/* =========================================================
   app.js — orchestrator
   State machine: waiting -> booting -> typing <-> dissolving
                                             -> echoing -> typing
   Plus: control panel, language toggle, background upload.
   ========================================================= */
(function () {
  const $ = id => document.getElementById(id);

  const stored = localStorage.getItem('tir.lang');
  const preferZh = (navigator.language || 'en').toLowerCase().startsWith('zh');

  const state = {
    phase: 'waiting',
    idleDelay: 4800,
    idleTimer: null,
    take: 1,
    lastQuote: -1,
    lang: stored || (preferZh ? 'zh' : 'en'),
    rain: 0.60,
    fog:  0.27,
    refract: 0.55,
    dropSize: 1.21,
    dropDensity: 0.14,
    speed: 1.0,
    audioOn: true,
    vol: 0.40,
    panelOpen: false,
  };

  /* ---------- refs ---------- */
  const shaderCanvas = $('shader-canvas');
  const fogCanvas    = $('fog-canvas');
  const overlay      = $('overlay');
  const startBtn     = $('startBtn');
  const echoEl       = $('echo');
  const echoQ        = $('echoQuote');
  const echoS        = $('echoSource');
  const typingHint   = $('typingHint');
  const clockEl      = $('clock');
  const takeEl       = $('takeN');
  const fab          = $('fab');
  const panel        = $('panel');
  const sRain        = $('sRain');
  const sFog         = $('sFog');
  const sRefract     = $('sRefract');
  const sDropSize    = $('sDropSize');
  const sDropDensity = $('sDropDensity');
  const sSpeed       = $('sSpeed');
  const sVol         = $('sVol');
  const vRain        = $('vRain');
  const vFog         = $('vFog');
  const vRefract     = $('vRefract');
  const vDropSize    = $('vDropSize');
  const vDropDensity = $('vDropDensity');
  const vSpeed       = $('vSpeed');
  const vVol         = $('vVol');
  const uploadBtn    = $('uploadBtn');
  const resetBtn     = $('resetBtn');
  const fileInput    = $('fileInput');
  const audioToggle  = $('audioToggle');
  const dropHint     = $('dropHint');

  const shader = new window.ShaderRain(shaderCanvas);
  const fog    = new window.FogLayer(fogCanvas);
  const audio  = new window.RainAudio();

  shader.setRain(state.rain);
  shader.setFog(state.fog);
  shader.setRefract(state.refract);
  shader.setDropSize(state.dropSize);
  shader.setDropDensity(state.dropDensity);
  shader.setSpeed(state.speed);

  sRain.value = Math.round(state.rain * 100);
  sFog.value  = Math.round(state.fog  * 100);
  sRefract.value = Math.round(state.refract * 100);
  sDropSize.value = Math.round(state.dropSize * 100);
  sDropDensity.value = Math.round(state.dropDensity * 100);
  sSpeed.value = Math.round(state.speed * 100);
  sVol.value  = Math.round(state.vol  * 100);
  vRain.textContent    = sRain.value;
  vFog.textContent     = sFog.value;
  vRefract.textContent = sRefract.value;
  vDropSize.textContent = sDropSize.value;
  vDropDensity.textContent = sDropDensity.value;
  vSpeed.textContent   = sSpeed.value;
  vVol.textContent     = sVol.value;

  /* ---------- helpers ---------- */
  const pad   = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function t(key) {
    const d = window.I18N[state.lang] || window.I18N.en;
    return d[key] !== undefined ? d[key] : (window.I18N.en[key] || '');
  }

  function updateClock() {
    const d = new Date();
    clockEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function randomQuote() {
    const n = window.QUOTES.length;
    let idx;
    do { idx = Math.floor(Math.random() * n); } while (idx === state.lastQuote && n > 1);
    state.lastQuote = idx;
    return window.QUOTES[idx];
  }

  function showTypingHint() {
    typingHint.classList.add('visible');
    setTimeout(() => typingHint.classList.remove('visible'), 4800);
  }

  /* ---------- echo reveal ---------- */
  let echoToken = 0;
  async function revealEcho(quote) {
    const token = ++echoToken;
    echoQ.innerHTML = '';
    echoS.textContent = '';
    echoS.classList.remove('visible');
    echoQ.className = 'echo-quote' + (quote.block ? ' block' : '');
    echoEl.classList.add('visible');

    audio.echoChime();

    const caret = document.createElement('span');
    caret.className = 'type-caret visible';
    echoQ.appendChild(caret);

    const text = quote[state.lang] || quote.en;
    const pausePunct = ',.;—、，。；：…';

    for (const ch of text) {
      if (token !== echoToken) return;
      const span = document.createElement('span');
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      echoQ.insertBefore(span, caret);
      let d = 34 + Math.random() * 32;
      if (pausePunct.includes(ch)) d += 170;
      if (ch === ' ') d *= 0.6;
      await sleep(d);
    }

    await sleep(520);
    caret.remove();

    echoS.textContent = quote.src;
    echoS.classList.add('visible');

    const hold = quote.block ? 16000 : 11000;
    await sleep(hold);
    if (token !== echoToken) return;

    echoEl.classList.remove('visible');
    await sleep(1400);
    if (token !== echoToken) return;

    fog.reset();
    fog.enterTyping();
    state.phase = 'typing';
    audio.setVolume(state.audioOn ? state.vol : 0);
    state.take += 1;
    if (takeEl) takeEl.textContent = pad(state.take, 3);
  }

  function skipEcho() {
    echoToken++;
    echoEl.classList.remove('visible');
    echoQ.innerHTML = '';
    echoS.textContent = '';
    echoS.classList.remove('visible');
    fog.reset();
    fog.enterTyping();
    state.phase = 'typing';
    audio.setVolume(state.audioOn ? state.vol : 0);
  }

  /* ---------- dissolve ---------- */
  function triggerDissolve() {
    if (state.phase !== 'typing') return;
    if (!fog.hasContent()) return;
    clearTimeout(state.idleTimer);
    state.phase = 'dissolving';
    audio.dissolveSwell();
    const started = fog.startDissolve(() => {
      state.phase = 'echoing';
      revealEcho(randomQuote());
    });
    if (!started) state.phase = 'typing';
  }

  function resetIdle() {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(triggerDissolve, state.idleDelay);
  }

  /* ---------- input ---------- */
  function isPanelTarget(el) {
    if (!el) return false;
    if (el.closest && el.closest('.panel')) return true;
    if (el.closest && el.closest('.fab')) return true;
    return false;
  }

  function handleKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isPanelTarget(e.target)) return;

    if (state.phase === 'echoing') {
      e.preventDefault();
      skipEcho();
      resetIdle();
      return;
    }

    if (state.phase === 'waiting') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        begin();
      }
      return;
    }

    if (state.phase === 'dissolving' || state.phase === 'booting') return;
    if (state.panelOpen) return;

    if (e.key === 'Escape') { e.preventDefault(); triggerDissolve(); return; }

    if (e.key === 'Backspace') {
      e.preventDefault();
      fog.backspace();
      audio.keyTick();
      resetIdle();
      imeInput.value = '';
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      fog.addCharacter('\n');
      audio.keyTick();
      resetIdle();
      imeInput.value = '';
      return;
    }

    if (e.key.length === 1) {
      fog.addCharacter(e.key);
      audio.keyTick();
      resetIdle();
      imeInput.value = '';
    }
  }

  // IME composition input (pinyin etc.)
  const imeInput = document.createElement('input');
  imeInput.type = 'text';
  imeInput.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  imeInput.setAttribute('autocomplete', 'off');
  imeInput.setAttribute('autocorrect', 'off');
  imeInput.setAttribute('autocapitalize', 'off');
  imeInput.setAttribute('spellcheck', 'false');
  document.body.appendChild(imeInput);
  imeInput.addEventListener('compositionend', (e) => {
    if (state.phase !== 'typing' || state.panelOpen) { imeInput.value = ''; return; }
    const text = e.data || '';
    for (const ch of text) { fog.addCharacter(ch); audio.keyTick(); }
    imeInput.value = '';
    resetIdle();
  });
  const focusIME = () => { try { imeInput.focus({ preventScroll: true }); } catch { imeInput.focus(); } };

  /* ---------- begin ---------- */
  async function begin() {
    if (state.phase !== 'waiting') return;
    state.phase = 'booting';
    overlay.classList.add('hidden');
    fab.hidden = false;
    await sleep(300);
    if (state.audioOn) {
      await audio.start();
      audio.setVolume(state.vol);
    }
    await sleep(700);
    fog.enterTyping();
    state.phase = 'typing';
    focusIME();
    showTypingHint();
  }

  /* ---------- panel ---------- */
  function setPanel(open) {
    state.panelOpen = open;
    panel.setAttribute('data-open', open ? 'true' : 'false');
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && state.phase === 'typing') focusIME();
  }

  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    ensureAudio();
    setPanel(!state.panelOpen);
  });
  document.addEventListener('click', (e) => {
    if (!state.panelOpen) return;
    if (isPanelTarget(e.target)) return;
    setPanel(false);
  });

  function bindSlider(el, valEl, setter, key) {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value) / 100;
      state[key] = v;
      setter(v);
      valEl.textContent = el.value;
    });
  }
  bindSlider(sRain,    vRain,    v => shader.setRain(v),    'rain');
  bindSlider(sFog,     vFog,     v => shader.setFog(v),     'fog');
  bindSlider(sSpeed,   vSpeed,   v => shader.setSpeed(v),   'speed');
  bindSlider(sDropSize, vDropSize, v => shader.setDropSize(v), 'dropSize');
  bindSlider(sDropDensity, vDropDensity, v => shader.setDropDensity(v), 'dropDensity');
  bindSlider(sRefract, vRefract, v => shader.setRefract(v), 'refract');
  bindSlider(sVol,     vVol,     v => { if (state.audioOn) audio.setVolume(v); }, 'vol');

  audioToggle.addEventListener('change', () => {
    state.audioOn = audioToggle.checked;
    if (state.audioOn) {
      audio.start().then(() => audio.setVolume(state.vol));
    } else {
      audio.setVolume(0);
    }
  });

  /* ---------- upload / drag-drop ---------- */
  const DEFAULT_BG = 'picture/R-C.jpeg';
  function loadDefaultBackground() {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => shader.setImage(img);
    img.onerror = () => shader.resetBackground();
    img.src = DEFAULT_BG;
  }

  uploadBtn.addEventListener('click', () => fileInput.click());
  resetBtn.addEventListener('click',  () => {
    loadDefaultBackground();
    flashHint(t('dropHintDefault'));
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });

  function handleFile(file) {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { shader.setImage(img); URL.revokeObjectURL(url); flashHint(t('dropHintLoaded')); };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    } else if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.autoplay = true;
      v.crossOrigin = 'anonymous';
      v.addEventListener('loadeddata', () => {
        v.play().catch(() => {});
        shader.setVideo(v);
        flashHint(t('dropHintLoaded'));
      }, { once: true });
      v.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    }
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('drag-over');
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('drag-over');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drag-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  /* ---------- i18n ---------- */
  function applyLang(lang) {
    state.lang = lang;
    localStorage.setItem('tir.lang', lang);
    document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en');
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const value = t(key);
      if (value) el.innerHTML = value;
    });
    document.querySelectorAll('.lang-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === lang);
    });
  }
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); applyLang(b.dataset.lang); });
  });
  applyLang(state.lang);

  /* ---------- drop hint ---------- */
  let hintTimer = null;
  function flashHint(text, ms = 2200) {
    dropHint.textContent = text;
    dropHint.classList.add('visible');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => dropHint.classList.remove('visible'), ms);
  }

  /* ---------- audio gating ---------- */
  let audioStarted = false;
  async function ensureAudio() {
    if (audioStarted || !state.audioOn) return;
    audioStarted = true;
    await audio.start();
    audio.setVolume(state.vol);
  }

  /* ---------- event plumbing ---------- */
  startBtn.addEventListener('click', (e) => { e.preventDefault(); begin(); });
  overlay.addEventListener('click', (e) => {
    if (e.target === startBtn || e.target.closest('#startBtn')) return;
    begin();
  });
  window.addEventListener('keydown', handleKey, { passive: false });
  window.addEventListener('click', () => {
    if (state.phase === 'typing' && !state.panelOpen) focusIME();
  });

  /* ---------- loop ---------- */
  function loop() {
    const now = performance.now();
    fog.update(now);
    fog.render();
    shader.updateTextMask(fog.off);
    shader.setTextDissolve(fog.getDissolveProgress());
    shader.setHasText(fog.hasContent() || fog.dissolving ? 1.0 : 0.0);
    shader.render();
    requestAnimationFrame(loop);
  }

  /* ---------- boot ---------- */
  (async function bootstrap() {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }
    fog.resize();
    updateClock();
    setInterval(updateClock, 15_000);
    if (takeEl) takeEl.textContent = pad(state.take, 3);
    loadDefaultBackground();
    loop();
  })();
})();
