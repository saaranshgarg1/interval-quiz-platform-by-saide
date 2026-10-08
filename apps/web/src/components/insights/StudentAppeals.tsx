import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gavel } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { Appeal } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { toast } from '../ui/sonner';

const STATUS = {
  open: { text: 'Waiting for your instructor', variant: 'warning' },
  accepted: { text: 'Accepted', variant: 'success' },
  rejected: { text: 'Not accepted', variant: 'secondary' },
} as const;

export const appealsKey = (attemptId: number) => ['appeals', attemptId];

export function useMyAppeals(attemptId: number) {
  return useQuery({
    queryKey: appealsKey(attemptId),
    queryFn: () => api.get<{ appeals: Appeal[] }>(`/insights/attempt/${attemptId}/appeals`),
    enabled: Number.isFinite(attemptId),
  });
}

/** Dialog for filing an appeal about one question's mark, or about an integrity decision. */
export function AppealDialog({
  attemptId,
  target,
  onClose,
}: {
  attemptId: number;
  target: { kind: 'grading' | 'integrity'; questionId?: number; label?: string } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/insights/attempt/${attemptId}/appeals`, {
        kind: target.kind,
        question_id: target.questionId ?? null,
        message,
      });
      toast.success('Appeal sent', { description: 'You will see the decision on this page.' });
      setMessage('');
      void qc.invalidateQueries({ queryKey: appealsKey(attemptId) });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the appeal.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {target.kind === 'grading' ? `Appeal the mark for ${target.label ?? 'this question'}` : 'Appeal an integrity decision'}
          </DialogTitle>
          <DialogDescription>
            {target.kind === 'grading'
              ? 'Explain why you think your answer deserves more marks (for example, another option is also correct, or your assumption was reasonable).'
              : 'Explain what happened (for example, a power cut or a browser problem). Your instructor sees your attempt timeline alongside this.'}
          </DialogDescription>
        </DialogHeader>
        <Textarea rows={5} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus aria-label="Your appeal" />
        <p className="text-right text-xs text-muted-foreground">{message.trim().length < 10 ? 'At least 10 characters' : `${message.length}/2000`}</p>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || message.trim().length < 10} onClick={() => void send()}>
            Send appeal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The student's appeals on this attempt and how each was decided. */
export function MyAppealsCard({ attemptId, labels }: { attemptId: number; labels: Record<number, string> }) {
  const { data } = useMyAppeals(attemptId);
  const appeals = data?.appeals ?? [];
  if (appeals.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gavel className="size-5 text-primary" aria-hidden="true" /> Your appeals
        </CardTitle>
        <CardDescription>Decisions from your instructor appear here.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {appeals.map((a) => (
          <div key={a.id} className="rounded-[var(--radius-md)] border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS[a.status].variant}>{STATUS[a.status].text}</Badge>
              <span className="text-muted-foreground">
                {a.kind === 'grading' ? `Mark${a.question_id && labels[a.question_id] ? ` · ${labels[a.question_id]}` : ''}` : 'Integrity'}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{a.message}</p>
            {a.response && (
              <p className="mt-1 text-muted-foreground">
                Reply: <span className="text-foreground">{a.response}</span>
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
