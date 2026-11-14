# SPEC-RETRY-04 — bounded retry with full-jitter backoff

Status: approved · Owner: platform reliability · Applies to: all outbound calls to the payments gateway.

## 1. Scope

A single function performs an operation, observes the outcome, and either returns it or tries again under the
rules below. The transport is injected; the function owns only the decision to retry and the wait before it.

## 2. Attempts

At most **3 attempts** in total (one initial call and two retries). On exhaustion the function throws an error that
carries the number of attempts made and the last observed error, if any.

## 3. Retryable outcomes

Retry only on **HTTP 429** and **HTTP 503**. Every other status, including 2xx, 4xx and 5xx not listed here, is
returned to the caller immediately. Behaviour for 504 is unspecified: an implementation may retry it, but must record
the choice.

## 4. Waiting between attempts

Wait a **full-jitter** interval: `uniform(0, min(cap, base × 2^(attempt−1)))` with `base = 200 ms` and
`cap = 2 000 ms`.

If the response carries `Retry-After` (seconds), the wait is **at least** the server hint and at most **30 000 ms**.
A malformed or negative hint is ignored.

## 5. Idempotency

The key is supplied by the caller and **reused unchanged on every attempt**, including the first. The function never
generates a key of its own.

## 6. Non-idempotent requests

For methods other than GET, HEAD, PUT, DELETE and OPTIONS, a call **without** a caller-supplied key must be refused
**before the first attempt leaves the process**. The refusal is an error, not a retry.

## 7. What this spec does not cover

Timeouts, circuit breaking, request signing, and the transport itself. Those are out of scope and must not be
invented by an implementation.
