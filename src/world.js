import {
  Box3, Color, DirectionalLight, Fog, GridHelper, Group, HemisphereLight, Mesh, NeutralToneMapping,
  PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Raycaster, RepeatWrapping, Scene,
  ShadowMaterial, SRGBColorSpace, Vector3, VideoTexture, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { holoTime, setLineResolution, ownerOf } from './objects.js';

// The 3D world. The camera feed is drawn as the background, and the virtual
// camera uses the same field of view as the real one, so 3D points line up
// exactly with your fingers on screen.
//
// Objects are lit like a photo studio: soft reflections from a room
// environment, one key light for shape and shadows, and neutral tone mapping
// so colors stay true. The camera feed itself is never tone-mapped.

const STUDIO = '#ebe8e2';

export class World {
  constructor(canvas, video, { antialias = true } = {}) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene = new Scene();
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;

    this.camera = new PerspectiveCamera(50, 16 / 9, 0.01, 100);
    this.scene.add(this.camera);
    this.content = new Group();
    this.scene.add(this.content);

    // Light from above and slightly in front, like a desk lamp.
    this.scene.add(new HemisphereLight('#ffffff', '#cfc8bc', 0.5));
    this.key = new DirectionalLight('#ffffff', 1.4);
    this.key.position.set(0.5, 1.4, 0.4);
    this.key.target.position.set(0, -0.1, -0.5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 4 });
    this.key.shadow.bias = -0.0005;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);

    // An invisible floor that only shows shadows (for gravity and the 3D view).
    this.floor = new Mesh(new PlaneGeometry(8, 8), new ShadowMaterial({ opacity: 0.16 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.visible = false;
    this.scene.add(this.floor);

    this.videoTex = new VideoTexture(video);
    this.videoTex.colorSpace = SRGBColorSpace;
    this.videoTex.wrapS = RepeatWrapping;
    this.scene.background = this.videoTex;

    // 3D view: orbit around your creations in a light studio.
    this.freeCam = new PerspectiveCamera(45, 1, 0.01, 100);
    this.freeCam.position.set(0.6, 0.35, 0.6);
    this.controls = new OrbitControls(this.freeCam, canvas);
    this.controls.target.set(0, 0, -0.5);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
    this.grid = new GridHelper(4, 40, '#cdc8bf', '#dedad3');
    this.grid.position.set(0, -0.4, -0.5);
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.free = false;
    this.studio = new Color(STUDIO);
    this.floorY = null;

    this.raycaster = new Raycaster();
  }

  setMirror(mirror) {
    this.videoTex.repeat.x = mirror ? -1 : 1;
    this.videoTex.offset.x = mirror ? 1 : 0;
  }

  // Battery saver: no shadows.
  setSaver(on) {
    this.key.castShadow = !on;
    this.saver = on;
  }

  // Where the gravity floor is (null = no floor), for soft contact shadows.
  setFloor(y) {
    this.floorY = y;
  }

  // Matches the virtual camera to the real camera: W×H frame, focal length f (px).
  setIntrinsics(W, H, f) {
    const fov = (2 * Math.atan(H / 2 / f) * 180) / Math.PI;
    if (Math.abs(this.camera.fov - fov) > 0.01 || Math.abs(this.camera.aspect - W / H) > 0.001) {
      this.camera.fov = fov;
      this.camera.aspect = W / H;
      this.camera.updateProjectionMatrix();
    }
  }

  resize(w, h, pr) {
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.freeCam.aspect = w / h;
    this.freeCam.updateProjectionMatrix();
    setLineResolution(w * pr, h * pr);
  }

  setFree(on) {
    if (on) this.frameContent();
    this.free = on;
    this.controls.enabled = on;
    this.grid.visible = on;
    this.scene.background = on ? this.studio : this.videoTex;
    this.scene.fog = on ? new Fog(STUDIO, 2.5, 7) : null;
  }

  // Points the 3D-view camera at everything you've made, from a slight angle.
  frameContent() {
    const box = new Box3().setFromObject(this.content);
    if (box.isEmpty()) box.set(new Vector3(-0.2, -0.2, -0.7), new Vector3(0.2, 0.2, -0.3));
    const center = box.getCenter(new Vector3());
    const size = Math.max(box.getSize(new Vector3()).length(), 0.2);
    this.controls.target.copy(center);
    this.freeCam.position.copy(center).add(new Vector3(0.45, 0.35, 0.85).multiplyScalar(size));
    this.freeCam.lookAt(center);
    this.grid.position.set(center.x, box.min.y - 0.02, center.z);
    this.controls.update();
  }

  get viewCamera() {
    return this.free ? this.freeCam : this.camera;
  }

  render(dt) {
    holoTime.value += dt;
    if (this.free) this.controls.update();
    this.camera.updateMatrixWorld();
    // Contact shadows: on the studio floor in the 3D view, on the gravity floor otherwise.
    const floorY = this.free ? this.grid.position.y : this.floorY;
    this.floor.visible = !this.saver && floorY != null;
    if (this.floor.visible) {
      this.floor.position.set(this.free ? this.grid.position.x : 0, floorY + 0.001, this.free ? this.grid.position.z : -0.6);
    }
    this.renderer.render(this.scene, this.viewCamera);
  }

  // Ray from the AR camera through a world point (e.g. a pinch point).
  rayTo(point) {
    const origin = new Vector3().setFromMatrixPosition(this.camera.matrixWorld);
    this.raycaster.set(origin, point.clone().sub(origin).normalize());
    this.raycaster.camera = this.camera;
    return this.raycaster;
  }

  // Pickable meshes under `root` (default: everything), optionally filtered.
  pickables(root = this.content, filter) {
    const out = [];
    root.traverse((o) => {
      if (o.isMesh && o.userData.pick && (!filter || filter(ownerOf(o)))) out.push(o);
    });
    return out;
  }
}
