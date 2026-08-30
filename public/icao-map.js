/* =========================================================
   ICAO Airport Map
   ========================================================= */

// keepBuffer keeps off-screen tiles in the cache so panning and zoom-out
// expose pre-loaded tiles instead of white squares.
const TILE_OPTS = { maxZoom: 19, keepBuffer: 8 };

// CARTO's raster basemaps need an API key. layout.js publishes it as
// window.WF_CARTO_KEY; build the URL through a function so a page that loads
// this file before the layout script still picks the key up at call time.
function cartoTileUrl(style) {
  const key = window.WF_CARTO_KEY ? '?key=' + encodeURIComponent(window.WF_CARTO_KEY) : '';
  return 'https://{s}.basemaps.cartocdn.com/' + style + '/{z}/{x}/{y}{r}.png' + key;
}

const TILE_LAYERS = {
  dark: {
    get url() { return cartoTileUrl('dark_all'); },
    options: TILE_OPTS
  },
  light: {
    get url() { return cartoTileUrl('light_all'); },
    options: TILE_OPTS
  }
};

function getMapTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function setMapTheme(theme) {
  localStorage.setItem('icaoMapTheme', theme);
}

/* =========================
   Geometry helpers
========================= */

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/* =========================
   Runway labels
========================= */

function addRunwayLabels(map, runways) {
  if (!Array.isArray(runways)) return;
  runways.forEach(rwy => {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) return;
    const b12 = bearingDeg(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    addRunwayLabel(map, rwy.lat1, rwy.lon1, rwy.ident1, b12);
    addRunwayLabel(map, rwy.lat2, rwy.lon2, rwy.ident2, (b12 + 180) % 360);
  });
}

function addRunwayLabel(map, lat, lon, text, rotation) {
  L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'runway-label',
      // Two divs: outer centres the label on the lat/lon, inner rotates the
      // text. Combining both transforms on a single element makes the
      // translate happen in the rotated axes, which drifts the label off the
      // runway threshold for any non-cardinal heading.
      html: `<div class="runway-label-wrap"><div class="runway-label-text" style="--rwy-rot:${rotation}deg">${text}</div></div>`,
      iconSize: [0, 0]
    }),
    interactive: false
  }).addTo(map);
}

/* =========================
   DOM Ready
========================= */

document.addEventListener('DOMContentLoaded', () => {

  document.documentElement.dataset.mapTheme = getMapTheme();

  /* ---------- Embedded map ---------- */

  const el = document.getElementById('icaoMap');
  if (!el || typeof L === 'undefined') return;

  const ICAO = el.dataset.icao;

  fetch(`/api/icao/${ICAO}/map`)
    .then(r => r.json())
    .then(({ airport, aircraft }) => {

      window._icaoAirport = airport;
      window._icaoAircraft = aircraft;

      const map = L.map('icaoMap', {
        zoomControl: true,
        attributionControl: false,
        // Render runways/buildings/stand polygons on a single canvas instead
        // of hundreds of SVG nodes — much smoother during zoom animations.
        preferCanvas: true,
        // Slower wheel zoom — smaller per-notch jumps mean less unloaded
        // area exposed during zoom-out before tiles arrive.
        zoomSnap: 0.5,
        wheelPxPerZoomLevel: 120,
        // Cap zoom-out — anything below z=10 is just regional/continental view
        // which isn't useful on an airport portal and exposes a lot of empty
        // tile area while loading.
        minZoom: 13
      });

      wfAddTileLayer(map, TILE_LAYERS[getMapTheme()].options);
      window._icaoMapInstance = map;

      // Recompute tile bounds whenever the map container resizes
      // (e.g. ATIS card appears and stretches the grid row).
      // Debounced to avoid invalidateSize ↔ ResizeObserver feedback loops.
      if (typeof ResizeObserver !== 'undefined') {
        let resizeTimer = null;
        new ResizeObserver(function() {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function() { map.invalidateSize(); }, 150);
        }).observe(el);
      }

      // Kick off the ground-layout fetch in parallel with rendering aircraft.
      // First load takes 5–30s while OSM is queried; subsequent loads are
      // instant from disk cache.
      loadGround(map, ICAO);

      // Buildings + stand labels are visually noise when zoomed out and the
      // single biggest performance cost. Toggle them by zoom level.
      map.on('zoomend', () => applyZoomVisibility(map));

      const bounds = L.latLngBounds([[airport.lat, airport.lon]]);
      aircraft.forEach(ac => {
        if (ac.lat && ac.lon) bounds.extend([ac.lat, ac.lon]);
      });

      // Aircraft layer + per-callsign marker map so we can update positions
      // in place rather than rebuilding every poll (smoother, no flicker).
      const aircraftLayer = L.layerGroup().addTo(map);
      const aircraftMarkers = new Map();
      window._icaoAircraftLayer = aircraftLayer;

      function buildAircraftIcon(ac) {
        return L.divIcon({
          className: 'ac-marker',
          // Anchor at the centre of the plane SVG so the marker's lat/lng
          // (and the polyline endpoint to its tag) lands on the aircraft icon
          // centre rather than its top-left corner.
          iconSize: [18, 18],
          iconAnchor: [9, 9],
          html: `<div class="ac-icon" style="transform:rotate(${ac.heading || 0}deg)"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>
                 <div class="ac-label">${ac.callsign}</div>`
        });
      }

      function escapeAcText(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
          ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
        );
      }

      function buildAircraftTooltip(ac) {
        const type = ac.aircraft ? escapeAcText(ac.aircraft) : '—';
        const orig = ac.origin ? escapeAcText(ac.origin) : '—';
        const dest = ac.destination ? escapeAcText(ac.destination) : '—';
        const wf = ac.isWf ? '<span class="ac-tt-wf">WF</span>' : '';
        return '<div class="ac-tt-callsign">' + escapeAcText(ac.callsign) + wf + '</div>' +
               '<div class="ac-tt-meta">' + type + ' &middot; ' + orig + ' → ' + dest + '</div>';
      }

      function bindAcTooltip(marker, ac) {
        marker.bindTooltip(buildAircraftTooltip(ac), {
          direction: 'top',
          offset: [0, -8],
          opacity: 1,
          className: 'ac-tooltip'
        });
      }

      // Permanent draggable tags: separate marker + polyline per aircraft.
      // Tag follows the aircraft using a stored offset; user can drag to
      // declutter and the offset is updated so the tag tracks the aircraft.
      const aircraftTags = new Map(); // callsign -> { tagMarker, line, offset }
      window._aircraftTags = aircraftTags;

      // White connector line on dark maps; near-black on light maps so it
       // doesn't blow out against the pale background.
      function getTagLineColor() {
        return getMapTheme() === 'light' ? '#1f2937' : '#fff';
      }

      // Lat/lng of the visible CENTRE of a tag marker. The marker's lat/lng
       // is at its top-left corner (iconAnchor [0,0]); we offset by half the
       // rendered width/height (in pixels, converted via the current zoom).
      function tagCenterLatLng(tagMarker) {
        const tagLL = tagMarker.getLatLng();
        const el = tagMarker.getElement();
        if (!el) return tagLL;
        const w = el.offsetWidth || 0;
        const h = el.offsetHeight || 0;
        if (!w || !h) return tagLL;
        const pt = map.latLngToContainerPoint(tagLL);
        return map.containerPointToLatLng([pt.x + w / 2, pt.y + h / 2]);
      }

      function createAircraftTag(ac, acMarker) {
        const acLL = acMarker.getLatLng();
        const offset = { dlat: 0.0006, dlng: 0.0008 };
        const tagLL = L.latLng(acLL.lat + offset.dlat, acLL.lng + offset.dlng);
        const tagMarker = L.marker(tagLL, {
          icon: L.divIcon({
            className: 'ac-tag-marker',
            html: '<div class="ac-tag-box">' + buildAircraftTooltip(ac) + '</div>',
            iconAnchor: [0, 0]
          }),
          draggable: true,
          zIndexOffset: 6000,
          autoPan: false
        }).addTo(aircraftLayer);
        const line = L.polyline([acLL, tagLL], {
          color: getTagLineColor(),
          weight: 1,
          opacity: 0.7,
          interactive: false
        }).addTo(aircraftLayer);
        const state = { tagMarker, line, offset };
        // Capture user-defined offset on drag so the tag stays where they
        // dropped it, relative to the aircraft, even as the aircraft moves.
        tagMarker.on('drag', () => {
          const aLL = acMarker.getLatLng();
          const tLL = tagMarker.getLatLng();
          state.offset = { dlat: tLL.lat - aLL.lat, dlng: tLL.lng - aLL.lng };
          line.setLatLngs([aLL, tagCenterLatLng(tagMarker)]);
        });
        // Initial line endpoint can only be computed once the element is
        // in the DOM; defer one frame so offsetWidth/Height are populated.
        requestAnimationFrame(() => {
          line.setLatLngs([acMarker.getLatLng(), tagCenterLatLng(tagMarker)]);
        });
        return state;
      }

      function syncAircraftTag(callsign, acMarker) {
        const t = aircraftTags.get(callsign);
        if (!t) return;
        const acLL = acMarker.getLatLng();
        const newTagLL = L.latLng(acLL.lat + t.offset.dlat, acLL.lng + t.offset.dlng);
        t.tagMarker.setLatLng(newTagLL);
        t.line.setLatLngs([acLL, tagCenterLatLng(t.tagMarker)]);
      }

      // Pixels-per-degree changes with zoom, so the centre lat/lng of each
      // tag shifts; recompute every line endpoint when the user zooms.
      map.on('zoomend', () => {
        for (const [cs, t] of aircraftTags) {
          const m = aircraftMarkers.get(cs);
          if (m) t.line.setLatLngs([m.getLatLng(), tagCenterLatLng(t.tagMarker)]);
        }
      });

      // Recolour all existing tag lines when the theme toggles.
      new MutationObserver(() => {
        const c = getTagLineColor();
        for (const t of aircraftTags.values()) t.line.setStyle({ color: c });
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      function updateAircraftTagContent(callsign, ac) {
        const t = aircraftTags.get(callsign);
        if (!t) return;
        t.tagMarker.setIcon(L.divIcon({
          className: 'ac-tag-marker',
          html: '<div class="ac-tag-box">' + buildAircraftTooltip(ac) + '</div>',
          iconAnchor: [0, 0]
        }));
      }

      function removeAircraftTag(callsign) {
        const t = aircraftTags.get(callsign);
        if (!t) return;
        aircraftLayer.removeLayer(t.tagMarker);
        aircraftLayer.removeLayer(t.line);
        aircraftTags.delete(callsign);
      }

      function renderAircraft(list) {
        const seen = new Set();
        (list || []).forEach(ac => {
          if (!ac.lat || !ac.lon || !ac.callsign) return;
          seen.add(ac.callsign);
          const existing = aircraftMarkers.get(ac.callsign);
          if (existing) {
            existing.setLatLng([ac.lat, ac.lon]);
            existing.setIcon(buildAircraftIcon(ac));
            existing._acData = ac;
            if (window._acTagsVisible) {
              updateAircraftTagContent(ac.callsign, ac);
              syncAircraftTag(ac.callsign, existing);
            } else {
              existing.setTooltipContent(buildAircraftTooltip(ac));
            }
          } else {
            const m = L.marker([ac.lat, ac.lon], {
              icon: buildAircraftIcon(ac),
              zIndexOffset: 5000
            }).addTo(aircraftLayer);
            m._acData = ac;
            if (window._acTagsVisible) {
              aircraftTags.set(ac.callsign, createAircraftTag(ac, m));
            } else {
              bindAcTooltip(m, ac);
            }
            aircraftMarkers.set(ac.callsign, m);
          }
        });
        // Drop departed aircraft (and their tags).
        for (const [cs, m] of aircraftMarkers) {
          if (!seen.has(cs)) {
            aircraftLayer.removeLayer(m);
            aircraftMarkers.delete(cs);
            removeAircraftTag(cs);
          }
        }
      }

      // Toggle: permanent vs hover-only aircraft tags.
      document.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.toggle-tags-btn');
        if (!btn) return;
        const visible = !window._acTagsVisible;
        window._acTagsVisible = visible;
        document.body.classList.toggle('ac-tags-permanent', visible);
        if (visible) {
          // Switch from hover tooltips to draggable tag markers.
          for (const [cs, m] of aircraftMarkers) {
            m.unbindTooltip();
            if (!aircraftTags.has(cs)) {
              aircraftTags.set(cs, createAircraftTag(m._acData, m));
            }
          }
        } else {
          // Tear down draggable tags, restore hover tooltips.
          for (const cs of [...aircraftTags.keys()]) removeAircraftTag(cs);
          for (const m of aircraftMarkers.values()) bindAcTooltip(m, m._acData);
        }
        btn.textContent = visible ? 'Hide Full Tags' : 'Show Full Tags';
        const label = visible ? 'Hide full tags' : 'Show full tags';
        btn.title = label;
        btn.setAttribute('aria-label', label);
      });

      renderAircraft(aircraft);
      addRunwayLabels(map, airport.runways);
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });

      // Poll aircraft positions every 15s — matches VATSIM's update cadence.
      setInterval(() => {
        fetch(`/api/icao/${ICAO}/map`)
          .then(r => r.json())
          .then(({ aircraft }) => {
            window._icaoAircraft = aircraft;
            renderAircraft(aircraft);
          })
          .catch(() => {});
      }, 15_000);
    });

  /* ---------- Expand / collapse button ---------- */

  let _origParent = null;
  let _origNextSibling = null;

  document
    .getElementById('expandMapBtn')
    ?.addEventListener('click', () => {
      const card = document.querySelector('.icao-portal-map-card');
      const map = window._icaoMapInstance;
      if (!card || !map) return;
      const willExpand = !card.classList.contains('is-fullscreen');

      if (willExpand) {
        // Move to body so we escape any ancestor stacking context (the sidebar
        // sits at z-index 1200; staying under it would leave it visible).
        _origParent = card.parentNode;
        _origNextSibling = card.nextSibling;
        document.body.appendChild(card);
        card.classList.add('is-fullscreen');
      } else {
        card.classList.remove('is-fullscreen');
        if (_origParent) {
          _origParent.insertBefore(card, _origNextSibling);
          _origParent = null;
          _origNextSibling = null;
        }
      }

      document.body.classList.toggle('map-fullscreen', willExpand);
      const btn = document.getElementById('expandMapBtn');
      if (btn) {
        btn.textContent = willExpand ? '✕' : '⤢';
        const label = willExpand ? 'Collapse map' : 'Expand map';
        btn.title = label;
        btn.setAttribute('aria-label', label);
      }
      // ResizeObserver on #icaoMap will pick up the size change, but kick
      // an immediate invalidateSize so the user sees no transient blank.
      setTimeout(() => map.invalidateSize(), 50);
    });
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const card = document.querySelector('.icao-portal-map-card.is-fullscreen');
  if (card) document.getElementById('expandMapBtn')?.click();
});

/* =========================
   Ground layout (runways, taxiways, aprons, stands, buildings)
========================= */

const GROUND_STYLE_DARK = {
  apron:    { color: '#2a2d35', weight: 0.3, fillColor: '#1f2128', fillOpacity: 0.35 },
  taxiway:  { color: '#2e3138', weight: 0.4, fillColor: '#23262d', fillOpacity: 0.45 },
  runway:   { color: '#2a2d35', weight: 0.3, fillColor: '#1f2128', fillOpacity: 0.3 },
  building: { color: '#1a1c20', weight: 0.2, fillColor: '#13151a', fillOpacity: 0.25 },
  stand:    { color: '#5eead4', weight: 1, fillColor: '#5eead4', fillOpacity: 0.18 },
  standOcc: { color: '#ef4444', weight: 1, fillColor: '#ef4444', fillOpacity: 0.32 }
};
const GROUND_STYLE_LIGHT = {
  apron:    { color: '#cbd5e1', weight: 0.4, fillColor: '#e2e8f0', fillOpacity: 0.35 },
  taxiway:  { color: '#cbd5e1', weight: 0.5, fillColor: '#e2e8f0', fillOpacity: 0.4 },
  runway:   { color: '#cbd5e1', weight: 0.4, fillColor: '#e2e8f0', fillOpacity: 0.3 },
  building: { color: '#cbd5e1', weight: 0.3, fillColor: '#e2e8f0', fillOpacity: 0.25 },
  stand:    { color: '#0d9488', weight: 1.5, fillColor: '#0d9488', fillOpacity: 0.15 },
  standOcc: { color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.25 }
};
function getGroundStyle() {
  return document.documentElement.dataset.mapTheme === 'light' ? GROUND_STYLE_LIGHT : GROUND_STYLE_DARK;
}
// Keep backward compat reference
const GROUND_STYLE = GROUND_STYLE_DARK;

// Zoom thresholds for hiding heavy detail layers when the user is too far
// out to read them anyway.
const BUILDING_MIN_ZOOM = 14;
const STAND_LABEL_MIN_ZOOM = 16;

function applyZoomVisibility(map) {
  const z = map.getZoom();
  const blayer = window._icaoBuildingLayer;
  if (blayer) {
    const want = z >= BUILDING_MIN_ZOOM;
    if (want && !map.hasLayer(blayer)) map.addLayer(blayer);
    else if (!want && map.hasLayer(blayer)) map.removeLayer(blayer);
  }
  document.body.classList.toggle('icao-zoomed-out', z < STAND_LABEL_MIN_ZOOM);
}

function loadGround(map, icao) {
  // Only show the loading pill if the fetch is genuinely slow (cache miss).
  // For airports pre-fetched at server startup the request returns immediately
  // and the indicator never appears.
  let indicator = null;
  const showAfter = setTimeout(() => { indicator = makeGroundIndicator(map); }, 400);

  fetch('/api/icao/' + icao + '/ground')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(geo => {
      clearTimeout(showAfter);
      if (indicator) indicator.remove();
      renderGround(map, geo);
      applyZoomVisibility(map);
      pollStandOccupancy(icao);
    })
    .catch(err => {
      clearTimeout(showAfter);
      if (!indicator) indicator = makeGroundIndicator(map);
      indicator.fail(err && err.message ? err.message : 'failed');
    });
}

function makeGroundIndicator(map) {
  const el = L.DomUtil.create('div', 'ground-indicator', map.getContainer());
  el.textContent = 'Loading ground layout…';
  return {
    remove: () => el.remove(),
    fail: (msg) => {
      el.textContent = 'Ground layout unavailable (' + msg + ')';
      el.classList.add('ground-indicator-fail');
      setTimeout(() => el.remove(), 6000);
    }
  };
}

function renderGround(map, geo) {
  if (!geo || !Array.isArray(geo.features)) return;

  const gs = getGroundStyle();

  // Runways and buildings only — aprons and taxiways are already visible on the
  // base tile layer and rendering hundreds of widened OSM polygons for them
  // tanks performance on integrated GPUs.
  ['runway', 'building'].forEach(kind => {
    const features = geo.features.filter(f => f.properties && f.properties.kind === kind);
    if (!features.length) return;
    const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
      style: gs[kind],
      interactive: false,
      pane: 'overlayPane'
    });
    if (kind === 'building') {
      // Track separately so applyZoomVisibility can detach it when zoomed out.
      window._icaoBuildingLayer = layer;
      if (map.getZoom() >= BUILDING_MIN_ZOOM) layer.addTo(map);
    } else {
      layer.addTo(map);
    }
  });

  // Stands — render polygons (where available) and a label per stand.
  const standLayer = L.layerGroup().addTo(map);
  window._icaoStandLookup = {};

  geo.features.filter(f => f.properties && f.properties.kind === 'stand').forEach(f => {
    const props = f.properties;
    const id = String(props.osm_id);
    const name = props.ref || props.name || '';
    let center = null;
    let polygon = null;

    if (f.geometry.type === 'Polygon') {
      const ring = f.geometry.coordinates[0];
      polygon = L.polygon(ring.map(c => [c[1], c[0]]), gs.stand).addTo(standLayer);
      let lat = 0, lon = 0;
      ring.forEach(c => { lon += c[0]; lat += c[1]; });
      center = [lat / ring.length, lon / ring.length];
    } else if (f.geometry.type === 'Point') {
      center = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
    }

    if (center && name) {
      const label = L.marker(center, {
        icon: L.divIcon({
          className: 'stand-label',
          html: '<div class="stand-label-box" data-stand-id="' + id + '">' + escapeText(name) + '</div>',
          iconSize: [0, 0]
        }),
        zIndexOffset: 100
      }).addTo(standLayer);
      window._icaoStandLookup[id] = { name, polygon, label };
    } else if (polygon) {
      window._icaoStandLookup[id] = { name, polygon, label: null };
    }
  });

  window._icaoStandLayer = standLayer;
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

/* =========================
   Stand occupancy
========================= */

let _occupancyTimer = null;

function pollStandOccupancy(icao) {
  if (_occupancyTimer) clearInterval(_occupancyTimer);
  refreshStandOccupancy(icao);
  _occupancyTimer = setInterval(() => refreshStandOccupancy(icao), 60_000);
}

async function refreshStandOccupancy(icao) {
  try {
    const res = await fetch('/api/icao/' + icao + '/stand-occupancy');
    if (!res.ok) return;
    const data = await res.json();
    window._icaoLastOccupancy = data.occupancy || {};
    applyStandOccupancy();
  } catch (err) {
    // Silent — we'll try again on the next interval.
  }
}

// Re-paint stand polygons + label classes from the cached occupancy.
// Called both after a fresh fetch and after the user re-shows the layer
// (Leaflet recreates the marker DOM on add, so the .stand-occupied class
// is otherwise lost).
function applyStandOccupancy() {
  const occ = window._icaoLastOccupancy || {};
  const lookup = window._icaoStandLookup || {};
  const gs = getGroundStyle();

  Object.keys(lookup).forEach(id => {
    const s = lookup[id];
    const isOccupied = !!occ[id];
    if (s.polygon) s.polygon.setStyle(isOccupied ? gs.standOcc : gs.stand);
    if (s.label) {
      const box = s.label.getElement()?.querySelector('.stand-label-box');
      if (box) {
        box.classList.toggle('stand-occupied', isOccupied);
        box.title = isOccupied ? occ[id].callsign : '';
      }
    }
  });
}

/* =========================
   Stand visibility toggle
========================= */

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.toggle-stands-btn');
  if (!btn) return;
  const map = window._icaoMapInstance;
  const layer = window._icaoStandLayer;
  if (!map || !layer) return;
  const visible = !map.hasLayer(layer);
  if (visible) {
    map.addLayer(layer);
    // Marker DOM was destroyed when the layer was hidden; reapply
    // occupancy classes so occupied stands are red again immediately.
    applyStandOccupancy();
  } else {
    map.removeLayer(layer);
  }
  btn.textContent = visible ? 'Hide Stands' : 'Show Stands';
  const label = visible ? 'Hide stands' : 'Show stands';
  btn.title = label;
  btn.setAttribute('aria-label', label);
});

/* =========================
   Theme toggle
========================= */

function toggleMapTheme() {
  const theme = getMapTheme() === 'dark' ? 'light' : 'dark';
  setMapTheme(theme);
  document.documentElement.dataset.mapTheme = theme;

  const map = window._icaoMapInstance;
  if (!map?._baseTileLayer) return;
  map.removeLayer(map._baseTileLayer);
  map._baseTileLayer = L.tileLayer(
    TILE_LAYERS[theme].url,
    TILE_LAYERS[theme].options
  ).addTo(map);
}
