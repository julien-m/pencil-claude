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
      const peer = new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${s.sessionId}&token=${s.editorToken}`); peers.push(peer);
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
