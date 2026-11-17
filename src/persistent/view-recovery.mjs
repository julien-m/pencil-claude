// Keep document reopening authority in the MCP process, not in a browser-supplied path.
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

/** @typedef {{path: string, scope: string}} OpenedDocument */
/** @typedef {{sessionId: string, editorToken: string}} EditorGrant */
/** @typedef {EditorGrant & {recoveryToken: string}} RecoverableEditor */
/** @typedef {{document: OpenedDocument, recoveryToken: string, sessionId?: string, closed?: boolean, pending?: Promise<RecoverableEditor>}} RecoveryRecord */

/** Owns one opaque recovery grant per opened document/scope for this MCP lifetime. */
export class ViewRecovery {
  /** @param {(document: OpenedDocument) => Promise<EditorGrant>} openDocument */
  constructor(openDocument) {
    this.openDocument = openDocument;
    /** @type {Map<string, RecoveryRecord>} */
    this.documents = new Map();
    /** @type {Map<string, RecoveryRecord>} */
    this.grants = new Map();
  }

  /** Record the canonical, already-authorized document; return a reusable view-only grant. */
  async remember(document, editor) {
    const canonical = { path: await realpath(document.path), scope: document.scope };
    const key = JSON.stringify(canonical);
    let record = this.documents.get(key);
    if (!record) {
      record = { document: canonical, recoveryToken: randomUUID() };
      this.documents.set(key, record); this.grants.set(record.recoveryToken, record);
    }
    record.sessionId = editor.sessionId;
    return { ...editor, recoveryToken: record.recoveryToken };
  }

  /** Reopen exactly the granted document; coalesce concurrent view recoveries. No edit is replayed. */
  async recover(recoveryToken) {
    const record = this.grants.get(recoveryToken);
    if (!record) throw new Error('VIEW_RECOVERY_NOT_FOUND');
    if (!record.pending) {
      record.pending = (async () => ({ ...await this.openDocument(record.document), recoveryToken: record.recoveryToken }))();
    }
    const pending = record.pending;
    try { const editor = await pending; if (record.closed) throw new Error('SESSION_CLOSED'); record.sessionId = editor.sessionId; return editor; }
    finally { if (record.pending === pending) record.pending = undefined; }
  }
  /** Revoke the finished session's capabilities, including an in-flight recovery result. */
  invalidate(sessionId) {
    for (const [key, record] of this.documents) if (record.sessionId === sessionId) {
      record.closed = true; this.grants.delete(record.recoveryToken); this.documents.delete(key);
    }
  }
}
