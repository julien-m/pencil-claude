/** Buffer early view messages behind renderer attachment, with a bounded queue. */
export function attachViewChannel(peer, watchReady, onSave) {
  let queued = 0;
  const send = message => { if (peer.readyState === 1) peer.send(JSON.stringify(message)); };
  peer.on('error', () => {});
  peer.on('close', () => { void watchReady.then(watch => watch.close()).catch(() => {}); });
  peer.on('message', async bytes => {
    if (++queued > 100) { queued--; peer.close(1008, 'View input queue full'); return; }
    try {
      const message = JSON.parse(bytes.toString()), watch = await watchReady;
      if (peer.readyState !== 1) return;
      if (message.kind === 'frame-ack') watch.acknowledge(message.id);
      else if (message.kind === 'input') { await watch.input(message.input); send({ kind: 'input-result', id: message.id }); }
      else if (message.kind === 'cancel-input') await watch.cancelInput();
      else if (message.kind === 'save') { await watch.cancelInput(); await onSave(); send({ kind: 'saved' }); }
      else throw new Error('Unsupported view message');
    } catch (error) { send({ kind: 'error', message: error.message }); }
    finally { queued--; }
  });
  void watchReady.catch(() => { send({ kind: 'error', message: 'Renderer unavailable' }); peer.close(); });
}
