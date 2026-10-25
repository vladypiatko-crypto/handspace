import { Matrix4, Quaternion, Vector3 } from 'three';

// One Euro filter: smooths jitter when the hand is still, stays responsive when
// it moves fast. (Casiez et al. 2012, the standard filter for hand tracking.)
class OneEuro {
  constructor(minCutoff = 1.0, beta = 6, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: 0 });
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x === null || t <= this.t) { this.x = x; this.t = t; return x; }
    const dt = Math.min(t - this.t, 0.2);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
  reset() { this.x = null; this.dx = 0; }
}

class OneEuro3 {
  constructor(...args) { this.f = [new OneEuro(...args), new OneEuro(...args), new OneEuro(...args)]; }
  filter(v, t) { v.set(this.f[0].filter(v.x, t), this.f[1].filter(v.y, t), this.f[2].filter(v.z, t)); return v; }
  reset() { this.f.forEach((f) => f.reset()); }
}

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// Palm bones that barely bend, used to estimate how far the hand is.
const PALM = [[0, 5], [0, 17], [5, 17], [0, 9]];
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [tip, middle joint]
const PINCH_ON = 0.38; // thumb–index gap as a fraction of palm length
const PINCH_OFF = 0.6; // (hysteresis: once pinching, it takes a clear release to let go)
const FRAME_ANGLE = 55; // thumb this far (degrees) from the index = an "L" for framing
const GRACE_FRAMES = 8; // keep a hand alive briefly when tracking drops out (e.g. in front of the face)
const POINT_ON_FRAMES = 4; // frames of clear pointing before drawing starts
const POINT_OFF_FRAMES = 3; // frames of not pointing before drawing stops
const AFTER_PINCH = 0.45; // seconds after a pinch during which pointing doesn't draw
const POINT_THUMB_GAP = 0.7; // pointing needs the thumb clearly away from the index tip
const POINT_STRAIGHT = 0.9; // and the index finger nearly straight

// Angle (degrees) between the directions a→b and c→d.
function angleDeg(wl, a, b, c, d) {
  const u = new Vector3(wl[b].x - wl[a].x, wl[b].y - wl[a].y, wl[b].z - wl[a].z).normalize();
  const v = new Vector3(wl[d].x - wl[c].x, wl[d].y - wl[c].y, wl[d].z - wl[c].z).normalize();
  return (Math.acos(Math.min(1, Math.max(-1, u.dot(v)))) * 180) / Math.PI;
}

// How straight a finger is: 1 = perfectly straight.
const straightness = (wl, a, b, c, d) =>
  dist3(wl[a], wl[d]) / (dist3(wl[a], wl[b]) + dist3(wl[b], wl[c]) + dist3(wl[c], wl[d]));

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();

export class Hand {
  constructor(id) {
    this.id = id;
    this.present = false;
    this.pinching = false;
    this.started = false; // pinch began this frame
    this.ended = false; // pinch ended this frame
    this.cam = new Vector3(); // pinch point in camera space (meters)
    this.world = new Vector3(); // pinch point in world space
    this.screen = { x: 0.5, y: 0.5 }; // pinch point on screen (0..1)
    this.tipCam = new Vector3(); // index fingertip, for pointing / drawing
    this.tipWorld = new Vector3();
    this.tipScreen = { x: 0.5, y: 0.5 };
    this.drawing = false; // pointing with the index finger (debounced)
    this.drawStarted = false;
    this.drawEnded = false;
    this.pointOn = 0;
    this.pointOff = 0;
    this.pinchEndT = -1; // when the last pinch ended (seconds)
    this.captured = false; // this pinch/point is pressing a UI button, not acting in 3D
    this.rot = new Quaternion(); // hand orientation in world space (for twisting objects)
    this.palmScreen = { x: 0.5, y: 0.5 };
    this.cornerScreen = { x: 0.5, y: 0.5 }; // corner of an "L" (thumb + index) frame
    this.cornerWorld = new Vector3();
    this.lm = null; // landmarks in screen space (0..1)
    this.depth = 0.5;
    this.label = '';
    this.gesture = 'none';
    this.gestureTime = 0;
    this.missing = 0;
    this.filter = new OneEuro3(1.2, 4, 1);
    this.tipFilter = new OneEuro3(1.2, 4, 1);
    this.depthFilter = new OneEuro(0.6, 0.5, 1);
  }

  // Where this hand is acting: the fingertip while pointing, else the pinch point.
  get cursorWorld() { return this.drawing || this.gesture === 'point' ? this.tipWorld : this.world; }
  get cursorScreen() { return this.drawing || this.gesture === 'point' ? this.tipScreen : this.screen; }
}

// A detection that sits almost entirely inside the face, with a shaky
// left/right confidence, is usually the face being misread as a hand.
function looksLikeFace(hand, faceLm) {
  if (!faceLm || (hand.score ?? 1) > 0.85) return false;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of faceLm) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const inside = hand.lm.filter((p) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1).length;
  return inside / hand.lm.length > 0.85;
}

export class HandInput {
  constructor() {
    this.hands = [new Hand(0), new Hand(1)];
    this.lastT = 0;
  }

  get active() {
    return this.hands.filter((h) => h.present);
  }

  // raw: [{ lm, wl, label, score }] from the tracker. view: { W, H, f, mirror }.
  // faceLm (optional): face landmarks, to throw out "hands" that are really
  // part of the face.
  update(raw, view, camera, t, faceLm = null) {
    const dt = this.lastT ? Math.min(t - this.lastT, 0.2) : 0;
    this.lastT = t;
    this._resetEvents();

    const toScreen = (lm) => lm.map((p) => ({ x: view.mirror ? 1 - p.x : p.x, y: p.y, z: p.z }));
    const items = raw.filter((r) => !looksLikeFace(r, faceLm)).map((r) => ({ ...r, slm: toScreen(r.lm) }));
    const assigned = this._assign(items);

    this.hands.forEach((h, i) => {
      const r = assigned[i];
      if (!r) return this._lose(h);
      h.missing = 0;
      if (!h.present) { h.filter.reset(); h.tipFilter.reset(); h.depthFilter.reset(); }
      h.present = true;
      h.lm = r.slm;
      h.label = r.label;

      const { W, H, f } = view;
      const { wl, slm } = r;
      // Distance from camera ≈ focal length × real bone length / bone length in pixels.
      // The least foreshortened palm bone gives the best estimate.
      let ratio = Infinity;
      for (const [a, b] of PALM) {
        const px = Math.hypot((slm[a].x - slm[b].x) * W, (slm[a].y - slm[b].y) * H);
        if (px > 4) ratio = Math.min(ratio, dist3(wl[a], wl[b]) / px);
      }
      const rawDepth = Number.isFinite(ratio) ? f * ratio : h.depth;
      h.depth = h.depthFilter.filter(Math.min(2.5, Math.max(0.12, rawDepth)), t);

      const palm = dist3(wl[0], wl[9]) || 0.09;
      const gap = dist3(wl[4], wl[8]) / palm;
      const indexForward = dist3(wl[0], wl[8]) > dist3(wl[0], wl[6]) * 0.95;
      this._setPinch(h, h.pinching ? gap < PINCH_OFF : gap < PINCH_ON && indexForward, t);
      this._orient(h, wl, view.mirror, camera, !h.rotInit);
      h.palmScreen.x = (slm[0].x + slm[5].x + slm[9].x + slm[13].x + slm[17].x) / 5;
      h.palmScreen.y = (slm[0].y + slm[5].y + slm[9].y + slm[13].y + slm[17].y) / 5;

      const u = (slm[4].x + slm[8].x) / 2;
      const v = (slm[4].y + slm[8].y) / 2;
      this._place(h, u, v, view, camera, t);
      this._placeTip(h, slm[8].x, slm[8].y, view, camera, t);

      const ext = FINGERS.map(([tip, pip]) => dist3(wl[0], wl[tip]) > dist3(wl[0], wl[pip]) * 1.12);
      const curled = FINGERS.map(([tip, pip]) => dist3(wl[0], wl[tip]) < dist3(wl[0], wl[pip]));
      const tucked = FINGERS.map(([tip, pip]) => dist3(wl[0], wl[tip]) < dist3(wl[0], wl[pip]) * 1.05);
      // A real point: straight index, thumb away from it (so not on the way to a
      // pinch) and the other three fingers folded.
      const pointing = ext[0] && tucked[1] && tucked[2] && tucked[3]
        && straightness(wl, 5, 6, 7, 8) > POINT_STRAIGHT && gap > POINT_THUMB_GAP;
      // "L" shape for framing an area: index straight, thumb straight and
      // sticking well out to the side, other fingers folded.
      const thumbAngle = angleDeg(wl, 2, 4, 5, 8);
      const framing = pointing && thumbAngle > FRAME_ANGLE && straightness(wl, 1, 2, 3, 4) > 0.85;
      h.cornerScreen.x = (slm[2].x + slm[5].x) / 2;
      h.cornerScreen.y = (slm[2].y + slm[5].y) / 2;
      this.unproject(h.cornerScreen.x, h.cornerScreen.y, h.depth, view, h.cornerWorld).applyMatrix4(camera.matrixWorld);
      let g = 'hand';
      if (h.pinching) g = 'pinch';
      else if (curled.every(Boolean)) g = 'fist';
      else if (ext[0] && ext[1] && curled[2] && curled[3]) g = 'peace';
      else if (ext.every(Boolean)) g = 'open';
      else if (framing) g = 'frame';
      else if (pointing) g = 'point';
      this._setGesture(h, g, dt);
      this._setDrawing(h, g === 'point' && t - h.pinchEndT > AFTER_PINCH);
    });
  }

  // Hand orientation from the palm (wrist → middle knuckle, index → pinky
  // knuckle), turned into world space. Smoothed, since it's used to rotate
  // held objects.
  _orient(h, wl, mirror, camera, snap) {
    const P = (i) => new Vector3(mirror ? -wl[i].x : wl[i].x, -wl[i].y, -wl[i].z);
    _y.subVectors(P(9), P(0)).normalize();
    _x.subVectors(P(17), P(5)).normalize();
    _z.crossVectors(_x, _y).normalize();
    _x.crossVectors(_y, _z).normalize();
    _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z)).premultiply(camera.quaternion);
    if (snap) h.rot.copy(_q);
    else h.rot.slerp(_q, 0.35);
    h.rotInit = true;
  }

  // Drives hands from the mouse / touch instead of the camera.
  // virtual: [{ u, v, depth, pinching, pointing }] in screen space.
  updateVirtual(virtual, view, camera, t) {
    const dt = this.lastT ? Math.min(t - this.lastT, 0.2) : 0;
    this.lastT = t;
    this._resetEvents();
    this.hands.forEach((h, i) => {
      const vh = virtual[i];
      if (!vh) return this._lose(h, true);
      h.present = true;
      h.missing = 0;
      h.lm = null;
      h.label = 'Pointer';
      h.depth = vh.depth;
      h.filter.reset();
      h.tipFilter.reset();
      h.rot.copy(camera.quaternion); // the mouse can't twist
      h.palmScreen.x = vh.u;
      h.palmScreen.y = vh.v;
      this._setPinch(h, vh.pinching, t);
      this._place(h, vh.u, vh.v, view, camera, t);
      this._placeTip(h, vh.u, vh.v, view, camera, t);
      const g = vh.pinching ? 'pinch' : vh.pointing ? 'point' : 'hand';
      this._setGesture(h, g, dt);
      this._setDrawing(h, g === 'point', true);
    });
  }

  _resetEvents() {
    for (const h of this.hands) {
      h.started = h.ended = false;
      h.drawStarted = h.drawEnded = false;
      if (!h.pinching && !h.drawing) h.captured = false;
    }
  }

  // Screen point (0..1) at the hand's distance → camera space → world space.
  unproject(u, v, depth, { W, H, f }, out) {
    return out.set(((u - 0.5) * W) / f * depth, (-(v - 0.5) * H) / f * depth, -depth);
  }

  _place(h, u, v, view, camera, t) {
    h.screen.x = u;
    h.screen.y = v;
    h.filter.filter(this.unproject(u, v, h.depth, view, h.cam), t);
    h.world.copy(h.cam).applyMatrix4(camera.matrixWorld);
  }

  _placeTip(h, u, v, view, camera, t) {
    h.tipScreen.x = u;
    h.tipScreen.y = v;
    h.tipFilter.filter(this.unproject(u, v, h.depth, view, h.tipCam), t);
    h.tipWorld.copy(h.tipCam).applyMatrix4(camera.matrixWorld);
  }

  // Pointing must hold for a couple of frames to start a stroke, and stop for a
  // few to end it, so tracking flicker doesn't scatter dots or break lines.
  _setDrawing(h, pointing, instant = false) {
    if (pointing) { h.pointOn++; h.pointOff = 0; } else { h.pointOff++; h.pointOn = 0; }
    if (!h.drawing && (instant ? pointing : h.pointOn >= POINT_ON_FRAMES)) {
      h.drawing = true;
      h.drawStarted = true;
    } else if (h.drawing && (instant ? !pointing : h.pointOff >= POINT_OFF_FRAMES)) {
      h.drawing = false;
      h.drawEnded = true;
    }
  }

  _setPinch(h, on, t) {
    if (on && !h.pinching) h.started = true;
    if (!on && h.pinching) { h.ended = true; h.pinchEndT = t; }
    h.pinching = on;
  }

  _setGesture(h, g, dt) {
    if (g === h.gesture) h.gestureTime += dt;
    else { h.gesture = g; h.gestureTime = 0; }
  }

  _lose(h, immediate = false) {
    if (!h.present) return;
    if (!immediate && ++h.missing <= GRACE_FRAMES) return;
    h.present = false;
    h.lm = null;
    if (h.pinching) { h.pinching = false; h.ended = true; }
    if (h.drawing) { h.drawing = false; h.drawEnded = true; }
    h.pointOn = h.pointOff = 0;
    h.rotInit = false;
    h.gesture = 'none';
    h.gestureTime = 0;
  }

  // Keeps each physical hand in the same slot from frame to frame by matching
  // wrist positions, so a stroke never jumps from one hand to the other.
  _assign(items) {
    const out = [null, null];
    const pos = (h) => (h.present && h.lm ? h.lm[0] : h.lm0);
    const d = (h, it) => {
      const p = pos(h);
      return p ? Math.hypot(p.x - it.slm[0].x, p.y - it.slm[0].y) : 1;
    };
    const [a, b] = this.hands;
    if (items.length >= 2) {
      const straight = d(a, items[0]) + d(b, items[1]);
      const swapped = d(a, items[1]) + d(b, items[0]);
      if (swapped < straight) { out[0] = items[1]; out[1] = items[0]; } else { out[0] = items[0]; out[1] = items[1]; }
    } else if (items.length === 1) {
      const it = items[0];
      const pick = a.present && b.present ? (d(a, it) <= d(b, it) ? 0 : 1)
        : a.present ? 0 : b.present ? 1 : 0;
      out[pick] = it;
    }
    for (let i = 0; i < 2; i++) if (out[i]) this.hands[i].lm0 = out[i].slm[0];
    return out;
  }
}
