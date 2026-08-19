import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decimalToDMS, coordPair } from './lib/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ICAO = process.argv[2] || 'EGLL';

// Mirror pool — rotated on 504/429/timeout. Override with OVERPASS_URL (single endpoint).
const OVERPASS_ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      // Fastest first — see the note in lib/osm-ground.mjs. Benchmarked
      // 2026-08-19; re-measure if fetches start crawling.
      'https://overpass.openstreetmap.fr/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ];

const USER_AGENT = 'WorldFlight-Planning/1.0 (+https://planning.worldflight.center)';
const FETCH_TIMEOUT_MS = 60000;

// EuroScope colour definitions (RGB as decimal)
const COLOURS = {
  runway: 'smrRunway',
  rwyedge: 'smrRwyEdge',
  taxiway: 'smrTaxiway',
  apron: 'smrApron',
  building: 'smrBuilding',
  grass: 'smrGrass',
  outline: '6579300',   // medium grey for outlines
  twyline: '17219',     // amber for taxiway centerlines
  standlabel: '16777215' // white
};

const MAX_RETRIES = 6;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Check an endpoint's /api/status — if it reports a waiting slot, sleep until it frees up.
// Best-effort: any failure here is ignored so we still try the main query.
async function waitForSlot(endpoint) {
  const statusUrl = endpoint.replace(/\/interpreter\/?$/, '/status');
  if (statusUrl === endpoint) return; // non-standard endpoint, skip
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(statusUrl, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
    clearTimeout(timer);
    if (!res.ok) return;
    const txt = await res.text();
    // Slot free signals: "N slots available now."
    if (/slots? available now/i.test(txt)) return;
    // Busy signals: "Slot available after: ... in <N> seconds."
    const m = txt.match(/in (\d+) seconds/i);
    if (m) {
      const waitSecs = Math.min(Number(m[1]) + 1, 30);
      if (waitSecs > 0) {
        console.log(`  Overpass status: ${endpoint} busy, waiting ${waitSecs}s for a slot...`);
        await sleep(waitSecs * 1000);
      }
    }
  } catch { /* best-effort */ }
}

async function fetchOverpass(query) {
  let backoff = INITIAL_BACKOFF_MS;
  const errors = [];
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[(attempt - 1) % OVERPASS_ENDPOINTS.length];
    console.log(`  [attempt ${attempt}/${MAX_RETRIES}] ${endpoint}`);
    await waitForSlot(endpoint);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (res.ok) {
        console.log(`    OK in ${secs}s`);
        return res.json();
      }
      const body = await res.text().catch(() => '');
      const snippet = body.slice(0, 160).replace(/\s+/g, ' ');
      errors.push(`HTTP ${res.status} from ${endpoint}: ${snippet}`);
      if ([429, 502, 503, 504].includes(res.status)) {
        console.log(`    ${res.status} after ${secs}s — backoff ${Math.round(backoff / 1000)}s, will rotate mirror.`);
        if (attempt < MAX_RETRIES) await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      // Other HTTP errors: fail fast (likely query syntax or endpoint-specific)
      throw new Error(`Overpass HTTP ${res.status}: ${snippet}`);
    } catch (err) {
      clearTimeout(timer);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const isAbort = err.name === 'AbortError';
      const label = isAbort ? `client timeout after ${secs}s` : err.message;
      errors.push(`${endpoint}: ${label}`);
      console.log(`    ${label} — backoff ${Math.round(backoff / 1000)}s, will rotate mirror.`);
      if (attempt < MAX_RETRIES) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
    }
  }
  throw new Error(`Overpass failed across ${OVERPASS_ENDPOINTS.length} mirror(s) after ${MAX_RETRIES} attempts. Last errors:\n  - ${errors.slice(-3).join('\n  - ')}`);
}

async function findAirportInOSM(icao) {
  // Lightweight probe — short server-side budget so an unreachable airport fails
  // fast. `out center` also hands back a coordinate, which the main query needs
  // for its bounding box, so this costs no extra round trip.
  const query = `[out:json][timeout:15];(way[icao="${icao}"];relation[icao="${icao}"];node[icao="${icao}"];);out center;`;
  const data = await fetchOverpass(query);
  const els = data.elements || [];
  if (!els.length) return null;
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return { lat: null, lon: null };   // present in OSM but no usable centre
}

// ~9 km either side, so the 18 km box holds even the largest airports.
const GROUND_BOX_DEG = 0.08;
function groundBbox(lat, lon) {
  const dLon = GROUND_BOX_DEG / Math.max(0.15, Math.cos(lat * Math.PI / 180));
  return [lat - GROUND_BOX_DEG, lon - dLon, lat + GROUND_BOX_DEG, lon + dLon]
    .map(v => v.toFixed(5)).join(',');
}

// A box that fits the biggest airport also catches the neighbours, so drop
// non-aeroway features that sit well away from the airport itself.
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

function coordToES(lat, lon) {
  return coordPair(lat, lon);
}

function processWay(element) {
  if (!element.geometry || element.geometry.length < 3) return null;
  return element.geometry.map(n => coordToES(n.lat, n.lon));
}

async function main() {
  console.log(`=== Fetching ground layout for ${ICAO} ===\n`);

  // Check for cached OSM data
  const cacheDir = path.join(__dirname, '..', 'Euroscope_Files', 'WorldFlight', 'cache');
  const cachePath = path.join(cacheDir, `${ICAO}_osm.json`);
  fs.mkdirSync(cacheDir, { recursive: true });

  let data;
  if (fs.existsSync(cachePath) && !process.argv.includes('--fresh')) {
    console.log('  Using cached OSM data (use --fresh to re-fetch)');
    data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } else {
    // Check if airport exists in OSM first
    console.log('  Checking if ICAO exists in OSM...');
    const centre = await findAirportInOSM(ICAO);
    if (!centre) {
      console.log(`  ${ICAO} not found in OSM database — skipping ground layout`);
      process.exit(2); // Exit code 2 = ICAO not in OSM (skip, not an error)
    }

    // Query OSM for airport features — 60s server-side budget is enough for 99% of airports.
    // If a specific airport exceeds this, the client retry/rotation will eventually land on a
    // faster mirror or a less-loaded slot.
    // Bounding box rather than area[icao=...]: Overpass resolves an ICAO tag
    // into an area via a separately-built dataset that the public mirrors keep
    // inconsistently, and it dominates the query cost. Measured on EGLL the
    // same result came back in 1.3s by bbox against 32s by area, with two of
    // the four mirrors failing the area form outright.
    const useBbox = Number.isFinite(centre.lat) && Number.isFinite(centre.lon);
    const bb = useBbox ? groundBbox(centre.lat, centre.lon) : null;
    const query = useBbox ? `
[out:json][timeout:60];
(
  way[aeroway=runway](${bb});
  way[aeroway=taxiway](${bb});
  way[aeroway=apron](${bb});
  way[aeroway=terminal](${bb});
  way[building][building!=no](if:t["aeroway"]!="terminal")(${bb});
  way[landuse=grass](${bb});
  way[aeroway=parking_position](${bb});
  way[aeroway=gate](${bb});
  relation[aeroway=apron](${bb});
  relation[building](${bb});
);
out body geom;
` : `
[out:json][timeout:60];
area[icao="${ICAO}"]->.airport;
(
  way(area.airport)[aeroway=runway];
  way(area.airport)[aeroway=taxiway];
  way(area.airport)[aeroway=apron];
  way(area.airport)[aeroway=terminal];
  way(area.airport)[building][building!=no](if:t["aeroway"]!="terminal");
  way(area.airport)[landuse=grass];
  way(area.airport)[aeroway=parking_position];
  way(area.airport)[aeroway=gate];
  relation(area.airport)[aeroway=apron];
  relation(area.airport)[building];
);
out body geom;
`;

    data = await fetchOverpass(query);
    if (useBbox) {
      const before = (data.elements || []).length;
      data.elements = keepAirportElements(data.elements || []);
      const dropped = before - data.elements.length;
      if (dropped) console.log(`  Filtered out ${dropped} feature(s) outside the airport`);
    }
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
    console.log(`  Got ${data.elements.length} elements from OSM (cached)\n`);
  }

  // Categorise elements
  const runways = [];
  const taxiways = [];
  const taxiwayLines = [];
  const aprons = [];
  const buildings = [];
  const grass = [];
  const stands = [];

  for (const el of data.elements) {
    const tags = el.tags || {};
    const aeroway = tags.aeroway || '';
    const building = tags.building || '';
    const landuse = tags.landuse || '';

    if (el.type === 'way') {
      const pts = processWay(el);
      if (!pts) continue;

      if (aeroway === 'runway') {
        // Runways are usually lines, not closed polygons - make them into regions
        // Check if it's a closed way (polygon) or a line
        const isPolygon = el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat &&
                          el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;
        if (isPolygon) {
          runways.push({ name: tags.ref || 'RWY', pts, id: el.id, rawGeom: el.geometry, width: parseFloat(tags.width) || 45 });
        } else {
          // It's a centerline - we can create a thin polygon from it or just use it as a line
          // For runways, OSM often gives the centerline. We need to widen it.
          const width = parseFloat(tags.width) || 45; // metres
          const widthDeg = width / 111320 / 2; // rough conversion to degrees
          const widened = [];
          for (let i = 0; i < el.geometry.length; i++) {
            const p = el.geometry[i];
            const next = el.geometry[Math.min(i + 1, el.geometry.length - 1)];
            const dx = next.lon - p.lon;
            const dy = next.lat - p.lat;
            const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
            const nx = -dy / len * widthDeg;
            const ny = dx / len * widthDeg;
            widened.push({ lat: p.lat + nx, lon: p.lon + ny });
          }
          for (let i = el.geometry.length - 1; i >= 0; i--) {
            const p = el.geometry[i];
            const next = el.geometry[Math.max(i - 1, 0)];
            const dx = next.lon - p.lon;
            const dy = next.lat - p.lat;
            const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
            const nx = dy / len * widthDeg;
            const ny = -dx / len * widthDeg;
            widened.push({ lat: p.lat + nx, lon: p.lon + ny });
          }
          // Close the polygon
          widened.push({ lat: widened[0].lat, lon: widened[0].lon });
          runways.push({ name: tags.ref || 'RWY', pts: widened.map(p => coordToES(p.lat, p.lon)), id: el.id, rawGeom: el.geometry, width: parseFloat(tags.width) || 45 });
        }
      } else if (aeroway === 'taxiway') {
        // Taxiways - save as lines for centerlines, and try to make polygons
        taxiwayLines.push({ name: tags.ref || '', pts, id: el.id, raw: el.geometry });

        // Also create widened polygon
        const width = parseFloat(tags.width) || 20; // metres
        const widthDeg = width / 111320 / 2;
        const widened = [];
        for (let i = 0; i < el.geometry.length; i++) {
          const p = el.geometry[i];
          const next = el.geometry[Math.min(i + 1, el.geometry.length - 1)];
          const dx = next.lon - p.lon;
          const dy = next.lat - p.lat;
          const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
          const nx = -dy / len * widthDeg;
          const ny = dx / len * widthDeg;
          widened.push({ lat: p.lat + nx, lon: p.lon + ny });
        }
        for (let i = el.geometry.length - 1; i >= 0; i--) {
          const p = el.geometry[i];
          const next = el.geometry[Math.max(i - 1, 0)];
          const dx = next.lon - p.lon;
          const dy = next.lat - p.lat;
          const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
          const nx = dy / len * widthDeg;
          const ny = -dx / len * widthDeg;
          widened.push({ lat: p.lat + nx, lon: p.lon + ny });
        }
        // Close the polygon
        widened.push({ lat: widened[0].lat, lon: widened[0].lon });
        taxiways.push({ name: tags.ref || '', pts: widened.map(p => coordToES(p.lat, p.lon)), id: el.id });
      } else if (aeroway === 'apron' || aeroway === 'terminal') {
        aprons.push({ name: tags.name || '', pts, id: el.id });
      } else if (building && building !== 'no') {
        buildings.push({ name: tags.name || '', pts, id: el.id });
      } else if (landuse === 'grass') {
        grass.push({ name: '', pts, id: el.id });
      } else if (aeroway === 'parking_position' || aeroway === 'gate') {
        if (el.geometry.length > 0) {
          stands.push({ name: tags.ref || tags.name || '', lat: el.geometry[0].lat, lon: el.geometry[0].lon });
        }
      }
    } else if (el.type === 'relation' && el.members) {
      // Handle multipolygon relations (aprons, buildings)
      for (const member of el.members) {
        if (member.type === 'way' && member.geometry && member.geometry.length >= 3) {
          const pts = member.geometry.map(n => coordToES(n.lat, n.lon));
          const tags2 = el.tags || {};
          if (tags2.aeroway === 'apron') aprons.push({ name: tags2.name || '', pts, id: el.id });
          else if (tags2.building) buildings.push({ name: tags2.name || '', pts, id: el.id });
        }
      }
    }
  }

  console.log(`  Runways:     ${runways.length}`);
  console.log(`  Taxiways:    ${taxiways.length} (${taxiwayLines.length} centerlines)`);
  console.log(`  Aprons:      ${aprons.length}`);
  console.log(`  Buildings:   ${buildings.length}`);
  console.log(`  Grass:       ${grass.length}`);
  console.log(`  Stands:      ${stands.length}`);

  // Generate EuroScope output
  const lines = [];
  lines.push(`; ${ICAO} Ground Layout — Generated from OpenStreetMap`);
  lines.push(`; OSM data © OpenStreetMap contributors`);
  lines.push('');

  // REGIONS (filled polygons) — order matters: grass first (background), then aprons, taxiways, runways, buildings on top
  lines.push('; === REGIONS (paste into [REGIONS] section) ===');
  lines.push('');

  // Grass (background - render first)
  for (const g of grass) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.grass} ${g.pts[0]}`);
    for (let j = 1; j < g.pts.length; j++) lines.push(` ${g.pts[j]}`);
    lines.push('');
  }

  // Aprons
  for (const a of aprons) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.apron} ${a.pts[0]}`);
    for (let j = 1; j < a.pts.length; j++) lines.push(` ${a.pts[j]}`);
    lines.push('');
  }

  // Taxiways
  for (const t of taxiways) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.taxiway} ${t.pts[0]}`);
    for (let j = 1; j < t.pts.length; j++) lines.push(` ${t.pts[j]}`);
    lines.push('');
  }

  // Buildings (before runways so runways render on top)
  for (const b of buildings) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.building} ${b.pts[0]}`);
    for (let j = 1; j < b.pts.length; j++) lines.push(` ${b.pts[j]}`);
    lines.push('');
  }

  // Runways — surface fill (LAST so they render on top of taxiways)
  for (const r of runways) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.runway} ${r.pts[0]}`);
    for (let j = 1; j < r.pts.length; j++) lines.push(` ${r.pts[j]}`);
    lines.push('');
  }

  // Runway edge rectangles — thin white border regions on top
  for (const r of runways) {
    if (r.rawGeom && r.rawGeom.length >= 2) {
      const geom = r.rawGeom;
      const width = r.width || 45;
      const widthDeg = width / 111320 / 2;
      const first = geom[0], last = geom[geom.length - 1];
      const dx = last.lon - first.lon, dy = last.lat - first.lat;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const nx = -dy / len * widthDeg, ny = dx / len * widthDeg;

      // Outer rectangle
      const o1 = { lat: first.lat + nx, lon: first.lon + ny };
      const o2 = { lat: last.lat + nx, lon: last.lon + ny };
      const o3 = { lat: last.lat - nx, lon: last.lon - ny };
      const o4 = { lat: first.lat - nx, lon: first.lon - ny };

      // Inner rectangle (slightly smaller)
      const border = 0.25; // fraction of width for border thickness
      const inx = nx * (1 - border), iny = ny * (1 - border);
      const i1 = { lat: first.lat + inx, lon: first.lon + iny };
      const i2 = { lat: last.lat + inx, lon: last.lon + iny };
      const i3 = { lat: last.lat - inx, lon: last.lon - iny };
      const i4 = { lat: first.lat - inx, lon: first.lon - iny };

      // Top edge strip
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o1.lat, o1.lon)}`);
      lines.push(` ${coordToES(o2.lat, o2.lon)}`);
      lines.push(` ${coordToES(i2.lat, i2.lon)}`);
      lines.push(` ${coordToES(i1.lat, i1.lon)}`);
      lines.push('');

      // Bottom edge strip
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o4.lat, o4.lon)}`);
      lines.push(` ${coordToES(o3.lat, o3.lon)}`);
      lines.push(` ${coordToES(i3.lat, i3.lon)}`);
      lines.push(` ${coordToES(i4.lat, i4.lon)}`);
      lines.push('');

      // Left end cap
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o1.lat, o1.lon)}`);
      lines.push(` ${coordToES(o4.lat, o4.lon)}`);
      lines.push(` ${coordToES(i4.lat, i4.lon)}`);
      lines.push(` ${coordToES(i1.lat, i1.lon)}`);
      lines.push('');

      // Right end cap
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o2.lat, o2.lon)}`);
      lines.push(` ${coordToES(o3.lat, o3.lon)}`);
      lines.push(` ${coordToES(i3.lat, i3.lon)}`);
      lines.push(` ${coordToES(i2.lat, i2.lon)}`);
      lines.push('');
    }
  }

  lines.push('');
  lines.push('; === GEO (paste into [GEO] section) ===');
  lines.push('');

  // Runway outlines — draw a complete rectangle around each runway
  for (const r of runways) {
    if (r.rawGeom && r.rawGeom.length >= 2) {
      const geom = r.rawGeom;
      const width = r.width || 45;
      const widthDeg = width / 111320 / 2;
      const first = geom[0], last = geom[geom.length - 1];
      const dx = last.lon - first.lon, dy = last.lat - first.lat;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const nx = -dy / len * widthDeg, ny = dx / len * widthDeg;

      // Four corners of the runway rectangle
      const c1 = { lat: first.lat + nx, lon: first.lon + ny };
      const c2 = { lat: first.lat - nx, lon: first.lon - ny };
      const c3 = { lat: last.lat - nx, lon: last.lon - ny };
      const c4 = { lat: last.lat + nx, lon: last.lon + ny };

      const corners = [c1, c4, c3, c2, c1]; // closed rectangle
      for (let i = 0; i < corners.length - 1; i++) {
        const p1 = coordToES(corners[i].lat, corners[i].lon);
        const p2 = coordToES(corners[i + 1].lat, corners[i + 1].lon);
        lines.push(`${p1} ${p2} ${COLOURS.rwyedge} ; RWY outline`);
      }

      // Runway centerline
      for (let i = 0; i < geom.length - 1; i++) {
        const p1 = coordToES(geom[i].lat, geom[i].lon);
        const p2 = coordToES(geom[i + 1].lat, geom[i + 1].lon);
        lines.push(`${p1} ${p2} 16777215 ; RWY CL`);
      }

      // Threshold marks (short cross lines at each end)
      const threshLen = widthDeg * 0.8;
      const t1a = coordToES(first.lat + nx * 0.8, first.lon + ny * 0.8);
      const t1b = coordToES(first.lat - nx * 0.8, first.lon - ny * 0.8);
      lines.push(`${t1a} ${t1b} 16777215 ; RWY threshold`);
      const t2a = coordToES(last.lat + nx * 0.8, last.lon + ny * 0.8);
      const t2b = coordToES(last.lat - nx * 0.8, last.lon - ny * 0.8);
      lines.push(`${t2a} ${t2b} 16777215 ; RWY threshold`);
    }
  }

  // Taxiway centerlines
  for (const t of taxiwayLines) {
    for (let i = 0; i < t.raw.length - 1; i++) {
      const p1 = coordToES(t.raw[i].lat, t.raw[i].lon);
      const p2 = coordToES(t.raw[i + 1].lat, t.raw[i + 1].lon);
      lines.push(`${p1} ${p2} ${COLOURS.twyline} ; TWY ${t.name}`);
    }
  }

  lines.push('');
  lines.push('; === LABELS (paste into [LABELS] section) ===');
  lines.push('');

  // Stand labels omitted — too cluttered for EuroScope SMR view

  // Taxiway name labels (at midpoint of each taxiway)
  for (const t of taxiwayLines) {
    if (t.name && t.raw.length >= 2) {
      const mid = Math.floor(t.raw.length / 2);
      lines.push(`"${t.name}" ${coordToES(t.raw[mid].lat, t.raw[mid].lon)} ${COLOURS.standlabel}`);
    }
  }

  // Write output
  const outPath = path.join(__dirname, '..', 'Euroscope_Files', 'WorldFlight', `${ICAO}_ground.txt`);
  fs.writeFileSync(outPath, lines.join('\r\n'), 'utf-8');
  console.log(`\n  Written ${lines.length} lines to ${outPath}`);
  console.log('  Copy the sections into your .sct file [REGIONS], [GEO], and [LABELS] sections');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
