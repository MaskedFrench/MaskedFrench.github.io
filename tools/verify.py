#!/usr/bin/env python3
"""Offline verifier for the RETRY-04 provenance chain.

Does not import the generator. Reads only the sealed record, the build files on
disk and the published public key, then re-computes everything from scratch.

    python3 tools/verify.py            human-readable report
    python3 tools/verify.py --json     machine-readable
    python3 tools/verify.py --quiet    exit code only

Exit code 0 = every check passed. 1 = at least one check failed.
"""

import argparse
import base64
import hashlib
import json
import pathlib
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

ROOT = pathlib.Path(__file__).resolve().parent.parent

results = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    return ok


def sha(b):
    return hashlib.sha256(b).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def merkle(files):
    leaves = [bytes.fromhex(f["sha256"]) for f in sorted(files, key=lambda x: x["path"])]
    if not leaves:
        return sha(b"")
    while len(leaves) > 1:
        if len(leaves) % 2:
            leaves.append(leaves[-1])
        leaves = [hashlib.sha256(leaves[i] + leaves[i + 1]).digest() for i in range(0, len(leaves), 2)]
    return leaves[0].hex()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    chain = json.loads((ROOT / "data" / "provenance.json").read_text())
    nodes = {n["id"]: n for n in chain["nodes"]}
    order = [n["id"] for n in chain["nodes"]]

    # ---- 1. key ------------------------------------------------------------
    try:
        pub = serialization.load_pem_public_key((ROOT / "keys" / "demo-public-key.pem").read_bytes())
        key_ok = base64.b64encode(pub.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )).decode() == chain["key"]["public_spki_b64"]
        check("K-01 public key on disk matches the key named in the chain", key_ok, f"kid {chain['key']['kid']}")
    except Exception as e:  # noqa: BLE001
        pub = None
        check("K-01 public key on disk matches the key named in the chain", False, str(e))

    # ---- 2. digests + signatures ------------------------------------------
    for nid in order:
        n = nodes[nid]
        body = n["body"]
        digest = sha(canonical(body))
        check(f"{nid} · digest recomputes from the body", digest == n["digest"], digest[:16] + "…")

        if pub is None:
            check(f"{nid} · signature verifies", False, "no public key")
            continue
        try:
            raw = base64.b64decode(n["sig"]["value"])
            r = int.from_bytes(raw[:32], "big")
            s = int.from_bytes(raw[32:], "big")
            pub.verify(encode_dss_signature(r, s), canonical(body), ec.ECDSA(hashes.SHA256()))
            check(f"{nid} · signature verifies over the canonical body", True, n["sig"]["kid"])
        except (InvalidSignature, ValueError) as e:
            check(f"{nid} · signature verifies over the canonical body", False, type(e).__name__)

    # ---- 3. links ----------------------------------------------------------
    for nid in order:
        body = nodes[nid]["body"]
        parents = body.get("parents")
        if parents is None and "parent" in body:
            parents = [body["parent"]]
        parents = parents or []
        if not parents:
            check(f"{nid} · parent set is empty (origin)", nid == "ORIGIN-0042")
            continue
        ok = True
        for p in parents:
            ok = ok and p["id"] in nodes and nodes[p["id"]]["digest"] == p["digest"]
        check(f"{nid} · parents resolve to their recorded digests",
              ok, " ← ".join(p["id"] for p in parents))

    # ---- 4. origin content -------------------------------------------------
    origin = nodes["ORIGIN-0042"]["body"]
    disk = {
        "spec_sha256": (ROOT / "SPEC-RETRY-04.md").read_bytes(),
        "transcript_sha256": (ROOT / "data" / "transcript.md").read_bytes(),
    }
    for field, raw in disk.items():
        check(f"ORIGIN-0042 · {field} matches the file on disk",
              sha(raw) == origin[field], origin[field][:16] + "…")

    prompt = (ROOT / "data" / "transcript.md").read_text()
    start = prompt.find("[human]")
    end = prompt.find("\n\n[agent]")
    check("ORIGIN-0042 · prompt hash covers the human turn",
          sha(prompt[start:end].encode()) == origin["prompt_sha256"], origin["prompt_sha256"][:16] + "…")

    # ---- 5. builds ---------------------------------------------------------
    for bid in ("BUILD-A", "BUILD-B"):
        body = nodes[bid]["body"]
        root = merkle(body["files"])
        check(f"{bid} · merkle root recomputes from {len(body['files'])} file hashes",
              root == body["root"], root[:16] + "…")

        bad = []
        for f in body["files"]:
            p = ROOT / "builds" / ("A" if bid == "BUILD-A" else "B") / f["path"]
            if not p.exists():
                bad.append(f["path"] + " missing")
            elif sha(p.read_bytes()) != f["sha256"]:
                bad.append(f["path"] + " hash mismatch")
        check(f"{bid} · every file on disk matches its recorded hash", not bad, "; ".join(bad) or f"{len(body['files'])} files")
        check(f"{bid} · build is bound to the origin",
              body["parent"]["digest"] == nodes["ORIGIN-0042"]["digest"]
              and body["origin_spec_sha256"] == origin["spec_sha256"], body["parent"]["id"])

    check("isolation · the two builds are siblings, not copies",
          nodes["BUILD-A"]["body"]["root"] != nodes["BUILD-B"]["body"]["root"]
          and nodes["BUILD-A"]["body"]["agent"] != nodes["BUILD-B"]["body"]["agent"],
          f"{nodes['BUILD-A']['body']['agent']} ≠ {nodes['BUILD-B']['body']['agent']}")

    # ---- 6. divergence -----------------------------------------------------
    div = nodes["DIVERGENCE-01"]["body"]
    tests = json.loads((ROOT / "data" / "test-results.json").read_text())
    cross = next(r for r in tests["runs"] if r["id"] == "B/A")
    case = {c["id"]: c for c in cross["cases"]}

    check("DIVERGENCE-01 · derived from both builds",
          [p["digest"] for p in div["parents"]] == [nodes["BUILD-A"]["digest"], nodes["BUILD-B"]["digest"]],
          "BUILD-A + BUILD-B")

    for f in div["findings"]:
        cid = f["evidence"]["case"]
        check(f"{f['id']} · evidence case {cid} actually failed",
              case[cid]["status"] == "fail", (case[cid]["detail"] or "")[:80])
        check(f"{f['id']} · bound to a spec clause", bool(f["spec"].strip()), f["spec"])

    blocking = [f["id"] for f in div["findings"] if f["severity"] == "blocking"]
    check("DIVERGENCE-01 · counts match the findings",
          div["summary"]["blocking"] == len(blocking)
          and div["summary"]["fail"] == cross["total"] - cross["passed"],
          f"{len(blocking)} blocking · {div['summary']['accepted']} accepted")

    # ---- 7. attestation ----------------------------------------------------
    att = nodes["ATTEST-01"]["body"]
    check("ATTEST-01 · bound to the divergence", att["parent"]["digest"] == nodes["DIVERGENCE-01"]["digest"])
    check("ATTEST-01 · reviewer is not the builder",
          att["agent"] != nodes["BUILD-A"]["body"]["agent"]
          and nodes["BUILD-B"]["body"]["agent"] == att["agent"],
          f"{att['agent']} ≠ {nodes['BUILD-A']['body']['agent']}")
    check("ATTEST-01 · every blocking finding is named in the conditions",
          all(any(fid in c for c in att["conditions"]) for fid in blocking), ", ".join(blocking))
    check("ATTEST-01 · refusals are explicit",
          len(att["refusals"]) >= 1, f"{len(att['refusals'])} refusals")

    # ---- 8. receipt --------------------------------------------------------
    rec = nodes["RECEIPT-0042"]["body"]
    ack = set(rec["acknowledged"])
    check("RECEIPT-0042 · bound to the attestation", rec["parent"]["digest"] == nodes["ATTEST-01"]["digest"])
    check("RECEIPT-0042 · signed by a person, not an agent",
          rec["actor_kind"] == "human" and rec["actor"] not in
          {nodes["BUILD-A"]["body"]["agent"], nodes["BUILD-B"]["body"]["agent"]},
          rec["actor"])
    check("RECEIPT-0042 · every blocking finding acknowledged",
          all(fid in ack for fid in blocking), ", ".join(sorted(ack)))
    check("RECEIPT-0042 · every refusal acknowledged",
          all(r["id"] in ack for r in att["refusals"]), str(len(att["refusals"])))
    check("RECEIPT-0042 · no-look flag is computed, not asserted",
          rec["no_look"] == (rec["time_to_sign_s"] < rec["no_look_threshold_s"]),
          f"{rec['time_to_sign_s']} s vs threshold {rec['no_look_threshold_s']} s")

    # ---- 9. coverage -------------------------------------------------------
    sealed = sum(len(nodes[b]["body"]["files"]) for b in ("BUILD-A", "BUILD-B"))
    on_disk = len([p for p in (ROOT / "builds").rglob("*") if p.is_file()])
    check("coverage · every build file is in a manifest",
          sealed == on_disk, f"{sealed} sealed / {on_disk} on disk")

    # ---- report ------------------------------------------------------------
    failed = [r for r in results if not r["ok"]]
    if args.json:
        print(json.dumps({"ok": not failed, "checks": results}, indent=2))
    elif not args.quiet:
        print()
        width = max(len(r["name"]) for r in results)
        for r in results:
            print(f"  {'PASS' if r['ok'] else 'FAIL'}  {r['name']:<{width}}  {r['detail']}")
        print()
        print(f"  {len(results) - len(failed)}/{len(results)} checks passed"
              + ("" if not failed else f" · {len(failed)} failed"))
        print(f"  chain root · {nodes['RECEIPT-0042']['digest']}")
        print()

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
