# WorldFlight Planning Portal — Claude Working Notes

This file is loaded automatically by Claude Code at the start of every conversation in this repo. It captures project context, tech overview, and collaboration rules so any Claude instance (this PC or another) is on the same page from turn one.

## Project

The **WorldFlight Planning Portal** is the operations site for the annual *WorldFlight* VATSIM round-the-world event.

- **Current active event:** WorldFlight 2026 (31 Oct – 7 Nov 2026)
- **Sectors** are individual legs identified as `WFxxxx` (e.g. `WF2624: KDEN → EGPK`)
- Pilots book TOBT slots and view briefings; controllers manage flow restrictions and ATIS
- Visited airports are tracked per year in `WfVisitedAirport` (data stretches back to early WorldFlights)

## Tech overview

- **Stack:** Express + Prisma + Leaflet + Socket.IO, vanilla JS templates (no React/Vue)
- **`index.js`** is the monolithic main file (~35k lines) — most routes and rendered HTML live here
- **`layout.js`** holds shared layout chrome and modal markup

### `index.js` line map (approximate — shifts with edits)

| Line   | Section |
|--------|---------|
| ~1     | Imports and setup |
| ~600   | TOBT booking loading (`loadTobtBookingsFromDb`) |
| ~790   | Dep flow / globals (`loadDepFlowsFromDb`, `connectedUsers`) |
| ~3930  | Suggest airport page |
| ~5380  | Socket.IO connection handler |
| ~6080  | Route helpers (`stripSidStar`, `normalizeRoute`, `decorateRouteForDisplay`) |
| ~7410  | Route tokenization + point resolution |
| ~8670  | Sector detail page (`/sector/:wf/:from/:to`) |
| ~9340  | Schedule page (`/schedule`) |
| ~15900 | My Slots API data |
| ~17300 | Affiliate portal |
| ~19500 | Team bookings |
| ~21870 | Schedule table editing UI |
| ~24050 | Route resolve API (`/api/resolve-route`) |
| ~24400 | Schedule row update/add APIs |
| ~28400 | ATC page |
| ~28520 | Sector Planning list (`/sector-planning`) |
| ~28690 | Sector Planning admin overview (`/sector-planning/admin`) |
| ~28960 | Sector Plan finalise API |
| ~29050 | Sector Planning detail page (`/sector-planning/:wf`) |
| ~31150 | Sector Plan route/flow/split APIs |
| ~31790 | Airspace page |
| ~34680 | Book a slot page (`/book`) |
| ~35220 | My Slots page (`/my-slots`) |
- **`public/`** has client-side JS (`icao-map.js`, `wf-world-map.js`, `previous-destinations.js`) and `styles.css`
- **Auth:** VATSIM OAuth in production; `DEV_MODE=true` enables an offline dev login that bypasses VATSIM
- **Map tiles:** CartoDB dark/light via `wfAddTileLayer()`; tiles swap automatically when the footer Light/Dark toggle changes `data-theme`

## Two Prisma schemas, two databases

| File | Database | Used when |
|------|----------|-----------|
| `prisma/schema.prisma` | Production Postgres (Railway) | `npm start`, prod |
| `prisma/schema.dev.prisma` | Local SQLite at `prisma/dev.db` | `npm run dev` → option 2 (Offline Dev) |

**Both schemas must be edited together** for any column add/remove. They drift otherwise.

## Dev / prod sync workflow

- `start.js` is the entry for `npm run dev`. It prompts for Production vs Offline (Dev) and rewrites `.env` from `.env.dev` (offline) or `.env.prod.bak` (prod).
- `sync-prod.mjs` pulls live prod tables into the local SQLite DB. It reads the prod connection string from `.env.dev`'s `PROD_DATABASE_URL`.
- **After any schema change:**
  1. Edit both schema files.
  2. Push to dev SQLite: `npx prisma db push --schema=prisma/schema.dev.prisma --skip-generate`
  3. Push to prod Postgres: `DATABASE_URL="$PROD_URL" npx prisma db push --schema=prisma/schema.prisma --skip-generate` (read `PROD_URL` from `.env.dev`).
  4. If a column has a `@default(...)` and existing rows need a different value, run a one-off backfill query directly against each DB after the push.
  5. Restart `npm run dev` — Prisma client regen fails on Windows while nodemon holds the engine DLL.
- **Pushing to prod is a serious action.** Show a dry-run / preview first, get explicit go-ahead per push, and run a verification query after.

## Collaboration rules

### 1. Stay strictly within requested scope
When asked to change or remove X, do **only** that. Don't refactor adjacent code, don't delete "related" dead code, don't add improvements beyond the request. If supporting code looks orphaned afterwards, leave it or ask separately — bundling cleanup into a removal task has caused regressions before.

### 2. Propose A/B/C options for non-trivial UI restructures
For layout overhauls (new tab structure, page consolidation, big flow change), list 2–3 named options with their tradeoffs and recommend one. Wait for the user to pick before implementing. Small tweaks (colour, padding, single-element add/remove, copy changes) — just do them directly.

### 3. Cosmetic CSS is never a security boundary
For login-gated "preview" pages, the server must render a non-sensitive placeholder. CSS `filter: blur()` is purely visual and removable in DevTools — any page that sends real data and blurs it client-side leaks that data. Pattern:

1. Check authentication server-side at the route handler.
2. If unauthenticated, render hard-coded sample/skeleton — no DB lookups, no real CIDs, callsigns, sectors, names.
3. Apply blur and the login overlay only on top of that placeholder.

### 4. No CHANGELOG.md
Keep change history in `git log` only. Never create or maintain a `CHANGELOG.md` file. Write detailed commit messages instead.

### 5. Confirm git push explicitly
Always ask before `git push`, even right after a recently approved push. Each push is its own decision; "yes" once does not authorize subsequent pushes.

## Page-visibility model (3-state)

`PageVisibility.mode` is one of:

- **`visible`** — shown to everyone (in nav and accessible)
- **`admin-only`** — shown in admin's nav, hidden from non-admin nav, returns 403 for non-admins (admin can access)
- **`hidden`** — hidden from nav for everyone, returns 403 for non-admins (admin can still URL-navigate)

Helpers:

- `isPageVisibleTo(key, isAdmin)` — for inline feature checks (returns true if visible to all, OR admin-only and viewer is admin)
- `isPageEnabled(key)` — legacy shim that returns true only for `'visible'`. Use `isPageVisibleTo` for new code.
- `requirePageEnabled(key)` middleware passes if visible OR viewer is admin (so admins always have access)

The legacy `enabled` boolean on the row is kept in sync on every write for back-compat.

## Document validity scoping

`AirportDocument.eventId` controls when a document is shown:

- `NULL` = permanent — always visible to everyone with access
- A specific event id = visible only while that event is the active event (`WfEvent.isActive`)
- Non-admins never see archived (event != active) docs
- Only the *currently active* event id may be tagged at upload time — any other id is rejected server-side
- Admins see all docs regardless, with a scope badge (Permanent / event name / Archived: event name)

## Airport portal (`/icao/:icao`)

Two-tab page that's become a major surface area. Architecture worth knowing:

- **Tab 1 — Map, Controllers & ATIS:** two-column grid (`.icao-portal-grid`, `minmax(0, 1.4fr) minmax(0, 1fr)`, `align-items: stretch`). Left column is the map card (stretches to right column height). Right column has METAR card → ATIS card(s) → Online Controllers card.
- **Tab 2 — Pilot Documents & Scenery:** two stacked cards.
- **WF banner state machine:** three banner states at the top: WF airport (with sector buttons), "Not on this year's route", or "route not yet released" (when the Schedule page is hidden — so the banner doesn't leak the route via portal-by-portal probing). Use `isPageVisibleTo('schedule', isAdmin)` for the gate.

### Side-label-card UI pattern

All cards on this page (METAR, each ATIS variant, Online Controllers, Pilot Documents, Available Scenery) share the same shape:

- `<section class="card side-label-card xxx-card">` wrapper
- `<span class="card-side-label">METAR</span>` — top-left horizontal corner chip with `border-top-left-radius: var(--radius)` so it tucks into the rounded card corner
- `<div class="card-side-body">` — content, padded `30px 16px 12px 16px` to clear the label
- Per-card `--card-stripe` CSS variable sets the chip color

Established colours:
- METAR `#60a5fa` · DEPARTURE `#f59e0b` · ARRIVAL `#10b981` · ATIS (general) `#06b6d4` · FAA ATIS `#6b7280`
- ONLINE CONTROLLERS `#818cf8` · PILOT DOCUMENTS `#a78bfa` · AVAILABLE SCENERY `#14b8a6`

`.card-side-body` is `display: flex; flex-direction: column; justify-content: center` — children stretch on the cross axis (full width). `.action-btn` inside needs `align-self: flex-start` to avoid stretching.

### Map (Leaflet)

- Single instance, `preferCanvas: true`. Expand button toggles a `.is-fullscreen` class on the card AND moves the card to `<body>` to escape ancestor stacking contexts. Esc collapses.
- `minZoom: 13`, `zoomSnap: 0.5`, `wheelPxPerZoomLevel: 120` for a slower, smoother feel.
- Tile layer uses `keepBuffer: 8` to reduce zoom-out white tiles. Container background `#1a1a1a` so missing tiles read as a loading state, not a flash.
- `ResizeObserver` on `#icaoMap` debounces `invalidateSize()` so sidebar/ATIS-card-appears events don't break tile layout.
- **Aircraft markers** (`buildAircraftIcon`): `iconSize: [18, 18]`, `iconAnchor: [9, 9]` — center the lat/lng on the plane SVG so polylines/lines connect cleanly.
- **Aircraft polling:** 15s interval re-fetches `/api/icao/:icao/map`. `renderAircraft(list)` updates existing markers in place via `setLatLng`/`setIcon` (no flicker), creates new ones, removes departed callsigns. `fitBounds` only on initial load.
- **Aircraft tooltip vs draggable tag:** "Show Full Tags" toggle — hover-only Leaflet tooltip vs separate draggable divIcon marker + polyline. For draggable tags, tag follows aircraft via stored `offset = { dlat, dlng }`. User-drag captures new offset. Polyline endpoint = `tagCenterLatLng()` (computes visible centre via element pixel size + map zoom). Recompute on `zoomend` (pixels-per-degree changes).

### Ground layout & stands (OSM Overpass)

- `lib/osm-ground.mjs` fetches `aeroway=runway/taxiway/apron/parking_position/gate` + buildings from Overpass. Disk-cached at `data/ground/<ICAO>.json`. **No expiry** — admin `?refresh=1` query param on `/api/icao/:icao/ground` to force re-fetch.
- `osmToGeoJSON()` widens runway/taxiway centerlines into polygons (default widths 45m/23m).
- **Stand position heuristic** (`pickStandTip`): OSM `parking_position` lines should follow "first node = taxiway, last = nose-wheel". Some airports (KDEN) reverse this. The heuristic picks whichever endpoint has the most other parking_position endpoints clustered within 100m (gates pack tightly along terminals; taxi entries spread out). Falls back to building proximity, then OSM convention. **Existing caches under `data/ground/` were generated with old logic — delete the file (or use `?refresh=1`) for the heuristic to apply to a given airport.**
- Stand occupancy (`detectStandOccupancy`): point-in-polygon match wins, otherwise nearest-stand within 70m. Aircraft must have `groundspeed <= 3 kt` (genuinely stopped). Polled every 60s client-side.
- **Stand layer toggle reapplies cached occupancy:** removing the layer destroys marker DOM; re-adding recreates from the divIcon HTML, so the `.stand-occupied` red class is lost. `applyStandOccupancy()` reapplies from `window._icaoLastOccupancy` whenever the layer is shown.

### External data sources

| Source | URL | Used for |
|---|---|---|
| VATSIM datafeed | `https://data.vatsim.net/v3/vatsim-data.json` | pilots, controllers, atis (15s real cadence) |
| FAA D-ATIS | `https://atis.info/api/<ICAO>` | US-only, returns array with `type` field (dep/arr/combined). Per-entry: `code` (letter), `datis` (text). Only called when `isUsIcao(icao)`. |
| METAR | `aviationweather.gov/api/data/metar`, falling back to `avwx.rest/api/metar/...` | Server iterates outward by radius (1.5°/5°/15°/45°/180° global) up to 80 candidates so even remote airports always find a station. Surface a `proxy: { icao, distKm }` in the response when nearest-station fallback was used. |
| OSM Overpass | rotated through 4 endpoints with backoff | Ground layout. 60s timeout, 6 retries with exponential backoff. |

### Controller list logic

- `isCoveringCtr(callsign, icao)` = US/UK/India/SouthAm CTR + `isCoveringUsApp` (TRACON coverage) + generic ICAO CTR fallback. `isAirportController` matches `<airport-prefix>_*_<role>` for `ATIS|DEL|GND|TWR|APP|DEP`.
- `US_APP_COVERAGE_BY_ICAO` maps consolidated TRACONs to airports — both the FAA identifier and the friendly VATSIM callsign should be listed (e.g. `KEWR: ['NY', 'N90']`). NY-area satellites (TEB/HPN/ISP/SWF/FRG/CDW/MMU/FOK) are included for NY APP.
- `/api/icao/:icao/controllers` returns merged + sorted by position rank: **FSS → CTR → APP/TMA/RDR → DEP → TWR → GND → RMP → DEL/CLD**. ATIS callsigns are intentionally excluded (rendered in dedicated ATIS card).
- Position chips on the client (`atcPosType()`) are color-coded with type-specific Lucide-style SVG icons, fixed `width: 72px` so callsigns align across rows.

## VATCAN bookings integration

Controller-facing slot bookings are pushed live to the VATCAN bookings plugin via their HTTP API. Pilots book on planning.worldflight.center; every change auto-pushes to VATCAN so controllers see the updated list within the plugin's 3–5 min poll.

**Files:**
- `lib/vatcan-bookings.mjs` — API client (`vatcanCreateEvent`, `vatcanPushBookings`, debounce queue, last-result tracking).
- `seed-vatcan-events.mjs` — one-time script: creates a VATCAN event per WF schedule row, stores returned `event_id` on `WfScheduleRow.vatcanEventId`.
- Hooks in `index.js` (search `vatcanPushForSlotKey`) on all 9 booking mutation sites: book, cancel, team-cancel, team-update, admin nuke-callsign, admin remove, auto-team assign, auto-affiliate assign, single-shift book.
- 60 s safety sweep re-pushes any sector whose last push wasn't a clean OK.

**Env vars (in `.env`, `.env.dev`, `.env.prod.bak` so they survive mode switches):**
- `VATCAN_BOOKINGS_API_KEY` — required. Per-user; only authorises events your CID owns/manages.
- `VATCAN_BOOKINGS_API_URL` — `https://bookings.vlhtesting.com` (demo, default) or `https://bookings.vatcan.ca` (prod).
- `VATCAN_BOOKINGS_DISABLED=true` — kill switch; disables all pushes without removing the key.
- `VATCAN_BOOKINGS_OWNER_CID` — defaults to 1303570 (Fraser). Override only if seeding under another owner.

**Switching demo → prod:**
1. Edit `.env` (and `.env.prod.bak`): set `VATCAN_BOOKINGS_API_URL=https://bookings.vatcan.ca`.
2. Wipe the demo event ids so the seeder rebuilds against prod:
   ```
   UPDATE "WfScheduleRow" SET "vatcanEventId" = NULL WHERE "eventId" = <active>;
   ```
   (Run on whichever DB you're using — dev SQLite or prod Postgres.)
3. Restart `npm run dev`.
4. `node seed-vatcan-events.mjs` (dry-run) → review → `node seed-vatcan-events.mjs --push` to create the events on prod VATCAN.
5. Smoke-test by booking one slot and confirming it lands on `bookings.vatcan.ca`.

**Switching prod → demo** is the same flow in reverse — just point the URL at `bookings.vlhtesting.com`.

**Event date semantics:** Seeder sets each event's `event_date` to `dep_time_utc − 60 min` (start of the ±60 min departure window) so the event is "open" from the moment the booking window begins, not just at scheduled dep.

**Admin endpoints:**
- `GET /admin/api/vatcan/status` — per-sector booking count + last push result + ok/fail.
- `POST /admin/api/vatcan/push/:wf` — manual re-push for one sector.

**Shape of the payload** matches the existing public endpoint `/api/slots/<wf>.json` exactly — `[{cid, slot:"HHMM"}, ...]`. The slot string is the TOBT minute without colon. VATCAN replaces the full list on every push (no diffing), so always send all bookings for the sector.

## Common gotchas

- Map padding for `fitBounds` is in **pixels**, not a percentage. For routes that span widely on one axis but not the other, use asymmetric padding (`[20, 50]`) and pick which axis gets more padding based on `spanLat > spanLon`.
- Leaflet doesn't auto-recompute its size when its container changes via CSS (e.g. ATIS card appears, sidebar toggles). Use a `ResizeObserver` on the map container that calls `map.invalidateSize()`.
- The `.modal-card input` global rules force `text-transform: uppercase` and `text-align: center` for the callsign/ICAO modal. Any new modal that wants normal input should scope its own overrides under a unique modal id.
- Inline arrow characters in `index.js` template literals are stored as `←` / `→` / `—` escape sequences. Multi-line `Edit` operations may need to use the literal escape sequence, not the rendered character — Python `replace` via Bash is a reliable fallback.
- US ICAOs (KLAX, KJFK, …) drop the leading `K` for *display only* on the airport portal heading; URLs and DB lookups still use the full 4-letter code.
- **Bootstrap loading-screen labels are PUBLIC.** `setBootstrapStatus(step, label)` text is shown to anyone hitting the server during startup. Never include WF airport ICAOs — that leaks the route before release. Use the sector number (e.g. "WF2601") instead.
- **Changes to `lib/*.mjs` need a full server restart** (Ctrl+C and `npm run dev`). Nodemon doesn't reliably pick up `.mjs` changes inside `lib/` on Windows. Cache regeneration won't use new code unless the server is restarted FIRST.
- **`AirportScenery.submittedBy` is a String column** but `req.session.user.data.cid` is an Int — wrap with `String(...)` before insert. Existing rows mix names and CIDs; ownership checks should match against both.
- **`airport.elev` may be null** in the DB. Aircraft filters that subtract `elev` from `pilot.altitude` would treat null as 0 — at high airports like KDEN (5,431 ft) every plane on the ground would be filtered out. Use `groundspeed < 80 kt` as primary "on the ground" signal; AGL is a secondary check that should gracefully skip when `elev == null`.
- **`.icao-tab-panel.active { display: block }` beats** flat panel rules like `.docs-panel { display: flex }`. Use sibling-margin selectors (`.docs-panel > .child + .child { margin-top: 24px }`) for spacing within tab panels.
- **`.action-btn` is `display: inline-flex`** but stretches to full width inside `display: flex; flex-direction: column` parents (like `.card-side-body`). Use `align-self: flex-start` to keep them content-sized.
- **Leaflet `.leaflet-div-icon` defaults** apply `background: #fff; border: 1px solid #666` to any divIcon. Override with `!important` and explicit `width/height: auto !important` if your custom marker isn't sizing/coloring as expected.
- **Globals set on the airport portal**: `window.IS_LOGGED_IN`, `window.ICAO`, `window.IS_WORLD_FLIGHT`, `window.WF_LEG`, `window.VATSIM_USER`. Inline page script populates them — reliable for client-side checks within the portal context.
- **`adminSheetCache`** is the in-memory cache of `WfScheduleRow`s for the active event. Each row: `{ number: 'WF2601', from: 'KDEN', to: 'EGLL', dateUtc, depTimeUtc, arrTimeUtc, blockTime, atcRoute, ... }`. Used heavily for WF-route checks across the app.
- **`sync-prod.mjs` deliberately skips `PageVisibility`** — visibility flags are per-environment so toggling in dev doesn't depend on prod state.

## Tools the user values

- **Prisma db push** for schema changes (no formal migrations workflow set up).
- **`pg` directly** in scripts for one-shot data pushes/pulls to/from prod, with `--push` flag gating destructive runs and `INSERT … ON CONFLICT DO NOTHING` for idempotency.
- **Lucide-style line SVG icons** throughout the UI (sidebar, dashboard cards, admin panel cards). When adding a new icon, match this style (`fill: none; stroke: currentColor; stroke-width: 1.8/2`).
- **Per-type CSS variables** like `--card-stripe`, `--pos-color` on container elements so child selectors can paint per-instance without proliferating classes. See `.atc-pos { background: color-mix(in srgb, var(--pos-color) 15%, transparent); ... }`.
