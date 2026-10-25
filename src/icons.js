// Line icons from Lucide (lucide.dev, ISC license), inlined at build time.
import create from 'lucide-static/icons/hand.svg?raw';
import paint from 'lucide-static/icons/paintbrush.svg?raw';
import erase from 'lucide-static/icons/eraser.svg?raw';
import undo from 'lucide-static/icons/undo-2.svg?raw';
import redo from 'lucide-static/icons/redo-2.svg?raw';
import menu from 'lucide-static/icons/settings-2.svg?raw';
import gravity from 'lucide-static/icons/apple.svg?raw';
import stick from 'lucide-static/icons/pin.svg?raw';
import board from 'lucide-static/icons/square-dashed.svg?raw';
import slime from 'lucide-static/icons/droplet.svg?raw';
import bar from 'lucide-static/icons/rectangle-horizontal.svg?raw';
import box from 'lucide-static/icons/box.svg?raw';
import sphere from 'lucide-static/icons/circle.svg?raw';
import cylinder from 'lucide-static/icons/cylinder.svg?raw';
import cone from 'lucide-static/icons/cone.svg?raw';
import torus from 'lucide-static/icons/torus.svg?raw';
import view from 'lucide-static/icons/rotate-3d.svg?raw';
import close from 'lucide-static/icons/x.svg?raw';
import color from 'lucide-static/icons/palette.svg?raw';
import flip from 'lucide-static/icons/switch-camera.svg?raw';
import phone from 'lucide-static/icons/smartphone.svg?raw';
import monitor from 'lucide-static/icons/monitor.svg?raw';
import camera from 'lucide-static/icons/video.svg?raw';
import arrow from 'lucide-static/icons/chevron-right.svg?raw';
import moon from 'lucide-static/icons/moon.svg?raw';
import shapes from 'lucide-static/icons/shapes.svg?raw';
import maximize from 'lucide-static/icons/maximize.svg?raw';
import minimize from 'lucide-static/icons/minimize.svg?raw';

const ICONS = {
  create, paint, erase, undo, redo, menu, gravity, stick, board, slime, bar, box, sphere, cylinder, cone,
  torus, view, close, color, flip, phone, monitor, camera, arrow, moon, shapes, maximize, minimize,
};

// SVG markup for an icon, sized in px and using the current text color.
export function icon(name, size = 20) {
  const svg = ICONS[name];
  if (!svg) return '';
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`)
    .replace('stroke-width="2"', 'stroke-width="1.75"')
    .replace('class="lucide', 'aria-hidden="true" class="icon lucide');
}

// Fills every element with a data-icon attribute (keeps any text after it).
export function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, +(el.dataset.iconSize || 20)));
  }
}
