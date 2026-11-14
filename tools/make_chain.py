#!/usr/bin/env python3
"""Build the provenance chain for the RETRY-04 record.

Reads both builds from disk, hashes them, derives findings from the cross-run
test results, seals each node with ECDSA P-256 and writes:

  data/provenance.json   the chain (nodes, digests, signatures, public key)
  assets/data.js         the same chain + file text, for the browser verifier
  MANIFEST.sha256        checksums of the sealed inputs

The signing key here is a demo key, on purpose, in the package. verify.py reads
the same chain and re-checks all of it without trusting this script.
"""

import base64
import hashlib
import json
import pathlib
import re

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEYS = ROOT / "keys"
KEYS.mkdir(exist_ok=True)

KID = "demo-2026-11"
ALG = "ES256"
SIGNED_AT = {
    "origin": "2026-11-14T08:12:00Z",
    "buildA": "2026-11-14T08:41:12Z",
    "buildB": "2026-11-14T08:44:30Z",
    "divergence": "2026-11-14T08:47:05Z",
    "attestation": "2026-11-14T08:49:40Z",
    "receipt": "2026-11-14T08:57:12Z",
}


# --------------------------------------------------------------------------- hashing

def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_text(t: str) -> str:
    return sha256_bytes(t.encode("utf-8"))


def merkle(files):
    """Sorted leaves, odd leaf duplicated, sha256(left||right) all the way up."""
    leaves = [bytes.fromhex(f["sha256"]) for f in sorted(files, key=lambda x: x["path"])]
    if not leaves:
        return sha256_bytes(b"")
    while len(leaves) > 1:
        if len(leaves) % 2:
            leaves.append(leaves[-1])
        leaves = [hashlib.sha256(leaves[i] + leaves[i + 1]).digest() for i in range(0, len(leaves), 2)]
    return leaves[0].hex()


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# --------------------------------------------------------------------------- keys

def load_key():
    priv_path = KEYS / "demo-signing-key.pem"
    if priv_path.exists():
        key = serialization.load_pem_private_key(priv_path.read_bytes(), password=None)
    else:
        key = ec.generate_private_key(ec.SECP256R1())
        priv_path.write_bytes(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
    pub = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    (KEYS / "demo-public-key.pem").write_bytes(
        key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
    )
    return key, base64.b64encode(pub).decode("ascii")


def sign(key, body):
    der = key.sign(canonical(body), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return {
        "alg": ALG,
        "kid": KID,
        "value": base64.b64encode(raw).decode("ascii"),
        "over": "canonical(body) · sorted keys · UTF-8",
    }


def node(body, key):
    return {
        "id": body["id"],
        "digest": sha256_bytes(canonical(body)),
        "sig": sign(key, body),
        "body": body,
    }


# --------------------------------------------------------------------------- inputs

def collect(build_id):
    base = ROOT / "builds" / build_id
    files = []
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(base).as_posix()
        raw = path.read_bytes()
        files.append({
            "path": rel,
            "sha256": sha256_bytes(raw),
            "bytes": len(raw),
            "text": raw.decode("utf-8"),
        })
    manifest = [{k: f[k] for k in ("path", "sha256", "bytes")} for f in files]
    return {
        "id": build_id,
        "root": merkle(manifest),
        "files": manifest,
        "texts": {f["path"]: f["text"] for f in files},
        "lines": sum(f["text"].count("\n") + 1 for f in files),
    }


spec_text = (ROOT / "SPEC-RETRY-04.md").read_text()
transcript_text = (ROOT / "data" / "transcript.md").read_text()
prompt = re.search(r"\[human\]\n(.*?)\n\n\[agent\]", transcript_text, re.S).group(1).strip()
prompt_text = "[human]\n" + prompt

tests = json.loads((ROOT / "data" / "test-results.json").read_text())
A = collect("A")
B = collect("B")


def run(sid):
    return next(r for r in tests["runs"] if r["id"] == sid)


ba = run("B/A")
case_by_id = {c["id"]: c for c in ba["cases"]}
bb = run("B/B")
aa = run("A/A")

# --------------------------------------------------------------------------- findings

RULES = {
    "B5": {
        "id": "F-01",
        "severity": "blocking",
        "title": "Retry-After is truncated at 8 s — the spec names 30 s",
        "spec": "SPEC-RETRY-04 §4",
        "detail": ("Build A caps the server hint at 8 000 ms. A gateway asking for 30 s is retried after 8 s, three "
                   "attempts inside 20 s, which is the load pattern the hint exists to prevent. The 5 s case passes, "
                   "so A's own suite cannot see it."),
        "fix": "Honour the hint up to 30 000 ms, or change the spec — but not silently.",
    },
    "B6": {
        "id": "F-02",
        "severity": "blocking",
        "title": "A POST without an idempotency key is retried with a fresh key",
        "spec": "SPEC-RETRY-04 §6",
        "detail": ("Build A invents a key when the caller supplies none, and generates a new one per attempt. A retry "
                   "of a non-idempotent request can therefore write twice. §6 requires a refusal before the first "
                   "attempt leaves the process."),
        "fix": "Refuse with a typed error before any I/O; never mint a key inside the retry loop.",
    },
    "B8": {
        "id": "F-03",
        "severity": "accepted-divergence",
        "title": "504 is retried by B and not by A — the spec is silent",
        "spec": "SPEC-RETRY-04 §3",
        "detail": ("A reads the retryable list as closed; B reads it as a minimum. Neither contradicts a normative "
                   "sentence. Recorded as a divergence to be decided in the spec, not as a defect in a build."),
        "fix": "Name 504 in §3 either way. Until then the behaviour is recorded, not scored.",
    },
}

findings = []
for cid, rule in RULES.items():
    c = case_by_id[cid]
    findings.append({
        "id": rule["id"],
        "severity": rule["severity"],
        "title": rule["title"],
        "spec": rule["spec"],
        "claim": c["claim"],
        "detail": rule["detail"],
        "fix": rule["fix"],
        "evidence": {
            "run": "TESTS-B × BUILD-A",
            "case": cid,
            "observed": c["detail"] or "case did not pass",
            "counterpart": next(x for x in bb["cases"] if x["id"] == cid)["status"],
        },
        "status": "open" if rule["severity"] == "blocking" else "accepted",
    })

notes = [
    {
        "id": "N-01",
        "title": "Both suites pass against the build that wrote them",
        "detail": (f"TESTS-A × BUILD-A: {aa['passed']}/{aa['total']}. TESTS-B × BUILD-B: {bb['passed']}/{bb['total']}. "
                   "A suite written beside an implementation tests that implementation's reading, not the spec."),
    },
    {
        "id": "N-02",
        "title": "The reviewer's suite is compatible with the builder's build",
        "detail": (f"TESTS-A × BUILD-B: {next(r for r in tests['runs'] if r['id'] == 'A/B')['passed']}/"
                   f"{next(r for r in tests['runs'] if r['id'] == 'A/B')['total']}. The divergence is not a rewrite; "
                   "it is confined to the boundaries A never tested."),
    },
    {
        "id": "N-03",
        "title": "Divergence is the signal",
        "detail": (f"{ba['total'] - ba['passed']} of {ba['total']} reviewer cases fail against the builder's build. "
                   "A single-agent review would have returned 4/4 and a green tick."),
    },
]

# --------------------------------------------------------------------------- chain

key, pub_b64 = load_key()

origin_body = {
    "id": "ORIGIN-0042",
    "type": "origin",
    "change": "RETRY-04",
    "title": "Bounded retry with full-jitter backoff",
    "spec_ref": "SPEC-RETRY-04",
    "spec_sha256": sha256_text(spec_text),
    "prompt_sha256": sha256_text(prompt_text),
    "transcript_sha256": sha256_text(transcript_text),
    "author": "prompt-author",
    "actor_kind": "human",
    "model": "northstar-builder-demo (recorded session, no runtime call)",
    "seed": 20261114,
    "context": "cold · spec only",
    "created": SIGNED_AT["origin"],
    "parents": [],
}
origin = node(origin_body, key)

buildA_body = {
    "id": "BUILD-A",
    "type": "build",
    "role": "builder",
    "agent": "builder-01",
    "actor_kind": "agent",
    "change": "RETRY-04",
    "context": "cold · spec only",
    "isolation": "no access to any other build",
    "parent": {"id": origin["id"], "digest": origin["digest"]},
    "origin_spec_sha256": origin_body["spec_sha256"],
    "root": A["root"],
    "files": A["files"],
    "bytes": sum(f["bytes"] for f in A["files"]),
    "tooling": "node 20 · tests executed locally · no network",
    "created": SIGNED_AT["buildA"],
}
buildA = node(buildA_body, key)

buildB_body = {
    "id": "BUILD-B",
    "type": "build",
    "role": "reviewer",
    "agent": "reviewer-02",
    "actor_kind": "agent",
    "change": "RETRY-04",
    "context": "cold · spec only",
    "isolation": "no access to BUILD-A · separate context, separate workspace",
    "parent": {"id": origin["id"], "digest": origin["digest"]},
    "origin_spec_sha256": origin_body["spec_sha256"],
    "root": B["root"],
    "files": B["files"],
    "bytes": sum(f["bytes"] for f in B["files"]),
    "tooling": "node 20 · tests executed locally · no network",
    "created": SIGNED_AT["buildB"],
}
buildB = node(buildB_body, key)

div_body = {
    "id": "DIVERGENCE-01",
    "type": "divergence",
    "agent": "reviewer-02",
    "actor_kind": "agent",
    "method": "reviewer suite executed against both builds · file-level hash diff · spec clause mapping",
    "parents": [
        {"id": buildA["id"], "digest": buildA["digest"]},
        {"id": buildB["id"], "digest": buildB["digest"]},
    ],
    "summary": {
        "cases": ba["total"],
        "pass": ba["passed"],
        "fail": ba["total"] - ba["passed"],
        "blocking": sum(1 for f in findings if f["severity"] == "blocking"),
        "accepted": sum(1 for f in findings if f["severity"] == "accepted-divergence"),
    },
    "findings": findings,
    "notes": notes,
    "created": SIGNED_AT["divergence"],
}
div = node(div_body, key)

att_body = {
    "id": "ATTEST-01",
    "type": "attestation",
    "agent": "reviewer-02",
    "actor_kind": "agent",
    "role": "reviewer of record",
    "parent": {"id": div["id"], "digest": div["digest"]},
    "verdict": "changes-required",
    "conditions": [
        "F-01: honour Retry-After up to 30 000 ms, or amend the spec through change control.",
        "F-02: refuse a non-idempotent request without a caller key, before any I/O.",
        "F-03: decide 504 in §3; until then the divergence is recorded and unscored.",
        "Re-run TESTS-B against BUILD-A and attach the result to this record.",
    ],
    "refusals": [
        {"id": "R-01", "text": "No integration run: the transport is a stub in every case; no live gateway was called."},
        {"id": "R-02", "text": "No load or timing measurement: jitter bounds are asserted arithmetically."},
        {"id": "R-03", "text": "This build does not execute the payments service and does not claim to."},
    ],
    "counts": {"claims": ba["total"], "supported": ba["passed"], "disputed": ba["total"] - ba["passed"]},
    "created": SIGNED_AT["attestation"],
}
att = node(att_body, key)

rec_body = {
    "id": "RECEIPT-0042",
    "type": "receipt",
    "actor": "A. Kaissi",
    "actor_kind": "human",
    "role": "reviewer of record",
    "organisation": "Latvian Ghostbusters",
    "parent": {"id": att["id"], "digest": att["digest"]},
    "decision": "accept-with-conditions",
    "merge": "blocked",
    "acknowledged": ["F-01", "F-02", "F-03", "R-01", "R-02", "R-03"],
    "conditions": att_body["conditions"],
    "note": "The divergence is the useful part. Fix both blocking findings, re-run the reviewer suite, then merge.",
    "time_to_sign_s": 214,
    "no_look_threshold_s": 10,
    "no_look": False,
    "created": SIGNED_AT["receipt"],
}
rec = node(rec_body, key)

# --------------------------------------------------------------------------- output

nodes = [origin, buildA, buildB, div, att, rec]
chain = {
    "schema": "northstar.provenance/v1",
    "generated": "2026-11-14T09:02:00Z",
    "change": {
        "id": "RETRY-04",
        "title": "Bounded retry with full-jitter backoff",
        "spec": "SPEC-RETRY-04",
        "repo": "te-industry-tech-office/junction26-messagepack-csharp",
        "base": "32258fdb",
    },
    "key": {"kid": KID, "alg": ALG, "public_spki_b64": pub_b64, "curve": "P-256"},
    "nodes": nodes,
    "demo_note": ("The signing key ships with the package because this is a demonstration. In production the builder, "
                  "reviewer and human keys are separate and live in an HSM; the record is identical."),
}
(ROOT / "data" / "provenance.json").write_text(json.dumps(chain, indent=2, ensure_ascii=False) + "\n")

bundle = {
    "chain": chain,
    "tests": tests,
    "spec": spec_text,
    "transcript": transcript_text,
    "prompt": prompt_text,
    "builds": {
        "A": {"files": A["texts"], "root": A["root"], "lines": A["lines"]},
        "B": {"files": B["texts"], "root": B["root"], "lines": B["lines"]},
    },
}
(ROOT / "assets" / "data.js").write_text(
    "/* generated by tools/make_chain.py — do not edit by hand */\n"
    "window.NS = " + json.dumps(bundle, ensure_ascii=False) + ";\n"
)

# manifest of sealed inputs
lines = []
for p in ["SPEC-RETRY-04.md", "data/transcript.md", "data/test-results.json", "data/provenance.json",
          "assets/data.js", "keys/demo-public-key.pem"]:
    f = ROOT / p
    if f.exists():
        lines.append(f"{sha256_bytes(f.read_bytes())}  {p}")
(ROOT / "MANIFEST.sha256").write_text("\n".join(lines) + "\n")

print(f"origin      {origin['digest'][:16]}…")
print(f"build A     {buildA['digest'][:16]}…  root {A['root'][:16]}…  {len(A['files'])} files")
print(f"build B     {buildB['digest'][:16]}…  root {B['root'][:16]}…  {len(B['files'])} files")
print(f"divergence  {div['digest'][:16]}…  {div_body['summary']}")
print(f"attestation {att['digest'][:16]}…")
print(f"receipt     {rec['digest'][:16]}…")
print(f"findings    {', '.join(f['id'] + ' ' + f['severity'] for f in findings)}")
