'use strict';
/**
 * Cross-run harness.
 *
 * Runs each suite against each build — four combinations — and writes
 * data/test-results.json. Nothing here decides what is a defect; it records
 * what ran and what happened. The divergence stage and a human do the rest.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILDS = ['A', 'B'];

function loadBuild(id) {
  return require(path.join(ROOT, 'builds', id, 'src', 'retry.js'));
}
function loadSuite(id) {
  return require(path.join(ROOT, 'builds', id, 'test', 'retry.test.js'));
}

function randFrom(seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

function helpers() {
  const failures = [];
  return {
    failures,
    randFrom,
    deps(seq) {
      return { rand: randFrom(seq), sleep: async () => {} };
    },
    ok(v, what) {
      if (!v) failures.push(`${what}: expected truthy, got ${String(v)}`);
    },
    eq(actual, expected, what) {
      if (actual !== expected) failures.push(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
  };
}

async function runCase(fn, impl) {
  const h = helpers();
  const started = process.hrtime.bigint();
  let status = 'pass';
  let detail = '';
  try {
    await fn(impl, h);
    if (h.failures.length) {
      status = 'fail';
      detail = h.failures.join(' · ');
    }
  } catch (error) {
    status = 'fail';
    detail = `${error.name}: ${error.message}`;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { status, detail, ms: Math.round(ms * 100) / 100 };
}

async function main() {
  const impls = Object.fromEntries(BUILDS.map((b) => [b, loadBuild(b)]));
  const suites = Object.fromEntries(BUILDS.map((b) => [b, loadSuite(b)]));

  const runs = [];
  for (const suiteId of BUILDS) {
    for (const buildId of BUILDS) {
      const suite = suites[suiteId];
      const cases = [];
      for (const c of suite.cases) {
        const r = await runCase(c.run, impls[buildId]);
        cases.push({ id: c.id, claim: c.claim, status: r.status, detail: r.detail, ms: r.ms });
      }
      runs.push({
        id: `${suiteId}/${buildId}`,
        suite: suite.id,
        suiteAuthor: suite.author,
        build: buildId,
        passed: cases.filter((c) => c.status === 'pass').length,
        total: cases.length,
        cases,
      });
    }
  }

  const out = {
    generated: new Date().toISOString(),
    runtime: `node ${process.version}`,
    harness: 'tools/run_tests.js',
    runs,
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'test-results.json'), JSON.stringify(out, null, 2) + '\n');

  // Console table
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n  suite/build   passed   failing cases');
  console.log('  ' + '-'.repeat(58));
  for (const r of runs) {
    const failing = r.cases.filter((c) => c.status === 'fail').map((c) => c.id).join(', ');
    console.log(`  ${pad(r.id, 13)} ${String(r.passed + '/' + r.total).padEnd(8)} ${failing || '—'}`);
  }
  console.log('');
  for (const r of runs) {
    for (const c of r.cases) {
      if (c.status === 'fail') console.log(`  ${r.id}  ${c.id}  ${c.detail}`);
    }
  }
  console.log('\n  written → data/test-results.json\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
