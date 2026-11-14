# Build A — builder-01 notes

**Spec:** SPEC-RETRY-04 · **Change:** RETRY-04 · **Context:** cold start, spec only.
**Tooling:** node 20 · tests run locally · no network.

## Reading of the spec

The retry loop is transport-agnostic so the transport can be stubbed in tests. Three attempts, full jitter,
`Retry-After` honoured, idempotency handled by attaching a key to every attempt.

## Claims

| # | Claim | Confidence | Basis |
|---|---|---|---|
| C1 | 429 and 503 are retried; other statuses return immediately | high | `retryOn` default, test A1 |
| C2 | At most three attempts, then `RetryExhausted` with an attempt count | high | test A2 |
| C3 | Backoff is full jitter inside `min(cap, base·2ⁿ)` | high | test A3 |
| C4 | `Retry-After` is honoured above the jittered wait | medium | test A4 covers a 5 s hint; longer hints are capped at 8 s |
| C5 | Retries cannot duplicate a write | medium | a key is attached to each attempt; not tested against a POST |

## Refusals

- **No integration run.** No live service in this environment; the transport is a stub in every test.
- **No load or timing measurement.** Jitter bounds are asserted arithmetically, not observed.

## Open questions raised for review

1. SPEC §4 says the `Retry-After` ceiling is 30 s. I capped at 8 s to protect worker slots. Flagged rather than
   silently shipped — but it is a deviation and should be decided by a person.
2. SPEC §6 does not say what to do when a POST arrives with no idempotency key. I generate one. If that is wrong,
   the retry can duplicate the write.
