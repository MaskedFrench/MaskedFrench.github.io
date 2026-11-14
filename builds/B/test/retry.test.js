'use strict';
/**
 * Reviewer-02's suite, written against the spec rather than against a build.
 * Eight cases. Five of them are also satisfied by a correct reading; three are
 * the boundaries where two independent readings can drift apart.
 *
 * Each case receives the implementation under test, so this suite can be run
 * against builds/A as a cross-check.
 */

module.exports = {
  id: 'TESTS-B',
  author: 'reviewer-02',
  cases: [
    {
      id: 'B1',
      claim: 'A 503 is retried and the next 200 is returned',
      async run(retry, h) {
        const calls = [];
        let n = 0;
        const res = await retry.retry(async (ctx) => {
          calls.push(ctx.attempt);
          n += 1;
          return { status: n === 1 ? 503 : 200, headers: {} };
        }, {}, h.deps([0.5]));
        h.eq(res.status, 200, 'final status');
        h.eq(calls.length, 2, 'attempts made');
      },
    },
    {
      id: 'B2',
      claim: 'Gives up after three attempts with RetryExhausted',
      async run(retry, h) {
        let calls = 0;
        let thrown = null;
        try {
          await retry.retry(async () => {
            calls += 1;
            return { status: 503, headers: {} };
          }, {}, h.deps([0.5, 0.5, 0.5]));
        } catch (e) {
          thrown = e;
        }
        h.ok(thrown, 'throws');
        h.eq(thrown.name, 'RetryExhausted', 'error type');
        h.eq(thrown.attempts, 3, 'attempts recorded');
        h.eq(calls, 3, 'calls made');
      },
    },
    {
      id: 'B3',
      claim: 'Full jitter never exceeds min(cap, base * 2^n)',
      async run(retry, h) {
        const sleeps = [];
        try {
          await retry.retry(async () => ({ status: 503, headers: {} }), {}, {
            rand: h.randFrom([0.5, 0.999]),
            sleep: async (ms) => { sleeps.push(ms); },
          });
        } catch (_) { /* exhausted is expected */ }
        h.eq(sleeps.length, 2, 'two waits before giving up');
        h.eq(sleeps[0], 100, 'wait 1 = 0.5 × 200 ms');
        h.eq(sleeps[1], 399, 'wait 2 = 0.999 × 400 ms, floored');
      },
    },
    {
      id: 'B4',
      claim: 'A 5 s Retry-After is honoured over the jitter',
      async run(retry, h) {
        const sleeps = [];
        let n = 0;
        await retry.retry(async () => {
          n += 1;
          return n === 1
            ? { status: 429, headers: { 'retry-after': '5' } }
            : { status: 200, headers: {} };
        }, {}, { rand: h.randFrom([0.5]), sleep: async (ms) => { sleeps.push(ms); } });
        h.eq(sleeps[0], 5000, 'waited the server hint');
      },
    },
    {
      id: 'B5',
      claim: 'Retry-After of 30 s is honoured in full (SPEC §4 ceiling)',
      async run(retry, h) {
        const sleeps = [];
        let n = 0;
        await retry.retry(async () => {
          n += 1;
          return n === 1
            ? { status: 503, headers: { 'retry-after': '30' } }
            : { status: 200, headers: {} };
        }, {}, { rand: h.randFrom([0.5]), sleep: async (ms) => { sleeps.push(ms); } });
        h.eq(sleeps[0], 30000, 'waited 30 s, not a truncated hint');
      },
    },
    {
      id: 'B6',
      claim: 'A POST without a caller-supplied key is refused, not retried',
      async run(retry, h) {
        let calls = 0;
        let thrown = null;
        try {
          await retry.retry(async () => { calls += 1; return { status: 200, headers: {} }; },
            { method: 'POST' }, h.deps([0.5]));
        } catch (e) { thrown = e; }
        h.ok(thrown, 'throws before the first attempt');
        h.eq(thrown && thrown.name, 'NonIdempotentRequest', 'error type');
        h.eq(calls, 0, 'no request was made');
      },
    },
    {
      id: 'B7',
      claim: 'The caller’s idempotency key is reused on every attempt',
      async run(retry, h) {
        const keys = [];
        let n = 0;
        await retry.retry(async (ctx) => {
          keys.push(ctx.idempotencyKey);
          n += 1;
          return { status: n === 1 ? 503 : 200, headers: {} };
        }, { method: 'POST', idempotencyKey: 'order-88213' }, h.deps([0.5]));
        h.eq(keys.length, 2, 'two attempts');
        h.eq(keys[0], 'order-88213', 'key on attempt 1');
        h.eq(keys[1], 'order-88213', 'key on attempt 2');
      },
    },
    {
      id: 'B8',
      claim: '504 is retried (spec silent — recorded as a divergence)',
      async run(retry, h) {
        let n = 0;
        const res = await retry.retry(async () => {
          n += 1;
          return { status: n === 1 ? 504 : 200, headers: {} };
        }, {}, h.deps([0.5]));
        h.eq(res.status, 200, 'gateway timeout retried');
      },
    },
  ],
};
