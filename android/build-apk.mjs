// Builds android/build/HandSpace.apk without Gradle or the Android SDK.
//
// Everything comes from Maven Central and the JDK:
//   - compile:  javac against Robolectric's android-all jar (the Android 14 framework)
//   - dex:      dalvik-dx (Jake Wharton's repackaged Android dx)
//   - manifest: encoded to Android's binary XML format below
//   - icon:     a one-entry resource table (resources.arsc) encoded below
//   - package:  a plain zip writer below
//   - sign:     APK Signature Scheme v2, implemented below with node:crypto
//
// Run: npm run apk
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cache = join(here, '.cache');
const build = join(here, 'build');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const APP_ID = 'com.handspace.app';
const ACTIVITY = `${APP_ID}.MainActivity`;
const VERSION_NAME = pkg.version;
const VERSION_CODE = (() => {
  const [a, b, c] = VERSION_NAME.split('.').map(Number);
  return a * 10000 + b * 100 + c;
})();
const MIN_SDK = 24; // Android 7.0
const TARGET_SDK = 34; // Android 14

const MAVEN = 'https://repo1.maven.org/maven2';
const DEPS = {
  'android-all-34.jar': `${MAVEN}/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar`,
  'dalvik-dx.jar': `${MAVEN}/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar`,
  'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

const log = (msg) => console.log(`[apk] ${msg}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// ------------------------------------------------------------------ 1. dependencies

async function fetchDeps() {
  mkdirSync(cache, { recursive: true });
  for (const [file, url] of Object.entries(DEPS)) {
    const dest = join(cache, file);
    if (existsSync(dest) && statSync(dest).size > 1000) continue;
    log(`downloading ${file}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

// ------------------------------------------------------------------ 2. web app

function buildWeb() {
  const www = join(build, 'www');
  log('building web app');
  run('node', [join(root, 'scripts/copy-wasm.mjs')]);
  run('npx', ['vite', 'build', '--outDir', www, '--emptyOutDir'], { cwd: root, env: { ...process.env, HTTP: '1' } });
  // MediaPipe only loads the classic (non-module) wasm builds.
  for (const f of readdirSync(join(www, 'mediapipe/wasm'))) {
    if (f.includes('module')) rmSync(join(www, 'mediapipe/wasm', f));
  }
  // Bundle the hand model so tracking starts fast and works offline.
  mkdirSync(join(www, 'models'), { recursive: true });
  cpSync(join(cache, 'hand_landmarker.task'), join(www, 'models/hand_landmarker.task'));
  return www;
}

// ------------------------------------------------------------------ 3. code

function buildDex() {
  const classes = join(build, 'classes');
  rmSync(classes, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  const sources = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.java')) sources.push(p);
    }
  };
  walk(join(here, 'src'));
  log('compiling Java');
  run('javac', ['-nowarn', '--release', '8', '-cp', join(cache, 'android-all-34.jar'), '-d', classes, ...sources]);
  log('converting to dex');
  const dex = join(build, 'classes.dex');
  run('java', ['-cp', join(cache, 'dalvik-dx.jar'), 'com.android.dx.command.Main', '--dex',
    `--min-sdk-version=${MIN_SDK}`, `--output=${dex}`, classes]);
  return readFileSync(dex);
}

// ------------------------------------------------------------------ 4. binary manifest

// Resource IDs of android:* attributes (from android.R.attr).
const ATTR = {
  theme: 16842752, label: 16842753, icon: 16842754, name: 16842755, exported: 16842768,
  configChanges: 16842783, minSdkVersion: 16843276, versionCode: 16843291, versionName: 16843292,
  targetSdkVersion: 16843376, allowBackup: 16843392, required: 16843406, hardwareAccelerated: 16843475,
};
const THEME_FULLSCREEN = 16974122; // android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen
const ICON_ID = 0x7f010000; // our package 0x7f, type 1 (drawable), entry 0
const ICON_PATH = 'res/drawable-xxxhdpi-v4/icon.png';
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

const str = (v) => ({ type: 0x03, v });
const int = (v) => ({ type: 0x10, v });
const hex = (v) => ({ type: 0x11, v });
const bool = (v) => ({ type: 0x12, v: v ? 0xffffffff : 0 });
const ref = (v) => ({ type: 0x01, v });

const el = (name, attrs = {}, children = []) => ({ name, attrs, children });

function manifestTree() {
  return el('manifest', { package: str(APP_ID), 'android:versionCode': int(VERSION_CODE), 'android:versionName': str(VERSION_NAME) }, [
    el('uses-sdk', { 'android:minSdkVersion': int(MIN_SDK), 'android:targetSdkVersion': int(TARGET_SDK) }),
    el('uses-permission', { 'android:name': str('android.permission.CAMERA') }),
    el('uses-permission', { 'android:name': str('android.permission.INTERNET') }),
    el('uses-permission', { 'android:name': str('android.permission.ACCESS_NETWORK_STATE') }),
    el('uses-feature', { 'android:name': str('android.hardware.camera.any'), 'android:required': bool(false) }),
    el('application', {
      'android:label': str('HandSpace'),
      'android:icon': ref(ICON_ID),
      'android:theme': ref(THEME_FULLSCREEN),
      'android:allowBackup': bool(true),
      'android:hardwareAccelerated': bool(true),
    }, [
      el('activity', {
        'android:name': str(ACTIVITY),
        'android:exported': bool(true),
        // orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|screenLayout|uiMode|navigation:
        // rotate without restarting the page (and the camera).
        'android:configChanges': hex(0x0ff0),
      }, [
        el('intent-filter', {}, [
          el('action', { 'android:name': str('android.intent.action.MAIN') }),
          el('category', { 'android:name': str('android.intent.category.LAUNCHER') }),
        ]),
      ]),
    ]),
  ]);
}

function chunk(type, headerSize, body) {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(type, 0);
  h.writeUInt16LE(headerSize, 2);
  h.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([h, body]);
}

// A UTF-16 string pool chunk, shared by binary XML and resource tables.
function stringPool(strings) {
  const encoded = strings.map((s) => {
    const b = Buffer.alloc(2 + s.length * 2 + 2);
    b.writeUInt16LE(s.length, 0);
    for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), 2 + i * 2);
    return b;
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let off = 0;
  encoded.forEach((b, i) => { offsets.writeUInt32LE(off, i * 4); off += b.length; });
  let data = Buffer.concat(encoded);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(0, 4); // styles
  header.writeUInt32LE(0, 8); // flags: UTF-16
  header.writeUInt32LE(28 + offsets.length, 12); // stringsStart
  header.writeUInt32LE(0, 16); // stylesStart
  return chunk(0x0001, 28, Buffer.concat([header, offsets, data]));
}

// Resource table with a single drawable (the launcher icon) for xxxhdpi screens.
// Android scales it for other densities.
function encodeArsc() {
  const values = stringPool([ICON_PATH]);
  const typeStrings = stringPool(['drawable']);
  const keyStrings = stringPool(['icon']);

  const spec = Buffer.alloc(8 + 4);
  spec.writeUInt8(1, 0); // type id
  spec.writeUInt32LE(1, 4); // entry count
  spec.writeUInt32LE(0, 8); // entry 0 config-change flags
  const typeSpec = chunk(0x0202, 16, spec);

  const CONFIG_SIZE = 64;
  const config = Buffer.alloc(CONFIG_SIZE);
  config.writeUInt32LE(CONFIG_SIZE, 0);
  config.writeUInt16LE(640, 14); // density: xxxhdpi
  config.writeUInt16LE(4, 24); // sdkVersion (the -v4 qualifier)
  const entry = Buffer.alloc(16);
  entry.writeUInt16LE(8, 0); // ResTable_entry size
  entry.writeUInt16LE(0, 2); // flags
  entry.writeUInt32LE(0, 4); // key: "icon"
  entry.writeUInt16LE(8, 8); // Res_value size
  entry.writeUInt8(0x03, 11); // TYPE_STRING
  entry.writeUInt32LE(0, 12); // value: ICON_PATH in the global pool
  const typeHeaderSize = 20 + CONFIG_SIZE;
  const typeHead = Buffer.alloc(12);
  typeHead.writeUInt8(1, 0); // type id
  typeHead.writeUInt32LE(1, 4); // entry count
  typeHead.writeUInt32LE(typeHeaderSize + 4, 8); // entriesStart
  const type = chunk(0x0201, typeHeaderSize, Buffer.concat([typeHead, config, u32(0), entry]));

  const PKG_HEADER = 288;
  const pkgHead = Buffer.alloc(PKG_HEADER - 8);
  pkgHead.writeUInt32LE(0x7f, 0);
  for (let i = 0; i < APP_ID.length; i++) pkgHead.writeUInt16LE(APP_ID.charCodeAt(i), 4 + i * 2);
  pkgHead.writeUInt32LE(PKG_HEADER, 260); // typeStrings offset
  pkgHead.writeUInt32LE(1, 264); // lastPublicType
  pkgHead.writeUInt32LE(PKG_HEADER + typeStrings.length, 268); // keyStrings offset
  pkgHead.writeUInt32LE(1, 272); // lastPublicKey
  pkgHead.writeUInt32LE(0, 276); // typeIdOffset
  const pkgChunk = chunk(0x0200, PKG_HEADER, Buffer.concat([pkgHead, typeStrings, keyStrings, typeSpec, type]));

  return chunk(0x0002, 12, Buffer.concat([u32(1), values, pkgChunk]));
}

// Android's compiled XML (what aapt produces): a string pool, a map from
// attribute names to resource IDs, then start/end element events.
function encodeAxml(tree) {
  // Attribute names with resource IDs must come first in the string pool,
  // in the same order as the resource map.
  const attrNames = [];
  const walk = (n) => {
    for (const k of Object.keys(n.attrs)) {
      const local = k.replace('android:', '');
      if (k.startsWith('android:') && !attrNames.includes(local)) attrNames.push(local);
    }
    n.children.forEach(walk);
  };
  walk(tree);
  attrNames.sort((a, b) => ATTR[a] - ATTR[b]);
  for (const a of attrNames) if (!ATTR[a]) throw new Error(`unknown attribute id: ${a}`);

  const strings = [...attrNames];
  const idx = (s) => {
    let i = strings.indexOf(s);
    if (i < 0) { i = strings.length; strings.push(s); }
    return i;
  };
  idx('android');
  idx(ANDROID_NS);

  // Encode events first (they add strings), then prepend the pool.
  const events = [];
  let line = 1;
  const node = (type, extra) => {
    const b = Buffer.alloc(8 + extra.length);
    b.writeUInt32LE(line++, 0);
    b.writeUInt32LE(0xffffffff, 4); // no comment
    extra.copy(b, 8);
    return chunk(type, 16, b);
  };
  const nsBody = () => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(idx('android'), 0);
    b.writeUInt32LE(idx(ANDROID_NS), 4);
    return b;
  };
  events.push(node(0x0100, nsBody()));

  const emit = (n) => {
    const attrs = Object.entries(n.attrs).map(([k, val]) => {
      const isAndroid = k.startsWith('android:');
      const local = isAndroid ? k.slice(8) : k;
      return { ns: isAndroid ? idx(ANDROID_NS) : 0xffffffff, name: idx(local), id: isAndroid ? ATTR[local] : 0, val };
    });
    // Attributes with resource IDs sorted by ID, then the rest (as aapt does).
    attrs.sort((a, b) => (a.id && b.id ? a.id - b.id : a.id ? -1 : b.id ? 1 : 0));
    const b = Buffer.alloc(20 + attrs.length * 20);
    b.writeUInt32LE(0xffffffff, 0); // element namespace: none
    b.writeUInt32LE(idx(n.name), 4);
    b.writeUInt16LE(20, 8); // attributeStart
    b.writeUInt16LE(20, 10); // attributeSize
    b.writeUInt16LE(attrs.length, 12);
    b.writeUInt16LE(0, 14); // idIndex
    b.writeUInt16LE(0, 16); // classIndex
    b.writeUInt16LE(0, 18); // styleIndex
    attrs.forEach((a, i) => {
      const o = 20 + i * 20;
      const isStr = a.val.type === 0x03;
      const sIdx = isStr ? idx(a.val.v) : 0;
      b.writeUInt32LE(a.ns, o);
      b.writeUInt32LE(a.name, o + 4);
      b.writeUInt32LE(isStr ? sIdx : 0xffffffff, o + 8); // raw value
      b.writeUInt16LE(8, o + 12); // Res_value size
      b.writeUInt8(0, o + 14);
      b.writeUInt8(a.val.type, o + 15);
      b.writeUInt32LE(isStr ? sIdx : a.val.v >>> 0, o + 16);
    });
    events.push(node(0x0102, b));
    n.children.forEach(emit);
    const e = Buffer.alloc(8);
    e.writeUInt32LE(0xffffffff, 0);
    e.writeUInt32LE(idx(n.name), 4);
    events.push(node(0x0103, e));
  };
  emit(tree);
  events.push(node(0x0101, nsBody()));

  const pool = stringPool(strings);
  const ids = Buffer.alloc(attrNames.length * 4);
  attrNames.forEach((a, i) => ids.writeUInt32LE(ATTR[a], i * 4));
  const resMap = chunk(0x0180, 8, ids);

  return chunk(0x0003, 8, Buffer.concat([pool, resMap, ...events]));
}

// ------------------------------------------------------------------ 5. zip

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, stored } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = stored ? null : deflateRawSync(data, { level: 9 });
    const store = stored || deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = crc32(data);
    // Stored entries are padded (via the extra field) so their data starts on a
    // 4-byte boundary; Android requires this for resources.arsc.
    const pad = store ? (4 - ((offset + 30 + nameBuf.length) % 4)) % 4 : 0;
    const local = Buffer.alloc(30 + pad);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(pad, 28);
    locals.push(local.subarray(0, 30), nameBuf, local.subarray(30), body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + pad + body.length;
  }
  const entriesBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(entriesBuf.length, 16);
  return { entriesBuf, cdBuf, eocd };
}

// ------------------------------------------------------------------ 6. APK Signature Scheme v2

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const lp = (b) => Buffer.concat([u32(b.length), b]); // uint32 length-prefixed
const RSA_PKCS1_SHA256 = 0x0103;

// Each section is split into 1 MiB chunks, each chunk hashed with a 0xa5
// prefix, then the chunk hashes are hashed together with a 0x5a prefix.
function contentDigest(sections) {
  const chunks = [];
  for (const s of sections) {
    for (let i = 0; i < s.length; i += 1 << 20) {
      const c = s.subarray(i, Math.min(i + (1 << 20), s.length));
      chunks.push(createHash('sha256').update(Buffer.from([0xa5])).update(u32(c.length)).update(c).digest());
    }
  }
  return createHash('sha256').update(Buffer.from([0x5a])).update(u32(chunks.length)).update(Buffer.concat(chunks)).digest();
}

function signV2({ entriesBuf, cdBuf, eocd }, keyPem, certPem) {
  const key = createPrivateKey(keyPem);
  const cert = new X509Certificate(certPem);
  const digest = contentDigest([entriesBuf, cdBuf, eocd]);

  const signedData = Buffer.concat([
    lp(lp(Buffer.concat([u32(RSA_PKCS1_SHA256), lp(digest)]))), // digests
    lp(lp(cert.raw)), // certificates
    lp(Buffer.alloc(0)), // additional attributes
  ]);
  const signature = sign('sha256', signedData, key);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const signer = Buffer.concat([
    lp(signedData),
    lp(lp(Buffer.concat([u32(RSA_PKCS1_SHA256), lp(signature)]))),
    lp(publicKey),
  ]);
  const v2Value = lp(lp(signer));

  const pair = Buffer.concat([u64(4 + v2Value.length), u32(0x7109871a), v2Value]);
  const blockSize = pair.length + 8 + 16;
  const block = Buffer.concat([u64(blockSize), pair, u64(blockSize), Buffer.from('APK Sig Block 42', 'ascii')]);

  const newEocd = Buffer.from(eocd);
  newEocd.writeUInt32LE(entriesBuf.length + block.length, 16); // central directory moved past the block
  return Buffer.concat([entriesBuf, block, cdBuf, newEocd]);
}

// ------------------------------------------------------------------ main

await fetchDeps();
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

const www = buildWeb();
const dex = buildDex();

const entries = [
  { name: 'AndroidManifest.xml', data: encodeAxml(manifestTree()) },
  { name: 'classes.dex', data: dex },
  { name: 'resources.arsc', data: encodeArsc(), stored: true },
  { name: ICON_PATH, data: readFileSync(join(here, 'res/icon.png')), stored: true },
];
const addDir = (dir) => {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) addDir(p);
    else entries.push({ name: `assets/www/${relative(www, p).split('\\').join('/')}`, data: readFileSync(p) });
  }
};
addDir(www);

log('packaging and signing');
const signing = join(here, 'signing');
if (!existsSync(join(signing, 'debug-key.pem'))) {
  log('creating a debug signing key');
  mkdirSync(signing, { recursive: true });
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '10950',
    '-keyout', join(signing, 'debug-key.pem'), '-out', join(signing, 'debug-cert.pem'),
    '-subj', '/CN=HandSpace Debug/O=HandSpace'], { stdio: 'ignore' });
}
const apk = signV2(zip(entries), readFileSync(join(signing, 'debug-key.pem')), readFileSync(join(signing, 'debug-cert.pem')));
const out = join(build, 'HandSpace.apk');
writeFileSync(out, apk);
writeFileSync(join(build, 'AndroidManifest.bin'), entries[0].data);
log(`done: ${relative(root, out)} (${(apk.length / 1048576).toFixed(1)} MB, v${VERSION_NAME}, code ${VERSION_CODE})`);
