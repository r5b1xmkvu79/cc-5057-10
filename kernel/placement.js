// Placement solver. Given routes, candidate landmark types, occluders and
// constraints, choose positions + yaws so each key segment has a legible guide
// shape. It calls the same measureLandmark() the UI and the verifier use, so the
// editor can never disagree with the report.
//
// Design: candidate landmarks are scored by a precomputed *coverage vector* —
// the set of route samples at which the landmark is legible from a forward-
// facing observer (with the route's allowed head pan / lateral shift). A greedy
// weighted set-cover then adds landmarks, penalising redundancy and any
// candidate that swamps the frame. Final numbers come from a full re-evaluation,
// never from the fast path.

import {
  add, sub, mul, cross, norm, len, dist, clamp, vec,
} from './geom.js';
import {
  makeCamera, measureLandmark, quickVisible, signBasis,
  sampleRoute, observerPoses, DEFAULT_THRESHOLDS,
} from './visibility.js';

const DEG = Math.PI / 180;
const UP = vec(0, 1, 0);

export function landmarkOccluderBox(lm) {
  // A landmark is itself scenery. Slender poles would create ray-noise, so only
  // bodies at least 2.5 m across block other signs.
  const b = lm.body;
  const hw = (b?.w ?? 1.2) / 2;
  const hd = (b?.d ?? 1.2) / 2;
  const h = b?.h ?? 5;
  if (Math.max(hw, hd) * 2 < 2.5) return null;
  // Rotate the footprint into a world-space AABB so a turned gatehouse blocks
  // the sightlines its actual mass covers.
  const c = Math.abs(Math.cos(lm.yaw)), sn = Math.abs(Math.sin(lm.yaw));
  const ex = hw * c + hd * sn;
  const ez = hw * sn + hd * c;
  return {
    id: `occluder:${lm.id}`,
    min: { x: lm.position.x - ex, y: lm.position.y, z: lm.position.z - ez },
    max: { x: lm.position.x + ex, y: lm.position.y + h, z: lm.position.z + ez },
  };
}

export function withLandmarkOccluders(occluders, landmarks) {
  return [...occluders, ...landmarks.map(landmarkOccluderBox).filter(Boolean)];
}

export function landmarkFromCatalog(catalog, typeId, position, yaw, idOverride) {
  const t = catalog[typeId];
  if (!t) throw new Error(`Unknown landmark type: ${typeId}`);
  return {
    id: idOverride ?? `${typeId}-${Math.round(position.x)}-${Math.round(position.z)}`,
    type: typeId,
    name: t.name,
    color: t.color,
    position: { x: position.x, y: position.y ?? 0, z: position.z },
    yaw,
    sign: { ...t.sign },
    body: { ...t.body },
    historic: !!t.historic,
    note: t.note,
    ignoreOccluderIds: [],
  };
}

export function groundHeight(platforms = [], p) {
  let h = 0;
  for (const pl of platforms) {
    if (p.x >= pl.min.x && p.x <= pl.max.x && p.z >= pl.min.z && p.z <= pl.max.z) {
      h = Math.max(h, pl.max.y);
    }
  }
  return h;
}

export function collides(occluders, center, radius, ignoreId) {
  for (const b of occluders) {
    if (ignoreId && b.id === ignoreId) continue;
    if (center.x + radius > b.min.x && center.x - radius < b.max.x &&
        center.z + radius > b.min.z && center.z - radius < b.max.z) {
      return b;
    }
  }
  return null;
}

function tooCloseToRoutes(lm, routesById, minDist) {
  for (const route of Object.values(routesById)) {
    for (const samp of route.samples) {
      const d = Math.hypot(samp.position.x - lm.position.x, samp.position.z - lm.position.z);
      if (d < minDist) return true;
    }
  }
  return false;
}

function inZone(zones, p) {
  return zones.some((z) => p.x >= z.minX && p.x <= z.maxX && p.z >= z.minZ && p.z <= z.maxZ);
}

// ---------------------------------------------------------------------------
// Observer poses used by *both* the fast coverage vector and the full report.

export function cameraForPose(route, sample, pose, opts) {
  return makeCamera({
    position: { x: pose.position.x, y: sample.position.y + sample.eyeHeight, z: pose.position.z },
    yaw: pose.yaw,
    fovYDeg: opts.fovYDeg ?? 62,
    aspect: opts.aspect ?? 16 / 9,
    width: opts.width ?? 1280,
    height: opts.height ?? 720,
  });
}

function posesFor(route, sample, panSteps) {
  const vp = route.viewpoint;
  if (vp.mode === 'fixed') {
    return observerPoses(sample, { panLimitDeg: vp.panLimitDeg ?? 0, panSteps, lateralLimit: 0, lateralSteps: 1 });
  }
  return observerPoses(sample, {
    panLimitDeg: vp.panLimitDeg ?? 35,
    panSteps,
    lateralLimit: vp.lateralLimit ?? 0,
    lateralSteps: 3,
  });
}

function measureBest(camOptsList, lm, occluders, thresholds, quick = false) {
  let top = null;
  for (const cam of camOptsList) {
    if (quick) {
      // Broad phase: only fully measure poses that pass the cheap gate, so the
      // coverage vector still reflects the real acceptance test.
      if (!quickVisible(cam, lm, occluders, thresholds)) continue;
    }
    const m = measureLandmark(cam, lm, occluders, thresholds);
    if (m && (!top || m.quality > top.quality)) top = m;
  }
  return top;
}

// Per-sample camera banks depend only on the route, not the landmark, so build
// them once and reuse them across all candidate coverage vectors.
const bankCache = new Map();

export function cameraBank(route, panSteps, opts) {
  const key = `${route.id}|${panSteps}|${opts.fovYDeg}|${opts.aspect}|${opts.width}|${opts.height}`;
  if (bankCache.has(key)) return bankCache.get(key);
  const bank = route.samples.map((sample) =>
    posesFor(route, sample, panSteps).map((p) => cameraForPose(route, sample, p, opts)));
  bankCache.set(key, bank);
  return bank;
}

export function clearCameraCache() { bankCache.clear(); }

// ---------------------------------------------------------------------------
// Candidate generation: a grid over walkable ground, pruned to positions that
// are near at least one route and not embedded in scenery.

export function generateCandidates(routesById, context, options = {}) {
  const { catalog, occluders, platforms = [], forbiddenZones = [], landmarkTypes, fieldBounds } = context;
  const cell = options.gridStep ?? 5;
  const radius = options.radius ?? 2.4;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const b = fieldBounds ?? expandBounds(boundsOfRoutes(routesById), 45);
  minX = b.min.x; maxX = b.max.x; minZ = b.min.z; maxZ = b.max.z;
  const maxRouteDist = options.maxRouteDist ?? 70;

  const out = [];
  const seen = new Set();
  for (let x = minX; x <= maxX + 1e-6; x += cell) {
    for (let z = minZ; z <= maxZ + 1e-6; z += cell) {
      const pos = { x, y: 0, z };
      if (collides(occluders, pos, radius)) continue;
      if (inZone(forbiddenZones, pos)) continue;
      const y = groundHeight(platforms, pos);
      pos.y = y;
      // Nearest route sample (also gives a natural facing target).
      let nearest = null, nd = Infinity;
      for (const route of Object.values(routesById)) {
        for (const samp of route.samples) {
          const d = Math.hypot(samp.position.x - x, samp.position.z - z);
          if (d < nd) { nd = d; nearest = samp; }
        }
      }
      if (!nearest || nd > maxRouteDist || nd < 3.2) continue;
      for (const typeId of landmarkTypes) {
        const t = catalog[typeId];
        if (!t || t.historic) continue;
        // Face the nearest route point, with a few yaw variations so the panel
        // is not always forced perpendicular to the street.
        const baseYaw = Math.atan2(-(nearest.position.x - x), -(nearest.position.z - z));
        for (const yawOff of [-28, 0, 28]) {
          const yaw = baseYaw + yawOff * DEG;
          const key = `${typeId}|${Math.round(x)}|${Math.round(z)}|${Math.round(yaw / DEG)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const lm = landmarkFromCatalog(catalog, typeId, pos, yaw, `${typeId}@${Math.round(x)},${Math.round(z)}`);
          if (tooCloseToRoutes(lm, routesById, 3.0)) continue;
          out.push({ landmark: lm, nearestS: { routeId: nearest.id, s: nearest.s }, nearestDist: nd });
        }
      }
    }
  }
  return out;
}

function boundsOfRoutes(routesById) {
  const min = { x: Infinity, y: 0, z: Infinity };
  const max = { x: -Infinity, y: 0, z: -Infinity };
  for (const r of Object.values(routesById)) {
    for (const s of r.samples) {
      min.x = Math.min(min.x, s.position.x); max.x = Math.max(max.x, s.position.x);
      min.z = Math.min(min.z, s.position.z); max.z = Math.max(max.z, s.position.z);
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// Coverage vector: which (route, sample) pairs are legible for a landmark.
// stride controls cost. Each entry carries the best measurement quality.

export function coverageVector(lm, routesById, occluders, opts = {}) {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const stride = opts.stride ?? 2;
  const panSteps = opts.panSteps ?? 3;
  const maxDist = opts.maxDist ?? 95;
  const quick = opts.quick ?? true;
  const vector = [];
  const byRoute = {};
  let swamped = 0;
  let maxAreaFraction = 0;
  for (const [routeId, route] of Object.entries(routesById)) {
    byRoute[routeId] = [];
    const bank = cameraBank(route, panSteps, opts);
    for (let i = 0; i < route.samples.length; i += stride) {
      const sample = route.samples[i];
      const rough = Math.hypot(sample.position.x - lm.position.x, sample.position.z - lm.position.z);
      if (rough > maxDist) continue;
      const best = measureBest(bank[i], lm, occluders, thresholds, quick);
      if (!best) continue;
      maxAreaFraction = Math.max(maxAreaFraction, best.areaFraction);
      if (best.reasons.includes('swamps-frame')) swamped++;
      if (best.readable) {
        vector.push({ routeId, sampleIndex: i, s: sample.s, quality: best.quality, measure: best });
        byRoute[routeId].push({ sampleIndex: i, s: sample.s, quality: best.quality });
      }
    }
  }
  return { lm, vector, byRoute, swamped, maxAreaFraction };
}

// ---------------------------------------------------------------------------
// Full evaluation of a plan with the exact same measurement path. Used for all
// reported numbers and for the UI result panel.

export function evaluatePlan(plan, routesById, occluders, options = {}) {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const fovYDeg = options.fovYDeg ?? 62;
  const aspect = options.aspect ?? 16 / 9;
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const landmarks = plan.landmarks;
  const perRoute = {};

  for (const [routeId, route] of Object.entries(routesById)) {
    const samples = [];
    for (const samp of route.samples) {
      const poses = posesFor(route, samp, 7);
      const cams = poses.map((p) => cameraForPose(route, samp, p, { fovYDeg, aspect, width, height }));
      const best = {};
      for (const lm of landmarks) {
        best[lm.id] = measureBest(cams, lm, occluders, thresholds);
      }
      const visibleIds = landmarks.filter((lm) => best[lm.id]?.readable).map((lm) => lm.id);
      samples.push({
        sampleId: samp.id,
        s: samp.s,
        position: samp.position,
        yaw: samp.yaw,
        eyeHeight: samp.eyeHeight,
        best,
        visibleIds,
      });
    }
    perRoute[routeId] = samples;
  }
  const coverage = computeCoverage(routesById, perRoute, plan);
  return { plan, perRoute, coverage, thresholds };
}

function computeCoverage(routesById, perRoute, plan) {
  const routeCoverage = {};
  const keySegments = plan.keySegments ?? [];
  for (const [routeId, route] of Object.entries(routesById)) {
    const samples = perRoute[routeId];
    const total = samples.length;
    let covered = 0;
    const gaps = [];
    let runStart = null;
    for (const sample of samples) {
      const ok = sample.visibleIds.length > 0;
      if (ok) {
        covered++;
        if (runStart !== null) { gaps.push({ from: runStart.s, to: sample.s }); runStart = null; }
      } else if (runStart === null) {
        runStart = sample;
      }
    }
    if (runStart !== null) gaps.push({ from: runStart.s, to: samples[samples.length - 1].s });
    let longestGap = null;
    for (const g of gaps) if (!longestGap || g.to - g.from > longestGap.to - longestGap.from) longestGap = g;
    const segments = keySegments.filter((k) => k.routeId === routeId).map((k) => {
      const inSeg = samples.filter((s) => s.s >= k.from && s.s <= k.to);
      const cov = inSeg.filter((s) => s.visibleIds.length > 0).length;
      return {
        ...k, samples: inSeg.length, covered: cov,
        fraction: inSeg.length ? cov / inSeg.length : 0,
        pass: inSeg.length > 0 && (inSeg.length ? cov / inSeg.length : 0) >= (k.minFraction ?? 0.6),
      };
    });
    routeCoverage[routeId] = {
      total, covered, fraction: total ? covered / total : 0,
      gaps, longestGap, longestGapLength: longestGap ? longestGap.to - longestGap.from : 0,
      keySegments: segments,
      allKeySegmentsPass: segments.every((s) => s.pass),
    };
  }
  return { byRoute: routeCoverage };
}

// ---------------------------------------------------------------------------
// Greedy weighted set cover over precomputed coverage vectors.

function assignWeights(routesById, keySegments) {
  // Base weight 1, key-segment samples weighted 2.5, and never-covered edges
  // matter a little more so a solver does not ignore the route ends.
  const weight = {};
  for (const [routeId, route] of Object.entries(routesById)) {
    route.samples.forEach((samp, i) => {
      const inKey = keySegments.some((k) => k.routeId === routeId && samp.s >= k.from && samp.s <= k.to);
      weight[`${routeId}:${i}`] = inKey ? 2.5 : 1.0;
    });
  }
  return weight;
}

// Index each route sample to the key segment that contains it, so the greedy
// pass can weight under-covered segments. `coveredIn()` closes over the live
// `covered` set assigned after construction.
function buildSegmentIndex(routesById, keySegments) {
  const map = new Map();
  for (const k of keySegments) {
    const route = routesById[k.routeId];
    if (!route) continue;
    const inSeg = route.samples
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.s >= k.from && s.s <= k.to);
    const key = `${k.routeId}:${k.from.toFixed(1)}:${k.to.toFixed(1)}`;
    const weight = k.weight ?? 2.0;
    for (const { i } of inSeg) {
      map.set(`${k.routeId}:${i}`, {
        key,
        seg: k,
        total: inSeg.length,
        weight,
        coveredIn: () => inSeg.filter(({ i: idx }) => segCoveredRef.has(`${k.routeId}:${idx}`)).length,
      });
    }
  }
  return map;
}

let segCoveredRef = new Set();

function tooCloseToFixed(lm, fixed, d) {
  return fixed.some((f) => Math.hypot(f.position.x - lm.position.x, f.position.z - lm.position.z) < d);
}

export function solvePlacement({ routesById, context, options = {} }) {
  const {
    catalog, occluders, landmarkTypes, keySegments = [], historicLandmarks = [],
    fixedLandmarks = [], platforms = [], forbiddenZones = [], fieldBounds,
  } = context;
  const maxLandmarks = options.maxLandmarks ?? 4;
  const evalOpts = {
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    fovYDeg: options.fovYDeg ?? 62,
    aspect: options.aspect ?? 16 / 9,
    width: options.width ?? 1280,
    height: options.height ?? 720,
  };
  const stride = options.stride ?? 2;

  const candidates = generateCandidates(routesById, {
    catalog, occluders, platforms, forbiddenZones, landmarkTypes, fieldBounds,
  }, options);
  // Fixed landmarks (locked historic face, deliberate roadside sign) are part
  // of the plan from the start and also count as their own coverage.
  const fixedScored = fixedLandmarks.map((lm) => ({
    cand: { landmark: lm, fixed: true },
    cov: coverageVector(lm, routesById, occluders, { ...evalOpts, stride, panSteps: 3, quick: true }),
  }));
  // Coverage vectors are independent of other landmarks: compute once.
  const scored = candidates.map((c) => ({
    cand: c,
    cov: coverageVector(c.landmark, routesById, occluders, { ...evalOpts, stride, panSteps: 3, quick: true }),
  }));

  const weight = assignWeights(routesById, keySegments);
  const segIndex = buildSegmentIndex(routesById, keySegments);
  const covered = new Set();
  segCoveredRef = covered;
  const chosen = [];
  const trace = [];
  for (const f of fixedScored) {
    for (const hit of f.cov.vector) covered.add(`${hit.routeId}:${hit.sampleIndex}`);
  }

  for (let round = 0; round < maxLandmarks; round++) {
    let best = null;
    for (const sc of scored) {
      if (chosen.includes(sc)) continue;
      if (tooCloseToFixed(sc.cand.landmark, fixedLandmarks, 6)) continue;
      let gain = 0;
      const newly = [];
      const segNew = new Map();
      for (const hit of sc.cov.vector) {
        const k = `${hit.routeId}:${hit.sampleIndex}`;
        const seg = segIndex.get(k);
        if (seg) {
          const cur = segNew.get(seg.key) ?? { count: 0, seg };
          cur.count++;
          segNew.set(seg.key, cur);
        }
        if (covered.has(k)) continue;
        gain += weight[k] ?? 1;
        newly.push(hit);
      }
      // Segment-balance term: reward candidates that fill the emptiest key
      // segments, scaled relative to each segment's length.
      let segBonus = 0;
      for (const { count, seg } of segNew.values()) {
        const already = seg.coveredIn();
        const missing = seg.total - already;
        if (missing <= 0) continue;
        const canFill = Math.min(count, missing) / seg.total;
        segBonus += canFill * (seg.weight ?? 2.0);
      }
      // Redundancy with already-chosen landmarks.
      let redundancy = 0;
      for (const other of chosen) {
        const d = dist(sc.cand.landmark.position, other.cand.landmark.position);
        if (d < 26) redundancy += (26 - d) / 26;
      }
      const swampPenalty = sc.cov.swamped * 4 + (sc.cov.maxAreaFraction > 0.28 ? 2 : 0);
      const score = gain + segBonus * 1.6 - redundancy * 1.6 - swampPenalty;
      if (!best || score > best.score) best = { sc, score, gain, newly, redundancy, segBonus };
    }
    if (!best || best.gain < 2) {
      trace.push({ round, decision: 'stop', reason: 'no remaining candidate adds meaningful coverage' });
      break;
    }
    chosen.push(best.sc);
    for (const hit of best.newly) covered.add(`${hit.routeId}:${hit.sampleIndex}`);
    trace.push({
      round, decision: 'place', landmarkId: best.sc.cand.landmark.id, type: best.sc.cand.landmark.type,
      position: best.sc.cand.landmark.position, yaw: best.sc.cand.landmark.yaw,
      score: best.score, gain: best.gain, redundancy: best.redundancy, segBonus: best.segBonus,
      newSamples: best.newly.length,
      newKeySamples: best.newly.filter((h) => (weight[`${h.routeId}:${h.sampleIndex}`] ?? 1) > 1).length,
      reason: `adds ${best.newly.length} readable sample(s) (${best.newly.filter((h) => (weight[`${h.routeId}:${h.sampleIndex}`] ?? 1) > 1).length} in key segments)`,
    });
  }

  const landmarkOrder = chosen.map((c) => c.cand.landmark);
  const plan = { landmarks: [...historicLandmarks, ...fixedLandmarks, ...landmarkOrder], keySegments };
  const evaluation = evaluatePlan(plan, routesById, occluders, evalOpts);
  return {
    plan,
    evaluation,
    trace,
    candidatesConsidered: scored.length,
    explanation: explainPlan(plan, evaluation, routesById, trace, historicLandmarks),
  };
}

export function explainPlan(plan, evalResult, routesById, trace, historicLandmarks = []) {
  const lines = [];
  const historicIds = new Set(historicLandmarks.map((h) => h.id));
  for (const [routeId, rc] of Object.entries(evalResult.coverage.byRoute)) {
    const route = routesById[routeId];
    const vp = route.viewpoint;
    const vpText = vp.mode === 'fixed'
      ? (vp.panLimitDeg === 0 ? 'fixed forward view, cannot move or turn the head'
        : `fixed seat, head pan limited to ±${vp.panLimitDeg}°`)
      : `free viewpoint (may step up to ${(vp.lateralLimit ?? 1).toFixed(1)} m sideways)`;
    const segs = rc.keySegments.map((k) => `${k.label ?? `${k.from.toFixed(0)}–${k.to.toFixed(0)}m`}: ${(k.fraction * 100).toFixed(0)}% ${k.pass ? 'PASS' : 'FAIL'}`).join('; ');
    lines.push(`${route.name} [${vpText}] — covered ${(rc.fraction * 100).toFixed(0)}%, longest blind run ${rc.longestGapLength.toFixed(1)} m. Key segments: ${segs}.`);
    if (!rc.allKeySegmentsPass) {
      lines.push(`  ⚠ ${route.name} still has failing key segments. ${vp.mode === 'fixed'
        ? 'On a fixed route the viewpoint cannot be adjusted, so the honest options are to relocate a landmark or explicitly report this stretch as unseen.'
        : 'Free viewpoint: the corner sightline may need a nudged guide point or an extra landmark.'}`);
    }
  }
  for (const lm of plan.landmarks ?? []) {
    if (lm.fixedReason) lines.push(`Kept ${lm.name} at (${lm.position.x.toFixed(0)}, ${lm.position.z.toFixed(0)}) — ${lm.fixedReason}.`);
  }
  for (const t of trace) {
    if (t.decision === 'place' && !historicIds.has(t.landmarkId)) {
      lines.push(`Placed ${t.type} at (${t.position.x.toFixed(0)}, ${t.position.z.toFixed(0)}) — ${t.reason}.`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Mutual-occlusion trade-off: compare migrating a landmark vs adjusting the
// observer, and report the measured longest blind run for each.

export function compareTradeoff({ plan, routesById, context, options = {} }) {
  const evalOpts = {
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    fovYDeg: options.fovYDeg ?? 62,
    aspect: options.aspect ?? 16 / 9,
    width: options.width ?? 1280,
    height: options.height ?? 720,
  };
  const routeId = options.routeId;
  const route = routesById[routeId];
  const [a, b] = options.objects;
  if (!a || !b) return null;

  // The contested window: samples where the blocker's presence changes whether
  // the hidden sign is readable. Everything outside it is irrelevant noise.
  const pairPlan = { ...plan, landmarks: [a, b], keySegments: plan.keySegments ?? [] };
  const withBoth = evaluatePlan(pairPlan, routesById, context.occluders, evalOpts);
  const aAlone = evaluatePlan({ ...plan, landmarks: [a], keySegments: [] }, routesById, context.occluders, evalOpts);
  const bAlone = evaluatePlan({ ...plan, landmarks: [b], keySegments: [] }, routesById, context.occluders, evalOpts);
  const contested = [];
  const bothSamples = withBoth.perRoute[routeId];
  const bSamples = bAlone.perRoute[routeId];
  for (let i = 0; i < bothSamples.length; i++) {
    const mb = bothSamples[i].best[b.id];
    // Contested = the partner landmark's own mass is what blocks this sign.
    const blockedByA = (mb?.blockerVotes?.[`occluder:${a.id}`] ?? 0) > 0
      || (mb?.blockerVotes?.[a.id] ?? 0) > 0;
    if (blockedByA) contested.push({ i, s: bothSamples[i].s });
  }
  const window = contested.length
    ? { from: contested[0].s, to: contested[contested.length - 1].s, count: contested.length }
    : null;

  const base = winStats(withBoth, routeId, window, b.id);

  let bestMigration = null;
  for (const off of [-26, -20, -14, -8, 8, 14, 20, 26]) {
    for (const yawOff of [-40, -20, 0, 20, 40]) {
      const near = nearestSample(route, b.position);
      const right = norm(cross(near.tangent, UP));
      const pos = { x: b.position.x + right.x * off, y: 0, z: b.position.z + right.z * off };
      pos.y = groundHeight(context.platforms ?? [], pos);
      if (collides(context.occluders, pos, 2.4, b.id)) continue;
      if (tooCloseToRoutes({ position: pos }, routesById, 3)) continue;
      const cand = { ...b, position: pos, yaw: b.yaw + yawOff * DEG };
      const ev = evaluatePlan({ ...plan, landmarks: [a, cand], keySegments: [] }, routesById, context.occluders, evalOpts);
      const st = winStats(ev, routeId, window, b.id);
      const score = st.windowFraction * 2 + st.fraction - st.longestGap / 60;
      if (!bestMigration || score > bestMigration.score) bestMigration = { score, landmark: cand, stats: st, keyPass: ev.coverage.byRoute[routeId].allKeySegmentsPass };
    }
  }

  let bestObserver = { available: false, reason: route.viewpoint.mode === 'fixed'
    ? 'fixed-route passengers cannot change viewpoint'
    : 'no contested window to adjust' };
  if (route.viewpoint.mode === 'free' && window) {
    const midS = (window.from + window.to) / 2;
    const near = nearestSampleByS(route, midS);
    const limit = route.viewpoint.lateralLimit ?? 1.4;
    for (const lat of [-limit, -limit / 2, limit / 2, limit]) {
      const ev = evaluatePlanWithObserver({ ...plan, landmarks: [a, b], keySegments: [] }, routesById, context.occluders, evalOpts, {
        routeId, sampleId: near.id, lateral: lat,
      });
      const st = winStats(ev, routeId, window, b.id);
      const score = st.windowFraction * 2 + st.fraction - st.longestGap / 60;
      if (!bestObserver.available || score > bestObserver.score) {
        bestObserver = { available: true, score, lateral: lat, ...st };
      }
    }
  }

  return {
    routeId,
    objects: [a.id, b.id],
    window,
    base: { ...base, keyPass: withBoth.coverage.byRoute[routeId].allKeySegmentsPass },
    migrate: bestMigration ? {
      ...bestMigration.stats,
      landmark: bestMigration.landmark,
      keyPass: bestMigration.keyPass,
      delta: bestMigration.stats.windowFraction - base.windowFraction,
    } : null,
    observer: bestObserver,
    recommendation: recommendTradeoff(bestMigration, bestObserver, base),
  };
}

function winStats(ev, routeId, window, targetId) {
  const samples = ev.perRoute[routeId];
  const rc = ev.coverage.byRoute[routeId];
  if (!window) return { fraction: rc.fraction, windowFraction: 1, longestGap: rc.longestGapLength, window: null };
  const inWin = samples.filter((s) => s.s >= window.from && s.s <= window.to);
  // The contested window is about the *hidden* landmark: does the passenger
  // have a legible guide at the place the blocker interferes? Other landmarks
  // are not counted here — that would hide the cost of the occlusion.
  const visible = (s) => targetId ? !!s.best[targetId]?.readable : s.visibleIds.length > 0;
  const cov = inWin.filter(visible).length;
  // Longest blind run measured only inside the contested window.
  let run = null, longest = 0;
  for (const s of inWin) {
    if (!visible(s)) { if (run === null) run = s.s; }
    else if (run !== null) { longest = Math.max(longest, s.s - run); run = null; }
  }
  if (run !== null) longest = Math.max(longest, inWin[inWin.length - 1].s - run);
  return {
    fraction: rc.fraction,
    windowFraction: inWin.length ? cov / inWin.length : 1,
    windowCovered: cov,
    windowSamples: inWin.length,
    longestGap: window.from != null ? Math.max(longest, 0) : 0,
    window: { from: window.from, to: window.to, length: window.to - window.from },
  };
}

function recommendTradeoff(migrate, observer, base) {
  const m = migrate ? migrate.stats.windowFraction : -1;
  const o = observer?.available ? observer.windowFraction : -1;
  const b = base.windowFraction;
  if (m < 0 && o < 0) return 'Neither migration nor observer adjustment is available; report the contested stretch as unseen.';
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  if (o > m + 0.02) return `Prefer adjusting the observation point: it recovers ${pct(o)} of the contested window vs ${pct(m)} for migration (currently ${pct(b)}), while leaving the landmark where it is.`;
  if (m > o + 0.02) return `Prefer migrating the landmark: it recovers ${pct(m)} of the contested window vs ${pct(o)} for the observer nudge (currently ${pct(b)}). Permanent, but a seated route cannot use the observer option at all.`;
  return `Both options measure within ~2% of each other on the contested window (base ${pct(b)}, migrate ${pct(m)}, observer ${pct(o)}). Choose by authoring cost: migration is permanent, the observer nudge is local to the corner — and only free routes may take it.`;
}

function nearestSample(route, p) {
  let best = route.samples[0], bd = Infinity;
  for (const s of route.samples) {
    const d = Math.hypot(s.position.x - p.x, s.position.z - p.z);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function nearestSampleByS(route, s) {
  let best = route.samples[0], bd = Infinity;
  for (const smp of route.samples) {
    const d = Math.abs(smp.s - s);
    if (d < bd) { bd = d; best = smp; }
  }
  return best;
}

function evaluatePlanWithObserver(plan, routesById, occluders, evalOpts, override) {
  const route = routesById[override.routeId];
  const near = route.samples.find((s) => s.id === override.sampleId) ?? nearestSampleByS(route, override.s);
  const right = norm(cross(near.tangent, UP));
  const movedPos = { x: near.position.x + right.x * override.lateral, z: near.position.z + right.z * override.lateral };
  const modified = {
    ...route,
    samples: route.samples.map((s) => (s.id === near.id
      ? { ...s, position: { ...s.position, x: movedPos.x, z: movedPos.z } }
      : s)),
  };
  return evaluatePlan(plan, { ...routesById, [override.routeId]: modified }, occluders, evalOpts);
}

export { sampleRoute, observerPoses, makeCamera, measureLandmark, signBasis };

function expandBounds(b, m) {
  return { min: { x: b.min.x - m, y: 0, z: b.min.z - m }, max: { x: b.max.x + m, y: 0, z: b.max.z + m } };
}
