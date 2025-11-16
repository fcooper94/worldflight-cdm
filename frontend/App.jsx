import React, { useState } from 'react';

export default function App() {
  const [cs, setCs] = useState("");
  const [data, setData] = useState(null);

  async function fetchTSAT() {
    const res = await fetch(`http://localhost:4000/api/tsat/${cs}`);
    setData(await res.json());
  }

  return (
    <div>
      <h1>WorldFlight CDM</h1>
      <input value={cs} onChange={e => setCs(e.target.value)} placeholder="Callsign" />
      <button onClick={fetchTSAT}>Get TSAT</button>
      {data && <pre>{JSON.stringify(data, null, 2)}</pre>}
    </div>
  );
}
