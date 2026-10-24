import {
  Box3, Color, Fog, GridHelper, Group, PerspectiveCamera, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3,
  VideoTexture, WebGLRenderer, NoToneMapping, RepeatWrapping, HalfFloatType, WebGLRenderTarget, ShaderMaterial,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { holoTime, setLineResolution, ownerOf } from './objects.js';

// The 3D world. The camera feed is drawn as the background, and the virtual
// camera uses the same field of view as the real one, so 3D points line up
// exactly with your fingers on screen.
//
// Selective bloom: the 3D objects are rendered once on black and blurred into
// a glow layer, which is then added over the normal render. That way only the
// neon objects glow, never the camera feed.

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
    this.grid = new GridHelper(4, 40, new Color('#4fd1c5'), new Color('#24364f'));
    this.grid.position.set(0, -0.4, -0.5);
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.free = false;

    this.bloomComposer = new EffectComposer(this.renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType }));
    this.bloomComposer.renderToScreen = false;
    this.bloomRender = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.8, 0.3, 0);
    this.bloomComposer.addPass(this.bloomRender);
    this.bloomComposer.addPass(this.bloom);

    this.composer = new EffectComposer(this.renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 }));
    this.renderPass = new RenderPass(this.scene, this.camera);
    const mix = new ShaderPass(new ShaderMaterial({
      uniforms: { baseTexture: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(baseTexture, vUv);
          vec3 glow = texture2D(bloomTexture, vUv).rgb;
          // Screen blend: glow brightens without blowing bright camera areas out to white.
          gl_FragColor = vec4(base.rgb + glow * max(vec3(0.0), 1.0 - base.rgb), base.a);
        }`,
    }), 'baseTexture');
    this.composer.addPass(this.renderPass);
    this.composer.addPass(mix);
    this.composer.addPass(new OutputPass());
    this.black = new Color('#000');
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
    for (const c of [this.composer, this.bloomComposer]) {
      c.setPixelRatio(pr);
      c.setSize(w, h);
    }
    this.freeCam.aspect = w / h;
    this.freeCam.updateProjectionMatrix();
    setLineResolution(w * pr, h * pr);
  }

  setFree(on) {
    if (on) this.frameContent();
    this.free = on;
    this.controls.enabled = on;
    this.grid.visible = on;
    this.scene.background = on ? new Color('#07090d') : this.videoTex;
    this.scene.fog = on ? new Fog('#07090d', 2, 6) : null;
    this.renderPass.camera = this.bloomRender.camera = on ? this.freeCam : this.camera;
  }

  // Points the free-view camera at everything you've made, from a slight angle.
  frameContent() {
    const box = new Box3().setFromObject(this.content);
    if (box.isEmpty()) box.set(new Vector3(-0.2, -0.2, -0.7), new Vector3(0.2, 0.2, -0.3));
    const center = box.getCenter(new Vector3());
    const size = Math.max(box.getSize(new Vector3()).length(), 0.2);
    this.controls.target.copy(center);
    this.freeCam.position.copy(center).add(new Vector3(0.45, 0.35, 0.85).multiplyScalar(size));
    this.freeCam.lookAt(center);
    this.grid.position.set(center.x, box.min.y - 0.05, center.z);
    this.controls.update();
  }

  get viewCamera() {
    return this.free ? this.freeCam : this.camera;
  }

  render(dt) {
    holoTime.value += dt;
    if (this.free) this.controls.update();
    this.camera.updateMatrixWorld();
    if (!this.glow) return this.renderer.render(this.scene, this.viewCamera);
    const { background, fog } = this.scene;
    this.scene.background = this.black;
    this.scene.fog = null;
    this.grid.visible = false;
    this.bloomComposer.render(dt);
    this.scene.background = background;
    this.scene.fog = fog;
    this.grid.visible = this.free;
    this.composer.render(dt);
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
