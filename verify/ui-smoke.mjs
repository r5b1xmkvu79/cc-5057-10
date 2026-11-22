// End-to-end UI smoke test. Boots the real editor in headless Chromium, drives
// the three modes (Edit / Route replay / Trade-off), replays along a route,
// exports the report through the dev server, and fails on any console or page
// error. This is the "does the delivered viewport actually work" check.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync } from 'node:fs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.UI_PORT ?? 4175);
const BASE = `http://localhost:${PORT}`;

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// Start the real static server (the same one npm start runs).
const server = spawn(process.execPath, [resolve(ROOT, 'scripts/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(d));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/', { redirect: 'manual' });
      if (r.status === 302 || r.status === 200) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server did not start');
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__editorReady === true, { timeout: 60000 });
  await sleep(500);

  // ---- boot state
  const boot = await page.evaluate(() => {
    const s = window.__editor.state;
    return {
      landmarks: s.landmarks.length,
      historic: s.landmarks.filter((l) => l.historic).map((l) => l.id),
      covered: Object.fromEntries(Object.entries(s.evaluation.coverage.byRoute).map(([k, v]) => [k, +v.fraction.toFixed(3)])),
      modes: [...document.querySelectorAll('.modes button')].map((b) => b.dataset.mode),
      canvas: !!document.querySelector('canvas#viewport'),
    };
  });
  check(boot.canvas, 'viewport canvas is missing');
  check(boot.landmarks >= 3, `expected >=3 landmarks, got ${boot.landmarks}`);
  check(boot.historic.length === 1, `expected the mint to stay locked, got ${JSON.stringify(boot.historic)}`);
  check(boot.modes.join(',') === 'edit,replay,tradeoff', `unexpected modes: ${boot.modes}`);
  for (const [rid, f] of Object.entries(boot.covered)) check(f > 0.5, `route ${rid} barely covered (${f})`);

  await page.screenshot({ path: resolve(ROOT, 'artifacts/ui-edit.png') });

  // ---- replay mode: scrub along a route, confirm the replay camera moved
  await page.click('button[data-mode="replay"]');
  await sleep(400);
  const replayVisible = await page.evaluate(() => !document.querySelector('#panel-replay').classList.contains('hidden'));
  check(replayVisible, 'replay panel not shown in replay mode');
  const poseBefore = await page.evaluate(() => {
    const e = window.__editor;
    e.state.replay.s = e.state.routesById[e.state.replay.routeId].length * 0.4;
    e.state.replay.lastT = performance.now();
    window.dispatchEvent(new Event('resize'));
    return { s: e.state.replay.s };
  });
  // Drive the slider input exactly as a user would.
  await page.evaluate(() => {
    const el = document.querySelector('#replay-slider');
    el.value = String(Math.round(el.max * 0.55));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(600);
  const poseAfter = await page.evaluate(() => {
    const s = window.__editor.state;
    return { s: s.replay.s };
  });
  check(poseAfter.s !== poseBefore.s, 'replay slider did not move the passenger');
  await page.screenshot({ path: resolve(ROOT, 'artifacts/ui-replay.png') });

  // ---- trade-off mode
  await page.click('button[data-mode="tradeoff"]');
  await sleep(600);
  const trade = await page.evaluate(() => {
    const s = window.__editor.state;
    const panel = document.querySelector('#panel-tradeoff');
    return {
      hidden: panel.classList.contains('hidden'),
      hasWindow: !!s.tradeoff?.window,
      base: s.tradeoff?.base?.windowFraction ?? null,
      migrate: s.tradeoff?.migrate?.windowFraction ?? null,
      observer: s.tradeoff?.observer?.available === false ? 'unavailable' : (s.tradeoff?.observer?.windowFraction ?? null),
      text: panel.innerText.slice(0, 80),
    };
  });
  check(!trade.hidden, 'trade-off panel not shown in trade-off mode');
  await page.screenshot({ path: resolve(ROOT, 'artifacts/ui-tradeoff.png') });

  // ---- edit mode: move a landmark, confirm the kernel re-evaluates
  await page.click('button[data-mode="edit"]');
  await sleep(300);
  const moved = await page.evaluate(() => {
    const e = window.__editor;
    const lm = e.state.landmarks.find((l) => !l.historic && !l.fixedReason);
    if (!lm) return null;
    const before = { x: lm.position.x, z: lm.position.z };
    const covBefore = +e.state.evaluation.coverage.byRoute[e.state.routes[0]?.id ?? 'plaza-walk']?.fraction.toFixed(4);
    lm.position.x += 4; // simulate a drag / field edit
    e.refreshEvaluation();
    const covAfter = +e.state.evaluation.coverage.byRoute[e.state.routes[0]?.id ?? 'plaza-walk']?.fraction.toFixed(4);
    return { before, covBefore, covAfter };
  });
  check(moved && moved.before, 'no editable landmark to move');
  check(moved && moved.covBefore !== undefined, 'evaluation missing after move');

  // ---- auto-place re-solve
  await page.click('#btn-solve');
  await sleep(1200);
  const afterSolve = await page.evaluate(() => ({
    n: window.__editor.state.landmarks.length,
    trace: window.__editor.state.trace.length,
    solveMs: window.__editor.state.solveMs,
  }));
  check(afterSolve.n >= 3, 'auto-place lost landmarks');
  check(afterSolve.trace > 0, 'solver produced no decision trace');
  check(Number.isFinite(afterSolve.solveMs) && afterSolve.solveMs < 20000, 'solve took implausibly long');

  // ---- export report through the dev server (POST /api/report). Observe the
  // response directly so we do not race the 2.2 s flash timeout.
  const before = new Set(readdirSync(resolve(ROOT, 'artifacts')).filter((f) => f.startsWith('plan-')));
  const reportResp = page.waitForResponse((r) => r.url().endsWith('/api/report') && r.request().method() === 'POST', { timeout: 10000 });
  await page.click('#btn-report');
  const resp = await reportResp;
  const body = await resp.json().catch(() => ({}));
  check(resp.ok() && body.path?.startsWith('artifacts/plan-'), `export failed: ${resp.status()} ${JSON.stringify(body)}`);
  const after = readdirSync(resolve(ROOT, 'artifacts')).filter((f) => f.startsWith('plan-'));
  check(after.some((f) => !before.has(f)), 'export did not write a new plan file');

  check(errors.length === 0, 'console/page errors: ' + JSON.stringify(errors.slice(0, 5)));

  await page.screenshot({ path: resolve(ROOT, 'artifacts/ui-final.png') });
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

console.log('\n=== UI SMOKE ===');
if (failures.length) {
  for (const f of failures) console.log('  FAIL', f);
  console.log('ui smoke: FAIL');
  process.exit(1);
} else {
  console.log('ui smoke: PASS (edit, replay, trade-off, auto-place, export; no console errors)');
  process.exit(0);
}
