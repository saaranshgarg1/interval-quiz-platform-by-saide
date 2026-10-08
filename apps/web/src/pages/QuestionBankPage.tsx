import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Plus,
  Trash2,
  Search,
  Filter,
  ChevronLeft,
  HelpCircle,
  ListPlus,
} from 'lucide-react';
import { api } from '@/api';
import { qk, useBanks, useBank } from '@/lib/queries';
import type { QuestionBank, BankQuestion, QuestionType, Difficulty } from '@/types';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { RichText } from '@/components/RichText';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';

// ─── Schemas ───────────────────────────────────────────────────────────────

const newBankSchema = z.object({
  name: z.string().min(1, 'Bank name is required').max(200),
  description: z.string().max(1000).optional(),
});

const questionBase = {
  text: z.string().min(1, 'Question text is required'),
  points: z.coerce.number().min(0.5, 'Must be at least 0.5').max(100),
  tags: z.string().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  allow_assumptions: z.boolean().optional(),
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const difficultyVariant = (d: Difficulty) => (d === 'hard' ? 'destructive' : d === 'easy' ? 'success' : 'warning');

const singleMultipleSchema = z.object({
  ...questionBase,
  qtype: z.enum(['single', 'multiple']),
  options: z.array(z.string().min(1, 'Option cannot be empty')).min(2, 'At least 2 options required'),
  answer: z.any(),
  tolerance: z.any().optional(),
});

const shortSchema = z.object({
  ...questionBase,
  qtype: z.enum(['short']),
  answer: z.string().min(1, 'Answer is required'),
  options: z.any().optional(),
  tolerance: z.any().optional(),
});

const numericSchema = z.object({
  ...questionBase,
  qtype: z.enum(['numeric']),
  answer: z.coerce.number({ error: 'Must be a number' }),
  tolerance: z.coerce.number().min(0).optional(),
  options: z.any().optional(),
});

/** Marked by hand: the answer is an optional marking guide. */
const descriptiveSchema = z.object({
  ...questionBase,
  qtype: z.enum(['descriptive']),
  answer: z.string().max(20000).optional(),
  options: z.any().optional(),
  tolerance: z.any().optional(),
});

const questionSchema = z.discriminatedUnion('qtype', [
  singleMultipleSchema,
  shortSchema,
  numericSchema,
  descriptiveSchema,
]);

type NewBankForm = z.infer<typeof newBankSchema>;
type QuestionForm = z.infer<typeof questionSchema>;

// ─── Table columns ──────────────────────────────────────────────────────────

const typeVariant = (qtype: QuestionType) =>
  qtype === 'single' || qtype === 'multiple' ? 'default' : 'secondary';

const columns: ColumnDef<BankQuestion>[] = [
  {
    accessorKey: 'qtype',
    header: 'Type',
    cell: ({ getValue }) => {
      const qtype = getValue<QuestionType>();
      return <Badge variant={typeVariant(qtype)}>{qtype.toUpperCase()}</Badge>;
    },
    enableSorting: false,
    size: 110,
  },
  {
    accessorKey: 'text',
    header: 'Question',
    cell: ({ getValue }) => {
      const text = getValue<string>();
      return (
        <div className="max-w-[320px] truncate" title={text}>
          <RichText content={text} />
        </div>
      );
    },
    enableSorting: false,
  },
  {
    accessorKey: 'points',
    header: 'Points',
    cell: ({ getValue }) => getValue<number>(),
    size: 80,
  },
  {
    accessorKey: 'difficulty',
    header: 'Difficulty',
    cell: ({ getValue }) => {
      const d = getValue<Difficulty>() ?? 'medium';
      return <Badge variant={difficultyVariant(d)}>{DIFFICULTY_LABEL[d]}</Badge>;
    },
    size: 100,
  },
  {
    accessorKey: 'tags',
    header: 'Tags',
    cell: ({ getValue }) => {
      const tags = getValue<string[]>();
      if (!tags || tags.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <Badge key={t} variant="outline" className="text-xs">
              {t}
            </Badge>
          ))}
        </div>
      );
    },
    enableSorting: false,
  },
];

// ─── New Bank form ──────────────────────────────────────────────────────────

function NewBankForm({
  open,
  onOpenChange,
  courseId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: number;
}) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewBankForm>({
    resolver: zodResolver(newBankSchema),
  });

  const onSubmit = async (data: NewBankForm) => {
    try {
      const res = await api.post<{ bank: QuestionBank }>(`/banks/course/${courseId}`, {
        name: data.name.trim(),
        description: data.description?.trim() ?? '',
      });
      await queryClient.invalidateQueries({ queryKey: qk.banks(courseId) });
      toast.success('Question bank created', { description: res.bank.name });
      onOpenChange(false);
    } catch (err: any) {
      toast.error('Failed to create bank', { description: err.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Question Bank</DialogTitle>
          <DialogDescription>
            Give this bank a name and optional description. You can add questions after creation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <Label htmlFor="bank-name">Bank Name</Label>
            <Input
              id="bank-name"
              placeholder="e.g. Midterm AI Questions"
              {...register('name')}
              aria-invalid={!!errors.name}
              aria-describedby="bank-name-error"
            />
            {errors.name && (
              <p id="bank-name-error" className="text-sm text-destructive mt-1">
                {errors.name.message}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="bank-desc">Description (optional)</Label>
            <Textarea
              id="bank-desc"
              placeholder="Topic coverage or notes..."
              rows={3}
              {...register('description')}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Creating…' : 'Create Bank'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── New Question form ──────────────────────────────────────────────────────

function NewQuestionForm({
  open,
  onOpenChange,
  bankId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bankId: number;
}) {
  const queryClient = useQueryClient();
  const [qtype, setQtype] = useState<QuestionType>('single');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
    setValue,
  } = useForm<z.input<typeof questionSchema>, unknown, QuestionForm>({
    resolver: zodResolver(questionSchema),
    defaultValues: {
      qtype: 'single',
      text: '',
      options: ['', '', '', ''],
      answer: 0,
      points: 1,
      tolerance: 0.01,
      tags: '',
      difficulty: 'medium',
      allow_assumptions: false,
    },
  });

  const watchedOptions = watch('options') as string[] | undefined;
  const watchedAnswer = watch('answer');

  const updateOption = (idx: number, val: string) => {
    const opts = [...(watchedOptions ?? [])];
    opts[idx] = val;
    setValue('options', opts);
  };

  const toggleOptionAnswer = (idx: number) => {
    if (qtype === 'single') {
      setValue('answer', idx);
    } else {
      const curr = Array.isArray(watchedAnswer) ? [...watchedAnswer] : [];
      if (curr.includes(idx)) setValue('answer', curr.filter((x) => x !== idx));
      else setValue('answer', [...curr, idx]);
    }
  };

  const addOption = () => {
    const opts = [...(watchedOptions ?? []), ''];
    setValue('options', opts);
  };

  const onSubmit = async (data: QuestionForm) => {
    try {
      let finalAnswer: unknown = data.answer;
      if (qtype === 'single') finalAnswer = Number(data.answer);
      if (qtype === 'numeric') finalAnswer = Number(data.answer);
      if (qtype === 'multiple') {
        finalAnswer = Array.isArray(data.answer) ? data.answer : [Number(data.answer)];
      }

      await api.post(`/banks/${bankId}/questions`, {
        qtype: data.qtype,
        text: data.text.trim(),
        options: qtype === 'single' || qtype === 'multiple' ? data.options : [],
        answer: finalAnswer,
        tolerance: qtype === 'numeric' ? data.tolerance : null,
        points: data.points,
        difficulty: data.difficulty,
        allow_assumptions: Boolean(data.allow_assumptions),
        tags: data.tags
          ? data.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
      });

      await queryClient.invalidateQueries({ queryKey: qk.bank(bankId) });
      toast.success('Question added', { description: data.text.slice(0, 60) + '…' });
      onOpenChange(false);
    } catch (err: any) {
      toast.error('Failed to add question', { description: err.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Question to Bank</DialogTitle>
          <DialogDescription>
            Choose a question type and fill in the details. Supports LaTeX math in question text.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="qtype">Question Type</Label>
              <select
                id="qtype"
                value={qtype}
                onChange={(e) => {
                  const val = e.target.value as QuestionType;
                  setQtype(val);
                  setValue('qtype', val);
                }}
                className="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
              >
                <option value="single">Single Choice (Radio)</option>
                <option value="multiple">Multiple Choice (Checkboxes)</option>
                <option value="numeric">Numeric (Math / Range)</option>
                <option value="short">Short Answer</option>
                <option value="descriptive">Descriptive (marked by hand)</option>
              </select>
            </div>
            <div>
              <Label htmlFor="points">Points</Label>
              <Input
                id="points"
                type="number"
                min="0.5"
                step="0.5"
                {...register('points')}
                aria-invalid={!!errors.points}
              />
              {errors.points && <p className="text-sm text-destructive mt-1">{errors.points.message}</p>}
            </div>
          </div>

          <div>
            <Label htmlFor="qtext">Question Text (supports Markdown & LaTeX: e.g. $$x^2 + y^2$$)</Label>
            <Textarea
              id="qtext"
              rows={3}
              placeholder="e.g. Calculate the integral $\int_0^1 x dx$"
              {...register('text')}
              aria-invalid={!!errors.text}
            />
            {errors.text && <p className="text-sm text-destructive mt-1">{errors.text.message}</p>}
          </div>

          {(qtype === 'single' || qtype === 'multiple') && (
            <div>
              <Label className="flex items-center justify-between">
                <span>Options</span>
                <Button type="button" variant="ghost" size="sm" onClick={addOption}>
                  <Plus className="size-3 mr-1" /> Add option
                </Button>
              </Label>
              <div className="space-y-2 mt-2">
                {(watchedOptions ?? []).map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="w-6 text-center font-mono text-sm">
                      {String.fromCharCode(65 + idx)}.
                    </span>
                    <Input
                      value={opt ?? ''}
                      onChange={(e) => updateOption(idx, e.target.value)}
                      placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                    />
                    {qtype === 'single' ? (
                      <input
                        type="radio"
                        name="answer"
                        checked={Number(watchedAnswer) === idx}
                        onChange={() => toggleOptionAnswer(idx)}
                        className="accent-[var(--primary)]"
                      />
                    ) : (
                      <input
                        type="checkbox"
                        checked={Array.isArray(watchedAnswer) && watchedAnswer.includes(idx)}
                        onChange={() => toggleOptionAnswer(idx)}
                        className="accent-[var(--primary)]"
                      />
                    )}
                  </div>
                ))}
              </div>
              {errors.options && <p className="text-sm text-destructive mt-1">{String(errors.options.message ?? '')}</p>}
            </div>
          )}

          {qtype === 'numeric' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="answer-numeric">Correct Number</Label>
                <Input
                  id="answer-numeric"
                  type="number"
                  step="any"
                  {...register('answer')}
                  aria-invalid={!!errors.answer}
                />
                {errors.answer && <p className="text-sm text-destructive mt-1">{String(errors.answer.message ?? '')}</p>}
              </div>
              <div>
                <Label htmlFor="tolerance">Tolerance (±)</Label>
                <Input id="tolerance" type="number" step="any" min="0" {...register('tolerance')} />
              </div>
            </div>
          )}

          {qtype === 'descriptive' && (
            <div>
              <Label htmlFor="answer-guide">Model answer / marking guide (optional)</Label>
              <Textarea
                id="answer-guide"
                rows={3}
                placeholder="What a full-marks answer contains"
                {...register('answer')}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Never auto-graded — the instructor marks each answer after the exam.
              </p>
            </div>
          )}

          {qtype === 'short' && (
            <div>
              <Label htmlFor="answer-short">Correct Answer (String)</Label>
              <Input id="answer-short" {...register('answer')} aria-invalid={!!errors.answer} />
              {errors.answer && <p className="text-sm text-destructive mt-1">{String(errors.answer.message ?? '')}</p>}
            </div>
          )}

          <div className="grid grid-cols-[1fr_2fr] gap-4">
            <div>
              <Label htmlFor="difficulty">Difficulty</Label>
              <select
                id="difficulty"
                {...register('difficulty')}
                className="w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input id="tags" placeholder="e.g. calculus, integrals, unit-2" {...register('tags')} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Quizzes can draw a random question of a given difficulty (and tag) from this bank, so each student gets a
            different question of the same level.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" {...register('allow_assumptions')} className="mt-1 accent-[var(--primary)]" style={{ width: 'auto' }} />
            <span>
              <strong>Allow assumptions</strong> — students can write down an assumption next to their answer.
            </span>
          </label>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Adding…' : 'Add to Bank'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bank list (left panel) ─────────────────────────────────────────────────

function BankList({
  banks,
  selectedId,
  onSelect,
  onDelete,
  onCreate,
}: {
  banks: QuestionBank[];
  selectedId: number | null;
  onSelect: (bank: QuestionBank) => void;
  onDelete: (bank: QuestionBank) => void;
  onCreate: () => void;
}) {
  if (banks.length === 0) {
    return (
      <EmptyState
        title="No question banks yet"
        description="Create a bank to start organizing reusable questions."
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus className="size-4" /> Create first bank
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-2">
      {banks.map((b) => {
        const isSelected = selectedId === b.id;
        return (
          <Card
            key={b.id}
            className={cn(
              'cursor-pointer border-2 transition-all',
              isSelected
                ? 'border-primary bg-accent/50'
                : 'border-transparent hover:border-muted',
            )}
            onClick={() => onSelect(b)}
          >
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{b.name}</span>
                  <Badge variant="secondary">{b.question_count ?? 0} Qs</Badge>
                </div>
                {b.description && (
                  <p className="text-sm text-muted-foreground truncate">{b.description}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(b);
                }}
                aria-label={`Delete bank ${b.name}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Questions table ────────────────────────────────────────────────────────

interface QuestionsTableProps {
  questions: BankQuestion[];
  onDelete: (q: BankQuestion) => void;
}

function QuestionsTable({ questions, onDelete }: QuestionsTableProps) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);

  const filtered = useMemo(() => {
    let result = questions;
    if (globalFilter.trim()) {
      const q = globalFilter.toLowerCase();
      result = result.filter(
        (row) =>
          row.text.toLowerCase().includes(q) ||
          row.tags?.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [questions, globalFilter]);

  const [difficultyFilter, setDifficultyFilter] = useState<'all' | Difficulty>('all');
  const shown = useMemo(
    () => (difficultyFilter === 'all' ? filtered : filtered.filter((q) => (q.difficulty ?? 'medium') === difficultyFilter)),
    [filtered, difficultyFilter],
  );
  const typeFilter = columnFilters.find((f) => f.id === 'qtype');
  const typeValue = (typeFilter?.value as string) ?? 'all';

  const table = useReactTable({
    data: shown,
    columns: [
      ...columns,
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(row.original)}
            aria-label={`Delete question ${row.original.id}`}
          >
            <Trash2 className="size-4" />
          </Button>
        ),
        enableSorting: false,
        size: 60,
      },
    ],
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    state: { columnFilters, globalFilter, sorting },
    initialState: { columnFilters: [] },
    meta: { onDelete },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search questions by text or tags..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="size-4 text-muted-foreground" />
          <select
            value={typeValue}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'all') {
                table.setColumnFilters([]);
              } else {
                table.setColumnFilters([{ id: 'qtype', value: val }]);
              }
            }}
            className="rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
          >
            <option value="all">All types</option>
            <option value="single">Single Choice</option>
            <option value="multiple">Multiple Choice</option>
            <option value="short">Short Answer</option>
            <option value="numeric">Numeric</option>
            <option value="descriptive">Descriptive</option>
          </select>
          <select
            value={difficultyFilter}
            onChange={(e) => setDifficultyFilter(e.target.value as 'all' | Difficulty)}
            aria-label="Filter by difficulty"
            className="rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
          >
            <option value="all">All difficulties</option>
            <option value="easy">Easy ({questions.filter((q) => q.difficulty === 'easy').length})</option>
            <option value="medium">Medium ({questions.filter((q) => (q.difficulty ?? 'medium') === 'medium').length})</option>
            <option value="hard">Hard ({questions.filter((q) => q.difficulty === 'hard').length})</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-lg)] border">
        <table className="w-full border-collapse text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="bg-muted px-4 py-2.5 text-left font-semibold text-muted-foreground uppercase text-xs"
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={table.getAllColumns().length} className="p-8 text-center text-muted-foreground">
                  No questions match your filters.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-t border-border hover:bg-muted/50">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function QuestionBankPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const cId = Number(courseId);

  const { data: banksData, isLoading: banksLoading, isError: banksError, error: banksErr } = useBanks(cId);
  const [selectedBank, setSelectedBank] = useState<QuestionBank | null>(null);

  const selectedBankId = selectedBank?.id ?? 0;
  const {
    data: bankData,
    isLoading: bankLoading,
    isError: bankError,
    error: bankErr,
  } = useBank(selectedBankId, { enabled: !!selectedBankId });

  const queryClient = useQueryClient();

  // Auto-select first bank when banks load
  useEffect(() => {
    if (banksData?.banks?.length && !selectedBank) {
      setSelectedBank(banksData.banks[0]!);
    }
  }, [banksData, selectedBank]);

  const handleSelectBank = (bank: QuestionBank) => {
    setSelectedBank(bank);
  };

  const handleDeleteBank = async (bank: QuestionBank) => {
    if (!confirm('Are you sure you want to delete this question bank?')) return;
    try {
      await api.del(`/banks/${bank.id}`);
      await queryClient.invalidateQueries({ queryKey: qk.banks(cId) });
      if (selectedBank?.id === bank.id) setSelectedBank(null);
      toast.success('Bank deleted', { description: bank.name });
    } catch (err: any) {
      toast.error('Failed to delete bank', { description: err.message });
    }
  };

  const handleDeleteQuestion = async (q: BankQuestion) => {
    if (!selectedBank) return;
    if (!confirm('Delete this question?')) return;
    try {
      await api.del(`/banks/${selectedBank.id}/questions/${q.id}`);
      await queryClient.invalidateQueries({ queryKey: qk.bank(selectedBank.id) });
      toast.success('Question deleted');
    } catch (err: any) {
      toast.error('Failed to delete question', { description: err.message });
    }
  };

  const [showNewBank, setShowNewBank] = useState(false);
  const [showNewQuestion, setShowNewQuestion] = useState(false);

  return (
    <div className="min-h-[100dvh]">
      <Page
        title="Question Banks"
        description="Organize reusable question repositories with LaTeX math support and batch JSON import/export."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link to={`/courses/${cId}`}>
                <ChevronLeft className="size-4" />
                Back to Course
              </Link>
            </Button>
            <Button size="sm" onClick={() => setShowNewBank(true)}>
              <Plus className="size-4" /> New Bank
            </Button>
          </div>
        }
        width="wide"
      >
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[320px_1fr]">
          {/* Left: Banks */}
          <div>
            <h2 className="font-display text-lg font-semibold mb-4">All Banks</h2>
            {banksLoading ? (
              <LoadingSkeleton variant="list" rows={4} />
            ) : banksError ? (
              <ErrorState
                title="Could not load banks"
                error={banksErr}
                onRetry={() => queryClient.invalidateQueries({ queryKey: qk.banks(cId) })}
              />
            ) : (
              <BankList
                banks={banksData?.banks ?? []}
                selectedId={selectedBank?.id ?? null}
                onSelect={handleSelectBank}
                onDelete={handleDeleteBank}
                onCreate={() => setShowNewBank(true)}
              />
            )}
          </div>

          {/* Right: Questions */}
          <div>
            {selectedBank ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-display text-xl font-semibold">{selectedBank.name}</h2>
                    <p className="text-sm text-muted-foreground">
                      {bankData?.questions?.length ?? 0} questions in this bank
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setShowNewQuestion(true)}
                    >
                      <ListPlus className="size-4" /> Add Question
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleDeleteBank(selectedBank)}
                    >
                      <Trash2 className="size-4" /> Delete Bank
                    </Button>
                  </div>
                </div>

                <Separator />

                {bankLoading ? (
                  <LoadingSkeleton variant="list" rows={5} />
                ) : bankError ? (
                  <ErrorState
                    title="Could not load questions"
                    error={bankErr}
                    onRetry={() => queryClient.invalidateQueries({ queryKey: qk.bank(selectedBank.id) })}
                  />
                ) : (
                  <QuestionsTable
                    questions={bankData?.questions ?? []}
                    onDelete={handleDeleteQuestion}
                  />
                )}
              </div>
            ) : (
              <EmptyState
                icon={HelpCircle}
                title="Select a question bank"
                description="Choose a bank from the left, or create a new one to get started."
              />
            )}
          </div>
        </div>
      </Page>

      <NewBankForm open={showNewBank} onOpenChange={setShowNewBank} courseId={cId} />

      {selectedBank && (
        <NewQuestionForm
          open={showNewQuestion}
          onOpenChange={setShowNewQuestion}
          bankId={selectedBank.id}
        />
      )}
    </div>
  );
}

