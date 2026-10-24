// Opens a camera stream. `facing` is 'user' (front/webcam) or 'environment' (back).
// `light`: a smaller, slower stream that's plenty for hand tracking and keeps
// phones cool.
export async function openCamera(facing = 'user', light = false) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs HTTPS (or localhost) and a modern browser.');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: facing,
      width: { ideal: light ? 640 : 1280 },
      height: { ideal: light ? 480 : 720 },
      frameRate: light ? { ideal: 24, max: 30 } : { ideal: 30 },
    },
  });
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Resolves once the video element knows its frame size.
export function videoReady(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('loadedmetadata', done); resolve(); };
    video.addEventListener('loadedmetadata', done);
  });
}
