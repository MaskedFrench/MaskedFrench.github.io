'use strict';
/**
 * Builder-01's own suite. Four cases, written from the same reading of the spec
 * that produced src/retry.js — which is the point: it tests what was built.
 *
 * Each case receives the implementation under test plus helpers, so the same
 * suite can be run against a different build.
 */

module.exports = {
  id: 'TESTS-A',
  author: 'builder-01',
  cases: [
    {
      id: 'A1',
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
      id: 'A2',
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
      id: 'A3',
      claim: 'Full jitter never exceeds min(cap, base * 2^n)',
      async run(retry, h) {
        const sleeps = [];
        let n = 0;
        const deps = {
          rand: h.randFrom([0.5, 0.999]),
          sleep: async (ms) => { sleeps.push(ms); },
        };
        try {
          await retry.retry(async () => {
            n += 1;
            return { status: 503, headers: {} };
          }, {}, deps);
        } catch (_) { /* exhausted is expected */ }
        h.eq(sleeps.length, 2, 'two waits before giving up');
        h.eq(sleeps[0], 100, 'wait 1 = 0.5 × 200 ms');
        h.eq(sleeps[1], 399, 'wait 2 = 0.999 × 400 ms, floored');
      },
    },
    {
      id: 'A4',
      claim: 'A Retry-After hint longer than the jitter is honoured',
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
  ],
};
