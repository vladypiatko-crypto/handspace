// Opens a camera stream. `facing` is 'user' (front/webcam) or 'environment' (back).
export async function openCamera(facing = 'user') {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs HTTPS (or localhost) and a modern browser.');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: facing,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
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
