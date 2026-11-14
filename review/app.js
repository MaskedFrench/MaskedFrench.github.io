/* Review Receipt — assurance console
   Offline reference implementation. Data is inlined in data.js (no fetch, no network). */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code class="mono">$1</code>');

const DATA = window.RR_DATA;
const VIEWS = ["dossier", "receipt", "merge", "ledger", "failures", "concept"];

const state = {
  view: "dossier",
  current: "2283",
  filter: "all",
  q: "",
  acks: {},              // changeId -> Set(findingId)
  receipts: [],          // signed this session
  signer: "",
  openedAt: null,        // receipt open time, for no-look detection
  signedAt: {},
};

const byId = (id) => DATA.changes.find(c => c.id === id);
const pct = (n) => Math.round(n * 100);
const vClass = (v) => "v-" + v.split(" ")[0].replace(/[^a-z]/g, "");

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const dossierHash = (c) => fnv(JSON.stringify([c.id, c.claims.map(x => [x.id, x.verdict]), c.not_checked]));

/* ---------------------------------------------------------------- rail */
function railHTML() {
  const list = DATA.changes.filter(c => {
    const okClass = state.filter === "all" || c.blast.class === state.filter;
    const q = state.q.trim().toLowerCase();
    const okQ = !q || (c.id + " " + c.issue_title + " " + c.req + " " + c.blast.label).toLowerCase().includes(q);
    return okClass && okQ;
  });
  return `
    <div class="railhead"><span class="t">Agent changes</span><span class="c">${DATA.changes.length} dossiers</span></div>
    <input class="search" id="railSearch" type="search" placeholder="Search id, requirement, title" value="${esc(state.q)}" aria-label="Search dossiers">
    <div class="filters" id="railFilters">
      ${["all", "A", "B", "C"].map(f => `<button data-f="${f}" class="${state.filter === f ? "on" : ""}">${f === "all" ? "ALL" : "CLASS " + f}</button>`).join("")}
    </div>
    ${list.map(c => {
      const dots = c.claims.map(cl => `<i class="${cl.verdict === "supported" ? "s" : cl.verdict === "partially supported" ? "p" : "u"}"></i>`).join("");
      return `<button class="chg ${c.id === state.current ? "on" : ""}" data-chg="${c.id}">
        <span class="l1"><span class="id">#${c.id}</span><span class="cls ${c.blast.class}">CLASS ${c.blast.class}</span></span>
        <span class="ttl">${esc(c.issue_title)}</span>
        <span class="meta"><span>${c.diff.files} files</span><span>+${c.diff.additions}</span><span class="dots">${dots}</span></span>
      </button>`;
    }).join("") || `<div class="note">No dossier matches that filter.</div>`}
    <div class="note">
      <b>${DATA.changes.length} agent branches</b>, one week, one repository. Dossiers were built from the real diffs;
      no build was executed in this environment.
    </div>`;
}

/* ---------------------------------------------------------------- dossier */
function verdictTag(v) {
  return `<span class="verdict ${vClass(v)}">${esc(v.replace("partially supported", "partial"))}</span>`;
}

function dossierView() {
  const c = byId(state.current);
  const claims = c.claims.map(cl => `
    <div class="claim">
      <div class="cid">${cl.id}</div>
      <div>
        <div class="txt">${rich(cl.text)}</div>
        <span class="ev"><b>evidence</b> ${esc(cl.kind)} — ${rich(cl.evidence)}</span>
      </div>
      <div class="vcell">${verdictTag(cl.verdict)}</div>
      <div class="ccell">
        ${cl.confidence == null
          ? `<span class="conf dim">—<small>no estimate</small></span>`
          : `<span class="conf">${pct(cl.confidence)}%<small>confidence</small></span>
             <div class="meter ${cl.verdict === "supported" ? "teal" : ""}"><i style="width:${pct(cl.confidence)}%"></i></div>`}
      </div>
    </div>`).join("");

  const findings = c.findings.map(f => `
    <article class="finding ${f.sev}">
      <div class="bar"></div>
      <div class="body">
        <h4>${esc(f.title)} <span class="tag ${f.sev === "high" ? "red" : f.sev === "medium" ? "amber" : ""}">${esc(f.sev)}</span></h4>
        <p>${esc(f.detail)}</p>
        <span class="ev">${esc(f.evidence)}</span>
        <div class="act"><b>Owner decides</b><span>${esc(f.action)}</span></div>
      </div>
    </article>`).join("");

  const refusals = c.refusals.map((r, i) => `
    <div class="refusal">
      <div class="g">R${i + 1}</div>
      <div><h4>${esc(r.q)}</h4><p>${esc(r.why)}</p></div>
      <div class="who"><b>Escalated to</b>${esc(r.decider)}</div>
    </div>`).join("");

  return `
  <div class="pad">
    <div class="eyebrow"><b>Dossier</b><span>·</span><span>${esc(c.branch)}</span><span>·</span><span>${esc(c.req)}</span></div>
    <h1>${esc(c.issue_title)}</h1>
    <p class="lede">${esc(c.req_statement)}</p>

    <div class="facts">
      <div><div class="k">Files</div><div class="v">${c.diff.files}</div></div>
      <div><div class="k">Added</div><div class="v">+${c.diff.additions}</div></div>
      <div><div class="k">Removed</div><div class="v">−${c.diff.deletions}</div></div>
      <div><div class="k">Source · tests</div><div class="v">${c.diff.src} · ${c.diff.tests}</div></div>
      <div><div class="k">Full read</div><div class="v">${c.estimate.full_read_min}<small> min</small></div></div>
      <div><div class="k">Dossier</div><div class="v">${c.estimate.dossier_min}<small> min</small></div></div>
    </div>

    <section class="block">
      <div class="bh"><span class="n">01</span><h2>Blast radius, not diff size</h2><span class="r">routing decision</span></div>
      <div class="blast">
        <div class="clsbox">
          <div class="big"><span>Review class</span>${c.blast.class}</div>
          <div class="tag ${c.blast.class === "A" ? "red" : c.blast.class === "B" ? "amber" : "teal"}" style="margin-top:10px">${esc(c.blast.label)}</div>
          <p class="why">${esc(c.blast.why)}</p>
        </div>
        <div class="drivers">
          <h4>What drives the class</h4>
          <ul>${c.blast.drivers.map((d, i) => `<li><b>D${i + 1}</b><span>${esc(d)}</span></li>`).join("")}</ul>
          <div class="vs">${c.diff.files} files · ${c.diff.additions} added lines · class set by reachability and touched surface</div>
        </div>
      </div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">02</span><h2>Claims and evidence</h2><span class="r">${c.claims.length} claims · one per behaviour change</span></div>
      <div class="claims">${claims}</div>
      <p class="hint">${esc(c.estimate.basis)}</p>
    </section>

    <section class="block">
      <div class="bh"><span class="n">03</span><h2>What the reviewer found</h2><span class="r">${c.findings.length} findings</span></div>
      ${findings}
    </section>

    <section class="block">
      <div class="bh"><span class="n">04</span><h2>What it refused to decide</h2><span class="r">${c.refusals.length} refusals</span></div>
      ${refusals}
    </section>

    <section class="block">
      <div class="bh"><span class="n">05</span><h2>What was not checked</h2><span class="r">printed on the receipt</span></div>
      <div class="card"><div class="card-b">
        <div class="chips">${c.not_checked.map(n => `<span>${esc(n)}</span>`).join("")}</div>
        <p class="hint">A skipped check cannot be invisible to the person signing. This list is reproduced verbatim on the receipt.</p>
      </div></div>
    </section>

    <div class="actions">
      <button class="btn red" data-go="receipt" data-id="${c.id}">Open the receipt for this change</button>
      <button class="btn ghost" data-go="merge">See what is in flight</button>
      <span class="hint" style="margin:0">A named human signs. The AI has no signature line.</span>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- receipt */
function receiptView() {
  const c = byId(state.current);
  const done = state.acks[c.id] || new Set();
  const all = c.findings.every(f => done.has(f.id));
  const signed = state.receipts.find(r => r.id === c.id);
  const hash = dossierHash(c);

  const blk = (title, items) => `
    <div class="blk"><h4>${title}</h4><ul>${items.join("")}</ul></div>`;

  const checked = c.claims.filter(cl => cl.verdict === "supported")
    .map(cl => `<li>${esc(cl.text)}<b>source: ${esc(cl.kind)}</b></li>`);
  checked.push(`<li>Merge-set position, pairwise dry-run<b>git merge-tree</b></li>`);

  const notChecked = c.not_checked.map(n => `<li>${esc(n)}<b>not possible in this environment</b></li>`);
  const reported = c.findings.map(f => `<li>${esc(f.title)}<b>${esc(f.sev)} · owner decides</b></li>`);
  const risk = c.claims.filter(cl => cl.verdict !== "supported")
    .map(cl => `<li>${esc(cl.text)}<b>${esc(cl.verdict)}</b></li>`);
  risk.push(`<li>Behaviour under the other branches in flight on these files<b>merge set</b></li>`);

  return `
  <div class="pad receiptwrap">
    <div class="eyebrow"><b>Receipt</b><span>·</span><span>${esc(c.req)}</span><span>·</span><span>${signed ? "signed" : "draft"}</span></div>
    <h1>${signed ? "Signature recorded" : "Attest the dossier, not the diff"}</h1>
    <p class="lede">${signed
      ? "The receipt below is bound to the dossier hash. It is what an auditor will read, and what the ledger will score."
      : "Confirm that you read the evidence, that you accept what was not checked, and that the residual risk is yours."}</p>

    <div class="doc ${signed ? "signed" : ""}" style="margin-top:20px">
      <div class="dhead">
        <div>
          <div class="s" style="margin-bottom:6px">ASSURANCE RECORD</div>
          <div class="t">Review receipt — ${esc(c.branch)}</div>
          <div class="s">Requirement ${esc(c.req)} · routing class ${c.blast.class} · ${esc(c.blast.label)}</div>
        </div>
        <div class="right">
          <span class="stampinline">${signed ? "Signed" : "Draft"}</span>
          <div>Repository <b>junction26-messagepack-csharp</b></div>
          <div>Base commit <b>32258fdb</b></div>
        </div>
      </div>

      <div class="blocks">
        ${blk("Checked, and by what", checked)}
        ${blk("Not checked, and why", notChecked)}
        ${blk("Reported, owner decides", reported)}
        ${blk("Residual risk accepted", risk)}
      </div>

      <div class="hashrow">
        <span>dossier hash <b>${hash}</b></span>
        <span>${c.diff.files} files · ${c.claims.length} claims · ${c.findings.length} findings · ${c.refusals.length} refusals</span>
      </div>

      <div class="sigblock">
        <div>
          <div class="sigline">${signed ? esc(signed.by) : ""}</div>
          <div class="sigmeta">${signed ? `Signed ${signed.at} · ${signed.nolook ? "no-look signature, flagged" : "acknowledged after review"}` : "Accountable engineer — name on signature"}</div>
        </div>
        <div class="noai"><b>AI</b>no signature line</div>
      </div>
    </div>

    ${signed ? `
      <div class="signedpanel">
        <div class="t">Receipt signed and written to the ledger</div>
        <div class="m">${esc(signed.by)} · ${signed.at} · hash ${signed.hash} · class ${signed.cls}<br>
        ${signed.nolook ? "Elapsed time under 10 seconds: recorded as a no-look signature and queued for spot-check." : "Elapsed time recorded; no-look threshold is 10 seconds."}</div>
        <div class="row" style="margin-top:12px">
          <button class="btn ghost sm" data-go="ledger">Open the ledger</button>
          <button class="btn ghost sm" data-go="dossier">Back to the dossier</button>
        </div>
      </div>` : `
      <div class="acks">
        <div class="ah">
          <span class="t">Acknowledge each finding before signing</span>
          <span class="c">${done.size} of ${c.findings.length}</span>
        </div>
        ${c.findings.map(f => `
          <label class="ack ${done.has(f.id) ? "done" : ""}" data-fid="${f.id}">
            <input type="checkbox" data-toggle="${f.id}" ${done.has(f.id) ? "checked" : ""}>
            <span><span class="t">${esc(f.title)}</span><span class="s">${esc(f.sev)} · ${esc(f.action)}</span></span>
          </label>`).join("")}
        <div class="signrow">
          <input type="text" id="signer" placeholder="Your name — the person accountable" value="${esc(state.signer)}" autocomplete="name">
          <button class="btn red" id="sign" ${all && state.signer.trim() ? "" : "disabled"}>Sign the receipt</button>
        </div>
        <div class="gate ${all ? "ok" : ""}" style="margin-top:10px">
          <span class="dot"></span>
          <span>${all ? "All findings acknowledged. The signature binds to hash " + hash + "." : "Unacknowledged findings block the signature."}</span>
        </div>
        <p class="hint">Bulk acknowledgement under ten seconds is logged as a no-look signature and feeds the spot-check queue. That is measured, not just discouraged.</p>
      </div>`}

    <div class="actions">
      <button class="btn ghost" data-go="dossier">Back to the dossier</button>
      <button class="btn ghost" data-go="failures">What could go wrong here</button>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- merge */
function mergeView() {
  const m = DATA.merge_set;
  const roll = { clean: 0, conflict: 0 };
  m.matrix.forEach(r => roll[r.result]++);
  return `
  <div class="pad">
    <div class="eyebrow"><b>Merge set</b><span>·</span><span>${m.matrix.length} pairwise dry-runs</span></div>
    <h1>${esc(m.title)}</h1>
    <p class="lede">${esc(m.lead)}</p>

    <div class="facts" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div><div class="k">Dry-runs</div><div class="v">${m.matrix.length}</div></div>
      <div><div class="k">Hard conflicts</div><div class="v">${roll.conflict}<small> pairs · ${m.conflict_files.length} files</small></div></div>
      <div><div class="k">Clean merges, contradictory intent</div><div class="v">1<small> #2283 × #2234</small></div></div>
    </div>

    <section class="block">
      <div class="bh"><span class="n">01</span><h2>Pairwise merge dry-run</h2><span class="r">git merge-tree, base 32258fdb</span></div>
      <div class="card"><div class="t-scroll">
        <table class="t matrix">
          <thead><tr><th style="width:150px">Pair</th><th style="width:130px">Result</th><th>What it means</th></tr></thead>
          <tbody>${m.matrix.map(r => `
            <tr>
              <td class="pair">#${r.a} × #${r.b}</td>
              <td><span class="res ${r.result}">${r.result}</span></td>
              <td>${esc(r.note)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">02</span><h2>The collision no diff viewer shows</h2></div>
      <div class="collision">
        <div class="ch"><span class="tag">Silent collision</span><h3>${esc(m.collision.text)}</h3></div>
        <div class="cb">
          <div>
            <p>${esc(m.collision.detail)}</p>
            <div class="ev">${m.collision.evidence.map(e => rich(e)).join("<br>")}</div>
          </div>
          <div class="req">
            <b>Requirement raised by the review layer</b>
            <p>${esc(m.collision.requirement)} — asked for by neither issue. Two branches changed the same method in opposite directions; git exits 0.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">03</span><h2>Files in hard conflict</h2><span class="r">#2129 × #2297</span></div>
      <div class="card"><div class="card-b">
        <div class="filelist">${m.conflict_files.map(f => `<code>${esc(f)}</code>`).join("")}</div>
        <p class="hint">Five files, both template pairs. Mechanical to resolve, and exactly the kind of change a per-pull-request review cannot see coming.</p>
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">04</span><h2>What this changes</h2></div>
      <p class="bigquote">${esc(m.lesson)}</p>
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- ledger */
function ledgerView() {
  const L = DATA.ledger;
  const signedRows = state.receipts.map(r => ({
    at: r.at, by: r.by, type: r.nolook ? "no-look" : "signature",
    what: `Signed #${r.id} (${r.req}) by ${r.by} · class ${r.cls} · hash ${r.hash}${r.nolook ? " · under 10 s" : ""}`
  }));
  const decisions = signedRows.concat(L.decisions);

  return `
  <div class="pad">
    <div class="eyebrow"><b>Ledger</b><span>·</span><span>provenance on every row</span></div>
    <h1>One primary metric. Seven guardrails. Nothing measured that we did not measure.</h1>
    <p class="lede">${esc(L.disclaimer)}</p>

    <div class="primary" style="margin-top:20px">
      <div class="l">
        <div class="k">Primary metric</div>
        <h3>${esc(L.primary.name)}</h3>
        <p>${esc(L.primary.definition)}</p>
        <p style="margin-top:8px"><b>Rule:</b> ${esc(L.primary.rule)}</p>
      </div>
      <div class="r">
        <div class="big">${esc(L.primary.target)}</div>
        <div class="s">Target against baseline · <span class="prov TARGET">TARGET</span></div>
        <div class="s" style="margin-top:6px">No baseline has been measured in this environment.</div>
      </div>
    </div>

    <section class="block">
      <div class="bh"><span class="n">01</span><h2>Metrics and guardrails</h2><span class="r">targets are not results</span></div>
      <div class="card"><div class="t-scroll">
        <table class="t">
          <thead><tr><th style="width:250px">Metric</th><th style="width:110px">Target</th><th style="width:110px">Provenance</th><th>How it is measured</th></tr></thead>
          <tbody>${L.metrics.map(m => `<tr>
            <td style="font-weight:500">${esc(m.name)}</td>
            <td class="mono">${esc(m.target)}</td>
            <td><span class="prov ${esc(m.prov)}">${esc(m.prov)}</span></td>
            <td class="muted">${esc(m.note)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">02</span><h2>Measured in this exercise</h2><span class="r">reproducible commands in the dossier</span></div>
      <div class="measured">
        ${L.measured.map(x => `<div><div class="n">${esc(x.n)}</div><div class="l">${esc(x.label)}</div><div class="s">${esc(x.src)}</div></div>`).join("")}
      </div>
      <p class="hint">The last row is the honest one: no build was verified. It appears on every receipt, not in a footnote.</p>
    </section>

    <section class="block">
      <div class="bh"><span class="n">03</span><h2>Trust by area</h2><span class="r">withdrawable after an escape</span></div>
      <div class="card"><div class="card-b">
        ${L.trust.map(t => `
          <div class="trustrow">
            <div class="area">${esc(t.area)}<small>${esc(t.note)}</small></div>
            <div>
              <div class="meter ${t.class === "A" ? "red" : t.class === "C" ? "teal" : ""}"><i style="width:${pct(t.score)}%"></i></div>
              <div class="mono" style="font-size:10px;color:var(--ink-40);margin-top:4px">trust ${Math.round(t.score * 100)} · class ${t.class}</div>
            </div>
            <div class="trend ${t.trend.startsWith("+") ? "up" : t.trend.startsWith("-") ? "down" : "held"}">${esc(t.trend)}</div>
          </div>`).join("")}
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">04</span><h2>Decision log</h2><span class="r">${decisions.length} entries${signedRows.length ? ` · ${signedRows.length} from this session` : ""}</span></div>
      <div class="card"><div class="card-b">
        ${decisions.map(d => `<div class="logrow">
          <div class="at">${esc(d.at)}</div>
          <div class="by"><span class="ty">${esc(d.type)}</span>${esc(d.by || "")}</div>
          <div>${esc(d.what)}</div>
        </div>`).join("")}
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">05</span><h2>What would make us distrust this</h2></div>
      <div class="card"><div class="card-b">
        <ul style="list-style:none;padding:0;display:grid;gap:8px;font-size:13px;color:var(--ink-60)">
          ${L.distrust.map(d => `<li style="display:flex;gap:10px"><span class="mono" style="color:var(--red)">×</span><span>${esc(d)}</span></li>`).join("")}
        </ul>
      </div></div>
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- failures */
function failuresView() {
  return `
  <div class="pad">
    <div class="eyebrow"><b>Failure modes</b><span>·</span><span>${DATA.failure_modes.length} ways this breaks</span></div>
    <h1>The failure modes we designed against, and how each is detected.</h1>
    <p class="lede">Each mode is paired with what was actually seen in this exercise and the mechanism that catches it. A mode without a detector is a wish.</p>

    <section class="block">
      <div class="bh"><span class="n">01</span><h2>Register</h2><span class="r">seen · fixed · detected</span></div>
      ${DATA.failure_modes.map((f, i) => `
        <div class="fmode">
          <h4><span class="no">${String(i + 1).padStart(2, "0")}</span>${esc(f.mode)}</h4>
          <div class="seen"><b class="mono" style="font-size:9px;letter-spacing:.1em;color:var(--ink-40)">SEEN</b> ${esc(f.seen)}</div>
          <div class="fix"><b>Correction</b><span>${esc(f.fix)}</span></div>
          <div class="fix"><b>Detector</b><span>${esc(f.detect)}</span></div>
        </div>`).join("")}
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- concept */
function conceptView() {
  const c = DATA.concept;
  return `
  <div class="pad">
    <div class="eyebrow"><b>Concept</b><span>·</span><span>${esc(c.name)}</span></div>
    <h1>${esc(c.tagline)}</h1>
    <p class="lede">${esc(c.recommendation)}</p>

    <section class="block">
      <div class="bh"><span class="n">01</span><h2>Principles</h2><span class="r">${c.principles.length} rules</span></div>
      <div class="principles">
        ${c.principles.map((p, i) => `<div class="principle">
          <div class="n">${String(i + 1).padStart(2, "0")}</div>
          <h4>${esc(p.t)}</h4><p>${esc(p.d)}</p>
        </div>`).join("")}
      </div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">02</span><h2>Trade-offs, with the cost stated</h2></div>
      <div class="card"><div class="card-b">
        ${c.tradeoffs.map(t => `<div class="kv" style="grid-template-columns:230px minmax(0,1fr)">
          <div class="k" style="padding-top:10px"><b style="font-size:13px;font-weight:600">${esc(t.t)}</b></div>
          <div class="muted">${esc(t.d)}</div>
        </div>`).join("")}
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">03</span><h2>Business</h2><span class="r">who pays, and why</span></div>
      <div class="card"><div class="card-b">
        ${["thesis", "buyer", "beachhead", "model", "price", "moat"].filter(k => c.business[k]).map(k => `
          <div class="kv" style="grid-template-columns:150px minmax(0,1fr)">
            <div class="k">${k}</div><div class="muted">${esc(c.business[k])}</div>
          </div>`).join("")}
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">04</span><h2>Limits</h2><span class="r">what this is not</span></div>
      <div class="card"><div class="card-b">
        <ul style="list-style:none;padding:0;display:grid;gap:8px;font-size:13px;color:var(--ink-60)">
          ${c.limits.map(l => `<li style="display:flex;gap:10px"><span class="mono" style="color:var(--red)">—</span><span>${esc(l)}</span></li>`).join("")}
        </ul>
      </div></div>
    </section>

    <section class="block">
      <div class="bh"><span class="n">05</span><h2>The three questions</h2></div>
      <div class="card"><div class="card-b">
        <div class="kv" style="grid-template-columns:1fr">
          <div><b>What would make you not trust your own output?</b><p class="muted" style="margin-top:4px">Confidence without a re-runnable check. A green build standing in for review. A router nobody can read. A ledger that counts only what the tool saw. A signature given in four seconds.</p></div>
          <div><b>Who owns the decision?</b><p class="muted" style="margin-top:4px">The named engineer who signs. Routing rules belong to the platform team and changing them is a Class A change. The reviewer agent owns nothing and can only refuse.</p></div>
          <div><b>How would this scale?</b><p class="muted" style="margin-top:4px">One dossier per change at CI speed. Class C gets auto-receipts; Class A stays at a few per week. The merge set is the scaling argument: four branches in one week already collide, and a per-pull-request review cannot see it.</p></div>
        </div>
      </div></div>
    </section>
  </div>`;
}

/* ---------------------------------------------------------------- shell */
function render() {
  const c = byId(state.current);
  $("#rail").innerHTML = railHTML();
  const views = {
    dossier: dossierView, receipt: receiptView, merge: mergeView,
    ledger: ledgerView, failures: failuresView, concept: conceptView,
  };
  $("#main").innerHTML = views[state.view]();
  $$("#nav button[data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === state.view));
  $("#rail").style.display = (state.view === "dossier" || state.view === "receipt") ? "" : "none";
  $(".shell").style.gridTemplateColumns = (state.view === "dossier" || state.view === "receipt") ? "" : "1fr";
  $("#footstats").textContent = `${DATA.changes.length} dossiers · ${DATA.changes.reduce((s, x) => s + x.diff.files, 0)} files · 0 builds verified`;
  wire();
  if (location.hash !== "#" + state.view) history.replaceState(null, "", "#" + state.view + (state.view === "dossier" || state.view === "receipt" ? "/" + c.id : ""));
}

function wire() {
  $$("#nav button[data-view]").forEach(b => b.onclick = () => {
    state.view = b.dataset.view;
    if (state.view === "receipt") state.openedAt = Date.now();
    render(); window.scrollTo({ top: 0 });
  });
  $$("[data-chg]").forEach(b => b.onclick = () => {
    state.current = b.dataset.chg;
    if (state.view !== "dossier" && state.view !== "receipt") state.view = "dossier";
    render();
    if (window.innerWidth < 900) $(".pad").scrollIntoView({ block: "start", behavior: "smooth" });
  });
  $$("[data-f]").forEach(b => b.onclick = () => { state.filter = b.dataset.f; render(); });
  bindRail();

  $$("[data-go]").forEach(b => b.onclick = () => {
    if (b.dataset.id) state.current = b.dataset.id;
    state.view = b.dataset.go;
    if (b.dataset.go === "receipt") state.openedAt = Date.now();
    render();
    window.scrollTo({ top: 0 });
  });

  if (state.view === "receipt") {
    if (!state.openedAt) state.openedAt = Date.now();
    const c = byId(state.current);
    if (!state.acks[c.id]) state.acks[c.id] = new Set();
    const syncGate = () => {
      const all = c.findings.every(f => state.acks[c.id].has(f.id));
      const done = state.acks[c.id].size;
      $$(".acks .ah .c").forEach(el => el.textContent = `${done} of ${c.findings.length}`);
      const btn = $("#sign");
      if (btn) btn.disabled = !(all && state.signer.trim());
      const gate = $(".gate");
      if (gate) {
        gate.classList.toggle("ok", all);
        const txt = all
          ? `All findings acknowledged. The signature binds to hash ${dossierHash(c)}.`
          : "Unacknowledged findings block the signature.";
        const span = gate.querySelector("span:last-child");
        if (span) span.textContent = txt;
      }
    };
    $$("[data-toggle]").forEach(cb => cb.onchange = () => {
      const id = cb.dataset.toggle;
      if (cb.checked) state.acks[c.id].add(id); else state.acks[c.id].delete(id);
      const label = cb.closest(".ack");
      if (label) label.classList.toggle("done", cb.checked);
      syncGate();
    });
    const input = $("#signer");
    if (input) input.oninput = (e) => { state.signer = e.target.value; syncGate(); };
    const sign = $("#sign");
    if (sign) sign.onclick = () => {
      const elapsed = (Date.now() - (state.openedAt || Date.now())) / 1000;
      state.receipts.unshift({
        id: c.id, req: c.req, by: state.signer.trim(),
        at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        hash: dossierHash(c), cls: c.blast.class, nolook: elapsed < 10,
      });
      state.view = "ledger"; render(); window.scrollTo({ top: 0 });
    };
  }
  const p = $("#printBtn");
  if (p) p.onclick = () => window.print();
}

function bindRail() {
  const search = $("#railSearch");
  if (search) search.oninput = (e) => {
    state.q = e.target.value;
    const pos = e.target.selectionStart;
    $("#rail").innerHTML = railHTML();
    const s2 = $("#railSearch");
    if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (_) {} }
    bindRail();
  };
  $$("[data-chg]").forEach(b => b.onclick = () => {
    state.current = b.dataset.chg;
    if (state.view !== "dossier" && state.view !== "receipt") state.view = "dossier";
    render();
  });
  $$("[data-f]").forEach(b => b.onclick = () => { state.filter = b.dataset.f; render(); });
}

/* keyboard: 1-6 sections, j/k change, p print */
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= VIEWS.length) {
    state.view = VIEWS[n - 1];
    if (state.view === "receipt") state.openedAt = Date.now();
    render(); window.scrollTo({ top: 0 });
  }
  if (e.key === "j" || e.key === "k") {
    const i = DATA.changes.findIndex(c => c.id === state.current);
    const next = Math.max(0, Math.min(DATA.changes.length - 1, i + (e.key === "j" ? 1 : -1)));
    state.current = DATA.changes[next].id; render();
  }
  if (e.key === "p" && !e.metaKey && !e.ctrlKey) window.print();
});

window.addEventListener("hashchange", () => {
  const h = location.hash.replace("#", "").split("/");
  if (VIEWS.includes(h[0])) state.view = h[0];
  if (h[1] && byId(h[1])) state.current = h[1];
  if (state.view === "receipt") state.openedAt = Date.now();
  render();
});

/* boot */
(function boot() {
  const h = location.hash.replace("#", "").split("/");
  if (VIEWS.includes(h[0])) state.view = h[0];
  if (h[1] && byId(h[1])) state.current = h[1];
  $("#buildstamp").textContent = "BUILD 2026-11-13";
  render();
})();
