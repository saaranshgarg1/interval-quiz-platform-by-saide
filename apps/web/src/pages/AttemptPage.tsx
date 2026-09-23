import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { AttemptView, SubmitResult } from '../types';
import { Pill, IconCheck, IconClock, IconSave, IconAlert, IconLock } from '../components/ui';
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

  // ---- submit -------------------------------------------------------------
  const submit = async () => {
    const unanswered = questions.filter((qs) => {
      const a = answers[qs.id];
      return !a || isEmptyAnswer(qs.qtype, a.value);
    }).length;
    const ok = window.confirm(
      unanswered > 0
        ? `You have not answered ${unanswered} question(s). Submit anyway? Answers cannot be changed after submission.`
        : 'Submit your answers now? This is final.',
    );
    if (!ok) return;
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
  if (!view || !activeMeta) return <p className="muted">Loading attempt…</p>;

  if (locked) {
    return (
      <div className="player">
        <div className="card" style={{ textAlign: 'center', marginTop: '2rem', padding: '2rem 1.5rem' }}>
          <IconLock />
          <h1>Attempt locked</h1>
          <p className="muted">
            The quiz’s strict policy triggered because you left the quiz window. Your acknowledged answers are preserved and
            the deadline continues to run. You can resume only after an instructor or TA reviews and reinstates the attempt.
          </p>
          <div className="banner warn" style={{ textAlign: 'left' }}>
            <strong>What happens next:</strong>
            <ol className="small" style={{ margin: '0.4rem 0 0' }}>
              <li>Your instructor sees this attempt under <strong>Incidents</strong>.</li>
              <li>They review the recorded events and your saved answers.</li>
              <li>If they reinstate the attempt, you can continue exactly where you left off.</li>
            </ol>
          </div>
          {policyMsg && <p className="small muted">{policyMsg}</p>}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1rem' }}>
            <button className="btn secondary" onClick={() => navigate(-1)}>Back</button>
            <button className="btn secondary" onClick={() => void load()}>Check status</button>
          </div>
        </div>
      </div>
    );
  }

  if (expiredScreen || activeMeta.status === 'expired') {
    return (
      <div className="player">
        <div className="card" style={{ textAlign: 'center', marginTop: '2rem', padding: '2rem 1.5rem' }}>
          <IconAlert />
          <h1>Attempt expired</h1>
          <p className="muted">
            The deadline passed. Your last acknowledged answers were graded as-is.
          </p>
          {activeMeta.receipt && (
            <p className="receipt-id mono">Receipt: {activeMeta.receipt}</p>
          )}
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button className="btn secondary" onClick={() => navigate(-1)}>Back</button>
            {activeMeta.receipt && (
              <button className="btn secondary" onClick={() => navigate(`/results/attempt/${activeMeta.id}`)}>
                {view.quiz.integrity_policy ? 'View any released result' : 'View result'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (submitResult && (activeMeta.status === 'submitted' || submitResult.status === 'submitted')) {
    const canView = activeMeta.score != null || activeMeta.receipt != null;
    return (
      <div className="player">
        <div className="card receipt">
          <IconCheck />
          <h1>Submitted</h1>
          <p className="small muted">Your answers were accepted by the server.</p>
          {activeMeta.receipt && (
            <p className="receipt-id mono" role="status">
              Receipt: <strong>{activeMeta.receipt}</strong>
            </p>
          )}
          <p className="small muted">
            Acknowledged answers: <strong>{submitResult.acknowledged_answers}</strong>
            {submitResult.policy.recorded > 0 ? ` · policy events recorded: ${submitResult.policy.recorded}` : ''}
          </p>
          {activeMeta.score != null && (
            <p>
              <Pill tone="ok" symbol="✓">
                Score: {activeMeta.score}/{activeMeta.max_score}
              </Pill>
            </p>
          )}
          {canView && (
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button className="btn" onClick={() => navigate(`/results/attempt/${activeMeta.id}`)}>View result</button>
              <button className="btn secondary" onClick={() => navigate('/')}>Back to home</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const q = questions[current];
  const answeredCount = questions.filter((qs) => {
    const a = answers[qs.id];
    return a != null && !isEmptyAnswer(qs.qtype, a.value);
  }).length;

  const timerWarn = msLeft != null && msLeft < 60_000;

  return (
    <div className="player">
      <div className="player-header">
        <div className="grow">
          <strong>{view.quiz.title}</strong>
          <div className="muted small">
            Q {current + 1} of {questions.length} · {answeredCount} answered
          </div>
        </div>
        <div className="progress-track" aria-hidden="true">
          <div className="progress-fill" style={{ width: `${Math.round(((current + 1) / questions.length) * 100)}%` }} />
        </div>
        {msLeft != null && (
          <span className={`timer${timerWarn ? ' warn' : ''}`} role="timer" aria-label="time remaining">
            <IconClock /> {formatMs(msLeft)}
          </span>
        )}
      </div>

      <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} />

      {policyMsg && <div className="banner warn small">{policyMsg}</div>}

      <div className="question-card">
        <div className="card-row" style={{ marginBottom: '0.5rem' }}>
          <Pill tone="neutral" symbol="·">{q.qtype.replace('_', ' ')}</Pill>
          <span className="muted small">{q.points} pt</span>
        </div>
        <div style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.75rem' }}>
          <RichText content={q.text} />
        </div>
        <AnswerControl
          qtype={q.qtype}
          options={q.options}
          value={answers[q.id]?.value}
          onChange={(v) => setAnswer(q.id, v)}
        />
      </div>

      <div className="question-pager" role="tablist" aria-label="Questions">
        {questions.map((qs, i) => {
          const a = answers[qs.id];
          return (
            <button
              key={qs.id}
              role="tab"
              aria-selected={i === current}
              className={`q-dot${i === current ? ' current' : ''}${a && !isEmptyAnswer(qs.qtype, a.value) ? ' answered' : ''}`}
              onClick={() => setCurrent(i)}
              title={`Question ${i + 1}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>

      <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <button className="btn secondary" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
          ← Previous
        </button>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button className="btn secondary" onClick={() => void drain()} disabled={!dirty}>
            <IconSave /> Save now
          </button>
          <button className="btn" onClick={() => void submit()} disabled={questions.length === 0}>
            Submit attempt
          </button>
        </div>
        {current < questions.length - 1 && (
          <button className="btn secondary" onClick={() => setCurrent((c) => c + 1)}>
            Next →
          </button>
        )}
      </div>

      {msLeft != null && msLeft <= 0 && (
        <div className="banner warn" style={{ marginTop: '1rem' }}>
          The deadline has passed. Your next save or submission will finalize this attempt as expired.
        </div>
      )}

      <p className="muted small" style={{ marginTop: '1rem' }}>
        Your answers are sent to the server and acknowledged. If the network drops, your last acknowledged state is preserved.
        <Link to={`/quizzes/${view.quiz.id}`} style={{ display: 'block', marginTop: '0.3rem' }}>← Back to quiz</Link>
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
  let tone = 'saved';
  let symbol: 'check' | 'clock' | 'alert' = 'check';
  if (state === 'saving') {
    label = 'Saving…';
    tone = 'saving';
    symbol = 'clock';
  } else if (state === 'error') {
    label = 'Save failed — retrying';
    tone = 'error';
    symbol = 'alert';
  } else if (lastSavedAt) {
    label = `Saved ${new Date(lastSavedAt.replace(' ', 'T') + 'Z').toLocaleTimeString()}`;
  }
  return (
    <div className={`save-state ${tone}`} role="status" aria-live="polite">
      {symbol === 'check' && <IconCheck />}
      {symbol === 'clock' && <IconClock />}
      {symbol === 'alert' && <IconAlert />}
      {label}
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
        {options.map((o, i) => (
          <label key={i} className={`option${Number(value) === i ? ' selected' : ''}`}>
            <input
              type="radio"
              name="ra"
              checked={Number(value) === i}
              onChange={() => onChange(i)}
              aria-label={`Option ${i + 1}`}
            />
            <span className="option-label">
              <RichText content={o} />
            </span>
          </label>
        ))}
      </div>
    );
  }
  if (qtype === 'multiple') {
    const arr = Array.isArray(value) ? (value as unknown[]).map(Number) : [];
    return (
      <div role="group" aria-label="Options (select all that apply)">
        {options.map((o, i) => (
          <label key={i} className={`option${arr.includes(i) ? ' selected' : ''}`}>
            <input
              type="checkbox"
              checked={arr.includes(i)}
              onChange={() => {
                onChange(arr.includes(i) ? arr.filter((x) => x !== i) : [...arr, i]);
              }}
            />
            <span className="option-label">
              <RichText content={o} />
            </span>
          </label>
        ))}
      </div>
    );
  }
  if (qtype === 'numeric') {
    return (
      <input
        type="number"
        step="any"
        value={typeof value === 'number' ? value : String(value ?? '')}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder="Enter a number"
      />
    );
  }
  return (
    <input
      type="text"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Type your answer"
    />
  );
}