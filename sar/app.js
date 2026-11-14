/* National SAR Crisis Management Centre — console logic
   Offline build: data inlined in data.js, no fetch, no external calls. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const DATA = window.SAR_DATA;
let P = null;

const state = {
  view: "command",
  sel: "INC-0441",
  pri: "all",
  coverage: false,
  now: 0,
  log: [],
  closed: 0,
  ov: null,
  decisions: [],
  search: {
    inc: "INC-0443", object: "piw", ld: 0.04, lc: 0.02, elapsed: 90, windFrom: 250, windKts: 12,
    curTo: 100, curKts: 0.8, particles: 4000, horizonMin: 120, seed: 2026,
    result: null, plan: [], w: {}, pos: 0, residual: 1, cleared: 0,
  },
};

/* ---------------- time + geo ---------------- */
const START_MIN = 6 * 60 + 40;
const fmtClock = (m) => {
  const t = ((START_MIN + m) % 1440 + 1440) % 1440;
  const h = Math.floor(t / 60), mm = Math.round(t % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

function projection() {
  const [lon0, lat0, lon1, lat1] = DATA.geo.bbox;
  const latm = (lat0 + lat1) / 2;
  const k = DATA.geo.w / ((lon1 - lon0) * Math.cos(latm * Math.PI / 180));
  return {
    x: (lon) => (lon - lon0) * Math.cos(latm * Math.PI / 180) * k,
    y: (lat) => (lat1 - lat) * k,
    pxPerKm: DATA.geo.h / (lat1 - lat0) / 111,
    w: DATA.geo.w, h: DATA.geo.h,
  };
}

function km(aLon, aLat, bLon, bLat) {
  const R = 6371, dLat = (bLat - aLat) * Math.PI / 180, dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const roadKm = (d) => d * 1.25;
const etaMin = (u, i) => Math.max(4, Math.round(roadKm(km(u.lon, u.lat, i.lon, i.lat)) / u.speed * 60));

const inc = (id) => DATA.incidents.find(i => i.id === id);
const unit = (id) => DATA.units.find(u => u.id === id);
const openIncidents = () => DATA.incidents.filter(i => i.status !== "closed");

function slaLeft(i) {
  if (i.status === "closed") return null;
  return i.slaMin - (i.reportedMinAgo + state.now);
}
function slaTxt(i) {
  const left = slaLeft(i);
  if (left === null) return "closed";
  const a = Math.abs(left), h = Math.floor(a / 60), m = Math.round(a % 60);
  const body = h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  return left < 0 ? `+${body}` : body;
}
function slaClass(i) {
  const left = slaLeft(i);
  if (left === null) return "done";
  if (left < 0 || left <= i.slaMin * 0.25) return "crit";
  if (left <= i.slaMin * 0.5) return "warn";
  return "";
}
function slaPct(i) {
  const left = slaLeft(i);
  if (left === null) return 0;
  return Math.max(0, Math.min(100, (left / i.slaMin) * 100));
}

const capName = (c) => DATA.capabilities[c] || c;
const PRI_ORDER = { P1: 0, P2: 1, P3: 2 };
const CAP_PHRASE = {
  usar: "urban search and rescue", k9: "search dog", drone: "UAS", water: "water rescue",
  medical: "critical care", logistics: "logistics", ground: "ground search",
};
const capPhrase = (c) => CAP_PHRASE[c] || c;

const REASONS = {
  proximity: "Closer asset overlooked",
  capability: "Better capability fit",
  fatigue: "Crew fatigue",
  local: "Local knowledge",
  other: "Other",
};

function candidates(i) {
  return DATA.units
    .filter(u => u.status === "available" || u.assignedTo === i.id)
    .map(u => {
      const eta = u.assignedTo === i.id
        ? Math.max(0, (u.etaMin || 0) - (state.now - (u.assignedAt || 0)))
        : etaMin(u, i);
      const match = i.needs.filter(n => n === u.capability).length;
      return { u, eta, match, dist: Math.round(roadKm(km(u.lon, u.lat, i.lon, i.lat))) };
    })
    .sort((a, b) => (b.match - a.match) || (a.eta - b.eta));
}

function confidence(u, i) {
  const match = i.needs.length ? i.needs.filter(n => n === u.capability).length / i.needs.length : 0;
  const eta = etaMin(u, i);
  const left = Math.max(1, slaLeft(i) ?? i.slaMin);
  const etaScore = Math.max(0, Math.min(1, 1 - eta / left));
  const fatigueScore = u.fatigue < 40 ? 1 : u.fatigue < 60 ? 0.5 : 0;
  let c = 0.35 + 0.35 * match + 0.25 * etaScore + 0.05 * fatigueScore;
  if (eta > left) c -= 0.15;
  if (match === 0) c -= 0.1;
  return Math.round(Math.min(95, Math.max(18, c * 100)));
}
const confClass = (c) => c >= 75 ? "hi" : c >= 55 ? "mid" : "lo";

function evidenceList(u, i) {
  const eta = etaMin(u, i);
  const left = Math.max(0, slaLeft(i) ?? i.slaMin);
  const match = i.needs.filter(n => n === u.capability).length;
  const ev = [
    `${eta} min to scene against ${Math.round(left)} min left in the window`,
    match ? `carries ${capPhrase(u.capability)}` : `no direct capability match (needs ${i.needs.map(capName).join(", ")})`,
    `crew fatigue ${u.fatigue}%, ${u.comms} comms`,
    `${Math.round(roadKm(km(u.lon, u.lat, i.lon, i.lat)))} km by road from ${u.base}`,
  ];
  if (u.fatigue >= 60) ev.push("fatigue above the 60% tasking threshold: officer sign-off required");
  return ev;
}

function refusalFor(i, list) {
  if (!list.length) return "No available team in the country matches this incident.";
  const best = list[0];
  const left = Math.max(0, slaLeft(i) ?? i.slaMin);
  if (best.match === 0) return `No available team carries ${i.needs.map(capName).join(" or ")}. The closest asset is ${best.u.callsign}, ${best.eta} min away and the wrong capability for the task.`;
  if (list.every(c => c.eta > left)) return `Every viable team arrives after the ${Math.round(left)} minutes left in the response window. Nearest is ${best.u.callsign} at ${best.eta} min.`;
  return null;
}

/* regions / gaps */
function gaps() {
  const out = [];
  DATA.regions.forEach(r => {
    Object.keys(DATA.capabilities).forEach(cap => {
      const n = DATA.units.filter(u => u.status === "available" && u.capability === cap &&
        km(u.lon, u.lat, ...regionPoint(r)) <= 120).length;
      if (n < 2) out.push({ region: r, cap, count: n });
    });
  });
  return out;
}
function nearest(cap, region) {
  const [lon, lat] = regionPoint(region);
  let best = null;
  DATA.units.filter(u => u.capability === cap).forEach(u => {
    const d = Math.round(km(u.lon, u.lat, lon, lat));
    if (!best || d < best.km) best = { u, km: d, status: u.status };
  });
  return best;
}
function regionPoint(region) {
  const cities = DATA.cities.filter(c => c.region === region);
  if (!cities.length) return [24.1, 56.95];
  const lon = cities.reduce((s, c) => s + c.lon, 0) / cities.length;
  const lat = cities.reduce((s, c) => s + c.lat, 0) / cities.length;
  return [lon, lat];
}
function unitOffsets() {
  const m = {};
  DATA.units.forEach((u, i) => {
    const near = DATA.units.filter(x => x.id !== u.id && Math.hypot(x.lon - u.lon, x.lat - u.lat) < 0.03);
    if (!near.length) return;
    const k = near.findIndex(x => x.id === u.id);
    const ang = (k < 0 ? i : k) * 2.2;
    m[u.id] = [Math.cos(ang) * 7, Math.sin(ang) * 7];
  });
  return m;
}

/* ---------------- operational map ---------------- */
function mapSvg() {
  const g = DATA.geo, px = P;
  const compact = window.innerWidth < 720;
  const OFFSET = unitOffsets();
  const grid = [];
  const [lon0, lat0, lon1, lat1] = g.bbox;
  for (let lon = Math.ceil(lon0); lon <= Math.floor(lon1); lon++) {
    const x = px.x(lon);
    grid.push(`<line class="grid" x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${px.h}"/>`);
    grid.push(`<text class="gridlab" x="${(x + 4).toFixed(1)}" y="${px.h - 6}">${esc(Math.abs(lon))}°E</text>`);
  }
  for (let lat = Math.ceil(lat0); lat <= Math.floor(lat1); lat++) {
    const y = px.y(lat);
    grid.push(`<line class="grid" x1="0" y1="${y.toFixed(1)}" x2="${px.w}" y2="${y.toFixed(1)}"/>`);
    grid.push(`<text class="gridlab" x="6" y="${(y - 4).toFixed(1)}">${esc(Math.abs(lat))}°N</text>`);
  }

  const cov = state.coverage
    ? `<g>${DATA.units.filter(u => u.status === "available").map(u =>
        `<circle class="cov" cx="${px.x(u.lon).toFixed(1)}" cy="${px.y(u.lat).toFixed(1)}" r="${(60 * px.pxPerKm).toFixed(0)}"/>`).join("")}</g>`
    : "";

  const cityLabels = DATA.cities.filter(c => (compact ? c.rank === 1 : true)).map(c => {
    const x = px.x(c.lon), y = px.y(c.lat);
    const dot = `<circle class="city" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${c.rank === 1 ? 1.9 : 1.2}"/>`;
    if (compact && c.rank > 1) return dot;
    return `${dot}${c.rank === 1 ? `<text class="citylab" x="${(x + 5).toFixed(1)}" y="${(y + 2.6).toFixed(1)}">${esc(c.name)}</text>` : ""}`;
  }).join("");

  const links = DATA.units.filter(u => u.assignedTo && u.status === "enroute").map(u => {
    const i = inc(u.assignedTo);
    if (!i) return "";
    const [dx, dy] = OFFSET[u.id] || [0, 0];
    return `<line class="link" x1="${(px.x(u.lon) + dx).toFixed(1)}" y1="${(px.y(u.lat) + dy).toFixed(1)}" x2="${px.x(i.lon).toFixed(1)}" y2="${px.y(i.lat).toFixed(1)}"/>`;
  }).join("");

  const units = DATA.units.map(u => {
    const [dx, dy] = OFFSET[u.id] || [0, 0];
    const x = px.x(u.lon) + dx, y = px.y(u.lat) + dy;
    const s = compact ? 5 : 3.6;
    const title = `${u.callsign} · ${u.status.toUpperCase()} · ${u.base}${u.assignedTo ? " · " + u.assignedTo : ""}`;
    return `<rect class="unit ${u.status}" x="${(x - s / 2).toFixed(1)}" y="${(y - s / 2).toFixed(1)}" width="${s}" height="${s}"><title>${esc(title)}</title></rect>`;
  }).join("");

  const incidents = openIncidents().map(i => {
    const x = px.x(i.lon), y = px.y(i.lat);
    const sel = i.id === state.sel;
    const r = compact ? (sel ? 6.5 : 5) : (sel ? 5.2 : 3.8);
    return `${sel ? `<circle class="inc-halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13"/>` : ""}
      <circle class="inc-r ${i.priority} ${i.status}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}">
        <title>${esc(i.priority + " · " + i.id + " · " + i.title)}</title>
      </circle>
      ${sel ? `<text class="inc-label" x="${(x + 8).toFixed(1)}" y="${(y - 7).toFixed(1)}">${esc(i.id)} · ${esc(i.priority)}</text>` : ""}`;
  }).join("");

  return `<svg viewBox="-6 -6 ${px.w + 12} ${px.h + 12}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Operational map of Latvia, units and open incidents">
    <rect x="-6" y="-6" width="${px.w + 12}" height="${px.h + 12}" fill="#0D1116"/>
    ${grid}
    <g opacity=".5">${Array.from({ length: 26 }, (_, k) => `<line class="grid" x1="${k * 40}" y1="0" x2="${k * 40}" y2="${px.h}" stroke="#141A21"/>`).join("")}</g>
    <path class="land" d="${g.path}"/>
    ${cov}
    ${cityLabels}
    ${links}
    ${incidents}
    ${units}
  </svg>`;
}

/* ---------------- views ---------------- */
function activity() {
  const events = [];
  openIncidents().forEach(i => events.push({ t: -i.reportedMinAgo, x: `${i.id} reported · ${i.title}` }));
  state.log.forEach(l => events.push({ t: l.tm, x: `${l.inc} · ${l.x}` }));
  events.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return events.slice(0, 7).map(e =>
    `<div class="act"><span class="tm">${esc(typeof e.t === "number" ? fmtClock(e.t) : e.t)}</span><span>${esc(e.x)}</span></div>`).join("");
}

function regionStrip() {
  return DATA.regions.map(r => {
    const open = openIncidents().filter(i => i.region === r).length;
    const avail = DATA.units.filter(u => u.region === r && u.status === "available").length;
    return `<span class="rchip"><span class="dot ${avail === 0 ? "gap" : ""}"></span><b>${esc(r)}</b> ${open} open · ${avail} free</span>`;
  }).join("");
}

function queueRow(i) {
  const sel = i.id === state.sel ? "on" : "";
  return `<button class="qi ${sel}" data-p="${i.priority}" data-inc="${i.id}">
    <span class="stripe"></span>
    <span class="b">
      <span class="l1"><span class="id">${i.id} · ${fmtClock(-i.reportedMinAgo)}</span>
        <span class="sla ${slaClass(i)}" data-sla="${i.id}">${slaTxt(i)}</span></span>
      <span class="t">${esc(i.title)}</span>
      <span class="m"><span class="tag ${i.priority === "P1" ? "red" : i.priority === "P2" ? "amber" : "teal"}">${i.priority}</span>
        <span>${esc(i.place)}</span>
        <span class="tag ghost">${i.needs.map(capName).join(" · ")}</span></span>
    </span></button>`;
}

function queue() {
  let list = openIncidents().slice();
  if (state.pri !== "all") list = list.filter(i => i.priority === state.pri);
  list.sort((a, b) => (PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) || (slaLeft(a) - slaLeft(b)));
  return list.map(queueRow).join("") || `<div class="empty">No open incidents in this filter.</div>`;
}

function detailPanel() {
  const i = inc(state.sel);
  if (!i) return `<div class="empty">Select an incident from the queue.</div>`;

  if (i.status === "closed") {
    return `<div class="dhead"><span class="pill st">CLOSED</span><span class="mono dim" style="font-size:10px">${i.id}</span></div>
      <h3>${esc(i.title)}</h3>
      <div class="place">${esc(i.place)} · ${esc(i.region)}</div>
      <p class="body">${esc(i.detail)}</p>
      <div class="sect">Outcome</div>
      <div class="kv">
        <div class="k">Response</div><div>${i.responseMin != null ? i.responseMin + " min to first asset" : "not recorded"}</div>
        <div class="k">Closed in</div><div>${i.closedInMin != null ? i.closedInMin + " min" : "—"}</div>
        <div class="k">Against SLA</div><div>${i.responseMin != null ? (i.responseMin <= i.slaMin ? "within target" : "outside target") : "—"}</div>
      </div>`;
  }

  const needs = i.needs.map(n => {
    const has = DATA.units.some(u => u.status === "available" && u.capability === n && km(u.lon, u.lat, i.lon, i.lat) <= 150);
    return `<span class="nchip ${has ? "" : "miss"}">${esc(capName(n))}${has ? "" : " · none in range"}</span>`;
  }).join("");

  const list = candidates(i).map(c => ({ ...c, conf: confidence(c.u, i) })).sort((a, b) => b.conf - a.conf).slice(0, 4);
  const decline = refusalFor(i, list);
  const can = i.status === "new" || i.status === "assigned";

  const recs = list.map((c, idx) => {
    const within = c.eta <= Math.max(0, slaLeft(i) ?? i.slaMin);
    const isBest = idx === 0 && c.match > 0 && within && !decline;
    return `<div class="cand ${isBest ? "best" : ""}">
      <div class="crow">
        <div>
          <div class="cs">${esc(c.u.callsign)}
            <span class="conf ${confClass(c.conf)}">${c.conf}%</span>
            ${isBest ? '<span class="besttag">Assistant pick</span>' : ""}</div>
          <div class="sub">${esc(c.u.base)} · ${c.match ? "capability match" : "no direct match"} · fatigue ${c.u.fatigue}%
            ${c.eta > Math.max(0, slaLeft(i) ?? i.slaMin) ? ' <span class="late">arrives after the window</span>' : ""}</div>
        </div>
        <div class="eta">${c.eta}<small>min ETA</small></div>
      </div>
      <ul class="ev">${evidenceList(c.u, i).map(e => `<li>${esc(e)}</li>`).join("")}</ul>
      <div class="cacts">
        ${c.u.assignedTo === i.id
          ? `<span class="assignedchip">Tasked · on the board</span>`
          : isBest
            ? `<button class="btn assign" data-validate="${c.u.id}" data-to="${i.id}" ${can ? "" : "disabled"}>Validate and task</button>`
            : `<button class="btn ovbtn" data-override="${c.u.id}" data-to="${i.id}" data-rec="${esc(list[0].u.callsign)}" data-conf="${list[0].conf}" ${can ? "" : "disabled"}>Task instead, record why</button>`}
      </div>
    </div>`;
  }).join("") || `<div class="empty">No unit available. Escalate to mutual aid.</div>`;

  const assignedUnit = i.unit ? unit(i.unit) : null;
  const assignedBlock = assignedUnit ? `
    <div class="sect">Assigned asset</div>
    <div class="cand best">
      <div class="crow">
        <div><div class="cs">${esc(assignedUnit.callsign)}</div>
          <div class="sub">${esc(assignedUnit.status)} · ${esc(assignedUnit.base)} · ${esc(assignedUnit.comms)}</div></div>
        <div class="eta" data-eta="${assignedUnit.id}">${assignedUnit.status === "onscene" ? "on scene" : Math.max(0, (assignedUnit.etaMin || 0) - (state.now - (assignedUnit.assignedAt || 0))) + "<small>min to scene</small>"}</div>
      </div>
      ${assignedUnit.status === "onscene" ? `<div class="cacts"><button class="btn assign" data-close="${i.id}">Stand down and close incident</button></div>` : ""}
    </div>` : "";

  return `
    <div class="dhead">
      <span class="pill ${i.priority}">${i.priority}</span>
      <span class="pill st">${esc(i.status.toUpperCase())}</span>
      <span class="mono dim" style="font-size:10px">${i.id}</span>
      <span class="mono dim" style="font-size:10px;margin-left:auto">${esc(i.type)}</span>
    </div>
    <h3>${esc(i.title)}</h3>
    <div class="place">${esc(i.place)} · ${esc(i.region)} · reported ${fmtClock(-i.reportedMinAgo)}</div>
    <p class="body">${esc(i.detail)}</p>

    <div class="kv">
      <div class="k">SLA left</div>
      <div><b class="mono" data-sla="${i.id}">${slaTxt(i)}</b> <span class="dim">of ${i.slaMin} min</span>
        <div class="slabar"><i class="${slaClass(i)}" style="width:${slaPct(i)}%"></i></div></div>
      <div class="k">Needed</div><div class="needchips">${needs}</div>
    </div>

    ${assignedBlock}

    <div class="sect">AI tasking recommendation <span class="aib">Advisory</span></div>
    <p class="ainote">Scored on capability match, time against the remaining window and crew fatigue. The assistant cannot dispatch. Validate its pick, or task another asset and record why.</p>
    ${decline ? `<div class="refuse"><b>The assistant declines to recommend.</b>${esc(decline)}<span class="refuse2">Tasking any of these is an override. The reason you record is what the after-action review will read.</span></div>` : ""}
    ${recs}

    <div class="sect">Timeline</div>
    <ul class="timeline">${timeline(i)}</ul>`;
}

function timeline(i) {
  const base = [
    { tm: fmtClock(-i.reportedMinAgo), x: "Reported through 112, triaged " + i.priority },
    { tm: fmtClock(-i.reportedMinAgo + 1), x: "Tasking requested for " + i.needs.map(capName).join(", ").toLowerCase() },
  ];
  const own = state.log.filter(l => l.inc === i.id);
  return base.concat(own).map(r => `<li><span class="tm">${esc(r.tm)}</span><span>${esc(r.x)}</span></li>`).join("");
}

function commandView() {
  const open = openIncidents();
  const p1 = open.filter(i => i.priority === "P1").length;
  const atRisk = open.filter(i => slaLeft(i) !== null && slaLeft(i) <= i.slaMin * 0.25).length;
  const avail = DATA.units.filter(u => u.status === "available").length;
  const meanFat = Math.round(DATA.units.reduce((s, u) => s + u.fatigue, 0) / DATA.units.length);

  return `
  <div class="cmd">
    <section class="qcol">
      <div class="paneh">
        <h2>Incident queue</h2>
        <span class="tag red">${p1} P1</span>
        <span class="label">${open.length} open · ${atRisk} at risk</span>
      </div>
      <div class="qfilters" id="filters">
        ${["all", "P1", "P2", "P3"].map(p => `<button data-pri="${p}" class="${state.pri === p ? "on" : ""}">${p === "all" ? "ALL" : p}</button>`).join("")}
      </div>
      <div class="queue" id="queue">${queue()}</div>
      <div class="qfoot">
        <span class="mono">${avail} teams available</span>
        <span class="mono">mean fatigue ${meanFat}%</span>
        <span class="mono" style="margin-left:auto">SIM ${fmtClock(state.now)}</span>
      </div>
    </section>

    <section class="mapcol">
      <div class="paneh">
        <h2>Operational picture · Latvia</h2>
        <span class="label">WGS84 · synthetic</span>
      </div>
      <div class="mapwrap">
        ${mapSvg()}
        <div class="maptools">
          <button id="togcov" class="${state.coverage ? "on" : ""}">60 km coverage</button>
        </div>
        <div class="mapmeta">LGB · SAR<br>WGS84 · EPSG:4326<br>REFRESH 1.4 s</div>
        <div class="legend">
          <span><i style="background:#35C3A8"></i>available</span>
          <span><i style="background:#E0A33A"></i>en route</span>
          <span><i style="background:#6AA8FF"></i>on scene</span>
          <span><i style="background:#5A6470"></i>rest</span>
          <span><i style="background:#E0554B"></i>P1</span>
          <span><i style="background:#E0A33A"></i>P2</span>
        </div>
      </div>
      <div class="activity"><div class="ah">Recent activity</div><div id="acts">${activity()}</div></div>
    </section>

    <aside class="dcol">
      <div class="paneh"><h2>Incident detail</h2><span class="label">Officer decision</span></div>
      <div class="detail">${detailPanel()}</div>
    </aside>
  </div>`;
}

/* ---------------- units ---------------- */
function unitsView() {
  const avail = DATA.units.filter(u => u.status === "available").length;
  const busy = DATA.units.filter(u => u.status === "enroute" || u.status === "onscene").length;
  const rest = DATA.units.filter(u => u.status === "rest").length;
  const avgFat = Math.round(DATA.units.reduce((s, u) => s + u.fatigue, 0) / DATA.units.length);

  const rows = DATA.units.map(u => `
    <tr data-unit="${u.id}" style="cursor:${u.assignedTo ? "pointer" : "default"}">
      <td class="mono" style="font-weight:500">${esc(u.callsign)}</td>
      <td>${esc(capName(u.capability))}</td>
      <td>${esc(u.base)}${u.base !== u.region ? ` <span class="mono dim" style="font-size:9.5px">${esc(u.region)}</span>` : ""}</td>
      <td><span class="state ${u.status}"><i></i>${u.status}</span></td>
      <td class="mono">${esc(u.shift)}</td>
      <td><div class="fat"><div class="fatbar"><i class="${u.fatigue >= 60 ? "high" : u.fatigue >= 45 ? "warn" : ""}" style="width:${u.fatigue}%"></i></div><span class="mono" style="font-size:10px">${u.fatigue}%</span></div></td>
      <td class="mono" style="font-size:10.5px">${esc(u.comms)}</td>
      <td class="mono" style="font-size:10.5px">${u.assignedTo ? esc(u.assignedTo) : "–"}</td>
      <td style="font-size:11px;color:var(--ink-60)">${esc(u.note)}</td>
    </tr>`).join("");

  const matrix = DATA.regions.map(r => {
    const cells = Object.keys(DATA.capabilities).map(cap => {
      const n = DATA.units.filter(u => u.status === "available" && u.capability === cap &&
        km(u.lon, u.lat, ...regionPoint(r)) <= 120).length;
      return `<td class="cell ${n === 0 ? "none" : n === 1 ? "some" : ""}">${n}</td>`;
    }).join("");
    return `<tr><td style="font-weight:500">${esc(r)}</td>${cells}</tr>`;
  }).join("");

  return `<div class="page">
    <div class="pagehead">
      <div><div class="eyebrow">Resource state</div><h1>Teams and capability</h1>
      <p class="lede">Availability, fatigue and reach. A zero means no available team of that capability can reach the region centre inside the 120 km planning radius.</p></div>
      <div class="right"><span class="tag">${DATA.units.length} teams</span><span class="tag teal">${avail} taskable</span></div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="k">Available now</div><div class="v">${avail}<span style="font-size:12px;color:var(--ink-40)"> / ${DATA.units.length}</span></div><div class="s">ready to task</div></div>
      <div class="kpi"><div class="k">Committed</div><div class="v">${busy}</div><div class="s">en route or on scene</div></div>
      <div class="kpi"><div class="k">Rest</div><div class="v">${rest}</div><div class="s">not taskable without recall</div></div>
      <div class="kpi"><div class="k">Mean fatigue</div><div class="v">${avgFat}%</div><div class="s">across all teams</div></div>
    </div>

    <section class="card" style="margin-bottom:14px">
      <div class="card-h"><h2>Teams</h2><span class="label">click a tasked row to open its incident</span></div>
      <div class="t-scroll"><table class="t"><thead><tr>
        <th>Callsign</th><th>Capability</th><th>Base</th><th>State</th><th>Shift</th><th>Fatigue</th><th>Comms</th><th>Tasking</th><th>Note</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </section>

    <section class="card">
      <div class="card-h"><h2>Capability reach by region</h2><span class="label">available units within 120 km</span></div>
      <div class="t-scroll"><table class="t matrix"><thead><tr><th>Region</th>${Object.keys(DATA.capabilities).map(c => `<th>${esc(capName(c))}</th>`).join("")}</tr></thead>
      <tbody>${matrix}</tbody></table></div>
      <div class="note">Red cells are the gap list used by Forecast and Analysis. Amber means a single available team: one more tasking in that region breaches the planning radius.</div>
    </section>
  </div>`;
}

/* ---------------- forecast ---------------- */
function forecastView() {
  const f = DATA.forecast;
  const max = Math.max(...DATA.regions.flatMap(r => f.regions[r]));
  const groups = DATA.regions.map(r => `
    <div class="rgroup">
      <div class="bars">${f.regions[r].map((v, k) => `<i style="height:${(v / max) * 100}%" title="${esc(r)} ${f.hours[k]}:00 · ${v} expected"></i>`).join("")}</div>
      <div class="rlabel">${esc(r)}</div>
    </div>`).join("");

  const g = gaps();
  const uncovered = g.filter(x => x.count === 0);
  const thin = g.filter(x => x.count === 1);
  const p1regions = new Set(openIncidents().filter(i => i.priority === "P1").map(i => i.region));
  const ranked = g.slice().sort((a, b) =>
    (a.count - b.count) || (p1regions.has(b.region) ? 1 : 0) - (p1regions.has(a.region) ? 1 : 0)).slice(0, 4);

  const gapCards = ranked.length ? ranked.map(x => {
    const near = nearest(x.cap, x.region);
    return `<div class="gapcard ${x.count ? "" : "bad"}">
      <div class="t">${esc(x.region)} · ${esc(capName(x.cap))} ${x.count === 0 ? "uncovered" : "single asset"}</div>
      <div class="d">${x.count === 0
        ? `No available team within 120 km. Nearest ${esc(capName(x.cap).toLowerCase())}: ${near ? esc(near.u.callsign) + " (" + near.status + "), " + near.km + " km" : "none in country"}.`
        : "One available team. A second tasking in this region breaches the planning radius."}${p1regions.has(x.region) ? " Region has an open P1." : ""}</div>
    </div>`;
  }).join("") : `<div class="gapcard ok"><div class="t">All regions covered</div><div class="d">Every capability has two or more available teams within 120 km.</div></div>`;

  const prep = DATA.regions.map(r => {
    const open = openIncidents().filter(i => i.region === r);
    const demand = f.regions[r].reduce((a, b) => a + b, 0);
    const avail = DATA.units.filter(u => u.region === r && u.status === "available").length;
    return { r, open: open.length, demand, avail, ratio: avail ? (demand / avail) : demand };
  }).sort((a, b) => b.ratio - a.ratio).slice(0, 2);

  return `<div class="page">
    <div class="pagehead">
      <div><div class="eyebrow">Next 12 hours</div><h1>Demand, gaps and pre-positioning</h1>
      <p class="lede">${esc(f.note)}</p></div>
      <div class="right"><span class="tag red">${uncovered.length} uncovered</span><span class="tag amber">${thin.length} single-asset</span></div>
    </div>

    <div class="fgrid">
      <section class="card">
        <div class="card-h"><h2>Expected call volume</h2><span class="label">calls per hour by region</span></div>
        <div class="chart">${groups}</div>
        <div class="axis"><span>${f.hours[0]}:00 · peak ${max}/h</span><span>${f.hours[6]}:00</span><span>${f.hours[11]}:00</span></div>
        <div class="card-h" style="border-top:1px solid var(--line);border-bottom:0"><h2 style="font-size:12px">Expected load against capacity</h2></div>
        <div class="t-scroll"><table class="t"><thead><tr><th>Region</th><th>Expected, 12 h</th><th>Available</th><th>Load per team</th><th>Open</th></tr></thead>
        <tbody>${DATA.regions.map(r => {
          const demand = f.regions[r].reduce((a, b) => a + b, 0);
          const avail = DATA.units.filter(u => u.region === r && u.status === "available").length;
          const open = openIncidents().filter(i => i.region === r).length;
          const per = avail ? (demand / avail).toFixed(1) : "–";
          const hot = avail === 0 || (avail && demand / avail > 12);
          return `<tr><td style="font-weight:500">${esc(r)}</td><td class="mono">${demand}</td>
            <td class="mono">${avail}</td><td class="mono" style="color:${hot ? "var(--red)" : "var(--ink)"};font-weight:${hot ? 600 : 400}">${per}</td>
            <td class="mono">${open}</td></tr>`;
        }).join("")}</tbody></table></div>
      </section>

      <section class="card">
        <div class="card-h"><h2>Gaps</h2><span class="label">${g.length} combinations below two assets</span></div>
        <div class="gapsum"><b>${uncovered.length}</b> uncovered, <b>${thin.length}</b> single-asset combinations across ${DATA.regions.length} regions. Top four shown.</div>
        ${gapCards}
        <div class="card-h" style="border-top:1px solid var(--line);margin-top:8px"><h2 style="font-size:12px">Recommended moves</h2></div>
        <ul class="drivers">
          ${prep.map(p => `<li><b>→</b><span><b style="font-family:inherit;font-size:12px;color:var(--ink)">${esc(p.r)}</b>: ${p.demand} expected calls against ${p.avail} available team${p.avail === 1 ? "" : "s"}${p.open ? `, ${p.open} open incident${p.open > 1 ? "s" : ""}` : ""}. Move one team from ${p.r === "Rīga" ? "the eastern districts" : "Rīga"} into the region before 15:00.</span></li>`).join("")}
        </ul>
      </section>
    </div>

    <section class="card" style="margin-top:14px">
      <div class="card-h"><h2>What is driving the load</h2><span class="label">baseline × hour-of-day factor</span></div>
      <ul class="drivers">${f.drivers.map((d, k) => `<li><b>${String(k + 1).padStart(2, "0")}</b><span>${esc(d)}</span></li>`).join("")}</ul>
      <div class="note">Illustrative model, not trained on real call data. It exists to show how a forecast becomes a pre-positioning decision, not to predict demand.</div>
    </section>
  </div>`;
}

/* ---------------- validation ---------------- */
function validationView() {
  const d = state.decisions.slice().sort((a, b) => b.t - a.t);
  const val = d.filter(x => x.action === "validated").length;
  const ovr = d.filter(x => x.action === "overridden").length;
  const rate = d.length ? Math.round((val / d.length) * 100) : 0;
  const meanConf = d.length ? Math.round(d.reduce((s, x) => s + x.recConf, 0) / d.length) : 0;

  const rows = d.map(x => `<tr>
    <td class="mono" style="font-size:10.5px">${fmtClock(x.t)}</td>
    <td class="mono" style="font-size:10.5px">${esc(x.inc)}</td>
    <td>${esc(x.rec)}</td>
    <td><span class="conf ${confClass(x.recConf)}">${x.recConf}%</span></td>
    <td><span class="dec ${x.action}">${x.action}</span></td>
    <td style="font-size:11.5px">${x.reason ? esc(REASONS[x.reason] || x.reason) : "Accepted as recommended"}</td>
    <td style="font-size:11.5px">${esc(x.callsign)}${x.action === "overridden" ? " (instead)" : ""}</td>
    <td class="mono" style="font-size:10.5px">Duty Officer</td>
  </tr>`).join("") || `<tr><td colspan="8" style="padding:14px;color:var(--ink-40)">No recommendation has been made this shift.</td></tr>`;

  const overrides = d.filter(x => x.action === "overridden");
  const ovList = overrides.length ? overrides.map(x => `
    <li><b>!</b><span><b style="font-family:inherit;font-size:12px;color:var(--ink)">${esc(x.inc)}</b> —
      <span class="mono">${esc(x.rec)}</span> was recommended at ${x.recConf}%. The officer tasked
      <span class="mono">${esc(x.callsign)}</span> instead, reason: ${esc(REASONS[x.reason] || x.reason)}.
      Evidence that mattered: ${esc(x.evidence[0])}.</span></li>`).join("")
    : `<li><b>—</b><span>No recommendation has been overridden this shift. That is either a good sign or a quiet one, and the ledger is how we tell the difference.</span></li>`;

  return `<div class="page">
    <div class="pagehead">
      <div><div class="eyebrow">AI validation ledger</div><h1>The assistant recommends. The duty officer decides.</h1>
      <p class="lede">Every recommendation, its evidence and confidence, and the human decision with a recorded reason. The console cannot move a unit without an officer action.</p></div>
      <div class="right"><span class="tag">synthetic exercise</span></div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="k">Recommendations</div><div class="v">${d.length}</div><div class="s">this shift, all advisory</div></div>
      <div class="kpi"><div class="k">Validated</div><div class="v" style="color:var(--teal)">${val}</div><div class="s">human accepted the pick</div></div>
      <div class="kpi"><div class="k">Overridden</div><div class="v" style="color:var(--amber)">${ovr}</div><div class="s">different asset, reason recorded</div></div>
      <div class="kpi"><div class="k">Acceptance rate</div><div class="v">${rate}%</div><div class="s">mean confidence ${meanConf}%</div></div>
    </div>

    <div class="rulebox">
      <div><div class="rb-k">The rule</div>
        <p>The assistant may recommend. It cannot dispatch. Every recommendation carries its evidence, a confidence, and the option to refuse. A named officer validates it or tasks a different asset, and the reason is written down with the time.</p></div>
      <div><div class="rb-k">Why it matters here</div>
        <p>A tasking decision sends people into a forest at night. If the system cannot say why it suggested one team over another, the decision belongs to a person, and the record has to show that it did.</p></div>
    </div>

    <section class="card" style="margin-bottom:14px">
      <div class="card-h"><h2>Decision log</h2><span class="label">recommendation · evidence · human decision</span></div>
      <div class="t-scroll"><table class="t"><thead><tr>
        <th>Time</th><th>Incident</th><th>Assistant recommended</th><th>Conf.</th>
        <th>Decision</th><th>Reason</th><th>Asset tasked</th><th>Officer</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    </section>

    <div class="cols2">
      <section class="card">
        <div class="card-h"><h2>Where the recommendation was overridden</h2></div>
        <ul class="drivers">${ovList}</ul>
        <div class="note">Overrides are the useful signal. A rising override rate in one region usually means the model is missing something local, not that officers are ignoring it.</div>
      </section>

      <section class="card">
        <div class="card-h"><h2>What the assistant refuses to do</h2></div>
        <ul class="drivers">
          <li><b>01</b><span>Dispatch anything. There is no code path from a recommendation to a unit state without an officer action.</span></li>
          <li><b>02</b><span>Rank an asset without the required capability as the top pick, even when it is closest.</span></li>
          <li><b>03</b><span>Recommend a tasking it cannot get on scene inside the window. It says so and escalates.</span></li>
          <li><b>04</b><span>Present an ETA as a fact. It is straight-line distance, a road factor and the team's planning speed.</span></li>
          <li><b>05</b><span>Forecast demand without stating that the model is illustrative and untrained.</span></li>
        </ul>
      </section>
    </div>
  </div>`;
}

/* ---------------- analysis ---------------- */
function analysisView() {
  const closed = DATA.incidents.filter(i => i.status === "closed");
  const resp = closed.map(i => i.responseMin).filter(Boolean).sort((a, b) => a - b);
  const median = resp.length ? resp[Math.floor(resp.length / 2)] : null;
  const open = openIncidents();
  const atRisk = open.filter(i => slaLeft(i) !== null && slaLeft(i) <= i.slaMin * 0.25).length;
  const availPct = Math.round(DATA.units.filter(u => u.status === "available").length / DATA.units.length * 100);

  const byRegion = DATA.regions.map(r => ({ r, n: DATA.incidents.filter(i => i.region === r).length }));
  const maxR = Math.max(...byRegion.map(x => x.n));

  const closedRows = closed.map(i => `<tr>
      <td class="mono" style="font-size:10.5px">${i.id}</td><td>${esc(i.type)}</td><td>${esc(i.place)}</td>
      <td><span class="pill ${i.priority}">${i.priority}</span></td>
      <td class="mono">${i.responseMin} min</td><td class="mono">${i.closedInMin} min</td>
      <td class="mono" style="color:${i.responseMin <= i.slaMin ? "var(--teal)" : "var(--red)"}">${i.responseMin <= i.slaMin ? "within" : "breach"}</td>
    </tr>`).join("");

  const g = gaps();
  const decisionCount = state.decisions.length;
  const valCount = state.decisions.filter(x => x.action === "validated").length;

  return `<div class="page">
    <div class="pagehead">
      <div><div class="eyebrow">After action</div><h1>What the board says, and what it does not.</h1>
      <p class="lede">Figures are derived live from the exercise dataset on this screen. Nothing here is a measured operational statistic.</p></div>
      <div class="right"><span class="tag">live derivation</span></div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="k">Open incidents</div><div class="v">${open.length}</div><div class="s">${open.filter(i => i.priority === "P1").length} at P1</div></div>
      <div class="kpi"><div class="k">Median time to first asset</div><div class="v">${median ?? "–"}<span style="font-size:12px;color:var(--ink-40)"> min</span></div><div class="s">closed incidents this cycle</div></div>
      <div class="kpi"><div class="k">SLA at risk</div><div class="v" style="color:${atRisk ? "var(--red)" : "var(--teal)"}">${atRisk}</div><div class="s">under 25% of target left</div></div>
      <div class="kpi"><div class="k">Force availability</div><div class="v">${availPct}%</div><div class="s">of ${DATA.units.length} teams taskable</div></div>
    </div>

    <div class="cols2" style="margin-bottom:14px">
      <section class="card">
        <div class="card-h"><h2>Closed this cycle</h2><span class="label">response vs SLA</span></div>
        <div class="t-scroll"><table class="t"><thead><tr><th>ID</th><th>Type</th><th>Place</th><th>Pri</th><th>First asset</th><th>Closed in</th><th>SLA</th></tr></thead>
        <tbody>${closedRows || `<tr><td colspan="7" class="dim" style="padding:14px">No incident closed yet this shift.</td></tr>`}</tbody></table></div>
      </section>

      <section class="card">
        <div class="card-h"><h2>Incident load by region</h2><span class="label">all statuses</span></div>
        <div class="barlist">
          ${byRegion.map(x => `<div class="row"><span class="n">${esc(x.r)}</span>
            <span class="track"><i style="width:${(x.n / maxR) * 100}%"></i></span>
            <span class="num">${x.n}</span></div>`).join("")}
        </div>
        <div class="note">Rīga and Latgale carry the highest share; Latgale has the thinnest K9 and USAR cover per the capability matrix.</div>
      </section>
    </div>

    <section class="card" style="margin-bottom:14px">
      <div class="card-h"><h2>Coverage against the open board</h2><span class="label">derived from the capability matrix</span></div>
      <div class="cols3">
        <div style="padding:12px 14px;border-right:1px solid var(--line)">
          <div class="label">Uncovered combinations</div>
          <div class="mono" style="font-size:20px;margin-top:4px;color:${g.filter(x => x.count === 0).length ? "var(--red)" : "var(--teal)"}">${g.filter(x => x.count === 0).length}</div>
        </div>
        <div style="padding:12px 14px;border-right:1px solid var(--line)">
          <div class="label">Single-asset combinations</div>
          <div class="mono" style="font-size:20px;margin-top:4px">${g.filter(x => x.count === 1).length}</div>
        </div>
        <div style="padding:12px 14px">
          <div class="label">P1 open in uncovered region</div>
          <div class="mono" style="font-size:20px;margin-top:4px">${openIncidents().filter(i => i.priority === "P1" && g.some(x => x.count === 0 && x.region === i.region)).length}</div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-h"><h2>After action, current cycle</h2><span class="label">progress this shift</span></div>
      <div style="padding:12px 14px;font-size:12.5px;color:var(--ink-60);line-height:1.6">
        ${closed.length + state.closed} incidents closed, ${resp.filter(r => r <= 30).length} of them inside the first-asset target.
        ${atRisk ? `${atRisk} open incident${atRisk > 1 ? "s" : ""} will breach unless a team is assigned in the next ${Math.min(...open.map(i => Math.max(0, slaLeft(i) || 0)))} minutes.` : "No open incident is close to breach."}
        The assistant made ${decisionCount} recommendation${decisionCount === 1 ? "" : "s"} this shift; the duty officer validated ${valCount} of them.
      </div>
      <div class="note">Human decisions are the only thing that changes a unit state. The console records who decided, when, and why.</div>
    </section>
  </div>`;
}

/* ---------------- override modal ---------------- */
function overrideModal() {
  if (!state.ov) return "";
  const { unitId, incId, rec, conf } = state.ov;
  const u = unit(unitId), i = inc(incId);
  if (!u || !i) return "";
  const c = confidence(u, i);
  return `<div class="scrim" data-scrim="1">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ovt">
      <div class="ovhead"><h3 id="ovt">Task a different asset</h3><span class="tag">Override · recorded</span></div>
      <div class="modal-b">
        <div class="ovgrid">
          <div class="ovbox"><div class="k">Assistant recommended</div><div class="v">${esc(rec)}</div><div class="s">confidence ${conf}%</div></div>
          <div class="ovbox" style="border-color:var(--ink)"><div class="k">You are tasking</div><div class="v">${esc(u.callsign)}</div><div class="s">confidence ${c}% · ${etaMin(u, i)} min ETA</div></div>
        </div>
        <div class="field">
          <label for="ovreason">Reason (written to the decision log)</label>
          <select id="ovreason">${Object.entries(REASONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="ovnote">What did you know that the assistant did not? (optional)</label>
          <input id="ovnote" type="text" placeholder="Local knowledge, ground conditions, crew familiarity">
        </div>
        <p class="hint" style="margin-top:10px">This record is what the after-action review reads. Overrides are not failures: an unexplained override is.</p>
      </div>
      <div class="modal-f">
        <button class="btn ghost" data-cancelov="1">Cancel</button>
        <button class="btn red" data-confirmov="${esc(unitId)}" data-to="${esc(incId)}" data-rec="${esc(rec)}" data-conf="${conf}">Confirm tasking</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- render + wiring ---------------- */
function render() {
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.view === state.view));
  const v = $("#view");
  v.innerHTML = state.view === "command" ? commandView()
    : state.view === "search" ? searchView()
    : state.view === "validation" ? validationView()
    : state.view === "units" ? unitsView()
    : state.view === "forecast" ? forecastView()
    : analysisView();
  $("#regionstrip").innerHTML = regionStrip();
  $("#modal-root").innerHTML = overrideModal();
  $("#footclock").textContent = fmtClock(state.now);
  $("#simdate").textContent = `EXERCISE DAY 1 · ${fmtClock(state.now)}`;
  wire();
  if (state.view === "search") wireSearch();
}

function wire() {
  $$("[data-inc]").forEach(b => b.onclick = () => {
    state.sel = b.dataset.inc; render();
    if (window.innerWidth <= 820) {
      const d = document.querySelector(".dcol");
      if (d) d.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  $$("[data-pri]").forEach(b => b.onclick = () => { state.pri = b.dataset.pri; render(); });
  const cov = $("#togcov");
  if (cov) cov.onclick = () => { state.coverage = !state.coverage; render(); };

  $$("[data-validate]").forEach(b => b.onclick = () => taskUnit(b.dataset.validate, b.dataset.to, "validated"));
  $$("[data-override]").forEach(b => b.onclick = () => {
    state.ov = { unitId: b.dataset.override, incId: b.dataset.to, rec: b.dataset.rec, conf: Number(b.dataset.conf) };
    render();
    const first = $("#ovreason"); if (first) first.focus();
  });
  $$("[data-cancelov]").forEach(b => b.onclick = () => { state.ov = null; render(); });
  $$("[data-scrim]").forEach(s => s.onclick = (e) => { if (e.target === s) { state.ov = null; render(); } });
  $$("[data-confirmov]").forEach(b => b.onclick = () => {
    const sel = $("#ovreason");
    taskUnit(b.dataset.confirmov, b.dataset.to, "overridden", sel ? sel.value : "other", b.dataset.rec, Number(b.dataset.conf));
  });
  $$("[data-close]").forEach(b => b.onclick = () => closeIncident(b.dataset.close));
  $$("[data-unit]").forEach(tr => tr.onclick = () => {
    const u = unit(tr.dataset.unit);
    if (u && u.assignedTo) { state.sel = u.assignedTo; state.view = "command"; render(); }
  });
}

function assign(unitId, incId, logIt = true) {
  const u = unit(unitId), i = inc(incId);
  if (!u || !i) return;
  if (u.assignedTo && u.assignedTo !== i.id) {
    const old = inc(u.assignedTo);
    if (old && old.status !== "closed") { old.status = "new"; old.unit = null; }
  }
  DATA.units.forEach(x => {
    if (x.id !== u.id && x.assignedTo === i.id) { x.status = "available"; x.assignedTo = null; x.etaMin = null; x.assignedAt = null; }
  });
  const eta = etaMin(u, i);
  u.status = "enroute";
  u.assignedTo = i.id;
  u.assignedAt = state.now;
  u.etaMin = eta;
  i.status = "assigned";
  i.unit = u.id;
  if (logIt) state.log.push({ tm: fmtClock(state.now), inc: i.id, x: `${u.callsign} assigned, ${eta} min ETA from ${u.base}` });
  render();
}

function taskUnit(unitId, incId, mode, reason, recCallsign, recConf) {
  const u = unit(unitId), i = inc(incId);
  if (!u || !i) return;
  const conf = confidence(u, i);
  const eta = etaMin(u, i);
  const rec = mode === "overridden" ? (recCallsign || u.callsign) : u.callsign;
  const recScore = mode === "overridden" ? (Number.isFinite(recConf) ? recConf : conf) : conf;
  const note = $("#ovnote") ? $("#ovnote").value.trim() : "";
  state.decisions.push({
    t: state.now, inc: i.id, rec, recConf: recScore, callsign: u.callsign, unit: u.id,
    action: mode, reason: mode === "overridden" ? reason : null,
    instead: mode === "overridden" ? u.callsign : null,
    evidence: evidenceList(u, i), eta, note,
  });
  state.ov = null;
  const label = mode === "validated" ? "validated" : `overridden (${REASONS[reason] || reason})`;
  state.log.push({ tm: fmtClock(state.now), inc: i.id, x: `AI recommendation ${label} by Duty Officer: ${u.callsign}, ${eta} min ETA` });
  assign(unitId, incId, false);
}

function closeIncident(incId) {
  const i = inc(incId);
  if (!i) return;
  const u = i.unit ? unit(i.unit) : null;
  if (u) {
    state.log.push({ tm: fmtClock(state.now), inc: i.id, x: `${u.callsign} released, returning to ${u.base}` });
    u.status = "available"; u.assignedTo = null; u.etaMin = null; u.assignedAt = null;
    u.fatigue = Math.min(95, u.fatigue + 4);
  }
  i.status = "closed";
  i.closedInMin = state.now + i.reportedMinAgo;
  state.log.push({ tm: fmtClock(state.now), inc: i.id, x: "Incident closed, handover complete" });
  state.closed++;
  const next = openIncidents().sort((a, b) => PRI_ORDER[a.priority] - PRI_ORDER[b.priority])[0];
  if (next) state.sel = next.id;
  render();
}

/* ---------------- clock ---------------- */
function tick() {
  state.now += 1;
  const clock = $("#clock");
  if (clock) clock.textContent = fmtClock(state.now);
  $("#footclock").textContent = fmtClock(state.now);
  $("#simdate").textContent = `EXERCISE DAY 1 · ${fmtClock(state.now)}`;

  $$("[data-sla]").forEach(el => {
    const i = inc(el.dataset.sla);
    if (!i) return;
    el.textContent = slaTxt(i);
    if (el.closest(".qi")) el.className = "sla " + slaClass(i);
  });

  $$("[data-eta]").forEach(el => {
    const u = unit(el.dataset.eta);
    if (!u) return;
    if (u.status === "onscene") { el.textContent = "on scene"; return; }
    const left = Math.max(0, (u.etaMin || 0) - (state.now - (u.assignedAt || 0)));
    el.innerHTML = `${left}<small>min to scene</small>`;
  });

  let changed = false;
  DATA.units.forEach(u => {
    if (u.status === "enroute" && u.assignedTo && (state.now - (u.assignedAt || 0)) >= (u.etaMin || 0)) {
      u.status = "onscene";
      const i = inc(u.assignedTo);
      if (i) {
        i.status = "onscene";
        i.responseMin = state.now + i.reportedMinAgo;
        state.log.push({ tm: fmtClock(state.now), inc: i.id, x: `${u.callsign} on scene, first asset` });
      }
      changed = true;
    }
  });
  if (changed) render();
}

/* ---------------- boot ---------------- */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  state.view = b.dataset.view;
  history.replaceState(null, "", "#" + state.view);
  render();
  window.scrollTo({ top: 0 });
});

window.addEventListener("hashchange", () => {
  const v = location.hash.replace("#", "");
  if (["command", "search", "validation", "units", "forecast", "analysis"].includes(v)) {
    state.view = v; render();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input,select,textarea")) return;
  if (e.key === "Escape" && state.ov) { state.ov = null; render(); }
  const n = parseInt(e.key, 10);
  const views = ["command", "search", "validation", "units", "forecast", "analysis"];
  if (n >= 1 && n <= 6) { state.view = views[n - 1]; render(); }
  if ((e.key === "j" || e.key === "k") && state.view === "command") {
    const list = openIncidents().slice().sort((a, b) => PRI_ORDER[a.priority] - PRI_ORDER[b.priority]);
    const idx = list.findIndex(x => x.id === state.sel);
    const next = Math.max(0, Math.min(list.length - 1, idx + (e.key === "j" ? 1 : -1)));
    if (list[next]) { state.sel = list[next].id; render(); }
  }
});

P = projection();
state.decisions = [
  { t: -48, inc: "INC-0436", rec: "LGB K9-2", recConf: 74, callsign: "LGB K9-2", action: "validated", reason: null, instead: null, eta: 26,
    evidence: ["26 min to scene against 41 min left in the window", "carries search dog", "crew fatigue 38%, radio comms", "82 km by road from Valmiera"] },
  { t: -42, inc: "INC-0437", rec: "LGB USAR-2", recConf: 81, callsign: "LGB USAR-2", action: "validated", reason: null, instead: null, eta: 18,
    evidence: ["18 min to scene against 34 min left in the window", "carries urban search and rescue", "crew fatigue 31%, radio comms", "44 km by road from Jelgava"] },
  { t: -36, inc: "INC-0438", rec: "LGB BOAT-1", recConf: 88, callsign: "LGB BOAT-1", action: "validated", reason: null, instead: null, eta: 11,
    evidence: ["11 min to scene against 19 min left in the window", "carries water rescue", "crew fatigue 29%, marine vhf", "6 km by road from Liepāja"] },
  { t: -29, inc: "INC-0439", rec: "LGB K9-1", recConf: 63, callsign: "LGB GND-1", action: "overridden", reason: "proximity", instead: "LGB GND-1", eta: 41,
    evidence: ["41 min to scene against 61 min left in the window", "carries search dog", "crew fatigue 22%, radio comms", "138 km by road from Rīga"] },
];
const bootView = location.hash.replace("#", "");
if (["command", "search", "validation", "units", "forecast", "analysis"].includes(bootView)) state.view = bootView;
runDrift();
render();
setInterval(tick, 1400);
