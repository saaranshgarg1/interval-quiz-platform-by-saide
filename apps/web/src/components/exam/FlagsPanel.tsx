import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, Flag, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { FlagLevel, FlagReport, FlagSeverity } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { EmptyState, LoadingSkeleton } from '../primitives';
import { toast } from '../ui/sonner';

export const LEVEL_TEXT: Record<FlagLevel, string> = {
  none: 'No flags',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function FlagLevelBadge({ level, score }: { level: FlagLevel; score?: number }) {
  if (level === 'none') return <span className="text-muted-foreground">—</span>;
  const variant = level === 'high' ? 'destructive' : level === 'medium' ? 'warning' : 'secondary';
  return (
    <Badge variant={variant} title={score !== undefined ? `Flag score ${score}` : undefined}>
      <Flag aria-hidden="true" />
      {LEVEL_TEXT[level]}
    </Badge>
  );
}

function local(ts: string): string {
  return new Date(`${ts.replace(' ', 'T')}Z`).toLocaleString();
}

export function flagReportKey(quizId: number) {
  return ['proctor', quizId, 'flags'] as const;
}

/** Everyone with a sign of unauthorized activity, most serious first. */
export function FlagsPanel({
  quizId,
  isInstructor,
  paused,
  onTimeline,
  onRaise,
}: {
  quizId: number;
  isInstructor: boolean;
  paused: boolean;
  onTimeline: (attemptId: number) => void;
  onRaise: (target: { attemptId: number; name: string }) => void;
}) {
  const qc = useQueryClient();
  const [resolving, setResolving] = useState<{ id: number; name: string } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: flagReportKey(quizId),
    queryFn: () => api.get<FlagReport>(`/proctor/quiz/${quizId}/flags`),
    refetchInterval: paused ? false : 10_000,
  });

  if (isLoading || !data) return <LoadingSkeleton rows={4} variant="list" />;
  if (data.candidates.length === 0) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="No flagged candidates"
        description="Tab or window switches, leaving full screen, blocked copy/paste, network changes and staff flags show up here."
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A flag is a prompt to look closer, not proof: browser signals have innocent explanations. Review the timeline
        before deciding anything.
      </p>
      {data.candidates.map((c) => (
        <Card key={c.attempt_id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{c.name}</span>
                  <FlagLevelBadge level={c.level} score={c.flag_score} />
                  <Badge variant="outline">{c.status.replace('_', ' ')}</Badge>
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {c.entry_number ?? c.email}
                  {c.last_ip && ` · ${c.start_ip ?? '?'}${c.last_ip !== c.start_ip ? ` → ${c.last_ip}` : ''}`}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => onTimeline(c.attempt_id)}>
                  <Eye aria-hidden="true" /> Timeline
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onRaise({ attemptId: c.attempt_id, name: c.name })}>
                  <Flag aria-hidden="true" /> Flag
                </Button>
              </div>
            </div>
            {Object.keys(c.signals).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(c.signals)
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, n]) => (
                    <Badge key={kind} variant="secondary">
                      {data.signal_labels[kind] ?? kind}: {n}
                    </Badge>
                  ))}
              </div>
            )}
            {c.manual_flags.length > 0 && (
              <ul className="space-y-1.5 text-sm">
                {c.manual_flags.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-start justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2">
                    <div className="min-w-0">
                      <span className="mr-2 font-medium capitalize">{f.severity}</span>
                      <span className="text-foreground/90">{f.reason}</span>
                      <div className="text-xs text-muted-foreground">
                        {f.created_by_name ?? 'Staff'} · {local(f.created_at)}
                        {f.resolved_at && (
                          <>
                            {' '}
                            · resolved by {f.resolved_by_name ?? 'staff'}: “{f.resolution}”
                          </>
                        )}
                      </div>
                    </div>
                    {f.resolved_at ? (
                      <Badge variant="success">
                        <CheckCircle2 aria-hidden="true" /> Resolved
                      </Badge>
                    ) : (
                      isInstructor && (
                        <Button size="sm" variant="ghost" onClick={() => setResolving({ id: f.id, name: c.name })}>
                          Resolve
                        </Button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
      <ResolveDialog
        target={resolving}
        onClose={() => setResolving(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['proctor', quizId] })}
      />
    </div>
  );
}

export function RaiseFlagDialog({
  target,
  onClose,
  onDone,
}: {
  target: { attemptId: number; name: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [severity, setSeverity] = useState<FlagSeverity>('medium');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (target) {
      setSeverity('medium');
      setReason('');
    }
  }, [target]);
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/proctor/attempt/${target.attemptId}/flags`, { severity, reason });
      toast.success(`Flag recorded for ${target.name}.`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the flag.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag {target?.name}</DialogTitle>
          <DialogDescription>
            Record something you observed (in the hall, in the answers). Flags are visible to course staff only and do not
            change the attempt by themselves.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2" role="radiogroup" aria-label="Severity">
            {(['low', 'medium', 'high'] as const).map((s) => (
              <Button key={s} type="button" size="sm" variant={severity === s ? 'default' : 'secondary'} onClick={() => setSeverity(s)}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </Button>
            ))}
          </div>
          <div>
            <Label htmlFor="flag-reason">What did you observe?</Label>
            <Textarea
              id="flag-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Phone on the desk at 10:42; asked to put it away."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !reason.trim()} onClick={() => void submit()}>
            <Flag aria-hidden="true" /> Record flag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({
  target,
  onClose,
  onDone,
}: {
  target: { id: number; name: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setResolution(''), [target]);
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/proctor/flags/${target.id}/resolve`, { resolution });
      toast.success('Flag resolved.');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not resolve.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve flag — {target?.name}</DialogTitle>
          <DialogDescription>Record the outcome; it stays in the audit trail.</DialogDescription>
        </DialogHeader>
        <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="e.g. Checked — permitted calculator." aria-label="Resolution" />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !resolution.trim()} onClick={() => void submit()}>
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
