import React, { useState, useEffect } from 'react';
import axios from 'axios';
export default function Admin(){
const [airports, setAirports] = useState([]);
const [icao, setIcao] = useState('FAOR');
const [arrivals, setArrivals] = useState(20);
useEffect(() => {
axios.get(import.meta.env.VITE_BACKEND_URL + '/api/airports').then(r =>
setAirports(r.data));
}, []);
const save = async () => {
const res = await axios.post((import.meta.env.VITE_BACKEND_URL ||
'http://localhost:4000') + `/api/airports/${icao}/flow`, {
arrivals_per_hour: arrivals });
alert('Saved — assignments updated');
}
return (
<div>
<h2>Admin — Flow Editor</h2>
<label>Airport: <select value={icao}
onChange={e=>setIcao(e.target.value)}>{airports.map(a=> <option key={a.icao}
value={a.icao}>{a.icao}</option>)}</select></label>
<div>
<label>Arrivals/hour: <input type="number" value={arrivals}
onChange={e=>setArrivals(e.target.value)} /></label>
</div>
<button onClick={save}>Save & Recompute</button>
</div>
)
}