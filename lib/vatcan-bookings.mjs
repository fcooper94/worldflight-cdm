// VATCAN Bookings integration.
//
// Cody Newman (VATCAN) built an HTTP API for the bookings plugin so we can
// push live slot data instead of CSV-uploading every change. Two endpoints:
//
//   POST {BASE}/api/event                  → create event, returns event_id
//   POST {BASE}/api/event/{event_id}/bookings → push JSON bookings array
//
// Auth: header `X-API-KEY: <key>`. Key is per-user and only authorises
// events the user is owner/manager of.
//
// Body shape for the bookings push matches our own /api/slots/<wf>.json:
//   [{ "cid": 1303570, "slot": "2030" }, ...]
//
// VATCAN's plugin polls every 3–5 min, so the worst-case latency between a
// pilot booking and a controller seeing the slot is that poll interval.

const ENV_BASE   = process.env.VATCAN_BOOKINGS_API_URL || 'https://bookings.vlhtesting.com';
const API_KEY    = process.env.VATCAN_BOOKINGS_API_KEY || '';
const ENABLED    = !!API_KEY && process.env.VATCAN_BOOKINGS_DISABLED !== 'true';
const DEFAULT_TIMEOUT_MS = 10_000;

export function vatcanIsEnabled() { return ENABLED; }
export function vatcanBaseUrl()    { return ENV_BASE; }

async function vatcanFetch(path, { method = 'POST', body } = {}) {
  if (!ENABLED) {
    const reason = API_KEY ? 'disabled via VATCAN_BOOKINGS_DISABLED' : 'no VATCAN_BOOKINGS_API_KEY';
    throw new Error('VATCAN integration ' + reason);
  }
  const url = ENV_BASE.replace(/\/$/, '') + path;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body != null ? JSON.stringify(body) : undefined
    });
  } finally {
    clearTimeout(t);
  }
  let parsed = null;
  const text = await res.text();
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const detail = typeof parsed === 'string' ? parsed : (parsed?.message || res.statusText);
    const err = new Error(`VATCAN ${method} ${path} → ${res.status} ${detail}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// Create an event on VATCAN. Returns { event_id, ... }. `eventOwnerCid` must
// be the API key's CID (or an event-manager CID for it).
export async function vatcanCreateEvent({ name, dateUtc, eventOwnerCid }) {
  if (!name || !dateUtc || !eventOwnerCid) throw new Error('name/dateUtc/eventOwnerCid required');
  const res = await vatcanFetch('/api/event', {
    method: 'POST',
    body: {
      event_name: name,
      event_date: dateUtc,
      event_owner: Number(eventOwnerCid)
    }
  });
  return res?.event || res;
}

// Push the bookings array for an event. Sample: [{cid:1303570, slot:"2030"}].
// VATCAN replaces the whole list (no diffing), so we always send the full set.
export async function vatcanPushBookings({ eventId, bookings }) {
  if (!eventId) throw new Error('eventId required');
  if (!Array.isArray(bookings)) throw new Error('bookings must be an array');
  return vatcanFetch(`/api/event/${encodeURIComponent(eventId)}/bookings`, {
    method: 'POST',
    body: bookings
  });
}

// ── Per-sector push orchestrator ──────────────────────────────────────────
//
// The caller passes in a `getBookings(wf)` closure (so this lib stays free
// of any DB/Prisma coupling) plus the `eventId` to push to. We coalesce
// rapid changes so a flurry of book/cancel within a short window only
// produces one push.

const PENDING = new Map();     // wf -> debounce timer
const LAST_RESULT = new Map(); // wf -> { at, ok, error?, count? }
const DEBOUNCE_MS = 750;

export function vatcanGetLastResult(wf) { return LAST_RESULT.get(wf) || null; }
export function vatcanAllLastResults()  { return Object.fromEntries(LAST_RESULT); }

// Push immediately (no debounce). Returns the API response or throws.
export async function vatcanPushSectorNow({ wf, eventId, bookings, onLog }) {
  if (!ENABLED) {
    const r = { at: Date.now(), ok: false, error: 'disabled', count: 0 };
    LAST_RESULT.set(wf, r);
    return r;
  }
  if (!eventId) {
    const r = { at: Date.now(), ok: false, error: 'no_event_id', count: 0 };
    LAST_RESULT.set(wf, r);
    return r;
  }
  try {
    const data = await vatcanPushBookings({ eventId, bookings });
    const count = data?.total_entries ?? bookings.length;
    const r = { at: Date.now(), ok: true, count };
    LAST_RESULT.set(wf, r);
    onLog?.('info', `[VATCAN] pushed ${wf} → event ${eventId} (${count} bookings)`);
    return r;
  } catch (e) {
    const r = { at: Date.now(), ok: false, error: e.message, count: bookings.length };
    LAST_RESULT.set(wf, r);
    onLog?.('error', `[VATCAN] push failed ${wf} → event ${eventId}: ${e.message}`);
    return r;
  }
}

// Debounced push. Safe to call from booking hooks on every change — multiple
// calls within DEBOUNCE_MS coalesce into one push using the latest data.
export function vatcanQueueSectorPush({ wf, getEventId, getBookings, onLog }) {
  if (!ENABLED) return;
  const existing = PENDING.get(wf);
  if (existing) clearTimeout(existing);
  const t = setTimeout(async () => {
    PENDING.delete(wf);
    try {
      const eventId = await getEventId();
      const bookings = await getBookings();
      await vatcanPushSectorNow({ wf, eventId, bookings, onLog });
    } catch (e) {
      const r = { at: Date.now(), ok: false, error: e.message, count: 0 };
      LAST_RESULT.set(wf, r);
      onLog?.('error', `[VATCAN] queue failed ${wf}: ${e.message}`);
    }
  }, DEBOUNCE_MS);
  PENDING.set(wf, t);
}
