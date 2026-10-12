"""Turn open Erdős problems into literature-check investigations on Corroborate.

Data: teorth/erdosproblems (Apache 2.0); statements: google-deepmind/formal-conjectures, pinned to one commit.
  python -I scripts/harvest_erdos.py --out erdos.json
  python -I scripts/harvest_erdos.py --publish erdos.json
Only investigations with "approved": true are published, so batches can be opened one at a time.
"""

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.request
from collections import defaultdict

DATA = "https://raw.githubusercontent.com/teorth/erdosproblems/main/data/problems.yaml"
UA = {"user-agent": "CorroborateSeed/0.1 (https://charune.com/corroborate/about; operator script)"}
LEAN_COMMIT = "34ee0e3c5fd52d202d62a71094a37970cb5fb870"
LEAN = "https://github.com/google-deepmind/formal-conjectures/blob/" + LEAN_COMMIT + "/FormalConjectures/ErdosProblems/{n}.lean"
EXCLUDE = ["wikipedia.org", "wolfram.com", "erdosproblems.com", "github.com"]

PREFACE = (
    "Literature check for open Erdős problems. No one here is trying to solve them; we only ask whether published work already "
    "answers one, so mathematicians can check. Nothing is sent to erdosproblems.com, the OEIS or GitHub. The problem is the main "
    "theorem erdos_N in the formal-conjectures file listed below, not a variant. Support a claim only with a quote of a theorem "
    "that answers that main statement in full, with the same quantifiers, ranges and constants. Bounds, special cases, variants, "
    "asymptotic orders when an exact value is asked for, conditional results (e.g. GRH) and Erdős's claims of unpublished proofs "
    "are notes, not support. A recent source saying the problem is still open refutes the claim. An arXiv preprint and its journal "
    "version are one source. Wikipedia, MathWorld and erdosproblems.com do not count. Every note names the paper (authors, year, "
    "arXiv id or DOI) and says in one line how its theorem matches erdos_N. Results stay candidate references until a "
    "mathematician reads them.\n"
)


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8")


def parse(yaml_text):
    out = []
    for block in re.split(r"\n(?=- number:)", yaml_text)[1:]:
        num = re.search(r'number: "(\d+)"', block)
        state = re.search(r'^  informal_status:\n    state: "([^"]+)"', block, re.M)
        formalized = re.search(r'^  formalized:\n    state: "([^"]+)"', block, re.M)
        oeis = re.search(r"^  oeis:\s*(.+)$", block, re.M)
        tags = re.search(r"^  tags:\s*(.+)$", block, re.M)
        comments = re.search(r"^  comments:\s*(.+)$", block, re.M)
        out.append({
            "number": int(num.group(1)),
            "state": state.group(1) if state else None,
            "formalized": bool(formalized and formalized.group(1) == "yes"),
            "oeis": oeis.group(1) if oeis else "",
            "tags": re.findall(r'"([^"]+)"', tags.group(1)) if tags else [],
            "ambiguous": bool(comments and "ambiguous" in comments.group(1)),
        })
    return out


def candidates(problems):
    return [
        p for p in problems
        if p["state"] == "open" and p["formalized"] and not p["ambiguous"]
        and "possible" in p["oeis"] and not re.search(r"A\d{6}", p["oeis"])
    ]


def bundle(problems, per=5):
    by_tag = defaultdict(list)
    for p in sorted(problems, key=lambda p: p["number"]):
        by_tag[p["tags"][0] if p["tags"] else "miscellaneous"].append(p)
    out = []
    for tag, items in sorted(by_tag.items(), key=lambda kv: -len(kv[1])):
        for n, start in enumerate(range(0, len(items), per), 1):
            chunk = items[start : start + per]
            lines = [f"#{p['number']}: {LEAN.format(n=p['number'])}" for p in chunk]
            brief = PREFACE + "\n".join(lines)
            assert len(brief) <= 2000, (tag, len(brief))
            suffix = f" ({n})" if len(items) > per else ""
            out.append({
                "title": f"Erdős problems: literature check, {tag}{suffix}",
                "brief": brief,
                "claims": [
                    {
                        "text": f"A published paper or arXiv preprint answers the main question of Erdős Problem #{p['number']} "
                                f"(theorem erdos_{p['number']} in formal-conjectures) in full (proof, disproof, or the exact value asked for) with no extra hypotheses.",
                        "origin_url": LEAN.format(n=p["number"]),
                    }
                    for p in chunk
                ],
                "problems": [p["number"] for p in chunk],
                "approved": False,
            })
    return out


def publish(path, base):
    secrets = dict(l.split("=", 1) for l in pathlib.Path(__file__).resolve().parent.parent.joinpath(".prod.secrets").read_text(encoding="utf-8").splitlines() if "=" in l)
    token = os.environ.get("ADMIN_TOKEN") or secrets["ADMIN_TOKEN"]
    for inv in json.loads(pathlib.Path(path).read_text(encoding="utf-8")):
        if not inv.get("approved"):
            continue
        body = json.dumps({
            "title": inv["title"], "brief": inv["brief"], "claims": inv["claims"],
            "exclude_domains": EXCLUDE, "verdict_cap": "candidate",
        }).encode()
        req = urllib.request.Request(base + "/api/admin/investigations", data=body, method="POST",
                                     headers={**UA, "content-type": "application/json", "authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=60) as r:
            print(r.status, json.loads(r.read()).get("investigation_id"), inv["title"], len(inv["claims"]), "claims")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--publish")
    ap.add_argument("--base", default="https://charune.com/corroborate")
    args = ap.parse_args()
    if args.publish:
        publish(args.publish, args.base)
    else:
        picked = candidates(parse(fetch(DATA)))
        data = bundle(picked)
        pathlib.Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{len(picked)} problems in {len(data)} investigations -> {args.out}; set \"approved\": true on the ones to open")
        for inv in data:
            print(f"  {inv['title']}: {inv['problems']}")
