import { buildObject, disposeObject, exportableGroup, serialize } from './objects.js';

// Scene persistence: autosaves to the browser after every change, keeps undo
// history, and saves/opens files.

const KEY = 'handspace.scene.v1';
const MAX_UNDO = 80;

export class Store {
  constructor(content) {
    this.content = content;
    this.undoStack = [];
    this.redoStack = [];
    this.current = '[]';
    this.onChange = () => {};
  }

  snapshot() {
    // Previews (shapes still being stretched or framed) aren't saved.
    return JSON.stringify(this.content.children.filter((o) => o.userData.data && !o.userData.preview).map(serialize));
  }

  load() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
    if (saved) {
      try { this.restore(saved); } catch (err) { console.warn('Could not load saved scene', err); }
    }
    this.current = this.snapshot();
  }

  restore(json) {
    for (const o of [...this.content.children]) {
      o.removeFromParent();
      disposeObject(o);
    }
    for (const data of JSON.parse(json)) this.content.add(buildObject(data));
  }

  // Call after every finished change.
  commit() {
    const s = this.snapshot();
    if (s === this.current) return;
    this.undoStack.push(this.current);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.current = s;
    this._save();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop();
    this.restore(this.current);
    this._save();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop();
    this.restore(this.current);
    this._save();
    return true;
  }

  clear() {
    this.restore('[]');
    this.commit();
  }

  _save() {
    try { localStorage.setItem(KEY, this.current); } catch { /* storage full or blocked */ }
    this.onChange();
  }

  get count() {
    return this.content.children.length;
  }

  exportJson() {
    const blob = new Blob([JSON.stringify({ app: 'handspace', version: 1, objects: JSON.parse(this.current) }, null, 1)],
      { type: 'application/json' });
    return download(blob, `handspace-${stamp()}.json`);
  }

  async importJson(file) {
    const parsed = JSON.parse(await file.text());
    const objects = Array.isArray(parsed) ? parsed : parsed.objects;
    if (!Array.isArray(objects)) throw new Error('Not a HandSpace file');
    this.restore(JSON.stringify(objects));
    this.commit();
  }

  async exportGlb() {
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const group = exportableGroup(this.content);
    const glb = await new GLTFExporter().parseAsync(group, { binary: true });
    return download(new Blob([glb], { type: 'model/gltf-binary' }), `handspace-${stamp()}.glb`);
  }
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

async function download(blob, name) {
  // Inside the Android app, downloads go through the native side.
  if (window.HandSpaceNative) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const path = window.HandSpaceNative.saveFile(name, blob.type, btoa(bin));
    if (!path) throw new Error('could not save the file');
    return `Saved to ${path}`;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
