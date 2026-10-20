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
