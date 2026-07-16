// Local server and Vercel root entrypoint.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { runTier } from './lib/engine.mjs';
import { handleTier } from './lib/handler.mjs';

const PORT = process.env.PORT || 3400;
const [INDEX_HTML, STYLES_CSS, CLIENT_JS, ROBOTS_TXT, LLMS_TXT, SITEMAP_XML] = await Promise.all([
  readFile(new URL('./index.html', import.meta.url)),
  readFile(new URL('./styles.css', import.meta.url)),
  readFile(new URL('./client.js', import.meta.url)),
  readFile(new URL('./robots.txt', import.meta.url)),
  readFile(new URL('./llms.txt', import.meta.url)),
  readFile(new URL('./sitemap.xml', import.meta.url)),
]);
const STATIC_FILES = new Map([
  ['/styles.css', [STYLES_CSS, 'text/css; charset=utf-8']],
  ['/client.js', [CLIENT_JS, 'text/javascript; charset=utf-8']],
  ['/robots.txt', [ROBOTS_TXT, 'text/plain; charset=utf-8']],
  ['/llms.txt', [LLMS_TXT, 'text/plain; charset=utf-8']],
  ['/sitemap.xml', [SITEMAP_XML, 'application/xml; charset=utf-8']],
]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/api/scan') return await handleTier('scan', req, res, runTier);
    if (req.method === 'POST' && url.pathname === '/api/audit') return await handleTier('audit', req, res, runTier);
    if (req.method === 'GET' && url.pathname === '/audit') {
      res.writeHead(308, { location: '/', 'cache-control': 'public, max-age=0, must-revalidate' });
      return res.end();
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/report/'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(INDEX_HTML);
    }
    if (req.method === 'GET' && STATIC_FILES.has(url.pathname)) {
      const [asset, contentType] = STATIC_FILES.get(url.pathname);
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
