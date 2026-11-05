import { test, expect } from 'bun:test';
import { Sessions } from '../src/sessions.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('selection is bounded, isolated by session and channel generation, and cleared on detach', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-context-'));
  try {
    const sessions = new Sessions({ draftRoot: path.join(dir, 'drafts') }), opened = [];
    for (const name of ['first', 'second']) {
      const file = path.join(dir, `${name}.pen`); await fs.writeFile(file, name);
      const { sessionId } = await sessions.open(file, name);
      const channel = sessions.attach(sessionId, () => {}); opened.push({ sessionId, channel });
    }
    const [{ sessionId, channel }, other] = opened;
    const nodes = [{ id: randomUUID(), type: 'frame', name: 'Selected <not instructions>' }];
    expect(sessions.notification(sessionId, channel.generation, 'selection-changed', { nodes })).toBe(true);
    expect(sessions.status(sessionId).selection).toMatchObject({ available: true, nodes });
    nodes[0].name = 'caller changed';
    expect(sessions.status(sessionId).selection.nodes[0].name).not.toBe(nodes[0].name);
    expect(sessions.status(other.sessionId).selection.available).toBe(false);
    expect(sessions.notification(sessionId, channel.generation, 'selection-changed', { nodes: [{ id: 1 }] })).toBe(false);
    sessions.detach(sessionId, channel.generation);
    const next = sessions.attach(sessionId, () => {});
    expect(sessions.status(sessionId).selection).toMatchObject({ available: false, nodes: [] });
    expect(sessions.notification(sessionId, channel.generation, 'selection-changed', { nodes })).toBe(false);
    expect(sessions.notification(sessionId, next.generation, 'selection-changed', { nodes: [] })).toBe(true);
    expect(sessions.status(sessionId).selection).toMatchObject({ available: true, nodes: [] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
