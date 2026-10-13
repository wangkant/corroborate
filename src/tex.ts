export interface TexPart {
  tex: boolean;
  display: boolean;
  s: string;
}

// Two plain words in a row mean the "$" opened prose (a prize such as "$100 is offered"), not math; words in math sit behind \text or a backslash.
const PROSE = /(?:^|[\s(])[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}(?=[\s.,;:)]|$)/;

// "$25 or $50": a number, a space, then a plain word.
const AMOUNT = /^\d[\d,.]*\s+[A-Za-z]{2,}\b/;

function closing(text: string, from: string, at: number): number {
  for (let i = text.indexOf(from, at); i >= 0; i = text.indexOf(from, i + 1)) if (text[i - 1] !== "\\") return i;
  return -1;
}

// Splits markdown with $…$ and $$…$$ into text and math, stopping before `max` visible characters without cutting a formula.
export function texParts(text: string, max = Infinity): { parts: TexPart[]; cut: boolean } {
  const parts: TexPart[] = [];
  let buf = "";
  let len = 0;
  const flush = (): boolean => {
    if (!buf) return true;
    const room = max - len;
    if (buf.length > room) {
      const head = buf.slice(0, room);
      const space = head.lastIndexOf(" ");
      parts.push({ tex: false, display: false, s: (space > room / 2 ? head.slice(0, space) : head).trimEnd() });
      return false;
    }
    parts.push({ tex: false, display: false, s: buf });
    len += buf.length;
    buf = "";
    return true;
  };
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\" && text[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }
    if (text[i] === "$") {
      const display = text[i + 1] === "$";
      const mark = display ? "$$" : "$";
      const end = closing(text, mark, i + mark.length);
      const body = end < 0 ? "" : text.slice(i + mark.length, end);
      if (body.trim() && !PROSE.test(body.replace(/\\[A-Za-z]+\{[^{}]*\}/g, " ")) && !AMOUNT.test(body)) {
        if (!flush()) return { parts, cut: true };
        if (len + body.length > max) {
          const last = parts.at(-1);
          if (last && !last.tex) last.s = last.s.trimEnd();
          return { parts, cut: true };
        }
        parts.push({ tex: true, display, s: body });
        len += body.length;
        i = end + mark.length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  return { parts, cut: !flush() };
}
