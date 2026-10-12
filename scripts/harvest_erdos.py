"""Turn open Erdős problems that may have an unlinked OEIS sequence into Corroborate investigations.

Data: teorth/erdosproblems (Apache 2.0). Usage:
  python -I scripts/harvest_erdos.py --out erdos.json
  python -I scripts/harvest_erdos.py --publish erdos.json
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
LEAN = "https://github.com/google-deepmind/formal-conjectures/blob/main/FormalConjectures/ErdosProblems/{n}.lean"

PREFACE = (
    "These are open Erdős problems, read as questions worth understanding rather than a scoreboard. Two kinds of work help here. "
    "(1) Literature: does published work already settle a problem exactly as stated? Support the claim only with a quote that "
    "states the full result; bounds, special cases and partial progress belong in a note, not as support. A recent source saying "
    "the problem is still open refutes it. (2) OEIS: the Erdős problems database suspects each of these may relate to an OEIS "
    "sequence it does not yet link. If you find one, add a claim of the form 'Erdős Problem #N is directly related to OEIS "
    "A______, ...' and support it with the sequence definition from oeis.org and the matching definition from the problem page. "
    "Findings are candidates for human mathematicians to check; nothing is sent to erdosproblems.com or its database automatically. "
    "Precise Lean statements: " + LEAN.replace("{n}", "N") + "\n"
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
            "formalized": formalized and formalized.group(1) == "yes",
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


def bundle(problems, per=8):
    by_tag = defaultdict(list)
    for p in sorted(problems, key=lambda p: p["number"]):
        by_tag[p["tags"][0] if p["tags"] else "miscellaneous"].append(p)
    out = []
    for tag, items in sorted(by_tag.items(), key=lambda kv: -len(kv[1])):
        for n, start in enumerate(range(0, len(items), per), 1):
            chunk = items[start : start + per]
            lines = [f"#{p['number']}: https://www.erdosproblems.com/{p['number']}" for p in chunk]
            brief = PREFACE + "\n".join(lines)
            assert len(brief) <= 2000, (tag, len(brief))
            suffix = f" ({n})" if len(items) > per else ""
            out.append({
                "title": f"Erdős problems: literature and OEIS connections, {tag}{suffix}",
                "brief": brief,
                "claims": [
                    {
                        "text": f"Erdős Problem #{p['number']}, as stated at erdosproblems.com/{p['number']}, has already been fully resolved (proved or disproved) in published literature.",
                        "origin_url": f"https://www.erdosproblems.com/{p['number']}",
                    }
                    for p in chunk
                ],
                "problems": [p["number"] for p in chunk],
            })
    return out


def publish(path, base):
    secrets = dict(l.split("=", 1) for l in pathlib.Path(__file__).resolve().parent.parent.joinpath(".prod.secrets").read_text(encoding="utf-8").splitlines() if "=" in l)
    token = os.environ.get("ADMIN_TOKEN") or secrets["ADMIN_TOKEN"]
    for inv in json.loads(pathlib.Path(path).read_text(encoding="utf-8")):
        if not inv.get("approved", True):
            continue
        body = json.dumps({"title": inv["title"], "brief": inv["brief"], "claims": inv["claims"]}).encode()
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
        print(f"{len(picked)} problems in {len(data)} investigations -> {args.out}")
        for inv in data:
            print(f"  {inv['title']}: {inv['problems']}")
