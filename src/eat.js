import { Box3, Vector3 } from 'three';
import { chomp } from './sfx.js';

// Eat your creations: bring something to your mouth, open wide, then close.
// Three bites and it's gone. Uses the face tracker's mouth landmarks and its
// "jawOpen" expression score.

const LIP_TOP = 13;
const LIP_BOTTOM = 14;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;
const EYE_LEFT = 33; // outer eye corners, ~9 cm apart on most adults
const EYE_RIGHT = 263;
const EYE_SPAN = 0.09;
const OPEN = 0.3;
const CLOSED = 0.12;
const BITES = 3;

const _box = new Box3();
const _c = new Vector3();
const _s = new Vector3();

export class Eater {
  constructor({ world, fx, store, tools, onBite }) {
    Object.assign(this, { world, fx, store, tools, onBite });
    this.armed = null; // object waiting in your open mouth
    this.state = null; // for the overlay: { x, y, r, open, target }
  }

  update(face, { W, H, f, mirror }) {
    this.state = null;
    if (!face?.lm || !face.blend) { this.armed = null; return; }
    const lm = face.lm;
    const X = (p) => (mirror ? 1 - p.x : p.x);
    const mx = (X(lm[LIP_TOP]) + X(lm[LIP_BOTTOM])) / 2;
    const my = (lm[LIP_TOP].y + lm[LIP_BOTTOM].y) / 2;
    const mouthPx = Math.hypot((X(lm[MOUTH_LEFT]) - X(lm[MOUTH_RIGHT])) * W, (lm[MOUTH_LEFT].y - lm[MOUTH_RIGHT].y) * H);
    const eyePx = Math.hypot((X(lm[EYE_LEFT]) - X(lm[EYE_RIGHT])) * W, (lm[EYE_LEFT].y - lm[EYE_RIGHT].y) * H);
    const faceDepth = eyePx > 4 ? (f * EYE_SPAN) / eyePx : 0.6;
    const jaw = face.blend.jawOpen ?? 0;

    const inMouth = (o) => {
      _box.setFromObject(o);
      if (_box.isEmpty()) return Infinity;
      _box.getCenter(_c);
      const size = _box.getSize(_s).length();
      const depth = -_c.clone().applyMatrix4(this.world.camera.matrixWorldInverse).z;
      if (depth <= 0.05 || Math.abs(depth - faceDepth) > 0.35) return Infinity;
      const p = _c.clone().project(this.world.camera);
      const dx = ((p.x + 1) / 2 - mx) * W;
      const dy = ((1 - p.y) / 2 - my) * H;
      const objPx = Math.min((size / 2) * f / depth, mouthPx * 2);
      const d = Math.hypot(dx, dy);
      return d < mouthPx * 0.9 + objPx * 0.5 ? d : Infinity;
    };

    let target = null;
    let best = Infinity;
    for (const o of this.world.content.children) {
      if (o.userData.data?.anchor === 'face') continue; // stuck to your face: decoration, not food
      const d = inMouth(o);
      if (d < best) { best = d; target = o; }
    }

    if (jaw > OPEN && target) this.armed = target;
    if (this.armed && jaw < CLOSED) {
      const o = this.armed;
      this.armed = null;
      if (o.parent === this.world.content && inMouth(o) < Infinity) this.bite(o);
    }
    if (!target && jaw < OPEN) this.armed = null;

    this.state = { x: mx, y: my, r: mouthPx / Math.max(W, 1), open: jaw > OPEN, target: !!target, armed: !!this.armed };
  }

  bite(o) {
    const color = o.userData.data.color;
    _box.setFromObject(o).getCenter(_c);
    this.fx.emit(_c, color, 36, 0.4, 0.9);
    chomp();
    o.userData.bites = (o.userData.bites ?? 0) + 1;
    if (o.userData.bites >= BITES) {
      this.tools.forget(o);
      this.fx.dissolve(o, color);
      this.onBite('Nom nom! 😋 All gone');
    } else {
      o.scale.multiplyScalar(0.68);
      this.onBite(`Chomp! ${'🍪'.repeat(BITES - o.userData.bites)} left`);
    }
    this.store.commit();
  }
}
