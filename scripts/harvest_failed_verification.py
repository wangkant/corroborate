"""Harvest Wikipedia statements tagged {{Failed verification}} in science articles as Corroborate investigations.

Editors add that tag when the cited source does not support the sentence, so each one is a ready-made
claim with a human who wants the answer. Usage:

  python -I scripts/harvest_failed_verification.py --out candidates.json
  python -I scripts/harvest_failed_verification.py --publish candidates.json --base https://charune.com/corroborate
"""

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = {"user-agent": "CorroborateSeed/0.1 (https://charune.com/corroborate/about; operator script)"}
API = "https://en.wikipedia.org/w/api.php"
SEARCH_CATS = ["Astronomy", "Physics", "Chemistry", "Computer science", "Geology", "Oceanography", "Mathematics", "Meteorology"]
KEEP = re.compile(
    r"astronom|planet|star|galax|moon|comet|asteroid|physic|chemical|element|compound|mineral|geolog|volcan|ocean|"
    r"sea|climate|weather|atmosph|mathemat|algorithm|programming|computer|software|protocol|cryptograph|"
    r"spaceflight|space probe|telescope|units of|physical constant|measurement|energy|electric|magnet|optic|"
    r"nuclear|particle|thermodynam|earth|lake|river|mountain|glacier|desert|isotope",
    re.I,
)
DROP = re.compile(
    r"living people|births|deaths|fiction|novel|film|television|video game|franchise|band|album|song|"
    r"drug|medic|disease|disorder|pharmac|psychoactive|companies|company|brands|businesspeople|politic|"
    r"religio|mytholog|deities|military|war|terror|disaster|countries|member states|people from|"
    r"\b(?:men|women)\b|athlet|sport|football|celebrit",
    re.I,
)
PRONOUN = re.compile(
    r"^(?:it|its|this|that|these|those|they|their|he|she|his|her|such|both|also|in addition|similar|similarly|the same|another|other|there)\b", re.I
)
CONNECTIVE = re.compile(r"^(?:nonetheless|nevertheless|however|moreover|furthermore|additionally|thus|therefore|consequently|meanwhile|indeed|in fact|today|currently),?\s+", re.I)
CONTEXTUAL = re.compile(r"\b(?:such|aforementioned|the latter|the former)\b", re.I)


def api(**params):
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read())
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)


class ArticleParser(HTMLParser):
    """Collects paragraph text with markers for references and failed-verification tags, plus reference URLs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraphs, self.refs = [], {}
        self.buf, self.in_p, self.skip = None, False, 0
        self.sup_stack, self.sup_text = [], ""
        self.note_id, self.note_url = None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class") or ""
        if tag == "p":
            self.in_p, self.buf = True, []
        if tag in ("style", "script") or "mw-editsection" in cls:
            self.skip += 1
        if tag == "sup":
            kind = "ref" if "reference" in cls else "tmpl" if "Inline-Template" in cls else "other"
            self.sup_stack.append(kind)
            self.sup_text = ""
        if tag == "a" and self.sup_stack and self.sup_stack[-1] == "ref" and self.in_p:
            href = a.get("href") or ""
            if href.startswith("#cite_note-"):
                self.buf.append(f"⟦REF:{href[1:]}⟧")
        if tag == "li" and (a.get("id") or "").startswith("cite_note-"):
            self.note_id, self.note_url = a["id"], None
        if tag == "a" and self.note_id and not self.note_url and "external" in cls:
            self.note_url = a.get("href")

    def handle_endtag(self, tag):
        if tag in ("style", "script") and self.skip:
            self.skip -= 1
        if tag == "sup" and self.sup_stack:
            kind = self.sup_stack.pop()
            if kind == "tmpl" and "failed verification" in self.sup_text.lower() and self.in_p:
                self.buf.append("⟦FV⟧")
        if tag == "p" and self.in_p:
            self.paragraphs.append("".join(self.buf))
            self.in_p, self.buf = False, None
        if tag == "li" and self.note_id:
            if self.note_url:
                self.refs[self.note_id] = self.note_url
            self.note_id = None

    def handle_data(self, data):
        if self.sup_stack:
            self.sup_text += data
            return
        if self.in_p and not self.skip:
            self.buf.append(data)


TOKEN = re.compile("⟦[^⟧]*⟧")


def flagged_sentences(page_html):
    p = ArticleParser()
    p.feed(page_html)
    out = []
    for para in p.paragraphs:
        if "⟦FV⟧" not in para:
            continue
        parts = re.split(r"(?<=[.!?])(?=(?:⟦[^⟧]*⟧)*\s+[A-Z0-9\"“(])", para)
        for part in parts:
            if "⟦FV⟧" not in part:
                continue
            before = part.split("⟦FV⟧")[0]
            refs = re.findall("⟦REF:([^⟧]+)⟧", before)
            text = re.sub(r"\s+", " ", TOKEN.sub("", before)).strip()
            text = re.sub(r"\s+([.,;:])", r"\1", text)
            out.append({"text": text, "cited": p.refs.get(refs[-1]) if refs else None})
    return out


def tidy(text):
    stripped = CONNECTIVE.sub("", text)
    return stripped[:1].upper() + stripped[1:] if stripped != text else text


def good_claim(text):
    return (
        40 <= len(text) <= 280
        and not PRONOUN.match(text)
        and not CONTEXTUAL.search(text)
        and text[-1:] in ".!?"
        and "citation needed" not in text.lower()
    )


SPACE_EARTH = re.compile(r"astronom|planet|star|galax|moon|comet|asteroid|spaceflight|telescope|ocean|sea|climate|weather|atmosph|geolog|volcan|earth|lake|river|mountain|glacier|desert", re.I)


def harvest(limit_articles):
    seen, statements = set(), []
    for cat in SEARCH_CATS:
        res = api(action="query", list="search", srsearch=f'hastemplate:"Failed verification" deepcat:"{cat}"', srlimit=50, srnamespace=0)
        for hit in res.get("query", {}).get("search", []):
            title = hit["title"]
            if title in seen or len(seen) >= limit_articles:
                continue
            seen.add(title)
            cats = api(action="query", prop="categories", titles=title, clshow="!hidden", cllimit=200)
            names = [c["title"] for page in cats["query"]["pages"] for c in page.get("categories", [])]
            joined = " | ".join(names)
            if DROP.search(joined) or not KEEP.search(joined):
                continue
            parsed = api(action="parse", page=title, prop="text", disableeditsection=1)
            url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))
            for s in flagged_sentences(parsed["parse"]["text"]):
                text = tidy(s["text"])
                if good_claim(text):
                    statements.append({"text": text, "article": title, "url": url, "cited": s["cited"], "theme": "space" if SPACE_EARTH.search(joined) else "matter"})
            print(f"  {title}: {len(statements)} statements so far", file=sys.stderr)
            time.sleep(0.4)
    return statements


THEMES = {
    "space": "Wikipedia statements that failed verification: Earth and space",
    "matter": "Wikipedia statements that failed verification: physics, chemistry and technology",
}


def bundle(statements, per=5):
    """Groups approved statements into themed investigations whose brief names each statement's article and cited source."""
    out = []
    for theme, title in THEMES.items():
        items = [s for s in statements if s["theme"] == theme]
        for n, start in enumerate(range(0, len(items), per), 1):
            chunk = items[start : start + per]
            lines = [f'{i}. "{s["text"][:90]}..." in {s["url"]}' + (f' (cited: {s["cited"]})' if s["cited"] else "") for i, s in enumerate(chunk, 1)]
            brief = (
                "Wikipedia editors tagged each of these statements because the source cited for it did not appear to support it. "
                "Find what primary sources actually say and support or refute each statement as written. "
                "Statement text is quoted from Wikipedia (CC BY-SA 4.0). " + " ".join(lines)
            )
            out.append({"title": title + (f" ({n})" if len(items) > per else ""), "brief": brief[:2000], "claims": [s["text"] for s in chunk], "articles": [s["article"] for s in chunk]})
    return out


def publish(path, base):
    secrets = dict(l.split("=", 1) for l in pathlib.Path(__file__).resolve().parent.parent.joinpath(".prod.secrets").read_text(encoding="utf-8").splitlines() if "=" in l)
    token = os.environ.get("ADMIN_TOKEN") or secrets["ADMIN_TOKEN"]
    statements = [s for s in json.loads(pathlib.Path(path).read_text(encoding="utf-8")) if s.get("approved", True)]
    for inv in bundle(statements):
        body = json.dumps({"title": inv["title"], "brief": inv["brief"], "claims": inv["claims"]}).encode()
        req = urllib.request.Request(base + "/api/admin/investigations", data=body, method="POST",
                                     headers={**UA, "content-type": "application/json", "authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=60) as r:
            print(r.status, json.loads(r.read()).get("investigation_id"), inv["title"], len(inv["claims"]), "claims")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--publish")
    ap.add_argument("--base", default="https://charune.com/corroborate")
    args = ap.parse_args()
    if args.publish:
        publish(args.publish, args.base)
    else:
        data = harvest(args.limit)
        pathlib.Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {len(data)} statements to {args.out}; set \"approved\": false on any to skip, then --publish")
