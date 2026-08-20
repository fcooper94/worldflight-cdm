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

export const TEMPLATE_SERIAL = 2026082009;

/* US fields differ enough to be worth branching on: altimeters are inches of
   mercury rather than hectopascals. */
function isUsIcao(icao) {
  return /^[KP]/.test(icao);
}

/* From the UK pack's Birmingham profile. Airport-specific entries there named
   Birmingham's own delivery and ground frequencies, so only the ones that hold
   true anywhere are kept. */
const AIRPORT_CONDITIONS = [
  'ATC LOW VISIBILITY PROCEDURES IN OPERATION.',
  'WINDSHEAR REPORTED.',
  'PILOTS ARE REMINDED TO USE MINIMUM RUNWAY OCCUPANCY.',
  'DATALINK CLEARANCES ARE AVAILABLE.',
];

const CONTRACTIONS = [
  { variableName: 'LVPS', text: 'LVPS', voice: 'L V PEES' },
  { variableName: 'DATALINK', text: 'DATALINK', voice: 'DAYTA LINK' },
  { variableName: 'COM', text: 'COM', voice: '' },
  { variableName: 'ATIS', text: 'ATIS', voice: 'INFORMATION' },
  { variableName: 'ATC', text: 'ATC', voice: 'AIR TRAFFIC CONTROL' },
];

/* No transition level is published here. It can be derived from an airport's
   transition altitude, but only against that state's own QNH table, and where
   a state publishes something non-standard the result is confidently wrong --
   which is worse than silent on something a controller reads out. Left to the
   controller in vATIS instead. */

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

/* Goes into every broadcast, configured or not. */
export const WELCOME_LINE = 'WELCOME TO WORLDFLIGHT.';

/* Ends the broadcast in place of vATIS's [CLOSING] variable. Auto-include is
   switched off with it, or vATIS appends the closing statement anyway and the
   old acknowledge-receipt wording comes back on its own. */
export const END_LINE = 'END OF ATIS.';

export const APPROACH_TYPES = ['ILS', 'RNP', 'RNAV (GNSS)', 'VOR', 'NDB', 'VISUAL', 'ILS OR VISUAL'];

/* NOTAMs from the configurator continue the airport conditions list rather
   than living in vATIS's separate NOTAM slot, so a controller sees one
   numbered list -- the four canned conditions, then theirs from 5 onwards.
   They arrive enabled, unlike the canned ones: someone typed them for this
   airport today, so they are meant to be read out. */
export function conditionDefinitions(config) {
  const canned = AIRPORT_CONDITIONS.map((text, i) => ({ text, ordinal: i + 1, enabled: false }));
  const list = (config && Array.isArray(config.notams)) ? config.notams : [];
  const extra = list
    .map(n => tidyLine(typeof n === 'string' ? n : (n && n.text)))
    .filter(Boolean)
    .map((text, i) => ({ text, ordinal: canned.length + i + 1, enabled: true }));
  return canned.concat(extra);
}

/* vATIS reads a preset out as written, so anything free-typed has to be
   flattened to one broadcastable line. Uppercase because the rest of the
   template is, and newlines would silently split it into a line the format
   does not expect. */
function tidyLine(text) {
  const clean = String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!clean) return '';
  return /[.!?]$/.test(clean) ? clean : clean + '.';
}

/* Always exactly one preset, called WF.

   A preset per runway was only ever a stand-in for not knowing which runway was
   in use. Now that the configurator answers that, more than one is clutter: a
   controller connecting has a single WorldFlight preset to select rather than a
   list to pick through, and changing the runway edits the preset rather than
   switching to a different one. */
export const PRESET_NAME = 'WF';

export function presetsFor(config) {
  const lines = ['[FACILITY] ATIS [ATIS_CODE].', '[TIME].'];

  const dep = String((config && config.depRwy) || '').toUpperCase();
  const arr = String((config && config.arrRwy) || '').toUpperCase();
  if (dep && arr && dep !== arr) lines.push('DEP RWY ^' + dep + '. ARR RWY ^' + arr + '.');
  else if (dep || arr) lines.push('RWY IN USE ^' + (dep || arr) + '.');

  const app = tidyLine(config && config.approach).replace(/\.$/, '');
  if (app) lines.push('EXPECT ' + app + ' APPROACH.');

  lines.push('[ARPT_COND]', '[NOTAMS]', '[WX].', WELCOME_LINE, END_LINE);
  return [{ name: PRESET_NAME, template: lines.join('\r\n') }];
}

/**
 * @param {object} o
 * @param {string} o.icao        four-letter identifier
 * @param {string} [o.name]      airport name, defaults to the ICAO
 * @param {Array}  [o.runways]   rows of { ident1, ident2 }
 * @param {number} [o.frequency] ATIS frequency in Hz (136030000 = 136.030)
 * @param {string} [o.updateUrl] where vATIS should poll for a newer copy
 * @param {number} [o.serial]    YYYYMMDDNN, defaults to TEMPLATE_SERIAL
 * @param {object} [o.config]  { depRwy, arrRwy, approach, notams[] } from the
 *                             ATIS configurator; collapses presets to one
 */
export function buildVatisProfile(o, template) {
  const icao = String(o.icao || '').toUpperCase();
  const name = o.name || icao;
  const us = isUsIcao(icao);

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
    st.presets = presetsFor(o.config);
    st.atisFormat = st.atisFormat || {};
    st.atisFormat.altimeter = {
      pronounceDecimal: false,
      template: us
        ? { text: 'A{altimeter}', voice: 'ALTIMETER {altimeter}' }
        : { text: 'Q{altimeter|hpa}', voice: 'QNH {altimeter|hpa}' },
    };
    delete st.atisFormat.transitionLevel;
    st.airportConditionDefinitions = conditionDefinitions(o.config);
    st.notamDefinitions = [];
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
        autoIncludeClosingStatement: false,
        template: { text: END_LINE, voice: END_LINE },
      },
    },
    notamsBeforeFreeText: false,
    airportConditionsBeforeFreeText: false,
    frequency: Number(o.frequency) || 0,
    useDecimalTerminology: !us,
    /* vATIS disabled its additional voices on cost grounds and now uses the
       default regardless of what a profile asks for, so "UK Male" -- inherited
       from the UK pack -- was being ignored anyway. "Default" is the one
       documented value, and sounds close to FAA D-ATIS. */
    atisVoice: { useTextToSpeech: true, voice: 'Default', speechRate: 170 },
    presets: presetsFor(o.config),
    contractions: CONTRACTIONS.map(c => ({ ...c })),
    airportConditionDefinitions: conditionDefinitions(o.config),
    notamDefinitions: [],
  };

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
