/* ============================================================================
   Northstar Trust — home page behaviour
   Six steps, two modes, one verifier. Everything computed from assets/data.js.
   ========================================================================== */
(function () {
  'use strict';

  var Core = window.NSCore;
  var NS = window.NS;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function short(h, n) { return h ? h.slice(0, n || 10) + '…' : '—'; }
  function fmtBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function bytesOf(str) { return new TextEncoder().encode(str).length; }

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 1800);
  }

  var COPY_ICON = '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.2"/><path d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2h2.3" stroke="currentColor" stroke-width="1.2"/></svg>';
  function copyBtn(text, label) {
    return '<button class="copy" type="button" data-copy="' + esc(text) + '" aria-label="' + esc(label || 'Copy') + '">' + COPY_ICON + '</button>';
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied · ' + short(text)); },
        function () { toast('Copy blocked by the browser'); });
    } else { toast('Copy unavailable'); }
  }

  /* ---------------------------------------------------------------- labels */

  var NODE_STEP = {
    'ORIGIN-0042': ['1', 'The instruction', 'what a person asked for'],
    'BUILD-A': ['2', 'First attempt', 'written by AI #1'],
    'BUILD-B': ['3', 'Second attempt', 'written by AI #2, blind'],
    'DIVERGENCE-01': ['4', 'The differences', 'where the two attempts part'],
    'ATTEST-01': ['5', 'The review', 'what must change first'],
    'RECEIPT-0042': ['6', 'The signature', 'a person, by name']
  };

  function plainDate(iso) {
    var d = new Date(iso);
    var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCDate() + ' ' + m[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }
  function plainDuration(sec) {
    if (sec < 60) return sec + ' seconds';
    return Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s';
  }

  var state = {
    chain: null,
    bundle: null,
    active: 'ORIGIN-0042',
    mode: 'plain',
    tampered: false,
    checks: null,
    issues: {}
  };

  function cloneData() {
    state.chain = JSON.parse(JSON.stringify(NS.chain));
    state.bundle = {
      spec: NS.spec, prompt: NS.prompt, tests: NS.tests,
      builds: JSON.parse(JSON.stringify(NS.builds))
    };
    state.active = 'ORIGIN-0042';
    state.tampered = false;
    state.checks = null;
    state.issues = {};
  }

  function nodeOf(id) {
    return state.chain.nodes.filter(function (n) { return n.id === id; })[0];
  }

  /* ---------------------------------------------------------------- hero record */

  function renderRecord() {
    $('#recordNodes').innerHTML = NS.chain.nodes.map(function (n, i) {
      var l = NODE_STEP[n.id];
      var last = n.id === 'RECEIPT-0042';
      return '<li><button class="rstep" type="button" data-record-node="' + n.id + '" ' +
        'aria-current="' + (state.active === n.id) + '" style="--i:' + i + '">' +
        '<span class="n">0' + esc(l[0]) + '</span>' +
        '<span><span class="t">' + esc(l[1]) + '</span><span class="d">' + esc(l[2]) + '</span></span>' +
        '<span class="m">' + (last ? 'signed' : 'sealed') + '</span></button></li>';
    }).join('');

    var rec = NS.chain.nodes[NS.chain.nodes.length - 1];
    $('#recordMeta').textContent = 'Signed by ' + rec.body.actor;
    $('#footStamp').textContent = 'the record · ' + short(rec.digest, 12);
  }

  function renderRecordActive() {
    $$('[data-record-node]').forEach(function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-record-node') === state.active);
    });
  }

  /* ---------------------------------------------------------------- plain panels */

  var PLAIN_FINDINGS = {
    'F-01': {
      title: 'It stops waiting too early',
      detail: 'When the payment system asks for up to 30 seconds before the next try, AI #1 waits 8. The rules say to honour the request, so this is a mistake — and under load it makes things worse.',
      fix: 'Wait as long as the system asks, up to 30 seconds.'
    },
    'F-02': {
      title: 'A failed payment could be charged twice',
      detail: 'If a request has no tracking code, AI #1 invents a new one on every retry. A retried payment can then be taken twice. The rules say refuse the request instead.',
      fix: 'Refuse, rather than invent a tracking code.'
    },
    'F-03': {
      title: 'They treat a timeout differently',
      detail: 'The rules never say what to do when the system times out. AI #1 gives up; AI #2 tries again. Neither is wrong today — the rule needs to say which.',
      fix: 'Decide it in the rules. Until then it is recorded, not scored.'
    }
  };

  var PLAIN_CONDITIONS = {
    'F-01': 'Make the retry wait as long as the payment system asks, up to 30 seconds — or change the rule.',
    'F-02': 'Refuse a payment request that arrives without a tracking code, instead of inventing one.',
    'F-03': 'Decide in the rules whether a timeout is retried. Record the answer.'
  };

  var PLAIN_REFUSALS = {
    'R-01': 'No real payment system was contacted. Both attempts used a stand-in.',
    'R-02': 'No load or timing test was run.',
    'R-03': 'This review does not run the payment service, so it cannot promise it works there.'
  };

  function plainFinding(f) {
    var p = PLAIN_FINDINGS[f.id] || { title: f.title, detail: f.detail };
    var blocking = f.severity === 'blocking';
    return '<div class="finding ' + (blocking ? 'blocking' : 'accepted') + '">' +
      '<div class="top"><span class="fid">' + (blocking ? 'Mistake' : 'Gap in the rules') + '</span>' +
      '<span class="ft">' + esc(p.title) + '</span>' +
      '<span class="chip ' + (blocking ? 'stop' : 'warn') + '" style="margin-left:auto">' + (blocking ? 'must fix' : 'recorded') + '</span></div>' +
      '<span class="fd">' + esc(p.detail) + '</span>' +
      '<span class="fid">Shown by AI #2’s test: “' + esc(f.claim) + '”</span>' +
      '</div>';
  }

  function plainHead(step, title, sub, chipLabel, chipClass, n) {
    return '<div class="panel-head"><div class="ttl"><h3><span class="pstep">' + step + '</span>' + esc(title) + '</h3>' +
      '<p>' + esc(sub) + '</p></div>' +
      '<span class="chip ' + chipClass + '"><i></i>' + esc(chipLabel) + '</span></div>' +
      '<div class="hash" style="margin-top:-6px">fingerprint ' + short(n.digest) + ' ' +
      copyBtn(n.digest, 'Copy fingerprint') + ' <span class="dim">· record ' + esc(n.id) + '</span></div>';
  }

  function kvPlain(rows) {
    return '<dl class="kv plain">' + rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + (r[2] === 'raw' ? r[1] : esc(r[1])) + '</dd>';
    }).join('') + '</dl>';
  }

  function plainOrigin(n) {
    var b = n.body;
    return plainHead('1', 'The instruction', 'What a person asked for, saved word for word.', 'saved by a person', 'blue', n) +
      kvPlain([
        ['What was asked', 'Make a payment retry try three times, waiting longer each time — and never charge twice.'],
        ['The rules', b.spec_ref + ' — seven plain rules', 'raw'],
        ['Who asked', 'A person on the team'],
        ['When', plainDate(b.created)],
        ['Given to', 'Both AIs, and nothing else']
      ]) +
      '<p class="note">This is the anchor. Because both attempts start here, any difference between them points at the rules — not at what someone happened to remember.</p>' +
      '<details class="linkdetails">' +
      '<summary>Show the exact wording both AIs received</summary>' +
      '<pre class="fcode">' + esc(state.bundle.prompt) + '</pre></details>';
  }

  function plainBuild(n, b) {
    var body = n.body;
    var issue = state.issues[n.id];
    var isA = b === 'A';
    return plainHead(isA ? '2' : '3', isA ? 'First attempt' : 'Second attempt',
      isA ? 'The change as AI #1 wrote it, with its own tests.'
          : 'The same change, built again by a different AI that never saw the first attempt.',
      issue ? 'edited after sealing' : 'sealed', issue ? 'stop' : 'ok', n) +
      kvPlain([
        ['Who wrote it', isA ? 'AI #1 — the builder' : 'AI #2 — the reviewer'],
        ['What it produced', body.files.length + ' files, ' + fmtBytes(body.bytes)],
        ['Its own tests', isA ? '4 of 4 pass' : '8 of 8 pass'],
        ['Saw the other attempt?', 'No — separate start, separate notes'],
        ['Sealed', plainDate(body.created) + ' · ' + short(n.digest)]
      ]) +
      '<p class="note">' + (isA
        ? 'On its own this looks finished: the work is written, the tests pass, the notes are tidy. That is exactly why a second attempt is needed.'
        : 'A different AI, a fresh start. Where it behaves differently from AI #1, either the rules were ambiguous or one of the two is wrong.') + '</p>' +
      '<div class="filelist" style="margin-top:2px">' + body.files.map(function (f) {
        var text = (state.bundle.builds[b].files || {})[f.path] || '';
        var ok = text && Core.sha256Hex(text) === f.sha256;
        return '<details class="fdet"><summary><div class="fr">' +
          '<span class="ic" style="color:' + (ok ? 'var(--ok)' : 'var(--stop)') + '">' +
          (ok ? '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6 11.5 13 4.5" stroke="currentColor" stroke-width="1.6"/></svg>'
              : '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>') +
          '</span><span class="p">' + esc(f.path) + '</span><span class="b">' + fmtBytes(f.bytes) + '</span>' +
          '<span class="hash">' + short(f.sha256) + '</span></div></summary>' +
          '<pre class="fcode">' + esc(text) + '</pre></details>';
      }).join('') + '</div>';
  }

  function plainDivergence(n) {
    var b = n.body;
    var issues = state.issues[n.id];
    return plainHead('4', 'The differences', 'Where the two attempts behave differently — and which rule it touches.',
      issues ? 'chain broken' : '3 differences', issues ? 'stop' : 'warn', n) +
      kvPlain([
        ['Tests compared', 'AI #2’s eight tests, run against AI #1’s work'],
        ['They agreed', '5 of 8'],
        ['They disagreed', '3 of 8'],
        ['What that means', '2 real mistakes, 1 gap in the rules']
      ]) +
      '<div style="display:flex;flex-direction:column;gap:7px">' + b.findings.map(plainFinding).join('') + '</div>';
  }

  function plainAttest(n) {
    var b = n.body;
    return plainHead('5', 'The review', 'What AI #2 says must change before this is allowed to ship.',
      'changes required', 'stop', n) +
      kvPlain([
        ['Decided by', 'AI #2 — the reviewer, working from the differences'],
        ['Verdict', 'Not yet. Two mistakes must be fixed first.'],
        ['Conditions', String(b.conditions.length)],
        ['Openly not checked', String(b.refusals.length) + ' things']
      ]) +
      '<div class="lbl" style="margin:2px 0 8px">Before this can ship</div>' +
      '<ol class="plainlist">' + b.conditions.map(function (c) {
        var key = ['F-01', 'F-02', 'F-03'].filter(function (k) { return c.indexOf(k) !== -1; })[0];
        var txt = key ? PLAIN_CONDITIONS[key] : 'Run AI #2’s tests against AI #1’s work again, and attach the result.';
        return '<li>' + esc(txt) + '</li>';
      }).join('') + '</ol>' +
      '<div class="lbl stop" style="margin:16px 0 8px">What the reviewer will not vouch for</div>' +
      '<ul class="plainlist warnlist">' + b.refusals.map(function (r) {
        return '<li>' + esc(PLAIN_REFUSALS[r.id] || r.text) + '</li>';
      }).join('') + '</ul>';
  }

  function plainReceipt(n) {
    var b = n.body;
    return plainHead('6', 'The signature', 'A named person, saying: I read all of this.', 'signed', 'ok', n) +
      kvPlain([
        ['Signed by', b.actor + ' — ' + b.role],
        ['Decision', 'Accept with conditions — merge is blocked until the two mistakes are fixed'],
        ['Time taken', plainDuration(b.time_to_sign_s) + ' — not a rubber stamp'],
        ['Confirmed', 'All ' + b.acknowledged.length + ' items were ticked as read'],
        ['Signed at', plainDate(b.created)]
      ]) +
      '<p class="note">“' + esc(b.note) + '”</p>' +
      '<p style="font-size:12.5px;color:var(--muted);margin-top:2px">Under ten seconds would be flagged as a signature nobody read. This one took ' + plainDuration(b.time_to_sign_s) + '.</p>';
  }

  /* ---------------------------------------------------------------- technical panels */

  function head(title, sub, chip, n) {
    return '<div class="panel-head"><div class="ttl"><h3>' + esc(title) + '</h3><p>' + esc(sub) + '</p></div>' + chip + '</div>' +
      '<div class="hash" style="margin-top:-6px"><b>' + esc(n.id) + '</b> · sha256 ' + short(n.digest) + ' ' +
      copyBtn(n.digest, 'Copy digest') + '</div>';
  }

  function kv(rows) {
    return '<dl class="kv">' + rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>';
    }).join('') + '</dl>';
  }

  function originPanel(n) {
    var b = n.body;
    return head('Origin record', 'The instruction, the spec and the seed both builds were given.',
      '<span class="chip blue"><i></i>human</span>', n) +
      kv([
        ['change', esc(b.change + ' — ' + b.title)],
        ['spec', '<a class="link" href="./SPEC-RETRY-04.md">' + b.spec_ref + '</a> · sha256 ' + short(b.spec_sha256)],
        ['prompt', 'sha256 ' + short(b.prompt_sha256)],
        ['transcript', 'sha256 ' + short(b.transcript_sha256)],
        ['model', esc(b.model)],
        ['seed', String(b.seed)],
        ['author', esc(b.author + ' · ' + b.context)],
        ['created', Core.relTime(b.created)]
      ]) +
      '<details class="linkdetails">' +
      '<summary>Read the recorded instruction</summary>' +
      '<pre class="fcode">' + esc(state.bundle.prompt) + '</pre></details>';
  }

  function buildPanel(n, b) {
    var body = n.body;
    var issue = state.issues[n.id];
    var chip = issue
      ? '<span class="chip stop"><i></i>' + (issue === 'sig' ? 'signature invalid' : 'record altered') + '</span>'
      : '<span class="chip ok"><i></i>sealed</span>';
    return head('Build ' + b + ' · ' + body.agent,
      body.role === 'builder' ? 'Produced by the creating agent from the origin alone.' : 'Produced by the reviewing agent in a cold context, without seeing Build A.',
      chip, n) +
      kv([
        ['role', esc(body.role)],
        ['agent', esc(body.agent) + ' <span class="dim">· ' + esc(body.actor_kind) + '</span>'],
        ['isolation', esc(body.isolation)],
        ['files', body.files.length + ' · ' + fmtBytes(body.bytes)],
        ['merkle root', short(body.root) + ' ' + copyBtn(body.root, 'Copy Merkle root')],
        ['parent', '<a href="#try" data-goto="' + body.parent.id + '" class="link">' + body.parent.id + '</a> · ' + short(body.parent.digest)],
        ['tooling', esc(body.tooling)],
        ['created', Core.relTime(body.created)]
      ]) +
      '<div class="filelist">' + body.files.map(function (f) {
        var text = (state.bundle.builds[b].files || {})[f.path] || '';
        var ok = text && Core.sha256Hex(text) === f.sha256;
        return '<details class="fdet"' + (f.path === 'src/retry.js' ? ' open' : '') + '><summary><div class="fr">' +
          '<span class="ic" style="color:' + (ok ? 'var(--ok)' : 'var(--stop)') + '">' +
          (ok ? '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6 11.5 13 4.5" stroke="currentColor" stroke-width="1.6"/></svg>'
              : '<svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>') +
          '</span><span class="p">' + esc(f.path) + '</span><span class="b">' + fmtBytes(f.bytes) + '</span>' +
          '<span class="hash">' + short(f.sha256) + '</span></div></summary>' +
          '<pre class="fcode">' + esc(text) + '</pre></details>';
      }).join('') + '</div>';
  }

  function divergencePanel(n) {
    var b = n.body;
    var issues = state.issues[n.id];
    return head('Divergence · ' + b.findings.length + ' findings',
      'The reviewer’s suite executed against both builds, and the file hashes diffed against each other.',
      issues ? '<span class="chip stop"><i></i>link broken</span>' : '<span class="chip warn"><i></i>2 blocking</span>', n) +
      kv([
        ['method', esc(b.method)],
        ['parents', b.parents.map(function (p) { return '<a href="#try" data-goto="' + p.id + '" class="link">' + p.id + '</a>'; }).join(' + ')],
        ['cases', b.summary.cases + ' · ' + b.summary.pass + ' pass / ' + b.summary.fail + ' fail'],
        ['result', b.summary.blocking + ' blocking · ' + b.summary.accepted + ' accepted divergence'],
        ['created', Core.relTime(b.created)]
      ]) +
      '<div style="display:flex;flex-direction:column;gap:7px">' + b.findings.map(function (f) {
        return '<div class="finding ' + (f.severity === 'blocking' ? 'blocking' : 'accepted') + '">' +
          '<div class="top"><span class="fid">' + esc(f.id) + '</span><span class="ft">' + esc(f.title) + '</span>' +
          '<span class="chip ' + (f.severity === 'blocking' ? 'stop' : 'warn') + '" style="margin-left:auto">' + esc(f.severity) + '</span></div>' +
          '<span class="fd">' + esc(f.detail) + '</span></div>';
      }).join('') + '</div>';
  }

  function attestPanel(n) {
    var b = n.body;
    return head('Attestation · ' + b.verdict.replace(/-/g, ' '),
      'The reviewer’s signed verdict, bound to the divergence hash. It cannot be issued by the builder.',
      '<span class="chip stop"><i></i>changes required</span>', n) +
      kv([
        ['reviewer', esc(b.agent + ' · ' + b.role)],
        ['verdict', '<b>' + esc(b.verdict) + '</b>'],
        ['claims', b.counts.claims + ' checked · ' + b.counts.supported + ' supported · ' + b.counts.disputed + ' disputed'],
        ['parent', '<a href="#try" data-goto="' + b.parent.id + '" class="link">' + b.parent.id + '</a>'],
        ['created', Core.relTime(b.created)]
      ]) +
      '<div style="display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:#43463F">' +
      b.conditions.map(function (c) { return '<div>· ' + esc(c) + '</div>'; }).join('') +
      '</div>';
  }

  function receiptPanel(n) {
    var b = n.body;
    return head('Human receipt · ' + b.actor,
      'Bound to the attestation hash. The gate is the product: nothing signs until every item is acknowledged.',
      '<span class="chip ok"><i></i>signed by a person</span>', n) +
      kv([
        ['signer', esc(b.actor + ' · ' + b.role + ' · ' + b.organisation)],
        ['decision', '<b>' + esc(b.decision) + '</b> · merge ' + esc(b.merge)],
        ['time to sign', b.time_to_sign_s + ' s · no-look threshold ' + b.no_look_threshold_s + ' s · flag ' + (b.no_look ? 'raised' : 'clear')],
        ['acknowledged', b.acknowledged.length + ' items · ' + b.acknowledged.join(' ')],
        ['parent', '<a href="#try" data-goto="' + b.parent.id + '" class="link">' + b.parent.id + '</a>'],
        ['signed', Core.relTime(b.created)]
      ]) +
      '<p style="font-size:12.5px;color:#43463F;border-left:2px solid var(--blue);padding-left:12px;line-height:1.6">“' + esc(b.note) + '”</p>';
  }

  var PANEL = {
    'ORIGIN-0042': function (n) { return state.mode === 'technical' ? originPanel(n) : plainOrigin(n); },
    'BUILD-A': function (n) { return state.mode === 'technical' ? buildPanel(n, 'A') : plainBuild(n, 'A'); },
    'BUILD-B': function (n) { return state.mode === 'technical' ? buildPanel(n, 'B') : plainBuild(n, 'B'); },
    'DIVERGENCE-01': function (n) { return state.mode === 'technical' ? divergencePanel(n) : plainDivergence(n); },
    'ATTEST-01': function (n) { return state.mode === 'technical' ? attestPanel(n) : plainAttest(n); },
    'RECEIPT-0042': function (n) { return state.mode === 'technical' ? receiptPanel(n) : plainReceipt(n); }
  };

  /* ---------------------------------------------------------------- rail + stepper */

  function renderRail() {
    var tech = state.mode === 'technical';
    $('#traceRail').innerHTML = state.chain.nodes.map(function (n) {
      var l = NODE_STEP[n.id];
      var issue = state.issues[n.id];
      var st = issue
        ? '<span class="st"><svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8"/></svg></span>'
        : '<span class="st"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6 11.5 13 4.5" stroke="currentColor" stroke-width="1.8"/></svg></span>';
      return '<button class="nrow" type="button" data-node="' + n.id + '" data-state="' + (issue ? 'broken' : 'ok') + '" aria-current="' + (state.active === n.id) + '">' +
        '<span class="wire"><span class="dot"></span></span>' +
        '<span><span class="t">' + (tech ? '0' + l[0] + ' · ' + n.id : 'Step ' + l[0]) + '</span>' +
        '<span class="i">' + esc(l[1]) + '</span>' +
        '<span class="h">' + (tech ? short(n.digest) : esc(l[2])) + '</span></span>' + st + '</button>';
    }).join('');

    var okCount = state.chain.nodes.length - Object.keys(state.issues).length;
    $('#railCount').textContent = state.checks ? okCount + '/6 clean' : '—';
  }

  function renderPanel() {
    var n = nodeOf(state.active);
    if (!n) return;
    var el = $('#tracePanel');
    el.innerHTML = PANEL[n.id](n);
    el.classList.remove('swap');
    void el.offsetWidth;
    el.classList.add('swap');
    makeFocusable();
  }

  function updateStepNav() {
    var ids = state.chain.nodes.map(function (n) { return n.id; });
    var i = ids.indexOf(state.active);
    var l = NODE_STEP[state.active];
    var label = $('#stepLabel');
    if (label) label.textContent = 'Step ' + l[0] + ' of 6 · ' + l[1];
    var prev = $('#btnPrev'), next = $('#btnNext');
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i >= ids.length - 1;
  }

  function selectNode(id, scroll) {
    state.active = id;
    renderRail();
    renderPanel();
    updateStepNav();
    renderRecordActive();
    if (scroll) {
      var panel = $('#tracePanel');
      if (panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: 'center' });
    }
  }

  function stepBy(dir) {
    var ids = state.chain.nodes.map(function (n) { return n.id; });
    var i = ids.indexOf(state.active);
    var j = Math.min(ids.length - 1, Math.max(0, i + dir));
    if (j !== i) selectNode(ids[j]);
  }

  function makeFocusable() {
    $$('.log, .codeview, .diffview, pre').forEach(function (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
  }

  /* ---------------------------------------------------------------- verify */

  var CHECK_NODE = [
    [/^origin/, 'ORIGIN-0042'],
    [/^a-/, 'BUILD-A'],
    [/^b-/, 'BUILD-B'],
    [/^isolation/, 'BUILD-B'],
    [/^div-/, 'DIVERGENCE-01'],
    [/^att-/, 'ATTEST-01'],
    [/^rec-|^ledger/, 'RECEIPT-0042'],
    [/^coverage/, 'BUILD-A']
  ];

  function groupOf(id) {
    for (var i = 0; i < CHECK_NODE.length; i++) if (CHECK_NODE[i][0].test(id)) return CHECK_NODE[i][1];
    return null;
  }

  function logLine(txt, cls) {
    var el = $('#traceLog');
    var safe = esc(txt);
    el.innerHTML += (el.innerHTML ? '\n' : '') + (cls ? '<span class="' + cls + '">' + safe + '</span>' : safe);
    el.scrollTop = el.scrollHeight;
  }

  function openLog(open) {
    var el = $('#traceLog');
    if (!el) return;
    el.classList.toggle('open', !!open);
    var b = $('#logToggle');
    if (b) {
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.textContent = open ? 'Hide check log' : 'Check log';
    }
  }

  function setStateChip(kind, label) {
    var el = $('#traceState');
    el.className = 'chip ' + (kind === 'ok' ? 'ok' : kind === 'stop' ? 'stop' : 'dark');
    el.style.height = '21px'; el.style.fontSize = '9px';
    el.innerHTML = '<i></i>' + esc(label);
  }

  async function verify(quiet) {
    var btn = $('#btnVerify');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    if (!quiet) { $('#traceLog').innerHTML = ''; openLog(true); }

    var t0 = performance.now();
    var res = await Core.verifyChain(state.chain, state.bundle);
    var ms = Math.round(performance.now() - t0);

    state.checks = res;
    state.issues = {};
    res.blocked.forEach(function (c) {
      var g = groupOf(c.id);
      if (!g) return;
      if (!state.issues[g]) state.issues[g] = c.id.indexOf('sig') !== -1 ? 'sig' : 'record';
    });

    var order = ['ORIGIN-0042', 'BUILD-A', 'BUILD-B', 'DIVERGENCE-01', 'ATTEST-01', 'RECEIPT-0042'];
    order.forEach(function (id) {
      var l = NODE_STEP[id];
      var mine = res.checks.filter(function (c) { return groupOf(c.id) === id; });
      var bad = mine.filter(function (c) { return !c.ok; });
      var label = ('Step ' + l[0] + ' · ' + l[1]).padEnd(24, ' ');
      var line = label + ' ' + mine.filter(function (c) { return c.ok; }).length + '/' + mine.length +
        (bad.length ? '  ✗ ' + bad.map(function (c) { return c.name; }).join('; ') : '  ✓');
      logLine(line, bad.length ? 'bad' : 'ok');
    });

    logLine('—', 'dim');
    logLine(res.passed + ' of ' + res.total + ' checks passed · ' + ms + ' ms · ' +
      (res.sigAvailable ? 'fingerprints and seals checked in this browser' : 'this browser cannot check seals — open over http(s)'),
      res.ok ? 'ok' : 'bad');

    setStateChip(res.ok ? 'ok' : 'stop', res.ok ? 'everything checks out' : 'something was changed');
    renderRail();
    renderPanel();

    btn.disabled = false;
    btn.textContent = res.ok ? 'Check again' : 'Check everything';
    if (!res.ok) openLog(true);
    return res;
  }

  function tamper() {
    if (state.tampered) { toast('Already changed — reset first'); return; }
    var node = nodeOf('BUILD-A');
    var path = 'src/retry.js';
    var text = state.bundle.builds.A.files[path] || '';
    var after = text.replace('Math.min(seconds * 1000, 8000)', 'Math.min(seconds * 1000, 30000)');
    if (after === text) { toast('Pattern not found'); return; }

    state.bundle.builds.A.files[path] = after;
    node.body.files = node.body.files.map(function (f) {
      return f.path === path ? { path: f.path, sha256: Core.sha256Hex(after), bytes: bytesOf(after) } : f;
    });
    node.body.root = Core.merkle(node.body.files);
    node.body.bytes = node.body.files.reduce(function (a, f) { return a + f.bytes; }, 0);
    node.digest = Core.digestOf(node.body);
    state.tampered = true;

    selectNode('BUILD-A');
    $('#btnTamper').disabled = true;
    $('#traceLog').innerHTML = '';
    openLog(true);
    logLine('You changed one character in AI #1’s file: the wait goes from 8 s to 30 s.', 'bad');
    logLine('The fingerprints were recalculated to hide the edit. The seal was not.', 'dim');
    verify(true);
  }

  function reset() {
    cloneData();
    $('#btnTamper').disabled = false;
    $('#traceLog').innerHTML = 'Restored. Pick a step on the left, or press “Check everything”.';
    openLog(false);
    setStateChip('dark', 'not checked yet');
    selectNode('ORIGIN-0042');
    verify(true);
  }

  /* ---------------------------------------------------------------- evidence */

  var PLAIN_CHECK = {
    'origin-digest': 'The instruction’s fingerprint matches its text',
    'origin-spec': 'The rules are exactly what both AIs received',
    'origin-prompt': 'The original request has not been altered',
    'a-digest': 'AI #1’s step still matches its fingerprint',
    'a-sig': 'AI #1’s step is still sealed',
    'b-digest': 'AI #2’s step still matches its fingerprint',
    'b-sig': 'AI #2’s step is still sealed',
    'a-root': 'AI #1’s files add up to the recorded fingerprint',
    'b-root': 'AI #2’s files add up to the recorded fingerprint',
    'a-files': 'AI #1’s files are exactly what was sealed',
    'b-files': 'AI #2’s files are exactly what was sealed',
    'a-bound': 'AI #1’s work is tied to the instruction',
    'b-bound': 'AI #2’s work is tied to the instruction',
    'isolation': 'The two attempts really are separate',
    'div-digest': 'The list of differences is unchanged',
    'div-links': 'The differences point at both attempts',
    'div-sig': 'The differences are still sealed',
    'div-counts': 'The number of differences matches the tests',
    'div-evidence': 'Every difference cites a test that really failed',
    'att-digest': 'The review is unchanged',
    'att-sig': 'The review is still sealed',
    'att-link': 'The review points at the differences',
    'att-sep': 'The reviewer is not the builder',
    'att-conditions': 'Every mistake is named in the conditions',
    'rec-digest': 'The signature is unchanged',
    'rec-sig': 'The signature is still sealed',
    'rec-link': 'The signature points at the review',
    'rec-human': 'A person signed, not an AI',
    'rec-ack': 'Every item was ticked as read',
    'rec-nolook': 'The time taken was long enough to be a real review',
    'coverage': 'Every file is covered by the record',
    'ledger': 'The record ends with a person’s name'
  };

  async function runChecks() {
    var btn = $('#btnRun');
    var out = $('#runOut');
    btn.disabled = true; btn.textContent = 'Checking…';
    out.className = 'out';
    out.textContent = 'Reading every file and redoing every fingerprint…';

    var t0 = performance.now();
    var res = await Core.verifyChain(NS.chain, NS);
    var ms = Math.round(performance.now() - t0);

    out.className = 'out ' + (res.ok ? 'ok' : 'bad');
    out.textContent = res.ok
      ? res.passed + ' of ' + res.total + ' checks passed in ' + ms + ' ms. Nothing has changed.'
      : res.blocked.length + ' checks failed: ' + res.blocked.slice(0, 3).map(function (c) { return PLAIN_CHECK[c.id] || c.name; }).join('; ');

    btn.disabled = false;
    btn.textContent = res.ok ? 'Run them again' : 'Run the 32 checks';
    return res;
  }

  /* ---------------------------------------------------------------- boot */

  function bindCopy() {
    document.addEventListener('click', function (e) {
      var c = e.target.closest('[data-copy]');
      if (c) { copy(c.getAttribute('data-copy')); return; }
      var go = e.target.closest('[data-goto]');
      if (go) {
        e.preventDefault();
        selectNode(go.getAttribute('data-goto'), true);
        document.getElementById('try').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  function bindProgress() {
    var bar = $('#progress');
    var onScroll = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? Math.min(100, window.scrollY / h * 100) : 0) + '%';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function boot() {
    cloneData();
    renderRecord();
    renderRail();
    renderPanel();
    updateStepNav();
    bindCopy();
    bindProgress();
    makeFocusable();

    $('#traceRail').addEventListener('click', function (e) {
      var b = e.target.closest('[data-node]');
      if (b) selectNode(b.getAttribute('data-node'));
    });

    $('#recordNodes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-record-node]');
      if (!b) return;
      selectNode(b.getAttribute('data-record-node'));
      document.getElementById('try').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#tracePanel').addEventListener('click', function (e) {
      var go = e.target.closest('[data-goto]');
      if (go) { e.preventDefault(); selectNode(go.getAttribute('data-goto')); }
    });

    $('#btnVerify').addEventListener('click', function () { verify(false); });
    $('#btnTamper').addEventListener('click', tamper);
    $('#btnReset').addEventListener('click', reset);
    $('#btnRun').addEventListener('click', runChecks);
    $('#btnPrev').addEventListener('click', function () { stepBy(-1); });
    $('#btnNext').addEventListener('click', function () { stepBy(1); });
    $('#logToggle').addEventListener('click', function () {
      openLog(!$('#traceLog').classList.contains('open'));
    });

    $$('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.getAttribute('data-mode');
        $$('[data-mode]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
        renderRail();
        renderPanel();
      });
    });

    if ('requestIdleCallback' in window) requestIdleCallback(function () { verify(true); });
    else setTimeout(function () { verify(true); }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
