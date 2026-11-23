// App controller: wires the placement kernel to the editor UI. Every number in
// the sidebar comes from kernel/placement.js and kernel/visibility.js; the
// viewport's projection overlay calls the same measureLandmark() the report does.

import * as THREE from 'three';
import { Viewport, REF_W, REF_H } from './viewport.js';
import { DISTRICT, LANDMARK_CATALOG } from '../content/world.js';
import { SCENES, materializeScene } from '../content/scenes.js';
import { sampleRoute, makeCamera, measureLandmark, projectPoint, signCenter, signCorners, signBasis, landmarkSightlines, DEFAULT_THRESHOLDS } from '../kernel/visibility.js';
import {
  solvePlacement, landmarkFromCatalog, evaluatePlan, compareTradeoff,
  landmarkOccluderBox, withLandmarkOccluders, groundHeight,
} from '../kernel/placement.js';
import {
  makeCorridor, runEvidenceChain, decideRepair, locateMismatch,
  counterfactualReplay, splitRouteAtSightlines, boundingVolumeErrors,
  sightlineIntersections, DEFAULT_BUDGET,
} from '../kernel/diagnostics.js';

const DEG = Math.PI / 180;
const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = {
  sceneId: 'harbor-quarter',
  scene: null,
  routes: [],
  routesById: {},
  keySegments: [],
  landmarks: [],
  historicLandmarks: [],
  fixedLandmarks: [],
  selectedId: null,
  evaluation: null,
  explain: [],
  trace: [],
  mode: 'edit',
  replay: { routeId: 'plaza-walk', s: 0, playing: false, lastT: 0 },
  tradeoff: null,
  solveMs: 0,
  diagnostics: {
    routeId: 'plaza-walk',
    landmarkId: null,
    closureOn: false,
    s: 0,
    chains: {},
    decision: null,
    budget: DEFAULT_BUDGET,
  },
};

const overlayCanvas = document.getElementById('measure-overlay');
const viewport = new Viewport($('#viewport'), overlayCanvas);

function eyeAt(pose) {
  return { x: pose.position.x, y: pose.position.y + (pose.eyeHeight ?? 1.7), z: pose.position.z };
}

function camAt(pose, yawOffsetDeg = 0, opts = {}) {
  return makeCamera({
    position: eyeAt(pose),
    yaw: pose.yaw + yawOffsetDeg * DEG,
    fovYDeg: opts.fovYDeg ?? 62,
    aspect: REF_W / REF_H,
    width: opts.width ?? REF_W,
    height: opts.height ?? REF_H,
  });
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  state.scene = SCENES[state.sceneId];
  const mat = materializeScene(state.scene, sampleRoute);
  state.routes = mat.routes;
  state.routesById = mat.routesById;
  state.keySegments = mat.keySegments;

  state.historicLandmarks = state.scene.historicPoints.map((h) => ({
    ...landmarkFromCatalog(LANDMARK_CATALOG, h.type, h.position, h.yaw, h.id),
    ignoreOccluderIds: h.ignoreOccluderIds ?? [],
  }));
  const rs = state.scene.roadsideSign;
  state.fixedLandmarks = rs ? [{
    ...landmarkFromCatalog(LANDMARK_CATALOG, rs.type, rs.position, rs.yaw, rs.id),
    fixedReason: 'deliberate roadside sign; the shared cistern block hides it on both approaches until the corner',
  }] : [];

  viewport.buildWorld(DISTRICT);
  viewport.buildRoutes(state.routes, state.keySegments);

  // Start from a solved plan so the editor opens on a real, measured layout.
  runSolve({ silent: true });
  wireUI();
  setMode('edit');
  renderAll();
  // Expose for automated UI verification (the verifier drives these).
  window.__editor = {
    state, measureLandmark, makeCamera, projectPoint, evaluatePlan, compareTradeoff,
    setMode, selectLandmark, runSolve, moveLandmark, refreshEvaluation, viewport, camAt, eyeAt,
    runDiagnostics, selectDiagnosticsLandmark, toggleClosure, setDiagnosticsS, diagnostics: diagnosticsApi(),
  };
  window.__editorReady = true;
}

function diagnosticsApi() {
  return {
    makeCorridor, runEvidenceChain, decideRepair, locateMismatch,
    counterfactualReplay, splitRouteAtSightlines, boundingVolumeErrors, sightlineIntersections,
  };
}

// ---------------------------------------------------------------------------
// Evaluation + render

function buildEvalOpts() {
  // All reported areas are in the reference 1280x720 frame, never the live
  // window size, so the sidebar, the export and the Node verifier agree
  // regardless of how the user has resized the browser.
  return {
    thresholds: DEFAULT_THRESHOLDS,
    fovYDeg: viewport.replayCam?.fov ?? 62,
    aspect: REF_W / REF_H,
    width: REF_W, height: REF_H,
  };
}

function planObj() {
  return { landmarks: state.landmarks, keySegments: state.keySegments };
}

function refreshEvaluation() {
  const occ = withLandmarkOccluders(DISTRICT.occluders, state.landmarks);
  state.evaluation = evaluatePlan(planObj(), state.routesById, occ, buildEvalOpts());
  state.explain = explainFromEvaluation(state.evaluation);
  viewport.colorRoutes(state.evaluation);
}

function explainFromEvaluation(ev) {
  const lines = [];
  for (const [routeId, rc] of Object.entries(ev.coverage.byRoute)) {
    const route = state.routesById[routeId];
    const vp = route.viewpoint;
    const vpText = vp.mode === 'fixed'
      ? `fixed seat, head pan ±${vp.panLimitDeg}°`
      : `free viewpoint, ±${(vp.lateralLimit ?? 0).toFixed(1)} m lateral`;
    const segs = rc.keySegments.map((k) =>
      `${k.label}: ${(k.fraction * 100).toFixed(0)}% ${k.pass ? 'PASS' : 'FAIL'}`).join('; ');
    lines.push({ kind: 'route', routeId, text: `${route.name} (${vpText}) — covered ${(rc.fraction * 100).toFixed(0)}%, longest blind run ${rc.longestGapLength.toFixed(1)} m. Key segments: ${segs}.` });
    if (!rc.allKeySegmentsPass) {
      lines.push({ kind: 'warn', text: vp.mode === 'fixed'
        ? `${route.name}: the eye cannot move, so a failing stretch must be fixed by relocating a landmark or explicitly reported unseen.`
        : `${route.name}: a free viewpoint still fails a key stretch; nudge the corner guide point or add a landmark.` });
    }
    lines.push({ kind: 'first', routeId, text: firstContoursLine(routeId) });
  }
  return lines;
}

// "Where does the passenger genuinely see the first legible contour?"
function firstContoursLine(routeId) {
  const samples = state.evaluation?.perRoute[routeId];
  if (!samples) return '';
  const names = [];
  for (const lm of state.landmarks) {
    const idx = samples.findIndex((s) => s.best[lm.id]?.readable);
    if (idx >= 0) names.push(`${lm.name} at ${samples[idx].s.toFixed(1)} m`);
  }
  return names.length
    ? `First legible contours along ${state.routesById[routeId].name}: ${names.join(', ')}.`
    : `No landmark becomes legible anywhere along ${state.routesById[routeId].name}.`;
}

function renderAll() {
  renderRoutePanel();
  renderReplayPanel();
  renderLandmarkPanel();
  renderResultPanel();
  renderTradeoffPanel();
  renderDiagnosticsPanel();
  renderHelpPanelSafe();
  viewport.buildLandmarks(state.landmarks, state.selectedId, { onDrag: onLandmarkDrag });
}

// Replay sidebar: a clickable coverage strip plus the blind runs for the chosen
// route, so the editor can jump straight to a gap and judge it on foot.
function renderReplayPanel() {
  const el = $('#panel-replay');
  if (!el) return;
  const routeId = state.replay.routeId;
  const route = state.routesById[routeId];
  const samples = state.evaluation.perRoute[routeId];
  const rc = state.evaluation.coverage.byRoute[routeId];
  const segs = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const key = state.keySegments.some((k) => k.routeId === routeId && s.s >= k.from && s.s <= k.to);
    let cls = 'blind';
    if (s.visibleIds.length > 0) {
      const best = s.visibleIds.map((id) => s.best[id]).sort((a, b) => b.quality - a.quality)[0];
      cls = best.quality > 0.62 ? 'good' : 'marg';
    }
    segs.push(`<div class="seg ${cls} ${key ? 'key' : ''}" data-s="${s.s}" title="${s.s.toFixed(1)} m · ${s.visibleIds.length} readable"></div>`);
  }
  const gaps = rc.gaps.filter((g) => g.to - g.from > 1.5);
  const gapRows = gaps.length
    ? gaps.map((g) => `<div class="row" style="display:flex;justify-content:space-between;gap:8px">
        <span>blind ${g.from.toFixed(0)}–${g.to.toFixed(0)} m (${(g.to - g.from).toFixed(0)} m)</span>
        <button data-gap="${g.from}">jump</button></div>`).join('')
    : '<div class="hint">No blind run longer than 1.5 m on this route.</div>';
  const routeButtons = state.routes.map((r) => `<button data-route="${r.id}" class="${r.id === routeId ? 'primary' : ''}">${esc(r.name)}</button>`).join('');
  el.innerHTML = `
    <h2>Replay & blind zones · ${esc(route.name)}</h2>
    <div class="btn-row">${routeButtons}</div>
    <div class="covbar">${segs.join('')}</div>
    <div class="covbar-labels"><span>0 m</span><span>${(route.length / 2).toFixed(0)} m</span><span>${route.length.toFixed(0)} m</span></div>
    <div class="hint" style="margin:6px 0">Click the strip or a blind run to move the passenger there.</div>
    <div style="display:flex;flex-direction:column;gap:4px">${gapRows}</div>
    <h3>Key segments</h3>
    <div style="display:flex;flex-direction:column;gap:4px">
      ${state.keySegments.filter((k) => k.routeId === routeId).map((k) => `
        <div style="display:flex;justify-content:space-between;gap:8px">
          <span>${esc(k.label)} <span class="hint">(${k.from.toFixed(0)}–${k.to.toFixed(0)} m)</span></span>
          <button data-gap="${k.from}">start</button>
        </div>`).join('')}
    </div>
    ${route.viewpoint.mode === 'fixed' ? `<div class="note" style="margin-top:10px">Seated route: the eye height and seat position are fixed. Only ±${route.viewpoint.panLimitDeg}° of head pan is allowed. Anything you cannot see here is genuinely unseen by the passenger.</div>` : ''}
    <div class="epistemic" style="margin-top:10px">The strip encodes measured legibility, not “does the player understand the sign”. A green sample means the panel cleared the area, occlusion, viewport and angular-size gates.</div>`;
  el.querySelectorAll('[data-gap]').forEach((b) => b.addEventListener('click', () => {
    state.replay.s = Number(b.dataset.gap);
    updateReplayPose();
  }));
  el.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => {
    state.replay.s = Number(b.dataset.s);
    updateReplayPose();
  }));
  el.querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', () => {
    state.replay.routeId = b.dataset.route;
    state.replay.s = Math.min(state.replay.s, state.routesById[state.replay.routeId].length);
    enterReplay(); renderReplayPanel();
  }));
}

function renderRoutePanel() {
  const el = $('#panel-routes');
  const rows = Object.entries(state.evaluation?.coverage.byRoute ?? {}).map(([routeId, rc]) => {
    const route = state.routesById[routeId];
    const vp = route.viewpoint;
    const segRows = rc.keySegments.map((k) => `
      <tr><td>${esc(k.label)}</td>
          <td class="${k.pass ? 'pass' : 'fail'}">${(k.fraction * 100).toFixed(0)}%</td>
          <td style="width:70px"><div class="meter ${k.pass ? '' : 'fail'}"><i style="width:${Math.round(k.fraction * 100)}%"></i></div></td></tr>`).join('');
    return `
      <div class="route-card">
        <div class="rc-head">
          <div>
            <div class="rc-name">${esc(route.name)}</div>
            <div class="rc-vp">${vp.mode === 'fixed'
              ? `Fixed viewpoint — passengers cannot move; head pan ±${vp.panLimitDeg}°`
              : `Free viewpoint — may step ${(vp.lateralLimit ?? 0).toFixed(1)} m sideways`}</div>
          </div>
          <span class="badge ${vp.mode === 'fixed' ? 'fixed' : 'free'}">${vp.mode === 'fixed' ? 'seated' : 'walking'}</span>
        </div>
        <table>
          <thead><tr><th>Key segment</th><th>Covered</th><th></th></tr></thead>
          <tbody>${segRows}</tbody>
        </table>
        <div class="rc-vp" style="margin-top:8px">Longest blind run: <strong>${rc.longestGapLength.toFixed(1)} m</strong> · covered ${(rc.fraction * 100).toFixed(0)}%</div>
      </div>`;
  }).join('');
  el.innerHTML = `<h2>Routes & key segments</h2>${rows}`;
}

function renderLandmarkPanel() {
  const el = $('#panel-result');
  const items = state.landmarks.map((lm) => {
    const sel = lm.id === state.selectedId ? 'selected' : '';
    const lock = lm.historic ? '<span class="lock" title="locked historic building">🔒 historic</span>'
      : lm.fixedReason ? '<span class="lock" title="fixed roadside sign">📌 fixed</span>' : '';
    return `<div class="lm-item ${sel}" data-id="${esc(lm.id)}">
      <span class="chip" style="background:${lm.color}"></span>
      <div>
        <div>${esc(lm.name)}</div>
        <div class="lm-meta">(${lm.position.x.toFixed(0)}, ${lm.position.z.toFixed(0)}) · facing ${(normDeg(lm.yaw)).toFixed(0)}°</div>
      </div>
      ${lock || `<button class="del" title="remove" data-del="${esc(lm.id)}">×</button>`}
    </div>`;
  }).join('') || '<div class="empty">No landmarks yet — Auto-place or add one.</div>';

  el.innerHTML = `
    <h2>Placement</h2>
    <div class="lm-list">${items}</div>
    ${selectedControls()}
    <div class="btn-row">
      <button id="btn-add">Add landmark</button>
      <button id="btn-reposition" class="primary">Re-solve from here</button>
    </div>
  `;
  el.querySelectorAll('.lm-item').forEach((n) => n.addEventListener('click', (e) => {
    if (e.target.dataset.del) return;
    selectLandmark(n.dataset.id);
  }));
  el.querySelectorAll('[data-del]').forEach((n) => n.addEventListener('click', (e) => {
    e.stopPropagation();
    state.landmarks = state.landmarks.filter((l) => l.id !== n.dataset.del);
    if (state.selectedId === n.dataset.del) state.selectedId = null;
    refreshEvaluation(); renderAll();
  }));
  const addBtn = el.querySelector('#btn-add');
  if (addBtn) addBtn.addEventListener('click', addLandmarkAtView);
  const re = el.querySelector('#btn-reposition');
  if (re) re.addEventListener('click', () => runSolve({ keepHistoric: true }));
  wireSelectedControls(el);
}

function selectedControls() {
  const lm = state.landmarks.find((l) => l.id === state.selectedId);
  if (!lm) return '<div class="hint" style="margin-top:10px">Select a landmark to move or re-aim it. Drag its ground ring in the 3D view; edit exact values below.</div>';
  if (lm.historic) {
    return `<div class="controls">
      <div class="full note">This clock face is part of the locked Old Mint. Position and facing are fixed; only its measured visibility can change.</div>
    </div>`;
  }
  const disabled = lm.fixedReason ? 'disabled' : '';
  return `
    <div class="controls">
      <label class="full">Facing ${normDeg(lm.yaw).toFixed(0)}°
        <input id="ctl-yaw" type="range" min="-180" max="180" step="1" value="${normDeg(lm.yaw).toFixed(0)}" ${disabled} />
      </label>
      <label>X <input id="ctl-x" type="number" step="1" value="${lm.position.x.toFixed(1)}" ${disabled} /></label>
      <label>Z <input id="ctl-z" type="number" step="1" value="${lm.position.z.toFixed(1)}" ${disabled} /></label>
      <div class="full hint">${lm.fixedReason ? esc(lm.fixedReason) : esc(lm.note ?? '')}</div>
    </div>`;
}

function wireSelectedControls(root) {
  const lm = state.landmarks.find((l) => l.id === state.selectedId);
  if (!lm) return;
  const yaw = root.querySelector('#ctl-yaw');
  if (yaw) yaw.addEventListener('input', () => { lm.yaw = Number(yaw.value) * DEG; refreshEvaluation(); renderAll(); });
  const x = root.querySelector('#ctl-x');
  const z = root.querySelector('#ctl-z');
  const apply = () => {
    lm.position.x = Number(x.value);
    lm.position.z = Number(z.value);
    lm.position.y = groundHeight(DISTRICT.platforms, lm.position);
    refreshEvaluation(); renderAll();
  };
  if (x) x.addEventListener('change', apply);
  if (z) z.addEventListener('change', apply);
}

function renderResultPanel() {
  const el = $('#panel-explain');
  const lines = state.explain.map((l) => {
    if (l.kind === 'warn') return `<div class="note" style="margin:6px 0">${esc(l.text)}</div>`;
    if (l.kind === 'first') return `<div class="hint" style="margin:4px 0">${esc(l.text)}</div>`;
    return `<div style="margin:4px 0">${esc(l.text)}</div>`;
  }).join('');
  const trace = state.trace.length
    ? `<div class="hint" style="margin-top:10px"><strong>Kernel decisions</strong><br>${state.trace.map((t) => t.decision === 'place'
      ? `• ${esc(t.type)} → (${t.position.x.toFixed(0)}, ${t.position.z.toFixed(0)}): ${esc(t.reason)}`
      : `• stop: ${esc(t.reason)}`).join('<br>')}</div>`
    : '';
  el.innerHTML = `
    <h2>Measured result</h2>
    <div class="explain">${lines}</div>
    ${trace}
    <div class="epistemic" style="margin-top:10px">
      This tool verifies measurable visual conditions — projected area, unoccluded fraction,
      on-screen position and angular size. It does <strong>not</strong> claim a human reader
      will understand the intended direction from these numbers alone.
    </div>`;
}

function renderHelpPanelSafe() {
  const el = $('#panel-help');
  if (!el) return;
  el.innerHTML = `
    <h2>How to use</h2>
    <div class="hint">
      <strong>Edit</strong>: drag a landmark's ground ring, or use the number fields. Drag the
      right mouse button to orbit, wheel to zoom.<br>
      <strong>Route replay</strong>: scrub or play along a route. The green box on screen is the
      measured panel footprint; the dashed rectangle is the safe viewport.<br>
      <strong>Trade-off</strong>: compares migrating a landmark against nudging the observer.
    </div>
    <div class="btn-row">
      <button id="btn-thresholds">Show thresholds used</button>
    </div>
    <div id="thresholds-out" class="hint" style="margin-top:8px"></div>`;
  el.querySelector('#btn-thresholds').addEventListener('click', () => {
    const t = DEFAULT_THRESHOLDS;
    $('#thresholds-out').innerHTML = `
      <table style="width:100%">
        <tr><td>Min unoccluded fraction</td><td>${(t.minVisibleFraction * 100).toFixed(0)}%</td></tr>
        <tr><td>Min visible area (1280×720)</td><td>${t.minVisibleAreaPx} px²</td></tr>
        <tr><td>Max frame area</td><td>${(t.maxAreaFraction * 100).toFixed(0)}%</td></tr>
        <tr><td>Min angular height</td><td>${t.minAngularHeightDeg}°</td></tr>
        <tr><td>Min incidence cos</td><td>${t.minIncidenceCos}</td></tr>
        <tr><td>Safe viewport</td><td>±${t.safeNdcX} × ±${t.safeNdcY} NDC</td></tr>
      </table>`;
  });
}

// ---------------------------------------------------------------------------
// Solve / edit actions

function runSolve({ silent = false, keepHistoric = true } = {}) {
  const t0 = performance.now();
  const res = solvePlacement({
    routesById: state.routesById,
    context: {
      catalog: LANDMARK_CATALOG,
      occluders: DISTRICT.occluders,
      platforms: DISTRICT.platforms,
      landmarkTypes: state.scene.landmarkTypes,
      keySegments: state.keySegments,
      historicLandmarks: state.historicLandmarks,
      fixedLandmarks: state.fixedLandmarks,
    },
    options: { maxLandmarks: 6 },
  });
  state.solveMs = performance.now() - t0;
  state.landmarks = res.plan.landmarks;
  state.trace = res.trace;
  state.selectedId = state.selectedId && state.landmarks.some((l) => l.id === state.selectedId)
    ? state.selectedId : state.landmarks[0]?.id ?? null;
  refreshEvaluation();
  if (!silent) renderAll();
}

function selectLandmark(id) {
  state.selectedId = id;
  renderAll();
  const lm = state.landmarks.find((l) => l.id === id);
  if (lm && viewport.mode === 'edit') {
    viewport.controls.target.set(lm.position.x, 0, lm.position.z);
  }
}

function addLandmarkAtView() {
  const target = viewport.controls.target;
  const pos = { x: Math.round(target.x), y: 0, z: Math.round(target.z) };
  pos.y = groundHeight(DISTRICT.platforms, pos);
  // Reject placements inside scenery before adding.
  for (const b of DISTRICT.occluders) {
    if (pos.x > b.min.x - 2 && pos.x < b.max.x + 2 && pos.z > b.min.z - 2 && pos.z < b.max.z + 2) {
      flash(`Cannot place inside ${b.label ?? b.id}.`);
      return;
    }
  }
  const yawTo = Math.atan2(-(target.x - pos.x), -(target.z - pos.z));
  const lm = landmarkFromCatalog(LANDMARK_CATALOG, 'ribbon', pos, yawTo, `manual-${Date.now()}`);
  state.landmarks = [...state.landmarks, lm];
  state.selectedId = lm.id;
  refreshEvaluation(); renderAll();
}

function onLandmarkDrag({ phase, id, x, z }) {
  const lm = state.landmarks.find((l) => l.id === id);
  if (!lm || lm.historic || lm.fixedReason) return;
  if (phase === 'move' && Number.isFinite(x)) {
    lm.position.x = x;
    lm.position.z = z;
    lm.position.y = groundHeight(DISTRICT.platforms, lm.position);
    // Live feedback at 30fps rather than every pointermove.
    const now = performance.now();
    if (!lm._lastEval || now - lm._lastEval > 33) {
      lm._lastEval = now;
      refreshEvaluation();
      viewport.buildLandmarks(state.landmarks, state.selectedId, { onDrag: onLandmarkDrag });
      renderResultPanel(); renderRoutePanel();
    }
  }
  if (phase === 'end') {
    refreshEvaluation(); renderAll();
  }
}

function moveLandmark(id, dx, dz) {
  const lm = state.landmarks.find((l) => l.id === id);
  if (!lm || lm.historic) return;
  lm.position.x += dx; lm.position.z += dz;
  lm.position.y = groundHeight(DISTRICT.platforms, lm.position);
  refreshEvaluation(); renderAll();
}

function flash(msg) {
  const el = $('#hud-view-badge');
  el.textContent = msg;
  el.style.color = 'var(--bad)';
  setTimeout(() => { el.style.color = ''; updateBadge(); }, 2200);
}

// ---------------------------------------------------------------------------
// Modes

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#replay-bar').classList.toggle('hidden', mode !== 'replay');
  $('#diag-bar').classList.toggle('hidden', mode !== 'diagnostics');
  $('#panel-replay').classList.toggle('hidden', mode !== 'replay');
  $('#panel-tradeoff').classList.toggle('hidden', mode !== 'tradeoff');
  $('#panel-diagnostics').classList.toggle('hidden', mode !== 'diagnostics');
  // Trade-off and diagnostics are focused modes: hide the general panels so
  // the comparison/evidence is the first thing on screen.
  for (const id of ['#panel-routes', '#panel-result', '#panel-explain', '#panel-help']) {
    $(id).classList.toggle('hidden', mode === 'tradeoff' || mode === 'diagnostics');
  }
  viewport.setMode(mode);
  // The "at this point" measurement HUD belongs to the passenger replay only;
  // leaving the last replay reading on screen in edit or trade-off mode is stale.
  $('#hud-measure').style.display = (mode === 'replay' || mode === 'diagnostics') ? '' : 'none';
  if (mode === 'replay') {
    if (state.replay.routeId && !state.routesById[state.replay.routeId]) state.replay.routeId = state.routes[0].id;
    enterReplay();
  } else if (mode === 'tradeoff') {
    computeTradeoff();
    renderTradeoffPanel();
    highlightTradeoffPair();
    updateBadge();
  } else if (mode === 'diagnostics') {
    enterDiagnostics();
  } else {
    viewport.clearDiag();
    updateBadge();
  }
  renderAll();
}

function updateBadge() {
  const el = $('#hud-view-badge');
  if (state.mode === 'replay') {
    const r = state.routesById[state.replay.routeId];
    const vp = r.viewpoint.mode === 'fixed' ? 'seated passenger · fixed eye' : 'walking observer';
    el.textContent = `${r.name} — ${vp}`;
  } else if (state.mode === 'tradeoff') {
    el.textContent = 'Trade-off: migrate landmark vs. adjust observer';
  } else if (state.mode === 'diagnostics') {
    const r = currentDiagnosticsRoute();
    el.textContent = `Diagnostics — ${r.name}${state.diagnostics.closureOn ? ' · road closed' : ''}`;
  } else {
    el.textContent = 'Editor · drag landmarks · orbit with right mouse';
  }
}

// ---------------------------------------------------------------------------
// Replay

function enterReplay() {
  const r = state.routesById[state.replay.routeId];
  state.replay.s = Math.min(state.replay.s, r.length);
  syncReplayUI();
  updateReplayPose();
  viewport.onOverlay(() => drawReplayOverlay());
}

function syncReplayUI() {
  const r = state.routesById[state.replay.routeId];
  $('#replay-slider').max = String(Math.round(r.length * 10));
  $('#replay-slider').value = String(Math.round(state.replay.s * 10));
  $('#replay-readout').textContent = `${state.replay.s.toFixed(1)} / ${r.length.toFixed(1)} m`;
  // Route selector inside replay bar is the route cards; keep it simple.
  updateBadge();
}

function nearestSample(routeId, s) {
  const r = state.routesById[routeId];
  let best = r.samples[0], bd = Infinity;
  for (const smp of r.samples) {
    const d = Math.abs(smp.s - s);
    if (d < bd) { bd = d; best = smp; }
  }
  return best;
}

// Best forward-ish pan allowed for this viewpoint, chosen by measurement.
function chooseReplayPose(sample) {
  const route = state.routesById[state.replay.routeId];
  const vp = route.viewpoint;
  const pans = vp.mode === 'fixed'
    ? [-vp.panLimitDeg, 0, vp.panLimitDeg]
    : [-vp.panLimitDeg, -vp.panLimitDeg / 2, 0, vp.panLimitDeg / 2, vp.panLimitDeg];
  let best = { pan: 0, lm: null, m: null };
  for (const pan of pans) {
    const cam = camAt(sample, pan);
    for (const lm of state.landmarks) {
      const m = measureLandmark(cam, lm, withLandmarkOccluders(DISTRICT.occluders, state.landmarks), DEFAULT_THRESHOLDS);
      if (m && m.readable && (!best.m || m.quality > best.m.quality)) best = { pan, lm, m, cam };
    }
  }
  if (!best.lm && state.selectedId) {
    const lm = state.landmarks.find((l) => l.id === state.selectedId);
    const cam = camAt(sample, 0);
    best = { pan: 0, lm, m: measureLandmark(cam, lm, withLandmarkOccluders(DISTRICT.occluders, state.landmarks)), cam };
  }
  return { sample, pan: best.pan, lm: best.lm, m: best.m, cam: best.cam };
}

function updateReplayPose() {
  const r = state.routesById[state.replay.routeId];
  const sample = nearestSample(state.replay.routeId, state.replay.s);
  const pose = chooseReplayPose(sample);
  state.replay.pose = pose;
  viewport.setReplayCamera({
    position: eyeAt(sample), yaw: sample.yaw, fovYDeg: viewport.replayCam.fov,
  });
  // Apply pan so the chosen landmark is in view.
  viewport.replayCam.rotation.set(0, 0, 0);
  viewport.replayCam.rotateY(sample.yaw + pose.pan * DEG);
  syncReplayUI();
  updateHudMeasure(pose);
}

function updateHudMeasure(pose) {
  const hud = $('#hud-measure');
  if (!pose.m || !pose.lm) {
    hud.innerHTML = `<h4>At this point</h4><div class="row"><span class="bad">No landmark readable</span></div>
      <div class="row"><span>This stretch is a blind run.</span></div>`;
    return;
  }
  const m = pose.m;
  const cls = m.readable ? 'ok' : 'bad';
  hud.innerHTML = `
    <h4>${esc(pose.lm.name)} — measured</h4>
    <div class="row"><span>Projected area</span><span>${Math.round(m.visibleAreaPx)} px² (${(m.areaFraction * 100).toFixed(1)}% frame)</span></div>
    <div class="row"><span>Unoccluded</span><span>${(m.visibleFraction * 100).toFixed(0)}%</span></div>
    <div class="row"><span>On screen</span><span>${(m.onScreenFraction * 100).toFixed(0)}%</span></div>
    <div class="row"><span>Angular height</span><span>${m.angularHeightDeg.toFixed(1)}°</span></div>
    <div class="row"><span>Distance / facing</span><span>${m.distance.toFixed(1)} m / cos ${m.incidence.toFixed(2)}</span></div>
    <div class="row"><span>Verdict</span><span class="${cls}">${m.readable ? 'READABLE' : m.reasons.join(', ') || 'not readable'}</span></div>
    <div class="row"><span>Pan used</span><span>${pose.pan.toFixed(0)}°</span></div>`;
}

function drawReplayOverlay() {
  const pose = state.replay.pose;
  if (!pose) return;
  if (pose.lm && pose.m) {
    // Kernel camera must match the rendered camera exactly. Recompute with the
    // live canvas aspect so the drawn box lines up with the 3D frame.
    const cam = makeCamera({
      position: eyeAt(pose.sample),
      yaw: pose.sample.yaw + pose.pan * DEG,
      fovYDeg: viewport.replayCam.fov,
      aspect: REF_W / REF_H,
      width: REF_W, height: REF_H,
    });
    const m = measureLandmark(cam, pose.lm, withLandmarkOccluders(DISTRICT.occluders, state.landmarks), DEFAULT_THRESHOLDS);
    viewport.drawMeasureOverlay(pose.lm, m, cam);
  } else {
    viewport.drawMeasureOverlay(null, null, null);
  }
}

// ---------------------------------------------------------------------------
// Trade-off

function computeTradeoff() {
  const scene = state.scene;
  const pair = scene.mutualPair.map((p) => landmarkFromCatalog(LANDMARK_CATALOG, p.type, p.position, p.yaw, p.id));
  // The pair's own bodies must be part of the occluder set or "mutual"
  // occlusion is unmeasurable by construction.
  const occ = withLandmarkOccluders(DISTRICT.occluders, [...state.landmarks, ...pair]);
  state.tradeoff = compareTradeoff({
    plan: { landmarks: state.landmarks, keySegments: state.keySegments },
    routesById: state.routesById,
    context: { occluders: occ, platforms: DISTRICT.platforms },
    options: {
      routeId: scene.mutualRouteId,
      objects: pair,
      fovYDeg: viewport.replayCam?.fov ?? 62,
      aspect: REF_W / REF_H,
      width: REF_W, height: REF_H,
    },
  });
  state.tradeoffPair = pair;
}

function renderTradeoffPanel() {
  const el = $('#panel-tradeoff');
  const t = state.tradeoff;
  if (!t) { el.innerHTML = '<h2>Trade-off</h2><div class="empty">Not computed.</div>'; return; }
  const route = state.routesById[t.routeId];
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  const winLabel = t.window
    ? `${t.window.from.toFixed(0)}–${t.window.to.toFixed(0)} m (${(t.window.to - t.window.from).toFixed(0)} m window, ${t.window.count} contested samples)`
    : 'none found';
  const baseWin = t.base.windowFraction;
  const migWin = t.migrate?.windowFraction;
  const obsWin = t.observer?.available ? t.observer.windowFraction : null;
  const best = Math.max(migWin ?? -1, obsWin ?? -1);
  const opts = [];
  opts.push(`<div class="tradeoff-opt">
      <h4>Status quo</h4>
      <div class="big">${pct(baseWin)}</div>
      <div class="why">of the contested window is legible. Longest blind run inside it: ${t.base.longestGap.toFixed(1)} m. Whole route: ${pct(t.base.fraction)}.</div>
    </div>`);
  opts.push(`<div class="tradeoff-opt ${migWin != null && migWin >= best - 0.02 ? 'win' : ''}">
      <h4>A · Migrate the hidden landmark</h4>
      <div class="big">${migWin != null ? pct(migWin) : '—'}</div>
      <div class="why">Move ${esc(t.migrate.landmark.name)} to (${t.migrate.landmark.position.x.toFixed(0)}, ${t.migrate.landmark.position.z.toFixed(0)}), facing ${normDeg(t.migrate.landmark.yaw).toFixed(0)}°.
        Longest blind run inside window: ${t.migrate.longestGap.toFixed(1)} m. Δ ${(migWin - baseWin) >= 0 ? '+' : ''}${((migWin - baseWin) * 100).toFixed(0)} pts. Permanent, but the guide stays physically where players look.</div>
      <div class="btn-row"><button class="primary" id="apply-migrate">Apply migration</button></div>
    </div>`);
  if (t.observer?.available) {
    opts.push(`<div class="tradeoff-opt ${obsWin != null && obsWin >= best - 0.02 ? 'win' : ''}">
      <h4>B · Adjust the observer point</h4>
      <div class="big">${pct(obsWin)}</div>
      <div class="why">Step ${t.observer.lateral.toFixed(1)} m sideways at the middle of the contested window.
        Longest blind run inside window: ${t.observer.longestGap.toFixed(1)} m. Δ ${(obsWin - baseWin) >= 0 ? '+' : ''}${((obsWin - baseWin) * 100).toFixed(0)} pts.
        Legal only because ${esc(route.name)} has a free viewpoint.</div>
      <div class="btn-row"><button id="apply-observer">Record observer nudge</button></div>
    </div>`);
  } else {
    opts.push(`<div class="tradeoff-opt disabled">
      <h4>B · Adjust the observer point</h4>
      <div class="big">n/a</div>
      <div class="why">Not offered on this route: ${esc(t.observer?.reason ?? 'no contested window')}. A seated passenger cannot move the eye, so this tool will not pretend the problem is solved — migrate a landmark or report the stretch unseen.</div>
    </div>`);
  }
  opts.push(`<div class="epistemic" style="margin-top:8px">${esc(t.recommendation)}</div>`);
  el.innerHTML = `<h2>Trade-off · ${esc(route.name)}</h2>
    <div class="hint" style="margin-bottom:8px">Pair: ${t.objects.map(esc).join(' vs ')} · contested window ${winLabel}</div>
    ${opts.join('')}`;
  el.querySelector('#apply-migrate')?.addEventListener('click', () => {
    const m = t.migrate.landmark;
    const idx = state.landmarks.findIndex((l) => l.id === m.id);
    if (idx >= 0) state.landmarks[idx] = m;
    refreshEvaluation(); computeTradeoff(); renderAll();
  });
  el.querySelector('#apply-observer')?.addEventListener('click', () => {
    state.observerOverride = { routeId: t.routeId, from: t.window?.from ?? 0, to: t.window?.to ?? 0, lateral: t.observer.lateral };
    applyObserverOverride();
  });
}

// Draw the contested pair on the diorama so the comparison has a physical anchor.
function highlightTradeoffPair() {
  const pair = state.tradeoffPair ?? [];
  viewport.buildLandmarks([...state.landmarks.filter((l) => !pair.some((p) => p.id === l.id))], null, {});
  const group = viewport.landmarkGroup;
  for (const lm of pair) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 3.2, 0.18, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: lm.type === 'arch' ? 0xffb347 : 0x4fd1ff, transparent: true, opacity: 0.36, side: THREE.DoubleSide }),
    );
    m.position.set(lm.position.x, 0.12, lm.position.z);
    group.add(m);
  }
  const t = state.tradeoff;
  if (t?.window) {
    // Mark the contested stretch of route on the ground.
    const route = state.routesById[t.routeId];
    const inWin = route.samples.filter((s) => s.s >= t.window.from && s.s <= t.window.to);
    for (const smp of inWin) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 12),
        new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.5 }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(smp.position.x, 0.2, smp.position.z);
      group.add(disc);
    }
  }
}

function applyObserverOverride() {
  const ov = state.observerOverride;
  if (!ov) return;
  const route = state.routesById[ov.routeId];
  const base = route.points;
  // We do not mutate the authored polyline; instead record the nudge and show
  // it in the explanation. The kernel already measured the effect.
  state.explain.push({ kind: 'warn', text: `Observer override recorded on ${route.name} at ${ov.from.toFixed(0)}–${ov.to.toFixed(0)} m: +${ov.lateral.toFixed(1)} m lateral. Re-measure before shipping.` });
  renderHelpPanelSafe();
  flash('Observer nudge recorded — re-measure to confirm.');
}

// ---------------------------------------------------------------------------
// Diagnostics mode
//
// The graphical entry point for the visibility-mismatch work. Every number is
// computed by kernel/diagnostics.js on the same reference frame as the editor;
// the viewport draws the navigator corridor, the closed road, the save point
// and forks, and overlays the real projection polygon + per-ray sightlines.

function diagnosticsOccluders() {
  return withLandmarkOccluders(DISTRICT.occluders, state.landmarks);
}

function currentDiagnosticsRoute() {
  return state.routesById[state.diagnostics.routeId] ?? state.routes[0];
}

function currentDiagnosticsCorridor() {
  const route = currentDiagnosticsRoute();
  return makeCorridor(route, state.diagnostics.closureOn && route.demoClosure
    ? { closures: [route.demoClosure] }
    : {});
}

// Re-run every evidence chain for the chosen route. Deterministic by
// construction: re-running with no edits returns the same fingerprints.
function runDiagnostics() {
  const route = currentDiagnosticsRoute();
  const corridor = currentDiagnosticsCorridor();
  const occ = diagnosticsOccluders();
  const chains = {};
  for (const lm of state.landmarks) {
    chains[lm.id] = runEvidenceChain({
      route, corridor, landmark: lm, occluders: occ, budget: state.diagnostics.budget,
    });
  }
  state.diagnostics.chains = chains;
  if (!state.diagnostics.landmarkId || !chains[state.diagnostics.landmarkId]) {
    state.diagnostics.landmarkId = state.landmarks.find((l) => l.id === 'mutual-spire')?.id
      ?? state.landmarks[0]?.id ?? null;
  }
  const target = state.landmarks.find((l) => l.id === state.diagnostics.landmarkId);
  state.diagnostics.decision = target ? decideRepair({
    route, corridor, landmark: target, occluders: occ,
    savePoint: route.savePoint,
    closure: state.diagnostics.closureOn ? route.demoClosure : null,
    forks: route.forks, budget: state.diagnostics.budget,
  }) : null;
  state.diagnostics.s = Math.min(state.diagnostics.s, route.length);
  return state.diagnostics;
}

function enterDiagnostics() {
  runDiagnostics();
  const route = currentDiagnosticsRoute();
  const corridor = currentDiagnosticsCorridor();
  viewport.drawCorridor(route, corridor, {
    closure: state.diagnostics.closureOn ? route.demoClosure : null,
    savePoint: route.savePoint, forks: route.forks,
  });
  syncDiagnosticsUI();
  updateDiagnosticsPose();
  viewport.onOverlay(() => drawDiagnosticsOverlay());
}

function selectDiagnosticsLandmark(id) {
  state.diagnostics.landmarkId = id;
  runDiagnostics();
  const route = currentDiagnosticsRoute();
  viewport.drawCorridor(route, currentDiagnosticsCorridor(), {
    closure: state.diagnostics.closureOn ? route.demoClosure : null,
    savePoint: route.savePoint, forks: route.forks,
  });
  renderDiagnosticsPanel();
  updateDiagnosticsPose();
}

function toggleClosure(on) {
  state.diagnostics.closureOn = on;
  enterDiagnostics();
  renderDiagnosticsPanel();
}

function setDiagnosticsS(s) {
  const route = currentDiagnosticsRoute();
  state.diagnostics.s = clamp(s, 0, route.length);
  syncDiagnosticsUI();
  updateDiagnosticsPose();
}

function syncDiagnosticsUI() {
  const route = currentDiagnosticsRoute();
  const slider = $('#diag-slider');
  if (slider) {
    slider.max = String(Math.round(route.length * 10));
    slider.value = String(Math.round(state.diagnostics.s * 10));
  }
  const readout = $('#diag-readout');
  if (readout) readout.textContent = `${state.diagnostics.s.toFixed(1)} m`;
}

function nearestRouteSample(route, s) {
  return route.samples.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a), route.samples[0]);
}

// Move the passenger camera to the scrubbed arc position and overlay the
// measured projection + sightlines of the selected landmark.
function updateDiagnosticsPose() {
  const route = currentDiagnosticsRoute();
  const corridor = currentDiagnosticsCorridor();
  const sample = nearestRouteSample(route, state.diagnostics.s);
  const lm = state.landmarks.find((l) => l.id === state.diagnostics.landmarkId);
  const badge = $('#diag-badge');
  if (!lm) { if (badge) badge.textContent = 'no landmark'; return; }

  const gate = corridor.sampleAllowed(sample);
  const occ = diagnosticsOccluders();
  const cam = makeCamera({
    position: { x: sample.position.x, y: sample.position.y + sample.eyeHeight, z: sample.position.z },
    yaw: sample.yaw, fovYDeg: viewport.replayCam?.fov ?? 62,
    aspect: REF_W / REF_H, width: REF_W, height: REF_H,
  });
  viewport.setReplayCamera({
    position: { x: sample.position.x, y: sample.position.y + sample.eyeHeight, z: sample.position.z },
    yaw: sample.yaw, fovYDeg: viewport.replayCam?.fov ?? 62,
  });

  if (!gate.allowed) {
    if (badge) {
      badge.className = 'diag-badge closed';
      badge.textContent = `road closed · ${gate.closure.reason ?? gate.closure.id}`;
    }
    viewport.drawDiagnosticsOverlay({ cam, landmark: null, measurement: null, sightlines: null });
    updateDiagHud(null, sample, gate.closure);
    return;
  }
  const measurement = measureLandmark(cam, lm, occ, DEFAULT_THRESHOLDS);
  const sightlines = landmarkSightlines(cam, lm, occ);
  const chain = state.diagnostics.chains[lm.id];
  const interval = containingInterval(chain, sample.s);
  const reason = measurement.readable
    ? 'readable'
    : (measurement.reasons.join(', ') || 'not readable');
  if (badge) {
    badge.className = `diag-badge ${measurement.readable ? 'ok' : 'bad'}`;
    badge.textContent = measurement.readable ? 'legible guide' : reason;
  }
  viewport.drawDiagnosticsOverlay({
    cam, landmark: lm, measurement, sightlines, reason,
    intervalLabel: interval ? `${interval.from.toFixed(0)}–${interval.to.toFixed(0)} m` : 'outside a visible interval',
  });
  updateDiagHud({ lm, measurement, sightlines, chain, sample, interval }, sample, null);
}

function containingInterval(chain, s) {
  if (!chain) return null;
  return chain.intervals.visible.find((iv) => s >= iv.from - 1e-9 && s <= iv.to + 1e-9) ?? null;
}

function updateDiagHud(data, sample, closure) {
  const hud = $('#hud-measure');
  if (closure) {
    hud.innerHTML = `<h4>At ${sample.s.toFixed(1)} m</h4>
      <div class="row"><span class="bad">Corridor closed</span><span>${esc(closure.id)}</span></div>
      <div class="row"><span>${esc(closure.reason ?? 'temporary closure')}</span></div>
      <div class="row"><span class="hint">The navigator corridor refuses this arc; no visibility is fabricated here.</span></div>`;
    return;
  }
  if (!data?.measurement) { hud.innerHTML = '<h4>Diagnostics</h4><div class="row"><span>No measurement.</span></div>'; return; }
  const { measurement: m, lm, interval, chain } = data;
  const blockers = m.blockerVotes ? Object.entries(m.blockerVotes).map(([id, n]) => `${id}×${n}`).join(', ') : '';
  hud.innerHTML = `
    <h4>${esc(lm.name)} — evidence at ${sample.s.toFixed(1)} m</h4>
    <div class="row"><span>Projected area</span><span>${Math.round(m.visibleAreaPx)} px² (${(m.areaFraction * 100).toFixed(1)}% frame)</span></div>
    <div class="row"><span>On-screen area</span><span>${Math.round(m.onScreenAreaPx)} px²</span></div>
    <div class="row"><span>Unoccluded</span><span>${(m.visibleFraction * 100).toFixed(0)}%</span></div>
    <div class="row"><span>Angular height</span><span>${m.angularHeightDeg.toFixed(2)}°</span></div>
    <div class="row"><span>Distance</span><span>${m.distance.toFixed(1)} m</span></div>
    <div class="row"><span>Blocker votes</span><span>${esc(blockers || 'none')}</span></div>
    <div class="row"><span>Visible interval</span><span>${interval ? `${interval.from.toFixed(1)}–${interval.to.toFixed(1)} m` : '—'}</span></div>
    <div class="row"><span>Evidence fingerprint</span><span>${chain?.fingerprint ?? '—'}</span></div>
    <div class="row"><span>Verdict</span><span class="${m.readable ? 'ok' : 'bad'}">${m.readable ? 'READABLE' : esc(m.reasons.join(', ') || 'not readable')}</span></div>`;
}

function drawDiagnosticsOverlay() {
  if (state.mode !== 'diagnostics') return;
  updateDiagnosticsPose();
}

function renderDiagnosticsPanel() {
  const el = $('#panel-diagnostics');
  if (!el) return;
  const route = currentDiagnosticsRoute();
  const d = state.diagnostics;
  const chain = d.chains[d.landmarkId];
  const lm = state.landmarks.find((l) => l.id === d.landmarkId);

  const routeButtons = state.routes.map((r) =>
    `<button data-diag-route="${r.id}" class="${r.id === d.routeId ? 'primary' : ''}">${esc(r.name)}</button>`).join('');
  const lmOptions = state.landmarks.map((l) =>
    `<option value="${esc(l.id)}" ${l.id === d.landmarkId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');

  const corridorNow = currentDiagnosticsCorridor();
  const chainCards = state.landmarks.map((l) => {
    const c = d.chains[l.id];
    if (!c) return '';
    const sel = l.id === d.landmarkId ? 'selected' : '';
    // One cell per route sample: closed samples never enter the tracker rows,
    // so the corridor gate is applied here to keep the strip aligned with s.
    const rowByS = new Map(c.tracker.rows.map((r) => [Number(r.s.toFixed(4)), r]));
    const strip = route.samples.map((smp) => {
      const gate = corridorNow.sampleAllowed(smp);
      if (!gate.allowed) {
        return `<div class="cell closed" title="${smp.s.toFixed(1)} m · closed (${esc(gate.closure.id)})"></div>`;
      }
      const r = rowByS.get(Number(smp.s.toFixed(4)));
      if (!r) return '<div class="cell" title="no evidence"></div>';
      const cls = r.readable ? 'vis' : (r.measurement?.onScreenAreaPx >= DEFAULT_THRESHOLDS.minVisibleAreaPx ? 'area' : '');
      return `<div class="cell ${cls}" title="${r.s.toFixed(1)} m · ${r.failure ?? 'readable'}"></div>`;
    }).join('');
    const closedCells = c.tracker.closedSamples.length
      ? `<div class="hint">closed samples: ${c.tracker.closedSamples.length} (${esc(c.tracker.closedSamples[0].closureId)})</div>` : '';
    return `<div class="diag-chain ${sel}" data-diag-lm="${esc(l.id)}" style="cursor:pointer">
      <div class="dc-head">
        <span class="dc-name">${esc(l.name)}</span>
        <span class="dc-fp">fp ${c.fingerprint}</span>
      </div>
      <div class="diag-strip">${strip}</div>
      <div class="hint">visible ${c.intervals.visible.length} interval(s) · ${c.mismatches.length} mismatch(es) · evidence ${c.logCost.fullEvidenceRecords}/${c.logCost.samples} samples</div>
      ${closedCells}
    </div>`;
  }).join('');

  const mismatchList = chain ? chain.mismatches.map((mm) => `
    <div class="diag-mm ${esc(mm.cause)}">
      <div class="mm-stage">${esc(mm.kind)} · ${esc(mm.stage)} @ ${mm.atS.toFixed(1)} m</div>
      <div><strong>${esc(mm.cause)}</strong> — ${esc(mm.measured.reasons.join(', ') || mm.failure || '')}</div>
      <div class="hint">area ${Math.round(mm.measured.visibleAreaPx)} px² · on-screen ${Math.round(mm.measured.onScreenAreaPx)} px² · angular ${mm.measured.angularHeightDeg.toFixed(2)}° · ${mm.measured.distance.toFixed(1)} m</div>
      ${mm.blockers.length ? `<div class="mm-blockers">blocker: ${mm.blockers.map((b) => `${esc(b.id)} (${b.rays} rays, ${b.coveringRays} cover panel)`).join('; ')}</div>` : ''}
      ${mm.render?.disagrees ? `<div class="diag-anomaly">render disagrees: kernel ${mm.render.kernelVisiblePx} px vs rendered ${mm.render.renderedVisiblePx} px</div>` : ''}
    </div>`).join('') : '';

  const bvErrors = chain ? boundingVolumeErrors(chain) : [];
  const decision = d.decision;
  const recCard = decision ? `
    <div class="diag-rec ${esc(decision.recommendation)}">
      <h4>Boundary decision · ${esc(decision.recommendation)}</h4>
      <div class="hint" style="margin-bottom:6px">${esc(decision.boundary)}</div>
      <div class="diag-kv">
        <span class="k">save point</span><span>${decision.savePointS.toFixed(1)} m</span>
        <span class="k">first loss</span><span>${decision.firstLossS === null ? 'none' : decision.firstLossS.toFixed(1) + ' m'}</span>
        <span class="k">fork entered</span><span>${decision.forkEntered ? esc(decision.forkEntered.id) : 'none'}</span>
        <span class="k">root occluder</span><span>${esc(decision.counterfactual?.rootOccluder ?? '—')}</span>
        <span class="k">Scheme A move</span><span>${decision.move?.feasible ? `feasible (Δ ${(decision.move.best.delta * 100).toFixed(0)} pts)` : 'not available'}</span>
        <span class="k">Scheme B node</span><span>${decision.node?.feasible ? `feasible (Δ ${(decision.node.best.delta * 100).toFixed(0)} pts)` : esc(decision.node?.reason ?? 'not available')}</span>
      </div>
      ${decision.split ? `<h4 style="margin-top:8px">Sightline split — ${decision.split.segments.length} segment(s), ${decision.split.nodesNeeded} new guide node(s)</h4>
        ${decision.split.segments.map((g) => `<div class="diag-seg"><span>${g.from.toFixed(0)}–${g.to.toFixed(0)} m</span><span class="${g.needsGuideNode ? 'diag-anomaly' : 'pass'}">${(g.fraction * 100).toFixed(0)}% covered${g.needsGuideNode ? ` · ${esc(g.dominantFailure ?? 'no guide')}` : ''}</span></div>`).join('')}` : ''}
    </div>` : '';

  el.innerHTML = `
    <h2>Visibility diagnostics</h2>
    <div class="diag-controls">
      <div class="btn-row">${routeButtons}</div>
      <label>Landmark
        <select id="diag-lm-select">${lmOptions}</select>
      </label>
      <label class="diag-toggle">
        <input type="checkbox" id="diag-closure" ${d.closureOn ? 'checked' : ''} />
        apply temporary road closure (resume from save point)
      </label>
      ${route.demoClosure ? `<div class="hint">Closure arc ${route.demoClosure.from.toFixed(0)}–${route.demoClosure.to.toFixed(0)} m: ${esc(route.demoClosure.reason)}</div>` : ''}
    </div>
    <h3>Evidence chains</h3>
    <div class="diag-legend">
      <span><i style="background:#2f8f57"></i>readable</span>
      <span><i style="background:#8a6d22"></i>on-screen but below area gate</span>
      <span><i style="background:#23303f"></i>not legible</span>
      <span><i style="background:#463a6b"></i>closed arc</span>
    </div>
    ${chainCards || '<div class="empty">No evidence yet.</div>'}
    ${bvErrors.length ? `<div class="note">Bounding-volume error suspected: ${bvErrors.map((e) => `${esc(e.blockerId)} @${e.s.toFixed(0)}m`).join(', ')}</div>` : ''}
    <h3>Mismatches with evidence</h3>
    ${mismatchList || '<div class="hint">No visibility mismatch on this chain.</div>'}
    ${recCard}
    <div class="epistemic" style="margin-top:10px">
      Each chain is a deterministic evidence record (projection, per-ray occlusion, route samples).
      Re-running without edits yields the same fingerprint; an occlusion mismatch always names the
      blocker that won the rays, so the tracker cannot raise a phantom report.
    </div>`;

  el.querySelectorAll('[data-diag-route]').forEach((b) => b.addEventListener('click', () => {
    state.diagnostics.routeId = b.dataset.diagRoute;
    state.diagnostics.s = 0;
    enterDiagnostics(); renderDiagnosticsPanel();
  }));
  el.querySelectorAll('[data-diag-lm]').forEach((card) => card.addEventListener('click', () => {
    selectDiagnosticsLandmark(card.dataset.diagLm);
  }));
  el.querySelector('#diag-lm-select')?.addEventListener('change', (e) => {
    selectDiagnosticsLandmark(e.target.value);
  });
  el.querySelector('#diag-closure')?.addEventListener('change', (e) => {
    toggleClosure(e.target.checked);
  });
}

function wireDiagnosticsBar() {
  $('#diag-slider')?.addEventListener('input', (e) => {
    setDiagnosticsS(Number(e.target.value) / 10);
  });
}

// ---------------------------------------------------------------------------
// Wire UI

function wireUI() {
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#btn-solve').addEventListener('click', () => { runSolve(); flash(`Solved in ${state.solveMs.toFixed(0)} ms`); });
  $('#btn-report').addEventListener('click', exportReport);
  $('#play-toggle').addEventListener('click', togglePlay);
  $('#replay-slider').addEventListener('input', (e) => {
    state.replay.s = Number(e.target.value) / 10;
    updateReplayPose();
  });
  $('#btn-prev-key').addEventListener('click', () => jumpKey(-1));
  $('#btn-next-key').addEventListener('click', () => jumpKey(1));
  // Route choice in replay: clicking a route card switches replay route.
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.route-card');
    if (card && state.mode === 'replay') {
      const name = card.querySelector('.rc-name')?.textContent;
      const route = state.routes.find((r) => r.name === name);
      if (route) { state.replay.routeId = route.id; state.replay.s = 0; enterReplay(); renderAll(); }
    }
  });
  window.addEventListener('keydown', (e) => {
    if (state.mode !== 'replay') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight') { state.replay.s = Math.min(state.routesById[state.replay.routeId].length, state.replay.s + 1); updateReplayPose(); }
    if (e.key === 'ArrowLeft') { state.replay.s = Math.max(0, state.replay.s - 1); updateReplayPose(); }
  });
  viewport.onOverlay(() => { if (state.mode === 'replay') drawReplayOverlay(); });
  wireDiagnosticsBar();
}

function jumpKey(dir) {
  const r = state.routesById[state.replay.routeId];
  const keys = state.keySegments.filter((k) => k.routeId === r.id).sort((a, b) => a.from - b.from);
  const cur = state.replay.s;
  const target = dir > 0
    ? keys.find((k) => k.from > cur + 0.5)
    : [...keys].reverse().find((k) => k.to < cur - 0.5);
  if (target) { state.replay.s = dir > 0 ? target.from : Math.max(0, target.to - 1); updateReplayPose(); }
}

function togglePlay() {
  const rec = state.replay;
  rec.playing = !rec.playing;
  $('#play-toggle').textContent = rec.playing ? '⏸' : '▶';
  if (rec.playing) {
    rec.lastT = performance.now();
    const step = (t) => {
      if (!rec.playing) return;
      const dt = (t - rec.lastT) / 1000;
      rec.lastT = t;
      const len = state.routesById[rec.routeId].length;
      rec.s = Math.min(len, rec.s + dt * 12);
      if (rec.s >= len) { rec.playing = false; $('#play-toggle').textContent = '▶'; }
      updateReplayPose();
      if (rec.playing) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

async function exportReport() {
  refreshEvaluation();
  const report = {
    scene: state.scene.id,
    generatedAt: new Date().toISOString(),
    solveMs: state.solveMs,
    thresholds: DEFAULT_THRESHOLDS,
    landmarks: state.landmarks.map((l) => ({
      id: l.id, type: l.type, name: l.name,
      position: l.position, yawDeg: normDeg(l.yaw),
      historic: !!l.historic, fixedReason: l.fixedReason ?? null,
    })),
    routes: Object.fromEntries(Object.entries(state.evaluation.coverage.byRoute).map(([id, rc]) => [id, {
      viewpoint: state.routesById[id].viewpoint,
      coveredFraction: rc.fraction,
      longestBlindRunM: rc.longestGapLength,
      keySegments: rc.keySegments.map((k) => ({ label: k.label, fraction: k.fraction, pass: k.pass })),
      firstLegibleByLandmark: Object.fromEntries(state.landmarks.map((lm) => {
        const idx = state.evaluation.perRoute[id].findIndex((s) => s.best[lm.id]?.readable);
        return [lm.name, idx >= 0 ? state.evaluation.perRoute[id][idx].s : null];
      })),
    }])),
    explanation: state.explain.map((e) => e.text),
    trace: state.trace,
    tradeoff: state.tradeoff,
    disclaimer: 'Verifies measurable visual conditions (projected area, unoccluded fraction, viewport position, angular size). Does not verify human comprehension of direction.',
  };
  // Send to the dev server for persistence; fall back to download.
  try {
    const res = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    if (!res.ok) throw new Error('server refused');
    const out = await res.json();
    flash(`Report written to ${out.path}`);
  } catch {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'harbor-quarter-report.json';
    a.click();
    flash('Report downloaded');
  }
}

function normDeg(rad) {
  let d = ((rad * 180) / Math.PI + 540) % 360 - 180;
  return d;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot().catch((err) => {
  console.error(err);
  const el = document.getElementById('hud-view-badge');
  if (el) { el.textContent = 'Boot error: ' + err.message; el.style.color = '#f87171'; }
});
