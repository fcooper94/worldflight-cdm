/* =========================================================
   ICAO Airport Map
   ========================================================= */

/* =========================
   Geometry helpers
========================= */

function toRad(d) {
  return (d * Math.PI) / 180;
}

function toDeg(r) {
  return (r * 180) / Math.PI;
}

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

// Offset point perpendicular to bearing
function perpendicularOffset(lat, lon, bearing, meters = 32) {
  const R = 6378137;
  const θ = toRad(bearing + 90);
  const δ = meters / R;

  const φ1 = toRad(lat);
  const λ1 = toRad(lon);

  const φ2 =
    Math.asin(
      Math.sin(φ1) * Math.cos(δ) +
      Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
    );

  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );

  return [toDeg(φ2), toDeg(λ2)];
}

/* =========================
   Runway labels (corrected)
========================= */

function addRunwayLabels(map, runways) {
  if (!Array.isArray(runways)) return;

  runways.forEach(rwy => {
    if (
      !rwy.lat1 ||
      !rwy.lon1 ||
      !rwy.lat2 ||
      !rwy.lon2 ||
      !rwy.ident1 ||
      !rwy.ident2
    ) return;

    const bearing12 = bearingDeg(
      rwy.lat1,
      rwy.lon1,
      rwy.lat2,
      rwy.lon2
    );

    const bearing21 = (bearing12 + 180) % 360;

    addRunwayLabel(
      map,
      rwy.lat1,
      rwy.lon1,
      rwy.ident1,
      bearing12
    );

    addRunwayLabel(
      map,
      rwy.lat2,
      rwy.lon2,
      rwy.ident2,
      bearing21
    );
  });
}


function addRunwayLabel(map, lat, lon, text, rotation) {
  const icon = L.divIcon({
    className: 'runway-label',
    html: `
      <div style="--rwy-rot:${rotation}deg">
        ${text}
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });

  L.marker([lat, lon], {
    icon,
    interactive: false
  }).addTo(map);
}


/* =========================
   Embedded map
========================= */

document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('icaoMap');
  if (!el || typeof L === 'undefined') return;

  const ICAO = el.dataset.icao;

  fetch(`/api/icao/${ICAO}/map`)
    .then(r => {
      if (!r.ok) throw new Error('Map data failed');
      return r.json();
    })
    .then(({ airport, aircraft }) => {
      if (!airport?.lat || !airport?.lon) return;

      window._icaoAirport = airport;
      window._icaoAircraft = aircraft;

      const map = L.map('icaoMap', {
        zoomControl: false,
        attributionControl: false
      });

      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 19 }
      ).addTo(map);

      const bounds = L.latLngBounds();
      bounds.extend([airport.lat, airport.lon]);

      // Airport reference point
      L.circleMarker([airport.lat, airport.lon], {
        radius: 6,
        color: '#38bdf8',
        weight: 1,
        fillOpacity: 0.12,
        opacity: 0.6
      }).addTo(map);

      // Aircraft
      aircraft.forEach(ac => {
        if (!ac.lat || !ac.lon) return;

        bounds.extend([ac.lat, ac.lon]);

        const icon = L.divIcon({
          className: 'ac-marker',
          html: `
            <div class="ac-icon" style="transform: rotate(${ac.heading || 0}deg)">✈</div>
            <div class="ac-label">${ac.callsign}</div>
          `
        });

        L.marker([ac.lat, ac.lon], { icon }).addTo(map);
      });

      // Runways
      addRunwayLabels(map, airport.runways);

      map.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: 16
      });
    })
    .catch(err => console.error('[ICAO MAP]', err));
});

/* =========================
   Modal map (unchanged)
========================= */

let modalMap = null;

document.getElementById('expandMapBtn')?.addEventListener('click', () => {
  const modal = document.getElementById('mapModal');
  modal.classList.remove('hidden');

  setTimeout(() => {
    if (!modalMap) {
      modalMap = L.map('mapModalMap', {
        zoomControl: true,
        attributionControl: false
      });

      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 19 }
      ).addTo(modalMap);
    } else {
      modalMap.eachLayer(layer => {
        if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
          modalMap.removeLayer(layer);
        }
      });
    }

    const bounds = L.latLngBounds();

    if (window._icaoAirport) {
      bounds.extend([window._icaoAirport.lat, window._icaoAirport.lon]);

      L.circleMarker(
        [window._icaoAirport.lat, window._icaoAirport.lon],
        {
          radius: 6,
          color: '#38bdf8',
          weight: 1,
          fillOpacity: 0.12
        }
      ).addTo(modalMap);

      addRunwayLabels(modalMap, window._icaoAirport.runways);
    }

    (window._icaoAircraft || []).forEach(ac => {
      if (!ac.lat || !ac.lon) return;

      bounds.extend([ac.lat, ac.lon]);

      const icon = L.divIcon({
        className: 'ac-marker',
        html: `
          <div class="ac-icon" style="transform: rotate(${ac.heading || 0}deg)">✈</div>
          <div class="ac-label">${ac.callsign}</div>
        `
      });

      L.marker([ac.lat, ac.lon], { icon }).addTo(modalMap);
    });

    modalMap.fitBounds(bounds, {
      padding: [40, 40],
      maxZoom: 16
    });

    modalMap.invalidateSize();
  }, 50);
});

/* =========================
   Modal close handlers
========================= */

function closeMapModal() {
  document.getElementById('mapModal')?.classList.add('hidden');
}

document.addEventListener('click', e => {
  if (
    e.target.id === 'closeMapModal' ||
    e.target.classList.contains('map-modal-backdrop')
  ) {
    closeMapModal();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMapModal();
});
