// Minimal stand-in for the Pencil engine: records every request and answers flush ("save")
// requests on its own, like the real engine, unless told otherwise.
export function attachEngine(sessions, sessionId, { flush = 0 } = {}) {
  const requests = [];
  let channel;
  const send = message => {
    requests.push(message);
    if (message.method !== 'save' || flush === null) return;
    queueMicrotask(() => sessions.reply(sessionId, channel.generation, flush instanceof Error ? { id: message.id, error: { message: flush.message } } : { id: message.id, payload: flush }));
  };
  channel = sessions.attach(sessionId, send);
  const answer = (request, payload = { content: [] }) => sessions.reply(sessionId, channel.generation, { id: request.id, payload });
  const calls = () => requests.filter(r => r.method === 'mcp-tool-call');
  return { ...channel, requests, calls, answer };
}
