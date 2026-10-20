import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Sessions } from '../src/sessions.mjs';
import { createDocument } from '../src/artifacts.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let dir;
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-startup-')); await fs.writeFile(path.join(dir, 'a.pen'), 'opaque'); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
// An engine that records requests and answers each one after a short delay.
const engine = (r, id, ready = true) => {
  const requests = []; let channel;
  channel = r.attach(id, m => { requests.push(m); setTimeout(() => r.reply(id, channel.generation, { id: m.id, payload: { content: [{ type: 'text', text: `${m.payload?.name ?? m.method}:${m.payload?.arguments?.path ?? ''}` }] } }), 2); }, { ready });
  return { ...channel, requests, toolCalls: name => requests.filter(m => m.payload?.name === name) };
};
const agentCounts = [...new Set([6, Number(process.env.PENCIL_TEST_AGENTS ?? 9)])];
for (const count of agentCounts) test(`${count} agents share one engine round trip per documentation path and per schema`, async () => {
  const r = new Sessions({ draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
  let e = engine(r, id);
  const agents = Array.from({ length: count }, (_, i) => r.acquire(id, `agent-${i}`));
  const docs = await Promise.all(agents.map(a => r.call(id, a.lease, 'read_skill', { path: 'execute.md' })));
  expect(e.toolCalls('read_skill')).toHaveLength(1);
  docs[0].content[0].text = 'mutated by one agent';                 // each agent got its own copy
  expect((await r.call(id, agents[1].lease, 'read_skill', { path: 'execute.md' })).content[0].text).toBe('read_skill:execute.md');
  await r.call(id, agents[0].lease, 'read_skill', {});                // another path is another request
  expect(e.toolCalls('read_skill')).toHaveLength(2);
  await Promise.all(agents.map(() => r.schema(id)));
  expect(e.requests.filter(m => m.method === 'get-mcp-schema')).toHaveLength(1);
  expect(r.status(id).metadataStats).toEqual({ requests: 3, hits: count + count - 1 });
  expect(r.status(id).recentCalls.filter(c => c.outcome === 'cache-hit').length).toBe(count);
  // A reconnect is a new engine generation: everything is read again.
  r.detach(id, e.generation); e = engine(r, id);
  await Promise.all(agents.map(a => r.call(id, a.lease, 'read_skill', { path: 'execute.md' })));
  expect(e.toolCalls('read_skill')).toHaveLength(1);
});
test('engine errors are not kept for other agents', async () => {
  const r = new Sessions({ draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
  let fails = 1; const requests = [];
  const { generation } = r.attach(id, m => { requests.push(m); setTimeout(() => r.reply(id, generation, fails-- > 0 ? { id: m.id, error: { message: 'boom' } } : { id: m.id, payload: { content: [] } }), 1); });
  const { lease } = r.acquire(id, 'A');
  await expect(r.call(id, lease, 'read_skill', { path: 'x.md' })).rejects.toMatchObject({ code: 'EDITOR_ERROR' });
  await r.call(id, lease, 'read_skill', { path: 'x.md' });
  expect(requests).toHaveLength(2);
});
test('agents join before the editor; their calls wait for the engine handshake, then go out', async () => {
  const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), editorWait: 1000 }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
  const agents = Array.from({ length: 6 }, (_, i) => r.acquire(id, `agent-${i}`));  // no view at all yet
  expect(r.status(id).agents).toHaveLength(6);
  const calls = agents.map(a => r.call(id, a.lease, 'get_app_state'));
  await tick();
  expect(r.status(id).agents.every(a => a.waitingCalls === 1 && a.activeCalls === 0)).toBe(true);   // visible while held back
  const e = engine(r, id, false);                                       // socket open, engine still loading
  await tick(); expect(e.requests).toHaveLength(0);
  r.ready(id, e.generation);
  await Promise.all(calls);
  expect(e.requests).toHaveLength(6);
  const log = r.status(id).recentCalls;
  expect(log.every(c => c.queuedAt < c.sentAt)).toBe(true);
  expect(r.status(id).readyAt).toBeGreaterThanOrEqual(r.status(id).openedAt);
});
test('when the editor never becomes ready, the call fails with EDITOR_OFFLINE and nothing is sent', async () => {
  const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), editorWait: 40 }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
  const { lease } = r.acquire(id, 'A');
  const e = engine(r, id, false);
  const started = Date.now();
  await expect(r.call(id, lease, 'execute', { input: 'Insert(...)' })).rejects.toMatchObject({ code: 'EDITOR_OFFLINE' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  expect(e.requests).toHaveLength(0);
  expect(r.status(id)).toMatchObject({ blocked: false, activeCalls: 0, unsavedMutations: 0 });
  expect(r.status(id).agents).toEqual([{ agent: 'A', activeCalls: 0, waitingCalls: 0 }]);
  expect(r.status(id).recentCalls.at(-1)).toMatchObject({ agent: 'A', tool: 'execute', outcome: 'EDITOR_OFFLINE', sentAt: null });   // the expiry is logged
});
test('new documents are empty: the plugin never imposes a frame', async () => {
  const file = await createDocument(path.join(dir, 'new.pen'));
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: '2.6', children: [] });
});
