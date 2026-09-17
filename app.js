// Camera Route -- calls FlockHopper's camera-avoidance routing API directly
// (client-side, no backend of ours needed -- api.dontgetflocked.com's CORS
// policy allows any origin, confirmed before building this), then hands the
// result to OsmAnd via the Web Share API so it can navigate the exact
// computed path. Google Maps link is a fallback approximation.
//
// GPX generation here mirrors deflock_maps' own gpxService.ts (MIT licensed,
// github.com/flockhopper3/deflock_maps) -- same as the Python CLI version
// this PWA is a mobile counterpart to.

// Bumped on every deploy and rendered at the bottom of the page. Exists
// purely as a diagnostic: after two confirmed stale-cache bugs this session
// (a fixed SW cache name that never changed, then GitHub Pages' HTTP cache
// being honored by a bare fetch()), "it's still not updating" reports can't
// be told apart from "still running old code" without a visible marker to
// check. If a reported bug's build ID doesn't match the latest deploy, it's
// caching, not logic -- if it matches, it's a real bug to find in this code.
const BUILD_ID = '2026-09-17.3';

const API_URL = 'https://api.dontgetflocked.com/api/v1/route';
const BRIDGE_WORKER_URL = 'https://flockavoid-bridge.cloudflare-harmony254.workers.dev';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
// Restricted to https://occamzrazor342.github.io/* via HTTP referrer + to the
// Places API (New) only, via API restriction -- safe to be visible in this
// public client-side file. Free OSM-based geocoders (Nominatim/Photon) kept
// as a fallback below, not primary -- confirmed directly that they frequently
// lack a specific business in a shared building even when Google has it.
const GOOGLE_PLACES_API_KEY = 'AIzaSyAA_CuzgXXdnr0ArJaVhzlbK02ctX5BOvM';
const GOOGLE_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const GOOGLE_TEXTSEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_MAPS_MAX_WAYPOINTS = 9;
const AUTOCOMPLETE_DEBOUNCE_MS = 400;
const AUTOCOMPLETE_MIN_CHARS = 3;

const $ = (id) => document.getElementById(id);

let currentOrigin = null;
let lastResult = null;
let selectedDestination = null; // set when the user picks a suggestion; cleared on manual edits

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
        // Clear any manually-typed origin text/suggestions -- otherwise
        // stale text could sit in the field not matching the GPS fix that's
        // actually about to be used for routing.
        $('origin').value = '';
        $('originSuggestions').hidden = true;
        $('originClear').hidden = true;
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

/** Autocomplete predictions only -- no coordinates yet (Google's Autocomplete
 * endpoint doesn't return them, by design, to keep the common per-keystroke
 * call cheap). Coordinates are fetched via getGooglePlaceDetails only for
 * the one suggestion actually selected, not every suggestion shown.
 *
 * Biased toward `currentOrigin` (a soft preference, not a hard restriction --
 * a real match far away still shows up, just ranked lower) -- confirmed this
 * was missing entirely and produced wrong results: "O'Reilly Auto" with no
 * bias returned Florida matches ahead of the correct Austin one, purely
 * because Google's Autocomplete has no location context by default and
 * falls back to generic relevance/popularity ranking, not proximity. */
async function searchGoogleAutocomplete(query) {
  const body = { input: query };
  if (currentOrigin) {
    body.locationBias = {
      circle: { center: { latitude: currentOrigin.lat, longitude: currentOrigin.lon }, radius: 50000.0 },
    };
  }
  const resp = await fetch(GOOGLE_AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({ name: p.text.text, placeId: p.placeId, needsDetails: true, lat: null, lon: null }));
}

async function getGooglePlaceDetails(placeId) {
  const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'location,displayName,formattedAddress',
    },
  });
  if (!resp.ok) throw new Error(`Place details failed (${resp.status})`);
  const data = await resp.json();
  return {
    lat: data.location.latitude,
    lon: data.location.longitude,
    name: data.formattedAddress || data.displayName?.text || placeId,
  };
}

/** One-shot geocode for the "typed/pasted and hit Get Route directly"
 * path -- Text Search rather than Autocomplete, since it returns a
 * location inline for a complete query with no separate details call
 * needed. Same currentOrigin bias as searchGoogleAutocomplete, for the
 * same reason. */
async function searchGoogleTextSearch(query) {
  const body = { textQuery: query };
  if (currentOrigin) {
    body.locationBias = {
      circle: { center: { latitude: currentOrigin.lat, longitude: currentOrigin.lon }, radius: 50000.0 },
    };
  }
  const resp = await fetch(GOOGLE_TEXTSEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': 'places.location,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.places || []).map((p) => ({
    lat: p.location.latitude,
    lon: p.location.longitude,
    name: p.formattedAddress || p.displayName?.text || query,
  }));
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

/** Live suggestions for the autocomplete dropdown. Google Places first --
 * confirmed directly (see git history/commit messages around this) that it
 * finds specific businesses in shared buildings/strip malls that Nominatim
 * and Photon both miss, since Google's database is licensed/verified
 * business data, not volunteer OSM tagging. Nominatim + Photon results are
 * still merged in after, since they occasionally have something Google's
 * result set doesn't surface first, and cost nothing extra to include.
 * Google suggestions carry a placeId instead of coordinates (see
 * searchGoogleAutocomplete) -- resolved lazily on selection, not here. */
async function searchSuggestions(query) {
  const [googleResults, nominatimResults, photonResults] = await Promise.all([
    searchGoogleAutocomplete(query).catch(() => []),
    searchNominatim(query).catch(() => []),
    searchPhoton(query).catch(() => []),
  ]);
  const seen = new Set();
  const combined = [];
  for (const r of [...googleResults, ...nominatimResults, ...photonResults]) {
    const key = r.placeId || `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
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
 * to the real URL. And critically, there's no "get the full URL instead"
 * workaround here: Google Maps' Share button shortens every link by design,
 * unconditionally, regardless of how you got to the place first (confirmed
 * before writing this comment -- re-sharing after opening a shortlink still
 * produces another shortlink). The only reliable fallback is dropping a pin
 * by long-pressing the exact spot on the map (not searching for it), which
 * shows raw coordinates in the search bar with no Share/shortlink pipeline
 * involved at all.
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
  const googleResults = await searchGoogleTextSearch(address).catch(() => []);
  if (googleResults.length) return { ...googleResults[0], name: googleResults[0].name || address };

  const nominatimResults = await searchNominatim(address, 1).catch(() => []);
  if (nominatimResults.length) return { ...nominatimResults[0], name: address };

  const photonResults = await searchPhoton(address, 1).catch(() => []);
  if (photonResults.length) return { ...photonResults[0], name: address };

  throw new Error(
    `Could not find "${address}" anywhere, including Google. Try picking from the ` +
    `suggestion dropdown as you type instead of typing the full address and pressing ` +
    `Get Route directly, or entering coordinates as "lat,lon".`
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

/** OsmAnd registers a real navigation deep link too, distinct from the
 * open-gpx one (confirmed directly in OsmAnd's source,
 * IntentHelper.parseNavigationIntent + buildRoute):
 * osmand.net/map/navigate?start=lat,lon&end=lat,lon&via=lat,lon;lat,lon;...
 * &profile=car. Unlike open-gpx this doesn't just import a track -- it
 * calls the exact same enterRoutePlanningModeGivenGpx(..., showMenu=true)
 * OsmAnd's own destination search uses, which is what actually produces the
 * live route-preview/turn-by-turn screen. No upload to our own worker, no
 * downloaded file, no notification tap -- one link, straight into
 * navigation.
 *
 * The real tradeoff, and it's a genuine one for a camera-avoidance app
 * specifically: `via` is a list of waypoints, not the literal recorded
 * path -- OsmAnd's own routing engine still chooses the road between each
 * pair, same caveat as the Google Maps link above. Given enough closely-
 * spaced via points there's normally only one sane road to take between
 * two of them, so it should track the real avoidance route closely, but
 * "should closely track" isn't "guaranteed identical" -- unlike the
 * downloaded GPX, which OsmAnd follows exactly because it's a real
 * recorded track, not a routing request. OSMAND_MAX_VIA_POINTS is
 * generous (no hard limit found in OsmAnd's own parser) but still
 * downsampled to keep the URL a sane length. */
const OSMAND_MAX_VIA_POINTS = 200;

function osmandNavigateUrl(origin, destination, geometry) {
  const interior = geometry.length > 2 ? geometry.slice(1, -1) : [];
  const via = downsample(interior, OSMAND_MAX_VIA_POINTS);
  const params = new URLSearchParams({
    start: `${origin.lat},${origin.lon}`,
    end: `${destination.lat},${destination.lon}`,
    profile: 'car',
  });
  if (via.length) {
    params.set('via', via.map(([lat, lon]) => `${lat},${lon}`).join(';'));
  }
  return `https://osmand.net/map/navigate?${params.toString()}`;
}

async function getRoute() {
  const destInput = $('destination').value.trim();
  const originInput = $('origin').value.trim();
  if (!destInput) {
    setStatus('Enter a destination first.', true);
    return;
  }

  // Typed an origin but hit Get Route before a suggestion was clicked (or
  // before the debounced dropdown even appeared) -- same direct-geocode
  // fallback destination already gets below, so typing fast doesn't require
  // waiting on the dropdown.
  if (!currentOrigin && originInput) {
    if (isShortenedMapsLink(originInput)) {
      setStatus(
        'That origin is a shortened Maps link, which can’t be read directly. Long-press the ' +
        'exact spot on the map to drop a pin, copy the coordinates, and paste those here instead.',
        true
      );
      return;
    }
    setStatus('Geocoding origin…');
    try {
      const pinnedOrigin = extractLatLon(originInput);
      currentOrigin = pinnedOrigin ? { ...pinnedOrigin, name: originInput } : await geocode(originInput);
      $('originLabel').textContent = `Origin: ${currentOrigin.name}`;
    } catch (err) {
      setStatus(`Could not find origin "${originInput}": ${err.message}`, true);
      return;
    }
  }

  if (!currentOrigin) {
    setStatus('Set your origin first (tap "Use current location" or type one).', true);
    return;
  }

  if (isShortenedMapsLink(destInput)) {
    setStatus(
      'Shortened Maps links (maps.app.goo.gl / goo.gl/maps) can’t be read directly, and ' +
      'Google Maps shortens every share link by design (re-sharing won’t give a different ' +
      'result). Instead: long-press the exact spot on the map to drop a pin, copy the ' +
      'coordinates shown in the search bar, and paste those here.',
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

/** Uploads the current route's GPX to the bridge worker and returns its
 * public URL. Shared by both OsmAnd hand-off paths below. */
async function uploadGPX(gpxContent) {
  const uploadResp = await fetch(`${BRIDGE_WORKER_URL}/gpx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gpx+xml' },
    body: gpxContent,
  });
  if (!uploadResp.ok) throw new Error(`Upload failed (${uploadResp.status})`);
  const { url } = await uploadResp.json();
  return url;
}

/** Primary path: osmand.net/map/navigate (see osmandNavigateUrl's comment
 * above for the full source-confirmed mechanism). No upload, no file, no
 * notification tap -- straight into OsmAnd's route-preview/turn-by-turn
 * screen off a single link tap. Supersedes an earlier osmand.net/open-gpx
 * version of this function, which only imported a track with no way to
 * start navigating it automatically -- confirmed live that this was
 * confusing standalone (a re-imported route with no visible change looked
 * exactly like nothing had happened). */
function navigateInOsmAnd() {
  if (!lastResult) return;
  const { origin, destination, avoidance } = lastResult;
  window.location.href = osmandNavigateUrl(origin, destination, avoidance.geometry);
  setStatus('Opening turn-by-turn in OsmAnd…');
}

/** Fallback path for when the via-points approximation above isn't good
 * enough -- the one case where it genuinely matters is a long/twisty
 * detour where a via-point gap could let OsmAnd's own engine reroute
 * through a camera the avoidance route specifically avoided. This forces
 * a real download (Content-Disposition: attachment) so Android's
 * "download complete -> Open" notification fires a VIEW intent with the
 * application/gpx+xml MIME type OsmAnd's manifest is registered for --
 * the same mechanism as opening a GPX email attachment -- and OsmAnd
 * follows the literal recorded track, not a re-routed approximation. */
async function downloadForOsmAnd() {
  if (!lastResult) return;
  const { origin, destination, avoidance, improvement } = lastResult;
  const name = `Camera-avoidance ${origin.name} to ${destination.name}`;
  const description = `${improvement.camerasAvoided} cameras avoided vs. the normal route`;
  const gpxContent = generateGPX(avoidance, name, description);

  try {
    setStatus('Uploading route…');
    const gpxUrl = await uploadGPX(gpxContent);

    // A fixed filename here (as this used to be) makes Chrome treat every
    // route as "you already downloaded this file, download again?" --
    // confirmed live, an extra confirmation tap every single time. The
    // server names the actual downloaded file uniquely per route (see the
    // worker's Content-Disposition header); this download attribute is
    // mostly ignored for a cross-origin URL like this one anyway, but kept
    // unique too rather than left stale and misleading.
    const link = document.createElement('a');
    link.href = gpxUrl;
    link.download = `route-${Date.now()}.gpx`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setStatus('Downloading the route… check your notifications, tap Open, then pick OsmAnd.');
  } catch (err) {
    setStatus(`Could not download the route: ${err.message}`, true);
  }
}

/** Wires a text input + suggestions dropdown to resolve a location from
 * typed text -- shared by origin and destination, since it's the exact same
 * operation (shortlink rejection, direct lat/lon extraction from a pasted
 * link, debounced Google/Nominatim/Photon suggestions with lazy place-detail
 * resolution on pick) applied to two different pieces of state. Previously
 * this existed only for the destination field; origin only had "Use current
 * location" with no way to type one in, despite getRoute()'s own error
 * message always having said "...or type one." */
function wireLocationInput({ input, suggestionsBox, clearBtn, onResolved, onCleared, resolvedStatus }) {
  let timer = null;

  function updateClearBtn() {
    if (clearBtn) clearBtn.hidden = input.value.length === 0;
  }

  function render(suggestions) {
    suggestionsBox.innerHTML = '';
    if (!suggestions.length) {
      suggestionsBox.hidden = true;
      return;
    }
    for (const s of suggestions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'suggestion-item';
      item.textContent = s.name;
      item.addEventListener('click', async () => {
        suggestionsBox.hidden = true;
        suggestionsBox.innerHTML = '';
        input.value = s.name;
        updateClearBtn();

        if (s.needsDetails) {
          // Google Autocomplete suggestions carry a placeId, not coordinates
          // yet (see searchGoogleAutocomplete) -- resolve them only now, for
          // the one place actually picked, not every suggestion shown.
          setStatus('Getting exact location…');
          try {
            const details = await getGooglePlaceDetails(s.placeId);
            onResolved({ ...details, name: s.name });
            setStatus(resolvedStatus(s.name));
          } catch (err) {
            setStatus(`Could not get exact location: ${err.message}`, true);
            onCleared();
          }
        } else {
          onResolved(s);
          setStatus(resolvedStatus(s.name));
        }
      });
      suggestionsBox.appendChild(item);
    }
    suggestionsBox.hidden = false;
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      onCleared();
      render([]);
      updateClearBtn();
      input.focus();
    });
  }
  updateClearBtn(); // initial state

  input.addEventListener('input', () => {
    onCleared(); // any manual edit invalidates a previously resolved location
    updateClearBtn();
    const query = input.value.trim();
    clearTimeout(timer);

    if (isShortenedMapsLink(query)) {
      render([]);
      setStatus(
        'That’s a shortened link — Google Maps shortens every share link by design, so ' +
        'there’s no full-URL version to get to. Long-press the exact spot on the map to drop ' +
        'a pin instead, copy the coordinates shown in the search bar, and paste those here.',
        true
      );
      return;
    }

    const pinned = extractLatLon(query);
    if (pinned) {
      onResolved({ ...pinned, name: query });
      render([]);
      setStatus(`Pinned exact location from link: ${pinned.lat.toFixed(5)}, ${pinned.lon.toFixed(5)}`);
      return;
    }

    if (query.length < AUTOCOMPLETE_MIN_CHARS) {
      render([]);
      return;
    }
    timer = setTimeout(async () => {
      try {
        const suggestions = await searchSuggestions(query);
        // Only render if the input hasn't changed since this search started.
        if (input.value.trim() === query) render(suggestions);
      } catch {
        render([]);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);
  });
}

wireLocationInput({
  input: $('origin'),
  suggestionsBox: $('originSuggestions'),
  clearBtn: $('originClear'),
  onResolved: (loc) => {
    currentOrigin = loc;
    $('originLabel').textContent = `Origin: ${loc.name}`;
  },
  onCleared: () => {
    currentOrigin = null;
    $('originLabel').textContent = 'Origin not set yet.';
  },
  resolvedStatus: (name) => `Origin set to "${name}". Enter a destination and tap Get Route.`,
});

wireLocationInput({
  input: $('destination'),
  suggestionsBox: $('destSuggestions'),
  clearBtn: $('destClear'),
  onResolved: (loc) => {
    selectedDestination = loc;
  },
  onCleared: () => {
    selectedDestination = null;
  },
  resolvedStatus: (name) => `Destination set to "${name}". Tap Get Route.`,
});

$('useLocationBtn').addEventListener('click', () => useCurrentLocation());
$('getRouteBtn').addEventListener('click', getRoute);
$('navigateOsmAndBtn').addEventListener('click', navigateInOsmAnd);
$('downloadOsmAndBtn').addEventListener('click', downloadForOsmAnd);
document.addEventListener('click', (e) => {
  if (!e.target.closest('#destinationWrap')) $('destSuggestions').hidden = true;
  if (!e.target.closest('#originWrap')) $('originSuggestions').hidden = true;
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
 * Real-world Google Maps shares are a shortlink (maps.app.goo.gl), which
 * can't be resolved to coordinates (see extractLatLon's docstring) -- but
 * critically, Android's share intent for a place doesn't send *just* the
 * link. It bundles the place name/address as plain text alongside it (e.g.
 * "O'Reilly Auto Parts, 13776 N Hwy 183 #119, Austin, TX · https://maps.app
 * .goo.gl/xxxx"). Earlier versions of this handler bailed out the moment
 * they saw a shortlink anywhere in the shared text, without ever looking at
 * that surrounding text -- which defeated the entire point of Share-to-app
 * for the common case. Fixed: strip the link out and geocode whatever text
 * remains via Google Places (the same lookup already proven to find a
 * specific business in a shared building), instead of demanding raw
 * coordinates. Only falls back to manual pin-drop instructions when there's
 * truly no usable text left after stripping the link.
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

  // Best case: a full (unshortened) link or bare coordinates -- exact,
  // no geocoding needed.
  const pinned = extractLatLon(combined);
  if (pinned) {
    const name = sharedTitle || sharedText || 'Shared location';
    selectedDestination = { lat: pinned.lat, lon: pinned.lon, name };
    $('destination').value = name;
    const gotLocation = await useCurrentLocation(`Got "${name}" — calculating route…`);
    if (gotLocation) await getRoute();
    return;
  }

  const searchableText = [sharedTitle, sharedText]
    .filter(Boolean)
    .join(', ')
    .replace(/https?:\/\/\S+/g, '')
    .trim()
    .replace(/^[,\s]+|[,\s]+$/g, '');

  if (!searchableText) {
    setStatus(
      'Received a share with no usable place name, just a link Google shortens by design ' +
      'and can’t be resolved automatically. Long-press the exact spot on the map to drop a ' +
      'pin instead, or open the app and type the destination.',
      true
    );
    return;
  }

  $('destination').value = searchableText;
  const gotLocation = await useCurrentLocation(`Got "${searchableText}" — looking up exact location…`);
  if (!gotLocation) return;

  try {
    setStatus('Looking up exact location…');
    const destination = await geocode(searchableText);
    selectedDestination = destination;
    $('destination').value = destination.name || searchableText;
    await getRoute();
  } catch (err) {
    setStatus(
      `Couldn’t find "${searchableText}" automatically (${err.message}). Long-press the ` +
      'exact spot on the map to drop a pin instead, or edit the destination below and pick ' +
      'from the suggestions dropdown.',
      true
    );
  }
}

handleIncomingShare();

/**
 * iOS Safari has never implemented the Web Share Target API (the piece
 * that lets an installed PWA register as a destination in the system share
 * sheet) -- confirmed current as of this build, not a config issue on this
 * app's end. Sharing a place from Google/Apple Maps straight into this app
 * only works on Android. Telling iPhone users this plainly up front beats
 * letting them hunt for a Share option that will never appear.
 */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
}

const platformNote = $('platformNote');
if (platformNote) {
  platformNote.textContent = isIOS()
    ? 'On iPhone: Share-from-Maps auto-fill isn’t available (Apple hasn’t implemented that API in ' +
      'Safari) — open this app directly and paste the address or Maps link into Destination below instead.'
    : 'Tip: tap Share on a place in Google Maps and pick Camera Route to auto-fill the destination.';
}

const buildIdEl = $('buildId');
if (buildIdEl) buildIdEl.textContent = `build ${BUILD_ID}`;
