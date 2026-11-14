# Northstar Trust — two AIs check each other, a person signs

**One AI writes a change. A second AI builds it again without looking. The differences become a short list a person
reads and signs. Every step is fingerprinted, so you can prove later that nothing changed.**

Reference implementation for *Earned trust in AI code* · Junction 2026 · Tieto. It runs from a folder: no server, no
internet, no model call while you read.

> **In a hurry?** [`summary.html`](summary.html) is the whole idea on one screen, and prints on one A4 page.
>
> **Open [`index.html`](index.html) first.** It explains the idea in plain language, lets you check the record
> yourself, and only then shows the machinery. [`console.html`](console.html) is the full record for people who want
> the raw detail.

---

## 1. In plain English

Most AI mistakes do not look like mistakes. They look like finished work. A single AI reviewing its own output is
one opinion, twice — it reads with the same blind spots that produced the error.

So we do not ask one AI whether it was right. We ask a second AI to do the job again, from the same written rules,
without being allowed to see the first attempt. If the rules can be read two ways, the two attempts will not match.
Those mismatches are the useful part: they are a short, specific list of places where a person's judgement is
actually needed.

Then a named person reads the list, ticks every item, and signs. The button stays locked until they do. How long
they took is recorded, because a signature in under ten seconds is not a review.

The whole thing is written down as six steps that point at each other. Each step is fingerprinted when it is sealed.
Change one character later and the fingerprint no longer matches — the record says exactly where it broke.

### The six steps

| | Step | Who | What it is |
|---|---|---|---|
| 1 | The instruction | a person | the job and the rules, saved word for word |
| 2 | First attempt | AI #1 | the work, plus its own tests and notes |
| 3 | Second attempt | AI #2 | the same work, built blind |
| 4 | The differences | AI #2 | where the two attempts disagree, and which rule it touches |
| 5 | The review | AI #2 | what must change first, and what it could not check |
| 6 | The signature | a person | a name, a decision, and the time it took |

### What the example actually shows

The change is small and real: a retry that waits longer each time, for a payment system. The numbers are the
argument.

| | |
|---|---|
| AI #1's own tests against AI #1's work | **4 of 4 pass** |
| AI #2's tests against AI #1's work | **5 of 8 pass** |
| AI #2's tests against AI #2's work | **8 of 8 pass** |
| Disagreements | 2 mistakes that must be fixed · 1 gap in the rules |
| People who signed | 1 |

One AI alone would have reported 4 out of 4 and called it finished.

### Six words, if you want them

**Fingerprint** — a short code made from a file's contents; change a character and it changes completely.
**Seal** — a mathematical signature tying a step to whoever produced it.
**Attempt** — one AI's complete version of the change.
**Disagreement** — a place where the two attempts behave differently.
**The record** — the six steps linked together, ending in a signature.
**The gate** — the signature button, locked until every finding is ticked.

---

## 2. The chain, for engineers

Six nodes. Each is canonical JSON (sorted keys, UTF-8), hashed with SHA-256, signed with ECDSA P-256. Each node names
its parent by digest, so the chain is a Merkle-ish linked record rather than a log with timestamps.

| Node | Actor | What it binds |
|---|---|---|
| `ORIGIN-0042` | human | prompt, spec, model, seed — the instruction both agents received |
| `BUILD-A` | builder-01 (agent) | 4 files, Merkle root, isolation policy |
| `BUILD-B` | reviewer-02 (agent) | 4 files, separate root, cold context |
| `DIVERGENCE-01` | reviewer-02 (agent) | cross-run results, findings, spec clause, evidence case |
| `ATTEST-01` | reviewer-02 (agent) | verdict, conditions, refusals |
| `RECEIPT-0042` | A. Kaissi (human) | decision, acknowledgements, time-to-sign, no-look flag |

Chain root at issue:

```
bcc4aaeb3575168273dcaa2a505801736ac2623bf157f2af10f433aebd9d6802
```

The full record is in [`data/provenance.json`](data/provenance.json). The browser bundle the pages read is
[`assets/data.js`](assets/data.js) — the same bodies, digests and signatures, plus the file text so hashes can be
recomputed rather than trusted.

### Why the second build is the point

Build A and Build B were written from the same seven-clause spec. They agree on five of eight reviewer cases and
disagree on three:

- **F-01 (blocking)** — A truncates `Retry-After` at 8 s; §4 names a 30 s ceiling. A's own suite tests a 5 s hint, so
  it cannot see this.
- **F-02 (blocking)** — A invents an idempotency key for a POST and regenerates it per attempt; §6 requires a refusal
  before the first attempt leaves the process.
- **F-03 (accepted divergence)** — A does not retry 504, B does. The spec is silent. Recorded, not scored.

---

## 3. What runs

| Path | What it is |
|---|---|
| `index.html` | One page, five sections: the idea, the live record, the evidence, the pipeline, the files |
| `summary.html` | The one-page version — prints on a single A4 sheet |
| `console.html` | Provenance console: the record index, builds, line diff, findings, ledger, receipt |
| `sar-management.html` | SAROPS-style planning console: cases, LKP, Monte Carlo drift, probability grid, search action plan, decision ledger |
| `builds/A/`, `builds/B/` | The two builds: source, policy, tests, agent notes |
| `SPEC-RETRY-04.md` | The spec both agents read |
| `data/provenance.json` | The sealed record |
| `data/test-results.json` | Four executed cross-runs, with per-case results |
| `tools/run_tests.js` | Runs each suite against each build |
| `tools/make_chain.py` | Rebuilds the record and re-signs it (demo key) |
| `tools/verify.py` | 47 independent checks; exit code 0 or 1 |
| `review/`, `sar/`, `sarops/`, `deck/`, `docs/` | The wider Review Receipt package this extends |

Keyboard: `1`–`6` switch console views · `J` / `K` move through chain nodes · `1`–`4` switch the product view on the
landing page.

### Reproduce

```bash
node tools/run_tests.js        # 4 × suites, writes data/test-results.json
python3 tools/make_chain.py     # re-hashes, re-signs, writes provenance.json + data.js
python3 tools/verify.py         # 47 checks against the files on disk
```

`verify.py` does not import the generator. It reads the record, the build files and the public key, then recomputes
file hashes, Merkle roots, node digests, signatures, parent links, the gate's acknowledgements and the no-look flag.

Tamper with anything and it fails closed:

```
$ sed -i 's/8000/30000/' builds/A/src/retry.js
$ python3 tools/verify.py
  FAIL  BUILD-A · every file on disk matches its recorded hash    src/retry.js hash mismatch
  46/47 checks passed · 1 failed
```

Edit the sealed record instead and the node's digest and signature both fail.

---

## 4. Validation, honestly counted

| Layer | Count | Where |
|---|---|---|
| Browser checks, per page load | 32 | `assets/chain.js` → `verifyChain` |
| Offline verifier | 47 | `tools/verify.py` |
| Cross-run suite combinations | 4 | `tools/run_tests.js` |
| Real source files sealed | 8 | two manifests, one Merkle root each |

Automated accessibility checks (axe, WCAG 2 A/AA + best practice) report **0 violations** on both pages at
1440 px. Both pages run at 390 / 768 / 1440 px with no horizontal overflow and no console errors.

---

## 5. What this does not claim

- **No model runs at request time.** Both builds are recorded artefacts. A production system would generate them
  behind the same interface; this package verifies rather than generates.
- **The signing key ships with the demo.** One key signs every node so the chain can be checked offline. Production
  separates builder, reviewer and human keys and keeps them in an HSM.
- **No live integration test.** The transport is a stub in every case; both attestations record that as a refusal.
- **Divergence is not correctness.** Two builds agreeing means one reading was shared. It is evidence, not proof.
- **One change, one record.** RETRY-04 only — not the repository, not the system.
- **No service is deployed.** No endpoint, no account, no telemetry.

---

## 6. Credits

Abderrahman Kaissi and Athena Su Dimou — Team Latvian Ghostbusters, Rīga. Supported by **Ajelix**.
Junction 2026 · Tieto · Earned trust in AI code.
