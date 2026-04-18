#version 300 es
precision highp float;

/* =========================================================
   Fog state update.

   Each frame, fog recondenses toward a full pane (target = 1)
   at a constant regrowth rate, while the wipe input pushes it
   back toward 0. When typing stops, wipeActive drops to 0 and
   the pane refogs naturally.
   ========================================================= */

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPrevFog;
uniform sampler2D uWipeInput;    // text mask (white where the finger passes)
uniform float uDt;
uniform float uRegrowth;         // per-second pull toward 1
uniform float uWipeStrength;     // per-second push toward 0 under the stroke
uniform float uWipeActive;       // 1 while typing, 0 during dissolve

void main() {
  float fog = texture(uPrevFog, vUv).r;
  float wipe = texture(uWipeInput, vUv).r * uWipeActive;

  fog += (1.0 - fog) * uRegrowth * uDt;
  fog -= wipe * uWipeStrength * uDt;

  outColor = vec4(clamp(fog, 0.0, 1.0), 0.0, 0.0, 1.0);
}
