// One physical district traversed by two different game routes. The cistern
// set-piece and the Old Mint exist once here and are reused by both routes and
// by the verifier — nothing is re-authored per route.
//
// Axes: X east, Z south-ish (three.js ground plane), Y up. Metres.
//
// The cistern block at x[-2,8] z[-8,2] is deliberately placed just north of the
// shared southern street. The guide landmark at (12,12) is behind it from both
// approaches, so the same scenery piece blocks the same road sign on both the
// plaza walk and the tram line until each route passes x≈8.

export const box = (id, x0, x1, y0, y1, z0, z1, extra = {}) => ({
  id,
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
  ...extra,
});

const CIS = box('cistern-block', -2, 8, 0, 12.5, -8, 2, {
  kind: 'setpiece',
  label: 'Cistern Block (shared set-piece)',
});

const MINT = box('old-mint', 42, 58, 0, 18, -14, 2, {
  kind: 'historic',
  label: 'Old Mint (locked historic building)',
});

export const DISTRICT = {
  id: 'harbor-quarter',
  name: 'Harbor Quarter',
  ground: { minX: -100, maxX: 64, minZ: -46, maxZ: 76 },
  setpiece: CIS,
  historic: MINT,
  // The locked clock face sits on the north wall (z = -21), normal +Z.
  // Clock face on the Mint's west wall (x = 42), normal -X, facing the street.
  historicFace: { position: { x: 41.8, y: 0, z: -6 }, yaw: Math.PI / 2, bodyCenter: { x: 50, y: 0, z: -6 } },
  occluders: [
    CIS,
    MINT,
    box('great-house', 24, 38, 0, 12, -38, -30, { kind: 'building', label: 'Great House' }),
    box('north-hall', -52, -36, 0, 16, -40, -26, { kind: 'building', label: 'North Hall' }),
    box('nw-tenements', -86, -74, 0, 14, -18, -8, { kind: 'building', label: 'NW Tenements' }),
    box('west-workshop', -98, -88, 0, 11, -20, -6, { kind: 'building', label: 'West Workshop' }),
    box('east-tower', 30, 40, 0, 22, -26, -18, { kind: 'building', label: 'East Tower' }),
    box('east-arcade', 46, 60, 0, 11, 10, 26, { kind: 'building', label: 'East Arcade' }),
    box('south-depot', -20, -6, 0, 15, 56, 68, { kind: 'building', label: 'South Depot' }),
    box('ne-silo', 28, 40, 0, 20, 40, 54, { kind: 'building', label: 'NE Silo' }),
    box('south-wall', -20, 6, 0, 2.2, 24, 26, { kind: 'wall', label: 'Low parapet wall' }),
    box('market-stalls', 8, 22, 0, 2.6, 24, 30, { kind: 'stalls', label: 'Market stalls' }),
    box('kiosk', -56, -50, 0, 3.5, -4, 2, { kind: 'kiosk', label: 'Ticket kiosk' }),
    box('low-arcade', -46, -38, 0, 4.0, -4, 2, { kind: 'building', label: 'Low arcade' }),
  ],
  platforms: [
    box('east-terrace', 10, 30, 0, 1.4, -32, -14, { kind: 'platform', label: 'Raised east terrace' }),
    box('south-terrace', -10, 20, 0, 0.6, 54, 64, { kind: 'platform', label: 'Low south terrace' }),
    box('west-pad', -62, -48, 0, 1.0, 28, 40, { kind: 'platform', label: 'West ramp pad' }),
    box('north-plinth', -30, -18, 0, 1.2, -16, -8, { kind: 'platform', label: 'North plinth' }),
  ],
};

export const LANDMARK_CATALOG = {
  spire: {
    id: 'spire', name: 'Glass Spire', color: '#4fd1ff',
    sign: { w: 5.0, h: 3.0, yOffset: 8.5 },
    body: { w: 2.2, d: 2.2, h: 7.2 },
    note: 'Tall wayfinding spire; visible far down the street.',
  },
  gate: {
    id: 'gate', name: 'Fountain Gate', color: '#ffd166',
    sign: { w: 4.0, h: 2.4, yOffset: 4.0 },
    body: { w: 1.6, d: 1.6, h: 3.2 },
    note: 'Low gate sign, reads well close to the route.',
  },
  ribbon: {
    id: 'ribbon', name: 'Market Ribbon', color: '#ff7b9c',
    sign: { w: 6.0, h: 2.2, yOffset: 5.2 },
    body: { w: 1.4, d: 1.4, h: 4.6 },
    note: 'Wide banner; good for cross-street sightlines.',
  },
  mint: {
    id: 'mint', name: 'Old Mint Clock', color: '#c9a227',
    sign: { w: 3.4, h: 3.4, yOffset: 7.5 },
    body: { w: 12, d: 16, h: 18 },
    historic: true,
    bodyOffset: true,
    note: 'Historic clock face on the locked Old Mint. Cannot be moved.',
  },
  arch: {
    id: 'arch', name: 'Gatehouse Arch', color: '#e08bff',
    sign: { w: 4.4, h: 2.6, yOffset: 6.4 },
    body: { w: 9.0, d: 1.4, h: 7.0 },
    note: 'Wide gatehouse; its mass can hide a sign behind it.',
  },
  lantern: {
    id: 'lantern', name: 'Harbor Lantern', color: '#9dff8f',
    sign: { w: 3.6, h: 2.2, yOffset: 6.0 },
    body: { w: 1.3, d: 1.3, h: 4.8 },
    note: 'Slender lantern column; fits tight corners.',
  },
};
