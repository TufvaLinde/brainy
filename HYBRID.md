# Brainy: a hybrid reading agent

Tell it how you feel and how long you have. It picks something from your library, on your phone, offline.

## What runs where

| On the device (iPhone, iPad) | In the cloud |
| --- | --- |
| **Llama 3.2 1B** via WebLLM on WebGPU turns what you say into parameters: minutes, energy, mood, setting, vibe, topics, things to avoid | **Claude** reads every item whole and labels it: topics, vibes, attention demand, thinking styles, the moments it suits |
| Rules catch what must be exact: "forgot my headphones" means no audio, "on the metro" means about 20 minutes | Redraws your interest sphere from every device's events: clusters, where each item sits, and inferences by mood and moment |
| Ranks picks on the device, and learns from each choice instantly by mood, setting and time of day | Turns many small choices into durable conclusions ("tired: visual over analytical") |
| Keeps the catalogue, readings, outbox and profile in IndexedDB; a service worker keeps the app itself | Keeps the event log and profile in Postgres, in its own `brainy` schema |

Handoff: every action becomes an event in the device's outbox. When online, the outbox syncs every 20 seconds, and after each choice. The cloud redraws the sphere after every 4 new events and sends it back, and the tiles glide to their new clusters. Offline, nothing waits on the cloud.

Without `ANTHROPIC_API_KEY`, rules stand in for Claude, so the loop still runs. Add the key and redeploy: the rule-made labels are replaced.

## Install on iPhone or iPad (iOS 26+)

1. Open the deployed address in Safari, entering the passcode if one is set. The globe is at the top of the library.
2. Tap Share, then **Add to Home Screen**, and open Brainy from the home screen.
3. Tap **Download model** on wifi (0.9 GB, once). Leave the app open until it says the model is ready.
4. Use it once online so it can keep your library. It then works in airplane mode.

The mic uses iOS speech recognition. If it isn't available, tap the keyboard button and use the keyboard's own dictation microphone.

## What apps you use (optional)

A web app can't see other apps. iOS Shortcuts can report them:

Shortcuts → Automation → New → **App** → choose apps → *Is Opened* → Run Immediately → action **Get Contents of URL**:
`https://YOUR-APP/api/hybrid/signal?app=Instagram&key=YOUR_PASSCODE`

**Focus** automations work the same way with `?focus=Work`. These signals show in the "What it knows" panel and reach the cloud agent.

## Demo script

1. Turn on airplane mode, to show the agent runs on-device.
2. Tap the mic: "I'm on the metro, forgot my headphones, and I've been in a loud social thing all day."
3. The sphere pulses, spins, and lifts out a pick. The chips you asked about (time, vibe) are lit.
4. Swipe away the analytical pick, then open something visual. Read a little.
5. Tap **What it knows**: the device has already learned, for example "socially drained → visual". Events are queued.
6. Turn airplane mode off. The queue drains, the cloud redraws your sphere, and the tiles rearrange. New inferences appear under **In the cloud**.

To force a redraw, use **Hand off and redraw now** in the panel.
