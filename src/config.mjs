export const DEFAULT_EDITOR_WAIT_MS = 20000;
// The service reads this once at startup and advertises it to every MCP client.
export function editorWaitFromEnv(value = process.env.PENCIL_EDITOR_WAIT_MS) {
  const wait = Number(value ?? DEFAULT_EDITOR_WAIT_MS);
  if (!Number.isFinite(wait) || wait < 0 || wait > 600000) throw new Error('PENCIL_EDITOR_WAIT_MS must be between 0 and 600000');
  return wait;
}
