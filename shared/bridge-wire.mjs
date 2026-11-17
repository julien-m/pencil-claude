export const BRIDGE_CHUNK_CHARS = 32768;
export const BRIDGE_BATCH_CHUNKS = 4;
export const BRIDGE_MAX_CHARS = 40 * 1024 * 1024;

export function encodeMessage(message) {
  const text = JSON.stringify(message);
  if (text.length > BRIDGE_MAX_CHARS) throw new Error('EDITOR_MESSAGE_TOO_LARGE');
  const transferId = crypto.randomUUID(), chunks = [];
  for (let index = 0, start = 0; start < text.length; index++, start += BRIDGE_CHUNK_CHARS)
    chunks.push({ transferId, index, done: start + BRIDGE_CHUNK_CHARS >= text.length, data: text.slice(start, start + BRIDGE_CHUNK_CHARS) });
  return chunks;
}

export class MessageDecoder {
  constructor() { this.current = null; }
  accept(chunk) {
    if (!chunk || typeof chunk.transferId !== 'string' || !Number.isSafeInteger(chunk.index) || typeof chunk.data !== 'string' || typeof chunk.done !== 'boolean' || chunk.data.length > BRIDGE_CHUNK_CHARS) throw new Error('INVALID_EDITOR_CHUNK');
    if (!this.current) {
      if (chunk.index !== 0) throw new Error('EDITOR_CHUNK_OUT_OF_ORDER');
      this.current = { id: chunk.transferId, next: 0, parts: [], length: 0 };
    }
    const current = this.current;
    if (chunk.transferId !== current.id || chunk.index !== current.next++) throw new Error('EDITOR_CHUNK_OUT_OF_ORDER');
    current.parts.push(chunk.data); current.length += chunk.data.length;
    if (current.length > BRIDGE_MAX_CHARS) throw new Error('EDITOR_MESSAGE_TOO_LARGE');
    if (!chunk.done) return undefined;
    this.current = null;
    return JSON.parse(current.parts.join(''));
  }
}
