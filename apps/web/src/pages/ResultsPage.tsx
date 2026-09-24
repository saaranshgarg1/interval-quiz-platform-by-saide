import { Link } from 'react-router-dom';
import { ArrowRight, ClipboardList, Award, TrendingUp } from 'lucide-react';
import type { ResultRow } from '../types';
import { formatDateTime } from '../components/ui';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '@/components/primitives';
import { useMyResults } from '@/lib/queries';

function pct(score: number, max: number): number {
  if (!max) return 0;
  return Math.round((score / max) * 100);
}

function scoreVariant(p: number): 'success' | 'warning' | 'destructive' {
  if (p >= 75) return 'success';
  if (p >= 50) return 'warning';
  return 'destructive';
}

export function ResultsPage() {
  const { data, isPending, isError, error, refetch } = useMyResults();
  const released: ResultRow[] = data?.results ?? [];

  const avg =
    released.length > 0
      ? Math.round(released.reduce((sum, r) => sum + pct(r.score, r.max_score), 0) / released.length)
      : 0;
  const best = released.length > 0 ? Math.max(...released.map((r) => pct(r.score, r.max_score))) : 0;

  return (
    <Page
      title="My results"
      description="Results appear once your instructor releases them (or immediately for practice quizzes configured that way)."
    >
      {isPending ? (
        <LoadingSkeleton rows={4} variant="list" />
      ) : isError ? (
        <ErrorState title="Could not load results" error={error} onRetry={() => void refetch()} />
      ) : released.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No results released yet"
          description="Once an instructor releases a graded quiz, your breakdown shows up here."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard icon={ClipboardList} value={String(released.length)} label="Released results" />
            <StatCard icon={TrendingUp} value={`${avg}%`} label="Average score" />
            <StatCard icon={Award} value={`${best}%`} label="Personal best" />
          </div>

          <div className="space-y-3">
            {released.map((r) => {
              const p = pct(r.score, r.max_score);
              return (
                <Card key={r.id}>
                  <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="font-display font-semibold text-foreground">{r.course_code}</span>
                        <span className="truncate text-sm text-muted-foreground">{r.course_name}</span>
                      </div>
                      <div className="text-sm text-foreground">
                        {r.quiz_title} <span className="text-muted-foreground">v{r.version}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <Progress value={p} aria-label={`Score ${p} percent`} className="max-w-xs" />
                        <Badge variant={scoreVariant(p)}>
                          {r.score}/{r.max_score} · {p}%
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Submitted {formatDateTime(r.submitted_at)} · Released {formatDateTime(r.released_at)}
                      </div>
                    </div>
                    <Button asChild variant="secondary" size="sm">
                      <Link to={`/results/attempt/${r.attempt_id}`}>
                        View breakdown <ArrowRight />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </Page>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof ClipboardList;
  value: string;
  label: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div>
          <div className="font-display text-2xl font-bold tracking-tight text-foreground">{value}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}
