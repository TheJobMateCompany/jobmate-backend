/**
 * jobmate-user-service — Stub placeholder
 *
 * TODO: Implement user CRUD, profile management, CV PDF parsing (delegated to Python subprocess).
 */

'use strict';

const http = require('http');

const PORT = process.env.PORT || 4001;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'user-service', version: '0.1.0' }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[user-service] Listening on port ${PORT}`);
});
