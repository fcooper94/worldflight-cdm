import { v4 as uuidv4 } from 'uuid';
// Generates a simple queue of inbound flights for FAOR (example) every 60s
export function startFlightSimulator(onUpdate) {
// seed 10 flights over next 2 hours
const flights = [];
const now = new Date();
for (let i = 0; i < 12; i++) {
const eobt = new Date(now.getTime() + (i * 8 +
Math.floor(Math.random()*6)) * 60 * 1000); // every ~8 minutes
flights.push({ id: uuidv4(), callsign: `WF${100+i}`, dep_icao: 'FACT',
arr_icao: 'FAOR', filed_eobt: eobt.toISOString() });
}
// call back immediately
onUpdate(flights);
// every 60s randomly add/remove to simulate flow
setInterval(() => {
if (Math.random() < 0.6 && flights.length < 40) {
const nextMin = flights.length * 6 + Math.floor(Math.random()*4);
const eobt = new Date(new Date().getTime() + nextMin*60*1000);
flights.push({ id: uuidv4(), callsign: `WF${200+flights.length}`,
dep_icao: 'FACT', arr_icao: 'FAOR', filed_eobt: eobt.toISOString() });
} else if (Math.random() < 0.2 && flights.length > 6) {
flights.splice(Math.floor(Math.random()*flights.length), 1);
}
onUpdate(flights);
}, 60_000);
}
