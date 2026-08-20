import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PACK_WF_DIR } from '../lib/paths.mjs';
import { decimalToDMS, coordPair, bearing, projectPoint, haversineNm, midpoint, interpolateGC } from './lib/geo.js';
import { parseFixes, parseNavaids, parseAirways, parseCIFP, parseRouteFIRs, parseVATSpyForFIRs, parseXP12Frequencies, parseAFVStations } from './lib/parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const LEG_NUM = process.argv[2] || '01';
const FROM = process.argv[3] || 'EGLL';
const TO = process.argv[4] || 'EHAM';
const ATC_ROUTE = process.argv[5] || '';
// LEG_NUM can be just "01" or full "WF2601" — detect and handle both
const LEG_NAME = /^WF\d{4,}$/.test(LEG_NUM) ? LEG_NUM : `WF${String(new Date().getFullYear()).slice(2)}${LEG_NUM.padStart(2, '0')}`;
const YEAR_PREFIX = LEG_NAME.slice(0, 4); // e.g. "WF26" or "WF25"

const RADIUS = 200; // 200nm radius around departure/arrival airports
const COASTLINE_PATH = path.join(__dirname, '..', 'data', 'world_coastline.sct');
const NAVDATA_DIR = path.join(__dirname, '..', 'data', 'navdata');
const CIFP_DIR = path.join(__dirname, '..', 'data', 'XP12', 'CIFP');
const FIR_GEOJSON = path.join(__dirname, '..', 'public', 'fir-boundaries.geojson');
const VATSPY_DAT = path.join(__dirname, '..', 'data', 'VATSPY', 'VATSpy.dat');
const FIR_BOUNDS = path.join(__dirname, '..', 'data', 'VATSPY', 'FIRBoundaries.dat');
const XP12_ATC = path.join(__dirname, '..', 'data', 'XP12', '1200 atc data', 'Earth nav data', 'atc.dat');
const AFV_STATIONS = path.join(__dirname, '..', 'data', 'afv_stations.csv');
const MSA_FILE = path.join(NAVDATA_DIR, 'earth_msa.dat');
const OUTPUT_DIR = PACK_WF_DIR;

// US TRACON facilities mapped to the airports they serve
const US_TRACON_MAP = {
  N90: ['KJFK', 'KLGA', 'KEWR', 'KTEB', 'KHPN', 'KISP', 'KFRG', 'KSWF'],
  SCT: ['KLAX', 'KSAN', 'KSNA', 'KONT', 'KBUR', 'KLGB', 'KVNY', 'KPSP'],
  NCT: ['KSFO', 'KOAK', 'KSJC', 'KSMF', 'KRNO'],
  PCT: ['KDCA', 'KIAD', 'KBWI', 'KADW'],
  A80: ['KATL', 'KPDK', 'KFTY'],
  C90: ['KORD', 'KMDW', 'KPWK'],
  D10: ['KDFW', 'KDAL', 'KADS', 'KAFW'],
  I90: ['KIAH', 'KHOU', 'KELP'],
  S56: ['KSEA', 'KBFI', 'KPAE'],
  A90: ['KBOS', 'KBDL', 'KPVD', 'KMHT'],
  D01: ['KDEN'],
  M98: ['KMSP'],
  L30: ['KLAS'],
  P50: ['KPHX', 'KSDL', 'KCHD', 'KGYR'],
  MIA: ['KMIA', 'KFLL', 'KPBI'],
  F11: ['KMCO', 'KTPA', 'KSFB', 'KMLB'],
  Y90: ['KPHX'],
  R90: ['KRDU'],
  T75: ['KSTL'],
  IND: ['KIND'],
  CVG: ['KCVG', 'KLUK'],
  CLT: ['KCLT'],
  MSY: ['KMSY'],
  PIT: ['KPIT'],
  DTW: ['KDTW'],
  CLE: ['KCLE'],
  SDF: ['KSDF'],
  MCI: ['KMCI'],
  MKE: ['KMKE'],
  CMH: ['KCMH'],
  BNA: ['KBNA'],
  JAX: ['KJAX'],
  ANC: ['PANC'],
  PDX: ['KPDX'],
};

function collectLabelItems(labelStr) {
  if (!labelStr) return { lines: labelStr, items: [] };
  const items = [];
  const lines = labelStr.split(/\r?\n/).map(line => {
    const clean = line.replace(/\r/g, '');
    const m = clean.match(/^"([^"]+)"\s+(.+)$/);
    if (m) items.push(m[1]);
    return clean;
  }).join('\r\n');
  return { lines, items };
}

// Parse earth_msa.dat for a given airport ICAO — returns best MSA entry (prefer multi-sector navaid-based)
function parseMSA(icao) {
  if (!fs.existsSync(MSA_FILE)) return null;
  const lines = fs.readFileSync(MSA_FILE, 'utf-8').split('\n');
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('I') || trimmed.startsWith('1150')) continue;
    // Format: TYPE  FIX REGION AIRPORT M sectors... 000 000  0
    const m = trimmed.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+M\s+(.+)$/);
    if (!m || m[4] !== icao) continue;
    const type = parseInt(m[1]);
    const fix = m[2];
    const rest = m[5].trim();
    // Parse sector triplets: bearing altitude radius, terminated by 000 000
    const nums = rest.split(/\s+/).map(Number);
    const sectors = [];
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const brg = nums[i], alt = nums[i + 1], rad = nums[i + 2];
      if (brg === 0 && alt === 0 && rad === 0) break;
      sectors.push({ bearing: brg, altitude: alt * 100, radius: rad });
    }
    if (sectors.length > 0) entries.push({ type, fix, sectors });
  }
  if (entries.length === 0) return null;
  // Prefer type 3 (navaid) with most sectors, then type 1 (airport) with most sectors
  entries.sort((a, b) => {
    if (b.sectors.length !== a.sectors.length) return b.sectors.length - a.sectors.length;
    return (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1);
  });
  return entries[0];
}

// Render MSA ring into GEO lines and LABELS for an airport
function renderMSA(icao, airport, vorLookup) {
  const msa = parseMSA(icao);
  if (!msa) return { geo: [], labels: [], fix: null };
  // Find center point: use VOR position if available, otherwise airport
  let centerLat = airport.lat, centerLon = airport.lon;
  if (msa.fix !== icao && vorLookup) {
    const vor = vorLookup.get(msa.fix);
    if (vor) { centerLat = vor.lat; centerLon = vor.lon; }
  }
  const radius = msa.sectors[0].radius; // all sectors typically same radius
  const geo = [];
  const labels = [];
  const geoName = `${icao} MSA`;
  // Draw MSA ring in screen-space with full cos(lat) correction for equirectangular display
  const radiusDegLat = radius / 60; // 1nm = 1/60 degree latitude
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const radiusDegLon = radiusDegLat / cosLat;
  const segments = 72; // 5-degree segments
  const toRad = d => d * Math.PI / 180;
  for (let i = 0; i < segments; i++) {
    const a1 = toRad((360 / segments) * i);
    const a2 = toRad((360 / segments) * (i + 1));
    const lat1 = centerLat + radiusDegLat * Math.cos(a1);
    const lon1 = centerLon + radiusDegLon * Math.sin(a1);
    const lat2 = centerLat + radiusDegLat * Math.cos(a2);
    const lon2 = centerLon + radiusDegLon * Math.sin(a2);
    geo.push(`${coordPair(lat1, lon1)} ${coordPair(lat2, lon2)} rangering`);
  }
  // Helper: point on screen-space ring at given bearing
  function ringPt(brg, frac = 1.0) {
    const a = toRad(brg);
    return { lat: centerLat + radiusDegLat * frac * Math.cos(a), lon: centerLon + radiusDegLon * frac * Math.sin(a) };
  }
  // Note: bearing 0 = north (cos gives lat offset, sin gives lon offset) — but standard math angle
  // has 0=east. Convert: screen bearing 0°=N means angle = 90°-bearing for cos/sin.
  // Actually the above code uses cos(a) for lat and sin(a) for lon, which makes 0° = north. Correct.
  // But wait: bearing 0°=N means lat increases (north), so cos(0)=1 for lat is correct.
  // And bearing 90°=E means lon increases (east), so sin(90°)=1 for lon is correct. ✓

  if (msa.sectors.length === 1) {
    const lp = ringPt(0, 0.5);
    labels.push({ text: `MSA_${msa.sectors[0].altitude}`, lat: lp.lat, lon: lp.lon });
    const np = ringPt(180, 1.15);
    labels.push({ text: `MSA_${radius}NM`, lat: np.lat, lon: np.lon });
  } else {
    for (let i = 0; i < msa.sectors.length; i++) {
      const s = msa.sectors[i];
      const edgePt = ringPt(s.bearing);
      geo.push(`${coordPair(centerLat, centerLon)} ${coordPair(edgePt.lat, edgePt.lon)} rangering`);
      const nextBrg = msa.sectors[(i + 1) % msa.sectors.length].bearing;
      let midBrg = s.bearing + ((nextBrg - s.bearing + 360) % 360) / 2;
      if (((nextBrg - s.bearing + 360) % 360) > 180) midBrg += 180;
      midBrg = midBrg % 360;
      const lp = ringPt(midBrg, 0.6);
      labels.push({ text: `MSA_${s.altitude}`, lat: lp.lat, lon: lp.lon });
    }
    const np = ringPt(180, 1.15);
    labels.push({ text: `MSA_${radius}NM`, lat: np.lat, lon: np.lon });
  }
  return { geo, labels, fix: msa.fix };
}

function parseDMS(dms) {
  const m = dms.match(/^([NSEW])(\d+)\.(\d+)\.(\d+\.\d+)$/);
  if (!m) return NaN;
  const deg = parseInt(m[2]) + parseInt(m[3]) / 60 + parseFloat(m[4]) / 3600;
  return (m[1] === 'S' || m[1] === 'W') ? -deg : deg;
}

function deduplicateLabels(labelsStr) {
  const lines = labelsStr.split(/\r?\n/);
  const kept = [];
  const byText = {}; // text -> [{lat, lon}]
  const DEDUP_NM = 0.054; // ~100m
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, '');
    const m = line.match(/^"([^"]+)"\s+([NSEW]\d+\.\d+\.\d+\.\d+)\s+([NSEW]\d+\.\d+\.\d+\.\d+)\s+(.+)$/);
    if (!m) { kept.push(line); continue; }
    const text = m[1], lat = parseDMS(m[2]), lon = parseDMS(m[3]);
    if (isNaN(lat) || isNaN(lon)) { kept.push(line); continue; }
    if (!byText[text]) byText[text] = [];
    const tooClose = byText[text].some(p => haversineNm(lat, lon, p.lat, p.lon) < DEDUP_NM);
    if (tooClose) continue;
    byText[text].push({ lat, lon });
    kept.push(line);
  }
  return kept.join('\r\n');
}

function loadGround(icao) {
  const groundPath = path.join(OUTPUT_DIR, `${icao}_ground.txt`);
  if (!fs.existsSync(groundPath)) return { regions: '', geo: '', labels: '' };
  const ground = fs.readFileSync(groundPath, 'utf-8');
  const regionsStart = ground.indexOf('; === REGIONS');
  const geoStart = ground.indexOf('; === GEO');
  const labelsStart = ground.indexOf('; === LABELS');
  const rawLabels = ground.substring(labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
  return {
    regions: ground.substring(regionsStart, geoStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n'),
    geo: ground.substring(geoStart, labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n'),
    labels: deduplicateLabels(rawLabels)
  };
}

function addRunwaysCenterlines(L, airport, icao) {
  // Short centerline only (10nm) — extended centrelines via TopSky MAP with ACTIVE:RWY
  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const recip = (hdg + 180) % 360;
    const ext1 = projectPoint(rwy.lat1, rwy.lon1, recip, 10);
    const ext2 = projectPoint(rwy.lat2, rwy.lon2, hdg, 10);
    L.push(`${icao}-${rwy.ident1} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(ext1.lat, ext1.lon)} centrelinecolour`);
    if (rwy.ident2) L.push(`${icao}-${rwy.ident2} ${coordPair(rwy.lat2, rwy.lon2)} ${coordPair(ext2.lat, ext2.lon)} centrelinecolour`);
  }
}

// Build TopSky MAP entries for extended centrelines with runway-conditional activation
function buildCentrelineMaps(airport, icao, positionShortIds) {
  const extDist = 20;
  const tickSpacing = 1;
  const shortTick = 0.3;
  const longTick = 0.6;
  const lines = [];
  const toRad = d => d * Math.PI / 180;

  function addMapEntry(rwyIdent, lat, lon, hdg) {
    const ext = projectPoint(lat, lon, hdg, extDist);
    const rwyTag = `${icao}${rwyIdent.replace(/\s/g, '')}`;
    // Centreline MAP — show when runway is active for arrivals
    lines.push('');
    lines.push(`MAP:${icao} ${rwyIdent}`);
    lines.push('FOLDER:Extended Centrelines');
    lines.push('COLOR:Active_Map_Type_5');
    lines.push('ZOOM:5');
    lines.push('STYLE:Solid:1');
    lines.push('ASRDATA:Centrelines');
    lines.push(`LINE:${coordPair(lat, lon).replace(' ', ':')}:${coordPair(ext.lat, ext.lon).replace(' ', ':')}`);
    lines.push(`ACTIVE:RWY:ARR:${rwyTag}:DEP:*`);

    // Ticks MAP — screen-space perpendiculars
    const dlat = ext.lat - lat;
    const dlon = ext.lon - lon;
    const len = Math.sqrt(dlat * dlat + dlon * dlon);
    const perpLat = -dlon / len;
    const perpLon = dlat / len;

    lines.push('');
    lines.push(`MAP:${icao} ${rwyIdent} Ticks`);
    lines.push('FOLDER:Extended Centrelines');
    lines.push('COLOR:Active_Map_Type_5');
    lines.push('ZOOM:5');
    lines.push('STYLE:Solid:1');
    lines.push('ASRDATA:Ticks');
    for (let d = tickSpacing; d <= extDist; d += tickSpacing) {
      const frac = d / extDist;
      const ptLat = lat + dlat * frac;
      const ptLon = lon + dlon * frac;
      const halfLen = (d % 5 === 0) ? longTick : shortTick;
      const tickDeg = halfLen / 60;
      const lLat = ptLat + perpLat * tickDeg;
      const lLon = ptLon + perpLon * tickDeg;
      const rLat = ptLat - perpLat * tickDeg;
      const rLon = ptLon - perpLon * tickDeg;
      lines.push(`LINE:${coordPair(lLat, lLon).replace(' ', ':')}:${coordPair(rLat, rLon).replace(' ', ':')}`);
    }
    lines.push(`ACTIVE:RWY:ARR:${rwyTag}:DEP:*`);
  }

  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const recip = (hdg + 180) % 360;
    addMapEntry(rwy.ident1, rwy.lat1, rwy.lon1, recip);
    if (rwy.ident2) addMapEntry(rwy.ident2, rwy.lat2, rwy.lon2, hdg);
  }
  return lines;
}

function addGeoForAirport(L, airport, icao, groundData) {
  L.push(`${icao} Ground              S999.00.00.000 E999.00.00.000 S999.00.00.000 E999.00.00.000`);
  if (groundData.geo) L.push(groundData.geo);
}

function addRegionsForAirport(L, airport, icao, groundData) {
  if (groundData.regions) L.push(groundData.regions);
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    const halfWidth = 0.008;
    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);
    L.push(`REGIONNAME ${icao}`);
    L.push(`smrRunway ${coordPair(c1.lat, c1.lon)}`);
    L.push(` ${coordPair(c4.lat, c4.lon)}`);
    L.push(` ${coordPair(c3.lat, c3.lon)}`);
    L.push(` ${coordPair(c2.lat, c2.lon)}`);
    L.push(` ${coordPair(c1.lat, c1.lon)}`);
    L.push('');
  }
}

function buildVsmrRunways(airport) {
  const dmsPt = (lat, lon) => [decimalToDMS(lat, true), decimalToDMS(lon, false)];
  const halfWidth = 0.032;
  const runways = [];
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    runways.push({
      runway_name: `${rwy.ident1}/${rwy.ident2}`,
      path: [dmsPt(c1.lat, c1.lon), dmsPt(c2.lat, c2.lon), dmsPt(c3.lat, c3.lon), dmsPt(c4.lat, c4.lon)],
      path_lvp: [dmsPt(c1.lat, c1.lon), dmsPt(c2.lat, c2.lon), dmsPt(c3.lat, c3.lon), dmsPt(c4.lat, c4.lon)]
    });
  }
  return runways;
}

function buildSmrAsr(legName, icao, airport, suffix, freeTextItems) {
  const boxSize = 0.04;
  const lines = [
    'DisplayTypeName:SMR radar display',
    'DisplayTypeNeedRadarContent:0',
    'DisplayTypeGeoReferenced:1',
  ];
  for (const item of (freeTextItems || [])) {
    lines.push(`Free Text:${item}:freetext`);
  }
  lines.push(`Geo:${icao} Ground:`);
  lines.push(`Regions:${icao}:polygon`);
  for (const rwy of airport.runways) {
    if (rwy.ident1) lines.push(`Runways:${icao}:${rwy.ident1}:centerline`);
    if (rwy.ident2) lines.push(`Runways:${icao}:${rwy.ident2}:centerline`);
  }
  lines.push(`SHOWC:${icao}_TWR:1`);
  lines.push('SHOWSB:0', 'BELOW:0', 'ABOVE:0', 'LEADER:5', 'SHOWLEADER:1');
  lines.push('HISTORY_DOTS:5', 'SIMULATION_MODE:1', 'DISABLEPANNING:0', 'DISABLEZOOMING:0');
  lines.push('DisplayRotation:0.00000', 'TAGFAMILY:Matias (built in)');
  lines.push(`m_Latitude:${airport.lat}`, `m_Longitude:${airport.lon}`);
  lines.push(`WINDOWAREA:${(airport.lat - boxSize).toFixed(6)}:${(airport.lon - boxSize * 1.3).toFixed(6)}:${(airport.lat + boxSize).toFixed(6)}:${(airport.lon + boxSize * 1.3).toFixed(6)}`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ActiveProfile:WorldFlight`);
  lines.push(`PLUGIN:vSMR Vatsim UK:Afterglow:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:Airport:${icao}`);
  lines.push(`PLUGIN:vSMR Vatsim UK:AppTrailsDots:4`);
  lines.push(`PLUGIN:vSMR Vatsim UK:FontSize:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ShowAircraftType:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ShowSID:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ShowWakeTurb:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1Display:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1Filter:5500`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1OffsetX:0`, `PLUGIN:vSMR Vatsim UK:SRW1OffsetY:0`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1Rotation:0`, `PLUGIN:vSMR Vatsim UK:SRW1Scale:30`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1TopLeftX:1545`, `PLUGIN:vSMR Vatsim UK:SRW1TopLeftY:629`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1BottomRightX:1920`, `PLUGIN:vSMR Vatsim UK:SRW1BottomRightY:928`);
  return lines;
}

function buildAppAsr(icao, airport, freeTextItems, relevantProcs, legName, vorSet, ndbSet, routeFixNames, msaFixNames, depIcao, nextRouteFixNames, nextRouteName) {
  const boxSize = 0.5; // degrees for APP view
  const lines = [
    'DisplayTypeName:Standard ES radar screen',
    'DisplayTypeNeedRadarContent:1',
    'DisplayTypeGeoReferenced:1',
  ];
  // Collect display items, then sort alphabetically (EuroScope format)
  const items = [];
  items.push(`Airports:${icao}:symbol`);
  items.push(`ARTCC boundary:${icao}-MSA:`);
  // Route line uses departure ICAO as prefix in the SCT
  if (legName && depIcao) items.push(`ARTCC boundary:${depIcao}-${legName}:`);
  for (const item of (freeTextItems || [])) {
    items.push(`Free Text:${item}:freetext`);
  }
  // Route waypoint fixes
  for (const f of (routeFixNames || [])) {
    if (vorSet && vorSet.has(f)) {
      items.push(`VORs:${f}:name`);
      items.push(`VORs:${f}:symbol`);
    } else if (ndbSet && ndbSet.has(f)) {
      items.push(`NDBs:${f}:name`);
      items.push(`NDBs:${f}:symbol`);
    } else {
      items.push(`Fixes:${f}:name`);
      items.push(`Fixes:${f}:symbol`);
    }
  }
  // MSA labels — name only
  for (const f of (msaFixNames || [])) {
    items.push(`Fixes:${f}:name`);
  }
  // Next leg outbound route
  if (nextRouteName) items.push(`ARTCC boundary:${nextRouteName}:`);
  for (const f of (nextRouteFixNames || [])) {
    if (vorSet && vorSet.has(f)) {
      items.push(`VORs:${f}:name`);
      items.push(`VORs:${f}:symbol`);
    } else if (ndbSet && ndbSet.has(f)) {
      items.push(`NDBs:${f}:name`);
      items.push(`NDBs:${f}:symbol`);
    } else {
      items.push(`Fixes:${f}:name`);
      items.push(`Fixes:${f}:symbol`);
    }
  }
  items.push('Geo:Coastline:');
  // Runways (extended centrelines via TopSky ACTIVE:RWY maps)
  for (const rwy of airport.runways) {
    if (rwy.ident1) items.push(`Runways:${icao}:${rwy.ident1}:centerline`);
    if (rwy.ident2) items.push(`Runways:${icao}:${rwy.ident2}:centerline`);
  }
  items.sort((a, b) => a.toLowerCase().replace(/-/g, '~').localeCompare(b.toLowerCase().replace(/-/g, '~')));
  lines.push(...items);
  // Display settings
  lines.push('SHOWC:1', 'SHOWSB:0', 'BELOW:0', 'ABOVE:0');
  lines.push('LEADER:3', 'SHOWLEADER:1', 'TURNLEADER:0');
  lines.push('HISTORY_DOTS:5', 'SIMULATION_MODE:1');
  lines.push('DISABLEPANNING:0', 'DISABLEZOOMING:0');
  lines.push('DisplayRotation:0.00000');
  lines.push('TAGFAMILY:AC-TopSky-Easy');
  lines.push(`WINDOWAREA:${(airport.lat - boxSize).toFixed(6)}:${(airport.lon - boxSize * 1.5).toFixed(6)}:${(airport.lat + boxSize).toFixed(6)}:${(airport.lon + boxSize * 1.5).toFixed(6)}`);
  // Plugin settings
  lines.push('PLUGIN:TopSky plugin:HideMapData:AirspaceBases,Fixes,FixLabels');
  lines.push('PLUGIN:TopSky plugin:ShowMapData:Centrelines,Ticks');
  return lines;
}

async function main() {
  console.log(`=== Generating ${LEG_NAME} (${FROM} -> ${TO}) ===\n`);

  const depAirport = await prisma.airport.findUnique({ where: { icao: FROM }, include: { runways: true } });
  const arrAirport = await prisma.airport.findUnique({ where: { icao: TO }, include: { runways: true } });
  if (!depAirport) { console.error(`Departure airport ${FROM} not found`); process.exit(1); }
  if (!arrAirport) { console.error(`Arrival airport ${TO} not found`); process.exit(1); }

  // Look up previous and next legs for inbound/outbound route drawing
  const legNum = parseInt(LEG_NAME.replace(/^WF\d{2}/, ''));
  const prevLegName = `${YEAR_PREFIX}${String(legNum - 1).padStart(2, '0')}`;
  const nextLegName = `${YEAR_PREFIX}${String(legNum + 1).padStart(2, '0')}`;
  /* Scope to one event. Leg numbers repeat across events — WF2611 is both
     LEMD->KJFK on an older event and UHPP->PADQ on this one — and an unscoped
     findFirst returned the wrong row, so the pack drew a route across the
     Atlantic instead of the neighbouring leg. Prefer the event that owns the
     leg being generated, falling back to whichever event is active. */
  const thisLeg = await prisma.wfScheduleRow.findFirst({
    where: { number: LEG_NAME, from: FROM, to: TO }
  });
  let scopeEventId = thisLeg?.eventId ?? null;
  if (scopeEventId == null) {
    const activeEvent = await prisma.wfEvent.findFirst({ where: { isActive: true }, select: { id: true } });
    scopeEventId = activeEvent?.id ?? null;
  }
  if (scopeEventId == null) console.warn('  WARNING: no event resolved — neighbouring legs may come from the wrong event');
  const legScope = scopeEventId == null ? {} : { eventId: scopeEventId };
  const prevLeg = await prisma.wfScheduleRow.findFirst({ where: { number: prevLegName, ...legScope } });
  const nextLeg = await prisma.wfScheduleRow.findFirst({ where: { number: nextLegName, ...legScope } });
  if (prevLeg) console.log(`  Previous leg: ${prevLegName} (${prevLeg.from} -> ${prevLeg.to})`);
  if (nextLeg) console.log(`  Next leg: ${nextLegName} (${nextLeg.from} -> ${nextLeg.to})`);

  const centers = [
    { icao: FROM, lat: depAirport.lat, lon: depAirport.lon },
    { icao: TO, lat: arrAirport.lat, lon: arrAirport.lon }
  ];
  const dist = haversineNm(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
  const mid = midpoint(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
  console.log(`  Distance: ${dist.toFixed(0)}nm | Midpoint: ${mid.lat.toFixed(2)}, ${mid.lon.toFixed(2)}`);

  // FIR boundaries — initially use great circle, will re-parse with actual route later
  let routeFirs = parseRouteFIRs(FIR_GEOJSON, depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
  console.log(`  ${routeFirs.length} FIRs along route (initial)`);

  // Navdata loading deferred until after route expansion so corridor follows actual route
  let routeCenters = [...centers];
  let fixes = [], vors = [], ndbs = [];
  let airways = { high: [], low: [] };
  let vorIdents = new Set();
  let ndbIdents = new Set();
  let vorLookup = new Map();

  // VATSpy parsing deferred until after route expansion (to use actual route FIRs)
  let vatspy = null;

  // Load ground layouts — fetch from Overpass if missing
  console.log('Loading ground layouts...');
  const fetchScript = path.join(__dirname, 'fetch-airport-ground.js');
  for (const icao of [FROM, TO]) {
    const groundPath = path.join(OUTPUT_DIR, `${icao}_ground.txt`);
    if (!fs.existsSync(groundPath)) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        console.log(`  Fetching ${icao} ground layout (attempt ${attempt}/5)...`);
        try {
          execFileSync(process.execPath, [fetchScript, icao], { cwd: path.join(__dirname, '..'), stdio: 'inherit', timeout: 120000 });
          if (fs.existsSync(groundPath)) { console.log(`  ${icao} ground layout fetched.`); break; }
        } catch (err) {
          console.log(`  Attempt ${attempt} failed: ${err.message}`);
          if (attempt < 5) await new Promise(r => setTimeout(r, 3000));
        }
      }
      if (!fs.existsSync(groundPath)) console.log(`  Warning: ${icao} ground layout unavailable after 5 attempts.`);
    }
  }
  const depGround = loadGround(FROM);
  const arrGround = loadGround(TO);

  // ===== BUILD SCT =====
  const L = [];
  L.push(`; ${LEG_NAME} EuroScope Sector File (${FROM} -> ${TO})`);
  L.push(`; Generated from Navigraph AIRAC 2603 + OpenStreetMap`);
  L.push('');
  L.push('#define smrRunway 5263440');
  L.push('#define smrRwyEdge 16777215');
  L.push('#define smrTaxiway 3289650');
  L.push('#define smrApron 6579300');
  L.push('#define smrBuilding 9211020');
  L.push('#define smrGrass 680970');
  L.push('#define centrelinecolour 15790135');
  L.push('#define twyline 17219');
  L.push('#define rangering 4227200');
  L.push('#define Coast 5263440');
  L.push('');

  // INFO centered on departure. The nine fields must follow [INFO] with no
  // blank line between — EuroScope reads them positionally, so a leading
  // blank shifts every field by one and the latitude slot receives the
  // airport code, which cannot parse as a coordinate.
  L.push('[INFO]');
  L.push(`${LEG_NAME} (${FROM} -> ${TO})`);
  L.push(`${FROM}_CTR`);
  L.push(FROM);
  L.push(coordPair(depAirport.lat, depAirport.lon).split(' ')[0]);
  L.push(coordPair(depAirport.lat, depAirport.lon).split(' ')[1]);
  L.push('60');
  L.push('36.06');
  L.push('1.0');
  L.push('10');
  L.push('');

  // Both airports
  L.push('[AIRPORT]');
  L.push(`${FROM} 118.500 ${coordPair(depAirport.lat, depAirport.lon)} D`);
  L.push(`${TO} 118.500 ${coordPair(arrAirport.lat, arrAirport.lon)} D`);
  L.push('');

  // Runways for both
  L.push('[RUNWAY]');
  for (const rwy of depAirport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
    const hdg2 = (hdg1 + 180) % 360;
    L.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)} ${FROM} ${depAirport.name}`);
  }
  for (const rwy of arrAirport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
    const hdg2 = (hdg1 + 180) % 360;
    L.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)} ${TO} ${arrAirport.name}`);
  }
  L.push('');

  // MSA + Navdata sections deferred — placeholder inserted here, filled after route expansion
  const NAVDATA_PLACEHOLDER = '{{NAVDATA_SECTIONS}}';
  L.push(NAVDATA_PLACEHOLDER);

  // Pre-scan route tokens to resolve VORs/NDBs/fixes not on airways
  const wpLookup = new Map();
  if (ATC_ROUTE) {
    const routeTokens = new Set(ATC_ROUTE.split(/\s+/).filter(t => t !== 'DCT' && /^[A-Z]/.test(t) && !/\d/.test(t.charAt(0))));
    // Quick scan of earth_nav.dat for VOR/NDB positions — pick closest to midpoint
    const wpCandidates = {}; // ident -> [{ident, lat, lon, dist}]
    const navFile = fs.readFileSync(path.join(NAVDATA_DIR, 'earth_nav.dat'), 'utf-8');
    for (const line of navFile.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length < 8) continue;
      const type = parseInt(p[0]);
      if (type !== 2 && type !== 3 && type !== 12 && type !== 13) continue;
      const ident = p[7];
      if (routeTokens.has(ident)) {
        const lat = parseFloat(p[1]), lon = parseFloat(p[2]);
        if (!isNaN(lat) && !isNaN(lon)) {
          const d = haversineNm(mid.lat, mid.lon, lat, lon);
          if (d < dist + 500) {
            if (!wpCandidates[ident]) wpCandidates[ident] = [];
            wpCandidates[ident].push({ ident, lat, lon, dist: d });
          }
        }
      }
    }
    // Quick scan of earth_fix.dat for fix positions
    const fixFile = fs.readFileSync(path.join(NAVDATA_DIR, 'earth_fix.dat'), 'utf-8');
    for (const line of fixFile.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length < 3) continue;
      const ident = p[2];
      if (routeTokens.has(ident) && !wpCandidates[ident]) {
        const lat = parseFloat(p[0]), lon = parseFloat(p[1]);
        if (!isNaN(lat) && !isNaN(lon)) {
          const d = haversineNm(mid.lat, mid.lon, lat, lon);
          if (d < dist + 500) {
            if (!wpCandidates[ident]) wpCandidates[ident] = [];
            wpCandidates[ident].push({ ident, lat, lon, dist: d });
          }
        }
      }
    }
    // Pick closest candidate for each token
    for (const [ident, candidates] of Object.entries(wpCandidates)) {
      candidates.sort((a, b) => a.dist - b.dist);
      wpLookup.set(ident, candidates[0]);
    }
    console.log(`  Pre-resolved ${wpLookup.size} route waypoints from navdata`);
  }

  // Parse CIFP for both airports to get SID/STAR fix sequences
  const allSidStars = [];
  for (const icao of [FROM, TO]) {
    const cifpPath = path.join(CIFP_DIR, `${icao}.dat`);
    if (fs.existsSync(cifpPath)) {
      const entries = parseCIFP(cifpPath, icao);
      allSidStars.push(...entries);
    }
  }

  // Collect all fix names from SID/STAR entries and resolve missing ones
  const allProcFixes = new Set();
  for (const entry of allSidStars) {
    const fixPart = entry.split(':')[4] || '';
    for (const f of fixPart.split(' ')) if (f) allProcFixes.add(f);
  }
  if (ATC_ROUTE) {
    for (const part of ATC_ROUTE.trim().split(/\s+/)) {
      if (!(/\d/.test(part) && /^[A-Z]{1,2}\d/.test(part)) && !(/\d$/.test(part) && part.length > 4)) {
        allProcFixes.add(part);
      }
    }
  }
  // Scan full fix file for any missing waypoints — pick closest to route midpoint
  const missingFixes = [...allProcFixes].filter(n => !wpLookup.has(n));
  if (missingFixes.length > 0) {
    const missingSet = new Set(missingFixes);
    const candidates = {}; // name -> [{lat, lon, dist}]
    const fixFile = fs.readFileSync(path.join(NAVDATA_DIR, 'earth_fix.dat'), 'utf-8');
    for (const line of fixFile.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      if (missingSet.has(parts[2])) {
        const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lon)) {
          if (!candidates[parts[2]]) candidates[parts[2]] = [];
          const dist = haversineNm(mid.lat, mid.lon, lat, lon);
          candidates[parts[2]].push({ ident: parts[2], lat, lon, dist });
        }
      }
    }
    // Pick closest candidate for each missing fix
    for (const [name, options] of Object.entries(candidates)) {
      if (wpLookup.has(name)) continue;
      options.sort((a, b) => a.dist - b.dist);
      wpLookup.set(name, options[0]);
    }
  }

  // depMSA/arrMSA parsed after navdata load (in navdata section builder)

  // Draw SID routes
  const allProcs = []; // { name, airport, fixes[] }
  L.push('[SID]');
  addRunwaysCenterlines(L, depAirport, FROM);
  addRunwaysCenterlines(L, arrAirport, TO);
  // MSA rings moved to [ARTCC LOW], route moved to [ARTCC HIGH]
  for (const entry of allSidStars.filter(e => e.startsWith('SID:'))) {
    const parts = entry.split(':');
    const procName = `${parts[1]}-${parts[3]}`; // EGLL-BPK5K
    const fixNames = (parts[4] || '').split(' ').filter(f => f);
    allProcs.push({ name: procName, airport: parts[1], fixes: fixNames });
    for (let i = 0; i < fixNames.length - 1; i++) {
      const p1 = wpLookup.get(fixNames[i]);
      const p2 = wpLookup.get(fixNames[i + 1]);
      if (p1 && p2) L.push(`${procName.padEnd(14).substring(0, 14)} ${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)}`);
    }
  }

  // Build airway graph (always, used by both main and next-leg route expansion)
  const awyGraph = {};
  const awyFile = fs.readFileSync(path.join(NAVDATA_DIR, 'earth_awy.dat'), 'utf-8');
  for (const line of awyFile.split('\n')) {
    if (line.startsWith('I') || line.startsWith('9') || !line.trim()) continue;
    const p = line.trim().split(/\s+/);
    if (p.length < 10) continue;
    const fix1 = p[0], lat1 = parseFloat(p[1]), lon1 = parseFloat(p[2]);
    const fix2 = p[3], lat2 = parseFloat(p[4]), lon2 = parseFloat(p[5]);
    const name = p[9];
    if (!awyGraph[name]) awyGraph[name] = {};
    if (!awyGraph[name][fix1]) awyGraph[name][fix1] = [];
    if (!awyGraph[name][fix2]) awyGraph[name][fix2] = [];
    awyGraph[name][fix1].push({ fix: fix2, lat: lat2, lon: lon2 });
    awyGraph[name][fix2].push({ fix: fix1, lat: lat1, lon: lon1 });
    if (!wpLookup.has(fix1) && haversineNm(mid.lat, mid.lon, lat1, lon1) < dist + 500) wpLookup.set(fix1, { ident: fix1, lat: lat1, lon: lon1 });
    if (!wpLookup.has(fix2) && haversineNm(mid.lat, mid.lon, lat2, lon2) < dist + 500) wpLookup.set(fix2, { ident: fix2, lat: lat2, lon: lon2 });
  }

  // Expand airway between two fixes using BFS
  function expandAirway(awyName, fromFix, toFix) {
    const graph = awyGraph[awyName] || awyGraph['U' + awyName] || awyGraph[awyName.replace(/^U/, '')];
    if (!graph || !graph[fromFix]) return [fromFix, toFix];
    const visited = new Set([fromFix]);
    const queue = [[fromFix]];
    while (queue.length) {
      const p = queue.shift();
      const current = p[p.length - 1];
      if (current === toFix) return p;
      for (const next of (graph[current] || [])) {
        if (!visited.has(next.fix)) {
          visited.add(next.fix);
          queue.push([...p, next.fix]);
        }
      }
    }
    return [fromFix, toFix];
  }

  // Fetch NAT tracks if route contains any NAT track identifier (NATA-NATZ)
  let natTracks = null;
  if (ATC_ROUTE && /\bNAT[A-Z]\b/.test(ATC_ROUTE)) {
    try {
      console.log('  Fetching NAT tracks...');
      const natResp = await fetch('https://notams.aim.faa.gov/nat.html');
      const natHtml = await natResp.text();
      // Parse from plain text — match fix + coordinates + fixes pattern, stop at EAST/WEST
      const allText = natHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      natTracks = [];
      const natRegex = /([A-Z]{4,5}(?:\s+\d{2,4}\/\d{2,4})+(?:\s+[A-Z]{4,5})+)/g;
      let nm;
      while ((nm = natRegex.exec(allText)) !== null) {
        const wps = nm[1].trim().split(/\s+/).filter(w => w !== 'EAST' && w !== 'WEST' && w !== 'LVLS' && w !== 'NIL');
        if (wps.length >= 3) natTracks.push(wps);
      }
      console.log(`  Found ${natTracks.length} NAT tracks`);
    } catch (err) {
      console.log(`  NAT track fetch failed: ${err.message}`);
    }
  }

  // Draw ATC route with airway expansion
  let deduped = null;
  if (ATC_ROUTE) {
    // Parse route: FIX AWY FIX AWY FIX...
    const routeParts = ATC_ROUTE.trim().split(/\s+/);
    const expandedFixes = [];
    let i = 0;
    while (i < routeParts.length) {
      const current = routeParts[i];
      // NAT track (NATA-NATZ) — expand using fetched track data
      if (/^NAT[A-Z]$/.test(current) && natTracks && i > 0 && i < routeParts.length - 1) {
        const prevFix = routeParts[i - 1];
        const nextFix = routeParts[i + 1];
        // Find matching track: starts with prevFix or ends with nextFix
        let matchedTrack = null;
        for (const track of natTracks) {
          if ((track[0] === prevFix && track[track.length - 1] === nextFix) ||
              (track[track.length - 1] === prevFix && track[0] === nextFix)) {
            matchedTrack = track;
            break;
          }
        }
        if (matchedTrack) {
          // Determine direction — if prevFix matches first element, use forward; otherwise reverse
          const trackWps = matchedTrack[0] === prevFix ? matchedTrack : [...matchedTrack].reverse();
          console.log(`  NAT Track ${current.slice(3)}: ${trackWps.join(' ')}`);
          // Convert DD/DD coords to coordinate waypoint format and add intermediate waypoints
          for (let j = 1; j < trackWps.length; j++) {
            const wp = trackWps[j];
            const coordMatch = wp.match(/^(\d{2})\/(\d{2})$/);
            if (coordMatch) {
              // DD/DD = DDN/DDDW format (North Atlantic = always N, always W)
              const lat = parseInt(coordMatch[1]);
              const lon = parseInt(coordMatch[2]);
              expandedFixes.push(`${lat}N0${lon}W`);
            } else {
              expandedFixes.push(wp);
            }
          }
          i += 2; // skip NAT token and next fix
        } else {
          console.log(`  Warning: No NAT track found matching ${prevFix} -> ${nextFix}`);
          i++;
        }
      } else {
        const isAirway = /\d/.test(current) && /^[A-Z]{1,2}\d/.test(current);
        if (isAirway && i > 0 && i < routeParts.length - 1) {
          const prevFix = routeParts[i - 1];
          const nextFix = routeParts[i + 1];
          const expanded = expandAirway(current, prevFix, nextFix);
          for (let j = 1; j < expanded.length; j++) expandedFixes.push(expanded[j]);
          i += 2;
        } else if (!isAirway && current !== 'DCT') {
          expandedFixes.push(current);
          i++;
        } else {
          i++;
        }
      }
    }

    // Parse coordinate waypoints (e.g. 66N071W, 5530N02000W, etc.)
    function parseCoordWaypoint(name) {
      // Format: DDN/SDDDW/E (e.g. 66N071W, 67N057W)
      let m = name.match(/^(\d{2})([NS])(\d{2,3})([EW])$/);
      if (m) {
        const lat = parseInt(m[1]) * (m[2] === 'S' ? -1 : 1);
        const lon = parseInt(m[3]) * (m[4] === 'W' ? -1 : 1);
        return { lat, lon };
      }
      // Format: DDMMN/SDDDMME/W (e.g. 5530N02000W)
      m = name.match(/^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/);
      if (m) {
        const lat = (parseInt(m[1]) + parseInt(m[2]) / 60) * (m[3] === 'S' ? -1 : 1);
        const lon = (parseInt(m[4]) + parseInt(m[5]) / 60) * (m[6] === 'W' ? -1 : 1);
        return { lat, lon };
      }
      return null;
    }

    // Build route points from expanded fixes — pick closest to previous for duplicates
    const routePoints = [{ lat: depAirport.lat, lon: depAirport.lon, name: FROM }];
    for (const name of expandedFixes) {
      const coord = parseCoordWaypoint(name);
      if (coord) { routePoints.push({ lat: coord.lat, lon: coord.lon, name }); continue; }
      // Find all candidates with this name, pick closest to previous point
      const lastPt = routePoints[routePoints.length - 1];
      const candidates = [];
      const wp = wpLookup.get(name);
      if (wp) candidates.push(wp);
      // Check airway graph for additional positions of this fix
      for (const awyName in awyGraph) {
        const g = awyGraph[awyName];
        if (g[name]) {
          for (const nb of g[name]) {
            // The neighbor has the fix's own position implied by the graph entry
          }
        }
      }
      if (candidates.length > 1) {
        candidates.sort((a, b) => haversineNm(lastPt.lat, lastPt.lon, a.lat, a.lon) - haversineNm(lastPt.lat, lastPt.lon, b.lat, b.lon));
      }
      if (candidates.length > 0) { routePoints.push({ lat: candidates[0].lat, lon: candidates[0].lon, name }); continue; }
      // Skip unresolvable tokens
    }
    routePoints.push({ lat: arrAirport.lat, lon: arrAirport.lon, name: TO });

    // Deduplicate consecutive
    deduped = routePoints.filter((p, idx) => idx === 0 || p.name !== routePoints[idx - 1].name);

    L.push(`; ATC Route: ${ATC_ROUTE}`);
    L.push(`; Expanded: ${deduped.map(p => p.name).join(' ')}`);
    // Route line moved to [ARTCC HIGH] section
    console.log(`  Route: ${deduped.length} waypoints (expanded from "${ATC_ROUTE}")`);
    // Rebuild corridor from actual route waypoints using great circle interpolation
    routeCenters = [...centers];
    for (let i = 0; i < deduped.length; i++) {
      routeCenters.push({ icao: 'RTE', lat: deduped[i].lat, lon: deduped[i].lon });
      // Add GC-interpolated points between consecutive waypoints for continuous coverage
      if (i < deduped.length - 1) {
        const segDist = haversineNm(deduped[i].lat, deduped[i].lon, deduped[i+1].lat, deduped[i+1].lon);
        const subSamples = Math.max(1, Math.ceil(segDist / 80)); // every ~80nm
        for (let s = 1; s < subSamples; s++) {
          const frac = s / subSamples;
          const pt = interpolateGC(deduped[i].lat, deduped[i].lon, deduped[i+1].lat, deduped[i+1].lon, frac);
          routeCenters.push({ icao: 'RTE', lat: pt.lat, lon: pt.lon });
        }
      }
    }
    console.log(`  ${routeCenters.length} corridor centers from actual route`);

    // Add next leg route points to corridor so navdata covers outbound route too
    if (nextLeg && nextLeg.atcRoute) {
      const nextArr = await prisma.airport.findUnique({ where: { icao: nextLeg.to } });
      if (nextArr) {
        // Add next leg destination as corridor center
        routeCenters.push({ icao: nextLeg.to, lat: nextArr.lat, lon: nextArr.lon });
        // Add GC interpolated points between arr airport and next destination
        const nextDist = haversineNm(arrAirport.lat, arrAirport.lon, nextArr.lat, nextArr.lon);
        const nextSamples = Math.max(1, Math.ceil(nextDist / 80));
        for (let s = 1; s < nextSamples; s++) {
          const frac = s / nextSamples;
          const pt = interpolateGC(arrAirport.lat, arrAirport.lon, nextArr.lat, nextArr.lon, frac);
          routeCenters.push({ icao: 'RTE', lat: pt.lat, lon: pt.lon });
        }
        console.log(`  Added next leg corridor (${nextLeg.to}), ${routeCenters.length} total centers`);
      }
    }

    // Add previous leg route points to corridor so navdata covers inbound route too
    if (prevLeg && prevLeg.atcRoute) {
      const prevDep = await prisma.airport.findUnique({ where: { icao: prevLeg.from } });
      if (prevDep) {
        routeCenters.push({ icao: prevLeg.from, lat: prevDep.lat, lon: prevDep.lon });
        const prevDist = haversineNm(prevDep.lat, prevDep.lon, depAirport.lat, depAirport.lon);
        const prevSamples = Math.max(1, Math.ceil(prevDist / 80));
        for (let s = 1; s < prevSamples; s++) {
          const frac = s / prevSamples;
          const pt = interpolateGC(prevDep.lat, prevDep.lon, depAirport.lat, depAirport.lon, frac);
          routeCenters.push({ icao: 'RTE', lat: pt.lat, lon: pt.lon });
        }
        console.log(`  Added prev leg corridor (${prevLeg.from}), ${routeCenters.length} total centers`);
      }
    }

    // Load navdata using actual route corridor (not GC between airports)
    console.log('  Loading navdata along actual route corridor...');
    fixes = await parseFixes(path.join(NAVDATA_DIR, 'earth_fix.dat'), routeCenters, RADIUS);
    const navResult = await parseNavaids(path.join(NAVDATA_DIR, 'earth_nav.dat'), routeCenters, RADIUS);
    vors = navResult.vors; ndbs = navResult.ndbs;
    airways = await parseAirways(path.join(NAVDATA_DIR, 'earth_awy.dat'), routeCenters, RADIUS);
    console.log(`  ${fixes.length} fixes, ${vors.length} VORs, ${ndbs.length} NDBs, ${airways.high.length} high/${airways.low.length} low airways`);
    vorIdents = new Set(vors.map(v => v.ident));
    ndbIdents = new Set(ndbs.map(n => n.ident));
    // Add to wpLookup
    for (const f of fixes) { if (!wpLookup.has(f.ident)) wpLookup.set(f.ident, f); }
    for (const v of vors) { if (!wpLookup.has(v.ident)) wpLookup.set(v.ident, v); }
    for (const n of ndbs) { if (!wpLookup.has(n.ident)) wpLookup.set(n.ident, n); }

    // Re-parse FIRs using actual route waypoints
    routeFirs = parseRouteFIRs(FIR_GEOJSON, depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon, deduped);
    console.log(`  ${routeFirs.length} FIRs along actual route`);
    // Now parse VATSpy with correct FIR IDs from actual route
    const transitFirIds = routeFirs.map(f => f.icao);
    vatspy = parseVATSpyForFIRs(VATSPY_DAT, FIR_BOUNDS, transitFirIds);
    console.log(`  ${vatspy.positions.length} VATSIM positions, ${vatspy.radars.length} radar sites for ${vatspy.firBounds.length} FIRs`);
  }

  // If no ATC route, load navdata with GC corridor (fallback)
  if (fixes.length === 0) {
    function addGCPoints(lat1, lon1, lat2, lon2, depth) {
      if (depth <= 0) return;
      const m = midpoint(lat1, lon1, lat2, lon2);
      routeCenters.push({ icao: 'RTE', lat: m.lat, lon: m.lon });
      addGCPoints(lat1, lon1, m.lat, m.lon, depth - 1);
      addGCPoints(m.lat, m.lon, lat2, lon2, depth - 1);
    }
    const gcDepth = dist < 500 ? 3 : dist < 2000 ? 4 : 5;
    addGCPoints(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon, gcDepth);
    console.log('Parsing navdata (GC fallback)...');
    fixes = await parseFixes(path.join(NAVDATA_DIR, 'earth_fix.dat'), routeCenters, RADIUS);
    const navResult = await parseNavaids(path.join(NAVDATA_DIR, 'earth_nav.dat'), routeCenters, RADIUS);
    vors = navResult.vors; ndbs = navResult.ndbs;
    airways = await parseAirways(path.join(NAVDATA_DIR, 'earth_awy.dat'), routeCenters, RADIUS);
    console.log(`  ${fixes.length} fixes, ${vors.length} VORs, ${ndbs.length} NDBs`);
    vorIdents = new Set(vors.map(v => v.ident));
    ndbIdents = new Set(ndbs.map(n => n.ident));
    for (const f of fixes) { if (!wpLookup.has(f.ident)) wpLookup.set(f.ident, f); }
    for (const v of vors) { if (!wpLookup.has(v.ident)) wpLookup.set(v.ident, v); }
    for (const n of ndbs) { if (!wpLookup.has(n.ident)) wpLookup.set(n.ident, n); }
    // Parse VATSpy with initial FIRs
    const transitFirIds = routeFirs.map(f => f.icao);
    vatspy = parseVATSpyForFIRs(VATSPY_DAT, FIR_BOUNDS, transitFirIds);
    console.log(`  ${vatspy.positions.length} VATSIM positions`);
  }

  // Now build navdata sections with final (post-route-expansion) data and splice into L
  const msaFixNames = [];
  let depMSA, arrMSA;
  {
    const navLines = [];
    vorLookup = new Map(vors.map(v => [v.ident, v])); // refresh after merge
    // Parse MSA now that VORs are loaded
    depMSA = renderMSA(FROM, depAirport, vorLookup);
    arrMSA = renderMSA(TO, arrAirport, vorLookup);
    navLines.push('[VOR]');
    for (const v of vors) navLines.push(`${v.ident.padEnd(5)} ${v.freq} ${coordPair(v.lat, v.lon)}`);
    navLines.push('');
    navLines.push('[NDB]');
    for (const n of ndbs) navLines.push(`${n.ident.padEnd(5)} ${n.freq} ${coordPair(n.lat, n.lon)}`);
    navLines.push('');
    navLines.push('[FIXES]');
    const fixMap = new Map();
    for (const f of fixes) { const k = `${f.ident}_${f.lat.toFixed(4)}`; if (!fixMap.has(k)) fixMap.set(k, f); }
    for (const f of [...fixMap.values()]) navLines.push(`${f.ident.padEnd(6)} ${coordPair(f.lat, f.lon)}`);
    // MSA altitude labels as fixes
    for (const { labels: msaLabels } of [depMSA, arrMSA]) {
      for (const lbl of msaLabels) {
        navLines.push(`${lbl.text.padEnd(6)} ${coordPair(lbl.lat, lbl.lon)}`);
        msaFixNames.push(lbl.text);
      }
    }
    // Add coordinate waypoints from route as named fixes (e.g. 55N050W)
    if (deduped) {
      for (const pt of deduped) {
        if (/^\d+[NS]\d+[EW]$/.test(pt.name) && !fixMap.has(`${pt.name}_${pt.lat.toFixed(4)}`)) {
          navLines.push(`${pt.name.padEnd(6)} ${coordPair(pt.lat, pt.lon)}`);
          fixMap.set(`${pt.name}_${pt.lat.toFixed(4)}`, pt);
        }
      }
    }
    navLines.push('');
    navLines.push('[HIGH AIRWAY]');
    const awyDedup = new Set();
    for (const s of airways.high) { const k = `${s.name}${s.lat1.toFixed(4)}${s.lon1.toFixed(4)}`; if (!awyDedup.has(k)) { awyDedup.add(k); navLines.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`); } }
    navLines.push('');
    navLines.push('[LOW AIRWAY]');
    for (const s of airways.low) { const k = `${s.name}${s.lat1.toFixed(4)}${s.lon1.toFixed(4)}`; if (!awyDedup.has(k)) { awyDedup.add(k); navLines.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`); } }
    navLines.push('');
    // Splice into L replacing placeholder
    const placeholderIdx = L.indexOf(NAVDATA_PLACEHOLDER);
    if (placeholderIdx >= 0) {
      L.splice(placeholderIdx, 1, ...navLines);
    }
  }
  L.push('');

  // Draw STAR routes
  L.push('[STAR]');
  for (const entry of allSidStars.filter(e => e.startsWith('STAR:'))) {
    const parts = entry.split(':');
    const procName = `${parts[1]}-${parts[3]}`; // EHAM-SUGOL1A
    const fixNames = (parts[4] || '').split(' ').filter(f => f);
    allProcs.push({ name: procName, airport: parts[1], fixes: fixNames });
    for (let i = 0; i < fixNames.length - 1; i++) {
      const p1 = wpLookup.get(fixNames[i]);
      const p2 = wpLookup.get(fixNames[i + 1]);
      if (p1 && p2) L.push(`${procName.padEnd(14).substring(0, 14)} ${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)}`);
    }
  }
  L.push('');
  L.push('[ARTCC]');
  // FIR boundaries from VATSpy data
  for (const fir of routeFirs) {
    for (let i = 0; i < fir.points.length - 1; i++) {
      const p1 = fir.points[i];
      const p2 = fir.points[i + 1];
      L.push(`${fir.icao.padEnd(6)} ${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)}`);
    }
    // Close the polygon
    if (fir.points.length > 2) {
      const first = fir.points[0];
      const last = fir.points[fir.points.length - 1];
      L.push(`${fir.icao.padEnd(6)} ${coordPair(last.lat, last.lon)} ${coordPair(first.lat, first.lon)}`);
    }
  }
  L.push('');
  // MSA rings and WF route as ARTCC entries (same section as FIR boundaries)
  for (const [icao, msa] of [[FROM, depMSA], [TO, arrMSA]]) {
    const msaName = `${icao}-MSA`;
    for (const g of msa.geo) {
      const coords = g.replace(/ rangering$/, '');
      L.push(`${msaName.padEnd(6)} ${coords}`);
    }
  }
  if (deduped) {
    const routeName = `${FROM}-${LEG_NAME}`;
    for (let i = 1; i < deduped.length - 2; i++) {
      L.push(`${routeName.padEnd(6)} ${coordPair(deduped[i].lat, deduped[i].lon)} ${coordPair(deduped[i + 1].lat, deduped[i + 1].lon)}`);
    }
  }
  // Draw next leg outbound route if available
  let nextDeduped = null;
  if (nextLeg && nextLeg.atcRoute) {
    const nextRoute = nextLeg.atcRoute;
    const nextTo = nextLeg.to;
    const nextArr = await prisma.airport.findUnique({ where: { icao: nextTo } });
    if (nextArr) {
      // Expand next leg route using existing wpLookup + airway graph
      const nextParts = nextRoute.split(/\s+/).filter(Boolean);
      const nextExpanded = [];
      let ni = 0;
      while (ni < nextParts.length) {
        const current = nextParts[ni];
        const isAirway = /\d/.test(current) && /^[A-Z]{1,2}\d/.test(current);
        if (isAirway && ni > 0 && ni < nextParts.length - 1) {
          const prevFix = nextParts[ni - 1];
          const nextFix = nextParts[ni + 1];
          const expanded = expandAirway(current, prevFix, nextFix);
          for (let j = 1; j < expanded.length; j++) nextExpanded.push(expanded[j]);
          ni += 2;
        } else if (!isAirway && current !== 'DCT') {
          nextExpanded.push(current);
          ni++;
        } else {
          ni++;
        }
      }
      // Resolve to coordinates — pick closest to previous waypoint for duplicates
      const nextPoints = [{ lat: arrAirport.lat, lon: arrAirport.lon, name: TO }];
      for (const name of nextExpanded) {
        const lastPt = nextPoints[nextPoints.length - 1];
        // Try coordinate waypoint first
        let m = name.match(/^(\d{2})([NS])(\d{2,3})([EW])$/);
        if (m) {
          const lat = parseInt(m[1]) * (m[2] === 'S' ? -1 : 1);
          const lon = parseInt(m[3]) * (m[4] === 'W' ? -1 : 1);
          nextPoints.push({ lat, lon, name }); continue;
        }
        // Search all fixes/VORs/NDBs for closest match to previous waypoint
        const candidates = [];
        for (const [ident, wp] of wpLookup) {
          if (ident === name) candidates.push(wp);
        }
        // Also check fixes array for duplicates wpLookup may have deduplicated
        for (const f of fixes) { if (f.ident === name && !candidates.some(c => Math.abs(c.lat - f.lat) < 0.01)) candidates.push(f); }
        for (const v of vors) { if (v.ident === name && !candidates.some(c => Math.abs(c.lat - v.lat) < 0.01)) candidates.push(v); }
        if (candidates.length > 0) {
          candidates.sort((a, b) => haversineNm(lastPt.lat, lastPt.lon, a.lat, a.lon) - haversineNm(lastPt.lat, lastPt.lon, b.lat, b.lon));
          nextPoints.push({ lat: candidates[0].lat, lon: candidates[0].lon, name });
        } else {
          const wp = wpLookup.get(name);
          if (wp) nextPoints.push({ lat: wp.lat, lon: wp.lon, name });
        }
      }
      nextPoints.push({ lat: nextArr.lat, lon: nextArr.lon, name: nextTo });
      nextDeduped = nextPoints.filter((p, idx) => idx === 0 || p.name !== nextPoints[idx - 1].name);
      const nextRouteName = `${TO}-${nextLegName}`;
      console.log(`  Next route: ${nextDeduped.length} waypoints for ${nextLegName}`);
      // Skip first (dep airport) and last two (arr airport) — same as inbound route
      for (let i = 1; i < nextDeduped.length - 2; i++) {
        L.push(`${nextRouteName.padEnd(6)} ${coordPair(nextDeduped[i].lat, nextDeduped[i].lon)} ${coordPair(nextDeduped[i + 1].lat, nextDeduped[i + 1].lon)}`);
      }
    }
  }
  // Draw previous leg inbound route if available
  let prevDeduped = null;
  if (prevLeg && prevLeg.atcRoute) {
    const prevRoute = prevLeg.atcRoute;
    const prevFrom = prevLeg.from;
    const prevDep = await prisma.airport.findUnique({ where: { icao: prevFrom } });
    if (prevDep) {
      const prevParts = prevRoute.split(/\s+/).filter(Boolean);
      const prevExpanded = [];
      let pi = 0;
      while (pi < prevParts.length) {
        const current = prevParts[pi];
        const isAirway = /\d/.test(current) && /^[A-Z]{1,2}\d/.test(current);
        if (isAirway && pi > 0 && pi < prevParts.length - 1) {
          const prevFix = prevParts[pi - 1];
          const nextFix = prevParts[pi + 1];
          const expanded = expandAirway(current, prevFix, nextFix);
          for (let j = 1; j < expanded.length; j++) prevExpanded.push(expanded[j]);
          pi += 2;
        } else if (!isAirway && current !== 'DCT') {
          prevExpanded.push(current);
          pi++;
        } else {
          pi++;
        }
      }
      // Resolve to coordinates — pick closest to previous waypoint
      const prevPoints = [{ lat: prevDep.lat, lon: prevDep.lon, name: prevFrom }];
      for (const name of prevExpanded) {
        const lastPt = prevPoints[prevPoints.length - 1];
        let m = name.match(/^(\d{2})([NS])(\d{2,3})([EW])$/);
        if (m) {
          const lat = parseInt(m[1]) * (m[2] === 'S' ? -1 : 1);
          const lon = parseInt(m[3]) * (m[4] === 'W' ? -1 : 1);
          prevPoints.push({ lat, lon, name }); continue;
        }
        const candidates = [];
        for (const [ident, wp] of wpLookup) { if (ident === name) candidates.push(wp); }
        for (const f of fixes) { if (f.ident === name && !candidates.some(c => Math.abs(c.lat - f.lat) < 0.01)) candidates.push(f); }
        for (const v of vors) { if (v.ident === name && !candidates.some(c => Math.abs(c.lat - v.lat) < 0.01)) candidates.push(v); }
        if (candidates.length > 0) {
          candidates.sort((a, b) => haversineNm(lastPt.lat, lastPt.lon, a.lat, a.lon) - haversineNm(lastPt.lat, lastPt.lon, b.lat, b.lon));
          prevPoints.push({ lat: candidates[0].lat, lon: candidates[0].lon, name });
        } else {
          const wp = wpLookup.get(name);
          if (wp) prevPoints.push({ lat: wp.lat, lon: wp.lon, name });
        }
      }
      prevPoints.push({ lat: depAirport.lat, lon: depAirport.lon, name: FROM });
      prevDeduped = prevPoints.filter((p, idx) => idx === 0 || p.name !== prevPoints[idx - 1].name);
      const prevRouteName = `${prevFrom}-${prevLegName}`;
      console.log(`  Prev route: ${prevDeduped.length} waypoints for ${prevLegName}`);
      for (let i = 1; i < prevDeduped.length - 2; i++) {
        L.push(`${prevRouteName.padEnd(6)} ${coordPair(prevDeduped[i].lat, prevDeduped[i].lon)} ${coordPair(prevDeduped[i + 1].lat, prevDeduped[i + 1].lon)}`);
      }
    }
  }
  L.push('');
  L.push('[ARTCC HIGH]');
  L.push('');
  L.push('[ARTCC LOW]');
  L.push('');

  // GEO for both airports + coastline + extended centrelines
  L.push('[GEO]');
  addGeoForAirport(L, depAirport, FROM, depGround);
  L.push('');
  addGeoForAirport(L, arrAirport, TO, arrGround);
  L.push('');
  L.push('');

  // Add world coastline clipped to route corridor
  if (fs.existsSync(COASTLINE_PATH)) {
    // Parse DMS coordinate to decimal
    function parseDMS(dms) {
      const m = dms.match(/^([NSEW])(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!m) return NaN;
      const deg = parseInt(m[2]) + parseInt(m[3]) / 60 + parseFloat(`${m[4]}.${m[5]}`) / 3600;
      return (m[1] === 'S' || m[1] === 'W') ? -deg : deg;
    }

    // Bounding box: route corridor + margin
    const margin = 3; // degrees
    const allLats = routeCenters.map(c => c.lat);
    const allLons = routeCenters.map(c => c.lon);
    const bbMinLat = Math.min(...allLats) - margin;
    const bbMaxLat = Math.max(...allLats) + margin;
    const bbMinLon = Math.min(...allLons) - margin;
    const bbMaxLon = Math.max(...allLons) + margin;

    const coastFile = fs.readFileSync(COASTLINE_PATH, 'utf-8');
    const geoStart = coastFile.indexOf('[GEO]');
    if (geoStart !== -1) {
      const geoLines = coastFile.substring(geoStart + 5).split('\n');
      let coastCount = 0;
      L.push('; World Coastline');
      L.push(`Coastline            S999.00.00.000 E999.00.00.000 S999.00.00.000 E999.00.00.000`);
      for (const line of geoLines) {
        if (line.startsWith('[')) break; // next section
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;
        const lat1 = parseDMS(parts[0]), lon1 = parseDMS(parts[1]);
        const lat2 = parseDMS(parts[2]), lon2 = parseDMS(parts[3]);
        if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) continue;
        // Check if either endpoint is within bounding box
        const in1 = lat1 >= bbMinLat && lat1 <= bbMaxLat && lon1 >= bbMinLon && lon1 <= bbMaxLon;
        const in2 = lat2 >= bbMinLat && lat2 <= bbMaxLat && lon2 >= bbMinLon && lon2 <= bbMaxLon;
        if (in1 || in2) {
          L.push(trimmed);
          coastCount++;
        }
      }
      console.log(`  ${coastCount} coastline segments`);
    }
  }
  L.push('');

  // Labels for both — prefix with ICAO group so ASR can enable them
  const depLabels = collectLabelItems(depGround.labels);
  const arrLabels = collectLabelItems(arrGround.labels);
  L.push('[LABELS]');
  L.push(`"${FROM}" ${coordPair(depAirport.lat, depAirport.lon)} 16777215`);
  if (depLabels.lines) L.push(depLabels.lines);
  L.push(`"${TO}" ${coordPair(arrAirport.lat, arrAirport.lon)} 16777215`);
  if (arrLabels.lines) L.push(arrLabels.lines);
  L.push('');

  // SMR free text: all ground labels + airport names
  const smrFreeTextItems = [FROM, TO, ...depLabels.items, ...arrLabels.items]
    .map(t => `SCT2\\${t}`)
    .sort((a, b) => a.localeCompare(b));
  // APP free text: none (MSA labels are now fixes, not free text)
  const appFreeTextItems = []
    .sort((a, b) => a.localeCompare(b));

  // Regions for both
  L.push('[REGIONS]');
  addRegionsForAirport(L, depAirport, FROM, depGround);
  addRegionsForAirport(L, arrAirport, TO, arrGround);
  L.push('');

  // Write SCT
  const sctDir = path.join(OUTPUT_DIR, 'Data', 'Sector_Files');
  fs.mkdirSync(sctDir, { recursive: true });
  fs.writeFileSync(path.join(sctDir, `${LEG_NAME}.sct`), L.join('\r\n'), 'utf-8');
  console.log(`Written ${L.length} lines (${(L.join('\r\n').length / 1024).toFixed(0)}KB) to ${LEG_NAME}.sct`);

  // ===== BUILD ESE =====
  const E = [];
  E.push(`; ${LEG_NAME} Extended Sector File (${FROM} -> ${TO})`);
  E.push('');
  E.push('[POSITIONS]');
  // Parse XP12 ATC frequencies
  const xp12Freqs = parseXP12Frequencies(XP12_ATC);
  const afvFreqs = parseAFVStations(AFV_STATIONS);
  // Helper: look up frequency from AFV first, then XP12 fallback
  // Tries multiple callsign variants for regional naming conventions
  const getFreq = (callsign, xp12Role, xp12Icao) => {
    if (afvFreqs[callsign]) return afvFreqs[callsign];
    // Extract ICAO and suffix (e.g. KLAX_TWR -> KLAX + _TWR)
    const underIdx = callsign.indexOf('_');
    if (underIdx > 0) {
      const icaoPart = callsign.substring(0, underIdx);
      const suffix = callsign.substring(underIdx);
      // US: KLAX -> LAX (drop K)
      if (icaoPart.startsWith('K') && icaoPart.length === 4) {
        const us = icaoPart.substring(1) + suffix;
        if (afvFreqs[us]) return afvFreqs[us];
      }
      // Canada: CYVR -> YVR (drop C)
      if (icaoPart.startsWith('C') && icaoPart.length === 4) {
        const ca = icaoPart.substring(1) + suffix;
        if (afvFreqs[ca]) return afvFreqs[ca];
      }
      // Australia: YSSY -> SY (drop Y, take last 2 chars)
      if (icaoPart.startsWith('Y') && icaoPart.length === 4) {
        const au = icaoPart.substring(2) + suffix;
        if (afvFreqs[au]) return afvFreqs[au];
      }
      // Generic: try last 2 or 3 chars of ICAO
      if (icaoPart.length === 4) {
        const short3 = icaoPart.substring(1) + suffix;
        const short2 = icaoPart.substring(2) + suffix;
        if (afvFreqs[short3]) return afvFreqs[short3];
        if (afvFreqs[short2]) return afvFreqs[short2];
      }
    }
    const xp12 = xp12Freqs[xp12Icao]?.find(f => f.role === xp12Role)?.freqs[0];
    return xp12 || null;
  };
  // Convert ICAO callsign to AFV callsign (KLAX_TWR -> LAX_TWR, YSSY_GND -> SY_GND)
  const toAFVCallsign = (callsign) => {
    const underIdx = callsign.indexOf('_');
    if (underIdx <= 0) return callsign;
    const icaoPart = callsign.substring(0, underIdx);
    const suffix = callsign.substring(underIdx);
    // Try exact first
    if (afvFreqs[callsign]) return callsign;
    // US: KLAX -> LAX
    if (icaoPart.startsWith('K') && icaoPart.length === 4) {
      const us = icaoPart.substring(1) + suffix;
      if (afvFreqs[us]) return us;
    }
    // Canada: CYVR -> YVR
    if (icaoPart.startsWith('C') && icaoPart.length === 4) {
      const ca = icaoPart.substring(1) + suffix;
      if (afvFreqs[ca]) return ca;
    }
    // Australia: YSSY -> SY
    if (icaoPart.startsWith('Y') && icaoPart.length === 4) {
      const au = icaoPart.substring(2) + suffix;
      if (afvFreqs[au]) return au;
    }
    // Generic: try 3 or 2 char
    if (icaoPart.length === 4) {
      const s3 = icaoPart.substring(1) + suffix;
      if (afvFreqs[s3]) return s3;
      const s2 = icaoPart.substring(2) + suffix;
      if (afvFreqs[s2]) return s2;
    }
    return callsign; // fallback to original
  };

  // Same lookup for AFV existence check
  const inAFV = (callsign) => {
    if (afvFreqs[callsign]) return true;
    const underIdx = callsign.indexOf('_');
    if (underIdx <= 0) return false;
    const icaoPart = callsign.substring(0, underIdx);
    const suffix = callsign.substring(underIdx);
    if (icaoPart.startsWith('K') && icaoPart.length === 4 && afvFreqs[icaoPart.substring(1) + suffix]) return true;
    if (icaoPart.startsWith('C') && icaoPart.length === 4 && afvFreqs[icaoPart.substring(1) + suffix]) return true;
    if (icaoPart.startsWith('Y') && icaoPart.length === 4 && afvFreqs[icaoPart.substring(2) + suffix]) return true;
    if (icaoPart.length === 4 && afvFreqs[icaoPart.substring(1) + suffix]) return true;
    if (icaoPart.length === 4 && afvFreqs[icaoPart.substring(2) + suffix]) return true;
    return false;
  };
  // Return the EuroScope middle letter for a position suffix
  const sfxToMiddle = (sfx) => {
    if (sfx === 'CTR') return 'C';
    if (sfx === 'FSS') return 'F';
    if (sfx === 'APP' || sfx === 'TRACON') return 'A';
    if (sfx === 'TWR') return 'T';
    if (sfx === 'GND') return 'G';
    if (sfx === 'DEL') return 'D';
    if (sfx === 'ATIS') return 'I';
    return 'C';
  };
  // Return the EuroScope facility level for a position suffix
  const sfxToFacility = (sfx) => {
    if (sfx === 'DEL') return 2;
    if (sfx === 'GND') return 3;
    if (sfx === 'TWR') return 4;
    if (sfx === 'APP') return 5;
    if (sfx === 'CTR') return 6;
    if (sfx === 'FSS') return 7;
    return 6;
  };
  // All AFV CTR/FSS callsigns for a VATSpy position prefix (e.g. EGGX -> EGGX_CTR, EGGX_A_CTR, ...)
  // Only CTR and FSS suffixes — GND/TWR/DEL/APP belong to airport sections, not transit FIRs
  const afvCallsignsForPrefix = (prefix) =>
    Object.keys(afvFreqs).filter(cs => {
      if (!cs.startsWith(prefix + '_')) return false;
      const lastSfx = cs.substring(cs.lastIndexOf('_') + 1);
      return lastSfx === 'CTR' || lastSfx === 'FSS';
    });
  // All AFV CTR/FSS callsigns for a VATSpy position, trying both the callsign prefix AND the base FIR ID.
  // Needed because e.g. CZEG FIR has VATSpy prefix "ZEG" but AFV also has entries under "CZEG_".
  const afvCallsignsForPosition = (vp) => {
    const firBase = vp.firId.split('-')[0];
    const prefixes = [...new Set([vp.callsign, firBase])];
    return [...new Set(prefixes.flatMap(p => afvCallsignsForPrefix(p)))];
  };

  // Find the AFV prefix an airport actually uses (e.g. KLAX -> LAX, EGPN -> EGPN)
  const afvAirportPrefix = (icao) => {
    const has = (pfx) => Object.keys(afvFreqs).some(cs => cs.startsWith(pfx + '_'));
    if (has(icao)) return icao;
    if (icao.startsWith('K') && icao.length === 4 && has(icao.substring(1))) return icao.substring(1);
    if (icao.startsWith('C') && icao.length === 4 && has(icao.substring(1))) return icao.substring(1);
    if (icao.startsWith('Y') && icao.length === 4 && has(icao.substring(2))) return icao.substring(2);
    if (icao.length === 4 && has(icao.substring(1))) return icao.substring(1);
    return icao;
  };
  // Return the radius (nm) for a connection profile given a position suffix
  const sfxToRadius = (sfx) => {
    if (sfx === 'APP' || sfx === 'DEP' || sfx === 'TRACON') return 100;
    if (sfx === 'TWR') return 30;
    return 20;
  };

  // Airport positions: scan AFV directly for all positions at each airport
  const airportAfvPrefixes = {}; // icao -> afv prefix (e.g. KLAX -> LAX)
  for (const [icao, apt] of [[FROM, depAirport], [TO, arrAirport]]) {
    const afvPfx = afvAirportPrefix(icao);
    airportAfvPrefixes[icao] = afvPfx;
    const coord = coordPair(apt.lat, apt.lon).replace(' ', ':');
    const aptCs = Object.keys(afvFreqs).filter(cs => {
      if (!cs.startsWith(afvPfx + '_')) return false;
      const lastSfx = cs.substring(cs.lastIndexOf('_') + 1);
      return lastSfx !== 'CTR' && lastSfx !== 'FSS';
    });
    if (aptCs.length === 0) {
      // No AFV data — emit a basic set with placeholder freqs
      for (const [sfx, mid] of [['TWR','T'],['GND','G'],['DEL','D'],['APP','A']]) {
        E.push(`${icao}_${sfx}:${apt.name}:199.998:${icao}:${mid}:${icao}:${sfx}:-:-:0100:0177:${coord}`);
      }
    } else {
      for (const cs of aptCs) {
        const lastUs = cs.lastIndexOf('_');
        const csPfx = cs.substring(0, lastUs);
        const csSfx = cs.substring(lastUs + 1);
        const csMid = sfxToMiddle(csSfx);
        const freq = afvFreqs[cs];
        E.push(`${cs}:${apt.name}:${freq}:${afvPfx}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coord}`);
        E.push(`${cs}:${apt.name}:199.998:${afvPfx}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coord}`);
      }
    }
  }
  // US TRACON positions: add TRACON facility + sibling airport positions
  const addedTraconAirports = new Set([FROM, TO]); // track what we've already added
  for (const [icao, apt] of [[FROM, depAirport], [TO, arrAirport]]) {
    for (const [tracon, airports] of Object.entries(US_TRACON_MAP)) {
      if (airports.includes(icao)) {
        const coord = coordPair(apt.lat, apt.lon).replace(' ', ':');
        // Add TRACON facility positions (e.g. N90_APP, N90_DEP)
        const traconCs = Object.keys(afvFreqs).filter(cs => cs.startsWith(tracon + '_'));
        for (const cs of traconCs) {
          const lastUs = cs.lastIndexOf('_');
          const csPfx = cs.substring(0, lastUs);
          const csSfx = cs.substring(lastUs + 1);
          const csMid = sfxToMiddle(csSfx);
          const freq = afvFreqs[cs];
          E.push(`${cs}:${tracon} TRACON:${freq}:${tracon}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coord}`);
          E.push(`${cs}:${tracon} TRACON:199.998:${tracon}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coord}`);
        }
        if (traconCs.length > 0) console.log(`  Added ${traconCs.length} ${tracon} TRACON positions for ${icao}`);
        // Add sibling airport positions from the same TRACON
        for (const siblingIcao of airports) {
          if (addedTraconAirports.has(siblingIcao)) continue;
          addedTraconAirports.add(siblingIcao);
          const sibAfvPfx = afvAirportPrefix(siblingIcao);
          const sibCs = Object.keys(afvFreqs).filter(cs => {
            if (!cs.startsWith(sibAfvPfx + '_')) return false;
            const sfx = cs.substring(cs.lastIndexOf('_') + 1);
            return sfx !== 'CTR' && sfx !== 'FSS';
          });
          for (const cs of sibCs) {
            const lastUs = cs.lastIndexOf('_');
            const csPfx = cs.substring(0, lastUs);
            const csSfx = cs.substring(lastUs + 1);
            const csMid = sfxToMiddle(csSfx);
            const freq = afvFreqs[cs];
            E.push(`${cs}:${siblingIcao}:${freq}:${sibAfvPfx}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coord}`);
            E.push(`${cs}:${siblingIcao}:199.998:${sibAfvPfx}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coord}`);
          }
          if (sibCs.length > 0) console.log(`  Added ${sibCs.length} sibling ${sibAfvPfx} positions (${tracon} TRACON)`);
        }
        break;
      }
    }
  }

  // Overlay FIRs that don't have their own GeoJSON boundary but appear when constituent FIRs are transited
  const OVERLAY_POSITIONS = [
    { callsign: 'NAT_FSS', name: 'Shanwick & Gander', triggerFirs: new Set(['EGGX', 'CZQO', 'CZQX', 'BIRD', 'LPPO', 'ENOB']) },
  ];
  const routeFirSet = new Set(routeFirs.map(f => f.icao.split('-')[0]));
  const activeOverlays = OVERLAY_POSITIONS.filter(o => [...o.triggerFirs].some(id => routeFirSet.has(id)));

  // Real VATSIM FIR/sector positions from VATSpy with XP12 frequencies
  const addedPrefixes = new Set();
  const positionShortIds = []; // collect short IDs for OWNER line
  for (const vp of vatspy.positions) {
    if (addedPrefixes.has(vp.callsign)) continue;
    addedPrefixes.add(vp.callsign);
    const shortId = vp.callsign;
    positionShortIds.push(shortId);
    const coordStr = coordPair(mid.lat, mid.lon).replace(' ', ':');
    // Emit all AFV callsigns for this prefix (primary + all subsectors)
    const afvCs = afvCallsignsForPosition(vp);
    if (afvCs.length === 0) {
      // No AFV data — emit a placeholder CTR so the sector file is still valid
      E.push(`${vp.callsign}_CTR:${vp.name}:199.998:${shortId}:C:${shortId}:CTR:-:-:0100:0177:${coordStr}`);
    } else {
      for (const cs of afvCs) {
        const lastUs = cs.lastIndexOf('_');
        const csPfx = cs.substring(0, lastUs);
        const csSfx = cs.substring(lastUs + 1);
        const csMid = sfxToMiddle(csSfx);
        const freq = afvFreqs[cs];
        E.push(`${cs}:${vp.name}:${freq}:${shortId}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coordStr}`);
        E.push(`${cs}:${vp.name}:199.998:${shortId}:${csMid}:${csPfx}:${csSfx}:-:-:0100:0177:${coordStr}`);
      }
    }
  }
  // Overlay positions (e.g. NAT_FSS) — not in GeoJSON so not auto-detected
  const overlayCoordStr = coordPair(mid.lat, mid.lon).replace(' ', ':');
  for (const ov of activeOverlays) {
    const lastUs = ov.callsign.lastIndexOf('_');
    const ovPrefix = ov.callsign.substring(0, lastUs);
    const ovSfx = ov.callsign.substring(lastUs + 1);
    const ovMid = sfxToMiddle(ovSfx);
    const ovFreq = afvFreqs[ov.callsign] || '199.998';
    E.push(`${ov.callsign}:${ov.name}:${ovFreq}:${ovPrefix}:${ovMid}:${ovPrefix}:${ovSfx}:-:-:0100:0177:${overlayCoordStr}`);
    if (ovFreq !== '199.998') {
      E.push(`${ov.callsign}:${ov.name}:199.998:${ovPrefix}:${ovMid}:${ovPrefix}:${ovSfx}:-:-:0100:0177:${overlayCoordStr}`);
    }
    positionShortIds.push(ovPrefix);
  }
  E.push('');
  E.push('[SIDSSTARS]');
  let totalSids = 0, totalStars = 0;
  for (const icao of [FROM, TO]) {
    const cifpPath = path.join(CIFP_DIR, `${icao}.dat`);
    if (fs.existsSync(cifpPath)) {
      const sidstars = parseCIFP(cifpPath, icao);
      for (const entry of sidstars) E.push(entry);
      const sids = sidstars.filter(s => s.startsWith('SID:')).length;
      const stars = sidstars.filter(s => s.startsWith('STAR:')).length;
      totalSids += sids; totalStars += stars;
      console.log(`  ${icao}: ${sids} SIDs, ${stars} STARs`);
    }
  }
  // Register MSA and route as SID entries for all runways so EuroScope recognises them
  // ESE uses short runway numbers (06 not 06L) and needs at least one fix
  for (const [icao, apt] of [[FROM, depAirport], [TO, arrAirport]]) {
    const msaFix = (icao === FROM ? depMSA : arrMSA).fix || icao;
    const rwyNums = [...new Set(apt.runways.flatMap(r => [r.ident1, r.ident2].filter(Boolean).map(id => id.replace(/[LRC]$/, ''))))];
    for (const r of rwyNums) {
      E.push(`SID:${icao}:${r}:MSA:${msaFix}`);
      if (ATC_ROUTE && icao === FROM) E.push(`SID:${icao}:${r}:${LEG_NAME}:${msaFix}`);
    }
  }
  E.push('');
  E.push('[AIRSPACE]');

  // Large encompassing sector for the entire leg (GND-FL660)
  // Create a wide box around the route corridor
  const boxMargin = 5; // degrees
  const allCenterLats = routeCenters.map(c => c.lat);
  const allCenterLons = routeCenters.map(c => c.lon);
  const sMinLat = Math.min(...allCenterLats) - boxMargin;
  const sMaxLat = Math.max(...allCenterLats) + boxMargin;
  const sMinLon = Math.min(...allCenterLons) - boxMargin;
  const sMaxLon = Math.max(...allCenterLons) + boxMargin;
  E.push(`SECTORLINE:${LEG_NAME}_BOUNDARY`);
  E.push(`COORD:${coordPair(sMinLat, sMinLon)}`);
  E.push(`COORD:${coordPair(sMaxLat, sMinLon)}`);
  E.push(`COORD:${coordPair(sMaxLat, sMaxLon)}`);
  E.push(`COORD:${coordPair(sMinLat, sMaxLon)}`);
  E.push(`COORD:${coordPair(sMinLat, sMinLon)}`);
  E.push('');
  // Build a map: FIR ICAO -> [short IDs that belong to this FIR]
  const firOwnerMap = {};
  for (const fir of routeFirs) {
    const firKey = fir.icao;
    const firPosEntries = vatspy.firPositions[firKey] || vatspy.firPositions[firKey.split('-')[0]] || [];
    firOwnerMap[firKey] = [...new Set(firPosEntries.map(p => p.callsign))];
  }

  // Find which FIR each airport belongs to (for ownership chain)
  function findAirportFir(icao, lat, lon) {
    for (const fir of routeFirs) {
      if (firOwnerMap[fir.icao] && firOwnerMap[fir.icao].length > 0) {
        // Check if airport is within ~200nm of the FIR center
        const firCenter = fir.points.length > 0 ? {
          lat: fir.points.reduce((s, p) => s + p.lat, 0) / fir.points.length,
          lon: fir.points.reduce((s, p) => s + p.lon, 0) / fir.points.length
        } : null;
        if (firCenter && haversineNm(lat, lon, firCenter.lat, firCenter.lon) < 500) {
          return fir.icao;
        }
      }
    }
    return null;
  }

  const depFir = findAirportFir(FROM, depAirport.lat, depAirport.lon);
  const arrFir = findAirportFir(TO, arrAirport.lat, arrAirport.lon);

  E.push(`SECTOR:${LEG_NAME}:0:66000`);
  // Owner list: only dep + arr airport prefixes and their FIR owners
  const globalOwners = [airportAfvPrefixes[FROM] || FROM, airportAfvPrefixes[TO] || TO];
  if (depFir && firOwnerMap[depFir]) globalOwners.push(...firOwnerMap[depFir]);
  if (arrFir && firOwnerMap[arrFir]) globalOwners.push(...firOwnerMap[arrFir]);
  E.push(`OWNER:${[...new Set(globalOwners)].join(':')}`);
  E.push(`BORDER:${LEG_NAME}_BOUNDARY`);
  E.push('');

  // Sub-sector definitions from transited FIRs — each FIR only owned by its own positions
  for (const fir of routeFirs) {
    const sectorName = fir.icao.replace(/-/g, '_');
    const owners = firOwnerMap[fir.icao] || [];
    if (owners.length === 0) continue;

    E.push(`SECTORLINE:${sectorName}_LINE`);
    for (const pt of fir.points) {
      E.push(`COORD:${coordPair(pt.lat, pt.lon).replace(' ', ':')}`);
    }
    E.push('');
    E.push(`SECTOR:${sectorName}:0:66000`);
    E.push(`OWNER:${owners.join(':')}`);
    E.push(`BORDER:${sectorName}_LINE`);
    E.push('');
  }

  // Per-airport sectors — owned by airport prefix + its FIR's enroute positions only
  for (const [icao, apt, fir] of [[FROM, depAirport, depFir], [TO, arrAirport, arrFir]]) {
    const pts = [];
    for (let i = 0; i <= 36; i++) { const p = projectPoint(apt.lat, apt.lon, (360/36)*i, 30); pts.push(coordPair(p.lat, p.lon)); }
    E.push(`SECTORLINE:${icao}_BOUNDARY`);
    for (const pt of pts) E.push(`COORD:${pt}`);
    E.push('');
    E.push(`SECTOR:${icao}_TWR:0:24500`);
    const aptPrefix = airportAfvPrefixes[icao] || icao;
    const aptOwners = [aptPrefix];
    // Add TRACON as owner if applicable
    for (const [tracon, airports] of Object.entries(US_TRACON_MAP)) {
      if (airports.includes(icao)) { aptOwners.push(tracon); break; }
    }
    if (fir && firOwnerMap[fir]) aptOwners.push(...firOwnerMap[fir]);
    E.push(`OWNER:${[...new Set(aptOwners)].join(':')}`);
    E.push(`BORDER:${icao}_BOUNDARY`);
    E.push('');
  }

  // ALTOWNER entries for observing — one per FIR, puts that FIR's owner first
  for (const fir of routeFirs) {
    const firKey = fir.icao;
    const owners = firOwnerMap[firKey] || [];
    if (owners.length === 0) continue;
    // "Observing KZAU" — puts CHI first so you see KZAU traffic as if you were CHI_CTR
    const allIds = [...new Set([...owners, airportAfvPrefixes[FROM] || FROM, airportAfvPrefixes[TO] || TO])];
    E.push(`ALTOWNER:Observing ${firKey}:${allIds.join(':')}`);
  }
  // "Observing" with no ownership (pure observer)
  E.push(`ALTOWNER:Observing:--`);
  E.push('');

  fs.writeFileSync(path.join(sctDir, `${LEG_NAME}.ese`), E.join('\r\n'), 'utf-8');

  // ===== BUILD PRF =====
  const prfDir = path.join(OUTPUT_DIR, LEG_NAME);
  fs.mkdirSync(prfDir, { recursive: true });
  const prf = [
    `Settings\tSettingsfileSYMBOLOGY\t\\..\\Data\\Settings\\Symbology_Enroute.txt`,
    `Settings\tSettingsfileTAGS\t\\..\\Data\\Settings\\Tags.txt`,
    `Settings\tSettingsfileSCREEN\t\\..\\Data\\Settings\\Screen.txt`,
    `Settings\tSettingsfile\t\\..\\Data\\Settings\\General.txt`,
    `Settings\tSettingsfilePROFILE\t\\..\\Data\\Settings\\Profiles_${LEG_NAME}.txt`,
    `Settings\tSettingsfileVOICE\t\\..\\Data\\Settings\\Voice_${LEG_NAME}.txt`,
    `Settings\tSettingsfileARR\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileDEP\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileFP\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileSEL\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileSIL\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileCONFLICT\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\talias\t\\..\\Data\\Alias\\WorldFlight.txt`,
    `Settings\tsector\t\\..\\Data\\Sector_Files\\${LEG_NAME}.sct`,
    `Settings\tairlines\t\\..\\Data\\Datafiles\\ICAO_Airlines.txt`,
    `Settings\tairports\t\\..\\Data\\Datafiles\\ICAO_Airports.txt`,
    `Settings\taircraft\t\\..\\Data\\Datafiles\\ICAO_Aircraft.txt`,
    `Settings\tairportcoords\t\\..\\Data\\Datafiles\\icao.txt`,
    `ASRFastKeys\t1\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_SMR.asr`,
    `ASRFastKeys\t2\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_APP.asr`,
    `ASRFastKeys\t3\t\\..\\Data\\ASR\\${LEG_NAME}_Enroute.asr`,
    `ASRFastKeys\t4\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_SMR.asr`,
    `ASRFastKeys\t5\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_APP.asr`,
    `RecentFiles\tRecent1\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_SMR.asr`,
    `RecentFiles\tRecent2\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_APP.asr`,
    `RecentFiles\tRecent3\t\\..\\Data\\ASR\\${LEG_NAME}_Enroute.asr`,
    `RecentFiles\tRecent4\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_SMR.asr`,
    `RecentFiles\tRecent5\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_APP.asr`,
    `Plugins\tPlugin0\t\\..\\Data\\Plugin\\vSMR\\vSMR.dll`,
    `Plugins\tPlugin0Display0\tSMR radar display`,
    `Plugins\tPlugin1\t\\..\\Data\\Plugin\\TopSky\\TopSky.dll`,
    `Plugins\tPlugin1Display0\tStandard ES radar screen`,
    /* VATCAN Slots plugin. The DisplayN line is what EuroScope treats as
       "allowed to draw" on that screen type, so registering it here means the
       controller does not have to tick anything after loading the pack.
       Only emitted when the DLL is actually bundled, since a missing plugin
       path makes EuroScope complain on every profile load. */
    ...(fs.existsSync(path.join(__dirname, '..', 'templates', 'Plugin', 'VATCAN', 'VATCANBookings.dll'))
      ? [
          `Plugins\tPlugin2\t\\..\\Data\\Plugin\\VATCAN\\VATCANBookings.dll`,
          `Plugins\tPlugin2Display0\tStandard ES radar screen`,
          `Plugins\tPlugin2Display1\tSMR radar display`,
        ]
      : []),
    `LastSession\tserver\tAUTOMATIC`,
    `LastSession\tcallsign\t- Select profile---->`,
  ];
  fs.writeFileSync(path.join(prfDir, `${LEG_NAME}.prf`), prf.join('\r\n'), 'utf-8');

  // ===== CONNECTION PROFILES =====
  const profilesDir = path.join(OUTPUT_DIR, 'Data', 'Settings');
  fs.mkdirSync(profilesDir, { recursive: true });
  const profLines = ['PROFILE'];
  const emittedProfiles = new Set();
  // Airport positions — from AFV directly
  for (const [icao, apt] of [[FROM, depAirport], [TO, arrAirport]]) {
    const afvPfx = airportAfvPrefixes[icao];
    const aptCs = Object.keys(afvFreqs).filter(cs => {
      if (!cs.startsWith(afvPfx + '_')) return false;
      const lastSfx = cs.substring(cs.lastIndexOf('_') + 1);
      return lastSfx !== 'CTR' && lastSfx !== 'FSS';
    });
    for (const cs of aptCs) {
      const csSfx = cs.substring(cs.lastIndexOf('_') + 1);
      emittedProfiles.add(cs);
      profLines.push(`PROFILE:${cs}:${sfxToRadius(csSfx)}:${sfxToFacility(csSfx)}`);
      profLines.push(`ATIS2:${apt.name}`);
      profLines.push(`ATIS3:`);
      profLines.push(`ATIS4:WorldFlight 2026`);
    }
  }
  // Enroute CTR/FSS positions — only those in AFV; emit both if both exist
  for (const vp of vatspy.positions) {
    if (addedPrefixes.has('PROF_' + vp.callsign)) continue;
    addedPrefixes.add('PROF_' + vp.callsign);
    for (const cs of afvCallsignsForPosition(vp)) {
      if (emittedProfiles.has(cs)) continue; // already emitted by airport section
      emittedProfiles.add(cs);
      const csSfx = cs.substring(cs.lastIndexOf('_') + 1);
      profLines.push(`PROFILE:${cs}:300:${sfxToFacility(csSfx)}`);
      profLines.push(`ATIS2:${vp.name}`);
      profLines.push(`ATIS3:`);
      profLines.push(`ATIS4:WorldFlight 2026`);
    }
  }
  // Overlay positions
  for (const ov of activeOverlays) {
    const csSfx = ov.callsign.substring(ov.callsign.lastIndexOf('_') + 1);
    profLines.push(`PROFILE:${ov.callsign}:300:${sfxToFacility(csSfx)}`);
    profLines.push(`ATIS2:${ov.name}`);
    profLines.push(`ATIS3:`);
    profLines.push(`ATIS4:WorldFlight 2026`);
  }
  profLines.push('END');
  fs.writeFileSync(path.join(profilesDir, `Profiles_${LEG_NAME}.txt`), profLines.join('\r\n'), 'utf-8');

  // ===== VOICE SETUP =====
  const voiceLines = ['VOICE'];
  const emittedVoice = new Set();
  // Airport frequencies — from AFV directly
  for (const [icao] of [[FROM], [TO]]) {
    const afvPfx = airportAfvPrefixes[icao];
    for (const cs of Object.keys(afvFreqs).filter(cs => {
      if (!cs.startsWith(afvPfx + '_')) return false;
      const lastSfx = cs.substring(cs.lastIndexOf('_') + 1);
      return lastSfx !== 'CTR' && lastSfx !== 'FSS';
    })) {
      emittedVoice.add(cs);
      voiceLines.push(`AG:${cs}:${afvFreqs[cs]}`);
    }
  }
  // Enroute CTR/FSS positions — only AFV-listed; emit both if both exist
  const addedVoice = new Set();
  for (const vp of vatspy.positions) {
    if (addedVoice.has(vp.callsign)) continue;
    addedVoice.add(vp.callsign);
    for (const cs of afvCallsignsForPosition(vp)) {
      if (emittedVoice.has(cs)) continue; // already emitted by airport section
      emittedVoice.add(cs);
      voiceLines.push(`AG:${cs}:${afvFreqs[cs]}`);
    }
  }
  // Overlay positions
  for (const ov of activeOverlays) {
    const freq = afvFreqs[ov.callsign];
    if (freq) voiceLines.push(`AG:${ov.callsign}:${freq}`);
  }
  voiceLines.push('END');
  fs.writeFileSync(path.join(profilesDir, `Voice_${LEG_NAME}.txt`), voiceLines.join('\r\n'), 'utf-8');

  // ===== ASR FILES =====
  const asrDir = path.join(OUTPUT_DIR, 'Data', 'ASR');
  fs.mkdirSync(asrDir, { recursive: true });

  // Filter SIDs/STARs to those matching the ATC route (by procedure name or shared fix)
  const routeTokens = new Set(ATC_ROUTE ? ATC_ROUTE.trim().split(/\s+/) : []);
  const depRelevantProcs = allProcs.filter(p => {
    if (p.airport !== FROM) return false;
    const procShort = p.name.substring(p.name.indexOf('-') + 1); // GMN7 from KLAX-GMN7
    return routeTokens.has(procShort) || p.fixes.some(f => routeTokens.has(f));
  });
  const arrRelevantProcs = allProcs.filter(p => {
    if (p.airport !== TO) return false;
    const procShort = p.name.substring(p.name.indexOf('-') + 1);
    return routeTokens.has(procShort) || p.fixes.some(f => routeTokens.has(f));
  });

  // Route waypoint names (excluding airports and coord waypoints like 66N071W)
  const routeWaypointNames = deduped ? deduped.slice(1, -1).map(p => p.name) : [];
  // Next leg waypoint names for outbound route display
  const nextRouteWaypointNames = nextDeduped ? nextDeduped.slice(1, -1).map(p => p.name) : [];
  const nextRouteName = nextLeg ? `${TO}-${nextLegName}` : null;
  // Previous leg waypoint names for inbound route display
  const prevRouteWaypointNames = prevDeduped ? prevDeduped.slice(1, -1).map(p => p.name) : [];
  const prevRouteName = prevLeg ? `${prevLeg.from}-${prevLegName}` : null;

  // F1: Departure SMR
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${FROM}_SMR.asr`), buildSmrAsr(LEG_NAME, FROM, depAirport, 'DEP', smrFreeTextItems).join('\n'), 'utf-8');

  // F2: Departure APP — includes previous leg inbound route
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${FROM}_APP.asr`), buildAppAsr(FROM, depAirport, appFreeTextItems, depRelevantProcs, LEG_NAME, vorIdents, ndbIdents, routeWaypointNames, msaFixNames, FROM, prevRouteWaypointNames, prevRouteName).join('\n'), 'utf-8');

  // F3: Enroute
  const enrPad = dist < 500 ? 2 : dist < 2000 ? 5 : 10; // degrees padding
  const enroute = [
    'DisplayTypeName:Standard ES radar screen',
    'DisplayTypeNeedRadarContent:1',
    'DisplayTypeGeoReferenced:1',
  ];
  const enrItems = [];
  enrItems.push(`Airports:${FROM}:symbol`, `Airports:${TO}:symbol`);
  // FIR ARTCC boundaries
  for (const fir of routeFirs) enrItems.push(`ARTCC boundary:${fir.icao}:`);
  // MSA rings for both airports
  enrItems.push(`ARTCC boundary:${FROM}-MSA:`, `ARTCC boundary:${TO}-MSA:`);
  // MSA labels — name only
  for (const f of msaFixNames) enrItems.push(`Fixes:${f}:name`);
  // Helper to add waypoint fix/VOR/NDB entries
  function addWpItems(wpList) {
    for (const wp of wpList) {
      if (vorIdents.has(wp)) {
        enrItems.push(`VORs:${wp}:name`, `VORs:${wp}:symbol`);
      } else if (ndbIdents.has(wp)) {
        enrItems.push(`NDBs:${wp}:name`, `NDBs:${wp}:symbol`);
      } else {
        enrItems.push(`Fixes:${wp}:name`, `Fixes:${wp}:symbol`);
      }
    }
  }
  // Current route line + fixes
  if (ATC_ROUTE) enrItems.push(`ARTCC boundary:${FROM}-${LEG_NAME}:`);
  addWpItems(routeWaypointNames);
  // Previous leg inbound route + fixes
  if (prevRouteName) enrItems.push(`ARTCC boundary:${prevRouteName}:`);
  addWpItems(prevRouteWaypointNames);
  // Next leg outbound route + fixes
  if (nextRouteName) enrItems.push(`ARTCC boundary:${nextRouteName}:`);
  addWpItems(nextRouteWaypointNames);
  enrItems.push('Geo:Coastline:');
  // Sort case-insensitive; replace - with ~ in sort key so parents (EGPX:) sort before children (EGPX-A:)
  enrItems.sort((a, b) => a.toLowerCase().replace(/-/g, '~').localeCompare(b.toLowerCase().replace(/-/g, '~')));
  enroute.push(...enrItems);
  // Calculate WINDOWAREA from dep/arr with padding
  const minLat = Math.min(depAirport.lat, arrAirport.lat) - enrPad;
  const maxLat = Math.max(depAirport.lat, arrAirport.lat) + enrPad;
  const minLon = Math.min(depAirport.lon, arrAirport.lon) - enrPad * 1.5;
  const maxLon = Math.max(depAirport.lon, arrAirport.lon) + enrPad * 1.5;
  enroute.push(
    'SHOWC:1', 'SHOWSB:0', 'BELOW:0', 'ABOVE:0',
    'LEADER:3', 'SHOWLEADER:1', 'TURNLEADER:0',
    'HISTORY_DOTS:0', 'SIMULATION_MODE:1',
    'DISABLEPANNING:0', 'DISABLEZOOMING:0',
    'DisplayRotation:0.00000',
    'TAGFAMILY:AC-TopSky-Easy',
    `WINDOWAREA:${minLat.toFixed(6)}:${minLon.toFixed(6)}:${maxLat.toFixed(6)}:${maxLon.toFixed(6)}`,
    'PLUGIN:TopSky plugin:HideMapData:AirspaceBases,Fixes,FixLabels',
    'PLUGIN:TopSky plugin:ShowMapData:Centrelines,Ticks',
  );
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_Enroute.asr`), enroute.join('\n'), 'utf-8');

  // F4: Arrival SMR
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${TO}_SMR.asr`), buildSmrAsr(LEG_NAME, TO, arrAirport, 'ARR', smrFreeTextItems).join('\n'), 'utf-8');

  // F5: Arrival APP
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${TO}_APP.asr`), buildAppAsr(TO, arrAirport, appFreeTextItems, arrRelevantProcs, LEG_NAME, vorIdents, ndbIdents, routeWaypointNames, msaFixNames, FROM, nextRouteWaypointNames, nextRouteName).join('\n'), 'utf-8');

  // ===== vSMR PROFILES =====
  const pluginDir = path.join(OUTPUT_DIR, 'Data', 'Plugin', 'vSMR');
  fs.mkdirSync(pluginDir, { recursive: true });
  const profilesPath = path.join(pluginDir, 'vSMR_Profiles.json');
  let profiles = [];
  if (fs.existsSync(profilesPath)) {
    profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
  }
  if (!profiles.find(p => p.name === 'Default')) {
    profiles.unshift({
      name: 'Default',
      font: { font_name: 'EuroScope', weight: 'Regular', sizes: { one: 11, two: 12, three: 13, four: 14, five: 16 } },
      filters: { hide_above_alt: 10000, hide_above_spd: 250, radar_range_nm: 50, night_alpha_setting: 110,
        pro_mode: { enable: false, accept_pilot_squawk: true, do_not_autocorrelate_squawks: [] } },
      labels: { auto_deconfliction: true, leader_line_length: 50, use_aspeed_for_gate: false,
        squawk_error_color: { r: 255, g: 255, b: 0 },
        departure: { definition: [['callsign'], ['actype', 'wake']], background_color: { r: 40, g: 50, b: 200, a: 255 }, background_color_on_runway: { r: 40, g: 50, b: 200, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        arrival: { definition: [['callsign'], ['actype']], background_color: { r: 170, g: 50, b: 50, a: 255 }, background_color_on_runway: { r: 170, g: 50, b: 50, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        airborne: { use_departure_arrival_coloring: false, definition: [['callsign'], ['flightlevel']], text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 0, g: 0, b: 0, a: 0 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } },
        uncorrelated: { definition: [['systemid']], text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 150, g: 22, b: 135, a: 255 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } }
      },
      rimcas: { rimcas_label_only: true, use_red_symbol_for_emergencies: true, timer: [60,45,30,15,0], timer_lvp: [120,90,60,30,0], rimcas_stage_two_speed_threshold: 25,
        background_color_stage_one: { r: 160, g: 90, b: 30, a: 255 }, background_color_stage_two: { r: 150, g: 0, b: 0, a: 255 }, alert_text_color: { r: 255, g: 255, b: 255 } },
      targets: { show_primary_target: true, target_color: { r: 255, g: 242, b: 73, a: 255 }, history_one_color: { r: 0, g: 255, b: 255, a: 255 }, history_two_color: { r: 0, g: 219, b: 219, a: 255 }, history_three_color: { r: 0, g: 183, b: 183, a: 255 } },
      approach_insets: { extended_lines_length: 15, extended_lines_ticks_spacing: 1, extended_lines_color: { r: 255, g: 255, b: 255 }, runway_color: { r: 0, g: 0, b: 0 }, background_color: { r: 127, g: 122, b: 122 } }
    });
  }
  let wfProfile = profiles.find(p => p.name === 'WorldFlight');
  if (!wfProfile) {
    wfProfile = JSON.parse(JSON.stringify(profiles[0]));
    wfProfile.name = 'WorldFlight';
    wfProfile.maps = {};
    profiles.push(wfProfile);
  }
  if (!wfProfile.maps) wfProfile.maps = {};
  wfProfile.maps[FROM] = { runways: buildVsmrRunways(depAirport) };
  wfProfile.maps[TO] = { runways: buildVsmrRunways(arrAirport) };
  wfProfile.approach_insets = { extended_lines_length: 15, extended_lines_ticks_spacing: 1,
    extended_lines_color: { r: 150, g: 150, b: 150 }, runway_color: { r: 255, g: 255, b: 255 }, background_color: { r: 127, g: 122, b: 122 } };
  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8');

  // ===== TOPSKY RADARS =====
  /* Deliberately NOT generated.
     This block used to write a TopSkyRadars.txt with one radar per VATSpy
     radar (86 for OMDB->ZULS) and, on EVERY radar, a POSITIONS line listing
     every position in the leg — 171 characters against the ~20 a real
     adaptation uses (UK: "POSITIONS:SCO:STC:EGPD", 22 radars). Loading it
     made TopSky terminate EuroScope during plugin init, with no Windows
     crash record. Proven by swapping this file alone into an otherwise
     working TopSky folder.
     The file is optional — Portugal vACC's adaptation ships none at all —
     and radar definitions only affect simulated coverage, so the correct
     fix is to omit it rather than emit a malformed one. If per-leg radars
     are wanted later, POSITIONS must list only the few positions that use
     that radar. */
  const topskyDir = path.join(OUTPUT_DIR, 'Data', 'Plugin', 'TopSky');
  if (fs.existsSync(topskyDir)) {
    // Write extended centreline tick marks to TopSkyMaps.txt
    // Generate extended centreline MAP entries with ACTIVE:RWY triggers — append, don't overwrite
    const mapsPath = path.join(topskyDir, 'TopSkyMaps.txt');
    if (fs.existsSync(mapsPath)) {
      let mapsContent = fs.readFileSync(mapsPath, 'utf-8');
      // Ensure marker exists
      const genMarker = '\n; === GENERATED CENTRELINES ===';
      if (!mapsContent.includes(genMarker)) mapsContent += genMarker;

      const allPosIds = [airportAfvPrefixes[FROM] || FROM, airportAfvPrefixes[TO] || TO, ...positionShortIds];
      const uniqueIds = [...new Set(allPosIds)];
      // Only add centrelines for airports not already present
      const clLines = [];
      for (const [icao, airport] of [[FROM, depAirport], [TO, arrAirport]]) {
        if (!mapsContent.includes(`MAP:${icao} `)) {
          clLines.push(...buildCentrelineMaps(airport, icao, uniqueIds));
        }
      }
      if (clLines.length > 0) {
        fs.writeFileSync(mapsPath, mapsContent + clLines.join('\n'), 'utf-8');
      }
    }
  }

  console.log(`\nGenerated ${LEG_NAME}:`);
  console.log(`  SCT: ${LEG_NAME}.sct (${FROM} + ${TO})`);
  console.log(`  ESE: ${LEG_NAME}.ese (${totalSids} SIDs, ${totalStars} STARs)`);
  console.log(`  ASR: DEP_SMR, DEP_APP, Enroute, ARR_SMR, ARR_APP`);
  console.log(`  PRF: ${LEG_NAME}.prf (F1-F5)`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
