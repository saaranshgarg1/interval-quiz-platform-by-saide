import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  BarChart3,
  ClipboardList,
  Download,
  ArrowLeft,
  ChevronsUpDown,
  CheckCircle,
  Clock,
  Lock,
  AlertCircle,
} from 'lucide-react';
import { useAnalytics } from '../lib/queries';
import type { QuestionAnalyticsItem, SubmissionItem, ScoreBucket } from '../types';
import { formatDateTime, statusLabel } from '../components/ui';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';

/* ── helpers ──────────────────────────────────────────────────────────── */

function safeNumber(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/** Discrimination index rating + tinted warning badge for low items. */
function discriminationBadge(d: number): { label: string; variant: 'default' | 'secondary' | 'warning' | 'destructive' } {
  if (d >= 0.4) return { label: 'Excellent', variant: 'default' };
  if (d >= 0.2) return { label: 'Good', variant: 'secondary' };
  if (d >= 0.1) return { label: 'Low', variant: 'warning' };
  return { label: 'Poor', variant: 'destructive' };
}

/** Accuracy rate rating for color-free text + tinted badge. */
function accuracyBadge(a: number): { label: string; variant: 'default' | 'secondary' | 'warning' | 'destructive' } {
  const pct = Math.round(a * 100);
  if (pct >= 70) return { label: 'High', variant: 'default' };
  if (pct >= 40) return { label: 'Moderate', variant: 'secondary' };
  return { label: 'Low', variant: 'warning' };
}

/* ── stat cards ───────────────────────────────────────────────────────── */

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'primary' | 'muted';
}

function StatCard({ icon, label, value, sub, tone = 'default' }: StatCardProps) {
  const toneClasses = {
    default: 'text-foreground',
    primary: 'text-primary',
    muted: 'text-muted-foreground',
  };
  return (
    <Card>
      <CardContent className="stat-card">
        <span className="stat-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="flex-1 truncate">
          <div className="muted small">{label}</div>
          <div className={`stat-value ${toneClasses[tone]}`}>{value}</div>
          {sub && <div className="muted small">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── score distribution chart (div/SVG bars, teal tokens) ────────────── */

function ScoreDistribution({ buckets }: { buckets: ScoreBucket[] }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Score distribution</CardTitle>
        <CardDescription>
          Histogram of submitted scores grouped into ranges.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No score data"
            description="Score buckets will appear once submissions are recorded."
          />
        ) : (
          <div className="relative mt-4 flex items-end justify-between gap-3 pb-2" role="img" aria-label="Score distribution histogram">
            {buckets.map((bucket, idx) => {
              const heightPct = Math.round((bucket.count / max) * 100);
              const barHeight = Math.max(heightPct, 6);
              return (
                <div key={idx} className="flex flex-col items-center gap-1.5">
                  <span
                    className="text-xs font-semibold text-muted-foreground"
                    aria-label={`${bucket.count} submissions`}
                  >
                    {bucket.count}
                  </span>
                  <div
                    className="w-8 rounded-t-[var(--radius-sm)] transition-[height] duration-300 ease-out"
                    style={{
                      height: `${barHeight}%`,
                      minHeight: '24px',
                      backgroundColor: bucket.count > 0 ? 'var(--primary)' : 'var(--muted)',
                    }}
                    aria-hidden="true"
                  />
                  <span className="text-[0.65rem] text-muted-foreground">{bucket.range}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ── per-question analytics table ────────────────────────────────────── */

const questionColumns: ColumnDef<QuestionAnalyticsItem>[] = [
  {
    accessorKey: 'order_index',
    header: '#',
    cell: ({ getValue }) => <span className="font-mono text-muted-foreground">{(getValue() as number) + 1}</span>,
    enableSorting: false,
    size: 40,
  },
  {
    accessorKey: 'text',
    header: 'Question',
    cell: ({ getValue }) => {
      const text = getValue() as string;
      return <span className="block max-w-xs truncate" title={text}>{text}</span>;
    },
  },
  {
    accessorKey: 'qtype',
    header: 'Type',
    cell: ({ getValue }) => {
      const qtype = getValue() as string;
      return <Badge variant="secondary">{qtype.toUpperCase()}</Badge>;
    },
    size: 90,
  },
  {
    accessorKey: 'points',
    header: 'Points',
    size: 70,
  },
  {
    accessorKey: 'accuracy_rate',
    header: 'Accuracy',
    cell: ({ getValue }) => {
      const rate = getValue() as number;
      const pct = Math.round(rate * 100);
      const badge = accuracyBadge(rate);
      return (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 rounded bg-muted overflow-hidden">
            <div
              className="h-full rounded"
              style={{
                width: `${pct}%`,
                backgroundColor: pct >= 70 ? 'var(--success)' : pct >= 40 ? 'var(--warning)' : 'var(--destructive)',
              }}
              aria-hidden="true"
            />
          </div>
          <Badge variant={badge.variant}>{pct}%</Badge>
        </div>
      );
    },
    size: 120,
  },
  {
    accessorKey: 'discrimination_index',
    header: 'Discrimination',
    cell: ({ getValue }) => {
      const d = getValue() as number;
      const badge = discriminationBadge(d);
      return (
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{d.toFixed(2)}</span>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
      );
    },
    size: 140,
  },
];

/* ── submissions table (react-table, sortable) ───────────────────────── */

const submissionColumns: ColumnDef<SubmissionItem>[] = [
  {
    accessorKey: 'user_name',
    header: 'Student',
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div>
          <div className="font-medium">{s.user_name}</div>
          <div className="text-sm text-muted-foreground">{s.user_email}</div>
        </div>
      );
    },
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ getValue }) => {
      const status = getValue() as string;
      const sl = statusLabel(status);
      const iconMap: Record<string, React.ReactNode> = {
        submitted: <CheckCircle className="size-3" />,
        in_progress: <Clock className="size-3" />,
        locked: <Lock className="size-3" />,
        under_review: <AlertCircle className="size-3" />,
      };
      return (
        <Badge
          variant={
            sl.tone === 'ok'
              ? 'success'
              : sl.tone === 'warn'
                ? 'warning'
                : sl.tone === 'danger'
                  ? 'destructive'
                  : 'secondary'
          }
        >
          {iconMap[status] ?? null}
          {sl.label}
        </Badge>
      );
    },
    size: 130,
  },
  {
    accessorKey: 'score',
    header: 'Score',
    cell: ({ row }) => {
      const s = row.original;
      return s.score !== null ? (
        <span className="font-medium">
          {s.score} / {s.max_score}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
    size: 100,
  },
  {
    accessorKey: 'submitted_at',
    header: 'Submitted',
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      return <span className="text-sm text-muted-foreground">{formatDateTime(v)}</span>;
    },
    size: 140,
  },
  {
    accessorKey: 'receipt',
    header: 'Receipt',
    cell: ({ getValue }) => {
      const r = getValue() as string | null;
      return r ? <code className="text-xs">{r}</code> : <span className="text-muted-foreground">—</span>;
    },
    size: 120,
  },
  {
    id: 'action',
    header: '',
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original;
      const isReview = s.status === 'locked' || s.status === 'under_review';
      return (
        <Button asChild variant="secondary" size="sm">
          <Link to={isReview ? `/incidents/attempt/${s.attempt_id}` : `/results/attempt/${s.attempt_id}`}>
            {isReview ? 'Review incident' : 'View result'}
          </Link>
        </Button>
      );
    },
    size: 130,
  },
];

/* ── main page ───────────────────────────────────────────────────────── */

export const AnalyticsPage: React.FC = () => {
  const { versionId } = useParams<{ versionId: string }>();
  const vId = safeNumber(versionId);
  const navigate = useNavigate();

  const { data: analytics, error, isError, isLoading, refetch } = useAnalytics(vId, {
    staleTime: 30_000,
  });

  // ── CSV export (local, no shared deps) ──────────────────────────────
  const exportSubmissionsCsv = () => {
    if (!analytics?.submissions?.length) return;
    const headers = ['Attempt ID', 'Student Name', 'Student Email', 'Status', 'Score', 'Max Score', 'Started At', 'Submitted At', 'Receipt'];
    const rows = analytics.submissions.map((s) => [
      s.attempt_id,
      `"${s.user_name.replace(/"/g, '""')}"`,
      s.user_email,
      s.status,
      s.score ?? '',
      s.max_score ?? '',
      s.started_at,
      s.submitted_at ?? '',
      s.receipt ?? '',
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${analytics.title.replace(/\s+/g, '_')}_submissions.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── loading ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <Page
        title="Quiz analytics"
        description="Student submissions, item psychometrics, and score distribution."
        actions={
          <Button variant="secondary" size="sm" disabled>
            <ArrowLeft className="size-4" />
            Back
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="stat-card">
                <Skeleton className="stat-icon" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-6 w-1/2" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="p-5">
              <Skeleton className="h-6 w-1/3 mb-4" />
              <div className="flex items-end gap-2 h-40">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="w-8 flex-1" />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardContent className="p-5">
              <Skeleton className="h-6 w-1/4 mb-4" />
              <LoadingSkeleton rows={5} variant="list" />
            </CardContent>
          </Card>
        </div>
      </Page>
    );
  }

  // ── error ────────────────────────────────────────────────────────────
  if (isError) {
    return (
      <Page
        title="Quiz analytics"
        description="Student submissions, item psychometrics, and score distribution."
      >
        <ErrorState
          title="Could not load quiz analytics"
          error={error}
          onRetry={() => refetch()}
        />
      </Page>
    );
  }

  // ── empty / not found ────────────────────────────────────────────────
  if (!analytics) {
    return (
      <Page
        title="Quiz analytics"
        description="Student submissions, item psychometrics, and score distribution."
      >
        <EmptyState
          icon={ClipboardList}
          title="Analytics not found"
          description="No analytics are available for this quiz version."
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="size-4" />
              Go back
            </Button>
          }
        />
      </Page>
    );
  }

  // ── submissions table ────────────────────────────────────────────────
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'submitted_at', desc: true },
  ]);
  const table = useReactTable({
    data: analytics.submissions ?? [],
    columns: submissionColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableMultiSort: false,
  });

  // ── question analytics table ─────────────────────────────────────────
  const questionTable = useReactTable({
    data: analytics.question_analytics ?? [],
    columns: questionColumns,
    getCoreRowModel: getCoreRowModel(),
    enableSorting: false,
  });

  return (
    <Page
      title={`Quiz analytics: ${analytics.title}`}
      description="Student submissions, item psychometrics, and score distribution."
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={exportSubmissionsCsv}
            disabled={!analytics.submissions?.length}
          >
            <Download className="size-4" />
            Export CSV
          </Button>
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
        </div>
      }
      width="wide"
    >
      {/* ── Summary stat cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<ClipboardList className="size-6" />}
          label="Total attempts"
          value={analytics.total_attempts}
          sub={`${analytics.submitted_count} submitted · ${analytics.locked_count} locked`}
        />
        <StatCard
          icon={<BarChart3 className="size-6" />}
          label="Mean score"
          value={`${analytics.mean_score} / ${analytics.max_score}`}
          sub={analytics.max_score > 0 ? `${Math.round((analytics.mean_score / analytics.max_score) * 100)}% mean performance` : undefined}
          tone="primary"
        />
        <StatCard
          icon={<BarChart3 className="size-6" />}
          label="Median score"
          value={analytics.median_score}
          sub="50th percentile"
        />
        <StatCard
          icon={<BarChart3 className="size-6" />}
          label="Score range"
          value={`${analytics.lowest_score} – ${analytics.highest_score}`}
          sub="Lowest to highest achieved"
        />
      </div>

      {/* ── Score distribution ── */}
      <Card className="mt-6">
        <ScoreDistribution buckets={analytics.score_buckets} />
      </Card>

      {/* ── Per-question analytics ── */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Question item analysis</CardTitle>
          <CardDescription>
            Per-question accuracy and discrimination index. Low-discrimination items are flagged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.question_analytics?.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No question data"
              description="Question analytics will appear once students have attempted this quiz."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  {questionTable.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((h) => (
                        <th key={h.id} style={{ width: h.getSize() }}>
                          {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {questionTable.getRowModel().rows?.length ? (
                    questionTable.getRowModel().rows.map((row) => (
                      <tr key={row.id}>
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={questionColumns.length} className="text-center text-muted-foreground">
                        No question analytics available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Submissions table ── */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Student submissions</CardTitle>
          <CardDescription>
            {analytics.submissions?.length ?? 0} submission{analytics.submissions?.length !== 1 ? 's' : ''} recorded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analytics.submissions?.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No submissions yet"
              description="No student attempts have been recorded for this quiz version."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((h) => (
                        <th key={h.id}>
                          {h.isPlaceholder ? null : (
                            <button
                              className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
                              onClick={h.column.getToggleSortingHandler()}
                              aria-label={`Sort by ${h.column.id}`}
                            >
                              {flexRender(h.column.columnDef.header, h.getContext())}
                              <ChevronsUpDown className="size-3" aria-hidden="true" />
                            </button>
                          )}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map((row) => (
                      <tr key={row.id}>
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={submissionColumns.length} className="text-center text-muted-foreground">
                        No submissions.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  );
};
