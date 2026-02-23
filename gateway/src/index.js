/**
 * jobmate-gateway — Stub placeholder
 *
 * TODO: Replace with Apollo Server (GraphQL) + SSE endpoint.
 * This stub validates that the Docker / network stack is working end-to-end.
 */

'use strict';

const http = require('http');

const PORT = process.env.PORT || 4000;

const router = (req, res) => {
  // Health check (used by Traefik and CI smoke tests)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', service: 'gateway', version: '0.1.0' }));
  }

  // GraphQL placeholder
  if (req.url === '/graphql') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: null, message: 'GraphQL endpoint — coming soon' }));
  }

  // SSE placeholder
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected","service":"gateway"}\n\n');
    // Keep connection alive (client disconnects after testing)
    const interval = setInterval(() => res.write(': ping\n\n'), 30_000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
};

const server = http.createServer(router);

server.listen(PORT, () => {
  console.log(`[gateway] Listening on port ${PORT}`);
  console.log(`[gateway] Health: http://localhost:${PORT}/health`);
});
