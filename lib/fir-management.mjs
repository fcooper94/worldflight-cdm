// Read-only fetch + parse for the WF FIR Management spreadsheet.
//
// The source is a Google Sheets workbook with one tab per region (AMAS,
// APAC, EMEA, …). We discover the sheet list by scraping `htmlview` once,
// then fetch each tab via `export?format=csv&gid=…` and parse them all.
//
// Each tab is itself multi-table: a Division-level Event Director block
// followed by a Sub-division Event Director block (with a small coverage
// note in between, which we skip). We carry forward blank Division cells
// inside each block.
//
// Per row we extract:
//   - Region (the sheet name — AMAS / APAC / EMEA)
//   - Division (carried forward when blank)
//   - FIR ICAO codes (comma-split; wildcards like "Txxx" / "KZxx" filtered)
//   - Event Director name + CID (parsed from "Name - CID" pattern)
//   - Contact details
//
// The output is structured for direct rendering and includes a
// cid → Set<fir> map used to auto-grant FIR access at runtime.

const DOC_ID = '1Y2D_uQ7zPWA001HthsHExcyfYesyMx5YmZoS5hRkL64';
// Supplementary flat-format POC workbook. One sheet, columns:
//   Region, Sub/Division, FIR, POC, CID, <combined>
// Adds extra (cid → fir) grants the main Event Directors sheet sometimes misses.
const POC_DOC_ID = '1hANX4LZEbeykyXLafRX_KfmmIJ6qoJWwecLYC8_diRM';

// Tiny CSV line parser — handles double-quoted cells with embedded commas.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(c => c.trim());
}

function parseEventDirector(raw) {
  if (!raw || raw === '-') return { name: '', cid: null };
  const m = /^(.+?)\s*[-–]\s*(\d{4,10})\s*$/.exec(raw);
  if (m) return { name: m[1].trim(), cid: Number(m[2]) };
  return { name: raw.trim(), cid: null };
}

function extractFirCodes(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .filter(s => /^[A-Z]{3,5}$/.test(s))
    // Skip wildcard-style placeholders (e.g. "KZXX", "TXXX", "SCXX", "SKXX").
    .filter(s => !/X{2,}/i.test(s));
}

// Discover all visible sheet tabs by scraping the htmlview page. Returns an
// ordered list of { name, gid }. Hidden sheets are excluded by Google's own
// htmlview output.
async function discoverSheets() {
  const url = `https://docs.google.com/spreadsheets/d/${DOC_ID}/htmlview`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('htmlview fetch failed: HTTP ' + res.status);
  const html = await res.text();
  // The page embeds: items.push({name: "AMAS", ..., gid: "1653224983", ...})
  const out = [];
  const re = /items\.push\(\{\s*name:\s*"([^"]+)"[\s\S]*?gid:\s*"(-?\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ name: m[1], gid: m[2] });
  if (!out.length) throw new Error('No sheets discovered in htmlview');
  return out;
}

async function fetchSheetCsv(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CSV fetch failed for gid=${gid}: HTTP ${res.status}`);
  return res.text();
}

// Parse a single sheet's CSV text. Returns { divisions, subDivisions, cidToFirs }.
function parseSheetCsv(csvText, regionName) {
  const lines = csvText.split(/\r?\n/);
  const divisions = [];
  const subDivisions = [];
  const cidToFirs = new Map();
  let mode = null;            // 'DIVISION' | 'SUBDIVISION' | null
  let lastDivision = '';

  for (const rawLine of lines) {
    const cells = parseCsvLine(rawLine);
    if (!cells.some(Boolean)) continue;

    // Top-of-sheet region banner — skip (we use the sheet name as region).
    if (cells.filter(Boolean).length === 1 && /^[A-Z]{2,5}\s*-/.test(cells.filter(Boolean)[0])) {
      mode = null; lastDivision = ''; continue;
    }

    // Division-level header
    if (cells[1] === 'Division' && cells[2] === 'FIR ICAO Code' && cells[3] === 'Event Director' && cells[4] !== 'Sub-division') {
      mode = 'DIVISION'; lastDivision = ''; continue;
    }
    // Sub-division header
    if (cells[1] === 'Division' && cells[2] === 'FIR ICAO Code' && cells[3] === 'Sub-division') {
      mode = 'SUBDIVISION'; lastDivision = ''; continue;
    }
    // Coverage-note block
    if (cells[1] === 'Countries / Territories covered by a division') { mode = null; continue; }
    if (mode === null) continue;

    if (!cells.slice(1).some(Boolean)) continue;

    let division = cells[1] || lastDivision;
    if (cells[1]) lastDivision = cells[1];

    const firRaw = cells[2] || '';
    const firCodes = extractFirCodes(firRaw);

    if (mode === 'DIVISION') {
      const ed = parseEventDirector(cells[3]);
      const row = {
        region: regionName,
        division,
        firsRaw: firRaw,
        firs: firCodes,
        eventDirector: ed.name,
        cid: ed.cid,
        contact: cells[5] || '',
        email: cells[6] || '',
        discord: cells[7] || '',
        webLink: cells[8] || '',
        lastUpdated: cells[9] || ''
      };
      if (row.eventDirector || row.firs.length) divisions.push(row);
      if (ed.cid && firCodes.length) {
        if (!cidToFirs.has(ed.cid)) cidToFirs.set(ed.cid, new Set());
        firCodes.forEach(f => cidToFirs.get(ed.cid).add(f));
      }
    } else if (mode === 'SUBDIVISION') {
      const subName = cells[3] || '';
      const ed = parseEventDirector(cells[4]);
      const row = {
        region: regionName,
        division,
        firsRaw: firRaw,
        firs: firCodes,
        subDivision: subName,
        eventDirector: ed.name,
        cid: ed.cid,
        contact: cells[5] || '',
        email: cells[6] || '',
        discord: cells[7] || '',
        webLink: cells[8] || '',
        lastUpdated: cells[9] || ''
      };
      if (row.eventDirector || row.firs.length || row.subDivision) subDivisions.push(row);
      if (ed.cid && firCodes.length) {
        if (!cidToFirs.has(ed.cid)) cidToFirs.set(ed.cid, new Set());
        firCodes.forEach(f => cidToFirs.get(ed.cid).add(f));
      }
    }
  }

  return { divisions, subDivisions, cidToFirs };
}

// Parse the supplementary flat-format POC workbook. Header row is:
//   Region, Sub/Division, FIR, POC, CID, <combined>
// One row per (FIR, POC) grant. Returns { rows, cidToFirs }.
async function fetchAndParsePocWorkbook() {
  const url = `https://docs.google.com/spreadsheets/d/${POC_DOC_ID}/export?format=csv&gid=0`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`POC sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  const rows = [];
  const cidToFirs = new Map();
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (i === 0) continue;                            // header
    if (cells.length < 5 || !cells[2]) continue;      // no FIR column
    const region = (cells[0] || '').trim();
    const subDiv = (cells[1] || '').trim();
    const fir    = (cells[2] || '').trim().toUpperCase();
    const poc    = (cells[3] || '').trim();
    const cidNum = Number(cells[4]);
    if (!/^[A-Z]{3,5}$/.test(fir) || /X{2,}/i.test(fir)) continue;
    if (!cidNum) continue;
    rows.push({ region, subDivision: subDiv, fir, eventDirector: poc, cid: cidNum, source: 'POC' });
    if (!cidToFirs.has(cidNum)) cidToFirs.set(cidNum, new Set());
    cidToFirs.get(cidNum).add(fir);
  }
  return { rows, cidToFirs };
}

export async function fetchAndParseFirManagement() {
  const sheets = await discoverSheets();
  const allDivisions = [];
  const allSubDivisions = [];
  const cidToFirs = new Map();
  const fetchedSheets = [];

  for (const sheet of sheets) {
    try {
      const csv = await fetchSheetCsv(sheet.gid);
      const parsed = parseSheetCsv(csv, sheet.name);
      allDivisions.push(...parsed.divisions);
      allSubDivisions.push(...parsed.subDivisions);
      for (const [cid, firs] of parsed.cidToFirs.entries()) {
        if (!cidToFirs.has(cid)) cidToFirs.set(cid, new Set());
        firs.forEach(f => cidToFirs.get(cid).add(f));
      }
      fetchedSheets.push({ name: sheet.name, gid: sheet.gid, divisions: parsed.divisions.length, subDivisions: parsed.subDivisions.length });
    } catch (e) {
      fetchedSheets.push({ name: sheet.name, gid: sheet.gid, error: e.message });
    }
  }

  // Layer in the supplementary POC workbook
  let pocRows = [];
  let pocSummary = { count: 0, cids: 0, added: 0 };
  try {
    const poc = await fetchAndParsePocWorkbook();
    pocRows = poc.rows;
    let added = 0;
    for (const [cid, firs] of poc.cidToFirs.entries()) {
      if (!cidToFirs.has(cid)) cidToFirs.set(cid, new Set());
      const set = cidToFirs.get(cid);
      firs.forEach(f => {
        if (!set.has(f)) { set.add(f); added++; }
      });
    }
    pocSummary = { count: poc.rows.length, cids: poc.cidToFirs.size, added };
  } catch (e) {
    pocSummary = { count: 0, cids: 0, added: 0, error: e.message };
  }

  return {
    regions: sheets.map(s => s.name),
    sheets: fetchedSheets,
    divisions: allDivisions,
    subDivisions: allSubDivisions,
    pocRows,
    pocSummary,
    cidToFirs: Object.fromEntries([...cidToFirs.entries()].map(([k, v]) => [k, [...v]])),
    fetchedAt: new Date().toISOString()
  };
}
