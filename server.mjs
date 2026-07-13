// Local dev server. Production runs on Vercel (static index.html + api/ functions).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTier } from './lib/engine.mjs';
import { handleTier } from './lib/handler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3400;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/scan') return await handleTier('scan', req, res, runTier);
    if (req.method === 'POST' && req.url === '/api/audit') return await handleTier('audit', req, res, runTier);
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const page = await readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Suede Scan running on http://localhost:${PORT}`));
