import { Euler, Quaternion, Vector3 } from 'three';

// Turns the phone's gyroscope into a camera rotation, so objects you place stay
// where you put them while you turn the phone around (3 degrees of freedom).
// Same math as three.js' old DeviceOrientationControls.

const zee = new Vector3(0, 0, 1);
const euler = new Euler();
const qScreen = new Quaternion();
const qWorld = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° around X

function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return (a * Math.PI) / 180;
}

export function deviceQuaternion(alpha, beta, gamma, orient, out) {
  euler.set(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(euler);
  out.multiply(qWorld);
  out.multiply(qScreen.setFromAxisAngle(zee, -orient));
  return out;
}

export class MotionSource {
  constructor() {
    this.active = false;
    this.hasData = false;
    this.current = new Quaternion();
    this.baseInv = new Quaternion();
    this.needsRecenter = true;
    this._onEvent = (e) => {
      if (e.alpha == null) return;
      const d2r = Math.PI / 180;
      deviceQuaternion(e.alpha * d2r, e.beta * d2r, e.gamma * d2r, screenAngle(), this.current);
      this.hasData = true;
      if (this.needsRecenter) this.recenter();
    };
  }

  static get supported() {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  // Must be called from a user gesture on iOS.
  async start() {
    if (this.active) return true;
    if (!MotionSource.supported) return false;
    const DOE = window.DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    window.addEventListener('deviceorientation', this._onEvent);
    this.active = true;
    return true;
  }

  stop() {
    window.removeEventListener('deviceorientation', this._onEvent);
    this.active = false;
    this.hasData = false;
    this.needsRecenter = true;
  }

  recenter() {
    this.baseInv.copy(this.current).invert();
    this.needsRecenter = false;
  }

  // Rotation since the last recenter, in the starting camera frame.
  relative(out = new Quaternion()) {
    return out.copy(this.baseInv).multiply(this.current);
  }
}

// Converts a phone's relative rotation into a rotation for our virtual camera.
// The front camera looks out of the screen (rotated 180° about Y from the back
// camera) and a mirrored view reflects the world across X; both are applied by
// conjugating the quaternion.
export function cameraRotation(rel, { front, mirror }, out = new Quaternion()) {
  let { x, y, z, w } = rel;
  if (front) { x = -x; z = -z; }
  if (mirror) { y = -y; z = -z; }
  return out.set(x, y, z, w);
}
