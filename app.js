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

async function useCurrentLocation() {
  setStatus('Getting your location…');
  if (!navigator.geolocation) {
    setStatus('Geolocation not available in this browser.', true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentOrigin = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        name: 'Current location',
      };
      $('originLabel').textContent = `Origin: current location (${currentOrigin.lat.toFixed(4)}, ${currentOrigin.lon.toFixed(4)})`;
      setStatus('Location set. Enter a destination and tap Get Route.');
    },
    (err) => setStatus(`Could not get location: ${err.message}`, true),
    { enableHighAccuracy: true, timeout: 15000 }
  );
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
  const file = new File([gpxContent], `camera-route-${Date.now()}.gpx`, { type: 'application/gpx+xml' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name, text: description });
      setStatus('Shared. Pick OsmAnd, then tap Navigation → Start.');
    } catch (err) {
      if (err.name !== 'AbortError') setStatus(`Share failed: ${err.message}`, true);
    }
  } else {
    // Fallback for browsers without file-sharing support: download the GPX
    // so it can be opened manually (Files app -> Share -> OsmAnd).
    const url = URL.createObjectURL(new Blob([gpxContent], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('Your browser can’t share files directly — GPX downloaded instead. Open it from Files and share to OsmAnd manually.', true);
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
