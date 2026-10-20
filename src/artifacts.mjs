import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeNewFile(filename, bytes) {
  if (!path.isAbsolute(filename)) throw new Error('Choose an absolute path');
  const parent = await fs.realpath(path.dirname(filename));
  const target = path.join(parent, path.basename(filename));
  const handle = await fs.open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (e) { await fs.unlink(target).catch(() => {}); throw e; }
  finally { await handle.close(); }
  return target;
}

export async function createDocument(filename) {
  if (path.extname(filename).toLowerCase() !== '.pen') throw new Error('The new document must use the .pen extension');
  const content = JSON.stringify({ version: '2.6', children: [{ type: 'frame', id: randomUUID(), name: 'Screen', width: 1440, height: 900, layout: 'vertical', gap: 16, alignItems: 'start', fill: '#FFFFFF' }] });
  return writeNewFile(filename, Buffer.from(content));
}

export async function exportDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Choose an absolute directory');
  const target = await fs.realpath(directory);
  if (!(await fs.stat(target)).isDirectory()) throw new Error('The destination must be an existing directory');
  return target;
}

export async function writeExportFile(directory, relative, bytes) {
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..') || relative.includes('\\')) throw new Error('Invalid export path');
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not allowed in exports'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  const parent = await fs.realpath(path.dirname(path.join(directory, relative)));
  if (parent !== directory && !parent.startsWith(`${directory}${path.sep}`)) throw new Error('Export outside the destination');
  return writeNewFile(path.join(parent, parts.at(-1)), bytes);
}
