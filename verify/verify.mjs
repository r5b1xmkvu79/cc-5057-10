// Verification harness. Re-runs the *authored* plan from content/scenes.js in
// Node (no browser), then renders the passenger's-eye frames in headless
// Chromium and checks the kernel's measurements against the actual render.
//
// Outputs: artifacts/verify/*.png and artifacts/verify/report.json

import { chromium } from 'playwright';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCENES, materializeScene } from '../content/scenes.js';
import { LANDMARK_CATALOG, DISTRICT } from '../content/world.js';
import { sampleRoute, makeCamera, measureLandmark } from '../kernel/visibility.js';
import { solvePlacement, landmarkFromCatalog, withLandmarkOccluders } from '../kernel/placement.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'artifacts', 'verify');
const PORT = Number(process.env.VERIFY_PORT ?? 4174);

function serve() {
  return new Promise((res) => {
    const server = createServer(async (req, rsp) => {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      const abs = join(ROOT, p);
      try {
        const buf = await readFile(abs);
        rsp.writeHead(200, { 'content-type': MIME[extname(abs)] ?? 'application/octet-stream' });
        rsp.end(buf);
      } catch {
        try {
          const html = await readFile(join(ROOT, p, 'index.html'));
          rsp.writeHead(200, { 'content-type': 'text/html' });
          rsp.end(html);
        } catch { rsp.writeHead(404); rsp.end('nf'); }
      }
    });
    server.listen(PORT, () => res(server));
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// ---------------------------------------------------------------------------
// 1. Author the plan in Node with the same kernel the UI uses.

const scene = SCENES['harbor-quarter'];
const mat = materializeScene(scene, sampleRoute);
const historicLandmarks = scene.historicPoints.map((h) => ({
  ...landmarkFromCatalog(LANDMARK_CATALOG, h.type, h.position, h.yaw, h.id),
  ignoreOccluderIds: h.ignoreOccluderIds ?? [],
}));
const rs = scene.roadsideSign;
const fixedLandmarks = rs ? [{ ...landmarkFromCatalog(LANDMARK_CATALOG, rs.type, rs.position, rs.yaw, rs.id), fixedReason: 'deliberate roadside sign' }] : [];

console.log('solving authored plan…');
const solved = solvePlacement({
  routesById: mat.routesById,
  context: {
    catalog: LANDMARK_CATALOG, occluders: DISTRICT.occluders, platforms: DISTRICT.platforms,
    landmarkTypes: scene.landmarkTypes, keySegments: mat.keySegments, historicLandmarks, fixedLandmarks,
  },
  options: { maxLandmarks: 6 },
});
const plan = solved.plan;
const landmarks = plan.landmarks.filter((lm) => !lm.historic);
const occ = DISTRICT.occluders;

const results = {
  generatedAt: new Date().toISOString(),
  plan: landmarks.map((l) => ({ id: l.id, type: l.type, x: l.position.x, z: l.position.z, yawDeg: (l.yaw * 180) / Math.PI })),
  routes: {},
  sharedSetpiece: {},
  tradeoff: null,
  renderChecks: [],
  failures: [],
};

for (const [routeId, route] of Object.entries(mat.routesById)) {
  const rc = solved.evaluation.coverage.byRoute[routeId];
  results.routes[routeId] = {
    viewpoint: route.viewpoint,
    coveredFraction: +rc.fraction.toFixed(3),
    longestBlindRunM: +rc.longestGapLength.toFixed(2),
    keySegments: rc.keySegments.map((k) => ({ label: k.label, from: +k.from.toFixed(1), to: +k.to.toFixed(1), fraction: +k.fraction.toFixed(3), pass: k.pass })),
    firstLegibleByLandmark: {},
  };
  for (const lm of plan.landmarks) {
    const idx = solved.evaluation.perRoute[routeId].findIndex((s) => s.best[lm.id]?.readable);
    results.routes[routeId].firstLegibleByLandmark[lm.name] = idx >= 0 ? +solved.evaluation.perRoute[routeId][idx].s.toFixed(1) : null;
  }
}

// ---------------------------------------------------------------------------
// 2. Shared set-piece: prove the *same* blocker occludes the *same* sign on
//    both routes, and record where it is first revealed.

const sign = plan.landmarks.find((l) => l.id === scene.roadsideSign.id);
for (const [routeId, route] of Object.entries(mat.routesById)) {
  let firstBlockedByCistern = null;
  let firstRevealed = null; // cistern no longer votes, but sign still below threshold
  let firstReadable = null;
  let blockedSamples = 0;
  let revealedButUnreadableReasons = null;
  const profile = [];
  for (const samp of route.samples) {
    // At each sample we allow the route's full head pan, so this is the best a
    // passenger could do, not a strawman forward-only ray.
    let best = null;
    const pans = route.viewpoint.mode === 'fixed'
      ? [-route.viewpoint.panLimitDeg, 0, route.viewpoint.panLimitDeg]
      : [-route.viewpoint.panLimitDeg, -route.viewpoint.panLimitDeg / 2, 0, route.viewpoint.panLimitDeg / 2, route.viewpoint.panLimitDeg];
    for (const pan of pans) {
      const cam = makeCamera({
        position: { x: samp.position.x, y: samp.position.y + samp.eyeHeight, z: samp.position.z },
        yaw: samp.yaw + (pan * Math.PI) / 180, fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720,
      });
      const m = measureLandmark(cam, sign, occ);
      if (m && (!best || m.quality > best.quality)) best = m;
    }
    if (best?.blockerVotes?.['cistern-block']) {
      blockedSamples++;
      if (firstBlockedByCistern === null) firstBlockedByCistern = +samp.s.toFixed(1);
    }
    if (best?.readable && firstReadable === null) firstReadable = +samp.s.toFixed(1);
    if (!best?.blockerVotes?.['cistern-block'] && firstRevealed === null) {
      firstRevealed = +samp.s.toFixed(1);
      if (!best?.readable) revealedButUnreadableReasons = best?.reasons ?? null;
    }
    profile.push({ s: +samp.s.toFixed(1), readable: !!best?.readable, blockedByCistern: !!(best?.blockerVotes?.['cistern-block']) });
  }
  results.sharedSetpiece[routeId] = {
    firstBlockedByCisternAtM: firstBlockedByCistern,
    firstRevealedAtM: firstRevealed,
    revealedButUnreadableReasons,
    firstReadableAtM: firstReadable,
    blockedSamples,
    reportedUnseen: firstReadable === null,
    profile,
  };
}

// ---------------------------------------------------------------------------
// 3. Locked historic building: re-walk both routes and check the *measured*
//    first legible contour positions are stable and the mint did not move.

const mint = plan.landmarks.find((l) => l.historic);
results.lockedHistoric = {
  id: mint.id,
  position: { x: mint.position.x, z: mint.position.z },
  yawDeg: (mint.yaw * 180) / Math.PI,
  firstContours: Object.fromEntries(Object.entries(mat.routesById).map(([id]) => [id, results.routes[id].firstLegibleByLandmark[mint.name] ?? null])),
};

// ---------------------------------------------------------------------------
// 4. Trade-off measurement (Node side, same kernel).

const pair = scene.mutualPair.map((p) => landmarkFromCatalog(LANDMARK_CATALOG, p.type, p.position, p.yaw, p.id));
const { compareTradeoff } = await import('../kernel/placement.js');
// Same context the editor's trade-off mode uses: the pair's own bodies are
// occluders, and every landmark in the *delivered* plan (including the locked
// historic body) contributes its mass. Using a different occluder set here
// would make the report disagree with the numbers on screen.
const trade = compareTradeoff({
  plan: { landmarks: plan.landmarks, keySegments: mat.keySegments },
  routesById: mat.routesById,
  context: { occluders: withLandmarkOccluders(occ, [...plan.landmarks, ...pair]), platforms: DISTRICT.platforms },
  options: { routeId: scene.mutualRouteId, objects: pair },
});
results.tradeoff = trade;

// ---------------------------------------------------------------------------
// 5. Render actual passenger frames and compare the rendered visible-sign
//    pixels against the kernel's predicted visible area. The plan is the one
//    authored above — the browser never re-solves.

await mkdir(OUT, { recursive: true });
const server = await serve();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://localhost:${PORT}/verify/render.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__renderReady === true, { timeout: 60000 });

// Serialise the delivered plan exactly as solved in Node.
const planForPage = plan.landmarks.map((lm) => ({
  id: lm.id, type: lm.type, name: lm.name, color: lm.color,
  position: lm.position, yaw: lm.yaw, sign: lm.sign, body: lm.body, historic: !!lm.historic,
}));
await page.evaluate((p) => window.__setPlan(p), planForPage);

for (const [routeId, route] of Object.entries(mat.routesById)) {
  const fractions = route.viewpoint.mode === 'fixed' ? [0.16, 0.34, 0.52, 0.7, 0.9] : [0.18, 0.42, 0.66, 0.88];
  for (const frac of fractions) {
    const targetS = route.length * frac;
    const samp = route.samples.reduce((a, b) => (Math.abs(b.s - targetS) < Math.abs(a.s - targetS) ? b : a));
    const pans = [-route.viewpoint.panLimitDeg, -route.viewpoint.panLimitDeg / 2, 0, route.viewpoint.panLimitDeg / 2, route.viewpoint.panLimitDeg]
      .filter((v, i, arr) => arr.indexOf(v) === i);

    const sampArg = { position: { x: samp.position.x, y: samp.position.y, z: samp.position.z }, yaw: samp.yaw, eyeHeight: samp.eyeHeight };
    const scored = await page.evaluate(async ({ samp, pans }) => {
      const mod = await import('/kernel/visibility.js');
      const occ = (await import('/content/world.js')).DISTRICT.occluders;
      const list = window.__landmarksNow();
      const out = [];
      for (const pan of pans) {
        const cam = mod.makeCamera({ position: { x: samp.position.x, y: samp.position.y + samp.eyeHeight, z: samp.position.z }, yaw: samp.yaw + pan * Math.PI / 180, fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720 });
        let n = 0, bestQ = -1, bestId = null;
        for (const lm of list) {
          const m = mod.measureLandmark(cam, lm, occ);
          if (m?.readable) { n++; if (m.quality > bestQ) { bestQ = m.quality; bestId = lm.id; } }
        }
        out.push({ pan, n, bestId, bestQ });
      }
      return out;
    }, { samp: sampArg, pans });
    const chosen = scored.sort((a, b) => b.n - a.n || b.bestQ - a.bestQ)[0];

    const kernel = await page.evaluate(async ({ samp, pan, lmId }) => {
      const mod = await import('/kernel/visibility.js');
      const occ = (await import('/content/world.js')).DISTRICT.occluders;
      const list = window.__landmarksNow();
      const lm = list.find((l) => l.id === lmId);
      if (!lm) return null;
      const cam = mod.makeCamera({ position: { x: samp.position.x, y: samp.position.y + samp.eyeHeight, z: samp.position.z }, yaw: samp.yaw + pan * Math.PI / 180, fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720 });
      const m = mod.measureLandmark(cam, lm, occ);
      return m ? { readable: m.readable, areaPx: m.visibleAreaPx, rawAreaPx: m.rawAreaPx, onScreenAreaPx: m.onScreenAreaPx, visibleFraction: m.visibleFraction, reasons: m.reasons, distance: m.distance } : null;
    }, { samp: sampArg, pan: chosen.pan, lmId: chosen.bestId });

    await page.evaluate(({ samp, pan }) => window.__renderFrame(samp, pan), { samp: sampArg, pan: chosen.pan });
    await page.waitForTimeout(100);
    const file = join(OUT, `${routeId}-${Math.round(frac * 100)}.png`);
    await page.screenshot({ path: file });

    const pixel = chosen.bestId
      ? await page.evaluate(({ samp, pan, lmId }) => window.__countLandmarkPixels(samp, pan, lmId), { samp: sampArg, pan: chosen.pan, lmId: chosen.bestId })
      : null;

    const check = {
      routeId, frac, s: +samp.s.toFixed(1), panDeg: chosen.pan,
      readableCount: chosen.n, chosenLandmark: chosen.bestId,
      measured: kernel, rendered: pixel, file: file.replace(ROOT + '/', ''),
    };
    if (pixel && kernel) {
      // Rendered visible pixels vs analytic visible area. Allow generous slack:
      // at grazing angles the analytic hull over-counts a perspective quad.
      const visibleRatio = pixel.visiblePixels / Math.max(1, Math.round(kernel.areaPx));
      const projectedRatio = pixel.projectedPixels / Math.max(1, Math.round(kernel.onScreenAreaPx ?? kernel.rawAreaPx));
      const occlusionAgreement = kernel.visibleFraction;
      const renderedOcclusion = pixel.projectedPixels > 0 ? pixel.visiblePixels / pixel.projectedPixels : 0;
      check.visibleRatio = +visibleRatio.toFixed(2);
      check.projectedRatio = +projectedRatio.toFixed(2);
      check.renderedOcclusion = +renderedOcclusion.toFixed(2);
      check.agree = visibleRatio > 0.25 && visibleRatio < 4.0
        && projectedRatio > 0.3 && projectedRatio < 3.0
        && Math.abs(renderedOcclusion - occlusionAgreement) < 0.28;
      if (!check.agree) {
        results.failures.push({ kind: 'render-mismatch', routeId, s: check.s, panDeg: chosen.pan, visibleRatio: check.visibleRatio, projectedRatio: check.projectedRatio, kernelVisibleFraction: occlusionAgreement, renderedOcclusion: check.renderedOcclusion });
      }
    } else if (kernel && kernel.readable) {
      results.failures.push({ kind: 'render-missing', routeId, s: check.s });
    }
    results.renderChecks.push(check);
  }
}

results.pageErrors = pageErrors;
results.pass = results.failures.length === 0 && pageErrors.length === 0
  && Object.values(results.routes).every((r) => r.keySegments.every((k) => k.pass));

await writeFile(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
server.close();

console.log('\n=== VERIFY REPORT ===');
for (const [id, r] of Object.entries(results.routes)) {
  console.log(`${id}: covered ${(r.coveredFraction * 100).toFixed(0)}%  longest blind ${r.longestBlindRunM} m  key=${r.keySegments.map((k) => `${k.label}:${k.pass ? 'PASS' : 'FAIL'}`).join(' ')}`);
}
for (const [id, sp] of Object.entries(results.sharedSetpiece)) {
  if (sp.reportedUnseen) {
    console.log(`shared set-piece on ${id}: hidden by cistern from ${sp.firstBlockedByCisternAtM} m; cistern clears at ${sp.firstRevealedAtM} m but the fixed viewpoint never delivers a legible shape (${(sp.revealedButUnreadableReasons ?? []).join(', ')}) — REPORTED UNSEEN`);
  } else {
    console.log(`shared set-piece on ${id}: hidden by cistern from ${sp.firstBlockedByCisternAtM} m, first legible at ${sp.firstReadableAtM} m (${sp.blockedSamples} blocked samples)`);
  }
}
console.log(`locked historic: mint fixed at (${results.lockedHistoric.position.x}, ${results.lockedHistoric.position.z}), first legible ${JSON.stringify(results.lockedHistoric.firstContours)}`);
const t = results.tradeoff;
if (t?.window) console.log(`trade-off window ${t.window.from.toFixed(0)}-${t.window.to.toFixed(0)} m: base ${(t.base.windowFraction * 100).toFixed(0)}%, migrate ${t.migrate ? (t.migrate.windowFraction * 100).toFixed(0) + '%' : 'n/a'}, observer ${t.observer?.available ? (t.observer.windowFraction * 100).toFixed(0) + '%' : 'unavailable'}`);
console.log(`render checks: ${results.renderChecks.length}, failures: ${results.failures.length}`);
for (const f of results.failures) console.log('  FAIL', JSON.stringify(f));
console.log('page errors:', pageErrors.length ? pageErrors : 'none');
console.log('overall:', results.pass ? 'PASS' : 'FAIL');
process.exit(results.pass ? 0 : 1);
