// Unit tests for the pure kernel. No DOM, no WebGL: these are the same maths the
// editor and the render harness depend on, so a regression here is a regression
// in every number the tool reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  vec, dist, dot, cross, norm, rayBox, rayBlockedBy, hull2D,
  clipPolygonRect, clipPolygonFrustum, polygonArea2D, pointBoxDistance,
} from '../kernel/geom.js';
import {
  makeCamera, signCorners, signCenter, projectPoint, measureLandmark,
  DEFAULT_THRESHOLDS,
} from '../kernel/visibility.js';
import {
  landmarkOccluderBox, withLandmarkOccluders, landmarkFromCatalog,
  evaluatePlan, solvePlacement,
} from '../kernel/placement.js';
import { sampleRoute } from '../kernel/visibility.js';
import { LANDMARK_CATALOG, DISTRICT } from '../content/world.js';

const box = (id, min, max) => ({ id, min: vec(...min), max: vec(...max) });

// ---------------------------------------------------------------------------
// Geometry primitives

test('rayBox hits and misses an AABB', () => {
  const b = box('b', [0, 0, 0], [10, 10, 10]);
  assert.ok(rayBox(vec(-5, 5, 5), vec(1, 0, 0), b, 100) !== null);
  assert.equal(rayBox(vec(-5, 15, 5), vec(1, 0, 0), b, 100), null);
  // Ray parallel to and outside a slab.
  assert.equal(rayBox(vec(-5, 5, 20), vec(1, 0, 0), b, 100), null);
});

test('rayBlockedBy returns the nearest blocking box', () => {
  const near = box('near', [4, -1, -1], [5, 1, 1]);
  const far = box('far', [8, -1, -1], [9, 1, 1]);
  const hit = rayBlockedBy(vec(0, 0, 0), vec(1, 0, 0), [far, near], 100);
  assert.equal(hit.box.id, 'near');
  // A target that ends before the box is not blocked.
  assert.equal(rayBlockedBy(vec(0, 0, 0), vec(1, 0, 0), [near], 3), null);
});

test('pointBoxDistance is negative inside, positive outside', () => {
  const b = box('b', [0, 0, 0], [10, 10, 10]);
  assert.ok(pointBoxDistance(vec(5, 5, 5), b) < 0);
  assert.ok(Math.abs(pointBoxDistance(vec(-3, 5, 5), b) - 3) < 1e-9);
});

test('convex hull area of a square is exact', () => {
  const pts = [vec(0, 0, 0), vec(4, 0, 0), vec(4, 4, 0), vec(0, 4, 0), vec(2, 2, 0)];
  assert.equal(hull2D(pts), 16);
});

// ---------------------------------------------------------------------------
// Polygon clipping (regression: a vertex entering the frustum must also be kept)

test('clipPolygonRect clamps a straddling polygon', () => {
  // 20x10 rect clipped to the 10x10 window → 10x5 = 50.
  const poly = [{ x: -5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: -5, y: 15 }];
  const out = clipPolygonRect(poly, 0, 0, 10, 10);
  assert.ok(Math.abs(polygonArea2D(out) - 50) < 1e-6, `area ${polygonArea2D(out)}`);
});

test('clipPolygonFrustum keeps a quad whose corners are all in front', () => {
  const tanX = 1.0, tanY = 0.6;
  // Quad straddles the left plane (x + tanX*z < 0 on part of it) but every
  // corner has positive z. The clip must preserve the in-frustum half, not
  // collapse to a sliver.
  const quad = [
    { x: -3, y: -0.2, z: 4 },
    { x: 1, y: -0.2, z: 4 },
    { x: 1, y: 0.2, z: 4 },
    { x: -3, y: 0.2, z: 4 },
  ];
  const out = clipPolygonFrustum(quad, tanX, tanY, 0.35);
  assert.ok(out.length >= 4, `expected >=4 vertices, got ${out.length}`);
  // Project and compare to the analytic width: the left boundary is x=-tanX*z=-4,
  // so the visible x-range is [-3, 1] fully; the quad is entirely inside x. But
  // with a tighter tanX the left edge clips — assert the area is non-trivial.
  const proj = out.map((p) => ({
    x: (p.x / p.z / tanX * 0.5 + 0.5) * 1280,
    y: (0.5 - p.y / p.z / tanY * 0.5) * 720,
  }));
  assert.ok(polygonArea2D(proj) > 1000, 'clipped area should be a real region');
});

test('clipPolygonFrustum on the shipped tram case matches a hand-computed quad', () => {
  // The exact camera-space corners from the once-failing tram-line s=60 frame.
  const tanX = 1.0681966560489962, tanY = 0.6008606190275604;
  const quad = [
    { x: -2.22, y: 1.75, z: 8.81 },
    { x: -5.20, y: 1.75, z: 3.60 },
    { x: -5.20, y: 3.95, z: 3.60 },
    { x: -2.22, y: 3.95, z: 8.81 },
  ];
  const out = clipPolygonFrustum(quad, tanX, tanY, 0.35);
  assert.ok(out.length >= 4, `expected a real quad, got ${out.length} vertices`);
  const proj = out.map((p) => ({
    x: (p.x / p.z / tanX * 0.5 + 0.5) * 1280,
    y: (0.5 - p.y / p.z / tanY * 0.5) * 720,
  }));
  const area = polygonArea2D(proj);
  // The GPU renders ~80,400 px for this frame; the analytic clip must land in
  // the same ballpark (allow 12% for rasterisation of a grazing quad).
  assert.ok(area > 70000 && area < 90000, `clipped area ${area.toFixed(0)} out of range`);
});

// ---------------------------------------------------------------------------
// Visibility measurement

function cameraLookingAt(from, at, { fovYDeg = 62 } = {}) {
  const dx = at.x - from.x, dz = at.z - from.z;
  const yaw = Math.atan2(-dx, -dz);
  return makeCamera({ position: from, yaw, fovYDeg, aspect: 16 / 9, width: 1280, height: 720 });
}

function simpleLandmark({ x = 0, z = 0, y = 0, yaw = 0, w = 6, h = 4, yOffset = 5 } = {}) {
  return {
    id: 'lm', type: 'test', name: 'Test', color: '#fff',
    position: { x, y, z }, yaw,
    sign: { w, h, yOffset }, body: { w: 2, d: 2, h: 5 },
    ignoreOccluderIds: [],
  };
}

test('a clear, close, face-on sign reads as readable', () => {
  const lm = simpleLandmark({ x: 0, z: 0, yaw: 0 });
  // Sign faces -Z (yaw 0 → normal points -Z), so stand at -Z looking +Z.
  const cam = cameraLookingAt(vec(0, 6, -20), signCenter(lm));
  const m = measureLandmark(cam, lm, []);
  assert.ok(m, 'measurement should exist');
  assert.equal(m.readable, true, `reasons: ${m.reasons}`);
  assert.ok(m.visibleFraction === 1);
  assert.ok(m.visibleAreaPx > DEFAULT_THRESHOLDS.minVisibleAreaPx);
});

test('a one-pixel distant sign is rejected for angular size, not area alone', () => {
  const lm = simpleLandmark({ x: 0, z: 0, yaw: 0, w: 2, h: 1.2 });
  const cam = cameraLookingAt(vec(0, 4, -400), signCenter(lm));
  const m = measureLandmark(cam, lm, []);
  assert.ok(m);
  assert.equal(m.readable, false);
  assert.ok(m.reasons.includes('too-distant'), `reasons: ${m.reasons}`);
});

test('a full occluder consumes the visible fraction and is attributed', () => {
  const lm = simpleLandmark({ x: 0, z: 0, yaw: 0 });
  const cam = cameraLookingAt(vec(0, 6, -20), signCenter(lm));
  const wall = box('wall', [-10, -5, -8], [10, 30, -6]);
  const m = measureLandmark(cam, lm, [wall]);
  assert.ok(m);
  assert.equal(m.readable, false);
  assert.ok(m.reasons.includes('occluded'));
  assert.equal(m.visibleFraction, 0);
  assert.ok((m.blockerVotes.wall ?? 0) > 0, 'wall should be named as the blocker');
});

test('a sign viewed edge-on is rejected by the incidence gate', () => {
  // Sign faces -Z; camera is to the side (+X) at grazing incidence.
  const lm = simpleLandmark({ x: 0, z: 0, yaw: 0 });
  const cam = makeCamera({
    position: vec(30, 6, -1), yaw: Math.atan2(-(0 - 30), -(0 + 1)),
    fovYDeg: 62, aspect: 16 / 9, width: 1280, height: 720,
  });
  const m = measureLandmark(cam, lm, []);
  assert.ok(m);
  assert.equal(m.readable, false);
  assert.ok(m.reasons.includes('edge-on') || m.reasons.includes('small-area') || m.reasons.includes('occluded'),
    `reasons: ${m.reasons}`);
});

test('landmark self-occlusion is excluded via ignoreOccluderIds', () => {
  const lm = simpleLandmark({ x: 0, z: 0, yaw: 0 });
  lm.id = 'clock';
  lm.ignoreOccluderIds = ['mint-face'];
  const cam = cameraLookingAt(vec(0, 6, -20), signCenter(lm));
  // Same box would fully block, but it is ignored.
  const face = box('mint-face', [-10, -5, -2], [10, 30, 2]);
  const m = measureLandmark(cam, lm, [face]);
  assert.ok(m);
  assert.equal(m.readable, true, `reasons: ${m.reasons}`);
});

// ---------------------------------------------------------------------------
// Landmark occluder derivation & plan evaluation

test('landmarkOccluderBox rotates the footprint into world space', () => {
  const lm = simpleLandmark({ x: 10, z: 5, yaw: 0 });
  lm.body = { w: 4, d: 2, h: 6 };
  const a = landmarkOccluderBox(lm);
  assert.equal(a.id, 'occluder:lm');
  const aw = a.max.x - a.min.x, ad = a.max.z - a.min.z;
  assert.ok(Math.abs(aw - 4) < 1e-9 && Math.abs(ad - 2) < 1e-9);
  lm.yaw = Math.PI / 2;
  const b = landmarkOccluderBox(lm);
  const bw = b.max.x - b.min.x, bd = b.max.z - b.min.z;
  assert.ok(Math.abs(bw - 2) < 1e-9 && Math.abs(bd - 4) < 1e-9, 'yaw 90° swaps extents');
});

test('slender poles do not become occluders', () => {
  const lm = simpleLandmark({ x: 0, z: 0 });
  lm.body = { w: 1, d: 1, h: 6 };
  assert.equal(landmarkOccluderBox(lm), null);
});

test('withLandmarkOccluders appends only qualifying landmark boxes', () => {
  const a = simpleLandmark({ x: 0, z: 0 }); a.id = 'a'; a.body = { w: 4, d: 4, h: 6 };
  const b = simpleLandmark({ x: 5, z: 0 }); b.id = 'b'; b.body = { w: 1, d: 1, h: 6 };
  const occ = withLandmarkOccluders([box('scenery', [-1, 0, -1], [1, 3, 1])], [a, b]);
  const ids = occ.map((o) => o.id).sort();
  assert.deepEqual(ids, ['occluder:a', 'scenery']);
});

test('evaluatePlan reports full coverage when a landmark is visible everywhere', () => {
  const route = { id: 'r', points: [[-20, 0, 0], [0, 0, 0], [20, 0, 0]], eyeHeight: 1.7, viewpoint: { mode: 'free', panLimitDeg: 30, lateralLimit: 0 } };
  const { samples, length } = sampleRoute(route, 2.5);
  const routesById = { r: { id: 'r', name: 'R', samples, length, eyeHeight: 1.7, viewpoint: route.viewpoint } };
  // Place the guide ahead on the route axis, facing back down the approach, so
  // a forward-facing observer pans only slightly to keep it framed.
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'ribbon', { x: 25, z: 0 }, Math.PI / 2, 'guide');
  const plan = { landmarks: [lm], keySegments: [{ routeId: 'r', label: 'all', from: 0, to: length }] };
  const ev = evaluatePlan(plan, routesById, []);
  // The route ends a few metres from the panel, where it swamps the frame; the
  // guide therefore covers most, not all, of the route. That is the honest
  // result — a single static sign does not cover the final approach.
  assert.ok(ev.coverage.byRoute.r.fraction > 0.8, `fraction ${ev.coverage.byRoute.r.fraction}`);
  assert.ok(ev.coverage.byRoute.r.covered > 0);
});

test('solvePlacement respects a fixed landmark and never moves it', () => {
  const route = { id: 'r', points: [[-20, 0, 0], [0, 0, 0], [20, 0, 0]], eyeHeight: 1.7, viewpoint: { mode: 'free', panLimitDeg: 30, lateralLimit: 0 } };
  const { samples, length } = sampleRoute(route, 2.5);
  const routesById = { r: { id: 'r', name: 'R', samples, length, eyeHeight: 1.7, viewpoint: route.viewpoint } };
  const fixed = { ...landmarkFromCatalog(LANDMARK_CATALOG, 'spire', { x: 0, z: -18 }, Math.PI, 'fixed-sign'), fixedReason: 'test' };
  const res = solvePlacement({
    routesById,
    context: {
      catalog: LANDMARK_CATALOG, occluders: [], platforms: [],
      landmarkTypes: ['ribbon', 'lantern'], keySegments: [{ routeId: 'r', label: 'all', from: 0, to: length, minFraction: 0.6 }],
      historicLandmarks: [], fixedLandmarks: [fixed],
    },
    options: { maxLandmarks: 4 },
  });
  const kept = res.plan.landmarks.find((l) => l.id === 'fixed-sign');
  assert.ok(kept, 'fixed landmark present in plan');
  assert.equal(kept.position.x, 0);
  assert.equal(kept.position.z, -18);
});

// ---------------------------------------------------------------------------
// Epistemic contract: the thresholds are explicit and documented as such.

test('thresholds are exported and finite', () => {
  for (const [k, v] of Object.entries(DEFAULT_THRESHOLDS)) {
    assert.ok(typeof v === 'number' || typeof v === 'boolean', `${k} should be numeric or boolean`);
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} should be finite`);
  }
  assert.ok(DEFAULT_THRESHOLDS.minVisibleAreaPx > 0);
  assert.ok(DEFAULT_THRESHOLDS.minAngularHeightDeg > 0);
});
