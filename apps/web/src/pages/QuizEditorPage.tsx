import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  QuizDetailResponse,
  QuestionType,
  IntegrityPolicy,
  ShowScores,
  QuestionEditor,
  QuestionBank,
  BankQuestion,
} from '../types';
import { RichText } from '../components/RichText';
import { toast } from '@/components/ui/sonner';
import { Page } from '@/components/primitives';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { ChevronLeft, Copy, Trash2 } from 'lucide-react';

const EMPTY_QUESTION = () => ({
  qtype: 'single' as QuestionType,
  text: '',
  options: ['', ''],
  answer: 0 as number | number[] | string,
  tolerance: '0.01',
  points: 1,
  id: null as number | null,
});

function convertToDatetimeLocal(dateString: string): string {
  try {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  } catch {
    return '';
  }
}

export function QuizEditorPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<QuizDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);

  // meta form
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [duration, setDuration] = useState('');
  const [shuffleQ, setShuffleQ] = useState<boolean>(false);
  const [shuffleO, setShuffleO] = useState<boolean>(false);
  const [attempts, setAttempts] = useState('1');
  const [policy, setPolicy] = useState<IntegrityPolicy>('off');
  const [trigger, setTrigger] = useState('focus_exit');
  const [showScores, setShowScores] = useState<ShowScores>('release');
  const [quizType, setQuizType] = useState<'anytime' | 'scheduled'>('anytime');
  const [windowOpensAt, setWindowOpensAt] = useState('');
  const [windowDuration, setWindowDuration] = useState('');

  const [newQ, setNewQ] = useState(EMPTY_QUESTION());
  const [edits, setEdits] = useState<Record<number, ReturnType<typeof EMPTY_QUESTION>>>({});

  // Question bank modal state
  const [showBankModal, setShowBankModal] = useState(false);
  const [banks, setBanks] = useState<QuestionBank[]>([]);
  const [selectedBankId, setSelectedBankId] = useState<number | ''>('');
  const [bankQuestions, setBankQuestions] = useState<BankQuestion[]>([]);
  const [importingBank, setImportingBank] = useState(false);

  // Answer key editing for published questions
  const [answerEdits, setAnswerEdits] = useState<Record<number, { answer: number | number[] | string; tolerance?: string }>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.get<QuizDetailResponse>(`/quizzes/${quizId}`);
      setDetail(res);
      const draft = res.versions.find((v) => v.status === 'draft') ?? res.versions[0];
      if (draft) {
        setTitle(draft.title);
        setInstructions(draft.instructions);
        setDuration(draft.duration_minutes == null ? '' : String(draft.duration_minutes));
        setShuffleQ(!!draft.shuffle_questions);
        setShuffleO(!!draft.shuffle_options);
        setAttempts(String(draft.attempts_allowed));
        setPolicy(draft.integrity_policy);
        setTrigger(draft.policy_trigger);
        setShowScores(draft.show_scores);
        setQuizType(draft.quiz_type || 'anytime');
        setWindowOpensAt(draft.window_opens_at ? convertToDatetimeLocal(draft.window_opens_at) : '');
        setWindowDuration(draft.window_duration_minutes ? String(draft.window_duration_minutes) : '');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load quiz.');
    }
  }, [quizId]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = detail?.versions.find((v) => v.status === 'draft');
  const published = detail?.versions.find((v) => v.status === 'published');
  const editable = !!draft;

  if (error) return <div className="banner error">{error}</div>;
  if (!detail) return <p className="muted">Loading quiz…</p>;

  const saveMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingMeta(true);
    setError(null);
    try {
      await api.put(`/quizzes/${quizId}`, {
        title,
        instructions,
        duration_minutes: duration === '' ? null : Number(duration),
        shuffle_questions: shuffleQ ? 1 : 0,
        shuffle_options: shuffleO ? 1 : 0,
        attempts_allowed: Number(attempts),
        integrity_policy: policy,
        policy_trigger: trigger,
        show_scores: showScores,
        quiz_type: quizType,
        window_opens_at: quizType === 'scheduled' ? new Date(windowOpensAt).toISOString() : null,
        window_duration_minutes: quizType === 'scheduled' ? Number(windowDuration) : null,
      });
      toast.success('Quiz settings saved');
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSavingMeta(false);
    }
  };

  const publish = async () => {
    try {
      await api.patch(`/quizzes/${quizId}/publish`, {});
      navigate(`/quizzes/${quizId}/preflight`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publish failed.');
    }
  };

  const cloneDraft = async () => {
    try {
      await api.post(`/quizzes/${quizId}/versions`, {});
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clone new draft.');
    }
  };

  const duplicateQuiz = async () => {
    try {
      const res = await api.post<{ quiz_id: number }>(`/quizzes/${quizId}/copy`, {});
      toast.success('Quiz duplicated');
      navigate(`/quizzes/${res.quiz_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Duplicate failed.');
    }
  };

  const deleteQuiz = async () => {
    try {
      await api.del(`/quizzes/${quizId}`);
      toast.success('Quiz deleted');
      navigate(`/courses/${detail!.course_id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
    }
  };

  const saveNewQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    try {
      const res = await api.post<{ question: QuestionEditor }>(`/quizzes/${quizId}/questions`, buildQuestionPayload(newQ));
      setNewQ(EMPTY_QUESTION());
      toast.success('Question added');
      setDetail((prev) =>
        prev && draft
          ? {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === draft.id ? { ...v, questions: [...v.questions, res.question] } : v,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add question.');
    }
  };

  const saveEdit = async (q: QuestionEditor) => {
    const payload = edits[q.id];
    if (!payload) return;
    try {
      const res = await api.put<{ question: QuestionEditor }>(`/quizzes/questions/${q.id}`, buildQuestionPayload(payload));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      toast.success('Question updated');
      setDetail((prev) =>
        prev && draft
          ? {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === draft.id
                  ? { ...v, questions: v.questions.map((qq) => (qq.id === q.id ? res.question : qq)) }
                  : v,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update question.');
    }
  };

  const deleteQuestion = async (q: QuestionEditor) => {
    try {
      await api.del(`/quizzes/questions/${q.id}`);
      toast.success('Question deleted');
      setDetail((prev) =>
        prev && draft
          ? {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === draft.id ? { ...v, questions: v.questions.filter((qq) => qq.id !== q.id) } : v,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete question.');
    }
  };

  // Item 7: published questions are frozen structurally, but the answer key can be
  // re-keyed in place via PATCH /quizzes/questions/:id/answer.
  const saveAnswerKey = async (q: QuestionEditor) => {
    const edit = answerEdits[q.id];
    if (!edit) return;
    try {
      await api.patch(`/quizzes/questions/${q.id}/answer`, {
        answer: edit.answer,
        tolerance: edit.tolerance !== undefined ? (edit.tolerance === '' ? 0 : Number(edit.tolerance)) : undefined,
      });
      setAnswerEdits((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      toast.success('Answer key updated');
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update answer key.');
    }
  };

  const openBankModal = async () => {
    try {
      setShowBankModal(true);
      const res = await api.get<{ banks: QuestionBank[] }>(`/banks/course/${detail.course_id}`);
      setBanks(res.banks);
    } catch (err) {
      setError('Failed to load course question banks.');
    }
  };

  const handleSelectBank = async (bId: number) => {
    setSelectedBankId(bId);
    try {
      const res = await api.get<{ questions: BankQuestion[] }>(`/banks/${bId}`);
      setBankQuestions(res.questions);
    } catch (err) {
      setError('Failed to load bank questions.');
    }
  };

  const importBankQuestion = async (bq: BankQuestion) => {
    if (!draft) return;
    try {
      setImportingBank(true);
      const res = await api.post<{ question: QuestionEditor }>(`/quizzes/${quizId}/questions`, {
        qtype: bq.qtype,
        text: bq.text,
        options: bq.options,
        answer: bq.answer,
        tolerance: bq.tolerance,
        points: bq.points,
      });
      toast.success(`Imported question into draft`);
      setDetail((prev) =>
        prev && draft
          ? {
              ...prev,
              versions: prev.versions.map((v) =>
                v.id === draft.id ? { ...v, questions: [...v.questions, res.question] } : v,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError('Failed to import question from bank.');
    } finally {
      setImportingBank(false);
    }
  };

  return (
    <Page
      title={title || 'Untitled quiz'}
      description={`Course ID #${detail.course_id} · ${draft ? `Editing draft v${draft.version}` : `Viewing published v${published?.version}`}${published && published.quiz_type === 'scheduled' && published.window_opens_at ? ` · Opens ${new Date(published.window_opens_at).toLocaleString()} for ${published.window_duration_minutes} min` : ''}`}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <Button asChild variant="secondary" size="sm">
            <a href={`/courses/${detail.course_id}`}>
              <ChevronLeft className="size-4" />
              Back
            </a>
          </Button>
          {draft && <Badge variant="warning">Draft v{draft.version}</Badge>}
          {published && <Badge variant="success">Live v{published.version}</Badge>}
          {editable && (
            <>
              <Button size="sm" variant="secondary" onClick={() => void openBankModal()}>
                Import from Bank
              </Button>
              <Button size="sm" onClick={() => void publish()} disabled={draft.questions.length === 0}>
                Publish live version
              </Button>
            </>
          )}
          {!editable && published && (
            <Button size="sm" onClick={() => void cloneDraft()}>
              Create new draft version
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void duplicateQuiz()}>
            <Copy className="size-4" />
            Duplicate
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive">
                <Trash2 className="size-4" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete quiz?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete the quiz and all its versions. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void deleteQuiz()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      }
      width="wide"
    >

      <Dialog open={showBankModal} onOpenChange={setShowBankModal}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Questions from Bank</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="bank-select">Select Bank</Label>
              <select
                id="bank-select"
                value={selectedBankId}
                onChange={(e) => void handleSelectBank(Number(e.target.value))}
                className="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
              >
                <option value="">-- Choose a Question Bank --</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.question_count ?? 0} questions)
                  </option>
                ))}
              </select>
            </div>

            {bankQuestions.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Available Questions ({bankQuestions.length})</h4>
                {bankQuestions.map((bq) => (
                  <Card key={bq.id}>
                    <CardContent className="p-3 flex justify-between items-center">
                      <div className="flex-1 mr-3">
                        <div className="text-xs text-muted-foreground mb-1">
                          {bq.qtype.toUpperCase()} · {bq.points} pt
                        </div>
                        <RichText content={bq.text} />
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={importingBank}
                        onClick={() => void importBankQuestion(bq)}
                      >
                        Import
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 lg:grid-cols-2 items-stretch mt-6">
        <Card className="h-full flex flex-col">
          <CardContent className="p-6 flex-1">
            <h3 className="text-lg font-semibold mb-4">Settings</h3>
            <form onSubmit={saveMeta} className="space-y-4">
              <div>
                <Label htmlFor="meta-title">Title</Label>
                <Input
                  id="meta-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={!editable}
                />
              </div>
              <div>
                <Label htmlFor="meta-inst">Instructions (Markdown & LaTeX math supported)</Label>
                <Textarea
                  id="meta-inst"
                  rows={3}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  disabled={!editable}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="meta-dur">Duration (minutes, blank = no limit)</Label>
                  <Input
                    id="meta-dur"
                    type="number"
                    min={1}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label htmlFor="meta-att">Attempts allowed</Label>
                  <Input
                    id="meta-att"
                    type="number"
                    min={1}
                    max={10}
                    value={attempts}
                    onChange={(e) => setAttempts(e.target.value)}
                    disabled={!editable}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="meta-pol">Integrity policy</Label>
                  <select
                    id="meta-pol"
                    value={policy}
                    onChange={(e) => setPolicy(e.target.value as IntegrityPolicy)}
                    disabled={!editable}
                    className="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
                  >
                    <option value="off">Off (practice)</option>
                    <option value="warn">Warn on tab exit</option>
                    <option value="strict">Strict lock on tab exit (HTTP 423)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="meta-scores">Show scores</Label>
                  <select
                    id="meta-scores"
                    value={showScores}
                    onChange={(e) => setShowScores(e.target.value as ShowScores)}
                    disabled={!editable}
                    className="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
                  >
                    <option value="immediate">Immediately on submit</option>
                    <option value="release">When instructor releases</option>
                    <option value="never">Never (private)</option>
                  </select>
                </div>
              </div>
              <div>
                <Label htmlFor="quiz-type">Quiz type</Label>
                <select
                  id="quiz-type"
                  value={quizType}
                  onChange={(e) => setQuizType(e.target.value as 'anytime' | 'scheduled')}
                  disabled={!editable}
                  className="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
                >
                  <option value="anytime">Anytime</option>
                  <option value="scheduled">Scheduled</option>
                </select>
              </div>
              {quizType === 'scheduled' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="window-opens">Window opens at</Label>
                    <Input
                      id="window-opens"
                      type="datetime-local"
                      value={windowOpensAt}
                      onChange={(e) => setWindowOpensAt(e.target.value)}
                      disabled={!editable}
                    />
                  </div>
                  <div>
                    <Label htmlFor="window-duration">Duration (minutes)</Label>
                    <Input
                      id="window-duration"
                      type="number"
                      min={1}
                      value={windowDuration}
                      onChange={(e) => setWindowDuration(e.target.value)}
                      disabled={!editable}
                    />
                  </div>
                </div>
              )}
              <div>
                <Label>Randomization</Label>
                <div className="flex gap-4 mt-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shuffleQ}
                      onChange={(e) => setShuffleQ(e.target.checked)}
                      disabled={!editable}
                      className="accent-[var(--primary)]"
                    />
                    <span className="text-sm">Shuffle questions</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shuffleO}
                      onChange={(e) => setShuffleO(e.target.checked)}
                      disabled={!editable}
                      className="accent-[var(--primary)]"
                    />
                    <span className="text-sm">Shuffle options</span>
                  </label>
                </div>
              </div>
              <Button type="submit" disabled={!editable || savingMeta} variant="secondary">
                {savingMeta ? 'Saving…' : 'Save settings'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full flex flex-col">
          <CardContent className="p-6 flex-1">
            <h3 className="text-lg font-semibold mb-4">
              Questions ({draft ? draft.questions.length : detail.versions[0]?.questions.length ?? 0})
            </h3>
            {draft && draft.questions.length === 0 && (
              <p className="text-sm text-muted-foreground mb-4">
                Add your first question below. You need at least one before publishing.
              </p>
            )}
            {editable && (
              <form onSubmit={saveNewQuestion} className="space-y-4 border-t border-border pt-4 mt-4">
                <QuestionFields q={newQ} setQ={setNewQ} />
                <Button type="submit" size="sm">
                  Add question
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      {draft && draft.questions.length > 0 && (
        <section className="mt-6">
          <h3 className="text-lg font-semibold mb-4">Question list</h3>
          <div className="flex flex-col gap-3">
            {draft.questions.map((q) => {
              const edit = edits[q.id];
              return (
                <Card key={q.id}>
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <strong>Q{q.order_index + 1}</strong>
                        <Badge variant="secondary">{q.qtype}</Badge>
                        <span className="text-sm text-muted-foreground">{q.points} pt</span>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEdits({ ...edits, [q.id]: questionToEdit(q) })}
                      >
                        Edit
                      </Button>
                    </div>
                    <div className="mt-2">
                      <RichText content={q.text} />
                    </div>
                    {edit && (
                      <div className="mt-4 p-4 bg-muted rounded-lg">
                        <QuestionFields q={edit} setQ={(next) => setEdits({ ...edits, [q.id]: next })} />
                        <div className="flex gap-2 mt-4">
                          <Button size="sm" onClick={() => void saveEdit(q)}>
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              const next = { ...edits };
                              delete next[q.id];
                              setEdits(next);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => void deleteQuestion(q)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {!draft && published && (
        <section className="mt-6">
          <h3 className="text-lg font-semibold mb-4">Published Questions (Answer Key Editor)</h3>
          <div className="flex flex-col gap-3">
            {published.questions.map((q) => {
              const edit = answerEdits[q.id];
              return (
                <Card key={q.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <strong>Q{q.order_index + 1}</strong>
                      <Badge variant="secondary">{q.qtype}</Badge>
                      <span className="text-sm text-muted-foreground">{q.points} pt</span>
                    </div>
                    <div className="mt-2 mb-4">
                      <RichText content={q.text} />
                    </div>
                    <div className="border-t border-border pt-4">
                      <Label className="text-sm font-semibold mb-2 block">Edit Answer Key</Label>
                      {(q.qtype === 'single' || q.qtype === 'multiple') && (
                        <div className="space-y-2">
                          {q.options.map((opt, idx) => (
                            <label key={idx} className="flex items-center gap-2">
                              <input
                                type={q.qtype === 'single' ? 'radio' : 'checkbox'}
                                name={`answer-${q.id}`}
                                checked={
                                  edit
                                    ? q.qtype === 'single'
                                      ? Number(edit.answer) === idx
                                      : Array.isArray(edit.answer) && edit.answer.includes(idx)
                                    : q.qtype === 'single'
                                    ? Number(q.answer) === idx
                                    : Array.isArray(q.answer) && q.answer.includes(idx)
                                }
                                onChange={() => {
                                  if (q.qtype === 'single') {
                                    setAnswerEdits({ ...answerEdits, [q.id]: { answer: idx } });
                                  } else {
                                    const curr = edit
                                      ? Array.isArray(edit.answer)
                                        ? [...edit.answer]
                                        : []
                                      : Array.isArray(q.answer)
                                      ? [...q.answer]
                                      : [];
                                    const next = curr.includes(idx)
                                      ? curr.filter((i) => i !== idx)
                                      : [...curr, idx];
                                    setAnswerEdits({ ...answerEdits, [q.id]: { answer: next } });
                                  }
                                }}
                                className="accent-[var(--primary)]"
                              />
                              <span className="text-sm">
                                <RichText content={opt} />
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                      {q.qtype === 'numeric' && (
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor={`answer-${q.id}`}>Correct Number</Label>
                            <Input
                              id={`answer-${q.id}`}
                              type="number"
                              step="any"
                              value={edit ? String(edit.answer) : String(q.answer)}
                              onChange={(e) =>
                                setAnswerEdits({
                                  ...answerEdits,
                                  [q.id]: {
                                    answer: e.target.value,
                                    tolerance: edit?.tolerance ?? String(q.tolerance ?? 0),
                                  },
                                })
                              }
                            />
                          </div>
                          <div>
                            <Label htmlFor={`tolerance-${q.id}`}>Tolerance (±)</Label>
                            <Input
                              id={`tolerance-${q.id}`}
                              type="number"
                              step="any"
                              min="0"
                              value={edit?.tolerance ?? String(q.tolerance ?? 0)}
                              onChange={(e) =>
                                setAnswerEdits({
                                  ...answerEdits,
                                  [q.id]: {
                                    answer: edit?.answer ?? q.answer,
                                    tolerance: e.target.value,
                                  },
                                })
                              }
                            />
                          </div>
                        </div>
                      )}
                      {q.qtype === 'short' && (
                        <div>
                          <Label htmlFor={`answer-${q.id}`}>Correct Answer</Label>
                          <Input
                            id={`answer-${q.id}`}
                            value={edit ? String(edit.answer) : String(q.answer)}
                            onChange={(e) =>
                              setAnswerEdits({ ...answerEdits, [q.id]: { answer: e.target.value } })
                            }
                          />
                        </div>
                      )}
                      {edit && (
                        <Button size="sm" className="mt-3" onClick={() => void saveAnswerKey(q)}>
                          Save answer key
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </Page>
  );
}

function questionToEdit(q: QuestionEditor): ReturnType<typeof EMPTY_QUESTION> {
  return {
    qtype: q.qtype,
    text: q.text,
    options: q.options.length ? q.options : ['', ''],
    answer: q.answer as number | number[] | string,
    tolerance: q.tolerance == null ? '0.01' : String(q.tolerance),
    points: q.points,
    id: q.id,
  };
}

function buildQuestionPayload(q: ReturnType<typeof EMPTY_QUESTION>) {
  const body: Record<string, unknown> = {
    qtype: q.qtype,
    text: q.text,
    points: Number(q.points) || 1,
  };
  if (q.qtype === 'single' || q.qtype === 'multiple') {
    body.options = q.options.filter((o) => o.trim() !== '');
  }
  if (q.qtype === 'single') body.answer = Number(q.answer);
  if (q.qtype === 'multiple') {
    body.answer = Array.isArray(q.answer) ? q.answer.map(Number) : [];
  }
  if (q.qtype === 'numeric') {
    body.answer = Number(q.answer);
    body.tolerance = q.tolerance === '' ? 0 : Number(q.tolerance);
  }
  if (q.qtype === 'short') {
    body.answer = String(q.answer ?? '');
  }
  return body;
}

function QuestionFields({
  q,
  setQ,
}: {
  q: ReturnType<typeof EMPTY_QUESTION>;
  setQ: (next: ReturnType<typeof EMPTY_QUESTION>) => void;
}) {
  const set = (patch: Partial<ReturnType<typeof EMPTY_QUESTION>>) => setQ({ ...q, ...patch });

  return (
    <div>
      <input type="hidden" />
      <div className="field">
        <label htmlFor="q-text">Question text (Supports LaTeX e.g. $$x^2$$ and Markdown)</label>
        <textarea id="q-text" rows={2} value={q.text} onChange={(e) => set({ text: e.target.value })} />
        {q.text && (
          <div style={{ marginTop: '6px', padding: '6px 10px', background: '#f8fafc', borderRadius: '4px', border: '1px dashed #cbd5e1' }}>
            <span style={{ fontSize: '0.7rem', color: '#64748b' }}>Live Preview:</span>
            <RichText content={q.text} />
          </div>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="q-type">Type</label>
          <select id="q-type" value={q.qtype} onChange={(e) => set({ qtype: e.target.value as QuestionType })}>
            <option value="single">Single choice</option>
            <option value="multiple">Multiple choice</option>
            <option value="short">Short answer</option>
            <option value="numeric">Numeric</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="q-points">Points</label>
          <input id="q-points" type="number" min={0.25} step={0.25} value={q.points} onChange={(e) => set({ points: Number(e.target.value) })} />
        </div>
      </div>

      {(q.qtype === 'single' || q.qtype === 'multiple') && (
        <div className="field">
          <label htmlFor="q-options">
            Options (one per line). Mark the correct one{q.qtype === 'multiple' ? 's (check ' + (Array.isArray(q.answer) ? (q.answer as unknown[]).length : 0) + ' selected)' : ''}.
          </label>
          <textarea
            id="q-options"
            rows={3}
            value={q.options.join('\n')}
            onChange={(e) => {
              const options = e.target.value.split('\n');
              let answer: number | number[] = q.qtype === 'single' ? Number(q.answer) : (Array.isArray(q.answer) ? q.answer.filter((i) => i < options.length) : []);
              if (q.qtype === 'single' && Number(answer) >= options.filter((o) => o.trim() !== '').length) {
                answer = 0;
              }
              set({ options, answer });
            }}
          />
          <div style={{ marginTop: '0.5rem' }} role="radiogroup" aria-label="correct options">
            {q.options.map((o, i) =>
              o.trim() === '' ? null : (
                <label key={i} className="option" style={{ marginTop: '0.35rem' }}>
                  <input
                    type={q.qtype === 'single' ? 'radio' : 'checkbox'}
                    name="correct"
                    checked={
                      q.qtype === 'single' ? Number(q.answer) === i : Array.isArray(q.answer) && (q.answer as unknown[]).includes(i)
                    }
                    onChange={() => set({ answer: q.qtype === 'single' ? i : toggleMulti(q.answer, i) })}
                    style={{ width: 'auto' }}
                  />
                  <span className="option-label small">
                    <RichText content={o} />
                  </span>
                </label>
              ),
            )}
          </div>
        </div>
      )}

      {q.qtype === 'numeric' && (
        <div className="field-row">
          <div className="field">
            <label htmlFor="q-num">Expected number</label>
            <input id="q-num" type="number" step="any" value={String(q.answer ?? '')} onChange={(e) => set({ answer: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="q-tol">Tolerance (±)</label>
            <input id="q-tol" type="number" step="any" min={0} value={q.tolerance} onChange={(e) => set({ tolerance: e.target.value })} />
          </div>
        </div>
      )}

      {q.qtype === 'short' && (
        <div className="field">
          <label htmlFor="q-short">Accepted answer (case-insensitive)</label>
          <input id="q-short" value={String(q.answer ?? '')} onChange={(e) => set({ answer: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function toggleMulti(current: unknown, index: number): number[] {
  const arr = Array.isArray(current) ? (current as unknown[]).map(Number) : [];
  return arr.includes(index) ? arr.filter((i) => i !== index) : [...arr, index];
}