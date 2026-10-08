import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, HelpCircle, Shuffle, Undo2 } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { FairnessReport, FairnessSlot } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmAction } from '../ConfirmAction';
import { EmptyState, ErrorState, LoadingSkeleton } from '../primitives';
import { toast } from '../ui/sonner';
import { DifficultyBadge, Distribution, formatP, pct, ShareBar } from './shared';

/**
 * Students who drew different bank questions for the same random slot should
 * have faced equally hard questions. For each slot this compares the variants
 * side by side and, if one turned out harder, offers to even it out.
 */
export function FairnessPanel({ versionId, onChanged }: { versionId: number; onChanged: () => void }) {
  const qc = useQueryClient();
  const key = ['insights', 'fairness', versionId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<FairnessReport>(`/insights/version/${versionId}/fairness`),
  });

  if (isLoading) return <LoadingSkeleton rows={4} variant="list" />;
  if (isError) return <ErrorState title="Could not load the fairness check" error={error} onRetry={() => void refetch()} />;
  if (!data || data.slots.length === 0) {
    return (
      <EmptyState
        icon={Shuffle}
        title="No random questions on this quiz"
        description="When a quiz draws a different bank question per student, this tab compares how hard each one turned out."
      />
    );
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['insights'] });
    onChanged();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bars show the average share of marks earned on each variant ({data.graded_attempts} submitted papers). The dashed
        line is the easiest variant; normalizing gives students on harder variants a bonus up to that line (hatched), so
        nobody loses marks.
      </p>
      {data.slots.map((s) => (
        <SlotCard key={s.slot.id} s={s} minSample={data.min_sample} onChanged={refresh} />
      ))}
    </div>
  );
}

function Verdict({ s, minSample }: { s: FairnessSlot; minSample: number }) {
  if (s.verdict === 'not_enough_data') {
    return (
      <Badge variant="secondary">
        <HelpCircle aria-hidden="true" /> Not enough data (needs {minSample}+ per variant)
      </Badge>
    );
  }
  if (s.verdict === 'unfair') {
    return (
      <Badge variant="warning">
        <AlertTriangle aria-hidden="true" /> Variants differ by {pct(s.gap)}
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <CheckCircle2 aria-hidden="true" /> Fair — gap {pct(s.gap)}
    </Badge>
  );
}

function SlotCard({ s, minSample, onChanged }: { s: FairnessSlot; minSample: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const best = Math.max(0, ...s.variants.map((v) => v.mean_fraction ?? 0));

  const normalize = async (mode: 'raise_to_easiest' | 'clear') => {
    setBusy(true);
    try {
      const res = await api.post<{ changed: number; regraded: number }>(`/insights/slots/${s.slot.id}/normalize`, { mode });
      toast.success(mode === 'clear' ? 'Normalization removed' : `${s.label} normalized`, {
        description: `${res.regraded} paper(s) recalculated — ${res.changed} score(s) changed.`,
      });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not normalize.');
    } finally {
      setBusy(false);
    }
  };

  const bonusText = s.variants
    .map((v) => ({ v, b: s.proposed_bonus[v.question_id] ?? 0 }))
    .filter((x) => x.b > 0)
    .map((x) => `${x.v.label}: +${x.b} marks`)
    .join(', ');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono">{s.label}</CardTitle>
          <span className="text-sm text-muted-foreground">
            random {s.slot.difficulty ?? 'any difficulty'}
            {s.slot.tag ? ` · “${s.slot.tag}”` : ''} · {s.slot.points} pt
          </span>
          <Verdict s={s} minSample={minSample} />
          {s.normalized && <Badge variant="default">normalized</Badge>}
        </div>
        <CardDescription>
          {s.p_value !== null && s.verdict !== 'not_enough_data' && (
            <>
              Chi-square test of right/wrong across variants: {formatP(s.p_value)}
              {s.p_value < 0.05 ? ' — the difference is unlikely to be chance.' : ' — consistent with chance.'}
              {s.small_sample && ' (small groups: treat with care)'}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          {s.variants.map((v) => {
            const bonusShare = v.points ? (v.bonus || 0) / v.points : 0;
            return (
              <div key={v.question_id} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
                <span className="font-mono text-sm">
                  {v.label}
                  <span className="block text-xs text-muted-foreground">n = {v.dealt - v.pending}</span>
                </span>
                <ShareBar
                  value={v.mean_fraction ?? 0}
                  bonus={bonusShare}
                  reference={s.variants.length > 1 ? best : null}
                  label={`${v.label}: ${pct(v.mean_fraction)} average from ${v.dealt - v.pending} students${v.bonus ? `, plus ${v.bonus} bonus` : ''}`}
                  tooltip={
                    <div className="space-y-0.5 text-xs">
                      <div className="font-medium">{v.label}</div>
                      <div>
                        {v.correct} of {v.dealt - v.pending} fully correct · average {pct(v.mean_fraction)}
                      </div>
                      {v.bonus > 0 && <div>Bonus applied: +{v.bonus} marks</div>}
                    </div>
                  }
                />
              </div>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Variant</th>
                <th className="py-1 pr-3 font-medium">Question</th>
                <th className="py-1 pr-3 font-medium">Students</th>
                <th className="py-1 pr-3 font-medium">Fully correct</th>
                <th className="py-1 pr-3 font-medium">Avg.</th>
                <th className="py-1 pr-3 font-medium">Rated / plays</th>
                <th className="py-1 font-medium">Bonus</th>
              </tr>
            </thead>
            <tbody>
              {s.variants.map((v) => (
                <tr key={v.question_id} className="border-t align-top">
                  <td className="py-1.5 pr-3 font-mono">{v.label}</td>
                  <td className="max-w-xs truncate py-1.5 pr-3" title={v.text}>
                    {v.text}
                  </td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{v.dealt - v.pending}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{v.correct}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{pct(v.mean_fraction)}</td>
                  <td className="py-1.5 pr-3">
                    <DifficultyBadge value={v.bank_difficulty} /> / <DifficultyBadge value={v.observed_difficulty} />
                  </td>
                  <td className="py-1.5 font-mono tabular-nums">{v.bonus ? `+${v.bonus}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Compare how students answered each variant</summary>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {s.variants.map((v) => (
              <div key={v.question_id}>
                <p className="mb-1 font-mono text-sm font-medium">{v.label}</p>
                <p className="mb-2 truncate text-xs text-muted-foreground" title={v.text}>
                  {v.text}
                </p>
                {v.qtype === 'descriptive' ? (
                  <p className="text-muted-foreground">Written answers — see Marking.</p>
                ) : (
                  <Distribution rows={v.distribution} total={v.dealt - v.pending} />
                )}
              </div>
            ))}
          </div>
        </details>

        <div className="flex flex-wrap gap-2">
          <ConfirmAction
            title={`Normalize ${s.label}?`}
            description={
              <>
                Students who drew a harder variant get bonus marks so their average matches the easiest one
                {bonusText ? ` (${bonusText})` : ''}. Bonuses never push a question above its points, and nobody loses
                marks. Every paper is recalculated now; you can undo it later.
              </>
            }
            confirmLabel="Normalize"
            onConfirm={() => void normalize('raise_to_easiest')}
          >
            <Button size="sm" disabled={busy || s.verdict === 'not_enough_data' || !bonusText}>
              <Shuffle aria-hidden="true" /> Normalize to the easiest variant
            </Button>
          </ConfirmAction>
          {s.normalized && (
            <ConfirmAction
              title="Remove the fairness bonus?"
              description="Scores go back to what students earned on their own variant."
              confirmLabel="Remove bonus"
              destructive
              onConfirm={() => void normalize('clear')}
            >
              <Button size="sm" variant="secondary" disabled={busy}>
                <Undo2 aria-hidden="true" /> Undo normalization
              </Button>
            </ConfirmAction>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
