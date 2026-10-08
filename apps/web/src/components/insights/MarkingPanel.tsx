import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, EyeOff, Lightbulb, PenLine } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { GradingQueue, GradingQueueItem } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { RichText } from '../RichText';
import { EmptyState, ErrorState, LoadingSkeleton } from '../primitives';
import { toast } from '../ui/sonner';

/**
 * Hand-marking: every written (descriptive) answer, plus every answer that came
 * with an assumption. Marks go out of the points set when the quiz was made;
 * students see their score once every written answer of theirs is marked.
 */
export function MarkingPanel({ versionId, onChanged }: { versionId: number; onChanged: () => void }) {
  const qc = useQueryClient();
  const key = ['insights', 'grading', versionId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<GradingQueue>(`/insights/version/${versionId}/grading`),
  });
  const [questionId, setQuestionId] = useState<number | null>(null);
  const [filter, setFilter] = useState<'todo' | 'all'>('todo');
  const [anonymous, setAnonymous] = useState(true);

  useEffect(() => {
    if (data && questionId === null && data.questions.length) {
      setQuestionId((data.questions.find((q) => q.needs_marks > 0) ?? data.questions[0])?.question_id ?? null);
    }
  }, [data, questionId]);

  const question = data?.questions.find((q) => q.question_id === questionId) ?? null;
  const items = useMemo(
    () =>
      (data?.items ?? [])
        .filter((i) => i.question_id === questionId)
        .filter((i) => filter === 'all' || i.marks === null),
    [data, questionId, filter],
  );

  if (isLoading) return <LoadingSkeleton rows={4} variant="list" />;
  if (isError) return <ErrorState title="Could not load the marking queue" error={error} onRetry={() => void refetch()} />;
  if (!data || data.questions.length === 0) {
    return (
      <EmptyState
        icon={PenLine}
        title="Nothing to mark"
        description="Written (descriptive) answers and answers with assumptions appear here after students submit."
      />
    );
  }

  const saved = () => {
    void qc.invalidateQueries({ queryKey: key });
    onChanged();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>
            {data.pending > 0 ? `${data.pending} written answer(s) still need marks.` : 'Everything is marked.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {data.questions.map((q) => (
            <button
              key={q.question_id}
              type="button"
              onClick={() => setQuestionId(q.question_id)}
              aria-pressed={q.question_id === questionId}
              className={`flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left text-sm ${
                q.question_id === questionId ? 'bg-primary/10 font-medium' : 'hover:bg-muted'
              }`}
            >
              <span className="min-w-0">
                <span className="font-mono">{q.label}</span>{' '}
                <span className="text-muted-foreground">{q.qtype === 'descriptive' ? 'written' : 'assumptions'}</span>
              </span>
              {q.needs_marks > 0 ? (
                <Badge variant="warning">{q.needs_marks} to mark</Badge>
              ) : (
                <Badge variant="success">
                  <CheckCircle2 aria-hidden="true" /> {q.marked}/{q.total}
                </Badge>
              )}
            </button>
          ))}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {question && (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="font-mono">{question.label}</CardTitle>
                <Badge variant="secondary">out of {question.points}</Badge>
                {question.allow_assumptions && <Badge variant="outline">assumptions allowed</Badge>}
              </div>
              <div className="mt-2">
                <RichText content={question.text} />
              </div>
            </CardHeader>
            {question.model_answer && (
              <CardContent>
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {question.qtype === 'descriptive' ? 'Marking guide' : 'Answer key'}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{question.model_answer}</p>
              </CardContent>
            )}
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={filter === 'todo' ? 'default' : 'ghost'} onClick={() => setFilter('todo')}>
            Not marked yet
          </Button>
          <Button size="sm" variant={filter === 'all' ? 'default' : 'ghost'} onClick={() => setFilter('all')}>
            All answers
          </Button>
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} style={{ width: 'auto' }} />
            <EyeOff className="size-4" aria-hidden="true" /> Hide names while marking
          </label>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={filter === 'todo' ? 'All marked for this question' : 'No answers'}
            description={filter === 'todo' ? 'Switch to “All answers” to review or change marks.' : undefined}
          />
        ) : (
          items.map((item, i) => (
            <AnswerCard
              key={`${item.attempt_id}:${item.question_id}`}
              item={item}
              index={i}
              points={question?.points ?? 1}
              anonymous={anonymous}
              onSaved={saved}
            />
          ))
        )}
      </div>
    </div>
  );
}

function AnswerCard({
  item,
  index,
  points,
  anonymous,
  onSaved,
}: {
  item: GradingQueueItem;
  index: number;
  points: number;
  anonymous: boolean;
  onSaved: () => void;
}) {
  const [marks, setMarks] = useState(item.marks === null ? '' : String(item.marks));
  const [feedback, setFeedback] = useState(item.feedback);
  const [busy, setBusy] = useState(false);

  const save = async (clear = false) => {
    const value = clear ? null : marks === '' ? null : Number(marks);
    if (!clear && (value === null || !Number.isFinite(value) || value < 0 || value > points)) {
      toast.error(`Enter marks between 0 and ${points}.`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.put<{ score: number | null; max_score: number | null; pending: number }>(
        `/insights/attempt/${item.attempt_id}/question/${item.question_id}/marks`,
        { marks: value, feedback },
      );
      toast.success(clear ? 'Marks cleared' : 'Marks saved', {
        description:
          res.pending > 0
            ? `Paper total ${res.score}/${res.max_score} — ${res.pending} more written answer(s) to mark on this paper.`
            : `Paper total now ${res.score}/${res.max_score}.`,
      });
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the marks.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <strong>{anonymous ? `Answer ${index + 1}` : item.student.name}</strong>
          {!anonymous && item.student.entry_number && (
            <span className="font-mono text-muted-foreground">{item.student.entry_number}</span>
          )}
          {item.marks !== null && (
            <Badge variant="success">
              {item.marks}/{points}
              {item.graded_by_name ? ` by ${item.graded_by_name}` : ''}
            </Badge>
          )}
          {item.reason === 'assumption' && item.auto_marks !== null && (
            <Badge variant="secondary">auto-graded {item.auto_marks}/{points}</Badge>
          )}
        </div>
        <div className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-muted/40 px-3 py-2 text-sm">{item.answer_text}</div>
        {item.assumption && (
          <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-dashed px-3 py-2 text-sm">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              <strong>Assumed: </strong>
              {item.assumption}
            </span>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor={`m-${item.attempt_id}-${item.question_id}`}>
              Marks (0–{points})
            </label>
            <Input
              id={`m-${item.attempt_id}-${item.question_id}`}
              type="number"
              min={0}
              max={points}
              step={0.25}
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor={`f-${item.attempt_id}-${item.question_id}`}>
              Feedback for the student (optional)
            </label>
            <Textarea
              id={`f-${item.attempt_id}-${item.question_id}`}
              rows={2}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            Save marks
          </Button>
          {item.marks !== null && (
            <Button size="sm" variant="ghost" onClick={() => void save(true)} disabled={busy}>
              {item.reason === 'assumption' ? 'Use the automatic mark' : 'Clear marks'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
