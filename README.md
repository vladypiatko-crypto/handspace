# ✋ HandSpace

Draw and build in 3D with your hands. Point a camera at yourself: HandSpace tracks your hands (plus your face and body if you want), and you pinch and pull in the air to make glowing strokes and holographic shapes that stay where you put them.

It runs entirely in the browser on PCs, phones and tablets, with nothing to install.

## Features

- **Hand, face and body tracking** with Google's MediaPipe models (two hands, face expressions, body skeleton).
- **Draw in 3D.** Pinch (thumb and index finger) and move. Move your hand closer to or further from the camera to draw in depth.
- **Draw on objects.** Start a stroke on a shape and it sticks to the surface and moves with the shape.
- **Stretch shapes between your hands.** Pinch with both hands and pull apart to get a hatched bar, box, sphere, cylinder, cone or ring.
- **Grab, scale and rotate.** Grab with one hand to move, and with both hands to scale and rotate.
- **Paint and erase** objects by pinching them. To erase, pinch and sweep across things.
- **Hands-free controls.** Hold a fist to undo, and hold a ✌️ to switch tools.
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
| Pinch (thumb + index) | Draw, grab, paint or erase, depending on the tool |
| Pinch with both hands and pull apart | Stretch a new shape (Shape tool) |
| Grab with both hands | Scale and rotate an object |
| Hold a fist ✊ | Undo |
| Hold a peace sign ✌️ | Next tool |

Keyboard: `D` draw · `S` shape · `G` grab · `P` paint · `E` erase · `1`–`6` shapes · `Z`/`Y` undo/redo · `F` free view · `R` recenter · `M` menu.

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
| `src/hands.js` | Pinch detection, distance from camera (from palm size), smoothing (One Euro filter), gestures |
| `src/world.js` | three.js scene; the camera feed is the background and bloom makes the neon glow |
| `src/objects.js` | Holographic shapes, glowing strokes, save format |
| `src/tools.js` | Draw / shape / grab / paint / erase |
| `src/fx.js` | Sparks, shockwaves, fingertip orbs |
| `src/link.js` | Phone → PC WebRTC link (PeerJS) |
| `src/motion.js` | Gyroscope → camera rotation |

The virtual camera uses the same field of view as the real one, so 3D points line up with your fingers on screen. If strokes drift away from your fingertips, adjust **Camera field of view** in the menu.

### Limits

- Depth is estimated from how big your hand looks, so it is approximate.
- *Lock objects to the room* follows the camera's **rotation**, not its movement. Turning the phone works; walking around with it doesn't. Full positional tracking would need ARCore or ARKit.
