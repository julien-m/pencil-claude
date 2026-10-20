import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startBroker } from '../src/broker.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const editorHtml = path.join(import.meta.dirname, '../dist/editor.html');
test('real loopback transport authenticates and routes one editor without broadcasting to another', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-ws-')); const b = await startBroker({ timeout: 1000 }); const peers = [];
  try {
    const rpc = async (method, args) => (await (await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method, args }) })).json()).result;
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST' })).status, 401);
    const sessions = [];
    for (const name of ['a', 'b']) {
      const file = path.join(dir, `${name}.pen`); await fs.writeFile(file, name); const s = await rpc('open', { path: file, scope: name }); sessions.push(s);
      const peer = new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${s.sessionId}&token=${s.editorToken}`); peers.push(peer); peer.once('open', () => peer.send(JSON.stringify({ kind: 'ready' })));
      await new Promise((resolve, reject) => { peer.once('message', resolve); peer.once('error', reject); });
      peer.on('message', bytes => { const m = JSON.parse(bytes); if (m.kind === 'request') peer.send(JSON.stringify({ kind: 'response', id: m.id, payload: { content: [{ type: 'text', text: name }] } })); });
    }
    const leases = await Promise.all(sessions.map((s, i) => rpc('acquire', { sessionId: s.sessionId, agent: `agent-${i}` })));
    const results = await Promise.all(sessions.map((s, i) => rpc('call', { sessionId: s.sessionId, lease: leases[i].lease, tool: 'get_app_state', arguments: {} })));
    assert.deepEqual(results.map(x => x.content[0].text), ['a', 'b']);
  } finally { for (const p of peers) p.terminate(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('local view requires the session grant and is served with a restrictive policy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-view-')); const b = await startBroker({ editorHtml });
  try {
    const file = path.join(dir, 'v.pen'); await fs.writeFile(file, 'opaque');
    const { result } = await (await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method: 'open', args: { path: file, scope: 'v' } }) })).json();
    assert.equal(result.viewUrl, `http://127.0.0.1:${b.port}/view/${result.sessionId}/${result.editorToken}`);
    const page = await fetch(result.viewUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-src https:\/\/app\.pen\.dev;/); assert.match(csp, new RegExp(`connect-src ws://127\\.0\\.0\\.1:${b.port};`)); assert.doesNotMatch(csp, /script-src 'unsafe-inline'/);
    const html = await page.text(); const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert(html.includes(`<script nonce="${nonce}">window.pencilLocalView=`)); assert(!html.includes('<script>'));
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/view/${result.sessionId}/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/view/${crypto.randomUUID()}/${result.editorToken}`)).status, 404);
  } finally { await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('one editor receives two agents\' calls before answering either, and reversed answers reach the right agent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-shared-ws-')); const b = await startBroker({ timeout: 1000 }); let peer;
  try {
    const rpc = async (method, args) => {
      const body = await (await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method, args }) })).json();
      if (body.error) throw Object.assign(new Error(body.error.message), body.error);
      return body.result;
    };
    const file = path.join(dir, 'shared.pen'); await fs.writeFile(file, 'opaque');
    const session = await rpc('open', { path: file, scope: 'shared' });
    await assert.rejects(rpc('open', { path: file, scope: 'another-session' }), { code: 'DOCUMENT_BUSY' });
    const requests = [], activity = [];
    peer = new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${session.sessionId}&token=${session.editorToken}`);
    peer.once('open', () => peer.send(JSON.stringify({ kind: 'ready' })));
    await new Promise((resolve, reject) => { peer.once('message', resolve); peer.once('error', reject); });
    peer.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.kind === 'activity') activity.push(m.status);
      if (m.kind !== 'request') return;
      requests.push({ ...m, at: process.hrtime.bigint() });
      // Answer only once BOTH requests are here, in reverse order: a serial broker would time out.
      if (requests.length === 2) for (const r of [...requests].reverse()) peer.send(JSON.stringify({ kind: 'response', id: r.id, payload: { marker: r.payload.arguments.marker } }));
    });
    const agents = await Promise.all(['A', 'B'].map(agent => rpc('acquire', { sessionId: session.sessionId, agent })));
    const results = await Promise.all(agents.map((a, i) => rpc('call', { sessionId: session.sessionId, lease: a.lease, tool: 'execute', arguments: { input: `Print(${i})`, marker: i } })));
    assert.deepEqual(results.map(r => r.marker), [0, 1]);
    assert.equal(requests.length, 2); assert.notEqual(requests[0].id, requests[1].id);
    assert(activity.some(s => s.agents.length === 2 && s.activeCalls === 2), 'activity must show both agents with a running call');
    const log = (await rpc('status', { sessionId: session.sessionId })).recentCalls;
    assert(log.every(c => c.outcome === 'ok') && log[1].sentAt <= log[0].settledAt && log[0].sentAt <= log[1].settledAt, 'the two calls overlap in time');
    await Promise.all(agents.map(a => rpc('release', { sessionId: session.sessionId, lease: a.lease })));
    assert.deepEqual(b.sessions.status(session.sessionId).agents, []);
  } finally { peer?.terminate(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('MCP clients use the deadline advertised by the service, not their own environment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-deadline-')); const b = await startBroker({ editorWait: 123 }); const previous = process.env.PENCIL_EDITOR_WAIT_MS;
  try {
    await fs.writeFile(path.join(dir, 'connection.json'), JSON.stringify({ port: b.port, token: b.token }));
    process.env.PENCIL_EDITOR_WAIT_MS = '1';
    const { connectBroker } = await import('../src/client.mjs');
    const client = await connectBroker(dir);
    assert.equal(client.editorWait, 123);
    assert.equal(client.rpcTimeoutMs, b.sessions.rpcBudget);
    assert(client.rpcTimeoutMs > client.editorWait + b.sessions.timeout);
  } finally { if (previous === undefined) delete process.env.PENCIL_EDITOR_WAIT_MS; else process.env.PENCIL_EDITOR_WAIT_MS = previous; await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
