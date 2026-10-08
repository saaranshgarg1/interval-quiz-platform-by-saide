import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Hand, Megaphone, Pin, X } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { QuestionHealthRow, StaffHand } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { EmptyState, ErrorState, LoadingSkeleton } from '../primitives';
import { toast } from '../ui/sonner';

export const handsKey = (quizId: number) => ['monitor', 'hands', quizId];

export function useHands(quizId: number) {
  return useQuery({
    queryKey: handsKey(quizId),
    queryFn: () => api.get<{ hands: StaffHand[]; open: number }>(`/insights/quiz/${quizId}/hands`),
    refetchInterval: 8_000,
  });
}

const ago = (ts: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(`${ts.replace(' ', 'T')}Z`).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

/** Students' raised hands: reply privately, answer everyone with that question, or close. */
export function HandsPanel({ quizId }: { quizId: number }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useHands(quizId);
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  if (isLoading) return <LoadingSkeleton rows={3} variant="list" />;
  if (isError) return <ErrorState title="Could not load raised hands" error={error} onRetry={() => void refetch()} />;
  if (!data || data.hands.length === 0) {
    return <EmptyState icon={Hand} title="No raised hands" description="Questions students send during the exam appear here." />;
  }

  const answer = async (h: StaffHand, body: { reply?: string; broadcast?: boolean; dismiss?: boolean }) => {
    setBusy(h.id);
    try {
      await api.post(`/insights/hands/${h.id}/answer`, body);
      toast.success(body.dismiss ? 'Closed' : body.broadcast ? 'Sent to everyone with that question' : `Replied to ${h.student_name}`);
      setReplies((r) => ({ ...r, [h.id]: '' }));
      void qc.invalidateQueries({ queryKey: handsKey(quizId) });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the reply.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {data.hands.map((h) => {
        const text = replies[h.id] ?? '';
        return (
          <Card key={h.id} className={h.status === 'open' ? 'border-warning/60' : 'opacity-80'}>
            <CardContent className="space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {h.status === 'open' ? (
                  <Badge variant="warning">
                    <Hand aria-hidden="true" /> waiting
                  </Badge>
                ) : h.status === 'answered' ? (
                  <Badge variant="success">
                    <CheckCircle2 aria-hidden="true" /> answered
                  </Badge>
                ) : (
                  <Badge variant="secondary">closed</Badge>
                )}
                <strong>{h.student_name}</strong>
                {h.student_entry && <span className="font-mono text-muted-foreground">{h.student_entry}</span>}
                {h.question_label && <Badge variant="outline">{h.question_label}</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{ago(h.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm">{h.message}</p>
              {h.status === 'open' ? (
                <>
                  <Textarea
                    rows={2}
                    value={text}
                    onChange={(e) => setReplies((r) => ({ ...r, [h.id]: e.target.value }))}
                    placeholder="Your reply"
                    aria-label={`Reply to ${h.student_name}`}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={!text.trim() || busy === h.id} onClick={() => void answer(h, { reply: text })}>
                      Reply privately
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!text.trim() || busy === h.id}
                      onClick={() => void answer(h, { reply: text, broadcast: true })}
                      title={h.question_label ? 'Pinned to that question for every student who has it' : 'Announced to everyone'}
                    >
                      <Megaphone aria-hidden="true" /> Answer for everyone
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === h.id} onClick={() => void answer(h, { dismiss: true })}>
                      <X aria-hidden="true" /> Close without reply
                    </Button>
                  </div>
                </>
              ) : (
                h.reply && (
                  <p className="text-sm text-muted-foreground">
                    {h.broadcast ? 'To everyone' : 'Reply'}
                    {h.replied_by_name ? ` (${h.replied_by_name})` : ''}: <span className="text-foreground">{h.reply}</span>
                  </p>
                )
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Live question health: questions that look broken while the exam is still
 * running (wrong key, confusing wording), with a one-click clarification
 * pinned to that question for every student who has it.
 */
export function QuestionHealthPanel({ quizId }: { quizId: number }) {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['monitor', 'question-health', quizId],
    queryFn: () => api.get<{ questions: QuestionHealthRow[] }>(`/insights/quiz/${quizId}/question-health`),
    refetchInterval: 20_000,
  });
  const [clarify, setClarify] = useState<QuestionHealthRow | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  if (isLoading) return <LoadingSkeleton rows={4} variant="list" />;
  if (isError) return <ErrorState title="Could not load question health" error={error} onRetry={() => void refetch()} />;
  const rows = data?.questions ?? [];
  if (rows.length === 0) return <EmptyState icon={CheckCircle2} title="No answers yet" description="Question health appears as students answer." />;

  const send = async () => {
    if (!clarify) return;
    setBusy(true);
    try {
      await api.post(`/proctor/quiz/${quizId}/announce`, { message, question_id: clarify.question_id, scope: 'all' });
      toast.success(`Clarification pinned to ${clarify.label}`);
      setClarify(null);
      setMessage('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Refreshes every 20 s · updated {new Date(dataUpdatedAt).toLocaleTimeString()} · correctness uses the current key
      </p>
      <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 font-medium">Question</th>
              <th className="px-3 py-2 font-medium">Answered</th>
              <th className="px-3 py-2 font-medium">Correct so far</th>
              <th className="px-3 py-2 font-medium">Hands</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q.question_id} className={`border-t align-top ${q.warnings.length ? 'bg-warning/5' : ''}`}>
                <td className="px-3 py-2">
                  <span className="font-mono font-medium">{q.label}</span>{' '}
                  <span className="text-muted-foreground">{q.qtype}</span>
                  <span className="block max-w-md truncate text-muted-foreground" title={q.text}>
                    {q.text}
                  </span>
                  {q.warnings.map((w) => (
                    <span key={w} className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {w}
                    </span>
                  ))}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">
                  {q.answered}/{q.dealt}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">
                  {q.correct_rate === null ? (q.qtype === 'descriptive' ? 'marked later' : '—') : `${Math.round(q.correct_rate * 100)}%`}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">{q.hands || '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant={q.warnings.length ? 'default' : 'ghost'} onClick={() => setClarify(q)}>
                    <Pin aria-hidden="true" /> Clarify
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={clarify !== null} onOpenChange={(o) => !o && setClarify(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clarify {clarify?.label}</DialogTitle>
            <DialogDescription>
              Pinned above the question for every student who has it, and shown as an announcement. Fix the key itself
              after the exam with Regrade.
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. In option C, read “O(n log n)”." autoFocus />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setClarify(null)}>
              Cancel
            </Button>
            <Button disabled={busy || !message.trim()} onClick={() => void send()}>
              <Megaphone aria-hidden="true" /> Send clarification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
