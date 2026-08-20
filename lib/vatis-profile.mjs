/* vATIS profile generation.

   vATIS (https://vatis.app) imports a JSON profile per airport. A profile can
   carry an updateUrl, which vATIS polls and compares against updateSerial: a
   higher serial on the server means the controller's copy is stale and gets
   replaced. That is why every profile we hand out points its updateUrl back at
   /api/vATIS/<ICAO>.json — a controller imports once and we can correct the
   frequency, runways or closing statement afterwards without anyone
   re-downloading anything.

   Serials are YYYYMMDDNN. Bump TEMPLATE_SERIAL whenever the generated shape
   below changes, or existing installs will never pick the change up. */

export const TEMPLATE_SERIAL = 2026082002;

/* US fields differ enough to be worth branching on: altimeters are inches of
   mercury rather than hectopascals, and there is no transition level to read
   out — the transition altitude is fixed at 18,000 ft. */
function isUsIcao(icao) {
  return /^[KP]/.test(icao);
}

/* From the UK pack's Birmingham profile. Airport-specific entries there named
   Birmingham's own delivery and ground frequencies, so only the ones that hold
   true anywhere are kept. */
const AIRPORT_CONDITIONS = [
  'ATC LOW VISIBILITY PROCEDURES IN OPERATION.',
  'INCREASED BIRD ACTIVITY WITHIN THE AERODROME BOUNDARY.',
  'LARGE FLOCKS OF BIRDS HAVE BEEN OBSERVED WITHIN THE VICINITY OF THE AERODROME.',
  'TURBULENCE MAY BE ENCOUNTERED IN THE FINAL STAGES OF THE APPROACH.',
  'WINDSHEAR REPORTED.',
  'BE ADVISED MODERATE MICRO-BURST FORECAST.',
  'FLIGHT CREWS ARE REMINDED TO USE MINIMUM RUNWAY OCCUPANCY.',
  'DATALINK CLEARANCES ARE AVAILABLE.',
];

const CONTRACTIONS = [
  { variableName: 'LVPS', text: 'LVPS', voice: 'L V PEES' },
  { variableName: 'DATALINK', text: 'DATALINK', voice: 'DAYTA LINK' },
  { variableName: 'COM', text: 'COM', voice: '' },
  { variableName: 'ATIS', text: 'ATIS', voice: 'INFORMATION' },
  { variableName: 'ATC', text: 'ATC', voice: 'AIR TRAFFIC CONTROL' },
];

/* QNH band -> transition level, derived from the airport's own transition
   altitude rather than assumed.

   The level is the lowest FL divisible by 5 that still sits 1,000 ft above the
   transition altitude at standard pressure, and each 18 hPa away from 1013
   moves it half a level -- 18 hPa being roughly 500 ft. Feeding it 6,000 ft
   reproduces the UK pack's Birmingham table exactly, band for band, which is
   what the shape was checked against.

   The offsets are in half-levels from the 1013-1031 band. */
const QNH_BANDS = [
  { low: 940, high: 958, step: 4 },
  { low: 959, high: 976, step: 3 },
  { low: 977, high: 994, step: 2 },
  { low: 995, high: 1012, step: 1 },
  { low: 1013, high: 1031, step: 0 },
  { low: 1032, high: 1049, step: -1 },
  { low: 1050, high: 1060, step: -2 },
];

const DEFAULT_TRANSITION_ALT = 6000;

export function transitionLevelsFor(transitionAltitude) {
  const ta = Number(transitionAltitude) > 0 ? Number(transitionAltitude) : DEFAULT_TRANSITION_ALT;
  const base = Math.ceil((ta + 1000) / 500) * 5;   // FL, divisible by 5
  return QNH_BANDS.map(b => ({ low: b.low, high: b.high, altitude: base + b.step * 5 }));
}

/* "07" and "25" are the two ends of one runway; both are usable directions, so
   each becomes its own preset. */
export function runwayIdents(runways) {
  const out = [];
  for (const r of runways || []) {
    for (const id of [r.ident1, r.ident2]) {
      const clean = String(id || '').trim().toUpperCase();
      if (clean && out.indexOf(clean) === -1) out.push(clean);
    }
  }
  return out.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));
}

function presetsFor(idents, us) {
  const tl = us ? '' : '[TL].\r\n';
  if (!idents.length) {
    return [{
      name: 'Default',
      template: '[FACILITY] COM ATIS [ATIS_CODE].\r\n[TIME].\r\n' + tl + '[ARPT_COND]\r\n[NOTAMS]\r\n[WX].\r\n[CLOSING].',
    }];
  }
  return idents.map(rwy => ({
    name: rwy,
    template: '[FACILITY] COM ATIS [ATIS_CODE].\r\n[TIME].\r\nRWY IN USE ^' + rwy + '.\r\n'
      + tl + '[ARPT_COND]\r\n[NOTAMS]\r\n[WX].\r\n[CLOSING].',
  }));
}

/**
 * @param {object} o
 * @param {string} o.icao        four-letter identifier
 * @param {string} [o.name]      airport name, defaults to the ICAO
 * @param {Array}  [o.runways]   rows of { ident1, ident2 }
 * @param {number} [o.frequency] ATIS frequency in Hz (136030000 = 136.030)
 * @param {string} [o.updateUrl] where vATIS should poll for a newer copy
 * @param {number} [o.serial]    YYYYMMDDNN, defaults to TEMPLATE_SERIAL
 * @param {number} [o.transitionAltitude] feet; 6,000 assumed when unknown
 */
export function buildVatisProfile(o, template) {
  const icao = String(o.icao || '').toUpperCase();
  const name = o.name || icao;
  const us = isUsIcao(icao);
  const idents = runwayIdents(o.runways);

  /* A stored template supplies everything that is the same everywhere -- the
     wording, contractions, conditions, voice. The fields below are rebuilt per
     airport regardless of what the template says, because they cannot be
     shared: who you are, what you transmit on, which runways exist, and the
     vertical structure of the airspace. */
  if (template) {
    const out = JSON.parse(JSON.stringify(template));
    const st = (out.stations && out.stations[0]) || {};
    st.identifier = icao;
    st.name = name;
    st.frequency = Number(o.frequency) || 0;
    st.presets = presetsFor(idents, us);
    st.atisFormat = st.atisFormat || {};
    st.atisFormat.altimeter = {
      pronounceDecimal: false,
      template: us
        ? { text: 'A{altimeter}', voice: 'ALTIMETER {altimeter}' }
        : { text: 'Q{altimeter|hpa}', voice: 'QNH {altimeter|hpa}' },
    };
    if (us) {
      delete st.atisFormat.transitionLevel;
    } else {
      st.atisFormat.transitionLevel = {
        values: transitionLevelsFor(o.transitionAltitude),
        template: (st.atisFormat.transitionLevel && st.atisFormat.transitionLevel.template)
          || { text: 'TRANSITION-LEVEL FL {trl}', voice: 'TRANSITION LEVEL. FLIGHT LEVEL {trl}' },
      };
    }
    st.useDecimalTerminology = !us;
    out.stations = [st];
    out.name = 'WF ' + icao;
    out.updateUrl = o.updateUrl || '';
    out.updateSerial = Number(o.serial) || Number(template.updateSerial) || TEMPLATE_SERIAL;
    out.version = out.version || 4;
    return out;
  }

  const station = {
    ordinal: 0,
    identifier: icao,
    name,
    atisType: 'Combined',
    codeRange: { low: 'A', high: 'Z' },
    atisFormat: {
      observationTime: {
        template: { text: '{time}Z', voice: 'TIME {time} ZULU {special}' },
      },
      surfaceWind: {
        speakLeadingZero: false,
        magneticVariation: { enabled: false, magneticDegrees: 0 },
        standard: {
          template: { text: '{wind_dir}{wind_spd}KT', voice: 'SURFACE WIND {wind_dir} {wind_spd} KNOTS' },
        },
        standardGust: {
          template: { text: '{wind_dir}{wind_spd}G{wind_gust}KT', voice: 'SURFACE WIND {wind_dir} {wind_spd} GUSTING {wind_gust} KNOTS' },
        },
        variable: {
          template: { text: 'VRB{wind_spd}KT', voice: 'SURFACE WIND VARIABLE {wind_spd} KNOTS' },
        },
        variableGust: {
          template: { text: 'VRB{wind_spd}G{wind_gust}KT', voice: 'SURFACE WIND VARIABLE {wind_spd} GUSTING {wind_gust} KNOTS' },
        },
        variableDirection: {
          template: { text: '{wind_vmin}V{wind_vmax}', voice: 'VARIABLE BETWEEN {wind_vmin} AND {wind_vmax} DEGREES' },
        },
        calm: {
          calmWindSpeed: 2,
          template: { text: '{wind}', voice: 'SURFACE WIND CALM' },
        },
      },
      visibility: { unlimitedVisibilityText: '9999' },
      recentWeather: { template: { text: '', voice: '' } },
      clouds: {
        automaticCbDetection: { text: '//////CB', voice: 'RADAR DETECTED CUMULONIMBUS CLOUDS' },
      },
      temperature: { usePlusPrefix: true },
      dewpoint: { usePlusPrefix: true },
      altimeter: {
        pronounceDecimal: false,
        template: us
          ? { text: 'A{altimeter}', voice: 'ALTIMETER {altimeter}' }
          : { text: 'Q{altimeter|hpa}', voice: 'QNH {altimeter|hpa}' },
      },
      notams: { template: { text: '{notams}', voice: '{notams}' } },
      closingStatement: {
        autoIncludeClosingStatement: true,
        template: {
          text: 'ACKNOWLEDGE RECEIPT OF INFORMATION {letter} AND ADVISE AIRCRAFT TYPE ON FIRST CONTACT',
          voice: 'ACKNOWLEDGE RECEIPT OF INFORMATION {letter|word} AND ADVISE AIRCRAFT TYPE ON FIRST CONTACT',
        },
      },
    },
    notamsBeforeFreeText: false,
    airportConditionsBeforeFreeText: false,
    frequency: Number(o.frequency) || 0,
    useDecimalTerminology: !us,
    /* Kept as the UK pack had it: it is a value vATIS is known to accept,
       and a wrong voice name is worse than a geographically odd one. */
    atisVoice: { useTextToSpeech: true, voice: 'UK Male', speechRate: 170 },
    presets: presetsFor(idents, us),
    contractions: CONTRACTIONS.map(c => ({ ...c })),
    airportConditionDefinitions: AIRPORT_CONDITIONS.map((text, i) => ({ text, ordinal: i + 1, enabled: false })),
    notamDefinitions: [],
  };

  if (!us) {
    station.atisFormat.transitionLevel = {
      values: transitionLevelsFor(o.transitionAltitude),
      template: { text: 'TRANSITION-LEVEL FL {trl}', voice: 'TRANSITION LEVEL. FLIGHT LEVEL {trl}' },
    };
  }

  return {
    /* The profile list in vATIS is narrow and truncates, so identify it by
       event and ICAO rather than by the airport's full name -- "WF EHAM"
       instead of "Amsterdam Airport Schiph...". The station keeps the real
       name, which is what the broadcast reads out. */
    name: 'WF ' + icao,
    updateUrl: o.updateUrl || '',
    updateSerial: Number(o.serial) || TEMPLATE_SERIAL,
    stations: [station],
    version: 4,
  };
}

/* The built-in shape, with the airport-specific fields blanked out. This is
   what the admin API hands back as a starting point when nothing is stored. */
export function defaultTemplate() {
  const p = buildVatisProfile({ icao: 'ZZZZ', name: '' });
  p.name = '';
  p.updateUrl = '';
  const st = p.stations[0];
  st.identifier = '';
  st.name = '';
  st.frequency = 0;
  st.presets = [];
  return p;
}
