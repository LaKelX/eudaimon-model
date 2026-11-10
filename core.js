// Eudaimon Evolutionary Economy — simulation core
// Nelson–Winter style evolutionary firms (variation, selection, retention)
// + a bottleneck input sector + household ownership.
// Two policy regimes run on the same random seed:
//   "status"   — today's ownership distribution; the ~1.4%-of-GDP asset-building
//                subsidy flows 70% to the top fifth (Doctrine III).
//   "republic" — same subsidy redirected into universal, titled citizen stakes,
//                seeded heavier for the bottom half (Doctrine V, Charter I.2).
//   "democracy" — v0.2: nobody picks the regime. Two parties compete (Frey 1978
//                politico-economic loop). Voters judge growth, jobs, inflation and
//                their own income; the incumbent pursues ideology when safe and
//                buys votes before elections when not; losers get replaced.
// v0.2 also adds a power sector run as a socio-technical transition (Geels 2002
// multi-level perspective): an incumbent energy regime with lock-in, a niche
// technology that gets cheaper with every unit built, landscape shocks that open
// windows of opportunity, and a build limit (permits, interconnection, trades).
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
    wealthSigma: 2.05, // initial wealth inequality (lognormal sigma), calibrated to the Fed DFA top-1% share (~32%)
    payout: 0,         // share of citizen-stake income paid out as cash dividend (Alaska PFD style)
    build: 0.05,       // grid build limit: new capacity per year beyond replacement, share of capacity
    shocks: 1,         // landscape shock frequency multiplier (fuel spikes, climate disasters, AI power surges)
    message: 'defend', // Ownership Party's message: 'defend' citizens' interests, or 'overthrow' the elite
  };
  // Platform appeal, scaled from a German conjoint experiment (candidate-choice probabilities):
  // higher taxes on the rich ~0.58 (+0.08 vs 0.50); "defend citizens' interests" 0.53 (+0.03);
  // "overthrow the political elite" 0.40 (-0.10). Candidate-choice effects are discounted ~60%
  // into vote share, since real elections bundle many issues.
  const APPEAL = { tax: 0.4 * 0.08, defend: 0.4 * 0.03, overthrow: 0.4 * -0.10 };

  // Party platforms (the "Ideology" bubble in Frey's diagram)
  function platform(party, o, safe) {
    const k = safe ? 1.4 : 1;
    if (party === 'republic') return { route: 'republic', payout: o.payout, support: 0.25 * k, protect: 0, buildX: 0.02 };
    return { route: 'status', payout: 0, support: 0, protect: 1 * k, buildX: 0 };
  }
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));

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
    // power sector (Geels): incumbent regime capacity Kr, niche capacity Kn
    const RL = rngFrom(o.seed * 104729 + 7);   // landscape: same shocks in every run on this seed
    const RP = rngFrom(o.seed * 7727 + 3);     // electoral noise
    Object.assign(st, {
      Kr: 1.12 * H, Kn: 0.03 * H, cumN: 0.03 * H, cumN0: 0.03 * H, align: 0.9, fuel: 0, aiBoost: 0,
      pEprev: 1, AbarPrev: 1, nbEff: o.nb, stim: 0, stimPrev: 0,
      party: policy === 'republic' ? 'republic' : 'order', popS: 0.5, inOffice: 0, elections: [], medPrev: null,
      norm: null, // voters' expectations: what they've gotten used to
    });

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

      // ── 2. Government: the policy function ───────────────
      const safe = policy === 'democracy' && st.popS > 0.55;
      const pol = platform(st.party, o, safe);

      // ── 3. Landscape: shocks that open windows of opportunity ──
      let pressure = 0; const events = [];
      if (RL.next() < 0.07 * o.shocks) { st.fuel += 0.3; pressure += 0.12; events.push('Fuel price shock'); }
      if (RL.next() < 0.06 * o.shocks) { pressure += 0.15; st.Kr *= 0.96; events.push('Climate disaster'); }
      if (RL.next() < 0.05 * o.shocks) { st.aiBoost += 0.08; events.push('AI power surge'); }

      // ── 4. Power sector: regime vs. niche ────────────────
      const lambda = Math.max(0.35, 0.62 - o.auto * t);          // labor share
      const eInt = 1 + 2.0 * (0.62 - lambda) + st.aiBoost;        // AI eats power: energy per unit of output
      const Ypot0 = Abar * H;
      const Ed = Ypot0 * eInt;
      const Cap = st.Kr + st.Kn;
      const Ypot = Math.min(Ypot0, Cap / eInt);                   // no electrons, no output
      const shortfall = 1 - Ypot / Ypot0;
      const shN = st.Kn / Cap;
      const cR = 1 + st.fuel;
      const cN = Math.max(0.35, 1.7 * Math.pow(st.cumN / st.cumN0, -0.32)); // ~20% cheaper per doubling (Wright's law)
      const util = Math.min(1, Ed / Cap);
      const pE = ((st.Kr * cR + st.Kn * cN) / Cap) * (1 + 2.5 * Math.max(0, util - 0.88));
      if (policy === 'republic' || (policy === 'democracy' && st.party === 'republic')) st.nbEff = Math.min(o.nb + 5, st.nbEff + 0.25); // antitrust: the power shift
      else st.nbEff += 0.1 * (o.nb - st.nbEff);
      const muB = 0.08 + 1.2 / st.nbEff;                          // concentrated regime owners
      const muN = 0.08 + 1.2 / (st.nbEff + 30 * shN);              // niche is decentralized: many small owners
      const betaR = 0.15 * (1 - shN) * muB / (1 + muB) * pE;
      const betaN = 0.15 * shN * muN / (1 + muN) * pE;
      const beta = Math.min(0.3, betaR + betaN);                  // bottleneck rent share of GDP
      const capfrac = (1 - lambda) * (1 - beta) + beta;          // profits + rents

      // ── 3. Demand closure (rich save more) ───────────────
      let sumW = 0, sumL = 0; for (let h = 0; h < H; h++) { sumW += W[h]; sumL += L[h]; }
      const sumA = sumW + sumL;
      const ybar = st.Yprev / H;
      const mpcL = 0.88;
      const mpcK = new Float64Array(H);
      let MK = 0;
      for (let h = 0; h < H; h++) { mpcK[h] = 0.7 / (1 + W[h] / (3 * ybar)); MK += mpcK[h] * (W[h] / sumA); }
      const kL = pol.route === 'republic' ? mpcL * pol.payout * (capfrac - o.sub) * (sumL / sumA) : 0;
      const k1 = mpcL * lambda * (1 - beta) + (capfrac - o.sub) * MK + kL;
      const k0 = 0.02 * sumW;
      const aut = (0.35 + st.stim) * Ypot; // investment (~18%) + government (~17%), plus any pre-election stimulus
      const iK = 0;
      const Y = Math.min(Ypot, (aut + k0) / Math.max(0.05, 1 - k1 - iK));

      // ── 4. Distribute income, consume, save ──────────────
      const wages = lambda * (1 - beta) * Y;
      const commE = pol.route === 'republic' ? 0.5 * betaN * Y : 0;   // community-owned share of niche power rents
      const capInc = (capfrac - o.sub) * Y - commE;
      const G = o.sub * Y;
      const g = new Float64Array(H);
      if (pol.route === 'status') {
        const idx = Array.from({ length: H }, (_, h) => h).sort((a, b) => W[b] - W[a]);
        const top = idx.slice(0, H * 0.2), mid = idx.slice(H * 0.2, H * 0.5), bot = idx.slice(H * 0.5);
        const give = (grp, amt) => { let sg = 0; for (const h of grp) sg += W[h] + 1e-9; for (const h of grp) g[h] += amt * (W[h] + 1e-9) / sg; };
        give(top, 0.70 * G); give(mid, 0.29 * G); give(bot, 0.01 * G);
      } else {
        const idx = Array.from({ length: H }, (_, h) => h).sort((a, b) => W[a] - W[b]);
        for (let h = 0; h < H; h++) g[h] += 0.6 * G / H;
        for (let k = 0; k < H / 2; k++) g[idx[k]] += 0.4 * G / (H / 2);
        for (let h = 0; h < H; h++) g[h] += commE / H;
      }
      const inc = new Float64Array(H);
      for (let h = 0; h < H; h++) {
        const wage = wages * s[h] / ss;
        const ci = sumA > 0 ? capInc * W[h] / sumA : 0;
        const cL = sumA > 0 ? capInc * L[h] / sumA : 0;          // stake income: reinvested except the payout share
        const div = pol.payout * cL;
        inc[h] = wage + ci + div;
        const C = mpcL * (wage + div) + mpcK[h] * ci + 0.02 * W[h];
        if (pol.route === 'status') W[h] = Math.max(0, (W[h] + wage + ci + g[h] - C) * 0.97);
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

      // ── 6. Build next year's grid (the niche competes for new capacity) ──
      const gA = Abar / st.AbarPrev - 1;
      st.Kr *= 0.967; st.Kn *= 0.96;
      const capNow = st.Kr + st.Kn;
      const target = Ed * (1 + Math.max(0, gA) + 0.01) * 1.12;
      const newB = clamp(target - capNow, 0, capNow * (0.035 + o.build + pol.buildX));
      const ready = 0.12 + 2.2 * shN + pol.support;               // local manufacturing, installers, distribution
      const sNew = Math.min(sigmoid(6 * (cR - cN * (1 - pol.support)) / cR + 2.5 * (1 - st.align) - 1.5), ready, 1);
      st.Kn += newB * sNew; st.Kr += newB * (1 - sNew); st.cumN += newB * sNew;
      const shN2 = st.Kn / (st.Kr + st.Kn);
      st.align = clamp(st.align + 0.05 * (0.9 - st.align) + 0.03 * pol.protect - pressure - 0.6 * Math.max(0, shN2 - shN), 0.05, 1);
      st.fuel *= 0.6;

      // ── 7. The evaluation function: voters judge, politicians respond ──
      const unemp = 1 - Y / Ypot0;
      const gY = Y / st.Yprev - 1;
      if (!st.norm) st.norm = { u: unemp, g: 0.02, m: 0.01 };
      const infl = 0.02 + 0.25 * (pE / st.pEprev - 1) + 0.3 * (st.norm.u - unemp) + 0.5 * st.stim;
      const sortedInc = Array.from(inc).sort((a, b) => a - b), med = sortedInc[H >> 1];
      const gMed = st.medPrev ? med / st.medPrev - 1 : 0.01;
      let pop = null, flipped = false;
      if (policy === 'democracy') {
        const lobby = 0.5 * betaR * (st.party === 'order' ? 1 : -1);   // regime owners fund the status-quo narrative
        // stakeholders defend their stakes (policy feedback: the program builds its own constituency)
        const stakeShare = sumL / (sumW + sumL + 1e-9);
        const constituency = 0.35 * stakeShare * (st.party === 'republic' ? 1 : -1);
        pop = 0.5 + 1.0 * (gY - st.norm.g) - 1.5 * (unemp - st.norm.u) - 0.8 * (infl - 0.02) + 0.6 * (gMed - st.norm.m)
          - 0.006 * st.inOffice + lobby + constituency + 0.02 * RP.gauss();
        const appeal = APPEAL.tax + (o.message === 'overthrow' ? APPEAL.overthrow : APPEAL.defend);
        pop += st.party === 'republic' ? appeal : -appeal;   // the opposition's platform pulls the other way
        st.popS = t === 0 ? pop : 0.6 * st.popS + 0.4 * pop;
        st.inOffice++;
        if (t % 4 === 3) {
          const win = st.popS + 0.03 + 0.025 * RP.gauss() > 0.5;   // incumbency advantage
          if (!win) { st.party = st.party === 'order' ? 'republic' : 'order'; st.inOffice = 0; flipped = true; }
          st.elections.push({ t, winner: st.party, flipped });
        }
        // Frey–Schneider: unpopular before an election → buy votes; after → consolidate
        const ph = (t + 1) % 4;
        st.stimPrev = st.stim;
        st.stim = (ph === 2 || ph === 3) && st.popS < 0.5 ? 0.02 : (ph === 0 && st.stimPrev > 0 ? -0.012 : 0);
      }
      st.norm.u += 0.25 * (unemp - st.norm.u); st.norm.g += 0.25 * (gY - st.norm.g); st.norm.m += 0.25 * (gMed - st.norm.m);
      st.pEprev = pE; st.AbarPrev = Abar; st.medPrev = med;

      // ── 8. Metrics ───────────────────────────────────────
      const arr = Array.from(W, (x, k) => x + L[k]);
      const sorted = arr.slice().sort((a, b) => a - b);
      let tot = 0; for (const x of sorted) tot += x;
      let b50 = 0; for (let k = 0; k < H / 2; k++) b50 += sorted[k];
      let t10 = 0; for (let k = Math.floor(H * 0.9); k < H; k++) t10 += sorted[k];
      st.hist.push({
        t, gdp: Y / st.Y0, potential: Ypot / st.Y0, unemp, gini: gini(arr),
        bottom50: b50 / tot, top10: t10 / tot, labor: lambda * (1 - beta), rent: beta,
        firms: firms.length, avgGen: firms.reduce((a, fi) => a + fi.gen * fi.f, 0), Abar,
        pE, niche: shN2, align: st.align, shortfall, infl, pop, party: st.party, stim: st.stim, flipped,
        window: st.align < 0.6, events, nb: st.nbEff,
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
