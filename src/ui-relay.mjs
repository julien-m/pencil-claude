import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { encodeMessage, MessageDecoder, BRIDGE_BATCH_CHUNKS } from '../shared/bridge-wire.mjs';

// The app talks to its originating MCP server, not to a loopback URL.
// Only this Node-side transport opens the existing authenticated editor socket.
export class UiRelay {
  constructor({ idleTimeout = 120000, pollTimeout = 5000, maxBytes = 40 * 1024 * 1024, endpoint = '/editor', origin } = {}) {
    this.connections = new Map();
    this.idleTimeout = idleTimeout; this.pollTimeout = pollTimeout; this.maxBytes = maxBytes;
    if (!['/editor', '/view'].includes(endpoint)) throw new Error('Unsupported relay endpoint');
    this.endpoint = endpoint; this.origin = origin;
  }
  async connect({ port, sessionId, editorToken }) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${this.endpoint}?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(editorToken)}`, { maxPayload: this.maxBytes, handshakeTimeout: 2000, origin: this.origin });
    const connectionId = randomUUID();
    const state = { sessionId, openedAt: Date.now(), exchanges: 0, pushes: 0, receivedMessages: 0, sentMessages: 0, decoder: new MessageDecoder(), socket, messages: [], bytes: 0, waiting: null, polling: false, closed: false };
    socket.on('error', () => {});
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.kind === 'session-closed') {
          // Terminal control must overtake an incomplete image, including after socket EOF.
          state.sessionClosed = true; state.messages.length = 0; state.bytes = 0;
          state.waiting?.(); return;
        }
        const chunks = encodeMessage(message);
        const queuedBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data), 0);
        if (state.bytes + queuedBytes > this.maxBytes) { this.close(connectionId); return; }
        state.messages.push(...chunks); state.bytes += queuedBytes; state.receivedMessages++;
        state.waiting?.();
      } catch { this.close(connectionId); }
    });
    socket.on('close', () => {
      state.closed = true; state.waiting?.();
    });
    this.connections.set(connectionId, state);
    this.touch(connectionId, state);
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return { connectionId, messages: [] };
    } catch (error) { this.close(connectionId); throw error; }
  }
  touch(id, state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this.close(id), this.idleTimeout);
    state.timer.unref();
  }
  async exchange(connectionId, messages = []) {
    const state = this.connections.get(connectionId);
    if (!state) throw new Error('EDITOR_CHANNEL_CLOSED');
    if (state.polling) throw new Error('EDITOR_EXCHANGE_IN_FLIGHT');
    state.polling = true; state.exchanges++; this.touch(connectionId, state);
    try {
      if (state.sessionClosed) {
        if (state.terminalDelivered) throw new Error('SESSION_CLOSED');
        state.terminalDelivered = true; return { messages: [], sessionClosed: true };
      }
      this.send(connectionId, messages);
      if (!state.messages.length && !state.closed) await new Promise(resolve => {
        const timer = setTimeout(resolve, this.pollTimeout);
        state.waiting = () => { clearTimeout(timer); resolve(); };
      });
      if (state.sessionClosed) {
        state.terminalDelivered = true; return { messages: [], sessionClosed: true };
      }
      if (state.closed && !state.messages.length) throw new Error('EDITOR_CHANNEL_CLOSED');
      const incoming = state.messages.splice(0, BRIDGE_BATCH_CHUNKS);
      state.bytes -= incoming.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.data), 0);
      return { messages: incoming };
    } finally { state.waiting = null; state.polling = false; }
  }
  send(connectionId, chunks = []) {
    const state = this.connections.get(connectionId);
    if (state?.sessionClosed) throw new Error('SESSION_CLOSED');
    if (!state || state.socket.readyState !== WebSocket.OPEN) throw new Error('EDITOR_CHANNEL_CLOSED');
    this.touch(connectionId, state);
    if (chunks.length) state.pushes++;
    try {
      for (const chunk of chunks) {
        const message = state.decoder.accept(chunk);
        if (message !== undefined) { state.socket.send(JSON.stringify(message)); state.sentMessages++; }
      }
    } catch (error) { this.close(connectionId); throw error; }
    return { accepted: chunks.length };
  }
  status(sessionId) {
    return [...this.connections.values()].filter(s => s.sessionId === sessionId).map(s => ({ connected: !s.closed, openedAt: s.openedAt, exchanges: s.exchanges, pushes: s.pushes, receivedMessages: s.receivedMessages, sentMessages: s.sentMessages, queuedChunks: s.messages.length, idleTimeoutMs: this.idleTimeout, pollTimeoutMs: this.pollTimeout }));
  }
  close(connectionId) {
    const state = this.connections.get(connectionId);
    if (!state) return;
    this.connections.delete(connectionId); clearTimeout(state.timer);
    state.closed = true; state.waiting?.(); state.socket.terminate();
  }
  closeAll() { for (const id of this.connections.keys()) this.close(id); }
}
