/* =========================================================
   RainAudio — procedural rain with actual droplets.

   Three layers make up the bed:
     1. A soft continuous wash (pink noise, low-passed, slowly
        breathing LFO on the cutoff).
     2. A stream of individual droplet transients — fast noise
        bursts, high-passed and band-passed, scattered in time
        and across the stereo field. This is what gives the
        "drops are actually falling" feel.
     3. Rare deeper plops — single heavier drops that land in
        puddles or on soft surfaces.
   A convolution reverb adds air around the whole thing, and
   distant thunder appears every now and then.

   Public surfaces: start(), setVolume(v). keyTick/
   dissolveSwell/echoChime are used by the typewriter UI.
   ========================================================= */
// RainAudio — procedural rain with drop transients, built-in reverb, and
// optional sample playback if /rain.mp3 is present.

  class RainAudio {
    constructor() {
      this.ctx = null;
      this.started = false;
      this.master = null;
      this.dropBus = null;
    }

    async start() {
      if (this.started) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { console.warn('Web Audio unavailable'); return; }
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (_) {}
      }

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(this.ctx.destination);

      this._buildPinkNoise();
      this._buildWhiteNoise();
      this._buildReverb();
      this._buildLowRoom();

      // Dedicated bus for drops so we can balance them together
      this.dropBus = this.ctx.createGain();
      this.dropBus.gain.value = 0.55;
      this.dropBus.connect(this.master);
      this._sendToReverb(this.dropBus, 0.38);

      // Prefer a real recorded rain loop if the user has provided one.
      // When present, the synth wash is skipped; droplets + thunder are
      // still scheduled as garnish on top. When absent, we fall back
      // fully to synthesis.
      this.usingSample = await this._tryLoadSample('rain.mp3');
      if (!this.usingSample) {
        this._buildRainBody();
      }

      this.started = true;
      this._scheduleDroplets();
      this._scheduleHeavyDrops();
      this._scheduleDistantThunder();
    }

    async _tryLoadSample(url) {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) return false;
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await new Promise((resolve, reject) => {
          this.ctx.decodeAudioData(arrayBuf.slice(0), resolve, reject);
        });

        // Crossfade two offset sources to hide the loop seam.
        const half = audioBuf.duration / 2;
        const makeSource = (startOffset) => {
          const src = this.ctx.createBufferSource();
          src.buffer = audioBuf;
          src.loop = true;
          const g = this.ctx.createGain();
          g.gain.value = 0.0;
          src.connect(g).connect(this.master);
          this._sendToReverb(g, 0.18);
          src.start(0, startOffset);
          return { src, g };
        };
        const a = makeSource(0);
        const b = makeSource(half);
        a.g.gain.value = 0.85;
        b.g.gain.value = 0.65;
        this._sampleNodes = [a, b];
        return true;
      } catch (err) {
        return false;
      }
    }

    /* ---------- buffers ---------- */
    _buildPinkNoise() {
      const sr = this.ctx.sampleRate;
      const len = sr * 4;
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
      this.pinkBuf = buf;
    }

    _buildWhiteNoise() {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * 0.4);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.whiteBuf = buf;
    }

    _pinkSource(rate = 1) {
      const n = this.ctx.createBufferSource();
      n.buffer = this.pinkBuf;
      n.loop = true;
      n.playbackRate.value = rate;
      return n;
    }

    _whiteSource(rate = 1) {
      const n = this.ctx.createBufferSource();
      n.buffer = this.whiteBuf;
      n.loop = false;
      n.playbackRate.value = rate;
      return n;
    }

    _buildReverb() {
      const sr = this.ctx.sampleRate;
      const len = Math.floor(sr * 2.4);
      const buf = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const t = i / sr;
          const decay = Math.exp(-t * (2.6 + ch * 0.3));
          d[i] = (Math.random() * 2 - 1) * decay;
        }
      }
      const conv = this.ctx.createConvolver();
      conv.buffer = buf;
      const wet = this.ctx.createGain();
      wet.gain.value = 0.55;
      conv.connect(wet).connect(this.master);
      this.reverbIn = conv;
    }

    _sendToReverb(node, amount = 0.35) {
      const send = this.ctx.createGain();
      send.gain.value = amount;
      node.connect(send).connect(this.reverbIn);
    }

    /* ---------- continuous bed ---------- */
    _buildRainBody() {
      const src = this._pinkSource(1.0);
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 180; hp.Q.value = 0.5;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.5;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.30;

      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 0.08;
      const lfoAmt = this.ctx.createGain();
      lfoAmt.gain.value = 220;
      lfo.connect(lfoAmt).connect(lp.frequency);
      lfo.start();

      src.connect(hp).connect(lp).connect(gain);
      gain.connect(this.master);
      this._sendToReverb(gain, 0.25);
      src.start();
    }

    _buildLowRoom() {
      const src = this._pinkSource(0.6);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.6;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.12;
      src.connect(lp).connect(gain).connect(this.master);
      this._sendToReverb(gain, 0.5);
      src.start();
    }

    /* ---------- droplet transients ---------- */
    _playDroplet() {
      if (!this.ctx || !this.dropBus) return;
      const t = this.ctx.currentTime;

      // A drop is a very short noise burst, tightly filtered and
      // enveloped. Randomise pitch, brightness, pan, and density.
      const rate = 0.9 + Math.random() * 1.6;
      const src = this._whiteSource(rate);

      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1400 + Math.random() * 900;
      hp.Q.value = 0.7;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600 + Math.random() * 3200;
      bp.Q.value = 5 + Math.random() * 10;

      const g = this.ctx.createGain();
      const peak = 0.18 + Math.random() * 0.42;
      const attack = 0.002 + Math.random() * 0.004;
      const decay  = 0.035 + Math.random() * 0.085;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0005, t + attack + decay);

      // Panner for stereo spread
      let panNode = null;
      if (this.ctx.createStereoPanner) {
        panNode = this.ctx.createStereoPanner();
        panNode.pan.value = (Math.random() - 0.5) * 1.6;
      }

      src.connect(hp).connect(bp).connect(g);
      if (panNode) { g.connect(panNode); panNode.connect(this.dropBus); }
      else g.connect(this.dropBus);

      src.start(t);
      src.stop(t + 0.18);
    }

    _scheduleDroplets() {
      const loop = () => {
        if (!this.started) return;
        // Aim for ~16-26 drops/sec on average for a dense patter.
        // Random inter-onset keeps it from feeling mechanical.
        const n = 1 + (Math.random() < 0.35 ? 1 : 0);
        for (let i = 0; i < n; i++) this._playDroplet();
        const delay = 28 + Math.random() * 90;
        setTimeout(loop, delay);
      };
      loop();
    }

    _playHeavyDrop() {
      if (!this.ctx || !this.dropBus) return;
      const t = this.ctx.currentTime;
      const src = this._whiteSource(0.55 + Math.random() * 0.4);

      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900 + Math.random() * 500;
      lp.Q.value = 1.1;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 340 + Math.random() * 420;
      bp.Q.value = 2.2;

      const g = this.ctx.createGain();
      const peak = 0.22 + Math.random() * 0.18;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.18 + Math.random() * 0.1);

      // A small pitch tail — the "plop" resonance
      const res = this.ctx.createOscillator();
      res.type = 'sine';
      const baseHz = 180 + Math.random() * 120;
      res.frequency.setValueAtTime(baseHz * 1.6, t);
      res.frequency.exponentialRampToValueAtTime(baseHz, t + 0.12);
      const resG = this.ctx.createGain();
      resG.gain.setValueAtTime(0, t);
      resG.gain.linearRampToValueAtTime(0.06, t + 0.015);
      resG.gain.exponentialRampToValueAtTime(0.0005, t + 0.22);

      let panNode = null;
      if (this.ctx.createStereoPanner) {
        panNode = this.ctx.createStereoPanner();
        panNode.pan.value = (Math.random() - 0.5) * 1.0;
      }

      src.connect(lp).connect(bp).connect(g);
      res.connect(resG);
      if (panNode) {
        g.connect(panNode); resG.connect(panNode);
        panNode.connect(this.dropBus);
      } else {
        g.connect(this.dropBus);
        resG.connect(this.dropBus);
      }

      src.start(t);
      src.stop(t + 0.3);
      res.start(t);
      res.stop(t + 0.3);
    }

    _scheduleHeavyDrops() {
      const loop = () => {
        if (!this.started) return;
        this._playHeavyDrop();
        const delay = 420 + Math.random() * 1200;
        setTimeout(loop, delay);
      };
      setTimeout(loop, 600 + Math.random() * 800);
    }

    /* ---------- distant thunder ---------- */
    _scheduleDistantThunder() {
      const loop = () => {
        if (!this.started) return;
        const delay = 55000 + Math.random() * 90000;
        setTimeout(() => { this._playThunder(); loop(); }, delay);
      };
      loop();
    }

    _playThunder() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const src = this._pinkSource(0.5);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 90; lp.Q.value = 0.4;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 1.2);
      g.gain.linearRampToValueAtTime(0.08, t + 3.0);
      g.gain.exponentialRampToValueAtTime(0.00005, t + 6.0);
      src.connect(lp).connect(g);
      g.connect(this.master);
      this._sendToReverb(g, 0.6);
      src.start(t);
      src.stop(t + 6.5);
    }

    /* ---------- public ---------- */
    setVolume(v) {
      if (!this.ctx || !this.master) return;
      const clamped = Math.max(0, Math.min(1, v));
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(clamped, t + 0.25);
    }

    keyTick() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const freq = 260 + Math.random() * 140;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 1.3, t);
      osc.frequency.exponentialRampToValueAtTime(freq, t + 0.02);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.014, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.00005, t + 0.09);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.7;
      osc.connect(lp).connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.12);
    }

    dissolveSwell() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(260, t);
      osc.frequency.exponentialRampToValueAtTime(80, t + 3.2);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.042, t + 0.6);
      g.gain.exponentialRampToValueAtTime(0.00005, t + 3.5);
      osc.connect(g).connect(this.master);
      this._sendToReverb(g, 0.4);
      osc.start(t);
      osc.stop(t + 3.6);
    }

    echoChime() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const fund = 174.6; // F3
      const partials = [
        { m: 1.00, g: 0.070, dur: 7.0 },
        { m: 2.01, g: 0.032, dur: 5.5 },
        { m: 3.02, g: 0.016, dur: 4.2 },
        { m: 4.25, g: 0.008, dur: 3.2 },
        { m: 5.61, g: 0.004, dur: 2.0 },
      ];
      partials.forEach(p => {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = fund * p.m;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(p.g, t + 0.6);
        g.gain.exponentialRampToValueAtTime(0.00003, t + p.dur);
        osc.connect(g).connect(this.master);
        this._sendToReverb(g, 0.5);
        osc.start(t);
        osc.stop(t + p.dur + 0.2);
      });
    }
  }

  export { RainAudio };

