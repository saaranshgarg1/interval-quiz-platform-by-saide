import { useMemo, useState } from 'react';
import { Dices, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api';
import type { BankQuestion, Difficulty, QuestionSlot, VersionDetail } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { toast } from './ui/sonner';
import { marksLabel } from '../lib/marks';

const selectClass =
  'mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40';

const LABEL: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

/**
 * "Random question from this bank": every student gets a different question of
 * the chosen difficulty (and tag), all worth the same marks.
 */
export function RandomFromBank({
  quizId,
  bankId,
  bankName,
  questions,
  existingSlots,
  bankPageHref,
  showTimeLimit,
  onAdded,
}: {
  quizId: number;
  bankId: number;
  bankName: string;
  questions: BankQuestion[];
  /** Random slots already in this draft: they use up questions from the pool. */
  existingSlots: QuestionSlot[];
  bankPageHref: string;
  showTimeLimit: boolean;
  onAdded: (version: VersionDetail) => void;
}) {
  const tags = useMemo(() => [...new Set(questions.flatMap((q) => q.tags))].sort(), [questions]);
  const bankSlots = existingSlots.filter((sl) => sl.bank_id === bankId);

  /**
   * Questions still free for new random slots with this filter. Mirrors the
   * server: slots with the same filter each need a different question, and all
   * slots on one bank together can't outnumber its questions.
   */
  const available = (d: '' | Difficulty, t: string) => {
    const pool = questions.filter(
      (q) => (!d || q.difficulty === d) && (!t || q.tags.some((x) => x.toLowerCase() === t.toLowerCase())),
    ).length;
    const sameFilter = bankSlots.filter(
      (sl) => (sl.difficulty ?? '') === d && (sl.tag ?? '').toLowerCase() === t.toLowerCase(),
    ).length;
    return Math.max(0, Math.min(pool - sameFilter, questions.length - bankSlots.length));
  };

  // Open on a choice that actually has questions (medium first, then easy, hard, any).
  const [difficulty, setDifficulty] = useState<'' | Difficulty>(
    () => (['medium', 'easy', 'hard', ''] as const).find((d) => available(d, '') > 0) ?? 'medium',
  );
  const [tag, setTag] = useState('');
  const [count, setCount] = useState('1');
  const [points, setPoints] = useState('1');
  const [negative, setNegative] = useState('0');
  const [timeLimit, setTimeLimit] = useState('');
  const [busy, setBusy] = useState(false);

  const matching = available(difficulty, tag);
  const bankExhausted = available('', '') === 0;
  const someDisabled =
    (['easy', 'medium', 'hard'] as const).some((d) => available(d, tag) === 0) || tags.some((t) => available(difficulty, t) === 0);
  const n = Math.max(1, Number(count) || 1);
  const optionLabel = (label: string, left: number) => `${label} (${left === 0 ? 'none left' : left})`;

  const add = async () => {
    setBusy(true);
    try {
      const version = await api.post<VersionDetail>(`/quizzes/${quizId}/slots`, {
        bank_id: bankId,
        difficulty: difficulty || null,
        tag: tag || null,
        count: n,
        points: Number(points),
        negative_points: negative.trim() === '' ? 0 : Number(negative),
        time_limit_seconds: timeLimit === '' ? null : Number(timeLimit),
      });
      toast.success(`Added ${n} random ${difficulty || 'any-difficulty'} question${n === 1 ? '' : 's'}.`);
      onAdded(version);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add random questions.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-3 p-4">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <Dices className="size-4 text-primary" aria-hidden="true" /> Random questions from this bank
          </h4>
          <p className="text-xs text-muted-foreground">
            Each student gets a different question of the same difficulty and marks, drawn when they start. Questions
            are spread evenly across the class and never repeat on one paper.
          </p>
        </div>
        {bankExhausted ? (
          <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">No questions left to draw from “{bankName}”.</p>
            <p className="mt-1 text-muted-foreground">
              {bankSlots.length > 0
                ? `This quiz already has ${bankSlots.length} random question${bankSlots.length === 1 ? '' : 's'} using all ${questions.length} question${questions.length === 1 ? '' : 's'} in this bank. Each student needs a different question for every random slot.`
                : 'This bank has no questions yet.'}{' '}
              Add more questions to the bank first, or remove a random question from this quiz.
            </p>
            <a href={bankPageHref} className="mt-2 inline-block font-medium text-primary underline underline-offset-2">
              Go to question banks
            </a>
          </div>
        ) : (
        <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="slot-difficulty">Difficulty</Label>
            <select id="slot-difficulty" className={selectClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value as '' | Difficulty)}>
              {(['easy', 'medium', 'hard'] as const).map((d) => {
                const left = available(d, tag);
                return (
                  <option key={d} value={d} disabled={left === 0}>
                    {optionLabel(LABEL[d], left)}
                  </option>
                );
              })}
              <option value="" disabled={available('', tag) === 0}>
                {optionLabel('Any', available('', tag))}
              </option>
            </select>
          </div>
          <div>
            <Label htmlFor="slot-tag">Tag</Label>
            <select id="slot-tag" className={selectClass} value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="" disabled={available(difficulty, '') === 0}>
                Any tag
              </option>
              {tags.map((t) => {
                const left = available(difficulty, t);
                return (
                  <option key={t} value={t} disabled={left === 0}>
                    {optionLabel(t, left)}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <Label htmlFor="slot-points">Marks each</Label>
            <Input id="slot-points" type="number" min={0.25} step={0.25} value={points} onChange={(e) => setPoints(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="slot-negative">Minus if wrong</Label>
            <Input id="slot-negative" type="number" min={0} step={0.25} value={negative} onChange={(e) => setNegative(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="slot-count">How many</Label>
            <Input id="slot-count" type="number" min={1} max={Math.max(1, matching)} value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          {showTimeLimit && (
            <div>
              <Label htmlFor="slot-time">Time limit (s)</Label>
              <Input id="slot-time" type="number" min={5} max={7200} placeholder="Default" value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} />
            </div>
          )}
        </div>
        {someDisabled && (
          <p className="text-xs text-muted-foreground">
            Greyed-out options have no unused questions in this bank
            {bankSlots.length > 0 ? ' (counts already exclude the random questions this quiz uses)' : ''}.{' '}
            <a href={bankPageHref} className="text-primary underline underline-offset-2">
              Add questions to the bank
            </a>{' '}
            to unlock them.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role={n > matching || matching === 0 ? 'alert' : undefined} className={`text-sm ${n > matching || matching === 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            {matching === 0
              ? 'No questions match this difficulty and tag. Pick another combination.'
              : n > matching
                ? `Only ${matching} matching question${matching === 1 ? '' : 's'} available, so you can add at most ${matching} here.`
                : `${matching} matching question${matching === 1 ? '' : 's'} available.`}
          </p>
          <Button size="sm" disabled={busy || matching === 0 || n > matching || !(Number(points) > 0)} onClick={() => void add()}>
            <Dices aria-hidden="true" /> Add {n} random question{n === 1 ? '' : 's'}
          </Button>
        </div>
        </>
        )}
      </CardContent>
    </Card>
  );
}

/** Random slots in the editor's question list (removable while the quiz is a draft). */
export function SlotList({
  slots,
  editable,
  onChanged,
}: {
  slots: QuestionSlot[];
  editable: boolean;
  onChanged?: (version: VersionDetail) => void;
}) {
  if (slots.length === 0) return null;
  const remove = async (slot: QuestionSlot) => {
    try {
      const version = await api.del<VersionDetail>(`/quizzes/slots/${slot.id}`);
      toast.success('Random question removed.');
      onChanged?.(version);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove it.');
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {slots.map((slot) => (
        <Card key={slot.id} className="border-dashed">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong>Q{slot.order_index + 1}</strong>
              <Badge variant="default">
                <Dices aria-hidden="true" /> Random
              </Badge>
              <Badge variant={slot.difficulty === 'hard' ? 'destructive' : slot.difficulty === 'easy' ? 'success' : slot.difficulty ? 'warning' : 'outline'}>
                {slot.difficulty ? LABEL[slot.difficulty] : 'Any difficulty'}
              </Badge>
              {slot.tag && <Badge variant="outline">{slot.tag}</Badge>}
              <span className="text-sm text-muted-foreground">
                {marksLabel(slot.points, slot.negative_points)} · from “{slot.bank_name}” · {slot.pool_size} in pool
                {slot.time_limit_seconds ? ` · ${slot.time_limit_seconds}s` : ''}
              </span>
            </div>
            {editable && (
              <Button size="sm" variant="ghost" onClick={() => void remove(slot)} aria-label={`Remove random question ${slot.order_index + 1}`}>
                <Trash2 aria-hidden="true" /> Remove
              </Button>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
