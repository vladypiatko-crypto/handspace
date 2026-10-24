import { Quaternion, Vector3 } from 'three';
import QRCode from 'qrcode';
import { openCamera, stopStream, videoReady } from './camera.js';
import { Receiver, Sender, normalizeCode } from './link.js';
import { MotionSource, cameraRotation } from './motion.js';
import { Tracker, describeFace } from './tracker.js';
import { HandInput } from './hands.js';
import { World } from './world.js';
import { Effects } from './fx.js';
import { Store } from './store.js';
import { Tools, TOOLS } from './tools.js';
import { Overlay } from './overlay.js';
import { SHAPES } from './objects.js';
import { AirUI } from './airui.js';
import { Anchors } from './anchors.js';
import { Eater } from './eat.js';
import { Physics } from './physics.js';
import { splat } from './sfx.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COLORS = ['#4fd1c5', '#f472b6', '#facc15', '#a78bfa', '#60a5fa', '#fb923c', '#4ade80', '#ffffff'];
const HOLD_TIME = 0.8; // seconds to hold a fist / peace sign
const TOOL_NAMES = { create: 'Create', paint: 'Paint', erase: 'Erase' };
const SHAPE_NAMES = { board: 'Area', slime: 'Slime', bar: 'Bar', box: 'Box', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone', torus: 'Ring' };
const SHAPE_ICONS = { board: '⬜', slime: '🟢', bar: '▭', box: '◻︎', sphere: '◯', cylinder: '⌭', cone: '△', torus: '◎' };
// Settings that are remembered between visits.
const PERSIST = ['tool', 'shape', 'color', 'size', 'showSkeleton', 'face', 'pose', 'fov', 'glow',
  'eat', 'wristRotate', 'physics', 'stick'];
const SETTINGS_VERSION = 2;

// ------------------------------------------------------------------ settings

const settings = {
  tool: 'create', shape: 'board', color: COLORS[0], size: 8,
  showSkeleton: true, face: false, pose: false, glow: true, fov: 62,
  eat: true, wristRotate: true, physics: false, stick: false,
  mirror: true, motion: false, freeView: false, pointerHand: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('handspace.settings') || '{}');
  for (const k of PERSIST) if (k in saved) settings[k] = saved[k];
  if (!TOOLS.includes(settings.tool)) settings.tool = 'create'; // older versions had more tools
  if ((saved.v ?? 1) < 2) settings.shape = 'board'; // two-hand pinch now makes a drawing area by default
} catch { /* ignore */ }

function saveSettings() {
  try {
    localStorage.setItem('handspace.settings', JSON.stringify({
      v: SETTINGS_VERSION, ...Object.fromEntries(PERSIST.map((k) => [k, settings[k]])),
    }));
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ core objects

const video = $('#video');
const stage = $('#stage');
const world = new World($('#three'), video);
const fx = new Effects(world.scene);
const store = new Store(world.content);
store.load();
const anchors = new Anchors({ world });
const tools = new Tools({ world, fx, store, settings, anchors, onStick: (label) => toast(`📌 Stuck to ${label}`) });
const physics = new Physics({
  world,
  onSettled: () => store.commit(),
  onSplat: (o, speed) => {
    splat(speed);
    fx.emit(o.position, o.userData.data.color, 14, 0.3, 0.6);
  },
});
const eater = new Eater({ world, fx, store, tools, onBite: (msg) => toast(msg) });
const overlay = new Overlay($('#overlay'));
const handInput = new HandInput();
const tracker = new Tracker();
const motion = new MotionSource();

let source = null; // 'local' | 'remote'
let stream = null;
let facing = 'user';
let receiver = null;
let sender = null;
let trackerReady = false;
let trackerStarted = false;
let lastResult = null;
let autoPointer = false; // mouse-as-hand was switched on because there was no camera
const remote = { facing: 'user', q: new Quaternion(), baseInv: new Quaternion(), has: false, needsRecenter: true };

// Expose for debugging and automated tests.
window.handspace = {
  settings, world, store, tools, handInput, tracker, remote,
  get airUI() { return airUI; },
  anchors, physics, eater,
  get sender() { return sender; },
  get senderMotion() { return senderMotion; },
};

// ------------------------------------------------------------------ helpers

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

function show(id) {
  for (const s of $$('.screen')) s.classList.toggle('hidden', s.id !== id);
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock) keepAwake();
});

// Face tracking feeds the face mesh, eating, and sticking things to your face.
const needsFace = () => settings.face || settings.eat || settings.stick;

async function startTracker() {
  if (trackerStarted) return;
  trackerStarted = true;
  $('#hud-status').textContent = 'Loading hand tracking…';
  try {
    await tracker.init();
    trackerReady = true;
    if (needsFace()) tracker.enable('face');
    if (settings.pose) tracker.enable('pose');
    if (settings.stick) tracker.enable('objects');
  } catch (err) {
    console.error(err);
    toast('Hand tracking failed to load — using mouse/touch instead');
    setSetting('pointerHand', true);
  }
}

// ------------------------------------------------------------------ layout

// Lowers the render resolution when the frame rate drops, and raises it again
// when there's room.
const quality = { scale: 1, slow: 0, fast: 0 };
function adaptQuality(dt) {
  if (dt <= 0 || document.hidden) return;
  if (dt > 1 / 40) { quality.slow += dt; quality.fast = 0; } else if (dt < 1 / 55) { quality.fast += dt; quality.slow = 0; }
  if (quality.slow > 1.5 && quality.scale > 0.5) {
    quality.scale = Math.max(0.5, quality.scale * 0.8);
    quality.slow = 0;
    layout();
  } else if (quality.fast > 6 && quality.scale < 1) {
    quality.scale = Math.min(1, quality.scale * 1.15);
    quality.fast = 0;
    layout();
  }
}

let layoutKey = '';
function layout() {
  const W = video.videoWidth || 1280;
  const H = video.videoHeight || 720;
  const vw = innerWidth;
  const vh = innerHeight;
  const aspect = W / H;
  // Fill the screen, unless that would crop away too much of the camera image.
  const cover = Math.max(vw / (vh * aspect), (vh * aspect) / vw) < 1.35;
  let w;
  let h;
  if ((vw / vh > aspect) === cover) { w = vw; h = vw / aspect; } else { h = vh; w = vh * aspect; }
  w = Math.round(w);
  h = Math.round(h);
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  const pr = Math.min(devicePixelRatio, 2, Math.sqrt(4e6 / (w * h))) * quality.scale;
  world.resize(w, h, pr);
  overlay.resize(w, h, pr);
  layoutKey = `${W}x${H}@${vw}x${vh}`;
}
addEventListener('resize', layout);

// ------------------------------------------------------------------ camera sources

function remember(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* ignore */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

async function useLocalCamera() {
  source = 'local';
  remember('handspace.source', 'local');
  receiver?.destroy();
  receiver = null;
  $('#pair').classList.add('hidden');
  stopStream(stream);
  try {
    stream = await openCamera(facing);
    video.srcObject = stream;
    await videoReady(video);
    await video.play().catch(() => {});
    setSetting('mirror', facing === 'user');
    if (autoPointer) { autoPointer = false; setSetting('pointerHand', false); }
  } catch (err) {
    console.warn(err);
    toast('No camera available — use your mouse or finger as a hand');
    autoPointer = !settings.pointerHand;
    setSetting('pointerHand', true);
  }
  layout();
}

function useRemoteCamera() {
  source = 'remote';
  remember('handspace.source', 'receive');
  stopStream(stream);
  stream = null;
  video.srcObject = null;
  receiver?.destroy();
  $('#pair').classList.remove('hidden');
  $('#pair-status').textContent = 'Connecting to pairing server…';
  receiver = new Receiver({
    code: recall('handspace.pairCode'), // same code every time, so the phone can reconnect by itself
    onStream: async (s) => {
      video.srcObject = s;
      await videoReady(video);
      await video.play().catch(() => {});
      $('#pair').classList.add('hidden');
      layout();
      toast('Phone connected');
    },
    onMessage: onRemoteMessage,
    onStatus: (status, detail) => {
      if (status === 'waiting') showPairCode();
      else if (status === 'connected') $('#pair-status').textContent = 'Connected';
      else if (status === 'lost') {
        $('#pair').classList.remove('hidden');
        $('#pair-status').textContent = 'Connection lost — waiting for the phone to reconnect…';
      } else if (status === 'error') $('#pair-status').textContent = `Problem: ${detail}`;
    },
  });
}

function showPairCode() {
  remember('handspace.pairCode', receiver.code);
  $('#pair-code').textContent = receiver.code;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('#pair-status').textContent = local
    ? 'Tip: this page is on localhost, so the QR code won\'t open on your phone. Open the app from its network address or hosted site instead, or type the code by hand.'
    : 'Waiting for phone…';
  QRCode.toCanvas($('#pair-qr'), receiver.joinUrl(), { width: 200, margin: 1 });
}

function onRemoteMessage(msg) {
  if (msg?.t === 'cam') {
    remote.facing = msg.facing;
    remote.needsRecenter = true;
    setSetting('mirror', msg.facing === 'user');
  } else if (msg?.t === 'ori') {
    remote.q.fromArray(msg.q);
    remote.has = true;
    if (remote.needsRecenter) { remote.baseInv.copy(remote.q).invert(); remote.needsRecenter = false; }
  }
}

function recenter() {
  if (source === 'remote') remote.needsRecenter = true;
  else motion.recenter();
  toast('View recentered');
}

const _rel = new Quaternion();
function updateCameraRotation() {
  const cam = world.camera;
  if (!settings.motion) { cam.quaternion.identity(); return; }
  let front;
  if (source === 'remote') {
    if (!remote.has) return;
    _rel.copy(remote.baseInv).multiply(remote.q);
    front = remote.facing === 'user';
  } else {
    if (!motion.hasData) return;
    motion.relative(_rel);
    front = facing === 'user';
  }
  cameraRotation(_rel, { front, mirror: settings.mirror }, cam.quaternion);
}

// ------------------------------------------------------------------ settings UI

async function setSetting(key, value) {
  settings[key] = value;
  const input = $(`[data-setting="${key}"]`);
  if (input) {
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
  }
  if (key === 'mirror') world.setMirror(value);
  if (key === 'glow') world.glow = value;
  if (key === 'freeView') {
    world.setFree(value);
    stage.classList.toggle('free', value);
  }
  if (key === 'fov') $('#fov-val').textContent = `${value}°`;
  const model = { face: 'face', eat: 'face', pose: 'pose', stick: 'objects' }[key];
  if (model && value && trackerReady && !tracker.has(model)) {
    const name = { face: 'face tracking', pose: 'body tracking', objects: 'object recognition' }[model];
    toast(`Loading ${name}…`);
    tracker.enable(model).then(() => toast(`${name[0].toUpperCase()}${name.slice(1)} on`), () => toast(`Couldn't load ${name}`));
    if (key === 'stick' && !tracker.has('face')) tracker.enable('face');
  }
  if (key === 'physics') {
    $('#physics-btn').classList.toggle('active', value);
    if (value) physics.wakeAll();
  }
  if (key === 'stick') $('#stick-btn').classList.toggle('active', value);
  if (key === 'motion' && value) {
    if (source === 'remote') {
      remote.needsRecenter = true;
      if (!remote.has) toast('Turn on "Send phone motion" on the phone');
    } else if (!(await motion.start())) {
      toast('Motion sensors are not available on this device');
      setSetting('motion', false);
      return;
    } else {
      motion.needsRecenter = true;
      setTimeout(() => {
        if (settings.motion && !motion.hasData) {
          toast('No motion sensor found — this works on phones and tablets');
          setSetting('motion', false);
        }
      }, 1500);
    }
  }
  if (key === 'motion' && !value && source !== 'remote') motion.stop();
  if (PERSIST.includes(key)) saveSettings();
}

function setTool(tool) {
  if (tool === settings.tool) return;
  tools.cancel();
  settings.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#shapes').classList.toggle('hidden', tool !== 'create');
  saveSettings();
}

function setShape(shape) {
  settings.shape = shape;
  for (const b of $$('[data-shape]')) b.classList.toggle('active', b.dataset.shape === shape);
  saveSettings();
}

function setColor(color) {
  settings.color = color;
  for (const b of $$('.swatch')) b.classList.toggle('active', b.dataset.color === color);
  document.documentElement.style.setProperty('--accent', color === '#ffffff' ? '#4fd1c5' : color);
  saveSettings();
}

function buildToolbar() {
  const colors = $('#colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.style.boxShadow = `0 0 12px ${c}`;
    b.title = c;
    b.onclick = () => setColor(c);
    colors.append(b);
  }
  for (const b of $$('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  for (const b of $$('[data-shape]')) b.onclick = () => setShape(b.dataset.shape);
  $('#size').value = settings.size;
  $('#size').oninput = (e) => { settings.size = +e.target.value; saveSettings(); };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#menu-btn').onclick = () => $('#menu').classList.toggle('hidden');
  $('#menu-close').onclick = () => $('#menu').classList.add('hidden');

  for (const input of $$('[data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = !!settings[key];
    else input.value = settings[key];
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      setSetting(key, input.type === 'checkbox' ? input.checked : +input.value);
    });
  }
  $('#fov-val').textContent = `${settings.fov}°`;

  $('#recenter').onclick = recenter;
  $('#flip-cam').onclick = () => {
    if (source === 'remote') { receiver?.send({ t: 'flip' }); return; }
    facing = facing === 'user' ? 'environment' : 'user';
    useLocalCamera();
  };
  $('#export-json').onclick = () => store.exportJson().then((msg) => toast(msg || 'Saved'), (err) => toast(`Save failed: ${err.message}`));
  $('#import-json').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await store.importJson(file); toast('Opened'); } catch (err) { toast(`Couldn't open: ${err.message}`); }
  };
  $('#export-glb').onclick = () => store.exportGlb().then((msg) => toast(msg || 'Exported .glb'), (err) => toast(`Export failed: ${err.message}`));
  $('#clear').onclick = () => {
    if (store.count && confirm('Delete everything? (You can still undo.)')) { tools.cancel(); store.clear(); toast('Cleared'); }
  };
  $('#home').onclick = () => {
    remember('handspace.source', null);
    location.href = location.pathname;
  };
  $('#physics-btn').onclick = () => setSetting('physics', !settings.physics);
  $('#stick-btn').onclick = () => setSetting('stick', !settings.stick);
  $('#physics-btn').classList.toggle('active', settings.physics);
  $('#stick-btn').classList.toggle('active', settings.stick);
  $('#pair-cancel').onclick = () => { facing = 'user'; useLocalCamera(); };

  setTool(settings.tool);
  $('#shapes').classList.toggle('hidden', settings.tool !== 'create');
  setShape(settings.shape);
  setColor(settings.color);
  world.setMirror(settings.mirror);
  world.glow = settings.glow;
}

function undo() {
  tools.cancel();
  if (store.undo()) toast('Undo');
}
function redo() {
  tools.cancel();
  if (store.redo()) toast('Redo');
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if ($('#app').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  const toolKeys = { c: 'create', d: 'create', g: 'create', s: 'create', p: 'paint', e: 'erase' };
  if (toolKeys[k]) setTool(toolKeys[k]);
  else if (k === 'z') undo();
  else if (k === 'y') redo();
  else if (k === 'f') setSetting('freeView', !settings.freeView);
  else if (k === 'r') recenter();
  else if (k === 'm' || k === 'escape') $('#menu').classList.toggle('hidden', k === 'escape' || !$('#menu').classList.contains('hidden'));
  else if (k >= '1' && k <= String(SHAPES.length)) { setTool('create'); setShape(SHAPES[+k - 1]); }
});

// ------------------------------------------------------------------ mouse / touch as a hand

const pointer = { inside: false, down: false, u: 0.5, v: 0.5, u0: 0.5, v0: 0.5, depth: 0.45 };
const canvas3d = $('#three');
function pointerPos(e) {
  const r = stage.getBoundingClientRect();
  pointer.u = (e.clientX - r.left) / r.width;
  pointer.v = (e.clientY - r.top) / r.height;
}
canvas3d.addEventListener('pointerdown', (e) => {
  if (!settings.pointerHand || settings.freeView) return;
  pointerPos(e);
  pointer.inside = true;
  pointer.down = true;
  pointer.u0 = pointer.u;
  pointer.v0 = pointer.v;
  pointer.mode = null;
  pointer.shape = e.shiftKey || e.button === 2;
  pointer.forceDraw = e.altKey;
  canvas3d.setPointerCapture(e.pointerId);
});
canvas3d.addEventListener('contextmenu', (e) => { if (settings.pointerHand) e.preventDefault(); });
canvas3d.addEventListener('pointermove', (e) => { pointerPos(e); pointer.inside = true; });
canvas3d.addEventListener('pointerup', () => { pointer.down = false; });
canvas3d.addEventListener('pointercancel', () => { pointer.down = false; });
canvas3d.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pointer.down) pointer.inside = false; });
canvas3d.addEventListener('wheel', (e) => {
  if (!settings.pointerHand || settings.freeView) return;
  e.preventDefault();
  pointer.depth = Math.min(1.5, Math.max(0.15, pointer.depth * Math.exp(e.deltaY * 0.001)));
  toast(`Depth ${(pointer.depth * 100).toFixed(0)} cm`);
}, { passive: false });

// Mouse/touch stands in for hands. In Create mode: drag on empty space draws
// (like pointing), drag an object to move it (like pinching), and Shift-drag or
// right-drag stretches a shape (like pinching with both hands). Alt-drag always
// draws, so you can draw on objects too.
const _pt = new Vector3();
function pointerMode(view) {
  if (settings.tool !== 'create') return 'pinch';
  if (pointer.shape) return 'shape';
  if (pointer.forceDraw) return 'point';
  handInput.unproject(pointer.u0, pointer.v0, pointer.depth, view, _pt).applyMatrix4(world.camera.matrixWorld);
  return tools.pick(_pt, false) ? 'pinch' : 'point';
}

function virtualHands(view) {
  if (!pointer.inside) return [];
  const { u, v, depth, down } = pointer;
  if (!down) return [{ u, v, depth }];
  pointer.mode ??= pointerMode(view);
  if (pointer.mode === 'shape') {
    return [{ u: pointer.u0, v: pointer.v0, depth, pinching: true }, { u, v, depth, pinching: true }];
  }
  return [{ u, v, depth, pinching: pointer.mode === 'pinch', pointing: pointer.mode === 'point' }];
}

// ------------------------------------------------------------------ hands-free menu

function nextShape() {
  const next = SHAPES[(SHAPES.indexOf(settings.shape) + 1) % SHAPES.length];
  setTool('create');
  setShape(next);
  toast(`Shape: ${SHAPE_NAMES[next]}`);
}

function nextColor() {
  setColor(COLORS[(COLORS.indexOf(settings.color) + 1) % COLORS.length]);
}

const airUI = new AirUI({
  stage,
  menu: $('#palm-menu'),
  items: [
    { id: 'create', icon: '✋', label: 'Create', run: () => setTool('create'), active: () => settings.tool === 'create' },
    { id: 'paint', icon: '🎨', label: 'Paint', run: () => setTool('paint'), active: () => settings.tool === 'paint' },
    { id: 'erase', icon: '🧽', label: 'Erase', run: () => setTool('erase'), active: () => settings.tool === 'erase' },
    { id: 'shape', icon: () => SHAPE_ICONS[settings.shape], label: () => SHAPE_NAMES[settings.shape], run: nextShape, keep: true },
    { id: 'color', icon: () => `<i class="dot" style="background:${settings.color}"></i>`, label: 'Color', run: nextColor, keep: true },
    { id: 'physics', icon: '🍎', label: 'Gravity', run: () => setSetting('physics', !settings.physics), active: () => settings.physics, keep: true },
    { id: 'stick', icon: '📌', label: 'Stick', run: () => setSetting('stick', !settings.stick), active: () => settings.stick, keep: true },
    { id: 'undo', icon: '↶', label: 'Undo', run: undo, keep: true },
    { id: 'redo', icon: '↷', label: 'Redo', run: redo, keep: true },
    { id: 'view', icon: '🧊', label: '3D view', run: () => setSetting('freeView', !settings.freeView), active: () => settings.freeView },
    { id: 'settings', icon: '⚙️', label: 'Settings', run: () => $('#menu').classList.remove('hidden') },
    { id: 'close', icon: '✕', label: 'Close', run: () => {} },
  ],
});

// ------------------------------------------------------------------ hold gestures

function holdGestures() {
  for (const h of handInput.hands) {
    if (h.gesture !== h.firedFor) h.firedFor = null;
    if (h.firedFor || h.gestureTime < HOLD_TIME) continue;
    if (h.gesture === 'fist') { undo(); h.firedFor = 'fist'; }
    if (h.gesture === 'peace') {
      const next = SHAPES[(SHAPES.indexOf(settings.shape) + 1) % SHAPES.length];
      setShape(next);
      toast(`Shape: ${SHAPE_NAMES[next]}`);
      h.firedFor = 'peace';
    }
  }
}

// ------------------------------------------------------------------ main loop

let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let hudTime = 0;
let lastTrackT = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const t = now / 1000;

  const W = video.videoWidth || 1280;
  const H = video.videoHeight || 720;
  if (layoutKey !== `${W}x${H}@${innerWidth}x${innerHeight}`) layout();
  const f = Math.max(W, H) / 2 / Math.tan((settings.fov * Math.PI) / 360);
  world.setIntrinsics(W, H, f);
  updateCameraRotation();
  world.camera.updateMatrixWorld();
  const view = { W, H, f, mirror: settings.mirror };

  let updated = false;
  let fresh = null;
  if (trackerReady) {
    fresh = tracker.detect(video, { face: needsFace(), pose: settings.pose, objects: settings.stick });
    if (fresh) {
      lastResult = fresh;
      fpsFrames++;
      if (!settings.pointerHand) {
        handInput.update(fresh.hands, view, world.camera, t, fresh.face?.lm);
        updated = true;
      }
    }
  }
  if (settings.pointerHand && !settings.freeView) {
    handInput.updateVirtual(virtualHands(view), view, world.camera, t);
    updated = true;
  }
  if (updated) {
    const trackDt = lastTrackT ? Math.min(t - lastTrackT, 0.2) : 0;
    lastTrackT = t;
    if (!settings.pointerHand) airUI.update(handInput.hands, trackDt);
    holdGestures();
    tools.update(handInput.hands);
  }
  if (fresh) {
    if (settings.stick) anchors.update(fresh, handInput.hands, view, world.camera, t);
    if (settings.eat) eater.update(fresh.face, view);
  }
  anchors.apply();
  const held = tools.busy();
  for (const o of world.content.children) if (o.userData.data?.anchor) held.add(o);
  physics.track(dt, held, settings.physics);
  if (settings.physics) physics.update(dt, held, view);

  fx.update(dt, t, handInput.hands, settings.color, tools.radius, world.camera);
  overlay.draw({
    hands: settings.freeView ? [] : handInput.hands,
    face: settings.face ? lastResult?.face : null,
    pose: settings.pose ? lastResult?.pose : null,
    mirror: settings.mirror,
    showSkeleton: settings.showSkeleton,
    color: settings.color,
    holdTimes: { fist: HOLD_TIME, peace: HOLD_TIME, open: airUI.holdTime },
    menuOpen: airUI.open,
    mouth: settings.eat && !settings.freeView ? eater.state : null,
    anchors: settings.stick && !settings.freeView ? anchors.visible() : null,
    t,
  });
  world.render(dt);
  adaptQuality(dt);

  fpsTime += dt;
  if (fpsTime > 1) { $('#fps').textContent = trackerReady ? `${Math.round(fpsFrames / fpsTime)} fps tracking` : ''; fpsFrames = 0; fpsTime = 0; }
  hudTime += dt;
  if (hudTime > 0.15) { hudTime = 0; updateHud(); }
}

function updateHud() {
  const hands = handInput.active;
  let status;
  if (!trackerReady && !settings.pointerHand) status = 'Loading hand tracking…';
  else if (settings.pointerHand) {
    status = settings.tool === 'create'
      ? 'Drag to draw · drag an object to move it · Shift-drag for a shape · Alt-drag to draw on objects · scroll = depth'
      : `${TOOL_NAMES[settings.tool]} · click or drag over objects`;
  } else if (!hands.length) status = 'Show your hands to the camera';
  else if (settings.tool === 'create') {
    status = `☝️ point to draw · 🤏 pinch to grab (twist to turn) · 🤏🤏 pull apart for ${settings.shape === 'board' ? 'an area' : `a ${SHAPE_NAMES[settings.shape].toLowerCase()}`} · ✋ hold palm for menu`;
  }
  else status = `${TOOL_NAMES[settings.tool]} · pinch or point at objects`;
  if (tools.hint && (trackerReady || settings.pointerHand)) status = tools.hint[0].toUpperCase() + tools.hint.slice(1);
  const detail = [];
  for (const h of hands) {
    if (h.lm) detail.push(`${h.id ? 'Hand 2' : 'Hand 1'}: ${h.gesture} · ${(h.depth * 100).toFixed(0)} cm`);
  }
  if (settings.face) {
    const face = lastResult?.face;
    detail.push(face ? `Face: ${describeFace(face.blend).join(', ') || 'neutral'}` : 'Face: not found');
  }
  if (settings.stick) {
    const seen = anchors.visible().filter((a) => !['face', 'hand', 'body'].includes(a.label)).map((a) => a.label);
    detail.push(seen.length ? `Seeing: ${[...new Set(seen)].join(', ')}` : 'Seeing: no objects');
  }
  if (settings.physics) detail.push('Gravity on');
  if (tracker.mode === 'main') detail.push('tracking on main thread');
  if (settings.pose) detail.push(lastResult?.pose ? 'Body: tracked' : 'Body: not found');
  detail.push(`${store.count} object${store.count === 1 ? '' : 's'}`);
  $('#hud-status').textContent = status;
  $('#hud-detail').textContent = detail.join(' · ');
}

// ------------------------------------------------------------------ sender (phone)

let senderFacing = 'user';
let senderStream = null;
let oriTimer = null;
let senderRetry = null;
const senderMotion = new MotionSource();
const _q = new Quaternion();

async function openSender(code = '', autoConnect = false) {
  show('sender');
  remember('handspace.source', 'send');
  $('#sender-code').value = normalizeCode(code);
  keepAwake();
  await restartSenderCamera();
  if (autoConnect && normalizeCode(code).length === 6) senderConnect();
}

async function restartSenderCamera() {
  stopStream(senderStream);
  try {
    senderStream = await openCamera(senderFacing);
  } catch (err) {
    $('#sender-status').textContent = `Camera unavailable: ${err.message}`;
    return;
  }
  const v = $('#sender-video');
  v.srcObject = senderStream;
  v.style.transform = senderFacing === 'user' ? 'scaleX(-1)' : '';
  sender?.replaceStream(senderStream);
  sender?.send({ t: 'cam', facing: senderFacing });
}

async function senderConnect() {
  const code = normalizeCode($('#sender-code').value);
  if (code.length !== 6) { $('#sender-status').textContent = 'Enter the 6-character code shown on your PC.'; return; }
  remember('handspace.sendCode', code);
  if (!senderStream) await restartSenderCamera();
  if (!senderStream) return;
  let motionNote = '';
  if ($('#sender-motion').checked && !(await senderMotion.start())) {
    motionNote = ' (motion sensors blocked, so objects won\'t follow phone turns)';
  }
  sender?.destroy();
  sender = new Sender({
    onStatus: (status, detail) => {
      const text = {
        connecting: 'Connecting…',
        connected: `Connected — look at your PC screen ✨${motionNote}`,
        lost: 'Disconnected',
        error: `Problem: ${detail}`,
      }[status];
      $('#sender-status').textContent = text;
      if (status === 'connected') sender.send({ t: 'cam', facing: senderFacing });
      // Keep trying until the PC is there (e.g. the phone was opened first).
      if (status === 'error' || status === 'lost') {
        clearTimeout(senderRetry);
        senderRetry = setTimeout(() => { if (!$('#sender').classList.contains('hidden')) senderConnect(); }, 4000);
        $('#sender-status').textContent += ' · retrying…';
      }
    },
    onMessage: (msg) => {
      if (msg?.t === 'flip') { senderFacing = senderFacing === 'user' ? 'environment' : 'user'; restartSenderCamera(); }
    },
  });
  try {
    await sender.connect(code, senderStream);
  } catch {
    return; // status already shows the error
  }
  clearInterval(oriTimer);
  oriTimer = setInterval(() => {
    if (!$('#sender-motion').checked || !senderMotion.hasData) return;
    sender.send({ t: 'ori', q: _q.copy(senderMotion.current).toArray().map((v) => +v.toFixed(5)) });
  }, 33);
}

$('#sender-connect').onclick = senderConnect;
$('#sender-dim').onclick = () => $('#dim').classList.remove('hidden');
$('#dim').onclick = () => $('#dim').classList.add('hidden');
$('#sender-flip').onclick = () => { senderFacing = senderFacing === 'user' ? 'environment' : 'user'; restartSenderCamera(); };
$('#sender-back').onclick = () => {
  clearInterval(oriTimer);
  clearTimeout(senderRetry);
  sender?.destroy();
  sender = null;
  stopStream(senderStream);
  senderStream = null;
  history.replaceState(null, '', location.pathname);
  remember('handspace.source', null);
  show('start');
};

// ------------------------------------------------------------------ start

function enterApp() {
  show('app');
  keepAwake();
  layout();
  startTracker();
}

for (const b of $$('[data-start]')) {
  b.onclick = () => {
    const mode = b.dataset.start;
    if (mode === 'send') return openSender();
    enterApp();
    if (mode === 'local') useLocalCamera();
    else useRemoteCamera();
  };
}

buildToolbar();
requestAnimationFrame(loop);

// Start straight away with whatever camera setup was used last time, so the
// app needs no clicks (the browser asks for camera permission only once).
const params = new URLSearchParams(location.search);
const lastSource = recall('handspace.source');
if (params.get('join')) openSender(params.get('join'), true);
else if (params.get('mode') === 'local' || (!params.get('mode') && lastSource === 'local')) { enterApp(); useLocalCamera(); }
else if (params.get('mode') === 'receive' || (!params.get('mode') && lastSource === 'receive')) { enterApp(); useRemoteCamera(); }
else if (lastSource === 'send') openSender(recall('handspace.sendCode') ?? '', true);
