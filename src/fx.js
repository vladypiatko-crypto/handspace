import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, Group, Mesh,
  MeshBasicMaterial, Points, PointsMaterial, RingGeometry, SphereGeometry, Vector3,
} from 'three';
import { disposeObject } from './objects.js';

// Visual effects: spark particles, shockwave rings, pop-in / dissolve animations
// and glowing orbs that follow your fingertips in 3D.

const MAX_PARTICLES = 1500;

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

export class Effects {
  constructor(scene) {
    this.group = new Group();
    scene.add(this.group);

    // Particles live in one preallocated buffer.
    const geo = new BufferGeometry();
    this.pos = new Float32Array(MAX_PARTICLES * 3);
    this.col = new Float32Array(MAX_PARTICLES * 3);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.baseCol = new Float32Array(MAX_PARTICLES * 3);
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new BufferAttribute(this.col, 3));
    this.points = new Points(geo, new PointsMaterial({
      size: 0.012,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.next = 0;

    this.ripples = [];
    this.anims = [];

    // Fingertip orbs.
    const orbGeo = new SphereGeometry(1, 20, 14);
    const ringGeo = new RingGeometry(1.5, 1.9, 40);
    this.cursors = [0, 1].map(() => {
      const g = new Group();
      const orb = new Mesh(orbGeo, new MeshBasicMaterial({ color: '#fff', transparent: true, opacity: 0.9 }));
      const ring = new Mesh(ringGeo, new MeshBasicMaterial({
        color: '#fff', transparent: true, side: DoubleSide, blending: AdditiveBlending, depthWrite: false,
      }));
      g.add(orb, ring);
      g.userData = { orb, ring, spin: 0 };
      g.visible = false;
      this.group.add(g);
      return g;
    });
  }

  emit(at, color, count = 12, speed = 0.25, life = 0.8) {
    const c = new Color(color).multiplyScalar(2.5);
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_PARTICLES;
      this.pos.set([at.x, at.y, at.z], i * 3);
      // Random direction on a sphere.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const s = speed * (0.3 + Math.random() * 0.7);
      this.vel.set([r * Math.cos(a) * s, r * Math.sin(a) * s, u * s], i * 3);
      const tint = 0.6 + Math.random() * 0.8;
      this.baseCol.set([c.r * tint, c.g * tint, c.b * tint], i * 3);
      this.life[i] = this.maxLife[i] = life * (0.5 + Math.random() * 0.5);
    }
  }

  ripple(at, color, camera, size = 0.15) {
    const m = new Mesh(new RingGeometry(0.9, 1, 64), new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(3), transparent: true, side: DoubleSide,
      blending: AdditiveBlending, depthWrite: false,
    }));
    m.position.copy(at);
    m.quaternion.copy(camera.quaternion);
    this.group.add(m);
    this.ripples.push({ m, t: 0, size });
  }

  popIn(obj) {
    const target = obj.scale.clone();
    obj.scale.setScalar(0.0001);
    this.anims.push({ obj, t: 0, dur: 0.45, step: (k) => obj.scale.copy(target).multiplyScalar(Math.max(0.0001, easeOutBack(k))) });
  }

  // Removes an object from the scene right away (so undo/saving no longer see
  // it) and lets it shrink away in a burst of sparks.
  dissolve(obj, color) {
    this.group.attach(obj);
    const at = new Vector3();
    obj.getWorldPosition(at);
    this.emit(at, color, 40, 0.5, 1.0);
    const start = obj.scale.clone();
    this.anims.push({
      obj, t: 0, dur: 0.3,
      step: (k) => obj.scale.copy(start).multiplyScalar(Math.max(0.0001, 1 - k * k)),
      done: () => { obj.removeFromParent(); disposeObject(obj); },
    });
  }

  // hands: Hand[]; color: current tool color; camera: the AR camera.
  update(dt, t, hands, color, camera) {
    // Particles
    const drag = Math.exp(-2.5 * dt);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      for (let j = 0; j < 3; j++) {
        const n = i * 3 + j;
        this.vel[n] *= drag;
        this.pos[n] += this.vel[n] * dt;
        this.col[n] = this.baseCol[n] * k * k;
      }
      this.vel[i * 3 + 1] += 0.05 * dt; // sparks drift up a little
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;

    // Ripples
    this.ripples = this.ripples.filter((r) => {
      r.t += dt;
      const k = r.t / 0.6;
      if (k >= 1) { r.m.removeFromParent(); r.m.geometry.dispose(); r.m.material.dispose(); return false; }
      r.m.scale.setScalar(r.size * (0.2 + k * 1.3));
      r.m.material.opacity = (1 - k) ** 2;
      return true;
    });

    // Animations
    this.anims = this.anims.filter((a) => {
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      a.step(k);
      if (k >= 1) { a.done?.(); return false; }
      return true;
    });

    // Fingertip orbs: size stays constant in the world, so they shrink as your
    // hand moves away — that's how you see depth.
    const c = new Color(color);
    hands.forEach((h, i) => {
      const cur = this.cursors[i];
      cur.visible = h.present;
      if (!h.present) return;
      const { orb, ring } = cur.userData;
      cur.position.copy(h.world);
      cur.quaternion.copy(camera.quaternion);
      const r = h.pinching ? 0.007 : 0.005;
      cur.scale.setScalar(r);
      orb.material.color.copy(c).multiplyScalar(h.pinching ? 3 : 1.4);
      ring.material.color.copy(c).multiplyScalar(h.pinching ? 2.5 : 1);
      ring.material.opacity = h.pinching ? 1 : 0.5;
      ring.rotation.z = t * 2;
      ring.scale.setScalar(h.pinching ? 0.75 + Math.sin(t * 10) * 0.08 : 1.2);
    });
  }
}
