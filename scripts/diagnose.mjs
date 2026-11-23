// Command-line helper for the landmark diagnostics. The graphical editor is
// the primary entry point; this script only reproduces an evidence chain in
// Node (no browser) so CI can pin the deterministic re-run fingerprint and
// inspect a repair decision without launching Chromium.
//
// Usage:
//   node scripts/diagnose.mjs                      # all routes × guide landmarks
//   node scripts/diagnose.mjs --route tram-line --landmark mutual-spire
//   node scripts/diagnose.mjs --closure            # apply each route's demo closure
//   node scripts/diagnose.mjs --budget 3           # coarser evidence cadence
//   node scripts/diagnose.mjs --out artifacts/diag # write evidence JSON there
//
// Exit code is non-zero if two runs of the same configuration hash differently
// or if a mismatch is emitted without an observed cause (a phantom report).

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCENES, materializeScene } from '../content/scenes.js';
import { LANDMARK_CATALOG, DISTRICT } from '../content/world.js';
import { sampleRoute } from '../kernel/visibility.js';
import { landmarkFromCatalog, withLandmarkOccluders } from '../kernel/placement.js';
import {
  makeCorridor, runEvidenceChain, decideRepair, locateMismatch,
  splitRouteAtSightlines, boundingVolumeErrors, DEFAULT_BUDGET,
} from '../kernel/diagnostics.js';

function parseArgs(argv) {
  const args = { closure: false, out: null, route: null, landmark: null, budget: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--closure') args.closure = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--route') args.route = argv[++i];
    else if (a === '--landmark') args.landmark = argv[++i];
    else if (a === '--budget') args.budget = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = args.out ? resolve(ROOT, args.out) : null;

const scene = SCENES['harbor-quarter'];
const mat = materializeScene(scene, sampleRoute);
const budget = args.budget
  ? { ...DEFAULT_BUDGET, strideSamples: args.budget, maxEvidencePerLandmark: 80 }
  : DEFAULT_BUDGET;

// The diagnostics run against the authored guide landmarks (historic clock,
// fixed roadside sign and the mutual-occlusion pair), with their own bodies in
// the occluder set so mutual occlusion is measurable.
const authored = [
  ...scene.historicPoints.map((h) => ({
    ...landmarkFromCatalog(LANDMARK_CATALOG, h.type, h.position, h.yaw, h.id),
    ignoreOccluderIds: h.ignoreOccluderIds ?? [],
  })),
  ...(scene.roadsideSign ? [landmarkFromCatalog(LANDMARK_CATALOG, scene.roadsideSign.type,
    scene.roadsideSign.position, scene.roadsideSign.yaw, scene.roadsideSign.id)] : []),
  ...scene.mutualPair.map((p) => landmarkFromCatalog(LANDMARK_CATALOG, p.type, p.position, p.yaw, p.id)),
];
const occluders = withLandmarkOccluders(DISTRICT.occluders, authored);

const report = {
  generatedAt: new Date().toISOString(),
  scene: scene.id,
  budget,
  closureApplied: args.closure,
  routes: {},
  failures: [],
};

for (const route of mat.routes) {
  if (args.route && route.id !== args.route) continue;
  const corridor = makeCorridor(route, args.closure && route.demoClosure
    ? { closures: [route.demoClosure] }
    : {});
  report.routes[route.id] = {
    viewpoint: route.viewpoint,
    closure: args.closure ? route.demoClosure : null,
    savePoint: route.savePoint,
    forks: route.forks,
    landmarks: {},
  };
  for (const lm of authored) {
    if (args.landmark && lm.id !== args.landmark) continue;
    const chain = runEvidenceChain({ route, corridor, landmark: lm, occluders, budget });
    // Determinism: a second run must hash identically.
    const rerun = runEvidenceChain({ route, corridor, landmark: lm, occluders, budget });
    if (rerun.fingerprint !== chain.fingerprint) {
      report.failures.push({ kind: 'fingerprint-drift', routeId: route.id, landmarkId: lm.id,
        a: chain.fingerprint, b: rerun.fingerprint });
    }
    // No phantom reports: every occlusion mismatch names a blocker.
    for (const mm of chain.mismatches) {
      if (mm.cause === 'critical-occlusion' && mm.blockers.length === 0) {
        report.failures.push({ kind: 'phantom-mismatch', routeId: route.id, landmarkId: lm.id, atS: mm.atS });
      }
    }
    const bvErrors = boundingVolumeErrors(chain);
    report.routes[route.id].landmarks[lm.id] = {
      fingerprint: chain.fingerprint,
      logCost: chain.logCost,
      intervals: {
        visible: chain.intervals.visible,
        onScreenArea: chain.intervals.onScreenArea,
        transitions: chain.intervals.transitions,
      },
      mismatches: chain.mismatches,
      boundingVolumeErrors: bvErrors,
    };
  }

  // Boundary repair decision for the mutual-occlusion spire (the brief's
  // walk-from-save-point case), using the route's authored save point/forks.
  const spire = authored.find((l) => l.id === 'mutual-spire');
  if (spire && (!args.landmark || args.landmark === spire.id)) {
    const decision = decideRepair({
      route, corridor, landmark: spire, occluders,
      savePoint: route.savePoint, closure: args.closure ? route.demoClosure : null,
      forks: route.forks, budget,
    });
    const located = locateMismatch({ route, corridor, landmark: spire, occluders, budget });
    const split = splitRouteAtSightlines({
      route, corridor, landmark: spire, occluders,
      extraCuts: args.closure && route.demoClosure ? [route.demoClosure.to] : [],
    });
    report.routes[route.id].repairDecision = {
      recommendation: decision.recommendation,
      boundary: decision.boundary,
      everGuided: decision.everGuided,
      firstLossS: decision.firstLossS,
      forkEntered: decision.forkEntered,
      lossWindow: decision.lossWindow,
      rootOccluder: located.rootOccluder,
      counterfactualTrials: located.trials,
      splitSegments: split.segments,
      fingerprint: decision.fingerprint,
    };
  }
}

report.pass = report.failures.length === 0;

if (OUT) {
  await mkdir(OUT, { recursive: true });
  const name = `diagnostics-${args.closure ? 'closure' : 'open'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(join(OUT, name), JSON.stringify(report, null, 2));
  console.log(`evidence written to ${join(args.out ?? OUT, name)}`);
}

// Human-readable summary (the JSON file is the machine evidence).
for (const [routeId, r] of Object.entries(report.routes)) {
  console.log(`\n${routeId}${r.closure ? ` (closure ${r.closure.id})` : ''}`);
  for (const [id, e] of Object.entries(r.landmarks)) {
    console.log(`  ${id}: fp=${e.fingerprint} visible=[${e.intervals.visible.map((i) => `${i.from.toFixed(0)}-${i.to.toFixed(0)}`).join('; ')}] mismatches=${e.mismatches.length} bvErr=${e.boundingVolumeErrors.length} evidence=${e.logCost.fullEvidenceRecords}/${e.logCost.samples}`);
    for (const mm of e.mismatches) {
      console.log(`    · ${mm.kind} ${mm.cause} @${mm.atS.toFixed(1)}m [${mm.stage}] ${mm.blockers.map((b) => b.id).join(',') || mm.measured.reasons.join(',')}`);
    }
  }
  if (r.repairDecision) {
    const d = r.repairDecision;
    console.log(`  repair: ${d.recommendation} — ${d.boundary}`);
    console.log(`    root=${d.rootOccluder} firstLoss=${d.firstLossS} fork=${d.forkEntered?.id ?? 'none'} splitNodes=${d.splitSegments.filter((g) => g.needsGuideNode).length}`);
  }
}
console.log(`\ndiagnostics: ${report.pass ? 'PASS' : 'FAIL'} (${report.failures.length} failure${report.failures.length === 1 ? '' : 's'})`);
process.exit(report.pass ? 0 : 1);
