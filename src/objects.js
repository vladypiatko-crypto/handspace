import {
  BoxGeometry, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, IcosahedronGeometry, Matrix4, Mesh, MeshBasicMaterial,
  Quaternion, ShaderMaterial, SphereGeometry, TorusGeometry, TubeGeometry, Vector3, WireframeGeometry,
  EdgesGeometry,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Every object in the scene is described by a small JSON-able "data" record kept
// in userData.data, so saving, undo and recoloring all just rebuild from data.
//
//   stroke: { type:'stroke', color, radius, pts:[x,y,z,...] (local), m, children }
//   shape:  { type:'shape', shape, color, dims:[x,y,z], hatch?, m, children }
//
// Shapes keep their size on an inner node, so strokes drawn onto a shape (its
// children) aren't stretched by it.

export const SHAPES = ['bar', 'box', 'sphere', 'cylinder', 'cone', 'torus'];
export const holoTime = { value: 0 };
export const lineMaterials = new Set();
const lineResolution = { x: 1, y: 1 };

export function setLineResolution(w, h) {
  lineResolution.x = w;
  lineResolution.y = h;
  for (const m of lineMaterials) m.resolution.set(w, h);
}

// A bright "neon tube" version of a color: a bit whiter in the core, and
// scaled so its brightest channel is 1 (dark colors still glow).
function glow(color, whiten = 0) {
  const c = new Color(color).lerp(new Color('#fff'), whiten);
  return c.multiplyScalar(1 / Math.max(c.r, c.g, c.b, 0.05));
}

// ---------------------------------------------------------------- materials

const holoVertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const holoFragment = /* glsl */ `
  uniform vec3 color;
  uniform float time;
  uniform float highlight;
  uniform float opacity;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  void main() {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float rim = pow(1.0 - facing, 2.2);
    float scan = smoothstep(0.75, 1.0, sin(vW.y * 260.0 - time * 3.0));
    float pulse = 0.5 + 0.5 * sin(time * 2.0);
    vec3 c = color * (0.12 + rim * 1.2 + scan * 0.15 + highlight * (0.15 + pulse * 0.25));
    c = min(c, vec3(1.0));
    float a = opacity * (0.14 + rim * 0.86 + scan * 0.08 + highlight * 0.15);
    gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
  }
`;

function holoMaterial(color) {
  return new ShaderMaterial({
    uniforms: {
      color: { value: glow(color) },
      time: holoTime,
      highlight: { value: 0 },
      opacity: { value: 0.85 },
    },
    vertexShader: holoVertex,
    fragmentShader: holoFragment,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

function edgeMaterial(color, width = 2.5, brightness = 1) {
  const m = new LineMaterial({ color: glow(color, 0.2).multiplyScalar(brightness), linewidth: width, transparent: true });
  m.resolution.set(lineResolution.x, lineResolution.y);
  m.userData.base = m.color.clone();
  lineMaterials.add(m);
  return m;
}

function strokeMaterial(color) {
  const m = new MeshBasicMaterial({ color: glow(color) });
  m.userData.base = m.color.clone();
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

function edgesFrom(geo, threshold = 1) {
  return new LineSegmentsGeometry().fromEdgesGeometry(new EdgesGeometry(geo, threshold));
}

const bodies = {
  bar: () => once('box', () => new BoxGeometry(1, 1, 1)),
  box: () => once('box', () => new BoxGeometry(1, 1, 1)),
  sphere: () => once('sphere', () => new SphereGeometry(0.5, 48, 32)),
  cylinder: () => once('cylinder', () => new CylinderGeometry(0.5, 0.5, 1, 48)),
  cone: () => once('cone', () => new ConeGeometry(0.5, 1, 48)),
  torus: () => once('torus', () => new TorusGeometry(0.4, 0.1, 24, 72)),
};

const edges = {
  bar: () => once('e-box', () => edgesFrom(new BoxGeometry(1, 1, 1))),
  box: () => once('e-box', () => edgesFrom(new BoxGeometry(1, 1, 1))),
  sphere: () => once('e-sphere', () => new LineSegmentsGeometry().fromWireframeGeometry(new WireframeGeometry(new IcosahedronGeometry(0.503, 1)))),
  cylinder: () => once('e-cyl', () => edgesFrom(new CylinderGeometry(0.5, 0.5, 1, 10))),
  cone: () => once('e-cone', () => edgesFrom(new ConeGeometry(0.5, 1, 10))),
  torus: () => once('e-torus', () => new LineSegmentsGeometry().fromWireframeGeometry(new WireframeGeometry(new TorusGeometry(0.4, 0.1, 6, 18)))),
};

// Diagonal hatching on the front and back faces of a unit box, like a sketch.
function hatchGeometry({ n, slant }) {
  const pos = [];
  const step = (1 + slant) / (n + 1);
  for (const z of [0.501, -0.501]) {
    for (let i = 1; i <= n; i++) {
      let x0 = -0.5 - slant + i * step; // bottom end
      let x1 = x0 + slant; // top end
      let y0 = -0.5;
      let y1 = 0.5;
      // Clip the line to the face.
      if (x0 < -0.5) { y0 += ((-0.5 - x0) / slant); x0 = -0.5; }
      if (x1 > 0.5) { y1 -= ((x1 - 0.5) / slant); x1 = 0.5; }
      if (y1 - y0 < 0.05) continue;
      pos.push(x0, y0, z, x1, y1, z);
    }
  }
  return new LineSegmentsGeometry().setPositions(pos);
}

function strokeGeometry(pts, radius) {
  const n = pts.length / 3;
  const cap = (i) => new SphereGeometry(radius, 12, 8).translate(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  if (n < 2) return cap(0);
  const points = [];
  for (let i = 0; i < n; i++) points.push(new Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]));
  const curve = new CatmullRomCurve3(points, false, 'centripetal');
  const tube = new TubeGeometry(curve, Math.min(n * 4, 800), radius, 8, false);
  tube.deleteAttribute('uv');
  const a = cap(0); a.deleteAttribute('uv');
  const b = cap(n - 1); b.deleteAttribute('uv');
  return mergeGeometries([tube.toNonIndexed(), a.toNonIndexed(), b.toNonIndexed()]);
}

// ---------------------------------------------------------------- build / save

function buildStroke(data) {
  const mesh = new Mesh(strokeGeometry(data.pts, data.radius), strokeMaterial(data.color));
  mesh.userData.pick = true;
  return mesh;
}

function buildShape(data) {
  const g = new Group();
  const inner = new Group();
  inner.name = 'inner';
  inner.scale.fromArray(data.dims);
  const body = new Mesh(bodies[data.shape](), holoMaterial(data.color));
  body.userData.pick = true;
  body.renderOrder = 1;
  inner.add(body);
  inner.add(new LineSegments2(edges[data.shape](), edgeMaterial(data.color)));
  if (data.hatch) inner.add(new LineSegments2(hatchGeometry(data.hatch), edgeMaterial(data.color, 2, 0.6)));
  g.add(inner);
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

// Live strokes grow point by point while you draw.
export function setStrokePoints(mesh, pts) {
  mesh.userData.data.pts = pts;
  mesh.geometry.dispose();
  mesh.geometry = strokeGeometry(pts, mesh.userData.data.radius);
}

const WHITE = new Color('#fff');

export function setHighlight(obj, on) {
  if (!obj || obj.userData.highlight === on) return;
  obj.userData.highlight = on;
  const apply = (o) => {
    const m = o.material;
    if (!m) return;
    if (m.uniforms?.highlight) m.uniforms.highlight.value = on ? 1 : 0;
    else if (m.userData.base) m.color.copy(m.userData.base).lerp(WHITE, on ? 0.55 : 0);
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

// ---------------------------------------------------------------- shapes from two hands

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

  if (shape === 'bar') {
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
    const mat = new MeshBasicMaterial({
      color: new Color(data.color),
      transparent: isShape,
      opacity: isShape ? 0.6 : 1,
    });
    const m = new Mesh(o.geometry, mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    out.add(m);
  });
  return out;
}
