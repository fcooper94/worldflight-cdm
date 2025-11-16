// Simple Express + Socket.IO server for prototype
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import cors from 'cors';
import { authRouter } from './auth.js';
import { startFlightSimulator } from './flights_sim.js';
import { computeTSATsForAirport } from './tsat_worker.js';
const app = express();
app.use(cors());
app.use(express.json());
app.use('/auth', authRouter);
// simple in-memory stores for prototype
const airports = { 'FAOR': { icao: 'FAOR', arrivals_per_hour: 20 } };
let flights = []; // will be populated by simulator
let assignments = {}; // flightId -> { tsat, eobt }
// endpoints
app.get('/api/airports', (req, res) => res.json(Object.values(airports)));
app.post('/api/airports/:icao/flow', (req, res) => {
const icao = req.params.icao.toUpperCase();
const { arrivals_per_hour } = req.body;
if (!airports[icao]) return res.status(404).send('Airport not found');
airports[icao].arrivals_per_hour = Number(arrivals_per_hour) ||
airports[icao].arrivals_per_hour;
// recompute TSATs
assignments = computeTSATsForAirport(icao, flights.filter(f => f.arr_icao
=== icao), airports[icao].arrivals_per_hour);
// broadcast via socket (handled below)
io.emit('assignments_updated', assignments);
res.json({ ok: true, assignments });
});
app.get('/api/flights', (req, res) => res.json(flights));
// start server
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: '*' } });
io.on('connection', (socket) => {
console.log('ws conn', socket.id);
socket.emit('init', { flights, assignments });
socket.on('join_flight', (flightId) => {
socket.join(`flight:${flightId}`);
});
});
// kick off simulator
startFlightSimulator((newFlights) => {
flights = newFlights;
// compute initial assignments
assignments = computeTSATsForAirport('FAOR', flights.filter(f =>
f.arr_icao === 'FAOR'), airports['FAOR'].arrivals_per_hour);
io.emit('init', { flights, assignments });
});
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`backend listening on ${PORT}`));
