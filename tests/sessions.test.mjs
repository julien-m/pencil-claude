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
  test('two agents cannot interleave a reserved sequence; next agent reads after release', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    const first = r.acquire(id, 'A'); expect(() => r.acquire(id, 'B')).toThrow('reserved');
    r.release(id, first.lease); expect(r.acquire(id, 'B').leaseOwner).toBe('B');
    expect(() => r.call(id, first.lease, 'execute', { input: '' })).toThrow('Reserve');
  });
  test('calls serialize within one channel and preserve their responses', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const requests = [];
    const { generation } = r.attach(id, m => requests.push(m)); const { lease } = r.acquire(id, 'A');
    const a = r.call(id, lease, 'get_app_state'); const b = r.call(id, lease, 'get_app_state');
    await new Promise(r => setTimeout(r, 5)); expect(requests).toHaveLength(1);
    expect(() => r.release(id, lease)).toThrow('in progress');
    r.reply(id, generation, { id: requests[0].id, payload: { content: [{ type: 'text', text: 'A' }] } }); await a;
    await new Promise(r => setTimeout(r, 5)); expect(requests).toHaveLength(2);
    r.reply(id, generation, { id: requests[1].id, payload: { content: [{ type: 'text', text: 'B' }] } });
    expect((await b).content[0].text).toBe('B');
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
    expect(r.status(id).blocked).toBe(true); expect(() => r.release(id, lease)).toThrow('unknown outcome');
    expect(() => r.attach(id, () => {})).toThrow('already attached');
  });
  test('a new view after an unknown outcome reloads the draft and unblocks the session', async () => {
    const r = new Sessions({ timeout: 15, draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    const first = r.attach(id, () => {}); const { lease } = r.acquire(id, 'A');
    await expect(r.call(id, lease, 'execute', { input: 'Print(1)' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    r.detach(id, first.generation);
    const second = r.attach(id, () => {});
    expect(second.generation).toBe(first.generation + 1);
    expect(r.status(id)).toMatchObject({ blocked: false, recoveries: 1, leaseOwner: 'A' });
    expect((await r.storage(id, second.generation, 'storage-load')).content).toBe('opaque-original');
    expect(r.release(id, lease).leaseOwner).toBe(null);
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
