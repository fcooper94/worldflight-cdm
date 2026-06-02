// --- Session cache helpers ---
function wfCacheKey(eventId, builtAt, qs) {
  return `wfWorldMap:v6:${eventId}:${builtAt}:${qs || 'default'}`;
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
  function airportIcon(label, placement, extra) {
    // placement: 'right' (default), 'left', 'top', 'bottom',
    //            'top-right', 'top-left', 'bottom-right', 'bottom-left'
    const p = placement || 'right';
    const extraClass = extra?.isStartEnd ? ' wf-start-end' : '';
    const badge = extra?.badge ? `<div class="wf-airport-badge">${extra.badge}</div>` : '';
    return L.divIcon({
      className: 'wf-airport-label',
      html: `
        <div class="wf-airport-pin${extraClass}"></div>
        <div class="wf-airport-text wf-label-${p}${extraClass}">${label}${badge}</div>`,
      iconSize: [1, 1]
    });
  }

  function airportPopupHtml(icao, a) {
  return `
    <div class="wf-airport-popup">
      <div class="wf-airport-popup-header">
        ${icao}
      </div>

      ${a.inbound ? `
        <a class="wf-airport-section inbound" href="/sector/${a.inbound.wf}/${a.inbound.from}/${a.inbound.to}">
          <div class="wf-airport-section-title">Inbound</div>
          <div class="wf-airport-leg">
            ${a.inbound.wf} ${a.inbound.from} → ${a.inbound.to}
          </div>
          <div class="wf-airport-meta">
            <span>${formatUtcDatePretty(a.inbound.dateIso)}</span>
            <span class="dot">•</span>
            <span>Arr Window ${a.inbound.arrWindow}</span>
          </div>
        </a>
      ` : ''}

      ${a.outbound ? `
        <a class="wf-airport-section outbound" href="/sector/${a.outbound.wf}/${a.outbound.from}/${a.outbound.to}">
          <div class="wf-airport-section-title">Outbound</div>
          <div class="wf-airport-leg">
            ${a.outbound.wf} ${a.outbound.from} → ${a.outbound.to}
          </div>
          <div class="wf-airport-meta">
            <span>${formatUtcDatePretty(a.outbound.dateIso)}</span>
            <span class="dot">•</span>
            <span>Dep Window ${a.outbound.depWindow}</span>
          </div>
        </a>
      ` : ''}
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
         </div>`;

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

      const displayLabel = a.shortName ? `${a.shortName} ${icao}` : icao;
      let extra = null;

      if (idx === 0) {
        extra = { isStartEnd: true, badge: 'START \u2022 31 Oct' };
      }
      if (isEnd) {
        extra = { isStartEnd: true, badge: 'FINISH \u2022 7 Nov' };
      }

      airportList.push({ icao, pos, a, displayLabel, extra });
      bounds.push([pos.lat, pos.lon]);
    });

    // Declutter: decide label placement for each airport to minimise overlaps.
    // Estimate label bounding boxes in pixel space, try 8 directions per label.
    const PLACEMENTS = ['right', 'left', 'top', 'bottom', 'top-right', 'top-left', 'bottom-right', 'bottom-left'];
    // Approximate label size in pixels
    const LW = 95, LH = 18, PIN = 8;
    // Offset from pin centre for each placement
    const OFFSETS = {
      'right':        { x: PIN,      y: -LH / 2 },
      'left':         { x: -LW - PIN, y: -LH / 2 },
      'top':          { x: -LW / 2,  y: -LH - PIN },
      'bottom':       { x: -LW / 2,  y: PIN },
      'top-right':    { x: PIN,      y: -LH - PIN },
      'top-left':     { x: -LW - PIN, y: -LH - PIN },
      'bottom-right': { x: PIN,      y: PIN },
      'bottom-left':  { x: -LW - PIN, y: PIN },
    };

    function getPixelPos(lat, lon) {
      return targetMap.latLngToContainerPoint(L.latLng(lat, lon));
    }

    function labelRect(px, placement) {
      const o = OFFSETS[placement];
      return { x: px.x + o.x, y: px.y + o.y, w: LW, h: LH };
    }

    function rectsOverlap(a, b) {
      return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
    }

    // Compute pixel positions and choose placements
    const pixelPositions = airportList.map(ap => getPixelPos(ap.pos.lat, ap.pos.lon));
    const chosenPlacements = [];
    const placedRects = [];

    airportList.forEach((ap, i) => {
      const px = pixelPositions[i];
      let best = 'right';
      let bestOverlaps = Infinity;

      for (const p of PLACEMENTS) {
        const rect = labelRect(px, p);
        let overlaps = 0;
        for (const pr of placedRects) {
          if (rectsOverlap(rect, pr)) overlaps++;
        }
        if (overlaps < bestOverlaps) {
          bestOverlaps = overlaps;
          best = p;
          if (overlaps === 0) break;
        }
      }

      chosenPlacements.push(best);
      placedRects.push(labelRect(px, best));
    });

    // Place markers with chosen label placements
    airportList.forEach((ap, i) => {
      WORLD_OFFSETS.forEach(offset => {
        const ll = [ap.pos.lat, ap.pos.lon + offset];
        L.marker(ll, { icon: airportIcon(ap.displayLabel, chosenPlacements[i], ap.extra) })
          .addTo(localAirports)
          .bindPopup(
            airportPopupHtml(ap.icao, ap.a),
            {
              closeButton: true,
              autoPan: true,
              maxWidth: 320,
              className: 'wf-airport-leaflet-popup'
            }
          );
      });
    });

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
      });
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
        const { builtAt, eventId } = await vRes.json();
        if (builtAt && eventId) {
          const key = wfCacheKey(eventId, builtAt, qs);
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
    const { builtAt, eventId } = payload;
    if (builtAt && eventId) {
      setCachedMapData(wfCacheKey(eventId, builtAt, qs), payload);
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
