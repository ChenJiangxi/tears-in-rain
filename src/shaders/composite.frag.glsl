#version 300 es
precision highp float;

/* =========================================================
   Composite pass — screen-resolution final image.

   Layers (inside → outside):
     1. Background (image / video / procedural)
     2. Rain drops on the outside of the glass — refraction + focus
        (Heartfelt by BigWings / Martijn Steinrucken, ltffzl, CC BY-NC-SA 3.0)
     3. Condensation fog on the inside, sampled per-pixel from uFogState
     4. Wetness field from uWetness — drives bead lensing, highlights,
        shadows and "sharp trail through fog" effect.

   Persistent state (uFogState, uWetness) is updated by separate passes
   before this one runs.
   ========================================================= */

out vec4 outColor;

uniform vec2  iResolution;
uniform float iTime;
uniform sampler2D iChannel0;     // background image / video
uniform vec2  iImageSize;
uniform float uRain;
uniform float uFog;              // user-facing glass blur multiplier
uniform float uRefract;
uniform float uDropSize;
uniform float uDropDensity;
uniform float uSpeed;
uniform int   uBgMode;           // 0 procedural, 1 image, 2 video
uniform float uHasMipmap;
uniform sampler2D uFogState;     // R: per-pixel condensation 0..1
uniform sampler2D uWetness;      // R: per-pixel wetness / bead trail 0..1
uniform float uFogBright;        // user-facing fog whiteness

#define S(a, b, t) smoothstep(a, b, t)

/* ---------- Heartfelt hashing ---------- */
vec3 N13(float p) {
  vec3 p3 = fract(vec3(p) * vec3(.1031,.11369,.13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract(vec3((p3.x + p3.y)*p3.z,
                    (p3.x + p3.z)*p3.y,
                    (p3.y + p3.z)*p3.x));
}
float N(float t) { return fract(sin(t*12345.564)*7658.76); }
float Saw(float b, float t) { return S(0., b, t) * S(1., b, t); }

float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f*f*(3.0 - 2.0*f);
  return mix(a, b, u.x) + (c - a)*u.y*(1.0 - u.x) + (d - b)*u.x*u.y;
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){
    v += a * vnoise(p);
    p = p * 2.03 + vec2(1.3, 2.1);
    a *= 0.5;
  }
  return v;
}

/* ---------- Heartfelt drops ---------- */
vec2 DropLayer2(vec2 uv, float t) {
  vec2 UV = uv;
  uv.y += t * 0.75;
  vec2 a = vec2(6., 1.);
  vec2 grid = a * 2.;
  vec2 id = floor(uv * grid);

  float colShift = N(id.x);
  uv.y += colShift;

  id = floor(uv * grid);
  vec3 n = N13(id.x * 35.2 + id.y * 2376.1);
  vec2 st = fract(uv * grid) - vec2(.5, 0);

  float alive = step(1.0 - uDropDensity, fract(n.z * 10.));
  float x = n.x - .5;
  float y = UV.y * 20.;
  float wiggle = sin(y + sin(y));
  x += wiggle * (.5 - abs(x)) * (n.z - .5);
  x *= .7;
  float ti = fract(t + n.z);
  y = (Saw(.85, ti) - .5) * .9 + .5;
  vec2 p = vec2(x, y);

  float d = length((st - p) * a.yx);
  float mainDrop = S(.4 * uDropSize, .0, d);

  float r = sqrt(S(1., y, st.y));
  float cd = abs(st.x - x);
  float trail = S(.23 * r, .15 * r * r, cd);
  float trailFront = S(-.02, .02, st.y - y);
  trail *= trailFront * r * r;

  y = UV.y;
  float trail2 = S(.2 * r, .0, cd);
  float droplets = max(0., (sin(y * (1. - y) * 120.) - st.y)) * trail2 * trailFront * n.z;
  y = fract(y * 10.) + (st.y - .5);
  float dd = length(st - vec2(x, y));
  droplets = S(.3, 0., dd);
  float m = mainDrop + droplets * r * trailFront;

  return vec2(m, trail) * alive;
}

float StaticDrops(vec2 uv, float t) {
  uv *= 40.;
  vec2 id = floor(uv);
  uv = fract(uv) - .5;
  vec3 n = N13(id.x * 107.45 + id.y * 3543.654);
  vec2 p = (n.xy - .5) * .7;
  float d = length(uv - p);

  float alive = step(1.0 - uDropDensity, fract(n.z * 10.));
  float fade = Saw(.025, fract(t + n.z));
  float c = S(.3 * uDropSize, 0., d) * fract(n.z * 10.) * fade;
  return c * alive;
}

vec2 Drops(vec2 uv, float t, float l0, float l1, float l2) {
  float s = StaticDrops(uv, t) * l0;
  vec2 m1 = DropLayer2(uv, t) * l1;
  vec2 m2 = DropLayer2(uv * 1.85, t) * l2;
  float c = s + m1.x + m2.x;
  c = S(.3, 1., c);
  return vec2(c, max(m1.y * l0, m2.y * l1));
}

/* ---------- Small "bead" field: high-frequency dot lattice ----------
   Used only inside wet regions to give the trail a droplet texture
   rather than a smooth glow. Each cell is a single circular bead. */
float beadLattice(vec2 uv, out vec2 beadNormal) {
  uv *= 55.;
  vec2 id = floor(uv);
  vec2 f = fract(uv) - 0.5;
  vec3 n = N13(id.x * 74.31 + id.y * 1379.12);
  vec2 p = (n.xy - 0.5) * 0.55;
  vec2 diff = f - p;
  float d = length(diff);
  float radius = 0.14 + n.z * 0.22;
  float bead = S(radius, radius * 0.2, d);
  beadNormal = (d > 1e-4) ? -(diff / d) * bead : vec2(0.0);
  return bead;
}

/* ---------- Procedural background ---------- */
vec3 proceduralBg(vec2 uv) {
  float t = iTime * 0.045;
  vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0) * 1.6;
  p += 0.35 * vec2(sin(p.y * 1.6 + t * 1.2), cos(p.x * 1.3 + t * 1.05 + 1.7));

  float nMix  = fbm(p * 1.1 + vec2(0.0, t * 0.8));
  float nTone = fbm(p * 2.2 - vec2(t * 0.7, t * 0.4) + 9.3);

  vec3 deepBlue   = vec3(0.04, 0.10, 0.42);
  vec3 brightBlue = vec3(0.12, 0.22, 0.78);
  vec3 deepRed    = vec3(0.48, 0.04, 0.10);
  vec3 brightRed  = vec3(0.88, 0.16, 0.22);
  vec3 voidColor  = vec3(0.015, 0.018, 0.05);

  vec3 blue = mix(deepBlue, brightBlue, smoothstep(0.25, 0.75, nTone));
  vec3 red  = mix(deepRed,  brightRed,  smoothstep(0.30, 0.72, nTone));
  vec3 col  = mix(blue, red, smoothstep(0.35, 0.70, nMix));
  col = mix(voidColor, col, smoothstep(0.1, 0.55, nTone * 0.8 + nMix * 0.3));

  float r = length(uv - 0.5) * 1.35;
  col *= mix(1.02, 0.28, smoothstep(0.15, 1.0, r));
  col += vec3(0.06, 0.01, 0.03) * smoothstep(0.55, 0.85, nMix) * 0.2;
  return col;
}

vec2 coverUV(vec2 uv) {
  float viewA = iResolution.x / max(iResolution.y, 1.0);
  float imgA  = max(iImageSize.x, 1.0) / max(iImageSize.y, 1.0);
  vec2 scale = vec2(1.0);
  if (viewA > imgA) scale = vec2(1.0, imgA / viewA);
  else              scale = vec2(viewA / imgA, 1.0);
  return (uv - 0.5) * scale + 0.5;
}

vec3 sampleBg(vec2 uv, float blur) {
  if (uBgMode == 0) {
    vec3 col = proceduralBg(uv);
    float k = clamp(blur / 6.0, 0.0, 1.0);
    vec3 tint = vec3(0.10, 0.09, 0.15);
    return mix(col, tint, k * 0.55);
  }
  vec2 bg = clamp(coverUV(uv), 0.0, 1.0);
  if (uHasMipmap > 0.5) {
    return textureLod(iChannel0, bg, blur).rgb;
  }
  vec2 px = vec2(1.0) / iResolution;
  float r = blur * 1.5;
  vec3 acc = texture(iChannel0, bg).rgb;
  acc += texture(iChannel0, bg + vec2( r,  0.0) * px).rgb;
  acc += texture(iChannel0, bg + vec2(-r,  0.0) * px).rgb;
  acc += texture(iChannel0, bg + vec2( 0.0,  r) * px).rgb;
  acc += texture(iChannel0, bg + vec2( 0.0, -r) * px).rgb;
  return acc / 5.0;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;
  vec2 UV = gl_FragCoord.xy / iResolution.xy;

  float T = iTime;
  float t = T * 0.2 * uSpeed;
  float rainAmount = clamp(uRain, 0.0, 1.0);

  // Heartfelt rain + refraction
  float staticDropsAmt = S(-.5, 1., rainAmount) * 2.;
  float layer1 = S(.25, .75, rainAmount);
  float layer2 = S(.0, .5, rainAmount);

  vec2 c = Drops(uv, t, staticDropsAmt, layer1, layer2);
  vec2 eps = vec2(.001, 0.);
  float cx = Drops(uv + eps,    t, staticDropsAmt, layer1, layer2).x;
  float cy = Drops(uv + eps.yx, t, staticDropsAmt, layer1, layer2).x;
  vec2 rainN = vec2(cx - c.x, cy - c.x);

  // ---- sample persistent state ----
  float fogLevel = texture(uFogState, UV).r;
  float wetLevel = texture(uWetness,  UV).r;

  // wetness gradient — gentle large-scale lensing along the trail
  vec2  wtx = 1.0 / vec2(textureSize(uWetness, 0));
  float wrL = texture(uWetness, UV + vec2(wtx.x * 2.0, 0.0)).r;
  float wrR = texture(uWetness, UV - vec2(wtx.x * 2.0, 0.0)).r;
  float wrU = texture(uWetness, UV + vec2(0.0, wtx.y * 2.0)).r;
  float wrD = texture(uWetness, UV - vec2(0.0, wtx.y * 2.0)).r;
  vec2  wetN = vec2(wrL - wrR, wrU - wrD) * 4.0;

  // ---- bead lattice inside wet region ----
  vec2 beadN;
  float beadField = beadLattice(uv, beadN);
  float beadGate  = S(0.18, 0.65, wetLevel);   // only where wet enough
  float beads     = beadField * beadGate;

  // ---- focus: fog blurs, rain trails and beads sharpen through it ----
  float maxBlur = mix(3., 6., rainAmount) * clamp(uFog * 2.0, 0.0, 2.0);
  float fogBlur = maxBlur * fogLevel;
  float focus   = mix(fogBlur - c.y, 0.5, S(.1, .2, c.x));
  // wet trails clear the glass: drop focus as wetness rises
  focus         = mix(focus, 0.0, S(0.1, 0.55, wetLevel));

  // ---- background refraction sample ----
  vec2 offs = (rainN + (wetN + beadN * beadGate * 0.8) * 0.35) * uRefract;
  vec3 col  = sampleBg(UV + offs, focus);

  // ---- bead specular highlight: ambient sky on the curved water ----
  col += vec3(0.32, 0.36, 0.44) * S(0.35, 0.95, beads) * 0.55;

  // ---- condensation fog tint ----
  float radial = 1.0 - smoothstep(0.0, 0.82, length(UV - 0.5) * 1.55);
  // breathing wisps — slow drift, kept subtle
  float fogTex = 0.86 + vnoise(UV * vec2(iResolution.x/iResolution.y, 1.0) * 4.5 + iTime * 0.025) * 0.28;
  // rain drops locally displace condensation — drops stay readable through fog
  float fogUnderDrop = 1.0 - c.x * 0.55;

  float cond = clamp(uFog * 1.6 * fogLevel * radial * fogTex * fogUnderDrop, 0.0, 1.0);
  vec3 fogTint = mix(vec3(0.48, 0.52, 0.60), vec3(0.92, 0.94, 0.98), uFogBright);
  col = mix(col, fogTint, cond);

  // ---- bead shadow: darker ring at the bead edge + wetness perimeter ----
  float wetRim = S(0.02, 0.18, wetLevel) * (1.0 - S(0.35, 0.75, wetLevel));
  col *= 1.0 - wetRim * 0.13;
  col *= 1.0 - S(0.15, 0.35, beads) * 0.08;

  // vignette
  col *= 1.0 - dot(UV - 0.5, UV - 0.5) * 0.9;

  outColor = vec4(col, 1.0);
}
