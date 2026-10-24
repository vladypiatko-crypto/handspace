import { Box3, Matrix3, Quaternion, Vector3 } from 'three';
import { buildObject, disposeObject, ownerOf, serialize, setHighlight, setStrokePoints, shapeFromHands } from './objects.js';

export const TOOLS = ['draw', 'shape', 'grab', 'paint', 'erase'];

const _n = new Vector3();
const _nm = new Matrix3();
const _box = new Box3();

export class Tools {
  constructor({ world, fx, store, settings }) {
    Object.assign(this, { world, fx, store, settings });
    this.strokes = [null, null];
    this.preview = null;
    this.grabs = [null, null];
    this.two = null;
    this.erased = false;
    this.highlighted = new Set();
    this.hint = '';
  }

  get radius() { return this.settings.size * 0.0006; }
  get thickness() { return this.settings.size * 0.0012; }

  // Ends whatever is in progress (e.g. when switching tools).
  cancel() {
    this.strokes.forEach((s, i) => s && this._endStroke(i));
    if (this.preview) { this.preview.removeFromParent(); disposeObject(this.preview); this.preview = null; }
    if (this.grabs.some(Boolean)) this.store.commit();
    this.grabs = [null, null];
    this.two = null;
    this._setHighlights([]);
  }

  update(hands) {
    this.hint = '';
    const tool = this.settings.tool;
    if (tool === 'draw') this._draw(hands);
    else if (tool === 'shape') this._shape(hands);
    else if (tool === 'grab') this._grab(hands);
    else if (tool === 'paint') this._tap(hands, (o) => this._recolor(o));
    else if (tool === 'erase') this._erase(hands);

    if (tool === 'grab' || tool === 'paint' || tool === 'erase') {
      const hover = [];
      hands.forEach((h, i) => {
        const held = this.grabs[i]?.target;
        if (held) hover.push(held);
        else if (h.present) {
          const o = this.pick(h, tool !== 'grab');
          if (o) hover.push(o);
        }
      });
      this._setHighlights(hover);
    } else this._setHighlights([]);
  }

  // ------------------------------------------------------------ picking

  _top(o) {
    while (o && o.parent !== this.world.content) o = o.parent;
    return o;
  }

  // The object a hand is pointing at: anything along the ray from the camera
  // through the fingertips that isn't far behind the hand, or failing that,
  // anything within a few centimeters of the fingertips.
  pick(h, children = true) {
    const ray = this.world.rayTo(h.world);
    const handDist = h.world.distanceTo(ray.ray.origin);
    const hits = ray.intersectObjects(this.world.pickables(), false);
    const hit = hits.find((x) => x.distance < handDist + 0.25);
    let o = hit ? ownerOf(hit.object) : null;
    if (!o) {
      let best = 0.035;
      for (const top of this.world.content.children) {
        top.traverse((c) => {
          if (!c.isMesh || !c.userData.pick) return;
          const d = _box.setFromObject(c).distanceToPoint(h.world);
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

  // ------------------------------------------------------------ draw

  // Where on a shape's surface the hand is drawing, if it's touching one.
  _surfaceHit(h, only) {
    const ray = this.world.rayTo(h.world);
    const handDist = h.world.distanceTo(ray.ray.origin);
    const list = only
      ? this.world.pickables(only, (o) => o === only)
      : this.world.pickables(this.world.content, (o) => o.userData.data.type === 'shape');
    const hit = ray.intersectObjects(list, false)[0];
    // Hand must be at (or reaching through) the surface, not hovering well in front.
    if (!hit || (!only && handDist < hit.distance - 0.1)) return null;
    _nm.getNormalMatrix(hit.object.matrixWorld);
    _n.copy(hit.face.normal).applyMatrix3(_nm).normalize();
    if (_n.dot(ray.ray.direction) > 0) _n.negate();
    return { owner: ownerOf(hit.object), point: hit.point.clone().addScaledVector(_n, this.radius * 0.6) };
  }

  _draw(hands) {
    hands.forEach((h, i) => {
      let s = this.strokes[i];
      if (h.started) {
        const surf = this._surfaceHit(h);
        const parent = surf ? surf.owner : this.world.content;
        const scale = surf ? parent.getWorldScale(new Vector3()).x : 1;
        const p = surf ? surf.point : h.world.clone();
        const mesh = buildObject({
          type: 'stroke', color: this.settings.color, radius: this.radius / scale,
          pts: parent.worldToLocal(p.clone()).toArray(),
        });
        parent.add(mesh);
        s = this.strokes[i] = { mesh, surface: surf ? parent : null, last: p };
        this.fx.emit(p, this.settings.color, 10, 0.15);
      }
      if (!s) return;
      if (h.pinching) {
        let p = h.world;
        if (s.surface) {
          // Painting on an object: stick to its surface, skip points that slide off it.
          const surf = this._surfaceHit(h, s.surface);
          if (!surf) return;
          p = surf.point;
        }
        if (p.distanceTo(s.last) > Math.max(this.radius * 0.7, 0.002)) {
          const local = s.mesh.parent.worldToLocal(p.clone());
          setStrokePoints(s.mesh, [...s.mesh.userData.data.pts, local.x, local.y, local.z]);
          s.last.copy(p);
          this.fx.emit(p, this.settings.color, 2, 0.06, 0.5);
        }
        if (s.surface) this.hint = 'Drawing on object';
      }
      if (h.ended || !h.present) this._endStroke(i);
    });
  }

  _endStroke(i) {
    const s = this.strokes[i];
    if (!s) return;
    this.strokes[i] = null;
    this.fx.emit(s.last, this.settings.color, 14, 0.2);
    this.store.commit();
  }

  // ------------------------------------------------------------ shapes

  _shape(hands) {
    const [a, b] = hands;
    const both = a.present && b.present && a.pinching && b.pinching;
    if (both) {
      const data = shapeFromHands(this.settings.shape, a.world, b.world, this.world.camera.quaternion,
        this.thickness, this.settings.color);
      if (this.preview) { this.preview.removeFromParent(); disposeObject(this.preview); }
      this.preview = buildObject(data);
      this.world.content.add(this.preview);
      this.hint = `${(a.world.distanceTo(b.world) * 100).toFixed(1)} cm — let go to place`;
      if (Math.random() < 0.5) {
        this.fx.emit(a.world, this.settings.color, 1, 0.05, 0.4);
        this.fx.emit(b.world, this.settings.color, 1, 0.05, 0.4);
      }
      return;
    }
    if (this.preview) {
      const p = this.preview;
      this.preview = null;
      if (a.world.distanceTo(b.world) < 0.015 && !p.userData.data.dims.some((v) => v > 0.03)) {
        p.removeFromParent();
        disposeObject(p);
      } else {
        const at = p.getWorldPosition(new Vector3());
        this.fx.ripple(at, this.settings.color, this.world.camera, 0.2);
        this.fx.emit(at, this.settings.color, 50, 0.45, 1.1);
        this.store.commit();
      }
    }
    if (hands.some((h) => h.pinching)) this.hint = 'Pinch with your other hand too, then pull apart';
  }

  // ------------------------------------------------------------ grab

  _grab(hands) {
    hands.forEach((h, i) => {
      const other = this.grabs[1 - i];
      if (h.started) {
        if (other) {
          // Second hand joins: scale + rotate the held object with both hands.
          this.grabs[i] = { target: other.target };
          this._startTwo(hands);
        } else {
          const target = this.pick(h, false);
          if (target) {
            this.grabs[i] = { target, offset: target.position.clone().sub(h.world) };
            this.fx.emit(h.world, this.settings.color, 8, 0.12);
          }
        }
      }
      if ((h.ended || !h.present) && this.grabs[i]) {
        this.grabs[i] = null;
        this.two = null;
        const o = this.grabs[1 - i];
        if (o) o.offset = o.target.position.clone().sub(hands[1 - i].world); // back to one hand
        else this.store.commit();
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
      this.hint = `Scale ×${s.toFixed(2)}`;
    } else {
      hands.forEach((h, i) => {
        const g = this.grabs[i];
        if (g && h.pinching) g.target.position.copy(h.world).add(g.offset);
      });
    }
  }

  _startTwo(hands) {
    const target = this.grabs[0].target;
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

  // ------------------------------------------------------------ paint / erase

  _tap(hands, action) {
    hands.forEach((h) => {
      if (!h.started) return;
      const o = this.pick(h, true);
      if (o) action(o, h);
    });
  }

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
    // Pinch and sweep: everything you touch while pinching disappears.
    hands.forEach((h) => {
      if (!h.pinching) return;
      const o = this.pick(h, true);
      if (!o) return;
      this.highlighted.delete(o);
      this.fx.dissolve(o, o.userData.data.color);
      this.erased = true;
    });
    if (this.erased && !hands.some((h) => h.pinching)) {
      this.erased = false;
      this.store.commit();
    }
  }
}
