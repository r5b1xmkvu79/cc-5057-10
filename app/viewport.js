// Three.js viewport: district, routes coloured by measured coverage, editable
// landmarks, and a passenger-eye replay camera. The overlay canvas draws the
// measured panel footprint straight from the kernel camera, so what you see on
// screen and what the numbers say come from the same projection.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeCamera, measureLandmark, projectPoint } from '../kernel/visibility.js';
import { signCorners, signCenter, signBasis } from '../kernel/visibility.js';
import { vec, add, mul } from '../kernel/geom.js';

// The kernel and the render harness report all areas at this reference frame.
// The replay view is letterboxed to the same 16:9 frame so the grid of pixels on
// screen is the same grid the numbers describe.
export const REF_W = 1280;
export const REF_H = 720;
export const REF_ASPECT = REF_W / REF_H;

const COLORS = {
  good: 0x4ade80,
  marg: 0xfbbf24,
  blind: 0xf87171,
  keyseg: 0xa78bfa,
  ground: 0x1a222d,
  platform: 0x2a3646,
  setpiece: 0x8a5a2b,
  historic: 0x5a4a1f,
};

export class Viewport {
  constructor(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x0a0e14, 1);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0e14, 150, 340);
    this.editCam = new THREE.PerspectiveCamera(55, 1, 0.5, 600);
    this.editCam.position.set(30, 120, 130);
    this.controls = new OrbitControls(this.editCam, canvas);
    this.controls.target.set(-10, 0, 10);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 320;

    this.replayCam = new THREE.PerspectiveCamera(62, 1, 0.1, 500);
    this.mode = 'edit';
    this.currentReplay = null;
    this.resizeListeners = [];
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();

    this.worldGroup = new THREE.Group();
    this.routeGroup = new THREE.Group();
    this.landmarkGroup = new THREE.Group();
    this.scene.add(this.worldGroup, this.routeGroup, this.landmarkGroup);

    this._addLights();
    this._addGround();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  _addLights() {
    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x1a1f28, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
    sun.position.set(-60, 120, 80);
    sun.castShadow = false;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x7fb6ff, 0.35);
    fill.position.set(80, 40, -60);
    this.scene.add(fill);
  }

  _addGround() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 420),
      new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1, metalness: 0 }),
    );
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.02;
    g.userData.isGround = true;
    this.worldGroup.add(g);
    this.groundMesh = g;
    const grid = new THREE.GridHelper(420, 84, 0x233042, 0x18212c);
    grid.position.y = 0.0;
    this.worldGroup.add(grid);
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h, false);
    this.editCam.aspect = w / h;
    this.editCam.updateProjectionMatrix();
    // Letterbox the passenger view to the reference 16:9 frame so the pixel
    // grid matches the numbers the kernel reports (1280x720).
    const vw = Math.min(w, Math.floor(h * REF_ASPECT));
    const vh = Math.floor(vw / REF_ASPECT);
    this.viewRect = { x: Math.floor((w - vw) / 2), y: Math.floor((h - vh) / 2), w: vw, h: vh };
    this.replayCam.aspect = REF_ASPECT;
    this.replayCam.updateProjectionMatrix();
    this.overlay.width = w * (window.devicePixelRatio || 1);
    this.overlay.height = h * (window.devicePixelRatio || 1);
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
    this.vw = w; this.vh = h;
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'edit';
    this.overlay.style.display = mode === 'replay' ? 'block' : 'none';
    // Billboard labels belong to the diorama, not to a passenger's-eye view.
    this.scene.traverse((o) => { if (o.userData?.isLabel) o.visible = mode !== 'replay'; });
    if (mode !== 'replay') this._clearOverlay();
  }

  buildWorld(district) {
    this.worldGroup.clear();
    this.labelGroup?.clear();
    this._addGround();
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    for (const b of district.occluders) {
      const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z;
      const color = b.kind === 'setpiece' ? COLORS.setpiece : b.kind === 'historic' ? COLORS.historic : 0x39475a;
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.92, metalness: 0.04,
        emissive: b.kind === 'setpiece' ? 0x2a1a08 : 0x000000,
      });
      const m = new THREE.Mesh(boxGeo, mat);
      m.scale.set(w, h, d);
      m.position.set(b.min.x + w / 2, b.min.y + h / 2, b.min.z + d / 2);
      m.userData.box = b;
      this.worldGroup.add(m);
      // Edges give the low-poly diorama a readable silhouette.
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0x8596ad, transparent: true, opacity: 0.28 }));
      edges.scale.copy(m.scale); edges.position.copy(m.position);
      this.worldGroup.add(edges);
      if (b.kind === 'setpiece' || b.kind === 'historic') {
        this._addLabel(b.label ?? b.id, new THREE.Vector3(m.position.x, b.max.y + 2.5, m.position.z), b.kind === 'setpiece' ? '#e3a869' : '#d8c06a');
      }
    }
    for (const p of district.platforms) {
      const w = p.max.x - p.min.x, h = p.max.y - p.min.y, d = p.max.z - p.min.z;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: COLORS.platform, roughness: 1 }));
      m.position.set(p.min.x + w / 2, p.min.y + h / 2, p.min.z + d / 2);
      m.userData.box = p;
      this.worldGroup.add(m);
    }
  }

  _addLabel(text, pos, color = '#9fb2c9') {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(10,14,20,0.72)';
    ctx.roundRect?.(0, 0, 512, 64, 10); ctx.fill();
    ctx.font = '600 28px ui-sans-serif, system-ui';
    ctx.fillStyle = color;
    ctx.fillText(text, 14, 42);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.position.copy(pos);
    spr.scale.set(26, 3.25, 1);
    spr.userData.isLabel = true;
    // Add to the diorama layer, not the world layer, so replay can hide all
    // labels in one pass.
    (this.labelGroup ??= (() => { const g = new THREE.Group(); this.scene.add(g); return g; })()).add(spr);
  }

  // Routes are drawn as separate small segments so each can carry its measured
  // visibility status (green / amber / red) and key-segment styling.
  buildRoutes(routes, keySegments) {
    this.routeGroup.clear();
    this.routeMeshes = {};
    for (const route of routes) {
      const group = new THREE.Group();
      const pts = route.samples;
      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i].position, b = pts[i + 1].position;
        const key = keySegments.find((k) => k.routeId === route.id && pts[i].s >= k.from && pts[i].s <= k.to);
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(a.x, a.y + 0.12, a.z),
          new THREE.Vector3(b.x, b.y + 0.12, b.z),
        ]);
        const mat = new THREE.LineBasicMaterial({ color: 0x3b4a5e, linewidth: 2 });
        const line = new THREE.Line(geo, mat);
        group.add(line);
        segs.push({ line, i, key: !!key });
      }
      // Wide key-segment underlay so key stretches are visible even from above.
      for (const k of keySegments.filter((x) => x.routeId === route.id)) {
        const inSeg = pts.filter((s) => s.s >= k.from && s.s <= k.to);
        if (inSeg.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(inSeg.map((s) => new THREE.Vector3(s.position.x, s.position.y + 0.08, s.position.z)));
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, Math.max(8, inSeg.length * 2), 0.55, 5, false),
          new THREE.MeshBasicMaterial({ color: COLORS.keyseg, transparent: true, opacity: 0.20, depthWrite: false }),
        );
        group.add(tube);
      }
      // Start / end markers.
      this._addMarker(pts[0].position, 0x6ee7b7, 'start ' + route.name);
      this._addMarker(pts[pts.length - 1].position, 0xfca5a5, 'end ' + route.name);
      this.routeMeshes[route.id] = segs;
      this.routeGroup.add(group);
    }
  }

  _addMarker(p, color, text) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.0, 12, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }));
    m.position.set(p.x, p.y + 0.6, p.z);
    this.routeGroup.add(m);
    this._addLabel(text, new THREE.Vector3(p.x, p.y + 4, p.z), '#' + color.toString(16).padStart(6, '0'));
  }

  colorRoutes(evaluation) {
    const statusFor = (sample) => {
      if (!sample) return 'blind';
      if (sample.visibleIds.length === 0) return 'blind';
      const best = sample.visibleIds.map((id) => sample.best[id]).sort((a, b) => b.quality - a.quality)[0];
      return best && best.quality > 0.62 ? 'good' : 'marg';
    };
    for (const [routeId, segs] of Object.entries(this.routeMeshes ?? {})) {
      const samples = evaluation.perRoute[routeId] ?? [];
      for (const { line, i } of segs) {
        const st = statusFor(samples[i]);
        line.material.color.setHex(st === 'good' ? COLORS.good : st === 'marg' ? COLORS.marg : COLORS.blind);
        line.material.opacity = st === 'blind' ? 0.85 : 1;
      }
    }
  }

  buildLandmarks(landmarks, selectedId, { onDrag } = {}) {
    this.landmarkGroup.clear();
    this.landmarkMeshes = [];
    for (const lm of landmarks) {
      const g = new THREE.Group();
      g.position.set(lm.position.x, lm.position.y, lm.position.z);
      g.rotation.y = lm.yaw;
      const bodyH = lm.body?.h ?? 4;
      const bodyW = lm.body?.w ?? 1.4;
      const bodyD = lm.body?.d ?? 1.4;
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(Math.min(bodyW, bodyD) / 2, Math.min(bodyW, bodyD) / 2 * 1.15, bodyH, 8),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(lm.color), roughness: 0.55, metalness: 0.25, emissive: new THREE.Color(lm.color), emissiveIntensity: 0.08 }),
      );
      body.position.y = bodyH / 2;
      body.userData.landmarkId = lm.id;
      g.add(body);
      // Historic buildings get a slab body, not a pole.
      if (lm.historic) {
        body.visible = false;
      }

      // Sign panel: plane normal is yawToDir(yaw) = (-sin,0,-cos), which is -Z
      // in local space. PlaneGeometry faces +Z, so rotate 180° about Y.
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(lm.sign.w, lm.sign.h),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(lm.color), emissive: new THREE.Color(lm.color), emissiveIntensity: 0.35,
          side: THREE.DoubleSide, roughness: 0.4,
        }),
      );
      sign.position.y = lm.sign.yOffset;
      sign.rotation.y = Math.PI;
      sign.userData.landmarkId = lm.id;
      g.add(sign);
      // Frame so the panel reads in the diorama.
      const frame = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(lm.sign.w, lm.sign.h)),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }),
      );
      frame.position.y = lm.sign.yOffset;
      frame.rotation.y = Math.PI;
      g.add(frame);
      // A ground ring shows the footprint / click target.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(bodyW, bodyD) * 0.7, Math.max(bodyW, bodyD) * 0.7 + 0.35, 24),
        new THREE.MeshBasicMaterial({ color: selectedId === lm.id ? 0x4fd1ff : 0x6b7c92, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      ring.userData.landmarkId = lm.id;
      g.add(ring);
      g.userData.landmarkId = lm.id;
      if (selectedId === lm.id) {
        const halo = new THREE.Mesh(
          new THREE.CylinderGeometry(2.5, 2.5, 0.1, 24, 1, true),
          new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
        );
        halo.position.y = 0.05;
        g.add(halo);
      }
      this.landmarkGroup.add(g);
      this.landmarkMeshes.push(g);
      this._addLabel(lm.name + (lm.historic ? ' 🔒' : ''), new THREE.Vector3(lm.position.x, lm.position.y + (lm.sign.yOffset + lm.sign.h / 2 + 2.2), lm.position.z), lm.color);
    }
    if (onDrag) this._enableDrag(onDrag);
  }

  _enableDrag(onDrag) {
    if (this._dragBound) return;
    this._dragBound = true;
    let dragging = null;
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const setPointer = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this._pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this._pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'edit') return;
      setPointer(e);
      this._raycaster.setFromCamera(this._pointer, this.editCam);
      const hits = this._raycaster.intersectObjects(this.landmarkMeshes, true);
      const hit = hits.find((h) => h.object.userData.landmarkId);
      if (!hit) return;
      dragging = hit.object.userData.landmarkId;
      this.controls.enabled = false;
      this.canvas.setPointerCapture(e.pointerId);
      onDrag({ phase: 'start', id: dragging });
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setPointer(e);
      this._raycaster.setFromCamera(this._pointer, this.editCam);
      const p = new THREE.Vector3();
      if (this._raycaster.ray.intersectPlane(dragPlane, p)) {
        onDrag({ phase: 'move', id: dragging, x: p.x, z: p.z });
      }
    });
    const end = (e) => {
      if (!dragging) return;
      const id = dragging; dragging = null;
      this.controls.enabled = this.mode === 'edit';
      onDrag({ phase: 'end', id });
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  setReplayCamera(pose) {
    this.currentReplay = pose;
    const c = this.replayCam;
    c.position.set(pose.position.x, pose.position.y, pose.position.z);
    c.rotation.set(0, 0, 0);
    c.rotateY(pose.yaw);
    if (pose.pitch) c.rotateX(pose.pitch);
    c.fov = pose.fovYDeg ?? 62;
    c.updateProjectionMatrix();
  }

  // Draw the measured panel footprint over the rendered frame. Measurement
  // pixels are in the 1280x720 reference frame; map them into the letterboxed
  // view rect so the overlay lands on the actual sign.
  drawMeasureOverlay(lm, measurement, cam) {
    if (!cam) { this._clearOverlay(); return; }
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.scale(dpr, dpr);
    const W = this.vw, H = this.vh;
    const R = this.viewRect ?? { x: 0, y: 0, w: W, h: H };
    const sx = R.w / REF_W, sy = R.h / REF_H;
    const mx = (px) => R.x + px * sx;
    const my = (py) => R.y + py * sy;
    // Safe viewport rectangle, in reference-frame percentages, drawn in the rect.
    ctx.strokeStyle = 'rgba(120,160,200,0.35)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.strokeRect(R.x + R.w * 0.07, R.y + R.h * 0.09, R.w * 0.86, R.h * 0.82);
    ctx.setLineDash([]);
    if (!lm || !measurement) return;

    const corners = measurement.cornersPx;
    const inFront = corners.every((c) => c.inFront);
    if (inFront) {
      ctx.beginPath();
      corners.forEach((c, i) => (i ? ctx.lineTo(mx(c.x), my(c.y)) : ctx.moveTo(mx(c.x), my(c.y))));
      ctx.closePath();
      ctx.strokeStyle = measurement.readable ? 'rgba(74,222,128,0.95)' : 'rgba(248,113,113,0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = measurement.readable ? 'rgba(74,222,128,0.10)' : 'rgba(248,113,113,0.08)';
      ctx.fill();
    }
    const c = { x: mx(measurement.centroidPx.x), y: my(measurement.centroidPx.y) };
    ctx.beginPath();
    ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = measurement.readable ? '#4ade80' : '#f87171';
    ctx.fill();
    // Sample dots: green = unoccluded and on screen, red = blocked/off-screen.
    const all = measurement.visibleSamplesPx ?? [];
    ctx.fillStyle = 'rgba(74,222,128,0.9)';
    for (const p of all) { ctx.beginPath(); ctx.arc(mx(p.x), my(p.y), 2.2, 0, Math.PI * 2); ctx.fill(); }

    ctx.font = '600 12px ui-sans-serif, system-ui';
    const label = `${lm.name} — area ${Math.round(measurement.visibleAreaPx)} px² (${(measurement.areaFraction * 100).toFixed(1)}% frame), visible ${(measurement.visibleFraction * 100).toFixed(0)}%, ${measurement.distance.toFixed(1)} m`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,14,20,0.82)';
    ctx.fillRect(c.x + 10, c.y - 26, tw + 14, 22);
    ctx.fillStyle = measurement.readable ? '#c9f7da' : '#ffd1d1';
    ctx.fillText(label, c.x + 17, c.y - 10);
  }

  _clearOverlay() {
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  animate() {
    requestAnimationFrame(this.animate);
    if (this.mode === 'edit') this.controls.update();
    if (this.mode === 'replay') {
      // Render the 16:9 passenger frame into the letterboxed rect, with black
      // bars outside it, so the view matches the 1280x720 reference measurement.
      const R = this.viewRect ?? { x: 0, y: 0, w: this.vw, h: this.vh };
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(R.x, this.vh - R.y - R.h, R.w, R.h);
      this.renderer.setViewport(R.x, this.vh - R.y - R.h, R.w, R.h);
      this.renderer.render(this.scene, this.replayCam);
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.vw, this.vh);
      if (this._overlayFn) this._overlayFn();
    } else {
      this.renderer.render(this.scene, this.editCam);
    }
  }

  onOverlay(fn) { this._overlayFn = fn; }
}

export { makeCamera, measureLandmark, projectPoint, signCorners, signCenter, signBasis };
