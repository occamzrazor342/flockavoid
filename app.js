// Camera Route -- calls FlockHopper's camera-avoidance routing API directly
// (client-side, no backend of ours needed -- api.dontgetflocked.com's CORS
// policy allows any origin, confirmed before building this), then hands the
// result to OsmAnd via the Web Share API so it can navigate the exact
// computed path. Google Maps link is a fallback approximation.
//
// GPX generation here mirrors deflock_maps' own gpxService.ts (MIT licensed,
// github.com/flockhopper3/deflock_maps) -- same as the Python CLI version
// this PWA is a mobile counterpart to.

const API_URL = 'https://api.dontgetflocked.com/api/v1/route';
const BRIDGE_WORKER_URL = 'https://flockavoid-bridge.cloudflare-harmony254.workers.dev';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const GOOGLE_MAPS_MAX_WAYPOINTS = 9;
const AUTOCOMPLETE_DEBOUNCE_MS = 400;
const AUTOCOMPLETE_MIN_CHARS = 3;

const $ = (id) => document.getElementById(id);

let currentOrigin = null;
let lastResult = null;
let selectedDestination = null; // set when the user picks a suggestion; cleared on manual edits
let autocompleteTimer = null;

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = isError ? 'status error' : 'status';
}

/** Returns true on success, false on failure -- callers that need to
 * sequence "get location, then do X" (the incoming-share auto-flow) can
 * await this and check the result instead of racing a bare callback. */
async function useCurrentLocation(statusOnSuccess = 'Location set. Enter a destination and tap Get Route.') {
  setStatus('Getting your location…');
  if (!navigator.geolocation) {
    setStatus('Geolocation not available in this browser.', true);
    return false;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentOrigin = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          name: 'Current location',
        };
        $('originLabel').textContent = `Origin: current location (${currentOrigin.lat.toFixed(4)}, ${currentOrigin.lon.toFixed(4)})`;
        setStatus(statusOnSuccess);
        resolve(true);
      },
      (err) => {
        setStatus(`Could not get location: ${err.message}`, true);
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

async function searchNominatim(query, limit = 5) {
  const params = new URLSearchParams({ q: query, format: 'json', limit: String(limit) });
  const resp = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return [];
  const results = await resp.json();
  return results.map((r) => ({
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    name: r.display_name,
  }));
}

async function searchPhoton(query, limit = 5) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const resp = await fetch(`${PHOTON_URL}?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.features || []).map((f) => {
    const p = f.properties;
    const parts = [p.name, p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street, p.city, p.state, p.country]
      .filter(Boolean);
    return {
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      name: parts.length ? parts.join(', ') : query,
    };
  });
}

/** Live suggestions for the autocomplete dropdown -- Nominatim first, Photon
 * merged in too, since they index things differently (this address search
 * problem is exactly why: Nominatim matches strict OSM road-name tagging,
 * e.g. "US 183" not "N Hwy 183"/"N Highway 183", with no abbreviation
 * tolerance, and Photon sometimes finds what Nominatim misses or vice
 * versa). Letting the user pick from what's actually indexed sidesteps
 * needing to guess address-normalization rules entirely. */
async function searchSuggestions(query) {
  const [nominatimResults, photonResults] = await Promise.all([
    searchNominatim(query).catch(() => []),
    searchPhoton(query).catch(() => []),
  ]);
  const seen = new Set();
  const combined = [];
  for (const r of [...nominatimResults, ...photonResults]) {
    const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(r);
  }
  return combined.slice(0, 6);
}

/** Fallback for when the user hits Get Route without picking a suggestion
 * (e.g. pasted text, or typed and pressed Enter) -- try both geocoders
 * before giving up, since either one alone can miss a real address. */
/**
 * Extract coordinates directly from a pasted Google/Apple Maps link or bare
 * "lat,lon" string, bypassing geocoding entirely. This exists because of a
 * real, confirmed limitation: free map data (OpenStreetMap, which both
 * Nominatim and Photon are built on) frequently has only ONE point for a
 * whole shared building/strip mall -- tagged to whichever single tenant a
 * volunteer happened to map -- with no entry at all for other businesses in
 * the same building, whether searched by address or by name. No amount of
 * query normalization finds data that isn't in the dataset. The reliable
 * fix for "I copied this from my normal map app" is to read the coordinates
 * already embedded in what was copied, since those apps pinpoint the exact
 * spot regardless of what OSM/Census happen to have indexed.
 *
 * Handles:
 *   - a bare "lat,lon" string
 *   - Google Maps: .../@lat,lon,<zoom>z/...  or  ?q=lat,lon  or  &q=lat,lon
 *   - Apple Maps:  ?ll=lat,lon  or  &ll=lat,lon
 *
 * Does NOT resolve shortened links (maps.app.goo.gl, goo.gl/maps) -- those
 * redirect server-side with no CORS exposure, so a browser can't follow them
 * to the real URL. If a shortlink is pasted, tell the user to open it once
 * and paste the resulting full URL instead.
 */
function extractLatLon(text) {
  const bare = text.match(/^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  if (bare) return { lat: parseFloat(bare[1]), lon: parseFloat(bare[2]) };

  const atSign = text.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+),/);
  if (atSign) return { lat: parseFloat(atSign[1]), lon: parseFloat(atSign[2]) };

  // Google Maps "place" share links encode the actual pinned point as
  // !3d<lat>!4d<lon> inside the data= parameter -- distinct from (and more
  // precise than) the @lat,lon,zoom viewport-center format above, which is
  // what a *specific business* share link (the real-world common case)
  // actually uses. Confirmed directly against a real shortlink redirect.
  const place3d4d = text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (place3d4d) return { lat: parseFloat(place3d4d[1]), lon: parseFloat(place3d4d[2]) };

  const qParam = text.match(/[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (qParam) return { lat: parseFloat(qParam[1]), lon: parseFloat(qParam[2]) };

  const llParam = text.match(/[?&]ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (llParam) return { lat: parseFloat(llParam[1]), lon: parseFloat(llParam[2]) };

  return null;
}

function isShortenedMapsLink(text) {
  return /(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(text);
}

async function geocode(address) {
  const nominatimResults = await searchNominatim(address, 1).catch(() => []);
  if (nominatimResults.length) return { ...nominatimResults[0], name: address };

  const photonResults = await searchPhoton(address, 1).catch(() => []);
  if (photonResults.length) return { ...photonResults[0], name: address };

  throw new Error(
    `Could not find "${address}" in either geocoder. Try: dropping the unit/suite ` +
    `number, using the highway's official name (e.g. "US 183" instead of "Hwy 183"), ` +
    `picking from the suggestion dropdown as you type instead of typing the full ` +
    `address and pressing Get Route directly, or entering coordinates as "lat,lon".`
  );
}

async function calculateRoute(origin, destination, cameraDistanceMeters, directional) {
  const body = {
    origin: { lat: origin.lat, lon: origin.lon },
    destination: { lat: destination.lat, lon: destination.lon },
    format: 'full',
    costing: 'auto',
    cameraDistanceMeters,
    useDirectionalZones: directional,
  };
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || `Routing failed (${resp.status})`);
  }
  return data.result;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateGPX(route, name, description) {
  const now = new Date().toISOString();
  const origin = route.origin;
  const destination = route.destination;

  const trackpoints = route.geometry
    .map(([lat, lon]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join('\n');

  const routepoints = (route.maneuvers || [])
    .map((m) => {
      const [lat, lon] = route.geometry[m.beginShapeIndex];
      return `    <rtept lat="${lat}" lon="${lon}">\n      <name>${escapeXml(m.instruction)}</name>\n    </rtept>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1"
     creator="Camera Route PWA (via FlockHopper camera-avoidance routing)"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <desc>${escapeXml(description)}</desc>
    <time>${now}</time>
  </metadata>

  <wpt lat="${origin.lat}" lon="${origin.lon}">
    <name>Start: ${escapeXml(origin.name || 'Origin')}</name>
    <sym>Flag, Green</sym>
  </wpt>

  <wpt lat="${destination.lat}" lon="${destination.lon}">
    <name>End: ${escapeXml(destination.name || 'Destination')}</name>
    <sym>Flag, Red</sym>
  </wpt>

  <rte>
    <name>${escapeXml(name)}</name>
${routepoints}
  </rte>

  <trk>
    <name>${escapeXml(name)} Track</name>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;
}

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => points[Math.round(i * step)]);
}

function googleMapsUrl(origin, destination, geometry) {
  const interior = geometry.length > 2 ? geometry.slice(1, -1) : [];
  const waypoints = downsample(interior, GOOGLE_MAPS_MAX_WAYPOINTS);
  const params = new URLSearchParams({
    api: '1',
    origin: `${origin.lat},${origin.lon}`,
    destination: `${destination.lat},${destination.lon}`,
    travelmode: 'driving',
  });
  if (waypoints.length) {
    params.set('waypoints', waypoints.map(([lat, lon]) => `${lat},${lon}`).join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

async function getRoute() {
  const destInput = $('destination').value.trim();
  if (!destInput) {
    setStatus('Enter a destination first.', true);
    return;
  }
  if (!currentOrigin) {
    setStatus('Set your origin first (tap "Use current location" or type one).', true);
    return;
  }

  if (isShortenedMapsLink(destInput)) {
    setStatus(
      'Shortened Maps links (maps.app.goo.gl / goo.gl/maps) can’t be read directly — ' +
      'open it once and paste the resulting full URL instead.',
      true
    );
    return;
  }

  $('getRouteBtn').disabled = true;
  $('results').hidden = true;
  setStatus('Geocoding destination…');

  try {
    let destination;
    const pinned = extractLatLon(destInput);
    if (pinned) {
      destination = { ...pinned, name: destInput };
    } else if (selectedDestination && selectedDestination.name === destInput) {
      // Picked from the autocomplete dropdown -- already has exact coordinates,
      // no need to re-geocode (and re-geocoding the display_name string back
      // through Nominatim isn't guaranteed to round-trip to the same result).
      destination = selectedDestination;
    } else {
      destination = await geocode(destInput);
    }

    setStatus('Calculating camera-avoidance route…');
    const cameraDistance = parseInt($('cameraDistance').value, 10) || 150;
    const directional = $('directional').checked;
    const result = await calculateRoute(currentOrigin, destination, cameraDistance, directional);

    const avoidance = result.avoidanceRoute.route;
    avoidance.origin = { ...avoidance.origin, name: currentOrigin.name };
    avoidance.destination = { ...avoidance.destination, name: destination.name };
    const improvement = result.improvement;

    lastResult = { origin: currentOrigin, destination, avoidance, improvement };

    $('statCameras').textContent = `${improvement.camerasAvoided} avoided (${improvement.cameraReductionPercent.toFixed(0)}%), ${result.avoidanceRoute.camerasOnRoute.length} remain on route`;
    $('statDistance').textContent = `+${(improvement.distanceIncrease / 1609.34).toFixed(1)} mi (${improvement.distanceIncreasePercent.toFixed(1)}%)`;
    $('statTime').textContent = `+${Math.round(improvement.durationIncrease / 60)} min (${improvement.durationIncreasePercent.toFixed(1)}%)`;
    $('gmapsLink').href = googleMapsUrl(currentOrigin, destination, avoidance.geometry);

    $('results').hidden = false;
    setStatus('Route ready. Share to OsmAnd for exact turn-by-turn, or open the approximate Google Maps link.');
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    $('getRouteBtn').disabled = false;
  }
}

async function shareToOsmAnd() {
  if (!lastResult) return;
  const { origin, destination, avoidance, improvement } = lastResult;
  const name = `Camera-avoidance: ${origin.name} to ${destination.name}`;
  const description = `${improvement.camerasAvoided} cameras avoided vs. the normal route`;
  const gpxContent = generateGPX(avoidance, name, description);

  // Chrome's Web Share API only allows a fixed allowlist of common file
  // types (image/audio/video/PDF/plain text) -- confirmed .gpx is not on
  // it, and there's no way to get around that from a website. The fix:
  // host the GPX at a real HTTPS URL (via the bridge worker) and share
  // that URL instead of a file -- sharing a URL has no such restriction,
  // and OsmAnd's own file-open intent filter matches a link ending in
  // .gpx the same way it matches a local file.
  try {
    setStatus('Uploading route…');
    const uploadResp = await fetch(`${BRIDGE_WORKER_URL}/gpx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gpx+xml' },
      body: gpxContent,
    });
    if (!uploadResp.ok) throw new Error(`Upload failed (${uploadResp.status})`);
    const { url: gpxUrl } = await uploadResp.json();

    if (navigator.canShare && navigator.canShare({ url: gpxUrl })) {
      await navigator.share({ url: gpxUrl, title: name, text: description });
      setStatus('Shared. Pick OsmAnd, then tap Navigation → Start.');
    } else if (navigator.share) {
      // Some browsers support share() for URLs without canShare() pre-check.
      await navigator.share({ url: gpxUrl, title: name, text: description });
      setStatus('Shared. Pick OsmAnd, then tap Navigation → Start.');
    } else {
      // No Web Share support at all -- last resort, open the link directly
      // so the user can long-press / use the browser's own "Open with".
      window.open(gpxUrl, '_blank');
      setStatus('Web Share isn’t available here — opened the route link directly instead.', true);
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled the share sheet
    setStatus(`Could not share the route: ${err.message}`, true);
  }
}

function renderSuggestions(suggestions) {
  const box = $('destSuggestions');
  box.innerHTML = '';
  if (!suggestions.length) {
    box.hidden = true;
    return;
  }
  for (const s of suggestions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'suggestion-item';
    item.textContent = s.name;
    item.addEventListener('click', () => {
      selectedDestination = s;
      $('destination').value = s.name;
      box.hidden = true;
      box.innerHTML = '';
    });
    box.appendChild(item);
  }
  box.hidden = false;
}

function onDestinationInput() {
  selectedDestination = null; // any manual edit invalidates a previously picked suggestion
  const query = $('destination').value.trim();
  clearTimeout(autocompleteTimer);

  if (isShortenedMapsLink(query)) {
    renderSuggestions([]);
    setStatus(
      'That’s a shortened link — open it once (it’ll redirect in your browser) and paste the resulting full URL here instead.',
      true
    );
    return;
  }

  const pinned = extractLatLon(query);
  if (pinned) {
    selectedDestination = { ...pinned, name: query };
    renderSuggestions([]);
    setStatus(`Pinned exact location from link: ${pinned.lat.toFixed(5)}, ${pinned.lon.toFixed(5)}`);
    return;
  }

  if (query.length < AUTOCOMPLETE_MIN_CHARS) {
    renderSuggestions([]);
    return;
  }
  autocompleteTimer = setTimeout(async () => {
    try {
      const suggestions = await searchSuggestions(query);
      // Only render if the input hasn't changed since this search started.
      if ($('destination').value.trim() === query) renderSuggestions(suggestions);
    } catch {
      renderSuggestions([]);
    }
  }, AUTOCOMPLETE_DEBOUNCE_MS);
}

$('useLocationBtn').addEventListener('click', useCurrentLocation);
$('getRouteBtn').addEventListener('click', getRoute);
$('shareOsmAndBtn').addEventListener('click', shareToOsmAnd);
$('destination').addEventListener('input', onDestinationInput);
document.addEventListener('click', (e) => {
  if (!e.target.closest('#destinationWrap')) $('destSuggestions').hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Non-fatal -- app still works without the service worker, just won't
    // pass Chrome's stricter installability check on every device.
  });
}

/**
 * Handles being opened via Android's Share sheet (registered as a
 * share_target in manifest.json) -- e.g. tapping Share on a place in
 * Google Maps and picking this app. This is the actual fix for "not smooth
 * enough": no manual copy/paste of a link at all, just the same Share
 * button already used for everything else. Chrome's GET-method share
 * target appends the shared data as query params to this same page.
 *
 * Falls through silently if there's nothing to handle (a normal open).
 */
async function handleIncomingShare() {
  const params = new URLSearchParams(location.search);
  const sharedTitle = params.get('shared_title') || '';
  const sharedText = params.get('shared_text') || '';
  const sharedUrl = params.get('shared_url') || '';
  const combined = [sharedUrl, sharedText, sharedTitle].filter(Boolean).join(' ');

  if (!combined) return; // normal open, nothing shared in

  // Clear the query string immediately so a page refresh/back doesn't replay it.
  history.replaceState({}, '', location.pathname);

  if (isShortenedMapsLink(combined)) {
    setStatus(
      'Shared a shortened link — Google/Apple sometimes send the short form even ' +
      'through Share. Open it in Maps once, then Share again.',
      true
    );
    return;
  }

  const pinned = extractLatLon(combined);
  if (!pinned) {
    setStatus(
      'Received a share but couldn’t find coordinates in it. Try sharing again from ' +
      'the place’s own page in Maps (not a search results list).',
      true
    );
    return;
  }

  const name = sharedTitle || sharedText || 'Shared location';
  selectedDestination = { lat: pinned.lat, lon: pinned.lon, name };
  $('destination').value = name;

  const gotLocation = await useCurrentLocation(`Got "${name}" — calculating route…`);
  if (gotLocation) await getRoute();
}

handleIncomingShare();
