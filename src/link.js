import Peer from 'peerjs';

// Phone → PC camera link over WebRTC. PeerJS' free public server is only used to
// introduce the two devices; video then flows directly between them.
// Override the signaling server with ?peerHost=host&peerPort=9000&peerPath=/ .

const PREFIX = 'handspace-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function peerOptions() {
  const p = new URLSearchParams(location.search);
  if (!p.get('peerHost')) return { debug: 1 };
  return {
    debug: 1,
    host: p.get('peerHost'),
    port: Number(p.get('peerPort') || 443),
    path: p.get('peerPath') || '/',
    secure: p.get('peerSecure') !== '0',
  };
}

export function makeCode() {
  let s = '';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  for (const r of rnd) s += ALPHABET[r % ALPHABET.length];
  return s;
}

export function normalizeCode(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

// Runs on the PC: waits for a phone to call in with its camera.
export class Receiver {
  constructor({ onStream, onMessage, onStatus }) {
    this.onStream = onStream;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this._open();
  }

  _open() {
    const { onStream, onMessage, onStatus } = this;
    this.code = makeCode();
    this.peer = new Peer(PREFIX + this.code, peerOptions());
    this.peer.on('open', () => onStatus('waiting'));
    this.peer.on('error', (err) => {
      // Another device already took this code: pick a new one.
      if (err.type === 'unavailable-id') {
        this.peer.destroy();
        this._open();
        return;
      }
      onStatus('error', err.message || String(err));
    });
    this.peer.on('disconnected', () => {
      if (!this.peer.destroyed) this.peer.reconnect();
    });
    this.peer.on('call', (call) => {
      this.call?.close();
      this.call = call;
      call.answer();
      call.on('stream', (stream) => {
        onStatus('connected');
        onStream(stream);
      });
      call.on('close', () => onStatus('lost'));
      call.on('error', () => onStatus('lost'));
    });
    this.peer.on('connection', (conn) => {
      this.conn = conn;
      conn.on('data', (msg) => onMessage(msg));
    });
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  joinUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    const keep = new URLSearchParams(location.search);
    for (const k of ['peerHost', 'peerPort', 'peerPath', 'peerSecure']) {
      if (keep.get(k)) url.searchParams.set(k, keep.get(k));
    }
    url.searchParams.set('join', this.code);
    return url.toString();
  }

  destroy() {
    this.call?.close();
    this.peer?.destroy();
  }
}

// Runs on the phone: sends its camera (and motion) to the PC with the given code.
export class Sender {
  constructor({ onStatus, onMessage = () => {} }) {
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.peer = new Peer(peerOptions());
    this.ready = new Promise((resolve, reject) => {
      this.peer.on('open', resolve);
      this.peer.on('error', (err) => {
        onStatus('error', err.type === 'peer-unavailable'
          ? 'No screen is waiting with that code.'
          : err.message || String(err));
        reject(err);
      });
    });
    this.ready.catch(() => {});
  }

  async connect(code, stream) {
    await this.ready;
    this.call?.close();
    this.conn?.close();
    const id = PREFIX + normalizeCode(code);
    this.onStatus('connecting');
    this.call = this.peer.call(id, stream);
    this.call.on('close', () => this.onStatus('lost'));
    this.conn = this.peer.connect(id, { reliable: false });
    this.conn.on('open', () => this.onStatus('connected'));
    this.conn.on('data', (msg) => this.onMessage(msg));
    this.conn.on('close', () => this.onStatus('lost'));
  }

  // Swap the camera track without reconnecting (e.g. front ↔ back camera).
  replaceStream(stream) {
    const track = stream.getVideoTracks()[0];
    const sender = this.call?.peerConnection?.getSenders().find((s) => s.track?.kind === 'video');
    sender?.replaceTrack(track);
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  destroy() {
    this.call?.close();
    this.conn?.close();
    this.peer?.destroy();
  }
}
