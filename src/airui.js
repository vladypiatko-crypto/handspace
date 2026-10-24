// Hands-free control of the page:
//  - pinch over any button (toolbar, menus, settings) to press it;
//    pinch a slider and move to drag it
//  - hold an open palm up, facing the camera, to open a ring menu around it

const PRESSABLE = 'button, label.check, input[type="range"], summary';
const MENU_HOLD = 1.0; // seconds of a still, open palm to open the menu
const MENU_IDLE = 6; // seconds before an unused menu closes itself

export class AirUI {
  constructor({ stage, menu, items }) {
    this.stage = stage;
    this.menu = menu;
    this.items = items; // [{ id, icon, label: string | () => string, run, keep }]
    this.hovered = new Set();
    this.open = false;
    this.idle = 0;
    this.buildMenu();
  }

  get holdTime() { return MENU_HOLD; }

  buildMenu() {
    this.menu.innerHTML = '';
    const center = document.createElement('div');
    center.className = 'palm-center';
    this.menu.append(center);
    this.center = center;
    this.buttons = this.items.map((item, i) => {
      const b = document.createElement('button');
      b.className = 'palm-item';
      b.dataset.id = item.id;
      b.style.setProperty('--a', `${(i / this.items.length) * 360 - 90}deg`);
      b.onclick = () => {
        item.run();
        this.idle = 0;
        if (item.keep) this.refresh();
        else this.close();
      };
      this.menu.append(b);
      return b;
    });
  }

  refresh() {
    this.items.forEach((item, i) => {
      const label = typeof item.label === 'function' ? item.label() : item.label;
      const icon = typeof item.icon === 'function' ? item.icon() : item.icon;
      this.buttons[i].innerHTML = `<span class="i">${icon}</span><span class="l">${label}</span>`;
      this.buttons[i].classList.toggle('active', !!item.active?.());
    });
    this.center.textContent = 'Pinch an item';
  }

  openAt(x, y) {
    const r = Math.min(140, innerWidth * 0.3, innerHeight * 0.3);
    this.menu.style.setProperty('--r', `${r}px`);
    const m = r + 50;
    this.menu.style.left = `${Math.min(Math.max(x, m), innerWidth - m)}px`;
    this.menu.style.top = `${Math.min(Math.max(y, m), innerHeight - m)}px`;
    this.refresh();
    this.menu.classList.remove('hidden');
    this.open = true;
    this.idle = 0;
  }

  close() {
    this.menu.classList.add('hidden');
    this.open = false;
  }

  toClient(p) {
    const r = this.stage.getBoundingClientRect();
    return { x: r.left + p.x * r.width, y: r.top + p.y * r.height };
  }

  target(p) {
    const { x, y } = this.toClient(p);
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const el = document.elementFromPoint(x, y);
    const t = el?.closest(PRESSABLE);
    return t && !t.closest('#stage') ? t : null;
  }

  // hands: Hand[] from the camera (not the mouse). Call before the tools run:
  // a pinch that presses a button is marked `captured` so it doesn't also
  // grab or draw in 3D.
  update(hands, dt) {
    const hovered = new Set();
    for (const h of hands) {
      if (!h.present || !h.lm) { h.slider = null; continue; }
      const el = this.target(h.screen);
      if (el) hovered.add(el);

      if (h.started && el) {
        h.captured = true;
        if (el.matches('input[type="range"]')) h.slider = el;
        else this.press(el);
      }
      if (h.drawStarted && this.target(h.tipScreen)) h.captured = true; // don't draw behind buttons
      if (h.slider && h.pinching) {
        const r = h.slider.getBoundingClientRect();
        const k = Math.min(1, Math.max(0, (this.toClient(h.screen).x - r.left) / r.width));
        const min = +h.slider.min || 0;
        const max = +h.slider.max || 100;
        h.slider.value = min + k * (max - min);
        h.slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (!h.pinching) h.slider = null;

      this.palmMenu(h);
    }
    for (const el of this.hovered) if (!hovered.has(el)) el.classList.remove('air-hover');
    for (const el of hovered) el.classList.add('air-hover');
    this.hovered = hovered;

    if (this.open) {
      this.idle = hovered.size ? 0 : this.idle + dt;
      if (this.idle > MENU_IDLE || !hands.some((h) => h.present)) this.close();
    }
  }

  // Open palm, fingers up, facing the camera and held still → menu.
  palmMenu(h) {
    const lm = h.lm;
    const prev = h.palmPrev ?? h.palmScreen;
    const moved = Math.hypot(h.palmScreen.x - prev.x, h.palmScreen.y - prev.y);
    h.palmPrev = { ...h.palmScreen };
    if (h.gesture !== 'open') { h.menuFired = false; return; }
    const upright = lm[0].y - lm[9].y > 0.05;
    const faceOn = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y) > Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) * 0.45;
    // Moving or turned hands restart the hold (the overlay shows its progress).
    if (moved > 0.012 || !upright || !faceOn || this.open) h.gestureTime = 0;
    if (!h.menuFired && h.gestureTime >= MENU_HOLD) {
      h.menuFired = true;
      const { x, y } = this.toClient(h.palmScreen);
      this.openAt(x, y);
    }
  }

  press(el) {
    el.click();
    el.classList.add('air-press');
    setTimeout(() => el.classList.remove('air-press'), 220);
  }
}
