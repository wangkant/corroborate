"""Suggest which Erdős problems recent papers may answer, for an operator to read.

Ranks every erdosproblems.com statement against each new paper on an instance that names no problem
number (TF-IDF over the statement and remarks). Problem pages are cached locally and fetched politely,
so the first run takes about 25 minutes and later runs only fetch new problems. Nothing is written to
the instance or to any other site; read the top candidates yourself before linking anything.

  python -I scripts/match_leads.py --base https://<your-instance> --days 7
"""

import argparse
import html
import json
import math
import pathlib
import re
import sys
import time
import urllib.request
from collections import Counter

UA = {"user-agent": "CorroborateSeed/0.1 (+https://github.com/wangkant/corroborate)"}
DATA = "https://raw.githubusercontent.com/teorth/erdosproblems/main/data/problems.yaml"
STOP = set(
    "the of and a an to in is are for that with on by as be we this it at from or which there any all if then let such its can our "
    "has have not no exists exist show prove problem question erdos conjecture paper result results".split()
)


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def text(raw):
    t = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))


def words(s):
    s = re.sub(r"\\[a-zA-Z]+", " ", s.lower())
    return [w for w in re.findall(r"[a-z][a-z\-]{2,}", s) if w not in STOP]


def problems(cache):
    yaml = get(DATA)
    states = {}
    for block in yaml.split("\n- number: ")[1:]:
        n = int(block.split('"')[1])
        st = re.search(r'informal_status:\n {4}state: "([^"]+)"', block)
        states[n] = st.group(1) if st else "?"
    cache.mkdir(parents=True, exist_ok=True)
    statements = {}
    for n in sorted(states):
        f = cache / f"{n}.html"
        if not f.exists():
            try:
                f.write_text(get(f"https://www.erdosproblems.com/{n}"), encoding="utf-8")
            except Exception as e:
                print(f"skip #{n}: {e}", file=sys.stderr)
                continue
            time.sleep(1.2)
        t = text(f.read_text(encoding="utf-8"))
        i = t.find(" Go Go Random ")
        j = t.find("Proof expositions", i)
        statements[n] = t[i + 14: j if j > 0 else i + 2000] if i >= 0 else t[:2000]
    return states, statements


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="the instance, e.g. https://example.org/corroborate")
    ap.add_argument("--days", type=int, default=7, help="only papers published in the last N days")
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--min-score", type=float, default=0.22)
    ap.add_argument("--cache", default=str(pathlib.Path(__file__).resolve().parent.parent / ".cache" / "erdosproblems"))
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    states, statements = problems(pathlib.Path(args.cache))
    df = Counter(w for s in statements.values() for w in set(words(s)))
    idf = {w: math.log(len(statements) / c) for w, c in df.items()}

    def vec(ws):
        c = Counter(w for w in ws if w in idf)
        v = {w: k * idf[w] for w, k in c.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        return {w: x / norm for w, x in v.items()}

    pv = {n: vec(words(s)) for n, s in statements.items()}
    leads = json.loads(get(f"{args.base.rstrip('/')}/api/leads?days={args.days}&limit=100"))["leads"]
    shown = 0
    for lead in leads:
        if lead["problems"] or lead["matched"]:
            continue
        lv = vec(words(lead["untrusted_title"] + " " + lead["untrusted_summary"]))
        ranked = sorted(((sum(x * pv[n].get(w, 0) for w, x in lv.items()), n) for n in pv), reverse=True)[: args.top]
        if not ranked or ranked[0][0] < args.min_score:
            continue
        shown += 1
        print(f"\narXiv:{lead['id']}  {lead['untrusted_title'][:110]}")
        for score, n in ranked:
            print(f"   {score:.2f}  #{n} [{states.get(n, '?')}]  {statements[n][:150]}")
    print(f"\n{len(leads)} papers in the last {args.days} days; {shown} with a candidate above {args.min_score}.")


if __name__ == "__main__":
    main()
