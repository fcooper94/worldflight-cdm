document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('icaoMap');
  if (!el || typeof L === 'undefined') return;

  const ICAO = el.dataset.icao;

  fetch('/api/icao/' + ICAO + '/map')
    .then(res => {
      if (!res.ok) throw new Error('Map data failed');
      return res.json();
    })
    .then(({ airport, aircraft }) => {
      if (!airport || !airport.lat || !airport.lon) return;

      // Create map (no fixed zoom)
      const map = L.map('icaoMap', {
        zoomControl: false,
        attributionControl: false
      });

      // Dark basemap
      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { maxZoom: 19 }
      ).addTo(map);

      // Bounds to auto-fit everything
      const bounds = L.latLngBounds();

      // Always include airport
      bounds.extend([airport.lat, airport.lon]);

      // Subtle airport reference marker
      L.circleMarker([airport.lat, airport.lon], {
        radius: 10,
        color: '#38bdf8',
        weight: 1,
        fillOpacity: 0.15,
        opacity: 0.6
      }).addTo(map);

      // Aircraft markers
      aircraft.forEach(ac => {
        if (!ac.lat || !ac.lon) return;

        bounds.extend([ac.lat, ac.lon]);

        const icon = L.divIcon({
          className: 'ac-marker',
          html:
            '<div class="ac-icon" style="transform: rotate(' +
            (ac.heading || 0) +
            'deg)">✈</div>' +
            '<div class="ac-label">' +
            ac.callsign +
            '</div>'
        });

        L.marker([ac.lat, ac.lon], { icon }).addTo(map);
      });

      // Auto-zoom to fit aircraft + airport
      if (bounds.isValid()) {
        map.fitBounds(bounds, {
          padding: [20, 20],
          maxZoom: 15
        });
      } else {
        // Fallback if no aircraft
        map.setView([airport.lat, airport.lon], 13);
      }
    })
    .catch(err => console.error('[ICAO MAP]', err));
});
