/* SAROPS workbench — UI */
(function () {
  "use strict";
  const { OBJECTS, ASSETS, simulate, plan, posterior, runChecks, sensitivity } = window.SAROPS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const fmt = (v, d = 1) => Number(v).toFixed(d);
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";

  const state = {
    tab: "plan",
    scenario: {
      datum: { lon: 21.00, lat: 56.52 },
      object: "piw", elapsedH: 3, stepMin: 10, particles: 12000,
      windFrom: 250, windKts: 14, currentTo: 100, currentKts: 0.8,
      cell: 0.25, horizonH: 6, seed: 2026, posSigma: 0.4,
    },
    assets: ASSETS.map(a => ({ ...a, enabled: true })),
    res: null, plan: null, weights: {}, flown: [],
    checks: null, sens: null,
    ai: null,
  };

  /* ------------------------------------------------------------- rendering */
  function render() {
    $$(".tab").forEach(b => b.classList.toggle("on", b.dataset.tab === state.tab));
    $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + state.tab));
    if (state.tab === "plan") { renderMap(); renderResults(); }
    if (state.tab === "analysis") renderAnalysis();
    if (state.tab === "vv") renderChecks();
  }

  function project() {
    const r = state.res; if (!r) return null;
    const pad = 1.1;
    const minX = Math.min(r.bbox.minX, -4) - pad, maxX = Math.max(r.bbox.maxX, 4) + pad;
    const minY = Math.min(r.bbox.minY, -4) - pad, maxY = Math.max(r.bbox.maxY, 4) + pad;
    const el = document.getElementById("map");
    const W = 900;
    const H = Math.max(420, Math.min(1100, Math.round(W * ((el && el.clientHeight) || 560) / ((el && el.clientWidth) || 900))));
    const spanX = Math.max(5, maxX - minX), spanY = Math.max(4, maxY - minY);
    const s = Math.min(W / spanX, H / spanY);
    return {
      s, W, H,
      x: (x) => W / 2 + (x - (minX + maxX) / 2) * s,
      y: (y) => H / 2 - (y - (minY + maxY) / 2) * s,
      minX, maxX, minY, maxY,
    };
  }

  function renderMap() {
    const svg = $("#map"); if (!svg) return;
    const r = state.res;
    if (!r) { svg.innerHTML = ""; return; }
    const P = project();
    svg.setAttribute("viewBox", `0 0 ${P.W} ${P.H}`);
    const grid = [];
    const step = (P.maxX - P.minX) > 16 ? 4 : 2;
    for (let x = Math.ceil(P.minX / step) * step; x <= P.maxX; x += step) {
      grid.push(`<line class="g" x1="${P.x(x)}" y1="0" x2="${P.x(x)}" y2="${P.H}"/>`);
      grid.push(`<text class="gl" x="${P.x(x) + 4}" y="${P.H - 8}">${x > 0 ? "+" : ""}${x} nm</text>`);
    }
    for (let y = Math.ceil(P.minY / step) * step; y <= P.maxY; y += step) {
      grid.push(`<line class="g" x1="0" y1="${P.y(y)}" x2="${P.W}" y2="${P.y(y)}"/>`);
      grid.push(`<text class="gl" x="6" y="${P.y(y) - 4}">${y > 0 ? "+" : ""}${y} nm</text>`);
    }
    const mx = Math.max(...r.cells.map(c => c.p));
    const heat = r.cells.map(c => {
      const w = state.weights[c.gx + ":" + c.gy] ?? 1;
      const a = Math.min(.92, .06 + (c.p / mx) * .86) * (w < .99 ? .35 : 1);
      const tone = w < .99 ? "120,132,150" : "63,107,255";
      const size = r.cellSize * P.s;
      return `<rect x="${P.x(c.x - r.cellSize / 2)}" y="${P.y(c.y + r.cellSize / 2)}" width="${size}" height="${size}" fill="rgba(${tone},${a})"><title>${pct(c.p)} · ${w < .99 ? "searched" : "open"}</title></rect>`;
    }).join("");

    const circles = [95, 75, 50].map((q, i) => {
      const rad = Math.sqrt(r.areas[q] / Math.PI) * P.s;
      return `<circle cx="${P.x(r.centroid.x)}" cy="${P.y(r.centroid.y)}" r="${rad}" fill="none" stroke="rgba(201,214,230,${.18 + i * .12})" stroke-dasharray="5 5"/>
        <text class="cl" x="${P.x(r.centroid.x) + rad + 4}" y="${P.y(r.centroid.y) - 4}">${q}%</text>`;
    }).join("");

    const boxes = (state.plan ? state.plan.sorties : []).map((srt, k) => {
      if (!srt.cells.length) return "";
      const xs = srt.cells.map(c => c.x), ys = srt.cells.map(c => c.y);
      const x0 = P.x(Math.min(...xs) - r.cellSize / 2), x1 = P.x(Math.max(...xs) + r.cellSize / 2);
      const y0 = P.y(Math.max(...ys) + r.cellSize / 2), y1 = P.y(Math.min(...ys) - r.cellSize / 2);
      const col = ["#E9F35F", "#A9BAFF", "#5FE0A8", "#FFB37B"][k % 4];
      return `<g><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${col}" stroke-width="1.3" stroke-dasharray="6 4"/>
        <text class="bl" x="${x0 + 5}" y="${y0 + 13 + (k % 2) * 12}" fill="${col}">${srt.name.split("·")[0].trim()} · ${pct(srt.pod, 0)}</text></g>`;
    }).join("");

    const datum = `<g><circle cx="${P.x(0)}" cy="${P.y(0)}" r="${Math.max(6, (r.sigma0 || .4) * P.s)}" fill="none" stroke="#fff" stroke-width="0.8" stroke-dasharray="2 3" opacity=".55"/>
      <circle cx="${P.x(0)}" cy="${P.y(0)}" r="4" fill="#0B1017" stroke="#fff" stroke-width="1.3"/>
      <path d="M${P.x(0) - 9} ${P.y(0)}h18M${P.x(0)} ${P.y(0) - 9}v18" stroke="#fff" stroke-width="1" opacity=".7"/>
      <text class="dl" x="${P.x(0) + 9}" y="${P.y(0) - 9}">DATUM</text></g>`;

    const drift = r.driftNm > .05 ? `<g>
      <line x1="${P.x(0)}" y1="${P.y(0)}" x2="${P.x(r.centroid.x)}" y2="${P.y(r.centroid.y)}" stroke="#E9F35F" stroke-width="1.4" stroke-dasharray="4 3"/>
      <circle cx="${P.x(r.centroid.x)}" cy="${P.y(r.centroid.y)}" r="4" fill="#E9F35F"/>
      <text class="dl" x="${P.x(r.centroid.x) + 8}" y="${P.y(r.centroid.y) + 4}" fill="#E9F35F">CENTROID · ${fmt(r.driftNm)} nm ${String(Math.round(r.driftBrg)).padStart(3, "0")}°</text></g>` : "";

    const scale = 2 * P.s;
    svg.innerHTML = `<rect width="${P.W}" height="${P.H}" fill="#0B1017"/>${grid.join("")}${heat}
      ${circles}${boxes}${drift}${datum}
      <g transform="translate(${P.W - scale - 26},${P.H - 26})">
        <line x1="0" y1="0" x2="${scale}" y2="0" stroke="#8C94A3" stroke-width="1.2"/>
        <line x1="0" y1="-4" x2="0" y2="4" stroke="#8C94A3"/><line x1="${scale}" y1="-4" x2="${scale}" y2="4" stroke="#8C94A3"/>
        <text class="gl" x="${scale / 2}" y="-7" text-anchor="middle">2 nm</text></g>`;
  }

  function renderResults() {
    const r = state.res, p = state.plan;
    const el = $("#results");
    if (!el) return;
    if (!r) { el.innerHTML = `<p class="hint">Run the drift simulation.</p>`; return; }
    const rows = p ? p.sorties.map(s => `
      <tr><td>${s.name}</td><td class="mono">${s.transitMin}′</td><td class="mono">${fmt(s.areaNm2, 1)}</td>
      <td class="mono">${fmt(s.coverage, 2)}</td><td class="mono">${pct(s.pod, 0)}</td><td class="mono strong">${pct(s.pos, 1)}</td></tr>`).join("") : "";
    el.innerHTML = `
      <div class="kpis">
        <div><span>Drift</span><b>${fmt(r.driftNm)} <i>nm</i></b><em>${String(Math.round(r.driftBrg)).padStart(3, "0")}° true</em></div>
        <div><span>Spread σ</span><b>${fmt(r.spreadNm)} <i>nm</i></b><em>${fmt(r.areas[75], 1)} nm² · 75%</em></div>
        <div><span>Plan POS</span><b>${p ? pct(p.pos, 0) : "—"}</b><em>${p ? p.sorties.length + (p.sorties.length === 1 ? " sortie" : " sorties") : "not allocated"}</em></div>
        <div><span>Residual</span><b>${p ? pct(1 - p.pos, 0) : "100%"}</b><em>after this plan</em></div>
      </div>
      <table class="t">
        <thead><tr><th>Asset</th><th>Transit</th><th>nm²</th><th>C</th><th>POD</th><th>POS</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="dim">No sorties — allocate a plan.</td></tr>`}</tbody>
      </table>
      <div class="contain">
        ${[50, 75, 95].map(q => `<div><span>${q}% containment</span><b>${fmt(r.areas[q], 1)} nm²</b></div>`).join("")}
      </div>`;
  }

  /* --------------------------------------------------------------- analysis */
  function buildAnalysis() {
    const r = state.res, p = state.plan, sc = state.scenario, o = OBJECTS[sc.object];
    if (!r) return null;
    const items = [];
    const add = (kind, title, body, method, conf) => items.push({ kind, title, body, method, conf });

    add("finding", "The field is drifting, not sitting still",
      `With wind ${sc.windKts} kn from ${String(sc.windFrom).padStart(3, "0")}° and current ${fmt(sc.currentKts, 1)} kn toward ${String(sc.currentTo).padStart(3, "0")}°, the ensemble centroid has moved <b>${fmt(r.driftNm)} nm</b> on bearing <b>${String(Math.round(r.driftBrg)).padStart(3, "0")}°</b> in ${fmt(sc.elapsedH, 0)} h. A search drawn on the datum would cover the least likely water.`,
      "Monte Carlo drift, " + r.particles.toLocaleString() + " particles · Kratzke et al. 2010", 0.9);

    add("finding", "Containment is tight enough to plan against",
      `Half the probability sits inside <b>${fmt(r.areas[50], 1)} nm²</b>, 75% inside ${fmt(r.areas[75], 1)} nm². ${r.areas[75] < 60 ? "That is a plan-able area with one or two assets." : "That is a large area; a single asset cannot cover it with useful POD."}`,
      "Cumulative cell probability; equal-area circles drawn on the chart", 0.85);

    if (!p) {
      add("refusal", "No plan exists yet — the assistant will not invent one",
        `Evidence is available, but no allocation has been run. Ranking assets before allocation would be a guess dressed as advice. Allocate a plan first.`,
        "Refusal rule: no recommendation without an allocation", 1);
    } else {
      const best = p.sorties.slice().sort((a, b) => b.pos - a.pos)[0];
      add("finding", `The plan covers ${pct(p.pos, 0)} of the distribution`,
        `${p.sorties.length} sortie${p.sorties.length === 1 ? "" : "s"}. The strongest is <b>${best.name}</b> at ${pct(best.pod, 0)} POD over ${fmt(best.areaNm2, 1)} nm², contributing ${pct(best.pos, 1)} POS. Residual after the plan: <b>${pct(1 - p.pos, 0)}</b>.`,
        "POS = Σ P(cell) × POD; POD = 1 − exp(−coverage)", 0.8);

      const late = p.sorties.filter(s => s.transitMin * 2 > sc.horizonH * 60);
      if (late.length) {
        add("warning", "At least one asset cannot get there and back inside the window",
          `${late.map(s => s.name + " (" + s.transitMin + "′ transit)").join(", ")} — round trip exceeds the ${fmt(sc.horizonH, 0)} h horizon. The allocation still counts its coverage, so treat the plan POS as optimistic.`,
          "Transit feasibility check against the planning horizon", 0.95);
      }
      const weak = p.sorties.filter(s => s.pod < 0.2);
      if (weak.length) {
        add("warning", "Low-POD sorties are consuming probability mass",
          `${weak.map(s => s.name).join(", ")} cover cells with POD under 20%. Re-tasking them to the densest cells would raise POS, or they should be stood down.`,
          "Marginal POD check", 0.7);
      }
    }

    if (state.sens) {
      const worst = state.sens.variants.slice().sort((a, b) => b.shiftNm - a.shiftNm)[0];
      add("finding", "The answer is sensitive to the wind, and you should say by how much",
        `Perturbing wind by ±10° or leeway by ±20% moves the centroid by at most <b>${fmt(worst.shiftNm, 2)} nm</b> (${worst.key}). That is ${worst.shiftNm < 1 ? "inside" : "outside"} one grid cell at ${fmt(r.cellSize, 2)} nm, so ${worst.shiftNm < 1 ? "the search boxes remain valid" : "the boxes should be widened or the plan re-run before tasking"}.`,
        "One-at-a-time sensitivity, 4 perturbations", 0.75);
    } else {
      add("refusal", "Sensitivity has not been run",
        `Without the ±10° wind and ±20% leeway perturbations, the assistant cannot say whether the search boxes survive a small change in the forecast. Run it before tasking.`,
        "Refusal rule: uncertainty must be demonstrated, not assumed", 1);
    }

    if (sc.windKts < 3 && sc.currentKts < 0.2) {
      add("refusal", "Environment is too quiet to trust a drift field",
        `Wind ${sc.windKts} kn and current ${fmt(sc.currentKts, 1)} kn produce a field dominated by the initial datum uncertainty, not by drift. The correct output is a datum-centred search, not a drift plan.`,
        "Variance decomposition: diffusion + datum σ exceed advection", 0.9);
    }

    return items;
  }

  function renderAnalysis() {
    const el = $("#analysis"); if (!el) return;
    const items = buildAnalysis();
    if (!items) { el.innerHTML = `<div class="empty">Run a simulation first — the analysis reads the field, it does not guess.</div>`; return; }
    el.innerHTML = `
      <div class="ai-head">
        <div><span class="lbl">AI analysis</span><h2>What the model says, and what it refuses to say</h2></div>
        <div class="ai-note">Rule-based analysis over the computed field · no language model at runtime · every statement carries its method</div>
      </div>
      <div class="ai-list">
        ${items.map(i => `<article class="ai-item ${i.kind}">
          <div class="ai-kind">${i.kind === "finding" ? "FINDING" : i.kind === "warning" ? "WARNING" : "REFUSAL"}</div>
          <h3>${i.title}</h3>
          <p>${i.body}</p>
          <div class="ai-foot"><span>${i.method}</span><span class="conf">confidence ${pct(i.conf, 0)}</span></div>
        </article>`).join("")}
      </div>`;
  }

  /* ------------------------------------------------------------------- V&V */
  function renderChecks() {
    if (!state.checks) state.checks = runChecks();
    drawChecks();
  }

  function drawChecks() {
    const c = state.checks; const el = $("#checks"); if (!el || !c) return;
    el.innerHTML = `
      <div class="check-sum">
        <b>${c.passed}/${c.total}</b> checks pass <span>· ${fmt(c.ms, 0)} ms in this browser</span>
      </div>
      <table class="t checks">
        <thead><tr><th>ID</th><th>Check</th><th>Evidence</th><th>Result</th></tr></thead>
        <tbody>${c.checks.map(x => `<tr class="${x.ok ? "ok" : "bad"}">
          <td class="mono">${x.id}</td>
          <td>${x.name}<span class="m">${x.method}</span></td>
          <td class="mono ev">${x.detail}</td>
          <td class="res">${x.ok ? "PASS" : "FAIL"}</td></tr>`).join("")}</tbody>
      </table>`;
  }

  function runAndShow() {
    state.checks = runChecks();
    drawChecks();
    flash(`Verification suite: ${state.checks.passed}/${state.checks.total} pass in ${fmt(state.checks.ms, 0)} ms`);
  }

  /* ---------------------------------------------------------------- actions */
  function runDrift() {
    const sc = state.scenario;
    state.res = simulate(sc);
    state.weights = {}; state.plan = null; state.sens = null; state.flown = [];
    render();
  }
  function allocate() {
    if (!state.res) runDrift();
    state.plan = plan(state.scenario, state.res, state.assets, state.weights);
    render();
  }
  function execute() {
    if (!state.plan) return;
    const w = posterior(state.res, state.plan.sorties);
    Object.assign(state.weights, w);
    state.flown.push(...state.plan.sorties.map(s => s.name));
    state.plan = plan(state.scenario, state.res, state.assets, state.weights);
    render();
    flash("Sorties executed · posterior updated · plan recomputed on the remaining mass.");
  }
  function runSens() {
    if (!state.res) runDrift();
    state.sens = sensitivity(state.scenario);
    if (state.tab !== "analysis") state.tab = "analysis";
    render();
  }
  function flash(msg) {
    const el = $("#flash"); if (!el) return;
    el.textContent = msg; el.classList.add("on");
    clearTimeout(flash.t); flash.t = setTimeout(() => el.classList.remove("on"), 3200);
  }

  /* ------------------------------------------------------------------ wiring */
  function bind() {
    $$(".tab").forEach(b => b.onclick = () => { state.tab = b.dataset.tab; render(); });
    const form = $("#scenario");
    const sync = () => {
      const v = (id) => $("#" + id).value;
      state.scenario.object = v("object");
      state.scenario.elapsedH = +v("elapsed") || 1;
      state.scenario.windFrom = +v("windFrom") || 0;
      state.scenario.windKts = Math.max(0, +v("windKts") || 0);
      state.scenario.currentTo = +v("currentTo") || 0;
      state.scenario.currentKts = Math.max(0, +v("currentKts") || 0);
      state.scenario.particles = Math.max(500, Math.min(30000, +v("particles") || 12000));
      state.scenario.horizonH = Math.max(1, +v("horizon") || 6);
      state.scenario.seed = +v("seed") || 1;
    };
    if (form) form.oninput = () => { sync(); };
    $("#run").onclick = () => { sync(); runDrift(); };
    $("#alloc").onclick = () => { sync(); allocate(); };
    $("#exec").onclick = () => execute();
    $("#sens").onclick = () => runSens();
    $("#reset").onclick = () => { state.weights = {}; state.plan = null; state.flown = []; render(); flash("Plan reset · open probability restored."); };
    document.addEventListener("click", (e) => {
      if (e.target && e.target.id === "runchecks") runAndShow();
    });
  }

  /* -------------------------------------------------------------------- boot */
  document.addEventListener("DOMContentLoaded", () => {
    bind();
    runDrift();
    state.checks = runChecks();
    render();
  });
})();
