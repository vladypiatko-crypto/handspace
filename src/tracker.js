import { FilesetResolver, HandLandmarker, FaceLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

// Google's pre-trained MediaPipe models (the same ones used by Meet effects and
// many web games). The wasm runtime is served from our own public/ folder.
// The Android app bundles the hand model so tracking works offline.
const IN_APP = navigator.userAgent.includes('HandSpaceApp');
const MODELS = {
  hand: IN_APP
    ? new URL('models/hand_landmarker.task', document.baseURI).href
    : 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};

export const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS;
export const FACE_CONTOURS = FaceLandmarker.FACE_LANDMARKS_CONTOURS;
export const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

async function create(Task, fileset, options) {
  // The GPU delegate is much faster but not available everywhere.
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Task.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate },
      });
    } catch (err) {
      if (delegate === 'CPU') throw err;
      console.warn(`${Task.name}: GPU delegate failed, using CPU`, err);
    }
  }
}

export class Tracker {
  constructor() {
    this.hand = null;
    this.face = null;
    this.pose = null;
    this.frame = 0;
    this.lastTime = -1;
    this.result = { hands: [], face: null, pose: null };
    this._loading = {};
  }

  async init() {
    this.fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', document.baseURI).href);
    this.hand = await create(HandLandmarker, this.fileset, {
      baseOptions: { modelAssetPath: MODELS.hand },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  // Face and pose models load lazily the first time they're switched on.
  async enable(kind) {
    if (this[kind] || this._loading[kind]) return this._loading[kind];
    this._loading[kind] = (async () => {
      if (kind === 'face') {
        this.face = await create(FaceLandmarker, this.fileset, {
          baseOptions: { modelAssetPath: MODELS.face },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
        });
      } else if (kind === 'pose') {
        this.pose = await create(PoseLandmarker, this.fileset, {
          baseOptions: { modelAssetPath: MODELS.pose },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
      }
    })();
    return this._loading[kind];
  }

  // Runs detection on the current video frame. Hands run every frame; face and
  // pose alternate on the frames in between to keep phones responsive.
  detect(video, { face, pose }) {
    if (!this.hand || video.readyState < 2 || !video.videoWidth) return null;
    if (video.currentTime === this.lastTime) return null;
    this.lastTime = video.currentTime;
    const now = performance.now();
    this.frame++;

    const h = this.hand.detectForVideo(video, now);
    this.result.hands = h.landmarks.map((lm, i) => ({
      lm,
      wl: h.worldLandmarks[i],
      label: h.handedness[i]?.[0]?.categoryName ?? '',
    }));

    if (!face) this.result.face = null;
    else if (this.face && this.frame % 2 === 0) {
      const f = this.face.detectForVideo(video, now);
      this.result.face = f.faceLandmarks[0]
        ? { lm: f.faceLandmarks[0], blend: blendMap(f.faceBlendshapes[0]) }
        : null;
    }

    if (!pose) this.result.pose = null;
    else if (this.pose && this.frame % 2 === 1) {
      const p = this.pose.detectForVideo(video, now);
      this.result.pose = p.landmarks[0] ? { lm: p.landmarks[0] } : null;
    }
    return this.result;
  }
}

function blendMap(b) {
  const out = {};
  for (const c of b?.categories ?? []) out[c.categoryName] = c.score;
  return out;
}

// Turns face blendshape scores into a short list of readable expressions.
export function describeFace(blend) {
  if (!blend) return [];
  const g = (k) => blend[k] ?? 0;
  const tags = [];
  if ((g('mouthSmileLeft') + g('mouthSmileRight')) / 2 > 0.5) tags.push('smiling 😄');
  if (g('jawOpen') > 0.4) tags.push('mouth open 😮');
  if (g('eyeBlinkLeft') > 0.5 && g('eyeBlinkRight') > 0.5) tags.push('eyes closed 😌');
  else if (g('eyeBlinkLeft') > 0.5 || g('eyeBlinkRight') > 0.5) tags.push('winking 😉');
  if (g('browInnerUp') > 0.5) tags.push('eyebrows up 🤨');
  if (g('mouthPucker') > 0.6) tags.push('pucker 😗');
  if (g('cheekPuff') > 0.4) tags.push('cheeks puffed 🐡');
  return tags;
}
