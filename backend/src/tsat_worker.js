// Simple headway TSAT assignment
export function computeTSATsForAirport(icao, arrivalFlights,
arrivalsPerHour) {
const headwaySec = arrivalsPerHour > 0 ? Math.round(3600 /
arrivalsPerHour) : 300; // fallback 5min
const flights = [...arrivalFlights].sort((a,b) => new Date(a.filed_eobt) -
new Date(b.filed_eobt));
const assignments = {};
let prevTSAT = null;
for (const f of flights) {
const eobt = new Date(f.filed_eobt);
const proposed = prevTSAT ? new Date(prevTSAT.getTime() + headwaySec *
1000) : eobt;
const tsat = proposed > eobt ? proposed : eobt;
assignments[f.id] = { tsat: tsat.toISOString(), eobt:
eobt.toISOString(), callsign: f.callsign };
prevTSAT = tsat;
}
return assignments;
}
