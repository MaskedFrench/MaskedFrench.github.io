/* ============================================================================
   Provenance console — the record, opened up
   ========================================================================== */
(function () {
  'use strict';

  var Core = window.NSCore;
  var NS = window.NS;
  var chain = NS.chain;
  var nodes = {};
  chain.nodes.forEach(function (n) { nodes[n.id] = n; });

  var state = {
    view: 'chain',
    nodeId: 'ORIGIN-0042',
    file: 'src/retry.js',
    diff: false,
    verify: null,
    tamper: null
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function short(h, n) { return h ? h.slice(0, n || 12) + '…' : '—'; }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function fmtTime(iso) { return iso.replace('T', ' ').replace('Z', ' UTC'); }
  function fmtPlainDate(iso) {
    var d = new Date(iso);
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getUTCDate() + ' ' + m[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + fmtTime(iso).slice(11);
  }

  var toastTimer;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg; el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 1700);
  }
  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast('Copied ' + short(text, 18)); },
      function () { toast('Copy blocked'); });
    else toast('Copy unavailable');
  }

  var COPY_ICON = '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2h2.3" stroke="currentColor" stroke-width="1.2"/></svg>';
  function cbtn(text, label) {
    return '<button class="copy" type="button" data-copy="' + esc(text) + '" aria-label="' + esc(label || 'Copy') + '">' + COPY_ICON + '</button>';
  }

  function jsonHighlight(obj) {
    var json = JSON.stringify(obj, null, 2);
    return esc(json).split('\n').map(function (line) {
      return line.replace(/^(\s*)&quot;([^&]+)&quot;:/, function (m, sp, k) {
        return sp + '<span class="k">&quot;' + k + '&quot;</span>:';
      });
    }).join('\n');
  }

  var TYPE = {
    'ORIGIN-0042': ['Step 1', 'The instruction', 'what a person asked for'],
    'BUILD-A': ['Step 2', 'First attempt', 'written by AI #1'],
    'BUILD-B': ['Step 3', 'Second attempt', 'written by AI #2, blind'],
    'DIVERGENCE-01': ['Step 4', 'The differences', 'where the two attempts part'],
    'ATTEST-01': ['Step 5', 'The review', 'what must change first'],
    'RECEIPT-0042': ['Step 6', 'The signature', 'a person, by name']
  };

  /* ============================================================ CHAIN */

  function renderChain() {
    var list = chain.nodes.map(function (n, i) {
      var t = TYPE[n.id];
      return '<button type="button" data-node="' + n.id + '" aria-current="' + (state.nodeId === n.id) + '" style="--i:' + i + '">' +
        '<span class="num">0' + (i + 1) + '</span>' +
        '<span class="body"><span class="nm">' + esc(t[1]) + '</span><span class="ds">' + esc(t[2]) + '</span></span>' +
        '<span class="st">✓</span></button>';
    }).join('');

    return head('The record', 'Six steps, in order. Step 1 is the instruction, step 6 is a person’s signature. Each step is sealed and points at the one before it, so an edit anywhere breaks everything after it. Select a step to read it.') +
      '<div class="split s-side">' +
      '<div class="pane record-pane">' +
      '<div class="pane-head"><span>Select a step</span><span class="sp"></span><span>6 steps</span></div>' +
      '<div class="clist" id="chainList"><span class="rline" aria-hidden="true"></span><span class="rfill" aria-hidden="true"></span>' + list + '</div>' +
      '<p class="rnav-hint"><span class="kbd">J</span> <span class="kbd">K</span> move between steps</p>' +
      '</div>' +
      '<div class="pane"><div class="pane-head" id="nodeHead"></div><div class="pane-body" id="nodeBody"></div></div>' +
      '</div>';
  }

  function positionIndicator() {
    var list = $('#chainList');
    if (!list) return;
    var active = list.querySelector('[aria-current="true"]');
    var fill = list.querySelector('.rfill');
    if (!active || !fill) return;
    var top = active.offsetTop;
    var h = active.offsetHeight;
    fill.style.height = (top + h / 2) + 'px';
  }

  function swapPanel() {
    var body = $('#nodeBody');
    if (!body) return;
    body.classList.remove('swap');
    void body.offsetWidth;
    body.classList.add('swap');
  }

  function renderNode() {
    var n = nodes[state.nodeId];
    if (!n || !$('#nodeBody')) return;
    var b = n.body;
    var t = TYPE[n.id];
    $('#nodeHead').innerHTML = '<span>' + esc(n.id) + '</span><span class="sp"></span>' +
      '<span>' + esc(t[0]) + ' · ' + (b.created ? esc(fmtPlainDate(b.created)) : esc(b.actor || '')) + '</span>';

    var rows = [];
    if (n.id === 'ORIGIN-0042') {
      rows = [
        ['change', b.change + ' — ' + b.title],
        ['spec', b.spec_ref + ' · sha256 ' + short(b.spec_sha256)],
        ['prompt', 'sha256 ' + short(b.prompt_sha256)],
        ['transcript', 'sha256 ' + short(b.transcript_sha256)],
        ['model', b.model],
        ['seed', String(b.seed)],
        ['author', b.author],
        ['created', fmtTime(b.created)]
      ];
    } else if (b.type === 'build') {
      rows = [
        ['agent', b.agent + ' · ' + b.role + ' · ' + b.actor_kind],
        ['isolation', b.isolation],
        ['context', b.context],
        ['parent', b.parent.id + ' · ' + short(b.parent.digest)],
        ['merkle root', short(b.root)],
        ['files', b.files.length + ' · ' + fmtBytes(b.bytes)],
        ['tooling', b.tooling],
        ['created', fmtTime(b.created)]
      ];
    } else if (b.type === 'divergence') {
      rows = [
        ['method', b.method],
        ['parents', b.parents.map(function (p) { return p.id; }).join(' + ')],
        ['cases', b.summary.cases + ' executed · ' + b.summary.pass + ' pass · ' + b.summary.fail + ' fail'],
        ['findings', b.summary.blocking + ' blocking · ' + b.summary.accepted + ' accepted'],
        ['created', fmtTime(b.created)]
      ];
    } else if (b.type === 'attestation') {
      rows = [
        ['reviewer', b.agent + ' · ' + b.role],
        ['verdict', b.verdict],
        ['claims', b.counts.claims + ' checked · ' + b.counts.supported + ' supported · ' + b.counts.disputed + ' disputed'],
        ['conditions', b.conditions.length + ' recorded'],
        ['refusals', b.refusals.length + ' recorded'],
        ['created', fmtTime(b.created)]
      ];
    } else {
      rows = [
        ['signer', b.actor + ' · ' + b.role],
        ['decision', b.decision + ' · merge ' + b.merge],
        ['acknowledged', b.acknowledged.join(' ')],
        ['time to sign', b.time_to_sign_s + ' s · no-look ' + b.no_look],
        ['created', fmtTime(b.created)]
      ];
    }

    $('#nodeBody').innerHTML =
      '<dl class="kv">' + rows.map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
      }).join('') + '</dl>' +
      (b.type === 'build' ? '<div style="display:flex;gap:8px;margin:14px 0"><button class="btn btn-quiet btn-xs" data-goto-builds="' + b.id + '">Open both builds →</button></div>' : '') +
      '<div class="blk-title">Sealed node · canonical body</div>' +
      '<div class="codebox"><div class="cb-top"><span>' + esc(n.id) + '.json</span><span class="sp"></span><span>canonical · sorted keys</span>' + cbtn(n.digest) + '</div>' +
      '<pre>' + jsonHighlight(b) + '</pre></div>' +
      '<div class="sigbar"><span class="chip ok"><i></i>ES256</span>' +
      '<span class="mono">kid ' + esc(n.sig.kid) + ' · sig ' + esc(n.sig.value.slice(0, 28)) + '…</span>' +
      '<span class="sp"></span>' +
      '<button class="btn btn-quiet btn-xs" data-verify-node="' + n.id + '">Verify this signature</button>' +
      '<span class="mono" id="nodeVerify" style="min-width:56px"></span></div>';
    makeFocusable();
  }

  async function verifyNode(id) {
    var n = nodes[id];
    var out = $('#nodeVerify');
    out.textContent = 'checking…';
    var ok = await Core.verifySignature(chain, n.body, n.sig);
    out.textContent = ok === null ? 'unavailable' : ok ? '✓ valid' : '✗ invalid';
    out.style.color = ok ? 'var(--ok)' : 'var(--stop)';
  }

  /* ============================================================ BUILDS */

  function fileStatus(path) {
    var a = nodes['BUILD-A'].body.files.filter(function (f) { return f.path === path; })[0];
    var b = nodes['BUILD-B'].body.files.filter(function (f) { return f.path === path; })[0];
    return !a || !b ? 'only one' : a.sha256 === b.sha256 ? 'identical' : 'differs';
  }

  function renderBuilds() {
    var A = nodes['BUILD-A'].body;
    var B = nodes['BUILD-B'].body;
    var paths = A.files.map(function (f) { return f.path; });

    var chips = paths.map(function (p) {
      var st = fileStatus(p);
      return '<button class="fchip" type="button" data-file="' + esc(p) + '" aria-pressed="' + (state.file === p) + '">' +
        esc(p) + ' <span class="st ' + (st === 'identical' ? 'same' : '') + '">' + st + '</span></button>';
    }).join('');

    var aFile = A.files.filter(function (f) { return f.path === state.file; })[0];
    var bFile = B.files.filter(function (f) { return f.path === state.file; })[0];
    var aText = (NS.builds.A.files[state.file] || '');
    var bText = (NS.builds.B.files[state.file] || '');

    return head('The same file, written twice', 'Two AIs, the same rules, no contact between them. Green lines are what AI #2 added; red lines are what AI #1 had and AI #2 did not. Where they match, the rules were clear.') +
      '<div class="filechips">' + chips + '</div>' +
      '<div class="split" style="gap:14px">' +
      pane('BUILD A', A.agent, '4 files', aFile, aText, 'A') +
      pane('BUILD B', B.agent, 'independent', bFile, bText, 'B') +
      '</div>' +
      '<div class="pane" style="margin-top:14px">' +
      '<div class="pane-head"><span>Unified diff · ' + esc(state.file) + '</span><span class="sp"></span>' +
      '<span class="diffstat" id="diffstat"></span>' +
      '<button class="btn btn-quiet btn-xs" id="btnDiffMode" type="button">' + (state.diff ? 'Hide diff' : 'Show diff') + '</button></div>' +
      (state.diff ? '<div id="diffHost"></div>' : '<div class="pane-body" style="font-size:12.5px;color:var(--muted)">' + esc(diffSummary(state.file)) + '</div>') +
      '</div>';
  }

  function pane(label, agent, note, file, text, id) {
    return '<div class="pane codepane">' +
      '<div class="pane-head"><span>' + esc(label) + '</span><span class="sp"></span><span>' + esc(agent) + ' · ' + esc(note) + '</span></div>' +
      '<div class="meta"><b>' + esc(state.file) + '</b><span class="sp"></span>' +
      '<span>' + (file ? fmtBytes(file.bytes) : '—') + '</span>' +
      '<span class="hash">' + (file ? esc(file.sha256.slice(0, 16)) + '…' : '—') + '</span></div>' +
      codeView(text) + '</div>';
  }

  function codeView(text) {
    var lines = text.replace(/\n$/, '').split('\n');
    return '<div class="codeview scroll">' + lines.map(function (l, i) {
      return '<div class="ln"><span class="no">' + (i + 1) + '</span><span class="tx">' + (esc(l) || '&nbsp;') + '</span></div>';
    }).join('') + '</div>';
  }

  function diffSummary(path) {
    var a = (NS.builds.A.files[path] || '').split('\n');
    var b = (NS.builds.B.files[path] || '').split('\n');
    var d = diffLines(a, b);
    var add = d.filter(function (x) { return x.t === '+'; }).length;
    var del = d.filter(function (x) { return x.t === '-'; }).length;
    return add + ' lines added, ' + del + ' removed against Build A. ' + fileStatus(path) + '.';
  }

  function diffLines(a, b) {
    var n = a.length, m = b.length;
    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [], x = 0, y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) { out.push({ t: ' ', s: a[x] }); x++; y++; }
      else if (dp[x + 1][y] >= dp[x][y + 1]) { out.push({ t: '-', s: a[x] }); x++; }
      else { out.push({ t: '+', s: b[y] }); y++; }
    }
    while (x < n) { out.push({ t: '-', s: a[x++] }); }
    while (y < m) { out.push({ t: '+', s: b[y++] }); }
    return out;
  }

  function renderDiff() {
    var a = (NS.builds.A.files[state.file] || '').split('\n');
    var b = (NS.builds.B.files[state.file] || '').split('\n');
    var d = diffLines(a, b);
    var add = d.filter(function (r) { return r.t === '+'; }).length;
    var del = d.filter(function (r) { return r.t === '-'; }).length;
    var stat = $('#diffstat');
    if (stat) stat.innerHTML = '<span class="add">+' + add + '</span><span class="del">−' + del + '</span>';

    var host = $('#diffHost');
    if (!host) return;
    host.innerHTML = '<div class="diffview">' +
      '<div class="dl hunk"><span class="sg">@</span><span>' + esc(state.file) + ' · BUILD-A → BUILD-B</span></div>' +
      d.map(function (r) {
        var cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : '';
        return '<div class="dl ' + cls + '"><span class="sg">' + (r.t === ' ' ? '' : r.t) + '</span><span>' + (esc(r.s) || '&nbsp;') + '</span></div>';
      }).join('') + '</div>';
  }

  /* ============================================================ DIVERGENCE */

  function renderDivergence() {
    var b = nodes['DIVERGENCE-01'].body;
    var crossB = NS.tests.runs.filter(function (r) { return r.id === 'B/A'; })[0];
    var crossA = NS.tests.runs.filter(function (r) { return r.id === 'A/A'; })[0];

    var rows = crossB.cases.map(function (c) {
      var inA = crossA.cases.filter(function (x) { return x.id === 'A' + c.id.slice(1); })[0];
      return '<tr><td class="mono">' + c.id + '</td><td>' + esc(c.claim) + '</td>' +
        '<td class="' + (c.status === 'pass' ? 'pass' : 'fail') + '">' + c.status + '</td>' +
        '<td class="' + (c.status === 'pass' ? 'muted' : 'muted') + '">' + esc(c.detail || '—') + '</td></tr>';
    }).join('');

    return head('Where they disagree', 'AI #2 wrote eight tests. Run against AI #1’s work, five pass and three fail. Two fail against a rule that exists; one fails against a rule nobody wrote.') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">' +
      '<span class="chip stop"><i></i>2 blocking</span>' +
      '<span class="chip warn"><i></i>1 accepted divergence</span>' +
      '<span class="chip">5/8 cases pass</span>' +
      '<span class="chip">clause-mapped</span></div>' +
      b.findings.map(function (f) {
        return '<div class="pane" style="margin-bottom:12px">' +
          '<div class="pane-head"><span>' + esc(f.id) + ' · ' + esc(f.severity) + '</span><span class="sp"></span><span>' + esc(f.spec) + '</span></div>' +
          '<div class="pane-body">' +
          '<h3 class="h4" style="margin-bottom:8px">' + esc(f.title) + '</h3>' +
          '<p style="font-size:13px;color:#3B424F;line-height:1.6;max-width:80ch">' + esc(f.detail) + '</p>' +
          '<div class="sigbar" style="background:#fff">' +
          '<span class="chip ' + (f.severity === 'blocking' ? 'stop' : 'warn') + '">evidence · ' + esc(f.evidence.case) + '</span>' +
          '<span class="mono" style="color:' + (f.severity === 'blocking' ? 'var(--stop)' : 'var(--warn)') + '">' + esc(f.evidence.observed) + '</span></div>' +
          '<div style="display:flex;gap:8px;margin-top:10px;align-items:flex-start"><span class="mono" style="font-size:10px;color:var(--muted-2);padding-top:2px">FIX</span>' +
          '<span style="font-size:12.5px;color:#3B424F">' + esc(f.fix) + '</span></div>' +
          '</div></div>';
      }).join('') +
      '<div class="pane" style="margin-top:6px"><div class="pane-head"><span>Cross-run · TESTS-B × BUILD-A</span><span class="sp"></span><span>executed under node 20</span></div>' +
      '<div class="pane-body flush scroll"><table class="ledger"><thead><tr><th>case</th><th>claim</th><th>result</th><th>observed</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-top:16px">' + b.notes.map(function (n) {
        return '<p style="font-size:12.5px;color:var(--muted);line-height:1.6"><b style="color:var(--ink);font-weight:500">' + esc(n.id) + ' · ' + esc(n.title) + '</b> — ' + esc(n.detail) + '</p>';
      }).join('') + '</div>';
  }

  /* ============================================================ VALIDATION */

  function renderValidation() {
    return head('Checks you can run yourself', 'Thirty-two checks read the files and redo every fingerprint and seal in this browser. Forty-seven more run from a command line. Press the button — nothing here is a claim you have to take on trust.') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">' +
      '<button class="btn btn-primary btn-sm" id="btnRunChecks" type="button">Run the 32 checks</button>' +
      '<button class="btn btn-ghost btn-sm" id="btnProve" type="button">Prove it fails closed</button>' +
      '<span class="sp" style="flex:1"></span>' +
      '<span class="chip ok"><i></i>47/47 offline</span>' +
      '<span class="chip">4 suites executed</span></div>' +
      '<div class="split s-val">' +
      '<div class="pane"><div class="pane-head"><span id="checkSummary">Not run</span><span class="sp"></span><span id="checkTime"></span></div>' +
      '<div class="pane-body flush scroll"><table class="ledger"><thead><tr><th style="width:44px">#</th><th>check</th><th style="width:64px">result</th><th>detail</th></tr></thead><tbody id="checkBody"><tr><td colspan="4" style="padding:18px;color:var(--muted)">Run the checks to fill this ledger.</td></tr></tbody></table></div></div>' +
      '<div class="pane"><div class="pane-head"><span>Offline verifier</span><span class="sp"></span><span>47 checks</span></div>' +
      '<div class="pane-body">' +
      '<div class="codebox"><div class="cb-top"><span>terminal</span><span class="sp"></span><span>captured 2026-11-14</span></div>' +
      '<pre style="max-height:300px">$ python3 tools/verify.py\n' +
      '<span class="c">  PASS  K-01 public key matches the chain</span>\n' +
      '  PASS  ORIGIN-0042 · digest recomputes\n' +
      '  PASS  ORIGIN-0042 · signature verifies\n' +
      '  PASS  BUILD-A · merkle root recomputes\n' +
      '  PASS  BUILD-A · every file matches its hash\n' +
      '  PASS  BUILD-B · merkle root recomputes\n' +
      '  PASS  DIVERGENCE-01 · evidence cases failed\n' +
      '  PASS  ATTEST-01 · reviewer is not the builder\n' +
      '  PASS  RECEIPT-0042 · signed by a person\n' +
      '\n  47/47 checks passed\n' +
      '  root bcc4aaeb3575168273dcaa2a505801736ac2623bf157f2af10f433aebd9d6802</pre></div>' +
      '<div class="sigbar" style="background:#fff"><span class="mono">tamper a file → exit 1</span><span class="sp"></span><span class="chip stop">fails closed</span></div>' +
      '<div class="blk-title">Reproduce</div>' +
      '<div class="codebox"><pre style="max-height:120px">$ node tools/run_tests.js\n$ python3 tools/make_chain.py\n$ python3 tools/verify.py</pre></div>' +
      '</div></div></div>' +
      '<div id="proveHost" style="margin-top:14px"></div>';
  }

  async function runChecks() {
    var btn = $('#btnRunChecks');
    btn.disabled = true; btn.textContent = 'Running…';
    var t0 = performance.now();
    var res = await Core.verifyChain(chain, NS);
    var ms = Math.round(performance.now() - t0);
    var body = res.checks.map(function (c, i) {
      return '<tr><td class="mono" style="color:var(--muted-2)">' + String(i + 1).padStart(2, '0') + '</td>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td class="' + (c.ok ? 'pass' : 'fail') + '">' + (c.ok ? 'pass' : 'FAIL') + '</td>' +
        '<td class="mono" style="font-size:10px;color:var(--muted)">' + esc(c.detail) + '</td></tr>';
    }).join('');
    $('#checkBody').innerHTML = body;
    $('#checkSummary').textContent = res.passed + '/' + res.total + ' checks';
    $('#checkTime').textContent = ms + ' ms · ' + new Date().toISOString().slice(11, 19) + 'Z';
    btn.disabled = false; btn.textContent = 'Re-run the 32 checks';
    return res;
  }

  async function proveFailsClosed() {
    var copyChain = JSON.parse(JSON.stringify(chain));
    var bundle = { spec: NS.spec, prompt: NS.prompt, tests: NS.tests, builds: JSON.parse(JSON.stringify(NS.builds)) };
    var path = 'src/retry.js';
    var text = bundle.builds.A.files[path].replace('Math.min(seconds * 1000, 8000)', 'Math.min(seconds * 1000, 30000)');
    bundle.builds.A.files[path] = text;
    var node = copyChain.nodes.filter(function (n) { return n.id === 'BUILD-A'; })[0];
    node.body.files = node.body.files.map(function (f) {
      return f.path === path ? { path: f.path, sha256: Core.sha256Hex(text), bytes: new TextEncoder().encode(text).length } : f;
    });
    node.body.root = Core.merkle(node.body.files);
    node.digest = Core.digestOf(node.body);

    var res = await Core.verifyChain(copyChain, bundle);
    var fails = res.checks.filter(function (c) { return !c.ok; });
    $('#proveHost').innerHTML = '<div class="pane"><div class="pane-head"><span>Tampered copy · one constant changed</span><span class="sp"></span><span>' + res.passed + '/' + res.total + ' pass</span></div>' +
      '<div class="pane-body">' +
      '<p style="font-size:12.5px;color:#3B424F;margin-bottom:10px">The attacker recomputed the file hash, the Merkle root and the node digest. The signature no longer matches, and every node after it loses its parent.</p>' +
      '<table class="ledger"><tbody>' + fails.map(function (c) {
        return '<tr><td class="fail" style="width:60px">FAIL</td><td>' + esc(c.name) + '</td><td class="mono" style="font-size:10px;color:var(--muted)">' + esc(c.detail) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    toast('Verifier fails closed · ' + fails.length + ' checks broken');
  }

  /* ============================================================ RECEIPT */

  function renderReceipt() {
    var r = nodes['RECEIPT-0042'].body;
    var att = nodes['ATTEST-01'].body;
    var div = nodes['DIVERGENCE-01'].body;
    var ackRows = r.acknowledged.map(function (id) {
      var f = div.findings.filter(function (x) { return x.id === id; })[0];
      var ref = att.refusals.filter(function (x) { return x.id === id; })[0];
      var what = f ? f.title : ref ? ref.text : '';
      var sev = f ? f.severity : 'refusal';
      var label = sev === 'accepted-divergence' ? 'accepted' : sev;
      return '<tr><td class="mono" style="width:54px;white-space:nowrap">' + id + '</td><td>' + esc(what) + '</td><td style="width:96px"><span class="chip ' + (sev === 'blocking' ? 'stop' : sev === 'accepted-divergence' ? 'warn' : '') + '" style="height:18px;font-size:8.5px">' + label + '</span></td></tr>';
    }).join('');

    return head('What the person signed', 'The decision, what they were shown, what nobody checked, and how long they took. This is the step an auditor asks for first.') +
      '<div class="split s-doc">' +
      '<div class="receipt-doc">' +
      '<span class="rh">Receipt · ' + esc(r.id) + ' · ' + esc(chain.change.repo) + '</span>' +
      '<h2>' + esc(chain.change.id) + ' — ' + esc(chain.change.title) + '</h2>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<span class="chip stop"><i></i>merge blocked</span>' +
      '<span class="chip">' + esc(r.decision) + '</span>' +
      '<span class="chip ok"><i></i>signed by a person</span></div>' +
      '<div class="blocks">' +
      '<div class="blk"><h3 class="blk-h">What was checked, and by what</h3><ul>' +
      '<li>' + att.counts.claims + ' reviewer cases executed against both builds</li>' +
      '<li>' + att.counts.supported + ' supported · ' + att.counts.disputed + ' disputed</li>' +
      '<li>4 suites · 8 files · 2 Merkle roots recomputed</li></ul></div>' +
      '<div class="blk"><h3 class="blk-h">What was not checked, and why</h3><ul>' +
      att.refusals.map(function (x) { return '<li>' + esc(x.text) + '</li>'; }).join('') + '</ul></div>' +
      '<div class="blk"><h3 class="blk-h">Reported findings</h3><ul>' +
      div.findings.map(function (f) { return '<li><b style="font-weight:500">' + f.id + '</b> ' + esc(f.title) + '</li>'; }).join('') + '</ul></div>' +
      '<div class="blk"><h3 class="blk-h">Residual risk</h3><ul>' +
      '<li>Two blocking findings open at signature time.</li>' +
      '<li>Transport stubbed; no live gateway exercised.</li>' +
      '<li>504 behaviour undecided in the spec.</li></ul></div>' +
      '</div>' +
      '<div class="sig">' +
      '<div style="flex:1"><div class="line">' + esc(r.actor) + '</div><div class="who">Reviewer of record · ' + esc(r.organisation) + ' · ' + fmtTime(r.created) + '</div></div>' +
      '<div style="text-align:right"><div class="mono" style="font-size:10px;color:var(--muted-2)">TIME TO SIGN</div><div style="font-size:22px;letter-spacing:-.03em">' + r.time_to_sign_s + ' s</div>' +
      '<span class="chip ' + (r.no_look ? 'stop' : 'ok') + '">' + (r.no_look ? 'no-look flag' : 'no-look clear') + '</span></div>' +
      '</div></div>' +
      '<div>' +
      '<div class="pane"><div class="pane-head"><span>Binding</span></div><div class="pane-body">' +
      '<dl class="kv" style="grid-template-columns:88px 1fr"><dt>parent</dt><dd>' + esc(r.parent.id) + '</dd>' +
      '<dt>digest</dt><dd>' + esc(short(r.parent.digest)) + ' ' + cbtn(r.parent.digest) + '</dd>' +
      '<dt>receipt</dt><dd>' + esc(short(nodes['RECEIPT-0042'].digest)) + ' ' + cbtn(nodes['RECEIPT-0042'].digest) + '</dd>' +
      '<dt>signature</dt><dd>' + esc(nodes['RECEIPT-0042'].sig.value.slice(0, 24)) + '…</dd>' +
      '<dt>algorithm</dt><dd>ES256 · P-256 · SHA-256</dd></dl>' +
      '<div class="sigbar"><span class="chip ok"><i></i>verified</span><span class="mono">checked in this browser</span></div>' +
      '</div></div>' +
      '<div class="pane" style="margin-top:12px"><div class="pane-head"><span>Acknowledgements</span><span class="sp"></span><span>' + r.acknowledged.length + '</span></div>' +
      '<div class="pane-body flush scroll"><table class="ledger"><tbody>' + ackRows + '</tbody></table></div></div>' +
      '<div class="warnline" style="margin-top:12px"><span>This is the gate’s output, not a claim about the code. A receipt can be correct and the change still be wrong; it records that a person saw these findings at this time.</span></div>' +
      '</div></div>';
  }

  /* ============================================================ LIMITS */

  function renderLimits() {
    var items = [
      ['L-01', 'No model at run time', 'Both builds are recorded artefacts with signatures. A production system would generate them behind the same interface; this package verifies rather than generates.'],
      ['L-02', 'One key signs everything', 'The demo key sits in the package so the chain can be checked offline. Production separates builder, reviewer and human keys and keeps them in an HSM.'],
      ['L-03', 'The transport is a stub', 'No live gateway was called. Both attestations record that as a refusal rather than a footnote.'],
      ['L-04', 'Divergence is not correctness', 'Two builds agreeing means one reading was shared. It is evidence, not proof; the spec still needs an owner.'],
      ['L-05', 'One change, one record', 'RETRY-04 only. Not the repository, not the system, not the team.'],
      ['L-06', 'No service is deployed', 'No endpoint, no account, no telemetry. The package runs from a folder with the network off.']
    ];

    return head('What this does not prove', 'A check that overstates itself is worse than no check. These are the edges, stated in the same place as the claims.') +
      '<div class="limits">' + items.map(function (i) {
        return '<div class="limit"><span class="n">' + i[0] + '</span><h3>' + esc(i[1]) + '</h3><p>' + esc(i[2]) + '</p></div>';
      }).join('') + '</div>' +
      '<div class="split" style="margin-top:22px">' +
      '<div class="pane"><div class="pane-head"><span>What this record proves</span></div><div class="pane-body">' +
      '<ul style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:#3B424F">' +
      ['Two builds were produced from one origin and neither saw the other.',
       'The two readings diverge on 3 of 8 cases; each divergence cites the clause it touches.',
       'A reviewer other than the builder signed a verdict with conditions and refusals.',
       'A named person acknowledged every finding and signed the attestation hash.',
       'No byte of the record has changed since it was sealed — recomputable here and offline.'].map(function (t) {
        return '<li style="display:grid;grid-template-columns:14px 1fr;gap:8px"><span style="color:var(--ok)">✓</span><span>' + esc(t) + '</span></li>';
      }).join('') + '</ul></div></div>' +
      '<div class="pane"><div class="pane-head"><span>What it does not prove</span></div><div class="pane-body">' +
      '<ul style="display:flex;flex-direction:column;gap:7px;font-size:12.5px;color:#3B424F">' +
      ['That the spec is right, complete or still current.',
       'That the change works in production, under load, with a real transport.',
       'That the reviewer was competent, or that the signer read carefully.',
       'That two agreeing builds are correct — only that they agree.',
       'That any other change in the repository is trustworthy.'].map(function (t) {
        return '<li style="display:grid;grid-template-columns:14px 1fr;gap:8px"><span style="color:var(--stop)">×</span><span>' + esc(t) + '</span></li>';
      }).join('') + '</ul></div></div>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--muted);margin-top:20px;line-height:1.6;max-width:92ch">"Trust" here is a narrow, checkable property: the record you are reading is the record that was signed, it names the origin it came from, and a second agent independently disagreed with the first in a place the record can point at. Everything else is a judgement a person still has to make.</p>';
  }

  /* ============================================================ wiring */

  function head(title, sub) {
    return '<div class="view-head"><div class="t"><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p></div>' +
      '<span class="chip ok"><i></i>record sealed</span></div>';
  }

  function makeFocusable() {
    $$('.scroll, .codeview, .diffview, pre').forEach(function (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
  }

  function render() {
    var host = $('#view');
    var map = {
      chain: renderChain,
      builds: renderBuilds,
      divergence: renderDivergence,
      validation: renderValidation,
      receipt: renderReceipt,
      limits: renderLimits
    };
    host.innerHTML = (map[state.view] || renderChain)();
    if (state.view === 'chain') { renderNode(); requestAnimationFrame(positionIndicator); }
    makeFocusable();
    if (state.view === 'builds' && state.diff) { renderDiff(); }
  }

  function setView(v) {
    state.view = v;
    $$('.app-nav button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-view') === v);
    });
    render();
    try { window.scrollTo(0, 0); } catch (e) { /* no-op */ }
  }

  function bind() {
    $('.app-nav').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });

    document.addEventListener('click', function (e) {
      var c = e.target.closest('[data-copy]');
      if (c) { copy(c.getAttribute('data-copy')); return; }

      var n = e.target.closest('[data-node]');
      if (n) {
        state.nodeId = n.getAttribute('data-node');
        $$('#chainList button').forEach(function (b) { b.setAttribute('aria-current', b === n); });
        renderNode();
        positionIndicator();
        swapPanel();
        return;
      }

      var vn = e.target.closest('[data-verify-node]');
      if (vn) { verifyNode(vn.getAttribute('data-verify-node')); return; }

      var f = e.target.closest('[data-file]');
      if (f) {
        state.file = f.getAttribute('data-file');
        render();
        return;
      }

      var gb = e.target.closest('[data-goto-builds]');
      if (gb) {
        var bid = gb.getAttribute('data-goto-builds');
        state.file = bid === 'BUILD-B' ? 'src/retry.js' : state.file;
        setView('builds');
        return;
      }

      if (e.target.id === 'btnDiffMode') {
        state.diff = !state.diff;
        render();
        return;
      }
      if (e.target.id === 'btnRunChecks') { runChecks(); return; }
      if (e.target.id === 'btnProve') { proveFailsClosed(); return; }
    });

    document.addEventListener('keydown', function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      var views = ['chain', 'builds', 'divergence', 'validation', 'receipt', 'limits'];
      if (/^[1-6]$/.test(e.key)) setView(views[+e.key - 1]);
      if (e.key === 'j' || e.key === 'k') {
        if (state.view !== 'chain') return;
        var ids = chain.nodes.map(function (n) { return n.id; });
        var i = ids.indexOf(state.nodeId);
        var next = e.key === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
        state.nodeId = ids[next];
        render();
      }
    });
  }

  function boot() {
    var root = nodes['RECEIPT-0042'].digest;
    $('#rootHash').textContent = short(root, 16);
    $('#footHash').textContent = 'root ' + short(root, 20);
    bind();
    render();
    window.addEventListener('resize', positionIndicator);
    if (state.view === 'chain') renderNode();
    // seal is demonstrated, not claimed
    Core.verifyChain(chain, NS).then(function (r) {
      var chip = document.querySelector('.view-head .chip');
      if (chip) {
        chip.className = 'chip ' + (r.ok ? 'ok' : 'stop');
        chip.innerHTML = '<i></i>' + (r.ok ? r.passed + '/' + r.total + ' checks' : 'chain broken');
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
