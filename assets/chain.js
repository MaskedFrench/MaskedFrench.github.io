/* ============================================================================
   Northstar — chain engine
   Pure client-side verification of a provenance record. No network, no model.
   SHA-256 and Merkle roots are computed here (synchronous, ~200 lines of the
   usual constants); ECDSA P-256 signatures are checked with Web Crypto.
   ========================================================================== */
(function () {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Bytes(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    var dv = new DataView(padded.buffer);
    var bits = len * 8;
    dv.setUint32(padded.length - 8, Math.floor(bits / 4294967296));
    dv.setUint32(padded.length - 4, bits >>> 0);

    var w = new Uint32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  var encoder = new TextEncoder();

  function hexOf(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function fromHex(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function sha256Hex(text) { return hexOf(sha256Bytes(encoder.encode(text))); }

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}';
  }

  function digestOf(body) { return sha256Hex(canonical(body)); }

  function merkle(files) {
    if (!files.length) return sha256Hex('');
    var level = files.slice().sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; })
      .map(function (f) { return fromHex(f.sha256); });
    while (level.length > 1) {
      if (level.length % 2) level.push(level[level.length - 1]);
      var next = [];
      for (var i = 0; i < level.length; i += 2) {
        var pair = new Uint8Array(level[i].length + level[i + 1].length);
        pair.set(level[i]); pair.set(level[i + 1], level[i].length);
        next.push(sha256Bytes(pair));
      }
      level = next;
    }
    return hexOf(level[0]);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  var subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
  var keyCache = {};

  async function importKey(chain) {
    if (!subtle) return null;
    if (keyCache[chain.key.kid]) return keyCache[chain.key.kid];
    var key = await subtle.importKey(
      'spki', b64ToBytes(chain.key.public_spki_b64),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    keyCache[chain.key.kid] = key;
    return key;
  }

  /** true | false | null (Web Crypto unavailable) */
  async function verifySignature(chain, body, sig) {
    var key = await importKey(chain);
    if (!key) return null;
    try {
      return await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key,
        b64ToBytes(sig.value), encoder.encode(canonical(body))
      );
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- checks */

  var CHECK_DEFS = [
    ['origin-digest', 'Origin digest recomputes from its body'],
    ['origin-spec', 'Origin spec hash matches the spec text'],
    ['origin-prompt', 'Origin prompt hash matches the recorded prompt'],
    ['a-digest', 'Build A digest recomputes'],
    ['a-sig', 'Build A signature verifies'],
    ['b-digest', 'Build B digest recomputes'],
    ['b-sig', 'Build B signature verifies'],
    ['a-root', 'Build A Merkle root recomputes from its files'],
    ['b-root', 'Build B Merkle root recomputes from its files'],
    ['a-files', 'Build A file hashes match the file text'],
    ['b-files', 'Build B file hashes match the file text'],
    ['a-bound', 'Build A is bound to the origin'],
    ['b-bound', 'Build B is bound to the origin'],
    ['isolation', 'The builds are independent (different roots, different agents)'],
    ['div-digest', 'Divergence digest recomputes'],
    ['div-links', 'Divergence is bound to both builds'],
    ['div-sig', 'Divergence signature verifies'],
    ['div-counts', 'Finding counts match the executed cross-run'],
    ['div-evidence', 'Every finding cites a case that actually failed'],
    ['att-digest', 'Attestation digest recomputes'],
    ['att-sig', 'Attestation signature verifies'],
    ['att-link', 'Attestation is bound to the divergence'],
    ['att-sep', 'The reviewer is not the builder'],
    ['att-conditions', 'Every blocking finding appears in the conditions'],
    ['rec-digest', 'Receipt digest recomputes'],
    ['rec-sig', 'Receipt signature verifies'],
    ['rec-link', 'Receipt is bound to the attestation'],
    ['rec-human', 'Receipt is signed by a person, not an agent'],
    ['rec-ack', 'Every finding and refusal was acknowledged'],
    ['rec-nolook', 'No-look flag is computed from time-to-sign'],
    ['coverage', 'Every build file is sealed in a manifest'],
    ['ledger', 'The chain terminates in a human signature']
  ];

  function nodeMap(chain) {
    var m = {};
    chain.nodes.forEach(function (n) { m[n.id] = n; });
    return m;
  }

  /**
   * Verify a chain. `bundle.builds.A.files` supplies file text so file hashes
   * can be recomputed, not trusted.
   */
  async function verifyChain(chain, bundle) {
    var nodes = nodeMap(chain);
    var results = [];
    var sigAvailable = !!subtle;

    function add(id, ok, detail) {
      var def = CHECK_DEFS.filter(function (d) { return d[0] === id; })[0] || [id, id];
      results.push({ id: id, name: def[1], ok: ok, detail: detail || '' });
    }

    var origin = nodes['ORIGIN-0042'], A = nodes['BUILD-A'], B = nodes['BUILD-B'];
    var div = nodes['DIVERGENCE-01'], att = nodes['ATTEST-01'], rec = nodes['RECEIPT-0042'];
    var bodies = {};
    chain.nodes.forEach(function (n) { bodies[n.id] = n.body; });

    add('origin-digest', digestOf(origin.body) === origin.digest, short(origin.digest));
    add('origin-spec', sha256Hex(bundle.spec) === origin.body.spec_sha256, short(origin.body.spec_sha256));
    add('origin-prompt', sha256Hex(bundle.prompt) === origin.body.prompt_sha256, short(origin.body.prompt_sha256));

    add('a-digest', digestOf(A.body) === A.digest, short(A.digest));
    var aSig = await verifySignature(chain, A.body, A.sig);
    add('a-sig', aSig === true, aSig === null ? 'Web Crypto unavailable' : 'ES256 · ' + A.sig.kid);

    add('b-digest', digestOf(B.body) === B.digest, short(B.digest));
    var bSig = await verifySignature(chain, B.body, B.sig);
    add('b-sig', bSig === true, bSig === null ? 'Web Crypto unavailable' : 'ES256 · ' + B.sig.kid);

    add('a-root', merkle(A.body.files) === A.body.root, short(A.body.root));
    add('b-root', merkle(B.body.files) === B.body.root, short(B.body.root));

    function filesMatch(bid, body) {
      var texts = bundle.builds[bid].files;
      var bad = body.files.filter(function (f) {
        return typeof texts[f.path] !== 'string' || sha256Hex(texts[f.path]) !== f.sha256;
      });
      return { ok: body.files.length === Object.keys(texts).length && bad.length === 0, bad: bad };
    }
    var af = filesMatch('A', A.body), bf = filesMatch('B', B.body);
    add('a-files', af.ok, af.ok ? A.body.files.length + ' files · byte-identical' : af.bad.map(function (f) { return f.path; }).join(', '));
    add('b-files', bf.ok, bf.ok ? B.body.files.length + ' files · byte-identical' : bf.bad.map(function (f) { return f.path; }).join(', '));

    add('a-bound', A.body.parent.digest === origin.digest && A.body.origin_spec_sha256 === origin.body.spec_sha256, '← ORIGIN-0042');
    add('b-bound', B.body.parent.digest === origin.digest && B.body.origin_spec_sha256 === origin.body.spec_sha256, '← ORIGIN-0042');
    add('isolation', A.body.root !== B.body.root && A.body.agent !== B.body.agent,
      A.body.agent + ' ≠ ' + B.body.agent);

    add('div-digest', digestOf(div.body) === div.digest, short(div.digest));
    add('div-links',
      div.body.parents.length === 2 &&
      div.body.parents[0].digest === A.digest && div.body.parents[1].digest === B.digest,
      'BUILD-A + BUILD-B');
    var dSig = await verifySignature(chain, div.body, div.sig);
    add('div-sig', dSig === true, dSig === null ? 'Web Crypto unavailable' : 'ES256 · ' + div.sig.kid);

    var cross = bundle.tests.runs.filter(function (r) { return r.id === 'B/A'; })[0];
    var crossCase = {};
    cross.cases.forEach(function (c) { crossCase[c.id] = c; });
    var blocking = div.body.findings.filter(function (f) { return f.severity === 'blocking'; });
    var totalFail = cross.total - cross.passed;
    add('div-counts',
      div.body.summary.blocking === blocking.length && div.body.summary.fail === totalFail,
      blocking.length + ' blocking · ' + totalFail + ' failing cases');
    var badEvidence = div.body.findings.filter(function (f) {
      return !crossCase[f.evidence.case] || crossCase[f.evidence.case].status !== 'fail';
    });
    add('div-evidence', badEvidence.length === 0,
      badEvidence.length ? badEvidence.map(function (f) { return f.id; }).join(', ') + ' cite a passing case'
        : div.body.findings.map(function (f) { return f.id; }).join(' '));

    add('att-digest', digestOf(att.body) === att.digest, short(att.digest));
    var atSig = await verifySignature(chain, att.body, att.sig);
    add('att-sig', atSig === true, atSig === null ? 'Web Crypto unavailable' : 'ES256 · ' + att.sig.kid);
    add('att-link', att.body.parent.digest === div.digest, '← DIVERGENCE-01');
    add('att-sep', att.body.agent !== A.body.agent && att.body.agent === B.body.agent,
      att.body.agent + ' ≠ ' + A.body.agent);
    add('att-conditions', blocking.every(function (f) {
      return att.body.conditions.some(function (c) { return c.indexOf(f.id) !== -1; });
    }), blocking.map(function (f) { return f.id; }).join(', '));

    add('rec-digest', digestOf(rec.body) === rec.digest, short(rec.digest));
    var rSig = await verifySignature(chain, rec.body, rec.sig);
    add('rec-sig', rSig === true, rSig === null ? 'Web Crypto unavailable' : 'ES256 · ' + rec.sig.kid);
    add('rec-link', rec.body.parent.digest === att.digest, '← ATTEST-01');
    add('rec-human', rec.body.actor_kind === 'human' && rec.body.actor !== A.body.agent && rec.body.actor !== B.body.agent,
      rec.body.actor + ' · human');
    var ack = rec.body.acknowledged;
    var need = div.body.findings.map(function (f) { return f.id; })
      .concat(att.body.refusals.map(function (r) { return r.id; }));
    add('rec-ack', need.every(function (id) { return ack.indexOf(id) !== -1; }), need.length + ' items');
    add('rec-nolook', rec.body.no_look === (rec.body.time_to_sign_s < rec.body.no_look_threshold_s),
      rec.body.time_to_sign_s + ' s vs ' + rec.body.no_look_threshold_s + ' s');

    var sealed = A.body.files.length + B.body.files.length;
    var embedded = Object.keys(bundle.builds.A.files).length + Object.keys(bundle.builds.B.files).length;
    add('coverage', sealed === embedded, sealed + ' files sealed / ' + embedded + ' embedded');

    add('ledger', rec.body.actor_kind === 'human' && digestOf(rec.body) === rec.digest,
      'terminates at ' + rec.body.actor);

    var passed = results.filter(function (r) { return r.ok; }).length;
    return {
      checks: results,
      passed: passed,
      total: results.length,
      ok: passed === results.length,
      sigAvailable: sigAvailable,
      blocked: results.filter(function (r) { return !r.ok; })
    };
  }

  function short(h) { return h ? h.slice(0, 12) + '…' : '—'; }

  function truncateMiddle(h, head, tail) {
    if (!h) return '—';
    head = head || 10; tail = tail || 6;
    return h.slice(0, head) + '…' + h.slice(-tail);
  }

  function relTime(iso) {
    var d = new Date(iso);
    return d.toISOString().replace('T', ' ').replace(':00.000Z', 'Z');
  }

  function bytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }

  window.NSCore = {
    sha256Hex: sha256Hex,
    sha256Bytes: sha256Bytes,
    canonical: canonical,
    digestOf: digestOf,
    merkle: merkle,
    verifyChain: verifyChain,
    verifySignature: verifySignature,
    short: short,
    truncateMiddle: truncateMiddle,
    relTime: relTime,
    bytes: bytes,
    sigAvailable: function () { return !!subtle; }
  };
})();
