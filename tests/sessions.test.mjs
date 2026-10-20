import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Sessions } from '../src/sessions.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-test-')); await fs.writeFile(path.join(dir, 'a.pen'), 'opaque-original'); await fs.writeFile(path.join(dir, 'b.pen'), 'opaque-b'); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
describe('session routing and reservations', () => {
  test('same scope shares the document; another session cannot attach a second writer', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const a = await r.open(path.join(dir, 'a.pen'), 'thread-a');
    expect((await r.open(path.join(dir, 'a.pen'), 'thread-a')).sessionId).toBe(a.sessionId);
    expect((await r.open(path.join(dir, 'b.pen'), 'thread-b')).sessionId).not.toBe(a.sessionId);
    await expect(r.open(path.join(dir, 'a.pen'), 'thread-b')).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' });
  });
  test('agents of one session get concurrent, non-exclusive access; released tokens stop working', async () => {
    const events = []; const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), onActivity: id => events.push(id) });
    const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    expect(a.lease).not.toBe(b.lease);
    expect(r.status(id).agents).toEqual([{ agent: 'A', inFlight: 0 }, { agent: 'B', inFlight: 0 }]);
    expect(r.release(id, a.lease).agents).toEqual([{ agent: 'B', inFlight: 0 }]);
    await expect(r.call(id, a.lease, 'get_app_state')).rejects.toMatchObject({ code: 'INVALID_LEASE' });
    expect(events.length).toBe(3);
  });
  test('calls from several agents are sent at once and correlated by request id', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const requests = [];
    const { generation } = r.attach(id, m => requests.push(m));
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    const first = r.call(id, a.lease, 'get_app_state'), second = r.call(id, b.lease, 'get_app_state');
    await new Promise(r => setTimeout(r, 5));
    expect(requests).toHaveLength(2); expect(requests[0].id).not.toBe(requests[1].id);
    expect(r.status(id).agents).toEqual([{ agent: 'A', inFlight: 1 }, { agent: 'B', inFlight: 1 }]);
    expect(() => r.release(id, a.lease)).toThrow('in progress');
    // Replies arrive in reverse order and still reach the right caller.
    r.reply(id, generation, { id: requests[1].id, payload: { content: [{ type: 'text', text: 'for B' }] } });
    r.reply(id, generation, { id: requests[0].id, payload: { content: [{ type: 'text', text: 'for A' }] } });
    expect((await first).content[0].text).toBe('for A'); expect((await second).content[0].text).toBe('for B');
    expect(r.status(id).inFlight).toBe(0);
  });
  test('Save waits for the operations in flight and their autosave, without blocking new calls', async () => {
    const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), saveWait: 1000 }); const file = path.join(dir, 'a.pen');
    const { sessionId: id } = await r.open(file, 's'); const requests = [];
    const { generation, fileURI } = r.attach(id, m => requests.push(m));
    await r.storage(id, generation, 'storage-load'); await r.storage(id, generation, 'storage-write', { fileURI, content: 'v1' });
    const a = r.acquire(id, 'A'), b = r.acquire(id, 'B');
    const edit = r.call(id, a.lease, 'execute', { input: 'Insert(...)' });
    await new Promise(r => setTimeout(r, 5));
    let saved = false; const save = r.save(id, b.lease).then(x => { saved = true; return x; });
    // A call started after the save request goes out immediately.
    const later = r.call(id, b.lease, 'get_app_state'); await new Promise(r => setTimeout(r, 5));
    expect(requests).toHaveLength(2); expect(saved).toBe(false);
    r.reply(id, generation, { id: requests[0].id, payload: { content: [] } }); await edit;
    expect(r.status(id).saveState).toBe('check-required');
    await new Promise(r => setTimeout(r, 5)); expect(saved).toBe(false);
    await r.storage(id, generation, 'storage-write', { fileURI, content: 'v2-with-edit' });
    await save; expect(await fs.readFile(file, 'utf8')).toBe('v2-with-edit');
    r.reply(id, generation, { id: requests[1].id, payload: { content: [] } }); await later;
  });
  test('Save refuses when no autosave acknowledges an edit in time', async () => {
    const r = new Sessions({ draftRoot: path.join(dir, 'drafts'), saveWait: 20 }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const requests = [];
    const { generation, fileURI } = r.attach(id, m => requests.push(m));
    await r.storage(id, generation, 'storage-load'); await r.storage(id, generation, 'storage-write', { fileURI, content: 'v1' });
    const { lease } = r.acquire(id, 'A');
    const edit = r.call(id, lease, 'execute', { input: 'Update("x",{})' }); await new Promise(r => setTimeout(r, 5));
    r.reply(id, generation, { id: requests[0].id, payload: { content: [] } }); await edit;
    await expect(r.save(id, lease)).rejects.toMatchObject({ code: 'SAVE_NOT_READY' });
    expect(await fs.readFile(path.join(dir, 'a.pen'), 'utf8')).toBe('opaque-original');
  });
  test('only declared read-only executes keep the acknowledged save state', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const requests = [];
    const { generation, fileURI } = r.attach(id, m => requests.push(m)); const { lease } = r.acquire(id, 'A');
    await r.storage(id, generation, 'storage-load'); await r.storage(id, generation, 'storage-write', { fileURI, content: 'edited' });
    const answer = () => new Promise(resolve => setTimeout(() => { r.reply(id, generation, { id: requests.at(-1).id, payload: { content: [] } }); resolve(); }, 1));
    await Promise.all([r.call(id, lease, 'execute', { input: 'Print(Get("x"))' }, { observational: true }), answer()]);
    expect(r.status(id).saveState).toBe('draft-saved');
    await Promise.all([r.call(id, lease, 'execute', { input: 'Update("x",{})' }), answer()]);
    expect(r.status(id).saveState).toBe('check-required');
  });
  test('timeout blocks writes and lease release instead of retrying', async () => {
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
    expect(r.status(id)).toMatchObject({ blocked: false, recoveries: 1, agents: [{ agent: 'A', inFlight: 0 }] });
    expect((await r.storage(id, second.generation, 'storage-load')).content).toBe('opaque-original');
    expect(r.release(id, lease).agents).toEqual([]);
  });
});
describe('opaque storage', () => {
  test('saves without decoding the document and refuses changed disk contents', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const file = path.join(dir, 'a.pen'); const { sessionId: id } = await r.open(file, 's'); const { generation, fileURI } = r.attach(id, () => {});
    expect((await r.storage(id, generation, 'storage-load')).content).toBe('opaque-original');
    expect(await r.storage(id, generation, 'storage-write', { fileURI, content: 'opaque-new' })).toBe(0);
    await fs.writeFile(file, 'human-edit');
    expect(await r.storage(id, generation, 'storage-write', { fileURI, content: 'stale' })).toBe(2);
    expect(await fs.readFile(file, 'utf8')).toBe('human-edit');
    expect(await fs.readFile(r.get(id).draft, 'utf8')).toBe('opaque-new');
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
