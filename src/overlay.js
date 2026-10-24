import { HAND_CONNECTIONS, FACE_CONTOURS, POSE_CONNECTIONS } from './tracker.js';

// Draws the tracking results on a 2D canvas over the 3D view in a neon style.

const HAND_COLORS = ['#4fd1c5', '#f472b6'];
const HOLD_ICONS = { fist: '↶ undo', peace: '✌ next tool' };

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

  draw({ hands, face, pose, mirror, showSkeleton, color, holdTime, t }) {
    const { g, w, h } = this;
    g.clearRect(0, 0, w, h);
    const X = (p) => (mirror ? 1 - p.x : p.x) * w;
    const Y = (p) => p.y * h;

    if (pose) {
      g.save();
      g.strokeStyle = 'rgba(167, 139, 250, 0.85)';
      g.shadowColor = '#a78bfa';
      g.shadowBlur = 12;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      for (const { start, end } of POSE_CONNECTIONS) {
        const a = pose.lm[start];
        const b = pose.lm[end];
        if ((a.visibility ?? 1) < 0.5 || (b.visibility ?? 1) < 0.5) continue;
        g.moveTo(X(a), Y(a));
        g.lineTo(X(b), Y(b));
      }
      g.stroke();
      g.restore();
    }

    if (face) {
      g.save();
      g.strokeStyle = 'rgba(253, 224, 71, 0.55)';
      g.shadowColor = '#fde047';
      g.shadowBlur = 8;
      g.lineWidth = 1.2;
      g.beginPath();
      for (const { start, end } of FACE_CONTOURS) {
        const a = face.lm[start];
        const b = face.lm[end];
        g.moveTo(X(a), Y(a));
        g.lineTo(X(b), Y(b));
      }
      g.stroke();
      g.restore();
    }

    hands.forEach((hand, i) => {
      if (!hand.present) return;
      const col = HAND_COLORS[i];
      // Hand landmarks are already in screen space (mirroring applied).
      const hx = (p) => p.x * w;
      const hy = (p) => p.y * h;

      if (showSkeleton && hand.lm) {
        g.save();
        g.strokeStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 14;
        g.lineWidth = 2.5;
        g.lineCap = 'round';
        g.globalAlpha = 0.9;
        g.beginPath();
        for (const { start, end } of HAND_CONNECTIONS) {
          g.moveTo(hx(hand.lm[start]), hy(hand.lm[start]));
          g.lineTo(hx(hand.lm[end]), hy(hand.lm[end]));
        }
        g.stroke();
        g.fillStyle = '#fff';
        for (const p of hand.lm) {
          g.beginPath();
          g.arc(hx(p), hy(p), 2.6, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }

      // Pinch ring: closes in as you pinch, spins while pinched.
      const cx = hand.screen.x * w;
      const cy = hand.screen.y * h;
      const r = hand.pinching ? 12 : 20;
      g.save();
      g.strokeStyle = hand.pinching ? color : col;
      g.shadowColor = hand.pinching ? color : col;
      g.shadowBlur = hand.pinching ? 22 : 10;
      g.lineWidth = hand.pinching ? 3.5 : 2;
      g.beginPath();
      if (hand.pinching) {
        for (let k = 0; k < 3; k++) {
          const a0 = t * 5 + (k * Math.PI * 2) / 3;
          g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
          g.arc(cx, cy, r, a0, a0 + 1.4);
        }
      } else {
        g.arc(cx, cy, r, 0, Math.PI * 2);
      }
      g.stroke();
      g.restore();

      // Hold-to-trigger gestures show a filling ring at the wrist.
      if (HOLD_ICONS[hand.gesture] && hand.gestureTime > 0.15 && hand.lm) {
        const k = Math.min(1, (hand.gestureTime - 0.15) / (holdTime - 0.15));
        const wx = hx(hand.lm[0]);
        const wy = hy(hand.lm[0]) - 10;
        g.save();
        g.lineWidth = 5;
        g.strokeStyle = 'rgba(255,255,255,0.15)';
        g.beginPath();
        g.arc(wx, wy, 26, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = col;
        g.shadowColor = col;
        g.shadowBlur = 16;
        g.beginPath();
        g.arc(wx, wy, 26, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
        g.stroke();
        g.fillStyle = '#fff';
        g.font = '600 13px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(HOLD_ICONS[hand.gesture], wx, wy + 46);
        g.restore();
      }
    });
  }
}
