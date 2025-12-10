const express = require("express");
const app = express();

const PORT = 3000;

// Simple test route
app.get("/", (req, res) => {
  res.send("WorldFlight-CDM is running");
});

// IMPORTANT: bind to 0.0.0.0 for Docker
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
