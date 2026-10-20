import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { Sessions } from './sessions.mjs';
import { createDocument } from './artifacts.mjs';
import { VERSION } from './version.mjs';

const same = (a, b) => {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function startBroker({ token = randomUUID(), timeout, draftRoot, editorHtml } = {}) {
  const sessions = new Sessions({ timeout, draftRoot }), views = new Map();
  let port;
  const viewUrl = id => `http://127.0.0.1:${port}/view/${id}/${views.get(id)}`;
  // The local view replaces the MCP App panel in hosts that do not render MCP Apps (Claude Code).
  async function serveView(req, res) {
    const [, , id, grant] = new URL(req.url, 'http://localhost').pathname.split('/');
    if (req.method !== 'GET' || !editorHtml || !views.has(id) || !same(grant, views.get(id))) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    const nonce = randomBytes(16).toString('base64');
    const config = JSON.stringify({ sessionId: id, editorToken: views.get(id), port }).replace(/</g, '\\u003c');
    const html = (await readFile(editorHtml, 'utf8')).replace(/<script>/g, `<script nonce="${nonce}">`).replace(`<script nonce="${nonce}">`, `<script nonce="${nonce}">window.pencilLocalView=${config};</script><script nonce="${nonce}">`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src ws://127.0.0.1:${port}; frame-src https://app.pen.dev; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    }).end(html);
  }
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/view/')) { await serveView(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); }); return; }
    res.setHeader('Content-Type', 'application/json');
    if (!same(req.headers.authorization, `Bearer ${token}`)) { res.writeHead(401).end('{}'); return; }
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404).end('{}'); return; }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 40 * 1024 * 1024) throw new Error('Request too large'); }
      const { method, args = {} } = JSON.parse(raw);
      let result;
      if (method === 'ping') result = { version: VERSION };
      else if (method === 'open' || method === 'new') {
        const filename = method === 'new' ? await createDocument(args.path) : args.path;
        result = await sessions.open(filename, args.scope);
        if (!views.has(result.sessionId)) views.set(result.sessionId, randomUUID());
        result = { ...result, editorToken: views.get(result.sessionId), viewUrl: viewUrl(result.sessionId) };
      } else if (method === 'schema') result = await sessions.request(args.sessionId, 'get-mcp-schema');
      else if (method === 'status') result = sessions.status(args.sessionId);
      else if (method === 'acquire') { result = sessions.acquire(args.sessionId, args.agent); broadcast(args.sessionId); }
      else if (method === 'release') { result = sessions.release(args.sessionId, args.lease); broadcast(args.sessionId); }
      else if (method === 'call') result = await sessions.call(args.sessionId, args.lease, args.tool, args.arguments, { observational: args.readOnly === true });
      else if (method === 'capture') result = await sessions.capture(args.sessionId, args.lease, args.nodeIds, args.directory);
      else if (method === 'export') result = await sessions.exportNodes(args.sessionId, args.lease, args.nodeIds, args.format, args.directory);
      else if (method === 'save') result = await sessions.save(args.sessionId, args.lease);
      else if (method === 'save-as') result = await sessions.saveAs(args.sessionId, args.lease, args.path);
      else throw new Error('Unknown broker method');
      res.end(JSON.stringify({ result }));
    } catch (e) { res.end(JSON.stringify({ error: { code: e.code ?? 'BROKER_ERROR', message: e.message } })); }
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
  const broadcast = id => { for (const peer of ws.clients) if (peer.sessionId === id && peer.readyState === 1) peer.send(JSON.stringify({ kind: 'activity', status: sessions.status(id) })); };
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const id = url.searchParams.get('session'), grant = views.get(id);
    if (url.pathname !== '/editor' || !grant || !same(url.searchParams.get('token'), grant)) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, peer => {
      let generation;
      peer.sessionId = id;
      try {
        const config = sessions.attach(id, message => peer.send(JSON.stringify(message)));
        generation = config.generation;
        peer.send(JSON.stringify({ kind: 'config', ...config }));
        peer.send(JSON.stringify({ kind: 'activity', status: sessions.status(id) }));
      } catch (e) { peer.send(JSON.stringify({ kind: 'fatal', message: e.message })); peer.close(); return; }
      let storageTail = Promise.resolve();
      peer.on('message', bytes => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.kind === 'response') sessions.reply(id, generation, message);
          else if (message.kind === 'storage') {
            storageTail = storageTail.then(async () => {
              try {
                const payload = await sessions.storage(id, generation, message.method, message.payload);
                peer.send(JSON.stringify({ kind: 'storage-response', id: message.id, payload })); broadcast(id);
              } catch (e) { if (peer.readyState === 1) peer.send(JSON.stringify({ kind: 'storage-response', id: message.id, error: { code: e.code ?? 'STORAGE_ERROR', message: e.message } })); }
            }).catch(() => {});
          }
        } catch { peer.close(1008, 'Invalid message'); }
      });
      peer.on('error', () => {});
      peer.on('close', () => sessions.detach(id, generation));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  return { port, token, sessions, close: async () => {
    for (const peer of ws.clients) peer.terminate();
    const closed = new Promise(r => server.close(r));
    server.closeAllConnections();
    await closed;
  } };
}
