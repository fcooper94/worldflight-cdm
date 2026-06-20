/* ===============================
   RENDER SLOT BANNERS (GLOBAL)
================================ */

window.loadSlotBanners = function (data) {
  if (!data) return;

  const header = document.getElementById('slotBannerHeader');
  const container = document.getElementById('slotBanners');
  if (!container || !header) return;

  const hasArrival = !!data.arrival;
  const hasDeparture = !!data.departure;

  // Hide everything if nothing to show
  if (!hasArrival && !hasDeparture) {
    header.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  header.style.display = '';
  container.innerHTML = '';

  /* ===============================
     BOOKING URLS
  ============================== */

  const arrivalBookUrl = data.arrival?.dep_time_utc
    ? '/book?' +
        'from=' + encodeURIComponent(data.arrival.from) +
        '&to=' + encodeURIComponent(data.arrival.to) +
        '&dateUtc=' + encodeURIComponent(data.arrival.dateUtc) +
        '&depTimeUtc=' + encodeURIComponent(data.arrival.dep_time_utc)
    : null;

  const departureBookUrl = data.departure?.dep_time_utc
    ? '/book?' +
        'from=' + encodeURIComponent(data.departure.from) +
        '&to=' + encodeURIComponent(data.departure.to) +
        '&dateUtc=' + encodeURIComponent(data.departure.dateUtc) +
        '&depTimeUtc=' + encodeURIComponent(data.departure.dep_time_utc)
    : null;

  /* ===============================
     ARRIVAL
  ============================== */

  if (data.arrival) {
    const a = data.arrival;

    container.innerHTML +=
      '<div class="slot-banner arrival">' +

        '<div class="slot-header">' +
          '<span class="slot-badge arrival">Arrival - </span>' +
          '<span class="slot-date">' + a.dateUtc + '</span>' +
        '</div>' +

        '<div class="slot-route">' +
          '<span>' + a.from + '</span>' +
          '<span class="arrow">→</span>' +
          '<span>' + a.to + '</span>' +
        '</div>' +

        '<div class="slot-window">' +
          '<span class="slot-window-label">Arrival window (UTC)</span>' +
          '<span class="slot-window-value">' + (a.window || '—') + '</span>' +
        '</div>' +

        (a.atcRoute ?
          '<div class="slot-atc">' +
            '<span class="slot-atc-label">ATC Route</span>' +
            '<span class="slot-atc-route">' + a.atcRoute + '</span>' +
          '</div>'
        : '') +

        (a.atcRoute2 ?
          '<div class="slot-atc">' +
            '<span class="slot-atc-label">Secondary Route</span>' +
            '<span class="slot-atc-route" style="opacity:0.8;">' + a.atcRoute2 + '</span>' +
          '</div>'
        : '') +

        (
  !a.hasSlots
    ? '<span class="wf-book-btn disabled arrival">Bookings not yet available ✕</span>'
  : a.iHaveSlot
    ? '<span class="wf-book-btn disabled arrival">You already have a slot ✓</span>'
  : a.fullyBooked
    ? '<span class="wf-book-btn disabled arrival">All slots booked ✕</span>'
  : arrivalBookUrl
    ? '<a class="wf-book-btn arrival" href="' + arrivalBookUrl + '">Book ' + a.from + ' departure slot</a>'
    : '<span class="wf-book-btn disabled arrival">Booking unavailable</span>'
)
 +

      '</div>';
  }

  /* ===============================
     DEPARTURE
  ============================== */

  if (data.departure) {
    const d = data.departure;

    container.innerHTML +=
      '<div class="slot-banner departure">' +

        '<div class="slot-header">' +
          '<span class="slot-badge departure">Departure - </span>' +
          '<span class="slot-date">' + d.dateUtc + '</span>' +
        '</div>' +

        '<div class="slot-route">' +
          '<span>' + d.from + '</span>' +
          '<span class="arrow">→</span>' +
          '<span>' + d.to + '</span>' +
        '</div>' +

        '<div class="slot-window">' +
          '<span class="slot-window-label">Departure window (UTC)</span>' +
          '<span class="slot-window-value">' + (d.window || '—') + '</span>' +
        '</div>' +

        (d.atcRoute ?
          '<div class="slot-atc">' +
            '<span class="slot-atc-label">ATC Route</span>' +
            '<span class="slot-atc-route">' + d.atcRoute + '</span>' +
          '</div>'
        : '') +

        (d.atcRoute2 ?
          '<div class="slot-atc">' +
            '<span class="slot-atc-label">Secondary Route</span>' +
            '<span class="slot-atc-route" style="opacity:0.8;">' + d.atcRoute2 + '</span>' +
          '</div>'
        : '') +

        (
  !d.hasSlots
    ? '<span class="wf-book-btn disabled departure">Bookings not yet available ✕</span>'
  : d.iHaveSlot
    ? '<span class="wf-book-btn disabled departure">You already have a slot ✓</span>'
  : d.fullyBooked
    ? '<span class="wf-book-btn disabled departure">All slots booked ✕</span>'
  : departureBookUrl
    ? '<a class="wf-book-btn departure" href="' + departureBookUrl + '">Book ' + d.from + ' departure slot</a>'
    : '<span class="wf-book-btn disabled departure">Booking unavailable</span>'
)
 +

      '</div>';
  }
};

/* ===============================
   AUTO LOAD (GLOBAL ICAO)
================================ */

document.addEventListener('DOMContentLoaded', function () {
  if (!/\/icao\/[A-Z]{4}$/i.test(window.location.pathname)) return;

  const parts = window.location.pathname.split('/');
  const icao = parts[parts.length - 1].toUpperCase();

  fetch('/api/icao/' + icao + '/wf-slots')
    .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
    .then(function (data) { if (window.loadSlotBanners) window.loadSlotBanners(data); })
    .catch(function () { /* not an ICAO page */ });
});
