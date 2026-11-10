// Eudaimon Evolutionary Economy — simulation core
// Nelson–Winter style evolutionary firms (variation, selection, retention)
// + a bottleneck input sector + household ownership.
// Two policy regimes run on the same random seed:
//   "status"   — today's ownership distribution; the ~1.4%-of-GDP asset-building
//                subsidy flows 70% to the top fifth (Doctrine III).
//   "republic" — same subsidy redirected into universal, titled citizen stakes,
//                seeded heavier for the bottom half (Doctrine V, Charter I.2).
// Stylized and annual. Every assumption is a parameter. Not a forecast.

(function (root) {
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

  const DEFAULTS = {
    H: 500,            // households
    M: 30,             // final-goods firms
    seed: 7,
    auto: 0.004,       // AI automation: labor share falls this much per year
    nb: 3,             // number of bottleneck owners (energy / chips / magnets)
    sub: 0.014,        // asset-building subsidy, share of GDP (~$397B / ~$28T)
    wealthSigma: 2.2,  // initial wealth inequality (lognormal sigma)
    payout: 0,         // share of citizen-stake income paid out as cash dividend (Alaska PFD style)
  };

  function gini(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const n = a.length;
    let cum = 0, sum = 0;
    for (let i = 0; i < n; i++) { cum += (i + 1) * a[i]; sum += a[i]; }
    return sum <= 0 ? 0 : (2 * cum) / (n * sum) - (n + 1) / n;
  }

  function makeSim(policy, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const R = rngFrom(o.seed);
    const H = o.H, M = o.M;

    // households: wealth W, skill s
    const W = new Float64Array(H), s = new Float64Array(H);
    const L = new Float64Array(H); // locked, titled citizen stakes (republic only)
    for (let h = 0; h < H; h++) {
      W[h] = Math.exp(o.wealthSigma * R.gauss());
      s[h] = Math.exp(0.45 * R.gauss());
    }
    // scale mean wealth to 5x mean income (income per household = 1 at t=0)
    let sw = 0; for (let h = 0; h < H; h++) sw += W[h];
    for (let h = 0; h < H; h++) W[h] *= (5 * H) / sw;
    let ss = 0; for (let h = 0; h < H; h++) ss += s[h];

    // firms: productivity A, markup mu, R&D intensity rd, market share f
    let nextId = 0;
    const firms = [];
    for (let i = 0; i < M; i++) {
      firms.push({ id: nextId++, A: 1 + 0.05 * R.gauss(), mu: clamp(0.2 + 0.08 * R.gauss(), 0.03, 0.6),
        rd: clamp(0.05 + 0.03 * R.gauss(), 0, 0.25), f: 1 / M, gen: 0, born: 0 });
    }

    const st = { policy, o, t: 0, W, L, s, firms, Yprev: H, Y0: H, hist: [], entries: 0, exits: 0 };

    st.step = function () {
      const t = st.t;
      // ── 1. Evolution of firms ────────────────────────────
      const price = (fi) => (1 + fi.mu + 0.6 * fi.rd) / fi.A;
      let Ebar = 0; for (const fi of firms) Ebar += fi.f / price(fi);
      let Amax = 0; for (const fi of firms) Amax = Math.max(Amax, fi.A);
      for (const fi of firms) {
        // selection: replicator dynamics on competitiveness (1/price)
        fi.f *= 1 + 2.5 * ((1 / price(fi)) / Ebar - 1);
        fi.f = Math.max(fi.f, 0);
        // variation: innovation (R&D-driven) and imitation of best practice
        if (R.next() < clamp(fi.rd * 4, 0, 0.9)) fi.A *= Math.exp(Math.max(-0.03, 0.035 + 0.05 * R.gauss()));
        if (R.next() < 0.22) fi.A += 0.3 * R.next() * (Amax - fi.A);
      }
      let tf = 0; for (const fi of firms) tf += fi.f;
      for (const fi of firms) fi.f /= tf;
      // exit + entry (retention with mutation)
      let Abar = 0; for (const fi of firms) Abar += fi.f * fi.A;
      for (let i = 0; i < firms.length; i++) {
        if (firms[i].f < 0.007) {
          let r = R.next(), parent = firms[0];
          for (const fi of firms) { r -= fi.f; if (r <= 0) { parent = fi; break; } }
          firms[i] = { id: nextId++, A: Abar * (0.9 + 0.12 * R.next()),
            mu: clamp(parent.mu + 0.04 * R.gauss(), 0.03, 0.6), rd: clamp(parent.rd + 0.025 * R.gauss(), 0, 0.25),
            f: 0.015, gen: parent.gen + 1, born: t };
          st.exits++; st.entries++;
        }
      }
      tf = 0; for (const fi of firms) tf += fi.f;
      for (const fi of firms) fi.f /= tf;
      Abar = 0; for (const fi of firms) Abar += fi.f * fi.A;

      // ── 2. Income split ──────────────────────────────────
      const Ypot = Abar * H;
      const lambda = Math.max(0.35, 0.62 - o.auto * t);         // labor share
      const muB = 0.08 + 1.2 / o.nb;                             // bottleneck markup
      const beta = 0.15 * muB / (1 + muB);                       // bottleneck rent share of GDP
      const capfrac = (1 - lambda) * (1 - beta) + beta;          // profits + rents

      // ── 3. Demand closure (rich save more) ───────────────
      let sumW = 0, sumL = 0; for (let h = 0; h < H; h++) { sumW += W[h]; sumL += L[h]; }
      const sumA = sumW + sumL;
      const ybar = st.Yprev / H;
      const mpcL = 0.88;
      const mpcK = new Float64Array(H);
      let MK = 0;
      for (let h = 0; h < H; h++) { mpcK[h] = 0.7 / (1 + W[h] / (3 * ybar)); MK += mpcK[h] * (W[h] / sumA); }
      const kL = policy === 'republic' ? mpcL * o.payout * (capfrac - o.sub) * (sumL / sumA) : 0;
      const k1 = mpcL * lambda * (1 - beta) + (capfrac - o.sub) * MK + kL;
      const k0 = 0.02 * sumW;
      const aut = 0.35 * Ypot;            // investment (~18%) + government (~17%), tied to capacity
      const iK = 0;
      const Y = Math.min(Ypot, (aut + k0) / Math.max(0.05, 1 - k1 - iK));

      // ── 4. Distribute income, consume, save ──────────────
      const wages = lambda * (1 - beta) * Y;
      const capInc = (capfrac - o.sub) * Y;
      const G = o.sub * Y;
      const g = new Float64Array(H);
      if (policy === 'status') {
        const idx = Array.from({ length: H }, (_, h) => h).sort((a, b) => W[b] - W[a]);
        const top = idx.slice(0, H * 0.2), mid = idx.slice(H * 0.2, H * 0.5), bot = idx.slice(H * 0.5);
        const give = (grp, amt) => { let sg = 0; for (const h of grp) sg += W[h] + 1e-9; for (const h of grp) g[h] += amt * (W[h] + 1e-9) / sg; };
        give(top, 0.70 * G); give(mid, 0.29 * G); give(bot, 0.01 * G);
      } else {
        const idx = Array.from({ length: H }, (_, h) => h).sort((a, b) => W[a] - W[b]);
        for (let h = 0; h < H; h++) g[h] += 0.6 * G / H;
        for (let k = 0; k < H / 2; k++) g[idx[k]] += 0.4 * G / (H / 2);
      }
      for (let h = 0; h < H; h++) {
        const wage = wages * s[h] / ss;
        const ci = sumA > 0 ? capInc * W[h] / sumA : 0;
        const cL = sumA > 0 ? capInc * L[h] / sumA : 0;          // stake income: reinvested except the payout share
        const div = o.payout * cL;
        const C = mpcL * (wage + div) + mpcK[h] * ci + 0.02 * W[h];
        if (policy === 'status') W[h] = Math.max(0, (W[h] + wage + ci + g[h] - C) * 0.97);
        else { W[h] = Math.max(0, (W[h] + wage + div + ci - C) * 0.97); L[h] = (L[h] + cL - div + g[h]) * 0.97; }
      }
      // ── 5. Generational turnover (bequests are dynastic in both regimes) ──
      const deaths = Math.round(H * 0.025);
      for (let d = 0; d < deaths; d++) {
        const h = Math.floor(R.next() * H);
        let tot = 0; for (let k = 0; k < H; k++) tot += W[k] + L[k];
        let r = R.next() * tot, heir = 0;
        for (let k = 0; k < H; k++) { r -= W[k] + L[k]; if (r <= 0) { heir = k; break; } }
        if (heir !== h) { W[heir] += W[h]; L[heir] += L[h]; }
        W[h] = 0; L[h] = 0;
        ss -= s[h]; s[h] = Math.exp(0.45 * R.gauss()); ss += s[h];
      }

      // ── 6. Metrics ───────────────────────────────────────
      const arr = Array.from(W, (x, k) => x + L[k]);
      const sorted = arr.slice().sort((a, b) => a - b);
      let tot = 0; for (const x of sorted) tot += x;
      let b50 = 0; for (let k = 0; k < H / 2; k++) b50 += sorted[k];
      let t10 = 0; for (let k = Math.floor(H * 0.9); k < H; k++) t10 += sorted[k];
      st.hist.push({
        t, gdp: Y / st.Y0, potential: Ypot / st.Y0, unemp: 1 - Y / Ypot, gini: gini(arr),
        bottom50: b50 / tot, top10: t10 / tot, labor: lambda * (1 - beta), rent: beta,
        firms: firms.length, avgGen: firms.reduce((a, fi) => a + fi.gen * fi.f, 0), Abar,
      });
      st.Yprev = Y;
      st.t++;
    };
    return st;
  }

  const api = { makeSim, DEFAULTS, gini };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EvoEcon = api;
})(this);
