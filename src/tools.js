import { Box3, Matrix3, Quaternion, Vector3 } from 'three';
import { pop } from './sfx.js';
import { buildObject, disposeObject, finishStroke, ownerOf, serialize, setHighlight, setStrokePoints, shapeFromHands } from './objects.js';

// Modes. "create" needs no switching:
//   ☝️ point            → draw (touch an object while pointing to draw on it)
//   🤏 pinch an object  → grab and move it; pinch it with both hands to scale/rotate
//   🤏🤏 pinch both hands in empty space and pull apart → new shape
//   two "L" hands (thumb + index, like framing a photo), held still → new area
// "paint" works the same, except pointing paints flat onto white canvases
// (from any distance) instead of drawing in the air, and a quick pinch on
// something fills it with the current color.
export const TOOLS = ['create', 'paint', 'erase'];

// How far quaternion q turns around `axis` (radians, signed): the "twist"
// part of a swing-twist split.
function twistAbout(q, axis) {
  const s = q.w < 0 ? -1 : 1;
  const proj = (q.x * axis.x + q.y * axis.y + q.z * axis.z) * s;
  const angle = 2 * Math.atan2(proj, q.w * s);
  return angle > Math.PI ? angle - 2 * Math.PI : angle;
}

const _n = new Vector3();
const _nm = new Matrix3();
const _box = new Box3();

export class Tools {
  constructor({ world, fx, store, settings, anchors, onStick = () => {} }) {
    Object.assign(this, { world, fx, store, settings, anchors, onStick });
    this.strokes = [null, null];
    this.preview = null;
    this.grabs = [null, null];
    this.empty = [false, false]; // hand is pinching empty space (shape candidate)
    this.frame = null; // two-hand "L" frame being held: { obj, held, last, done }
    this.lastT = performance.now();
    this.two = null;
    this.erased = false;
    this.highlighted = new Set();
    this.hint = '';
  }

  get radius() { return this.settings.size * 0.0006; }
  get thickness() { return this.settings.size * 0.0012; }

  // Ends whatever is in progress (e.g. when switching modes or undoing).
  cancel() {
    this.strokes.forEach((s, i) => s && this._endStroke(i));
    if (this.preview) { this.preview.removeFromParent(); disposeObject(this.preview); this.preview = null; }
    if (this.frame && !this.frame.done) { this.frame.obj.removeFromParent(); disposeObject(this.frame.obj); }
    this.frame = null;
    if (this.grabs.some(Boolean)) this.store.commit();
    this.grabs = [null, null];
    this.empty = [false, false];
    this.two = null;
    this._setHighlights([]);
  }

  update(hands) {
    this.hint = '';
    const now = performance.now();
    const dt = Math.min((now - this.lastT) / 1000, 0.2);
    this.lastT = now;
    const tool = this.settings.tool;
    const hover = [];
    if (tool === 'create' || tool === 'paint') {
      const paint = tool === 'paint';
      this._draw(hands, paint);
      this._pinch(hands, paint);
      this._frame(hands, dt);
      hands.forEach((h, i) => {
        const held = this.grabs[i]?.target;
        if (held) hover.push(held);
        else if (h.present && !h.drawing && !h.pinching && h.gesture !== 'frame') {
          const o = this.pick(h.world, false, true);
          if (o) { hover.push(o); this.hint ||= paint ? 'tap-pinch to fill with color, pinch and move to grab' : 'pinch to grab'; }
        }
      });
      if (paint && !this.strokes.some(Boolean) && hands.some((h) => h.gesture === 'point')) {
        this.hint ||= 'point at a white canvas to paint on it';
      }
    } else {
      this._erase(hands);
      for (const h of hands) {
        const o = h.present && this.pick(h.cursorWorld, true);
        if (o) hover.push(o);
      }
    }
    this._setHighlights(hover);
  }

  // ------------------------------------------------------------ picking

  _top(o) {
    while (o && o.parent !== this.world.content) o = o.parent;
    return o;
  }

  // The object at a world point: anything along the ray from the camera
  // through the point that isn't far behind it, or failing that, anything
  // within a few centimeters of it.
  // near: for grabbing, the hand must also be at about the object's depth
  // (so pinching in front of something far away starts a new shape instead).
  pick(at, children = true, near = false) {
    const ray = this.world.rayTo(at);
    const dist = at.distanceTo(ray.ray.origin);
    const hits = ray.intersectObjects(this.world.pickables(), false);
    const hit = near
      ? hits.find((x) => x.distance > dist - 0.12 && x.distance < dist + 0.15)
      : hits.find((x) => x.distance < dist + 0.25);
    let o = hit ? ownerOf(hit.object) : null;
    if (!o) {
      let best = 0.035;
      for (const top of this.world.content.children) {
        top.traverse((c) => {
          if (!c.isMesh || !c.userData.pick) return;
          const d = _box.setFromObject(c).distanceToPoint(at);
          if (d < best) { best = d; o = ownerOf(c); }
        });
      }
    }
    return o && !children ? this._top(o) : o;
  }

  _setHighlights(list) {
    const next = new Set(list);
    for (const o of this.highlighted) if (!next.has(o)) setHighlight(o, false);
    for (const o of next) setHighlight(o, true);
    this.highlighted = next;
  }

  // ------------------------------------------------------------ draw (point)

  // Where on a shape's surface the fingertip is drawing, if it's touching one.
  // canvas: painting mode, which only paints on white canvases but reaches
  // them from any distance (like pointing a laser at them).
  _surfaceHit(at, only, canvas = false) {
    const ray = this.world.rayTo(at);
    const dist = at.distanceTo(ray.ray.origin);
    const list = only
      ? this.world.pickables(only, (o) => o === only)
      : this.world.pickables(this.world.content, (o) => o.userData.data.type === 'shape'
        && (!canvas || o.userData.data.shape === 'board'));
    const hit = ray.intersectObjects(list, false)[0];
    // The fingertip must be at (or reaching through) the surface, not hovering well in front.
    if (!hit) return null;
    const owner = ownerOf(hit.object);
    // Drawing areas are forgiving about depth; other shapes need a closer touch.
    const slack = owner.userData.data.shape === 'board' ? 0.3 : 0.1;
    if (!only && !canvas && dist < hit.distance - slack) return null;
    _nm.getNormalMatrix(hit.object.matrixWorld);
    _n.copy(hit.face.normal).applyMatrix3(_nm).normalize();
    if (_n.dot(ray.ray.direction) > 0) _n.negate();
    // Paint lies almost flat on a canvas; strokes on other things sit on top.
    const lift = owner.userData.data.shape === 'board' ? 0.25 : 0.6;
    return { owner, point: hit.point.clone().addScaledVector(_n, this.radius * lift) };
  }

  // Painting mode: makes sure there's a blank canvas in view to paint on.
  ensureCanvas() {
    const cam = this.world.camera;
    cam.updateMatrixWorld();
    const inView = this.world.content.children.some((o) => {
      if (o.userData.data?.shape !== 'board') return false;
      const p = o.getWorldPosition(new Vector3()).project(cam);
      return Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9 && p.z < 1;
    });
    if (inView) return false;
    // Fill most of the view at about arm's length, facing you.
    const depth = 0.45;
    const halfH = depth * Math.tan((cam.fov * Math.PI) / 360);
    const w = Math.min(halfH * cam.aspect * 2 * 0.72, 0.6);
    const h = Math.min(halfH * 2 * 0.62, w * 1.2);
    const center = new Vector3(0, halfH * 0.08, -depth).applyMatrix4(cam.matrixWorld);
    const corner = (sx, sy) => new Vector3(sx * w / 2, halfH * 0.08 + sy * h / 2, -depth).applyMatrix4(cam.matrixWorld);
    const data = shapeFromHands('board', corner(-1, 1), corner(1, -1), cam.quaternion, this.thickness, '#ffffff', { corners: true });
    const canvas = buildObject(data);
    this.world.content.add(canvas);
    this.fx.popIn(canvas);
    this.fx.ripple(center, '#ffffff', cam, 0.25);
    pop();
    this.store.commit();
    return true;
  }

  // paint: only paint on canvases (see _surfaceHit), never in the air.
  _draw(hands, paint = false) {
    hands.forEach((h, i) => {
      let s = this.strokes[i];
      if (h.drawStarted && !h.captured && !this.grabs[i]) {
        const surf = this._surfaceHit(h.tipWorld, null, paint);
        if (paint && !surf) return;
        const parent = surf ? surf.owner : this.world.content;
        const scale = surf ? parent.getWorldScale(new Vector3()).x : 1;
        const p = surf ? surf.point : h.tipWorld.clone();
        const mesh = buildObject({
          type: 'stroke', color: this.settings.color, radius: this.radius / scale,
          pts: parent.worldToLocal(p.clone()).toArray(),
        });
        parent.add(mesh);
        // Stick mode: a stroke started on a real thing (your face, a cup...) sticks to it.
        if (!surf && this.settings.stick) {
          const anchor = this.anchors?.at(h.tipScreen, [`hand${i}`]);
          if (anchor) { this.anchors.attach(mesh, anchor); this.onStick(anchor.label); }
        }
        s = this.strokes[i] = { mesh, surface: surf ? parent : null, last: p };
        this.fx.emit(p, this.settings.color, 10, 0.15);
      }
      if (!s) return;
      if (h.drawing) {
        let p = h.tipWorld;
        if (s.surface) {
          // Drawing on an object: stick to its surface, skip points that slide off it.
          const surf = this._surfaceHit(h.tipWorld, s.surface, paint);
          if (!surf) return;
          p = surf.point;
        }
        if (p.distanceTo(s.last) > Math.max(this.radius * 0.7, 0.002)) {
          const local = s.mesh.worldToLocal(p.clone());
          setStrokePoints(s.mesh, [...s.mesh.userData.data.pts, local.x, local.y, local.z]);
          s.last.copy(p);
          this.fx.emit(p, this.settings.color, 2, 0.06, 0.5);
        }
        this.hint = paint ? 'painting' : s.surface ? 'drawing on object' : 'drawing';
      }
      if (h.drawEnded || !h.present) this._endStroke(i);
    });
  }

  _endStroke(i) {
    const s = this.strokes[i];
    if (!s) return;
    this.strokes[i] = null;
    // A single point is almost always tracking flicker, not a real stroke.
    if (s.mesh.userData.data.pts.length <= 3) {
      s.mesh.removeFromParent();
      disposeObject(s.mesh);
      return;
    }
    finishStroke(s.mesh);
    this.fx.emit(s.last, this.settings.color, 14, 0.2);
    this.store.commit();
  }

  // ------------------------------------------------------------ pinch: grab or make shapes

  // paint: a quick pinch-and-release on something fills it with the color.
  _pinch(hands, paint = false) {
    hands.forEach((h, i) => {
      if (h.started && !h.captured) {
        const other = this.grabs[1 - i];
        if (other) {
          // Second hand joins: scale + rotate the held object with both hands.
          this.grabs[i] = { target: other.target };
          this._startTwo(hands, other.target);
        } else {
          const target = this.pick(h.world, false, true);
          if (target) {
            if (target.userData.data.anchor) this.anchors?.detach(target); // pull it off
            this.grabs[i] = this._hold(target, h);
            this.fx.emit(h.world, this.settings.color, 8, 0.12);
          } else {
            this.empty[i] = true;
          }
        }
      }
      if (h.ended || !h.present) {
        this.empty[i] = false;
        const released = this.grabs[i]?.target;
        if (this.grabs[i]) {
          this.tap = { ...this.grabs[i], end: h.world.clone() };
          this.grabs[i] = null;
          this.two = null;
          const o = this.grabs[1 - i];
          if (o) this.grabs[1 - i] = this._hold(o.target, hands[1 - i]); // back to one hand
          else if (paint && this._wasTap(released, h)) {
            this._recolor(released);
          } else {
            if (this.settings.stick) this._stick(released);
            this.store.commit();
          }
        }
      }
    });

    if (this.two) {
      const { target, A0, B0, mid0, pos0, quat0, scale0 } = this.two;
      const A = hands[0].world;
      const B = hands[1].world;
      const v0 = B0.clone().sub(A0);
      const v = B.clone().sub(A);
      const s = Math.max(0.05, v.length() / Math.max(v0.length(), 1e-3));
      const q = new Quaternion().setFromUnitVectors(v0.normalize(), v.normalize());
      const mid = A.clone().add(B).multiplyScalar(0.5);
      target.quaternion.copy(q).multiply(quat0);
      target.scale.copy(scale0).multiplyScalar(s);
      target.position.copy(pos0).sub(mid0).applyQuaternion(q).multiplyScalar(s).add(mid);
      this.hint = `scale ×${s.toFixed(2)}`;
    } else {
      hands.forEach((h, i) => {
        const g = this.grabs[i];
        if (!g || !h.pinching) return;
        if (this.settings.wristRotate && h.lm) {
          // Twist your wrist to turn what you're holding, around the grab point.
          const dq = h.rot.clone().multiply(g.rot0.clone().invert());
          g.target.quaternion.copy(dq).multiply(g.q0);
          g.target.position.copy(g.offset).applyQuaternion(dq).add(h.world);
        } else {
          g.target.position.copy(h.world).add(g.offset);
        }
        this.hint = 'moving · twist your wrist to rotate';
      });
    }

    this._shape(hands);
  }

  // Starts holding an object with one hand.
  _hold(target, h) {
    return {
      target, offset: target.position.clone().sub(h.world), rot0: h.rot.clone(), q0: target.quaternion.clone(),
      pos0: target.position.clone(), start: h.world.clone(), t0: performance.now(),
    };
  }

  // A short pinch that barely moved: a tap. Puts the object back where it was.
  _wasTap(obj, h) {
    const g = this.tap;
    if (!g || g.target !== obj || !g.start) return false;
    const tap = performance.now() - g.t0 < 350 && g.start.distanceTo(g.end ?? h.world) < 0.02;
    if (tap) { obj.position.copy(g.pos0); obj.quaternion.copy(g.q0); }
    return tap;
  }

  // Stick mode: dropping something on a real thing sticks it there.
  _stick(obj) {
    const anchor = this.anchors?.stick(obj, ['hand0', 'hand1']);
    if (anchor) this.onStick(anchor.label);
  }

  // Objects being held, drawn or created right now (physics leaves them alone).
  busy() {
    const set = new Set();
    for (const g of this.grabs) if (g) set.add(g.target);
    for (const s of this.strokes) if (s) set.add(this._top(s.mesh));
    if (this.preview) set.add(this.preview);
    if (this.frame && !this.frame.done) set.add(this.frame.obj);
    return set;
  }

  // Lets go of an object that's about to disappear (e.g. eaten).
  forget(obj) {
    this.grabs = this.grabs.map((g) => (g && g.target === obj ? null : g));
    if (this.two?.target === obj) this.two = null;
    this.highlighted.delete(obj);
  }

  _startTwo(hands, target) {
    const A0 = hands[0].world.clone();
    const B0 = hands[1].world.clone();
    this.two = {
      target, A0, B0,
      mid0: A0.clone().add(B0).multiplyScalar(0.5),
      pos0: target.position.clone(),
      quat0: target.quaternion.clone(),
      scale0: target.scale.clone(),
    };
  }

  // Both hands in an "L" (like framing a photo): the frame between them
  // becomes a drawing area once held still for a moment.
  _frame(hands, dt) {
    const [a, b] = hands;
    const framing = a.present && b.present && a.gesture === 'frame' && b.gesture === 'frame';
    const f = this.frame;
    if (!framing) {
      if (f) {
        if (!f.done) { f.obj.removeFromParent(); disposeObject(f.obj); }
        this.frame = null;
      }
      return;
    }
    if (f?.done) { this.hint = 'area placed: relax your hands'; return; }
    const A = a.cornerWorld;
    const B = b.cornerWorld;
    const data = shapeFromHands('board', A, B, this.world.camera.quaternion, this.thickness, '#ffffff', { corners: true });
    if (f) { f.obj.removeFromParent(); disposeObject(f.obj); }
    const obj = buildObject(data);
    obj.userData.preview = true;
    obj.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity *= 0.55; } });
    this.world.content.add(obj);
    // Count how long the frame has stayed (about) still.
    const moved = f ? f.last.distanceTo(A) + f.lastB.distanceTo(B) : 0;
    const held = f && moved < 0.02 ? f.held + dt : 0;
    this.frame = { obj, held, last: A.clone(), lastB: B.clone(), done: false };
    const k = Math.min(1, held / 0.6);
    this.hint = `hold still to place the area · ${Math.round(k * 100)}%`;
    if (k >= 1) {
      // Rebuild at full opacity as the real thing.
      obj.removeFromParent();
      disposeObject(obj);
      const placed = buildObject(data);
      this.world.content.add(placed);
      this.fx.popIn(placed);
      this.fx.ripple(placed.getWorldPosition(new Vector3()), '#ffffff', this.world.camera, 0.2);
      pop();
      if (this.settings.stick) this._stick(placed);
      this.store.commit();
      this.frame = { obj: placed, held, last: A.clone(), lastB: B.clone(), done: true };
    }
  }

  // Both hands pinching empty space: stretch a new shape between them.
  _shape(hands) {
    const [a, b] = hands;
    const both = this.empty[0] && this.empty[1] && a.pinching && b.pinching;
    if (both) {
      // Twisting both wrists turns the new shape around the line between your hands.
      if (!this.createRot0) this.createRot0 = [a.rot.clone(), b.rot.clone()];
      const axis = b.world.clone().sub(a.world).normalize();
      const twist = (twistAbout(a.rot.clone().multiply(this.createRot0[0].clone().invert()), axis)
        + twistAbout(b.rot.clone().multiply(this.createRot0[1].clone().invert()), axis)) / 2;
      const data = shapeFromHands(this.settings.shape, a.world, b.world, this.world.camera.quaternion,
        this.thickness, this.settings.color, { twist });
      if (this.preview) { this.preview.removeFromParent(); disposeObject(this.preview); }
      this.preview = buildObject(data);
      this.preview.userData.preview = true;
      this.world.content.add(this.preview);
      this.hint = `${(a.world.distanceTo(b.world) * 100).toFixed(1)} cm, let go to place`;
      if (Math.random() < 0.5) {
        this.fx.emit(a.world, this.settings.color, 1, 0.05, 0.4);
        this.fx.emit(b.world, this.settings.color, 1, 0.05, 0.4);
      }
      return;
    }
    this.createRot0 = null;
    if (this.preview) {
      const p = this.preview;
      this.preview = null;
      p.userData.preview = false;
      if (!p.userData.data.dims.some((v) => v > 0.03)) {
        p.removeFromParent();
        disposeObject(p);
      } else {
        const at = p.getWorldPosition(new Vector3());
        this.fx.ripple(at, this.settings.color, this.world.camera, 0.2);
        this.fx.emit(at, this.settings.color, 50, 0.45, 1.1);
        if (this.settings.stick) this._stick(p);
        this.store.commit();
      }
    }
    if (this.empty.some((e, i) => e && hands[i].pinching)) {
      this.hint = this.settings.shape === 'board'
        ? 'pinch with your other hand too and pull apart to mark an area'
        : 'pinch with your other hand too and pull apart for a shape';
    }
  }

  // ------------------------------------------------------------ paint / erase

  _recolor(o) {
    const data = serialize(o);
    data.color = this.settings.color;
    const fresh = buildObject(data);
    o.parent.add(fresh);
    o.removeFromParent();
    disposeObject(o);
    this.highlighted.delete(o);
    const at = fresh.getWorldPosition(new Vector3());
    this.fx.ripple(at, data.color, this.world.camera, 0.12);
    this.fx.emit(at, data.color, 30, 0.3);
    this.store.commit();
  }

  _erase(hands) {
    // Pinch or point and sweep: everything you touch disappears.
    for (const h of hands) {
      if ((!h.pinching && !h.drawing) || h.captured) continue;
      const o = this.pick(h.pinching ? h.world : h.tipWorld, true);
      if (!o) continue;
      this.highlighted.delete(o);
      this.fx.dissolve(o, o.userData.data.color);
      this.erased = true;
    }
    if (this.erased && !hands.some((h) => h.pinching || h.drawing)) {
      this.erased = false;
      this.store.commit();
    }
  }
}
