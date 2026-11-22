// Minimal static server: no bundler, ES modules load directly. Also serves a
// small JSON API for the verifier so the UI and node scripts share scenarios.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const ARTIFACTS = join(ROOT, 'artifacts');
async function readBody(req, limit = 4_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/report') {
      const body = await readBody(req);
      const report = JSON.parse(body);
      if (!report || typeof report !== 'object' || !Array.isArray(report.landmarks)) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad report"}'); return;
      }
      await mkdir(ARTIFACTS, { recursive: true });
      const name = `plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const abs = join(ARTIFACTS, name);
      await writeFile(abs, JSON.stringify(report, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: 'artifacts/' + name }));
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = normalize(decodeURIComponent(url.pathname));
    if (path === '/' || path === '') {
      res.writeHead(302, { location: '/app/index.html' });
      res.end();
      return;
    }
    // Serve node_modules/three for the browser import map.
    const abs = path.startsWith('/node_modules/')
      ? join(ROOT, path)
      : join(ROOT, path);
    if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const s = await stat(abs).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); res.end('not found: ' + path); return; }
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`Harbor Quarter guide editor → http://localhost:${PORT}/`);
  console.log(`Static root: ${ROOT}`);
});
