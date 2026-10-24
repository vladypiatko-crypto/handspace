import { Box3, Matrix4, Quaternion, Vector3 } from 'three';

// Real-world anchors: your face, hands, body, and everyday objects the camera
// recognizes. Drawings and shapes stuck to an anchor move (and turn) with it.
//
// An attached object keeps `data.anchor` (the anchor id) and `data.offset`
// (its transform relative to the anchor), so it re-attaches after a reload.

// Typical sizes (m) of the narrow side of things, to guess how far away they are.
const SIZES = {
  cup: 0.085, 'wine glass': 0.08, bottle: 0.075, bowl: 0.15, 'cell phone': 0.075, remote: 0.05,
  mouse: 0.065, keyboard: 0.15, laptop: 0.25, book: 0.16, scissors: 0.08, 'teddy bear': 0.22,
  banana: 0.05, apple: 0.08, orange: 0.08, clock: 0.25, vase: 0.12, 'potted plant': 0.2, tv: 0.5,
  chair: 0.45, backpack: 0.3, handbag: 0.25, umbrella: 0.1, 'sports ball': 0.2, toothbrush: 0.02,
};
const TRACKED_FOR = 0.5; // seconds an anchor counts as "seen" after its last detection
const FORGET_AFTER = 30; // seconds a lost object is remembered (to re-attach when it's back)
const EYE_SPAN = 0.09;
const SHOULDER_SPAN = 0.36;

const _m = new Matrix4();
const _off = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _q = new Quaternion();
const _box = new Box3();
const _c = new Vector3();

export class Anchors {
  constructor({ world }) {
    this.world = world;
    this.poses = new Map(); // id -> { id, label, pos, rot, matrix, seenAt, box }
    this.count = new Map(); // label -> running number, for object ids
    this.t = 0;
  }

  // result: tracker output; hands: Hand[]; view: camera intrinsics.
  update(result, hands, view, camera, t) {
    this.t = t;
    const X = (p) => (view.mirror ? 1 - p.x : p.x);
    // Screen point (0..1) at a distance → world.
    const toWorld = (u, v, depth) => new Vector3(((u - 0.5) * view.W) / view.f * depth,
      (-(v - 0.5) * view.H) / view.f * depth, -depth).applyMatrix4(camera.matrixWorld);
    // Orientation from three landmark directions, in the mirrored-if-needed view.
    const P = (p) => new Vector3(X(p) * view.W, -p.y * view.H, -(p.z ?? 0) * view.W);
    const frame = (xFrom, xTo, yFrom, yTo) => {
      _x.subVectors(P(xTo), P(xFrom)).normalize();
      _y.subVectors(P(yTo), P(yFrom)).normalize();
      _z.crossVectors(_x, _y).normalize();
      _y.crossVectors(_z, _x).normalize();
      return new Quaternion().setFromRotationMatrix(_m.makeBasis(_x, _y, _z)).premultiply(camera.quaternion);
    };
    const bounds = (pts) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of pts) {
        const u = X(p);
        x0 = Math.min(x0, u); x1 = Math.max(x1, u);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const px = (a, b) => Math.hypot((X(a) - X(b)) * view.W, (a.y - b.y) * view.H);

    const face = result?.face?.lm;
    if (face) {
      const eyes = px(face[33], face[263]);
      if (eyes > 4) {
        const depth = (view.f * EYE_SPAN) / eyes;
        const c = face[168]; // between the eyes
        this.set('face', 'face', toWorld(X(c), c.y, depth), frame(face[33], face[263], face[152], face[10]), bounds(face));
      }
    }

    hands.forEach((h, i) => {
      if (!h.present || !h.lm) return;
      this.set(`hand${i}`, 'hand', toWorld(h.palmScreen.x, h.palmScreen.y, h.depth), h.rot.clone(), bounds(h.lm));
    });

    const body = result?.pose?.lm;
    if (body && (body[11].visibility ?? 1) > 0.5 && (body[12].visibility ?? 1) > 0.5) {
      const span = px(body[11], body[12]);
      if (span > 10) {
        const depth = (view.f * SHOULDER_SPAN) / span;
        const sx = (X(body[11]) + X(body[12])) / 2;
        const sy = (body[11].y + body[12].y) / 2;
        const hy = body[23] && body[24] ? (body[23].y + body[24].y) / 2 : sy + 0.3;
        const hips = { x: view.mirror ? 1 - sx : sx, y: hy, z: 0 };
        const chest = { x: view.mirror ? 1 - sx : sx, y: sy, z: 0 };
        this.set('body', 'body', toWorld(sx, sy + (hy - sy) * 0.3, depth), frame(body[12], body[11], hips, chest),
          bounds([body[11], body[12], ...(body[23] ? [body[23], body[24]] : [])]));
      }
    }

    if (result?.objects) {
      for (const d of result.objects) {
        const box = { x: view.mirror ? 1 - (d.x + d.w) : d.x, y: d.y, w: d.w, h: d.h };
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const sidePx = Math.max(4, Math.min(box.w * view.W, box.h * view.H));
        const depth = Math.min(3, Math.max(0.2, (view.f * (SIZES[d.label] ?? 0.15)) / sidePx));
        const id = this.match(d.label, cx, cy) ?? this.newId(d.label);
        this.set(id, d.label, toWorld(cx, cy, depth), new Quaternion(), box, d.score);
      }
    }

    for (const [id, p] of this.poses) {
      if (t - p.seenAt > FORGET_AFTER && !this.inUse(id)) this.poses.delete(id);
    }
  }

  // Same kind of thing near where we last saw one → same anchor (even if it
  // was out of view for a while).
  match(label, cx, cy) {
    let best = null;
    let bestD = 0.3;
    for (const p of this.poses.values()) {
      if (p.label !== label || p.matchedAt === this.t) continue;
      const d = Math.hypot(p.box.x + p.box.w / 2 - cx, p.box.y + p.box.h / 2 - cy) * (this.isTracked(p.id) ? 1 : 0.5);
      if (d < bestD) { bestD = d; best = p.id; }
    }
    return best;
  }

  newId(label) {
    const n = (this.count.get(label) ?? 0) + 1;
    this.count.set(label, n);
    return `${label}#${n}`;
  }

  set(id, label, pos, rot, box, score) {
    let p = this.poses.get(id);
    const fresh = !p || this.t - p.seenAt > TRACKED_FOR;
    if (!p) {
      p = { id, label, pos: pos.clone(), rot: rot.clone(), matrix: new Matrix4() };
      this.poses.set(id, p);
    }
    // Smooth out tracking jitter.
    if (fresh) { p.pos.copy(pos); p.rot.copy(rot); } else { p.pos.lerp(pos, 0.5); p.rot.slerp(rot, 0.5); }
    p.matrix.compose(p.pos, p.rot, new Vector3(1, 1, 1));
    p.box = box;
    p.score = score;
    p.seenAt = this.t;
    p.matchedAt = this.t;
  }

  isTracked(id) {
    const p = this.poses.get(id);
    return !!p && this.t - p.seenAt < TRACKED_FOR;
  }

  inUse(id) {
    return this.world.content.children.some((o) => o.userData.data?.anchor === id);
  }

  // The tracked thing at a screen point (smallest box wins), ignoring `exclude` ids.
  at(pt, exclude = []) {
    let best = null;
    let bestArea = Infinity;
    for (const p of this.poses.values()) {
      if (!this.isTracked(p.id) || exclude.includes(p.id)) continue;
      const b = p.box;
      const pad = p.label === 'face' ? 0.02 : 0.01;
      if (pt.x < b.x - pad || pt.x > b.x + b.w + pad || pt.y < b.y - pad || pt.y > b.y + b.h + pad) continue;
      const area = b.w * b.h;
      if (area < bestArea) { bestArea = area; best = p; }
    }
    return best;
  }

  attach(obj, anchor) {
    obj.updateMatrix();
    const data = obj.userData.data;
    data.anchor = anchor.id;
    data.offset = _off.copy(anchor.matrix).invert().multiply(obj.matrix).toArray();
  }

  detach(obj) {
    delete obj.userData.data.anchor;
    delete obj.userData.data.offset;
  }

  // Sticks `obj` to whatever real thing is at its spot on screen.
  stick(obj, exclude = []) {
    _box.setFromObject(obj).getCenter(_c).project(this.world.camera);
    const anchor = this.at({ x: (_c.x + 1) / 2, y: (1 - _c.y) / 2 }, exclude);
    if (anchor) this.attach(obj, anchor);
    return anchor;
  }

  // Moves attached things along with their anchors.
  apply() {
    for (const o of this.world.content.children) {
      const d = o.userData.data;
      if (!d?.anchor || !d.offset || !this.isTracked(d.anchor)) continue;
      _m.multiplyMatrices(this.poses.get(d.anchor).matrix, _off.fromArray(d.offset));
      _m.decompose(o.position, o.quaternion, o.scale);
    }
  }

  // For the overlay: what's currently recognized, and how much is stuck to it.
  visible() {
    const stuck = new Map();
    for (const o of this.world.content.children) {
      const id = o.userData.data?.anchor;
      if (id) stuck.set(id, (stuck.get(id) ?? 0) + 1);
    }
    return [...this.poses.values()].filter((p) => this.isTracked(p.id))
      .map((p) => ({ id: p.id, label: p.label, box: p.box, score: p.score, stuck: stuck.get(p.id) ?? 0 }));
  }
}
