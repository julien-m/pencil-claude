import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sessions } from '../src/sessions.mjs';
import { attachEngine } from './fake-engine.mjs';
import { startBroker } from '../src/broker.mjs';

test('completion saves UUID bytes, preserves read-only selection semantics, and requires explicit reopen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-finish-'));
  try {
    const file = path.join(directory, 'design.pen'), uuid = randomUUID();
    await fs.writeFile(file, 'initial opaque bytes');
    const sessions = new Sessions({ draftRoot: path.join(directory, 'drafts') });
    const { sessionId } = await sessions.open(file, 'chat');
    const engine = attachEngine(sessions, sessionId);
    await sessions.storage(sessionId, engine.generation, 'storage-load');
    const nodes = [{ id: randomUUID(), type: 'frame', name: 'Human selection' }];
    sessions.notification(sessionId, engine.generation, 'selection-changed', { nodes });
    const { lease } = sessions.acquire(sessionId, 'owner');
    const read = sessions.call(sessionId, lease, 'execute', { input: 'Print(GetVariables())' }, { observational: true });
    engine.answer(engine.calls().at(-1)); await read;
    assert.equal(sessions.status(sessionId).unsavedMutations, 0);
    assert.deepEqual(sessions.status(sessionId).selection.nodes, nodes);
    await sessions.storage(sessionId, engine.generation, 'storage-write', { fileURI: engine.fileURI, content: uuid });
    const other = sessions.acquire(sessionId, 'other');
    const calls = [];
    const lifecycle = { prepare: async () => {
      assert.throws(() => sessions.acquire(sessionId, 'late'), { code: 'SESSION_CLOSING' });
      assert.throws(() => sessions.attach(sessionId, () => {}), { code: 'SESSION_CLOSING' });
      await assert.rejects(sessions.call(sessionId, lease, 'get_app_state'), { code: 'SESSION_CLOSING' });
      calls.push('prepare');
    }, resume: async () => calls.push('resume'), dispose: async () => { assert.equal(await fs.readFile(file, 'utf8'), uuid); calls.push('dispose'); } };
    await assert.rejects(sessions.finish(sessionId, lease, lifecycle), { code: 'CLOSE_NOT_READY' });
    sessions.release(sessionId, other.lease);
    const closed = await sessions.finish(sessionId, lease, lifecycle);
    assert.equal(closed.rendererReleased, true); assert.deepEqual(calls, ['prepare', 'dispose']);
    assert.throws(() => sessions.status(sessionId), { code: 'SESSION_NOT_FOUND' });
    sessions.detach(sessionId, engine.generation); // A close event arriving after disposal is harmless.
    await assert.rejects(sessions.open(file, 'chat'), { code: 'SESSION_CLOSED' });
    const restarted = new Sessions({ draftRoot: path.join(directory, 'drafts') });
    await assert.rejects(restarted.open(file, 'chat'), { code: 'SESSION_CLOSED' });
    const reopened = await restarted.open(file, 'chat', { explicit: true });
    assert.notEqual(reopened.sessionId, sessionId);
    const next = attachEngine(restarted, reopened.sessionId);
    const loaded = await restarted.storage(reopened.sessionId, next.generation, 'storage-load');
    assert.equal(loaded.content, uuid);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed completion preserves the session and resumes its editor', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-finish-conflict-'));
  try {
    const file = path.join(directory, 'design.pen'); await fs.writeFile(file, 'initial');
    const sessions = new Sessions({ draftRoot: path.join(directory, 'drafts') });
    const { sessionId } = await sessions.open(file, 'chat'), engine = attachEngine(sessions, sessionId);
    await sessions.storage(sessionId, engine.generation, 'storage-load');
    await fs.writeFile(file, 'external change');
    const { lease } = sessions.acquire(sessionId, 'owner'); let resumed = false, disposed = false;
    await assert.rejects(sessions.finish(sessionId, lease, { prepare: async () => {}, resume: async () => { resumed = true; }, dispose: async () => { disposed = true; } }), { code: 'SAVE_CONFLICT' });
    assert(resumed); assert(!disposed); assert.equal(sessions.get(sessionId).closing, false);
    assert.equal(await fs.readFile(file, 'utf8'), 'external change');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('broker retains the persistent managed document catalog with lifecycle injection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-catalog-'));
  const broker = await startBroker({ draftRoot: path.join(directory, 'drafts'), documentRoot: path.join(directory, 'documents') });
  const rpc = async (method, args = {}) => (await (await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}` }, body: JSON.stringify({ method, args }) })).json()).result;
  try {
    const draft = await rpc('new', { scope: 'chat', intent: 'explicit' });
    const catalog = await rpc('documents');
    assert.equal(catalog.documents.length, 1); assert.equal(catalog.sessions[0].sessionId, draft.sessionId);
    assert.equal((await fs.stat(catalog.documents[0].path)).isFile(), true);
  } finally { await broker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
