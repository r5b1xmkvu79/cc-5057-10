// Visibility measurement kernel. Implements the actual acceptance test:
//   * ray to the sign is not merely unblocked,
//   * projected footprint area is large enough after clipping,
//   * partial occlusion ratio is bounded,
//   * the centroid sits inside a safe viewport region,
//   * the shape has a minimum angular size (no one-pixel distant props).
// This measures geometric/visual conditions; it explicitly does NOT claim
// that a human reader will understand the direction.

import {
  add, sub, mul, dot, cross, norm, len, dist, lerp,
  yawToDir, rayBlockedBy, hull2D, clipPolygonFrustum, polygonArea2D, clamp, vec,
} from './geom.js';

export const DEFAULT_THRESHOLDS = {
  minVisibleFraction: 0.55,     // sign surface unoccluded
  minVisibleAreaPx: 2600,       // effective on-screen area at reference res
  maxAreaFraction: 0.30,        // never let a landmark swamp the frame
  minAngularHeightDeg: 1.25,    // rejects far one-pixel props
  minIncidenceCos: 0.34,        // panel not viewed edge-on
  minOnScreenFraction: 0.50,
  safeNdcX: 0.86,
  safeNdcY: 0.82,
  requireAllCornersInFront: true,
};

export function makeCamera({ position, yaw, pitch = 0, fovYDeg = 62, aspect = 16 / 9, width = 1280, height = 720 }) {
  const fovY = (fovYDeg * Math.PI) / 180;
  const forward = {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * Math.cos(pitch),
  };
  const worldUp = vec(0, 1, 0);
  let right = cross(forward, worldUp);
  if (len(right) < 1e-9) right = vec(1, 0, 0);
  right = norm(right);
  const up = cross(right, forward);
  const tanY = Math.tan(fovY / 2);
  const tanX = tanY * aspect;
  return { position, yaw, pitch, forward, right, up, tanX, tanY, width, height, fovYDeg };
}

export function projectPoint(cam, p) {
  const d = sub(p, cam.position);
  const x = dot(d, cam.right);
  const y = dot(d, cam.up);
  const z = dot(d, cam.forward);
  if (z <= 1e-6) return { inFront: false, nx: 0, ny: 0, px: 0, py: 0, depth: z };
  const nx = x / z / cam.tanX;
  const ny = y / z / cam.tanY;
  return {
    inFront: true,
    nx,
    ny,
    px: (nx * 0.5 + 0.5) * cam.width,
    py: (1 - (ny * 0.5 + 0.5)) * cam.height,
    depth: z,
  };
}

export function signBasis(landmark) {
  const forward = yawToDir(landmark.yaw);
  const right = norm(cross(forward, vec(0, 1, 0)));
  const up = vec(0, 1, 0);
  return { forward, right, up };
}

export function signCenter(landmark) {
  return add(landmark.position, vec(0, landmark.sign.yOffset ?? 0, 0));
}

export function signCorners(landmark) {
  const { right, up } = signBasis(landmark);
  const c = signCenter(landmark);
  const hw = landmark.sign.w / 2;
  const hh = landmark.sign.h / 2;
  return [
    add(add(c, mul(right, -hw)), mul(up, -hh)),
    add(add(c, mul(right, hw)), mul(up, -hh)),
    add(add(c, mul(right, hw)), mul(up, hh)),
    add(add(c, mul(right, -hw)), mul(up, hh)),
  ];
}

// Grid of surface samples on the sign face, in local (u,v).
export function signSamples(landmark, n = 5) {
  const { right, up } = signBasis(landmark);
  const c = signCenter(landmark);
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u = (i + 0.5) / n - 0.5;
      const v = (j + 0.5) / n - 0.5;
      out.push({
        u,
        v,
        point: add(add(c, mul(right, u * landmark.sign.w)), mul(up, v * landmark.sign.h)),
      });
    }
  }
  return out;
}

function panelNormal(landmark) {
  return yawToDir(landmark.yaw);
}

// Cheap pre-check used by the solver's broad search: visibility of the sign
// centre plus the incidence gate. Never used for reported numbers — the full
// measureLandmark() recomputes every figure.
export function quickVisible(cam, landmark, occluders, thresholds = DEFAULT_THRESHOLDS) {
  const normal = panelNormal(landmark);
  const center = signCenter(landmark);
  const toCam = sub(cam.position, center);
  const camDist = len(toCam);
  if (camDist < 1e-3 || camDist > 120) return null;
  const incidence = dot(normal, norm(toCam));
  if (incidence < thresholds.minIncidenceCos) return null;
  const proj = projectPoint(cam, center);
  if (!proj.inFront || Math.abs(proj.nx) > 0.95 || Math.abs(proj.ny) > 0.92) return null;
  const d = sub(center, cam.position);
  const L = len(d);
  if (rayBlockedBy(cam.position, mul(d, 1 / L), occluders, L - 0.02)) return null;
  return { nx: proj.nx, ny: proj.ny, dist: camDist, incidence };
}

// Evaluate one landmark from one camera. `occluders` is an array of AABBs
// {min:{x,y,z}, max:{x,y,z}, id?}. `landmark.ignoreBox` is subtracted.
export function measureLandmark(cam, landmark, occluders, thresholds = DEFAULT_THRESHOLDS) {
  const normal = panelNormal(landmark);
  const center = signCenter(landmark);
  const toCam = sub(cam.position, center);
  const camDist = len(toCam);
  if (camDist < 1e-3) return null;
  const incidence = dot(normal, norm(toCam));
  if (incidence <= 0) return null;

  // Full projected footprint, ignoring the screen (used for incidence and
  // debug). Measured only when the whole panel is in front of the camera.
  const cornerPts = signCorners(landmark);
  const camLocal = cornerPts.map((p) => {
    const d = sub(p, cam.position);
    return { x: dot(d, cam.right), y: dot(d, cam.up), z: dot(d, cam.forward) };
  });
  const rawArea = camLocal.every((p) => p.z > 0.35)
    ? polygonArea2D(camLocal.map((p) => ({ x: (p.x / p.z / cam.tanX * 0.5 + 0.5) * cam.width, y: (0.5 - p.y / p.z / cam.tanY * 0.5) * cam.height })))
    : 0;
  // Exact on-screen area: clip the panel polygon against the real frustum, then
  // project. This is what the GPU effectively sees, so it agrees with renders.
  const clipped = clipPolygonFrustum(camLocal, cam.tanX, cam.tanY, 0.35);
  let onScreenArea = 0;
  if (clipped.length >= 3) {
    const proj = clipped.map((p) => ({
      x: (p.x / p.z / cam.tanX * 0.5 + 0.5) * cam.width,
      y: (0.5 - p.y / p.z / cam.tanY * 0.5) * cam.height,
    }));
    onScreenArea = polygonArea2D(proj);
  }
  // If the panel is wholly behind the camera, there is nothing to measure.
  if (camLocal.every((p) => p.z < 0.35)) return null;
  const corners = cornerPts.map((p) => projectPoint(cam, p));

  // A landmark mounted on its own building (e.g. a clock on the Mint) must not
  // be occluded by that building's face.
  const selfIds = new Set([`occluder:${landmark.id}`, ...(landmark.ignoreOccluderIds ?? [])]);
  const blockers = occluders.filter((b) => !selfIds.has(b.id));
  const samples = signSamples(landmark, 5);
  let unoccluded = 0;
  let onScreen = 0;
  let visible = 0;
  let sumNx = 0, sumNy = 0;
  const visPts = [];
  const blockerVotes = {};
  for (const s of samples) {
    const proj = projectPoint(cam, s.point);
    const inside = proj.inFront && Math.abs(proj.nx) <= 1 && Math.abs(proj.ny) <= 1;
    let free = false;
    if (proj.inFront) {
      const d = sub(s.point, cam.position);
      const L = len(d);
      // Panel surface point can self-intersect only its own landmark; occluders
      // are scenery, so a small back-off excludes contact cases.
      const hit = rayBlockedBy(cam.position, mul(d, 1 / L), blockers, L - 0.02);
      free = !hit;
      if (hit) {
        const id = hit.box.id ?? 'unknown';
        blockerVotes[id] = (blockerVotes[id] || 0) + 1;
      }
    }
    if (free) unoccluded++;
    if (inside) onScreen++;
    if (inside && free) {
      visible++;
      sumNx += proj.nx;
      sumNy += proj.ny;
      visPts.push({ x: proj.px, y: proj.py });
    }
  }
  const visibleFraction = unoccluded / samples.length;
  const onScreenFraction = onScreen / samples.length;
  const centroidNx = visible > 0 ? sumNx / visible : 0;
  const centroidNy = visible > 0 ? sumNy / visible : 0;
  const visibleAreaPx = onScreenArea * visibleFraction;
  const angularHeightDeg = (2 * Math.atan(landmark.sign.h / (2 * camDist)) * 180) / Math.PI;

  const reasons = [];
  if (visibleFraction < thresholds.minVisibleFraction) reasons.push('occluded');
  if (onScreenFraction < thresholds.minOnScreenFraction) reasons.push('off-screen');
  if (visibleAreaPx < thresholds.minVisibleAreaPx) reasons.push('small-area');
  if (visibleAreaPx > thresholds.maxAreaFraction * cam.width * cam.height) reasons.push('swamps-frame');
  if (angularHeightDeg < thresholds.minAngularHeightDeg) reasons.push('too-distant');
  if (incidence < thresholds.minIncidenceCos) reasons.push('edge-on');
  if (Math.abs(centroidNx) > thresholds.safeNdcX || Math.abs(centroidNy) > thresholds.safeNdcY) reasons.push('unsafe-viewport');

  const readable = reasons.length === 0;
  return {
    readable,
    reasons,
    distance: camDist,
    incidence,
    rawAreaPx: rawArea,
    onScreenAreaPx: onScreenArea,
    visibleAreaPx,
    areaFraction: visibleAreaPx / (cam.width * cam.height),
    visibleFraction,
    onScreenFraction,
    angularHeightDeg,
    centroidNx,
    centroidNy,
    blockerVotes,
    centroidPx: {
      x: (centroidNx * 0.5 + 0.5) * cam.width,
      y: (1 - (centroidNy * 0.5 + 0.5)) * cam.height,
    },
    cornersPx: corners.map((c) => ({ x: c.px, y: c.py, inFront: c.inFront })),
    visibleSamplesPx: visPts,
    quality: readabilityScore({
      visibleFraction, visibleAreaPx, angularHeightDeg, incidence,
      centroidNx, centroidNy, thresholds, framePx: cam.width * cam.height,
    }),
  };
}

function readabilityScore(m) {
  const area = clamp(Math.log10(Math.max(1, m.visibleAreaPx) / 1000) / 2, 0, 1);
  const occ = clamp(m.visibleFraction, 0, 1);
  const ang = clamp(m.angularHeightDeg / 9, 0, 1);
  const inc = clamp((m.incidence - 0.3) / 0.7, 0, 1);
  const center = clamp(1 - Math.hypot(m.centroidNx / 0.9, m.centroidNy / 0.85), 0, 1);
  return 0.34 * area + 0.22 * occ + 0.16 * ang + 0.10 * inc + 0.18 * center;
}

// Arc-length parameterised route sampling with tangents and eye heights.
export function sampleRoute(route, step = 2.5) {
  const pts = route.points.map((p) => vec(p[0], p[1] ?? 0, p[2] ?? 0));
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const l = dist(a, b);
    segs.push({ a, b, l, s: total });
    total += l;
  }
  const out = [];
  for (let s = 0; s <= total + 1e-9; s += step) {
    let seg = segs[segs.length - 1];
    for (const sg of segs) {
      if (s <= sg.s + sg.l + 1e-9) { seg = sg; break; }
    }
    const t = seg.l < 1e-9 ? 0 : clamp((s - seg.s) / seg.l, 0, 1);
    const p = lerp(seg.a, seg.b, t);
    const tangent = norm(sub(seg.b, seg.a));
    const yaw = Math.atan2(-tangent.x, -tangent.z);
    out.push({
      id: `${route.id}:${out.length}`,
      s,
      position: p,
      tangent,
      yaw,
      eyeHeight: route.eyeHeight ?? 1.65,
      adjustable: !!route.adjustable,
    });
  }
  return { samples: out, length: total };
}

// Enumerate observer poses for a route sample. Fixed-viewpoint routes only
// pan the head; free routes may also shift the standing point laterally.
export function observerPoses(sample, { panLimitDeg = 30, panSteps = 5, lateralLimit = 0, lateralSteps = 3 } = {}) {
  const poses = [];
  const pans = panSteps <= 1 ? [0] : Array.from({ length: panSteps }, (_, i) => -panLimitDeg + (2 * panLimitDeg * i) / (panSteps - 1));
  const lats = lateralSteps <= 1 || lateralLimit <= 0 ? [0] : Array.from({ length: lateralSteps }, (_, i) => -lateralLimit + (2 * lateralLimit * i) / (lateralSteps - 1));
  const right = norm(cross(sample.tangent, vec(0, 1, 0)));
  for (const lat of lats) {
    const pos = add(sample.position, mul(right, lat));
    for (const pan of pans) {
      poses.push({
        sampleId: sample.id,
        s: sample.s,
        position: pos,
        yaw: sample.yaw + (pan * Math.PI) / 180,
        pan,
        lateral: lat,
        adjustable: sample.adjustable,
      });
    }
  }
  return poses;
}

// First route sample (by arc length) at which a landmark becomes readable.
// This is "where the passenger genuinely sees the first legible contour".
export function firstVisibleS(posesBySample, landmarks, measures) {
  const out = {};
  for (const lm of landmarks) {
    out[lm.id] = null;
    for (const sample of posesBySample) {
      const m = measures[`${sample.sampleId}|${lm.id}`];
      if (m && m.readable) { out[lm.id] = sample.s; break; }
    }
  }
  return out;
}
