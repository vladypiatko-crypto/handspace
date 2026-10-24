import { HAND_CONNECTIONS, FACE_CONTOURS, POSE_CONNECTIONS } from './tracker.js';

// Draws the tracking results on a 2D canvas over the 3D view in a neon style.

const HAND_COLORS = ['#4fd1c5', '#f472b6'];
const HOLD_ICONS = { fist: '↶ undo', peace: '✌ next shape', open: '☰ menu' };
const ANCHOR_ICONS = { face: '🙂', hand: '✋', body: '🧍' };

// Neon line glow without canvas shadows (which are slow): a wide, faint
// stroke under a thin, bright one.
function glowStroke(g, color, width, alpha = 1) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = color;
  g.globalAlpha = alpha * 0.25;
  g.lineWidth = width * 3.5;
  g.stroke();
  g.globalAlpha = alpha;
  g.lineWidth = width;
  g.stroke();
  g.globalAlpha = 1;
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

    // Stick mode: what the camera recognizes, as labeled corner brackets.
    for (const a of anchors ?? []) {
      const x = a.box.x * w;
      const y = a.box.y * h;
      const bw = a.box.w * w;
      const bh = a.box.h * h;
      const k = Math.min(18, bw / 3, bh / 3);
      const c = a.stuck ? '#facc15' : '#ffffff';
      g.save();
      g.strokeStyle = c;
      g.shadowColor = c;
      g.shadowBlur = 10;
      g.lineWidth = 2.5;
      g.globalAlpha = 0.85;
      g.beginPath();
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1]]) {
        g.moveTo(cx + dx * k, cy);
        g.lineTo(cx, cy);
        g.lineTo(cx, cy + dy * k);
      }
      g.stroke();
      const label = `${ANCHOR_ICONS[a.label] ?? '📦'} ${a.label}${a.score ? ` ${Math.round(a.score * 100)}%` : ''}${a.stuck ? ` · 📌${a.stuck}` : ''}`;
      g.font = '600 12px system-ui, sans-serif';
      const tw = g.measureText(label).width + 12;
      g.shadowBlur = 0;
      g.globalAlpha = 0.75;
      g.fillStyle = '#07090d';
      g.fillRect(x, y - 20, tw, 18);
      g.globalAlpha = 1;
      g.fillStyle = c;
      g.fillText(label, x + 6, y - 7);
      g.restore();
    }

    // Eating: a ring around your mouth when something tasty is in range.
    if (mouth?.target) {
      const r = Math.max(18, mouth.r * w * 0.8) * (mouth.armed ? 1.25 + Math.sin(t * 20) * 0.08 : 1);
      g.save();
      g.strokeStyle = mouth.armed ? '#fb923c' : '#f472b6';
      g.shadowColor = g.strokeStyle;
      g.shadowBlur = 18;
      g.lineWidth = 3;
      g.setLineDash([6, 6]);
      g.lineDashOffset = -t * 30;
      g.beginPath();
      g.arc(mouth.x * w, mouth.y * h, r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#fff';
      g.font = '600 13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(mouth.armed ? 'now close! 😋' : 'open wide 😮', mouth.x * w, mouth.y * h + r + 18);
      g.restore();
    }

    if (pose) {
      g.save();
      g.beginPath();
      for (const { start, end } of POSE_CONNECTIONS) {
        const a = pose.lm[start];
        const b = pose.lm[end];
        if ((a.visibility ?? 1) < 0.5 || (b.visibility ?? 1) < 0.5) continue;
        g.moveTo(X(a), Y(a));
        g.lineTo(X(b), Y(b));
      }
      glowStroke(g, '#a78bfa', 3, 0.85);
      g.restore();
    }

    if (face) {
      g.save();
      g.beginPath();
      for (const { start, end } of FACE_CONTOURS) {
        const a = face.lm[start];
        const b = face.lm[end];
        g.moveTo(X(a), Y(a));
        g.lineTo(X(b), Y(b));
      }
      glowStroke(g, '#fde047', 1.2, 0.6);
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
        g.beginPath();
        for (const { start, end } of HAND_CONNECTIONS) {
          g.moveTo(hx(hand.lm[start]), hy(hand.lm[start]));
          g.lineTo(hx(hand.lm[end]), hy(hand.lm[end]));
        }
        glowStroke(g, col, 2.5, 0.9);
        g.fillStyle = '#fff';
        for (const p of hand.lm) {
          g.beginPath();
          g.arc(hx(p), hy(p), 2.6, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }

      // Pointing: a bright dot at the fingertip ("pen tip").
      if (hand.drawing || hand.gesture === 'point') {
        const tx = hand.tipScreen.x * w;
        const ty = hand.tipScreen.y * h;
        g.save();
        g.fillStyle = color;
        g.shadowColor = color;
        g.shadowBlur = hand.drawing ? 24 : 10;
        g.globalAlpha = hand.drawing ? 1 : 0.6;
        g.beginPath();
        g.arc(tx, ty, hand.drawing ? 7 : 5, 0, Math.PI * 2);
        g.fill();
        g.restore();
        return;
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
      const holdTime = holdTimes?.[hand.gesture];
      if (holdTime && !(hand.gesture === 'open' && menuOpen) && hand.gestureTime > 0.15 && hand.lm) {
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
