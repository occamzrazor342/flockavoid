# Camera Route

A camera-avoidance route planner you can use while driving, on Android or iPhone. Live at
**https://occamzrazor342.github.io/flockavoid/**

Add it to your home screen (browser menu → "Add to Home Screen" / "Install app") so it
runs like a real app.

## What it does

1. Computes a route that avoids known ALPR/surveillance cameras, using
   [FlockHopper](https://github.com/flockhopper3/deflock_maps)'s real routing engine —
   directional camera field-of-view modeling, not just a naive radius — and shows you the
   tradeoff (cameras avoided vs. extra time/distance) before you commit to it.
2. Hands the exact computed route to [OsmAnd](https://osmand.net) for real turn-by-turn
   navigation, which is what actually shows up on your car's screen (Android Auto or
   CarPlay — OsmAnd supports both, paid tier).
3. Separately, install the official [DeFlock app](https://deflock.org/app) for live
   background proximity alerts as you drive, regardless of which nav app is open.

## Entering a destination

- **Type an address or business name** — live suggestions appear as you type (pulled
  from both Nominatim and Photon, since either one alone misses real addresses).
- **Paste a Google/Apple Maps link** — pulls the exact coordinates out of the link,
  bypassing address search entirely. Use the *expanded* link (not a shortened
  `maps.app.goo.gl` one — open it once first if that's what you have; see "Known
  limitations" below).
- **Android only: tap Share on a place in Google Maps and pick "Camera Route"** — this
  is the smoothest path when it's available. iOS has no equivalent (see below).

## Known limitations, and why

- **Free map data doesn't have every business.** OpenStreetMap (which the address search
  and camera data both come from) frequently has only one point for a whole shared
  building/strip mall — tagged to whichever single tenant a volunteer happened to map. If
  a business-name or address search doesn't find your destination, paste its Maps link
  instead — that always has the exact coordinates regardless of what OSM has indexed.
- **Shortened Maps links (`maps.app.goo.gl`) can't be resolved automatically.** Google's
  bot-detection blocks this specifically from cloud/datacenter IPs, which is exactly what
  any server-side resolver (including this app's) runs on. This is a deliberate stopping
  point, not a bug still being worked on — open the shortlink once in your own browser
  (which isn't flagged) and share/paste the resulting full URL instead.
- **Share-from-Maps auto-fill is Android-only.** iOS Safari has never implemented the Web
  Share Target API (the piece that lets an installed PWA appear as a share destination) —
  this is an Apple platform gap, not something this app can work around. iPhone users:
  open the app directly and paste the address/link into Destination instead.

## How it's built

- `index.html` / `app.js` / `manifest.json` / `sw.js` — the PWA itself, plain
  HTML/CSS/JS, no build step, no framework, no dependencies. Hosted on GitHub Pages.
- `worker/worker.js` — a small Cloudflare Worker doing two things browser JS can't do on
  its own: hosting the generated GPX at a real HTTPS URL (Chrome's Web Share API only
  allows a fixed allowlist of common file types for direct file-sharing — `.gpx` isn't on
  it, sharing a URL instead has no such restriction), and (for other Maps link shapes,
  not shortlinks — see above) following a redirect server-side where CORS would block a
  browser from doing the same.

GPX generation mirrors [deflock_maps](https://github.com/flockhopper3/deflock_maps)'s own
`gpxService.ts` (MIT licensed).

## License

MIT.
