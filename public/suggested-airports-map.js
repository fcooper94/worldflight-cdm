document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('suggMap');
  if (!el || typeof L === 'undefined') return;

  if (window.__SUGG_MAP_INITIALIZED__) return;
  window.__SUGG_MAP_INITIALIZED__ = true;

  /* ---- Popularity buckets ---- */
  // Single source of truth for color + size + label text per bucket.
  const BUCKETS = [
    { min: 1,  max: 1,        color: '#64748b', label: '1 request' },
    { min: 2,  max: 2,        color: '#38bdf8', label: '2 requests' },
    { min: 3,  max: 4,        color: '#4ade80', label: '3–4 requests' },
    { min: 5,  max: 9,        color: '#f59e0b', label: '5–9 requests' },
    { min: 10, max: Infinity, color: '#ef4444', label: '10+ requests' }
  ];
  function bucketFor(n) { return BUCKETS.find(b => n >= b.min && n <= b.max) || BUCKETS[0]; }
  function radiusFor(n) {
    // 1 → 4px, 2 → 5.5px, 10 → ~10px, 100 → ~14px (capped)
    return Math.min(14, 4 + Math.sqrt(Math.max(1, n)) * 1.6);
  }

  /* ---- Map ---- */
  const map = L.map(el, { zoomControl: true, preferCanvas: true });
  wfAddTileLayer(map, { maxZoom: 19 });
  map.setView([20, 0], 3);
  requestAnimationFrame(() => map.invalidateSize(true));

  /* ---- Loading overlay ---- */
  function ensureOverlay(container) {
    if (!container.style.position) container.style.position = 'relative';
    let o = container.querySelector('.wf-map-loading');
    if (!o) {
      o = document.createElement('div');
      o.className = 'wf-map-loading';
      o.innerHTML = `
        <div class="panel">
          <div class="title">Loading suggested airports...</div>
          <div class="msg" id="suggLoadingMsg">Requesting data</div>
        </div>`;
      container.appendChild(o);
    }
    return o;
  }
  function setOverlay(o, show, msg) {
    o.style.display = show ? 'flex' : 'none';
    const m = o.querySelector('#suggLoadingMsg');
    if (m && msg) m.textContent = msg;
  }

  /* ---- Airport label icon (only when zoomed in) ---- */
  function airportIcon(label) {
    return L.divIcon({
      className: 'wf-airport-label',
      html: `<div class="wf-airport-pin"></div><div class="wf-airport-text">${label}</div>`,
      iconSize: [1, 1]
    });
  }

  /* ---- Info panel (bottom-right) ---- */
  const infoPanel = document.createElement('div');
  infoPanel.className = 'prev-dest-info-panel';
  infoPanel.style.display = 'none';
  el.appendChild(infoPanel);

  function showInfoPanel(icao, data) {
    const b = bucketFor(data.count);
    infoPanel.innerHTML = `
      <button class="prev-dest-info-close">&times;</button>
      <div class="wf-airport-popup-header">${icao}${data.name ? ' — ' + data.name : ''}</div>
      <div class="wf-airport-section">
        <div class="wf-airport-section-title" style="display:flex;align-items:center;gap:8px;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${b.color};"></span>
          ${data.count} suggestion${data.count !== 1 ? 's' : ''}
        </div>
        ${data.staffCount ? `<div class="wf-airport-leg">${data.staffCount} from staff / directors</div>` : ''}
      </div>
      <div class="wf-airport-popup-actions">
        <button class="wf-airport-action-btn" data-icao="${icao}">View Airport Details</button>
      </div>
    `;
    infoPanel.style.display = 'block';
  }
  function hideInfoPanel() { infoPanel.style.display = 'none'; }

  infoPanel.addEventListener('click', e => {
    if (e.target.closest('.prev-dest-info-close')) { hideInfoPanel(); return; }
    const btn = e.target.closest('.wf-airport-action-btn');
    if (btn) window.location.href = `/icao/${btn.getAttribute('data-icao')}`;
  });

  // Reuse the info-panel styles from previous-destinations
  const panelStyle = document.createElement('style');
  panelStyle.textContent = `
    .prev-dest-info-panel {
      position:absolute; bottom:60px; right:120px; z-index:1000;
      width:300px; max-height:60vh; overflow-y:auto;
      border-radius:14px; padding:14px 16px 12px;
      background:var(--panel, rgba(14,22,40,0.92));
      border:1px solid var(--border, rgba(255,255,255,0.08));
      box-shadow:0 16px 40px rgba(0,0,0,0.25);
      pointer-events:auto;
    }
    [data-theme="light"] .prev-dest-info-panel {
      background:rgba(255,255,255,0.96);
      box-shadow:0 16px 40px rgba(0,0,0,0.12);
    }
    .prev-dest-info-close {
      position:absolute; top:8px; right:10px;
      background:none; border:none; color:var(--muted, #94a3b8);
      font-size:20px; cursor:pointer; line-height:1; padding:4px;
    }
    .prev-dest-info-close:hover { color:var(--text, #e2e8f0); }
    @media (max-width:600px) {
      .prev-dest-info-panel { width:calc(100% - 20px); right:10px; bottom:10px; }
    }
  `;
  document.head.appendChild(panelStyle);

  /* ---- Legend (top-right) ---- */
  function injectLegend() {
    const legend = document.createElement('div');
    legend.className = 'sugg-legend';
    legend.innerHTML = `
      <div class="sugg-legend-title">Suggestions</div>
      ${BUCKETS.map(b => `
        <div class="sugg-legend-row">
          <span class="sugg-legend-dot" style="background:${b.color};"></span>
          <span>${b.label}</span>
        </div>
      `).join('')}
    `;
    el.appendChild(legend);

    const st = document.createElement('style');
    st.textContent = `
      .sugg-legend {
        position:absolute; top:24px; right:24px; z-index:500;
        padding:10px 14px; border-radius:10px;
        background:rgba(11,18,32,0.92);
        border:1px solid rgba(56,189,248,0.2);
        backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        font-size:12px; color:#e2e8f0;
        box-shadow:0 8px 24px rgba(0,0,0,0.35);
        pointer-events:auto;
      }
      [data-theme="light"] .sugg-legend {
        background:rgba(255,255,255,0.95); color:#0f172a;
        border-color:rgba(56,189,248,0.3);
      }
      .sugg-legend-title { font-weight:700; margin-bottom:6px; letter-spacing:0.04em; }
      .sugg-legend-row { display:flex; align-items:center; gap:8px; padding:2px 0; }
      .sugg-legend-dot { display:inline-block; width:10px; height:10px; border-radius:50%; }
      @media (max-width:720px) { .sugg-legend { top:auto; bottom:120px; right:12px; } }
    `;
    document.head.appendChild(st);
  }

  /* ---- Search box (centred top) ---- */
  function injectSearchBox(mapRef) {
    const mapContainer = mapRef.getContainer();
    const wrap = L.DomUtil.create('div', 'wf-search-box', mapContainer);
    wrap.innerHTML = `
      <div class="wf-search-inner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#94a3b8;flex-shrink:0;">
          <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="search" class="wf-search-input" placeholder="Search ICAO or airport name..." autocomplete="off" spellcheck="false" />
      </div>
      <div class="wf-search-results" role="listbox"></div>
    `;
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.disableScrollPropagation(wrap);
    return wrap;
  }
  function injectSearchStyles() {
    if (document.getElementById('wf-search-styles')) return;
    const st = document.createElement('style');
    st.id = 'wf-search-styles';
    st.textContent = `
      .wf-search-box {
        position:absolute; top:72px; left:50%; transform:translateX(-50%);
        z-index:500; width:min(320px, calc(100% - 60px));
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        pointer-events:auto;
      }
      .wf-search-inner {
        display:flex; align-items:center; gap:8px;
        background:rgba(11,18,32,0.92); border:1px solid rgba(56,189,248,0.25);
        border-radius:10px; padding:8px 12px;
        box-shadow:0 8px 24px rgba(0,0,0,0.4);
        backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
      }
      .wf-search-inner:focus-within { border-color:#38bdf8; box-shadow:0 8px 24px rgba(0,0,0,0.4), 0 0 0 2px rgba(56,189,248,0.15); }
      .wf-search-input { flex:1; background:transparent; border:0; color:#e2e8f0; font-size:13px; font-family:inherit; outline:none; padding:0; }
      .wf-search-input::placeholder { color:#64748b; }
      .wf-search-results {
        margin-top:6px; max-height:320px; overflow-y:auto;
        background:rgba(11,18,32,0.96); border:1px solid rgba(56,189,248,0.2);
        border-radius:10px; display:none;
        box-shadow:0 12px 32px rgba(0,0,0,0.5);
        backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
      }
      .wf-search-results.open { display:block; }
      .wf-search-item { display:flex; align-items:center; gap:10px; padding:9px 12px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.04); }
      .wf-search-item:last-child { border-bottom:0; }
      .wf-search-item:hover, .wf-search-item.active { background:rgba(56,189,248,0.1); }
      .wf-search-icao { font-family:monospace; font-weight:700; color:#38bdf8; font-size:13px; min-width:46px; }
      .wf-search-name { flex:1; color:#e2e8f0; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wf-search-meta { font-size:11px; color:#64748b; white-space:nowrap; }
      .wf-search-empty { padding:12px; font-size:12px; color:#64748b; text-align:center; }
    `;
    document.head.appendChild(st);
  }

  window.addEventListener('sidebar:toggle', () => {
    requestAnimationFrame(() => map.invalidateSize(true));
  });

  /* ---- Load data ---- */
  async function load() {
    const overlay = ensureOverlay(el);
    setOverlay(overlay, true, 'Requesting suggestion data...');

    const res = await fetch('/api/admin/suggested-airports-map', { credentials: 'same-origin' });
    if (!res.ok) {
      setOverlay(overlay, true, `Failed (${res.status})`);
      return;
    }
    const payload = await res.json();
    const airports = payload.airports || {};
    const allBounds = [];

    // Sort so high-count circles render on top of low-count ones.
    const airportList = Object.entries(airports)
      .map(([icao, data]) => ({ icao, data, ll: L.latLng(data.lat, data.lon) }))
      .sort((a, b) => a.data.count - b.data.count);

    airportList.forEach(ap => allBounds.push(ap.ll));

    const dotLayer = L.layerGroup().addTo(map);
    const labelLayer = L.layerGroup();
    const LABEL_ZOOM = 5;
    let labelsBuilt = false;
    let labelsShown = false;
    const WORLD_SHIFTS = [-360, 0, 360];

    for (const ap of airportList) {
      const b = bucketFor(ap.data.count);
      const r = radiusFor(ap.data.count);
      WORLD_SHIFTS.forEach(shift => {
        const ll = L.latLng(ap.data.lat, ap.data.lon + shift);
        const m = L.circleMarker(ll, {
          radius: r,
          color: b.color,
          fillColor: b.color,
          fillOpacity: 0.7,
          weight: 1
        })
          .addTo(dotLayer)
          .on('click', () => showInfoPanel(ap.icao, ap.data));
        if (shift === 0) ap.marker = m;
      });
    }

    function buildLabels() {
      if (labelsBuilt) return;
      labelsBuilt = true;
      for (const ap of airportList) {
        WORLD_SHIFTS.forEach(shift => {
          L.marker(L.latLng(ap.data.lat, ap.data.lon + shift), { icon: airportIcon(ap.icao) })
            .on('click', () => showInfoPanel(ap.icao, ap.data))
            .addTo(labelLayer);
        });
      }
    }
    function updateLabels() {
      const zoom = map.getZoom();
      if (zoom >= LABEL_ZOOM && !labelsShown) {
        buildLabels(); map.addLayer(labelLayer); labelsShown = true;
      } else if (zoom < LABEL_ZOOM && labelsShown) {
        map.removeLayer(labelLayer); labelsShown = false;
      }
    }
    map.on('zoomend', updateLabels);

    if (allBounds.length) {
      const sidebarWidth = document.body.classList.contains('sidebar-collapsed') ? 72 : 220;
      map.fitBounds(allBounds, {
        paddingTopLeft: [sidebarWidth + 24, 24],
        paddingBottomRight: [24, 24],
        animate: false
      });
      requestAnimationFrame(() => map.invalidateSize(true));
    }

    updateLabels();
    injectLegend();
    setOverlay(overlay, false);

    /* ---- Search UI ---- */
    injectSearchStyles();
    const searchBox = injectSearchBox(map);
    const searchInput = searchBox.querySelector('.wf-search-input');
    const resultsBox = searchBox.querySelector('.wf-search-results');
    let activeIdx = -1;
    let currentResults = [];

    function render(results, query) {
      currentResults = results;
      activeIdx = -1;
      if (!results.length) {
        const q = (query || '').trim().toUpperCase();
        const msg = q && /^[A-Z0-9]{1,4}$/.test(q)
          ? 'No suggestions for ' + q
          : 'No matching airports';
        resultsBox.innerHTML = '<div class="wf-search-empty">' + msg + '</div>';
        resultsBox.classList.add('open');
        return;
      }
      resultsBox.innerHTML = results.map((r, i) => {
        const name = (r.data.name || '').replace(/"/g, '&quot;');
        const count = r.data.count;
        return '<div class="wf-search-item" data-idx="' + i + '" role="option">' +
          '<span class="wf-search-icao">' + r.icao + '</span>' +
          '<span class="wf-search-name">' + (name || '&mdash;') + '</span>' +
          '<span class="wf-search-meta">' + count + ' suggestion' + (count !== 1 ? 's' : '') + '</span>' +
          '</div>';
      }).join('');
      resultsBox.classList.add('open');
    }
    function hide() { resultsBox.classList.remove('open'); activeIdx = -1; }
    function setActive(idx) {
      const items = resultsBox.querySelectorAll('.wf-search-item');
      items.forEach(it => it.classList.remove('active'));
      if (idx >= 0 && idx < items.length) {
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      }
      activeIdx = idx;
    }
    function select(entry) {
      if (!entry) return;
      hide();
      searchInput.value = '';
      searchInput.blur();
      map.flyTo(entry.ll, Math.max(map.getZoom(), 9), { duration: 0.8 });
      setTimeout(() => {
        updateLabels();
        showInfoPanel(entry.icao, entry.data);
      }, 820);
    }

    // Sort search by count desc so most-requested floats to the top when
    // multiple matches share the same prefix.
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) { hide(); return; }
      const matches = airportList
        .filter(ap => {
          const icao = ap.icao.toLowerCase();
          const name = (ap.data.name || '').toLowerCase();
          return icao.indexOf(q) !== -1 || name.indexOf(q) !== -1;
        })
        .sort((a, b) => b.data.count - a.data.count)
        .slice(0, 12);
      render(matches, q);
    });
    searchInput.addEventListener('keydown', e => {
      if (!resultsBox.classList.contains('open')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, currentResults.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = activeIdx >= 0 ? activeIdx : 0;
        if (currentResults[idx]) select(currentResults[idx]);
      } else if (e.key === 'Escape') { hide(); searchInput.blur(); }
    });
    resultsBox.addEventListener('click', e => {
      const item = e.target.closest('.wf-search-item');
      if (!item) return;
      const idx = Number(item.dataset.idx);
      if (Number.isFinite(idx)) select(currentResults[idx]);
    });
    document.addEventListener('click', e => {
      if (!searchBox.contains(e.target)) hide();
    });
  }

  load().catch(console.error);
});
