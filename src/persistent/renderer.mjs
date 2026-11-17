import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { inputSchema } from './input.mjs';

/** One invisible browser hosts an independent renderer for every broker session. */
export class RendererHost {
  constructor({ executablePath, origin, brokerPort, viewport = { width: 1280, height: 800 } }) {
    this.options = { executablePath, origin, brokerPort, viewport };
    this.sessions = new Map();
  }
  async browser() {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ executablePath: this.options.executablePath, headless: true, chromiumSandbox: true,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    }
    return this.browserPromise;
  }
  async ensure(sessionId, engineToken) {
    if (!this.sessions.has(sessionId)) {
      const pending = this.create(sessionId, engineToken);
      this.sessions.set(sessionId, pending);
      pending.catch(() => { if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId); });
    }
    return this.sessions.get(sessionId);
  }
  async create(sessionId, token) {
    const browser = await this.browser();
    const context = await browser.newContext({ viewport: this.options.viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const state = { id: randomUUID(), sessionId, context, page, viewers: new Set(), frame: null, frameNumber: 0, inputTail: Promise.resolve(), pendingInputs: 0, streaming: false, controller: null, keys: new Set(), buttons: new Set() };
    try {
      const hash = new URLSearchParams({ session: sessionId, token, brokerPort: String(this.options.brokerPort) });
      await page.goto(`${this.options.origin}/engine#${hash}`, { timeout: 30_000 });
      await page.waitForFunction(() => window.engineState === 'ready', undefined, { timeout: 30_000 });
      const cdp = await context.newCDPSession(page);
      state.cdp = cdp;
      await cdp.send('Page.enable');
      cdp.on('Page.screencastFrame', event => {
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        this.publish(state, event.data);
      });
      return state;
    } catch (error) { await context.close(); throw error; }
  }
  publish(state, data) {
    state.frame = { kind: 'frame', rendererId: state.id, id: ++state.frameNumber, width: this.options.viewport.width, height: this.options.viewport.height, data };
    for (const viewer of state.viewers) this.sendFrame(state, viewer);
  }
  sendFrame(state, viewer) {
    if (!state.frame || viewer.pendingFrame || viewer.lastFrame === state.frame.id || viewer.socket.readyState !== 1) return;
    viewer.pendingFrame = state.frame.id;
    viewer.socket.send(JSON.stringify(state.frame));
  }
  async watch(sessionId, socket) {
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('Renderer not found');
    if (state.closing) throw new Error('SESSION_CLOSING');
    const viewer = { id: randomUUID(), socket, pendingFrame: 0, lastFrame: 0, closed: false };
    state.viewers.add(viewer);
    if (!state.streaming) {
      state.streaming = true;
      await state.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: this.options.viewport.width, maxHeight: this.options.viewport.height });
    }
    this.publish(state, (await state.page.screenshot({ type: 'jpeg', quality: 75, timeout: 10_000 })).toString('base64'));
    return {
      input: value => this.input(sessionId, value, viewer),
      cancelInput: () => this.cancelInput(sessionId, viewer),
      acknowledge: id => {
        if (viewer.pendingFrame !== id) return;
        viewer.lastFrame = id; viewer.pendingFrame = 0;
        this.sendFrame(state, viewer);
      },
      close: async () => {
        viewer.closed = true;
        state.viewers.delete(viewer);
        await this.cancelInput(sessionId, viewer);
        if (!state.viewers.size && state.streaming) {
          state.streaming = false;
          await state.cdp.send('Page.stopScreencast').catch(() => {});
        }
      },
    };
  }
  async input(sessionId, value, viewer) {
    const input = inputSchema.parse(value);
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('Renderer not found');
    if (state.closing) throw new Error('SESSION_CLOSING');
    if (state.pendingInputs >= 100) throw new Error('Input queue full');
    state.pendingInputs++;
    const run = state.inputTail.then(async () => {
      if (viewer.closed) throw new Error('View disconnected before input dispatch');
      if (state.controller !== viewer.id && (state.keys.size || state.buttons.size)) throw new Error('Another view is completing an interaction');
      state.controller = viewer.id;
      const page = state.page, viewport = this.options.viewport;
      if (input.type === 'pointer' || input.type === 'wheel') {
        await page.mouse.move(input.x * viewport.width, input.y * viewport.height);
        if (input.type === 'wheel') await page.mouse.wheel(input.deltaX, input.deltaY);
        else if (input.action !== 'move') {
          await page.mouse[input.action]({ button: input.button });
          if (input.action === 'down') state.buttons.add(input.button); else state.buttons.delete(input.button);
        }
      } else if (input.type === 'key') {
        await page.keyboard[input.action](input.key);
        if (input.action === 'down') state.keys.add(input.key); else state.keys.delete(input.key);
      }
      else await page.keyboard.insertText(input.text);
    });
    state.inputTail = run.catch(() => {});
    try { await run; } finally { state.pendingInputs--; }
  }
  async cancelInput(sessionId, viewer) {
    const state = await this.sessions.get(sessionId);
    if (!state) return;
    const run = state.inputTail.then(async () => {
      if (state.controller !== viewer.id) return;
      for (const key of state.keys) await state.page.keyboard.up(key);
      for (const button of state.buttons) await state.page.mouse.up({ button });
      state.keys.clear(); state.buttons.clear(); state.controller = null;
    });
    state.inputTail = run.catch(() => {});
    return run;
  }
  async status(sessionId) {
    const state = await this.sessions.get(sessionId);
    return state ? { rendererId: state.id, viewers: state.viewers.size, pendingInputs: state.pendingInputs, closed: state.page.isClosed() } : null;
  }
  async close() {
    const browser = await this.browserPromise;
    await browser?.close();
    this.sessions.clear();
  }
  /** Freeze input before Save; do not interrupt pending interactions. */
  async prepareClose(sessionId) {
    const state = await this.sessions.get(sessionId);
    if (!state || state.pendingInputs || state.keys.size || state.buttons.size) throw new Error('RENDERER_BUSY');
    state.closing = true; await state.inputTail;
  }
  async resume(sessionId) {
    const state = await this.sessions.get(sessionId);
    if (state) state.closing = false;
  }
  /** Release one context and its viewers, retaining the shared browser and other contexts. */
  async closeSession(sessionId) {
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('Renderer not found');
    for (const viewer of state.viewers) {
      const socket = viewer.socket;
      // A stale viewer must not prevent disposal of its editor.
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ kind: 'session-closed' }), () => socket.close());
        else socket.terminate();
      } catch { socket.terminate(); }
    }
    let timer;
    try {
      // An uncertain close must never kill the shared browser or another document.
      await Promise.race([state.context.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('EDITOR_CLOSE_TIMEOUT')), 10_000); })]);
    } finally { clearTimeout(timer); }
    state.viewers.clear(); state.frame = null; this.sessions.delete(sessionId);
  }
}
