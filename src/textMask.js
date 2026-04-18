/* =========================================================
   TextMask — renders the typed text as a white mask on an
   offscreen Canvas 2D, for the renderer to consume as the
   "wipe input" signal.

   Pure stamping: no dissolve logic, no progress curves. The
   renderer owns all persistent state. When the app stops
   feeding this mask (wipeActive = 0), the fog naturally
   refills over the strokes.
   ========================================================= */

export class TextMask {
  constructor() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.off  = document.createElement('canvas');
    this.octx = this.off.getContext('2d');

    this.active = false;
    const firstLine = [];
    firstLine.easedX = null;
    this.lines = [firstLine];
    this.easedBlockY = null;

    this.fontSize     = 62;
    this.lineHeight   = 106;
    // Shadows Into Light Two reads like a marker drawn through fog — the
    // closest glyph shape to a fingertip on a foggy pane. Ma Shan Zheng
    // is the Chinese handwriting fallback (brush style).
    this.font         = `400 ${this.fontSize}px 'Shadows Into Light Two', 'Homemade Apple', 'Ma Shan Zheng', 'Caveat', cursive`;
    this.maxLineWidth = 780;

    this.cursorBlink = 0;
    this.prevTime    = 0;

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
    // Leave room to the right of the left-anchor for the caret and breathing space.
    const anchorX = Math.max(40, w * 0.14);
    this.maxLineWidth = Math.max(300, w - anchorX - 40);
  }

  /* ---------- text state ---------- */
  enterTyping() { this.active = true; }
  stopTyping()  { this.active = false; }

  reset() {
    const line = [];
    line.easedX = null;
    this.lines = [line];
    this.easedBlockY = null;
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
    if (this.lines.length >= 5) this.lines.shift();
    // Each line carries its own eased start-X so existing glyphs slide
    // smoothly toward a new centered position when characters are added.
    const line = [];
    line.easedX = null;
    this.lines.push(line);
  }

  addCharacter(ch) {
    if (!this.active) return;
    if (ch === '\n') { this._newLine(); return; }
    const display = ch === ' ' ? '\u00A0' : ch;
    const line = this._currentLine();
    if (this._measure(this._lineText(line) + display) > this.maxLineWidth && line.length > 0) {
      this._newLine();
    }
    this._currentLine().push({ ch: display, seed: Math.random() });
  }

  backspace() {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].length > 0) {
        this.lines[i].pop();
        if (this.lines[i].length === 0 && i > 0) this.lines.splice(i, 1);
        return;
      }
    }
  }

  /* ---------- per-frame rasterization ---------- */
  update(now) {
    if (!this.prevTime) this.prevTime = now;
    const dt = Math.min(0.06, (now - this.prevTime) / 1000);
    this.prevTime = now;
    this.cursorBlink += dt;

    // Critically-damped-ish ease: reaches ~63% of remaining gap every 1/rate
    // seconds. rate=22 → noticeable settle over ~120ms. Fast enough to feel
    // responsive, slow enough that characters visibly "breathe" into place.
    const rate = 22;
    const lambda = 1 - Math.exp(-rate * dt);

    // Vertical block position, centered around the user's block of lines.
    const nLines = this.lines.length;
    const blockHeight = nLines * this.lineHeight;
    const targetY = (this.h - blockHeight) / 2 + this.fontSize * 0.78;
    if (this.easedBlockY === null) this.easedBlockY = targetY;
    else this.easedBlockY += (targetY - this.easedBlockY) * lambda;

    // Per-line left edge so characters slide into their centered position.
    for (const line of this.lines) {
      const targetX = (this.w - this._lineWidth(line)) / 2;
      if (line.easedX === null) line.easedX = targetX;
      else line.easedX += (targetX - line.easedX) * lambda;
    }
  }

  render() {
    // Always raster: produces the wipe mask that the renderer samples this
    // frame. When `active` is false and lines are empty, it just clears.
    this._rasterize(this.active);
  }

  _rasterize(withCaret) {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.hasContent() && !withCaret) return;

    ctx.font = this.font;
    ctx.textBaseline = 'alphabetic';
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';

    // Use eased positions so new characters slide into place instead of
    // snapping. easedBlockY / easedX are updated each frame in update().
    const fallbackY = (this.h - this.lines.length * this.lineHeight) / 2 + this.fontSize * 0.78;
    const startY = this.easedBlockY !== null ? this.easedBlockY : fallbackY;

    let caretPos = null;

    for (let li = 0; li < this.lines.length; li++) {
      const line = this.lines[li];
      const lineY = startY + li * this.lineHeight;
      const fallbackX = (this.w - this._lineWidth(line)) / 2;
      let x = line.easedX !== null && line.easedX !== undefined ? line.easedX : fallbackX;

      for (const g of line) {
        const glyphW = this._measure(g.ch);
        const s = g.seed;
        const rot   = (s - 0.5) * 0.14;
        const offY  = (s * 2 - 1) * 4.5;
        const offX  = ((s * 7) % 1 - 0.5) * 2.2;
        const scale = 0.88 + s * 0.20;

        ctx.save();
        ctx.translate(x + glyphW / 2 + offX, lineY + offY);
        ctx.rotate(rot);
        ctx.scale(scale, scale);
        ctx.shadowColor = 'rgba(255, 255, 255, 0.35)';
        ctx.shadowBlur  = 1;
        ctx.fillText(g.ch, -glyphW / 2, 0);
        ctx.restore();
        x += glyphW;
      }
      if (li === this.lines.length - 1) caretPos = { x, y: lineY };
    }

    ctx.shadowBlur = 0;

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
}
