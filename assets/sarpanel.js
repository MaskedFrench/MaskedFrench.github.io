/* ============================================================================
   SAROPS-STYLE SEARCH PLANNING CONSOLE
   Case → LKP → Monte Carlo drift → probability grid → search action plan →
   a planner approves or modifies, and the ledger records it.

   The environment is synthetic: wind, current and leeway are sliders, and the
   drift model is a demonstration, not an operational product.
   ========================================================================== */
(function () {
  'use strict';

  var D = window.SAR_DATA;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var START = 400;                 // 06:40 in minutes
  var UNITS_PER_KM = 2.267;        // from the geo bbox at ~57°N
  var KM_PER_UNIT = 1 / UNITS_PER_KM;
  var PARTICLES = 600;

  var PRIORITY = { P1: '#F26B21', P2: '#DFA93F', P3: '#56B892' };

  var REASONS = {
    sea: 'Sea state / weather',
    local: 'Local knowledge',
    fatigue: 'Crew fatigue',
    datum: 'Different datum',
    other: 'Other'
  };

  var WATER = /water|swim|beach|flood/i;

  var state = {
    clock: START,
    caseId: null,
    layer: 'plan',
    decisions: [],
    sim: null,
    plan: null,
    approved: {},
    params: { wind: 6, windDir: 240, cur: 0.4, lee: null }
  };

  /* ---------------------------------------------------------------- utils */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function timeStr(min) {
    var m = ((min % 1440) + 1440) % 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  function km(a, b, c, d) {
    var R = 6371, r = Math.PI / 180;
    var dLat = (c - a) * r, dLon = (d - b) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  function proj(lon, lat) {
    var b = D.geo.bbox;
    return {
      x: (lon - b[0]) / (b[2] - b[0]) * D.geo.w,
      y: (b[3] - lat) / (b[3] - b[1]) * D.geo.h
    };
  }
  function unproj(x, y) {
    var b = D.geo.bbox;
    return {
      lon: b[0] + (x / D.geo.w) * (b[2] - b[0]),
      lat: b[3] - (y / D.geo.h) * (b[3] - b[1])
    };
  }
  function caseById(id) { return D.incidents.filter(function (i) { return i.id === id; })[0]; }
  function openCases() { return D.incidents.filter(function (i) { return i.status !== 'closed'; }); }
  function availableUnits() { return D.units.filter(function (u) { return u.status === 'available'; }); }
  function elapsedMin(c) { return c.reportedMinAgo + (state.clock - START); }
  function slaLeft(c) { return c.slaMin - elapsedMin(c); }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    var u = 0, v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* ---------------------------------------------------------------- drift */

  function simulate(c) {
    var p = state.params;
    var lee = p.lee == null ? (WATER.test(c.type) ? 3.5 : 0.8) : p.lee;
    var h = Math.max(0.2, elapsedMin(c) / 60);
    var rng = mulberry32(hash(c.id + '|' + p.wind + '|' + p.windDir + '|' + p.cur + '|' + lee));

    var lkp = proj(c.lon, c.lat);
    var windTo = (p.windDir + 180) * Math.PI / 180;   // wind FROM → drift toward
    var driftKmh = (lee / 100) * p.wind * 3.6;         // leeway fraction of wind speed
    var curKmh = p.cur * 1.852;
    var curTo = 45 * Math.PI / 180;                    // synthetic set
    var sigma = 0.45 + 0.7 * Math.sqrt(h);             // km, position + search uncertainty

    var pts = [];
    for (var i = 0; i < PARTICLES; i++) {
      var spread = 12 * Math.PI / 180;
      var a = windTo + gauss(rng) * spread;
      var dx = Math.cos(a) * driftKmh * h + Math.cos(curTo) * curKmh * h + gauss(rng) * sigma;
      var dy = Math.sin(a) * driftKmh * h + Math.sin(curTo) * curKmh * h + gauss(rng) * sigma;
      pts.push({ x: lkp.x + dx * UNITS_PER_KM, y: lkp.y - dy * UNITS_PER_KM });
    }

    // bounding box
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(function (q) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    });
    var pad = Math.max(1.2, (maxX - minX) * 0.18);
    minX -= pad; maxX += pad; minY -= pad; maxY += pad;

    // histogram
    var cell = Math.max(0.1, Math.min(14, (maxX - minX) / 38));
    var grid = {}, cells = [], max = 0;
    pts.forEach(function (q) {
      var gx = Math.floor((q.x - minX) / cell);
      var gy = Math.floor((q.y - minY) / cell);
      var k = gx + ':' + gy;
      if (!grid[k]) grid[k] = { gx: gx, gy: gy, n: 0, x: minX + (gx + 0.5) * cell, y: minY + (gy + 0.5) * cell };
      grid[k].n++;
      if (grid[k].n > max) max = grid[k].n;
    });
    Object.keys(grid).forEach(function (k) { cells.push(grid[k]); });
    cells.sort(function (a, b) { return b.n - a.n; });

    var total = pts.length;
    var cum = 0, box = null;
    cells.forEach(function (c) {
      c.p = c.n / total;
      cum += c.p;
      c.cum = cum;
    });
    // 80% box from the cells themselves
    var keep = [], acc = 0;
    for (var j = 0; j < cells.length && acc < 0.8; j++) { keep.push(cells[j]); acc += cells[j].p; }
    if (keep.length) {
      box = {
        x0: Math.min.apply(null, keep.map(function (c) { return c.x - cell / 2; })),
        x1: Math.max.apply(null, keep.map(function (c) { return c.x + cell / 2; })),
        y0: Math.min.apply(null, keep.map(function (c) { return c.y - cell / 2; })),
        y1: Math.max.apply(null, keep.map(function (c) { return c.y + cell / 2; }))
      };
    }

    var datum = cells[0] ? { x: cells[0].x, y: cells[0].y } : lkp;
    return {
      pts: pts, cells: cells, cell: cell, max: max, total: total,
      bbox: { x0: minX, x1: maxX, y0: minY, y1: maxY },
      box: box, datum: datum, lkp: lkp, lee: lee, hours: h,
      coverage: Math.min(1, acc)
    };
  }

  /* ---------------------------------------------------------------- plan */

  function planFor(c, sim) {
    if (!sim.box) return null;
    var widthKm = (sim.box.x1 - sim.box.x0) * KM_PER_UNIT;
    var heightKm = (sim.box.y1 - sim.box.y0) * KM_PER_UNIT;
    var areaKm2 = Math.max(1, widthKm * heightKm);

    var srus = availableUnits().map(function (u) {
      var match = c.needs[0] === u.capability ? 2 : c.needs.indexOf(u.capability) !== -1 ? 1 : 0;
      var d = km(u.lat, u.lon, c.lat, c.lon);
      return { u: u, match: match, dist: Math.round(d * 1.3), eta: Math.max(2, Math.round(d * 1.3 / u.speed * 60)) };
    }).sort(function (a, b) { return (b.match - a.match) || (a.dist - b.dist); });

    var lead = srus[0];
    var sweepKm = lead ? (lead.u.capability === 'drone' ? 1.2 : lead.u.capability === 'water' ? 1.8 : 1.4) : 1.5;
    var spacingKm = Math.max(0.6, sweepKm * 0.85);
    var legs = Math.max(2, Math.min(9, Math.ceil(heightKm / spacingKm)));
    var lengthKm = Math.round(legs * widthKm * 1.06);
    var pod = 1 - Math.exp(-(sweepKm * lengthKm) / areaKm2);
    pod = Math.max(0.02, Math.min(0.92, pod));

    return {
      srus: srus.slice(0, 3), lead: lead,
      sweepKm: sweepKm, spacingKm: spacingKm, legs: legs,
      lengthKm: lengthKm, areaKm2: Math.round(areaKm2),
      widthKm: Math.round(widthKm), heightKm: Math.round(heightKm),
      pod: pod, pos: pod * sim.coverage,
      timeOnTask: lead ? Math.round(lengthKm / lead.u.speed * 60 / 60 * 10) / 10 : null
    };
  }

  /* ---------------------------------------------------------------- map */

  function viewBox(sim) {
    var b = sim ? sim.bbox : { x0: 380, y0: 230, x1: 420, y1: 260 };
    var w = Math.max(9, Math.min(220, b.x1 - b.x0));
    var h = w * (D.geo.h / D.geo.w);
    var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }

  function renderMap() {
    var c = caseById(state.caseId);
    var sim = state.sim;
    var vb = viewBox(sim);
    var layer = state.layer;
    var host = $('#mapHost');
    var mw = host.clientWidth || 800;
    var ux = vb.w / mw;                       // map units per screen pixel

    function fs(px) { return px * ux; }

    // kilometre grid with geographic labels
    var maxLines = window.innerWidth < 620 ? 4 : 7;
    var stepKm = [0.5, 1, 2, 5, 10, 20, 50].filter(function (s) { return (vb.w * KM_PER_UNIT) / s <= maxLines; })[0] || 50;
    var step = stepKm * UNITS_PER_KM;
    var grid = '';
    var x0 = Math.ceil(vb.x / step) * step;
    for (var x = x0; x <= vb.x + vb.w + step; x += step) {
      grid += '<line class="grat" x1="' + x + '" y1="' + vb.y + '" x2="' + x + '" y2="' + (vb.y + vb.h) + '" stroke-width="' + fs(0.7) + '"/>';
      grid += '<text class="gratlbl" x="' + (x + fs(3)) + '" y="' + (vb.y + fs(11)) + '" font-size="' + fs(8.5) + '">' +
        unproj(x, vb.y).lon.toFixed(stepKm < 1 ? 3 : 2) + '°E</text>';
    }
    var y0 = Math.ceil(vb.y / step) * step;
    for (var y = y0; y <= vb.y + vb.h + step; y += step) {
      grid += '<line class="grat" x1="' + vb.x + '" y1="' + y + '" x2="' + (vb.x + vb.w) + '" y2="' + y + '" stroke-width="' + fs(0.7) + '"/>';
      grid += '<text class="gratlbl" x="' + (vb.x + fs(5)) + '" y="' + (y - fs(3)) + '" font-size="' + fs(8.5) + '">' +
        unproj(vb.x, y).lat.toFixed(stepKm < 1 ? 3 : 2) + '°N</text>';
    }

    // probability cells
    var cells = '';
    if (sim && layer !== 'report') {
      cells = sim.cells.map(function (cl) {
        var v = cl.n / sim.max;
        var op = (0.1 + 0.72 * Math.pow(v, 0.55)) * (layer === 'env' ? 0.45 : 1);
        return '<rect x="' + (cl.x - sim.cell / 2) + '" y="' + (cl.y - sim.cell / 2) + '" width="' + sim.cell + '" height="' + sim.cell +
          '" fill="#5FD0E6" opacity="' + op.toFixed(3) + '"/>';
      }).join('');
    }

    // search legs
    var legs = '';
    if (sim && sim.box && (layer === 'plan' || layer === 'report')) {
      var n = state.plan ? state.plan.legs : 4;
      var spacing = (sim.box.y1 - sim.box.y0) / n;
      for (var i = 0; i < n; i++) {
        var ly = sim.box.y0 + spacing * (i + 0.5);
        var xa = sim.box.x0, xb = sim.box.x1;
        if (i % 2) { var t = xa; xa = xb; xb = t; }
        legs += '<line class="leg" x1="' + xa + '" y1="' + ly + '" x2="' + xb + '" y2="' + ly + '" stroke-width="' + fs(1.3) +
          '" stroke-dasharray="' + fs(7) + ' ' + fs(4) + '"/>';
      }
      legs += '<text class="leg-lbl" x="' + sim.box.x0 + '" y="' + (sim.box.y0 - fs(5)) + '" font-size="' + fs(8.5) + '">PS-' +
        n + ' · ' + (state.plan ? state.plan.spacingKm.toFixed(1) : '—') + ' km</text>';
    }

    // search box and drift vector
    var boxArt = '';
    if (sim && sim.box) {
      boxArt += '<rect x="' + sim.box.x0 + '" y="' + sim.box.y0 + '" width="' + (sim.box.x1 - sim.box.x0) + '" height="' + (sim.box.y1 - sim.box.y0) +
        '" fill="none" stroke="#5FD0E6" stroke-width="' + fs(0.9) + '" stroke-dasharray="' + fs(4) + ' ' + fs(3) + '" opacity=".55"/>';
    }
    if (sim && sim.lkp && sim.datum) {
      var vx = sim.datum.x - sim.lkp.x, vy = sim.datum.y - sim.lkp.y;
      var len = Math.sqrt(vx * vx + vy * vy);
      if (len > 0.4) {
        var ux1 = vx / len, uy1 = vy / len;
        var hx = sim.datum.x - ux1 * fs(10), hy = sim.datum.y - uy1 * fs(10);
        boxArt += '<line x1="' + sim.lkp.x + '" y1="' + sim.lkp.y + '" x2="' + hx + '" y2="' + hy +
          '" stroke="#8EA0AC" stroke-width="' + fs(1) + '" stroke-dasharray="' + fs(3) + ' ' + fs(3) + '"/>' +
          '<path d="M' + sim.datum.x + ' ' + sim.datum.y + ' l' + (-ux1 * fs(5) - uy1 * fs(2.4)) + ' ' + (-uy1 * fs(5) + ux1 * fs(2.4)) +
          ' l' + (-ux1 * fs(5) + uy1 * fs(2.4)) + ' ' + (-uy1 * fs(5) - ux1 * fs(2.4)) + ' Z" fill="#8EA0AC"/>';
      }
    }

    // datum and last known position
    var datum = '';
    if (sim) {
      var dx = sim.datum.x, dy = sim.datum.y, r = fs(8);
      datum = '<g><circle class="datum" cx="' + dx + '" cy="' + dy + '" r="' + r + '" stroke-width="' + fs(1.3) + '"/>' +
        '<line class="datum" x1="' + (dx - r * 1.8) + '" y1="' + dy + '" x2="' + (dx + r * 1.8) + '" y2="' + dy + '" stroke-width="' + fs(1) + '"/>' +
        '<line class="datum" x1="' + dx + '" y1="' + (dy - r * 1.8) + '" x2="' + dx + '" y2="' + (dy + r * 1.8) + '" stroke-width="' + fs(1) + '"/>' +
        '<text class="datum-lbl" x="' + (dx + r * 1.6) + '" y="' + (dy - r * 1.1) + '" font-size="' + fs(8.5) + '">DATUM</text></g>';
      var lx = sim.lkp.x, ly = sim.lkp.y;
      datum += '<g><circle class="lkp" cx="' + lx + '" cy="' + ly + '" r="' + fs(4) + '" stroke-width="' + fs(1.1) + '"/>' +
        '<text class="datum-lbl" x="' + (lx - fs(5)) + '" y="' + (ly + fs(9)) + '" text-anchor="end" font-size="' + fs(8) + '" fill="#8EA0AC">LKP</text></g>';
    }

    // units in view
    var units = '';
    if (layer === 'plan' || layer === 'report') {
      units = D.units.filter(function (u) {
        if (u.status === 'rest') return false;
        var q = proj(u.lon, u.lat);
        return q.x > vb.x - vb.w * 0.1 && q.x < vb.x + vb.w * 1.1 && q.y > vb.y - vb.h * 0.1 && q.y < vb.y + vb.h * 1.1;
      }).slice(0, 6).map(function (u) {
        var q = proj(u.lon, u.lat);
        return '<g><path class="unit" d="M' + q.x + ' ' + (q.y - fs(4)) + ' L' + (q.x + fs(3.4)) + ' ' + (q.y + fs(3)) +
          ' L' + (q.x - fs(3.4)) + ' ' + (q.y + fs(3)) + 'Z" stroke-width="' + fs(0.8) + '"/>' +
          '<text class="uname" x="' + (q.x + fs(5)) + '" y="' + (q.y + fs(2.5)) + '" font-size="' + fs(7.5) + '">' +
          esc(u.callsign.replace('LGB ', '')) + '</text></g>';
      }).join('');
    }

    // environment arrows
    var env = '';

    host.innerHTML =
      '<svg viewBox="' + vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h + '" preserveAspectRatio="xMidYMid meet" aria-label="Local search area chart">' +
      '<defs><filter id="soft" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="' + (sim ? sim.cell * 0.32 : 1) + '"/></filter></defs>' +
      '<rect x="' + vb.x + '" y="' + vb.y + '" width="' + vb.w + '" height="' + vb.h + '" fill="#071018"/>' +
      '<path class="coast" d="' + D.geo.path + '" stroke-width="' + fs(1.1) + '"/>' +
      grid +
      '<g filter="url(#soft)">' + cells + '</g>' +
      boxArt + legs + datum + units + env +
      '</svg>';

    if (state.plan) $('#scale').textContent = stepKm + ' km grid · ' + state.plan.legs + ' legs · ' + state.plan.lengthKm + ' km track';

    var envCard = $('#envCard');
    if (layer === 'env' && c) {
      envCard.hidden = false;
      envCard.innerHTML = '<h3>Environment · EDS synthetic</h3>' +
        '<div class="rose">' + rose() +
        '<div class="key"><span><i style="background:#5FD0E6"></i>wind</span><span><i style="background:#DFA93F"></i>current</span><span><i style="background:#8EA0AC"></i>drift</span></div></div>' +
        '<div class="row"><span>Wind</span><b>' + state.params.windDir + '° / ' + state.params.wind + ' m/s</b></div>' +
        '<div class="row"><span>Current</span><b>045° / ' + state.params.cur.toFixed(1) + ' kn</b></div>' +
        '<div class="row"><span>Leeway</span><b>' + sim.lee.toFixed(1) + ' %</b></div>' +
        '<div class="row"><span>Drift time</span><b>' + sim.hours.toFixed(1) + ' h</b></div>' +
        '<div class="row"><span>Datum shift</span><b>' +
        (Math.sqrt(Math.pow(sim.datum.x - sim.lkp.x, 2) + Math.pow(sim.datum.y - sim.lkp.y, 2)) * KM_PER_UNIT).toFixed(1) + ' km</b></div>';
    } else {
      envCard.hidden = true;
    }

    var card = $('#reportCard');
    if (layer === 'report' && state.plan && c) {
      var pl = state.plan;
      card.hidden = false;
      card.innerHTML = '<h3>Search action plan · ' + esc(c.id) + '</h3>' +
        '<div class="row"><span>Object</span><b>' + esc(c.type) + '</b></div>' +
        '<div class="row"><span>LKP</span><b>' + c.lat.toFixed(3) + 'N ' + c.lon.toFixed(3) + 'E</b></div>' +
        '<div class="row"><span>Datum</span><b>' + unproj(sim.datum.x, sim.datum.y).lat.toFixed(3) + 'N ' +
        unproj(sim.datum.x, sim.datum.y).lon.toFixed(3) + 'E</b></div>' +
        '<div class="row"><span>Search box</span><b>' + pl.widthKm + ' × ' + pl.heightKm + ' km · ' + (sim.coverage * 100).toFixed(0) + '%</b></div>' +
        '<div class="row"><span>Pattern</span><b>Parallel · ' + pl.legs + ' legs</b></div>' +
        '<div class="row"><span>Spacing</span><b>' + pl.spacingKm.toFixed(1) + ' km</b></div>' +
        '<div class="row"><span>Track</span><b>' + pl.lengthKm + ' km</b></div>' +
        '<div class="row"><span>POD / POS</span><b>' + Math.round(pl.pod * 100) + '% / ' + Math.round(pl.pos * 100) + '%</b></div>' +
        '<div class="row"><span>Lead SRU</span><b>' + (pl.lead ? pl.lead.u.callsign + ' · ' + pl.lead.eta + ' min' : '—') + '</b></div>' +
        '<div class="st ' + (state.approved[c.id] ? 'ok' : '') + '">' +
        (state.approved[c.id] ? 'Approved ' + state.approved[c.id] : 'Awaiting approval') + '</div>';
    } else {
      card.hidden = true;
    }
    if (c) {
      $('#coords').textContent = c.lat.toFixed(3) + '°N ' + c.lon.toFixed(3) + '°E · ' + (sim ? sim.total : 0) + ' particles · ' +
        (vb.w * KM_PER_UNIT).toFixed(0) + ' km view';
    }
  }

  function rose() {
    var cx = 34, cy = 34, r = 26;
    function arrow(deg, color, len) {
      var a = (90 - deg) * Math.PI / 180;
      var x2 = cx + Math.cos(a) * len, y2 = cy - Math.sin(a) * len;
      var hx = x2 - Math.cos(a - 0.5) * 5, hy = y2 + Math.sin(a - 0.5) * 5;
      var hx2 = x2 - Math.cos(a + 0.5) * 5, hy2 = y2 + Math.sin(a + 0.5) * 5;
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="1.4"/>' +
        '<path d="M' + x2 + ' ' + y2 + ' L' + hx + ' ' + hy + ' L' + hx2 + ' ' + hy2 + ' Z" fill="' + color + '"/>';
    }
    var driftDeg = Math.atan2(-(state.sim.datum.y - state.sim.lkp.y), state.sim.datum.x - state.sim.lkp.x) * 180 / Math.PI;
    return '<svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#22333D"/>' +
      '<line x1="' + cx + '" y1="' + (cy - r) + '" x2="' + cx + '" y2="' + (cy + r) + '" stroke="#1B2A33"/>' +
      '<line x1="' + (cx - r) + '" y1="' + cy + '" x2="' + (cx + r) + '" y2="' + cy + '" stroke="#1B2A33"/>' +
      '<text x="' + cx + '" y="8" text-anchor="middle" font-size="6" fill="#7C8F9B" font-family="DM Mono, monospace">N</text>' +
      arrow(state.params.windDir + 180, '#5FD0E6', 22) +
      arrow(45, '#DFA93F', 15) +
      arrow(driftDeg, '#8EA0AC', 10) +
      '</svg>';
  }

  function envArrow(x, y, dirDeg, label, ux, color, px) {
    var len = (px || 16) * ux;
    var rad = (90 - dirDeg) * Math.PI / 180;
    var x2 = x + Math.cos(rad) * len, y2 = y - Math.sin(rad) * len;
    var ang = Math.atan2(y2 - y, x2 - x);
    var hx = x2 - Math.cos(ang - 0.4) * 6 * ux, hy = y2 - Math.sin(ang - 0.4) * 6 * ux;
    var hx2 = x2 - Math.cos(ang + 0.4) * 6 * ux, hy2 = y2 - Math.sin(ang + 0.4) * 6 * ux;
    return '<g><line x1="' + x + '" y1="' + y + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="' + (1.4 * ux) + '"/>' +
      '<path d="M' + x2 + ' ' + y2 + ' L' + hx + ' ' + hy + ' L' + hx2 + ' ' + hy2 + ' Z" fill="' + color + '"/>' +
      '<text x="' + (x2 + 4 * ux) + '" y="' + (y2 + 2 * ux) + '" font-size="' + (8 * ux) + '" fill="' + color +
      '" font-family="DM Mono, monospace" letter-spacing=".04em">' + esc(label) + '</text></g>';
  }

  /* ---------------------------------------------------------------- panels */

  function renderLeft() {
    var c = caseById(state.caseId);
    $('#caseList').innerHTML = openCases().map(function (i) {
      return '<button class="case" type="button" data-case="' + i.id + '" aria-current="' + (i.id === state.caseId) + '">' +
        '<span class="pri" style="background:' + PRIORITY[i.priority] + '"></span>' +
        '<span><span class="id">' + i.id + ' · ' + esc(i.priority) + '</span><span class="t">' + esc(i.title) + '</span></span>' +
        '<span class="sla ' + (slaLeft(i) < 25 ? 'hot' : '') + '">' + Math.max(0, slaLeft(i)) + '′</span></button>';
    }).join('');
    $('#caseCount').textContent = openCases().length + ' open';

    if (!c) return;
    $('#caseId').textContent = c.id;
    $('#datumTime').textContent = timeStr(START - c.reportedMinAgo);

    var lee = state.params.lee == null ? (WATER.test(c.type) ? 3.5 : 0.8) : state.params.lee;
    $('#objectKv').innerHTML = [
      ['Object', c.type],
      ['Place', c.place],
      ['LKP', c.lat.toFixed(3) + '°N ' + c.lon.toFixed(3) + '°E'],
      ['Reported', timeStr(START - c.reportedMinAgo) + ' · ' + elapsedMin(c) + ' min ago'],
      ['Target', c.slaMin + ' min · ' + Math.max(0, slaLeft(c)) + ' left'],
      ['Drift', lee.toFixed(1) + '% leeway · ' + state.sim.hours.toFixed(1) + ' h'],
      ['Needs', c.needs.join(', ')]
    ].map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    $('#lee').value = lee;
    $('#windOut').textContent = state.params.wind + ' m/s';
    $('#windDirOut').textContent = state.params.windDir + '°';
    $('#curOut').textContent = state.params.cur.toFixed(1) + ' kn';
    $('#leeOut').textContent = lee.toFixed(1) + ' %';
  }

  function renderRight() {
    var sim = state.sim, p = state.plan, c = caseById(state.caseId);
    if (!sim || !c) return;

    var top = sim.cells.slice(0, 5);
    $('#polTable').innerHTML = top.map(function (cl, i) {
      var g = unproj(cl.x, cl.y);
      return '<tr><td>' + pad(i + 1) + '<span class="polbar"><i style="width:' + Math.round(cl.n / sim.max * 100) + '%"></i></span></td>' +
        '<td>' + g.lat.toFixed(4) + '°N<br>' + g.lon.toFixed(4) + '°E</td>' +
        '<td class="pct">' + (cl.p * 100).toFixed(1) + '%</td>' +
        '<td>' + (cl.cum * 100).toFixed(0) + '%</td></tr>';
    }).join('');
    $('#polNote').textContent = sim.total + ' particles · ' + sim.cells.length + ' cells · top 5 hold ' +
      (top.reduce(function (a, x) { return a + x.p; }, 0) * 100).toFixed(0) + '% of probability.';

    var pod = Math.round(p.pod * 100), pos = Math.round(p.pos * 100);
    var podEl = $('#pod');
    podEl.textContent = pod + '%';
    podEl.className = pod < 40 ? 'verylow' : pod < 60 ? 'low' : '';
    $('#pos').textContent = pos + '%';

    $('#planKv').innerHTML = [
      ['Pattern', 'Parallel track'],
      ['Legs', p.legs + ' · ' + p.spacingKm.toFixed(1) + ' km spacing'],
      ['Track', p.lengthKm + ' km over ' + p.areaKm2 + ' km²'],
      ['Search box', p.widthKm + ' × ' + p.heightKm + ' km'],
      ['Coverage', (sim.coverage * 100).toFixed(0) + '% of probability'],
      ['Lead SRU', p.lead ? p.lead.u.callsign + ' · ETA ' + p.lead.eta + ' min' : '—'],
      ['On task', p.timeOnTask == null ? '—' : p.timeOnTask + ' h at ' + (p.lead ? p.lead.u.speed : '—') + ' km/h']
    ].map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    }).join('');

    var approved = state.approved[state.caseId];
    $('#btnApprove').disabled = !!approved;
    $('#btnApprove').textContent = approved ? 'Approved ' + approved : 'Approve plan';
  }

  function renderBottom() {
    var c = caseById(state.caseId);
    var rows = availableUnits().map(function (u) {
      var d = km(u.lat, u.lon, c.lat, c.lon) * 1.3;
      return { u: u, eta: Math.max(2, Math.round(d / u.speed * 60)) };
    }).sort(function (a, b) { return a.eta - b.eta; }).slice(0, 9);

    $('#sruTable').innerHTML = rows.map(function (r) {
      return '<tr><td>' + esc(r.u.callsign) + '</td>' +
        '<td>' + esc(r.u.capability.toUpperCase()) + '</td>' +
        '<td>' + esc(r.u.base) + '</td>' +
        '<td><span class="dot ' + r.u.status + '"></span>' + r.u.status + '</td>' +
        '<td>' + r.u.speed + ' km/h</td>' +
        '<td>' + r.u.fatigue + '%</td>' +
        '<td>' + r.eta + '′</td></tr>';
    }).join('');
    $('#sruCount').textContent = availableUnits().length + ' available';

    var list = state.decisions.slice().reverse();
    $('#ledgerCount').textContent = list.length + ' this shift';
    $('#ledger').innerHTML = list.length ? list.map(function (d) {
      return '<div class="lrow ' + (d.action === 'modified' ? 'override' : '') + '">' +
        '<span class="t">' + d.at + '</span><b>' + esc(d.id) + '</b> · ' + esc(d.action) +
        ' · ' + d.legs + ' legs · POD ' + d.pod + '%' + (d.reason ? ' · ' + esc(d.reason) : '') +
        (d.note ? ' — “' + esc(d.note) + '”' : '') + '</div>';
    }).join('') : '<div class="empty">No plan approved this shift. Every approval and every modification lands here with the time, the search plan and the reason.</div>';
  }

  function renderAll() {
    renderLeft();
    renderRight();
    renderMap();
    renderBottom();
    $('#clock').textContent = timeStr(state.clock);
  }

  function run() {
    var c = caseById(state.caseId);
    if (!c) return;
    state.sim = simulate(c);
    state.plan = planFor(c, state.sim);
    renderAll();
  }

  /* ---------------------------------------------------------------- actions */

  var runTimer;
  function queueRun() {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, 120);
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    setTimeout(function () { el.classList.remove('on'); }, 2200);
  }

  function approve(mod) {
    var c = caseById(state.caseId);
    if (!c || !state.plan) return;
    if (state.approved[c.id]) { toast('Plan already approved'); return; }
    state.approved[c.id] = timeStr(state.clock);
    state.decisions.push({
      at: timeStr(state.clock),
      id: c.id,
      action: mod ? 'modified' : 'approved',
      legs: state.plan.legs,
      pod: Math.round(state.plan.pod * 100),
      pos: Math.round(state.plan.pos * 100),
      reason: mod ? REASONS[mod.reason] : null,
      note: mod ? mod.note : null
    });
    state.clock += 1;
    renderAll();
    toast((mod ? 'Modified and approved' : 'Plan approved') + ' · ' + c.id);
  }

  function openModal() {
    $('#modReason').innerHTML = Object.keys(REASONS).map(function (k) {
      return '<option value="' + k + '">' + esc(REASONS[k]) + '</option>';
    }).join('');
    $('#modNote').value = '';
    $('#modal').hidden = false;
    $('#modReason').focus();
  }
  function closeModal() { $('#modal').hidden = true; }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    var open = openCases().slice().sort(function (a, b) { return slaLeft(a) - slaLeft(b); });
    state.caseId = open[0].id;

    run();

    $('#caseList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-case]');
      if (!b) return;
      state.caseId = b.getAttribute('data-case');
      run();
    });

    ['wind', 'windDir', 'cur', 'lee'].forEach(function (k) {
      $('#' + k).addEventListener('input', function (e) {
        state.params[k] = Number(e.target.value);
        if (k === 'lee' && !e.target.value) state.params.lee = null;
        queueRun();
      });
    });
    $('#btnRun').addEventListener('click', run);

    $$('.mapbar .tab').forEach(function (t) {
      t.addEventListener('click', function () {
        state.layer = t.getAttribute('data-tab');
        $$('.mapbar .tab').forEach(function (x) { x.setAttribute('aria-selected', x === t); });
        renderMap();
      });
    });

    $('#btnApprove').addEventListener('click', function () { approve(null); });
    $('#btnModify').addEventListener('click', openModal);
    $('#modCancel').addEventListener('click', closeModal);
    $('#modConfirm').addEventListener('click', function () {
      approve({ reason: $('#modReason').value, note: $('#modNote').value.trim() });
      closeModal();
    });
    $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    $('#btnExport').addEventListener('click', function () {
      var c = caseById(state.caseId);
      var payload = {
        case: { id: c.id, type: c.type, place: c.place, lkp: [c.lat, c.lon], reported: timeStr(START - c.reportedMinAgo) },
        environment: state.params,
        simulation: { particles: state.sim.total, cells: state.sim.cells.length, hours: state.sim.hours },
        pol: state.sim.cells.slice(0, 10).map(function (cl) {
          var g = unproj(cl.x, cl.y);
          return { lat: +g.lat.toFixed(4), lon: +g.lon.toFixed(4), p: +(cl.p * 100).toFixed(2) };
        }),
        plan: state.plan ? {
          pattern: 'parallel track', legs: state.plan.legs, spacing_km: +state.plan.spacingKm.toFixed(1),
          track_km: state.plan.lengthKm, pod: +(state.plan.pod * 100).toFixed(1), pos: +(state.plan.pos * 100).toFixed(1)
        } : null,
        decisions: state.decisions
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sarops-' + c.id + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      toast('Plan exported');
    });

    window.addEventListener('resize', function () { if (state.sim) renderMap(); });

    // coordinate readout
    $('#mapHost').addEventListener('mousemove', function (e) {
      var svg = $('#mapHost svg');
      if (!svg) return;
      var r = svg.getBoundingClientRect();
      var c = caseById(state.caseId);
      if (!c) return;
      var vb = svg.viewBox.baseVal;
      var px = (e.clientX - r.left) / r.width * vb.width + vb.x;
      var py = (e.clientY - r.top) / r.height * vb.height + vb.y;
      var g = unproj(px, py);
      $('#coords').textContent = g.lat.toFixed(3) + '°N ' + g.lon.toFixed(3) + '°E · ' + state.sim.total + ' particles';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
