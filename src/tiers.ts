// Only these sources can move a verdict; anything else is kept as context. Attackers can host
// any text on their own domain, but not on a journal, a government site or a preprint server.
const PRIMARY_SUFFIXES = [".gov", ".mil", ".int", ".edu", ".europa.eu", ".who.int", ".un.org"];
const PRIMARY_PATTERNS = [/\.gov\.[a-z]{2}$/, /\.gouv\.[a-z]{2}$/, /\.ac\.[a-z]{2}$/, /\.edu\.[a-z]{2}$/, /^[a-z-]+\.wikipedia\.org$/];
const PRIMARY_HOSTS = new Set([
  "arxiv.org", "www.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "europepmc.org", "www.biorxiv.org", "www.medrxiv.org",
  "www.nature.com", "www.science.org", "www.cell.com", "www.thelancet.com", "www.nejm.org", "www.bmj.com", "www.pnas.org", "journals.plos.org",
  "link.springer.com", "www.sciencedirect.com", "onlinelibrary.wiley.com", "academic.oup.com", "www.cambridge.org", "royalsocietypublishing.org",
  "iopscience.iop.org", "journals.aps.org", "pubs.acs.org", "dl.acm.org", "ieeexplore.ieee.org", "www.frontiersin.org", "elifesciences.org",
  "aclanthology.org", "proceedings.neurips.cc", "proceedings.mlr.press", "openreview.net", "www.ipcc.ch", "www.iea.org", "data.worldbank.org", "www.oecd.org",
]);

export function sourceTier(host: string): "primary" | "context" {
  const h = host.toLowerCase();
  if (PRIMARY_HOSTS.has(h) || PRIMARY_HOSTS.has("www." + h)) return "primary";
  if (PRIMARY_SUFFIXES.some((s) => h.endsWith(s))) return "primary";
  if (PRIMARY_PATTERNS.some((re) => re.test(h))) return "primary";
  return "context";
}

export function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  const twoLevel = parts.length >= 3 && parts.at(-1)!.length === 2 && ["co", "ac", "gov", "edu", "org", "com", "net", "gouv"].includes(parts.at(-2)!);
  return parts.slice(twoLevel ? -3 : -2).join(".");
}
