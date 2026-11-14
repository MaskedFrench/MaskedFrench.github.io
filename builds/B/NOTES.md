# Build B — reviewer-02 notes

**Spec:** SPEC-RETRY-04 · **Change:** RETRY-04 · **Context:** cold start, spec only, **no access to Build A**.
**Purpose:** an independent second build. Where A and B disagree, the spec was ambiguous or one reading is wrong.

## Reading of the spec

Same shape as any correct implementation would take, but every normative sentence in the spec gets a case:

- §3 retryable statuses: 429 and 503 named; 504 is not named and not forbidden → retried, **recorded as a divergence,
  not a defect**.
- §4 `Retry-After`: the server hint is a floor over the jittered wait; the ceiling is the 30 s named in the spec.
- §6 idempotency: the transport may not invent a key for a non-idempotent method. A POST without a key is refused
  before the first attempt leaves the process.

## Claims

| # | Claim | Confidence | Basis |
|---|---|---|---|
| C1 | 429, 503 and 504 are retried; other statuses return immediately | high | B1, B8 |
| C2 | At most three attempts, then `RetryExhausted` with an attempt count | high | B2 |
| C3 | Backoff is full jitter inside `min(cap, base·2ⁿ)` | high | B3 |
| C4 | `Retry-After` is honoured in full up to 30 s | high | B4, B5 |
| C5 | A non-idempotent request without a key is refused before any I/O | high | B6 |
| C6 | A supplied key is reused on every attempt | high | B7 |

## Refusals

- **No integration run.** Same limit as A: the transport is a stub, no live service was called.
- **No statement about A's correctness beyond the shared cases.** This build is evidence, not a verdict; the verdict
  is computed by the divergence stage and signed by a person.

## Divergence expected

A retries two status codes, B three. A's `Retry-After` ceiling is unknown to me by design. Any disagreement is
the finding — not a reason for either agent to win.
