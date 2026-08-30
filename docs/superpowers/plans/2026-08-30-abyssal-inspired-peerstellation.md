# ABYSSAL inspired Peerstellation experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Use the reference repository's production rendering ideas without copying its code, and make Peerstellation's real IPFS observatory feel cinematic while remaining evidence-driven, accessible, and fast.

**Architecture:** Keep Three.js as the renderer with WebGPU first and WebGL2 fallback. Keep Rust WASM for peer analytics and Zig WASM for numeric layout/edges; add small pure TypeScript policies for camera framing, quality adaptation, and diagnostics. All visual events are driven by observed peer transitions, never fabricated topology.

**Tech Stack:** TypeScript 7, Three.js 0.185, WebGPU/WebGL2, Rust and Zig WASM, Vitest, Playwright, axe, Pa11y, html-validate, Biome.

**Spec:** `docs/product-spec.md`

## Global Constraints

- Do not copy source code, shader code, naming, prose, or parameter tables from `Token-Gremlin/natural-disasters`.
- Keep the application limited to real Helia/Kubo observations and explicitly label unmeasured values.
- Preserve WebGPU-first startup, WebGL2 fallback, Rust/Zig WASM split, reduced-motion behavior, and keyboard/touch node cards.
- No new runtime dependency unless it is required for the tested behavior and remains free for local/static deployment.
- Every behavior change starts with a failing test and ends with unit, E2E, accessibility, and production-build verification.

### Task 1: Boundary-aware camera framing

**Files:**
- Create: `src/scene/camera-fit.ts`
- Modify: `src/scene/universe.ts`
- Test: `tests/camera-fit.test.ts`

**Interfaces:** `fitPerspectiveDistance(radius, fovYRadians, aspect, padding): number` and `fitBoundsRadius(points): number` return finite, clamped framing values used by `ThreeUniverseScene`.

- [ ] Write a Vitest test proving a portrait viewport uses the horizontal frustum limit and that an empty point set returns the safe minimum.
- [ ] Run `npx vitest run tests/camera-fit.test.ts` and confirm the new assertions fail before implementation.
- [ ] Implement the two pure helpers without Three.js imports.
- [ ] Replace the fixed 54/84 distance with a smoothed target derived from the live WASM positions, preserving manual wheel/pinch override until the peer signature changes.
- [ ] Run the focused test and the existing layout/WASM tests.

### Task 2: 200% text and compact topbar regression

**Files:**
- Modify: `src/styles.css`
- Modify: `tests/e2e/universe.spec.ts`

**Interfaces:** The topbar remains usable at 320 CSS px and 200% root text size; visually hidden labels retain accessible names.

- [ ] Add an E2E assertion for `.topbar`, `.topbar__actions`, `#header-network-state`, and `#peer-explorer-button` client/scroll widths.
- [ ] Run that test and observe the current clipping failure.
- [ ] Add a narrow responsive layout that allows status/action controls to wrap or collapse without hiding their accessible names; avoid fixed-width text containers.
- [ ] Run the focused E2E, axe, Pa11y, and html-validate checks.

### Task 3: Evidence-backed discovery arrival choreography

**Files:**
- Create: `src/scene/arrival.ts`
- Modify: `src/scene/universe.ts`
- Test: `tests/arrival.test.ts`

**Interfaces:** `ArrivalPhase` and `advanceArrival(phase, elapsedMs, reducedMotion)` provide a deterministic five-stage state machine for a newly observed peer.

- [ ] Test the phase timeline and immediate settle under reduced motion.
- [ ] Verify the test fails before implementation.
- [ ] Implement the state machine and use it only for peer IDs that entered the observed set; cap concurrent arrivals at three and queue the rest.
- [ ] Render a single travelling highlight and one ring per active arrival, reusing existing geometries and avoiding per-frame allocations.
- [ ] Verify unit tests, WebGPU/WebGL2 E2E, and reduced-motion screenshots.

### Task 4: Symmetric quality policy and honest telemetry

**Files:**
- Create: `src/scene/quality-policy.ts`
- Modify: `src/scene/universe.ts`
- Test: `tests/quality-policy.test.ts`
- Modify: `tests/e2e/universe.spec.ts`

**Interfaces:** `QualityTier`, `QualitySample`, and `QualityPolicy.observe(sample): QualityDecision` provide symmetric downgrade/recovery and per-frame draw-call telemetry.

- [ ] Test downgrade after sustained p95 budget misses, recovery after a cool-down, and no action for isolated spikes.
- [ ] Verify the policy tests fail before implementation.
- [ ] Implement four project-specific tiers (CINEMA/BALANCED/EFFICIENT/STILL) that control DPR, dust count, and node LOD only; do not alter data truth.
- [ ] Normalize WebGPU cumulative renderer counters to per-frame values and expose p50/p95/max frame timing in `data-*` diagnostics.
- [ ] Add deterministic screenshot seeds and assert normalized diagnostics in E2E.

### Task 5: Node state color and reference disclosure

**Files:**
- Modify: `src/scene/universe.ts`
- Modify: `README.md`
- Test: `tests/e2e/universe.spec.ts`

**Interfaces:** Connected and discovered instances must render their semantic colors on both backends; README contains a concise acknowledgement of the MIT reference and states that no code was copied.

- [ ] Add a browser assertion that the instance color buffer receives the connected/discovered colors.
- [ ] Reproduce the current WebGPU color failure before changing the material path.
- [ ] Use a backend-compatible color node/material path or a tiny non-instanced fallback only when the backend cannot consume `instanceColor`.
- [ ] Add the acknowledgement and the independent Peerstellation design rationale to README.
- [ ] Run the complete quality, build, E2E, accessibility, Lighthouse, docs, and audit gates.

