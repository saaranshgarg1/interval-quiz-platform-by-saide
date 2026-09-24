import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Check, X, Minus, KeyRound, AlertCircle, HelpCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '../lib/queries';
import { api, ApiError } from '../api';
import type { ResultDetail, ResultDetail as ResultDetailType } from '../types';
import { formatDateTime } from '../components/ui';
import { RichText } from '../components/RichText';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

/**
 * Response wrapper shape — confirmed against the live endpoint: the API returns
 * `{ result: ResultDetail }`, NOT a bare ResultDetail. Type the generic to match.
 */
interface ResultDetailResponse {
  result: ResultDetail;
}

function prettyAnswer(_qtype: string, v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? `[${v.join(', ')}]` : '—';
  return String(v);
}

/** Derive a pass/fail/neutral status per question using icon + text (WCAG AA). */
function questionStatus(q: ResultDetailType['per_question'][number]): {
  label: string;
  icon: React.ElementType;
  tone: 'success' | 'warning' | 'destructive' | 'secondary';
} {
  if (q.earned > 0) {
    return { label: 'Correct', icon: Check, tone: 'success' };
  }
  if (q.answered) {
    return { label: 'Incorrect', icon: X, tone: 'destructive' };
  }
  return { label: 'Not answered', icon: Minus, tone: 'secondary' };
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <LoadingSkeleton variant="text" rows={2} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <LoadingSkeleton variant="cards" rows={3} />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <LoadingSkeleton variant="text" rows={1} />
            </CardHeader>
            <CardContent>
              <LoadingSkeleton variant="text" rows={3} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function ResultDetailPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const attemptIdNum = attemptId ? Number(attemptId) : NaN;

  const {
    data: response,
    error,
    isError,
    isPending,
    refetch,
  } = useQuery({
    queryKey: qk.resultDetail(attemptIdNum),
    queryFn: () => api.get<ResultDetailResponse>(`/results/attempt/${attemptIdNum}`),
    enabled: Number.isFinite(attemptIdNum),
    staleTime: 30_000,
  });

  const result = response?.result ?? null;

  // ---- States: loading / error / empty ----
  if (isPending) {
    return (
      <Page title="Result" description="Loading your result…">
        <DetailSkeleton />
      </Page>
    );
  }

  if (isError) {
    return (
      <Page title="Result" description="Could not load this result.">
        <ErrorState
          title="Could not load this result"
          error={error instanceof ApiError ? error.message : error}
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  if (!result) {
    return (
      <Page title="Result" description="No result found.">
        <EmptyState
          icon={AlertCircle}
          title="No result found"
          description="This attempt does not have a released result."
          action={
            <Button asChild variant="secondary" size="sm">
              <Link to="/results">
                <ArrowLeft />
                All results
              </Link>
            </Button>
          }
        />
      </Page>
    );
  }

  const answered = result.per_question.filter((q) => q.answered).length;
  const scorePct = result.max_score ? Math.round((result.score / result.max_score) * 100) : 0;
  const isPassed = scorePct >= 60;
  const keyReleased = result.answer_key_released === 1;
  const resultReleased = result.released === 1;

  return (
    <Page
      title={result.quiz_title}
      description={
        <span className="text-sm text-muted-foreground">
          {result.course_code} · {result.course_name} · v{result.version} · submitted{' '}
          {formatDateTime(result.submitted_at)}
        </span>
      }
      actions={
        <Badge variant={isPassed ? 'success' : 'warning'} className="text-sm font-medium">
          {result.score}/{result.max_score} · {scorePct}%
        </Badge>
      }
      width="wide"
    >
      <div className="space-y-8">
        {/* Score ring / progress */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
              <div className="text-center sm:text-left">
                <p className="text-sm font-medium text-muted-foreground">Your score</p>
                <p className="font-display text-3xl font-bold text-foreground">
                  {result.score} / {result.max_score}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {scorePct}% · {isPassed ? 'Passed' : 'Not passed'}
                </p>
              </div>
              <div className="w-full max-w-xs">
                <Progress
                  value={scorePct}
                  className="h-3"
                  aria-label={`Score ${scorePct}%`}
                  indicatorClassName={isPassed ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stat summary */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="stat-card">
              <div>
                <div className="stat-value">
                  {answered}
                  <span className="text-muted-foreground"> / {result.per_question.length}</span>
                </div>
                <div className="text-sm text-muted-foreground">Questions answered</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="stat-card">
              <KeyRound className="stat-icon" aria-hidden="true" />
              <div>
                <div className="stat-value">{keyReleased ? 'Released' : 'Withheld'}</div>
                <div className="text-sm text-muted-foreground">Answer key</div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="stat-card">
              <AlertCircle className="stat-icon" aria-hidden="true" />
              <div>
                <div className="stat-value">{resultReleased ? 'Released' : 'Withheld'}</div>
                <div className="text-sm text-muted-foreground">Result</div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Answer key not released banner */}
        {!keyReleased && (
          <div
            className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--primary)]/30 bg-[var(--primary)]/5 px-4 py-3 text-sm"
            role="status"
            aria-live="polite"
          >
            <HelpCircle className="mt-0.5 size-5 text-[var(--primary)]" aria-hidden="true" />
            <p>
              The instructor has not released the answer key for this quiz. You can see your own
              answers and the points earned per question, but correct answers are hidden until
              release.
            </p>
          </div>
        )}

        {/* Per-question breakdown */}
        <div className="space-y-4">
          <h2 className="font-display text-xl font-semibold text-foreground">Question breakdown</h2>
          {result.per_question.map((q, i) => {
            const status = questionStatus(q);
            const Icon = status.icon;
            return (
              <Card key={q.question_id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="font-display text-xl font-bold text-[var(--primary)]">
                        Q{i + 1}
                      </span>
                      <Badge variant="secondary">{q.qtype}</Badge>
                      <span className="text-sm text-muted-foreground">{q.points} pt</span>
                    </div>
                    <Badge
                      variant={
                        status.tone === 'success'
                          ? 'success'
                          : status.tone === 'destructive'
                            ? 'destructive'
                            : status.tone === 'warning'
                              ? 'warning'
                              : 'secondary'
                      }
                      className="flex items-center gap-1.5"
                    >
                      <Icon aria-hidden="true" />
                      <span>{q.earned} / {q.points} pt</span>
                      <span className="sr-only">{status.label}</span>
                    </Badge>
                  </div>
                  <CardTitle className="mt-2">
                    <RichText content={q.text} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Your answer
                      </p>
                      <p className="mt-1 font-mono text-sm break-words">
                        {prettyAnswer(q.qtype, q.your_answer)}
                      </p>
                    </div>
                    {keyReleased && q.correct_answer != null && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Correct answer
                        </p>
                        <p className="mt-1 font-mono text-sm break-words">
                          {prettyAnswer(q.qtype, q.correct_answer)}
                        </p>
                      </div>
                    )}
                  </div>
                  {q.options.length > 0 && (
                    <ol className="flex flex-col gap-1.5">
                      {q.options.map((o, optIdx) => (
                        <li
                          key={optIdx}
                          className="flex items-baseline gap-3 text-sm text-muted-foreground"
                        >
                          <span
                            className="font-mono font-semibold text-foreground"
                            aria-hidden="true"
                          >
                            {String.fromCharCode(65 + optIdx)}
                          </span>
                          <RichText content={o} />
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Back action */}
        <div>
          <Button asChild variant="secondary">
            <Link to="/results">
              <ArrowLeft />
              All results
            </Link>
          </Button>
        </div>
      </div>
    </Page>
  );
}
