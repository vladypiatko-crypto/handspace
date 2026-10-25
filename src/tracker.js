import { HandLandmarker, FaceLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { TrackerCore } from './tracker-core.js';
import TrackerWorker from './tracker-worker.js?worker';

// Google's pre-trained MediaPipe models (the same ones used by Meet effects and
// many web games). The wasm runtime is served from our own public/ folder.
// The Android app bundles the hand model so tracking works offline.
function modelUrls() {
  const inApp = navigator.userAgent.includes('HandSpaceApp');
  const base = 'https://storage.googleapis.com/mediapipe-models';
  return {
    hand: inApp
      ? new URL('models/hand_landmarker.task', document.baseURI).href
      : `${base}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    face: `${base}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    pose: `${base}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    // EfficientDet-Lite0: recognizes 80 everyday things (cup, phone, bottle, book, ...).
    objects: `${base}/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite`,
  };
}

const SLOW_MS = 28; // main-thread tracking slower than this per frame stutters the picture

export const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
export const FACE_CONTOURS = FaceLandmarker.FACE_LANDMARKS_CONTOURS;
export const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

// Runs tracking in a Web Worker so the 3D view never waits for it (falls back
// to the main thread where workers can't run MediaPipe). detect() never
// blocks: it sends the newest camera frame when the worker is free and returns
// a result whenever a new one has arrived.
export class Tracker {
  constructor() {
    this.ready = false;
    this.mode = null; // 'worker' | 'main'
    this.loaded = new Set();
    this.enabling = {};
    this.waiters = {};
    this.pending = null;
    this.busySince = 0;
    this.lastTime = -1;
    this.cost = 0; // average time one main-thread tracking run blocks the page (ms)
    this.runs = 0;
    this.autoTried = false;
    this.resultTimes = []; // when recent results arrived, for results/second
  }

  // Picks the fastest setup. GPU on the main thread is what MediaPipe is built
  // for and runs in real time; feeding a worker frame by frame is far slower
  // when the GPU is involved. Only without a GPU does the worker win, because
  // CPU tracking there at least doesn't stall the 3D view.
  // ?tracker=main or ?tracker=worker forces one (for testing).
  async init() {
    const wasmBase = new URL('mediapipe/wasm', document.baseURI).href;
    const models = modelUrls();
    this.wasmBase = wasmBase;
    this.models = models;
    const force = new URLSearchParams(location.search).get('tracker');
    if (force) this.autoTried = true;

    if (force !== 'worker') {
      const core = new TrackerCore();
      try {
        const delegate = await core.init(wasmBase, models);
        if (delegate === 'GPU' || force === 'main') {
          this.useMain(core, delegate);
          return;
        }
        // CPU only: try the worker instead, keep this as a fallback.
        this.fallback = { core, delegate };
      } catch (err) {
        console.warn('Main-thread tracking failed', err);
      }
    }

    try {
      this.delegate = await this.startWorker(wasmBase, models);
      this.mode = 'worker';
      this.fallback?.core.close();
    } catch (err) {
      console.warn('Tracking worker unavailable', err);
      this.worker?.terminate();
      this.worker = null;
      if (!this.fallback) throw err;
      this.useMain(this.fallback.core, this.fallback.delegate);
      return;
    }
    this.loaded.add('hand');
    this.ready = true;
  }

  useMain(core, delegate) {
    this.core = core;
    this.mode = 'main';
    this.delegate = delegate;
    this.loaded.add('hand');
    this.ready = true;
  }

  startWorker(wasmBase, models) {
    return new Promise((resolve, reject) => {
      const w = new TrackerWorker();
      this.worker = w;
      const timer = setTimeout(() => reject(new Error('tracking worker timed out')), 25000);
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'worker failed')); };
      w.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(timer);
          w.onmessage = (ev) => this.onMessage(ev.data);
          resolve(data.delegate);
        } else if (data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(data.message));
        }
      };
      w.postMessage({ type: 'init', wasmBase, models });
    });
  }

  counted() {
    const now = performance.now();
    this.resultTimes.push(now);
    while (this.resultTimes.length && now - this.resultTimes[0] > 3000) this.resultTimes.shift();
  }

  // Tracking results per second over the last few seconds.
  rate() {
    const now = performance.now();
    return this.resultTimes.filter((t) => now - t < 3000).length / 3;
  }

  // Trial run of the background worker: switch to it for a few seconds and
  // keep it only if it delivers at least ~70% as many results. It never
  // blocks the page, so at a similar rate the picture is much smoother.
  async tryWorker() {
    this.autoTried = true;
    const mainRate = this.rate();
    const mainDelegate = this.delegate;
    try {
      const delegate = await this.startWorker(this.wasmBase, this.models);
      for (const kind of this.loaded) if (kind !== 'hand') this.worker.postMessage({ type: 'enable', kind });
      this.mode = 'worker';
      this.delegate = delegate;
      this.resultTimes = [];
      setTimeout(() => {
        const workerRate = this.rate();
        console.info(`tracking: main thread ${mainRate.toFixed(1)}/s (${this.cost.toFixed(0)} ms each), worker ${workerRate.toFixed(1)}/s`);
        if (workerRate < mainRate * 0.7) {
          this.worker.terminate();
          this.worker = null;
          this.mode = 'main';
          this.delegate = mainDelegate;
        } else {
          this.core.close();
          this.core = null;
        }
      }, 4000);
    } catch (err) {
      console.warn('Background tracking trial failed', err);
      this.worker?.terminate();
      this.worker = null;
      this.mode = 'main';
    }
  }

  onMessage(msg) {
    if (msg.type === 'result') {
      this.pending = msg.result;
      this.busySince = 0;
      this.counted();
    } else if (msg.type === 'enabled') {
      this.loaded.add(msg.kind);
      this.waiters[msg.kind]?.resolve();
    } else if (msg.type === 'error') {
      if (msg.of === 'frame') this.busySince = 0;
      if (msg.of === 'enable') this.waiters[msg.kind]?.reject(new Error(msg.message));
    }
  }

  has(kind) {
    return this.loaded.has(kind);
  }

  // Face, body and object models load the first time they're switched on.
  enable(kind) {
    if (this.loaded.has(kind)) return Promise.resolve();
    if (!this.enabling[kind]) {
      this.enabling[kind] = this.mode === 'main'
        ? this.core.enable(kind).then(() => { this.loaded.add(kind); })
        : new Promise((resolve, reject) => {
          this.waiters[kind] = { resolve, reject };
          this.worker.postMessage({ type: 'enable', kind });
        });
      this.enabling[kind].catch(() => { delete this.enabling[kind]; });
    }
    return this.enabling[kind];
  }

  detect(video, opts) {
    if (!this.ready || video.readyState < 2 || !video.videoWidth) return null;
    if (this.mode === 'main') {
      if (video.currentTime === this.lastTime) return null;
      this.lastTime = video.currentTime;
      const t0 = performance.now();
      const r = this.core.run(video, t0, opts);
      const ms = performance.now() - t0;
      this.cost = this.runs++ ? this.cost * 0.9 + ms * 0.1 : ms;
      this.counted();
      // Tracking is holding up every frame (slow phone GPU)? See whether the
      // background worker does better.
      if (!this.autoTried && this.runs > 60 && this.cost > SLOW_MS) this.tryWorker();
      return r;
    }
    const now = performance.now();
    if (this.busySince && now - this.busySince > 2000) this.busySince = 0; // lost frame: move on
    if (!this.busySince && video.currentTime !== this.lastTime) {
      this.lastTime = video.currentTime;
      this.busySince = now;
      // The models work on small images anyway; a smaller frame is quicker to copy.
      const scale = Math.min(1, 640 / video.videoWidth);
      createImageBitmap(video, {
        resizeWidth: Math.round(video.videoWidth * scale),
        resizeHeight: Math.round(video.videoHeight * scale),
        resizeQuality: 'low',
      }).then(
        (bitmap) => this.worker.postMessage({ type: 'frame', bitmap, now: performance.now(), opts }, [bitmap]),
        () => { this.busySince = 0; },
      );
    }
    const r = this.pending;
    this.pending = null;
    return r;
  }
}

// Turns face blendshape scores into a short list of readable expressions.
export function describeFace(blend) {
  if (!blend) return [];
  const g = (k) => blend[k] ?? 0;
  const tags = [];
  if ((g('mouthSmileLeft') + g('mouthSmileRight')) / 2 > 0.5) tags.push('smiling 😄');
  if (g('jawOpen') > 0.4) tags.push('mouth open 😮');
  if (g('eyeBlinkLeft') > 0.5 && g('eyeBlinkRight') > 0.5) tags.push('eyes closed 😌');
  else if (g('eyeBlinkLeft') > 0.5 || g('eyeBlinkRight') > 0.5) tags.push('winking 😉');
  if (g('browInnerUp') > 0.5) tags.push('eyebrows up 🤨');
  if (g('mouthPucker') > 0.6) tags.push('pucker 😗');
  if (g('cheekPuff') > 0.4) tags.push('cheeks puffed 🐡');
  return tags;
}
