# ✋ HandSpace

Draw and build in 3D with your hands. Point a camera at yourself and HandSpace tracks your hands (plus your face and body if you want). Point to draw glowing lines in the air, pinch things to move them anywhere, and pinch with both hands and pull apart to create holographic shapes. Everything stays where you put it.

It runs entirely in the browser on PCs, phones and tablets, with nothing to install.

## Features

- **Hand, face and body tracking** with Google's MediaPipe models (two hands, face expressions, body skeleton).
- **☝️ Point to draw in 3D.** Move your hand closer to or further from the camera to draw in depth.
- **Draw on objects.** Point at a shape and touch it; the drawing sticks to the surface and moves with the shape.
- **🤏 Pinch to move.** Pinch any object to grab it and place it anywhere. Pinch it with both hands to scale and rotate it.
- **🤏🤏 Pinch both hands and pull apart** in empty space to stretch a hatched bar, box, sphere, cylinder, cone or ring.
- **Paint and Erase modes** recolor or remove whatever you pinch or point at. To erase, sweep across things.
- **Hands-free controls.** Hold a fist to undo, and hold a ✌️ to switch to the next shape.
- **Objects stay in place.** On a phone or tablet, turn on *Lock objects to the room*. The gyroscope keeps your creations fixed in the room while you turn the camera away and back.
- **Phone as camera, PC as screen.** The phone streams its camera live to the PC over a direct WebRTC link. The PC does the tracking and shows everything.
- **Autosave** in the browser, with undo/redo, save/open `.json` files, and export to `.glb` for Blender, Unity and other 3D apps.
- **Free 3D view** lets you orbit around your creations with the mouse or touch.
- **Mouse or touch as a hand** for when there's no camera. Scroll to change depth, and click-drag to stretch shapes.

## Use it

### This device's camera
Open the app and choose **Use this device's camera**.

### Phone → PC (the phone is just the camera)
1. On the **PC**, choose **Use my phone as the camera**. It shows a 6-letter code and a QR code.
2. On the **phone**, scan the QR code, or open the app and choose **Send this camera to another screen** and type the code.
3. Tap **Connect**. The phone's camera now shows up live on the PC. Use **Dim screen** on the phone to save battery.

Both devices must be able to open the app over **HTTPS**, for example from the GitHub Pages site. The free [PeerJS](https://peerjs.com) server only introduces the two devices to each other. After that, video goes directly between them. Devices on the same Wi-Fi work best. Some strict networks block direct connections; if that happens, try both devices on the same Wi-Fi.

## Gestures

| Gesture | Does |
|---|---|
| ☝️ Point with your index finger | Draw (touch an object to draw on it) |
| 🤏 Pinch an object | Grab it and move it |
| Pinch an object with both hands | Scale and rotate it |
| 🤏🤏 Pinch both hands in empty space and pull apart | Stretch a new shape |
| Hold a fist ✊ | Undo |
| Hold a peace sign ✌️ | Next shape |

Mouse/touch (menu → "Mouse/touch acts as a hand"): drag to draw, drag an object to move it, Shift-drag or right-drag for a shape, Alt-drag to draw on an object, scroll for depth.

Keyboard: `C` create · `P` paint · `E` erase · `1`–`6` shapes · `Z`/`Y` undo/redo · `F` free view · `R` recenter · `M` menu.

## Android app (APK)

`npm run apk` builds `android/build/HandSpace.apk`: the same app in a fullscreen Android wrapper, with the hand model bundled so tracking works offline. To install it, copy the APK to your phone, open it, and allow installing from that source when Android asks. It needs Android 7 or newer.

The build doesn't use Gradle or the Android SDK. `android/build-apk.mjs` compiles `android/src` against the Android framework jar from Maven Central, converts it with `dx`, encodes the manifest and icon, then zips and signs the APK (APK Signature Scheme v2). It only needs Node and a JDK.

`android/signing/` holds a **debug** signing key, committed so every build can update the installed app in place. Don't use it for a store release.

## Develop

```bash
npm install
npm run dev      # https://localhost:5173 (and your network IP, for phones)
npm test         # hand-tracking math checks
npm run build    # static site in dist/
```

The dev server uses a self-signed certificate, because phones only allow camera access on HTTPS. Your phone will warn about it the first time; accept the warning to continue.

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`. To turn it on, go to **Settings → Pages → Source: GitHub Actions**.

### How it works

| File | Role |
|---|---|
| `src/tracker.js` | MediaPipe hand / face / pose landmarkers |
| `src/hands.js` | Pinch / point detection, distance from camera (from palm size), smoothing (One Euro filter), gestures |
| `src/world.js` | three.js scene; the camera feed is the background and bloom makes the neon glow |
| `src/objects.js` | Holographic shapes, glowing strokes, save format |
| `src/tools.js` | Create (point = draw, pinch = move, two-hand pinch = shape), paint, erase |
| `src/fx.js` | Sparks, shockwaves, fingertip orbs |
| `src/link.js` | Phone → PC WebRTC link (PeerJS) |
| `src/motion.js` | Gyroscope → camera rotation |
| `android/` | Android wrapper (`MainActivity.java`) and the APK build script |

The virtual camera uses the same field of view as the real one, so 3D points line up with your fingers on screen. If strokes drift away from your fingertips, adjust **Camera field of view** in the menu.

### Limits

- Depth is estimated from how big your hand looks, so it is approximate.
- *Lock objects to the room* follows the camera's **rotation**, not its movement. Turning the phone works; walking around with it doesn't. Full positional tracking would need ARCore or ARKit.
