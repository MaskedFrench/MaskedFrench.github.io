/* Search planning — Monte Carlo drift, probability field, allocation.
   Same deterministic model as the reference implementation; presentation rebuilt.
   No environmental feed: wind and current are officer inputs. */

const SEARCH = {
  objects: {
    piw: { name: "Person in water", ld: 0.040, lc: 0.020, spread: 0.5 },
    piw_lj: { name: "Person in water, lifejacket", ld: 0.045, lc: 0.022, spread: 0.4 },
    raft: { name: "Life raft", ld: 0.060, lc: 0.030, spread: 0.3 },
    kayak: { name: "Kayak or small craft", ld: 0.035, lc: 0.018, spread: 0.25 },
    boat: { name: "Disabled motorboat", ld: 0.030, lc: 0.012, spread: 0.2 },
  },
  assets: {
    drone: { name: "UAS", speed: 90, sweep: 0.08, factor: 0.75 },
    water: { name: "Boat", speed: 30, sweep: 0.20, factor: 0.70 },
    ground: { name: "Ground team", speed: 5, sweep: 0.10, factor: 0.68 },
  },
  cellKm: 0.5,
  stepMin: 20,
  defaultParticles: 4000,
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
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

const KM_PER_DEG = 111.32;
const kmToLat = (km) => km / KM_PER_DEG;
const kmToLon = (km, lat) => km / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));

function searchParams() {
  const s = state.search;
  const i = inc(s.inc);
  return { s, i };
}

function runDrift() {
  const { s, i } = searchParams();
  if (!i) return null;
  const obj = SEARCH.objects[s.object];
  const ld = s.ld ?? obj.ld;
  const lc0 = s.lc ?? obj.lc;
  const rng = mulberry32(s.seed);
  const steps = Math.max(1, Math.round(s.elapsed / SEARCH.stepMin));
  const dtH = SEARCH.stepMin / 60;
  const windKmh = s.windKts * 1.852;
  const curKmh = s.curKts * 1.852;
  const windTo = ((s.windFrom + 180) % 360) * Math.PI / 180;
  const curTo = s.curTo * Math.PI / 180;
  const windE = Math.sin(windTo), windN = Math.cos(windTo);
  const crossE = Math.cos(windTo), crossN = -Math.sin(windTo);
  const curE = Math.sin(curTo), curN = Math.cos(curTo);

  const pts = [];
  for (let p = 0; p < s.particles; p++) {
    let x = gauss(rng) * obj.spread;
    let y = gauss(rng) * obj.spread;
    const div = rng() < 0.5 ? -1 : 1;
    for (let k = 0; k < steps; k++) {
      const dwn = ld * windKmh;
      const lc = lc0 * windKmh * div;
      const wx = windE * dwn + crossE * lc;
      const wy = windN * dwn + crossN * lc;
      const cx = curE * curKmh;
      const cy = curN * curKmh;
      const diff = 0.35 * Math.sqrt(SEARCH.stepMin / 20);
      x += (wx + cx) * dtH + gauss(rng) * diff;
      y += (wy + cy) * dtH + gauss(rng) * diff;
    }
    pts.push([i.lon + kmToLon(x, i.lat), i.lat + kmToLat(y)]);
  }

  const cell = SEARCH.cellKm;
  const grid = new Map();
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [lon, lat] of pts) {
    const x = (lon - i.lon) * KM_PER_DEG * Math.cos(i.lat * Math.PI / 180);
    const y = (lat - i.lat) * KM_PER_DEG;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    grid.set(gx + ":" + gy, (grid.get(gx + ":" + gy) || 0) + 1);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const cells = [];
  for (const [key, n] of grid) {
    const [gx, gy] = key.split(":").map(Number);
    cells.push({ gx, gy, x: gx * cell + cell / 2, y: gy * cell + cell / 2, p: n / pts.length, n });
  }
  cells.sort((a, b) => b.p - a.p);

  let cum = 0;
  const cont = { 50: 0, 75: 0, 95: 0 };
  let a50 = 0, a75 = 0, a95 = 0;
  for (const c of cells) {
    cum += c.p;
    if (!cont[50] && cum >= 0.5) { cont[50] = 1; a50 = areaOf(cells, 0.5); }
    if (!cont[75] && cum >= 0.75) { cont[75] = 1; a75 = areaOf(cells, 0.75); }
    if (!cont[95] && cum >= 0.95) { cont[95] = 1; a95 = areaOf(cells, 0.95); }
  }

  const res = {
    pts: pts.length, cells, bbox: { minX, maxX, minY, maxY },
    areas: { 50: Math.round(a50), 75: Math.round(a75), 95: Math.round(a95) },
    elapsed: s.elapsed, steps, seed: s.seed, object: s.object,
  };
  s.result = res;
  allocate();
  return res;
}

function areaOf(cells, frac) {
  let cum = 0, n = 0;
  for (const c of cells) { cum += c.p; n++; if (cum >= frac) break; }
  return n * SEARCH.cellKm * SEARCH.cellKm;
}

/* allocation: assets ranked by transit, then round robin over the highest probability cells.
   Completed searches reduce cell weights by (1 - detection factor); the distribution is renormalised. */
function allocate() {
  const res = state.search.result;
  if (!res) return;
  const i = inc(state.search.inc);
  const horizonH = state.search.horizonMin / 60;

  const wOf = (c) => state.search.w[c.gx + ":" + c.gy] ?? 1;
  const totalW = res.cells.reduce((sum, c) => sum + c.p * wOf(c), 0) || 1;
  const eff = (c) => (c.p * wOf(c)) / totalW;

  const pool = DATA.units
    .filter(u => SEARCH.assets[u.capability] && u.status === "available")
    .map(u => {
      const cap = SEARCH.assets[u.capability];
      const dist = km(u.lon, u.lat, i.lon, i.lat) * 1.25;
      const transitMin = Math.max(0, Math.round(dist / cap.speed * 60));
      const onStationH = Math.max(0, horizonH - transitMin / 60);
      const cellsWanted = Math.round(onStationH * cap.speed * cap.sweep / (SEARCH.cellKm * SEARCH.cellKm));
      return { u, cap, transitMin, dist: Math.round(dist), cellsWanted, cells: [] };
    })
    .filter(a => a.cellsWanted > 0)
    .sort((a, b) => a.transitMin - b.transitMin || b.cellsWanted - a.cellsWanted);

  let mx = 0, my = 0;
  let tot = 0;
  for (const c of res.cells) { const w = c.p * wOf(c); mx += c.x * w; my += c.y * w; tot += w; }
  mx /= tot || 1; my /= tot || 1;

  const open = res.cells
    .filter(c => wOf(c) > 1e-6)
    .slice()
    .sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my));

  let cursor = 0, guard = 0;
  while (guard++ < 200000) {
    let any = false;
    for (const a of pool) {
      if (a.cells.length >= a.cellsWanted) continue;
      if (cursor >= open.length) break;
      a.cells.push(open[cursor++]);
      any = true;
    }
    if (!any || cursor >= open.length) break;
  }

  const plan = pool.filter(a => a.cells.length > 0).map(a => {
    const mass = a.cells.reduce((sum, c) => sum + eff(c), 0);
    return {
      u: a.u, cap: a.cap, cells: a.cells, mass, transitMin: a.transitMin, dist: a.dist,
      pos: Math.min(1, mass * a.cap.factor),
      areaKm2: Math.round(a.cells.length * SEARCH.cellKm * SEARCH.cellKm),
    };
  }).sort((a, b) => b.pos - a.pos);

  state.search.plan = plan;
  state.search.pos = plan.reduce((sum, p) => sum + p.pos, 0);
  state.search.residual = totalW;
  state.search.cleared = 1 - totalW;
  state.search.cumPos = 1 - totalW * (1 - state.search.pos);
  state.search.effOf = eff;
}

/* ---------------- map ---------------- */
function searchMap() {
  const res = state.search.result;
  if (!res) return `<div class="mapload">Run the drift simulation to see the probability field.</div>`;
  const i = inc(state.search.inc);
  const pad = 1.6;
  const wKm = Math.max(6, res.bbox.maxX - res.bbox.minX + pad * 2);
  const hKm = Math.max(4, res.bbox.maxY - res.bbox.minY + pad * 2);
  const VW = 1000, VH = 620;
  const scale = Math.min(VW / wKm, VH / hKm);
  const cx = (res.bbox.minX + res.bbox.maxX) / 2;
  const cy = (res.bbox.minY + res.bbox.maxY) / 2;
  const ox = VW / 2 - cx * scale, oy = VH / 2 + cy * scale;
  const toX = (x) => ox + x * scale;
  const toY = (y) => oy - y * scale;

  const [clon0, clat0, clon1, clat1] = DATA.geo.bbox;
  const Klat = KM_PER_DEG * scale;
  const Klon = KM_PER_DEG * Math.cos(i.lat * Math.PI / 180) * scale;
  const KcLat = DATA.geo.h / (clat1 - clat0);
  const s2 = Klat / KcLat;
  const ctx = ox + (i.lon - clon0) * Klon;
  const cty = oy - (clat1 - i.lat) * Klat;

  const effOf = state.search.effOf || ((c) => c.p);
  const maxP = Math.max(...res.cells.map(effOf));
  const heat = res.cells.map(c => {
    const p = effOf(c);
    const w = state.search.w[c.gx + ":" + c.gy] ?? 1;
    const alpha = Math.min(0.9, 0.08 + (p / (maxP || 1)) * 0.82) * (0.25 + 0.75 * w);
    const tone = w < 0.99 ? "120,132,146" : "224,85,75";
    return `<rect x="${(toX(c.x - SEARCH.cellKm / 2)).toFixed(1)}" y="${(toY(c.y + SEARCH.cellKm / 2)).toFixed(1)}"
      width="${(SEARCH.cellKm * scale).toFixed(1)}" height="${(SEARCH.cellKm * scale).toFixed(1)}"
      fill="rgba(${tone},${alpha})" stroke="none"><title>${(p * 100).toFixed(1)}% of the distribution${w < 0.99 ? " · already searched" : ""}</title></rect>`;
  }).join("");

  const clip = `<clipPath id="viewclip"><rect x="0" y="0" width="${VW}" height="${VH}"/></clipPath>`;
  const boxes = state.search.plan.map((p, k) => {
    const xs = p.cells.map(c => c.x), ys = p.cells.map(c => c.y);
    const x0 = toX(Math.min(...xs) - SEARCH.cellKm / 2), x1 = toX(Math.max(...xs) + SEARCH.cellKm / 2);
    const y0 = toY(Math.max(...ys) + SEARCH.cellKm / 2), y1 = toY(Math.min(...ys) - SEARCH.cellKm / 2);
    const col = ["#7BD7C4", "#E0A33A", "#8FB6F0", "#C79BE0"][k % 4];
    return `<g><rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(y1 - y0).toFixed(1)}"
      fill="none" stroke="${col}" stroke-width="1.4" stroke-dasharray="6 4"/>
      <text x="${(x0 + 5).toFixed(1)}" y="${(y0 + 13 + k * 13).toFixed(1)}" fill="${col}" font-size="10"
        font-family="'IBM Plex Mono',monospace" paint-order="stroke" stroke="#0D1116" stroke-width="3" stroke-linejoin="round">${esc(p.u.callsign)} · ${Math.round(p.pos * 100)}%</text></g>`;
  }).join("");

  let cxw = 0, cyw = 0;
  for (const c of res.cells) { cxw += c.x * c.p; cyw += c.y * c.p; }
  const driftKm = Math.hypot(cxw, cyw);
  const driftBrg = (Math.atan2(cxw, cyw) * 180 / Math.PI + 360) % 360;
  const arrow = driftKm > 0.3 ? `<g>
    <line x1="${toX(0).toFixed(1)}" y1="${toY(0).toFixed(1)}" x2="${toX(cxw).toFixed(1)}" y2="${toY(cyw).toFixed(1)}"
      stroke="#9FB0C0" stroke-width="1.2" stroke-dasharray="5 3" opacity=".8"/>
    <circle cx="${toX(cxw).toFixed(1)}" cy="${toY(cyw).toFixed(1)}" r="3" fill="#9FB0C0"/>
    <text x="${(toX(cxw) + 9).toFixed(1)}" y="${(toY(cyw) - 10).toFixed(1)}" font-size="10" fill="#C9D4DE"
      font-family="'IBM Plex Mono',monospace" paint-order="stroke" stroke="#0D1116" stroke-width="3" stroke-linejoin="round">DRIFT ${driftKm.toFixed(1)} km · ${String(Math.round(driftBrg)).padStart(3, "0")}°</text></g>` : "";

  const lkp = `<g><circle cx="${toX(0).toFixed(1)}" cy="${toY(0).toFixed(1)}" r="4.5" fill="#0D1116" stroke="#fff" stroke-width="2"/>
    <text x="${(toX(0) - 9).toFixed(1)}" y="${(toY(0) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#E8E5DA"
      font-family="'IBM Plex Mono',monospace" paint-order="stroke" stroke="#0D1116" stroke-width="3" stroke-linejoin="round">LAST KNOWN POSITION</text></g>`;

  const barKm = 5, barPx = barKm * scale;
  const bar = `<g transform="translate(${VW - barPx - 24},${VH - 26})">
    <line x1="0" y1="0" x2="${barPx}" y2="0" stroke="#7C858F" stroke-width="1.2"/>
    <line x1="0" y1="-4" x2="0" y2="4" stroke="#7C858F" stroke-width="1.2"/>
    <line x1="${barPx}" y1="-4" x2="${barPx}" y2="4" stroke="#7C858F" stroke-width="1.2"/>
    <text x="${barPx / 2}" y="-7" text-anchor="middle" font-size="9.5" fill="#9FB0C0" font-family="'IBM Plex Mono',monospace">${barKm} km</text></g>`;

  const legend = `<g transform="translate(16,${VH - 38})">
    <text x="0" y="0" font-size="9" fill="#7C858F" font-family="'IBM Plex Mono',monospace" letter-spacing="1">PROBABILITY · 0.5 KM CELL</text>
    ${[0.12, 0.3, 0.5, 0.7, 0.9].map((a, k) => `<rect x="${k * 24}" y="8" width="22" height="9" fill="rgba(224,85,75,${a})"/>`).join("")}
    <text x="124" y="16" font-size="9" fill="#7C858F" font-family="'IBM Plex Mono',monospace">low → high</text></g>`;

  return `<svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Drift probability map">
    <defs>${clip}</defs>
    <rect width="${VW}" height="${VH}" fill="#0D1116"/>
    <g clip-path="url(#viewclip)">
      ${Array.from({ length: 21 }, (_, k) => `<line x1="${k * 50}" y1="0" x2="${k * 50}" y2="${VH}" stroke="#151B22" stroke-width="1"/>`).join("")}
      ${Array.from({ length: 13 }, (_, k) => `<line x1="0" y1="${k * 50}" x2="${VW}" y2="${k * 50}" stroke="#151B22" stroke-width="1"/>`).join("")}
      <g transform="translate(${ctx.toFixed(2)},${cty.toFixed(2)}) scale(${s2.toFixed(5)})" opacity=".85">
        <path d="${DATA.geo.path}" fill="#11171E" fill-opacity=".55" stroke="#5C6874" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      </g>
    </g>
    ${heat}
    ${boxes}
    ${arrow}
    ${lkp}
    ${legend}
    ${bar}
  </svg>`;
}

/* ---------------- view ---------------- */
function searchView() {
  const s = state.search;
  const i = inc(s.inc);
  const res = s.result;
  const driftable = DATA.incidents.filter(x => ["Person in water", "Flooding", "Medical evacuation"].includes(x.type));
  const obj = SEARCH.objects[s.object];
  const posPct = Math.round((s.pos || 0) * 100);
  const cumPct = Math.round((s.cumPos ?? s.pos ?? 0) * 100);

  const planRows = (s.plan || []).map((p, k) => `<div class="planrow">
      <span class="n">${k + 1}</span>
      <span><span class="cs">${esc(p.u.callsign)}</span><span class="s">${esc(p.cap.name)} · ${p.areaKm2} km² · ${p.transitMin} min transit</span></span>
      <span class="pos">${Math.round(p.pos * 100)}%<small>POS</small></span>
    </div>`).join("") || `<div class="empty">No search assets available. Every suitable team is committed.</div>`;

  const sedRows = (s.plan || []).map(p => `<div class="planrow" style="grid-template-columns:minmax(0,1fr) auto">
      <span><span class="cs">${esc(p.u.callsign)}</span><span class="s">box of ${p.areaKm2} km² · ${Math.round(p.mass * 100)}% of distribution</span></span>
      <button class="btn ghost sm" data-searched="${p.u.id}" title="Mark this box searched and recompute">Mark searched</button>
    </div>`).join("");

  return `<div class="searchshell">
    <aside class="sidepanel">
      <div class="paneh"><h2>Scenario</h2><span class="label">officer inputs</span></div>
      <div class="body">
        <div class="field"><label for="sp-inc">Incident</label>
          <select id="sp-inc">${driftable.map(x => `<option value="${x.id}" ${x.id === s.inc ? "selected" : ""}>${esc(x.id)} · ${esc(x.type)} · ${esc(x.place)}</option>`).join("")}</select></div>
        <div class="field"><label for="sp-obj">Search object</label>
          <select id="sp-obj">${Object.entries(SEARCH.objects).map(([k, v]) => `<option value="${k}" ${k === s.object ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></div>
        <div class="field-row">
          <div class="field"><label for="sp-elapsed">Drift time (min)</label><input id="sp-elapsed" type="number" min="10" max="1440" step="5" value="${s.elapsed}"></div>
          <div class="field"><label for="sp-parts">Particles</label><input id="sp-parts" type="number" min="500" max="10000" step="500" value="${s.particles}"></div>
        </div>

        <div class="sect">Environment</div>
        <div class="field-row">
          <div class="field"><label for="sp-winddir">Wind from (°)</label><input id="sp-winddir" type="number" min="0" max="359" value="${s.windFrom}"></div>
          <div class="field"><label for="sp-windspd">Wind (kt)</label><input id="sp-windspd" type="number" min="0" max="60" step="0.5" value="${s.windKts}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="sp-curdir">Current toward (°)</label><input id="sp-curdir" type="number" min="0" max="359" value="${s.curTo}"></div>
          <div class="field"><label for="sp-curspd">Current (kt)</label><input id="sp-curspd" type="number" min="0" max="5" step="0.1" value="${s.curKts}"></div>
        </div>

        <div class="sect">Leeway · planning defaults</div>
        <div class="field-row">
          <div class="field"><label for="sp-ld">Downwind</label><input id="sp-ld" type="number" min="0" max="0.2" step="0.001" value="${s.ld ?? obj.ld}"></div>
          <div class="field"><label for="sp-lc">Crosswind</label><input id="sp-lc" type="number" min="0" max="0.2" step="0.001" value="${s.lc ?? obj.lc}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="sp-horizon">Search window (min)</label><input id="sp-horizon" type="number" min="30" max="600" step="15" value="${s.horizonMin}"></div>
          <div class="field"><label for="sp-seed">Seed</label><input id="sp-seed" type="number" value="${s.seed}"></div>
        </div>
        <p class="hint">Same seed, same field. A case is reproducible from the file, not from memory.</p>
      </div>
      <div class="foot">
        <button class="btn red block" id="sp-run">Run drift simulation</button>
        <div class="row" style="margin-top:7px">
          <button class="btn ghost sm" id="sp-export" style="flex:1">Export case</button>
          <label class="btn ghost sm" style="flex:1;text-align:center;cursor:pointer">Import<input id="sp-import" type="file" accept="application/json" style="display:none"></label>
        </div>
      </div>
    </aside>

    <section class="mapdark">
      <div class="paneh">
        <h2>Drift probability ${res ? "· " + res.pts.toLocaleString() + " particles · " + Math.round(s.elapsed) + " min" : "· not run"}</h2>
        <span class="label">${i ? esc(i.id) + " · " + esc(i.place) : ""}</span>
      </div>
      <div class="mapbody">${searchMap()}</div>
      <div class="searchstats">
        <div><div class="k">Plan POS</div><div class="v">${posPct}%</div></div>
        <div><div class="k">Cumulative</div><div class="v">${cumPct}%</div></div>
        <div><div class="k">Still open</div><div class="v">${res ? Math.round((s.residual || 0) * 100) : "–"}%</div></div>
      </div>
    </section>

    <aside class="sidepanel">
      <div class="paneh"><h2>Search plan</h2><span class="label">advisory</span></div>
      <div class="body" style="padding:0">
        <div style="padding:14px">
          <div style="display:flex;align-items:baseline;gap:8px">
            <div class="display" style="font-size:40px;font-weight:600;letter-spacing:-.03em">${cumPct}%</div>
            <div class="label" style="line-height:1.4">probability<br>of success</div>
          </div>
          <p class="hint" style="margin-top:2px">Cumulative, including completed searches. This plan alone covers ${posPct}% of the ${Math.round((s.residual ?? 1) * 100)}% still open.</p>
          <div class="posbars" style="padding:12px 0 0">
            <div class="posbar"><div class="l"><span>Plan coverage</span><span>${posPct}%</span></div><div class="t"><i style="width:${posPct}%"></i></div></div>
            <div class="posbar res"><div class="l"><span>Distribution still open</span><span>${res ? Math.round((s.residual || 0) * 100) : "–"}%</span></div><div class="t"><i style="width:${res ? Math.round((s.residual || 0) * 100) : 0}%"></i></div></div>
            <div class="posbar"><div class="l"><span>Ruled out by searches</span><span>${res ? Math.round((s.cleared || 0) * 100) : "–"}%</span></div><div class="t"><i style="width:${res ? Math.round((s.cleared || 0) * 100) : 0}%"></i></div></div>
          </div>
        </div>
        <div class="planlist">${planRows}</div>
        ${sedRows ? `<div class="sect" style="padding:12px 14px 0">Record search effort</div><div class="planlist">${sedRows}</div>` : ""}
        <div class="note" style="margin-top:6px">POS = sum of P(cell) × detection factor over assigned cells. UAS 0.75, boat 0.70, ground 0.68. Distribution: 50% in ${res ? res.areas[50] : "–"} km² · 75% in ${res ? res.areas[75] : "–"} · 95% in ${res ? res.areas[95] : "–"}.</div>
      </div>
    </aside>
  </div>

  <div class="page" style="padding-top:20px">
    <div class="pagehead" style="padding-bottom:10px">
      <div><div class="eyebrow">Method and limits</div><h1 style="font-size:20px">What this model is, and what it is not</h1></div>
      <div class="right"><span class="tag amber">assumption-labelled</span></div>
    </div>
    <div class="cols2">
      <div class="card"><div class="card-b" style="font-size:12.5px;color:var(--ink-60);line-height:1.6">
        <p><b class="label-ink">Method.</b> Simplified from the US Coast Guard Search and Rescue Optimal Planning System: Monte Carlo particles advected by current plus wind leeway with divergence, 20 minute drift steps, a probability density grid, and allocation that maximises probability of success. SAROPS runs up to 10,000 particles per scenario and takes environmental data from a server; this prototype takes wind and current from the officer.</p>
        <p style="margin-top:8px"><b class="label-ink">Leeway.</b> Coefficients follow the order of the Allen and Plourde (1999) experiments, as tabulated for IAMSAR object classes. They are editable planning defaults, not certified values for any specific object or clothing state.</p>
      </div></div>
      <div class="card"><div class="card-b" style="font-size:12.5px;color:var(--ink-60);line-height:1.6">
        <p><b class="label-ink">Detection.</b> Sweep widths assume a person-sized target detected from 100 m by a UAS with on-board detection, consistent with the hardware class reported by Ciccone and Ceruti (2025), Drones 9(8):514. We do not take a measured sweep width from that paper; the values are assumptions and are labelled as such.</p>
        <p style="margin-top:8px"><b class="label-ink">Not modelled.</b> No environmental feed, no sea state, no object-specific drift validation, no helicopter or fixed-wing assets, no search fatigue, no leeway divergence distribution fitted to data. A planning demonstration, not a certified search tool.</p>
      </div></div>
    </div>
  </div>`;
}

/* ---------------- wiring ---------------- */
function wireSearch() {
  const s = state.search;
  const read = () => {
    const v = (id) => document.getElementById(id).value;
    s.inc = v("sp-inc");
    s.object = v("sp-obj");
    s.elapsed = Number(v("sp-elapsed")) || 40;
    s.particles = Math.min(10000, Math.max(500, Number(v("sp-parts")) || 4000));
    s.windFrom = Number(v("sp-winddir")) || 0;
    s.windKts = Number(v("sp-windspd")) || 0;
    s.curTo = Number(v("sp-curdir")) || 0;
    s.curKts = Number(v("sp-curspd")) || 0;
    s.horizonMin = Number(v("sp-horizon")) || 120;
    s.seed = Number(v("sp-seed")) || 2026;
    s.ld = Number(v("sp-ld"));
    s.lc = Number(v("sp-lc"));
  };
  const run = () => { read(); s.searched = {}; runDrift(); render(); };
  const b = $("#sp-run"); if (b) b.onclick = run;
  const incEl = document.getElementById("sp-inc"); if (incEl) incEl.onchange = run;
  const objEl = document.getElementById("sp-obj");
  if (objEl) objEl.onchange = () => {
    const o = SEARCH.objects[objEl.value];
    state.search.object = objEl.value;
    state.search.ld = o.ld;
    state.search.lc = o.lc;
    document.getElementById("sp-ld").value = o.ld;
    document.getElementById("sp-lc").value = o.lc;
    run();
  };

  $$("[data-searched]").forEach(btn => btn.onclick = () => {
    const p = (state.search.plan || []).find(x => x.u.id === btn.dataset.searched);
    if (!p) return;
    for (const c of p.cells) {
      const key = c.gx + ":" + c.gy;
      state.search.w[key] = (state.search.w[key] ?? 1) * (1 - p.cap.factor);
    }
    const u = unit(btn.dataset.searched);
    state.log.push({ tm: fmtClock(state.now), inc: state.search.inc, x: `${u.callsign} completed a search of ${Math.round(p.mass * 100)}% of the distribution` });
    state.decisions.push({
      t: state.now, inc: state.search.inc, rec: u.callsign, recConf: Math.round(p.pos * 100),
      callsign: u.callsign, action: "validated", reason: null, instead: null,
      evidence: [`search box of ${p.areaKm2} km² at detection factor ${p.cap.factor}`, `${Math.round(p.mass * 100)}% of the distribution inside the box`], eta: 0,
    });
    allocate(); render();
  });

  const ex = $("#sp-export");
  if (ex) ex.onclick = () => {
    const blob = new Blob([JSON.stringify({
      case: "Search case", incident: state.search.inc,
      scenario: {
        object: state.search.object, elapsed: state.search.elapsed, windFrom: state.search.windFrom,
        windKts: state.search.windKts, curTo: state.search.curTo, curKts: state.search.curKts,
        particles: state.search.particles, horizonMin: state.search.horizonMin, seed: state.search.seed,
      },
      result: state.search.result ? {
        areas: state.search.result.areas, pos: state.search.pos,
        plan: state.search.plan.map(p => ({ asset: p.u.callsign, pos: p.pos, areaKm2: p.areaKm2 })),
      } : null,
      generated: new Date().toISOString(),
    }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `lgb-search-${state.search.inc}.json`;
    a.click();
  };

  const im = $("#sp-import");
  if (im) im.onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        Object.assign(state.search, d.scenario, { searched: {}, inc: d.incident || state.search.inc });
        runDrift(); render();
      } catch (err) { alert("Case file could not be read."); }
    };
    r.readAsText(f);
  };
}
