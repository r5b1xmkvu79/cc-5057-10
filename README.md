# Harbor Quarter — Landmark Guide Editor

A level-editor tool for placing *guide landmarks* (signs, spires, gatehouses)
so that players travelling one of several routes can actually see a legible
shaped guide at the important stretches. It is a real, interactive editor: you
place and drag landmarks, replay the passenger's-eye view along each route,
watch blind zones appear and disappear, and read the measured projection of any
sign in the frame — all driven by the same visibility kernel that the Node
verifier uses.

It answers a harder question than "is the ray unblocked?":

* projected **area** on screen (after exact frustum clipping),
* **unoccluded fraction** (per-sample ray occlusion, with blocker attribution),
* **viewport position** (the sign's centre must sit inside a safe region),
* **angular size** (a far one-pixel prop is not a landmark),
* **incidence** (a sign seen edge-on is not legible),
* and never letting a sign **swamp the frame** to game the area threshold.

> **What this tool does and does not claim.** Every number it reports is a
> *measurable geometric/visual condition*. Clearing those conditions is
> necessary for a human to read the guide; it is **not** proof that a human will
> understand the intended direction. The tool verifies the measurable
> preconditions of legibility, not cognition. See
> [Epistemic contract](#epistemic-contract).

---

## Quick start (the UI)

```bash
npm install          # installs three (runtime) + playwright (dev, for checks)
npm start            # static dev server, no bundler
# → open http://localhost:4173/
```

`npm start` runs `scripts/serve.mjs` on **http://localhost:4173/** (it also
writes exported reports under `artifacts/`). The browser must be able to load
ES modules from `node_modules/three`; the server serves those directly, so no
build step is needed.

Once open you get three modes (top bar):

| Mode | What you do |
| --- | --- |
| **Edit** | Orbit the diorama (right-mouse drag / wheel). Click a landmark, drag its ground ring, or edit its `x` / `z` / yaw fields. Coverage re-measures live. **Auto-place** re-runs the solver. **Export report** POSTs the measured plan to `artifacts/plan-*.json`. |
| **Route replay** | Scrub or play along either route. The passenger view is letterboxed to the 1280×720 reference frame. The green box is the measured sign footprint; the dashed box is the safe viewport; the top-right HUD shows area / unoccluded / on-screen / angular height / distance / verdict. The coverage strip and blind-run list jump you straight to a gap. |
| **Trade-off** | Focused comparison for a mutually-occluding pair: *migrate the landmark* vs *adjust the observer point*, each with its measured share of the contested window and its longest blind run inside it. Seated routes refuse the observer option outright. |

If the headless screenshot checks are what you want to run, see
[Verification](#verification); they need the private sysroot described there.

---

## The scenario this tool was built against

One district (`content/world.js`): a curved street, two raised platforms, and
buildings that block distant views (great house, mint, tenements, arcade,
cistern block). Two routes through it (`content/scenes.js`):

* **Plaza Walk** — a *free viewpoint*: the walker may step ≤ 1.8 m sideways and
  pan the head ± 35°.
* **Tram Line** — a *fixed viewpoint*: seated passengers at eye height 2.35 m;
  only ± 10° of head pan. The eye cannot be relocated.

The tool demonstrates every requirement:

1. **Same set-piece, two routes.** One `cistern-block` occluder is the shared
   blocker for one roadside sign on *both* routes. The verifier proves it is the
   named blocker on both approaches.
2. **Free vs fixed viewpoint.** The free plaza route may nudge the corner guide
   point; the tram route may not. When the fixed route cannot see the sign, the
   verifier reports that stretch as **explicitly unseen** instead of pretending.
3. **Locked historic building.** The Mint clock is a fixed landmark. Both routes
   are re-walked and the *measured* first-legible-contour positions are recorded
   to test the placer's choice (mint stays at `(41.8, −6)`).
4. **Mutual occlusion trade-off.** A gatehouse (arch) and a spire partly hide
   each other's guide line. The tool measures **migrate vs. adjust-observer** and
   the **longest blind run inside the contested window** for each.
5. **Coverage & redundancy.** The solver is a greedy weighted set-cover with a
   redundancy penalty and a per-key-segment balance term, so multiple observation
   points and landmarks are chosen for coverage, not duplicated pointlessly.
6. **Render vs. measurement.** Headless Chromium renders the actual passenger
   frames and the same sign as a white mask; the rendered pixel counts are
   compared against the kernel's analytic projection. The check that used to
   fail (a sign straddling the frustum edge) is now a regression test.

The delivered plan and measured report are written to `artifacts/verify/`:

* `report.json` — routes, key segments, shared set-piece, locked historic,
  trade-off, render checks, pass/fail.
* `*.png` — the actual passenger frames that were measured.

---

## Architecture

No bundler. Pure ES modules shared by the browser and Node.

```
kernel/geom.js        vector maths, AABB rays, Jacobi eigen, convex hull,
                      Sutherland–Hodgman clipping (rect + true 3D frustum).
kernel/visibility.js  makeCamera, sign corners/samples, measureLandmark()
                      (the acceptance test), route sampling, observer poses.
kernel/placement.js   catalog → landmark, candidate generation, landmark
                      occluder boxes, evaluatePlan, greedy set-cover solver,
                      explainPlan, compareTradeoff.
content/world.js      the district: occluders, platforms, landmark catalog.
content/scenes.js     the two routes, key segments, shared sign, mutual pair,
                      locked historic clock; materializeScene().
app/                  the editor: index.html, style.css, viewport.js (three.js
                      diorama + replay camera), main.js (controller/UI).
scripts/serve.mjs     static server + POST /api/report.
verify/               kernel.test.mjs (unit), verify.mjs (node + headless
                      render), render.html (rasterisation harness),
                      ui-smoke.mjs (drives the real UI).
```

**Single source of truth.** `measureLandmark()` in `kernel/visibility.js` is
called by the solver, the editor HUD/overlay, the export, and the verifier. The
editor cannot disagree with the report. All reported areas are computed in the
fixed 1280×720 reference frame (never the live window size), and the replay view
is letterboxed to that same 16:9 frame so the pixel grid on screen is the pixel
grid the numbers describe.

**The solver** (`solvePlacement`) precomputes a *coverage vector* per candidate
(the route samples at which it would be legible from the route's allowed
observer poses), then greedily adds landmarks weighted toward under-covered key
segments, penalising redundancy and any candidate that swamps the frame. Fixed
and historic landmarks are seeded first and never moved. Final numbers always
come from a full re-evaluation, never the fast path.

---

## Verification

Three independent gates:

```bash
npm test          # kernel unit tests (18): geometry, clipping regression,
                  #   visibility gates, occluder derivation, solver constraints
npm run verify:ui # boots the real editor in headless Chromium, exercises all
                  #   three modes + auto-place + export; fails on any console error
npm run verify    # re-authors the plan in Node, renders passenger frames in
                  #   headless Chromium, and checks render-vs-measurement
```

The last two launch Chromium, so they run through `scripts/with-sysroot.mjs`,
which prepends `tools/sysroot/**/aarch64-linux-gnu` to `LD_LIBRARY_PATH` when it
exists and does nothing otherwise. On this aarch64 host — which has no root —
that private sysroot is what lets Playwright's Chromium start: the arm64
dependency `.deb`s were fetched with `apt-get download` into `tools/debs` and
unpacked into `tools/sysroot`. On a machine with a normal desktop Chromium the
wrapper is a no-op.

`tools/` is a local build artifact (about 100 MB of `.deb`s and the extracted
sysroot) and is not part of the deliverable source; the editor and all checks
run without it wherever Chromium launches normally. There is no `postinstall`
hook, so `npm install` only pulls `three` and `playwright` — it does not download
browsers.

### What "PASS" means here

From the latest run (`artifacts/verify/report.json`):

```
plaza-walk: covered 99%  longest blind 0 m   key segments all PASS
tram-line:  covered 98%  longest blind 2 m   key segments all PASS
shared set-piece on plaza-walk: hidden by cistern from 0 m, first legible at 102 m
shared set-piece on tram-line:  hidden by cistern from 0 m; cistern clears at
   128 m but the fixed viewpoint never delivers a legible shape
   (off-screen, small-area) — REPORTED UNSEEN
locked historic: mint fixed at (41.8, -6), first legible
   {"plaza-walk":102,"tram-line":130}
trade-off window 0-54 m: base 0%, migrate 54%, observer 0%
render checks: 9, failures: 0
page errors: none
overall: PASS
```

The tram "REPORTED UNSEEN" line is the honest outcome the brief asked for: a
seated passenger cannot move the eye, so the tool does not fabricate coverage —
it relocates or reports. The trade-off numbers are identical in the UI and the
report because both call the same kernel with the same context and reference
frame.

---

## Epistemic contract

The tool measures:

* on-screen **projected area** after exact frustum clipping (GPU-equivalent),
* **unoccluded fraction** from per-sample ray occlusion,
* **viewport position** of the centroid versus a safe rectangle,
* **angular height** and **incidence** of the panel,
* and enforces a **maximum frame fraction** so a sign cannot be scaled to fill
  the frame and call it "visible".

It does **not** and cannot measure whether a human reads the sign, infers the
direction, or finds it memorable. A sign that clears every threshold is
*measurably legible under these assumptions*; orientation and cognition are out
of scope. The threshold constants are exported (`DEFAULT_THRESHOLDS`) and shown
in the UI ("Show thresholds used") so the boundary of the claim is inspectable.

The rendered frames under `artifacts/verify/` exist precisely so you can look at
what was measured rather than trusting the number alone.

---

## Notes & limits

* The scene is single-district and single-scenario; the kernel is generic but the
  content is authored for the Harbor Quarter brief.
* Render agreement uses generous ratio bounds (grazing quads rasterise slightly
  differently from an analytic hull); the exact clipping defect that once broke
  this is now pinned by a unit test.
* The district coordinates, routes and landmark catalog are hand-authored in
  `content/`; the solver searches positions and yaws, not building geometry.
