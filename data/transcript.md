SESSION TRANSCRIPT — ORIGIN-0042
Change: RETRY-04 · Spec: SPEC-RETRY-04 · Recorded 2026-11-14T08:12:00Z
Model: northstar-builder-demo · The text below is the complete context the creating agent received.

---

[human]
Implement SPEC-RETRY-04 in JavaScript, no dependencies, tests included. The transport is injected. Anything the spec
does not cover, do not invent — write it in your notes as an open question.

[agent]
Reading the spec: three attempts, 429 and 503, full jitter, Retry-After honoured, caller-supplied idempotency key.
Two sentences are not normative and I will treat them as open questions: the 30 s ceiling in §4 and the missing-key
case for POST in §6. I will implement a defensible reading of both and flag them.

[human]
Flag them. Do not decide them silently.

[agent]
Understood. Delivering src/retry.js, src/policy.json, test/retry.test.js, NOTES.md.

---

END OF RECORDED CONTEXT
