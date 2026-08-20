// Server-side helper for fetching and caching airport ground layout from
// OpenStreetMap via the Overpass API, plus a point-in-polygon helper for
// detecting which aircraft are parked on which stand.
//
// On-disk cache lives at `data/ground/<ICAO>.json`. Cache has no expiry;
// pass `{ forceRefresh: true }` (admin-only path on the API side) to re-fetch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GROUND_CACHE_DIR } from './paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = GROUND_CACHE_DIR;

/* Order matters: attempt N uses endpoint N, so the first entry is tried first
   and the last is only reached after three timeouts and their backoff — three
   minutes in the worst case. Benchmarked 2026-08-19 on an identical query:
   openstreetmap.fr 1.3s, private.coffee 32.6s, overpass-api.de 504,
   kumi.systems timed out past 40s. Re-measure if fetches start crawling; the
   mirrors' relative health does drift. All of them require a User-Agent. */
const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const USER_AGENT = 'WorldFlight-Planning/1.0 (+https://planning.worldflight.center)';
const FETCH_TIMEOUT_MS = 60000;
const MAX_RETRIES = 6;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchOverpass(query) {
  let backoff = INITIAL_BACKOFF_MS;
  const errors = [];
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[(attempt - 1) % OVERPASS_ENDPOINTS.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return res.json();
      const body = await res.text().catch(() => '');
      errors.push(`HTTP ${res.status} from ${endpoint}: ${body.slice(0,160)}`);
      if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      throw new Error(`Overpass HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      errors.push(`${endpoint}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }
  throw new Error(`Overpass failed: ${errors.slice(-2).join('; ')}`);
}

function geomToCoords(geometry) {
  return geometry.map(n => [n.lon, n.lat]);
}
function isClosed(geometry) {
  if (!geometry || geometry.length < 2) return false;
  const a = geometry[0], b = geometry[geometry.length - 1];
  return a.lat === b.lat && a.lon === b.lon;
}

// Widen a centerline (lat/lon nodes) into a closed polygon ring.
// OSM stores runways and taxiways as centerlines; we need polygons to render fill.
function widenLine(geometry, widthMeters) {
  const widthDeg = widthMeters / 111320 / 2;
  const left = [], right = [];
  for (let i = 0; i < geometry.length; i++) {
    const p = geometry[i];
    const next = geometry[Math.min(i + 1, geometry.length - 1)];
    const prev = geometry[Math.max(i - 1, 0)];
    const dx = next.lon - prev.lon;
    const dy = next.lat - prev.lat;
    const len = Math.sqrt(dx * dx + dy * dy) || 1e-9;
    const nx = -dy / len * widthDeg;
    const ny = dx / len * widthDeg;
    left.push([p.lon + nx, p.lat + ny]);
    right.push([p.lon - nx, p.lat - ny]);
  }
  return [...left, ...right.reverse(), left[0]];
}

// Score a stand `ref` to pick the "best" one when deduping near-duplicates.
// Longer is better; presence of a letter+digit pattern boosts the score; pure
// short/single-char refs are heavily penalised because they're almost always
// OSM mis-tags ("3" sitting on top of "303R").
function scoreStandRef(ref) {
  if (!ref) return -100;
  const trimmed = String(ref).trim();
  if (!trimmed) return -100;
  let score = trimmed.length * 2;
  if (trimmed.length === 1) score -= 20;
  if (/[A-Za-z]/.test(trimmed) && /\d/.test(trimmed)) score += 5;
  return score;
}

function standRefPoint(feature) {
  if (feature.geometry.type === 'Polygon') {
    const ring = feature.geometry.coordinates[0];
    let lat = 0, lon = 0;
    for (const c of ring) { lon += c[0]; lat += c[1]; }
    return [lat / ring.length, lon / ring.length];
  }
  if (feature.geometry.type === 'Point') {
    return [feature.geometry.coordinates[1], feature.geometry.coordinates[0]];
  }
  return null;
}

// Cluster stand features that sit within `radiusMeters` of each other and keep
// only the one with the highest-scoring ref. OSM commonly has overlapping
// tags at the same physical stand (e.g. ref="3" + ref="303R") and we don't
// want to render both.
function dedupeStands(features, radiusMeters = 12) {
  const stands = features.filter(f => f.properties?.kind === 'stand');
  const rest = features.filter(f => f.properties?.kind !== 'stand');
  if (stands.length < 2) return features;

  const points = stands.map(f => ({ feature: f, point: standRefPoint(f) }))
    .filter(s => s.point);

  const radDeg = radiusMeters / 111320;
  const radDegSq = radDeg * radDeg;

  const used = new Set();
  const kept = [];
  for (let i = 0; i < points.length; i++) {
    if (used.has(i)) continue;
    let best = i;
    let bestScore = scoreStandRef(points[i].feature.properties.ref);
    for (let j = i + 1; j < points.length; j++) {
      if (used.has(j)) continue;
      const dLat = points[i].point[0] - points[j].point[0];
      const dLon = (points[i].point[1] - points[j].point[1]) * Math.cos(points[i].point[0] * Math.PI / 180);
      if (dLat * dLat + dLon * dLon <= radDegSq) {
        const s = scoreStandRef(points[j].feature.properties.ref);
        if (s > bestScore) { best = j; bestScore = s; }
        used.add(j);
      }
    }
    used.add(i);
    kept.push(points[best].feature);
  }
  return [...rest, ...kept];
}

// Pick the parking-spot (nose-wheel) end of an unclosed parking_position line.
// OSM convention is "first = taxiway, last = nose-wheel" but isn't always
// followed (e.g. KDEN reverses it). Heuristic order:
//   1. Stand-endpoint clustering: gates pack tightly along a terminal, taxi
//      entries spread out — so whichever end has more other parking_position
//      endpoints nearby is the gate side. Works at any airport regardless of
//      OSM line direction.
//   2. Building proximity (gates against terminals).
//   3. OSM convention (last node).
function pickStandTip(line, otherEndpoints, buildingCentroids) {
  const first = line[0];
  const last = line[line.length - 1];

  if (otherEndpoints.length) {
    const radiusDegSq = (100 / 111320) ** 2;  // 100m
    let cFirst = 0, cLast = 0;
    for (const e of otherEndpoints) {
      const dF = (first.lat - e.lat) ** 2 + (first.lon - e.lon) ** 2;
      const dL = (last.lat - e.lat) ** 2 + (last.lon - e.lon) ** 2;
      if (dF < radiusDegSq) cFirst++;
      if (dL < radiusDegSq) cLast++;
    }
    if (cFirst !== cLast) return cFirst > cLast ? first : last;
  }

  if (buildingCentroids.length) {
    let dFirst = Infinity, dLast = Infinity;
    for (const c of buildingCentroids) {
      const dF = (first.lat - c.lat) ** 2 + (first.lon - c.lon) ** 2;
      const dL = (last.lat - c.lat) ** 2 + (last.lon - c.lon) ** 2;
      if (dF < dFirst) dFirst = dF;
      if (dL < dLast) dLast = dL;
    }
    if (dFirst !== dLast) return dFirst < dLast ? first : last;
  }

  return last;
}

function osmToGeoJSON(elements) {
  const features = [];

  // First pass: collect all parking_position endpoints (for stand-clustering)
  // and building centroids (fallback signal). The clustering heuristic is the
  // primary way pickStandTip distinguishes the gate end from the taxi end.
  const allStandEndpoints = [];
  const buildingCentroids = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    if ((tags.aeroway === 'parking_position' || tags.aeroway === 'gate') && !isClosed(el.geometry)) {
      allStandEndpoints.push(el.geometry[0]);
      allStandEndpoints.push(el.geometry[el.geometry.length - 1]);
    }
    const building = tags.building || '';
    if (building && building !== 'no' && isClosed(el.geometry)) {
      let lat = 0, lon = 0;
      for (const n of el.geometry) { lat += n.lat; lon += n.lon; }
      buildingCentroids.push({ lat: lat / el.geometry.length, lon: lon / el.geometry.length });
    }
  }

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    const aeroway = tags.aeroway || '';
    const building = tags.building || '';
    const props = {
      osm_id: el.id,
      ref: tags.ref || '',
      name: tags.name || ''
    };

    if (aeroway === 'runway') {
      const ring = isClosed(el.geometry)
        ? geomToCoords(el.geometry)
        : widenLine(el.geometry, parseFloat(tags.width) || 45);
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { ...props, kind: 'runway' } });
    } else if (aeroway === 'taxiway') {
      const ring = isClosed(el.geometry)
        ? geomToCoords(el.geometry)
        : widenLine(el.geometry, parseFloat(tags.width) || 23);
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { ...props, kind: 'taxiway' } });
    } else if (aeroway === 'apron') {
      if (isClosed(el.geometry)) {
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [geomToCoords(el.geometry)] }, properties: { ...props, kind: 'apron' } });
      }
    } else if (aeroway === 'parking_position' || aeroway === 'gate') {
      // Drop OSM stand entries with no usable ref label — they're untagged
      // taxiway joins or noise. Real stands always have an alphanumeric ref.
      const refTrimmed = (tags.ref || '').trim();
      if (!refTrimmed) continue;
      // OSM convention for parking_position lines is "first = taxiway entry,
      // last = nose-wheel", but it isn't followed everywhere (KDEN reverses
      // it). pickStandTip picks the end closer to a building, which is the
      // gate side regardless of how the way was drawn.
      if (isClosed(el.geometry)) {
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [geomToCoords(el.geometry)] }, properties: { ...props, kind: 'stand' } });
      } else {
        const tip = pickStandTip(el.geometry, allStandEndpoints, buildingCentroids);
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [tip.lon, tip.lat] }, properties: { ...props, kind: 'stand' } });
      }
    } else if (building && building !== 'no') {
      if (isClosed(el.geometry)) {
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [geomToCoords(el.geometry)] }, properties: { ...props, kind: 'building' } });
      }
    }
  }
  return { type: 'FeatureCollection', features: dedupeStands(features) };
}

function readCache(icao) {
  const f = path.join(CACHE_DIR, `${icao}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf-8')); }
  catch { return null; }
}

function writeCache(icao, geo) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path.join(CACHE_DIR, `${icao}.json`), JSON.stringify(geo));
}

// Half-size of the search box, in degrees of latitude. ~9 km, so the 18 km box
// comfortably contains even the largest airports (KDEN is roughly 12x11 km).
const GROUND_BOX_DEG = 0.08;

function groundBbox(lat, lon) {
  const dLat = GROUND_BOX_DEG;
  // Keep the box square on the ground rather than in degrees.
  const dLon = GROUND_BOX_DEG / Math.max(0.15, Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => v.toFixed(5)).join(',');
}

/* A box big enough for the biggest airport also catches whatever sits next
   door, so drop buildings that are nowhere near the aeroway features. This
   runs before osmToGeoJSON on purpose: its stand heuristic falls back to
   building proximity, and off-airport buildings would skew it. */
function keepAirportElements(elements) {
  // Cell roughly 220 m square. A candidate is kept when one of its nodes lands
  // in a cell that holds aeroway geometry, or in any of the eight neighbours —
  // so terminals and piers beside a stand survive while the city beyond does
  // not. A bounding box around the aeroway features is far too generous for
  // airports embedded in a city: OMDB pulled in 18,376 Dubai buildings.
  const CELL = 0.002;
  let latRef = null;
  for (const el of elements) {
    if (el.tags && el.tags.aeroway && el.geometry && el.geometry.length) { latRef = el.geometry[0].lat; break; }
  }
  if (latRef === null) return elements;              // no aeroway found — keep everything
  const lonCell = CELL / Math.max(0.15, Math.cos(latRef * Math.PI / 180));
  const key = (lat, lon) => Math.floor(lat / CELL) + ':' + Math.floor(lon / lonCell);

  const near = new Set();
  for (const el of elements) {
    if (!el.tags || !el.tags.aeroway || !el.geometry) continue;
    for (const n of el.geometry) near.add(key(n.lat, n.lon));
  }
  const touches = (n) => {
    const r = Math.floor(n.lat / CELL), c = Math.floor(n.lon / lonCell);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (near.has((r + dr) + ':' + (c + dc))) return true;
    }
    return false;
  };
  return elements.filter(el => {
    if (el.tags && el.tags.aeroway) return true;
    if (!el.geometry || !el.geometry.length) return false;
    return el.geometry.some(touches);
  });
}

/**
 * Fetch the airport ground layout as GeoJSON. Disk-cached per ICAO.
 * @param {string} icao
 * @param {{forceRefresh?: boolean, lat?: number, lon?: number}} opts
 *   Pass lat/lon where known — it swaps a slow area[icao=] lookup for a bbox.
 * @returns {Promise<{type:'FeatureCollection',features:any[]}>}
 */
export async function getAirportGround(icao, { forceRefresh = false, lat = null, lon = null } = {}) {
  icao = String(icao || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(icao)) throw new Error('Invalid ICAO');
  if (!forceRefresh) {
    const cached = readCache(icao);
    if (cached) return cached;
  }

  /* Prefer a bounding box over area[icao=...]. Overpass resolves an ICAO tag
     into an area using a separately-generated dataset that the public mirrors
     build inconsistently, and it is by far the slowest part of the query —
     measured on EGLL, the same result took 32s via area and 1.3s via bbox,
     with two mirrors failing outright on the area form. Falls back to the
     area query when the caller has no coordinates. */
  const haveCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  let query;
  if (haveCoords) {
    const bb = groundBbox(Number(lat), Number(lon));
    query = `
[out:json][timeout:60];
(
  way[aeroway=runway](${bb});
  way[aeroway=taxiway](${bb});
  way[aeroway=apron](${bb});
  way[aeroway=parking_position](${bb});
  way[aeroway=gate](${bb});
  way[building][building!=no](${bb});
);
out body geom;
`;
  } else {
    query = `
[out:json][timeout:60];
area[icao="${icao}"]->.airport;
(
  way(area.airport)[aeroway=runway];
  way(area.airport)[aeroway=taxiway];
  way(area.airport)[aeroway=apron];
  way(area.airport)[aeroway=parking_position];
  way(area.airport)[aeroway=gate];
  way(area.airport)[building][building!=no];
);
out body geom;
`;
  }
  const data = await fetchOverpass(query);
  const elements = haveCoords ? keepAirportElements(data.elements || []) : (data.elements || []);
  const geo = osmToGeoJSON(elements);
  writeCache(icao, geo);
  return geo;
}

// Ray-casting point-in-polygon. Ring is [[lon,lat], ...].
function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat))
      && (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Decide which stands are occupied by which aircraft.
 * @param {object} geojson - ground GeoJSON from getAirportGround
 * @param {Array<{lat:number,lon:number,callsign:string,cid?:number,groundspeed?:number}>} aircraft
 * @returns {Object<string, {callsign:string, cid?:number, groundspeed?:number}>}
 *          Map of stand osm_id -> aircraft details for occupied stands.
 */
// Approximate metres-per-degree at a given latitude. lon scales with cos(lat).
function latLonDistMeters(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * 111320;
  const dx = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

// Return [lat, lon] centroid of a Polygon ring (rough, average of vertices).
function polyCentroid(ring) {
  let lat = 0, lon = 0;
  for (const c of ring) { lon += c[0]; lat += c[1]; }
  return [lat / ring.length, lon / ring.length];
}

/**
 * Decide which stands are occupied by which aircraft. Algorithm:
 *   1. For each aircraft on the ground (groundspeed <= maxGroundspeed) that
 *      is genuinely inside a polygon stand → that stand is occupied.
 *   2. Otherwise, find the *nearest* stand within `nearestStandToleranceMeters`
 *      and assign the aircraft to it.
 *
 * The "nearest within tolerance" step is critical because OSM
 * `aeroway=parking_position` data is noisy — point positions can be 30–80 m
 * away from where the aircraft actually parks (especially for widebodies),
 * and OSM rarely maps the actual painted polygon. A small fixed radius misses
 * legitimate occupants; nearest-stand handles the imprecision gracefully.
 *
 * @param {object} geojson - ground GeoJSON from getAirportGround
 * @param {Array<{lat:number,lon:number,callsign:string,cid?:number,groundspeed?:number}>} aircraft
 */
export function detectStandOccupancy(geojson, aircraft, {
  // ≤3 kt = genuinely stationary, not "slow-taxiing close to a stand".
  // Aircraft pulling on/off stand can briefly tag at 5–10 kt, but in those
  // moments they're not really "parked" yet, and matching them to whichever
  // stand they happen to be nearest creates false positives.
  maxGroundspeed = 3,
  // 70 m tolerance: tight enough to avoid grabbing a neighbouring stand or
  // an aircraft holding short on the taxiway, generous enough to absorb the
  // typical 30–50 m offset between OSM's parking dot and a parked widebody's
  // GPS centre.
  nearestStandToleranceMeters = 70
} = {}) {
  const stands = (geojson?.features || []).filter(f => f.properties?.kind === 'stand');
  const occupancy = {};
  if (!stands.length || !aircraft.length) return occupancy;

  const candidates = aircraft.filter(a =>
    typeof a.lat === 'number' && typeof a.lon === 'number'
    && (typeof a.groundspeed !== 'number' || a.groundspeed <= maxGroundspeed)
  );
  if (!candidates.length) return occupancy;

  // Pre-compute each stand's reference point (centroid for polygons, the
  // point coord for points) so the nearest-stand search is a flat list.
  const standRefs = stands.map(f => {
    let lat, lon;
    if (f.geometry.type === 'Polygon') {
      [lat, lon] = polyCentroid(f.geometry.coordinates[0]);
    } else if (f.geometry.type === 'Point') {
      lon = f.geometry.coordinates[0];
      lat = f.geometry.coordinates[1];
    }
    return { feature: f, lat, lon };
  }).filter(s => typeof s.lat === 'number' && typeof s.lon === 'number');

  for (const ac of candidates) {
    // Always pick the single nearest stand (within tolerance) and only count
    // it as occupied if the aircraft is also genuinely close. Polygon stands
    // get a preference: if the aircraft is inside a polygon, that wins
    // regardless of nearest-point distance to other stands.
    let matched = null;
    let matchedDist = Infinity;
    for (const s of standRefs) {
      if (s.feature.geometry.type === 'Polygon'
          && pointInPolygon(ac.lon, ac.lat, s.feature.geometry.coordinates[0])) {
        matched = s;
        matchedDist = 0;
        break;
      }
      const d = latLonDistMeters(ac.lat, ac.lon, s.lat, s.lon);
      if (d < matchedDist && d <= nearestStandToleranceMeters) {
        matched = s;
        matchedDist = d;
      }
    }
    if (matched) {
      const id = matched.feature.properties.osm_id;
      // If the same stand attracts more than one candidate, the closer one wins.
      const prev = occupancy[id];
      if (!prev || (prev._dist != null && matchedDist < prev._dist)) {
        occupancy[id] = {
          callsign: ac.callsign,
          cid: ac.cid,
          groundspeed: ac.groundspeed,
          _dist: matchedDist
        };
      }
    }
  }
  // Strip the internal _dist field before returning.
  for (const k of Object.keys(occupancy)) delete occupancy[k]._dist;
  return occupancy;
}
