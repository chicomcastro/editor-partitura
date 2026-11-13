// Ícones SVG desenhados à mão: fontes musicais Unicode não são garantidas no iPadOS.
const svg = (inner: string, vb = '0 0 24 32') => `<svg viewBox="${vb}" width="22" height="28" aria-hidden="true">${inner}</svg>`;

export function noteIcon(base: number): string {
  const hollow = base <= 1;
  const head = `<ellipse cx="9" cy="25" rx="6" ry="4.3" transform="rotate(-20 9 25)" fill="${hollow ? 'none' : 'currentColor'}" stroke="currentColor" stroke-width="${hollow ? 2 : 1}"/>`;
  if (base <= 0) return svg(head);
  const stem = '<line x1="14.5" y1="24" x2="14.5" y2="4" stroke="currentColor" stroke-width="1.8"/>';
  let flags = '';
  for (let i = 0; i < Math.max(0, base - 2); i++) {
    const y = 4 + i * 6;
    flags += `<path d="M14.5 ${y} q 7 5 5 13" fill="none" stroke="currentColor" stroke-width="2.2"/>`;
  }
  return svg(head + stem + flags);
}

export const icons = {
  rest: svg('<path d="M9 3 L15 10 L10 16 L15 23 Q8 20 10 28 Q4 22 11 21 L6 15 L11 9 Z" fill="currentColor"/>'),
  dot: svg('<circle cx="12" cy="18" r="3.5" fill="currentColor"/>'),
  tie: svg('<path d="M3 14 Q12 26 21 14" fill="none" stroke="currentColor" stroke-width="2.4"/>'),
  triplet: svg('<text x="12" y="22" font-size="17" text-anchor="middle" font-weight="700" font-family="Georgia,serif" fill="currentColor">3</text><path d="M2 10 v-4 h20 v4" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
  chord: svg(
    '<ellipse cx="9" cy="24" rx="5.5" ry="4" fill="currentColor"/><ellipse cx="9" cy="16" rx="5.5" ry="4" fill="currentColor"/><line x1="14" y1="24" x2="14" y2="3" stroke="currentColor" stroke-width="1.8"/><text x="20" y="11" font-size="11" font-weight="700" text-anchor="middle" fill="currentColor">+</text>',
  ),
  sharp: svg('<text x="12" y="25" font-size="24" text-anchor="middle" fill="currentColor">♯</text>'),
  flat: svg('<text x="12" y="25" font-size="24" text-anchor="middle" fill="currentColor">♭</text>'),
  natural: svg('<text x="12" y="25" font-size="24" text-anchor="middle" fill="currentColor">♮</text>'),
  up: svg('<path d="M12 6 L20 18 H4 Z" fill="currentColor"/><rect x="9" y="18" width="6" height="8" fill="currentColor"/>'),
  down: svg('<path d="M12 26 L20 14 H4 Z" fill="currentColor"/><rect x="9" y="6" width="6" height="8" fill="currentColor"/>'),
  trash: svg('<path d="M5 9h14l-1.3 18H6.3z M3 6h18 M9 6V3h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  undo: svg('<path d="M8 10 L3 15 L8 20 M3 15 H15 a6 6 0 0 1 0 12 H10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  redo: svg('<path d="M16 10 L21 15 L16 20 M21 15 H9 a6 6 0 0 0 0 12 H14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  play: svg('<path d="M6 5 L21 16 L6 27 Z" fill="currentColor"/>'),
  stop: svg('<rect x="5" y="8" width="14" height="16" rx="2" fill="currentColor"/>'),
  piano: svg(
    '<rect x="1.5" y="7" width="21" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 7v19 M12 7v19 M17 7v19" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="7" width="3.5" height="11" fill="currentColor"/><rect x="10.2" y="7" width="3.5" height="11" fill="currentColor"/><rect x="15.4" y="7" width="3.5" height="11" fill="currentColor"/>',
  ),
  pencil: svg('<path d="M4 28 l2-7 13-13 5 5-13 13z M17 10l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  hand: svg(
    '<path d="M8 17V7a2 2 0 0 1 4 0v8V5a2 2 0 0 1 4 0v10V7a2 2 0 0 1 4 0v12c0 6-3 9-8 9-4 0-6-2-8-6l-2.5-5a2 2 0 0 1 3.4-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  ),
  metronome: svg('<path d="M8 4h8l5 24H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 22 L19 8" stroke="currentColor" stroke-width="2"/><circle cx="17" cy="11" r="2" fill="currentColor"/>'),
  back: svg('<path d="M15 6 L6 16 L15 26" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  more: svg('<circle cx="5" cy="16" r="2.4" fill="currentColor"/><circle cx="12" cy="16" r="2.4" fill="currentColor"/><circle cx="19" cy="16" r="2.4" fill="currentColor"/>'),
  measure: svg('<path d="M2 8h20M2 13h20M2 18h20M2 23h20M2 28h20" stroke="currentColor" stroke-width="1"/><path d="M3 8v20M21 8v20" stroke="currentColor" stroke-width="2"/>', '0 0 24 34'),
  share: svg('<path d="M12 3v16 M6 9l6-6 6 6 M5 15v11h14V15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  zoomIn: svg('<circle cx="10" cy="14" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 19l6 6 M7 14h6 M10 11v6" stroke="currentColor" stroke-width="2"/>'),
  zoomOut: svg('<circle cx="10" cy="14" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 19l6 6 M7 14h6" stroke="currentColor" stroke-width="2"/>'),
};
