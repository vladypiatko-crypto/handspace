import { Box3, Quaternion, Sphere, Vector3 } from 'three';

// Light, game-style physics for your creations: gravity, bouncing off the
// bottom and sides of the view, landing on drawing areas (boards), bumping
// into each other, and being thrown. Objects you're holding or drawing are
// left alone, and resting objects go to sleep so they cost nothing.

const GRAVITY = 6; // m/s², a bit floatier than real life
const BOUNCE = 0.45;
const FRICTION = 0.82;
const SLEEP_SPEED = 0.04;
const SLEEP_TIME = 0.6;
const MAX_THROW = 4; // m/s
// Slime: soft landings and a springy squash-and-stretch.
const SLIME_BOUNCE = 0.25;
const JELLY_K = 160; // spring stiffness
const JELLY_DAMP = 7;
const JELLY_GAIN = 1.4; // how much a change in speed deforms it (a 2.5 m/s landing ≈ 30% squash)

const _box = new Box3();
const _sphere = new Sphere();
const _sphere2 = new Sphere();
const _n = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _axis = new Vector3();

export class Physics {
  constructor({ world, onSettled, onSplat }) {
    this.world = world;
    this.onSettled = onSettled;
    this.onSplat = onSplat;
    this.bodies = new WeakMap();
    this.dirty = false;
    this.heldBefore = new Set();
    this.awake = 0; // objects still moving (0 = everything at rest)
  }

  body(o) {
    let b = this.bodies.get(o);
    if (!b) {
      b = {
        vel: new Vector3(), spin: new Vector3(), still: 0, asleep: false,
        last: o.position.clone(), seen: new Vector3(), // velocity as observed (for throws and jelly)
        jelly: new Vector3(), jellyVel: new Vector3(),
      };
      this.bodies.set(o, b);
    }
    return b;
  }

  // Throw or nudge an object.
  push(o, vel) {
    const b = this.body(o);
    b.vel.copy(vel);
    b.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(vel.length() * 4);
    b.asleep = false;
    b.still = 0;
  }

  wakeAll() {
    for (const o of this.world.content.children) {
      const b = this.body(o);
      b.asleep = false;
      b.still = 0;
    }
  }

  // Watches every object's motion (held or not): lets go = throw, and drives
  // slime jiggle. Runs even when gravity is off.
  track(dt, held, gravity) {
    if (dt <= 0) return;
    for (const o of this.world.content.children) {
      if (!o.userData.data) continue;
      const b = this.body(o);
      const v = _d.subVectors(o.position, b.last).divideScalar(dt);
      b.last.copy(o.position);
      const prev = b.seen.clone();
      b.seen.lerp(v, 0.5);
      if (gravity && this.heldBefore.has(o) && !held.has(o)) {
        // Released: keep its momentum.
        const throwVel = b.seen.clone();
        if (throwVel.length() > MAX_THROW) throwVel.setLength(MAX_THROW);
        b.vel.copy(throwVel);
        b.spin.set(0, 0, 0);
        if (throwVel.length() > 0.6) this.push(o, throwVel);
        b.asleep = false;
        b.still = 0;
      }
      if (o.userData.data.shape === 'slime') this.jiggle(o, b, prev, dt);
    }
    this.heldBefore = new Set(held);
  }

  // Squash and stretch: a spring pulled by the slime's acceleration.
  jiggle(o, b, prevVel, dt) {
    const accel = _n.subVectors(b.seen, prevVel).divideScalar(dt);
    const force = accel.multiplyScalar(-JELLY_GAIN)
      .addScaledVector(b.jelly, -JELLY_K)
      .addScaledVector(b.jellyVel, -JELLY_DAMP);
    b.jellyVel.addScaledVector(force, dt);
    b.jelly.addScaledVector(b.jellyVel, dt).clampScalar(-0.45, 0.45);
    const inner = o.getObjectByName('inner');
    const dims = o.userData.data.dims;
    // jelly is how far the goo lags behind its motion: lagging down (landing)
    // squashes it flat, lagging up (falling) stretches it tall, sideways
    // shaking stretches it sideways. Volume stays roughly the same.
    const j = b.jelly;
    const sideways = 1 + (Math.abs(j.x) + Math.abs(j.z)) * 0.4;
    const sy = (1 + j.y) / sideways;
    const sxz = 1 / Math.sqrt(Math.max(1 + j.y, 0.3));
    inner.scale.set(dims[0] * sxz * (1 + Math.abs(j.x) * 0.8), dims[1] * sy, dims[2] * sxz * (1 + Math.abs(j.z) * 0.8));
    const body = inner.getObjectByName('slime');
    if (body) body.material.userData.wobble.value = Math.min(1, b.jellyVel.length() * 0.6 + b.jelly.length());
  }

  // held: objects being held or drawn right now. view: camera intrinsics.
  update(dt, held, { W, H, f }) {
    dt = Math.min(dt, 1 / 30);
    const all = this.world.content.children.filter((o) => o.userData.data);
    const boards = all.filter((o) => o.userData.data.shape === 'board');
    const movers = all.filter((o) => o.userData.data.shape !== 'board' && !held.has(o));
    // The "floor" is a little above the bottom of the view at hand distance.
    const floorY = -0.45 * (H / 2 / f) * 0.78;
    const halfW = (W / 2) / f;
    this.floorY = floorY;

    let awake = 0;
    for (const o of movers) {
      const b = this.body(o);
      if (b.asleep) continue;
      awake++;
      b.vel.y -= GRAVITY * dt;
      o.position.addScaledVector(b.vel, dt);
      if (b.spin.lengthSq() > 1e-6) {
        _q.setFromAxisAngle(_axis.copy(b.spin).normalize(), b.spin.length() * dt);
        o.quaternion.premultiply(_q);
      }

      let grounded = false;
      const slime = o.userData.data.shape === 'slime';
      _box.setFromObject(o);
      // Floor
      if (_box.min.y < floorY) {
        o.position.y += floorY - _box.min.y;
        if (b.vel.y < -1 && slime) this.onSplat?.(o, -b.vel.y);
        if (b.vel.y < 0) b.vel.y = -b.vel.y * (slime ? SLIME_BOUNCE : BOUNCE);
        if (b.vel.y < 0.25) b.vel.y = 0;
        b.vel.x *= slime ? 0.5 : FRICTION;
        b.vel.z *= slime ? 0.5 : FRICTION;
        b.spin.multiplyScalar(slime ? 0.2 : 0.6);
        grounded = true;
      }
      // Side and depth walls keep things in view.
      const depth = Math.max(0.2, -o.position.z);
      const xLim = depth * halfW * 0.95;
      if (Math.abs(o.position.x) > xLim) {
        o.position.x = Math.sign(o.position.x) * xLim;
        b.vel.x *= -BOUNCE;
      }
      if (o.position.z > -0.2) { o.position.z = -0.2; b.vel.z *= -BOUNCE; }
      if (o.position.z < -1.6) { o.position.z = -1.6; b.vel.z *= -BOUNCE; }

      // Boards are solid platforms.
      _box.setFromObject(o).getBoundingSphere(_sphere);
      const r = _sphere.radius * 0.7;
      for (const board of boards) {
        const dims = board.userData.data.dims;
        const s = board.scale.x;
        _n.set(0, 0, 1).applyQuaternion(board.quaternion);
        _d.subVectors(_sphere.center, board.position);
        const dist = _d.dot(_n);
        if (Math.abs(dist) > r) continue;
        const x = _d.dot(new Vector3(1, 0, 0).applyQuaternion(board.quaternion));
        const y = _d.dot(new Vector3(0, 1, 0).applyQuaternion(board.quaternion));
        if (Math.abs(x) > (dims[0] * s) / 2 + r * 0.3 || Math.abs(y) > (dims[1] * s) / 2 + r * 0.3) continue;
        const side = dist >= 0 ? 1 : -1;
        o.position.addScaledVector(_n, side * r - dist);
        const vn = b.vel.dot(_n);
        if (vn * side < 0) b.vel.addScaledVector(_n, -vn * (1 + BOUNCE));
        b.vel.multiplyScalar(FRICTION);
        if (_n.y * side > 0.5) grounded = true;
      }

      const speed = b.vel.length();
      b.still = grounded && speed < SLEEP_SPEED * 4 ? b.still + dt : 0;
      if (grounded && speed < SLEEP_SPEED) b.vel.set(0, 0, 0);
      if (b.still > SLEEP_TIME) { b.asleep = true; b.vel.set(0, 0, 0); b.spin.set(0, 0, 0); }
      this.dirty = true;
    }

    // Objects bump into each other (as rough spheres).
    for (let i = 0; i < movers.length; i++) {
      const a = movers[i];
      _box.setFromObject(a).getBoundingSphere(_sphere);
      _sphere.radius *= 0.6;
      for (let j = i + 1; j < movers.length; j++) {
        const c = movers[j];
        const ba = this.body(a);
        const bc = this.body(c);
        if (ba.asleep && bc.asleep) continue;
        _box.setFromObject(c).getBoundingSphere(_sphere2);
        _sphere2.radius *= 0.6;
        _d.subVectors(_sphere2.center, _sphere.center);
        const dist = _d.length();
        const overlap = _sphere.radius + _sphere2.radius - dist;
        if (overlap <= 0 || dist < 1e-6) continue;
        _n.copy(_d).divideScalar(dist);
        a.position.addScaledVector(_n, -overlap / 2);
        c.position.addScaledVector(_n, overlap / 2);
        const rel = _d.subVectors(bc.vel, ba.vel).dot(_n);
        if (rel < 0) {
          const imp = (-(1 + BOUNCE) * rel) / 2;
          ba.vel.addScaledVector(_n, -imp);
          bc.vel.addScaledVector(_n, imp);
        }
        ba.asleep = bc.asleep = false;
        ba.still = bc.still = 0;
      }
    }

    this.awake = awake;
    // Save once everything has come to rest.
    if (!awake && this.dirty) {
      this.dirty = false;
      this.onSettled();
    }
  }
}
