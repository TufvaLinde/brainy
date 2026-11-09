# Brainy for iPhone

A native shell around the deployed web app. It adds the two things a web page can't do reliably offline:

- **Apple's on-device model** (Foundation Models, iOS 26) turns what you say into Brainy's labels: minutes, energy, mood, setting, vibes, topics, things to avoid. It fills them in as a typed form.
- **On-device speech recognition**, so the mic works in airplane mode.

Everything else is the web app: the globe, ranking, learning and sync. It's kept offline by a service worker, which the web view may run because Brainy's domain is listed as "app-bound" in `Info.plist`.

## Needs

- Xcode 26 (App Store) on this Mac
- An iPhone or iPad with Apple Intelligence (iPhone 15 Pro or later, including iPhone Air) on iOS 26
- A free Apple ID. No paid developer account and no TestFlight. Free installs expire after 7 days; press Run again to renew.
- The web app deployed over HTTPS (Vercel)

## Install on your iPhone

1. **Point the app at the web app.** In `ios/Config.xcconfig`, set `BRAINY_HOST` to the deployed host, without `https://`. Set `BUNDLE_ID` to something unique, for example `com.yourname.brainy`. Then run `cd ios && xcodegen generate`.
2. **Open the project.** Run `open ios/Brainy.xcodeproj`.
3. **Sign it.** Go to Xcode → Settings → Accounts, add your Apple ID, then close Settings. Click the Brainy project, then the **Brainy** target → **Signing & Capabilities**. Tick *Automatically manage signing* and choose **Team: (your name) (Personal Team)**.
4. **Prepare the phone.**
   - Connect it by cable, unlock it and tap **Trust**.
   - On the phone, open **Settings → Privacy & Security → Developer Mode**, turn it on, and let it restart. The option only appears after the phone has been connected to Xcode once.
   - In **Settings → Apple Intelligence & Siri**, turn on Apple Intelligence and wait until its model has downloaded.
5. **Run.** In Xcode's toolbar, pick your iPhone as the destination and press **⌘R**.
   - On first launch, iOS may say the developer isn't trusted. Open **Settings → General → VPN & Device Management**, tap your Apple ID, then **Trust**, and launch again.
6. **First open, online.** Enter the passcode if you set one. Let the globe load, and open a couple of pieces so they're kept offline.
7. **Airplane mode test.** Turn on airplane mode, force-quit Brainy and open it again. Tap the mic and say *"Long day, I'm tired, 15 minutes on the train, no headphones"*. You should get a pick with the time and vibe set in black on the card.

## Seeing what happens inside

On the iPhone, open Settings → Apps → Safari → Advanced and turn on **Web Inspector**. On the Mac, open Safari → Settings → Advanced and turn on **Show features for web developers**. Then use Safari's **Develop** menu → your iPhone → Brainy. You get the console, the network panel and the IndexedDB stores (`catalog`, `outbox`, `kv`).

In the console, try:

```js
await brainyNative.call("status")
// { llm: "available", speech: "on-device", app: "ios" }
await brainyNative.call("intent", { text: "wiped out, 20 min on the metro, something visual", topics: [] })
```

## When something's wrong

| You see | Why | Fix |
|---|---|---|
| Blank white screen | `BRAINY_HOST` is wrong, or the site isn't deployed | Check the host in Safari on the phone first |
| "Apple's model is unavailable: turn on Apple Intelligence" | Apple Intelligence is off, or its model is still downloading | Settings → Apple Intelligence & Siri |
| Mic says to allow it in Settings | Permission denied at the first prompt | Settings → Apps → Brainy → Microphone and Speech Recognition |
| Opens online but blank in airplane mode | The first visit didn't finish caching | Open it once online and wait 10 seconds, then try again |
| App won't open after a week | The free signing expired | Connect the phone and press ⌘R again |
