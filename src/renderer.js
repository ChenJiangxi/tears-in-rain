/* =========================================================
   Renderer — single-pass WebGL2 orchestrator for Tears in Rain.

   There is no persistent fog state. The composite shader reads the text
   mask directly, so writing carves fog instantly (no lag, no ghost
   trails) and re-centering glyphs doesn't leave behind fading patches.

   Two JS-side scalars drive the "feel":

     ambientFog  0 → 1 ramp on `beginFog()` (intro fade-in)
     maskAlpha   1 → 0 ramp on `beginDissolve()` (slow fade of the text)

   The composite shader computes:
     fogLevel = ambientFog / (1 + K · mask · maskAlpha)

   During typing, maskAlpha = 1 and the stroke carves fog to ~10%. When
   the user stops, maskAlpha eases to 0 and fog smoothly covers the text.
   That's the only "slow disappearance" in the system.
   ========================================================= */
import vertSrc      from './shaders/quad.vert.glsl?raw';
import compositeSrc from './shaders/composite.frag.glsl?raw';

const INTRO_FOG_MS     = 2500;
const DEFAULT_FADE_MS  = 3500;

export class Renderer {
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

    this.start     = performance.now();

    // User-facing parameters
    this.rain        = 0.60;
    this.fog         = 0.30;
    this.fogBright   = 0.30;
    this.refract     = 0.55;
    this.dropSize    = 1.21;
    this.dropDensity = 0.14;
    this.speed       = 1.0;

    // Renderer-internal
    this.bgMode    = 0;
    this.imageSize = [1920, 1080];
    this.hasMipmap = 0.0;
    this.videoEl   = null;

    // Animated scalars
    this.ambientFog    = 0.0;    // intro fade-in; 1 once fog is established
    this.maskAlpha     = 1.0;    // 1 during typing; eases to 0 on dissolve
    this._fogStart     = -1;     // ms since origin; <0 means ramp not started
    this._dissolveStart= -1;
    this._dissolveDur  = DEFAULT_FADE_MS;

    this._initQuad();
    this._initTextures();
    this._initComposite();

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  /* ---------- GL setup ---------- */
  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('Shader compile failed:\n' + gl.getShaderInfoLog(sh) + '\n---\n' + src);
    }
    return sh;
  }

  _link(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link failed:\n' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  _initComposite() {
    const gl = this.gl;
    this.compositeProg = this._link(vertSrc, compositeSrc);
    const names = [
      'iResolution','iTime','iChannel0','iImageSize',
      'uRain','uFog','uRefract','uDropSize','uDropDensity','uSpeed',
      'uBgMode','uHasMipmap','uTextMask','uMaskAlpha','uAmbientFog','uFogBright',
    ];
    this.u = {};
    for (const n of names) this.u[n] = gl.getUniformLocation(this.compositeProg, n);
  }

  _initQuad() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _initTextures() {
    const gl = this.gl;
    // Background (unit 0)
    this.bgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([8, 8, 16, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Text mask (unit 1) — sampled directly by the composite shader
    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth  * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width  !== w) this.canvas.width  = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /* ---------- Public API ---------- */
  setRain(v)        { this.rain = v; }
  setFog(v)         { this.fog = v; }
  setFogBright(v)   { this.fogBright = v; }
  setRefract(v)     { this.refract = v; }
  setDropSize(v)    { this.dropSize = v; }
  setDropDensity(v) { this.dropDensity = v; }
  setSpeed(v)       { this.speed = v; }

  // Begin the intro fog ramp (0 → 1 over INTRO_FOG_MS).
  beginFog() { this._fogStart = performance.now(); }

  // Begin the dissolve ramp (maskAlpha 1 → 0 over durationMs, ease-out).
  beginDissolve(durationMs = DEFAULT_FADE_MS) {
    this._dissolveStart = performance.now();
    this._dissolveDur   = Math.max(100, durationMs);
  }

  // Snap the glass back to a fully-fogged, fully-visible-text state.
  // Called between takes so the previous take leaves nothing behind.
  resetGlass() {
    this._dissolveStart = -1;
    this.maskAlpha  = 1.0;
    this.ambientFog = 1.0;
    this._fogStart  = -1;
  }

  updateTextMask(canvasSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasSource);
  }

  setImage(img) {
    const gl = this.gl;
    this._disposeVideo();
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
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
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  resetBackground() {
    this._disposeVideo();
    this.bgMode = 0;
    this.hasMipmap = 0.0;
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

  /* ---------- Render ---------- */
  _updateVideoTex() {
    if (this.bgMode !== 2 || !this.videoEl) return;
    const gl = this.gl;
    const v = this.videoEl;
    if (v.readyState >= 2 && v.videoWidth > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
        this.imageSize = [v.videoWidth, v.videoHeight];
      } catch (_) { /* CORS / transient */ }
    }
  }

  _advanceRamps(now) {
    if (this._fogStart >= 0) {
      const k = Math.min(1, Math.max(0, (now - this._fogStart) / INTRO_FOG_MS));
      // ease-out quad: quick start, gentle settle
      this.ambientFog = 1 - (1 - k) * (1 - k);
      if (k >= 1) this._fogStart = -1;
    }
    if (this._dissolveStart >= 0) {
      const k = Math.min(1, Math.max(0, (now - this._dissolveStart) / this._dissolveDur));
      // pow(0.55) — drops fast in the first half, eases to zero near the end
      this.maskAlpha = 1 - Math.pow(k, 0.55);
      if (k >= 1) { this.maskAlpha = 0; this._dissolveStart = -1; }
    }
  }

  render() {
    if (!this.ok) return;

    const now = performance.now();
    this._advanceRamps(now);
    this._updateVideoTex();

    const gl = this.gl;
    gl.useProgram(this.compositeProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);

    const u = this.u;
    gl.uniform1i(u.iChannel0, 0);
    gl.uniform1i(u.uTextMask, 1);
    gl.uniform2f(u.iResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.iTime, (now - this.start) * 0.001);
    gl.uniform2f(u.iImageSize, this.imageSize[0], this.imageSize[1]);
    gl.uniform1f(u.uRain,        this.rain);
    gl.uniform1f(u.uFog,         this.fog);
    gl.uniform1f(u.uRefract,     this.refract);
    gl.uniform1f(u.uDropSize,    this.dropSize);
    gl.uniform1f(u.uDropDensity, this.dropDensity);
    gl.uniform1f(u.uSpeed,       this.speed);
    gl.uniform1i(u.uBgMode,      this.bgMode);
    gl.uniform1f(u.uHasMipmap,   this.hasMipmap);
    gl.uniform1f(u.uMaskAlpha,   this.maskAlpha);
    gl.uniform1f(u.uAmbientFog,  this.ambientFog);
    gl.uniform1f(u.uFogBright,   this.fogBright);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
