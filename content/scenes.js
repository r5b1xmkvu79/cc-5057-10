// Scenarios built on the shared Harbor Quarter district.
//
// ROUTE A — "Plaza Walk": free viewpoint, may nudge the standing point at the
//   corner and look around. Shares the cistern-block set-piece with Route B.
// ROUTE B — "Tram Line": seated passengers, fixed viewpoint, only ±10° head
//   pan. The eye cannot be relocated; landmarks or an explicit "unseen" report
//   are the only honest options.
//
// Key segments are arc-length windows that each need a legible guide shape.

import { DISTRICT } from './world.js';

const DEG = Math.PI / 180;

export const SCENES = {
  'harbor-quarter': {
    id: 'harbor-quarter',
    name: 'Harbor Quarter — two routes, one set-piece',
    objectName: 'Harbor Quarter',
    district: DISTRICT,
    routes: [
      {
        id: 'plaza-walk',
        name: 'Plaza Walk',
        // West approach → shared street → around the cistern → north-east.
        points: [
          [-92, 0, 34], [-86, 0, 30], [-78, 0, 26], [-68, 0, 22], [-58, 0, 18],
          [-48, 0, 14], [-38, 0, 11], [-26, 0, 9], [-14, 0, 8], [-2, 0, 8],
          [10, 0, 8], [20, 0, 9], [30, 0, 8], [36, 0, 5], [38, 0, 1], [38, 0, -4], [40, 0, -8],
        ],
        eyeHeight: 1.7,
        viewpoint: { mode: 'free', lateralLimit: 1.8, panLimitDeg: 35 },
        keySegFrac: [
          { fromFrac: 0.00, toFrac: 0.24, label: 'West approach' },
          { fromFrac: 0.24, toFrac: 0.50, label: 'Cistern street' },
          { fromFrac: 0.50, toFrac: 0.76, label: 'Meeting-house corner' },
          { fromFrac: 0.76, toFrac: 1.00, label: 'North descent' },
        ],
      },
      {
        id: 'tram-line',
        name: 'Tram Line',
        // Depot → same shared street → mint bend → terminus.
        points: [
          [-88, 0, 58], [-86, 0, 48], [-84, 0, 36], [-82, 0, 24], [-80, 0, 16],
          [-74, 0, 13], [-62, 0, 12], [-48, 0, 12], [-34, 0, 12], [-20, 0, 12],
          [-6, 0, 12], [8, 0, 12], [20, 0, 12], [30, 0, 10], [36, 0, 6], [39, 0, 0], [40, 0, -6],
        ],
        eyeHeight: 2.35,
        viewpoint: { mode: 'fixed', panLimitDeg: 10, lateralLimit: 0 },
        keySegFrac: [
          { fromFrac: 0.00, toFrac: 0.24, label: 'Depot approach' },
          { fromFrac: 0.24, toFrac: 0.50, label: 'Cistern west side' },
          { fromFrac: 0.50, toFrac: 0.78, label: 'Mint bend' },
          { fromFrac: 0.78, toFrac: 1.00, label: 'Terminus' },
        ],
      },
    ],
    landmarkTypes: ['spire', 'gate', 'ribbon', 'lantern', 'arch'],
    historicPoints: [
      { type: 'mint', position: { x: 41.8, y: 0, z: -6 }, yaw: Math.PI / 2, id: 'old-mint-clock', ignoreOccluderIds: ['old-mint'] },
    ],
    // The shared road sign: the same cistern block hides it from both
    // approaches, and it is revealed at the corner on each route. This is the
    // "same set-piece, two routes" deliverable, authored once here.
    roadsideSign: { type: 'spire', position: { x: 16, y: 0, z: -13 }, yaw: Math.PI, id: 'cistern-roadside-sign' },
    // Two landmarks whose panels partly hide each other's guide line on the
    // plaza walk. The editor offers migrate-vs-observer tradeoffs for this pair.
    // Both are real, useful guides on the plaza walk; the wide gatehouse
    // currently hides most of the spire's sightline. Measured live in the UI.
    mutualPair: [
      { type: 'arch', position: { x: -40, y: 0, z: 7 }, yaw: Math.PI / 2, id: 'mutual-arch' },
      { type: 'spire', position: { x: -28, y: 0, z: -6 }, yaw: (3 * Math.PI) / 4, id: 'mutual-spire' },
    ],
    mutualRouteId: 'plaza-walk',
  },
};

export function materializeScene(scene, sampleRoute) {
  const routesById = {};
  const routes = [];
  for (const spec of scene.routes) {
    const { samples, length } = sampleRoute(spec, 2.0);
    const route = {
      id: spec.id, name: spec.name, samples, length,
      eyeHeight: spec.eyeHeight, viewpoint: spec.viewpoint, points: spec.points,
    };
    routes.push(route);
    routesById[route.id] = route;
  }
  const keySegments = [];
  for (const spec of scene.routes) {
    const route = routesById[spec.id];
    for (const k of spec.keySegFrac) {
      keySegments.push({
        routeId: spec.id,
        from: k.fromFrac * route.length,
        to: k.toFrac * route.length,
        label: k.label,
        minFraction: 0.6,
      });
    }
  }
  return { routes, routesById, keySegments };
}
