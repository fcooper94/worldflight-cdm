// --- Session cache helpers ---
function wfCacheKey(eventId, builtAt, qs, atcRoutes) {
  return `wfWorldMap:v7:${eventId}:${builtAt}:${atcRoutes ? 'r1' : 'r0'}:${qs || 'default'}`;
}

function getCachedMapData(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setCachedMapData(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
}

function getSidebarOffset() {
  const body = document.body;

  // Match your actual sidebar widths
  if (body.classList.contains('sidebar-collapsed')) {
    return 72; // collapsed width (px)
  }
  return 260; // expanded width (px)
}


document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('wfWorldMap');
  if (!el || typeof L === 'undefined') return;

  if (window.__WF_MAP_INITIALIZED__) return;
  window.__WF_MAP_INITIALIZED__ = true;

  /* --------------------------------------------------
     MAP: wrapping tiles, no bounds lock
  -------------------------------------------------- */
  const map = L.map(el, {
    zoomControl: true,
    worldCopyJump: false,
    minZoom: 2,
    maxZoom: 19
  });

  // CartoDB via the shared helper — no auth, theme-aware (swaps dark/light
  // when the footer toggle changes data-theme), matches every other map page.
  // Previously used Stadia Maps directly which 401'd without an API key.
  const baseLayer = wfAddTileLayer(map, { maxZoom: 19, noWrap: false });
  map._wfBaseTileLayer = baseLayer;

  map.setView([20, 10], 2);
  requestAnimationFrame(() => map.invalidateSize(true));

  /* --------------------------------------------------
     Direction of travel key (Leaflet control)
  -------------------------------------------------- */
  const DirectionControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function(map) {
      const div = L.DomUtil.create('div', 'wf-direction-arrow');
      div.style.marginTop = '60px';
      div.style.marginRight = '120px';
      div.innerHTML =
        '<div class="wf-direction-label">WorldFlight Route</div>' +
        '<div class="wf-direction-row">' +
          '<span class="wf-direction-text">Direction of travel</span>' +
          '<svg class="wf-direction-svg" viewBox="0 0 80 18" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<line x1="0" y1="9" x2="64" y2="9" stroke="currentColor" stroke-width="3"/>' +
            '<polygon points="64,1 80,9 64,17" fill="currentColor"/>' +
          '</svg>' +
        '</div>';
      return div;
    }
  });
  map.addControl(new DirectionControl());

  // Hide the direction banner while a popup is open — Leaflet controls
  // always stack above the popup pane, so it would cover the popup.
  map.on('popupopen', () => {
    document.querySelector('.wf-direction-arrow')?.classList.add('wf-direction-hidden');
  });
  map.on('popupclose', () => {
    document.querySelector('.wf-direction-arrow')?.classList.remove('wf-direction-hidden');
  });

  /* --------------------------------------------------
     Layers
  -------------------------------------------------- */
  const atcLayer = L.layerGroup().addTo(map);
  const airportLayer = L.layerGroup().addTo(map);

  let lastData = null;

  /* --------------------------------------------------
     Loading overlay
  -------------------------------------------------- */
  function ensureOverlay(container) {
    if (!container.style.position) container.style.position = 'relative';

    let o = container.querySelector('.wf-map-loading');
    if (!o) {
      o = document.createElement('div');
      o.className = 'wf-map-loading';
      o.innerHTML = `
        <div class="panel">
          <div class="title">Loading ATC routes…</div>
          <div class="msg" id="wfMapLoadingMsg">Requesting data</div>
        </div>`;
      container.appendChild(o);
    }
    return o;
  }

  function formatUtcDatePretty(dateStr) {
    if (!dateStr) return '';

    const d = new Date(`${dateStr}T00:00:00Z`);
    if (isNaN(d)) return dateStr;

    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const dayName = days[d.getUTCDay()];
    const dayNum = d.getUTCDate();
    const monthName = months[d.getUTCMonth()];

    const suffix =
      dayNum % 10 === 1 && dayNum !== 11 ? 'st' :
      dayNum % 10 === 2 && dayNum !== 12 ? 'nd' :
      dayNum % 10 === 3 && dayNum !== 13 ? 'rd' : 'th';

    return `${dayName} ${dayNum}${suffix} ${monthName}`;
  }

  function setOverlay(o, show, msg) {
    o.style.display = show ? 'flex' : 'none';
    const m = o.querySelector('#wfMapLoadingMsg');
    if (m && msg) m.textContent = msg;
  }

  /* --------------------------------------------------
     Airport icon + hover popup
  -------------------------------------------------- */
  function pinIcon(extra) {
    const cls = extra?.isStartEnd ? ' wf-start-end' : '';
    return L.divIcon({
      className: 'wf-airport-label',
      html: `<div class="wf-airport-pin${cls}"></div>`,
      iconSize: [1, 1]
    });
  }

  function tagIcon(label, extra) {
    const cls = extra?.isStartEnd ? ' wf-start-end' : '';
    const badge = extra?.badge ? `<div class="wf-airport-badge">${extra.badge}</div>` : '';
    return L.divIcon({
      className: 'wf-airport-tag',
      html: `<div class="wf-airport-text${cls}">${label}${badge}</div>`,
      iconAnchor: [0, 0]
    });
  }

  function tagCenterLL(map, tagMarker) {
    const ll = tagMarker.getLatLng();
    const el = tagMarker.getElement();
    if (!el) return ll;
    const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
    if (!w || !h) return ll;
    const pt = map.latLngToContainerPoint(ll);
    return map.containerPointToLatLng([pt.x + w / 2, pt.y + h / 2]);
  }

  const ARROW_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

  function popupRowHtml(kind, leg, windowStr, icao) {
    const dir = kind === 'Arrival' ? 'inbound' : 'outbound';
    return `
      <a class="wf-airport-section ${dir}" href="/sector/${leg.wf}/${leg.from}/${leg.to}">
        <div class="wf-airport-row-head">
          <span class="wf-airport-dot ${dir}"></span>
          <span class="wf-airport-row-kind">${kind}</span>
        </div>
        <span class="wf-airport-leg"><span class="wf-airport-leg-wf">${leg.wf}</span>  ${leg.from} \u2192 ${leg.to}</span>
        <div class="wf-airport-times">
          <span class="wf-time-utc">${formatUtcDatePretty(leg.dateIso)} \u00b7 ${kind} window <strong>${windowStr}</strong> UTC</span>
          ${leg.localWindow ? `<span class="wf-time-local">${leg.localWindow} local (${leg.localZone || '?'})</span>` : ''}
        </div>
        ${leg.atcRoute ? `<span class="wf-airport-route">${leg.atcRoute}</span>` : ''}
        ${leg.atcRoute2 ? `<span class="wf-airport-route" style="opacity:0.7;font-size:10px;">Secondary: ${leg.atcRoute2}</span>` : ''}
        <span class="wf-airport-portal-hint">View ${leg.wf} sector details ${ARROW_SVG}</span>
      </a>
    `;
  }

  function airportPopupHtml(icao, a) {
  const codes = a.iata ? `${icao} / ${a.iata}` : icao;
  return `
    <div class="wf-airport-popup">
      <div class="wf-airport-popup-header">
        <div class="wf-airport-popup-name">${a.name || icao}</div>
        <div class="wf-airport-popup-codes">${codes}</div>
      </div>
      <div class="wf-airport-popup-body">
        ${[
          a.inbound && { kind: 'Arrival', leg: a.inbound, win: a.inbound.arrWindow },
          a.outbound && { kind: 'Departure', leg: a.outbound, win: a.outbound.depWindow }
        ]
          .filter(Boolean)
          // Chronological: usually Arrival then Departure, but e.g. Sydney
          // departs 31 Oct and arrives back 7 Nov.
          .sort((x, y) =>
            `${x.leg.dateIso || ''} ${x.win}`.localeCompare(`${y.leg.dateIso || ''} ${y.win}`))
          .map(r => popupRowHtml(r.kind, r.leg, r.win, icao))
          .join('')}
      </div>
    </div>
  `;
}


  /* --------------------------------------------------
     Utilities
  -------------------------------------------------- */

  /**
   * Unwrap the entire route so longitudes flow continuously.
   * The WF route goes westward from Sydney (151E) around the world
   * and returns to Sydney. By letting lon go below -180 (or above 180)
   * we get a single continuous path — Australia appears on both edges.
   *
   * Strategy: walk the wfPath in order; for each airport, pick the
   * longitude copy closest to the previous airport. Same for polyline
   * waypoints within each leg.
   */
  function unwrapRoute(data) {
    const airports = data.airports || {};
    const wfPath = data.wfPath || [];
    const polylines = data.atcPolylines || [];

    if (!wfPath.length) return { airportPositions: {}, polylines: [] };

    // Build continuous airport longitude chain
    const airportPositions = {}; // icao -> { lat, lon } (unwrapped)
    let prevLon = null;

    for (const icao of wfPath) {
      const a = airports[icao];
      if (!a) continue;

      let lon = a.lon;
      if (prevLon !== null) {
        // Pick the copy of lon closest to prevLon
        while (lon - prevLon > 180) lon -= 360;
        while (lon - prevLon < -180) lon += 360;
      }

      // Only set the position the first time we see the airport in the path,
      // UNLESS this is a later visit (like Sydney appearing at start AND end).
      // For the first occurrence, store it. For subsequent occurrences in the
      // path, we need separate positions — so track by path index.
      airportPositions[icao] = { lat: a.lat, lon };
      prevLon = lon;
    }

    // For airports that appear at both start and end (like YSSY),
    // we need TWO positions. Track the final one separately.
    const endPositions = {};
    if (wfPath.length > 1 && wfPath[0] === wfPath[wfPath.length - 1]) {
      const icao = wfPath[wfPath.length - 1];
      const a = airports[icao];
      if (a) {
        let lon = a.lon;
        // Use the second-to-last airport's lon as anchor
        const prev = wfPath[wfPath.length - 2];
        const prevPos = airportPositions[prev];
        if (prevPos) {
          while (lon - prevPos.lon > 180) lon -= 360;
          while (lon - prevPos.lon < -180) lon += 360;
        }
        endPositions[icao] = { lat: a.lat, lon };
      }
    }

    // Unwrap polyline points: for each leg, anchor the start to the
    // departure airport's unwrapped lon, then flow continuously
    const unwrappedPolylines = polylines.map((leg, legIdx) => {
      const depPos = airportPositions[leg.from];
      const pts = (leg.points || [])
        .filter(p => p?.lat != null && p?.lon != null)
        .map(p => ({ lat: Number(p.lat), lon: Number(p.lon) }));

      if (pts.length === 0) return { ...leg, unwrappedPoints: [] };

      // Anchor first point to departure airport
      let anchorLon = depPos ? depPos.lon : pts[0].lon;
      const unwrapped = [];

      for (let i = 0; i < pts.length; i++) {
        let lon = pts[i].lon;
        const ref = i === 0 ? anchorLon : unwrapped[i - 1][1];
        while (lon - ref > 180) lon -= 360;
        while (lon - ref < -180) lon += 360;
        unwrapped.push([pts[i].lat, lon]);
      }

      return { ...leg, unwrappedPoints: unwrapped };
    });

    return { airportPositions, endPositions, polylines: unwrappedPolylines };
  }

  function clearLeafletLayers(targetMap) {
    targetMap.eachLayer(layer => {
      if (layer === targetMap._wfBaseTileLayer) return;
      targetMap.removeLayer(layer);
    });
  }

  /* --------------------------------------------------
     Render (shared for main + modal)
  -------------------------------------------------- */
  function renderData(targetMap, data) {
    if (!data) return;

    const localAtc = L.layerGroup().addTo(targetMap);
    const localAirports = L.layerGroup().addTo(targetMap);

    const { airportPositions, endPositions, polylines } = unwrapRoute(data);
    const airports = data.airports || {};
    const wfPath = data.wfPath || [];
    const bounds = [];

    const routeColor = '#ffffff';

    // World copy offsets: render the route on every visible copy of the map
    const WORLD_OFFSETS = [-720, -360, 0, 360, 720];

    /* ---------- Routes ---------- */
    polylines.forEach((leg) => {
      const basePts = leg.unwrappedPoints || [];
      if (basePts.length < 2) return;

      const popupHtml =
        `<strong style="font-size:13px;">${leg.from} → ${leg.to}</strong><br>
         <div style="margin-top:6px;font-family:JetBrains Mono,monospace;font-size:12px;white-space:pre-wrap;">
           ${(leg.atc_route || '').replace(/</g, '&lt;')}
         </div>
         ${leg.atc_route2 ? `<div style="margin-top:6px;font-size:10px;color:#94a3b8;">Secondary Route</div><div style="font-family:JetBrains Mono,monospace;font-size:11px;white-space:pre-wrap;">${leg.atc_route2.replace(/</g, '&lt;')}</div>` : ''}`;

      WORLD_OFFSETS.forEach(offset => {
        const pts = basePts.map(p => [p[0], p[1] + offset]);

        /* Glow layer underneath */
        L.polyline(pts, {
          color: routeColor,
          weight: 10,
          opacity: 0.12,
          noClip: true,
          interactive: false,
          lineCap: 'round', lineJoin: 'round'
        }).addTo(localAtc);

        /* Main route line */
        const line = L.polyline(pts, {
          color: routeColor,
          weight: 4.5,
          opacity: 1,
          noClip: true,
          lineCap: 'round', lineJoin: 'round'
        }).addTo(localAtc).bindPopup(popupHtml);

        /* Direction arrows */
        if (L.polylineDecorator) {
          L.polylineDecorator(line, {
            patterns: [{
              offset: '50%',
              repeat: 0,
              symbol: L.Symbol.arrowHead({
                pixelSize: 10,
                polygon: false,
                pathOptions: { color: routeColor, weight: 2, opacity: 0.7 }
              })
            }]
          }).addTo(localAtc);
        }
      });
    });

    /* ---------- Airports (on top of routes) ---------- */

    // Collect unique airport positions first for declutter
    const airportList = [];
    const placed = new Set();
    const startIcao = wfPath[0];
    const endIcao = wfPath[wfPath.length - 1];
    const isRoundTrip = startIcao === endIcao;

    wfPath.forEach((icao, idx) => {
      const a = airports[icao];
      if (!a) return;

      const isEnd = idx === wfPath.length - 1 && endPositions[icao];
      const pos = isEnd ? endPositions[icao] : airportPositions[icao];
      if (!pos) return;

      const key = isEnd ? icao + ':end' : icao;
      if (placed.has(key)) return;
      placed.add(key);

      const codes = a.iata ? `${icao} / ${a.iata}` : icao;
      const displayLabel = a.shortName ? `${a.shortName} ${codes}` : codes;
      let extra = null;

      if (idx === 0) {
        extra = isRoundTrip
          ? { isStartEnd: true, badge: 'START / FINISH' }
          : { isStartEnd: true, badge: 'START' };
      }
      if (isEnd) {
        // Round trip: start marker already covers this airport (and is
        // duplicated across world copies) — skip the second tag, but keep
        // the unwrapped end position in the fit bounds.
        if (isRoundTrip) {
          bounds.push([pos.lat, pos.lon]);
          return;
        }
        extra = { isStartEnd: true, badge: 'FINISH' };
      }

      airportList.push({ icao, pos, a, displayLabel, extra });
      bounds.push([pos.lat, pos.lon]);
    });

    // Declutter: choose label offsets that minimise overlap.
    const DIRECTIONS = [
      { x:  1, y:  0 },   // right
      { x: -1, y:  0 },   // left
      { x:  0, y: -1 },   // top
      { x:  0, y:  1 },   // bottom
      { x:  1, y: -1 },   // top-right
      { x: -1, y: -1 },   // top-left
      { x:  1, y:  1 },   // bottom-right
      { x: -1, y:  1 },   // bottom-left
    ];
    const LH = 20, PIN_GAP = 14, PAD = 6;
    function estimateLabelWidth(label) { return label.length * 6.5 + 14; }

    function getPixelPos(lat, lon) {
      return targetMap.latLngToContainerPoint(L.latLng(lat, lon));
    }

    function dirRect(px, dir, lw, gap) {
      const x = dir.x >= 0 ? px.x + gap : px.x - lw - gap;
      const y = dir.y < 0 ? px.y - LH - gap : dir.y > 0 ? px.y + gap : px.y - LH / 2;
      return { x: x - PAD, y: y - PAD, w: lw + PAD * 2, h: LH + PAD * 2 };
    }

    function rectsOverlap(a, b) {
      return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
    }

    // Place pin markers + draggable label tags with connector lines.
    // Layout (label text, offsets, leaders) is applied by relayout().
    const tagStates = []; // { idx, ap, pinMarker, tagMarker, line, offsetPx, dragged, label, compact }

    function tagLLFromPx(pinLL, offsetPx) {
      const pt = targetMap.latLngToContainerPoint(L.latLng(pinLL[0] ?? pinLL.lat, pinLL[1] ?? pinLL.lng));
      return targetMap.containerPointToLatLng([pt.x + offsetPx.dx, pt.y + offsetPx.dy]);
    }

    // The translucent topbar / site banner overlay the top of the map, so
    // autoPan must treat that strip as off-screen or popups open cut off.
    function topOverlapPx() {
      const mapTop = targetMap.getContainer().getBoundingClientRect().top;
      let overlap = 0;
      document.querySelectorAll('header.topbar, .site-banner').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > mapTop) overlap = Math.max(overlap, r.bottom - mapTop);
      });
      return overlap;
    }

    airportList.forEach((ap, i) => {
      WORLD_OFFSETS.forEach(wo => {
        const pinLL = [ap.pos.lat, ap.pos.lon + wo];

        // Pin marker (non-draggable, holds popup)
        const pinMarker = L.marker(pinLL, { icon: pinIcon(ap.extra), zIndexOffset: 1000 })
          .addTo(localAirports)
          .bindPopup(
            airportPopupHtml(ap.icao, ap.a),
            {
              closeButton: true, autoPan: true, maxWidth: 320,
              autoPanPaddingTopLeft: L.point(12, topOverlapPx() + 12),
              autoPanPaddingBottomRight: L.point(12, 12),
              className: 'wf-airport-leaflet-popup'
            }
          );

        // Connector line (hidden at world zoom)
        const line = L.polyline([pinLL, pinLL], {
          color: 'rgba(255,255,255,0.55)',
          weight: 2,
          dashArray: '4 6',
          interactive: false
        }).addTo(localAirports);

        // Draggable label tag
        const tagMarker = L.marker(pinLL, {
          icon: tagIcon(ap.displayLabel, ap.extra),
          draggable: true,
          zIndexOffset: 2000,
          autoPan: false
        }).addTo(localAirports);

        // Click tag to open pin popup
        tagMarker.on('click', () => pinMarker.openPopup());

        // Drag handler — capture pixel offset, pin it against re-declutter
        const state = {
          idx: i, ap, pinMarker, tagMarker, line,
          offsetPx: { dx: 0, dy: 0 }, dragged: false,
          label: ap.displayLabel, compact: null
        };
        tagMarker.on('drag', () => {
          const pPt = targetMap.latLngToContainerPoint(pinMarker.getLatLng());
          const tPt = targetMap.latLngToContainerPoint(tagMarker.getLatLng());
          state.offsetPx = { dx: tPt.x - pPt.x, dy: tPt.y - pPt.y };
          state.dragged = true;
          line.setLatLngs([pinMarker.getLatLng(), tagCenterLL(targetMap, tagMarker)]);
        });

        tagStates.push(state);
      });
    });

    /* ----- Zoom-aware label layout -----
       World view (zoom <= COMPACT_MAX_ZOOM): ICAO-only chips tight to the
       pin, no leader lines. Zoomed in: full "Name ICAO" tags with dashed
       leaders. Declutter re-runs at the current zoom on every zoomend;
       user-dragged tags keep their position (within the same mode) and act
       as obstacles for the rest. */
    const COMPACT_MAX_ZOOM = 3;

    function relayout() {
      const compact = targetMap.getZoom() <= COMPACT_MAX_ZOOM;
      const gap = compact ? 7 : PIN_GAP;

      const labels = airportList.map(ap =>
        compact
          ? (ap.a.iata ? `${ap.icao} / ${ap.a.iata}` : ap.icao)
          : ap.displayLabel);
      const widths = labels.map(estimateLabelWidth);
      const pxs = airportList.map(ap => getPixelPos(ap.pos.lat, ap.pos.lon));

      // Mode switch invalidates manual drags (offsets sized for other labels)
      tagStates.forEach(s => { if (s.compact !== compact) s.dragged = false; });

      const draggedOffsets = new Map(); // airport idx -> offsetPx
      tagStates.forEach(s => { if (s.dragged) draggedOffsets.set(s.idx, s.offsetPx); });

      const placedRects = [];
      draggedOffsets.forEach((off, idx) => {
        placedRects.push({
          x: pxs[idx].x + off.dx - PAD, y: pxs[idx].y + off.dy - PAD,
          w: widths[idx] + PAD * 2, h: LH + PAD * 2
        });
      });

      const offsets = airportList.map((ap, i) => {
        if (draggedOffsets.has(i)) return draggedOffsets.get(i);

        let bestDir = DIRECTIONS[0];
        let bestOverlaps = Infinity;
        for (const dir of DIRECTIONS) {
          const rect = dirRect(pxs[i], dir, widths[i], gap);
          let overlaps = 0;
          for (const pr of placedRects) {
            if (rectsOverlap(rect, pr)) overlaps++;
          }
          if (overlaps < bestOverlaps) {
            bestOverlaps = overlaps;
            bestDir = dir;
            if (overlaps === 0) break;
          }
        }
        const rect = dirRect(pxs[i], bestDir, widths[i], gap);
        placedRects.push(rect);
        return { dx: rect.x + PAD - pxs[i].x, dy: rect.y + PAD - pxs[i].y };
      });

      tagStates.forEach(s => {
        s.compact = compact;
        if (!s.dragged) s.offsetPx = { ...offsets[s.idx] };

        const label = labels[s.idx];
        if (s.label !== label) {
          s.label = label;
          s.tagMarker.setIcon(tagIcon(label, s.ap.extra));
        }

        const pinLL = s.pinMarker.getLatLng();
        s.tagMarker.setLatLng(tagLLFromPx(pinLL, s.offsetPx));

        s.line.setLatLngs([pinLL, tagCenterLL(targetMap, s.tagMarker)]);
      });
    }

    targetMap.on('zoomend', relayout);

    if (bounds.length) {
      const sidebarWidth = document.body.classList.contains('sidebar-collapsed')
        ? 72
        : 220;

      targetMap.fitBounds(bounds, {
        paddingTopLeft: [sidebarWidth + 24, 24],
        paddingBottomRight: [24, 24],
        maxZoom: 4,
        animate: false
      });

      requestAnimationFrame(() => {
        targetMap.invalidateSize(true);
        relayout();
      });
    } else {
      relayout();
    }
  }

  window.addEventListener('sidebar:toggle', () => {
    if (!map || !lastData) return;

    // Re-render to recalculate bounds with new sidebar width
    clearLeafletLayers(map);
    renderData(map, lastData);
  });

  /* --------------------------------------------------
     Load main map
  -------------------------------------------------- */
  async function load() {
    const overlay = ensureOverlay(el);
    setOverlay(overlay, true, 'Requesting route data…');

    const qs = new URLSearchParams(window.WF_MAP_QUERY || {}).toString();

    // Lightweight version check — only fetch full data if stale
    try {
      const vRes = await fetch('/api/wf/world-map/version' + (qs ? `?${qs}` : ''), { credentials: 'same-origin' });
      if (vRes.ok) {
        const { builtAt, eventId, atcRoutes } = await vRes.json();
        if (builtAt && eventId) {
          const key = wfCacheKey(eventId, builtAt, qs, atcRoutes);
          const cached = getCachedMapData(key);
          if (cached) {
            lastData = cached;
            airportLayer.clearLayers();
            atcLayer.clearLayers();
            renderData(map, cached);
            setOverlay(overlay, false);
            return;
          }
        }
      }
    } catch {}

    // Full fetch (cache miss or version check failed)
    const res = await fetch(
      '/api/wf/world-map' + (qs ? `?${qs}` : ''),
      { credentials: 'same-origin' }
    );

    if (!res.ok) {
      setOverlay(overlay, true, `Failed (${res.status})`);
      return;
    }

    const payload = await res.json();
    const { builtAt, eventId, atcRoutes } = payload;
    if (builtAt && eventId) {
      setCachedMapData(wfCacheKey(eventId, builtAt, qs, atcRoutes), payload);
    }

    lastData = payload;

    airportLayer.clearLayers();
    atcLayer.clearLayers();

    renderData(map, payload);
    setOverlay(overlay, false);
  }

  load().catch(console.error);

  /* --------------------------------------------------
     Modal handling (unchanged behavior)
  -------------------------------------------------- */
  let modalMap = null;

  function ensureWfModal() {
    let modal = document.getElementById('wfMapModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'wfMapModal';
    modal.className = 'map-modal hidden';
    modal.innerHTML = `
      <div class="map-modal-backdrop" data-wf-close="1"></div>
      <div class="map-modal-panel">
        <div class="map-modal-header">
          <span>WF Route Map</span>
          <button type="button" data-wf-close="1">✕</button>
        </div>
        <div class="icao-map">
          <div id="wfMapModalMap" style="width:100%;height:100%"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  function openWfModal() {
    const modal = ensureWfModal();
    modal.classList.remove('hidden');

    setTimeout(() => {
      if (!modalMap) {
        modalMap = L.map('wfMapModalMap', { zoomControl: true, worldCopyJump: false });
        modalMap._wfBaseTileLayer = L.tileLayer(tileUrl, { maxZoom: 19, noWrap: false }).addTo(modalMap);
      }

      clearLeafletLayers(modalMap);
      renderData(modalMap, lastData);
      modalMap.invalidateSize(true);
    }, 50);
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-wf-close="1"]')) {
      document.getElementById('wfMapModal')?.classList.add('hidden');
    }
    if (e.target.closest('[data-wf-expand="1"]')) openWfModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('wfMapModal')?.classList.add('hidden');
    }
  });
});
