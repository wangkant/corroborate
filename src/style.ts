// The build also writes this to public/<base>/ as a static asset; the worker route stays as a fallback.
export const CSS = `:root {
  --bg: #f6f4ee; --ink: #1c1b18; --muted: #6b675e; --rule: #d9d4c7; --accent: #1f4e79;
  --support: #2f6b3a; --refute: #9a2f24; --contest: #8a5a00;
  --serif: "Iowan Old Style", "Charter", Georgia, "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161513; --ink: #ece8de; --muted: #9c978b; --rule: #34312b; --accent: #8fb8e0; --support: #7fc28a; --refute: #e58b7f; --contest: #e0b25c; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.6 var(--sans); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
.top, main, footer { max-width: 980px; margin: 0 auto; padding: 0 20px; }
.top { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 24px; padding-top: 22px; padding-bottom: 14px; border-bottom: 1px solid var(--rule); }
.brand { font: 600 21px/1 var(--serif); color: var(--ink); letter-spacing: 0.01em; }
.top nav { display: flex; gap: 20px; flex-wrap: wrap; font-size: 15px; }
.top nav a { color: var(--muted); }
.top nav a:hover { color: var(--ink); }
main { padding-top: 36px; padding-bottom: 56px; }
h1 { font: 600 clamp(28px, 4.4vw, 42px)/1.15 var(--serif); margin: 0 0 14px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
h2 { font: 600 20px/1.3 var(--serif); margin: 36px 0 12px; }
.lede { font-size: 19px; color: var(--muted); max-width: 46em; margin: 0 0 20px; overflow-wrap: anywhere; }
.brief p { margin: 0 0 8px; }
.brief p + p { font-size: 15px; }
.claim, .summary p, ul.thread p, .prose p { overflow-wrap: anywhere; }
.kicker { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; }
.muted { color: var(--muted); }
.meta { color: var(--muted); font-size: 14px; }
.hero .scope { font-size: 15px; color: var(--muted); max-width: 52em; margin: 0 0 20px; }
.hero h1 { font-size: clamp(32px, 5.4vw, 54px); max-width: 15em; }
.connect { margin: 26px 0 0; font-size: 15px; color: var(--muted); }
.connect code { display: block; margin-top: 8px; font: 15px/1.5 var(--mono); color: var(--ink); padding: 4px 0 6px; border-bottom: 2px solid var(--accent); width: fit-content; max-width: 100%; overflow-wrap: anywhere; }
.stats { display: flex; flex-wrap: wrap; gap: 18px 40px; margin: 38px 0 6px; padding: 18px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.stat { display: flex; flex-direction: column; }
.stat .n { font: 600 30px/1.1 var(--serif); font-variant-numeric: tabular-nums; }
.stat .label { font-size: 13px; color: var(--muted); }
.cols { display: grid; grid-template-columns: 1.1fr 1fr; gap: 0 48px; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
ul.list, ul.feed, ol.claims, ul.evlist, ul.thread { list-style: none; margin: 0; padding: 0; }
ul.list li { padding: 12px 0; border-bottom: 1px solid var(--rule); display: flex; flex-direction: column; gap: 2px; }
ul.list li a.t { font: 500 18px/1.35 var(--serif); color: var(--ink); }
ul.list li a.t:hover { color: var(--accent); }
ul.feed li { padding: 7px 0; font-size: 15px; border-bottom: 1px solid var(--rule); overflow-wrap: anywhere; }
ol.claims { counter-reset: claim; }
ol.claims > li { counter-increment: claim; padding: 18px 0 14px; border-bottom: 1px solid var(--rule); }
.claim { font: 500 19px/1.4 var(--serif); margin: 0 0 8px; }
.claim::before { content: counter(claim) ". "; color: var(--muted); }
.claim a { color: var(--ink); }
.verdict { font: 600 12px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.07em; margin-left: 6px; color: var(--muted); white-space: nowrap; }
.v-supported, .v-leaning_supported { color: var(--support); }
.v-refuted, .v-leaning_refuted { color: var(--refute); }
.v-contested, .v-candidate { color: var(--contest); }
.v-candidate { white-space: normal; }
.ev { padding: 8px 0 8px 16px; border-left: 2px solid var(--rule); margin: 10px 0; }
.ev-accepted.tier-primary { border-left-color: var(--accent); }
.ev blockquote { margin: 0; font: italic 17px/1.5 var(--serif); overflow-wrap: anywhere; }
.ev .meta { margin: 4px 0 0; }
.stance { font-weight: 600; }
.s-supports { color: var(--support); }
.s-refutes { color: var(--refute); }
.note { font-size: 14px; margin: 4px 0 0; }
.summary { border-top: 2px solid var(--ink); padding-top: 4px; }
ul.thread li { padding: 12px 0; border-bottom: 1px solid var(--rule); }
ul.thread li.reply { padding-left: 22px; }
ul.thread p { margin: 0; overflow-wrap: anywhere; }
ul.thread .meta { margin-bottom: 4px; }
.intent { font: 600 11px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.07em; color: var(--accent); }
.proposals .kind { font: 600 12px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.07em; color: var(--accent); margin-right: 6px; }
.proposals p { margin: 0; }
.proposals .body { font-size: 15px; color: var(--muted); margin-top: 4px; }
table.board { width: 100%; border-collapse: collapse; font-size: 15px; }
.board th { text-align: left; font-weight: 500; color: var(--muted); border-bottom: 1px solid var(--ink); padding: 8px 10px 8px 0; }
.board td { border-bottom: 1px solid var(--rule); padding: 9px 10px 9px 0; }
.board .num { text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) { .board .opt { display: none; } }
.prose { max-width: 42em; }
.prose p { margin: 0 0 14px; }
form.report { max-width: 36em; display: flex; flex-direction: column; gap: 14px; }
form.report label { font-size: 14px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
form.report input, form.report textarea, form.report select { font: inherit; color: var(--ink); background: transparent; border: 0; border-bottom: 1px solid var(--ink); padding: 6px 0; border-radius: 0; }
form.report textarea { min-height: 6em; resize: vertical; }
form.report button { align-self: flex-start; font: 600 15px/1 var(--sans); color: var(--bg); background: var(--accent); border: 0; padding: 10px 18px; border-radius: 3px; cursor: pointer; }
p.error { color: var(--refute); }
pre.token { font: 15px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px 0 8px; border-bottom: 2px solid var(--accent); width: fit-content; max-width: 100%; }
ul.steps { padding-left: 1.2em; max-width: 46em; }
ul.steps li { margin-bottom: 10px; }
ul.steps code { font: 14px/1.5 var(--mono); overflow-wrap: anywhere; }
footer { border-top: 1px solid var(--rule); padding-top: 18px; padding-bottom: 40px; font-size: 13px; color: var(--muted); }
footer p { max-width: 52em; }
`;

// Content hash for the stylesheet URL, so the CDN's cached copy is bypassed whenever the CSS changes.
export const CSS_VERSION = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < CSS.length; i++) h = Math.imul(h ^ CSS.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
})();

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1f4e79"/><path d="M9 17l5 5 9-12" fill="none" stroke="#f6f4ee" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
