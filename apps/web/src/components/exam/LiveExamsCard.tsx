import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, CalendarClock, Flag, Lock, Pause, Radio, Wifi } from 'lucide-react';
import { api } from '../../api';
import type { LiveExam, QuizList } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

function local(ts: string | null): string {
  if (!ts) return '';
  return new Date(`${ts.replace(' ', 'T')}Z`).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** Staff: every quiz running right now across all their courses (several can be live at once). */
export function LiveExamsCard() {
  const { data } = useQuery({
    queryKey: ['proctor', 'live'],
    queryFn: () => api.get<{ exams: LiveExam[] }>('/proctor/live'),
    refetchInterval: 15_000,
  });
  const exams = data?.exams ?? [];
  if (exams.length === 0) return null;
  return (
    <Card className="mb-8 border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-5 text-primary" aria-hidden="true" />
          Live now
        </CardTitle>
        <CardDescription>
          Quizzes running or opening soon in your courses. Each runs independently — its own clock, pause and rules.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {exams.map((e) => (
          <div key={e.quiz_id} className="flex flex-col gap-2 rounded-[var(--radius-lg)] border p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-primary">{e.course_code}</p>
                <p className="truncate font-medium text-foreground" title={e.title}>
                  {e.title}
                </p>
              </div>
              {e.state === 'paused' ? (
                <Badge variant="warning">
                  <Pause aria-hidden="true" /> Paused
                </Badge>
              ) : e.state === 'upcoming' ? (
                <Badge variant="outline">
                  <CalendarClock aria-hidden="true" /> Opens {local(e.window_opens_at)}
                </Badge>
              ) : (
                <Badge variant="success">
                  <Radio aria-hidden="true" /> Live
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span>
                <strong className="text-foreground">{e.in_progress}</strong> writing
              </span>
              <span className="inline-flex items-center gap-1">
                <Wifi className="size-3.5" aria-hidden="true" /> {e.online} online
              </span>
              <span>
                {e.finished}/{e.enrolled} done
              </span>
              {e.locked > 0 && (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <Lock className="size-3.5" aria-hidden="true" /> {e.locked} locked
                </span>
              )}
              {e.flagged > 0 && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <Flag className="size-3.5" aria-hidden="true" /> {e.flagged} flagged
                </span>
              )}
            </div>
            {e.window_closes_at && <p className="text-xs text-muted-foreground">Window closes {local(e.window_closes_at)}</p>}
            <Button asChild size="sm" className="mt-auto self-start">
              <Link to={`/quizzes/${e.quiz_id}/monitor`}>Open monitor</Link>
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Students: scheduled quizzes that are open now or coming up, soonest first. */
export function UpcomingExamsCard({ courses }: { courses: { code: string; quizzes: QuizList[] }[] }) {
  const now = Date.now();
  const items = courses
    .flatMap((c) =>
      c.quizzes
        .filter((q) => q.published?.quiz_type === 'scheduled' && q.published.window_opens_at && q.published.window_closes_at)
        .map((q) => ({
          course: c.code,
          quizId: q.quiz_id,
          title: q.published!.title,
          opens: new Date(`${q.published!.window_opens_at!.replace(' ', 'T')}Z`).getTime(),
          closes: new Date(`${q.published!.window_closes_at!.replace(' ', 'T')}Z`).getTime(),
          duration: q.published!.duration_minutes,
          inProgress: q.published!.my_attempts?.in_progress ?? null,
          done: (q.published!.my_attempts?.count ?? 0) >= q.published!.attempts_allowed,
        })),
    )
    .filter((x) => x.closes > now && !x.done)
    .sort((a, b) => a.opens - b.opens);
  if (items.length === 0) return null;
  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-5 text-primary" aria-hidden="true" />
          Exam schedule
        </CardTitle>
        <CardDescription>Scheduled quizzes that are open now or coming up. Times are in your local time zone.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((x) => {
            const open = x.opens <= now;
            return (
              <li key={x.quizId} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    <span className="mr-2 text-xs font-semibold text-primary">{x.course}</span>
                    {x.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtMs(x.opens)} – {fmtMs(x.closes)}
                    {x.duration ? ` · ${x.duration} min` : ''}
                  </p>
                </div>
                {open ? (
                  <Button asChild size="sm">
                    <Link to={`/quizzes/${x.quizId}/preflight`}>{x.inProgress ? 'Continue' : 'Open now'}</Link>
                  </Button>
                ) : (
                  <Badge variant="outline">Opens in {formatIn(x.opens - now)}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function fmtMs(ms: number): string {
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatIn(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
