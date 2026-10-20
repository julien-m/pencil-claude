import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeNewFile, exportDirectory, writeExportFile } from './artifacts.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new SessionError(code, message); };

export class Sessions {
  constructor({ timeout = 15000, draftRoot = path.join(os.tmpdir(), 'pencil-drafts') } = {}) { this.items = new Map(); this.timeout = timeout; this.draftRoot = draftRoot; }
  get(id) { return this.items.get(id) ?? fail('SESSION_NOT_FOUND', 'Unknown session'); }
  async open(filename, scope) {
    if (!path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.pen') fail('INVALID_PATH', 'An absolute .pen file path is required');
    const file = await fs.realpath(filename);
    if (path.extname(file).toLowerCase() !== '.pen') fail('INVALID_PATH', 'The resolved target must be a .pen document');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('INVALID_FILE', 'Invalid or oversized document');
    const previous = [...this.items.values()].find(s => s.file === file);
    if (previous) {
      if (previous.scope !== scope) fail('DOCUMENT_BUSY', 'This document already belongs to another design session; create a copy for a variant');
      return this.status(previous.id);
    }
    const id = randomUUID();
    const draft = path.join(this.draftRoot, `${digest(`${scope}:${file}`)}.pen`);
    const s = { id, scope, file, draft, exportJobs: new Map(), writeEpoch: 0, virtualRoot: `pencil/${id}/`, generation: 0, pending: new Map(), lease: null, tail: Promise.resolve(), blocked: false, connected: false, savedHash: null, operations: 0, recoveries: 0, saveState: 'not-loaded' };
    this.items.set(id, s);
    return this.status(id);
  }
  status(id) {
    const s = this.get(id);
    return { sessionId: s.id, scope: s.scope, name: path.basename(s.file), connected: s.connected, generation: s.generation, blocked: s.blocked, leaseOwner: s.lease?.agent ?? null, operations: s.operations, recoveries: s.recoveries, saveState: s.saveState, draftPath: s.draft };
  }
  attach(id, send) {
    const s = this.get(id);
    if (s.connected) fail('EDITOR_ALREADY_CONNECTED', 'An editor view is already attached to this session');
    // A new view reloads the last acknowledged draft, which settles any unknown outcome:
    // unsaved engine state died with the previous view. Agents must re-read before editing.
    if (s.blocked) { s.blocked = false; s.recoveries += 1; }
    s.generation += 1; s.send = send; s.connected = true;
    return { generation: s.generation, fileURI: `file:///${s.virtualRoot}${encodeURIComponent(path.basename(s.file))}` };
  }
  detach(id, generation) {
    const s = this.get(id);
    if (generation !== s.generation) return;
    s.connected = false; s.send = undefined;
    for (const p of s.pending.values()) p.reject(new SessionError('OUTCOME_UNKNOWN', 'Connection lost during a call'));
    if (s.pending.size) s.blocked = true;
    s.pending.clear();
  }
  acquire(id, agent) {
    const s = this.get(id);
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session blocked after an unknown outcome');
    if (s.lease) fail('LEASE_BUSY', `Document reserved by ${s.lease.agent}`);
    s.lease = { token: randomUUID(), agent };
    return { lease: s.lease.token, ...this.status(id) };
  }
  release(id, token) {
    const s = this.get(id);
    if (s.lease?.token !== token) fail('INVALID_LEASE', 'Invalid reservation');
    if (s.pending.size || s.queued) fail('CALLS_IN_FLIGHT', 'Calls are still in progress');
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Do not release a reservation with an operation of unknown outcome');
    s.lease = null;
    return this.status(id);
  }
  call(id, token, name, args = {}, { observational = false } = {}) {
    const s = this.get(id);
    if (s.lease?.token !== token) fail('INVALID_LEASE', 'Reserve the document before calling tools');
    if (!['execute', 'read_skill', 'get_style', 'get_app_state'].includes(name)) fail('TOOL_NOT_ALLOWED', 'Tool not exposed by this plugin');
    // Generation and execution are mixed in execute; async generation is excluded from this version.
    if (name === 'execute' && /\bGenerate\s*\(/.test(args.input ?? '')) fail('ASYNC_UNSUPPORTED', 'Asynchronous generation is not supported in this version');
    s.queued = (s.queued ?? 0) + 1;
    const result = s.tail.then(async () => {
      if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session blocked; do not replay mutations');
      if (s.lease?.token !== token) fail('INVALID_LEASE', 'Stale reservation');
      const writeEpoch = s.writeEpoch;
      const response = await this.request(id, 'mcp-tool-call', { name, arguments: args });
      s.operations += 1;
      if (name === 'execute' && !observational && s.writeEpoch === writeEpoch) s.saveState = 'check-required';
      return response;
    });
    s.tail = result.catch(() => {});
    return result.finally(() => { s.queued -= 1; });
  }
  request(id, method, payload) {
    const s = this.get(id);
    if (!s.connected) fail('EDITOR_OFFLINE', 'Open the editor view for this session and wait for the engine');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(requestId); s.blocked = true;
        reject(new SessionError('OUTCOME_UNKNOWN', 'Timed out; the outcome of the operation is unknown'));
      }, this.timeout);
      s.pending.set(requestId, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
      try { s.send({ kind: 'request', id: requestId, method, payload }); }
      catch (e) { clearTimeout(timer); s.pending.delete(requestId); s.blocked = true; reject(e); }
    });
  }
  reply(id, generation, message) {
    const s = this.get(id);
    if (generation !== s.generation) return false;
    const p = s.pending.get(message.id);
    if (!p) return false;
    s.pending.delete(message.id);
    if (message.error) p.reject(new SessionError('EDITOR_ERROR', String(message.error.message)));
    else p.resolve(message.payload);
    return true;
  }
  async capture(id, token, nodeIds, directory) {
    const target = await exportDirectory(directory);
    const result = await this.call(id, token, 'execute', { filePath: '', description: 'Capture the selected nodes', input: `TakeScreenshot(${JSON.stringify(nodeIds)})` }, { observational: true });
    if (result.isError) return result;
    const files = [];
    for (const image of result.content.filter(x => x.type === 'image')) {
      if (image.mimeType !== 'image/png') fail('UNSUPPORTED_CAPTURE', 'Unsupported capture format');
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('INVALID_CAPTURE', 'Invalid PNG capture');
      files.push(await writeNewFile(path.join(target, `pencil-${randomUUID()}.png`), bytes));
    }
    if (!files.length) fail('EMPTY_CAPTURE', 'The engine returned no image');
    return { ...result, structuredContent: { files } };
  }
  async exportNodes(id, token, nodeIds, format, directory) {
    const s = this.get(id), target = await exportDirectory(directory);
    const prefix = `images/pencil-export-${randomUUID()}`;
    const job = { directory: target, files: [] }; s.exportJobs.set(prefix, job);
    const output = format.startsWith('html-') ? `${prefix}/index.html` : prefix;
    try {
      const result = await this.call(id, token, 'execute', { filePath: '', description: 'Export the selection', input: `Export(${JSON.stringify(nodeIds)},${JSON.stringify(format)},${JSON.stringify(output)})` }, { observational: true });
      if (result.isError) return { ...result, structuredContent: { files: job.files, partial: true } };
      if (!job.files.length) fail('EXPORT_NOT_SAVED', 'The engine replied without producing a verified file');
      return { ...result, structuredContent: { files: job.files } };
    } finally { s.exportJobs.delete(prefix); }
  }
  async saveAs(id, token, filename) {
    const s = this.get(id);
    if (s.lease?.token !== token || s.pending.size || s.queued || s.blocked) fail('SAVE_NOT_READY', 'Reserve the session and wait for pending operations');
    if (s.saveState !== 'draft-saved' && s.saveState !== 'host-saved') fail('SAVE_NOT_READY', 'Wait for an engine save acknowledgement before Save As');
    if (path.extname(filename).toLowerCase() !== '.pen') fail('INVALID_PATH', 'Choose a new .pen file');
    const saved = await writeNewFile(filename, await fs.readFile(s.draft));
    return { path: saved, sessionId: id, sourceUnchanged: true };
  }
  // Replace the original with the acknowledged draft, only if nobody changed it since the engine loaded it.
  // The previous version is kept in backups/ first; a final hash check runs right before the atomic rename.
  async save(id, token) {
    const s = this.get(id);
    if (s.lease?.token !== token || s.pending.size || s.queued || s.blocked) fail('SAVE_NOT_READY', 'Reserve the session and wait for pending operations');
    if (s.saveState !== 'draft-saved' && s.saveState !== 'host-saved') fail('SAVE_NOT_READY', 'Wait for an engine save acknowledgement before saving');
    const unchanged = async () => s.savedHash !== null && digest(await fs.readFile(s.file)) === s.savedHash;
    const conflict = () => { s.saveState = 'conflict'; fail('SAVE_CONFLICT', 'The original file changed since it was loaded; nothing was replaced. Use Save As'); };
    if (!await unchanged()) conflict();
    const bytes = await fs.readFile(s.draft), previous = await fs.readFile(s.file);
    const backups = path.join(path.dirname(this.draftRoot), 'backups');
    await fs.mkdir(backups, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = await writeNewFile(path.join(backups, `${path.basename(s.file, '.pen')}-${stamp}-${randomUUID().slice(0, 8)}.pen`), previous);
    const temp = path.join(path.dirname(s.file), `.${path.basename(s.file)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, bytes, { flag: 'wx', mode: (await fs.stat(s.file)).mode & 0o777 });
      if (!await unchanged()) conflict();
      await fs.rename(temp, s.file);
    } finally { await fs.unlink(temp).catch(() => {}); }
    s.savedHash = digest(bytes);
    return { path: s.file, backupPath, sessionId: id, bytes: bytes.length };
  }
  async storage(id, generation, method, payload) {
    const s = this.get(id);
    if (generation !== s.generation || !s.connected) fail('STALE_CHANNEL', 'Stale channel');
    if (method === 'documents-save-preview') return null; // Optional dashboard thumbnail, no document persistence.
    if (method === 'storage-load') {
      let bytes = await fs.readFile(s.file);
      s.savedHash = digest(bytes); s.saveState = 'saved';
      try { bytes = await fs.readFile(s.draft); s.saveState = 'draft-saved'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { filePath: path.basename(s.file), content: bytes.toString('utf8'), updatedAt: (await fs.stat(s.file)).mtimeMs };
    }
    if (method === 'storage-write' || method === 'storage-save-draft') {
      if (typeof payload?.content !== 'string' || Buffer.byteLength(payload.content) > 32 * 1024 * 1024) fail('INVALID_CONTENT', 'Invalid content');
      if (payload.fileURI !== `file:///${s.virtualRoot}${encodeURIComponent(path.basename(s.file))}`) fail('WRONG_DOCUMENT', 'Unexpected document URI');
      if (method === 'storage-write' && (s.savedHash === null || digest(await fs.readFile(s.file)) !== s.savedHash)) { s.saveState = 'conflict'; return 2; }
      // Engine autosaves only update the draft; the original changes through save().
      await fs.mkdir(this.draftRoot, { recursive: true, mode: 0o700 });
      await this.atomicWrite(s.draft, Buffer.from(payload.content));
      s.writeEpoch += 1; s.saveState = 'draft-saved'; return 0;
    }
    if (!['storage-read-asset', 'storage-write-asset', 'storage-has-asset'].includes(method)) fail('METHOD_NOT_ALLOWED', `Unknown storage operation: ${method}`);
    const key = payload?.path;
    if (typeof key !== 'string' || !key.startsWith(s.virtualRoot)) fail('ASSET_OUTSIDE_ROOT', 'Asset outside the document');
    const relative = key.slice(s.virtualRoot.length);
    if (!relative || relative.split('/').some(x => !x || x === '..' || x === '.') || relative.includes('\\')) fail('ASSET_OUTSIDE_ROOT', 'Invalid asset path');
    if (!/^(images|fonts)\//.test(relative) || /\.pen$/i.test(relative)) fail('ASSET_OUTSIDE_ROOT', 'Only images/ and fonts/ assets are accessible');
    const exportJob = [...s.exportJobs.entries()].find(([prefix]) => relative.startsWith(`${prefix}/`));
    if (exportJob && method === 'storage-write-asset') {
      const [prefix, job] = exportJob, exportPath = relative.slice(prefix.length + 1);
      const data = payload?.data;
      if (!Array.isArray(data) || data.length > 32 * 1024 * 1024 || !data.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) fail('INVALID_ASSET', 'Invalid export');
      job.files.push(await writeExportFile(job.directory, exportPath, Buffer.from(data)));
      return null;
    }
    const root = path.dirname(s.file), target = path.join(root, relative);
    if (target === s.file) fail('ASSET_IS_DOCUMENT', 'An asset cannot replace the document');
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) fail('ASSET_SYMLINK', 'Symbolic links are not allowed for assets'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (method === 'storage-read-asset') { try { return [...await fs.readFile(target)]; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
    if (method === 'storage-has-asset') { try { await fs.access(target); return true; } catch { return false; } }
    const data = payload?.data;
    if (!Array.isArray(data) || data.length > 16 * 1024 * 1024 || !data.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) fail('INVALID_ASSET', 'Invalid asset');
    await fs.mkdir(path.dirname(target), { recursive: true }); await this.atomicWrite(target, Buffer.from(data));
    return null;
  }
  async atomicWrite(file, bytes) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
}
