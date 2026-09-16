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
const GOOGLE_MAPS_MAX_WAYPOINTS = 9;

const $ = (id) => document.getElementById(id);

let currentOrigin = null;
let lastResult = null;

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

async function geocode(address) {
  const params = new URLSearchParams({ q: address, format: 'json', limit: '1' });
  const resp = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`Geocoding failed (${resp.status})`);
  const results = await resp.json();
  if (!results.length) throw new Error(`Could not find address: ${address}`);
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), name: address };
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

  $('getRouteBtn').disabled = true;
  $('results').hidden = true;
  setStatus('Geocoding destination…');

  try {
    const destination = /^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(destInput)
      ? (() => {
          const [lat, lon] = destInput.split(',').map((s) => parseFloat(s.trim()));
          return { lat, lon, name: destInput };
        })()
      : await geocode(destInput);

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

$('useLocationBtn').addEventListener('click', useCurrentLocation);
$('getRouteBtn').addEventListener('click', getRoute);
$('shareOsmAndBtn').addEventListener('click', shareToOsmAnd);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Non-fatal -- app still works without the service worker, just won't
    // pass Chrome's stricter installability check on every device.
  });
}
