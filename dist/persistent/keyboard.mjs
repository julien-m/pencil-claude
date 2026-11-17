/** Preserve the pressed key's spelling even if modifiers change before keyup. */
export function keyboardInput(event, action, held) {
  const identity = event.code || event.key;
  if (action === 'down') {
    const key = held.get(identity) ?? (event.key === ' ' ? 'Space' : event.key);
    held.set(identity, key);
    return { type: 'key', action, key };
  }
  const key = held.get(identity);
  if (key === undefined) return null;
  held.delete(identity);
  return { type: 'key', action, key };
}
