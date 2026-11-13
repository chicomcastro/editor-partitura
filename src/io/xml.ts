// Helpers mínimos de DOM que funcionam tanto no DOMParser do navegador quanto no
// @xmldom/xmldom dos testes (que não implementa `.children`).

export function kids(el: Element | null | undefined, tag?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Element;
    if (n.nodeType === 1 && (!tag || n.nodeName === tag)) out.push(n);
  }
  return out;
}

export function kid(el: Element | null | undefined, tag: string): Element | undefined {
  if (!el) return undefined;
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Element;
    if (n.nodeType === 1 && n.nodeName === tag) return n;
  }
  return undefined;
}

export function text(el: Element | null | undefined, tag?: string): string | undefined {
  const e = tag ? kid(el, tag) : el;
  if (!e) return undefined;
  return (e.textContent ?? '').trim();
}

export function num(el: Element | null | undefined, tag: string): number | undefined {
  const t = text(el, tag);
  if (t === undefined || t === '') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

export function path(el: Element | null | undefined, ...tags: string[]): Element | undefined {
  let cur: Element | undefined = el ?? undefined;
  for (const t of tags) {
    cur = kid(cur, t);
    if (!cur) return undefined;
  }
  return cur;
}

export type XmlParser = (src: string) => Document;

let parser: XmlParser = (src) => new DOMParser().parseFromString(src, 'application/xml');

export function setXmlParser(p: XmlParser) {
  parser = p;
}

export function parseXml(src: string): Document {
  const doc = parser(src);
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('XML inválido: ' + (err.textContent ?? '').slice(0, 200));
  return doc;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
