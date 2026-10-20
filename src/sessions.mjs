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
  constructor({ timeout = 15000, draftRoot = path.join(os.tmpdir(), 'pencil-drafts'), saveWait = 5000, onActivity = () => {} } = {}) {
    this.items = new Map(); this.timeout = timeout; this.draftRoot = draftRoot; this.saveWait = saveWait; this.onActivity = onActivity;
  }
  get(id) { return this.items.get(id) ?? fail('SESSION_NOT_FOUND', 'Unknown session'); }
  // Exclusivity is between design sessions: a document belongs to exactly one session.
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
    const s = {
      id, scope, file, draft, exportJobs: new Map(), virtualRoot: `pencil/${id}/`, generation: 0, pending: new Map(),
      participants: new Map(), flights: new Set(), saving: null, persistTail: Promise.resolve(), coverageWaiters: new Set(), recent: [],
      // mutations counts completed mutating calls; savedThrough is the highest count a persisted snapshot is known to contain.
      mutations: 0, savedThrough: 0,
      blocked: false, connected: false, savedHash: null, operations: 0, recoveries: 0, saveState: 'not-loaded'
    };
    this.items.set(id, s);
    return this.status(id);
  }
  status(id) {
    const s = this.get(id);
    const agents = [...s.participants.values()].map(({ agent, activeCalls }) => ({ agent, activeCalls }));
    return {
      sessionId: s.id, scope: s.scope, name: path.basename(s.file), connected: s.connected, generation: s.generation, blocked: s.blocked,
      agents, activeCalls: s.flights.size, saving: !!s.saving, operations: s.operations, recoveries: s.recoveries,
      saveState: s.saveState, unsavedMutations: Math.max(0, s.mutations - s.savedThrough), draftPath: s.draft, recentCalls: s.recent.slice(-20)
    };
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
  // Inside a session every agent gets its own non-exclusive participation token (the "lease"
  // field): there is no lock between agents, and one agent leaving never interrupts the others.
  acquire(id, agent) {
    const s = this.get(id);
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session blocked after an unknown outcome');
    const lease = randomUUID();
    s.participants.set(lease, { agent, activeCalls: 0 });
    this.onActivity(id);
    return { lease, ...this.status(id) };
  }
  release(id, token) {
    const s = this.get(id), participant = this.participant(s, token);
    if (participant.activeCalls) fail('CALLS_IN_FLIGHT', 'This agent still has calls in progress');
    s.participants.delete(token);
    this.onActivity(id);
    return this.status(id);
  }
  participant(s, token) { return s.participants.get(token) ?? fail('INVALID_LEASE', 'Call pencil_begin to join the session before calling tools'); }
  // Calls go to the channel immediately, without a session-wide queue: each request has its
  // own correlation id, so responses may come back in any order. Only a save in progress holds
  // new calls back, briefly, until its flush and write are done.
  async call(id, token, name, args = {}, { observational = false } = {}) {
    const s = this.get(id);
    this.participant(s, token);
    if (!['execute', 'read_skill', 'get_style', 'get_app_state'].includes(name)) fail('TOOL_NOT_ALLOWED', 'Tool not exposed by this plugin');
    // Generation and execution are mixed in execute; async generation is excluded from this version.
    if (name === 'execute' && /\bGenerate\s*\(/.test(args.input ?? '')) fail('ASYNC_UNSUPPORTED', 'Asynchronous generation is not supported in this version');
    while (s.saving) await s.saving;
    const participant = this.participant(s, token);
    if (s.blocked) fail('OUTCOME_UNKNOWN', 'Session blocked; do not replay mutations');
    const mutating = name === 'execute' && !observational;
    const entry = { requestId: randomUUID(), agent: participant.agent, tool: name, mutating, sentAt: new Date().toISOString(), settledAt: null, outcome: 'pending' };
    const flight = this.request(id, 'mcp-tool-call', { name, arguments: args }, entry.requestId);
    const settled = flight.then(() => {}, () => {});
    s.flights.add(settled); participant.activeCalls += 1;
    s.recent.push(entry); if (s.recent.length > 100) s.recent.shift();
    this.onActivity(id);
    try {
      const response = await flight;
      s.operations += 1; entry.outcome = response?.isError ? 'engine-error' : 'ok';
      // Only snapshots that reach the service after this response can contain this mutation.
      if (mutating) { s.mutations += 1; this.refreshSaveState(s); }
      return response;
    } catch (error) { entry.outcome = error.code ?? 'error'; throw error; }
    finally { entry.settledAt = new Date().toISOString(); s.flights.delete(settled); participant.activeCalls -= 1; this.onActivity(id); }
  }
  refreshSaveState(s) {
    if (s.saveState === 'not-loaded' || s.saveState === 'conflict') return;
    s.saveState = s.savedThrough >= s.mutations ? 'draft-saved' : 'check-required';
  }
  request(id, method, payload, requestId = randomUUID()) {
    const s = this.get(id);
    if (!s.connected) fail('EDITOR_OFFLINE', 'Open the editor view for this session and wait for the engine');
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
  // Save and Save As: wait for the calls in flight, hold new calls back, ask the engine to flush
  // (or wait for its autosave), check that the persisted snapshot covers every completed
  // mutation, then write. Agents stay joined throughout.
  async consistent(id, token, write) {
    const s = this.get(id); this.participant(s, token);
    while (s.saving) await s.saving;
    let open; s.saving = new Promise(resolve => { open = resolve; }); this.onActivity(id);
    try {
      await Promise.all([...s.flights]);
      if (s.blocked) fail('OUTCOME_UNKNOWN', 'An operation has an unknown outcome; reload the view before saving');
      const flush = await this.flush(s);
      await s.persistTail;
      if (s.savedThrough < s.mutations) fail('SAVE_NOT_READY', `The engine did not persist ${s.mutations - s.savedThrough} completed change(s); nothing was written`);
      return { ...await this.persist(s, () => write(s)), flush };
    } finally { s.saving = null; open(); this.onActivity(id); }
  }
  async flush(s) {
    const through = s.mutations;
    let flushed = false, answer;
    try {
      answer = await this.request(s.id, 'save');
      flushed = answer === 0 || answer === 1;
    } catch (error) { if (error.code !== 'EDITOR_ERROR') throw error; answer = `error: ${error.message}`; }
    await s.persistTail;
    // The engine answered after persisting everything it had, including mutations completed before the request.
    if (flushed && s.saveState !== 'not-loaded') { s.savedThrough = Math.max(s.savedThrough, through); this.refreshSaveState(s); return { method: 'engine-flush', answer }; }
    if (s.savedThrough >= s.mutations) return { method: 'autosave', answer };
    await new Promise(resolve => {
      const waiter = () => { if (s.savedThrough < s.mutations) return; clearTimeout(timer); s.coverageWaiters.delete(waiter); resolve(); };
      const timer = setTimeout(() => { s.coverageWaiters.delete(waiter); resolve(); }, this.saveWait);
      s.coverageWaiters.add(waiter);
    });
    return { method: 'autosave', answer };
  }
  saveAs(id, token, filename) {
    if (path.extname(filename).toLowerCase() !== '.pen') fail('INVALID_PATH', 'Choose a new .pen file');
    return this.consistent(id, token, async s => {
      const saved = await writeNewFile(filename, await this.currentBytes(s));
      return { path: saved, sessionId: id, sourceUnchanged: true };
    });
  }
  async currentBytes(s) {
    try { return await fs.readFile(s.draft); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return fs.readFile(s.file); }
  }
  // Replace the original only if nobody changed it since the engine loaded it. The previous
  // version is kept in backups/ first; a final hash check runs right before the atomic rename.
  save(id, token) {
    return this.consistent(id, token, async s => {
      const unchanged = async () => s.savedHash !== null && digest(await fs.readFile(s.file)) === s.savedHash;
      const conflict = () => { s.saveState = 'conflict'; fail('SAVE_CONFLICT', 'The original file changed since it was loaded; nothing was replaced. Use Save As'); };
      if (s.saveState === 'conflict' || !await unchanged()) conflict();
      const bytes = await this.currentBytes(s), previous = await fs.readFile(s.file);
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
      await this.writeBaseline(s);
      return { path: s.file, backupPath, sessionId: id, bytes: bytes.length };
    });
  }
  persist(s, operation) {
    const result = s.persistTail.then(operation);
    s.persistTail = result.then(() => {}, () => {});
    return result;
  }
  writeBaseline(s) { return this.atomicWrite(`${s.draft}.baseline`, Buffer.from(JSON.stringify({ sourceHash: s.savedHash }))); }
  // Storage requests are registered synchronously in arrival order, so a snapshot only covers
  // the mutations whose responses reached the service before it.
  storage(id, generation, method, payload) {
    const s = this.get(id), covers = s.mutations;
    return this.persist(s, () => this.storageNow(s, generation, method, payload, covers));
  }
  async storageNow(s, generation, method, payload, covers) {
    if (generation !== s.generation || !s.connected) fail('STALE_CHANNEL', 'Stale channel');
    if (method === 'documents-save-preview') return null; // Optional dashboard thumbnail, no document persistence.
    if (method === 'storage-load') {
      let bytes = await fs.readFile(s.file);
      const sourceHash = digest(bytes);
      s.savedHash = sourceHash; s.saveState = 'saved';
      try {
        bytes = await fs.readFile(s.draft);
        // The baseline records which original the draft was made from, across reloads and restarts.
        try { s.savedHash = JSON.parse(await fs.readFile(`${s.draft}.baseline`, 'utf8')).sourceHash ?? null; }
        catch (error) { if (error.code !== 'ENOENT') throw error; s.savedHash = null; }
        s.saveState = s.savedHash === sourceHash ? 'draft-saved' : 'conflict';
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      s.savedThrough = s.mutations;
      return { filePath: path.basename(s.file), content: bytes.toString('utf8'), updatedAt: (await fs.stat(s.file)).mtimeMs };
    }
    if (method === 'storage-write' || method === 'storage-save-draft') {
      if (typeof payload?.content !== 'string' || Buffer.byteLength(payload.content) > 32 * 1024 * 1024) fail('INVALID_CONTENT', 'Invalid content');
      if (payload.fileURI !== `file:///${s.virtualRoot}${encodeURIComponent(path.basename(s.file))}`) fail('WRONG_DOCUMENT', 'Unexpected document URI');
      let sourceHash;
      try { sourceHash = digest(await fs.readFile(s.file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const conflict = s.savedHash === null || sourceHash !== s.savedHash;
      // Autosaves always keep the work in the draft; only Save publishes it to the original.
      await fs.mkdir(this.draftRoot, { recursive: true, mode: 0o700 });
      await this.atomicWrite(s.draft, Buffer.from(payload.content));
      await this.writeBaseline(s);
      s.savedThrough = Math.max(s.savedThrough, covers);
      if (conflict) s.saveState = 'conflict';
      else { s.saveState = 'saved'; this.refreshSaveState(s); }
      for (const waiter of [...s.coverageWaiters]) waiter();
      return conflict ? 2 : 0;
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
