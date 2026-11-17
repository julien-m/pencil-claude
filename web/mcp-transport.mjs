import { encodeMessage, MessageDecoder, BRIDGE_BATCH_CHUNKS } from '../shared/bridge-wire.mjs';

/**
 * Own one host-proxied channel. Send independently of receive polls; callers own close().
 * Optional recovery reopens only a view's granted document and never replays queued sends.
 */
export function createMcpTransport(app, initialEditor, { onmessage, onclose, onerror, recovery }) {
  let editor = initialEditor, connectionId, stopped = false, readyState = 0, sendingEpoch, channelEpoch = 0, channelError, recoveryAttempts = 0;
  let decoder = new MessageDecoder();
  const outgoing = [], lifetime = new AbortController();
  const confirmsRecovery = recovery?.isReady ?? (() => true);
  const call = async args => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
    const result = await app.callServerTool({ name: 'pencil_editor_bridge', arguments: args }, { signal, timeout: 10_000 });
    if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text ?? 'MCP editor bridge failed');
    if (!result.structuredContent) throw new Error('MCP editor bridge returned no data');
    return result.structuredContent;
  };
  const closeChannel = async () => {
    if (!connectionId) return;
    const closed = connectionId; connectionId = undefined;
    // Closing is best-effort after a dead service; never let cleanup block teardown.
    try { await app.callServerTool({ name: 'pencil_editor_bridge', arguments: { action: 'close', connectionId: closed } }, { timeout: 2000 }); }
    catch { /* A dead channel is already unusable; no document operation is retried. */ }
  };
  const fail = async error => {
    if (stopped) return;
    if (error.message === 'SESSION_CLOSED') { await finishIntentionally(); return; }
    channelError ??= error; readyState = 0;
    // A send may have reached the editor before failure. Discard all queued chunks.
    outgoing.length = 0;
    await closeChannel();
  };
  const finishIntentionally = async () => {
    if (stopped) return;
    await socket.close(); onmessage({ data: JSON.stringify({ kind: 'session-closed' }) });
  };
  const reopen = async error => {
    if (stopped) return false;
    readyState = 0; outgoing.length = 0; decoder = new MessageDecoder(); channelEpoch++; sendingEpoch = undefined;
    await closeChannel();
    while (!stopped && recovery && recoveryAttempts < recovery.attempts) {
      recoveryAttempts++; recovery.onreconnect?.();
      try {
        await new Promise((resolve, reject) => {
          const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', cancel); resolve(); };
          const cancel = () => { clearTimeout(timer); reject(lifetime.signal.reason); };
          const timer = setTimeout(finish, recovery.delayMs);
          lifetime.signal.addEventListener('abort', cancel, { once: true });
          if (lifetime.signal.aborted) cancel();
        });
        editor = await recovery.reopen(editor, lifetime.signal);
        if (stopped) return false;
        recovery.oneditor?.(editor);
        return true;
      } catch (nextError) { error = nextError; }
    }
    if (!stopped) { await socket.close(); onclose(); onerror(error); }
    return false;
  };
  const flush = async () => {
    if (sendingEpoch === channelEpoch || stopped || !connectionId || readyState !== 1) return;
    const epoch = channelEpoch, channel = connectionId;
    sendingEpoch = epoch;
    try {
      while (outgoing.length && !stopped && epoch === channelEpoch) await call({ action: 'send', connectionId: channel, messages: outgoing.splice(0, BRIDGE_BATCH_CHUNKS) });
    } catch (error) {
      // An old in-flight send has no authority over its replacement channel.
      if (epoch === channelEpoch) await fail(error);
    } finally { if (sendingEpoch === epoch) sendingEpoch = undefined; }
  };
  const socket = {
    get readyState() { return readyState; },
    send(text) {
      if (readyState !== 1) throw new Error('EDITOR_CHANNEL_CLOSED');
      outgoing.push(...encodeMessage(JSON.parse(text)));
      void flush();
    },
    async close() {
      stopped = true; readyState = 3; outgoing.length = 0; decoder = new MessageDecoder(); channelEpoch++; lifetime.abort();
      await closeChannel();
    }
  };
  void (async () => {
    while (!stopped) {
      try {
        channelError = undefined;
        const connected = await call({ action: 'connect', sessionId: editor.sessionId, editorToken: editor.editorToken });
        connectionId = connected.connectionId;
        if (stopped) { await closeChannel(); return; }
        readyState = 1;
        while (!stopped && !channelError) {
          const result = await call({ action: 'exchange', connectionId });
          if (stopped) return;
          if (result.sessionClosed) { await finishIntentionally(); return; }
          if (channelError) throw channelError;
          for (const chunk of result.messages) {
            const message = decoder.accept(chunk);
            if (message !== undefined) {
              if (message.kind === 'session-closed') {
                await finishIntentionally(); return;
              }
              if (confirmsRecovery(message)) recoveryAttempts = 0;
              onmessage({ data: JSON.stringify(message) });
            }
          }
        }
        if (channelError) throw channelError;
      } catch (error) {
        if ((channelError ?? error).message === 'SESSION_CLOSED') { await finishIntentionally(); return; }
        if (!await reopen(channelError ?? error)) return;
      }
    }
  })();
  return socket;
}
