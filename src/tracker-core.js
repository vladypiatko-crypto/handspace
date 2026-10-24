import { FilesetResolver, HandLandmarker, FaceLandmarker, PoseLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';

// The MediaPipe models themselves. Runs either in a Web Worker (normally) or on
// the main thread (fallback), so it never touches the DOM.

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
      console.warn('GPU delegate failed, using CPU', err);
    }
  }
}

function blendMap(b) {
  const out = {};
  for (const c of b?.categories ?? []) out[c.categoryName] = c.score;
  return out;
}

export class TrackerCore {
  constructor() {
    this.models = {};
    this.frame = 0;
    this.lastNow = 0;
    this.result = { hands: [], face: null, pose: null, objects: null };
    this.loading = {};
  }

  // wasmBase: URL of the folder with MediaPipe's wasm; models: { kind: url }.
  async init(wasmBase, models) {
    this.urls = models;
    this.fileset = await FilesetResolver.forVisionTasks(wasmBase);
    this.models.hand = await create(HandLandmarker, this.fileset, {
      baseOptions: { modelAssetPath: models.hand },
      runningMode: 'VIDEO',
      numHands: 2,
      // Strict about finding new hands (the face can look like one), lenient
      // about keeping hands it already has (e.g. in front of the face).
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
    });
  }

  has(kind) {
    return !!this.models[kind];
  }

  // Face, body and object models load the first time they're needed.
  enable(kind) {
    if (this.models[kind] || this.loading[kind]) return this.loading[kind];
    const options = {
      face: [FaceLandmarker, { numFaces: 1, outputFaceBlendshapes: true }],
      pose: [PoseLandmarker, { numPoses: 1 }],
      // People are left to the face/hand/body models.
      objects: [ObjectDetector, { maxResults: 6, scoreThreshold: 0.45, categoryDenylist: ['person'] }],
    }[kind];
    if (!options) return Promise.resolve();
    this.loading[kind] = create(options[0], this.fileset, {
      baseOptions: { modelAssetPath: this.urls[kind] },
      runningMode: 'VIDEO',
      ...options[1],
    }).then((m) => { this.models[kind] = m; });
    return this.loading[kind];
  }

  // Hands run on every frame; face, body and objects take turns on the frames
  // in between so the hands stay fast.
  run(source, now, { face, pose, objects }) {
    if (now <= this.lastNow) now = this.lastNow + 1; // MediaPipe needs increasing timestamps
    this.lastNow = now;
    this.frame++;
    const W = source.videoWidth || source.width;
    const H = source.videoHeight || source.height;
    const r = this.result;

    const h = this.models.hand.detectForVideo(source, now);
    r.hands = h.landmarks.map((lm, i) => ({
      lm,
      wl: h.worldLandmarks[i],
      label: h.handedness[i]?.[0]?.categoryName ?? '',
      score: h.handedness[i]?.[0]?.score ?? 1,
    }));

    if (!face) r.face = null;
    else if (this.models.face && this.frame % 2 === 0) {
      const f = this.models.face.detectForVideo(source, now);
      r.face = f.faceLandmarks[0] ? { lm: f.faceLandmarks[0], blend: blendMap(f.faceBlendshapes[0]) } : null;
    }

    if (!pose) r.pose = null;
    else if (this.models.pose && this.frame % 4 === 1) {
      const p = this.models.pose.detectForVideo(source, now);
      r.pose = p.landmarks[0] ? { lm: p.landmarks[0] } : null;
    }

    if (!objects) r.objects = null;
    else if (this.models.objects && this.frame % 4 === 3) {
      const d = this.models.objects.detectForVideo(source, now);
      r.objects = d.detections.map((det) => ({
        label: det.categories[0]?.categoryName ?? 'thing',
        score: det.categories[0]?.score ?? 0,
        // Bounding box in 0..1 of the (unmirrored) frame.
        x: det.boundingBox.originX / W,
        y: det.boundingBox.originY / H,
        w: det.boundingBox.width / W,
        h: det.boundingBox.height / H,
      }));
    }
    return r;
  }
}
