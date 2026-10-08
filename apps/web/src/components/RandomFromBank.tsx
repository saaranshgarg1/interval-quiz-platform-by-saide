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
  questions,
  showTimeLimit,
  onAdded,
}: {
  quizId: number;
  bankId: number;
  questions: BankQuestion[];
  showTimeLimit: boolean;
  onAdded: (version: VersionDetail) => void;
}) {
  const [difficulty, setDifficulty] = useState<'' | Difficulty>('medium');
  const [tag, setTag] = useState('');
  const [count, setCount] = useState('1');
  const [points, setPoints] = useState('1');
  const [timeLimit, setTimeLimit] = useState('');
  const [busy, setBusy] = useState(false);

  const tags = useMemo(() => [...new Set(questions.flatMap((q) => q.tags))].sort(), [questions]);
  const countBy = (d: Difficulty) => questions.filter((q) => (q.difficulty ?? 'medium') === d).length;
  const matching = questions.filter(
    (q) =>
      (!difficulty || (q.difficulty ?? 'medium') === difficulty) &&
      (!tag || q.tags.some((t) => t.toLowerCase() === tag.toLowerCase())),
  ).length;
  const n = Math.max(1, Number(count) || 1);

  const add = async () => {
    setBusy(true);
    try {
      const version = await api.post<VersionDetail>(`/quizzes/${quizId}/slots`, {
        bank_id: bankId,
        difficulty: difficulty || null,
        tag: tag || null,
        count: n,
        points: Number(points),
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="slot-difficulty">Difficulty</Label>
            <select id="slot-difficulty" className={selectClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value as '' | Difficulty)}>
              <option value="easy">Easy ({countBy('easy')})</option>
              <option value="medium">Medium ({countBy('medium')})</option>
              <option value="hard">Hard ({countBy('hard')})</option>
              <option value="">Any ({questions.length})</option>
            </select>
          </div>
          <div>
            <Label htmlFor="slot-tag">Tag</Label>
            <select id="slot-tag" className={selectClass} value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="slot-points">Marks each</Label>
            <Input id="slot-points" type="number" min={0.25} step={0.25} value={points} onChange={(e) => setPoints(e.target.value)} />
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-sm ${n > matching ? 'text-destructive' : 'text-muted-foreground'}`}>
            {matching} matching question{matching === 1 ? '' : 's'} in the pool
            {n > matching ? ` — not enough for ${n} different questions per student.` : '.'}
          </p>
          <Button size="sm" disabled={busy || matching === 0 || n > matching || !(Number(points) > 0)} onClick={() => void add()}>
            <Dices aria-hidden="true" /> Add {n} random question{n === 1 ? '' : 's'}
          </Button>
        </div>
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
                {slot.points} pt · from “{slot.bank_name}” · {slot.pool_size} in pool
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
