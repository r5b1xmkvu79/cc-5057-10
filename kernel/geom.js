// Pure geometry primitives. No Three.js, no DOM: this module must be usable by
// both the browser UI and the Node verification harness.

export const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a) => Math.sqrt(dot(a, a));
export const dist = (a, b) => len(sub(a, b));
export const norm = (a) => {
  const l = len(a);
  return l < 1e-12 ? vec(0, 0, 0) : mul(a, 1 / l);
};
export const lerp = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function rotateY(v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

export function yawToDir(yaw) {
  // yaw=0 looks down -Z, positive yaw turns left around +Y (three.js convention).
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

// Signed distance from point to an axis-aligned box (negative inside).
export function pointBoxDistance(p, box) {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  const outside = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (outside > 0) return outside;
  // Inside: negative distance to nearest face.
  const inx = Math.min(p.x - box.min.x, box.max.x - p.x);
  const iny = Math.min(p.y - box.min.y, box.max.y - p.y);
  const inz = Math.min(p.z - box.min.z, box.max.z - p.z);
  return -Math.min(inx, iny, inz);
}

// Slab test. Returns entry distance t in [0, tMax] or null. Robust to axis
// parallel rays (uses inverse direction; Infinity handled by the min/max ops).
export function rayBox(origin, dir, box, tMax = Infinity) {
  let t0 = 0, t1 = tMax;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis], d = dir[axis];
    const lo = box.min[axis], hi = box.max[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
    } else {
      const inv = 1 / d;
      let a = (lo - o) * inv;
      let b = (hi - o) * inv;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return null;
    }
  }
  return t0;
}

// March a ray against axis-aligned occluders. Returns true if any box is hit
// strictly before `maxDist` (with a small clearance so a target touching a
// ground plane is not considered self-occluded).
export function rayBlockedBy(origin, dir, boxes, maxDist) {
  const maxT = Math.max(0, maxDist - 1e-3);
  let best = null;
  for (const box of boxes) {
    if (pointBoxDistance(origin, box) <= 1e-3) continue;
    const t = rayBox(origin, dir, box, maxT);
    if (t !== null && t > 1e-3 && t < maxT && (!best || t < best.t)) best = { t, box };
  }
  return best;
}

export function rayBlocked(origin, dir, boxes, maxDist) {
  return rayBlockedBy(origin, dir, boxes, maxDist) !== null;
}

// Jacobi eigen-decomposition of a symmetric 3x3 matrix. Returns sorted
// eigenvalues (descending) and matching eigenvectors. Small, dependency-free.
export function eig3(m) {
  let a = [
    [m[0][0], m[0][1], m[0][2]],
    [m[1][0], m[1][1], m[1][2]],
    [m[2][0], m[2][1], m[2][2]],
  ];
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const app = a[p][p], aqq = a[q][q], apq = a[p][q];
        a[p][p] = app - t * apq;
        a[q][q] = aqq + t * apq;
        a[p][q] = a[q][p] = 0;
        for (let k = 0; k < 3; k++) {
          if (k !== p && k !== q) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = a[p][k] = c * akp - s * akq;
            a[k][q] = a[q][k] = s * akp + c * akq;
          }
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return {
    values: idx.map((i) => a[i][i]),
    vectors: idx.map((i) => ({ x: v[0][i], y: v[1][i], z: v[2][i] })),
  };
}

// Area of a convex hull (monotone chain) in 2D pixel space.
export function hull2D(points) {
  if (points.length < 3) return 0;
  const pts = points
    .map((p) => [p.x, p.y])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

// Sutherland–Hodgman clip of a polygon to the axis-aligned rect [minX,maxX]×[minY,maxY].
export function clipPolygonRect(points, minX, minY, maxX, maxY) {
  const edges = [
    (p) => p.x >= minX, (p) => p.x <= maxX,
    (p) => p.y >= minY, (p) => p.y <= maxY,
  ];
  const inter = [
    (a, b) => ({ x: minX, y: a.y + (b.y - a.y) * ((minX - a.x) / (b.x - a.x)) }),
    (a, b) => ({ x: maxX, y: a.y + (b.y - a.y) * ((maxX - a.x) / (b.x - a.x)) }),
    (a, b) => ({ y: minY, x: a.x + (b.x - a.x) * ((minY - a.y) / (b.y - a.y)) }),
    (a, b) => ({ y: maxY, x: a.x + (b.x - a.x) * ((maxY - a.y) / (b.y - a.y)) }),
  ];
  let out = points.slice();
  for (let e = 0; e < 4; e++) {
    const inside = edges[e], cut = inter[e];
    const input = out; out = [];
    if (!input.length) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci && pi) out.push(cur);
      else if (ci && !pi) { out.push(cut(prev, cur)); out.push(cur); }
      else if (!ci && pi) out.push(cut(prev, cur));
    }
  }
  return out;
}

// Clip a polygon of 3D points (camera-local frame: +X right, +Y up, +Z forward)
// against the near plane and the four side planes of a frustum. Returns a new
// polygon. This is the rendering pipeline's own operation, done analytically, so
// a sign that straddles the camera or the screen edge is measured exactly.
export function clipPolygonFrustum(points, tanX, tanY, near = 0.35) {
  const planes = [
    (p) => p.z - near,          // near
    (p) => p.x + tanX * p.z,    // left
    (p) => tanX * p.z - p.x,    // right
    (p) => p.y + tanY * p.z,    // bottom
    (p) => tanY * p.z - p.y,    // top
  ];
  let out = points.map((p) => ({ ...p }));
  for (const pd of planes) {
    const input = out; out = [];
    if (!input.length) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const dc = pd(cur), dp = pd(prev);
      const ci = dc >= 0, pi = dp >= 0;
      const cut = () => {
        const t = dp / (dp - dc);
        return { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t, z: prev.z + (cur.z - prev.z) * t };
      };
      if (ci && pi) out.push(cur);
      else if (ci && !pi) { out.push(cut()); out.push(cur); }
      else if (!ci && pi) { out.push(cut()); }
    }
  }
  return out;
}

// Area of an arbitrary simple polygon (shoelace, absolute).
export function polygonArea2D(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
