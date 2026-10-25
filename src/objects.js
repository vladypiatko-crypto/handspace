import {
  CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, Quaternion, SphereGeometry, TorusGeometry, TubeGeometry, Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Every object in the scene is described by a small JSON-able "data" record kept
// in userData.data, so saving, undo and recoloring all just rebuild from data.
//
//   stroke: { type:'stroke', color, radius, pts:[x,y,z,...] (local), m, children }
//   shape:  { type:'shape', shape, color, dims:[x,y,z], hatch?, m, children }
//
// Shapes keep their size on an inner node, so strokes drawn onto a shape (its
// children) aren't stretched by it.
//
// Look: lit, solid materials. Strokes are glossy paint, shapes are soft clay
// with a light clear coat, drawing areas are paper, slime is wobbly jelly.

export const SHAPES = ['board', 'slime', 'bar', 'box', 'sphere', 'cylinder', 'cone', 'torus'];
export const holoTime = { value: 0 }; // shared clock for animated materials
export const lineMaterials = new Set();
const lineResolution = { x: 1, y: 1 };
const HIGHLIGHT = new Color('#ff5a36');

// Lite materials (battery saver): no clear coat, which is costly on phone GPUs.
let lite = false;
export function setLiteMaterials(on) {
  lite = on;
}

export function setLineResolution(w, h) {
  lineResolution.x = w;
  lineResolution.y = h;
  for (const m of lineMaterials) m.resolution.set(w, h);
}

// ---------------------------------------------------------------- materials

function strokeMaterial(color) {
  return new MeshStandardMaterial({ color, roughness: 0.38, metalness: 0 });
}

function clayMaterial(color) {
  if (lite) return new MeshStandardMaterial({ color, roughness: 0.5, metalness: 0 });
  return new MeshPhysicalMaterial({ color, roughness: 0.55, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.45 });
}

function paperMaterial() {
  return new MeshStandardMaterial({ color: '#fbfaf7', roughness: 0.95, metalness: 0, transparent: true, opacity: 0.95 });
}

// Glossy jelly whose surface wobbles; physics sets userData.wobble (0..1)
// when it's shaken or lands.
function slimeMaterial(color) {
  const m = lite
    ? new MeshStandardMaterial({ color, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.9 })
    : new MeshPhysicalMaterial({
      color, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06,
      transparent: true, opacity: 0.9,
    });
  const wobble = { value: 0 };
  m.userData.wobble = wobble;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.time = holoTime;
    shader.uniforms.wobble = wobble;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float time;\nuniform float wobble;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float w = sin(position.x * 13.0 + time * 9.0) * sin(position.y * 11.0 + time * 7.0) * sin(position.z * 12.0 + time * 8.0);
        transformed += normal * (w * (0.012 + wobble * 0.08) + sin(time * 2.0 + position.y * 6.0) * 0.01);`);
  };
  return m;
}

function lineMaterial(color, width) {
  const m = new LineMaterial({ color, linewidth: width });
  m.resolution.set(lineResolution.x, lineResolution.y);
  lineMaterials.add(m);
  return m;
}

// ---------------------------------------------------------------- geometry

const shared = {};
function once(key, make) {
  if (!shared[key]) {
    shared[key] = make();
    shared[key].userData.shared = true;
  }
  return shared[key];
}

const bodies = {
  board: () => once('board', () => new RoundedBoxGeometry(1, 1, 1, 4, 0.03)),
  bar: () => once('bar', () => new RoundedBoxGeometry(1, 1, 1, 4, 0.2)),
  box: () => once('box', () => new RoundedBoxGeometry(1, 1, 1, 4, 0.08)),
  sphere: () => once('sphere', () => new SphereGeometry(0.5, 64, 40)),
  cylinder: () => once('cylinder', () => new CylinderGeometry(0.5, 0.5, 1, 64)),
  cone: () => once('cone', () => new ConeGeometry(0.5, 1, 64)),
  torus: () => once('torus', () => new TorusGeometry(0.4, 0.1, 32, 96)),
};

// Diagonal hatching on the front and back faces of a unit box, like a sketch.
function hatchGeometry({ n, slant }) {
  const pos = [];
  const step = (1 + slant) / (n + 1);
  for (const z of [0.505, -0.505]) {
    for (let i = 1; i <= n; i++) {
      let x0 = -0.5 - slant + i * step; // bottom end
      let x1 = x0 + slant; // top end
      let y0 = -0.42;
      let y1 = 0.42;
      // Clip the line to the face.
      if (x0 < -0.45) { y0 += ((-0.45 - x0) / slant) * 0.84; x0 = -0.45; }
      if (x1 > 0.45) { y1 -= ((x1 - 0.45) / slant) * 0.84; x1 = 0.45; }
      if (y1 - y0 < 0.05) continue;
      pos.push(x0, y0, z, x1, y1, z);
    }
  }
  return new LineSegmentsGeometry().setPositions(pos);
}

// live: a cheaper tube without end caps, rebuilt as the stroke grows.
function strokeGeometry(pts, radius, live = false) {
  const n = pts.length / 3;
  const cap = (i) => new SphereGeometry(radius, 16, 10).translate(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  if (n < 2) return cap(0);
  const points = [];
  for (let i = 0; i < n; i++) points.push(new Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
  const curve = new CatmullRomCurve3(points, false, 'centripetal');
  if (live) return new TubeGeometry(curve, Math.min(n * 2, 300), radius, 8, false);
  const tube = new TubeGeometry(curve, Math.min(n * 4, 800), radius, 10, false);
  tube.deleteAttribute('uv');
  const a = cap(0); a.deleteAttribute('uv');
  const b = cap(n - 1); b.deleteAttribute('uv');
  return mergeGeometries([tube.toNonIndexed(), a.toNonIndexed(), b.toNonIndexed()]);
}

// ---------------------------------------------------------------- build / save

function lit(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.pick = true;
  return mesh;
}

function buildStroke(data) {
  return lit(new Mesh(strokeGeometry(data.pts, data.radius), strokeMaterial(data.color)));
}

function buildShape(data) {
  const g = new Group();
  const inner = new Group();
  inner.name = 'inner';
  inner.scale.fromArray(data.dims);
  g.add(inner);
  if (data.shape === 'board') {
    // A sheet of paper to draw on, with a hairline edge.
    const body = lit(new Mesh(bodies.board(), paperMaterial()));
    body.castShadow = false;
    inner.add(body);
    return g;
  }
  if (data.shape === 'slime') {
    const body = lit(new Mesh(bodies.sphere(), slimeMaterial(data.color)));
    body.name = 'slime';
    inner.add(body);
    return g;
  }
  inner.add(lit(new Mesh(bodies[data.shape](), clayMaterial(data.color))));
  if (data.hatch) {
    // Hatching in a darker shade of the bar's own color.
    const ink = new Color(data.color).multiplyScalar(0.45);
    inner.add(new LineSegments2(hatchGeometry(data.hatch), lineMaterial(ink, 2.2)));
  }
  return g;
}

export function buildObject(data) {
  const obj = data.type === 'stroke' ? buildStroke(data) : buildShape(data);
  obj.userData.data = data;
  if (data.m) {
    obj.matrix.fromArray(data.m);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  }
  for (const c of data.children ?? []) obj.add(buildObject(c));
  return obj;
}

export function serialize(obj) {
  obj.updateMatrix();
  const { children: _, ...data } = obj.userData.data;
  const kids = obj.children.filter((c) => c.userData.data).map(serialize);
  return { ...data, m: obj.matrix.toArray().map((v) => +v.toFixed(5)), ...(kids.length ? { children: kids } : {}) };
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.material) {
      lineMaterials.delete(o.material);
      o.material.dispose();
    }
  });
}

// Live strokes grow point by point while you draw...
export function setStrokePoints(mesh, pts) {
  mesh.userData.data.pts = pts;
  mesh.geometry.dispose();
  mesh.geometry = strokeGeometry(pts, mesh.userData.data.radius, true);
}

// ...and get their smooth, capped final shape when you stop.
export function finishStroke(mesh) {
  mesh.geometry.dispose();
  mesh.geometry = strokeGeometry(mesh.userData.data.pts, mesh.userData.data.radius);
}

// Hover feedback: a warm tint on what a hand would grab, paint or erase.
export function setHighlight(obj, on) {
  if (!obj || obj.userData.highlight === on) return;
  obj.userData.highlight = on;
  const apply = (o) => {
    if (o.material?.emissive) o.material.emissive.copy(HIGHLIGHT).multiplyScalar(on ? 0.28 : 0);
  };
  // Highlight the object itself but not strokes drawn on it.
  apply(obj);
  obj.getObjectByName('inner')?.children.forEach(apply);
}

// Finds the saved object that a raycast hit belongs to.
export function ownerOf(o) {
  while (o && !o.userData.data) o = o.parent;
  return o;
}

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();

// Shape spanned between two pinch points A and B. `camQ` is the camera rotation
// (shapes face the viewer), `t` the thickness setting in meters.
export function shapeFromHands(shape, A, B, camQ, t, color) {
  const d = _x.subVectors(B, A);
  const len = Math.max(d.length(), 0.005);
  const mid = new Vector3().addVectors(A, B).multiplyScalar(0.5);
  const q = new Quaternion();
  let dims;
  let hatch;

  const alongAxis = (axisLocal) => {
    // Rotation that points `axisLocal` along A→B and keeps "up" toward the camera's up.
    const dir = d.clone().normalize();
    const up = new Vector3(0, 1, 0).applyQuaternion(camQ);
    const fwd = new Vector3(0, 0, 1).applyQuaternion(camQ);
    const ref = Math.abs(dir.dot(up)) > 0.9 ? fwd : up;
    if (axisLocal === 'x') {
      _x.copy(dir);
      _z.crossVectors(_x, ref).normalize();
      _y.crossVectors(_z, _x).normalize();
    } else {
      _y.copy(dir);
      _x.crossVectors(_y, fwd).normalize();
      if (_x.lengthSq() < 1e-6) _x.crossVectors(_y, up).normalize();
      _z.crossVectors(_x, _y).normalize();
    }
    q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  };

  if (shape === 'board') {
    // The two pinch points are opposite corners of the area, facing you.
    q.copy(camQ);
    const inv = camQ.clone().invert();
    _a.copy(A).applyQuaternion(inv);
    _b.copy(B).applyQuaternion(inv);
    let sx = Math.abs(_a.x - _b.x);
    let sy = Math.abs(_a.y - _b.y);
    sx = Math.max(sx, sy * 0.4, 0.02);
    sy = Math.max(sy, sx * 0.4, 0.02);
    dims = [sx, sy, 0.004];
  } else if (shape === 'bar') {
    alongAxis('x');
    const h = Math.max(t * 2.2, len * 0.17);
    dims = [len, h, Math.max(t, h * 0.3)];
    hatch = { n: Math.max(2, Math.round((len / h) * 2.2)), slant: h / len };
  } else if (shape === 'cylinder' || shape === 'cone') {
    alongAxis('y');
    const r = Math.max(t * 3, len * 0.32);
    dims = [r, len, r];
  } else {
    q.copy(camQ);
    if (shape === 'box') {
      const inv = camQ.clone().invert();
      _a.copy(A).applyQuaternion(inv);
      _b.copy(B).applyQuaternion(inv);
      const sx = Math.max(Math.abs(_a.x - _b.x), 0.01);
      const sy = Math.max(Math.abs(_a.y - _b.y), 0.01);
      const sz = Math.max(Math.abs(_a.z - _b.z), Math.min(sx, sy) * 0.8, 0.01);
      dims = [sx, sy, sz];
    } else {
      dims = [len, len, len];
    }
  }

  _m.compose(mid, q, new Vector3(1, 1, 1));
  return {
    type: 'shape',
    shape,
    color,
    dims: dims.map((v) => +v.toFixed(4)),
    ...(hatch ? { hatch } : {}),
    m: _m.toArray(),
  };
}

// Simple, export-friendly copy of the scene (for .glb files).
export function exportableGroup(content) {
  const out = new Group();
  content.updateMatrixWorld(true);
  content.traverse((o) => {
    if (!o.isMesh || !o.userData.pick) return;
    const data = ownerOf(o).userData.data;
    const isShape = data.type === 'shape';
    const mat = new MeshStandardMaterial({
      color: new Color(data.shape === 'board' ? '#fbfaf7' : data.color),
      roughness: isShape ? 0.55 : 0.4,
    });
    const m = new Mesh(o.geometry, mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    out.add(m);
  });
  return out;
}
