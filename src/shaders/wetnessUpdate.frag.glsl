#version 300 es
precision highp float;

/* =========================================================
   Wetness state update.

   Wetness represents water pushed aside by the wipe — the bead
   trail that remains along the stroke even after the fog has
   recondensed. It accumulates fast under an active wipe and
   decays slowly everywhere, so the trail outlives the letters.
   ========================================================= */

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPrevWet;
uniform sampler2D uWipeInput;
uniform float uDt;
uniform float uAccumRate;        // per-second build-up where wipe is active
uniform float uDecayRate;        // per-second decay, always
uniform float uWipeActive;

void main() {
  float wet = texture(uPrevWet, vUv).r;
  float wipe = texture(uWipeInput, vUv).r * uWipeActive;

  wet += wipe * uAccumRate * uDt;
  wet -= uDecayRate * uDt;

  outColor = vec4(clamp(wet, 0.0, 1.0), 0.0, 0.0, 1.0);
}
