/** "2 pt", or "+2 / −0.5" when a wrong answer loses marks. */
export function marksLabel(points: number, negative?: number | null): string {
  const neg = Number(negative) || 0;
  return neg > 0 ? `+${fmt(points)} / −${fmt(neg)}` : `${fmt(points)} pt`;
}

/** Sentence for students, e.g. "2 marks · −0.5 for a wrong answer". */
export function marksSentence(points: number, negative?: number | null): string {
  const neg = Number(negative) || 0;
  const base = `${fmt(points)} mark${points === 1 ? '' : 's'}`;
  return neg > 0 ? `${base} · −${fmt(neg)} for a wrong answer` : base;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
