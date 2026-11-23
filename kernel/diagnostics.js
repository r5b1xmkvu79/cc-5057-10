// Visibility-mismatch diagnostics.
//
// This module never invents a second visibility model: every projection, ray
// and acceptance result comes from kernel/visibility.js. What it adds is the
// *evidence layer* around that model:
//
//   1. walkable corridors supplied by the navigator (the ground truth of where
//      an observer can actually stand), including temporarily closed roads;
//   2. per-landmark evidence tracking — projection, occlusion query and route
//      sampling — with a deterministic fingerprint so a re-run can be proven
//      identical and the tracker can never raise a phantom mismatch;
//   3. mismatch diagnosis that separates per-object blocker culling from
//      sightline-intersection route splits, via counterfactual single-object
//      removal replays and a boundary test (first guide-loss point vs fork);
//   4. root-cause classification (critical occlusion, distant/small landmark,
//      under-sampling, bounding-volume error, composition threshold) with the
//      screen area and visibility intervals attached to each stage.
//
// Logging is budgeted: evidence is sampled at a configurable cadence and full
// per-ray detail is only retained for mismatch-adjacent samples.

import {
  add, sub, mul, cross, norm, len, dist, clamp, vec,
} from './geom.js';
import {
  makeCamera, measureLandmark, sightlineQuery, landmarkSightlines,
  projectedPanelPolygon, mergeIntervals, visibleIntervals, screenAreaIntervals,
  DEFAULT_THRESHOLDS, NEAR_PLANE,
} from './visibility.js';
import { cameraForPose } from './placement.js';

const DEG = Math.PI / 180;
const UP = vec(0, 1, 0);

// Deterministic 32-bit FNV-1a over a canonical JSON encoding. Numbers are
// rounded so two runs of the same floating-point computation hash the same.
function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
  return out;
}

export function stableHash(value) {
  const json = JSON.stringify(canonical(value));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Corridors and closures.
//
// A corridor is the navigator's authoritative walkable surface for one route:
// a centreline (the route samples) plus a lateral half-width that may vary with
// arc length, and zero-width stretches (a fixed seat, a closed road). The
// diagnostics only ever place eyes inside this corridor — an "unblocked" ray
// from an illegal pose is not evidence.

export function makeCorridor(route, overrides = {}) {
  const widths = route.corridor?.widths ?? [];
  const halfWidthAt = (s) => {
    if (overrides.halfWidth !== undefined) return overrides.halfWidth;
    const fixed = route.viewpoint?.mode === 'fixed' ? 0 : (route.viewpoint?.lateralLimit ?? 0);
    for (const w of widths) {
      if (s >= w.from && s <= w.to) return w.halfWidth ?? fixed;
    }
    return fixed;
  };
  const closures = [...(route.corridor?.closures ?? []), ...(overrides.closures ?? [])];
  const closedAt = (s) => closures.find((c) => s >= c.from - 1e-9 && s <= c.to + 1e-9) ?? null;
  return {
    routeId: route.id,
    closures,
    halfWidthAt,
    closedAt,
    sampleAllowed: (sample) => {
      const c = closedAt(sample.s);
      return { allowed: !c, closure: c };
    },
  };
}

// Poses a route sample may legally use inside a corridor. A closed stretch
// yields no poses at all; a zero-width stretch yields centreline-only poses.
export function corridorPoses(route, sample, corridor, { panSteps = 5, lateralSteps = 3 } = {}) {
  const gate = corridor.sampleAllowed(sample);
  if (!gate.allowed) return { poses: [], closure: gate.closure };
  const vp = route.viewpoint;
  const panLimit = vp.panLimitDeg ?? 0;
  const pans = panSteps <= 1 ? [0]
    : Array.from({ length: panSteps }, (_, i) => -panLimit + (2 * panLimit * i) / (panSteps - 1));
  const half = clamp(corridor.halfWidthAt(sample.s), 0, vp.lateralLimit ?? 0);
  const lats = half <= 1e-9 || lateralSteps <= 1 ? [0]
    : Array.from({ length: lateralSteps }, (_, i) => -half + (2 * half * i) / (lateralSteps - 1));
  const right = norm(cross(sample.tangent, UP));
  const poses = [];
  for (const lat of lats) {
    for (const pan of pans) {
      poses.push({
        sampleId: sample.id,
        s: sample.s,
        position: add(sample.position, mul(right, lat)),
        yaw: sample.yaw + pan * DEG,
        pan,
        lateral: lat,
        adjustable: sample.adjustable,
      });
    }
  }
  return { poses, closure: null };
}

// Route samples reachable on foot from a save point after a closure. The
// pre-closure section is skipped (the player starts at the save point) and the
// closed arc is excluded; everything reachable afterwards is walked in order.
export function walkFromSavePoint(route, corridor, savePoint, closure) {
  const startS = clamp(savePoint?.s ?? 0, 0, route.length);
  return route.samples
    .filter((smp) => smp.s >= startS - 1e-9)
    .map((smp) => ({ sample: smp, gate: corridor.sampleAllowed(smp) }));
}

// ---------------------------------------------------------------------------
// Camera + measurement helpers (all on the reference 1280x720 frame).

function cameraFromPose(route, sample, pose, opts) {
  return cameraForPose(route, sample, pose, {
    fovYDeg: opts.fovYDeg ?? 62,
    aspect: opts.aspect ?? 16 / 9,
    width: opts.width ?? 1280,
    height: opts.height ?? 720,
  });
}

// Best legal pose measurement for a landmark at one sample, restricted to the
// corridor. Returns the chosen pose + camera + measurement plus the runner-up
// reasons so a loss of guidance is explainable rather than null.
function bestCorridorMeasure(route, sample, corridor, landmark, occluders, thresholds, poseOpts) {
  const { poses, closure } = corridorPoses(route, sample, corridor, poseOpts);
  if (!poses.length) {
    return { closure, pose: null, cam: null, measurement: null, alternatives: [] };
  }
  let best = null;
  const alternatives = [];
  for (const pose of poses) {
    const cam = cameraFromPose(route, sample, pose, poseOpts);
    const m = measureLandmark(cam, landmark, occluders, thresholds);
    if (!m) continue;
    alternatives.push({ pan: pose.pan, lateral: pose.lateral, reasons: m.reasons, quality: m.quality });
    if (!best || m.quality > best.measurement.quality) best = { pose, cam, measurement: m };
  }
  alternatives.sort((a, b) => b.quality - a.quality);
  return { closure: null, ...(best ?? { pose: null, cam: null, measurement: null }), alternatives: alternatives.slice(0, 3) };
}

// ---------------------------------------------------------------------------
// Evidence tracker.
//
// One tracker per (route, landmark). It records the full per-ray sightline
// detail only at the sampling cadence and always around a state transition
// (readable↔not), which keeps the log bounded while guaranteeing that every
// boundary in the visibility/screen-area intervals is observed.

export const DEFAULT_BUDGET = {
  strideSamples: 4,          // routine cadence along the route
  maxEvidencePerLandmark: 60,
  detailAroundTransition: 2, // full sightline detail kept either side of a flip
};

export function createEvidenceTracker(route, landmark, options = {}) {
  const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) };
  return {
    routeId: route.id,
    landmarkId: landmark.id,
    budget,
    rows: [],          // one entry per sampled s, compact
    evidence: [],      // full per-ray detail, budgeted
    transitions: [],   // arc positions where readability flips
    closedSamples: [], // samples the corridor refused (with the closure id)
    _lastReadable: undefined,
    _transitionCount: 0,
  };
}

// Classify why a measurement fails the acceptance test, grouped for the brief:
// critical occlusion vs distant/small vs composition threshold.
export function classifyFailure(measurement) {
  if (!measurement) return 'no-measurement';
  const r = measurement.reasons ?? [];
  if (r.includes('occluded')) return 'critical-occlusion';
  if (r.includes('too-distant')) return 'distant-small';
  if (r.includes('small-area') && measurement.angularHeightDeg >= DEFAULT_THRESHOLDS.minAngularHeightDeg) {
    return 'composition-threshold';
  }
  if (r.includes('small-area')) return 'distant-small';
  if (r.includes('off-screen') || r.includes('unsafe-viewport')) return 'composition-threshold';
  if (r.includes('edge-on')) return 'composition-threshold';
  if (r.includes('swamps-frame')) return 'composition-threshold';
  return r[0] ?? 'unclassified';
}

function compactMeasurement(m) {
  if (!m) return null;
  return {
    readable: m.readable,
    reasons: m.reasons,
    visibleAreaPx: m.visibleAreaPx,
    onScreenAreaPx: m.onScreenAreaPx,
    areaFraction: m.areaFraction,
    visibleFraction: m.visibleFraction,
    onScreenFraction: m.onScreenFraction,
    angularHeightDeg: m.angularHeightDeg,
    incidence: m.incidence,
    distance: m.distance,
    centroidPx: m.centroidPx,
    blockerVotes: m.blockerVotes,
    quality: m.quality,
  };
}

// Record one route sample into the tracker. `detail` forces full sightline
// capture (used on transitions and inside a diagnosed mismatch window).
export function recordEvidence(tracker, {
  route, sample, corridor, landmark, occluders, thresholds = DEFAULT_THRESHOLDS,
  cameraOpts = {}, forceDetail = false,
}) {
  const poseOpts = { panSteps: cameraOpts.panSteps ?? 5, lateralSteps: cameraOpts.lateralSteps ?? 3,
    fovYDeg: cameraOpts.fovYDeg, aspect: cameraOpts.aspect, width: cameraOpts.width, height: cameraOpts.height };
  const res = bestCorridorMeasure(route, sample, corridor, landmark, occluders, thresholds, poseOpts);
  if (res.closure) {
    tracker.closedSamples.push({ s: sample.s, closureId: res.closure.id, reason: res.closure.reason ?? 'road closed' });
    return { closure: res.closure };
  }
  const m = res.measurement;
  const row = {
    s: sample.s,
    sampleIndex: route.samples.indexOf(sample),
    readable: !!m?.readable,
    failure: m && !m.readable ? classifyFailure(m) : null,
    measurement: compactMeasurement(m),
    pose: res.pose ? { pan: res.pose.pan, lateral: res.pose.lateral } : null,
    alternatives: res.alternatives,
  };
  tracker.rows.push(row);

  const flipped = tracker._lastReadable !== undefined && tracker._lastReadable !== row.readable;
  if (flipped) {
    tracker._transitionCount++;
    tracker.transitions.push({ s: sample.s, toReadable: row.readable, failure: row.failure });
  }
  tracker._lastReadable = row.readable;

  const idx = tracker.rows.length - 1;
  const routine = idx % tracker.budget.strideSamples === 0;
  const nearTransition = tracker.transitions.some((t) => {
    const at = tracker.rows.findIndex((r) => r.s === t.s);
    return at >= 0 && Math.abs(at - idx) <= tracker.budget.detailAroundTransition;
  });
  const wantDetail = forceDetail || routine || flipped || nearTransition;
  if (wantDetail && res.cam && tracker.evidence.length < tracker.budget.maxEvidencePerLandmark) {
    const sightlines = landmarkSightlines(res.cam, landmark, occluders);
    tracker.evidence.push({
      s: sample.s,
      sampleIndex: row.sampleIndex,
      camera: {
        position: res.cam.position,
        yaw: res.cam.yaw,
        fovYDeg: res.cam.fovYDeg,
        width: res.cam.width,
        height: res.cam.height,
      },
      panelPolygonPx: projectedPanelPolygon(res.cam, landmark),
      sightlines,
      measurement: compactMeasurement(m),
      reason: flipped ? 'transition' : routine ? 'cadence' : 'mismatch-window',
    });
  }
  return { row, camera: res.cam, pose: res.pose, measurement: m };
}

// Intervals derived from the recorded rows — these are the visible window and
// the on-screen-area window the UI and the report render.
export function trackerIntervals(tracker, thresholds = DEFAULT_THRESHOLDS) {
  return {
    visible: visibleIntervals(tracker.rows),
    onScreenArea: screenAreaIntervals(tracker.rows, thresholds.minVisibleAreaPx),
    transitions: tracker.transitions,
    closed: tracker.closedSamples.map((c) => c.s),
  };
}

// Deterministic fingerprint of everything observed. Re-running the same
// configuration must produce the same hash; the verifier asserts this.
export function fingerprintTracker(tracker) {
  return stableHash({
    routeId: tracker.routeId,
    landmarkId: tracker.landmarkId,
    rows: tracker.rows.map((r) => ({
      s: r.s, readable: r.readable, failure: r.failure,
      area: r.measurement?.visibleAreaPx ?? 0,
      onScreen: r.measurement?.onScreenAreaPx ?? 0,
      frac: r.measurement?.visibleFraction ?? 0,
      reasons: r.measurement?.reasons ?? [],
    })),
    transitions: tracker.transitions,
    closedSamples: tracker.closedSamples,
  });
}

// ---------------------------------------------------------------------------
// Full evidence chain for one (route, landmark). Walks every legal sample in
// the corridor, records budgeted evidence, derives the screen-area and
// visibility intervals, and classifies each unreadable stretch. An optional
// renderCheck(cam, landmark) => {visiblePixels, projectedPixels} links the
// kernel chain to the real rendering view (see verify/render.html).

export function runEvidenceChain({
  route, corridor, landmark, occluders, thresholds = DEFAULT_THRESHOLDS,
  cameraOpts = {}, budget, renderCheck = null,
}) {
  const tracker = createEvidenceTracker(route, landmark, { budget });
  const renderFlags = [];
  for (const sample of route.samples) {
    const rec = recordEvidence(tracker, {
      route, sample, corridor, landmark, occluders, thresholds, cameraOpts,
    });
    if (rec.closure) continue;
    if (renderCheck && rec.camera) {
      try {
        const px = renderCheck(rec.camera, landmark);
        if (px) {
          renderFlags.push({
            s: sample.s,
            kernelVisiblePx: Math.round(rec.measurement?.visibleAreaPx ?? 0),
            kernelOnScreenPx: Math.round(rec.measurement?.onScreenAreaPx ?? 0),
            renderedVisiblePx: px.visiblePixels,
            renderedProjectedPx: px.projectedPixels,
            agreement: renderAgrees(rec.measurement, px),
          });
        }
      } catch {
        // A render harness failure must not fabricate a mismatch.
      }
    }
  }
  const intervals = trackerIntervals(tracker, thresholds);
  const mismatches = detectMismatches(tracker, intervals, renderFlags, thresholds);
  return {
    routeId: route.id,
    landmarkId: landmark.id,
    tracker,
    intervals,
    mismatches,
    renderFlags,
    fingerprint: fingerprintTracker(tracker),
    logCost: {
      samples: route.samples.length,
      rowsRecorded: tracker.rows.length,
      fullEvidenceRecords: tracker.evidence.length,
      closedSamples: tracker.closedSamples.length,
      budget: tracker.budget,
    },
  };
}

// Render-vs-measurement agreement, using the same generous bounds the render
// harness was already validated against.
function renderAgrees(m, px) {
  if (!m) return px.visiblePixels === 0;
  const visibleRatio = px.visiblePixels / Math.max(1, Math.round(m.visibleAreaPx));
  const projectedRatio = px.projectedPixels / Math.max(1, Math.round(m.onScreenAreaPx));
  const renderedOcc = px.projectedPixels > 0 ? px.visiblePixels / px.projectedPixels : 0;
  return visibleRatio > 0.25 && visibleRatio < 4.0
    && projectedRatio > 0.3 && projectedRatio < 3.0
    && Math.abs(renderedOcc - m.visibleFraction) < 0.28;
}

// A mismatch is a stretch the chain can actually see fail, with an attached
// cause. Under-sampling is only raised when the sampling grid is too coarse to
// resolve the transition — not whenever a sign is far away.
function detectMismatches(tracker, intervals, renderFlags, thresholds) {
  const out = [];
  const rows = tracker.rows;
  if (rows.length < 2) return out;
  const step = medianStep(rows);
  const emitMismatch = (row, kind) => {
    const cause = rootCause(row, step, thresholds);
    const detail = nearestEvidence(tracker, row.s);
    const blockers = topBlockers(detail);
    const render = renderFlags.find((f) => Math.abs(f.s - row.s) <= step) ?? null;
    const supported = cause.kind !== 'critical-occlusion'
      ? blockers.length > 0 || (render && !render.agreement) || mBreachesThreshold(row, thresholds)
      : blockers.length > 0;
    if (!supported) return;
    out.push({
      kind,
      atS: row.s,
      cause: cause.kind,
      stage: cause.stage,
      failure: row.failure,
      measured: {
        visibleAreaPx: row.measurement?.visibleAreaPx ?? 0,
        onScreenAreaPx: row.measurement?.onScreenAreaPx ?? 0,
        visibleFraction: row.measurement?.visibleFraction ?? 0,
        angularHeightDeg: row.measurement?.angularHeightDeg ?? 0,
        distance: row.measurement?.distance ?? 0,
        reasons: row.measurement?.reasons ?? [],
      },
      blockers,
      render: render ? { ...render, disagrees: !render.agreement } : null,
      underSampled: cause.underSampled,
    });
  };
  // A landmark blocked from the very first sample has no transition to flip;
  // surface it as an initial-state mismatch instead of dropping it.
  if (rows[0] && !rows[0].readable) emitMismatch(rows[0], 'initial');
  for (const t of tracker.transitions) {
    const row = rows.find((r) => r.s === t.s);
    if (!row || t.toReadable) continue;
    emitMismatch(row, 'transition');
  }
  // Render disagreements that do not coincide with a transition (the sign is
  // "readable" to the kernel but the pixels are not there, or vice versa).
  for (const f of renderFlags) {
    if (f.agreement) continue;
    if (out.some((m) => m.kind === 'render' && Math.abs(m.atS - f.s) <= step)) continue;
    const row = nearestRow(rows, f.s);
    out.push({
      kind: 'render',
      atS: f.s,
      cause: row?.failure === 'distant-small' ? 'distant-small' : 'render-disagreement',
      stage: 'render-cross-check',
      failure: row?.failure ?? null,
      measured: row?.measurement ? compactMeasurement(row.measurement) : null,
      blockers: topBlockers(nearestEvidence(tracker, f.s)),
      render: { ...f, disagrees: true },
      underSampled: false,
    });
  }
  return out;
}

function medianStep(rows) {
  const ds = [];
  for (let i = 1; i < rows.length; i++) ds.push(rows[i].s - rows[i - 1].s);
  ds.sort((a, b) => a - b);
  return ds.length ? ds[Math.floor(ds.length / 2)] : 1;
}

function nearestRow(rows, s) {
  return rows.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a), rows[0]);
}

function nearestEvidence(tracker, s) {
  if (!tracker.evidence.length) return null;
  return tracker.evidence.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
}

function topBlockers(evidence) {
  if (!evidence) return [];
  const votes = {};
  for (const ray of evidence.sightlines) {
    if (ray.free || !ray.blocker) continue;
    const id = ray.blocker.id;
    votes[id] ??= { id, rays: 0, coveringRays: 0, minDistance: Infinity, box: ray.blocker.box };
    votes[id].rays++;
    if (ray.coversPanel) votes[id].coveringRays++;
    votes[id].minDistance = Math.min(votes[id].minDistance, ray.blocker.distance);
  }
  return Object.values(votes)
    .map((v) => ({ id: v.id, rays: v.rays, coveringRays: v.coveringRays, minDistance: v.minDistance }))
    .sort((a, b) => b.rays - a.rays);
}

// Root cause with a stage tag, using the occlusion boundary vs distant/small
// distinction the brief requires. The stage says where in the chain the
// observation was made, so screen-area/interval anomalies can be located.
function mBreachesThreshold(row, thresholds) {
  const m = row.measurement;
  if (!m) return false;
  return m.visibleAreaPx < thresholds.minVisibleAreaPx
    || m.angularHeightDeg < thresholds.minAngularHeightDeg
    || m.incidence < thresholds.minIncidenceCos
    || m.onScreenFraction < thresholds.minOnScreenFraction;
}
function rootCause(row, step, thresholds) {
  const m = row.measurement;
  if (!m) return { kind: 'no-measurement', stage: 'corridor-pose', underSampled: false };
  // A bounding-volume error: the AABB vote exists but its projected footprint
  // never overlaps the panel pixels. Surfaced from the sightline evidence.
  if (row.failure === 'critical-occlusion' && m.visibleFraction < thresholds.minVisibleFraction
      && m.onScreenAreaPx >= thresholds.minVisibleAreaPx) {
    return { kind: 'critical-occlusion', stage: 'occlusion-query', underSampled: false };
  }
  if (row.failure === 'distant-small') {
    // A far landmark that only fails between two grid nodes is under-sampled;
    // one that stays small across many nodes is genuinely too distant.
    return { kind: 'distant-small', stage: 'projection', underSampled: step > 3.0 };
  }
  if (row.failure === 'composition-threshold') {
    return { kind: 'composition-threshold', stage: 'acceptance-gate', underSampled: false };
  }
  return { kind: row.failure ?? 'unclassified', stage: 'acceptance-gate', underSampled: false };
}

// Bounding-volume error test, run on demand against stored evidence: an
// occluder that wins ray votes but whose projected polygon never overlaps the
// sign's projected polygon is a phantom blocker.
export function boundingVolumeErrors(chain) {
  const out = [];
  for (const ev of chain.tracker.evidence) {
    const panel = ev.panelPolygonPx;
    if (panel.length < 3) continue;
    const byId = new Map();
    for (const ray of ev.sightlines) {
      if (ray.free || !ray.blocker) continue;
      const rec = byId.get(ray.blocker.id) ?? { id: ray.blocker.id, rays: 0, nonCovering: 0 };
      rec.rays++;
      if (!ray.coversPanel) rec.nonCovering++;
      byId.set(ray.blocker.id, rec);
    }
    for (const rec of byId.values()) {
      if (rec.rays >= 4 && rec.nonCovering === rec.rays) {
        out.push({ s: ev.s, blockerId: rec.id, rays: rec.rays, note: 'AABB blocks rays but its projection never overlaps the panel' });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counterfactual replay: remove exactly one occluder and re-walk the corridor.
// Comparing the regained intervals against the baseline pins the mismatch on a
// single object instead of a diffuse "something blocks the view" report.

export function counterfactualReplay({
  route, corridor, landmark, occluders, removeOccluderId,
  thresholds = DEFAULT_THRESHOLDS, cameraOpts = {}, budget,
}) {
  const reduced = occluders.filter((b) => b.id !== removeOccluderId);
  const baseline = runEvidenceChain({
    route, corridor, landmark, occluders, thresholds, cameraOpts, budget,
  });
  const replay = runEvidenceChain({
    route, corridor, landmark, occluders: reduced, thresholds, cameraOpts, budget,
  });
  const baseVisible = mergeArc(baseline.intervals.visible);
  const replayVisible = mergeArc(replay.intervals.visible);
  const regained = subtractIntervals(replayVisible, baseVisible);
  const baseVotes = countVotes(baseline);
  return {
    removedOccluderId: removeOccluderId,
    existed: occluders.some((b) => b.id === removeOccluderId),
    baselineFingerprint: baseline.fingerprint,
    replayFingerprint: replay.fingerprint,
    baselineVisibleM: totalLength(baseVisible),
    replayVisibleM: totalLength(replayVisible),
    regainedM: totalLength(regained),
    regainedIntervals: regained,
    restoresReadability: regained.length > 0,
    baselineVotesForRemoved: baseVotes[removeOccluderId] ?? 0,
    replay,
  };
}

// Locate the mismatch by trying every named blocker in turn. The occluder whose
// single removal restores the most visible arc length is the causal object.
export function locateMismatch({
  route, corridor, landmark, occluders, candidateOccluderIds = null,
  thresholds = DEFAULT_THRESHOLDS, cameraOpts = {}, budget,
}) {
  const baseline = runEvidenceChain({
    route, corridor, landmark, occluders, thresholds, cameraOpts, budget,
  });
  const ids = candidateOccluderIds
    ?? [...new Set(baseline.tracker.evidence.flatMap((e) => e.sightlines.filter((r) => !r.free).map((r) => r.blocker.id)))];
  const trials = [];
  for (const id of ids) {
    const cf = counterfactualReplay({
      route, corridor, landmark, occluders, removeOccluderId: id, thresholds, cameraOpts, budget,
    });
    trials.push({ occluderId: id, regainedM: cf.regainedM, restoresReadability: cf.restoresReadability,
      regainedIntervals: cf.regainedIntervals, baselineVotes: cf.baselineVotesForRemoved });
  }
  trials.sort((a, b) => b.regainedM - a.regainedM);
  return {
    landmarkId: landmark.id,
    routeId: route.id,
    baselineFingerprint: baseline.fingerprint,
    trials,
    rootOccluder: trials[0]?.regainedM > 0 ? trials[0].occluderId : null,
  };
}

function countVotes(chain) {
  const votes = {};
  for (const ev of chain.tracker.evidence) {
    for (const ray of ev.sightlines) {
      if (!ray.free && ray.blocker) votes[ray.blocker.id] = (votes[ray.blocker.id] ?? 0) + 1;
    }
  }
  return votes;
}

// ---------------------------------------------------------------------------
// Boundary test: per-object culling vs sightline-intersection route split.
//
// The brief's boundary condition: close a road, walk from the save point, and
// use (a) where guidance is first lost and (b) which fork the walker ends up in
// to decide which repair is legal.
//
//   * If one object's removal restores the guide across the whole first-loss
//     window AND no fork has been entered before the loss, the blocker can be
//     culled / the landmark moved (per-object repair).
//   * If the first-loss happens before a fork and persists regardless of any
//     single object, the route itself must be split at each sightline
//     intersection, giving each segment its own guide node.

// Where the eye-to-landmark sightline crosses the route centreline as the
// walker moves: each crossing is a natural split point because the guidance
// geometry changes handedness there.
export function sightlineIntersections(route, landmark) {
  const out = [];
  let lastSide = null;
  for (const smp of route.samples) {
    const eye = { x: smp.position.x, y: smp.position.y + smp.eyeHeight, z: smp.position.z };
    // Horizontal side of the eye relative to the eye→landmark line.
    const dx = landmark.position.x - eye.x;
    const dz = landmark.position.z - eye.z;
    const tx = smp.tangent.x, tz = smp.tangent.z;
    const side = dx * tz - dz * tx;
    if (lastSide !== null && Math.sign(side) !== Math.sign(lastSide) && Math.sign(side) !== 0) {
      out.push({ s: smp.s, position: smp.position, reason: 'sightline crosses route tangent' });
    }
    if (Math.abs(side) > 1e-6) lastSide = side;
  }
  return out;
}

// Split a route at sightline intersections (and optionally at the closure
// end). Each segment gets the guide node that is actually legible inside it.
export function splitRouteAtSightlines({
  route, corridor, landmark, occluders, thresholds = DEFAULT_THRESHOLDS, cameraOpts = {},
  extraCuts = [],
}) {
  const chain = runEvidenceChain({
    route, corridor, landmark, occluders, thresholds, cameraOpts,
    budget: { ...DEFAULT_BUDGET, strideSamples: 1, maxEvidencePerLandmark: 400 },
  });
  const cuts = [
    ...sightlineIntersections(route, landmark).map((c) => c.s),
    ...extraCuts,
    0, route.length,
  ].map((s) => clamp(s, 0, route.length)).sort((a, b) => a - b)
    .filter((s, i, arr) => i === 0 || Math.abs(s - arr[i - 1]) > 1e-6);
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i], to = cuts[i + 1];
    const rows = chain.tracker.rows.filter((r) => r.s >= from - 1e-9 && r.s <= to + 1e-9);
    const covered = rows.filter((r) => r.readable).length;
    const failures = rows.filter((r) => !r.readable).map((r) => r.failure);
    segments.push({
      index: i,
      from, to,
      samples: rows.length,
      covered,
      fraction: rows.length ? covered / rows.length : 0,
      dominantFailure: mode(failures),
      needsGuideNode: rows.length > 0 && covered / rows.length < thresholds.minOnScreenFraction,
    });
  }
  return {
    landmarkId: landmark.id,
    routeId: route.id,
    cuts,
    segments,
    nodesNeeded: segments.filter((g) => g.needsGuideNode).length,
    fingerprint: chain.fingerprint,
  };
}

function mode(values) {
  const counts = {};
  for (const v of values) if (v) counts[v] = (counts[v] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// The two repair schemes and the boundary decision.

// Scheme A — move the blocked landmark. Search offsets on the corridor's right
// vector and keep the first placement whose evidence chain clears the window.
export function evaluateMoveLandmark({
  route, corridor, landmark, occluders, window,
  thresholds = DEFAULT_THRESHOLDS, cameraOpts = {}, offsets = [-24, -16, -10, -6, 6, 10, 16, 24],
  platformHeight = () => 0, isLegal = () => true,
}) {
  const base = runEvidenceChain({ route, corridor, landmark, occluders, thresholds, cameraOpts });
  const candidates = [];
  const near = nearestSampleAt(route, (window.from + window.to) / 2);
  const right = norm(cross(near.tangent, UP));
  for (const off of offsets) {
    const pos = { x: landmark.position.x + right.x * off, y: 0, z: landmark.position.z + right.z * off };
    pos.y = platformHeight(pos);
    if (!isLegal(pos)) continue;
    const moved = { ...landmark, position: pos };
    const chain = runEvidenceChain({ route, corridor, landmark: moved, occluders, thresholds, cameraOpts });
    const st = windowStats(chain, window);
    candidates.push({ offset: off, position: pos, ...st, fingerprint: chain.fingerprint });
  }
  candidates.sort((a, b) => b.windowFraction - a.windowFraction || b.fraction - a.fraction);
  const best = candidates[0] ?? null;
  const baseStats = windowStats(base, window);
  return {
    scheme: 'A-move-landmark',
    feasible: !!best && best.windowFraction > baseStats.windowFraction + 0.02,
    baseline: baseStats,
    best: best ? { ...best, delta: best.windowFraction - baseStats.windowFraction } : null,
    candidatesTried: candidates.length,
  };
}

// Scheme B — keep the landmark, change the guide node (observer/corridor
// guidance). Legal only on free-viewpoint routes; fixed seats cannot move.
export function evaluateGuideNode({
  route, corridor, landmark, occluders, window, forks = [],
  thresholds = DEFAULT_THRESHOLDS, cameraOpts = {},
}) {
  if (route.viewpoint?.mode === 'fixed') {
    return {
      scheme: 'B-guide-node',
      feasible: false,
      reason: 'fixed viewpoint: the seated eye cannot be relocated',
      baseline: null,
      best: null,
    };
  }
  const base = runEvidenceChain({ route, corridor, landmark, occluders, thresholds, cameraOpts });
  const baseStats = windowStats(base, window);
  const limit = route.viewpoint.lateralLimit ?? 0;
  const trials = [];
  for (const lat of [-limit, -limit / 2, limit / 2, limit]) {
    const widened = makeCorridor(route, {
      halfWidth: Math.max(corridor.halfWidthAt((window.from + window.to) / 2), Math.abs(lat)),
      closures: corridor.closures,
    });
    const chain = runEvidenceChain({ route, corridor: widened, landmark, occluders, thresholds, cameraOpts });
    trials.push({ lateral: lat, ...windowStats(chain, window), fingerprint: chain.fingerprint });
  }
  trials.sort((a, b) => b.windowFraction - a.windowFraction);
  const best = trials[0];
  // Fork check: the boundary rule rejects B when the walker has already
  // committed to a fork before guidance was lost — nudging the eye cannot undo
  // a turn already taken.
  const forkBeforeLoss = forks.some((f) => f.s <= window.from + 1e-9);
  return {
    scheme: 'B-guide-node',
    feasible: !forkBeforeLoss && !!best && best.windowFraction > baseStats.windowFraction + 0.02,
    reason: forkBeforeLoss ? 'a fork was entered before guidance was lost' : undefined,
    baseline: baseStats,
    best: best ? { ...best, delta: best.windowFraction - baseStats.windowFraction } : null,
    forkBeforeLoss,
  };
}

// Boundary decision combining the first guide-loss point, the fork the walker
// enters and the counterfactual single-object result.
export function decideRepair({
  route, corridor, landmark, occluders, savePoint, closure, forks = [],
  thresholds = DEFAULT_THRESHOLDS, cameraOpts = {}, budget,
}) {
  const closedCorridor = closure ? makeCorridor(route, { closures: [closure] }) : corridor;
  const chain = runEvidenceChain({
    route, corridor: closedCorridor, landmark, occluders, thresholds, cameraOpts, budget,
  });
  const reachable = new Set(walkFromSavePoint(route, closedCorridor, savePoint, closure)
    .filter(({ gate }) => gate.allowed)
    .map(({ sample }) => sample.s));
  const rows = chain.tracker.rows.filter((r) => reachable.has(r.s));
  // First *loss* of guidance: the first unreadable sample after the landmark
  // was legible at least once. A stretch that was never guided is "unseen",
  // not a loss, and is reported separately.
  let firstReadableIdx = rows.findIndex((r) => r.readable);
  let firstLossRow = null;
  if (firstReadableIdx >= 0) {
    firstLossRow = rows.slice(firstReadableIdx).find((r) => !r.readable) ?? null;
  }
  const firstLossS = firstLossRow?.s ?? null;
  const everGuided = firstReadableIdx >= 0;
  // When the guide is blocked from the outset there is no flip to anchor on;
  // build the loss window from the first reachable sample to the first legible
  // one, so the repair schemes still evaluate one concrete, evidence-backed arc.
  let lossWindow = lossWindowAround(chain, firstLossS);
  if (!lossWindow && !everGuided && rows.length) {
    const firstRead = rows.find((r) => r.readable);
    const endS = firstRead ? Math.max(rows[0].s, firstRead.s - medianStep(rows)) : rows[rows.length - 1].s;
    lossWindow = { from: rows[0].s, to: endS, count: rows.filter((r) => r.s <= endS).length };
  }
  const forkEntered = forks
    .filter((f) => firstLossS === null || f.s <= firstLossS + 1e-9)
    .sort((a, b) => b.s - a.s)[0] ?? null;

  // Per-object counterfactual over the loss window.
  let counterfactual = null;
  if (lossWindow) {
    const located = locateMismatch({
      route, corridor: closedCorridor, landmark, occluders, thresholds, cameraOpts, budget,
    });
    counterfactual = located;
  }

  const move = lossWindow
    ? evaluateMoveLandmark({
      route, corridor: closedCorridor, landmark, occluders, window: lossWindow, thresholds, cameraOpts,
    })
    : null;
  const node = lossWindow
    ? evaluateGuideNode({
      route, corridor: closedCorridor, landmark, occluders, window: lossWindow, forks, thresholds, cameraOpts,
    })
    : null;

  const perObjectRestores = counterfactual?.rootOccluder
    && (counterfactual.trials.find((t) => t.occluderId === counterfactual.rootOccluder)?.regainedM ?? 0)
      >= (lossWindow ? lossWindow.to - lossWindow.from : 0) * 0.8;

  let recommendation;
  let boundary;
  if (firstLossS === null && !everGuided) {
    recommendation = 'report-unseen';
    boundary = 'the landmark never becomes legible from any reachable corridor pose after the save point — report the stretch unseen rather than fabricate guidance';
  } else if (firstLossS === null) {
    recommendation = 'no-repair-needed';
    boundary = 'guidance held from the save point through every reachable sample';
  } else if (forkEntered) {
    recommendation = 'split-route';
    boundary = `first loss at ${firstLossS.toFixed(1)} m after entering fork "${forkEntered.id}" — an eye nudge cannot undo the committed turn`;
  } else if (perObjectRestores && (move?.feasible || counterfactual?.rootOccluder)) {
    recommendation = 'A-move-landmark';
    boundary = `single object ${counterfactual.rootOccluder} restores the window and no fork was taken before the first loss at ${firstLossS.toFixed(1)} m`;
  } else if (node?.feasible) {
    recommendation = 'B-guide-node';
    boundary = `first loss at ${firstLossS.toFixed(1)} m precedes every fork and the free viewpoint recovers the window`;
  } else {
    recommendation = 'split-route';
    boundary = `first loss at ${firstLossS.toFixed(1)} m survives single-object removal; split the route at the sightline intersections`;
  }

  const split = recommendation === 'split-route' && lossWindow
    ? splitRouteAtSightlines({
      route, corridor: closedCorridor, landmark, occluders, thresholds, cameraOpts,
      extraCuts: closure ? [closure.to] : [],
    })
    : null;

  return {
    landmarkId: landmark.id,
    routeId: route.id,
    savePointS: savePoint?.s ?? 0,
    closure: closure ?? null,
    everGuided,
    firstLossS,
    forkEntered: forkEntered ? { id: forkEntered.id, s: forkEntered.s } : null,
    lossWindow,
    counterfactual,
    move,
    node,
    split,
    recommendation,
    boundary,
    fingerprint: chain.fingerprint,
  };
}

function lossWindowAround(chain, s) {
  if (s === null || s === undefined) return null;
  const hit = chain.intervals.visible.length; // visibility gaps are the complement
  const rows = chain.tracker.rows;
  const idx = rows.findIndex((r) => Math.abs(r.s - s) < 1e-6 || r.s === s);
  if (idx < 0 || rows[idx].readable) return null;
  let a = idx, b = idx;
  while (a > 0 && !rows[a - 1].readable) a--;
  while (b < rows.length - 1 && !rows[b + 1].readable) b++;
  return { from: rows[a].s, to: rows[b].s, count: b - a + 1 };
}

function nearestSampleAt(route, s) {
  return route.samples.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a), route.samples[0]);
}

function windowStats(chain, window) {
  if (!window) return { fraction: 0, windowFraction: 1, longestGap: 0 };
  const rows = chain.tracker.rows.filter((r) => r.s >= window.from - 1e-9 && r.s <= window.to + 1e-9);
  const covered = rows.filter((r) => r.readable).length;
  let run = 0, longest = 0, lastS = null, runStart = null;
  for (const r of rows) {
    if (!r.readable) {
      if (runStart === null) runStart = r.s;
      run = r.s - runStart;
      longest = Math.max(longest, run);
    } else runStart = null;
    lastS = r.s;
  }
  return {
    fraction: chain.tracker.rows.length ? chain.tracker.rows.filter((r) => r.readable).length / chain.tracker.rows.length : 0,
    windowFraction: rows.length ? covered / rows.length : 1,
    longestGap: longest,
  };
}

// Small arc-length interval algebra (all intervals {from,to} in metres).
function mergeArc(intervals) {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to + 1e-6) last.to = Math.max(last.to, iv.to);
    else out.push({ from: iv.from, to: iv.to });
  }
  return out;
}

function subtractIntervals(a, b) {
  const out = [];
  for (const iv of a) {
    let cursor = iv.from;
    for (const cut of mergeArc(b)) {
      if (cut.to <= cursor || cut.from >= iv.to) continue;
      if (cut.from > cursor) out.push({ from: cursor, to: Math.min(cut.from, iv.to) });
      cursor = Math.max(cursor, cut.to);
    }
    if (cursor < iv.to) out.push({ from: cursor, to: iv.to });
  }
  return out.filter((iv) => iv.to - iv.from > 1e-6);
}

function totalLength(intervals) {
  return intervals.reduce((sum, iv) => sum + (iv.to - iv.from), 0);
}
