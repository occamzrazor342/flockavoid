/**
 * flockavoid-bridge worker
 *
 * Serves two clients now, and the newer one is the one that matters.
 *
 * The native Android app (Projects/flockavoid-native) depends on
 * /places/searchtext, /osm/cameras and /osm/cameras/area. The original
 * CamRoute PWA, which this was built for, is superseded by that app and only
 * still uses /resolve and /gpx. Those two are kept because removing them would
 * break the PWA outright, not because anything actively needs them.
 *
 * Worth knowing: the native app authenticates here by sending the PWA's
 * origin as a Referer, so the same-origin check below is satisfied by a
 * client that is not a browser at all. That is a fiction inherited from the
 * PWA-first design and the weakest part of this Worker's access control --
 * see the note on /places/searchtext about why it was never a strong check
 * to begin with.
 *
 * Endpoints 1 and 2 exist because of real, confirmed limitations that
 * browser-side JS in the PWA can't work around on its own:
 *
 * 1. GET /resolve?url=<shortlink>
 *    Follows a Google/Apple Maps shortlink's redirect server-side and
 *    returns the resolved URL. Browser fetch() can't do this itself --
 *    CORS blocks reading a cross-origin redirect's destination from page
 *    JS, but a server-side request has no such restriction (confirmed by
 *    resolving a real shortlink with plain curl before building this).
 *
 * 2. POST /gpx  (body: raw GPX XML)
 *    Stores the GPX in KV and returns a real HTTPS URL for it. Chrome's
 *    Web Share API only allows sharing a fixed allowlist of common file
 *    types (image/audio/video/PDF/plain text) -- .gpx isn't on it, and
 *    there's no way to spoof past that from a website. Hosting it at a
 *    URL sidesteps that, but only works if the app fetches the URL as a
 *    real file download (Content-Disposition: attachment below) -- OsmAnd
 *    doesn't import a GPX from ACTION_SEND text containing a link (a
 *    real, confirmed device test: it just searched the URL string as a
 *    place name instead). What it DOES recognize is the exact same
 *    android.intent.action.VIEW + application/gpx+xml MIME type it uses
 *    for a tapped email/Drive attachment -- which is exactly what Chrome's
 *    "download complete -> Open" flow produces for an unrenderable file.
 *    GET /gpx/<id> serves the stored content back with the right
 *    Content-Type. Entries expire after 1 hour (KV expirationTtl) --
 *    this is a short-lived handoff, not permanent storage.
 *
 * 3. POST /places/searchtext  (body: {"textQuery": ..., "locationBias": ...})
 *    Proxies Google Places Text Search using a server-only API key
 *    (env.GOOGLE_PLACES_SERVER_KEY, a Worker secret -- never in client code
 *    or git). Exists to replace a client-side Google key restricted only
 *    by HTTP referrer, which has two real problems: a referrer is just a
 *    string a real browser honestly sends, so (1) any non-browser script
 *    holding the key can simply lie about it and use the key anyway
 *    (confirmed directly -- curl can set an arbitrary Referer header), and
 *    (2) some real mobile browser contexts (iOS Safari's installed
 *    "standalone" home-screen mode, suspected here) are known to drop the
 *    Referer header entirely, breaking the restriction from the *correct*
 *    origin too. A server-only key never shipped to any client sidesteps
 *    both: there's no key for anyone to extract and spoof a referrer with,
 *    and Google never needs to see one at all. The same-origin check below
 *    is a second, independent, non-airtight layer (a scripted caller can
 *    fake an Origin/Referer header hitting this endpoint the same way it
 *    could fake one straight to Google) -- it raises the bar against
 *    casual reuse of this endpoint from another site, not a cryptographic
 *    guarantee.
 */

const GPX_TTL_SECONDS = 3600;
// One route's worth of cameras, with plenty of headroom; a cap this endpoint
// enforces rather than trusting the caller to be reasonable.
const OSM_MAX_IDS = 100;
const OSM_CACHE_SECONDS = 86400;
// Per IP, per endpoint, per minute. Comfortably above what the app does during
// normal use -- one route computation plus a heatmap pan is a handful of calls
// -- and far below what it would take to run up a Google Places bill or make a
// nuisance of this Worker on someone else's Overpass instance.
const RATE_LIMIT_PER_MINUTE = 30;
// Roughly a metro area. Large enough for a useful map view, small enough that
// one request can't pull a region-sized dataset.
const AREA_MAX_SPAN_DEG = 0.6;
const AREA_GRID_DEG = 0.05;
// DeFlock's own instance first: measured 1.2s against the public instance's
// 69.8s for an identical query with identical results.
const OVERPASS_HOSTS = [
  'https://overpass.deflock.org/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Runs an Overpass query against the first host that answers.
 *
 * Shared by both camera endpoints deliberately: they previously had separate
 * fetch logic and drifted, leaving one with a fallback and one without.
 */
async function queryOverpass(query) {
  for (const host of OVERPASS_HOSTS) {
    try {
      const resp = await fetch(host, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass asks for an identifying User-Agent so operators can
          // contact heavy users rather than just blocking them.
          'User-Agent': 'flockavoid-bridge (https://github.com/occamzrazor342/flockavoid)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!resp.ok) continue;
      return await resp.json();
    } catch (err) {
      // Try the next host.
    }
  }
  return null;
}

/**
 * Authorises a request.
 *
 * The original check compared Origin/Referer against the PWA's GitHub Pages
 * URL. That was never strong -- the header is a string any caller can set --
 * and it got weaker over time: the native app is not a browser and satisfies
 * it by *claiming* to be the PWA, and this repository is public, so the exact
 * string needed to pass is published alongside the code. Demonstrated with a
 * single curl carrying a faked Referer, which sailed straight through.
 *
 * A shared token is not a cryptographic guarantee either -- anything shipped
 * inside a distributed app can be extracted from it. What it does buy is a
 * real difference: the secret is not published, it can be rotated without
 * redeploying the app's origin story, and it can be revoked. Paired with the
 * rate limiting below, that bounds the damage an extracted token can do to
 * the Google Places bill and to a volunteer-run Overpass instance.
 *
 * Deliberately falls back to the old Referer check while APP_API_TOKEN is
 * unset, so this can be deployed before the secret exists and before an app
 * build carries it -- the same staged approach used for
 * GOOGLE_PLACES_SERVER_KEY. Once the secret is set, the Referer path is gone.
 */
function isAuthorised(request, env) {
  if (env.APP_API_TOKEN) {
    const auth = request.headers.get('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return timingSafeEqual(presented, env.APP_API_TOKEN);
  }
  const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
  return origin.startsWith('https://occamzrazor342.github.io');
}

/** Constant-time compare, so a wrong token can't be narrowed down by timing. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Per-IP request cap, backed by the KV namespace already bound here.
 *
 * This is the part that actually limits harm. Auth answers "who is calling";
 * this answers "how much can any one caller cost me" -- which matters because
 * /places/searchtext spends real money against a Google key and the camera
 * endpoints proxy a volunteer-run service under this Worker's identity.
 *
 * KV is eventually consistent, so the count can undershoot briefly under a
 * burst from several edge locations. That is acceptable: the goal is bounding
 * sustained abuse, not exact accounting, and a stricter primitive (Durable
 * Objects) is not worth the complexity here.
 */
async function withinRateLimit(request, env, bucket, limit, windowSeconds) {
  if (!env.GPX_STORE) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${ip}:${window}`;
  const current = parseInt((await env.GPX_STORE.get(key)) || '0', 10);
  if (current >= limit) return false;
  await env.GPX_STORE.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/resolve' && request.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'missing url param' }, 400);
      try {
        // redirect: 'manual' + read the Location header, rather than
        // 'follow' -- confirmed necessary: actually fetching the final
        // maps.google.com page from a Cloudflare Worker IP trips Google's
        // bot detection (a "/sorry/" interstitial), even though the
        // shortlink's own redirect resolves in one clean hop with no such
        // check. Reading the Location header never touches that page at
        // all, so it never triggers the block.
        let current = target;
        let resolved = null;
        for (let hop = 0; hop < 5; hop++) {
          const resp = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
          });
          const location = resp.headers.get('Location');
          if (!location) {
            resolved = current;
            break;
          }
          current = location;
          // Stop as soon as we've landed on a real maps URL (not another
          // shortener) -- no need to keep hopping, and this is exactly the
          // point where continuing would mean fetching Google's own page.
          if (!/goo\.gl/i.test(current)) {
            resolved = current;
            break;
          }
        }
        if (!resolved) return json({ error: 'Too many redirects' }, 502);
        return json({ resolvedUrl: resolved });
      } catch (err) {
        return json({ error: `Could not resolve: ${err.message}` }, 502);
      }
    }

    if (url.pathname === '/places/searchtext' && request.method === 'POST') {
      if (!isAuthorised(request, env)) {
        return json({ error: 'Forbidden' }, 403);
      }
      if (!(await withinRateLimit(request, env, url.pathname, RATE_LIMIT_PER_MINUTE, 60))) {
        return json({ error: 'Rate limit exceeded' }, 429);
      }
      if (!env.GOOGLE_PLACES_SERVER_KEY) {
        // Expected until the new server-only key is created and set as a
        // Worker secret -- not a bug, this endpoint is deployed ahead of
        // that on purpose since it's inert (nothing calls it yet) until
        // then.
        return json({ error: 'Places proxy not configured yet' }, 503);
      }
      const clientBody = await request.text();
      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': env.GOOGLE_PLACES_SERVER_KEY,
          // Fixed server-side, not forwarded from the client -- keeps this
          // proxy from being usable to request arbitrary, possibly pricier
          // field masks than this app actually needs.
          'X-Goog-FieldMask': 'places.location,places.displayName,places.formattedAddress',
        },
        body: clientBody,
      });
      const data = await resp.text();
      return new Response(data, {
        status: resp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/osm/cameras' && request.method === 'POST') {
      if (!isAuthorised(request, env)) {
        return json({ error: 'Forbidden' }, 403);
      }
      if (!(await withinRateLimit(request, env, url.pathname, RATE_LIMIT_PER_MINUTE, 60))) {
        return json({ error: 'Rate limit exceeded' }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch (err) {
        return json({ error: 'Body must be JSON' }, 400);
      }

      // Deliberately takes a list of ids and builds the Overpass query here,
      // and never accepts a query string from the client. Forwarding a
      // caller-supplied query would turn this endpoint into an open relay for
      // arbitrary Overpass work -- expensive area-wide queries billed to
      // OSM's volunteer-run servers, attributed to this Worker's IP, and a
      // ready-made SSRF primitive. Numeric ids can't express any of that.
      const rawIds = Array.isArray(body?.osmIds) ? body.osmIds : null;
      if (!rawIds || rawIds.length === 0) {
        return json({ error: 'osmIds must be a non-empty array' }, 400);
      }
      if (rawIds.length > OSM_MAX_IDS) {
        return json({ error: `At most ${OSM_MAX_IDS} ids per request` }, 400);
      }
      const ids = [];
      for (const value of rawIds) {
        // Number, integral, positive, and inside OSM's real id range. Anything
        // else is rejected outright rather than coerced.
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          return json({ error: 'osmIds must be positive integers' }, 400);
        }
        ids.push(value);
      }
      // Sorted + de-duplicated so the same set of cameras always produces the
      // same cache key regardless of the order they arrived in.
      const uniqueSorted = [...new Set(ids)].sort((a, b) => a - b);

      // Camera tags change on the order of months, and Overpass is a
      // volunteer-run service that asks callers not to hammer it. Caching a
      // day is both faster for the app and the polite thing to do.
      const cacheKey = new Request(
        `${url.origin}/osm/cameras/cache/${uniqueSorted.join(',')}`,
        { method: 'GET' },
      );
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      // `out meta` rather than `out tags` so the response carries each node's
      // last-edited timestamp. This data is crowdsourced, and how recently a
      // camera was confirmed is part of how much to trust it -- a node touched
      // last week is a different proposition from one untouched for two years.
      const query = `[out:json][timeout:25];node(id:${uniqueSorted.join(',')});out meta;`;
      // Tries every host in turn, same as the area endpoint. This originally
      // hardcoded the public instance with no fallback, and that broke the
      // feature outright the first time the public instance went down while
      // DeFlock's own was healthy -- caught live, returning
      // "Overpass returned 521" while the heatmap beside it kept working
      // because only that endpoint had the fallback. Host order matters too:
      // DeFlock's instance measured 1.2s against the public one's 69.8s on an
      // identical query.
      const overpass = await queryOverpass(query);
      if (!overpass) {
        return json({ error: 'No Overpass instance reachable' }, 502);
      }

      // Returns only the tags the app actually renders, keyed by id. Passing
      // the raw Overpass payload straight through would ship a pile of fields
      // nothing reads and make the client parse a third party's schema.
      const cameras = {};
      for (const element of overpass.elements || []) {
        const tags = element.tags || {};
        cameras[String(element.id)] = {
          surveillanceType: tags['surveillance:type'] || null,
          cameraType: tags['camera:type'] || null,
          mount: tags['camera:mount'] || null,
          manufacturer: tags.manufacturer || null,
          operator: tags.operator || null,
          zone: tags['surveillance:zone'] || null,
          direction: tags.direction || tags['camera:direction'] || null,
          description: tags.description || null,
          lastUpdated: element.timestamp || null,
        };
      }

      const response = json({ cameras });
      response.headers.set('Cache-Control', `public, max-age=${OSM_CACHE_SECONDS}`);
      // waitUntil isn't available here, and the write is cheap enough to await.
      await cache.put(cacheKey, response.clone());
      return response;
    }

    if (url.pathname === '/osm/cameras/area' && request.method === 'POST') {
      if (!isAuthorised(request, env)) {
        return json({ error: 'Forbidden' }, 403);
      }
      if (!(await withinRateLimit(request, env, url.pathname, RATE_LIMIT_PER_MINUTE, 60))) {
        return json({ error: 'Rate limit exceeded' }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch (err) {
        return json({ error: 'Body must be JSON' }, 400);
      }

      const nums = ['south', 'west', 'north', 'east'].map((k) => body?.[k]);
      if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        return json({ error: 'south/west/north/east must be numbers' }, 400);
      }
      let [south, west, north, east] = nums;
      if (south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east) {
        return json({ error: 'Invalid bounding box' }, 400);
      }
      // Bounded on purpose. An unbounded area query against a volunteer-run
      // Overpass instance is both a denial-of-service risk to them and a way
      // to pull a national dataset through this Worker one request at a time.
      if (north - south > AREA_MAX_SPAN_DEG || east - west > AREA_MAX_SPAN_DEG) {
        return json({ error: `Area too large (max ${AREA_MAX_SPAN_DEG} degrees per side)` }, 400);
      }

      // Snapped outward to a fixed grid so that panning the map slightly
      // produces the same cache key instead of a near-miss every time. The
      // caller gets a little more than it asked for, which is fine.
      const snap = (v, dir) =>
        (dir < 0 ? Math.floor(v / AREA_GRID_DEG) : Math.ceil(v / AREA_GRID_DEG)) * AREA_GRID_DEG;
      south = Number(snap(south, -1).toFixed(3));
      west = Number(snap(west, -1).toFixed(3));
      north = Number(snap(north, 1).toFixed(3));
      east = Number(snap(east, 1).toFixed(3));

      const cacheKey = new Request(
        `${url.origin}/osm/cameras/area/cache/${south},${west},${north},${east}`,
        { method: 'GET' },
      );
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const query =
        `[out:json][timeout:25];node["man_made"="surveillance"](${south},${west},${north},${east});out body;`;

      // DeFlock runs its own Overpass instance for exactly this data, and it is
      // dramatically faster than the public one -- measured on an identical
      // query returning identical results: 1.2s versus 69.8s. The public
      // instance stays as a fallback rather than a default.
      const overpass = await queryOverpass(query);
      if (!overpass) return json({ error: 'No Overpass instance reachable' }, 502);

      // Trimmed hard: a heatmap needs position and weighting, nothing else.
      // The full tag payload for a city is hundreds of KB of data the client
      // would immediately discard.
      const cameras = [];
      for (const el of overpass.elements || []) {
        if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
        const tags = el.tags || {};
        cameras.push({
          id: el.id,
          lat: Number(el.lat.toFixed(6)),
          lon: Number(el.lon.toFixed(6)),
          alpr: (tags['surveillance:type'] || '').toUpperCase() === 'ALPR',
        });
      }

      const response = json({ cameras, bbox: { south, west, north, east } });
      response.headers.set('Cache-Control', `public, max-age=${OSM_CACHE_SECONDS}`);
      await cache.put(cacheKey, response.clone());
      return response;
    }

    if (url.pathname === '/gpx' && request.method === 'POST') {
      const body = await request.text();
      if (!body || body.length > 2_000_000) {
        return json({ error: 'missing or oversized GPX body' }, 400);
      }
      const id = crypto.randomUUID();
      await env.GPX_STORE.put(id, body, { expirationTtl: GPX_TTL_SECONDS });
      return json({ url: `${url.origin}/gpx/${id}.gpx` });
    }

    const gpxMatch = url.pathname.match(/^\/gpx\/([a-f0-9-]+)\.gpx$/);
    if (gpxMatch && request.method === 'GET') {
      const content = await env.GPX_STORE.get(gpxMatch[1]);
      if (content === null) {
        return new Response('Not found or expired (routes are kept for 1 hour only)', {
          status: 404,
          headers: CORS_HEADERS,
        });
      }
      return new Response(content, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/gpx+xml',
          // attachment, not inline: forces Chrome to download this rather
          // than try to display it, which is what makes Android's
          // "download complete -> Open" flow appear at all. inline was the
          // original bug here -- confirmed live it let OsmAnd's own share
          // handler receive a bare URL as shared text and search it as a
          // place name instead of importing it.
          //
          // filename includes the route's own id, not a static "route.gpx" --
          // confirmed live that a fixed filename makes Chrome treat every
          // subsequent route as "you already downloaded this file, download
          // again?", an extra confirmation tap on every single route. A
          // unique name per route means Chrome just downloads it, every time.
          'Content-Disposition': `attachment; filename="route-${gpxMatch[1].slice(0, 8)}.gpx"`,
        },
      });
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};
