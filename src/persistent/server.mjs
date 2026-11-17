import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startBroker } from '../broker.mjs';
import { editorWaitFromEnv } from '../config.mjs';
import { RendererHost } from './renderer.mjs';
import { attachViewChannel } from './view-channel.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'persistent');
const same = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const assets = new Map([['/', ['view.html', 'text/html']], ['/engine', ['engine.html', 'text/html']], ['/view.mjs', ['view.mjs', 'text/javascript']], ['/engine.mjs', ['engine.mjs', 'text/javascript']], ['/point.mjs', ['point.mjs', 'text/javascript']], ['/keyboard.mjs', ['keyboard.mjs', 'text/javascript']]]);

/** Start the supervised Pencil renderer service; MCP clients never spawn it. */
export async function startPersistentService({ port, executablePath, runtimeDirectory }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid explicit loopback port is required');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const broker = await startBroker({ editorWait: editorWaitFromEnv(), draftRoot: path.join(runtimeDirectory, 'drafts'), editorLifecycle: {
    prepare: id => renderer.prepareClose(id), resume: id => renderer.resume(id), dispose: id => renderer.closeSession(id),
  } });
  const token = randomUUID(), grants = new Map(), origin = `http://127.0.0.1:${port}`;
  const renderer = new RendererHost({ executablePath, origin, brokerPort: broker.port });
  const rpc = async (method, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(85_000) });
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Host rejected' });
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, mime] = assets.get(url.pathname);
        res.setHeader('Content-Type', mime);
        const connect = url.pathname === '/engine' ? `ws://127.0.0.1:${broker.port}` : origin.replace('http:', 'ws:');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src ${connect}; frame-src https://app.pen.dev; base-uri 'none'; form-action 'none'`);
        res.end(await readFile(path.join(root, file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/view-messages.mjs') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(path.join(root, 'view-messages.mjs'))); return;
      }
      if (req.method !== 'POST' || url.pathname !== '/rpc') return json(res, 404, { error: 'Not found' });
      if (!same(req.headers.authorization, `Bearer ${token}`)) return json(res, 401, { error: 'Authentication required' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 40 * 1024 * 1024) throw new Error('Request too large'); }
      const { method, args = {} } = JSON.parse(raw);
      let result = await rpc(method, args);
      if (method === 'new' || method === 'open') {
        const { editorToken, ...session } = result;
        await renderer.ensure(session.sessionId, editorToken);
        if (!grants.has(session.sessionId)) grants.set(session.sessionId, randomUUID());
        const fragment = new URLSearchParams({ session: session.sessionId, token: grants.get(session.sessionId) });
        result = { ...session, path: broker.sessions.get(session.sessionId).file, renderer: await renderer.status(session.sessionId), viewURL: `${origin}/#${fragment}` };
      } else if (method === 'status') result = { ...result, renderer: await renderer.status(args.sessionId) };
      else if (method === 'close') grants.delete(args.sessionId);
      json(res, 200, { result });
    } catch (error) { json(res, 400, { error: { code: error.code ?? 'PENCIL_SERVICE_ERROR', message: error.message } }); }
  });
  const views = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin), id = url.searchParams.get('session'), grant = grants.get(id);
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin || url.pathname !== '/view' || !grant || !same(url.searchParams.get('token'), grant)) { socket.destroy(); return; }
    views.handleUpgrade(req, socket, head, peer => {
      attachViewChannel(peer, renderer.watch(id, peer), async () => {
        const state = await renderer.sessions.get(id);
        await state.inputTail;
        const participant = await rpc('acquire', { sessionId: id, agent: 'Remote view save' });
        try { await rpc('save', { sessionId: id, lease: participant.lease }); }
        finally { await rpc('release', { sessionId: id, lease: participant.lease }); }
      });
    });
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await broker.close(); throw error; }
  const connectionFile = path.join(runtimeDirectory, 'connection.json');
  await writeFile(connectionFile, JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
  return { origin, token, renderer, broker, close: async () => {
    for (const peer of views.clients) peer.terminate();
    await renderer.close(); await broker.close();
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    await unlink(connectionFile);
  } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port, executablePath, runtimeDirectory] = process.argv.slice(2);
  const service = await startPersistentService({ port: Number(port), executablePath, runtimeDirectory });
  console.log('Pencil persistent service ready');
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await service.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
