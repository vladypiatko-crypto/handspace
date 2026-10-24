import {
  Color, Fog, GridHelper, Group, PerspectiveCamera, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3,
  VideoTexture, WebGLRenderer, NoToneMapping, RepeatWrapping, HalfFloatType, WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { holoTime, setLineResolution, ownerOf } from './objects.js';

// The 3D world. The camera feed is drawn as the background, and the virtual
// camera uses the same field of view as the real one, so 3D points line up
// exactly with your fingers on screen.
//
// Bloom only picks up colors brighter than 1.0. The camera feed never goes
// above 1.0, so only the neon objects glow.

export class World {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(50, 16 / 9, 0.01, 100);
    this.scene.add(this.camera);
    this.content = new Group();
    this.scene.add(this.content);

    this.videoTex = new VideoTexture(video);
    this.videoTex.colorSpace = SRGBColorSpace;
    this.videoTex.wrapS = RepeatWrapping;
    this.scene.background = this.videoTex;

    // Free view: orbit around your creations with a neon floor grid.
    this.freeCam = new PerspectiveCamera(55, 1, 0.01, 100);
    this.freeCam.position.set(0.6, 0.35, 0.6);
    this.controls = new OrbitControls(this.freeCam, canvas);
    this.controls.target.set(0, 0, -0.5);
    this.controls.enableDamping = true;
    this.controls.enabled = false;
    this.grid = new GridHelper(4, 40, new Color('#4fd1c5').multiplyScalar(1.6), new Color('#2a3f5f'));
    this.grid.position.set(0, -0.4, -0.5);
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.free = false;

    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.9, 0.55, 1.0);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.glow = true;

    this.raycaster = new Raycaster();
  }

  setMirror(mirror) {
    this.videoTex.repeat.x = mirror ? -1 : 1;
    this.videoTex.offset.x = mirror ? 1 : 0;
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
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.freeCam.aspect = w / h;
    this.freeCam.updateProjectionMatrix();
    setLineResolution(w * pr, h * pr);
  }

  setFree(on) {
    this.free = on;
    this.controls.enabled = on;
    this.grid.visible = on;
    this.scene.background = on ? new Color('#07090d') : this.videoTex;
    this.scene.fog = on ? new Fog('#07090d', 1.5, 5) : null;
    this.renderPass.camera = on ? this.freeCam : this.camera;
  }

  get viewCamera() {
    return this.free ? this.freeCam : this.camera;
  }

  render(dt) {
    holoTime.value += dt;
    if (this.free) this.controls.update();
    this.camera.updateMatrixWorld();
    if (this.glow) this.composer.render(dt);
    else this.renderer.render(this.scene, this.viewCamera);
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
