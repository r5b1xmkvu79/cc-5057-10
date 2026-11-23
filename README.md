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

Once open you get four modes (top bar):

| Mode | What you do |
| --- | --- |
| **Edit** | Orbit the diorama (right-mouse drag / wheel). Click a landmark, drag its ground ring, or edit its `x` / `z` / yaw fields. Coverage re-measures live. **Auto-place** re-runs the solver. **Export report** POSTs the measured plan to `artifacts/plan-*.json`. |
| **Route replay** | Scrub or play along either route. The passenger view is letterboxed to the 1280×720 reference frame. The green box is the measured sign footprint; the dashed box is the safe viewport; the top-right HUD shows area / unoccluded / on-screen / angular height / distance / verdict. The coverage strip and blind-run list jump you straight to a gap. |
| **Trade-off** | Focused comparison for a mutually-occluding pair: *migrate the landmark* vs *adjust the observer point*, each with its measured share of the contested window and its longest blind run inside it. Seated routes refuse the observer option outright. |
| **Diagnostics** | The graphical entry point for visibility-mismatch work. Pick a route and landmark, optionally apply the **temporary road closure**, and scrub the route from the **save point**. The 3D view shows the navigator's walkable corridor (cyan ribbon), red closure barricades, the green save-point ring and amber fork markers; the overlay draws the real projected panel polygon, per-ray sightline dots (green free / red blocked / amber blocked-without-panel-overlap) and the visibility interval. The sidebar shows per-landmark evidence fingerprints, interval strips, mismatch cards with cause + stage + named blockers, bounding-volume warnings, log cost and the boundary repair decision (Scheme A / Scheme B / split / report unseen). |

If the headless screenshot checks are what you want to run, see
[Verification](#verification); they need the private sysroot described there.

---

## Visibility-mismatch diagnostics

The Diagnostics mode and `kernel/diagnostics.js` answer the brief's core
question: **which cases pass the placement evaluation yet are actually
invisible, and what is the evidence-backed repair?**

### Corridors are ground truth

The navigator — not the visibility kernel — owns where an observer may stand.
`makeCorridor(route, overrides)` models the walkable surface as a centreline
plus an arc-length-varying half-width, with zero-width stretches for a fixed
seat or a closed road. Every diagnostic camera is a legal corridor pose; an
"unblocked" ray from an illegal pose is never recorded as evidence. A
**temporary closure** (`demoClosure` in `content/scenes.js`) refuses the closed
arc and the walk resumes from the route's **save point** on foot.

### Evidence chains and fingerprints

Each (route, landmark) pair gets an evidence chain: per-sample projection, the
per-ray occlusion query with the winning blocker named, and the screen-area /
visibility intervals derived from the rows. A deterministic FNV-1a
**fingerprint** (canonical, number-rounded JSON) covers every row, transition
and closed sample, so re-running an unchanged configuration is proven identical
and any drift is a failure. The tracker cannot raise a phantom report: a
critical-occlusion mismatch must name the blocker that won the rays, and every
other mismatch needs a blocker, a render disagreement, or a real threshold
breach. Log volume is budgeted (`DEFAULT_BUDGET`): routine stride sampling,
full per-ray detail only around readability transitions, and a hard cap on
retained evidence records.

### Boundary condition and the two repair schemes

`decideRepair()` closes the road, walks from the save point, and combines the
**first guide-loss location** with the **fork the walker ultimately enters**:

* **Scheme A — move the landmark.** Chosen when a counterfactual replay
  removing exactly one occluder restores the whole first-loss window (the
  per-object culling case) and no fork was committed before the loss. A lateral
  offset search confirms a feasible new position.
* **Scheme B — change the guide/observer node.** Only legal on free-viewpoint
  routes; a fixed seat returns `fixed viewpoint: the seated eye cannot be
  relocated`, and a fork entered before the loss rejects the nudge outright.
* **Split the route.** When the loss survives every single-object removal (or a
  fork was already taken), the route is split at its sightline intersections
  and each segment that cannot hold the guide gets its own guide node.
* **Report unseen.** When the landmark never becomes legible from any reachable
  pose, the stretch is reported rather than given fabricated guidance.

For briefly disappearing targets, `counterfactualReplay()` removes one object
at a time and measures the regained arc length; `locateMismatch()` tries every
named blocker and pins the root occluder. `boundingVolumeErrors()` flags the
AABB-error signature — rays blocked by a box whose projected polygon never
overlaps the panel — which is drawn as amber dots in the overlay. Root causes
are classified as **critical-occlusion**, **distant-small**, or
**composition-threshold**, and distinguished from **under-sampling** by the
occlusion boundary rather than the sign's distance, each tagged with the
pipeline **stage** where the anomaly was observed.

### CLI is auxiliary

The command line only re-runs the same kernel the graphical mode uses; it
cannot replace the editor viewport:

```bash
npm run diagnose            # open-corridor evidence chains, fingerprint drift check
npm run diagnose:closure    # same walk with the temporary road closure applied
# add --out artifacts/diag to write the full evidence JSON
```

Both commands run every chain twice and fail on fingerprint drift or a phantom
mismatch. The graphical Diagnostics mode is the primary entry point; the CLI
exists for batch verification and artifact capture.

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
7. **Visibility-mismatch diagnostics.** The navigator corridor is the ground
   truth; evidence chains with deterministic fingerprints record projection,
   occlusion and sampling; a temporary closure is walked from the save point;
   counterfactual single-object removal and the first-loss/fork boundary choose
   between moving the landmark (A), moving the guide node (B), splitting the
   route, or honestly reporting the stretch unseen. See
   [Visibility-mismatch diagnostics](#visibility-mismatch-diagnostics).

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
kernel/diagnostics.js walkable corridors + closures, evidence tracker with
                      deterministic fingerprints, counterfactual single-object
                      replay, sightline route splits, Scheme A/B evaluation and
                      the first-loss/fork boundary decision.
content/world.js      the district: occluders, platforms, landmark catalog.
content/scenes.js     the two routes, key segments, shared sign, mutual pair,
                      locked historic clock, corridor/save-point/fork/closure
                      ground truth; materializeScene().
app/                  the editor: index.html, style.css, viewport.js (three.js
                      diorama + replay/diagnostics camera + corridor overlay),
                      main.js (controller/UI for all four modes).
scripts/serve.mjs     static server + POST /api/report.
scripts/diagnose.mjs  CLI batch runner for the diagnostics evidence chains
                      (auxiliary; the graphical mode is the primary entry).
verify/               kernel.test.mjs (unit), diagnostics.test.mjs (evidence,
                      corridors, counterfactual, repair decisions), verify.mjs
                      (node + headless render), render.html (rasterisation
                      harness), ui-smoke.mjs (drives the real UI).
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
npm test          # node:test suites — 43 tests total:
                  #   kernel (18): geometry, clipping regression, visibility
                  #     gates, occluder derivation, solver constraints
                  #   diagnostics (25): fingerprints/determinism, corridors &
                  #     closures, no-phantom-mismatch, counterfactual replay,
                  #     bounding-volume errors, route splits, Scheme A/B and
                  #     the first-loss/fork boundary, Harbor Quarter end-to-end
npm run verify:ui # boots the real editor in headless Chromium, exercises all
                  #   four modes (incl. diagnostics scrubbing, closure, stable
                  #   fingerprints) + auto-place + export; fails on console error
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
