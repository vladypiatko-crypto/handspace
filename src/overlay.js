import { HAND_CONNECTIONS, FACE_CONTOURS, POSE_CONNECTIONS } from './tracker.js';

// Draws tracking feedback on a 2D canvas over the 3D view: white marks with a
// soft dark edge, so they read on any camera background.

const HOLD_LABELS = { fist: 'Undo', peace: 'Next shape', open: 'Menu' };
const INK = '#17171a';
const SHADE = 'rgba(0, 0, 0, 0.28)';

// A white line with a faint dark edge (cheaper than canvas shadows).
function inkLine(g, width, alpha = 1) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.globalAlpha = alpha * 0.6;
  g.strokeStyle = SHADE;
  g.lineWidth = width + 2;
  g.stroke();
  g.globalAlpha = alpha;
  g.strokeStyle = '#fff';
  g.lineWidth = width;
  g.stroke();
  g.globalAlpha = 1;
}

// A small rounded label: white chip with ink text.
function chip(g, text, x, y, align = 'left') {
  g.font = '500 12px Inter, system-ui, sans-serif';
  const w = g.measureText(text).width + 14;
  const h = 22;
  const left = align === 'center' ? x - w / 2 : x;
  g.fillStyle = 'rgba(255, 255, 255, 0.95)';
  g.beginPath();
  g.roundRect(left, y - h / 2, w, h, 11);
  g.fill();
  g.fillStyle = INK;
  g.textBaseline = 'middle';
  g.fillText(text, left + 7, y + 0.5);
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
  }

  resize(w, h, pr) {
    this.canvas.width = Math.round(w * pr);
    this.canvas.height = Math.round(h * pr);
    this.w = w;
    this.h = h;
    this.g.setTransform(pr, 0, 0, pr, 0, 0);
  }

  draw({ hands, face, pose, mirror, showSkeleton, color, holdTimes, menuOpen, mouth, anchors, t }) {
    const { g, w, h } = this;
    g.clearRect(0, 0, w, h);
    const X = (p) => (mirror ? 1 - p.x : p.x) * w;
    const Y = (p) => p.y * h;

    // Stick mode: what the camera recognizes, as corner brackets with a label.
    for (const a of anchors ?? []) {
      const x = a.box.x * w;
      const y = a.box.y * h;
      const bw = a.box.w * w;
      const bh = a.box.h * h;
      const k = Math.min(16, bw / 3, bh / 3);
      g.beginPath();
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]]) {
        g.moveTo(cx + dx * k, cy);
        g.lineTo(cx, cy);
        g.lineTo(cx, cy + dy * k);
      }
      inkLine(g, 2, 0.9);
      const label = `${a.label}${a.stuck ? ` · ${a.stuck} stuck` : ''}`;
      chip(g, label, x, y - 14);
    }

    // Eating: a dashed ring around your mouth when something is in reach.
    if (mouth?.target) {
      const r = Math.max(18, mouth.r * w * 0.8) * (mouth.armed ? 1.2 : 1);
      g.save();
      g.setLineDash([5, 6]);
      g.lineDashOffset = -t * 20;
      g.beginPath();
      g.arc(mouth.x * w, mouth.y * h, r, 0, Math.PI * 2);
      inkLine(g, 2, 0.95);
      g.restore();
      chip(g, mouth.armed ? 'Now close' : 'Open wide', mouth.x * w, mouth.y * h + r + 18, 'center');
    }

    if (pose) {
      g.beginPath();
      for (const { start, end } of POSE_CONNECTIONS) {
        const a = pose.lm[start];
        const b = pose.lm[end];
        if ((a.visibility ?? 1) < 0.5 || (b.visibility ?? 1) < 0.5) continue;
        g.moveTo(X(a), Y(a));
        g.lineTo(X(b), Y(b));
      }
      inkLine(g, 2, 0.7);
    }

    if (face) {
      g.beginPath();
      for (const { start, end } of FACE_CONTOURS) {
        const a = face.lm[start];
        const b = face.lm[end];
        g.moveTo(X(a), Y(a));
        g.lineTo(X(b), Y(b));
      }
      inkLine(g, 1, 0.55);
    }

    hands.forEach((hand) => {
      if (!hand.present) return;
      // Hand landmarks are already in screen space (mirroring applied).
      const hx = (p) => p.x * w;
      const hy = (p) => p.y * h;

      if (showSkeleton && hand.lm) {
        g.beginPath();
        for (const { start, end } of HAND_CONNECTIONS) {
          g.moveTo(hx(hand.lm[start]), hy(hand.lm[start]));
          g.lineTo(hx(hand.lm[end]), hy(hand.lm[end]));
        }
        inkLine(g, 1.5, 0.75);
      }

      // Framing ("L" with thumb and index): mark the corner and both arms.
      if (hand.gesture === 'frame' && hand.lm) {
        const cx = hand.cornerScreen.x * w;
        const cy = hand.cornerScreen.y * h;
        g.beginPath();
        for (const tip of [4, 8]) {
          g.moveTo(cx, cy);
          g.lineTo(cx + (hx(hand.lm[tip]) - cx) * 0.75, cy + (hy(hand.lm[tip]) - cy) * 0.75);
        }
        inkLine(g, 3, 1);
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(cx, cy, 4, 0, Math.PI * 2);
        g.fill();
        return;
      }

      // Pointing: a pen tip in the current color at the fingertip.
      if (hand.drawing || hand.gesture === 'point') {
        const tx = hand.tipScreen.x * w;
        const ty = hand.tipScreen.y * h;
        const r = hand.drawing ? 6 : 4.5;
        g.globalAlpha = hand.drawing ? 1 : 0.75;
        g.fillStyle = SHADE;
        g.beginPath();
        g.arc(tx, ty, r + 3.5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(tx, ty, r + 2, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = color;
        g.beginPath();
        g.arc(tx, ty, r, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        return;
      }

      // Pinch point: an open ring that closes to a dot while pinching.
      const cx = hand.screen.x * w;
      const cy = hand.screen.y * h;
      g.beginPath();
      g.arc(cx, cy, hand.pinching ? 7 : 13, 0, Math.PI * 2);
      inkLine(g, hand.pinching ? 3 : 2, hand.pinching ? 1 : 0.85);
      if (hand.pinching) {
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(cx, cy, 3, 0, Math.PI * 2);
        g.fill();
      }

      // Hold-to-trigger gestures fill a ring above the wrist.
      const holdTime = holdTimes?.[hand.gesture];
      if (holdTime && !(hand.gesture === 'open' && menuOpen) && hand.gestureTime > 0.15 && hand.lm) {
        const k = Math.min(1, (hand.gestureTime - 0.15) / (holdTime - 0.15));
        const wx = hx(hand.lm[0]);
        const wy = hy(hand.lm[0]) - 12;
        g.lineCap = 'round';
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(0, 0, 0, 0.3)';
        g.beginPath();
        g.arc(wx, wy, 20, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = '#fff';
        g.beginPath();
        g.arc(wx, wy, 20, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
        g.stroke();
        chip(g, HOLD_LABELS[hand.gesture], wx, wy + 40, 'center');
      }
    });
  }
}
