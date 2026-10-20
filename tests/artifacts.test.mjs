import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDocument, writeNewFile } from '../src/artifacts.mjs';
import { Sessions } from '../src/sessions.mjs';
let directory;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-files-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
test('new document and Save As use the chosen directory without overwriting existing files', async () => {
  const original = path.join(directory, 'new.pen'); await createDocument(original);
  await expect(createDocument(original)).rejects.toMatchObject({ code: 'EEXIST' });
  const sessions = new Sessions({ draftRoot: path.join(directory, 'drafts') });
  const { sessionId } = await sessions.open(original, 's'); const { generation, fileURI } = sessions.attach(sessionId, () => {});
  await sessions.storage(sessionId, generation, 'storage-load');
  await sessions.storage(sessionId, generation, 'storage-write', { fileURI, content: 'opaque-saved-snapshot' });
  const { lease } = sessions.acquire(sessionId, 'agent');
  const target = path.join(directory, 'chosen-name.pen');
  expect((await sessions.saveAs(sessionId, lease, target)).path).toBe(await fs.realpath(target));
  expect(await fs.readFile(target, 'utf8')).toBe('opaque-saved-snapshot');
  await expect(sessions.saveAs(sessionId, lease, target)).rejects.toMatchObject({ code: 'EEXIST' });
});
test('captures persist engine PNG bytes at the chosen destination', async () => {
  const source = path.join(directory, 'test.pen'); await createDocument(source);
  const sessions = new Sessions(); const { sessionId } = await sessions.open(source, 's'); const { lease } = sessions.acquire(sessionId, 'agent');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  sessions.call = async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] });
  const result = await sessions.capture(sessionId, lease, ['document'], directory);
  expect(result.structuredContent.files).toHaveLength(1);
  expect(await fs.readFile(result.structuredContent.files[0])).toEqual(png);
});
test('exclusive file write does not replace a pre-existing destination', async () => {
  const target = path.join(directory, 'existing.png'); await fs.writeFile(target, 'original');
  await expect(writeNewFile(target, Buffer.from('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(target, 'utf8')).toBe('original');
});
test('Save replaces the original with the acknowledged draft and keeps a backup', async () => {
  const original = path.join(directory, 'doc.pen'); await fs.writeFile(original, 'v1', { mode: 0o644 });
  const sessions = new Sessions({ draftRoot: path.join(directory, 'data/drafts') });
  const { sessionId } = await sessions.open(original, 's'); const { generation, fileURI } = sessions.attach(sessionId, () => {});
  await sessions.storage(sessionId, generation, 'storage-load');
  await sessions.storage(sessionId, generation, 'storage-write', { fileURI, content: 'v2' });
  const { lease } = sessions.acquire(sessionId, 'agent');
  const result = await sessions.save(sessionId, lease);
  expect(await fs.readFile(original, 'utf8')).toBe('v2');
  expect((await fs.stat(original)).mode & 0o777).toBe(0o644);
  expect(await fs.readFile(result.backupPath, 'utf8')).toBe('v1');
  expect(path.dirname(result.backupPath)).toBe(await fs.realpath(path.join(directory, 'data/backups')));
  expect((await fs.readdir(directory)).filter(f => f.endsWith('.tmp'))).toEqual([]);
  // The engine's next autosave is not treated as an external conflict.
  expect(await sessions.storage(sessionId, generation, 'storage-write', { fileURI, content: 'v3' })).toBe(0);
  expect((await sessions.save(sessionId, lease)).path).toBe(await fs.realpath(original));
  expect(await fs.readFile(original, 'utf8')).toBe('v3');
});
test('Save refuses when the original changed on disk or without a reservation', async () => {
  const original = path.join(directory, 'doc.pen'); await fs.writeFile(original, 'v1');
  const sessions = new Sessions({ draftRoot: path.join(directory, 'data/drafts') });
  const { sessionId } = await sessions.open(original, 's'); const { generation, fileURI } = sessions.attach(sessionId, () => {});
  await sessions.storage(sessionId, generation, 'storage-load');
  await sessions.storage(sessionId, generation, 'storage-save-draft', { fileURI, content: 'agent-edit' });
  await expect(sessions.save(sessionId, 'no-lease')).rejects.toMatchObject({ code: 'SAVE_NOT_READY' });
  const { lease } = sessions.acquire(sessionId, 'agent');
  await fs.writeFile(original, 'human-edit');
  await expect(sessions.save(sessionId, lease)).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
  expect(await fs.readFile(original, 'utf8')).toBe('human-edit');
  expect(sessions.status(sessionId).saveState).toBe('conflict');
});
