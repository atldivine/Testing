// Good Shepard Auto Body site server: static files + the booking API. Run: node serve.js [port]
// Settings live in .env (copy .env.example). Without a Stripe key, deposits run in demo mode.
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./server/config');
const api = require('./server/api');

const root = __dirname;
const port = Number(process.argv[2]) || config.port;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const MEDIA = new Set(['.png', '.jpg', '.webp', '.svg', '.mp4', '.ico', '.woff2']);
// never served: source, raw downloads, the database, secrets, tooling
const PRIVATE = new Set(['server', 'data', '_src', '_ig', '_ig2', 'node_modules', 'serve.js', 'PRODUCT.md', 'BOOKING.md', 'package.json', 'render.yaml', 'skills-lock.json']);

// every page loads only its own scripts; fonts come from Google, review photos from Google's image host
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // browsers that have seen the site once refuse plain http for a year
  ...(config.siteUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

http
  .createServer((req, res) => {
    for (const [k, v] of Object.entries(security)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return api.handle(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    if (rel.includes('\0') || rel.includes('\\')) { res.writeHead(400).end(); return; }
    const file = path.join(root, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    // checked on the resolved path, lowercased, so no spelling of a private folder slips through
    const parts = path.relative(root, file).toLowerCase().split(path.sep);
    if (parts.some((p) => p.startsWith('.')) || PRIVATE.has(parts[0])) { res.writeHead(404).end('Not found'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', st.mtime.toUTCString());
      // pages, styles and scripts change without new names: always revalidate (cheap 304s). Media can sit for an hour.
      res.setHeader('Cache-Control', MEDIA.has(ext) ? 'public, max-age=3600' : 'no-cache');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }

      // byte ranges: iPhone Safari won't play a video unless the server answers Range requests with 206
      let start = 0, end = st.size - 1, status = 200;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
        else start = Math.max(0, st.size - Number(m[2])); // suffix range: the last N bytes
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
          return;
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      }
      res.writeHead(status, { 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end })
        .on('error', () => res.destroy())
        .pipe(res);
    });
  })
  .listen(port, () => console.log(`Good Shepard Auto Body on http://localhost:${port}${config.demoPayments ? ' (demo payments: no Stripe key)' : ''}`));
