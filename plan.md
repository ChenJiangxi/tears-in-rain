# Tears in Rain — Rewrite Plan (v2 architecture)

> Goal: make writing on a foggy rainy window feel physically correct. Currently
> everything is crammed into the Heartfelt fragment shader, so every new effect
> fights the others. This rewrite separates concerns into physical layers and
> persistent state fields.

## 1. Physics Model

Reading outward from the viewer's eye, through the window:

```
[ scene behind the glass ]
          │
          ▼
[ outside: running rain drops (refraction) ]   ← Heartfelt code stays
          │
          ▼
[ the glass itself (constant micro-blur) ]
          │
          ▼
[ inside: condensation fog layer ]             ← persistent state, evolves
          │
          ▼
[ inside: wetness / bead trails ]              ← persistent state, slow decay
          │
          ▼
[ the viewer's finger — input signal ]
```

### Key insight

**Fog = water vapor.** When you swipe your finger through fog, you don't clean
the glass — you **push the vapor aside into beads** along the stroke. Those
beads remain after the fog recondenses. So the visible trail has two lifetimes:

1. **Short** (~2 s): stroke sits above fog, clear window through it.
2. **Long** (~6 s): fog refills over the stroke, but the **bead trail still
   shows** — visible only as wetness/highlights on the glass.
3. **End**: beads shrink and dry out; pane is uniform fog again.

This matches the aesthetic: "The words fade, then the traces of them fade,
then nothing."

### Input → state mapping

The text mask canvas (rasterized by textMask.js) is the **wipe input signal**.
It is fed every frame while the user is typing. When dissolve is triggered,
**we stop feeding it** — no animated `uTextDissolve` needed. Fog naturally
refills; wetness naturally decays. The "animation" is purely physical.

## 2. Persistent State Fields

Two 2D float textures, ping-pong (two buffers each, swap per frame).

| Field     | Channel | Target fill | Grow rate           | Decay/sink     |
|-----------|---------|-------------|---------------------|----------------|
| `fogState`   | R (0..1) | 1.0 everywhere | `+regrowth·dt` toward 1 | `-wipe·strength·dt` (only where wipeInput > 0) |
| `wetness`    | R (0..1) | 0 everywhere   | `+wipe·accum·dt` (where wipeInput > 0) | `-decay·dt` (always) |

Tunable constants (initial guesses):

```
fog regrowth rate     ≈ 0.40 /s     (fully refills in ~2.5s)
fog wipe strength     ≈ 4.0  /s     (wiped in ~0.25s under 100% mask)
wetness accum rate    ≈ 2.0  /s     (saturates under the stroke in ~0.5s)
wetness decay rate    ≈ 0.14 /s     (fully dry in ~7s)
```

Resolution: **512 × 288** float textures (R16F). Low-res is fine — fog is
low-frequency, letters are pre-blurred by Canvas 2D anyway. FBOs are cheap.

## 3. Render Passes (per frame)

```
1. fogUpdatePass      → fogStateB = f(fogStateA, wipeInput, dt)       (512×288)
2. wetnessUpdatePass  → wetnessB  = f(wetnessA,  wipeInput, dt)       (512×288)
3. compositePass      → screen pixels                                 (full screen)
     samples: background, fogStateB, wetnessB, textMask (raw)
     runs Heartfelt rain here (outside-the-glass effect)
     applies condensation blur based on fogState
     adds bead highlights/shadows/refraction based on wetness
4. (swap A↔B for fog and wetness)
```

## 4. Composite Pass — Visual Build-up

```
vec3 bgSample(UV + rainRefract + beadRefract, focus)
focus = mix(maxBlur·fogLevel, 0, sharpensFromBeadsOrDrops)

composition =
  background
  + rain drop refraction           (Heartfelt — unchanged)
  + condensation tint · fogLevel   (cool blue-white, controlled by uFogBright)
  + bead specular highlights       (wetness driven, with stochastic jitter)
  − bead shadows                   (at wetness edges)
  × rain-drop "wipe-through-fog"   (drops reveal bg even through fog)
```

Water beads form along the wetness field using:
- Voronoi-seeded positions in the wet region → circular highlights
- Finite-difference normal of the wetness texture for **lensing refraction**
- Darker ring at bead periphery (wet → shadow)

## 5. Dissolve — now a pure phase transition

App state machine simplification:

```
typing     : wipeActive = 1.0   → feed mask every frame
dissolving : wipeActive = 0.0   → stop feeding mask; fog refills, beads decay
                                  hold ~5s, then show echo
echoing    : (unchanged)
```

No `uTextDissolve` uniform. No `startDissolve` animation curve. The shader
does the "disappearing" for free, because it's physical.

`textMask.js` becomes **pure stamping**: input characters, render a white mask
on the offscreen canvas. No dissolve, no progress curve, no `onDissolveDone`
callback. The renderer owns all persistent state.

## 6. Tech Stack

**Vite + vanilla JS + raw WebGL 2.** No Three.js — we don't need a scene graph,
and a hand-written 3-pass renderer is clearer than wiring Three post-processing
stacks for this scale.

Why Vite:
- `import glsl from './shader.frag.glsl?raw'` for shader strings
- HMR when tuning shaders
- `vite build` produces static files for GitHub Pages or any static host
  (deploy stays equivalent to the current static version)

## 7. File Layout

```
/
  package.json
  vite.config.js
  index.html              (Vite entry, loads /src/main.js as <script type="module">)
  style.css               (unchanged)
  picture/                (unchanged)
  src/
    main.js               (was app.js — state machine, IME input, UI wiring)
    renderer.js           (new — top-level; owns FBOs, 3 programs, ping-pong)
    textMask.js           (was fog.js — pure canvas 2D mask rasterization)
    audio.js              (unchanged behavior, moved under /src)
    i18n.js               (unchanged)
    quotes.js             (unchanged)
    shaders/
      quad.vert.glsl
      fogUpdate.frag.glsl
      wetnessUpdate.frag.glsl
      composite.frag.glsl (Heartfelt lives in this file)
  README.md
  plan.md                 (this)
```

## 8. Migration Steps

1. Initialize Vite project (`package.json`, `vite.config.js`, `.gitignore` node_modules).
2. Move static sources under `/src/`.
3. Write `quad.vert.glsl` (fullscreen triangle).
4. Write `fogUpdate.frag.glsl` and `wetnessUpdate.frag.glsl`.
5. Lift Heartfelt GLSL into `composite.frag.glsl`, replacing the monolithic
   text-dissolve logic with `fogState` / `wetness` texture samples.
6. Write `renderer.js` with:
   - GL init, VAO, single triangle
   - two ping-pong FBO pairs (fog, wetness) at 512×288
   - compile 3 programs
   - `render(dt, wipeActiveCanvas, wipeActive)` runs the 3 passes in order
   - same public API as `ShaderRain` (setRain/setFog/…/setImage/setVideo)
     so `main.js` changes are minimal
7. Refactor `fog.js` → `textMask.js`:
   - keep: resize, addCharacter, backspace, hasContent, render (rasterize)
   - drop: dissolving, dissolveT, startDissolve, getDissolveProgress,
     onDissolveDone, update()
8. Refactor `app.js` → `main.js`:
   - replace `fog.startDissolve(callback)` with
     `{ wipeActive = 0; setTimeout(revealEcho, 5000); }`
   - replace `shader.setTextDissolve(fog.getDissolveProgress())` calls with
     renderer's `wipeActive` flag
   - loop: `renderer.render(dt, textMask.off, state.wipeActive)`
9. Update `index.html`:
   - remove multiple `<script>` tags
   - add `<script type="module" src="/src/main.js"></script>`
10. `npm run dev`, open browser, verify.
11. Tune constants on real content.
12. `vite build` smoke test (dist/ should be pure static).
13. Commit, push.

## 9. Risks

- **FBO resolution vs letter fidelity**: letters at 512×288 may look pixelated
  when fog refills. Mitigation: sample with bicubic filtering, or bump to
  768×432 if needed.
- **Mobile GPU**: R16F textures need `EXT_color_buffer_half_float`. Fallback
  to RGBA8 (quantized 0..255) loses precision but still works.
- **Large `composite.frag.glsl`**: Heartfelt is ~80 lines; new fog/wetness
  sampling adds ~60; total ~180 GLSL lines. Still manageable.
- **Vite in Chinese fonts via fonts.loli.net**: unchanged from current setup.

## 10. Out of Scope (for this rewrite)

- Bead gravity (drops running down). Current beads stay put. Adding gravity
  would require advecting the wetness field per-frame — doable but larger.
- Sound design changes. Audio stays identical.
- New quotes. Current library is fine.

---

Once this is merged and stable, gravity-advected beads would be the natural
next step: add a third `beadVelocity` field, and each frame offset the
wetness texture slightly downward (scaled by local gravity function).
