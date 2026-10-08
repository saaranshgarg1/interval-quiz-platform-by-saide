import type { ReactNode } from 'react';
import { Check, X } from 'lucide-react';
import type { Difficulty } from '../../types';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export const pct = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`;

export const DIFFICULTY_TEXT: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export function DifficultyBadge({ value }: { value: Difficulty | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={value === 'hard' ? 'destructive' : value === 'easy' ? 'success' : 'warning'}>{DIFFICULTY_TEXT[value]}</Badge>;
}

/** p < 0.001 reads better than 1.2e-7. */
export function formatP(p: number | null): string {
  if (p === null) return '—';
  if (p < 0.001) return 'p < 0.001';
  return `p = ${p.toFixed(3)}`;
}

/**
 * One horizontal bar on a 0–100% track: a single series, so it wears the
 * primary colour and its value is written beside it (never colour alone).
 * An optional bonus segment is drawn hatched, and an optional reference
 * marker shows a target (e.g. the easiest variant's average).
 */
export function ShareBar({
  value,
  bonus = 0,
  reference,
  label,
  tooltip,
}: {
  value: number;
  bonus?: number;
  reference?: number | null;
  label: string;
  tooltip: ReactNode;
}) {
  const v = Math.max(0, Math.min(1, value));
  const b = Math.max(0, Math.min(1 - v, bonus));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-3 py-1.5" role="img" aria-label={label}>
          <div className="relative h-3 flex-1 rounded-[4px] bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded-[4px] bg-primary"
              style={{ width: `${v * 100}%` }}
            />
            {b > 0 && (
              <div
                className="absolute inset-y-0 rounded-r-[4px] border-l-2 border-card"
                style={{
                  left: `${v * 100}%`,
                  width: `${b * 100}%`,
                  background:
                    'repeating-linear-gradient(45deg, var(--primary) 0 3px, transparent 3px 7px)',
                  opacity: 0.75,
                }}
              />
            )}
            {reference !== undefined && reference !== null && (
              <div
                className="absolute -inset-y-1 w-0 border-l-2 border-dashed border-muted-foreground"
                style={{ left: `${Math.max(0, Math.min(1, reference)) * 100}%` }}
                aria-hidden="true"
              />
            )}
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-foreground">{pct(v + b)}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** How many students chose each answer; the key is marked with an icon and the word "key", not colour. */
export function Distribution({ rows, total }: { rows: { answer: string; count: number; correct: boolean }[]; total: number }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No answers yet.</p>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="space-y-1" aria-label="How students answered">
      {rows.map((r) => (
        <li key={r.answer} className="grid grid-cols-[minmax(0,1fr)_7rem_3.5rem] items-center gap-2 text-sm">
          <span className="flex min-w-0 items-center gap-1.5">
            {r.correct ? (
              <Check className="size-3.5 shrink-0 text-success" aria-label="correct" />
            ) : (
              <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="truncate" title={r.answer}>
              {r.answer}
            </span>
            {r.correct && <span className="shrink-0 text-xs text-muted-foreground">(key)</span>}
          </span>
          <span className="h-2 rounded-[4px] bg-muted">
            <span className="block h-2 rounded-[4px] bg-primary/70" style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
            {r.count} · {total ? Math.round((r.count / total) * 100) : 0}%
          </span>
        </li>
      ))}
    </ul>
  );
}
