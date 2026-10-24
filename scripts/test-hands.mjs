// Sanity checks for hand depth / pinch / gesture logic using a synthetic hand
// projected through a known pinhole camera. Run: node scripts/test-hands.mjs
import { PerspectiveCamera } from 'three';
import { HandInput } from '../src/hands.js';

const W = 1280, H = 720, f = 1000;
const camera = new PerspectiveCamera();
camera.updateMatrixWorld();

// Rough flat hand, meters, wrist at origin, fingers pointing up (-y in image).
function makeHand({ pinch = false, fist = false, peace = false } = {}) {
  const p = [];
  p[0] = [0, 0, 0];
  const fingers = { 1: -0.035, 5: -0.02, 9: 0, 13: 0.018, 17: 0.035 };
  for (const [base, x] of Object.entries(fingers)) {
    const b = +base;
    for (let k = 0; k < 4; k++) p[b + k] = [x, 0.08 + k * 0.025, 0];
  }
  p[1] = [-0.025, 0.02, 0]; p[2] = [-0.04, 0.04, 0]; p[3] = [-0.05, 0.06, 0]; p[4] = [-0.055, 0.08, 0];
  const curl = (b) => { p[b + 2] = [p[b][0], 0.07, 0.02]; p[b + 3] = [p[b][0], 0.05, 0.01]; };
  if (fist) [5, 9, 13, 17].forEach(curl);
  if (peace) [13, 17].forEach(curl);
  if (pinch) { p[8] = [-0.03, 0.12, 0.01]; p[4] = [-0.035, 0.115, 0.012]; }
  return p.map(([x, y, z]) => ({ x, y, z }));
}

function frame(hand, depth, cx = 0, cy = 0) {
  const lm = hand.map((q) => {
    const X = cx + q.x, Y = cy + q.y, Z = depth + q.z;
    return { x: 0.5 + (X * f) / Z / W, y: 0.5 - (Y * f) / Z / H, z: 0 };
  });
  return { lm, wl: hand.map((q) => ({ x: q.x, y: -q.y, z: q.z })), label: 'Right' };
}

const view = { W, H, f, mirror: false };
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

for (const d of [0.3, 0.5, 0.9]) {
  const input = new HandInput();
  let t = 0;
  for (let i = 0; i < 40; i++) input.update([frame(makeHand(), d)], view, camera, (t += 1 / 30));
  const h = input.hands[0];
  check(`depth ${d} m`, Math.abs(h.depth - d) / d < 0.08, `→ ${h.depth.toFixed(3)}`);
}

{
  const input = new HandInput();
  let t = 0;
  input.update([frame(makeHand(), 0.5)], view, camera, (t += 0.033));
  check('open hand not pinching', !input.hands[0].pinching, input.hands[0].gesture);
  input.update([frame(makeHand({ pinch: true }), 0.5)], view, camera, (t += 0.033));
  check('pinch starts', input.hands[0].pinching && input.hands[0].started);
  input.update([frame(makeHand({ pinch: true }), 0.5)], view, camera, (t += 0.033));
  check('started fires once', !input.hands[0].started);
  input.update([frame(makeHand(), 0.5)], view, camera, (t += 0.033));
  check('pinch ends', !input.hands[0].pinching && input.hands[0].ended);
  for (let i = 0; i < 3; i++) input.update([], view, camera, (t += 0.033));
  check('brief dropout keeps hand', input.hands[0].present);
  for (let i = 0; i < 3; i++) input.update([], view, camera, (t += 0.033));
  check('long dropout loses hand', !input.hands[0].present);
}

{
  const input = new HandInput();
  let t = 0;
  for (let i = 0; i < 30; i++) input.update([frame(makeHand({ fist: true }), 0.5)], view, camera, (t += 0.033));
  check('fist detected and held', input.hands[0].gesture === 'fist' && input.hands[0].gestureTime > 0.8, input.hands[0].gesture);
  for (let i = 0; i < 5; i++) input.update([frame(makeHand({ peace: true }), 0.5)], view, camera, (t += 0.033));
  check('peace detected', input.hands[0].gesture === 'peace', input.hands[0].gesture);
}

{
  // Two hands keep their slots when they swap order in the tracker output.
  const input = new HandInput();
  let t = 0;
  const L = () => frame(makeHand(), 0.5, -0.15), R = () => frame(makeHand(), 0.5, 0.15);
  input.update([L(), R()], view, camera, (t += 0.033));
  const x0 = input.hands[0].screen.x;
  input.update([R(), L()], view, camera, (t += 0.033));
  check('hand slots stable', Math.abs(input.hands[0].screen.x - x0) < 0.01);
  // Pinch point lands where the fingers are on screen.
  const h = input.hands[0];
  const sx = (h.cam.x * f) / -h.cam.z / W + 0.5;
  check('3D point projects onto fingers', Math.abs(sx - h.screen.x) < 0.01, `${sx.toFixed(3)} vs ${h.screen.x.toFixed(3)}`);
}

process.exit(fails ? 1 : 0);
