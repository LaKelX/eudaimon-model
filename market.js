// Eudaimon Adaptive Market Mind — simulation core
//
// Three layers, one loop:
//   1. THE ECONOMY   — fundamental value grows with the productivity of the
//                      evolutionary economy in core.js, hit by a hidden regime
//                      chain (Expansion → Euphoria → Crisis → Recovery …).
//   2. THE CROWD     — 200 traders. Each carries a strategy genome (value, trend,
//                      mean-reversion, pattern memory, follow-the-Mind), HABITS
//                      (strategies that paid get reinforced and persist after the
//                      edge is gone) and SHADOW HABITS (biases nobody chose:
//                      loss scars, herd conformity, dip-buying reflex). Poor
//                      traders die; winners reproduce with mutation.
//   3. THE MIND      — sees only prices, order flow and noisy earnings. It runs a
//                      library of 8 theories, scores each on what actually
//                      happened, learns which theory fits which kind of market,
//                      grows its own library of market "archetypes" with no
//                      labels, recalls them when they come back, and estimates
//                      the crowd's shadow habits from the flow alone.
//   LOOP             — the Mind's forecast is published back to the crowd as
//                      "the chart". Traders who follow it change the market the
//                      Mind is trying to understand (reflexivity).
//
// Stylized, daily, every assumption a parameter. A self-model, not a forecast
// of any real market and not sentient.

(function (root) {
  const EvoEcon = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.EvoEcon;

  function rngFrom(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return { next, gauss };
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // ── Hidden truth: the regime chain (the Mind never sees this) ──
  const REGIMES = [
    { key: 'expansion',   name: 'Expansion',   mu:  0.0004, vol: 0.008, bias:  0.00, scar: 1.0, dur: 320 },
    { key: 'euphoria',    name: 'Euphoria',    mu:  0.0003, vol: 0.007, bias:  0.30, scar: 0.5, dur: 170 },
    { key: 'crisis',      name: 'Crisis',      mu: -0.0030, vol: 0.028, bias: -0.30, scar: 2.5, dur: 80  },
    { key: 'stagflation', name: 'Stagflation', mu: -0.0005, vol: 0.015, bias: -0.08, scar: 1.4, dur: 220 },
    { key: 'recovery',    name: 'Recovery',    mu:  0.0014, vol: 0.016, bias:  0.10, scar: 1.0, dur: 190 },
  ];
  const NEXT = { // Minsky-flavored: calm breeds euphoria, euphoria breeds crisis
    0: [[1, 0.45], [3, 0.30], [2, 0.25]],
    1: [[2, 0.70], [0, 0.30]],
    2: [[4, 0.80], [3, 0.20]],
    3: [[2, 0.35], [4, 0.40], [0, 0.25]],
    4: [[0, 0.75], [3, 0.25]],
  };

  const SIGNALS = ['Value', 'Trend', 'Mean reversion', 'Pattern memory', 'Follow the Mind'];
  const SHADOWS = ['Loss scar', 'Herd conformity', 'Dip-buying reflex'];
  const THEORIES = [
    { key: 'rw',    name: 'Random walk',        school: 'Efficient markets (Fama)' },
    { key: 'mom',   name: 'Momentum',           school: 'Trend persistence (Jegadeesh–Titman)' },
    { key: 'mr',    name: 'Mean reversion',     school: 'Overreaction (De Bondt–Thaler)' },
    { key: 'val',   name: 'Value',              school: 'Intrinsic value (Graham)' },
    { key: 'refl',  name: 'Reflexivity',        school: 'Flows move prices move flows (Soros)' },
    { key: 'minsky',name: 'Fragility',          school: 'Stability breeds instability (Minsky)' },
    { key: 'shadow',name: 'Behavioral shadow',  school: 'Loss aversion & herding (Kahneman, Shiller)' },
    { key: 'pat',   name: 'Pattern memory',     school: 'Technical recall (the Mind’s own)' },
  ];
  const NT = THEORIES.length, NS = SIGNALS.length, NK = 54, HZ = 5;

  const DEFAULTS = {
    seed: 7,
    N: 200,          // traders
    days: 3024,      // 12 years
    loop: 0.6,       // how strongly the crowd follows the Mind's published chart
    shadow: 1.0,     // intensity of shadow habits
    eta: 0.9,        // how fast the Mind re-weights theories
  };

  function archetypeName(c) {
    const trend = c[0], vol = c[1], gap = c[2];
    const vs = vol > 0.35 ? 'Volatile' : vol < -0.25 ? 'Calm' : 'Steady';
    const ts = trend > 0.45 ? 'rising' : trend < -0.45 ? 'falling' : 'drifting';
    const gs = gap < -0.7 ? 'overvalued' : gap > 0.7 ? 'undervalued' : 'fair value';
    let poet;
    if (vs === 'Volatile' && ts === 'falling') poet = 'Panic';
    else if (vs === 'Volatile' && ts === 'rising') poet = 'Relief rally';
    else if (vs === 'Volatile') poet = 'Chop';
    else if (ts === 'rising' && gs === 'overvalued') poet = 'Melt-up';
    else if (ts === 'rising') poet = 'Quiet bull';
    else if (ts === 'falling' && gs === 'undervalued') poet = 'Capitulation';
    else if (ts === 'falling') poet = 'Slow bleed';
    else if (gs === 'overvalued') poet = 'Thin air';
    else if (gs === 'undervalued') poet = 'Coiled spring';
    else poet = 'Sleep';
    return { poet, desc: `${vs} · ${ts} · ${gs}` };
  }

  // Recursive least squares (for the Mind's model of the crowd's order flow)
  function makeRLS(n, lam) {
    const w = new Float64Array(n), P = [];
    for (let i = 0; i < n; i++) { P.push(new Float64Array(n)); P[i][i] = 50; }
    return {
      w,
      predict(x) { let s = 0; for (let i = 0; i < n; i++) s += w[i] * x[i]; return s; },
      update(x, y) {
        const Px = new Float64Array(n);
        for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += P[i][j] * x[j]; Px[i] = s; }
        let den = lam; for (let i = 0; i < n; i++) den += x[i] * Px[i];
        let err = y; for (let i = 0; i < n; i++) err -= w[i] * x[i];
        for (let i = 0; i < n; i++) w[i] += Px[i] * err / den;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i][j] = (P[i][j] - Px[i] * Px[j] / den) / lam;
      },
    };
  }

  function makeMarket(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const R = rngFrom(o.seed * 7919 + 13);
    const N = o.N;

    // ── Economy: fundamental growth comes from the evolutionary economy ──
    const years = Math.ceil(o.days / 252) + 2;
    const eco = EvoEcon.makeSim('status', { seed: o.seed });
    for (let y = 0; y < years; y++) eco.step();
    const Ab = eco.hist.map(h => h.Abar);
    const gYear = Ab.map((a, y) => y + 1 < Ab.length ? Math.log(Ab[y + 1] / a) : 0);

    // ── Crowd ──
    const g = new Float64Array(N * NS), hab = new Float64Array(N * NS);
    const la = new Float64Array(N), hd = new Float64Array(N), an = new Float64Array(N);
    const vb = new Float64Array(N), lr = new Float64Array(N), W = new Float64Array(N).fill(1);
    const pos = new Float64Array(N), tab = new Float64Array(N * NK), born = new Int32Array(N), gen = new Int32Array(N);
    function seedGenome(i) {
      const dom = Math.floor(R.next() * 4);
      for (let k = 0; k < NS; k++) g[i * NS + k] = Math.exp(0.5 * R.gauss()) * (k === dom ? 3 : 1) * (k === 4 ? 0.5 : 1);
      vb[i] = 0.03 * R.gauss();
      lr[i] = 0.01 + 0.12 * R.next();
    }
    for (let i = 0; i < N; i++) seedGenome(i);

    // ── Mind ──
    const mind = {
      b: new Float64Array(NT).fill(0), // learned coefficient per theory
      Lg: new Float64Array(NT),        // global discounted loss per theory
      tab: new Float64Array(NK),       // the Mind's own pattern memory (5-day forward return per pattern)
      arch: [],                        // archetype library
      cur: -1, pend: -1, pendN: 0, sinceSpawn: 999,
      queue: [],
      flow: makeRLS(6, 0.995),
      zs: null,
      mseM: 1e-4, mseRW: 1e-4, hit: 0.5, skillN: 0,
      recalls: 0,
    };
    mind.b[1] = 2; mind.b[2] = -0.1; mind.b[3] = 0.05; mind.b[4] = 0.01; mind.b[5] = -0.02; mind.b[6] = 0.01; mind.b[7] = 1;

    const st = {
      o, t: 0, N,
      logP: 0, logV: 0, Vhat: 0, peak: 0, ma20: 0, ma200: 0,
      s2: 1e-4, sLong: 0.01, emaR: 0, crowd: 0, D: 0,
      rets: [], prices: [0],
      reg: 0, regAge: 0, forced: null,
      mf: 0, hist: [], mind, gen, deaths: 0,
      habitsAvg: new Float64Array(NS), shadowAvg: new Float64Array(3),
      lastWeights: new Float64Array(NT).fill(1 / NT),
    };

    function patternKey() {
      const s = Math.sqrt(st.s2), n = st.rets.length;
      let k = 0;
      for (let j = 3; j >= 1; j--) {
        const r = n - j >= 0 ? st.rets[n - j] : 0;
        k = k * 3 + (r > 0.5 * s ? 2 : r < -0.5 * s ? 0 : 1);
      }
      return k * 2 + (s > st.sLong ? 1 : 0);
    }

    function theoryX(dd) {
      const s = Math.sqrt(st.s2);
      const est = mind.flow.w;
      const shadowFlow = est[3] * (dd / 0.1) + est[4] * st.crowd * 3;
      return [
        0,
        st.emaR,
        st.logP - st.ma20,
        st.Vhat - st.logP,
        st.crowd * s,
        (st.logP - st.ma200) * Math.min(3, st.sLong / s),
        shadowFlow * s,
        0, // pattern handled separately
      ];
    }

    function weightsFor(a) {
      const w = new Float64Array(NT);
      const blend = (L, out, scale) => {
        let mn = Infinity; for (let j = 0; j < NT; j++) mn = Math.min(mn, L[j]);
        let sw = 0; const tmp = new Float64Array(NT);
        for (let j = 0; j < NT; j++) { tmp[j] = Math.exp(-o.eta * (L[j] - mn)); sw += tmp[j]; }
        for (let j = 0; j < NT; j++) out[j] += scale * tmp[j] / sw;
      };
      if (a < 0) { blend(mind.Lg, w, 1); return w; }
      const A = mind.arch[a];
      const alpha = A.n / (A.n + 60);
      blend(A.L, w, alpha); blend(mind.Lg, w, 1 - alpha);
      return w;
    }

    st.shock = function (kind) { st.forced = kind; };

    st.step = function () {
      const t = st.t;
      const s = Math.sqrt(st.s2);
      const reg = REGIMES[st.reg];
      const key = patternKey();
      const dd = st.logP - st.peak;

      // ── 1. The crowd decides ──
      const mfz = st.mf / (s * Math.sqrt(HZ));
      const sigCommon = [
        null,
        clamp(st.emaR / s * 4, -3, 3),
        clamp(-(st.logP - st.ma20) / (s * 4.5), -3, 3),
        null,
        clamp(mfz * 1.5 * o.loop, -3, 3),
      ];
      let sumW = 0; for (let i = 0; i < N; i++) sumW += W[i];
      let D = 0, Dsh = 0;
      const sig = new Float64Array(NS), contrib = new Float64Array(N * NS);
      let shTrue0 = 0, shTrue1 = 0, shTrue2 = 0;
      for (let i = 0; i < N; i++) {
        sig[0] = clamp((st.logV + vb[i] - st.logP) / 0.08, -6, 6);
        sig[1] = sigCommon[1]; sig[2] = sigCommon[2];
        sig[3] = clamp(tab[i * NK + key] / s * 3, -3, 3);
        sig[4] = sigCommon[4];
        let den = 0; for (let k = 0; k < NS; k++) den += g[i * NS + k] * (1 + hab[i * NS + k]);
        let S = 0;
        for (let k = 0; k < NS; k++) {
          const c = g[i * NS + k] * (1 + hab[i * NS + k]) * sig[k] / den;
          contrib[i * NS + k] = c; S += c;
        }
        const s0 = la[i] * (dd / 0.1) * 0.8;          // scarred traders dump into drawdowns
        const s1 = hd[i] * st.crowd * 3;               // conformists follow the flow
        const s2 = an[i] * clamp(-dd / 0.1, 0, 3) * 0.6; // reflex: buy the dip back toward the old high
        const shadowX = o.shadow * (s0 + s1 + s2);
        const x = S + shadowX + reg.bias + 0.25 * R.gauss();
        const d = Math.tanh(0.8 * x);
        const dNo = Math.tanh(0.8 * (x - shadowX));
        pos[i] = d;
        D += W[i] * d; Dsh += W[i] * (d - dNo);
        shTrue0 += W[i] * o.shadow * la[i]; shTrue1 += W[i] * o.shadow * hd[i]; shTrue2 += W[i] * o.shadow * an[i];
      }
      D /= sumW; Dsh /= sumW;

      // ── 2. Economy + price ──
      let mu = reg.mu, vol = reg.vol, jump = 0;
      if (st.forced === 'crash') { jump = -0.12; }
      if (st.forced === 'bubble') { jump = 0.04; }
      const gy = gYear[Math.min(gYear.length - 1, Math.floor(t / 252))] / 252;
      const dV = gy + mu + vol * R.gauss() + jump;
      st.logV += dV;
      // arbitrage / issuance / buybacks slowly pull price back toward value
      const r = 0.6 * dV + 0.007 * D - 0.015 * (st.logP - st.logV) + 0.003 * R.gauss() + (st.forced === 'crash' ? -0.05 : 0);
      st.logP += r;

      // ── 3. The crowd learns: PnL, habits, shadows, pattern memory ──
      const z = r / s;
      for (let i = 0; i < N; i++) {
        const pnl = pos[i] * r;
        W[i] = clamp(W[i] * Math.exp(pnl), 1e-4, 5); // redemptions cap any fund at 5x average
        for (let k = 0; k < NS; k++) {
          const credit = contrib[i * NS + k] * z;
          const h = hab[i * NS + k] * 0.996 + 0.008 * credit;
          hab[i * NS + k] = clamp(h, 0, 2);
        }
        const pz = pnl / s;
        if (pz < -1.5) la[i] = Math.min(2, la[i] + 0.04 * (-pz - 1.5) * reg.scar);
        la[i] *= 0.9993;
        if (Math.sign(pos[i]) === Math.sign(D) && pnl > 0) hd[i] = Math.min(2, hd[i] + 0.0015); else hd[i] *= 0.997;
        if (dd < -0.05 && r > 0 && pos[i] > 0) an[i] = Math.min(3, an[i] + 0.01); else an[i] *= 0.9993;
        const ti = i * NK + key;
        tab[ti] += lr[i] * (r - tab[ti]);
      }

      // ── 4. Market statistics update ──
      st.rets.push(r); st.prices.push(st.logP);
      st.s2 = 0.0000015 + 0.08 * r * r + 0.905 * st.s2;
      st.sLong += 0.004 * (Math.sqrt(st.s2) - st.sLong);
      st.emaR += 0.1 * (r - st.emaR);
      st.ma20 += (st.logP - st.ma20) / 20;
      st.ma200 += (st.logP - st.ma200) / 200;
      { // rolling 1-year high: the reference point traders feel losses against
        let pk = -Infinity; const n = st.prices.length;
        for (let k = Math.max(0, n - 252); k < n; k++) pk = Math.max(pk, st.prices[k]);
        st.peak = pk;
      }
      const crowdPrev = st.crowd;
      st.crowd += 0.1 * (D - st.crowd);
      st.D = D;

      // ── 5. Selection: the poorest die, winners reproduce with mutation ──
      if (t > 0 && t % 63 === 0) {
        const idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => W[a] - W[b]);
        const kill = Math.round(N * 0.05), top = idx.slice(Math.floor(N * 0.7));
        const med = W[idx[N >> 1]];
        for (let q = 0; q < kill; q++) {
          const i = idx[q], p = top[Math.floor(R.next() * top.length)];
          for (let k = 0; k < NS; k++) { g[i * NS + k] = g[p * NS + k] * Math.exp(0.25 * R.gauss()); hab[i * NS + k] = 0; }
          la[i] = 0.5 * la[p]; hd[i] = 0.5 * hd[p]; an[i] = 0.5 * an[p]; // shadows pass down half-strength (culture)
          vb[i] = vb[p] + 0.01 * R.gauss(); lr[i] = clamp(lr[p] * Math.exp(0.2 * R.gauss()), 0.005, 0.2);
          for (let k = 0; k < NK; k++) tab[i * NK + k] = 0;
          W[i] = med; gen[i] = gen[p] + 1; born[i] = t;
          st.deaths++;
        }
        let sw = 0; for (let i = 0; i < N; i++) sw += W[i];
        for (let i = 0; i < N; i++) W[i] *= N / sw;
      }

      // ── 6. Hidden regime transition ──
      if (st.forced) {
        st.reg = st.forced === 'crash' ? 2 : 1; st.regAge = 0; st.forced = null;
      } else {
        st.regAge++;
        if (R.next() < 1 / REGIMES[st.reg].dur) {
          let u = R.next(), nx = NEXT[st.reg][0][0];
          for (const [j, p] of NEXT[st.reg]) { u -= p; if (u <= 0) { nx = j; break; } }
          st.reg = nx; st.regAge = 0;
        }
      }

      // ── 7. THE MIND ──
      // 7a. observe noisy earnings
      st.Vhat += 0.05 * (st.logV + 0.04 * R.gauss() - st.Vhat);
      // 7b. model the crowd's flow; the dd and crowd coefficients ARE its estimate of the shadow habits
      const fx = [clamp(sigCommon[1], -3, 3), sigCommon[2], clamp((st.Vhat - st.logP + r) / 0.08, -3, 3), (dd) / 0.1, crowdPrev * 3, 1];
      mind.flow.update(fx, D);
      const fw = mind.flow.w;
      const shEst = fw[3] * (dd / 0.1) + fw[4] * crowdPrev * 3;

      // 7c. score forecasts made HZ days ago
      if (mind.queue.length >= HZ) {
        const q = mind.queue.shift();
        const Rr = st.logP - q.lp;
        const sc = q.s * q.s * HZ;
        for (let j = 0; j < NT; j++) {
          const loss = (Rr - q.f[j]) * (Rr - q.f[j]) / sc;
          mind.Lg[j] = 0.99 * mind.Lg[j] + loss;
          if (q.a >= 0) { const A = mind.arch[q.a]; A.L[j] = 0.985 * A.L[j] + loss; }
          // each theory refits its own coefficient (normalized LMS)
          const x = q.x[j];
          if (j > 0 && j < 7 && x !== 0) {
            const ex2 = x * x + 1e-8 + (j === 1 ? s * s * 0.05 : j === 4 || j === 6 ? s * s * 0.5 : 1e-4);
            mind.b[j] = clamp(mind.b[j] + 0.03 * (Rr - mind.b[j] * x) * x / ex2, -20, 20);
          }
        }
        mind.tab[q.key] += 0.04 * (Rr - mind.tab[q.key]);
        mind.mseM += 0.004 * ((Rr - q.comb) ** 2 - mind.mseM);
        mind.mseRW += 0.004 * (Rr * Rr - mind.mseRW);
        if (Math.abs(q.comb) > 1e-6) mind.hit += 0.004 * ((Math.sign(q.comb) === Math.sign(Rr) ? 1 : 0) - mind.hit);
        mind.skillN++;
      }

      // 7d. archetype library: unsupervised regime discovery + recall
      const zf = [
        clamp((st.logP - (st.prices.length > 20 ? st.prices[st.prices.length - 21] : 0)) / (Math.sqrt(st.s2) * 4.47) / 1.5, -3, 3),
        clamp(Math.log(Math.sqrt(st.s2) / st.sLong) * 2, -3, 3),
        clamp((st.Vhat - st.logP) / 0.1, -3, 3),
        clamp(st.crowd * 3, -3, 3),
        clamp(dd / 0.1, -3, 3) * 0.6,
      ];
      if (!mind.zs) mind.zs = zf.slice();
      for (let k = 0; k < 5; k++) mind.zs[k] += 0.08 * (zf[k] - mind.zs[k]);
      const zs = mind.zs;
      mind.sinceSpawn++;
      if (t >= 40) {
        let best = -1, bd = Infinity;
        mind.arch.forEach((A, k) => {
          let d2 = 0; for (let m = 0; m < 5; m++) d2 += (zs[m] - A.c[m]) ** 2;
          if (d2 < bd) { bd = d2; best = k; }
        });
        const dist = Math.sqrt(bd);
        if ((best < 0 || dist > 1.7) && mind.sinceSpawn > 30 && mind.arch.length < 12) {
          const L = Float64Array.from(mind.Lg);
          mind.arch.push({ id: mind.arch.length + 1, c: zs.slice(), L, n: 0, visits: 1, born: t, truth: new Float64Array(REGIMES.length), name: null, desc: null });
          mind.cur = mind.arch.length - 1; mind.pend = -1; mind.pendN = 0; mind.sinceSpawn = 0;
        } else if (best >= 0 && best !== mind.cur) {
          if (best === mind.pend) mind.pendN++; else { mind.pend = best; mind.pendN = 1; }
          if (mind.pendN >= 5) {
            mind.cur = best; mind.pend = -1; mind.pendN = 0;
            mind.arch[best].visits++; mind.recalls++;
          }
        } else { mind.pend = -1; mind.pendN = 0; }
        if (mind.cur >= 0) {
          const A = mind.arch[mind.cur];
          for (let m = 0; m < 5; m++) A.c[m] += 0.01 * (zs[m] - A.c[m]);
          A.n++; A.truth[st.reg]++;
          const nm = archetypeName(A.c); A.name = nm.poet; A.desc = nm.desc;
        }
      }

      // 7e. forecast the next HZ days and publish it (the loop)
      const x = theoryX(dd);
      const s1 = Math.sqrt(st.s2);
      const keyNow = patternKey();
      const f = new Float64Array(NT);
      for (let j = 0; j < NT; j++) f[j] = mind.b[j] * x[j];
      f[7] = mind.tab[keyNow];
      for (let j = 0; j < NT; j++) f[j] = clamp(f[j], -0.25, 0.25);
      const w = weightsFor(mind.cur);
      let comb = 0; for (let j = 0; j < NT; j++) comb += w[j] * f[j];
      st.mf = comb;
      st.lastWeights = w;
      mind.queue.push({ lp: st.logP, f, x, comb, a: mind.cur, s: s1, key: keyNow });

      // ── 8. Record ──
      const hAvg = new Float64Array(NS);
      let sw2 = 0; for (let i = 0; i < N; i++) sw2 += W[i];
      for (let i = 0; i < N; i++) for (let k = 0; k < NS; k++) hAvg[k] += W[i] * hab[i * NS + k] / sw2;
      st.habitsAvg = hAvg;
      st.shadowAvg = [shTrue0 / sumW, shTrue1 / sumW, shTrue2 / sumW];
      const skill = 1 - mind.mseM / Math.max(1e-12, mind.mseRW);
      st.hist.push({
        t, lp: st.logP, lv: st.logV, reg: st.reg, arch: mind.cur, D, mf: comb,
        w: Array.from(w), hab: Array.from(hAvg), sh: st.shadowAvg.slice(),
        shTrue: Dsh, shEst, skill: mind.skillN > 120 ? skill : null, hit: mind.skillN > 120 ? mind.hit : null,
        nArch: mind.arch.length,
      });
      st.t++;
    };

    // purity: how well the Mind's own unlabeled archetypes line up with the hidden regimes
    st.purity = function () {
      let tot = 0, hit = 0;
      for (const A of mind.arch) { let m = 0, s = 0; for (const v of A.truth) { s += v; m = Math.max(m, v); } tot += s; hit += m; }
      return tot ? hit / tot : 0;
    };
    st.archTruth = function (A) {
      let m = 0, j = 0, s = 0; A.truth.forEach((v, k) => { s += v; if (v > m) { m = v; j = k; } });
      return { reg: j, share: s ? m / s : 0 };
    };
    return st;
  }

  const api = { makeMarket, DEFAULTS, REGIMES, THEORIES, SIGNALS, SHADOWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EvoMarket = api;
})(this);
