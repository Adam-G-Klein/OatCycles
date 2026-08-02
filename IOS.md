# Running OatCycles as a sideloaded iOS app

OatCycles is a static web app (Vite + Strudel, all client-side). To run it on an
iPhone we wrap the built web bundle in a native shell with
[Capacitor](https://capacitorjs.com), which hosts it in a `WKWebView`. The bundle
is **shipped inside the app and served from a local `oatcycles://` scheme**, so
the app boots and plays fully offline — no dev server, no network.

Everything below runs on a **Mac with Xcode installed**. The repo already carries
the Capacitor dependencies, `capacitor.config.json`, and the npm scripts; you only
generate the native `ios/` project (which is git-ignored — it's a build artifact).

## One-time setup

```sh
npm install          # pulls in @capacitor/core, @capacitor/ios, @capacitor/cli
npm run build        # produces dist/ (the offline web bundle)
npm run ios:add      # generates the native ios/ Xcode project (runs `cap add ios`)
```

`ios:add` runs CocoaPods (`pod install`). If you don't have it:
`sudo gem install cocoapods` (or `brew install cocoapods`).

## Build & open in Xcode

```sh
npm run ios          # build + cap sync ios + cap open ios
```

`npm run ios` rebuilds `dist/`, copies it into the native project, and opens the
workspace in Xcode. Run it any time you change the web code. (`npm run ios:sync`
does the build+copy without opening Xcode.)

## Sideloading to your phone

In Xcode:

1. Select the **App** target → **Signing & Capabilities**.
2. Set **Team** to your Apple ID (add it under Xcode → Settings → Accounts if
   needed). A free Apple ID works.
3. If the bundle id `cc.oatcycles.app` is taken, change it to something unique
   (e.g. `com.yourname.oatcycles`). Match it in `capacitor.config.json`'s `appId`
   if you want them consistent.
4. Plug in your iPhone, pick it as the run destination, press **▶ Run**.
5. On the phone, trust the developer profile:
   **Settings → General → VPN & Device Management → (your Apple ID) → Trust**.

**Signing lifetime:** a *free* Apple ID signs apps that expire after **7 days**
(re-run from Xcode to refresh) and caps you at 3 sideloaded apps. A paid Apple
Developer account ($99/yr) gives 1-year signing.

## Feature notes on iOS WebKit

The engine and editor work as-is. Two platform caveats:

- **MIDI keyboard input does not work.** The Web MIDI API doesn't exist in
  WebKit/iOS (even Chrome-for-iOS is WebKit under the hood). The Enable-MIDI
  control is hidden automatically when Web MIDI is unavailable, so it won't error
  — it just isn't offered. Hardware MIDI would need a native CoreMIDI bridge.
- **Voice → code (microphone)** works in `WKWebView`, but iOS requires a usage
  string. After `ios:add`, add this to `ios/App/App/Info.plist`:

  ```xml
  <key>NSMicrophoneUsageDescription</key>
  <string>OatCycles listens to your singing to transcribe melodies into code.</string>
  ```

  (Re-running `ios:add` regenerates the project, so keep this note handy — or add
  the key via Xcode's Info tab, which persists in the generated project until you
  delete `ios/`.)

## What needs a network (and what doesn't)

- **Offline:** the editor, Vim mode, the built-in synth waveforms (the default
  pattern), voice transcription, and song persistence (localStorage) all run with
  no connection.
- **Needs a connection:** the extra sample banks and General MIDI soundfonts are
  lazily fetched from GitHub the first time a sample-based sound plays, and
  Multiplayer (WebRTC) needs the internet to reach peers. None of these block the
  app from starting or playing synth patterns offline.
