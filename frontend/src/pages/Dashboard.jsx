import React, { useEffect, useState } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
const socket = io(import.meta.env.VITE_BACKEND_URL || 'http://localhost:
4000');
export default function Dashboard(){
const [flights, setFlights] = useState([]);
const [assignments, setAssignments] = useState({});
useEffect(() => {
socket.on('init', (payload) => {
setFlights(payload.flights || []);
setAssignments(payload.assignments || {});
});
socket.on('assignments_updated', (a) => setAssignments(a));
return () => { socket.off('init'); socket.off('assignments_updated'); }
}, []);
return (
<div>
<h2>Pilot Dashboard (demo)</h2>
<p>Connect with VATSIM SSO or use <a href="/auth/vatsim/mock">mock
login</a>.</p>
<table border="1" cellPadding="6">
<thead><tr><th>Callsign</th><th>EOBT</th><th>TSAT</th><th>Delay</
th></tr></thead>
<tbody>
{flights.map(f => {
const a = assignments[f.id];
const e = new Date(f.filed_eobt);
const t = a ? new Date(a.tsat) : null;
const delay = t ? Math.round((t - e)/60000) : 0;
return (
<tr key={f.id}>
<td>{f.callsign}</td>
<td>{e.toUTCString()}</td>
<td>{t ? t.toUTCString() : '—'}</td>
<td>{t ? `${delay} min` : '—'}</td>
</tr>
)
})}
</tbody>
</table>
</div>
)
}

