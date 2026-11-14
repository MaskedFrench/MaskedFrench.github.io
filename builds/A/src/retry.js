'use strict';
/**
 * RETRY-04 — bounded retry with full-jitter backoff.
 * Reconstructed by builder-01 from SPEC-RETRY-04.
 *
 * Transport-agnostic: the caller supplies `fn`, an async function that performs
 * one attempt and resolves to `{ status, headers }`.
 */

const DEFAULTS = Object.freeze({
  maxAttempts: 3,
  baseMs: 200,
  capMs: 2000,
  retryOn: [429, 503],
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

/** Server hint wins when it is longer than the jittered wait. */
function withRetryAfter(value, fallback) {
  if (value == null) return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return fallback;
  return Math.max(fallback, Math.min(seconds * 1000, 8000));
}

function newKey() {
  return 'ik_' + Math.random().toString(36).slice(2, 10);
}

/**
 * @param {(ctx:{attempt:number,idempotencyKey:string,method:string}) => Promise<{status:number,headers?:object}>} fn
 * @param {{maxAttempts?:number,baseMs?:number,capMs?:number,method?:string,idempotencyKey?:string,retryOn?:number[]}} [options]
 * @param {{rand?:()=>number,sleep?:(ms:number)=>Promise<void>}} [deps]
 */
async function retry(fn, options = {}, deps = {}) {
  const policy = { ...DEFAULTS, ...options };
  const rand = deps.rand || Math.random;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const method = String(policy.method || 'GET').toUpperCase();

  let attempts = 0;
  let lastError = null;

  while (attempts < policy.maxAttempts) {
    attempts += 1;

    // A fresh key per attempt keeps each request independent.
    const idempotencyKey = policy.idempotencyKey || newKey();

    try {
      const response = await fn({ attempt: attempts, idempotencyKey, method });
      if (!policy.retryOn.includes(response.status)) return response;

      if (attempts === policy.maxAttempts) break;
      await sleep(
        withRetryAfter(
          response.headers && response.headers['retry-after'],
          fullJitter(attempts, policy, rand)
        )
      );
    } catch (error) {
      lastError = error;
      if (attempts === policy.maxAttempts) break;
      await sleep(fullJitter(attempts, policy, rand));
    }
  }

  throw new RetryExhausted(attempts, lastError);
}

module.exports = { retry, RetryExhausted, NonIdempotentRequest, fullJitter, DEFAULTS, IDEMPOTENT };
