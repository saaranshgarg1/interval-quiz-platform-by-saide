import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Clock, FileText, Flag, Network, SearchCheck, ShieldQuestion, Users } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { CollusionPair, CollusionReport, CollusionStudent } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ConfirmAction } from '../ConfirmAction';
import { EmptyState } from '../primitives';
import { toast } from '../ui/sonner';
import { formatP } from './shared';

const LEVEL_TEXT = { high: 'Strong evidence', medium: 'Worth a look', low: 'Weak signal' } as const;
const LEVEL_VARIANT = { high: 'destructive', medium: 'warning', low: 'secondary' } as const;

function who(s: CollusionStudent) {
  return (
    <span>
      <span className="font-medium">{s.name}</span>
      {s.entry_number && <span className="ml-1 font-mono text-xs text-muted-foreground">{s.entry_number}</span>}
      {s.score !== null && (
        <span className="ml-1 text-xs text-muted-foreground">
          · {s.score}/{s.max_score}
        </span>
      )}
    </span>
  );
}

/**
 * Runs only when the instructor chooses to. Explains the method before the
 * results, because a list of names is an accusation unless people can see why.
 */
export function CollusionPanel({ versionId }: { versionId: number }) {
  const [report, setReport] = useState<CollusionReport | null>(null);
  const run = useMutation({
    mutationFn: () => api.post<CollusionReport>(`/insights/version/${versionId}/collusion`),
    onSuccess: setReport,
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'The check failed.'),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldQuestion className="size-5 text-primary" aria-hidden="true" /> Check for answer copying
          </CardTitle>
          <CardDescription>
            Students who get a question wrong usually choose different wrong answers. Pairs who keep choosing the{' '}
            <em>same</em> wrong answers — especially unpopular ones — far more often than chance allows are listed below,
            along with near-identical written answers. The probability is corrected for the number of pairs compared, so
            a big class does not produce false alarms just by size. Same network and saving the same answers at the same
            moment are shown as context only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            <SearchCheck aria-hidden="true" />
            {run.isPending ? 'Checking…' : report ? 'Run again' : 'Run collusion check'}
          </Button>
          <p className="text-sm text-muted-foreground">
            A match is evidence to look into, never proof. Talk to the students before deciding anything.
          </p>
        </CardContent>
      </Card>

      {report && (
        <>
          <p className="text-sm text-muted-foreground">
            Compared {report.pairs_checked.toLocaleString()} pairs across {report.analysed_attempts} papers and{' '}
            {report.questions_used} questions · {new Date(report.generated_at).toLocaleTimeString()}
          </p>
          {report.pairs.length === 0 ? (
            <EmptyState icon={Users} title="No suspicious pairs" description="No pair shared unusual answers beyond what chance explains." />
          ) : (
            report.pairs.map((p) => <PairCard key={`${p.a.attempt_id}-${p.b.attempt_id}`} p={p} />)
          )}
        </>
      )}
    </div>
  );
}

function PairCard({ p }: { p: CollusionPair }) {
  const [flagged, setFlagged] = useState(false);
  const flagBoth = async () => {
    const reason = (other: CollusionStudent) =>
      p.text_matches.length > 0
        ? `Collusion check: near-identical written answer to ${other.name}'s (${p.text_matches.map((t) => t.label).join(', ')}).`
        : `Collusion check: ${p.shared_wrong} identical wrong answers shared with ${other.name} (${formatP(p.adjusted_p)} after correction).`;
    try {
      const severity = p.level === 'high' ? 'high' : 'medium';
      await api.post(`/proctor/attempt/${p.a.attempt_id}/flags`, { severity, reason: reason(p.b) });
      await api.post(`/proctor/attempt/${p.b.attempt_id}/flags`, { severity, reason: reason(p.a) });
      setFlagged(true);
      toast.success('Both attempts flagged for review.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not flag the attempts.');
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={LEVEL_VARIANT[p.level]}>{LEVEL_TEXT[p.level]}</Badge>
          {who(p.a)}
          <span className="text-muted-foreground">and</span>
          {who(p.b)}
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {p.shared_wrong > 0 && (
            <span className="rounded-[var(--radius-md)] bg-muted px-2 py-1">
              <strong>{p.shared_wrong}</strong> identical wrong answers out of {p.both_wrong} both got wrong · chance would
              explain about {p.expected_by_chance} · {formatP(p.adjusted_p)} (corrected)
            </span>
          )}
          {p.text_matches.map((t) => (
            <span key={t.question_id} className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-muted px-2 py-1">
              <FileText className="size-3.5" aria-hidden="true" />
              {t.label}: written answers {Math.round(t.similarity * 100)}% the same
            </span>
          ))}
          {p.same_network && (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-muted px-2 py-1">
              <Network className="size-3.5" aria-hidden="true" /> same network
            </span>
          )}
          {p.close_saves > 0 && (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-muted px-2 py-1">
              <Clock className="size-3.5" aria-hidden="true" /> {p.close_saves} shared answer(s) saved within 30 s of each other
            </span>
          )}
          {p.submitted_gap_seconds !== null && p.submitted_gap_seconds <= 120 && (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-muted px-2 py-1">
              <Clock className="size-3.5" aria-hidden="true" /> submitted {p.submitted_gap_seconds} s apart
            </span>
          )}
        </div>
        {p.shared_questions.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Show the shared wrong answers</summary>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {p.shared_questions.map((q) => (
                <li key={q.question_id}>
                  <span className="font-mono">{q.label}</span> — {q.answer}
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link to={`/incidents/attempt/${p.a.attempt_id}`}>Timeline: {p.a.name.split(' ')[0]}</Link>
          </Button>
          <Button asChild size="sm" variant="secondary">
            <Link to={`/incidents/attempt/${p.b.attempt_id}`}>Timeline: {p.b.name.split(' ')[0]}</Link>
          </Button>
          <ConfirmAction
            title="Flag both attempts?"
            description="Adds a staff flag to each attempt with the evidence above. It does not change scores or lock anything; it puts both on the Flags list for review."
            confirmLabel="Flag both"
            onConfirm={() => void flagBoth()}
          >
            <Button size="sm" variant="outline" disabled={flagged}>
              <Flag aria-hidden="true" /> {flagged ? 'Flagged' : 'Flag both for review'}
            </Button>
          </ConfirmAction>
        </div>
      </CardContent>
    </Card>
  );
}
