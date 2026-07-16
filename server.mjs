// Local dev server. Production runs on Vercel (static index.html + api/ functions).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTier } from './lib/engine.mjs';
import { handleTier } from './lib/handler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3400;
const STATIC_FILES = new Map([
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']],
  ['/llms.txt', ['llms.txt', 'text/plain; charset=utf-8']],
  ['/sitemap.xml', ['sitemap.xml', 'application/xml; charset=utf-8']],
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/api/scan') return await handleTier('scan', req, res, runTier);
    if (req.method === 'POST' && url.pathname === '/api/audit') return await handleTier('audit', req, res, runTier);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/report/'))) {
      const page = await readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(page);
    }
    if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
      const [file, contentType] = STATIC_FILES.get(url.pathname);
      const asset = await readFile(path.join(__dirname, file));
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
      return res.end(asset);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Suede Scan running on http://localhost:${PORT}`));
