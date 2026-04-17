/* =========================================================
   FogLayer — text mask for finger-on-foggy-glass effect.

   Renders white text on a transparent offscreen 2D canvas.
   This mask is consumed by ShaderRain as a second texture:
   where the mask is white, the shader clears the fog blur
   to reveal the sharp background — like a finger wiping
   condensation from cold glass.

   The visible fog-canvas is hidden; all rendering happens
   in the rain shader.
   ========================================================= */
(function (global) {
  class FogLayer {
    constructor(canvas) {
      this.canvas = canvas;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);

      // hide the visible canvas — shader.js handles all rendering
      this.canvas.style.display = 'none';

      // offscreen 2D canvas for the text mask
      this.off  = document.createElement('canvas');
      this.octx = this.off.getContext('2d');

      // text state
      this.active = false;
      this.lines  = [[]];

      this.fontSize    = 192;
      this.lineHeight  = 190;
      this.font        = `400 ${this.fontSize}px 'Caveat', 'Ma Shan Zheng', cursive`;
      this.maxLineWidth = 780;

      this.cursorBlink = 0;

      this.dissolving    = false;
      this.dissolveT     = 0;
      this.dissolveDur   = 3.5;
      this.onDissolveDone = null;

      this.prevTime = 0;

      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const pw = Math.max(1, Math.floor(w * this.dpr));
      const ph = Math.max(1, Math.floor(h * this.dpr));

      this.off.width  = pw;
      this.off.height = ph;
      this.octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      this.w = w; this.h = h;
      this.pw = pw; this.ph = ph;
      this.maxLineWidth = Math.min(w * 0.92, w - 40);
    }

    /* ---------- text state ---------- */
    enterTyping() { this.active = true; }

    reset() {
      this.lines      = [[]];
      this.dissolving  = false;
      this.dissolveT   = 0;
      this.octx.clearRect(0, 0, this.off.width, this.off.height);
    }

    hasContent() { return this.lines.some(l => l.length > 0); }

    _measure(text) {
      this.octx.font = this.font;
      return this.octx.measureText(text).width;
    }
    _currentLine() { return this.lines[this.lines.length - 1]; }
    _lineText(line) { return line.map(g => g.ch).join(''); }
    _lineWidth(line) { return this._measure(this._lineText(line)); }

    _newLine() {
      if (this.lines.length >= 6) this.lines.shift();
      this.lines.push([]);
    }

    addCharacter(ch) {
      if (!this.active || this.dissolving) return;
      if (ch === '\n') { this._newLine(); return; }
      const display = ch === ' ' ? '\u00A0' : ch;
      const line = this._currentLine();
      const prospective = this._lineText(line) + display;
      if (this._measure(prospective) > this.maxLineWidth && line.length > 0) {
        this._newLine();
      }
      this._currentLine().push({ ch: display, seed: Math.random() });
    }

    backspace() {
      if (this.dissolving) return;
      for (let i = this.lines.length - 1; i >= 0; i--) {
        if (this.lines[i].length > 0) {
          this.lines[i].pop();
          if (this.lines[i].length === 0 && i > 0) this.lines.splice(i, 1);
          return;
        }
      }
    }

    /* ---------- dissolve ---------- */
    startDissolve(onDone) {
      if (this.dissolving || !this.hasContent()) return false;
      // freeze the mask (rasterize without caret)
      this._rasterize(false);
      this.dissolving     = true;
      this.dissolveT      = 0;
      this.active         = false;
      this.onDissolveDone = onDone || null;
      return true;
    }

    getDissolveProgress() {
      if (!this.dissolving) return 0;
      return Math.min(this.dissolveT / this.dissolveDur, 1.0);
    }

    update(now) {
      if (!this.prevTime) this.prevTime = now;
      const dt = Math.min(0.06, (now - this.prevTime) / 1000);
      this.prevTime = now;

      this.cursorBlink += dt;

      if (this.dissolving) {
        this.dissolveT += dt;
        if (this.dissolveT >= this.dissolveDur) {
          this.dissolving = false;
          this.reset();
          if (this.onDissolveDone) {
            const cb = this.onDissolveDone;
            this.onDissolveDone = null;
            cb();
          }
        }
      }
    }

    /* ---------- mask rasterization ---------- */
    _rasterize(withCaret) {
      const ctx = this.octx;
      ctx.clearRect(0, 0, this.w, this.h);

      const hasText = this.hasContent();
      if (!hasText && !withCaret) return;

      ctx.font = this.font;
      ctx.textBaseline = 'alphabetic';
      ctx.globalCompositeOperation = 'source-over';

      const nLines = this.lines.length;
      const blockHeight = nLines * this.lineHeight;
      const startY = (this.h - blockHeight) / 2 + this.fontSize * 0.78;

      let caretPos = null;

      // White text with per-character wobble — looks finger-drawn
      ctx.fillStyle   = '#ffffff';

      for (let li = 0; li < this.lines.length; li++) {
        const line = this.lines[li];
        const lineWidth = this._lineWidth(line);
        const lineY = startY + li * this.lineHeight;
        let x = (this.w - lineWidth) / 2;

        for (const g of line) {
          const glyphW = this._measure(g.ch);
          const s = g.seed !== undefined ? g.seed : 0.5;

          const rot   = (s - 0.5) * 0.08;       // ±4° rotation
          const offY  = (s * 2 - 1) * 2.5;       // ±2.5px baseline wobble
          const scale = 0.95 + s * 0.10;          // 0.95–1.05 size variation

          ctx.save();
          ctx.translate(x + glyphW / 2, lineY + offY);
          ctx.rotate(rot);
          ctx.scale(scale, scale);
          ctx.shadowColor = 'rgba(255, 255, 255, 0.55)';
          ctx.shadowBlur  = 10;
          ctx.fillText(g.ch, -glyphW / 2, 0);
          ctx.restore();

          x += glyphW;
        }
        if (li === this.lines.length - 1) caretPos = { x, y: lineY };
      }

      ctx.shadowBlur = 0;

      // caret
      if (withCaret && caretPos) {
        const blink = 0.5 + 0.5 * Math.cos(this.cursorBlink * 3.4);
        ctx.globalAlpha = 0.6 + 0.4 * blink;
        ctx.fillStyle = '#ffffff';
        const caretX = caretPos.x + 1.5;
        const top    = caretPos.y - this.fontSize * 0.82;
        const bot    = caretPos.y + 2;
        ctx.fillRect(caretX, top, 2, bot - top);
        ctx.globalAlpha = 1;
      }
    }

    /* ---------- frame ---------- */
    render() {
      // Re-rasterize during typing; during dissolve the mask is frozen
      if (!this.dissolving && (this.active || this.hasContent())) {
        this._rasterize(this.active);
      }
    }
  }

  global.FogLayer = FogLayer;
})(window);
