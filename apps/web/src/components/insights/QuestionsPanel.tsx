import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, ListChecks, Scale, Wand2 } from 'lucide-react';
import { api, ApiError } from '../../api';
import type { Difficulty, QuestionReview, QuestionStat } from '../../types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { RichText } from '../RichText';
import { EmptyState, ErrorState, LoadingSkeleton } from '../primitives';
import { toast } from '../ui/sonner';
import { DifficultyBadge, DIFFICULTY_TEXT, Distribution, pct } from './shared';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** What the numbers suggest is wrong with a question, in words. */
function concerns(q: QuestionStat, minSample: number): string[] {
  const out: string[] = [];
  const n = q.dealt - q.pending;
  if (n < minSample || q.grading_mode !== 'normal') return out;
  if (q.qtype !== 'descriptive' && (q.mean_fraction ?? 1) <= 0.15) {
    out.push('Almost nobody got this right — check the answer key and the wording.');
  }
  if (q.discrimination !== null && q.discrimination < 0) {
    out.push('Stronger students did worse on this than weaker ones — the key may be wrong or the question ambiguous.');
  }
  const top = q.distribution.filter((d) => !d.correct).sort((a, b) => b.count - a.count)[0];
  const right = q.distribution.filter((d) => d.correct).reduce((s, d) => s + d.count, 0);
  if (top && top.count > right && top.count >= 3) {
    out.push(`More students chose “${top.answer}” than the key — is it also defensible?`);
  }
  return out;
}

/**
 * Item analysis for a published version, with the two follow-ups an
 * instructor actually takes: regrade a question that turned out broken, and
 * re-rate a bank question whose real difficulty differs from its tag.
 */
export function QuestionsPanel({ versionId, onChanged }: { versionId: number; onChanged: () => void }) {
  const qc = useQueryClient();
  const key = ['insights', 'questions', versionId];
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<QuestionReview>(`/insights/version/${versionId}/questions`),
  });
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [regrading, setRegrading] = useState<QuestionStat | null>(null);

  if (isLoading) return <LoadingSkeleton rows={5} variant="list" />;
  if (isError) return <ErrorState title="Could not load question analysis" error={error} onRetry={() => void refetch()} />;
  if (!data || data.questions.length === 0) {
    return <EmptyState icon={ListChecks} title="No questions yet" description="Question analysis appears once students submit." />;
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['insights'] });
    onChanged();
  };

  const applyDifficulty = async (q: QuestionStat, difficulty: Difficulty) => {
    if (!q.bank_id || !q.bank_question_id) return;
    try {
      await api.patch(`/banks/${q.bank_id}/questions/${q.bank_question_id}`, { difficulty });
      toast.success(`Bank question re-rated as ${DIFFICULTY_TEXT[difficulty].toLowerCase()}.`, {
        description: 'Future random draws use the new rating. Papers already drawn are unchanged.',
      });
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the rating.');
    }
  };

  const suggestions = data.questions.filter((q) => q.suggested_difficulty);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Based on {data.graded_attempts} submitted paper(s). Difficulty is what the results say: easy when at least 75% of
        the marks were earned, hard below 40%. Needs {data.min_sample}+ students per question.
      </p>

      {suggestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wand2 className="size-5 text-primary" aria-hidden="true" /> Suggested difficulty changes
            </CardTitle>
            <CardDescription>
              These bank questions played differently from how they are rated. Re-rating keeps future random draws fair.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {suggestions.map((q) => (
              <div key={q.question_id} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-sm">
                <span className="font-mono">{q.label}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={q.text}>
                  {q.text}
                </span>
                <span>
                  rated <DifficultyBadge value={q.bank_difficulty} />, students scored {pct(q.mean_fraction)} → plays{' '}
                  <DifficultyBadge value={q.suggested_difficulty} />
                </span>
                <Button size="sm" variant="secondary" onClick={() => void applyDifficulty(q, q.suggested_difficulty as Difficulty)}>
                  Re-rate as {DIFFICULTY_TEXT[q.suggested_difficulty as Difficulty].toLowerCase()}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 font-medium">Question</th>
              <th className="px-3 py-2 font-medium">Students</th>
              <th className="px-3 py-2 font-medium">Avg. marks</th>
              <th className="px-3 py-2 font-medium" title="Discrimination: top 27% minus bottom 27% by total score">
                Discrim.
              </th>
              <th className="px-3 py-2 font-medium">Plays as</th>
              <th className="px-3 py-2 font-medium">Grading</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.questions.map((q) => {
              const issues = concerns(q, data.min_sample);
              const expanded = open[q.question_id];
              return (
                <QuestionRow
                  key={q.question_id}
                  q={q}
                  issues={issues}
                  expanded={Boolean(expanded)}
                  onToggle={() => setOpen((o) => ({ ...o, [q.question_id]: !o[q.question_id] }))}
                  onRegrade={() => setRegrading(q)}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <RegradeDialog q={regrading} onClose={() => setRegrading(null)} onDone={refresh} />
    </div>
  );
}

function QuestionRow({
  q,
  issues,
  expanded,
  onToggle,
  onRegrade,
}: {
  q: QuestionStat;
  issues: string[];
  expanded: boolean;
  onToggle: () => void;
  onRegrade: () => void;
}) {
  return (
    <>
      <tr className="border-t align-top">
        <td className="px-3 py-2">
          <button type="button" onClick={onToggle} className="flex items-start gap-1 text-left" aria-expanded={expanded}>
            {expanded ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <span>
              <span className="font-mono font-medium">{q.label}</span>{' '}
              <span className="text-muted-foreground">
                {q.qtype} · {q.points} pt
              </span>
              <span className="block max-w-[22rem] truncate text-muted-foreground" title={q.text}>
                {q.text}
              </span>
            </span>
          </button>
          {issues.map((w) => (
            <p key={w} className="mt-1 flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {w}
            </p>
          ))}
        </td>
        <td className="px-3 py-2 font-mono tabular-nums">
          {q.dealt}
          {q.pending > 0 && <span className="block text-xs text-warning">{q.pending} unmarked</span>}
        </td>
        <td className="px-3 py-2 font-mono tabular-nums">{pct(q.mean_fraction)}</td>
        <td className="px-3 py-2 font-mono tabular-nums">{q.discrimination === null ? '—' : q.discrimination.toFixed(2)}</td>
        <td className="px-3 py-2">
          <DifficultyBadge value={q.observed_difficulty} />
          {q.bank_difficulty && <span className="block text-xs text-muted-foreground">bank: {DIFFICULTY_TEXT[q.bank_difficulty]}</span>}
        </td>
        <td className="px-3 py-2">
          {q.grading_mode === 'dropped' ? (
            <Badge variant="warning">dropped</Badge>
          ) : q.grading_mode === 'full_marks' ? (
            <Badge variant="warning">full marks for all</Badge>
          ) : q.accept_also_text.length ? (
            <Badge variant="secondary">+{q.accept_also_text.length} accepted</Badge>
          ) : (
            <span className="text-muted-foreground">normal</span>
          )}
          {q.bonus > 0 && <span className="block text-xs text-muted-foreground">+{q.bonus} fairness bonus</span>}
        </td>
        <td className="px-3 py-2 text-right">
          <Button size="sm" variant="secondary" onClick={onRegrade} className="whitespace-nowrap">
            <Scale aria-hidden="true" /> Regrade
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/20">
          <td colSpan={7} className="px-6 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <RichText content={q.text} />
                <p className="mt-2 text-sm">
                  <span className="text-muted-foreground">{q.qtype === 'descriptive' ? 'Marking guide: ' : 'Key: '}</span>
                  {q.answer_text || '—'}
                  {q.accept_also_text.length > 0 && (
                    <span className="text-muted-foreground"> · also accepted: {q.accept_also_text.join(', ')}</span>
                  )}
                </p>
              </div>
              {q.qtype !== 'descriptive' && <Distribution rows={q.distribution} total={q.dealt - q.pending} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

type Choice = 'rekey' | 'accept' | 'full_marks' | 'dropped' | 'restore';

function RegradeDialog({ q, onClose, onDone }: { q: QuestionStat | null; onClose: () => void; onDone: () => void }) {
  const [choice, setChoice] = useState<Choice>('accept');
  const [single, setSingle] = useState(0);
  const [multi, setMulti] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [tolerance, setTolerance] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset whenever a different question is opened.
  const [forId, setForId] = useState<number | null>(null);
  if (q && q.question_id !== forId) {
    setForId(q.question_id);
    setChoice(q.qtype === 'descriptive' ? 'full_marks' : 'accept');
    setSingle(Number(q.answer) || 0);
    setMulti(Array.isArray(q.answer) ? (q.answer as number[]) : []);
    setText(q.qtype === 'numeric' || q.qtype === 'short' ? String(q.answer ?? '') : '');
    setTolerance(q.tolerance === null ? '' : String(q.tolerance));
  }
  if (!q) return null;
  const choiceQ = q.qtype === 'single' || q.qtype === 'multiple';

  const answerValue = (): unknown => {
    if (q.qtype === 'single') return single;
    if (q.qtype === 'multiple') return [...multi].sort((a, b) => a - b);
    if (q.qtype === 'numeric') return Number(text);
    return text;
  };

  const submit = async () => {
    const body: Record<string, unknown> = {};
    if (choice === 'rekey') {
      body.answer = answerValue();
      if (q.qtype === 'numeric' && tolerance !== '') body.tolerance = Number(tolerance);
      body.mode = 'normal';
    } else if (choice === 'accept') {
      body.accept_also = [...q.accept_also, answerValue()];
      body.mode = 'normal';
    } else if (choice === 'restore') {
      body.mode = 'normal';
      if (q.qtype !== 'descriptive') body.accept_also = [];
    } else {
      body.mode = choice;
    }
    setBusy(true);
    try {
      const res = await api.post<{ regraded: number; changed: number }>(`/insights/questions/${q.question_id}/regrade`, body);
      toast.success(`${q.label} regraded`, {
        description: `${res.regraded} paper(s) recalculated — ${res.changed} score(s) changed.`,
      });
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Regrade failed.');
    } finally {
      setBusy(false);
    }
  };

  const options: { value: Choice; label: string; hint: string; hidden?: boolean }[] = [
    { value: 'accept', label: 'Also accept another answer', hint: 'Keep the key and give credit for one more answer.', hidden: q.qtype === 'descriptive' },
    { value: 'rekey', label: 'Change the answer key', hint: 'The key was wrong: replace it.', hidden: q.qtype === 'descriptive' },
    { value: 'full_marks', label: 'Full marks for everyone', hint: 'The question was broken; nobody should lose marks on it.' },
    { value: 'dropped', label: 'Drop the question', hint: 'Remove it from every paper; totals shrink by its points.' },
    {
      value: 'restore',
      label: 'Undo regrade',
      hint: 'Back to normal grading with the current key (removes accepted extras).',
      hidden: q.grading_mode === 'normal' && q.accept_also.length === 0,
    },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Regrade {q.label}</DialogTitle>
          <DialogDescription>
            Every submitted paper with this question is recalculated straight away. Released results update too, and the
            change is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {options
            .filter((o) => !o.hidden)
            .map((o) => (
              <label key={o.value} className={`flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border px-3 py-2 text-sm ${choice === o.value ? 'border-primary bg-primary/5' : ''}`}>
                <input type="radio" name="regrade" checked={choice === o.value} onChange={() => setChoice(o.value)} style={{ width: 'auto', marginTop: 3 }} />
                <span>
                  <span className="font-medium">{o.label}</span>
                  <span className="block text-muted-foreground">{o.hint}</span>
                </span>
              </label>
            ))}
        </div>
        {(choice === 'rekey' || choice === 'accept') && (
          <div className="space-y-2 rounded-[var(--radius-md)] bg-muted/40 p-3">
            <p className="text-sm font-medium">{choice === 'rekey' ? 'New key' : 'Answer to accept as well'}</p>
            {choiceQ &&
              q.options.map((o, i) => (
                <label key={i} className="flex items-center gap-2 text-sm">
                  <input
                    type={q.qtype === 'single' ? 'radio' : 'checkbox'}
                    name="regrade-answer"
                    style={{ width: 'auto' }}
                    checked={q.qtype === 'single' ? single === i : multi.includes(i)}
                    onChange={() =>
                      q.qtype === 'single' ? setSingle(i) : setMulti((m) => (m.includes(i) ? m.filter((x) => x !== i) : [...m, i]))
                    }
                  />
                  <span className="font-mono">{LETTERS[i]}.</span> <RichText content={o} />
                </label>
              ))}
            {(q.qtype === 'numeric' || q.qtype === 'short') && (
              <Input
                type={q.qtype === 'numeric' ? 'number' : 'text'}
                step="any"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label="Answer"
              />
            )}
            {q.qtype === 'numeric' && choice === 'rekey' && (
              <Input type="number" step="any" min={0} value={tolerance} onChange={(e) => setTolerance(e.target.value)} placeholder="Tolerance (±)" aria-label="Tolerance" />
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Regrade all papers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

