import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gavel, Lightbulb, MessageSquareWarning } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { AppealWithContext } from '../../types';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { RichText } from '../RichText';
import { EmptyState, ErrorState, LoadingSkeleton } from '../primitives';
import { toast } from '../ui/sonner';

const STATUS_VARIANT = { open: 'warning', accepted: 'success', rejected: 'secondary' } as const;

/** Students' appeals against a mark or an integrity decision, with what is needed to decide them. */
export function AppealsPanel({ versionId, onChanged }: { versionId: number; onChanged: () => void }) {
  const qc = useQueryClient();
  const key = ['insights', 'appeals', versionId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ appeals: AppealWithContext[]; open: number }>(`/insights/version/${versionId}/appeals`),
  });

  if (isLoading) return <LoadingSkeleton rows={3} variant="list" />;
  if (isError) return <ErrorState title="Could not load appeals" error={error} onRetry={() => void refetch()} />;
  if (!data || data.appeals.length === 0) {
    return (
      <EmptyState
        icon={Gavel}
        title="No appeals"
        description="Students can appeal a mark once results are released, or an integrity decision on their attempt."
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{data.open} open · {data.appeals.length} in total</p>
      {data.appeals.map((a) => (
        <AppealCard
          key={a.id}
          a={a}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['insights'] });
            onChanged();
          }}
        />
      ))}
    </div>
  );
}

function AppealCard({ a, onDone }: { a: AppealWithContext; onDone: () => void }) {
  const [response, setResponse] = useState('');
  const [marks, setMarks] = useState(a.question ? String(a.question.earned) : '');
  const [busy, setBusy] = useState(false);

  const decide = async (status: 'accepted' | 'rejected') => {
    setBusy(true);
    try {
      await api.post(`/insights/appeals/${a.id}/resolve`, {
        status,
        response,
        marks: status === 'accepted' && a.kind === 'grading' && a.question && marks !== '' ? Number(marks) : undefined,
      });
      toast.success(status === 'accepted' ? 'Appeal accepted' : 'Appeal rejected', {
        description: 'The student sees your decision on their result page.',
      });
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the decision.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={STATUS_VARIANT[a.status]}>{a.status}</Badge>
          <Badge variant="outline">{a.kind === 'grading' ? 'Mark' : 'Integrity'}</Badge>
          <strong>{a.student_name}</strong>
          {a.student_entry && <span className="font-mono text-muted-foreground">{a.student_entry}</span>}
          {a.question && <span className="font-mono">{a.question.label}</span>}
          <span className="ml-auto text-xs text-muted-foreground">{new Date(`${a.created_at.replace(' ', 'T')}Z`).toLocaleString()}</span>
        </div>
        <p className="flex items-start gap-2 whitespace-pre-wrap text-sm">
          <MessageSquareWarning className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {a.message}
        </p>

        {a.question && (
          <div className="space-y-2 rounded-[var(--radius-md)] bg-muted/40 p-3 text-sm">
            <RichText content={a.question.text} />
            <p>
              <span className="text-muted-foreground">Their answer: </span>
              <span className="whitespace-pre-wrap">{a.question.student_answer}</span>
            </p>
            {a.question.assumption && (
              <p className="flex items-start gap-1.5">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  <span className="text-muted-foreground">Assumed: </span>
                  {a.question.assumption}
                </span>
              </p>
            )}
            <p>
              <span className="text-muted-foreground">{a.question.qtype === 'descriptive' ? 'Marking guide: ' : 'Key: '}</span>
              {a.question.answer_text || '—'} · <span className="text-muted-foreground">earned</span> {a.question.earned}/
              {a.question.points}
            </p>
          </div>
        )}
        {a.kind === 'integrity' && (
          <p className="text-sm text-muted-foreground">
            Attempt {a.attempt.status}
            {a.attempt.violation_count ? ` · ${a.attempt.violation_count} violation(s)` : ''}
            {a.open_flags ? ` · ${a.open_flags} open staff flag(s) — accepting resolves them` : ''}
            {a.attempt.status === 'locked' ? ' · reinstating stays a separate decision on the Incidents page' : ''}
          </p>
        )}

        {a.status === 'open' ? (
          <div className="space-y-2">
            <Textarea
              rows={2}
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              placeholder="Your reply to the student (required to reject)"
              aria-label="Reply to the student"
            />
            <div className="flex flex-wrap items-center gap-2">
              {a.kind === 'grading' && a.question && (
                <label className="flex items-center gap-2 text-sm">
                  New marks
                  <Input
                    type="number"
                    min={0}
                    max={a.question.points}
                    step={0.25}
                    value={marks}
                    onChange={(e) => setMarks(e.target.value)}
                    className="h-8 w-24"
                  />
                  <span className="text-muted-foreground">/ {a.question.points}</span>
                </label>
              )}
              <Button size="sm" onClick={() => void decide('accepted')} disabled={busy}>
                Accept
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void decide('rejected')} disabled={busy || !response.trim()}>
                Reject
              </Button>
              <Button asChild size="sm" variant="ghost" className="ml-auto">
                <Link to={`/incidents/attempt/${a.attempt_id}`}>Open the attempt timeline</Link>
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm">
            <span className="text-muted-foreground">
              {a.status === 'accepted' ? 'Accepted' : 'Rejected'}
              {a.resolved_by_name ? ` by ${a.resolved_by_name}` : ''}:{' '}
            </span>
            {a.response || '—'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
