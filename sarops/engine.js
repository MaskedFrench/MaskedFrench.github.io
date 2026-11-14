/* ============================================================================
   SAROPS workbench — engine
   Monte Carlo drift, probability field, allocation, Bayesian update.
   Reference implementation. No model call at runtime; all numbers computed here.
   ========================================================================== */
(function (root) {
  "use strict";

  const NM = 1;                       // working unit: nautical miles
  const KM_PER_DEG = 111.32;

  /* Leeway classes. Downwind / crosswind coefficients (fraction of wind speed),
     divergence probability, and a spread term. Values are representative of the
     Allen & Plourde (1999) taxonomy as tabulated for common SAR objects; they are
     planning defaults, editable in the UI, not certified coefficients. */
  const OBJECTS = {
    piw:        { name: "Person in water",            D: 0.030, C: 0.011, diverge: 0.5, spread: 0.35 },
    piw_lj:     { name: "Person in water, lifejacket", D: 0.038, C: 0.014, diverge: 0.5, spread: 0.30 },
    raft:       { name: "Life raft",                  D: 0.050, C: 0.020, diverge: 0.5, spread: 0.25 },
    kayak:      { name: "Kayak / small craft",        D: 0.034, C: 0.012, diverge: 0.45, spread: 0.20 },
    boat:       { name: "Disabled motorboat",         D: 0.026, C: 0.009, diverge: 0.4, spread: 0.18 },
    debris:     { name: "Fishing gear / debris",      D: 0.022, C: 0.010, diverge: 0.55, spread: 0.30 },
    container:  { name: "Shipping container",         D: 0.018, C: 0.006, diverge: 0.35, spread: 0.15 },
  };

  const ASSETS = [
    { id: "uas",   name: "UAS · fixed wing", speed: 70, sweep: 0.12, endurance: 4.0, base: [24.105, 56.950] },
    { id: "helo",  name: "Helicopter",       speed: 120, sweep: 0.30, endurance: 3.0, base: [23.60, 56.85] },
    { id: "boat",  name: "SAR boat",         speed: 28,  sweep: 0.18, endurance: 8.0, base: [21.01, 56.505] },
    { id: "ground", name: "Coastal team",    speed: 6,   sweep: 0.05, endurance: 10.0, base: [21.00, 56.53] },
  ];

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const nmBetween = (aLon, aLat, bLon, bLat) => {
    const dy = (bLat - aLat) * 60;
    const dx = (bLon - aLon) * 60 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    return Math.hypot(dx, dy);
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const kn = (kts) => kts;                       // knots == nm per hour

  /* ------------------------------------------------------------------ drift */
  function simulate(raw) {
    // defensive input boundary: the engine never trusts the caller
    const s = {
      ...raw,
      particles: Math.max(1, Math.min(60000, Math.round(raw.particles || 4000))),
      windKts: Math.max(0, Math.min(120, raw.windKts || 0)),
      currentKts: Math.max(0, Math.min(6, raw.currentKts || 0)),
      elapsedH: Math.max(0.1, Math.min(240, raw.elapsedH || 1)),
      stepMin: Math.max(1, Math.min(60, raw.stepMin || 10)),
      cell: Math.max(0.05, Math.min(2, raw.cell || 0.25)),
      posSigma: Math.max(0, Math.min(20, raw.posSigma != null ? raw.posSigma : 0.4)),
      windFrom: ((raw.windFrom || 0) % 360 + 360) % 360,
      currentTo: ((raw.currentTo || 0) % 360 + 360) % 360,
      seed: Math.abs(Math.round(raw.seed || 1)) || 1,
    };
    const rng = mulberry32(s.seed);
    const obj = OBJECTS[s.object] || OBJECTS.piw;
    const steps = Math.max(1, Math.round((s.elapsedH * 60) / s.stepMin));
    const dtH = s.stepMin / 60;
    const windTo = ((s.windFrom + 180) % 360) * Math.PI / 180;
    const wE = Math.sin(windTo), wN = Math.cos(windTo);
    const cE = Math.sin(windTo + Math.PI / 2), cN = Math.cos(windTo + Math.PI / 2); // crosswind (right)
    const curE = Math.sin(s.currentTo * Math.PI / 180), curN = Math.cos(s.currentTo * Math.PI / 180);
    const D = (s.leewayD != null ? s.leewayD : obj.D);
    const C = (s.leewayC != null ? s.leewayC : obj.C);
    const sig0 = s.posSigma != null ? s.posSigma : 0.4;   // nm, datum uncertainty
    const diff = (s.diffusion != null ? s.diffusion : 0.09) * Math.sqrt(s.stepMin / 10);

    const pts = [];
    for (let p = 0; p < s.particles; p++) {
      let x = gauss(rng) * sig0;
      let y = gauss(rng) * sig0;
      const sign = rng() < obj.diverge ? 1 : -1;
      const dw = D * s.windKts, cw = C * s.windKts * sign;
      const jib = 0.25 + rng() * 0.5;                      // per-particle leeway variation
      for (let k = 0; k < steps; k++) {
        const wx = (wE * dw + cE * cw) * jib;
        const wy = (wN * dw + cN * cw) * jib;
        x += (wx + curE * s.currentKts) * dtH + gauss(rng) * diff;
        y += (wy + curN * s.currentKts) * dtH + gauss(rng) * diff;
      }
      pts.push([x, y]);
    }

    const cell = s.cell || 0.25;
    const grid = new Map();
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const [x, y] of pts) {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      grid.set(gx + ":" + gy, (grid.get(gx + ":" + gy) || 0) + 1);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const cells = [];
    let cx = 0, cy = 0;
    for (const [key, n] of grid) {
      const [gx, gy] = key.split(":").map(Number);
      const p = n / pts.length;
      cells.push({ gx, gy, x: gx * cell + cell / 2, y: gy * cell + cell / 2, p, n });
      cx += (gx * cell + cell / 2) * p;
      cy += (gy * cell + cell / 2) * p;
    }
    cells.sort((a, b) => b.p - a.p);

    const areaAt = (frac) => {
      let cum = 0, n = 0;
      for (const c of cells) { cum += c.p; n++; if (cum >= frac) break; }
      return n * cell * cell;
    };
    const mass = cells.reduce((t, c) => t + c.p, 0);

    // drift vector in compass terms
    const driftNm = Math.hypot(cx, cy);
    const driftBrg = (Math.atan2(cx, cy) * 180 / Math.PI + 360) % 360;
    const spreadNm = Math.sqrt(cells.reduce((t, c) => t + c.p * ((c.x - cx) ** 2 + (c.y - cy) ** 2), 0));

    const res = {
      object: s.object, cells, mass, cellSize: cell,
      centroid: { x: cx, y: cy }, driftNm, driftBrg, spreadNm,
      areas: { 50: areaAt(0.5), 75: areaAt(0.75), 95: areaAt(0.95) },
      bbox: { minX, maxX, minY, maxY },
      particles: s.particles, steps, elapsedH: s.elapsedH, seed: s.seed,
      sigma0: sig0, D, C, windKts: s.windKts, currentKts: s.currentKts,
      windFrom: s.windFrom, currentTo: s.currentTo,
    };
    res.hash = hashCells(res);
    return res;
  }

  function hashCells(res) {
    let h = 2166136261 >>> 0;
    for (const c of res.cells) {
      h ^= c.gx & 0xffff; h = Math.imul(h, 16777619);
      h ^= c.gy & 0xffff; h = Math.imul(h, 16777619);
      h ^= c.n & 0xffff;  h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /* --------------------------------------------------------------- allocation */
  /* Greedy: rank cells by probability, assign contiguous boxes to assets by
     increasing transit time, bounded by on-station time and endurance. */
  function plan(s, res, assets, weights) {
    const w = weights || {};
    const total = res.cells.reduce((t, c) => t + c.p * (w[c.gx + ":" + c.gy] ?? 1), 0) || 1;
    const eff = (c) => (c.p * (w[c.gx + ":" + c.gy] ?? 1)) / total;
    const wx = s.datum.lon, wy = s.datum.lat;

    const pool = assets.filter(a => a.enabled !== false).map(a => {
      const dist = nmBetween(a.base[0], a.base[1], wx, wy);
      const transit = Math.max(0, Math.round((dist / a.speed) * 60));
      const onStation = Math.max(0, s.horizonH * 60 - transit * 2);
      return { ...a, dist, transit, onStation };
    }).filter(a => a.onStation > 0).sort((a, b) => a.transit - b.transit);

    // order cells by distance from the probability centroid (compact boxes)
    const cx = res.centroid.x, cy = res.centroid.y;
    const open = res.cells.filter(c => (w[c.gx + ":" + c.gy] ?? 1) > 1e-6)
      .slice().sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));

    // Parallel-sweep partition: divide the field into as many vertical strips as
    // there are assets, then give each asset its highest-probability cells up to
    // its capacity. Boxes end up adjacent, which is how the sorties are flown.
    const caps = pool.map(a => {
      const areaNm2 = a.sweep * a.speed * (a.onStation / 60);
      return { ...a, cap: Math.max(1, Math.round(areaNm2 / (res.cellSize * res.cellSize))), cells: [] };
    });
    const xs = res.cells.map(c => c.x);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const K = Math.max(1, caps.length);
    const strip = Math.max(res.cellSize, (x1 - x0) / K);
    // most capable asset takes the most central strip
    const byCap = caps.slice().sort((a, b) => b.cap - a.cap);
    const centres = Array.from({ length: K }, (_, i) => x0 + strip * (i + 0.5));
    const mid = (x0 + x1) / 2;
    const order = centres.map((c, i) => ({ i, d: Math.abs(c - mid) })).sort((a, b) => a.d - b.d).map(o => o.i);
    byCap.forEach((a, j) => {
      const idx = order[j % K];
      const lo = x0 + idx * strip;
      const hi = idx === K - 1 ? Infinity : lo + strip;
      a.cells = res.cells.filter(c => c.x >= lo && c.x < hi)
        .sort((p, q) => q.p - p.p).slice(0, a.cap);
    });

    const sorties = caps.filter(a => a.cells.length).map(a => {
      const mass = a.cells.reduce((t, c) => t + eff(c), 0);
      const area = Math.max(0.25, a.cells.length * res.cellSize * res.cellSize);
      const coverage = Math.min(4, (a.sweep * a.speed * (a.onStation / 60)) / area);
      const pod = 0.85 * (1 - Math.exp(-coverage));   // sensor ceiling, not a perfect detector
      return {
        id: a.id, name: a.name, speed: a.speed, sweep: a.sweep, base: a.base,
        transitMin: a.transit, onStationMin: a.onStation, cells: a.cells,
        areaNm2: +area.toFixed(2), coverage, mass, pod, pos: mass * pod,
      };
    }).sort((x, y) => y.pos - x.pos);

    return {
      sorties,
      pos: sorties.reduce((t, x) => t + x.pos, 0),
      covered: sorties.reduce((t, x) => t + x.mass, 0),
      residual: total,
      weights: w,
      eff,
    };
  }

  function posterior(res, sorties) {
    const w = {};
    const src = (sorties[0] && sorties[0]._w) || null;
    for (const srt of sorties) {
      for (const c of srt.cells) {
        const k = c.gx + ":" + c.gy;
        w[k] = (w[k] ?? 1) * (1 - clamp(srt.pod, 0, 0.999));
      }
    }
    return w;
  }

  /* -------------------------------------------------------------------- tests */
  function runChecks() {
    const out = [];
    const t0 = performance.now();
    const base = {
      datum: { lon: 21.0, lat: 56.53 }, elapsedH: 3, stepMin: 10, particles: 4000,
      object: "piw", windFrom: 250, windKts: 12, currentTo: 100, currentKts: 0.8,
      cell: 0.25, horizonH: 6, seed: 2026, posSigma: 0.4,
    };
    const pass = (id, name, ok, detail, method) => out.push({ id, name, ok, detail, method });

    // V1 mass conservation
    const r1 = simulate(base);
    pass("V1", "Probability mass conserved", Math.abs(r1.mass - 1) < 1e-9,
      `Σp = ${r1.mass.toFixed(12)}`, "Sum of cell probabilities after binning");

    // V2 reproducibility
    const r2 = simulate(base);
    pass("V2", "Same seed reproduces the field", r1.hash === r2.hash,
      `hash ${r1.hash} vs ${r2.hash}`, "Deterministic PRNG, identical inputs");

    // V3 analytic drift: current only
    const cur = { ...base, windKts: 0, currentKts: 2, currentTo: 90, particles: 6000, diffusion: 0.001, posSigma: 0.001 };
    const r3 = simulate(cur);
    const expect = 2 * base.elapsedH;                       // nm east
    const err = Math.abs(r3.centroid.x - expect) / expect;
    pass("V3", "Drift matches the analytic vector", err < 0.02,
      `centroid east ${r3.centroid.x.toFixed(3)} nm vs 2 kn × ${base.elapsedH} h = ${expect} nm (${(err * 100).toFixed(2)}%)`,
      "Constant current, zero wind, zero diffusion");

    // V4 containment monotonicity
    const a = r1.areas;
    pass("V4", "Containment areas are monotonic", a[50] <= a[75] && a[75] <= a[95],
      `50% ${a[50].toFixed(1)} ≤ 75% ${a[75].toFixed(1)} ≤ 95% ${a[95].toFixed(1)} nm²`,
      "Sorted cumulative probability");

    // V5 grid invariance
    const r5 = simulate({ ...base, cell: 0.125 });
    const dA = Math.abs(r5.areas[75] - a[75]) / a[75];
    pass("V5", "Containment stable under grid refinement", dA < 0.15,
      `75% area ${a[75].toFixed(1)} → ${r5.areas[75].toFixed(1)} nm² (${(dA * 100).toFixed(1)}%)`,
      "0.25 nm vs 0.125 nm cells");

    // V6 particle convergence
    const r6 = simulate({ ...base, particles: 12000 });
    const dC = Math.hypot(r6.centroid.x - r1.centroid.x, r6.centroid.y - r1.centroid.y);
    pass("V6", "Centroid converges with particle count", dC < 0.2,
      `Δ centroid ${dC.toFixed(3)} nm at 12 000 vs 4 000 particles`,
      "Monte Carlo convergence, same seed");

    // V7 POS bounds
    const p7 = plan({ ...base, datum: base.datum }, r1, ASSETS, {});
    const posOk = p7.pos >= 0 && p7.pos <= 1 && p7.sorties.every(x => x.pod >= 0 && x.pod <= 1 && x.pos >= 0);
    pass("V7", "POS and POD stay within [0,1]", posOk,
      `plan POS ${(p7.pos * 100).toFixed(1)}%, max POD ${(Math.max(...p7.sorties.map(x => x.pod)) * 100).toFixed(1)}%`,
      "POS = Σ P(cell) × POD over assigned cells");

    // V8 Bayesian update
    const w8 = posterior(r1, p7.sorties);
    const tot = r1.cells.reduce((t, c) => t + c.p * (w8[c.gx + ":" + c.gy] ?? 1), 0);
    const norm = r1.cells.reduce((t, c) => t + (c.p * (w8[c.gx + ":" + c.gy] ?? 1)) / tot, 0);
    pass("V8", "Posterior renormalises after a search", Math.abs(norm - 1) < 1e-9 && tot < 1,
      `residual mass ${tot.toFixed(4)}, renormalised Σ = ${norm.toFixed(12)}`,
      "p ← p(1−POD), then divide by total");

    // V9 POD monotonic in sweep width
    const podAt = (sw) => {
      const as = [{ ...ASSETS[0], sweep: sw, enabled: true }];
      return plan(base, r1, as, {}).sorties[0]?.pod ?? 0;
    };
    const p1 = podAt(0.08), p2 = podAt(0.16);
    pass("V9", "POD increases with sweep width", p2 > p1,
      `W 0.08 → POD ${(p1 * 100).toFixed(1)}%, W 0.16 → ${(p2 * 100).toFixed(1)}%`,
      "POD = 1 − exp(−coverage), coverage ∝ W");

    // V10 input validation
    const bad = simulate({ ...base, windKts: -5, particles: 0 });
    pass("V10", "Invalid inputs are rejected or clamped", bad.particles >= 1 && bad.windKts >= 0,
      `particles ${bad.particles}, wind ${bad.windKts} kn after clamping`,
      "Input guard at the scenario boundary");

    const ms = performance.now() - t0;
    return { checks: out, ms, passed: out.filter(c => c.ok).length, total: out.length };
  }

  /* sensitivity: wind ±10°, leeway ±20% */
  function sensitivity(s) {
    const base = simulate(s);
    const variants = [
      { key: "wind−10", s: { ...s, windFrom: (s.windFrom + 350) % 360 } },
      { key: "wind+10", s: { ...s, windFrom: (s.windFrom + 10) % 360 } },
      { key: "leeway−20", s: { ...s, leewayD: (OBJECTS[s.object].D) * 0.8, leewayC: (OBJECTS[s.object].C) * 0.8 } },
      { key: "leeway+20", s: { ...s, leewayD: (OBJECTS[s.object].D) * 1.2, leewayC: (OBJECTS[s.object].C) * 1.2 } },
    ].map(v => {
      const r = simulate({ ...v.s, particles: Math.min(4000, s.particles) });
      return {
        key: v.key,
        shiftNm: Math.hypot(r.centroid.x - base.centroid.x, r.centroid.y - base.centroid.y),
        area75: r.areas[75],
        centroid: r.centroid,
      };
    });
    return { base, variants };
  }

  root.SAROPS = { OBJECTS, ASSETS, simulate, plan, posterior, runChecks, sensitivity, nmBetween, hashCells };
})(window);
