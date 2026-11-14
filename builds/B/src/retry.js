'use strict';
/**
 * RETRY-04 — bounded retry with full-jitter backoff and an idempotency guard.
 * Reconstructed by reviewer-02 from SPEC-RETRY-04, in a cold context, without
 * reading builds/A.
 *
 * Transport-agnostic: the caller supplies `fn`, an async function that performs
 * one attempt and resolves to `{ status, headers }`.
 */

const DEFAULTS = Object.freeze({
  maxAttempts: 3,
  baseMs: 200,
  capMs: 2000,
  maxRetryAfterMs: 30000,
  retryOn: [429, 503, 504],
});

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

class RetryExhausted extends Error {
  constructor(attempts, cause) {
    super(`retry exhausted after ${attempts} attempts`);
    this.name = 'RetryExhausted';
    this.attempts = attempts;
    this.cause = cause || null;
  }
}

class NonIdempotentRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonIdempotentRequest';
  }
}

/** Full jitter: uniform in [0, min(cap, base * 2^(attempt-1))). */
function fullJitter(attempt, policy, rand) {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.floor(rand() * ceiling);
}

/** The server's hint is a floor, capped so a bad header cannot stall a worker. */
function withRetryAfter(value, policy, fallback) {
  if (value == null) return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return fallback;
  return Math.max(fallback, Math.min(seconds * 1000, policy.maxRetryAfterMs));
}

/**
 * @param {(ctx:{attempt:number,idempotencyKey:string|null,method:string}) => Promise<{status:number,headers?:object}>} fn
 * @param {{maxAttempts?:number,baseMs?:number,capMs?:number,maxRetryAfterMs?:number,method?:string,idempotencyKey?:string,retryOn?:number[]}} [options]
 * @param {{rand?:()=>number,sleep?:(ms:number)=>Promise<void>}} [deps]
 */
async function retry(fn, options = {}, deps = {}) {
  const policy = { ...DEFAULTS, ...options };
  const rand = deps.rand || Math.random;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const method = String(policy.method || 'GET').toUpperCase();
  const key = policy.idempotencyKey || null;

  if (key === null && !IDEMPOTENT.has(method)) {
    throw new NonIdempotentRequest(
      `${method} needs a caller-supplied idempotencyKey: the transport cannot invent one`
    );
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < policy.maxAttempts) {
    attempts += 1;

    try {
      const response = await fn({ attempt: attempts, idempotencyKey: key, method });
      if (!policy.retryOn.includes(response.status)) return response;

      if (attempts === policy.maxAttempts) break;
      await sleep(
        withRetryAfter(
          response.headers && response.headers['retry-after'],
          policy,
          fullJitter(attempts, policy, rand)
        )
      );
    } catch (error) {
      if (error instanceof NonIdempotentRequest) throw error;
      lastError = error;
      if (attempts === policy.maxAttempts) break;
      await sleep(fullJitter(attempts, policy, rand));
    }
  }

  throw new RetryExhausted(attempts, lastError);
}

module.exports = { retry, RetryExhausted, NonIdempotentRequest, fullJitter, DEFAULTS, IDEMPOTENT };
