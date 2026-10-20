import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Sessions } from '../src/sessions.mjs';
import { attachEngine } from './fake-engine.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let dir;
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-test-')); await fs.writeFile(path.join(dir, 'a.pen'), 'opaque-original'); await fs.writeFile(path.join(dir, 'b.pen'), 'opaque-b'); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const loaded = async (options = {}) => {
  const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), ...options }); const file = path.join(dir, 'a.pen');
  const { sessionId: id } = await r.open(file, 's'); const engine = attachEngine(r, id, options.engine);
  await r.storage(id, engine.generation, 'storage-load');
  return { r, id, file, engine, write: content => r.storage(id, engine.generation, 'storage-write', { fileURI: engine.fileURI, content }) };
};
describe('exclusivity between sessions', () => {
  test('one design session per document; the same scope shares it, another scope gets DOCUMENT_BUSY', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const a = await r.open(path.join(dir, 'a.pen'), 'thread-a');
    expect((await r.open(path.join(dir, 'a.pen'), 'thread-a')).sessionId).toBe(a.sessionId);
    expect((await r.open(path.join(dir, 'b.pen'), 'thread-b')).sessionId).not.toBe(a.sessionId);
    await expect(r.open(path.join(dir, 'a.pen'), 'thread-b')).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' });
  });
});
describe('collaboration inside a session', () => {
  test('agents get distinct non-exclusive tokens; one leaving does not affect the others', async () => {
    const events = []; const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), onActivity: id => events.push(id) });
    const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    expect(a.lease).not.toBe(b.lease);
    expect(r.status(id).agents).toEqual([{ agent: 'A', activeCalls: 0, waitingCalls: 0 }, { agent: 'B', activeCalls: 0, waitingCalls: 0 }]);
    expect(r.release(id, a.lease).agents).toEqual([{ agent: 'B', activeCalls: 0, waitingCalls: 0 }]);
    await expect(r.call(id, a.lease, 'get_app_state')).rejects.toMatchObject({ code: 'INVALID_LEASE' });
    expect(events.length).toBe(3);
  });
  test('both agents\' requests reach the channel before any response, and reversed replies reach the right caller', async () => {
    const { r, id, engine } = await loaded();
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    const first = r.call(id, a.lease, 'execute', { input: 'Insert A' }), second = r.call(id, b.lease, 'execute', { input: 'Insert B' });
    await tick();
    const [ra, rb] = engine.calls();
    expect(engine.calls()).toHaveLength(2); expect(ra.id).not.toBe(rb.id);
    expect(r.status(id)).toMatchObject({ activeCalls: 2, agents: [{ agent: 'A', activeCalls: 1, waitingCalls: 0 }, { agent: 'B', activeCalls: 1, waitingCalls: 0 }] });
    expect(() => r.release(id, a.lease)).toThrow('in progress');
    engine.answer(rb, { content: [{ type: 'text', text: 'for B' }] });
    expect((await second).content[0].text).toBe('for B');
    // B leaves while A's call is still running; A is not interrupted.
    r.release(id, b.lease);
    engine.answer(ra, { content: [{ type: 'text', text: 'for A' }] });
    expect((await first).content[0].text).toBe('for A');
    const log = r.status(id).recentCalls;
    expect(log.map(c => c.agent)).toEqual(['A', 'B']);
    expect(log[1].sentAt <= log[0].settledAt).toBe(true); // B was sent before A was answered: the calls overlapped.
  });
  test('a snapshot produced during a concurrent mutation does not count that mutation as saved', async () => {
    const { r, id, engine, write } = await loaded({ engine: { flush: new Error('save is not supported') }, saveWait: 20 });
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    const first = r.call(id, a.lease, 'execute', { input: 'Insert A' }), second = r.call(id, b.lease, 'execute', { input: 'Insert B' });
    await tick(); const [ra, rb] = engine.calls();
    engine.answer(ra); await first;
    await write('snapshot-with-A');      // reaches the service before B's response
    engine.answer(rb); await second;
    expect(r.status(id)).toMatchObject({ saveState: 'check-required', unsavedMutations: 1 });
    await expect(r.saveAs(id, a.lease, path.join(dir, 'stale.pen'))).rejects.toMatchObject({ code: 'SAVE_NOT_READY' });
    await write('snapshot-with-A-and-B');
    expect(r.status(id)).toMatchObject({ saveState: 'draft-saved', unsavedMutations: 0 });
    await r.saveAs(id, a.lease, path.join(dir, 'fresh.pen'));
    expect(await fs.readFile(path.join(dir, 'fresh.pen'), 'utf8')).toBe('snapshot-with-A-and-B');
  });
  test('only declared read-only executes keep the save state', async () => {
    const { r, id, engine, write } = await loaded();
    await write('edited'); const { lease } = r.acquire(id, 'A');
    const read = r.call(id, lease, 'execute', { input: 'Print(Get("x"))' }, { observational: true }); await tick(); engine.answer(engine.calls().at(-1)); await read;
    expect(r.status(id).saveState).toBe('draft-saved');
    const edit = r.call(id, lease, 'execute', { input: 'Update("x",{})' }); await tick(); engine.answer(engine.calls().at(-1)); await edit;
    expect(r.status(id).saveState).toBe('check-required');
  });
});
describe('consistent save', () => {
  test('waits for calls in flight, holds new calls during flush and write, and keeps agents joined', async () => {
    const { r, id, file, engine, write } = await loaded({ engine: { flush: null } });
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    const edit = r.call(id, a.lease, 'execute', { input: 'Insert A' }); await tick();
    const save = r.save(id, b.lease); await tick();
    expect(engine.requests.some(m => m.method === 'save')).toBe(false); // waits for A's call
    expect(r.status(id).saving).toBe(true);
    const later = r.call(id, b.lease, 'get_app_state'); await tick();
    expect(engine.calls()).toHaveLength(1);                              // B's new call is held
    engine.answer(engine.calls()[0]); await edit; await tick();
    const flush = engine.requests.find(m => m.method === 'save');
    expect(flush).toBeDefined();
    await write('flushed-with-A');                                       // the engine flushes, then answers
    r.reply(id, engine.generation, { id: flush.id, payload: 0 });
    const result = await save;
    expect(await fs.readFile(file, 'utf8')).toBe('flushed-with-A');
    expect(await fs.readFile(result.backupPath, 'utf8')).toBe('opaque-original');
    await tick(); expect(engine.calls()).toHaveLength(2);                // released after the write
    engine.answer(engine.calls()[1]); await later;
    expect(r.status(id).agents.map(x => x.agent)).toEqual(['A', 'B']);
    expect(r.status(id).saving).toBe(false);
  });
  test('without a flush or a covering autosave, Save writes nothing', async () => {
    const { r, id, file, engine, write } = await loaded({ engine: { flush: new Error('unknown method') }, saveWait: 20 });
    await write('v1'); const { lease } = r.acquire(id, 'A');
    const edit = r.call(id, lease, 'execute', { input: 'Update("x",{})' }); await tick(); engine.answer(engine.calls()[0]); await edit;
    await expect(r.save(id, lease)).rejects.toMatchObject({ code: 'SAVE_NOT_READY' });
    expect(await fs.readFile(file, 'utf8')).toBe('opaque-original');
  });
  test('the draft baseline survives a restart and blocks Save if the original changed meanwhile', async () => {
    const first = await loaded(); await first.write('draft-work');
    await fs.writeFile(first.file, 'changed-while-stopped');
    const r = new Sessions({ draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(first.file, 's'); const engine = attachEngine(r, id);
    expect((await r.storage(id, engine.generation, 'storage-load')).content).toBe('draft-work');
    expect(r.status(id).saveState).toBe('conflict');
    const { lease } = r.acquire(id, 'A');
    await expect(r.save(id, lease)).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
    expect(await fs.readFile(first.file, 'utf8')).toBe('changed-while-stopped');
    await r.saveAs(id, lease, path.join(dir, 'kept.pen'));
    expect(await fs.readFile(path.join(dir, 'kept.pen'), 'utf8')).toBe('draft-work');
  });
});
describe('unknown outcomes', () => {
  test('timeout blocks new calls, joins and saves instead of retrying', async () => {
    const r = new Sessions({ timeout: 15, draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    r.attach(id, () => {}); const { lease } = r.acquire(id, 'A');
    await expect(r.call(id, lease, 'execute', { input: 'Print(1)' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(r.status(id).blocked).toBe(true);
    await expect(r.call(id, lease, 'get_app_state')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(() => r.acquire(id, 'B')).toThrow('unknown outcome');
    await expect(r.save(id, lease)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(() => r.attach(id, () => {})).toThrow('already attached');
  });
  test('a new view after an unknown outcome reloads the draft and unblocks the session', async () => {
    const r = new Sessions({ timeout: 15, draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    const first = r.attach(id, () => {}); const { lease } = r.acquire(id, 'A');
    await expect(r.call(id, lease, 'execute', { input: 'Print(1)' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    r.detach(id, first.generation);
    const second = r.attach(id, () => {});
    expect(second.generation).toBe(first.generation + 1);
    expect(r.status(id)).toMatchObject({ blocked: false, recoveries: 1, agents: [{ agent: 'A', activeCalls: 0, waitingCalls: 0 }] });
    expect((await r.storage(id, second.generation, 'storage-load')).content).toBe('opaque-original');
    expect(r.release(id, lease).agents).toEqual([]);
  });
});
describe('opaque storage', () => {
  test('saves without decoding the document; an external change marks a conflict but keeps the work in the draft', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const file = path.join(dir, 'a.pen'); const { sessionId: id } = await r.open(file, 's'); const { generation, fileURI } = r.attach(id, () => {});
    expect((await r.storage(id, generation, 'storage-load')).content).toBe('opaque-original');
    expect(await r.storage(id, generation, 'storage-write', { fileURI, content: 'opaque-new' })).toBe(0);
    await fs.writeFile(file, 'human-edit');
    expect(await r.storage(id, generation, 'storage-write', { fileURI, content: 'agent-work' })).toBe(2);
    expect(await fs.readFile(file, 'utf8')).toBe('human-edit');
    expect(await fs.readFile(r.get(id).draft, 'utf8')).toBe('agent-work');
    expect(r.status(id).saveState).toBe('conflict');
  });
  test('asset writes cannot replace another session document', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 'a'); await r.open(path.join(dir, 'b.pen'), 'b'); const { generation } = r.attach(id, () => {});
    await expect(r.storage(id, generation, 'storage-write-asset', { path: `pencil/${id}/b.pen`, data: [65] })).rejects.toMatchObject({code:'ASSET_OUTSIDE_ROOT'});
    expect(await fs.readFile(path.join(dir,'b.pen'),'utf8')).toBe('opaque-b');
  });
  test('an external write during draft save is preserved', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const file = path.join(dir,'a.pen'); const {sessionId:id} = await r.open(file,'s'); const {generation,fileURI} = r.attach(id,()=>{}); await r.storage(id,generation,'storage-load');
    const atomic = r.atomicWrite.bind(r); r.atomicWrite = async (target,bytes) => { await fs.writeFile(file,'external-after-check'); await atomic(target,bytes); };
    expect(await r.storage(id,generation,'storage-write',{fileURI,content:'draft'})).toBe(0); expect(await fs.readFile(file,'utf8')).toBe('external-after-check');
  });
  test('rejects stale channels, other URIs, traversal and symlink assets', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const { generation } = r.attach(id, () => {});
    await expect(r.storage(id, generation + 1, 'storage-load')).rejects.toMatchObject({ code: 'STALE_CHANNEL' });
    await expect(r.storage(id, generation, 'storage-write', { fileURI: 'file:///other.pen', content: 'bad' })).rejects.toMatchObject({ code: 'WRONG_DOCUMENT' });
    await expect(r.storage(id, generation, 'storage-read-asset', { path: `pencil/${id}/../escape` })).rejects.toMatchObject({ code: 'ASSET_OUTSIDE_ROOT' });
    await fs.mkdir(path.join(dir, 'images')); await fs.symlink(os.tmpdir(), path.join(dir, 'images/link'));
    await expect(r.storage(id, generation, 'storage-read-asset', { path: `pencil/${id}/images/link/x` })).rejects.toMatchObject({ code: 'ASSET_SYMLINK' });
  });
});
