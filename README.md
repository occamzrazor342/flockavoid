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
   CarPlay — OsmAnd supports both, paid tier). Tapping "Download for OsmAnd" downloads a
   `.gpx` file (the same mechanism as opening a GPX email attachment); once the download
   finishes, tap the notification, choose Open, then pick OsmAnd.
3. Separately, install the official [DeFlock app](https://deflock.org/app) for live
   background proximity alerts as you drive, regardless of which nav app is open.

## Installing it (Android)

**Only Chrome and Samsung Internet can install this as a real app on Android** — every
other browser (DuckDuckGo, Firefox, Edge, Opera, ...) can only create a plain home-screen
bookmark shortcut, which opens the page fine but never registers with Android's share
system. If "Camera Route" doesn't show up when you tap Share on a place in Google Maps,
this is almost certainly why — reinstall using Chrome or Samsung Internet specifically.
(You can still browse the rest of the web with whatever browser you prefer; this only
matters for the one-time install of this app.)

## Entering a destination

- **Type an address or business name** — live suggestions appear as you type (pulled
  from both Nominatim and Photon, since either one alone misses real addresses).
- **Long-press the exact spot on the map in Google/Apple Maps to drop a pin** (not a
  search result), copy the coordinates shown in the search bar, paste them here. This is
  the most reliable method, full stop — see "Known limitations" below for why.
- **Paste an already-expanded Google/Apple Maps link** — pulls the exact coordinates out
  of it directly. Only works for a full link, not a shortened `maps.app.goo.gl` one (see
  below for why there's no workaround for those).
- **Android only, using Chrome or Samsung Internet: tap Share on a place in Google Maps
  and pick "Camera Route"** — the smoothest path, and the intended default way to use
  this app. Google Maps' share intent sends a shortened link, but it also bundles the
  place's name/address as plain text right alongside it — this app strips the link out
  and looks up that name/address via Google Places automatically, so most real shares
  resolve without you doing anything else. It only falls back to asking you to drop a
  pin manually if a share truly has no place name attached, just a bare link.

## Known limitations, and why

- **Free map data doesn't have every business.** OpenStreetMap (which the address search
  and camera data both come from) frequently has only one point for a whole shared
  building/strip mall — tagged to whichever single tenant a volunteer happened to map. If
  a business-name or address search doesn't find your destination, paste its Maps link
  instead — that always has the exact coordinates regardless of what OSM has indexed.
- **Shortened Maps links (`maps.app.goo.gl`) can't be resolved to coordinates
  automatically.** Google's bot-detection blocks this specifically from cloud/datacenter
  IPs, which is exactly what any server-side resolver (including this app's) runs on.
  This is a deliberate stopping point, not a bug still being worked on. In practice this
  rarely matters for the Share flow above, since the shared text alongside the link
  usually has the place's name/address, which gets geocoded directly instead. It only
  bites if you paste a bare shortlink — with no other text — straight into the
  Destination field; do a long-press pin-drop instead in that case.
- **Share-from-Maps auto-fill is Android-only.** iOS Safari has never implemented the Web
  Share Target API (the piece that lets an installed PWA appear as a share destination) —
  this is an Apple platform gap, not something this app can work around. iPhone users:
  open the app directly and paste the address/link into Destination instead.

## How it's built

- `index.html` / `app.js` / `manifest.json` / `sw.js` — the PWA itself, plain
  HTML/CSS/JS, no build step, no framework, no dependencies. Hosted on GitHub Pages.
- `worker/worker.js` — a small Cloudflare Worker doing two things browser JS can't do on
  its own: hosting the generated GPX at a real HTTPS URL served as a forced download
  (Chrome's Web Share API only allows a fixed allowlist of common file types for direct
  file-sharing — `.gpx` isn't on it, and sharing the URL itself instead of a real file
  doesn't work either — OsmAnd doesn't import from a shared link, only from an actual
  `application/gpx+xml` file via Android's normal "open with" flow, the same as a GPX
  email attachment), and (for other Maps link shapes, not shortlinks — see above)
  following a redirect server-side where CORS would block a browser from doing the same.

GPX generation mirrors [deflock_maps](https://github.com/flockhopper3/deflock_maps)'s own
`gpxService.ts` (MIT licensed).

## License

MIT.
