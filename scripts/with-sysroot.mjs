// Re-exec a script with the private Chromium sysroot on LD_LIBRARY_PATH.
//
// On an aarch64 host without root, the distro Chromium that Playwright downloads
// cannot find its shared libraries. tools/sysroot holds arm64 copies extracted
// from `apt-get download`; this wrapper prepends them when they exist. On a
// machine where Chromium launches normally, it is a no-op.
//
// Usage: node scripts/with-sysroot.mjs verify/verify.mjs

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LIB = [
  resolve(ROOT, 'tools/sysroot/lib/aarch64-linux-gnu'),
  resolve(ROOT, 'tools/sysroot/usr/lib/aarch64-linux-gnu'),
  resolve(ROOT, 'tools/sysroot/usr/lib/aarch64-linux-gnu/nss'),
].filter((p) => existsSync(p));

if (LIB.length) {
  const sep = ':';
  const existing = process.env.LD_LIBRARY_PATH;
  const merged = existing ? LIB.join(sep) + sep + existing : LIB.join(sep);
  if (!process.env.LD_LIBRARY_PATH?.startsWith(LIB[0])) {
    process.env.LD_LIBRARY_PATH = merged;
  }
}

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/with-sysroot.mjs <script.mjs>');
  process.exit(2);
}
// Import (not spawn) so top-level await and process.exit in the target behave
// exactly as they do when run directly.
await import(pathToFileURL(resolve(process.cwd(), target)).href);
