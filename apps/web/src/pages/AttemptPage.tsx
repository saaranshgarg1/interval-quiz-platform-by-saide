import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  CheckCircle2,
  Clock,
  Save,
  AlertTriangle,
  Lock,
  ChevronLeft,
  ChevronRight,
  Flag,
  FlagOff,
} from 'lucide-react';
import { api, ApiError } from '../api';
import type { AttemptView, SubmitResult } from '../types';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Progress } from '../components/ui/progress';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
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
} from '../components/ui/alert-dialog';
import { Input } from '../components/ui/input';
import { RichText } from '../components/RichText';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface LocalAnswer {
  value: unknown;
  revision: number;
  serverRevision: number;
}

export function AttemptPage() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<AttemptView | null>(null);
  const [answers, setAnswers] = useState<Record<number, LocalAnswer>>({});
  const [current, setCurrent] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [serverNow, setServerNow] = useState<string | null>(null);
  const [clientBoot, setClientBoot] = useState(0);
  const [locked, setLocked] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [expiredScreen, setExpiredScreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [flagged, setFlagged] = useState<Record<number, boolean>>({});
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);

  const localRef = useRef(answers);
  localRef.current = answers;
  const submitResultRef = useRef(submitResult);

  const load = useCallback(async () => {
    try {
      const res = await api.get<AttemptView>(`/attempts/${attemptId}`);
      setView(res);
      setServerNow(res.attempt.server_now);
      setClientBoot(Date.now());
      setLocked(res.attempt.status === 'locked' || res.attempt.status === 'under_review');
      if (res.attempt.status === 'expired') setExpiredScreen(true);
      if (res.attempt.status === 'submitted') {
        const existing = submitResultRef.current;
        setSubmitResult(existing ?? null);
      }
      const seeded: Record<number, LocalAnswer> = {};
      for (const [qid, a] of Object.entries(res.answers)) {
        seeded[Number(qid)] = { value: a.answer, revision: a.revision, serverRevision: a.revision };
      }
      setAnswers((prev) => (Object.keys(prev).length ? prev : seeded));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load attempt.');
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  const questions = view?.questions ?? [];
  const activeMeta = view?.attempt;

  const offsetMs = useMemo(() => {
    if (!serverNow || !clientBoot) return 0;
    return new Date(serverNow.replace(' ', 'T') + 'Z').getTime() - clientBoot;
  }, [serverNow, clientBoot]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const serverEpoch = now + offsetMs;
  const deadline = activeMeta?.expires_at ? new Date(activeMeta.expires_at.replace(' ', 'T') + 'Z').getTime() : null;
  const msLeft = deadline ? deadline - serverEpoch : null;

  // ---- answer + save machinery ------------------------------------------
  const setAnswer = useCallback((questionId: number, value: unknown) => {
    setAnswers((prev) => {
      const cur = prev[questionId] ?? { value: undefined, revision: 0, serverRevision: 0 };
      return { ...prev, [questionId]: { value, revision: cur.revision + 1, serverRevision: cur.serverRevision } };
    });
  }, []);

  const flushSave = useCallback(async () => {
    const all = localRef.current;
    const items = Object.entries(all)
      .filter(([, a]) => a.revision > a.serverRevision)
      .map(([qid, a]) => ({ question_id: Number(qid), answer: a.value, revision: a.revision }));
    if (items.length === 0) return;
    setSaveState('saving');
    try {
      const res = await api.put<{ acks: { question_id: number; revision: number; saved_at: string }[] }>(
        `/attempts/${attemptId}/answers`,
        { answers: items },
      );
      const ackMap = new Map(res.acks.map((a) => [a.question_id, a.revision]));
      setAnswers((prev) => {
        const next: Record<number, LocalAnswer> = {};
        for (const [qid, a] of Object.entries(prev)) {
          const n = Number(qid);
          next[n] = { ...a, serverRevision: ackMap.get(n) ?? a.serverRevision };
        }
        return next;
      });
      const latest = res.acks.map((a) => a.saved_at).sort().at(-1);
      setSaveState('saved');
      if (latest) {
        setLastSavedAt(latest);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Attempt no longer active (locked, submitted or expired) — refresh state.
        await load();
        return;
      }
      setSaveState('error');
    }
  }, [attemptId, load]);

  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlight = useRef(false);
  const pendingRef = useRef(false);

  const dirty = useMemo(() => {
    return Object.entries(answers).some(([, a]) => a.revision > a.serverRevision);
  }, [answers]);

  // debounced drain
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!dirty) return;
    if (saveInFlight.current) {
      pendingRef.current = true;
      return;
    }
    if (submitResult) return;
    if (locked) return;
    saveTimer.current = setTimeout(() => void drain(), 700);
  }, [dirty, locked, submitResult]);

  const drain = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    do {
      pendingRef.current = false;
      await flushSave();
    } while (pendingRef.current);
    saveInFlight.current = false;
  };

  // final flush before navigating away
  useEffect(() => {
    const onHide = () => {
      void drain();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drain]);

  // ---- policy event reporting --------------------------------------------
  const reportEvent = useCallback(
    async (kind: string, detail: string) => {
      if (!view) return;
      if (view.quiz.integrity_policy === 'off') return;
      if (view.attempt.status !== 'in_progress') return;
      try {
        const res = await api.post<{ action: string; lock: boolean; message?: string }>(`/attempts/${attemptId}/events`, {
          kind,
          detail,
        });
        if (res.action === 'recorded' && !res.lock) {
          setPolicyMsg(res.message ?? 'Event recorded.');
        }
        if (res.lock) {
          setLocked(true);
          setPolicyMsg(res.message ?? 'Attempt locked.');
          await load();
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 423) {
          setLocked(true);
          setPolicyMsg('Strict policy triggered — attempt locked.');
          await load();
          return;
        }
        /* reporting is best-effort */
      }
    },
    [attemptId, view, load],
  );

  useEffect(() => {
    if (!view || view.quiz.integrity_policy === 'off') return;
    let last = 0;
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        const t = Date.now();
        if (t - last > 2000) {
          last = t;
          void reportEvent('page_hidden', 'Page became hidden (visibilitychange).');
        }
      }
    };
    const onBlur = () => {
      const t = Date.now();
      if (t - last > 2000) {
        last = t;
        void reportEvent('focus_exit', 'Window lost focus');
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', onBlur);
    };
  }, [view, reportEvent]);

  const [policyMsg, setPolicyMsg] = useState<string | null>(null);

  // ---- keyboard navigation ------------------------------------------------
  useEffect(() => {
    if (locked || expiredScreen || submitResult) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      if (e.key === 'ArrowLeft' && current > 0) {
        e.preventDefault();
        setCurrent((c) => c - 1);
      } else if (e.key === 'ArrowRight' && current < questions.length - 1) {
        e.preventDefault();
        setCurrent((c) => c + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, questions.length, locked, expiredScreen, submitResult]);

  // ---- submit -------------------------------------------------------------
  const submit = async () => {
    setError(null);
    try {
      await drain();
      const res = await api.post<SubmitResult>(`/attempts/${attemptId}/submit`);
      setSubmitResult(res);
      submitResultRef.current = res;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          await load();
          setError('The attempt was finalized because its deadline passed or it was already submitted.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Submission failed. Try again.');
      }
    }
  };

  // ---- render --------------------------------------------------------------
  if (error && !view) return <div className="banner error">{error}</div>;
  if (!view || !activeMeta) return <p className="muted small">Loading attempt…</p>;

  if (locked) {
    return (
      <div className="player">
        <Card className="mx-auto max-w-md text-center">
          <CardHeader>
            <div className="mb-3 flex justify-center">
              <Lock className="size-10 text-destructive" aria-hidden="true" />
            </div>
            <CardTitle>Attempt locked</CardTitle>
            <CardDescription>
              The quiz's strict policy triggered because you left the quiz window. Your acknowledged answers are preserved and
              the deadline continues to run. You can resume only after an instructor or TA reviews and reinstates the attempt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 space-y-2 text-left">
              <p className="text-sm font-semibold">What happens next:</p>
              <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                <li>Your instructor sees this attempt under <strong>Incidents</strong>.</li>
                <li>They review the recorded events and your saved answers.</li>
                <li>If they reinstate the attempt, you can continue exactly where you left off.</li>
              </ol>
            </div>
            {policyMsg && <p className="text-xs text-muted-foreground">{policyMsg}</p>}
          </CardContent>
          <CardFooter className="flex justify-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>Back</Button>
            <Button variant="secondary" size="sm" onClick={() => void load()}>Check status</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (expiredScreen || activeMeta.status === 'expired') {
    return (
      <div className="player">
        <Card className="mx-auto max-w-md text-center">
          <CardHeader>
            <div className="mb-3 flex justify-center">
              <AlertTriangle className="size-10 text-warning" aria-hidden="true" />
            </div>
            <CardTitle>Attempt expired</CardTitle>
            <CardDescription>
              The deadline passed. Your last acknowledged answers were graded as-is.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {activeMeta.receipt && (
              <p className="font-mono text-sm break-all bg-muted px-3 py-1.5 rounded-[var(--radius-md)]">
                Receipt: {activeMeta.receipt}
              </p>
            )}
          </CardContent>
          <CardFooter className="flex justify-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>Back</Button>
            {activeMeta.receipt && (
              <Button variant="secondary" size="sm" onClick={() => navigate(`/results/attempt/${activeMeta.id}`)}>
                {view.quiz.integrity_policy ? 'View any released result' : 'View result'}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (submitResult && (activeMeta.status === 'submitted' || submitResult.status === 'submitted')) {
    const canView = activeMeta.score != null || activeMeta.receipt != null;
    return (
      <div className="player">
        <Card className="mx-auto max-w-md text-center">
          <CardHeader>
            <div className="mb-3 flex justify-center">
              <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
            </div>
            <CardTitle>Submitted</CardTitle>
            <CardDescription>Your answers were accepted by the server.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activeMeta.receipt && (
              <p className="font-mono text-sm break-all bg-muted px-3 py-1.5 rounded-[var(--radius-md)]" role="status">
                Receipt: <strong>{activeMeta.receipt}</strong>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Acknowledged answers: <strong>{submitResult.acknowledged_answers}</strong>
              {submitResult.policy.recorded > 0 ? ` · policy events recorded: ${submitResult.policy.recorded}` : ''}
            </p>
            {activeMeta.score != null && (
              <Badge variant="success" className="mx-auto">
                Score: {activeMeta.score}/{activeMeta.max_score}
              </Badge>
            )}
          </CardContent>
          {canView && (
            <CardFooter className="flex justify-center gap-3">
              <Button size="sm" onClick={() => navigate(`/results/attempt/${activeMeta.id}`)}>View result</Button>
              <Button variant="secondary" size="sm" onClick={() => navigate('/')}>Back to home</Button>
            </CardFooter>
          )}
        </Card>
      </div>
    );
  }

  const q = questions[current];
  const answeredCount = questions.filter((qs) => {
    const a = answers[qs.id];
    return a != null && !isEmptyAnswer(qs.qtype, a.value);
  }).length;

  const timerWarn = msLeft != null && msLeft < 60_000;
  const reduceMotion = useReducedMotion();

  return (
    <div className="player">
      {/* ---- header ---- */}
      <div className="player-header">
        <div className="grow min-w-0">
          <p className="font-display text-lg font-semibold text-foreground">{view.quiz.title}</p>
          <p className="text-sm text-muted-foreground">
            Q {current + 1} of {questions.length} · {answeredCount} answered
          </p>
        </div>
        <Progress
          value={Math.round(((current + 1) / questions.length) * 100)}
          className="w-32 shrink-0"
          aria-label={`Question ${current + 1} of ${questions.length}`}
        />
        {msLeft != null && (
          <Badge
            variant={timerWarn ? 'destructive' : 'secondary'}
            className="font-mono tabular-nums"
            role="timer"
            aria-label="time remaining"
          >
            <Clock className="mr-1 size-3" aria-hidden="true" />
            {formatMs(msLeft)}
          </Badge>
        )}
      </div>

      <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} />

      {policyMsg && <div className="banner warn small">{policyMsg}</div>}

      {/* ---- question card ---- */}
      <motion.div
        key={q.id}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={reduceMotion ? false : { opacity: 1, y: 0 }}
        exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
      >
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="capitalize">
                {q.qtype.replace('_', ' ')}
              </Badge>
              <Badge variant="secondary">{q.points} pt</Badge>
            </div>
            <CardTitle className="mt-2">
              <RichText content={q.text} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AnswerControl
              qtype={q.qtype}
              options={q.options}
              value={answers[q.id]?.value}
              onChange={(v) => setAnswer(q.id, v)}
            />
          </CardContent>
        </Card>
      </motion.div>

      {/* ---- question pager ---- */}
      <div className="question-pager" role="tablist" aria-label="Questions">
        {questions.map((qs, i) => {
          const a = answers[qs.id];
          const isAnswered = a != null && !isEmptyAnswer(qs.qtype, a.value);
          const isFlagged = !!flagged[qs.id];
          const isCurrent = i === current;
          return (
            <div key={qs.id} className="relative flex items-center">
              <button
                role="tab"
                aria-selected={isCurrent}
                aria-label={`Question ${i + 1}${isFlagged ? ', flagged' : ''}`}
                className={`relative q-dot ${isCurrent ? 'current' : ''} ${isAnswered ? 'answered' : ''} ${isFlagged ? 'flagged' : ''}`}
                onClick={() => setCurrent(i)}
                title={`Question ${i + 1}`}
              >
                {i + 1}
              </button>
              <button
                type="button"
                aria-label={isFlagged ? `Unflag question ${i + 1}` : `Flag question ${i + 1} for review`}
                title={isFlagged ? 'Unflag for review' : 'Flag for review'}
                className="absolute -top-1 -right-1 rounded-full p-0.5 hover:bg-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setFlagged((prev) => ({ ...prev, [qs.id]: !prev[qs.id] }));
                }}
              >
                {isFlagged ? (
                  <Flag className="size-3 text-warning" aria-hidden="true" />
                ) : (
                  <FlagOff className="size-3 text-muted-foreground/50" aria-hidden="true" />
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* ---- navigation + actions ---- */}
      <div className="mt-5 flex items-center justify-between flex-wrap gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={current === 0}
          onClick={() => setCurrent((c) => c - 1)}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Previous
        </Button>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void drain()}
            disabled={!dirty}
          >
            <Save className="size-4" aria-hidden="true" />
            Save now
          </Button>
          <AlertDialog open={submitDialogOpen} onOpenChange={setSubmitDialogOpen}>
            <AlertDialogTrigger asChild>
              <Button size="sm" disabled={questions.length === 0}>
                Submit attempt
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Submit attempt?</AlertDialogTitle>
                <AlertDialogDescription>
                  {(() => {
                    const unanswered = questions.filter((qs) => {
                      const a = answers[qs.id];
                      return !a || isEmptyAnswer(qs.qtype, a.value);
                    }).length;
                    return unanswered > 0
                      ? `You have not answered ${unanswered} question(s). Submit anyway? Answers cannot be changed after submission.`
                      : 'Submit your answers now? This is final.';
                  })()}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    setSubmitDialogOpen(false);
                    await submit();
                  }}
                >
                  Submit
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {current < questions.length - 1 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCurrent((c) => c + 1)}
          >
            Next <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {msLeft != null && msLeft <= 0 && (
        <div className="banner warn small mt-4">
          The deadline has passed. Your next save or submission will finalize this attempt as expired.
        </div>
      )}

      <p className="muted small mt-4">
        Your answers are sent to the server and acknowledged. If the network drops, your last acknowledged state is preserved.
        <Link to={`/quizzes/${view.quiz.id}`} className="block mt-1">
          ← Back to quiz
        </Link>
      </p>
    </div>
  );
}

function isEmptyAnswer(_qtype: string, v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function formatMs(ms: number): string {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function SaveIndicator({ state, lastSavedAt }: { state: SaveState; lastSavedAt: string | null }) {
  let label = 'All changes saved';
  let icon: React.ReactNode = <CheckCircle2 className="size-4 text-success" aria-hidden="true" />;
  if (state === 'saving') {
    label = 'Saving…';
    icon = <Clock className="size-4 text-warning animate-spin" aria-hidden="true" />;
  } else if (state === 'error') {
    label = 'Save failed — retrying';
    icon = <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />;
  } else if (lastSavedAt) {
    label = `Saved ${new Date(lastSavedAt.replace(' ', 'T') + 'Z').toLocaleTimeString()}`;
  }
  return (
    <div className="save-state" role="status" aria-live="polite">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function AnswerControl({
  qtype,
  options,
  value,
  onChange,
}: {
  qtype: 'single' | 'multiple' | 'short' | 'numeric';
  options: string[];
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (qtype === 'single') {
    return (
      <div role="radiogroup" aria-label="Options">
        {options.map((o, i) => {
          const selected = Number(value) === i;
          return (
            <label
              key={i}
              className={`option ${selected ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="ra"
                checked={selected}
                onChange={() => onChange(i)}
                aria-label={`Option ${i + 1}`}
              />
              <span className="option-label">
                <RichText content={o} />
              </span>
            </label>
          );
        })}
      </div>
    );
  }
  if (qtype === 'multiple') {
    const arr = Array.isArray(value) ? (value as unknown[]).map(Number) : [];
    return (
      <div role="group" aria-label="Options (select all that apply)">
        {options.map((o, i) => {
          const selected = arr.includes(i);
          return (
            <label
              key={i}
              className={`option ${selected ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => {
                  onChange(arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i]);
                }}
              />
              <span className="option-label">
                <RichText content={o} />
              </span>
            </label>
          );
        })}
      </div>
    );
  }
  if (qtype === 'numeric') {
    return (
      <Input
        type="number"
        step="any"
        value={typeof value === 'number' ? value : String(value ?? '')}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder="Enter a number"
      />
    );
  }
  return (
    <Input
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Type your answer"
    />
  );
}
