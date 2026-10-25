import { TrackerCore } from './tracker-core.js';

// Runs hand/face/body/object tracking off the main thread, so drawing and
// rendering never wait for the AI. Frames arrive as ImageBitmaps.

const core = new TrackerCore();

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      const delegate = await core.init(msg.wasmBase, msg.models);
      self.postMessage({ type: 'ready', delegate });
    } else if (msg.type === 'enable') {
      await core.enable(msg.kind);
      self.postMessage({ type: 'enabled', kind: msg.kind });
    } else if (msg.type === 'frame') {
      const result = core.run(msg.bitmap, msg.now, msg.opts);
      msg.bitmap.close();
      self.postMessage({ type: 'result', result });
    }
  } catch (err) {
    msg.bitmap?.close();
    self.postMessage({ type: 'error', of: msg.type, kind: msg.kind, message: String(err?.message ?? err) });
  }
};
