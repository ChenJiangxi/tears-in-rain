/* =========================================================
   ShaderRain — WebGL2 rain-on-glass
   Core shader after "Heartfelt" by BigWIngs / Martijn Steinrucken
   (Shadertoy ltffzl, CC BY-NC-SA 3.0), preserving the dual
   static+sliding drop system and the refraction-through-drops
   focus trick. Extended with three background sources:
     0 = procedural red/blue fluid
     1 = user image
     2 = user video
   No time-based background zoom anywhere.
   ========================================================= */
(function (global) {
  const VERT = `#version 300 es
    in vec2 a_pos;
    void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FRAG = `#version 300 es
    precision highp float;
    out vec4 outColor;

    uniform vec2  iResolution;
    uniform float iTime;
    uniform sampler2D iChannel0;
    uniform vec2  iImageSize;
    uniform float uRain;
    uniform float uFog;
    uniform float uRefract;
    uniform float uDropSize;
    uniform float uDropDensity;
    uniform float uSpeed;
    uniform int   uBgMode;
    uniform float uHasMipmap;
    uniform sampler2D iChannel1;
    uniform float uTextDissolve;
    uniform float uHasText;

    #define S(a, b, t) smoothstep(a, b, t)

    /* ---------- Heartfelt by BigWings (Shadertoy ltffzl) ---------- */
    vec3 N13(float p) {
      vec3 p3 = fract(vec3(p) * vec3(.1031,.11369,.13787));
      p3 += dot(p3, p3.yzx + 19.19);
      return fract(vec3((p3.x + p3.y)*p3.z,
                        (p3.x + p3.z)*p3.y,
                        (p3.y + p3.z)*p3.x));
    }
    float N(float t) { return fract(sin(t*12345.564)*7658.76); }

    float Saw(float b, float t) {
      return S(0., b, t) * S(1., b, t);
    }

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

    /* ---------- Heartfelt drops with trails ---------- */
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

      // density: skip some cells
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

      // density: skip some cells
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

    /* ---------- default background: red/blue fluid ---------- */
    vec3 proceduralBg(vec2 uv) {
      float t = iTime * 0.045;

      vec2 p = (uv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0) * 1.6;
      p += 0.35 * vec2(
        sin(p.y * 1.6 + t * 1.2),
        cos(p.x * 1.3 + t * 1.05 + 1.7)
      );

      float nMix  = fbm(p * 1.1 + vec2(0.0, t * 0.8));
      float nTone = fbm(p * 2.2 - vec2(t * 0.7, t * 0.4) + 9.3);

      vec3 deepBlue   = vec3(0.04, 0.10, 0.42);
      vec3 brightBlue = vec3(0.12, 0.22, 0.78);
      vec3 deepRed    = vec3(0.48, 0.04, 0.10);
      vec3 brightRed  = vec3(0.88, 0.16, 0.22);
      vec3 voidColor  = vec3(0.015, 0.018, 0.05);

      vec3 blue = mix(deepBlue, brightBlue, smoothstep(0.25, 0.75, nTone));
      vec3 red  = mix(deepRed,  brightRed,  smoothstep(0.30, 0.72, nTone));

      vec3 col = mix(blue, red, smoothstep(0.35, 0.70, nMix));
      col = mix(voidColor, col, smoothstep(0.1, 0.55, nTone * 0.8 + nMix * 0.3));

      float r = length(uv - 0.5) * 1.35;
      col *= mix(1.02, 0.28, smoothstep(0.15, 1.0, r));
      col += vec3(0.06, 0.01, 0.03) * smoothstep(0.55, 0.85, nMix) * 0.2;

      return col;
    }

    /* ---------- image/video cover UV ---------- */
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
        vec3 fogTint = vec3(0.10, 0.09, 0.15);
        return mix(col, fogTint, k * 0.55);
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

    void main(){
      vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;
      vec2 UV = gl_FragCoord.xy / iResolution.xy;

      float T = iTime;
      float t = T * 0.2 * uSpeed;

      float rainAmount = clamp(uRain, 0.0, 1.0);

      // Heartfelt fog: maxBlur = foggy glass, minBlur = clear inside drops
      float maxBlur = mix(3., 6., rainAmount) * clamp(uFog * 2.0, 0.0, 2.0);
      float minBlur = 2.0 * clamp(uFog, 0.0, 1.0);

      float staticDrops = S(-.5, 1., rainAmount) * 2.;
      float layer1 = S(.25, .75, rainAmount);
      float layer2 = S(.0, .5, rainAmount);

      vec2 c = Drops(uv, t, staticDrops, layer1, layer2);

      vec2 e = vec2(.001, 0.);
      float cx = Drops(uv + e, t, staticDrops, layer1, layer2).x;
      float cy = Drops(uv + e.yx, t, staticDrops, layer1, layer2).x;
      vec2 n = vec2(cx - c.x, cy - c.x);

      // Heartfelt focus: trails (c.y) cut through the fog on the glass
      float focus = mix(maxBlur - c.y, minBlur, S(.1, .2, c.x));

      // --- finger-on-glass text effect ---
      vec2 textUV = vec2(UV.x, 1.0 - UV.y);
      float textMask = texture(iChannel1, textUV).r;
      textMask *= 1.0 - smoothstep(0.0, 0.85, uTextDissolve);
      // Text clears the fog — finger wipe reveals sharp background
      float textFocus = mix(max(focus, 3.5), 0.0, smoothstep(0.02, 0.25, textMask));
      focus = mix(focus, textFocus, step(0.01, textMask));

      vec3 col = sampleBg(UV + n * uRefract, focus);

      // --- condensation fog: only when writing, strong center, fades to edges ---
      float textClear  = smoothstep(0.02, 0.3, textMask);
      float radial     = 1.0 - smoothstep(0.0, 0.75, length(UV - 0.5) * 1.6);
      float hasTextFade = uHasText * (1.0 - smoothstep(0.8, 1.0, uTextDissolve));
      float condensation = uFog * 2.2 * hasTextFade * radial * (1.0 - textClear);
      vec3 fogTint = vec3(0.62, 0.64, 0.68);
      col = mix(col, fogTint, condensation);

      // --- water bead at wipe edge (subtle darkening) ---
      float edge = smoothstep(0.05, 0.20, textMask) * (1.0 - smoothstep(0.20, 0.45, textMask));
      col *= 1.0 - edge * 0.15;

      // vignette
      col *= 1.0 - dot(UV - 0.5, UV - 0.5);

      outColor = vec4(col, 1.0);
    }
  `;

  class ShaderRain {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
      if (!gl) {
        console.error('WebGL2 is required.');
        this.ok = false;
        return;
      }
      this.gl = gl;
      this.ok = true;

      this.start = performance.now();
      this.rain = 0.6;
      this.fog = 0.3;
      this.refract = 0.55;
      this.dropSize = 1.21;
      this.dropDensity = 0.14;
      this.speed = 1.0;
      this.bgMode = 0;
      this.imageSize = [1920, 1080];
      this.hasMipmap = 0.0;
      this.textDissolve = 0.0;
      this.hasText = 0.0;
      this.videoEl = null;

      this._initGL();
      this._resize();
      window.addEventListener('resize', () => this._resize());
    }

    _compile(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('Shader compile failed:\n' + gl.getShaderInfoLog(sh));
      }
      return sh;
    }

    _initGL() {
      const gl = this.gl;
      const vs = this._compile(gl.VERTEX_SHADER, VERT);
      const fs = this._compile(gl.FRAGMENT_SHADER, FRAG);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('Program link failed:\n' + gl.getProgramInfoLog(prog));
      }
      this.prog = prog;

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.vao = vao;

      this.u = {
        iResolution: gl.getUniformLocation(prog, 'iResolution'),
        iTime:       gl.getUniformLocation(prog, 'iTime'),
        iChannel0:   gl.getUniformLocation(prog, 'iChannel0'),
        iImageSize:  gl.getUniformLocation(prog, 'iImageSize'),
        uRain:       gl.getUniformLocation(prog, 'uRain'),
        uFog:        gl.getUniformLocation(prog, 'uFog'),
        uRefract:    gl.getUniformLocation(prog, 'uRefract'),
        uDropSize:   gl.getUniformLocation(prog, 'uDropSize'),
        uDropDensity: gl.getUniformLocation(prog, 'uDropDensity'),
        uSpeed:      gl.getUniformLocation(prog, 'uSpeed'),
        uBgMode:     gl.getUniformLocation(prog, 'uBgMode'),
        uHasMipmap:  gl.getUniformLocation(prog, 'uHasMipmap'),
        iChannel1:   gl.getUniformLocation(prog, 'iChannel1'),
        uTextDissolve: gl.getUniformLocation(prog, 'uTextDissolve'),
        uHasText:    gl.getUniformLocation(prog, 'uHasText'),
      };

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([8, 8, 16, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      // text mask texture (iChannel1)
      this.texMask = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]));

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(this.canvas.clientWidth  * dpr));
      const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }

    setRain(v)    { this.rain = v; }
    setFog(v)     { this.fog = v; }
    setRefract(v) { this.refract = v; }
    setDropSize(v) { this.dropSize = v; }
    setDropDensity(v) { this.dropDensity = v; }
    setSpeed(v) { this.speed = v; }
    setTextDissolve(v) { this.textDissolve = v; }
    setHasText(v)      { this.hasText = v; }

    updateTextMask(canvas) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.activeTexture(gl.TEXTURE0);
    }

    setImage(img) {
      const gl = this.gl;
      this._disposeVideo();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.imageSize = [img.naturalWidth || img.width, img.naturalHeight || img.height];
      this.hasMipmap = 1.0;
      this.bgMode = 1;
    }

    setVideo(videoEl) {
      this._disposeVideo();
      this.videoEl = videoEl;
      this.imageSize = [videoEl.videoWidth || 1920, videoEl.videoHeight || 1080];
      this.hasMipmap = 0.0;
      this.bgMode = 2;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    _disposeVideo() {
      if (this.videoEl) {
        try {
          this.videoEl.pause();
          this.videoEl.removeAttribute('src');
          this.videoEl.load();
        } catch (_) {}
        this.videoEl = null;
      }
    }

    resetBackground() {
      this._disposeVideo();
      this.bgMode = 0;
      this.hasMipmap = 0.0;
    }

    render() {
      if (!this.ok) return;
      this._resize();
      const gl = this.gl;

      if (this.bgMode === 2 && this.videoEl) {
        const v = this.videoEl;
        if (v.readyState >= 2 && v.videoWidth > 0) {
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
            this.imageSize = [v.videoWidth, v.videoHeight];
          } catch (_) { /* CORS or transient */ }
        }
      }

      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.u.iChannel0, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      gl.uniform1i(this.u.iChannel1, 1);
      gl.uniform2f(this.u.iResolution, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.u.iTime, (performance.now() - this.start) * 0.001);
      gl.uniform2f(this.u.iImageSize, this.imageSize[0], this.imageSize[1]);
      gl.uniform1f(this.u.uRain, this.rain);
      gl.uniform1f(this.u.uFog, this.fog);
      gl.uniform1f(this.u.uRefract, this.refract);
      gl.uniform1f(this.u.uDropSize, this.dropSize);
      gl.uniform1f(this.u.uDropDensity, this.dropDensity);
      gl.uniform1f(this.u.uSpeed, this.speed);
      gl.uniform1i(this.u.uBgMode, this.bgMode);
      gl.uniform1f(this.u.uHasMipmap, this.hasMipmap);
      gl.uniform1f(this.u.uTextDissolve, this.textDissolve);
      gl.uniform1f(this.u.uHasText, this.hasText);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  global.ShaderRain = ShaderRain;
})(window);
