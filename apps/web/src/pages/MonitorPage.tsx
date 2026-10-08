import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlarmClockPlus,
  ChevronLeft,
  Download,
  Eye,
  KeyRound,
  Lock,
  Megaphone,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Square,
  Unlock,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api, ApiError, downloadFile } from '../api';
import type { Audit, MonitorEvent, MonitorRow, MonitorSnapshot } from '../types';
import { Page, ErrorState, LoadingSkeleton, EmptyState } from '../components/primitives';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { toast } from '../components/ui/sonner';
import { formatMs } from '../components/exam/ExamScreens';
import { ConfirmAction } from '../components/ConfirmAction';
import { FlagLevelBadge, FlagsPanel, RaiseFlagDialog } from '../components/exam/FlagsPanel';

/**
 * Live exam monitor (instructor & TA). Polls a whole-class snapshot every few
 * seconds: who has started, who is online, time left, progress, violations,
 * IP changes. Instructors can extend time (everyone or by entry number),
 * pause/resume, end the quiz, message students and rule on single attempts.
 */

const POLL_MS = 5000;

type Filter = 'all' | 'active' | 'offline' | 'locked' | 'flagged' | 'not_started' | 'finished';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Writing' },
  { key: 'offline', label: 'Offline' },
  { key: 'locked', label: 'Locked' },
  { key: 'flagged', label: 'Flagged' },
  { key: 'not_started', label: 'Not started' },
  { key: 'finished', label: 'Finished' },
];

function matches(row: MonitorRow, filter: Filter): boolean {
  const a = row.attempt;
  switch (filter) {
    case 'active':
      return a?.status === 'in_progress';
    case 'offline':
      return a?.status === 'in_progress' && !a.online;
    case 'locked':
      return a?.status === 'locked' || a?.status === 'under_review';
    case 'flagged':
      return (a?.flag_level ?? 'none') !== 'none';
    case 'not_started':
      return !a;
    case 'finished':
      return a?.status === 'submitted' || a?.status === 'expired';
    default:
      return true;
  }
}

function statusBadge(row: MonitorRow) {
  const a = row.attempt;
  if (!a) return <Badge variant="outline">Not started</Badge>;
  switch (a.status) {
    case 'in_progress':
      return <Badge variant="default">Writing</Badge>;
    case 'submitted':
      return <Badge variant="success">Submitted</Badge>;
    case 'expired':
      return <Badge variant="warning">Timed out</Badge>;
    case 'locked':
    case 'under_review':
      return (
        <Badge variant="destructive">
          <Lock aria-hidden="true" /> Locked
        </Badge>
      );
    default:
      return <Badge variant="secondary">{a.status}</Badge>;
  }
}

function since(ts: string | null, serverNow: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((serverNow - new Date(`${ts.replace(' ', 'T')}Z`).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function local(ts: string | null): string {
  if (!ts) return '—';
  return new Date(`${ts.replace(' ', 'T')}Z`).toLocaleString();
}

type AttemptActionKind =
  | 'lock'
  | 'reinstate'
  | 'force_submit'
  | 'allow_reentry'
  | 'reset_session'
  | 'reset_violations';

const ACTION_TEXT: Record<AttemptActionKind, { title: string; body: string; button: string; destructive?: boolean }> = {
  lock: { title: 'Lock attempt', body: 'The student stops immediately and cannot continue until you reinstate the attempt. Saved answers are kept.', button: 'Lock', destructive: true },
  reinstate: { title: 'Reinstate attempt', body: 'The student can continue. Add minutes for the time lost while locked; if the deadline already passed and you add nothing, the time left at the moment of the lock is restored.', button: 'Reinstate' },
  force_submit: { title: 'Submit for the student', body: 'Grades the attempt from the answers saved so far and ends it. This cannot be undone.', button: 'Submit now', destructive: true },
  allow_reentry: { title: 'Allow re-entry', body: 'Lets the student open the attempt once more — for example after a crashed laptop in a quiz where exit & resume is off.', button: 'Allow' },
  reset_session: { title: 'Disconnect current device', body: 'Cuts off the window the student is using now and lets them continue on another device.', button: 'Disconnect' },
  reset_violations: { title: 'Clear violations', body: 'Sets the violation count back to zero (e.g. after a false alarm). The events stay in the timeline.', button: 'Clear' },
};

export function MonitorPage() {
  const { quizId } = useParams();
  const qid = Number(quizId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [paused, setPausedPolling] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [extendFor, setExtendFor] = useState<{ students: string } | null>(null);
  const [announceFor, setAnnounceFor] = useState<{ students: string } | null>(null);
  const [action, setAction] = useState<{ kind: AttemptActionKind; row: MonitorRow } | null>(null);
  const [timelineFor, setTimelineFor] = useState<number | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [view, setView] = useState<'students' | 'flags'>('students');
  const [flagTarget, setFlagTarget] = useState<{ attemptId: number; name: string } | null>(null);
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const lastEventId = useRef(0);
  const [tick, setTick] = useState(0);

  const snapshotKey = ['proctor', qid] as const;
  const { data, error, isError, isLoading, dataUpdatedAt, refetch } = useQuery({
    queryKey: snapshotKey,
    queryFn: () => api.get<MonitorSnapshot>(`/proctor/quiz/${qid}`),
    enabled: Number.isFinite(qid),
    refetchInterval: paused ? false : POLL_MS,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  // Activity feed: only new events since the last poll.
  useEffect(() => {
    if (!Number.isFinite(qid) || paused) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await api.get<{ events: MonitorEvent[] }>(`/proctor/quiz/${qid}/events?after=${lastEventId.current}&limit=200`);
        if (!stop && res.events.length) {
          lastEventId.current = Math.max(lastEventId.current, ...res.events.map((e) => e.id));
          setEvents((prev) => [...res.events, ...prev].slice(0, 300));
        }
      } catch {
        /* the snapshot shows connection errors */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [qid, paused]);

  // Local 1 s tick so time-left counts down between polls.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.students ?? []).filter(
      (r) =>
        matches(r, filter) &&
        (!term ||
          r.name.toLowerCase().includes(term) ||
          r.email.toLowerCase().includes(term) ||
          (r.entry_number ?? '').toLowerCase().includes(term)),
    );
  }, [data, filter, search]);

  if (!Number.isFinite(qid)) return <ErrorState error="Invalid quiz." />;
  if (isLoading) {
    return (
      <Page title="Live monitor" width="full">
        <LoadingSkeleton rows={6} variant="list" />
      </Page>
    );
  }
  if (isError || !data) {
    return (
      <Page title="Live monitor" width="full">
        <ErrorState title="Could not load the monitor" error={error} onRetry={() => void refetch()} />
      </Page>
    );
  }

  const { quiz, summary } = data;
  const isInstructor = data.viewer_role === 'instructor';
  const elapsed = paused ? 0 : Math.max(0, (Date.now() - dataUpdatedAt) / 1000);
  void tick;
  const serverNow = new Date(`${data.server_now.replace(' ', 'T')}Z`).getTime() + elapsed * 1000;
  const live = !quiz.closed_at;
  const invalidate = () => qc.invalidateQueries({ queryKey: snapshotKey });

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast.success(label);
      await invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    }
  };

  const selectedIdentifiers = () =>
    (data.students.filter((s) => selected.has(s.user_id)).map((s) => s.entry_number ?? s.email)).join(', ');

  const toggleAll = () => {
    if (rows.every((r) => selected.has(r.user_id))) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.user_id)));
  };

  return (
    <Page
      width="full"
      title={quiz.title}
      description={
        <span className="flex flex-wrap items-center gap-2">
          {quiz.closed_at ? (
            <Badge variant="destructive">Ended {local(quiz.closed_at)}</Badge>
          ) : quiz.paused_at ? (
            <Badge variant="warning">
              <Pause aria-hidden="true" /> Paused since {local(quiz.paused_at)}
            </Badge>
          ) : (
            <Badge variant="success">
              <Activity aria-hidden="true" /> Live
            </Badge>
          )}
          <span>v{quiz.version}</span>
          {quiz.duration_minutes && <span>· {quiz.duration_minutes} min</span>}
          {quiz.window_closes_at && <span>· window closes {local(quiz.window_closes_at)}</span>}
          {quiz.extra_seconds_all > 0 && <span>· +{Math.round(quiz.extra_seconds_all / 60)} min for everyone</span>}
          <span className="text-xs">· updated {since(data.server_now, serverNow)}</span>
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to={`/courses/${quiz.course_id}`}>
              <ChevronLeft aria-hidden="true" /> Course
            </Link>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setPausedPolling((p) => !p)}>
            <RefreshCw aria-hidden="true" className={paused ? '' : 'animate-[spin_3s_linear_infinite]'} />
            {paused ? 'Resume updates' : 'Pause updates'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAnnounceFor({ students: '' })} disabled={!live}>
            <Megaphone aria-hidden="true" /> Announce
          </Button>
          {isInstructor && (
            <>
              <Button size="sm" onClick={() => setExtendFor({ students: '' })} disabled={!live}>
                <AlarmClockPlus aria-hidden="true" /> Extend time
              </Button>
              {live &&
                (quiz.paused_at ? (
                  <Button variant="secondary" size="sm" onClick={() => void run('Quiz resumed — clocks moved on by the pause.', () => api.post(`/proctor/quiz/${qid}/resume`))}>
                    <Play aria-hidden="true" /> Resume quiz
                  </Button>
                ) : (
                  <ConfirmAction
                    title="Pause the quiz for everyone?"
                    description={`All ${summary.in_progress} student(s) writing now see a pause screen and every timer stops. Nobody loses time: when you resume, each deadline moves on by the length of the pause.`}
                    confirmLabel="Pause quiz"
                    onConfirm={() => void run('Quiz paused — every timer is frozen.', () => api.post(`/proctor/quiz/${qid}/pause`))}
                  >
                    <Button variant="secondary" size="sm">
                      <Pause aria-hidden="true" /> Pause quiz
                    </Button>
                  </ConfirmAction>
                ))}
              {live ? (
                <Button variant="destructive" size="sm" onClick={() => setConfirmEnd(true)}>
                  <Square aria-hidden="true" /> End quiz
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void run('Quiz reopened for new starts.', () => api.post(`/proctor/quiz/${qid}/reopen`))}>
                  Reopen
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void downloadFile(`/results/quiz/${quiz.version_id}/export.csv`, `${quiz.title.replace(/[^\w-]+/g, '_')}-gradebook.csv`).catch(
                    (e) => toast.error(e instanceof Error ? e.message : 'Download failed.'),
                  )
                }
              >
                <Download aria-hidden="true" /> Gradebook CSV
              </Button>
            </>
          )}
        </div>
      }
    >
      {/* ---- summary tiles ---- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Tile label="Enrolled" value={summary.enrolled} onClick={() => setFilter('all')} active={filter === 'all'} />
        <Tile label="Not started" value={summary.not_started} onClick={() => setFilter('not_started')} active={filter === 'not_started'} />
        <Tile label="Writing" value={summary.in_progress} onClick={() => setFilter('active')} active={filter === 'active'} />
        <Tile label="Online now" value={summary.online} tone="success" />
        <Tile label="Offline" value={summary.in_progress - summary.online} tone={summary.in_progress - summary.online ? 'warning' : undefined} onClick={() => setFilter('offline')} active={filter === 'offline'} />
        <Tile label="Locked" value={summary.locked} tone={summary.locked ? 'destructive' : undefined} onClick={() => setFilter('locked')} active={filter === 'locked'} />
        <Tile label="Flagged" value={summary.flagged} tone={summary.flagged ? 'warning' : undefined} onClick={() => setView('flags')} active={view === 'flags'} />
        <Tile label="Finished" value={summary.submitted + summary.expired} onClick={() => setFilter('finished')} active={filter === 'finished'} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- class table / flags ---- */}
        <section aria-label="Students">
          <div className="mb-3 flex gap-1" role="tablist" aria-label="Monitor view">
            <Button role="tab" aria-selected={view === 'students'} size="sm" variant={view === 'students' ? 'default' : 'secondary'} onClick={() => setView('students')}>
              <Users aria-hidden="true" /> Students ({summary.enrolled})
            </Button>
            <Button role="tab" aria-selected={view === 'flags'} size="sm" variant={view === 'flags' ? 'default' : 'secondary'} onClick={() => setView('flags')}>
              <ShieldAlert aria-hidden="true" /> Flagged candidates ({summary.flagged})
            </Button>
          </div>
          {view === 'flags' ? (
            <FlagsPanel
              quizId={qid}
              isInstructor={isInstructor}
              paused={paused}
              onTimeline={(id) => setTimelineFor(id)}
              onRaise={setFlagTarget}
            />
          ) : (
          <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                className="pl-8"
                placeholder="Search by name, email or entry number"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search students"
              />
            </div>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter">
              {FILTERS.map((f) => (
                <Button key={f.key} size="sm" variant={filter === f.key ? 'default' : 'ghost'} onClick={() => setFilter(f.key)}>
                  {f.label}
                </Button>
              ))}
            </div>
          </div>

          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border bg-accent/40 px-3 py-2 text-sm">
              <strong>{selected.size} selected</strong>
              {isInstructor && (
                <Button size="sm" variant="secondary" onClick={() => setExtendFor({ students: selectedIdentifiers() })}>
                  <AlarmClockPlus aria-hidden="true" /> Extend time
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setAnnounceFor({ students: selectedIdentifiers() })}>
                <Megaphone aria-hidden="true" /> Message
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState icon={Users} title="No students match" description="Change the filter or search." />
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-muted text-left text-xs uppercase text-muted-foreground">
                    <th className="px-3 py-2">
                      <input type="checkbox" aria-label="Select all shown" checked={rows.length > 0 && rows.every((r) => selected.has(r.user_id))} onChange={toggleAll} />
                    </th>
                    <th className="px-3 py-2 font-medium">Student</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Connection</th>
                    <th className="px-3 py-2 font-medium">Progress</th>
                    <th className="px-3 py-2 font-medium">Time left</th>
                    <th className="px-3 py-2 font-medium">Flags</th>
                    <th className="px-3 py-2 font-medium">Device</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const a = r.attempt;
                    const left =
                      a?.time_left_seconds != null
                        ? Math.max(0, a.time_left_seconds - (a.status === 'in_progress' && !quiz.paused_at ? elapsed : 0))
                        : null;
                    return (
                      <tr key={r.user_id} className="border-b align-middle last:border-0 hover:bg-accent/30">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.name}`}
                            checked={selected.has(r.user_id)}
                            onChange={() =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.user_id)) next.delete(r.user_id);
                                else next.add(r.user_id);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-foreground">{r.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">{r.entry_number ?? r.email}</div>
                        </td>
                        <td className="px-3 py-2">
                          {statusBadge(r)}
                          {a?.lock_reason && <div className="mt-0.5 text-xs text-muted-foreground">{data.labels.lock[a.lock_reason] ?? a.lock_reason}</div>}
                          {a?.finalize_reason && a.finalize_reason !== 'submitted_by_student' && (
                            <div className="mt-0.5 text-xs text-muted-foreground">{data.labels.finalize[a.finalize_reason] ?? a.finalize_reason}</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {a?.status === 'in_progress' ? (
                            a.online ? (
                              <span className="inline-flex items-center gap-1 text-success">
                                <Wifi className="size-4" aria-hidden="true" /> Online
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-warning" title={`Last seen ${local(a.last_seen_at)}`}>
                                <WifiOff className="size-4" aria-hidden="true" /> {since(a.last_seen_at, serverNow)}
                              </span>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                          {a ? (
                            <>
                              {a.answered}/{a.total_questions} answered
                              {a.score != null && <div className="text-xs text-muted-foreground">Score {a.score}/{a.max_score}</div>}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums">
                          {left != null ? formatMs(left * 1000) : '—'}
                          {a && a.extra_seconds > 0 && <div className="text-xs text-muted-foreground">+{Math.round(a.extra_seconds / 60)} min</div>}
                        </td>
                        <td className="px-3 py-2">
                          {a ? (
                            <div className="space-y-0.5">
                              <FlagLevelBadge level={a.flag_level} score={a.flag_score} />
                              {(a.violation_count > 0 || a.open_flags > 0) && (
                                <div className="text-xs text-muted-foreground">
                                  {a.violation_count} violation(s){a.open_flags ? ` · ${a.open_flags} staff flag(s)` : ''}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {a ? (
                            <>
                              <div className="font-mono">{a.last_ip ?? '—'}</div>
                              {a.ip_changed && <Badge variant="warning">IP changed</Badge>}
                              {a.resume_count > 0 && <div>{a.resume_count} resume(s)</div>}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <RowMenu
                            row={r}
                            isInstructor={isInstructor}
                            onExtend={() => setExtendFor({ students: r.entry_number ?? r.email })}
                            onMessage={() => setAnnounceFor({ students: r.entry_number ?? r.email })}
                            onAction={(kind) => setAction({ kind, row: r })}
                            onTimeline={() => a && setTimelineFor(a.id)}
                            onFlag={() => a && setFlagTarget({ attemptId: a.id, name: r.name })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </>
          )}
        </section>

        {/* ---- side panel ---- */}
        <aside className="space-y-4">
          <Card>
            <CardContent className="space-y-2 p-4">
              <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
                <Activity className="size-4 text-primary" aria-hidden="true" /> Activity
              </h2>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet. Starts, violations, resumes and submissions appear here.</p>
              ) : (
                <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1 text-xs">
                  {events.map((e) => (
                    <li key={e.id} className="border-l-2 border-border pl-2">
                      <button className="text-left hover:underline" onClick={() => setTimelineFor(e.attempt_id)}>
                        <span className="font-medium text-foreground">{e.user_name}</span>{' '}
                        <span className="text-muted-foreground">{e.entry_number ?? ''}</span>
                      </button>
                      <div className={EVENT_TONE[e.kind] ?? 'text-muted-foreground'}>{e.detail ?? e.kind}</div>
                      <div className="text-muted-foreground">{new Date(`${e.recorded_at.replace(' ', 'T')}Z`).toLocaleTimeString()}</div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-2 p-4 text-sm">
              <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
                <ShieldAlert className="size-4 text-primary" aria-hidden="true" /> Rules in force
              </h2>
              {quiz.settings.access_code && (
                <p className="flex items-center gap-2">
                  <KeyRound className="size-4" aria-hidden="true" /> Access code:{' '}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{quiz.settings.access_code}</code>
                </p>
              )}
              <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                {quiz.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <Link className="text-xs text-primary hover:underline" to={`/quizzes/${qid}`}>
                Open quiz settings
              </Link>
            </CardContent>
          </Card>

          {(data.extensions.length > 0 || data.announcements.length > 0) && (
            <Card>
              <CardContent className="space-y-2 p-4 text-xs">
                <h2 className="font-display text-sm font-semibold">History</h2>
                <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                  {data.extensions.map((x) => (
                    <li key={`x${x.id}`}>
                      <strong>{x.kind === 'pause' ? 'Pause' : `+${Math.round(x.seconds / 60)} min`}</strong>{' '}
                      {x.user_id ? `for ${x.user_name} (${x.user_entry_number ?? '—'})` : 'for everyone'}
                      {x.reason && <span className="text-muted-foreground"> — {x.reason}</span>}
                      <div className="text-muted-foreground">{local(x.created_at)}</div>
                    </li>
                  ))}
                  {data.announcements.map((m) => (
                    <li key={`a${m.id}`}>
                      <strong>{m.user_id ? `Message to ${m.user_name}` : 'Announcement'}:</strong> {m.message}
                      <div className="text-muted-foreground">{local(m.created_at)}</div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>

      <ExtendDialog
        quizId={qid}
        open={extendFor !== null}
        initialStudents={extendFor?.students ?? ''}
        onClose={() => setExtendFor(null)}
        onDone={() => void invalidate()}
      />
      <AnnounceDialog
        quizId={qid}
        open={announceFor !== null}
        initialStudents={announceFor?.students ?? ''}
        onClose={() => setAnnounceFor(null)}
        onDone={() => void invalidate()}
      />
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={() => void invalidate()} />
      <TimelineDialog attemptId={timelineFor} onClose={() => setTimelineFor(null)} />
      <RaiseFlagDialog target={flagTarget} onClose={() => setFlagTarget(null)} onDone={() => void qc.invalidateQueries({ queryKey: ['proctor', qid] })} />

      <Dialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End the quiz for everyone?</DialogTitle>
            <DialogDescription>
              Every attempt still in progress ({summary.in_progress}) is submitted now with the answers saved so far, and
              nobody can start. Locked attempts stay locked for your review. You can reopen the quiz for new starts later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmEnd(false);
                void run('Quiz ended — all live attempts submitted.', () => api.post(`/proctor/quiz/${qid}/close`, {}));
              }}
            >
              End quiz now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p className="mt-6 text-xs text-muted-foreground">
        <button className="hover:underline" onClick={() => navigate(-1)}>
          ← Back
        </button>
      </p>
    </Page>
  );
}

const EVENT_TONE: Record<string, string> = {
  tab_hidden: 'text-warning',
  window_blur: 'text-warning',
  fullscreen_exit: 'text-warning',
  locked: 'text-destructive',
  reentry_blocked: 'text-destructive',
  session_takeover: 'text-warning',
  ip_changed: 'text-warning',
  submitted: 'text-success',
};

function Tile({
  label,
  value,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning' | 'destructive';
  onClick?: () => void;
  active?: boolean;
}) {
  const color = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'destructive' ? 'text-destructive' : 'text-foreground';
  const body = (
    <>
      <div className={`font-display text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </>
  );
  return onClick ? (
    <button
      onClick={onClick}
      className={`rounded-[var(--radius-lg)] border bg-card p-3 text-left transition-colors hover:bg-accent/40 ${active ? 'ring-2 ring-primary/50' : ''}`}
    >
      {body}
    </button>
  ) : (
    <div className="rounded-[var(--radius-lg)] border bg-card p-3">{body}</div>
  );
}

function RowMenu({
  row,
  isInstructor,
  onExtend,
  onMessage,
  onAction,
  onTimeline,
  onFlag,
}: {
  row: MonitorRow;
  isInstructor: boolean;
  onExtend: () => void;
  onMessage: () => void;
  onAction: (kind: AttemptActionKind) => void;
  onTimeline: () => void;
  onFlag: () => void;
}) {
  const a = row.attempt;
  const open = a?.status === 'in_progress';
  const locked = a?.status === 'locked' || a?.status === 'under_review';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${row.name}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{row.name}</DropdownMenuLabel>
        {a && (
          <DropdownMenuItem onSelect={onTimeline}>
            <Eye aria-hidden="true" /> Timeline & answers
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onMessage}>
          <Megaphone aria-hidden="true" /> Send a message
        </DropdownMenuItem>
        {a && (
          <DropdownMenuItem onSelect={onFlag}>
            <ShieldAlert aria-hidden="true" /> Flag candidate…
          </DropdownMenuItem>
        )}
        {isInstructor && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onExtend}>
              <AlarmClockPlus aria-hidden="true" /> Extend time
            </DropdownMenuItem>
            {locked && (
              <DropdownMenuItem onSelect={() => onAction('reinstate')}>
                <Unlock aria-hidden="true" /> Reinstate
              </DropdownMenuItem>
            )}
            {open && (
              <DropdownMenuItem onSelect={() => onAction('lock')}>
                <Lock aria-hidden="true" /> Lock now
              </DropdownMenuItem>
            )}
            {open && (
              <DropdownMenuItem onSelect={() => onAction('allow_reentry')}>Allow re-entry</DropdownMenuItem>
            )}
            {open && (
              <DropdownMenuItem onSelect={() => onAction('reset_session')}>Disconnect device</DropdownMenuItem>
            )}
            {a && a.violation_count > 0 && (
              <DropdownMenuItem onSelect={() => onAction('reset_violations')}>Clear violations</DropdownMenuItem>
            )}
            {(open || locked) && (
              <DropdownMenuItem className="text-destructive" onSelect={() => onAction('force_submit')}>
                Submit for student
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExtendDialog({
  quizId,
  open,
  initialStudents,
  onClose,
  onDone,
}: {
  quizId: number;
  open: boolean;
  initialStudents: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [scope, setScope] = useState<'all' | 'students'>('all');
  const [students, setStudents] = useState('');
  const [minutes, setMinutes] = useState('10');
  const [includeNew, setIncludeNew] = useState(true);
  const [reopen, setReopen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStudents(initialStudents);
    setScope(initialStudents ? 'students' : 'all');
    setReopen(false);
    setReason('');
  }, [open, initialStudents]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ extended: number; reopened: number; untimed: number; not_found: string[] }>(
        `/proctor/quiz/${quizId}/extend`,
        { minutes: Number(minutes), scope, students, include_new: includeNew, reopen_expired: reopen, reason },
      );
      toast.success(
        `Added ${minutes} min to ${res.extended} running attempt(s)${res.reopened ? `, reopened ${res.reopened}` : ''}.`,
      );
      if (res.not_found.length) toast.error(`Not found in this course: ${res.not_found.join(', ')}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not extend time.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Extend time</DialogTitle>
          <DialogDescription>
            Running attempts get the extra minutes on their deadline (and current question); a scheduled window closes
            later by the same amount. Students see the new time on their next heartbeat.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2" role="radiogroup" aria-label="Who gets more time">
            <Button type="button" size="sm" variant={scope === 'all' ? 'default' : 'secondary'} onClick={() => setScope('all')}>
              Everyone
            </Button>
            <Button type="button" size="sm" variant={scope === 'students' ? 'default' : 'secondary'} onClick={() => setScope('students')}>
              Specific students
            </Button>
          </div>
          {scope === 'students' && (
            <div>
              <Label htmlFor="extend-students">Entry numbers or emails</Label>
              <Textarea
                id="extend-students"
                rows={3}
                value={students}
                onChange={(e) => setStudents(e.target.value)}
                placeholder="2022CSB1234, 2022CSB1250 (comma, space or one per line)"
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="extend-minutes">Extra minutes</Label>
              <Input id="extend-minutes" type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="extend-reason">Reason (recorded)</Label>
              <Input id="extend-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. power cut in Hall B" />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={includeNew} onChange={(e) => setIncludeNew(e.target.checked)} />
            <span>Also give the extra time to students who have not started yet</span>
          </label>
          {scope === 'students' && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={reopen} onChange={(e) => setReopen(e.target.checked)} />
              <span>Reopen attempts that already ran out of time (not possible once results are released)</span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !Number(minutes) || (scope === 'students' && !students.trim())} onClick={() => void submit()}>
            <AlarmClockPlus aria-hidden="true" /> Add {minutes || 0} min
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AnnounceDialog({
  quizId,
  open,
  initialStudents,
  onClose,
  onDone,
}: {
  quizId: number;
  open: boolean;
  initialStudents: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [message, setMessage] = useState('');
  const [students, setStudents] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setStudents(initialStudents);
      setMessage('');
    }
  }, [open, initialStudents]);
  const send = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ not_found: string[] }>(`/proctor/quiz/${quizId}/announce`, {
        message,
        scope: students.trim() ? 'students' : 'all',
        students,
      });
      toast.success('Sent. Students see it within about 15 seconds.');
      if (res.not_found.length) toast.error(`Not found: ${res.not_found.join(', ')}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{students.trim() ? 'Message students' : 'Announce to everyone'}</DialogTitle>
          <DialogDescription>Shown as a banner and a notification on the students’ quiz screen.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="announce-message">Message</Label>
            <Textarea
              id="announce-message"
              rows={4}
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Q4 has a typo: read “x²” as “x³”."
            />
          </div>
          <div>
            <Label htmlFor="announce-students">Only to (optional: entry numbers or emails)</Label>
            <Input id="announce-students" value={students} onChange={(e) => setStudents(e.target.value)} placeholder="Leave empty to send to everyone" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !message.trim()} onClick={() => void send()}>
            <Megaphone aria-hidden="true" /> Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: { kind: AttemptActionKind; row: MonitorRow } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReason('');
    setMinutes('');
  }, [action]);
  if (!action) return null;
  const text = ACTION_TEXT[action.kind];
  const confirm = async () => {
    if (!action.row.attempt) return;
    setBusy(true);
    try {
      await api.post(`/proctor/attempt/${action.row.attempt.id}/action`, {
        action: action.kind,
        reason,
        minutes: action.kind === 'reinstate' && minutes ? Number(minutes) : undefined,
      });
      toast.success(`${text.title}: done for ${action.row.name}.`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {text.title} — {action.row.name}
          </DialogTitle>
          <DialogDescription>{text.body}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {action.kind === 'reinstate' && (
            <div>
              <Label htmlFor="action-minutes">Extra minutes (optional)</Label>
              <Input id="action-minutes" type="number" min={0} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          )}
          <div>
            <Label htmlFor="action-reason">Reason (kept in the audit trail)</Label>
            <Textarea id="action-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={text.destructive ? 'destructive' : 'default'} disabled={busy} onClick={() => void confirm()}>
            {text.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TimelineDialog({ attemptId, onClose }: { attemptId: number | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['review', 'attempt', attemptId],
    queryFn: () => api.get<Audit>(`/review/attempt/${attemptId}`),
    enabled: attemptId !== null,
  });
  return (
    <Dialog open={attemptId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {data?.student?.name ?? 'Attempt'} {data?.student?.entry_number ? `· ${data.student.entry_number}` : ''}
          </DialogTitle>
          <DialogDescription>
            {data
              ? `Attempt #${data.attempt.id} · ${data.attempt.status} · ${data.attempt.violation_count} violation(s) · ${data.history.length} answer change(s) · ${data.attempt.user_agent ?? ''}`
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <LoadingSkeleton rows={4} variant="text" />
        ) : (
          <ol className="space-y-1.5 text-sm">
            {data.events.map((e) => (
              <li key={e.id} className="grid grid-cols-[80px_1fr] gap-2 border-b pb-1.5 last:border-0">
                <time className="font-mono text-xs text-muted-foreground">
                  {new Date(`${e.recorded_at.replace(' ', 'T')}Z`).toLocaleTimeString()}
                </time>
                <span>
                  <code className="mr-1.5 rounded bg-muted px-1 text-xs">{e.kind}</code>
                  {e.detail}
                </span>
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          {data && (
            <Button asChild variant="secondary" size="sm">
              <Link to={`/incidents/attempt/${data.attempt.id}`}>Open full audit</Link>
            </Button>
          )}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
