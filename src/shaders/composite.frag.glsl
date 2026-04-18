#version 300 es
precision highp float;

/* =========================================================
   Composite pass — screen-resolution final image.

   Layers (inside → outside):
     1. Background (image / video / procedural)
     2. Rain drops on the outside of the glass — refraction + focus
        (Heartfelt by BigWings / Martijn Steinrucken, ltffzl, CC BY-NC-SA 3.0)
     3. Condensation fog, proportional to ambientFog × (1 − wipe).
        The wipe signal is the text mask multiplied by maskAlpha; there is
        no persistent state field. During typing, maskAlpha = 1 and the
        stroke carves the fog instantly. When the user stops (Esc / idle),
        maskAlpha eases to 0 over a few seconds — fog rolls smoothly back
        over the text. This is the only source of "slow disappearance".
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
uniform sampler2D uTextMask;     // white where the user has drawn
uniform float uMaskAlpha;        // 1 during typing; eases 1→0 during dissolve
uniform float uAmbientFog;       // 0→1 intro ramp; 1 afterwards
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

/* ---------- Tiny condensation speckle at the stroke edge ----------
   No glass beads. Just a sparse micro-droplet mist that only lives in a
   thin ring where the wipe transitions, so strokes read as "fingertip
   through fog" rather than "water painted onto glass". */
float edgeSpeckle(vec2 uv) {
  uv *= 140.;
  vec2 id = floor(uv);
  vec2 f = fract(uv) - 0.5;
  vec3 n = N13(id.x * 74.31 + id.y * 1379.12);
  vec2 p = (n.xy - 0.5) * 0.6;
  float d = length(f - p);
  float radius = 0.04 + n.z * 0.07;
  return step(0.72, n.z) * S(radius, radius * 0.15, d);
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

  // ---- wipe signal: text mask (gated by maskAlpha for dissolve) ----
  float mask = texture(uTextMask, UV).r;
  float wipe = mask * uMaskAlpha;

  // fog level: smoothly reduced where wipe is strong. K controls how fully a
  // stroke clears the fog (K=9 → stroke interior fog ≈ 10%).
  const float K = 9.0;
  float fogLevel = uAmbientFog / (1.0 + K * wipe);

  // Stroke edge band (for faint condensation speckle) computed directly from
  // the mask gradient. No persistent wetness field needed.
  vec2  mtx = 1.0 / iResolution;
  float mL = texture(uTextMask, UV - vec2(mtx.x * 2.0, 0.0)).r;
  float mR = texture(uTextMask, UV + vec2(mtx.x * 2.0, 0.0)).r;
  float mU = texture(uTextMask, UV + vec2(0.0, mtx.y * 2.0)).r;
  float mD = texture(uTextMask, UV - vec2(0.0, mtx.y * 2.0)).r;
  float edgeMag = length(vec2(mR - mL, mU - mD)) * uMaskAlpha;
  float edgeBand = S(0.05, 0.35, edgeMag);

  // ---- focus: fog blurs, stroke interiors clear through it ----
  float maxBlur = mix(3., 6., rainAmount) * clamp(uFog * 2.0, 0.0, 2.0);
  float fogBlur = maxBlur * fogLevel;
  float focus   = mix(fogBlur - c.y, 0.0, S(.1, .2, c.x));
  // stroke interior: drop focus further so background is crisp
  focus         = mix(focus, 0.0, S(0.2, 0.7, wipe));

  // ---- background refraction: rain only. ----
  vec2 offs = rainN * uRefract;
  vec3 col  = sampleBg(UV + offs, focus);

  // ---- condensation fog tint ----
  float radial = 1.0 - smoothstep(0.0, 0.82, length(UV - 0.5) * 1.55);
  float fogTex = 0.86 + vnoise(UV * vec2(iResolution.x/iResolution.y, 1.0) * 4.5 + iTime * 0.025) * 0.28;
  float fogUnderDrop = 1.0 - c.x * 0.55;

  float cond = clamp(uFog * 1.6 * fogLevel * radial * fogTex * fogUnderDrop, 0.0, 1.0);
  vec3 fogTint = mix(vec3(0.48, 0.52, 0.60), vec3(0.92, 0.94, 0.98), uFogBright);
  col = mix(col, fogTint, cond);

  // ---- faint condensation speckle only along the stroke edge ----
  float speck = edgeSpeckle(uv) * edgeBand;
  col = mix(col, fogTint, speck * 0.30);

  // vignette
  col *= 1.0 - dot(UV - 0.5, UV - 0.5) * 0.9;

  outColor = vec4(col, 1.0);
}
