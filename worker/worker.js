/**
 * flockavoid-bridge worker
 *
 * Two jobs, both existing because of real, confirmed limitations that
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
 */

const GPX_TTL_SECONDS = 3600;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
