const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/tsat/:callsign', (req, res) => {
  res.json({ callsign: req.params.callsign, eobt: "12:00", tsat: "12:15" });
});

app.listen(4000, () => console.log('Backend running on port 4000'));
