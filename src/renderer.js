/* =========================================================
   Renderer — multi-pass WebGL2 orchestrator for Tears in Rain.

   Runs three programs each frame:
     1. fogUpdate        : evolves the persistent fog field
     2. wetnessUpdate    : evolves the persistent wetness / bead-trail field
     3. composite        : draws background + Heartfelt rain + fog + beads

   State is held in two ping-pong FBO pairs (fog, wetness). The wipe input
   is a Canvas 2D mask uploaded per frame; the app toggles uWipeActive to
   stop feeding it during dissolve, at which point fog naturally refills
   and the trail slowly dries out.
   ========================================================= */
import vertSrc           from './shaders/quad.vert.glsl?raw';
import fogUpdateSrc      from './shaders/fogUpdate.frag.glsl?raw';
import wetnessUpdateSrc  from './shaders/wetnessUpdate.frag.glsl?raw';
import compositeSrc      from './shaders/composite.frag.glsl?raw';

// Physics constants (per second). Tunable if dissolve feels too fast/slow.
const FOG_REGROWTH    = 0.40;   // fog refills in ~2.5s after wipe stops
const FOG_WIPE_FORCE  = 4.0;    // under the stroke, fog clears in ~0.25s
const WET_ACCUM       = 2.0;    // wetness saturates under the stroke in ~0.5s
const WET_DECAY       = 0.14;   // full decay in ~7s

const STATE_MIN_W = 512;
const STATE_MAX_W = 1024;
const STATE_MIN_H = 288;
const STATE_MAX_H = 576;

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

    // Needed for R16F/RGBA16F render targets. Without it, fine regrowth
    // deltas (< 1/255) would quantize to zero and fog would never refill.
    const ext = gl.getExtension('EXT_color_buffer_float')
             || gl.getExtension('EXT_color_buffer_half_float');
    if (!ext) {
      console.warn('Float color buffers unavailable. Fog dynamics may banding-stall.');
    }
    gl.getExtension('OES_texture_float_linear');

    this.start     = performance.now();
    this.prevTime  = this.start;

    // User-facing parameters
    this.rain        = 0.60;
    this.fog         = 0.30;
    this.fogBright   = 0.30;
    this.refract     = 0.55;
    this.dropSize    = 1.21;
    this.dropDensity = 0.14;
    this.speed       = 1.0;

    // Renderer-internal
    this.bgMode     = 0;
    this.imageSize  = [1920, 1080];
    this.hasMipmap  = 0.0;
    this.videoEl    = null;
    this.wipeActive = 0.0;

    this._initQuad();
    this._initTextures();
    this._initPrograms();

    this.stateW = 0; this.stateH = 0;
    this.fogFBO = null;
    this.wetFBO = null;

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

  _collectUniforms(prog, names) {
    const gl = this.gl;
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return u;
  }

  _initPrograms() {
    // Fog update
    this.fogUpdateProg = this._link(vertSrc, fogUpdateSrc);
    this.uFog = this._collectUniforms(this.fogUpdateProg,
      ['uPrevFog','uWipeInput','uDt','uRegrowth','uWipeStrength','uWipeActive']);

    // Wetness update
    this.wetUpdateProg = this._link(vertSrc, wetnessUpdateSrc);
    this.uWet = this._collectUniforms(this.wetUpdateProg,
      ['uPrevWet','uWipeInput','uDt','uAccumRate','uDecayRate','uWipeActive']);

    // Composite
    this.compositeProg = this._link(vertSrc, compositeSrc);
    this.uC = this._collectUniforms(this.compositeProg, [
      'iResolution','iTime','iChannel0','iImageSize',
      'uRain','uFog','uRefract','uDropSize','uDropDensity','uSpeed',
      'uBgMode','uHasMipmap','uFogState','uWetness','uFogBright',
    ]);
  }

  _initQuad() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Fullscreen triangle
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

    // Mask / wipe input (unit 1)
    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
  }

  _makeStateTex(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _makeStatePair(w, h, clear) {
    const gl = this.gl;
    const a = this._makeStateTex(w, h);
    const b = this._makeStateTex(w, h);
    const fbA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const fbB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // `read` = source for next pass, `write` = destination
    return { read: a, write: b, readFB: fbA, writeFB: fbB };
  }

  _swap(pair) {
    const t = pair.read; pair.read = pair.write; pair.write = t;
    const f = pair.readFB; pair.readFB = pair.writeFB; pair.writeFB = f;
  }

  _disposeStatePair(pair) {
    if (!pair) return;
    const gl = this.gl;
    gl.deleteTexture(pair.read);
    gl.deleteTexture(pair.write);
    gl.deleteFramebuffer(pair.readFB);
    gl.deleteFramebuffer(pair.writeFB);
  }

  _resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth  * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width  !== w) this.canvas.width  = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    // State textures at roughly half resolution, clamped to sensible bounds
    const sw = Math.max(STATE_MIN_W, Math.min(STATE_MAX_W, Math.floor(w / 2)));
    const sh = Math.max(STATE_MIN_H, Math.min(STATE_MAX_H, Math.floor(h / 2)));
    if (sw !== this.stateW || sh !== this.stateH) {
      this._disposeStatePair(this.fogFBO);
      this._disposeStatePair(this.wetFBO);
      // fog starts fully condensed; wetness starts dry
      this.fogFBO = this._makeStatePair(sw, sh, [1.0, 0.0, 0.0, 1.0]);
      this.wetFBO = this._makeStatePair(sw, sh, [0.0, 0.0, 0.0, 1.0]);
      this.stateW = sw; this.stateH = sh;
    }
  }

  /* ---------- Public API ---------- */
  setRain(v)        { this.rain = v; }
  setFog(v)         { this.fog = v; }
  setFogBright(v)   { this.fogBright = v; }
  setRefract(v)     { this.refract = v; }
  setDropSize(v)    { this.dropSize = v; }
  setDropDensity(v) { this.dropDensity = v; }
  setSpeed(v)       { this.speed = v; }
  setWipeActive(v)  { this.wipeActive = v; }

  updateTextMask(canvasSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    // FLIP_Y=true so canvas top maps to state-texture top (WebGL uv origin at bottom-left).
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

  /* ---------- Render passes ---------- */
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

  _runStatePass(prog, locs, fbo, setUniforms) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.writeFB);
    gl.viewport(0, 0, this.stateW, this.stateH);

    // Previous state → unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbo.read);
    // Mask → unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);

    setUniforms(gl, locs);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _renderFogUpdate(dt) {
    this._runStatePass(this.fogUpdateProg, this.uFog, this.fogFBO, (gl, u) => {
      gl.uniform1i(u.uPrevFog,   0);
      gl.uniform1i(u.uWipeInput, 1);
      gl.uniform1f(u.uDt, dt);
      gl.uniform1f(u.uRegrowth,     FOG_REGROWTH);
      gl.uniform1f(u.uWipeStrength, FOG_WIPE_FORCE);
      gl.uniform1f(u.uWipeActive,   this.wipeActive);
    });
  }

  _renderWetUpdate(dt) {
    this._runStatePass(this.wetUpdateProg, this.uWet, this.wetFBO, (gl, u) => {
      gl.uniform1i(u.uPrevWet,   0);
      gl.uniform1i(u.uWipeInput, 1);
      gl.uniform1f(u.uDt, dt);
      gl.uniform1f(u.uAccumRate,  WET_ACCUM);
      gl.uniform1f(u.uDecayRate,  WET_DECAY);
      gl.uniform1f(u.uWipeActive, this.wipeActive);
    });
  }

  _renderComposite(iTime) {
    const gl = this.gl;
    gl.useProgram(this.compositeProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // iChannel0 (background) → unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    // uFogState → unit 2 (after swap, the freshly-written tex is fbo.read)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fogFBO.read);
    // uWetness → unit 3
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.wetFBO.read);

    const u = this.uC;
    gl.uniform1i(u.iChannel0, 0);
    gl.uniform1i(u.uFogState, 2);
    gl.uniform1i(u.uWetness,  3);
    gl.uniform2f(u.iResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.iTime, iTime);
    gl.uniform2f(u.iImageSize, this.imageSize[0], this.imageSize[1]);
    gl.uniform1f(u.uRain,        this.rain);
    gl.uniform1f(u.uFog,         this.fog);
    gl.uniform1f(u.uRefract,     this.refract);
    gl.uniform1f(u.uDropSize,    this.dropSize);
    gl.uniform1f(u.uDropDensity, this.dropDensity);
    gl.uniform1f(u.uSpeed,       this.speed);
    gl.uniform1i(u.uBgMode,      this.bgMode);
    gl.uniform1f(u.uHasMipmap,   this.hasMipmap);
    gl.uniform1f(u.uFogBright,   this.fogBright);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render() {
    if (!this.ok) return;

    const now = performance.now();
    const dt  = Math.min(0.05, (now - this.prevTime) * 0.001);
    this.prevTime = now;
    const iTime = (now - this.start) * 0.001;

    this._updateVideoTex();

    // 1. fog state
    this._renderFogUpdate(dt);
    this._swap(this.fogFBO);

    // 2. wetness state
    this._renderWetUpdate(dt);
    this._swap(this.wetFBO);

    // 3. composite to the default framebuffer
    this._renderComposite(iTime);
  }
}
