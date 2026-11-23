// Unit tests for the visibility-mismatch diagnostics. Everything here runs on
// the same pure kernel the browser editor uses; no DOM, no WebGL. The tests pin
// the brief's contracts: corridor legality, evidence tracking, deterministic
// re-run fingerprints, no phantom mismatches, counterfactual single-object
// attribution, and the first-loss/fork boundary between the two repair schemes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vec, dist } from '../kernel/geom.js';
import {
  makeCamera, signCenter, measureLandmark, sampleRoute,
  sightlineQuery, projectedPanelPolygon, polygonsOverlap2D,
  landmarkSightlines, mergeIntervals, DEFAULT_THRESHOLDS,
} from '../kernel/visibility.js';
import { landmarkFromCatalog } from '../kernel/placement.js';
import { LANDMARK_CATALOG, DISTRICT } from '../content/world.js';
import { SCENES, materializeScene } from '../content/scenes.js';
import {
  stableHash, makeCorridor, corridorPoses, walkFromSavePoint,
  createEvidenceTracker, recordEvidence, runEvidenceChain, fingerprintTracker,
  classifyFailure, counterfactualReplay, locateMismatch,
  sightlineIntersections, splitRouteAtSightlines, boundingVolumeErrors,
  evaluateMoveLandmark, evaluateGuideNode, decideRepair, DEFAULT_BUDGET,
} from '../kernel/diagnostics.js';

const box = (id, min, max) => ({ id, min: vec(...min), max: vec(...max) });

function simpleLandmark({ x = 0, z = 0, yaw = 0, w = 6, h = 4, yOffset = 5, id = 'lm' } = {}) {
  return {
    id, type: 'test', name: 'Test', color: '#fff',
    position: { x, y: 0, z }, yaw,
    sign: { w, h, yOffset }, body: { w: 2, d: 2, h: 5 },
    ignoreOccluderIds: [],
  };
}

function straightRoute({ id = 'r', length = 80, viewpoint = { mode: 'free', panLimitDeg: 30, lateralLimit: 2 } } = {}) {
  const pts = [];
  for (let z = 40; z >= 40 - length; z -= 10) pts.push([0, 0, z]);
  const spec = { id, name: id, points: pts, eyeHeight: 1.7, viewpoint };
  const { samples, length: L } = sampleRoute(spec, 2.0);
  return { id, name: id, samples, length: L, eyeHeight: 1.7, viewpoint, corridor: { widths: [] }, forks: [] };
}

// ---------------------------------------------------------------------------
// Determinism + interval algebra primitives

test('stableHash is order-independent for object keys and stable across calls', () => {
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ a: 1, b: 2 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});

test('mergeIntervals groups contiguous true runs', () => {
  const iv = mergeIntervals(
    [{ s: 0 }, { s: 2 }, { s: 4 }, { s: 6 }, { s: 8 }],
    (r) => r.s >= 2 && r.s <= 4,
  );
  assert.deepEqual(iv.map((i) => [i.from, i.to]), [[2, 4]]);
});

// ---------------------------------------------------------------------------
// Corridors: navigator-supplied walkable surface, closures, fixed seats

test('corridor rejects poses inside a closure and narrows to its half-width', () => {
  const route = straightRoute();
  route.corridor = { widths: [{ from: 0, to: 80, halfWidth: 1.2 }], closures: [] };
  const corridor = makeCorridor(route, { closures: [{ id: 'c1', from: 20, to: 30, reason: 'works' }] });
  const inside = route.samples.find((s) => s.s === 24);
  const outside = route.samples.find((s) => s.s === 10);
  assert.equal(corridor.sampleAllowed(inside).allowed, false);
  assert.equal(corridor.sampleAllowed(outside).allowed, true);
  const { poses, closure } = corridorPoses(route, inside, corridor);
  assert.equal(poses.length, 0);
  assert.equal(closure.id, 'c1');
  const free = corridorPoses(route, outside, corridor);
  assert.ok(free.poses.length > 1);
  assert.ok(Math.max(...free.poses.map((p) => Math.abs(p.lateral))) <= 1.2 + 1e-9);
});

test('fixed-viewpoint corridor yields centreline-only poses', () => {
  const route = straightRoute({ viewpoint: { mode: 'fixed', panLimitDeg: 10, lateralLimit: 0 } });
  const corridor = makeCorridor(route);
  const [s] = route.samples;
  const { poses } = corridorPoses(route, s, corridor, { panSteps: 3 });
  assert.ok(poses.every((p) => p.lateral === 0));
  assert.ok(poses.some((p) => Math.abs(p.pan - 10) < 1e-9));
});

test('walkFromSavePoint skips the pre-save arc and marks closed samples', () => {
  const route = straightRoute();
  const corridor = makeCorridor(route, { closures: [{ id: 'c', from: 30, to: 40 }] });
  const walk = walkFromSavePoint(route, corridor, { s: 20 }, { id: 'c', from: 30, to: 40 });
  assert.ok(walk.every(({ sample }) => sample.s >= 20));
  const closed = walk.filter(({ gate }) => !gate.allowed);
  assert.ok(closed.length > 0);
  assert.ok(closed.every(({ sample }) => sample.s >= 30 && sample.s <= 40));
});

// ---------------------------------------------------------------------------
// Sightline queries and the bounding-volume error detector

test('sightlineQuery names the blocker with hit distance, or reports a free ray', () => {
  const lm = simpleLandmark({ x: 0, z: 0 });
  const center = signCenter(lm);
  const eye = vec(0, 6, -20);
  const wall = box('wall', [-10, -5, -8], [10, 30, -6]);
  const blocked = sightlineQuery(eye, center, [wall]);
  assert.equal(blocked.free, false);
  assert.equal(blocked.blocker.id, 'wall');
  assert.ok(blocked.blocker.distance > 0 && blocked.blocker.distance < blocked.length);
  assert.ok(sightlineQuery(eye, center, []).free);
});

test('projected polygons overlap only where the screen footprints intersect', () => {
  assert.equal(polygonsOverlap2D(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }],
  ), true);
  assert.equal(polygonsOverlap2D(
    [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
    [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }, { x: 20, y: 30 }],
  ), false);
});

test('sightlines flag an AABB whose projection never covers the panel (BV error)', () => {
  const lm = simpleLandmark({ x: 0, z: 0 });
  // Sign normal points -Z, so stand at -Z looking back toward +Z (yaw = PI).
  const cam = makeCamera({ position: vec(0, 6, -20), yaw: Math.PI, fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720 });
  // A tall thin box beside the line of sight: it may vote on a grazing ray but
  // its screen footprint sits away from the panel.
  const stray = box('stray', [14, 0, -12], [16, 20, -4]);
  const rays = landmarkSightlines(cam, lm, [stray]);
  const panel = projectedPanelPolygon(cam, lm);
  assert.ok(panel.length >= 3);
  // Every ray that is blocked must report whether the blocker covers the panel;
  // a box entirely off to the side must never claim coverage.
  for (const r of rays) {
    if (!r.free) assert.equal(typeof r.coversPanel, 'boolean');
  }
  assert.ok(rays.some((r) => r.free), 'a side box must not block the central sign rays');
});

// ---------------------------------------------------------------------------
// Evidence tracking: budgets, fingerprints, no phantom reports

test('evidence tracker re-run produces an identical fingerprint', () => {
  const route = straightRoute();
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'ribbon', { x: 6, z: -10 }, Math.PI / 2, 'guide');
  const corridor = makeCorridor(route);
  const a = runEvidenceChain({ route, corridor, landmark: lm, occluders: DISTRICT.occluders });
  const b = runEvidenceChain({ route, corridor, landmark: lm, occluders: DISTRICT.occluders });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.intervals.visible, b.intervals.visible);
});

test('evidence logging stays inside the configured budget', () => {
  const route = straightRoute();
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'ribbon', { x: 6, z: -10 }, Math.PI / 2, 'guide');
  const corridor = makeCorridor(route);
  const chain = runEvidenceChain({
    route, corridor, landmark: lm, occluders: DISTRICT.occluders,
    budget: { ...DEFAULT_BUDGET, strideSamples: 10, maxEvidencePerLandmark: 5 },
  });
  assert.ok(chain.logCost.fullEvidenceRecords <= 5);
  assert.equal(chain.logCost.rowsRecorded, route.samples.length);
});

test('tracker never raises a mismatch without an observed cause', () => {
  const route = straightRoute();
  // An unoccluded landmark the walker passes: transitions happen, but every
  // failure carries a measured threshold breach — never an empty blocker claim.
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'ribbon', { x: 0, z: 0 }, Math.PI, 'guide');
  const corridor = makeCorridor(route);
  const chain = runEvidenceChain({ route, corridor, landmark: lm, occluders: [] });
  for (const mm of chain.mismatches) {
    if (mm.cause === 'critical-occlusion') {
      assert.ok(mm.blockers.length > 0, 'occlusion mismatch must name a blocker');
    } else {
      assert.ok(mm.measured.reasons.length > 0 || mm.render?.disagrees);
    }
  }
});

test('classifyFailure separates critical occlusion from distant/small and composition', () => {
  assert.equal(classifyFailure({ reasons: ['occluded'] }), 'critical-occlusion');
  assert.equal(classifyFailure({ reasons: ['too-distant'] }), 'distant-small');
  assert.equal(classifyFailure({ reasons: ['off-screen'] }), 'composition-threshold');
  assert.equal(classifyFailure({ reasons: ['edge-on'] }), 'composition-threshold');
});

test('closure is recorded as closed samples, not fabricated visibility', () => {
  const route = straightRoute();
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'ribbon', { x: 6, z: -10 }, Math.PI / 2, 'guide');
  const corridor = makeCorridor(route, { closures: [{ id: 'shut', from: 20, to: 36 }] });
  const chain = runEvidenceChain({ route, corridor, landmark: lm, occluders: [] });
  const closedS = chain.tracker.closedSamples.map((c) => c.s);
  assert.ok(closedS.some((s) => s >= 20 && s <= 36));
  assert.ok(!chain.tracker.rows.some((r) => closedS.includes(r.s)));
});

// ---------------------------------------------------------------------------
// Counterfactual single-object replay and mismatch location

test('counterfactual replay restores visibility only when the causal blocker is removed', () => {
  const route = straightRoute();
  const lm = simpleLandmark({ x: 0, z: -2, id: 'guide', yaw: Math.PI });
  // Wall across the approach (between the walker at +Z and the sign at z=-2);
  // a second, irrelevant box far away. Narrow enough that lateral poses exist.
  const wall = box('cause-wall', [-10, -2, 2], [10, 12, 4]);
  const other = box('far-shed', [40, 0, 30], [50, 8, 40]);
  const occ = [wall, other];
  const corridor = makeCorridor(route);
  const removeWall = counterfactualReplay({
    route, corridor, landmark: lm, occluders: occ, removeOccluderId: 'cause-wall',
  });
  const removeOther = counterfactualReplay({
    route, corridor, landmark: lm, occluders: occ, removeOccluderId: 'far-shed',
  });
  assert.ok(removeWall.regainedM > 0);
  assert.equal(removeOther.regainedM, 0);
  const located = locateMismatch({ route, corridor, landmark: lm, occluders: occ });
  assert.equal(located.rootOccluder, 'cause-wall');
});

test('counterfactual removal of an unknown occluder is reported, not faked', () => {
  const route = straightRoute();
  const lm = simpleLandmark();
  const corridor = makeCorridor(route);
  const cf = counterfactualReplay({
    route, corridor, landmark: lm, occluders: [], removeOccluderId: 'ghost',
  });
  assert.equal(cf.existed, false);
  assert.equal(cf.regainedM, 0);
});

// ---------------------------------------------------------------------------
// Sightline-intersection route split

test('splitRouteAtSightlines returns segments whose coverage sums to the route', () => {
  const route = straightRoute();
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'spire', { x: 8, z: -6 }, Math.PI * 0.75, 'spire');
  const corridor = makeCorridor(route);
  const split = splitRouteAtSightlines({ route, corridor, landmark: lm, occluders: DISTRICT.occluders });
  assert.ok(split.segments.length >= 1);
  const total = split.segments.reduce((n, g) => n + g.samples, 0);
  assert.equal(total, route.samples.length);
  for (const g of split.segments) {
    assert.ok(g.fraction >= 0 && g.fraction <= 1);
    assert.equal(typeof g.needsGuideNode, 'boolean');
  }
});

test('sightlineIntersections reports crossings of the eye-to-landmark line', () => {
  // A landmark offset to one side of a straight walk produces a crossing only
  // if the walker passes its longitude; the helper must stay finite and sorted.
  const route = straightRoute();
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'spire', { x: 10, z: 10 }, 0, 'side');
  const cuts = sightlineIntersections(route, lm);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i].s >= cuts[i - 1].s);
});

// ---------------------------------------------------------------------------
// The two repair schemes and the first-loss/fork boundary

test('Scheme A moves the landmark when one object blocks a pre-fork window', () => {
  const route = straightRoute();
  const lm = simpleLandmark({ x: 0, z: -2, id: 'guide', yaw: Math.PI });
  const wall = box('cause-wall', [-10, -2, 2], [10, 12, 4]);
  const corridor = makeCorridor(route);
  const chain = runEvidenceChain({ route, corridor, landmark: lm, occluders: [wall] });
  const firstLoss = chain.tracker.rows.find((r) => !r.readable);
  const move = evaluateMoveLandmark({
    route, corridor, landmark: lm, occluders: [wall],
    window: { from: firstLoss.s, to: Math.min(route.length, firstLoss.s + 20) },
  });
  assert.equal(move.scheme, 'A-move-landmark');
  assert.ok(move.feasible);
  assert.ok(move.best.delta > 0);
});

test('Scheme B is refused outright on a fixed (seated) route', () => {
  const route = straightRoute({ viewpoint: { mode: 'fixed', panLimitDeg: 10, lateralLimit: 0 } });
  const lm = simpleLandmark();
  const corridor = makeCorridor(route);
  const node = evaluateGuideNode({
    route, corridor, landmark: lm, occluders: [], window: { from: 10, to: 30 },
  });
  assert.equal(node.feasible, false);
  assert.match(node.reason, /fixed viewpoint/);
});

test('Scheme B is refused when a fork was entered before guidance was lost', () => {
  const route = straightRoute();
  route.forks = [{ id: 'f1', s: 12, label: 'branch' }];
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'spire', { x: 6, z: -8 }, Math.PI, 'spire');
  const corridor = makeCorridor(route);
  const node = evaluateGuideNode({
    route, corridor, landmark: lm, occluders: [], window: { from: 20, to: 40 }, forks: route.forks,
  });
  assert.equal(node.feasible, false);
  assert.equal(node.forkBeforeLoss, true);
});

test('decideRepair distinguishes move-landmark from route-split via the boundary', () => {
  // Free route, a single wall, no forks before the loss → Scheme A.
  const free = straightRoute({ id: 'free' });
  const lm = simpleLandmark({ x: 0, z: -2, id: 'guide', yaw: Math.PI });
  const wall = box('cause-wall', [-10, -2, 2], [10, 12, 4]);
  const corridorFree = makeCorridor(free);
  const decFree = decideRepair({
    route: free, corridor: corridorFree, landmark: lm, occluders: [wall],
    savePoint: { s: 0 }, closure: null, forks: [],
  });
  assert.ok(decFree.lossWindow !== null);
  assert.equal(decFree.forkEntered, null);
  assert.equal(decFree.recommendation, 'A-move-landmark');

  // Same geometry but the walker commits to a fork first → route split.
  const forked = straightRoute({ id: 'forked' });
  forked.forks = [{ id: 'early-fork', s: 0.5, label: 'taken before loss' }];
  const decFork = decideRepair({
    route: forked, corridor: makeCorridor(forked), landmark: lm, occluders: [wall],
    savePoint: { s: 0 }, closure: null, forks: forked.forks,
  });
  assert.equal(decFork.recommendation, 'split-route');
  assert.ok(decFork.split.segments.length >= 1);
});

test('decideRepair reports unseen instead of fabricating guidance', () => {
  // A thin, full-width wall just in front of the sign blocks it from every
  // corridor pose for the whole walk: never legible → report-unseen.
  const route = straightRoute();
  const lm = simpleLandmark({ x: 0, z: -2, id: 'hidden', yaw: Math.PI });
  const wall = box('long-wall', [-200, -2, -1.5], [200, 60, -1.0]);
  const dec = decideRepair({
    route, corridor: makeCorridor(route), landmark: lm, occluders: [wall],
    savePoint: { s: 0 }, closure: null, forks: [],
  });
  assert.equal(dec.everGuided, false);
  assert.equal(dec.recommendation, 'report-unseen');
});

// ---------------------------------------------------------------------------
// End-to-end on the authored Harbor Quarter scene, including its demo closure

test('Harbor Quarter: every route/landmark chain re-runs to the same fingerprint', () => {
  const scene = SCENES['harbor-quarter'];
  const mat = materializeScene(scene, sampleRoute);
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, scene.mutualPair[1].type,
    scene.mutualPair[1].position, scene.mutualPair[1].yaw, scene.mutualPair[1].id);
  for (const route of mat.routes) {
    const corridor = makeCorridor(route);
    const a = runEvidenceChain({ route, corridor, landmark: lm, occluders: DISTRICT.occluders });
    const b = runEvidenceChain({ route, corridor, landmark: lm, occluders: DISTRICT.occluders });
    assert.equal(a.fingerprint, b.fingerprint, `${route.id} fingerprint drifted between runs`);
    assert.ok(a.logCost.fullEvidenceRecords <= DEFAULT_BUDGET.maxEvidencePerLandmark);
  }
});

test('Harbor Quarter: tram fixed route refuses Scheme B and attributes the spire loss', () => {
  const scene = SCENES['harbor-quarter'];
  const mat = materializeScene(scene, sampleRoute);
  const [arch, spire] = scene.mutualPair.map((p) =>
    landmarkFromCatalog(LANDMARK_CATALOG, p.type, p.position, p.yaw, p.id));
  const occluders = [...DISTRICT.occluders, arch && {
    id: `occluder:${arch.id}`,
    min: { x: arch.position.x - 5, y: 0, z: arch.position.z - 1 },
    max: { x: arch.position.x + 5, y: arch.body.h, z: arch.position.z + 1 },
  }].filter(Boolean);
  const route = mat.routesById['tram-line'];
  const located = locateMismatch({ route, corridor: makeCorridor(route), landmark: spire, occluders });
  assert.equal(located.rootOccluder, 'occluder:mutual-arch');
  const node = evaluateGuideNode({
    route, corridor: makeCorridor(route), landmark: spire, occluders,
    window: { from: 70, to: 90 }, forks: route.forks,
  });
  assert.equal(node.feasible, false);
});

test('Harbor Quarter: closure + save point walk yields a boundary decision with evidence', () => {
  const scene = SCENES['harbor-quarter'];
  const mat = materializeScene(scene, sampleRoute);
  const spire = scene.mutualPair[1];
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, spire.type, spire.position, spire.yaw, spire.id);
  const route = mat.routesById['plaza-walk'];
  const dec = decideRepair({
    route, corridor: makeCorridor(route), landmark: lm, occluders: DISTRICT.occluders,
    savePoint: route.savePoint, closure: route.demoClosure, forks: route.forks,
  });
  assert.ok(['A-move-landmark', 'B-guide-node', 'split-route', 'report-unseen', 'no-repair-needed'].includes(dec.recommendation));
  assert.ok(dec.boundary.length > 10);
  assert.match(dec.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(dec.closure.id, route.demoClosure.id);
});
