const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3001; // Port for Replit

// Serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


