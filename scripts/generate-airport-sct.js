import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PACK_WF_DIR } from '../lib/paths.mjs';
import { decimalToDMS, coordPair, bearing, projectPoint } from './lib/geo.js';
import { parseFixes, parseNavaids, parseAirways, parseCIFP } from './lib/parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const ICAO = process.argv[2] || 'EGLL';
const RADIUS = 50; // 50nm radius for a single airport
const NAVDATA_DIR = path.join(__dirname, '..', 'data', 'navdata');
const CIFP_DIR = path.join(__dirname, '..', 'data', 'XP12', 'CIFP');
const OUTPUT_DIR = PACK_WF_DIR;

async function main() {
  console.log(`=== Generating ${ICAO} sector file ===\n`);

  const airport = await prisma.airport.findUnique({
    where: { icao: ICAO },
    include: { runways: true }
  });
  if (!airport) { console.error('Airport not found'); process.exit(1); }

  const centers = [{ icao: ICAO, lat: airport.lat, lon: airport.lon }];

  console.log('Parsing nearby fixes...');
  const fixes = await parseFixes(path.join(NAVDATA_DIR, 'earth_fix.dat'), centers, RADIUS);
  console.log(`  ${fixes.length} fixes`);

  console.log('Parsing nearby navaids...');
  const { vors, ndbs } = await parseNavaids(path.join(NAVDATA_DIR, 'earth_nav.dat'), centers, RADIUS);
  console.log(`  ${vors.length} VORs, ${ndbs.length} NDBs`);

  console.log('Parsing nearby airways...');
  const airways = await parseAirways(path.join(NAVDATA_DIR, 'earth_awy.dat'), centers, RADIUS);
  console.log(`  ${airways.high.length} high, ${airways.low.length} low`);

  // Read ground layout if exists
  const groundPath = path.join(OUTPUT_DIR, `${ICAO}_ground.txt`);
  let groundData = { regions: '', geo: '', labels: '' };
  if (fs.existsSync(groundPath)) {
    console.log('Loading ground layout...');
    const ground = fs.readFileSync(groundPath, 'utf-8');
    const regionsStart = ground.indexOf('; === REGIONS');
    const geoStart = ground.indexOf('; === GEO');
    const labelsStart = ground.indexOf('; === LABELS');
    groundData.regions = ground.substring(regionsStart, geoStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
    groundData.geo = ground.substring(geoStart, labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
    groundData.labels = ground.substring(labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
    console.log('  Ground layout loaded');
  }

  // Build SCT
  const L = [];
  L.push(`; ${ICAO} EuroScope Sector File`);
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
  L.push('');

  L.push('[INFO]');
  L.push(ICAO);
  L.push(`${ICAO}_CTR`);
  L.push(ICAO);
  L.push(coordPair(airport.lat, airport.lon).split(' ')[0]);
  L.push(coordPair(airport.lat, airport.lon).split(' ')[1]);
  L.push('60');
  L.push('38');
  L.push('0');
  L.push('1.0');
  L.push('');

  L.push('[AIRPORT]');
  L.push(`${ICAO} 118.500 ${coordPair(airport.lat, airport.lon)} D`);
  L.push('');

  L.push('[RUNWAY]');
  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
    const hdg2 = (hdg1 + 180) % 360;
    L.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)} ${ICAO} ${airport.name}`);
  }
  L.push('');

  L.push('[VOR]');
  for (const v of vors) L.push(`${v.ident.padEnd(5)} ${v.freq} ${coordPair(v.lat, v.lon)}`);
  L.push('');

  L.push('[NDB]');
  for (const n of ndbs) L.push(`${n.ident.padEnd(5)} ${n.freq} ${coordPair(n.lat, n.lon)}`);
  L.push('');

  L.push('[FIXES]');
  const fixMap = new Map();
  for (const f of fixes) { const k = `${f.ident}_${f.lat.toFixed(4)}`; if (!fixMap.has(k)) fixMap.set(k, f); }
  for (const f of [...fixMap.values()]) L.push(`${f.ident.padEnd(6)} ${coordPair(f.lat, f.lon)}`);
  L.push('');

  L.push('[HIGH AIRWAY]');
  for (const s of airways.high) L.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`);
  L.push('');

  L.push('[LOW AIRWAY]');
  for (const s of airways.low) L.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`);
  L.push('');

  // Extended centerlines
  L.push('[SID]');
  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const recip = (hdg + 180) % 360;
    const ext1 = projectPoint(rwy.lat1, rwy.lon1, recip, 10);
    const ext2 = projectPoint(rwy.lat2, rwy.lon2, hdg, 10);
    L.push(`${ICAO}-${rwy.ident1} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(ext1.lat, ext1.lon)} centrelinecolour`);
    if (rwy.ident2) L.push(`${ICAO}-${rwy.ident2} ${coordPair(rwy.lat2, rwy.lon2)} ${coordPair(ext2.lat, ext2.lon)} centrelinecolour`);
  }
  L.push('');

  L.push('[STAR]');
  L.push('');
  L.push('[ARTCC]');
  L.push('');
  L.push('[ARTCC HIGH]');
  L.push('');
  L.push('[ARTCC LOW]');
  L.push('');

  L.push('[GEO]');
  // GEO group header for ground layout
  L.push(`${ICAO} Ground              S999.00.00.000 E999.00.00.000 S999.00.00.000 E999.00.00.000`);
  // Range rings
  for (const radius of [5, 10]) {
    for (let i = 0; i < 36; i++) {
      const a1 = (360 / 36) * i;
      const a2 = (360 / 36) * (i + 1);
      const p1 = projectPoint(airport.lat, airport.lon, a1, radius);
      const p2 = projectPoint(airport.lat, airport.lon, a2, radius);
      L.push(`${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)} rangering`);
    }
  }
  if (groundData.geo) L.push(groundData.geo);
  L.push('');

  L.push('[LABELS]');
  L.push(`"${ICAO}" ${coordPair(airport.lat, airport.lon)} 16777215`);
  if (groundData.labels) L.push(groundData.labels);
  L.push('');

  L.push('[REGIONS]');
  if (groundData.regions) L.push(groundData.regions);

  // Add runway rectangles from DB runway data (45m wide, on top of everything)
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    const halfWidth = 0.008; // ~15m in nm, gives ~30m total

    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);

    // Runway surface
    L.push(`REGIONNAME ${ICAO}`);
    L.push(`smrRunway ${coordPair(c1.lat, c1.lon)}`);
    L.push(` ${coordPair(c4.lat, c4.lon)}`);
    L.push(` ${coordPair(c3.lat, c3.lon)}`);
    L.push(` ${coordPair(c2.lat, c2.lon)}`);
    L.push(` ${coordPair(c1.lat, c1.lon)}`);
    L.push('');

  }
  L.push('');

  // Write
  const sctDir = path.join(OUTPUT_DIR, 'Data', 'Sector_Files');
  fs.mkdirSync(sctDir, { recursive: true });
  const sctPath = path.join(sctDir, `${ICAO}.sct`);
  fs.writeFileSync(sctPath, L.join('\r\n'), 'utf-8');
  console.log(`\nWritten ${L.length} lines (${(L.join('\r\n').length / 1024).toFixed(0)}KB) to ${sctPath}`);

  // Generate ESE
  const E = [];
  E.push(`; ${ICAO} Extended Sector File`);
  E.push('');
  E.push('[POSITIONS]');
  for (const pos of [{s:'OBS',n:'Observer',f:'199.998'},{s:'DEL',n:'Delivery',f:'121.700'},{s:'GND',n:'Ground',f:'121.800'},{s:'TWR',n:'Tower',f:'118.500'},{s:'APP',n:'Approach',f:'119.000'}]) {
    E.push(`${ICAO}_${pos.s}:${airport.name} ${pos.n}:${pos.f}:${ICAO}:${pos.s.charAt(0)}:${ICAO}:${pos.s}:-:-:0100:0177:${coordPair(airport.lat, airport.lon).replace(' ', ':')}`);
  }
  E.push('');
  E.push('[SIDSSTARS]');
  // Parse CIFP data for SID/STAR procedures
  const cifpPath = path.join(CIFP_DIR, `${ICAO}.dat`);
  if (fs.existsSync(cifpPath)) {
    const sidstars = parseCIFP(cifpPath, ICAO);
    for (const entry of sidstars) E.push(entry);
    console.log(`  ${sidstars.filter(s => s.startsWith('SID:')).length} SIDs, ${sidstars.filter(s => s.startsWith('STAR:')).length} STARs from CIFP`);
  } else {
    console.log('  No CIFP data found');
  }
  E.push('');
  E.push('[AIRSPACE]');
  const pts = [];
  for (let i = 0; i <= 36; i++) { const p = projectPoint(airport.lat, airport.lon, (360/36)*i, 30); pts.push(coordPair(p.lat, p.lon)); }
  E.push(`SECTORLINE:${ICAO}_BOUNDARY`);
  for (const pt of pts) E.push(`COORD:${pt}`);
  E.push('');
  E.push(`SECTOR:${ICAO}_TWR:0:24500`);
  E.push(`OWNER:${ICAO}_TWR:${ICAO}_APP`);
  E.push(`BORDER:${ICAO}_BOUNDARY`);
  E.push('');

  const esePath = path.join(sctDir, `${ICAO}.ese`);
  fs.writeFileSync(esePath, E.join('\r\n'), 'utf-8');

  // Generate PRF in ICAO subfolder - uses \..\Data\... to reach shared Data (matches UK pack pattern)
  const prfDir = path.join(OUTPUT_DIR, ICAO);
  fs.mkdirSync(prfDir, { recursive: true });
  const prf = [
    `Settings\tSettingsfileSYMBOLOGY\t\\..\\Data\\Settings\\Symbology.txt`,
    `Settings\tSettingsfileTAGS\t\\..\\Data\\Settings\\Tags.txt`,
    `Settings\tSettingsfileSCREEN\t\\..\\Data\\Settings\\Screen.txt`,
    `Settings\tSettingsfile\t\\..\\Data\\Settings\\General.txt`,
    `Settings\tSettingsfileARR\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileDEP\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileFP\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileSEL\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileSIL\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileCONFLICT\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tsector\t\\..\\Data\\Sector_Files\\${ICAO}.sct`,
    `Settings\tairlines\t\\..\\Data\\Datafiles\\ICAO_Airlines.txt`,
    `Settings\tairports\t\\..\\Data\\Datafiles\\ICAO_Airports.txt`,
    `Settings\taircraft\t\\..\\Data\\Datafiles\\ICAO_Aircraft.txt`,
    `Settings\tairportcoords\t\\..\\Data\\Datafiles\\icao.txt`,
    `ASRFastKeys\t1\t\\..\\Data\\ASR\\${ICAO}_SMR.asr`,
    `ASRFastKeys\t2\t\\..\\Data\\ASR\\${ICAO}_APP.asr`,
    `RecentFiles\tRecent1\t\\..\\Data\\ASR\\${ICAO}_SMR.asr`,
    `RecentFiles\tRecent2\t\\..\\Data\\ASR\\${ICAO}_APP.asr`,
    `Plugins\tPlugin0\t\\..\\Data\\Plugin\\vSMR\\vSMR.dll`,
    `Plugins\tPlugin0Display0\tSMR radar display`,
    `LastSession\tserver\tAUTOMATIC`,
    `LastSession\tcallsign\t${ICAO}_OBS`,
  ];
  fs.writeFileSync(path.join(prfDir, `${ICAO}.prf`), prf.join('\r\n'), 'utf-8');

  // Generate connection profiles
  const profilesDir = path.join(OUTPUT_DIR, 'Data', 'Settings');
  const profLines = [
    'PROFILE',
    `PROFILE:${ICAO}_OBS:100:0`,
    `ATIS2:${ICAO} Observer`,
    `ATIS3:`,
    `ATIS4:WorldFlight 2026`,
    `PROFILE:${ICAO}_APP:100:5`,
    `ATIS2:${ICAO} Approach`,
    `ATIS3:`,
    `ATIS4:WorldFlight 2026`,
    `PROFILE:${ICAO}_TWR:30:4`,
    `ATIS2:${ICAO} Tower`,
    `ATIS3:`,
    `ATIS4:WorldFlight 2026`,
    `PROFILE:${ICAO}_GND:20:3`,
    `ATIS2:${ICAO} Ground`,
    `ATIS3:`,
    `ATIS4:WorldFlight 2026`,
    `PROFILE:${ICAO}_DEL:20:2`,
    `ATIS2:${ICAO} Delivery`,
    `ATIS3:`,
    `ATIS4:WorldFlight 2026`,
    'END',
  ];
  fs.writeFileSync(path.join(profilesDir, `Profiles_${ICAO}.txt`), profLines.join('\r\n'), 'utf-8');

  // Add profiles reference to PRF
  prf.splice(4, 0, `Settings\tSettingsfilePROFILE\t\\..\\Data\\Settings\\Profiles_${ICAO}.txt`);
  fs.writeFileSync(path.join(prfDir, `${ICAO}.prf`), prf.join('\r\n'), 'utf-8');

  // Generate ASR files
  const asrDir = path.join(OUTPUT_DIR, 'Data', 'ASR');
  fs.mkdirSync(asrDir, { recursive: true });

  // SMR ASR (vSMR ground radar view) - F1
  // Calculate bounding box ~0.04 degrees around airport center
  const boxSize = 0.04;
  const smr = [
    'DisplayTypeName:SMR radar display',
    'DisplayTypeNeedRadarContent:0',
    'DisplayTypeGeoReferenced:1',
    `Geo:${ICAO} Ground:`,
    `Regions:${ICAO}:polygon`,
  ];
  for (const rwy of airport.runways) {
    if (rwy.ident1) smr.push(`Runways:${ICAO}:${rwy.ident1}:centerline`);
    if (rwy.ident2) smr.push(`Runways:${ICAO}:${rwy.ident2}:centerline`);
  }
  smr.push(`SHOWC:${ICAO}_TWR:1`);
  smr.push('SHOWSB:0');
  smr.push('BELOW:0');
  smr.push('ABOVE:0');
  smr.push('LEADER:5');
  smr.push('SHOWLEADER:1');
  smr.push('HISTORY_DOTS:5');
  smr.push('SIMULATION_MODE:1');
  smr.push('DISABLEPANNING:0');
  smr.push('DISABLEZOOMING:0');
  smr.push('DisplayRotation:0.00000');
  smr.push('TAGFAMILY:Matias (built in)');
  smr.push(`m_Latitude:${airport.lat}`);
  smr.push(`m_Longitude:${airport.lon}`);
  smr.push(`WINDOWAREA:${(airport.lat - boxSize).toFixed(6)}:${(airport.lon - boxSize * 1.3).toFixed(6)}:${(airport.lat + boxSize).toFixed(6)}:${(airport.lon + boxSize * 1.3).toFixed(6)}`);
  smr.push(`PLUGIN:vSMR Vatsim UK:ActiveProfile:WorldFlight`);
  smr.push(`PLUGIN:vSMR Vatsim UK:Afterglow:1`);
  smr.push(`PLUGIN:vSMR Vatsim UK:Airport:${ICAO}`);
  smr.push(`PLUGIN:vSMR Vatsim UK:AppTrailsDots:4`);
  smr.push(`PLUGIN:vSMR Vatsim UK:FontSize:1`);
  smr.push(`PLUGIN:vSMR Vatsim UK:ShowAircraftType:1`);
  smr.push(`PLUGIN:vSMR Vatsim UK:ShowSID:1`);
  smr.push(`PLUGIN:vSMR Vatsim UK:ShowWakeTurb:1`);
  // SRW1 - Sub Radar Window showing airport overview
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1Display:1`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1Filter:5500`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1OffsetX:0`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1OffsetY:0`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1Rotation:0`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1Scale:30`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1TopLeftX:1545`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1TopLeftY:629`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1BottomRightX:1920`);
  smr.push(`PLUGIN:vSMR Vatsim UK:SRW1BottomRightY:928`);
  fs.writeFileSync(path.join(asrDir, `${ICAO}_SMR.asr`), smr.join('\r\n'), 'utf-8');

  // APP ASR (standard approach radar) - F2
  const app = [
    'DisplayTypeName:Standard ES radar screen',
    'DisplayTypeNeedRadarContent:1',
    'DisplayTypeGeoReferenced:1',
    `Airports:${ICAO}:symbol`,
    `Airports:${ICAO}:name`,
  ];
  for (const rwy of airport.runways) {
    if (rwy.ident1) app.push(`Runways:${ICAO}:${rwy.ident1}:centerline`);
    if (rwy.ident2) app.push(`Runways:${ICAO}:${rwy.ident2}:centerline`);
    if (rwy.ident1) app.push(`Sids:${ICAO}-${rwy.ident1}`);
    if (rwy.ident2) app.push(`Sids:${ICAO}-${rwy.ident2}`);
  }
  app.push(`SHOWC:${ICAO}_TWR:1`);
  app.push(`m_Latitude:${airport.lat}`);
  app.push(`m_Longitude:${airport.lon}`);
  app.push('m_Zoom:7');
  fs.writeFileSync(path.join(asrDir, `${ICAO}_APP.asr`), app.join('\r\n'), 'utf-8');

  // Generate vSMR_Profiles.json with runway polygons (4-corner rectangles from threshold data)
  const dmsPt = (lat, lon) => [decimalToDMS(lat, true), decimalToDMS(lon, false)];
  const halfWidth = 0.032; // ~60m in nm, gives ~120m total (wide enough for SRW visibility)
  const vsmrRunways = [];
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    // 4 corners: threshold1-left, threshold2-left, threshold2-right, threshold1-right
    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    vsmrRunways.push({
      runway_name: `${rwy.ident1}/${rwy.ident2}`,
      path: [dmsPt(c1.lat, c1.lon), dmsPt(c2.lat, c2.lon), dmsPt(c3.lat, c3.lon), dmsPt(c4.lat, c4.lon)],
      path_lvp: [dmsPt(c1.lat, c1.lon), dmsPt(c2.lat, c2.lon), dmsPt(c3.lat, c3.lon), dmsPt(c4.lat, c4.lon)]
    });
  }

  const pluginDir = path.join(OUTPUT_DIR, 'Data', 'Plugin', 'vSMR');
  const profilesPath = path.join(pluginDir, 'vSMR_Profiles.json');
  let profiles = [];
  if (fs.existsSync(profilesPath)) {
    profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
  }
  // Ensure a Default profile exists as first entry (vSMR requires it)
  if (!profiles.find(p => p.name === 'Default')) {
    profiles.unshift({
      name: 'Default',
      font: { font_name: 'EuroScope', weight: 'Regular', sizes: { one: 11, two: 12, three: 13, four: 14, five: 16 } },
      filters: { hide_above_alt: 10000, hide_above_spd: 250, radar_range_nm: 50, night_alpha_setting: 110,
        pro_mode: { enable: false, accept_pilot_squawk: true, do_not_autocorrelate_squawks: [] } },
      labels: { auto_deconfliction: true, leader_line_length: 50, use_aspeed_for_gate: false,
        squawk_error_color: { r: 255, g: 255, b: 0 },
        departure: { definition: [['callsign'], ['actype', 'wake']],
          background_color: { r: 40, g: 50, b: 200, a: 255 }, background_color_on_runway: { r: 40, g: 50, b: 200, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        arrival: { definition: [['callsign'], ['actype']],
          background_color: { r: 170, g: 50, b: 50, a: 255 }, background_color_on_runway: { r: 170, g: 50, b: 50, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        airborne: { use_departure_arrival_coloring: false, definition: [['callsign'], ['flightlevel']],
          text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 0, g: 0, b: 0, a: 0 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } },
        uncorrelated: { definition: [['systemid']],
          text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 150, g: 22, b: 135, a: 255 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } }
      },
      rimcas: { rimcas_label_only: true, use_red_symbol_for_emergencies: true,
        timer: [60, 45, 30, 15, 0], timer_lvp: [120, 90, 60, 30, 0], rimcas_stage_two_speed_threshold: 25,
        background_color_stage_one: { r: 160, g: 90, b: 30, a: 255 }, background_color_stage_two: { r: 150, g: 0, b: 0, a: 255 }, alert_text_color: { r: 255, g: 255, b: 255 } },
      targets: { show_primary_target: true,
        target_color: { r: 255, g: 242, b: 73, a: 255 }, history_one_color: { r: 0, g: 255, b: 255, a: 255 },
        history_two_color: { r: 0, g: 219, b: 219, a: 255 }, history_three_color: { r: 0, g: 183, b: 183, a: 255 } },
      approach_insets: { extended_lines_length: 15, extended_lines_ticks_spacing: 1,
        extended_lines_color: { r: 255, g: 255, b: 255 }, runway_color: { r: 0, g: 0, b: 0 }, background_color: { r: 127, g: 122, b: 122 } }
    });
  }
  // Update or create WorldFlight profile with this airport's maps
  let wfProfile = profiles.find(p => p.name === 'WorldFlight');
  if (!wfProfile) {
    wfProfile = {
      name: 'WorldFlight',
      font: { font_name: 'EuroScope', weight: 'Regular', sizes: { one: 11, two: 12, three: 13, four: 14, five: 16 } },
      filters: { hide_above_alt: 10000, hide_above_spd: 250, radar_range_nm: 50, night_alpha_setting: 110,
        pro_mode: { enable: false, accept_pilot_squawk: true, do_not_autocorrelate_squawks: [] } },
      labels: { auto_deconfliction: true, leader_line_length: 50, use_aspeed_for_gate: false,
        squawk_error_color: { r: 255, g: 255, b: 0 },
        departure: { definition: [['callsign'], ['actype', 'wake']],
          background_color: { r: 40, g: 50, b: 200, a: 255 }, background_color_on_runway: { r: 40, g: 50, b: 200, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        arrival: { definition: [['callsign'], ['actype']],
          background_color: { r: 170, g: 50, b: 50, a: 255 }, background_color_on_runway: { r: 170, g: 50, b: 50, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        airborne: { use_departure_arrival_coloring: false, definition: [['callsign'], ['flightlevel']],
          text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 0, g: 0, b: 0, a: 0 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } },
        uncorrelated: { definition: [['systemid']],
          text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 150, g: 22, b: 135, a: 255 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } }
      },
      rimcas: { rimcas_label_only: true, use_red_symbol_for_emergencies: true,
        timer: [60, 45, 30, 15, 0], timer_lvp: [120, 90, 60, 30, 0], rimcas_stage_two_speed_threshold: 25,
        background_color_stage_one: { r: 160, g: 90, b: 30, a: 255 }, background_color_stage_two: { r: 150, g: 0, b: 0, a: 255 }, alert_text_color: { r: 255, g: 255, b: 255 } },
      targets: { show_primary_target: true,
        target_color: { r: 255, g: 242, b: 73, a: 255 }, history_one_color: { r: 0, g: 255, b: 255, a: 255 },
        history_two_color: { r: 0, g: 219, b: 219, a: 255 }, history_three_color: { r: 0, g: 183, b: 183, a: 255 } },
      maps: {},
      approach_insets: {}
    };
    profiles.push(wfProfile);
  }
  if (!wfProfile.maps) wfProfile.maps = {};
  wfProfile.maps[ICAO] = { runways: vsmrRunways };
  wfProfile.approach_insets = {
    extended_lines_length: 15,
    extended_lines_ticks_spacing: 1,
    extended_lines_color: { r: 150, g: 150, b: 150 },
    runway_color: { r: 255, g: 255, b: 255 },
    background_color: { r: 127, g: 122, b: 122 }
  };
  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8');
  console.log(`  Updated vSMR_Profiles.json with ${ICAO} runway maps (${vsmrRunways.length} runways)`);

  console.log(`Generated ${ICAO}.prf, ${ICAO}_SMR.asr, ${ICAO}_APP.asr, ${ICAO}.sct, ${ICAO}.ese`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
