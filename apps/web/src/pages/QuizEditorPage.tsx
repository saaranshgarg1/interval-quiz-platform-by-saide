import { deviceToServerMs, formatIST, istInputToUtcIso, serverNow, utcToIstInput, windowStatus } from '../lib/time';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  ExamSettings,
  QuizDetailResponse,
  QuestionType,
  ShowScores,
  QuestionEditor,
  QuestionBank,
  BankQuestion,
} from '../types';
import { RichText } from '../components/RichText';
import { LatexPaste, RichPreview } from '../components/LatexPaste';
import { marksLabel } from '../lib/marks';
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
import { ChevronLeft, Copy, Radio, ShieldCheck, Trash2 } from 'lucide-react';
import { ExamSettingsPanel, DEFAULT_EXAM_SETTINGS } from '@/components/ExamSettingsPanel';
import { ConfirmAction } from '@/components/ConfirmAction';
import { RandomFromBank, SlotList } from '@/components/RandomFromBank';
import type { VersionDetail } from '../types';

const EMPTY_QUESTION = () => ({
  qtype: 'single' as QuestionType,
  text: '',
  options: ['', ''],
  answer: 0 as number | number[] | string,
  tolerance: '0.01',
  points: '1' as string,
  /** Marks taken off for a wrong answer ('' or 0 = no negative marking). */
  negative_points: '0' as string,
  time_limit_seconds: '' as string,
  allow_assumptions: false,
  id: null as number | null,
});

export function QuizEditorPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<QuizDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);
  /** Bumped each time load() refills the settings form from the server. */
  const [loadGen, setLoadGen] = useState(0);

  // meta form
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [duration, setDuration] = useState('');
  const [shuffleQ, setShuffleQ] = useState<boolean>(false);
  const [shuffleO, setShuffleO] = useState<boolean>(false);
  const [attempts, setAttempts] = useState('1');
  const [examSettings, setExamSettings] = useState<ExamSettings>(DEFAULT_EXAM_SETTINGS);
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
  const [loadingBank, setLoadingBank] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);
  const bankRequest = useRef(0);

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
        setExamSettings({ ...DEFAULT_EXAM_SETTINGS, ...(draft.exam_settings as ExamSettings) });
        setShowScores(draft.show_scores);
        setQuizType(draft.quiz_type || 'anytime');
        setWindowOpensAt(draft.window_opens_at ? utcToIstInput(draft.window_opens_at) : '');
        setWindowDuration(draft.window_duration_minutes ? String(draft.window_duration_minutes) : '');
        setLoadGen((g) => g + 1);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load quiz.');
    }
  }, [quizId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-read only the server's publish verdict after a question is added or
   * removed locally, without resetting the (possibly unsaved) settings form.
   */
  const refreshPublishStatus = useCallback(async () => {
    try {
      const res = await api.get<QuizDetailResponse>(`/quizzes/${quizId}`);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              versions: prev.versions.map((v) => {
                const fresh = res.versions.find((f) => f.id === v.id);
                return fresh ? { ...v, publish_problems: fresh.publish_problems, question_count: fresh.question_count } : v;
              }),
            }
          : prev,
      );
    } catch {
      // Non-fatal: the publish route still re-checks everything.
    }
  }, [quizId]);

  /**
   * Auto-update every 10 s while the tab is visible: questions, random slots,
   * publish status and versions come from the server (e.g. a co-instructor's
   * edits). Typed-but-unsaved input lives in separate state and is never
   * overwritten; only if the draft itself changed (published or replaced
   * elsewhere) is the whole page reloaded.
   */
  const [lastSync, setLastSync] = useState<number | null>(null);
  useEffect(() => {
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const res = await api.get<QuizDetailResponse>(`/quizzes/${quizId}`);
        let draftChanged = false;
        setDetail((prev) => {
          const before = prev?.versions.find((v) => v.status === 'draft')?.id;
          const after = res.versions.find((v) => v.status === 'draft')?.id;
          draftChanged = Boolean(prev) && before !== after;
          return res;
        });
        setLastSync(Date.now());
        if (draftChanged) void load();
      } catch {
        // Offline for a moment: try again on the next tick.
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void tick(), 10_000);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [quizId, load]);

  const draft = detail?.versions.find((v) => v.status === 'draft');
  const published = detail?.versions.find((v) => v.status === 'published');
  const editable = !!draft;
  // The server's own publish checks; the empty-quiz rule is repeated so it reacts instantly.
  const publishBlockers = draft
    ? draft.questions.length + (draft.slots?.length ?? 0) === 0
      ? ['Add at least one question before publishing.']
      : (draft.publish_problems ?? []).filter((p) => !p.startsWith('Add at least one question'))
    : [];

  // ------------------------------------------------ settings auto-save
  // Every settings field saves itself ~1.5 s after the last change, so nobody
  // loses settings by forgetting a button. Saves run one at a time, in order.
  const metaPayload = useMemo(
    () => ({
      title,
      instructions,
      duration_minutes: duration === '' ? null : Number(duration),
      shuffle_questions: shuffleQ ? 1 : 0,
      shuffle_options: shuffleO ? 1 : 0,
      attempts_allowed: Number(attempts),
      exam_settings: examSettings,
      show_scores: showScores,
      quiz_type: quizType,
      window_opens_at: quizType === 'scheduled' ? (istInputToUtcIso(windowOpensAt) ?? '') : null,
      window_duration_minutes: quizType === 'scheduled' ? Number(windowDuration) : null,
    }),
    [title, instructions, duration, shuffleQ, shuffleO, attempts, examSettings, showScores, quizType, windowOpensAt, windowDuration],
  );
  const metaKey = JSON.stringify(metaPayload);
  /** A scheduled quiz can only be saved once its window has a start and a length. */
  const metaIncomplete =
    quizType === 'scheduled' && (!istInputToUtcIso(windowOpensAt) || !(Number(windowDuration) > 0));
  const latestMeta = useRef({ key: metaKey, payload: metaPayload, incomplete: metaIncomplete });
  latestMeta.current = { key: metaKey, payload: metaPayload, incomplete: metaIncomplete };
  const savedMetaKey = useRef<string | null>(null);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const [autoSave, setAutoSave] = useState<{
    state: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'incomplete';
    at?: number;
    message?: string;
  }>({ state: 'idle' });

  // After load() fills the form, the values on screen are what the server has.
  useEffect(() => {
    if (loadGen === 0) return;
    savedMetaKey.current = latestMeta.current.key;
    setAutoSave({ state: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadGen]);

  /** Save the current settings (queued behind any save already running). Resolves true when saved. */
  const saveMetaNow = useCallback((): Promise<boolean> => {
    saveChain.current = saveChain.current.then(async () => {
      const { key, payload, incomplete } = latestMeta.current;
      if (key === savedMetaKey.current) return true;
      if (incomplete) {
        setAutoSave({ state: 'incomplete' });
        return false;
      }
      setSavingMeta(true);
      setAutoSave({ state: 'saving' });
      try {
        await api.put(`/quizzes/${quizId}`, payload);
        savedMetaKey.current = key;
        setAutoSave({ state: latestMeta.current.key === key ? 'saved' : 'pending', at: Date.now() });
        // Refresh rules/preview from the server without touching the form.
        void api
          .get<QuizDetailResponse>(`/quizzes/${quizId}`)
          .then((res) => setDetail(res))
          .catch(() => {});
        return true;
      } catch (err) {
        setAutoSave({ state: 'error', message: err instanceof ApiError ? err.message : 'Could not reach the server.' });
        return false;
      } finally {
        setSavingMeta(false);
      }
    });
    return saveChain.current;
  }, [quizId]);

  // Debounced auto-save whenever a setting changes.
  useEffect(() => {
    if (!editable || savedMetaKey.current === null || metaKey === savedMetaKey.current) return;
    if (metaIncomplete) {
      setAutoSave({ state: 'incomplete' });
      return;
    }
    setAutoSave((s) => (s.state === 'saving' ? s : { state: 'pending' }));
    const t = window.setTimeout(() => void saveMetaNow(), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaKey, metaIncomplete]);

  // Warn before leaving the page with settings that are not saved yet.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (savedMetaKey.current !== null && latestMeta.current.key !== savedMetaKey.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  if (!detail) return error ? <div className="banner error" role="alert">{error}</div> : <p className="muted">Loading quiz…</p>;


  const saveMeta = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const ok = await saveMetaNow();
    if (ok) toast.success('Quiz settings saved');
  };

  const publish = async () => {
    // Publish exactly what is on screen: finish any pending settings save first.
    if (!(await saveMetaNow())) {
      setError(
        latestMeta.current.incomplete
          ? 'Set the window opening time and duration before publishing.'
          : 'Your latest settings could not be saved, so the quiz was not published. Fix the message under Settings and try again.',
      );
      return;
    }
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
    setError(null);
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
      void refreshPublishStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add question.');
    }
  };

  const saveEdit = async (q: QuestionEditor) => {
    const payload = edits[q.id];
    if (!payload) return;
    setError(null);
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
      void refreshPublishStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete question.');
    }
  };

  // Item 7: published questions are frozen structurally, but the answer key can be
  // re-keyed in place via PATCH /quizzes/questions/:id/answer.
  const saveAnswerKey = async (q: QuestionEditor) => {
    const edit = answerEdits[q.id];
    if (!edit) return;
    setError(null);
    try {
      // Regrades every submitted paper with the corrected key.
      const res = await api.post<{ regraded: number; changed: number }>(`/insights/questions/${q.id}/regrade`, {
        answer: edit.answer,
        tolerance: edit.tolerance !== undefined ? (edit.tolerance === '' ? 0 : Number(edit.tolerance)) : undefined,
      });
      setAnswerEdits((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      toast.success('Answer key updated', {
        description: res.regraded
          ? `${res.regraded} submitted paper(s) regraded — ${res.changed} score(s) changed.`
          : 'No submissions yet.',
      });
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update answer key.');
    }
  };

  const openBankModal = async () => {
    const request = ++bankRequest.current;
    setShowBankModal(true);
    setBanks([]);
    setSelectedBankId('');
    setBankQuestions([]);
    setBankError(null);
    setLoadingBank(true);
    try {
      const res = await api.get<{ banks: QuestionBank[] }>(`/banks/course/${detail.course_id}`);
      if (request === bankRequest.current) setBanks(res.banks);
    } catch (err) {
      if (request === bankRequest.current) setBankError('Failed to load course question banks.');
    } finally {
      if (request === bankRequest.current) setLoadingBank(false);
    }
  };

  const handleSelectBank = async (bId: number | '') => {
    const request = ++bankRequest.current;
    setSelectedBankId(bId);
    setBankQuestions([]);
    setBankError(null);
    setLoadingBank(bId !== '');
    if (bId === '') return;
    try {
      const res = await api.get<{ questions: BankQuestion[] }>(`/banks/${bId}`);
      if (request === bankRequest.current) setBankQuestions(res.questions);
    } catch (err) {
      if (request === bankRequest.current) setBankError('Failed to load bank questions. Choose the bank again to retry.');
    } finally {
      if (request === bankRequest.current) setLoadingBank(false);
    }
  };

  /** Swap in the server's copy of a version after a slot was added/removed. */
  const replaceVersion = (version: VersionDetail) =>
    setDetail((prev) => (prev ? { ...prev, versions: prev.versions.map((v) => (v.id === version.id ? version : v)) } : prev));

  const importBankQuestion = async (bq: BankQuestion) => {
    if (!draft) return;
    setError(null);
    try {
      setImportingBank(true);
      const res = await api.post<{ question: QuestionEditor }>(`/quizzes/${quizId}/questions`, {
        qtype: bq.qtype,
        text: bq.text,
        options: bq.options,
        answer: bq.answer,
        tolerance: bq.tolerance,
        points: bq.points,
        negative_points: bq.negative_points ?? 0,
        allow_assumptions: Boolean(bq.allow_assumptions),
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
      void refreshPublishStatus();
    } catch (err) {
      setError('Failed to import question from bank.');
    } finally {
      setImportingBank(false);
    }
  };

  return (
    <Page
      title={
        <div className="flex flex-wrap items-center gap-2.5">
          <span>{title || 'Untitled quiz'}</span>
          {draft && <Badge variant="warning">Draft v{draft.version}</Badge>}
          {published && <Badge variant="success">Live v{published.version}</Badge>}
        </div>
      }
      description={`Course ID #${detail.course_id} · ${draft ? `Editing draft v${draft.version}` : `Viewing published v${published?.version}`}${published && published.quiz_type === 'scheduled' && published.window_opens_at ? ` · Opens ${formatIST(published.window_opens_at)} for ${published.window_duration_minutes} min` : ''}`}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <Button asChild variant="secondary" size="sm">
            <a href={`/courses/${detail.course_id}`}>
              <ChevronLeft className="size-4" />
              Back
            </a>
          </Button>
          {editable && (
            <>
              <Button size="sm" variant="secondary" onClick={() => void openBankModal()}>
                Import from Bank
              </Button>
              <ConfirmAction
                title="Publish this version to students?"
                description={
                  <>
                    <p>
                      Students can see it and start as soon as its rules allow. The questions and exam rules are then
                      frozen: later edits go into a new draft version, and students who already started stay on this one.
                    </p>
                    <p className="mt-2">Your settings are saved automatically; any change still pending is saved before publishing.</p>
                    {draft.quiz_type === 'scheduled' && draft.window_opens_at && (() => {
                      const w = windowStatus(draft.window_opens_at, draft.window_duration_minutes);
                      if (!w || w.state !== 'open') return null;
                      const minsAgo = Math.round((serverNow() - w.opensMs) / 60_000);
                      const minsLeft = Math.max(0, Math.round((w.closesMs - serverNow()) / 60_000));
                      return (
                        <p className="mt-2 rounded-[var(--radius-md)] border border-[var(--warning)]/50 bg-[var(--warning)]/10 p-2 text-foreground" role="alert">
                          <strong>The window already opened</strong> at {formatIST(w.opensMs, 'timeShort')} ({minsAgo} min ago).
                          Students will have only {minsLeft} min left before it closes at {formatIST(w.closesMs, 'timeShort')}.
                          To give the full time, cancel and set a later opening time.
                        </p>
                      );
                    })()}
                  </>
                }
                confirmLabel="Publish"
                onConfirm={() => void publish()}
              >
                <Button
                  size="sm"
                  disabled={publishBlockers.length > 0}
                  aria-describedby={publishBlockers.length > 0 ? 'publish-blockers' : undefined}
                  title={publishBlockers.length > 0 ? `Can't publish yet: ${publishBlockers.join(' ')}` : undefined}
                >
                  Publish live version
                </Button>
              </ConfirmAction>
            </>
          )}
          {!editable && published && (
            <Button size="sm" onClick={() => void cloneDraft()}>
              Create new draft version
            </Button>
          )}
          {published && (
            <Button asChild size="sm" variant="secondary">
              <a href={`/quizzes/${quizId}/monitor`}>
                <Radio className="size-4" />
                Live monitor
              </a>
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
      {error && <div className="banner error" role="alert">{error}</div>}

      <p className="mt-2 text-xs text-muted-foreground" aria-live="off">
        Updates automatically every 10 seconds
        {lastSync ? ` · last updated ${formatIST(deviceToServerMs(lastSync), 'time')}` : ''}. Unsaved typing is kept.
      </p>

      {editable && publishBlockers.length > 0 && (
        <div
          id="publish-blockers"
          role="status"
          className="mt-4 rounded-[var(--radius-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/8 p-4 text-sm"
        >
          <p className="font-semibold">Publish is turned off until you fix {publishBlockers.length === 1 ? 'this' : 'these'}:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {publishBlockers.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={showBankModal} onOpenChange={(open) => {
        setShowBankModal(open);
        if (!open) {
          ++bankRequest.current;
          setLoadingBank(false);
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add questions from a bank</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="bank-select">Select Bank</Label>
              <select
                id="bank-select"
                value={selectedBankId}
                onChange={(e) => void handleSelectBank(e.target.value === '' ? '' : Number(e.target.value))}
                className="mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40"
              >
                <option value="">-- Choose a Question Bank --</option>
                {banks.map((b) => {
                  const n = b.question_count ?? 0;
                  return (
                    <option key={b.id} value={b.id} disabled={n === 0}>
                      {b.name} ({n === 0 ? 'empty — add questions first' : `${n} question${n === 1 ? '' : 's'}`})
                    </option>
                  );
                })}
              </select>
            </div>

            {!loadingBank && !bankError && selectedBankId === '' && banks.every((b) => (b.question_count ?? 0) === 0) && (
              <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">
                  {banks.length === 0 ? 'This course has no question banks yet.' : 'All question banks in this course are empty.'}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Add questions to a bank before using it in a quiz, or write questions directly in this quiz instead.
                </p>
                <a href={`/courses/${detail.course_id}/banks`} className="mt-2 inline-block font-medium text-primary underline underline-offset-2">
                  Go to question banks
                </a>
              </div>
            )}

            {!loadingBank && !bankError && selectedBankId !== '' && bankQuestions.length === 0 && (
              <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">This bank has no questions, so there is nothing to add.</p>
                <a href={`/courses/${detail.course_id}/banks`} className="mt-2 inline-block font-medium text-primary underline underline-offset-2">
                  Go to question banks
                </a>
              </div>
            )}

            {loadingBank && <p role="status" className="text-sm text-muted-foreground">Loading question bank…</p>}
            {bankError && (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">{bankError}</p>
                <Button variant="secondary" size="sm" onClick={() => void (selectedBankId === '' ? openBankModal() : handleSelectBank(selectedBankId))}>
                  Retry bank load
                </Button>
              </div>
            )}

            {selectedBankId !== '' && bankQuestions.length > 0 && (
              <RandomFromBank
                quizId={Number(quizId)}
                bankId={Number(selectedBankId)}
                bankName={banks.find((b) => b.id === selectedBankId)?.name ?? 'this bank'}
                questions={bankQuestions}
                existingSlots={draft?.slots ?? []}
                bankPageHref={`/courses/${detail.course_id}/banks`}
                showTimeLimit={examSettings.question_timer === 'per_question'}
                onAdded={(v) => {
                  replaceVersion(v);
                  setShowBankModal(false);
                }}
              />
            )}

            {bankQuestions.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Or copy specific questions ({bankQuestions.length}) — every student gets these</h4>
                {bankQuestions.map((bq) => (
                  <Card key={bq.id}>
                    <CardContent className="p-3 flex justify-between items-center">
                      <div className="flex-1 mr-3">
                        <div className="text-xs text-muted-foreground mb-1">
                          {bq.qtype.toUpperCase()} · {marksLabel(bq.points, bq.negative_points)} · {bq.difficulty ?? 'medium'}
                          {bq.tags.length ? ` · ${bq.tags.join(', ')}` : ''}
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
                    <Label htmlFor="window-opens">Window opens at (IST)</Label>
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
                  {(() => {
                    const opensIso = istInputToUtcIso(windowOpensAt);
                    const mins = Number(windowDuration);
                    if (!opensIso || !(mins > 0)) return null;
                    const closesMs = new Date(opensIso).getTime() + mins * 60_000;
                    const past = closesMs <= serverNow();
                    return (
                      <p className={`col-span-2 text-xs ${past ? 'text-destructive' : 'text-muted-foreground'}`} role={past ? 'alert' : undefined}>
                        Opens {formatIST(opensIso)} · closes {formatIST(closesMs)}
                        {past ? ' — this is already in the past (server time), so students could not take it.' : ''}
                      </p>
                    );
                  })()}
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
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={!editable || savingMeta} variant="secondary" size="sm">
                  {savingMeta ? 'Saving…' : 'Save now'}
                </Button>
                {editable && <AutoSaveStatus status={autoSave} onRetry={() => void saveMetaNow()} />}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="h-full flex flex-col">
          <CardContent className="p-6 flex-1">
            <h3 className="text-lg font-semibold mb-4">
              Questions ({(draft ?? published ?? detail.versions[0])
                ? (draft ?? published ?? detail.versions[0])!.questions.length + ((draft ?? published ?? detail.versions[0])!.slots?.length ?? 0)
                : 0})
            </h3>
            {draft && draft.questions.length + (draft.slots?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground mb-4">
                Add your first question below. You need at least one before publishing.
              </p>
            )}
            {editable && (
              <form onSubmit={saveNewQuestion} className="space-y-4 border-t border-border pt-4 mt-4">
                <QuestionFields q={newQ} setQ={setNewQ} showTimeLimit={examSettings.question_timer === 'per_question'} defaultSeconds={examSettings.question_time_seconds} />
                <Button type="submit" size="sm">
                  Add question
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardContent className="p-6">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-semibold">
                <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
                Exam rules & proctoring
              </h3>
              <p className="text-sm text-muted-foreground">
                Tab and window switching, copy & paste, full screen, exit & resume, timers and access. Frozen when you
                publish, like the questions.
              </p>
            </div>
            {editable && (
              <div className="flex flex-col items-end gap-1">
                <Button size="sm" variant="secondary" disabled={savingMeta} onClick={() => void saveMeta()}>
                  {savingMeta ? 'Saving…' : 'Save now'}
                </Button>
                <AutoSaveStatus status={autoSave} onRetry={() => void saveMetaNow()} />
              </div>
            )}
          </div>
          <ExamSettingsPanel
            value={examSettings}
            onChange={setExamSettings}
            disabled={!editable}
            questionCount={(draft ?? published)?.question_count ?? 0}
            scheduled={quizType === 'scheduled'}
          />
          {(draft ?? published)?.rules && (
            <div className="mt-4 rounded-[var(--radius-md)] bg-muted/60 p-4">
              <p className="mb-1 text-sm font-semibold">What students will read before starting (as last saved)</p>
              <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                {(draft ?? published)!.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {draft && draft.questions.length + (draft.slots?.length ?? 0) > 0 && (
        <section className="mt-6">
          <h3 className="text-lg font-semibold mb-4">Question list</h3>
          {(draft.slots?.length ?? 0) > 0 && (
            <div className="mb-3">
              <p className="mb-2 text-sm text-muted-foreground">
                Random questions — each student gets a different bank question here:
              </p>
              <SlotList slots={draft.slots} editable onChanged={replaceVersion} />
            </div>
          )}
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
                        <span className="text-sm text-muted-foreground">{marksLabel(q.points, q.negative_points)}</span>
                        {examSettings.question_timer === 'per_question' && (
                          <Badge variant="outline">{q.time_limit_seconds ?? examSettings.question_time_seconds}s</Badge>
                        )}
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
                        <QuestionFields
                          q={edit}
                          setQ={(next) => setEdits({ ...edits, [q.id]: next })}
                          showTimeLimit={examSettings.question_timer === 'per_question'}
                          defaultSeconds={examSettings.question_time_seconds}
                        />
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
          {(published.slots?.length ?? 0) > 0 && (
            <div className="mb-3">
              <p className="mb-2 text-sm text-muted-foreground">
                Random questions — answer keys come from the bank questions each student drew:
              </p>
              <SlotList slots={published.slots} editable={false} />
            </div>
          )}
          <div className="flex flex-col gap-3">
            {published.questions.map((q) => {
              const edit = answerEdits[q.id];
              return (
                <Card key={q.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <strong>Q{q.order_index + 1}</strong>
                      <Badge variant="secondary">{q.qtype}</Badge>
                      <span className="text-sm text-muted-foreground">{marksLabel(q.points, q.negative_points)}</span>
                      {q.allow_assumptions && <Badge variant="outline">assumptions allowed</Badge>}
                      {q.grading_mode && q.grading_mode !== 'normal' && (
                        <Badge variant="warning">{q.grading_mode === 'dropped' ? 'dropped' : 'full marks for all'}</Badge>
                      )}
                    </div>
                    <div className="mt-2 mb-4">
                      <RichText content={q.text} />
                    </div>
                    {q.qtype === 'descriptive' ? (
                    <div className="border-t border-border pt-4 text-sm">
                      <Label className="text-sm font-semibold mb-2 block">Marking guide</Label>
                      <p className="whitespace-pre-wrap text-muted-foreground">
                        {typeof q.answer === 'string' && q.answer ? q.answer : 'No marking guide.'}
                      </p>
                      <p className="mt-2 text-muted-foreground">Marked by hand under Analytics → Marking.</p>
                    </div>
                    ) : (
                    <div className="border-t border-border pt-4">
                      <Label className="text-sm font-semibold mb-2 block">Edit answer key (regrades submitted papers)</Label>
                      {(q.qtype === 'single' || q.qtype === 'multiple') && (
                        <div className="space-y-2">
                          {q.options.map((opt, idx) => {
                            const isChecked =
                              edit
                                ? q.qtype === 'single'
                                  ? Number(edit.answer) === idx
                                  : Array.isArray(edit.answer) && edit.answer.includes(idx)
                                : q.qtype === 'single'
                                ? Number(q.answer) === idx
                                : Array.isArray(q.answer) && q.answer.includes(idx);
                            return (
                              <label
                                key={idx}
                                className={`flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2 text-sm transition-colors ${
                                  isChecked
                                    ? 'border-primary bg-primary/5'
                                    : 'border-border hover:bg-accent/40'
                                }`}
                              >
                                <input
                                  type={q.qtype === 'single' ? 'radio' : 'checkbox'}
                                  name={`answer-${q.id}`}
                                  checked={isChecked}
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
                                  className="size-4 shrink-0 accent-[var(--primary)]"
                                />
                                <span className="flex-1">
                                  <RichText content={opt} />
                                </span>
                                {isChecked && (
                                  <Badge variant="success" className="shrink-0">
                                    Correct
                                  </Badge>
                                )}
                              </label>
                            );
                          })}
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
                    )}
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

/** Auto-save state for the settings form, e.g. "All changes saved · 10:02:31 am IST". */
function AutoSaveStatus({
  status,
  onRetry,
}: {
  status: { state: 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'incomplete'; at?: number; message?: string };
  onRetry: () => void;
}) {
  const base = 'text-xs';
  switch (status.state) {
    case 'saving':
      return <span className={`${base} text-muted-foreground`} role="status">Saving…</span>;
    case 'pending':
      return <span className={`${base} text-muted-foreground`} role="status">Unsaved changes — saving shortly…</span>;
    case 'saved':
      return (
        <span className={`${base} text-[var(--success)]`} role="status">
          All changes saved{status.at ? ` · ${formatIST(deviceToServerMs(status.at), 'time')}` : ''}
        </span>
      );
    case 'incomplete':
      return (
        <span className={`${base} text-[var(--warning)]`} role="status">
          Set the window opening time and duration — then it saves automatically.
        </span>
      );
    case 'error':
      return (
        <span className={`${base} text-destructive`} role="alert">
          Not saved: {status.message}{' '}
          <button type="button" className="underline underline-offset-2" onClick={onRetry}>
            Retry
          </button>
        </span>
      );
    default:
      return <span className={`${base} text-muted-foreground`}>Changes save automatically.</span>;
  }
}

function questionToEdit(q: QuestionEditor): ReturnType<typeof EMPTY_QUESTION> {
  return {
    qtype: q.qtype,
    text: q.text,
    options: q.options.length ? q.options : ['', ''],
    answer: q.answer as number | number[] | string,
    tolerance: q.tolerance == null ? '0.01' : String(q.tolerance),
    points: String(q.points),
    negative_points: String(q.negative_points ?? 0),
    time_limit_seconds: q.time_limit_seconds == null ? '' : String(q.time_limit_seconds),
    allow_assumptions: Boolean(q.allow_assumptions),
    id: q.id,
  };
}

function buildQuestionPayload(q: ReturnType<typeof EMPTY_QUESTION>) {
  const body: Record<string, unknown> = {
    qtype: q.qtype,
    text: q.text,
    points: q.points,
    negative_points: q.qtype === 'descriptive' || q.negative_points.trim() === '' ? 0 : q.negative_points,
    time_limit_seconds: q.time_limit_seconds === '' ? null : Number(q.time_limit_seconds),
    allow_assumptions: q.allow_assumptions,
  };
  if (q.qtype === 'single' || q.qtype === 'multiple') {
    body.options = q.options;
  }
  if (q.qtype === 'single') body.answer = Number(q.answer);
  if (q.qtype === 'multiple') {
    body.answer = Array.isArray(q.answer) ? q.answer.map(Number) : [];
  }
  if (q.qtype === 'numeric') {
    body.answer = q.answer;
    body.tolerance = q.tolerance === '' ? 0 : Number(q.tolerance);
  }
  if (q.qtype === 'short' || q.qtype === 'descriptive') {
    body.answer = typeof q.answer === 'string' ? q.answer : '';
  }
  return body;
}

function QuestionFields({
  q,
  setQ,
  showTimeLimit = false,
  defaultSeconds = 60,
}: {
  q: ReturnType<typeof EMPTY_QUESTION>;
  setQ: (next: ReturnType<typeof EMPTY_QUESTION>) => void;
  showTimeLimit?: boolean;
  defaultSeconds?: number;
}) {
  const set = (patch: Partial<ReturnType<typeof EMPTY_QUESTION>>) => setQ({ ...q, ...patch });
  const prefix = q.id == null ? 'q' : `q-${q.id}`;
  const fieldId = (name: string) => `${prefix}-${name}`;
  const correctGroup = q.id == null ? 'correct' : `correct-${q.id}`;

  return (
    <div>
      <input type="hidden" />
      <div className="field">
        <label htmlFor={fieldId('text')}>
          Question text (LaTeX: $x^2$, $$\int_0^1 x\,dx$$, \textbf&#123;…&#125;, \begin&#123;enumerate&#125;… — Markdown **bold** also works)
        </label>
        <textarea id={fieldId('text')} rows={3} value={q.text} onChange={(e) => set({ text: e.target.value })} />
        <div className="mt-2">
          <LatexPaste
            onParsed={(p) => {
              const choice = p.options.length >= 2;
              const qtype: QuestionType = choice ? (p.correct.length > 1 ? 'multiple' : 'single') : q.qtype;
              set({
                text: p.text,
                ...(choice
                  ? {
                      qtype,
                      options: p.options,
                      answer: qtype === 'multiple' ? p.correct : (p.correct[0] ?? -1),
                    }
                  : {}),
              });
              toast.success(
                choice
                  ? `Filled the question and ${p.options.length} options${p.correct.length ? '' : ' — now tick the correct one'}.`
                  : 'Filled the question text.',
              );
              if (p.more > 0) toast.info(`Found ${p.more + 1} questions; only the first was used. Paste the others one at a time.`);
            }}
          />
        </div>
        <RichPreview content={q.text} label="Live preview" />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor={fieldId('type')}>Type</label>
          <select id={fieldId('type')} value={q.qtype} onChange={(e) => {
            const qtype = e.target.value as QuestionType;
            set({ qtype, answer: qtype === 'single' ? 0 : qtype === 'multiple' ? [] : '' });
          }}>
            <option value="single">Single choice</option>
            <option value="multiple">Multiple choice</option>
            <option value="short">Short answer</option>
            <option value="numeric">Numeric</option>
            <option value="descriptive">Descriptive (marked by hand)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={fieldId('points')}>{q.qtype === 'descriptive' ? 'Marks (out of)' : 'Points'}</label>
          <input id={fieldId('points')} type="number" min={0.25} step={0.25} value={q.points} onChange={(e) => set({ points: e.target.value })} />
        </div>
        {q.qtype !== 'descriptive' && (
          <div className="field">
            <label htmlFor={fieldId('negative')}>Negative marks (wrong answer)</label>
            <input
              id={fieldId('negative')}
              type="number"
              min={0}
              step={0.25}
              value={q.negative_points}
              onChange={(e) => set({ negative_points: e.target.value })}
              aria-describedby={fieldId('negative-hint')}
            />
            <span id={fieldId('negative-hint')} className="muted small">
              {Number(q.negative_points) > 0
                ? `Right +${q.points || 0}, wrong −${q.negative_points}, blank 0.`
                : '0 = no negative marking.'}
            </span>
          </div>
        )}
        {showTimeLimit && (
          <div className="field">
            <label htmlFor={fieldId('time')}>Time limit (seconds)</label>
            <input
              id={fieldId('time')}
              type="number"
              min={5}
              max={7200}
              placeholder={`${defaultSeconds} (default)`}
              value={q.time_limit_seconds}
              onChange={(e) => set({ time_limit_seconds: e.target.value })}
            />
          </div>
        )}
      </div>

      {(q.qtype === 'single' || q.qtype === 'multiple') && (
        <div className="field">
          <label htmlFor={fieldId('options')}>
            Options (one per line). Mark the correct one{q.qtype === 'multiple' ? 's (check ' + (Array.isArray(q.answer) ? (q.answer as unknown[]).length : 0) + ' selected)' : ''}.
          </label>
          <textarea
            id={fieldId('options')}
            rows={3}
            value={q.options.join('\n')}
            onChange={(e) => {
              const options = e.target.value.split('\n');
              let answer: number | number[] = q.qtype === 'single' ? Number(q.answer) : (Array.isArray(q.answer) ? q.answer.filter((i) => i < options.length) : []);
              if (q.qtype === 'single' && Number(answer) >= options.length) {
                answer = -1;
              }
              set({ options, answer });
            }}
          />
          <div style={{ marginTop: '0.5rem' }} role={q.qtype === 'single' ? 'radiogroup' : 'group'} aria-label="correct options">
            {q.options.map((o, i) =>
              o.trim() === '' ? null : (
                <label key={i} className="option" style={{ marginTop: '0.35rem' }}>
                  <input
                    type={q.qtype === 'single' ? 'radio' : 'checkbox'}
                    name={correctGroup}
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
            <label htmlFor={fieldId('num')}>Expected number</label>
            <input id={fieldId('num')} type="number" step="any" value={String(q.answer ?? '')} onChange={(e) => set({ answer: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={fieldId('tol')}>Tolerance (±)</label>
            <input id={fieldId('tol')} type="number" step="any" min={0} value={q.tolerance} onChange={(e) => set({ tolerance: e.target.value })} />
          </div>
        </div>
      )}

      {q.qtype === 'short' && (
        <div className="field">
          <label htmlFor={fieldId('short')}>Accepted answer (case-insensitive)</label>
          <input id={fieldId('short')} value={String(q.answer ?? '')} onChange={(e) => set({ answer: e.target.value })} />
        </div>
      )}

      {q.qtype === 'descriptive' && (
        <div className="field">
          <label htmlFor={fieldId('guide')}>Model answer / marking guide (optional — shown to graders, never to students before release)</label>
          <textarea
            id={fieldId('guide')}
            rows={3}
            value={typeof q.answer === 'string' ? q.answer : ''}
            onChange={(e) => set({ answer: e.target.value })}
            placeholder="e.g. 2 marks: states Fitts's law. 2 marks: explains distance vs width. 1 mark: an example."
          />
          <p className="muted small mt-1">
            Written answers are never auto-graded. After the exam you mark each one out of {q.points} under
            Analytics → Marking; students see their score once marking is done.
          </p>
        </div>
      )}

      <label className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={q.allow_assumptions}
          onChange={(e) => set({ allow_assumptions: e.target.checked })}
          style={{ width: 'auto', marginTop: 3 }}
        />
        <span>
          <strong>Allow assumptions</strong> — students get a box to write any assumption they made. You can read
          them while marking and award marks for a reasonable one.
        </span>
      </label>
    </div>
  );
}

function toggleMulti(current: unknown, index: number): number[] {
  const arr = Array.isArray(current) ? (current as unknown[]).map(Number) : [];
  return arr.includes(index) ? arr.filter((i) => i !== index) : [...arr, index];
}