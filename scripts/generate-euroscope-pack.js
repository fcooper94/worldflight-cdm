import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PACK_WF_DIR } from '../lib/paths.mjs';
import { coordPair, bearing, runwayLengthFt, projectPoint } from './lib/geo.js';
import { parseFixes, parseNavaids, parseAirways } from './lib/parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const WF_AIRPORTS = [
  'BGTL','CYHZ','CYYR','DAAG','EGPF','KDTW','KEWR','LBSF','LFPG','LIMC',
  'LIRF','LTFM','MMUN','MPTO','NZAA','NZCH','NZFX','OAKB','OJAI','RJBB',
  'RKSI','ROAH','SBGR','SBPV','SCCI','SCEL','SCGC','SKBO','UBBB','UEEE',
  'UNNT','VABB','VHHH','VNKT','VTBD','WADD','WAJJ','WALL','WIII','WSSS',
  'YBBN','YBCS','YPDN','YSSY','ZBAD'
];

const NAVDATA_DIR = path.join(__dirname, '..', 'data', 'navdata');
const OUTPUT_DIR = PACK_WF_DIR;

async function main() {
  console.log('=== WorldFlight EuroScope Pack Generator ===\n');

  // 1. Load airports and runways from DB
  console.log('Loading airports from database...');
  const airports = await prisma.airport.findMany({
    where: { icao: { in: WF_AIRPORTS } },
    include: { runways: true }
  });
  console.log(`  Found ${airports.length} airports with ${airports.reduce((s, a) => s + a.runways.length, 0)} runways`);

  const centers = airports.map(a => ({ icao: a.icao, lat: a.lat, lon: a.lon }));

  // 2. Parse navdata
  console.log('Parsing fixes (this may take a moment)...');
  const fixes = await parseFixes(path.join(NAVDATA_DIR, 'earth_fix.dat'), centers);
  console.log(`  ${fixes.length} fixes within range`);

  console.log('Parsing navaids...');
  const { vors, ndbs } = await parseNavaids(path.join(NAVDATA_DIR, 'earth_nav.dat'), centers);
  console.log(`  ${vors.length} VORs, ${ndbs.length} NDBs within range`);

  console.log('Parsing airways...');
  const airways = await parseAirways(path.join(NAVDATA_DIR, 'earth_awy.dat'), centers);
  console.log(`  ${airways.high.length} high airway segments, ${airways.low.length} low airway segments`);

  // 3. Generate SCT file
  console.log('\nGenerating .sct file...');
  const sctLines = [];

  // -- Colour defines (UK style) --
  sctLines.push('; WorldFlight 2026 EuroScope Sector File');
  sctLines.push('; Generated from Navigraph AIRAC 2603 + Airport Database');
  sctLines.push('; For use with VATSIM WorldFlight event only');
  sctLines.push('');
  sctLines.push('#define coast 9076039');
  sctLines.push('#define land 3947580');
  sctLines.push('#define river 4915200');
  sctLines.push('#define centrelinecolour 15790135');
  sctLines.push('#define geoDefault 5787205');
  sctLines.push('#define rangering 4227200');
  sctLines.push('');

  // -- INFO --
  sctLines.push('[INFO]');
  sctLines.push('WorldFlight 2026');
  sctLines.push('WF_CTR');
  sctLines.push('EGLL');
  sctLines.push('N051.28.14.000');
  sctLines.push('W000.27.43.000');
  sctLines.push('60');
  sctLines.push('38');
  sctLines.push('0');
  sctLines.push('1.0');
  sctLines.push('');

  // -- AIRPORT --
  sctLines.push('[AIRPORT]');
  for (const ap of airports.sort((a, b) => a.icao.localeCompare(b.icao))) {
    sctLines.push(`${ap.icao} 000.000 ${coordPair(ap.lat, ap.lon)} ; ${ap.name}`);
  }
  sctLines.push('');

  // -- RUNWAY --
  sctLines.push('[RUNWAY]');
  for (const ap of airports) {
    for (const rwy of ap.runways) {
      if (!rwy.ident1 || !rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
      const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
      const hdg2 = (hdg1 + 180) % 360;
      sctLines.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)} ; ${ap.icao}`);
    }
  }
  sctLines.push('');

  // -- VOR --
  sctLines.push('[VOR]');
  for (const v of vors.sort((a, b) => a.ident.localeCompare(b.ident))) {
    sctLines.push(`${v.ident.padEnd(5)} ${v.freq} ${coordPair(v.lat, v.lon)} ; ${v.name}`);
  }
  sctLines.push('');

  // -- NDB --
  sctLines.push('[NDB]');
  for (const n of ndbs.sort((a, b) => a.ident.localeCompare(b.ident))) {
    sctLines.push(`${n.ident.padEnd(5)} ${n.freq} ${coordPair(n.lat, n.lon)} ; ${n.name}`);
  }
  sctLines.push('');

  // -- FIXES --
  sctLines.push('[FIXES]');
  // Deduplicate by ident+position
  const fixMap = new Map();
  for (const f of fixes) {
    const key = `${f.ident}_${f.lat.toFixed(4)}_${f.lon.toFixed(4)}`;
    if (!fixMap.has(key)) fixMap.set(key, f);
  }
  for (const f of [...fixMap.values()].sort((a, b) => a.ident.localeCompare(b.ident))) {
    sctLines.push(`${f.ident.padEnd(6)} ${coordPair(f.lat, f.lon)}`);
  }
  sctLines.push('');

  // -- HIGH AIRWAY --
  sctLines.push('[HIGH AIRWAY]');
  for (const seg of airways.high) {
    sctLines.push(`${seg.name.padEnd(6)} ${coordPair(seg.lat1, seg.lon1)} ${coordPair(seg.lat2, seg.lon2)}`);
  }
  sctLines.push('');

  // -- LOW AIRWAY --
  sctLines.push('[LOW AIRWAY]');
  for (const seg of airways.low) {
    sctLines.push(`${seg.name.padEnd(6)} ${coordPair(seg.lat1, seg.lon1)} ${coordPair(seg.lat2, seg.lon2)}`);
  }
  sctLines.push('');

  // -- SID (Extended Centerlines) --
  sctLines.push('[SID]');
  for (const ap of airports) {
    for (const rwy of ap.runways) {
      if (!rwy.ident1 || !rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
      const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
      const recip = (hdg + 180) % 360;

      // Extended centerline from each threshold outward 10nm
      const ext1 = projectPoint(rwy.lat1, rwy.lon1, recip, 10);
      const ext2 = projectPoint(rwy.lat2, rwy.lon2, hdg, 10);

      sctLines.push(`${ap.icao}-${rwy.ident1} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(ext1.lat, ext1.lon)} centrelinecolour`);
      if (rwy.ident2) {
        sctLines.push(`${ap.icao}-${rwy.ident2} ${coordPair(rwy.lat2, rwy.lon2)} ${coordPair(ext2.lat, ext2.lon)} centrelinecolour`);
      }
    }
  }
  sctLines.push('');

  // -- STAR --
  sctLines.push('[STAR]');
  sctLines.push('');

  // -- ARTCC --
  sctLines.push('[ARTCC]');
  sctLines.push('');

  // -- ARTCC HIGH --
  sctLines.push('[ARTCC HIGH]');
  sctLines.push('');

  // -- ARTCC LOW --
  sctLines.push('[ARTCC LOW]');
  sctLines.push('');

  // -- GEO --
  sctLines.push('[GEO]');
  // Range rings (5nm, 10nm) for each airport
  for (const ap of airports) {
    for (const radius of [5, 10]) {
      const segments = 36;
      for (let i = 0; i < segments; i++) {
        const a1 = (360 / segments) * i;
        const a2 = (360 / segments) * (i + 1);
        const p1 = projectPoint(ap.lat, ap.lon, a1, radius);
        const p2 = projectPoint(ap.lat, ap.lon, a2, radius);
        sctLines.push(`${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)} rangering ; ${ap.icao} ${radius}nm`);
      }
    }
  }
  sctLines.push('');

  // -- LABELS --
  sctLines.push('[LABELS]');
  for (const ap of airports) {
    sctLines.push(`"${ap.icao}" ${coordPair(ap.lat, ap.lon)} 16777215`);
  }
  sctLines.push('');

  // -- REGIONS --
  sctLines.push('[REGIONS]');
  sctLines.push('');

  // Write SCT file
  const sectorDir = path.join(OUTPUT_DIR, 'Data', 'Sector_Files');
  fs.mkdirSync(sectorDir, { recursive: true });
  const sctPath = path.join(sectorDir, 'WorldFlight2026.sct');
  fs.writeFileSync(sctPath, sctLines.join('\r\n'), 'utf-8');
  console.log(`  Written ${sctLines.length} lines to ${sctPath}`);

  // 4. Generate ESE file
  console.log('Generating .ese file...');
  const eseLines = [];

  eseLines.push('; WorldFlight 2026 EuroScope Extended Sector File');
  eseLines.push('');

  // -- POSITIONS --
  eseLines.push('[POSITIONS]');
  for (const ap of airports.sort((a, b) => a.icao.localeCompare(b.icao))) {
    // Generate standard positions: DEL, GND, TWR, APP
    const positions = [
      { suffix: 'DEL', name: 'Delivery', freq: '121.700' },
      { suffix: 'GND', name: 'Ground', freq: '121.800' },
      { suffix: 'TWR', name: 'Tower', freq: '118.500' },
      { suffix: 'APP', name: 'Approach', freq: '119.000' },
    ];
    for (const pos of positions) {
      const callsign = `${ap.icao}_${pos.suffix}`;
      const fullName = `${ap.name} ${pos.name}`;
      // Format: CALLSIGN:FULL_NAME:FREQ:IDENT:MIDDLE:PREFIX:SUFFIX:NOT_USED:NOT_USED:NOT_USED:VIS_RANGE:LAT:LON
      eseLines.push(`${callsign}:${fullName}:${pos.freq}:${ap.icao}:${pos.suffix.charAt(0)}:${ap.icao}:${pos.suffix}:-:-:0100:0177:35:${coordPair(ap.lat, ap.lon)}`);
    }
  }
  eseLines.push('');

  // -- SIDSSTARS --
  eseLines.push('[SIDSSTARS]');
  eseLines.push('');

  // -- AIRSPACE --
  eseLines.push('[AIRSPACE]');
  for (const ap of airports) {
    // Simple circular sector per airport
    const pts = [];
    for (let i = 0; i <= 36; i++) {
      const angle = (360 / 36) * i;
      const p = projectPoint(ap.lat, ap.lon, angle, 30);
      pts.push(coordPair(p.lat, p.lon));
    }
    eseLines.push(`SECTORLINE:${ap.icao}_BOUNDARY`);
    eseLines.push(`DISPLAY:${ap.icao}_TWR:${ap.icao}_TWR:${ap.icao}_TWR`);
    for (const pt of pts) {
      eseLines.push(`COORD:${pt}`);
    }
    eseLines.push('');
    eseLines.push(`SECTOR:${ap.icao}_TWR:0:24500`);
    eseLines.push(`OWNER:${ap.icao}_TWR:${ap.icao}_APP`);
    eseLines.push(`BORDER:${ap.icao}_BOUNDARY`);
    eseLines.push('');
  }
  eseLines.push('');

  // Write ESE file
  const esePath = path.join(sectorDir, 'WorldFlight2026.ese');
  fs.writeFileSync(esePath, eseLines.join('\r\n'), 'utf-8');
  console.log(`  Written ${eseLines.length} lines to ${esePath}`);

  // 5. Generate Settings files
  console.log('Generating settings files...');

  const settingsDir = path.join(OUTPUT_DIR, 'Data', 'Settings');
  const asrDir = path.join(OUTPUT_DIR, 'Data', 'ASR');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(asrDir, { recursive: true });

  // -- Symbology (UK-style, no plugins) --
  const symbology = [
    'SYMBOLOGY',
    'SYMBOLSIZE',
    'Airports:symbol:8026624:1.4:0:0:7',
    'Airports:name:7895040:3.2:0:0:2',
    'Low airways:line:8026624:2.5:2:0:7',
    'Low airways:name:7895040:2.5:0:0:8',
    'High airways:line:7895040:3.5:2:0:7',
    'High airways:name:7895040:3.5:0:0:8',
    'Fixes:symbol:8026624:1.4:0:0:7',
    'Fixes:name:7895040:3.2:0:0:2',
    'Sids:line:25700:3.0:0:0:7',
    'Stars:line:8026624:3.0:2:0:7',
    'ARTCC high boundary:line:8026624:3.0:2:0:7',
    'ARTCC boundary:line:64:3.0:1:0:7',
    'ARTCC low boundary:line:8026624:3.0:2:0:7',
    'Geo:line:8026624:3.0:0:0:7',
    'VORs:symbol:8026624:1.4:0:0:7',
    'VORs:name:7895040:3.2:0:0:2',
    'VORs:frequency:7895040:3.5:0:0:2',
    'NDBs:symbol:8026624:1.4:0:0:7',
    'NDBs:name:7895040:3.2:0:0:2',
    'NDBs:frequency:7895040:3.5:0:0:0',
    'Runways:centerline:7895040:3.5:0:0:7',
    'Runways:extended centerline:8026624:3.5:0:0:7',
    'Runways:name:7895040:3.5:0:0:7',
    'Datablock:non concerned:2008380:3.2:0:0:7',
    'Datablock:notified:2208871:3.2:0:0:7',
    'Datablock:assumed:4578664:3.2:0:0:7',
    'Datablock:transfer to me initiated:13816320:3.2:0:0:7',
    'Datablock:redundant:2008380:3.2:0:0:7',
    'Datablock:information:255:3.2:0:0:7',
    'Datablock:arrivals:42495:3.2:0:0:7',
    'Datablock:departures:16711680:3.2:0:0:7',
    'Datablock:emergency:3302655:3.2:0:0:7',
    'Datablock:detailed background:5131854:3.2:0:0:7',
    'Datablock:active item background:16777215:3.2:0:0:7',
    'Controller:normal:16777215:3.5:0:0:7',
    'Controller:breaking:10066431:3.5:0:0:7',
    'Controller:timeout:701695:3.5:0:0:7',
  ].join('\r\n');
  fs.writeFileSync(path.join(settingsDir, 'Symbology.txt'), symbology, 'utf-8');

  // -- Tags (standard EuroScope, no plugins) --
  const tags = [
    'TAGS',
    'TAGFAMILY:Standard',
    'TAGTYPE:0:2:1',
    'TAGITEM:0::0:0:0:0::0:1:::1',
    'TAGITEM:9::1:0:8:1::0:1:::0',
    'TAGTYPE:1:4:2',
    'TAGITEM:0::0:0:0:0::0:1:::1',
    'TAGITEM:9::1:0:8:1::0:1:::0',
    'TAGITEM:4::0:1:0:0::0:1:::1',
    'TAGITEM:29::0:1:0:0::0:1:::5',
    'TAGTYPE:2:6:2',
    'TAGITEM:0::0:0:0:0::0:1:::1',
    'TAGITEM:9::1:0:8:1::0:1:::0',
    'TAGITEM:4::0:1:0:0::0:1:::1',
    'TAGITEM:29::0:1:0:0::0:1:::5',
    'TAGITEM:8::0:1:0:0::0:1:::1',
    'TAGITEM:25::0:1:0:0::0:1:::1',
    'TAGTYPE:3:6:2',
    'TAGITEM:0::0:0:0:0::0:1:::1',
    'TAGITEM:9::1:0:8:1::0:1:::0',
    'TAGITEM:4::0:1:0:0::0:1:::1',
    'TAGITEM:29::0:1:0:0::0:1:::5',
    'TAGITEM:8::0:1:0:0::0:1:::1',
    'TAGITEM:25::0:1:0:0::0:1:::1',
    'TAGITEM:15::0:1:0:0::0:1:::1',
  ].join('\r\n');
  fs.writeFileSync(path.join(settingsDir, 'Tags.txt'), tags, 'utf-8');

  // -- General settings --
  const general = [
    'm_PlaySounds:1',
    'm_AssumeSlowAcAsStandby:1',
    'm_ShowAirspaceLines:1',
    'm_ShowRouteFixName:1',
    'm_ShowRouteETA:1',
    'm_ShowCalculatedHeading:1',
    'm_ShowSimulatedData:0',
    'm_TransitionAltitude:6000',
    'm_CenterlineDme:2.0',
    'm_CenterlineLength:10.0',
    'm_CenterlineTickDme:2.0',
    'm_CenterlineTickInterval:1.0',
    'm_CenterlineTickLength:0.3',
    'm_CenterlineMarkerLength:0.5',
    'm_CenterlineMarkerInterval:5.0',
    'm_STCA_LowShow:1',
    'm_STCA_LowVertical:970',
    'm_STCA_LowHorizontal:3.0',
    'm_STCA_LowBottom:2500',
    'm_STCA_HighShow:1',
    'm_STCA_HighVertical:970',
    'm_STCA_HighHorizontal:5.0',
    'm_STCA_HighBottom:17500',
    'm_RandomSquawks:1',
    'm_VFRSquawks:7000',
    'm_AutoLoadMetarForActiveAirports:1',
    'm_VoiceAtisBuilderUrl:https://www.vatatis.nz/gen?apptype=ILS&arr=$arrrwy($atisairport)&dep=$deprwy($atisairport)&metar=$metar($atisairport)',
  ].join('\r\n');
  fs.writeFileSync(path.join(settingsDir, 'General.txt'), general, 'utf-8');

  // -- Screen settings --
  const screen = [
    'm_ShowControllers:1',
    'm_ShowAircraft:0',
    'm_ShowTextMessages:0',
    'm_ShowTitle:1',
    'm_ShowTitleFileName:1',
    'm_ShowTitleController:1',
    'm_ShowTitlePrimaryFreq:1',
    'm_ShowTitleClock:1',
    'm_ShowFSSControllers:1',
    'm_ShowCTRControllers:1',
    'm_ShowAPPControllers:1',
    'm_ShowTWRControllers:1',
    'm_ShowGNDControllers:1',
    'm_ShowATISControllers:1',
    'm_ShowArrivalPlanes:1',
    'm_ShowDeparturePlanes:1',
    'm_ShowOverflightPlanes:1',
    'SET_ShowTrackingPlanes:1',
    'm_METARList:1',
  ].join('\r\n');
  fs.writeFileSync(path.join(settingsDir, 'Screen.txt'), screen, 'utf-8');

  // 6. Generate ASR file per airport
  console.log('Generating ASR files...');
  for (const ap of airports) {
    const asrLines = [
      'DisplayTypeName:Standard ES radar screen',
      'DisplayTypeNeedRadarContent:1',
      'DisplayTypeGeoReferenced:1',
    ];

    // Show all WF airports
    for (const a of airports) {
      asrLines.push(`Airports:${a.icao}:symbol`);
      asrLines.push(`Airports:${a.icao}:name`);
    }

    // Show runways for this airport
    for (const rwy of ap.runways) {
      if (rwy.ident1) asrLines.push(`Runways:${ap.icao}:${rwy.ident1}:centerline`);
      if (rwy.ident2) asrLines.push(`Runways:${ap.icao}:${rwy.ident2}:centerline`);
    }

    // Show extended centerlines for this airport
    for (const rwy of ap.runways) {
      if (rwy.ident1) asrLines.push(`Sids:${ap.icao}-${rwy.ident1}`);
      if (rwy.ident2) asrLines.push(`Sids:${ap.icao}-${rwy.ident2}`);
    }

    // Display settings
    asrLines.push(`SHOWC:${ap.icao}_TWR:1`);
    asrLines.push(`SHOWC:${ap.icao}_APP:1`);
    asrLines.push(`SHOWC:${ap.icao}_GND:1`);
    asrLines.push(`m_Latitude:${ap.lat}`);
    asrLines.push(`m_Longitude:${ap.lon}`);
    asrLines.push('m_Zoom:40');

    fs.writeFileSync(path.join(asrDir, `${ap.icao}.asr`), asrLines.join('\r\n'), 'utf-8');
  }
  console.log(`  Generated ${airports.length} ASR files`);

  // 7. Generate PRF file per airport
  console.log('Generating PRF files...');
  for (const ap of airports) {
    const prfLines = [
      `Settings\tSettingsfileSYMBOLOGY\tData\\Settings\\Symbology.txt`,
      `Settings\tSettingsfileTAGS\tData\\Settings\\Tags.txt`,
      `Settings\tSettingsfileSCREEN\tData\\Settings\\Screen.txt`,
      `Settings\tSettingsfile\tData\\Settings\\General.txt`,
      `Settings\tsector\tData\\Sector_Files\\WorldFlight2026.sct`,
      `ASRFastKeys\t1\tData\\ASR\\${ap.icao}.asr`,
      `RecentFiles\tRecent1\tData\\ASR\\${ap.icao}.asr`,
      `LastSession\tserver\tAUTOMATIC`,
      `LastSession\tatis_url0\thttps://www.vatatis.nz/gen?apptype=ILS&arr=$arrrwy($atisairportA)&dep=$deprwy($atisairportA)&metar=$metar($atisairportA)`,
    ];
    fs.writeFileSync(path.join(OUTPUT_DIR, `${ap.icao}.prf`), prfLines.join('\r\n'), 'utf-8');
  }
  console.log(`  Generated ${airports.length} PRF files`);

  // Also generate a generic WorldFlight.prf
  const genericPrf = [
    `Settings\tSettingsfileSYMBOLOGY\tData\\Settings\\Symbology.txt`,
    `Settings\tSettingsfileTAGS\tData\\Settings\\Tags.txt`,
    `Settings\tSettingsfileSCREEN\tData\\Settings\\Screen.txt`,
    `Settings\tSettingsfile\tData\\Settings\\General.txt`,
    `Settings\tsector\tData\\Sector_Files\\WorldFlight2026.sct`,
    ...airports.slice(0, 9).map((ap, i) => `ASRFastKeys\t${i + 1}\tData\\ASR\\${ap.icao}.asr`),
    `RecentFiles\tRecent1\tData\\ASR\\${airports[0].icao}.asr`,
    `LastSession\tserver\tAUTOMATIC`,
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, 'WorldFlight2026.prf'), genericPrf.join('\r\n'), 'utf-8');
  console.log('  Generated WorldFlight2026.prf (generic)');

  // Summary
  console.log('\n=== Pack Generated ===');
  console.log(`  Airports:        ${airports.length}`);
  console.log(`  Runways:         ${airports.reduce((s, a) => s + a.runways.length, 0)}`);
  console.log(`  VORs:            ${vors.length}`);
  console.log(`  NDBs:            ${ndbs.length}`);
  console.log(`  Fixes:           ${fixMap.size}`);
  console.log(`  High Airways:    ${airways.high.length}`);
  console.log(`  Low Airways:     ${airways.low.length}`);
  console.log(`  Centerlines:     ${airports.reduce((s, a) => s + a.runways.length * 2, 0)}`);
  console.log(`  ASR files:       ${airports.length}`);
  console.log(`  PRF files:       ${airports.length + 1}`);
  console.log(`  Settings files:  4`);
  console.log(`\n  Output: ${OUTPUT_DIR}`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
