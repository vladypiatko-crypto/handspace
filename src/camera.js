// Opens a camera stream. `facing` is 'user' (front/webcam) or 'environment' (back).
// `light`: a smaller, slower stream that's plenty for hand tracking and keeps
// phones cool.
export async function openCamera(facing = 'user', light = false) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs HTTPS (or localhost) and a modern browser.');
  }
  // Ask for a portrait picture on a portrait screen, so it fills the screen
  // instead of showing up as a small letterboxed strip.
  const long = light ? 640 : 1280;
  const short = light ? 480 : 720;
  const portrait = innerHeight > innerWidth;
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: facing,
      width: { ideal: portrait ? short : long },
      height: { ideal: portrait ? long : short },
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
