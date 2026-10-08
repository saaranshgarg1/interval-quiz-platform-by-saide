import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient, useQueries } from '@tanstack/react-query';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  AlertTriangle,
  Clock,
  Eye,
  Lock,
  Radio,
  ShieldAlert,
  User,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { Incident, Audit } from '../types';
import { useCourses, useAudit, qk } from '../lib/queries';
import { toast } from '../components/ui/sonner';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../components/ui/alert-dialog';
import { Skeleton } from '../components/ui/skeleton';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';

/**
 * IncidentsPage — instructor/staff view of flagged/locked/expired attempts.
 *
 * Route contract (unchanged):
 *   /incidents                         — staff-wide incident list
 *   /incidents/attempt/:attemptId      — same page, audit panel pre-opened
 *
 * Data layer: staff courses are fetched once, then incidents are fetched per
 * course in parallel via `useQueries` (keys match `qk.incidents`). Selecting a
 * row opens the audit via `useAudit`. Rulings POST to /review/attempt/:attemptId
 * and invalidate the matching incident + audit queries.
 */

type Decision = 'reinstate' | 'allow_submit' | 'lock';

/** Status → badge variant + icon. Colour is a secondary cue; the label carries meaning. */
function statusBadge(status: string): { variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'; icon: React.ReactNode; label: string } {
  switch (status) {
    case 'locked':
      return { variant: 'destructive', icon: <Lock className="size-3" aria-hidden="true" />, label: 'Locked' };
    case 'under_review':
      return { variant: 'warning', icon: <AlertTriangle className="size-3" aria-hidden="true" />, label: 'Under review' };
    case 'expired':
      return { variant: 'warning', icon: <Clock className="size-3" aria-hidden="true" />, label: 'Timed out' };
    case 'submitted':
      return { variant: 'success', icon: <Clock className="size-3" aria-hidden="true" />, label: 'Submitted' };
    case 'in_progress':
      return { variant: 'default', icon: <Clock className="size-3" aria-hidden="true" />, label: 'Writing' };
    default:
      return { variant: 'secondary', icon: <AlertTriangle className="size-3" aria-hidden="true" />, label: status };
  }
}

const columns: ColumnDef<Incident>[] = [
  {
    accessorKey: 'quiz_title',
    header: 'Quiz',
    cell: ({ row }) => <span className="font-medium text-foreground">{row.getValue('quiz_title')}</span>,
  },
  {
    accessorKey: 'user_name',
    header: 'Student',
    cell: ({ row }) => (
      <span className="inline-flex flex-col">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <User className="size-3" aria-hidden="true" />
          {row.original.user_name}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.entry_number ?? row.original.user_email}</span>
      </span>
    ),
  },
  {
    accessorKey: 'violation_count',
    header: 'Violations',
    cell: ({ row }) =>
      row.original.violation_count > 0 ? (
        <Badge variant="warning" className="inline-flex items-center gap-1">
          <ShieldAlert className="size-3" aria-hidden="true" />
          {row.original.violation_count}
        </Badge>
      ) : (
        <span className="text-muted-foreground">0</span>
      ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => {
      const s = statusBadge(row.getValue('status'));
      return (
        <Badge variant={s.variant} className="inline-flex items-center gap-1">
          {s.icon}
          {s.label}
        </Badge>
      );
    },
  },
  {
    accessorKey: 'started_at',
    header: 'Started',
    cell: ({ row }) => <TimeCell value={row.getValue('started_at')} />,
  },
  {
    accessorKey: 'expires_at',
    header: 'Expires',
    cell: ({ row }) => <TimeCell value={row.getValue('expires_at')} />,
  },
  {
    id: 'actions',
    header: '',
    enableHiding: false,
    cell: ({ row }) => {
      const attemptId = row.original.attempt_id;
      return (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Review attempt ${attemptId}`}
          onClick={() => row.toggleSelected()}
        >
          <Eye className="size-4" aria-hidden="true" />
          Review
        </Button>
      );
    },
  },
];

function TimeCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return <span className="text-muted-foreground">{value}</span>;
  return <time dateTime={d.toISOString()}>{d.toLocaleString()}</time>;
}

export function IncidentsPage() {
  const { attemptId: focusAttemptId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const focusId = focusAttemptId ? Number(focusAttemptId) : null;
  const [selectedId, setSelectedId] = useState<number | null>(focusId);

  // Staff courses → per-course incidents, merged into a single row set.
  const {
    data: coursesData,
    isError: coursesError,
    error: coursesErr,
    isFetching: coursesFetching,
  } = useCourses();
  const staffCourses = useMemo(
    () => (coursesData?.courses ?? []).filter((c) => c.my_role !== 'student'),
    [coursesData],
  );

  // Per-course incident queries as a batch — `useQueries` handles the dynamic
  // list without violating rules of hooks.
  const incidentsQueries = useQueries({
    queries: staffCourses.map((c) => ({
      queryKey: qk.incidents(c.id),
      queryFn: () => api.get<{ incidents: Incident[] }>(`/attempts/course/${c.id}/incidents`),
      enabled: Number.isFinite(c.id),
    })),
  });
  const incidentsError = incidentsQueries.find((q) => q.isError);
  const incidentsFetching = incidentsQueries.some((q) => q.isFetching);

  const rows: Incident[] = useMemo(() => {
    return incidentsQueries.flatMap((q) => q.data?.incidents ?? []);
  }, [incidentsQueries]);

  // Audit for the selected attempt.
  const {
    data: audit,
    isError: auditError,
    error: auditErr,
    isFetching: auditFetching,
  } = useAudit(selectedId ?? 0, { enabled: !!selectedId });

  const isLoading = coursesFetching || incidentsFetching;
  const isError = !!incidentsError || coursesError;
  const error = incidentsError?.error ?? coursesErr;

  const handleSelect = (id: number) => {
    setSelectedId(id);
    navigate(`/incidents/attempt/${id}`, { replace: true });
  };

  const handleDecide = async (attemptId: number, decision: Decision, reason: string | null, minutes: number | null) => {
    try {
      await api.post<unknown>(`/review/attempt/${attemptId}`, { decision, reason, minutes });
      toast.success(`Decision "${decision}" recorded.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.courses() }),
        ...staffCourses.map((c) => queryClient.invalidateQueries({ queryKey: qk.incidents(c.id) })),
        queryClient.invalidateQueries({ queryKey: qk.audit(attemptId) }),
      ]);
      setSelectedId(null);
      navigate('/incidents', { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Decision failed.');
    }
  };

  return (
    <Page
      title="Incidents & review"
      description="Locked attempts and attempts with recorded violations. Review the recorded events and every saved answer change before deciding."
      width="wide"
    >
      <div className="space-y-6">
        {/* Incidents table */}
        <section aria-labelledby="incidents-heading">
          <h2 id="incidents-heading" className="font-display text-lg font-semibold tracking-tight text-foreground">
            Open items
          </h2>

          {isError && (
            <ErrorState
              title="Could not load incidents"
              error={error}
              onRetry={() => {
                void queryClient.invalidateQueries({ queryKey: qk.courses() });
                staffCourses.forEach((c) => queryClient.invalidateQueries({ queryKey: qk.incidents(c.id) }));
              }}
            />
          )}

          {!isError && isLoading && <LoadingSkeleton variant="list" rows={6} />}

          {!isError && !isLoading && rows.length === 0 && (
            <EmptyState
              icon={AlertTriangle}
              title="No incidents right now"
              description="Locked attempts and attempts with recorded violations appear here."
            />
          )}

          {!isError && !isLoading && rows.length > 0 && (
            <IncidentsTable rows={rows} onSelect={handleSelect} selectedId={selectedId} />
          )}
        </section>

        {/* Audit panel — inline when a row is selected, otherwise a guided empty state. */}
        <section aria-labelledby="audit-heading">
          <h2 id="audit-heading" className="font-display text-lg font-semibold tracking-tight text-foreground">
            Audit trail
          </h2>

          {!selectedId && (
            <EmptyState
              icon={Eye}
              title="Select an incident"
              description="Choose a row above to review its events, saved answers, and prior decisions."
            />
          )}

          {selectedId && auditError && (
            <ErrorState
              title="Could not load audit trail"
              error={auditErr}
              onRetry={() => queryClient.invalidateQueries({ queryKey: qk.audit(selectedId) })}
            />
          )}

          {selectedId && !auditError && auditFetching && <AuditSkeleton />}

          {selectedId && !auditError && audit && (
            <AuditPanel audit={audit} onDecide={(d, reason, minutes) => void handleDecide(audit.attempt.id, d, reason, minutes)} />
          )}
        </section>
      </div>
    </Page>
  );
}

/**
 * @tanstack/react-table data table for incidents.
 */
function IncidentsTable({
  rows,
  onSelect,
  selectedId,
}: {
  rows: Incident[];
  onSelect: (id: number) => void;
  selectedId: number | null;
}) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Key rows by attempt id so selecting a row opens that attempt (not the row index).
    getRowId: (r) => String(r.attempt_id),
    enableRowSelection: true,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(selectedId ? { [selectedId]: true } : {}) : updater;
      const id = Number(Object.keys(next)[0]);
      if (id) onSelect(id);
    },
    state: { rowSelection: selectedId ? { [selectedId]: true } : {} },
  });

  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
      <table className="w-full border-collapse text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground"
                >
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows?.length ? (
            table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                data-selected={row.getIsSelected()}
                className="border-b transition-colors data-[selected=true]:bg-accent/40"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 align-top">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-muted-foreground">
                No incidents.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Skeleton mirroring the audit panel layout. */
function AuditSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-20" />
      </div>
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-4 w-3/4" />
      <div className="space-y-2 pt-2">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  );
}

interface AuditPanelProps {
  audit: Audit;
  onDecide: (decision: Decision, reason: string | null, minutes: number | null) => void;
}

function AuditPanel({ audit, onDecide }: AuditPanelProps) {
  const { attempt, student, answers, events, decisions } = audit;
  const canRuling = attempt.status === 'locked' || attempt.status === 'under_review';

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="font-display text-base font-semibold text-foreground">{attempt.quiz_title}</h3>
          <p className="text-sm text-muted-foreground">v{attempt.version}</p>
        </div>
        <Badge variant={statusBadge(attempt.status).variant}>
          {statusBadge(attempt.status).label}
        </Badge>
      </header>

      <p className="text-sm text-muted-foreground">
        Student: <strong className="text-foreground">{student?.name ?? '—'}</strong>
        {student?.email && <span> ({student.email})</span>}
        <br />
        Score: {attempt.score ?? '—'}/{attempt.max_score ?? '—'} · Receipt:{' '}
        <code className="mono">{attempt.receipt ?? '—'}</code>
        <br />
        Started <TimeCell value={attempt.started_at} /> · Expiry <TimeCell value={attempt.expires_at} />
        <br />
        Violations: <strong className="text-foreground">{attempt.violation_count}</strong> · Resumes: {attempt.resume_count} · IP{' '}
        <code className="mono">{attempt.start_ip ?? '—'}</code>
        {attempt.last_ip && attempt.last_ip !== attempt.start_ip ? (
          <>
            {' '}→ <code className="mono">{attempt.last_ip}</code>
          </>
        ) : null}
        {attempt.extra_seconds > 0 ? ` · +${Math.round(attempt.extra_seconds / 60)} min extra` : ''}
        <br />
        Answer changes recorded: {audit.history.length}
        <Link to={`/quizzes/${attempt.quiz_id}/monitor`} className="ml-3 inline-flex items-center gap-1 text-primary hover:underline">
          <Radio className="size-3" aria-hidden="true" /> Live monitor
        </Link>
      </p>

      <section>
        <h4 className="font-display text-sm font-semibold text-foreground">Recorded events ({events.length})</h4>
        {events.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted-foreground">No policy events recorded.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">#</th>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Kind</th>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Time</th>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={e.id} className="border-b">
                    <td className="px-3 py-2">{i + 1}</td>
                    <td className="px-3 py-2 mono"><code>{e.kind}</code></td>
                    <td className="px-3 py-2 text-muted-foreground"><TimeCell value={e.recorded_at} /></td>
                    <td className="px-3 py-2 text-muted-foreground">{e.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h4 className="font-display text-sm font-semibold text-foreground">Saved answers ({answers.length})</h4>
        {answers.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted-foreground">No answers saved yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Q</th>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Answer</th>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Rev</th>
                  <th className="bg-muted px-3 py-2 text-left font-medium uppercase text-muted-foreground">Saved at</th>
                </tr>
              </thead>
              <tbody>
                {answers.map((a) => (
                  <tr key={a.question_id} className="border-b">
                    <td className="px-3 py-2">{a.position + 1}</td>
                    <td className="px-3 py-2 mono"><code>{JSON.stringify(a.answer)}</code></td>
                    <td className="px-3 py-2">{a.revision}</td>
                    <td className="px-3 py-2 text-muted-foreground"><TimeCell value={a.saved_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {decisions.length > 0 && (
        <section>
          <h4 className="font-display text-sm font-semibold text-foreground">Review decisions ({decisions.length})</h4>
          <ul className="mt-2 space-y-1.5 text-sm">
            {decisions.map((d) => (
              <li key={d.id} className="border-l-2 border-accent pl-3">
                <strong className="text-foreground">{d.decision}</strong> — {d.decided_by_name} ({d.decided_by_email}) —{' '}
                <TimeCell value={d.created_at} />
                {d.reason ? <span className="block text-muted-foreground">— "{d.reason}"</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRuling && (
        <RulingActions onDecide={onDecide} />
      )}
    </div>
  );
}

/**
 * Decision buttons. Each destructive/confirm action is wrapped in an AlertDialog
 * so the ruling is intentional. `reinstate` additionally prompts for a reason.
 */
function RulingActions({ onDecide }: { onDecide: (d: Decision, reason: string | null, minutes: number | null) => void }) {
  const [pending, setPending] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('');

  const trigger = (d: Decision) => {
    setPending(d);
    setReason(d === 'reinstate' ? 'Authorized re-entry after review' : '');
    setMinutes('');
  };

  const confirm = () => {
    if (pending) {
      onDecide(pending, reason.trim() || null, pending === 'reinstate' && minutes !== '' ? Number(minutes) : null);
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button variant="default" size="sm" onClick={() => trigger('reinstate')}>
          Reinstate & re-enter
        </Button>
        <Button variant="secondary" size="sm" onClick={() => trigger('allow_submit')}>
          Grade & submit from saved answers
        </Button>
        <Button variant="outline" size="sm" onClick={() => trigger('lock')}>
          Confirm lock
        </Button>
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm decision: {pending ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending === 'reinstate'
                ? 'The student will be allowed to re-enter this attempt. A reason will be recorded in the audit trail.'
                : pending === 'allow_submit'
                  ? 'The attempt will be graded from the saved answers and submitted.'
                  : 'The attempt will remain locked. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            {pending === 'reinstate' && (
              <div>
                <Label htmlFor="ruling-minutes">Extra minutes (optional — for time lost while locked)</Label>
                <Input id="ruling-minutes" type="number" min={0} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
              </div>
            )}
            <div>
              <Label htmlFor="ruling-reason">Reason (recorded in the audit trail)</Label>
              <Textarea id="ruling-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={pending === 'lock' ? 'bg-destructive text-destructive-foreground' : undefined}
              onClick={confirm}
            >
              {pending === 'reinstate' ? 'Reinstate' : pending === 'allow_submit' ? 'Submit' : 'Lock'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
