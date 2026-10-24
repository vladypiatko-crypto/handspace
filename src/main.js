import { Quaternion } from 'three';
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

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COLORS = ['#4fd1c5', '#f472b6', '#facc15', '#a78bfa', '#60a5fa', '#fb923c', '#4ade80', '#ffffff'];
const HOLD_TIME = 0.8; // seconds to hold a fist / peace sign
const TOOL_NAMES = { draw: 'Draw', shape: 'Shape', grab: 'Grab', paint: 'Paint', erase: 'Erase' };
// Settings that are remembered between visits.
const PERSIST = ['tool', 'shape', 'color', 'size', 'showSkeleton', 'face', 'pose', 'fov', 'glow'];

// ------------------------------------------------------------------ settings

const settings = {
  tool: 'draw', shape: 'bar', color: COLORS[0], size: 8,
  showSkeleton: true, face: false, pose: false, glow: true, fov: 62,
  mirror: true, motion: false, freeView: false, pointerHand: false,
};
try {
  const saved = JSON.parse(localStorage.getItem('handspace.settings') || '{}');
  for (const k of PERSIST) if (k in saved) settings[k] = saved[k];
} catch { /* ignore */ }

function saveSettings() {
  try {
    localStorage.setItem('handspace.settings', JSON.stringify(Object.fromEntries(PERSIST.map((k) => [k, settings[k]]))));
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ core objects

const video = $('#video');
const stage = $('#stage');
const world = new World($('#three'), video);
const fx = new Effects(world.scene);
const store = new Store(world.content);
store.load();
const tools = new Tools({ world, fx, store, settings });
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

async function startTracker() {
  if (trackerStarted) return;
  trackerStarted = true;
  $('#hud-status').textContent = 'Loading hand tracking…';
  try {
    await tracker.init();
    trackerReady = true;
    if (settings.face) tracker.enable('face');
    if (settings.pose) tracker.enable('pose');
  } catch (err) {
    console.error(err);
    toast('Hand tracking failed to load — using mouse/touch instead');
    setSetting('pointerHand', true);
  }
}

// ------------------------------------------------------------------ layout

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
  const pr = Math.min(devicePixelRatio, 2, Math.sqrt(4e6 / (w * h)));
  world.resize(w, h, pr);
  overlay.resize(w, h, pr);
  layoutKey = `${W}x${H}@${vw}x${vh}`;
}
addEventListener('resize', layout);

// ------------------------------------------------------------------ camera sources

async function useLocalCamera() {
  source = 'local';
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
  stopStream(stream);
  stream = null;
  video.srcObject = null;
  receiver?.destroy();
  $('#pair').classList.remove('hidden');
  $('#pair-status').textContent = 'Connecting to pairing server…';
  receiver = new Receiver({
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
  if ((key === 'face' || key === 'pose') && value && trackerReady && !tracker[key]) {
    toast(`Loading ${key === 'face' ? 'face' : 'body'} tracking…`);
    tracker.enable(key).then(() => toast(`${key === 'face' ? 'Face' : 'Body'} tracking on`),
      () => toast(`Couldn't load ${key} tracking`));
  }
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
  $('#shapes').classList.toggle('hidden', tool !== 'shape');
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
  $('#export-json').onclick = () => { store.exportJson(); toast('Saved'); };
  $('#import-json').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await store.importJson(file); toast('Opened'); } catch (err) { toast(`Couldn't open: ${err.message}`); }
  };
  $('#export-glb').onclick = () => store.exportGlb().then(() => toast('Exported .glb'), (err) => toast(`Export failed: ${err.message}`));
  $('#clear').onclick = () => {
    if (store.count && confirm('Delete everything? (You can still undo.)')) { tools.cancel(); store.clear(); toast('Cleared'); }
  };
  $('#home').onclick = () => { location.href = location.pathname; };
  $('#pair-cancel').onclick = () => { facing = 'user'; useLocalCamera(); };

  setTool(settings.tool);
  $('#shapes').classList.toggle('hidden', settings.tool !== 'shape');
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
  const toolKeys = { d: 'draw', s: 'shape', g: 'grab', p: 'paint', e: 'erase' };
  if (toolKeys[k]) setTool(toolKeys[k]);
  else if (k === 'z') undo();
  else if (k === 'y') redo();
  else if (k === 'f') setSetting('freeView', !settings.freeView);
  else if (k === 'r') recenter();
  else if (k === 'm' || k === 'escape') $('#menu').classList.toggle('hidden', k === 'escape' || !$('#menu').classList.contains('hidden'));
  else if (k >= '1' && k <= String(SHAPES.length)) { setTool('shape'); setShape(SHAPES[+k - 1]); }
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
  canvas3d.setPointerCapture(e.pointerId);
});
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

function virtualHands() {
  if (!pointer.inside) return [];
  const { u, v, depth, down } = pointer;
  if (settings.tool === 'shape' && down) {
    // One click-drag = both hands: the press point and the current point.
    return [{ u: pointer.u0, v: pointer.v0, depth, pinching: true }, { u, v, depth, pinching: true }];
  }
  return [{ u, v, depth, pinching: down }];
}

// ------------------------------------------------------------------ hold gestures

function holdGestures() {
  for (const h of handInput.hands) {
    if (h.gesture !== h.firedFor) h.firedFor = null;
    if (h.firedFor || h.gestureTime < HOLD_TIME) continue;
    if (h.gesture === 'fist') { undo(); h.firedFor = 'fist'; }
    if (h.gesture === 'peace') {
      const next = TOOLS[(TOOLS.indexOf(settings.tool) + 1) % TOOLS.length];
      setTool(next);
      toast(`Tool: ${TOOL_NAMES[next]}`);
      h.firedFor = 'peace';
    }
  }
}

// ------------------------------------------------------------------ main loop

let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let hudTime = 0;

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
  if (trackerReady) {
    const r = tracker.detect(video, { face: settings.face, pose: settings.pose });
    if (r) {
      lastResult = r;
      fpsFrames++;
      if (!settings.pointerHand) { handInput.update(r.hands, view, world.camera, t); updated = true; }
    }
  }
  if (settings.pointerHand && !settings.freeView) {
    handInput.updateVirtual(virtualHands(), view, world.camera, t);
    updated = true;
  }
  if (updated) {
    holdGestures();
    tools.update(handInput.hands);
  }

  fx.update(dt, t, handInput.hands, settings.color, world.camera);
  overlay.draw({
    hands: settings.freeView ? [] : handInput.hands,
    face: settings.face ? lastResult?.face : null,
    pose: settings.pose ? lastResult?.pose : null,
    mirror: settings.mirror,
    showSkeleton: settings.showSkeleton,
    color: settings.color,
    holdTime: HOLD_TIME,
    t,
  });
  world.render(dt);

  fpsTime += dt;
  if (fpsTime > 1) { $('#fps').textContent = trackerReady ? `${Math.round(fpsFrames / fpsTime)} fps tracking` : ''; fpsFrames = 0; fpsTime = 0; }
  hudTime += dt;
  if (hudTime > 0.15) { hudTime = 0; updateHud(); }
}

function updateHud() {
  const hands = handInput.active;
  let status;
  if (!trackerReady && !settings.pointerHand) status = 'Loading hand tracking…';
  else if (settings.pointerHand) status = `${TOOL_NAMES[settings.tool]} · mouse/touch hand (scroll = depth)`;
  else if (!hands.length) status = `${TOOL_NAMES[settings.tool]} · show your hands to the camera`;
  else status = `${TOOL_NAMES[settings.tool]} · ${hands.length} hand${hands.length > 1 ? 's' : ''}`;
  if (tools.hint) status += ` — ${tools.hint}`;
  const detail = [];
  for (const h of hands) {
    if (h.lm) detail.push(`${h.id ? 'Hand 2' : 'Hand 1'}: ${h.gesture} · ${(h.depth * 100).toFixed(0)} cm`);
  }
  if (settings.face) {
    const face = lastResult?.face;
    detail.push(face ? `Face: ${describeFace(face.blend).join(', ') || 'neutral'}` : 'Face: not found');
  }
  if (settings.pose) detail.push(lastResult?.pose ? 'Body: tracked' : 'Body: not found');
  detail.push(`${store.count} object${store.count === 1 ? '' : 's'}`);
  $('#hud-status').textContent = status;
  $('#hud-detail').textContent = detail.join(' · ');
}

// ------------------------------------------------------------------ sender (phone)

let senderFacing = 'user';
let senderStream = null;
let oriTimer = null;
const senderMotion = new MotionSource();
const _q = new Quaternion();

async function openSender(code = '') {
  show('sender');
  $('#sender-code').value = normalizeCode(code);
  keepAwake();
  await restartSenderCamera();
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
  sender?.destroy();
  sender = null;
  stopStream(senderStream);
  senderStream = null;
  history.replaceState(null, '', location.pathname);
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

const params = new URLSearchParams(location.search);
if (params.get('join')) openSender(params.get('join'));
else if (params.get('mode') === 'local') { enterApp(); useLocalCamera(); }
else if (params.get('mode') === 'receive') { enterApp(); useRemoteCamera(); }
