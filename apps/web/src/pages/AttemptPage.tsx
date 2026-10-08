import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  Flag,
  FlagOff,
  Hand as HandIcon,
  Lightbulb,
  MessageSquareReply,
  Pin,
  Save,
  Send,
  ShieldAlert,
  Timer,
  Unplug,
} from 'lucide-react';
import { api, ApiError, isNetworkError, withNetworkRetry } from '../api';
import type {
  Announcement,
  AttemptSessionResponse,
  AttemptView,
  EventOutcome,
  Hand,
  HeartbeatResult,
  SaveAck,
  SubmitResult,
} from '../types';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Progress } from '../components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { RichText } from '../components/RichText';
import { LoadingSkeleton, ErrorState } from '../components/primitives';
import { toast } from '../components/ui/sonner';
import {
  AnnouncementsBar,
  CenteredCard,
  ClaimScreen,
  FinishedScreen,
  FullscreenGate,
  LockedScreen,
  PausedOverlay,
  ViolationDialog,
  Watermark,
  formatMs,
  type ClaimInfo,
  type ViolationNotice,
} from '../components/exam/ExamScreens';
import {
  clearAttemptStorage,
  getAttemptSession,
  loadPending,
  savePending,
  sessionHeaders,
  setAttemptSession,
  type PendingAnswer,
} from '../lib/attempt-storage';
import { exitFullscreen, useExamGuard, type GuardEventKind } from '../lib/exam-guard';

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'offline';
type Phase = 'loading' | 'error' | 'claim' | 'replaced' | 'ready';

interface LocalAnswer {
  value: unknown;
  assumption?: string;
  revision: number;
  serverRevision: number;
}

const MAX_ASSUMPTION = 2000;
const MAX_HAND = 500;

/** Stored timestamps are UTC 'YYYY-MM-DD HH:MM:SS.sss'. */
function parseTs(ts: string): number {
  return new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`).getTime();
}

const SAVE_DEBOUNCE_MS = 600;

export function AttemptPage() {
  const { attemptId } = useParams();
  const id = Number(attemptId);
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [claimInfo, setClaimInfo] = useState<ClaimInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<AttemptView | null>(null);
  const viewRef = useRef<AttemptView | null>(null);
  const tokenRef = useRef<string | null>(getAttemptSession(id));

  const [answers, setAnswersState] = useState<Record<number, LocalAnswer>>({});
  const answersRef = useRef<Record<number, LocalAnswer>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  const [offsetMs, setOffsetMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [questionExpiresAt, setQuestionExpiresAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const pauseSnapshot = useRef<number | null>(null);

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const lastAnnouncementId = useRef(0);
  const [hands, setHands] = useState<Hand[]>([]);
  const [handOpen, setHandOpen] = useState(false);
  const [handText, setHandText] = useState('');
  const [handAboutQuestion, setHandAboutQuestion] = useState(true);
  const [handBusy, setHandBusy] = useState(false);
  const [notice, setNotice] = useState<ViolationNotice | null>(null);
  const [violations, setViolations] = useState(0);
  const [current, setCurrent] = useState(0);
  const [flagged, setFlagged] = useState<Record<number, boolean>>({});
  const [submitOpen, setSubmitOpen] = useState(false);
  const [nextOpen, setNextOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<number | null>(null);
  const [everFullscreen, setEverFullscreen] = useState(false);
  const autoRef = useRef<{ running: boolean; lastTry: number }>({ running: false, lastTry: 0 });

  const headers = useCallback(() => sessionHeaders(tokenRef.current), []);

  // ---- answers (ref is the source of truth so async saves never read stale state)
  const updateAnswers = useCallback(
    (fn: (prev: Record<number, LocalAnswer>) => Record<number, LocalAnswer>) => {
      const next = fn(answersRef.current);
      answersRef.current = next;
      setAnswersState(next);
      const pending: Record<number, PendingAnswer> = {};
      for (const [qid, a] of Object.entries(next)) {
        if (a.revision > a.serverRevision) {
          pending[Number(qid)] = { value: a.value, revision: a.revision, assumption: a.assumption };
        }
      }
      savePending(id, pending);
    },
    [id],
  );

  // ---- view
  const applyView = useCallback(
    (v: AttemptView) => {
      viewRef.current = v;
      setView(v);
      setOffsetMs(parseTs(v.attempt.server_now) - Date.now());
      setExpiresAt(v.attempt.expires_at ? parseTs(v.attempt.expires_at) : null);
      setQuestionExpiresAt(v.attempt.question_expires_at ? parseTs(v.attempt.question_expires_at) : null);
      pausedRef.current = v.quiz.paused;
      setPaused(v.quiz.paused);
      setViolations(v.attempt.violation_count);
      setAnnouncements(v.announcements);
      lastAnnouncementId.current = v.announcements.reduce((m, a) => Math.max(m, a.id), 0);
      setHands(v.hands ?? []);
      if (v.attempt.status !== 'in_progress') {
        clearAttemptStorage(id);
        exitFullscreen();
      } else {
        // Server answers, overridden by anything newer typed on this device (offline buffer).
        const pending = loadPending(id);
        updateAnswers((prev) => {
          const next: Record<number, LocalAnswer> = {};
          for (const q of v.questions) {
            const server = v.answers[q.id];
            const serverRev = server?.revision ?? 0;
            const local = prev[q.id];
            const stored = pending[q.id];
            if (local && local.revision > serverRev) next[q.id] = { ...local, serverRevision: serverRev };
            else if (stored && stored.revision > serverRev)
              next[q.id] = {
                value: stored.value,
                assumption: stored.assumption,
                revision: stored.revision,
                serverRevision: serverRev,
              };
            else if (server)
              next[q.id] = {
                value: server.answer,
                assumption: server.assumption ?? undefined,
                revision: serverRev,
                serverRevision: serverRev,
              };
          }
          return next;
        });
        if (v.attempt.last_save_at) setLastSavedAt(v.attempt.last_save_at);
      }
      setCurrent((c) => Math.min(c, Math.max(0, v.questions.length - 1)));
      setPhase('ready');
    },
    [id, updateAnswers],
  );

  const forgetSession = useCallback(() => {
    tokenRef.current = null;
    setAttemptSession(id, null);
  }, [id]);

  const load = useCallback(async () => {
    try {
      const v = await withNetworkRetry(() => api.get<AttemptView>(`/attempts/${id}`, { headers: headers() }));
      applyView(v);
    } catch (err) {
      if (!handleSessionErrorRef.current(err)) {
        setError(err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection.');
        setPhase('error');
      }
    }
  }, [id, headers, applyView]);

  const claim = useCallback(
    async (takeover: boolean) => {
      setBusy(true);
      try {
        const res = await withNetworkRetry(() =>
          api.post<AttemptSessionResponse>(`/attempts/${id}/session`, { takeover }),
        );
        if (res.session_token) {
          tokenRef.current = res.session_token;
          setAttemptSession(id, res.session_token);
        }
        applyView(res);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'session_active') {
          setClaimInfo({ otherActive: true, canTakeover: Boolean(err.data.can_takeover), reentryAction: null });
          setPhase('claim');
        } else if (err instanceof ApiError && err.status === 423) {
          forgetSession();
          await load();
        } else {
          setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
          setPhase('error');
        }
      } finally {
        setBusy(false);
      }
    },
    [id, applyView, forgetSession, load],
  );

  /** 409 session_required / session_replaced → decide how this window may continue. */
  const handleSessionError = useCallback(
    (err: unknown): boolean => {
      if (!(err instanceof ApiError) || err.status !== 409) return false;
      const d = err.data as { can_resume?: boolean; other_session_active?: boolean; reentry_action?: 'lock' | 'submit' | null };
      if (err.code === 'session_replaced') {
        forgetSession();
        setClaimInfo({ otherActive: true, canTakeover: Boolean(d.can_resume), reentryAction: d.reentry_action ?? null });
        setPhase('replaced');
        exitFullscreen();
        return true;
      }
      if (err.code === 'session_required') {
        forgetSession();
        if (d.can_resume && !d.other_session_active) {
          void claim(false);
        } else {
          setClaimInfo({
            otherActive: Boolean(d.other_session_active),
            canTakeover: Boolean(d.can_resume),
            reentryAction: d.reentry_action ?? null,
          });
          setPhase('claim');
        }
        return true;
      }
      return false;
    },
    [claim, forgetSession],
  );
  const handleSessionErrorRef = useRef(handleSessionError);
  handleSessionErrorRef.current = handleSessionError;

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    void load();
  }, [id, load]);

  const live = phase === 'ready' && view?.attempt.status === 'in_progress';
  const settings = view?.quiz.settings ?? null;

  // ---- saving
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(2000);
  const drainPromise = useRef<Promise<void> | null>(null);
  const drainAgain = useRef(false);

  const flush = useCallback(async (): Promise<void> => {
    const items = Object.entries(answersRef.current)
      .filter(([, a]) => a.revision > a.serverRevision)
      .map(([qid, a]) => ({
        question_id: Number(qid),
        answer: a.value ?? null,
        revision: a.revision,
        assumption: a.assumption ?? '',
      }));
    if (items.length === 0 || pausedRef.current) return;
    setSaveState('saving');
    try {
      const res = await api.put<{ acks: SaveAck[] }>(`/attempts/${id}/answers`, { answers: items }, { headers: headers() });
      const acks = new Map(res.acks.map((a) => [a.question_id, a]));
      let rejected = 0;
      updateAnswers((prev) => {
        const next = { ...prev };
        for (const [qid, a] of Object.entries(prev)) {
          const ack = acks.get(Number(qid));
          if (!ack) continue;
          if (ack.acknowledged) next[Number(qid)] = { ...a, serverRevision: Math.max(a.serverRevision, ack.revision) };
          else {
            rejected++;
            next[Number(qid)] = { ...a, serverRevision: a.revision }; // not storable (moved on / invalid): drop it
          }
        }
        return next;
      });
      const latest = res.acks.map((a) => a.saved_at).filter(Boolean).sort().at(-1);
      if (latest) setLastSavedAt(latest);
      setSaveState(rejected ? 'error' : 'saved');
      setOnline(true);
      retryDelay.current = 2000;
    } catch (err) {
      if (isNetworkError(err)) {
        setSaveState('offline');
        setOnline(false);
      } else if (err instanceof ApiError && err.code === 'quiz_paused') {
        pausedRef.current = true;
        setPaused(true);
        setSaveState('idle');
        return;
      } else if (handleSessionErrorRef.current(err)) {
        return;
      } else if (err instanceof ApiError && err.status === 409) {
        await load();
        return;
      } else {
        setSaveState('error');
      }
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => void drainRef.current(), retryDelay.current);
      retryDelay.current = Math.min(retryDelay.current * 2, 15000);
    }
  }, [id, headers, updateAnswers, load]);

  const drain = useCallback((): Promise<void> => {
    if (drainPromise.current) {
      drainAgain.current = true;
      return drainPromise.current;
    }
    drainPromise.current = (async () => {
      try {
        do {
          drainAgain.current = false;
          await flush();
        } while (drainAgain.current);
      } finally {
        drainPromise.current = null;
      }
    })();
    return drainPromise.current;
  }, [flush]);
  const drainRef = useRef(drain);
  drainRef.current = drain;

  const dirtyCount = useMemo(
    () => Object.values(answers).filter((a) => a.revision > a.serverRevision).length,
    [answers],
  );

  useEffect(() => {
    if (!live || dirtyCount === 0 || paused) return;
    const t = setTimeout(() => void drain(), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [answers, dirtyCount, live, paused, drain]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void drainRef.current();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const setAnswer = useCallback(
    (questionId: number, value: unknown) => {
      updateAnswers((prev) => {
        const cur = prev[questionId] ?? { value: undefined, revision: 0, serverRevision: 0 };
        return { ...prev, [questionId]: { ...cur, value, revision: cur.revision + 1 } };
      });
    },
    [updateAnswers],
  );

  /** The assumption travels with the answer (same revision), so both are saved together. */
  const setAssumption = useCallback(
    (questionId: number, text: string) => {
      updateAnswers((prev) => {
        const cur = prev[questionId] ?? { value: null, revision: 0, serverRevision: 0 };
        return { ...prev, [questionId]: { ...cur, assumption: text, revision: cur.revision + 1 } };
      });
    },
    [updateAnswers],
  );

  // ---- heartbeat: clock sync, extensions, pause, announcements, instructor actions
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const beat = async () => {
      const sent = Date.now();
      let nextIn = viewRef.current?.heartbeat_ms ?? 15000;
      try {
        const hb = await api.post<HeartbeatResult>(
          `/attempts/${id}/heartbeat`,
          { last_announcement_id: lastAnnouncementId.current },
          { headers: headers() },
        );
        const received = Date.now();
        setOnline(true);
        setOffsetMs(parseTs(hb.server_now) - (sent + received) / 2);
        const v = viewRef.current;
        if (hb.status !== 'in_progress' || (v && hb.current_index !== v.attempt.current_index)) {
          await load();
          return;
        }
        const newExpiry = hb.expires_at ? parseTs(hb.expires_at) : null;
        setExpiresAt((prev) => {
          if (prev !== null && newExpiry !== null && newExpiry - prev > 30_000) {
            toast.success(`Your instructor gave you ${Math.round((newExpiry - prev) / 60000)} more minute(s).`);
          }
          return newExpiry;
        });
        setQuestionExpiresAt(hb.question_expires_at ? parseTs(hb.question_expires_at) : null);
        if (hb.paused !== pausedRef.current) {
          pausedRef.current = hb.paused;
          setPaused(hb.paused);
          if (!hb.paused) {
            toast.success('The quiz has resumed.');
            await load();
            void drainRef.current();
          }
        }
        setViolations(hb.violation_count);
        if (hb.hands) {
          setHands((prev) => {
            for (const h of hb.hands) {
              const before = prev.find((p) => p.id === h.id);
              if (before?.status === 'open' && h.status === 'dismissed') {
                toast.info('The invigilator closed your question without a reply.');
              }
            }
            return hb.hands;
          });
        }
        if (hb.announcements.length) {
          setAnnouncements((prev) => [...prev, ...hb.announcements.filter((a) => !prev.some((p) => p.id === a.id))]);
          lastAnnouncementId.current = Math.max(lastAnnouncementId.current, ...hb.announcements.map((a) => a.id));
          for (const a of hb.announcements) toast.info(a.personal ? 'Message from your instructor' : 'Announcement', { description: a.message, duration: 12000 });
        }
        if (hb.paused) nextIn = 4000;
      } catch (err) {
        if (handleSessionErrorRef.current(err)) return;
        if (isNetworkError(err)) {
          setOnline(false);
          nextIn = 5000;
        }
      }
      if (!stopped) timer = setTimeout(() => void beat(), nextIn);
    };
    timer = setTimeout(() => void beat(), 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [live, id, headers, load]);

  // ---- raise hand: a private question to the invigilators
  const sendHand = useCallback(
    async (questionId: number | null) => {
      const message = handText.trim();
      if (!message) return;
      setHandBusy(true);
      try {
        const res = await api.post<{ hand: Hand }>(
          `/attempts/${id}/hand`,
          { message, question_id: questionId },
          { headers: headers() },
        );
        setHands((prev) => [...prev, res.hand]);
        setHandText('');
        setHandOpen(false);
        toast.success('Sent to the invigilator. The reply will appear at the top of the quiz.');
      } catch (err) {
        if (!handleSessionErrorRef.current(err)) {
          toast.error(err instanceof ApiError ? err.message : 'Could not send. Check your connection.');
        }
      } finally {
        setHandBusy(false);
      }
    },
    [id, headers, handText],
  );

  // ---- integrity events
  const report = useCallback(
    async (kind: GuardEventKind, detail: string) => {
      try {
        const out = await api.post<EventOutcome>(`/attempts/${id}/events`, { kind, detail }, { headers: headers() });
        if (out.violation) {
          setViolations(out.violation_count);
          if (out.message) {
            setNotice({ message: out.message, count: out.violation_count, max: out.max_violations, action: out.violation_action });
          }
        }
        if (out.action === 'submitted') await load();
      } catch (err) {
        if (err instanceof ApiError && err.status === 423) {
          await load();
          return;
        }
        handleSessionErrorRef.current(err);
      }
    },
    [id, headers, load],
  );

  const guard = useExamGuard({ active: live && !paused, settings, report });
  useEffect(() => {
    if (guard.fullscreen) setEverFullscreen(true);
  }, [guard.fullscreen]);

  // ---- leaving the page
  useEffect(() => {
    if (!live || !settings) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onPageHide = () => {
      void drainRef.current();
      if (!settings.allow_resume) {
        void api
          .post(`/attempts/${id}/events`, { kind: 'page_exit', detail: 'The quiz page was closed or reloaded.' }, { headers: headers(), keepalive: true })
          .catch(() => {});
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [live, settings, id, headers]);

  // ---- clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const serverNow = now + offsetMs;
  if (paused && pauseSnapshot.current === null) pauseSnapshot.current = serverNow;
  if (!paused && pauseSnapshot.current !== null) pauseSnapshot.current = null;
  const clockNow = pauseSnapshot.current ?? serverNow;
  const msLeft = expiresAt !== null ? expiresAt - clockNow : null;
  const questionMsLeft = live && questionExpiresAt !== null ? questionExpiresAt - clockNow : null;

  const sequential = settings?.navigation === 'sequential';
  const total = view?.attempt.total_questions ?? 0;
  const q = view ? (sequential ? view.questions[0] : view.questions[current]) : undefined;
  const position = q?.position ?? 0;
  const isLast = position >= total - 1;

  // ---- submit / advance
  const submit = useCallback(async () => {
    setBusy(true);
    try {
      await drain();
      const res = await withNetworkRetry(() =>
        api.post<SubmitResult>(`/attempts/${id}/submit`, undefined, { headers: headers() }),
      );
      setAcknowledged(res.acknowledged_answers);
      clearAttemptStorage(id);
      await load();
    } catch (err) {
      if (handleSessionErrorRef.current(err)) return;
      if (err instanceof ApiError && err.status === 409) await load();
      else toast.error(err instanceof ApiError ? err.message : 'Could not reach the server — trying again shortly.');
    } finally {
      setBusy(false);
    }
  }, [id, headers, drain, load]);

  const advance = useCallback(async () => {
    const v = viewRef.current;
    if (!v) return;
    setBusy(true);
    try {
      await drain();
      const next = await withNetworkRetry(() =>
        api.post<AttemptView>(`/attempts/${id}/advance`, { from_index: v.attempt.current_index }, { headers: headers() }),
      );
      applyView(next);
    } catch (err) {
      if (handleSessionErrorRef.current(err)) return;
      if (err instanceof ApiError && err.code === 'quiz_paused') {
        pausedRef.current = true;
        setPaused(true);
      } else toast.error(err instanceof ApiError ? err.message : 'Could not reach the server — trying again shortly.');
    } finally {
      setBusy(false);
    }
  }, [id, headers, drain, applyView]);

  // Timers that hit zero act on their own: next question, or submit.
  useEffect(() => {
    if (!live || paused) return;
    const auto = autoRef.current;
    if (auto.running || Date.now() - auto.lastTry < 3000) return;
    let action: (() => Promise<void>) | null = null;
    if (msLeft !== null && msLeft <= 0) action = submit;
    else if (questionMsLeft !== null && questionMsLeft <= 0) action = isLast ? submit : advance;
    if (!action) return;
    auto.running = true;
    auto.lastTry = Date.now();
    void action().finally(() => {
      auto.running = false;
    });
  }, [live, paused, msLeft, questionMsLeft, isLast, submit, advance]);

  // Free navigation: arrow keys move between questions.
  useEffect(() => {
    if (!live || sequential) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') setCurrent((c) => Math.max(0, c - 1));
      if (e.key === 'ArrowRight') setCurrent((c) => Math.min((viewRef.current?.questions.length ?? 1) - 1, c + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, sequential]);

  // ---------------------------------------------------------------- render
  if (!Number.isFinite(id)) return <ErrorState error="Invalid attempt link." />;
  if (phase === 'loading') {
    return (
      <div className="player">
        <LoadingSkeleton rows={4} variant="text" />
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div className="player">
        <ErrorState title="Could not open this attempt" error={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (phase === 'claim' && claimInfo) {
    return (
      <ClaimScreen
        info={claimInfo}
        busy={busy}
        onClaim={(takeover) => void claim(takeover)}
        onRetry={() => void load()}
        onBack={() => navigate(-1)}
      />
    );
  }
  if (phase === 'replaced') {
    return (
      <CenteredCard
        icon={<Unplug className="size-10 text-warning" aria-hidden="true" />}
        title="This window was disconnected"
        description="Your attempt was opened in another window or device, so this one stopped saving. Your answers up to that moment were saved."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => navigate('/')}>
              Back to home
            </Button>
            {claimInfo?.canTakeover && (
              <Button size="sm" disabled={busy} onClick={() => void claim(true)}>
                Continue here instead
              </Button>
            )}
          </>
        }
      />
    );
  }
  if (!view) return null;
  const meta = view.attempt;

  if (meta.status === 'locked' || meta.status === 'under_review') {
    return <LockedScreen meta={meta} busy={busy} onCheck={() => void load()} onBack={() => navigate(-1)} />;
  }
  if (meta.status === 'submitted' || meta.status === 'expired') {
    return (
      <FinishedScreen
        meta={meta}
        acknowledged={acknowledged}
        onViewResult={() => navigate(`/results/attempt/${meta.id}`)}
        onHome={() => navigate('/')}
      />
    );
  }
  if (!q || !settings) {
    return (
      <div className="player">
        <ErrorState title="No question to show" error="Reload the page to continue." onRetry={() => void load()} />
      </div>
    );
  }

  const answeredCount = view.questions.filter((qs) => {
    const a = answers[qs.id];
    return a != null && !isEmptyAnswer(a.value);
  }).length;
  const monitored = !settings.allow_tab_switch || !settings.allow_window_switch || settings.require_fullscreen;
  const protect = !settings.allow_copy_paste;
  const needFullscreen = settings.require_fullscreen && !guard.fullscreen;
  const timerWarn = msLeft !== null && msLeft < 60_000;
  const questionLimitMs = (q.time_limit_seconds ?? 0) * 1000;
  const watermarkLines = [view.student.name, view.student.entry_number ?? view.student.email, `Attempt #${meta.id}`];

  return (
    <div className={`player ${protect ? 'exam-protected' : ''}`}>
      {paused && <PausedOverlay />}
      {!paused && needFullscreen && (
        <FullscreenGate supported={guard.fullscreenSupported} onEnter={() => void guard.enterFullscreen()} started={everFullscreen} />
      )}
      <ViolationDialog notice={notice} onClose={() => setNotice(null)} />

      {/* ---- header ---- */}
      <div className="player-header">
        <div className="grow min-w-0">
          <p className="font-display text-lg font-semibold text-foreground">{view.quiz.title}</p>
          <p className="text-sm text-muted-foreground">
            Question {position + 1} of {total}
            {!sequential && ` · ${answeredCount} answered`}
          </p>
        </div>
        <Progress
          value={Math.round(((position + 1) / Math.max(1, total)) * 100)}
          className="w-32 shrink-0"
          aria-label={`Question ${position + 1} of ${total}`}
        />
        {monitored && settings.violation_action !== 'none' && (
          <Badge variant={violations > 0 ? 'warning' : 'secondary'} title="Violations recorded for this attempt">
            <ShieldAlert aria-hidden="true" />
            {violations}/{settings.max_violations}
          </Badge>
        )}
        {msLeft !== null && (
          <span className={`timer ${timerWarn ? 'warn' : ''}`} role="timer" aria-label="Time remaining for the quiz">
            <Clock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            {formatMs(msLeft)}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setHandOpen(true)}
          title="Ask the invigilator a question"
          className="ml-auto"
        >
          <HandIcon aria-hidden="true" />
          Raise hand
          {hands.some((h) => h.status === 'open') && (
            <Badge variant="warning" className="ml-1">
              waiting
            </Badge>
          )}
        </Button>
        {/* Kept apart from navigation so a "Next" click can never land on it. */}
        <div className="border-l border-border pl-4">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setSubmitOpen(true)}
            className="border-destructive/60 text-destructive hover:bg-destructive/10"
          >
            <Send aria-hidden="true" />
            Submit quiz
          </Button>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-3">
        <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} />
        {!online && (
          <span className="inline-flex items-center gap-1.5 text-sm text-warning" role="status">
            <CloudOff className="size-4" aria-hidden="true" />
            Offline — answers are kept on this device and sent when you reconnect
          </span>
        )}
      </div>

      <AnnouncementsBar items={announcements} />

      {questionMsLeft !== null && (
        <div className="mb-3" role="timer" aria-label="Time remaining for this question">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Timer className="size-4 text-primary" aria-hidden="true" />
              Time for this question
            </span>
            <span className={`font-mono tabular-nums ${questionMsLeft < 10_000 ? 'text-destructive' : ''}`}>
              {formatMs(questionMsLeft)}
            </span>
          </div>
          {questionLimitMs > 0 && (
            <Progress value={Math.max(0, Math.min(100, (questionMsLeft / questionLimitMs) * 100))} aria-hidden="true" />
          )}
        </div>
      )}

      {/* ---- question card ---- */}
      <motion.div
        key={q.id}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
      >
        <Card className="relative overflow-hidden">
          {settings.watermark && <Watermark lines={watermarkLines} />}
          <CardHeader>
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="capitalize">
                {q.qtype === 'multiple' ? 'Select all that apply' : q.qtype === 'descriptive' ? 'Written answer' : q.qtype}
              </Badge>
              <Badge variant="secondary">{q.points} pt</Badge>
            </div>
            <CardTitle className="mt-2">
              <RichText content={q.text} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            {announcements
              .filter((a) => a.question_id === q.id)
              .map((a) => (
                <div
                  key={a.id}
                  className="mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
                  role="note"
                >
                  <Pin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>
                    <strong>{a.personal ? 'Reply from the invigilator: ' : 'Clarification: '}</strong>
                    {a.message}
                  </span>
                </div>
              ))}
            <AnswerControl
              questionId={q.id}
              qtype={q.qtype}
              options={q.options}
              value={answers[q.id]?.value}
              onChange={(v) => setAnswer(q.id, v)}
            />
            {q.allow_assumptions && (
              <div className="mt-4 rounded-[var(--radius-md)] border border-dashed bg-muted/30 p-3">
                <label htmlFor={`assume-${q.id}`} className="flex items-center gap-1.5 text-sm font-medium">
                  <Lightbulb className="size-4 text-warning" aria-hidden="true" />
                  Your assumption (optional)
                </label>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  If the question is unclear, write what you assumed. Your instructor reads it when marking.
                </p>
                <Textarea
                  id={`assume-${q.id}`}
                  rows={2}
                  maxLength={MAX_ASSUMPTION}
                  value={answers[q.id]?.assumption ?? ''}
                  onChange={(e) => setAssumption(q.id, e.target.value)}
                  placeholder="e.g. I assumed the array is already sorted."
                />
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ---- navigation ---- */}
      {sequential ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {isLast
              ? 'This is the last question. When you are done, use “Submit quiz” at the top right.'
              : 'One question at a time — you cannot go back.'}
          </p>
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => void drain()} disabled={dirtyCount === 0}>
              <Save aria-hidden="true" />
              Save now
            </Button>
            {!isLast && (
              <Button size="sm" disabled={busy} onClick={() => setNextOpen(true)}>
                Next question <ChevronRight aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="question-pager" role="tablist" aria-label="Questions">
            {view.questions.map((qs, i) => {
              const a = answers[qs.id];
              const isAnswered = a != null && !isEmptyAnswer(a.value);
              const isFlagged = !!flagged[qs.id];
              return (
                <div key={qs.id} className="relative flex items-center">
                  <button
                    role="tab"
                    aria-selected={i === current}
                    aria-label={`Question ${i + 1}${isAnswered ? ', answered' : ''}${isFlagged ? ', flagged' : ''}`}
                    className={`q-dot ${i === current ? 'current' : ''} ${isAnswered ? 'answered' : ''} ${isFlagged ? 'flagged' : ''}`}
                    onClick={() => setCurrent(i)}
                  >
                    {i + 1}
                  </button>
                  <button
                    type="button"
                    aria-label={isFlagged ? `Unflag question ${i + 1}` : `Flag question ${i + 1} for review`}
                    title={isFlagged ? 'Unflag for review' : 'Flag for review'}
                    className="absolute -right-1 -top-1 rounded-full p-0.5 hover:bg-muted"
                    onClick={() => setFlagged((prev) => ({ ...prev, [qs.id]: !prev[qs.id] }))}
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
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" size="sm" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
              <ChevronLeft aria-hidden="true" />
              Previous
            </Button>
            <div className="flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => void drain()} disabled={dirtyCount === 0}>
                <Save aria-hidden="true" />
                Save now
              </Button>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={current >= view.questions.length - 1}
              onClick={() => setCurrent((c) => c + 1)}
            >
              Next <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </>
      )}

      <AlertDialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit your quiz?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {sequential ? (
                  !isLast && (
                    <p>
                      You are on question {position + 1} of {total}. The remaining {total - position - 1} question(s)
                      will be submitted unanswered.
                    </p>
                  )
                ) : (
                  <p>
                    Answered <strong>{answeredCount}</strong> of {view.questions.length}
                    {view.questions.length - answeredCount > 0 && (
                      <> — <strong>{view.questions.length - answeredCount} unanswered</strong></>
                    )}
                    {Object.values(flagged).filter(Boolean).length > 0 && (
                      <>, {Object.values(flagged).filter(Boolean).length} flagged for review</>
                    )}
                    .
                  </p>
                )}
                <p>This is final — you cannot change answers after submitting.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Keep working</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:brightness-105"
              onClick={() => {
                setSubmitOpen(false);
                void submit();
              }}
            >
              Yes, submit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={nextOpen} onOpenChange={setNextOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to the next question?</AlertDialogTitle>
            <AlertDialogDescription>
              {answers[q.id] && !isEmptyAnswer(answers[q.id]?.value)
                ? 'Your answer is saved. You will not be able to come back to this question.'
                : 'You have not answered this question. You will not be able to come back to it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setNextOpen(false);
                void advance();
              }}
            >
              Next question
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {msLeft !== null && msLeft <= 0 && (
        <div className="banner warn small mt-4">Time is up — submitting your saved answers…</div>
      )}

      <Dialog open={handOpen} onOpenChange={setHandOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask the invigilator</DialogTitle>
            <DialogDescription>
              Only staff see this. The timer keeps running while you wait — carry on with other questions.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            maxLength={MAX_HAND}
            value={handText}
            onChange={(e) => setHandText(e.target.value)}
            placeholder="e.g. Option C in this question seems to have a typo."
            aria-label="Your question for the invigilator"
            autoFocus
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={handAboutQuestion}
              onChange={(e) => setHandAboutQuestion(e.target.checked)}
            />
            This is about question {position + 1}
          </label>
          {hands.length > 0 && (
            <div className="max-h-48 space-y-2 overflow-y-auto border-t pt-3 text-sm">
              {hands
                .slice()
                .reverse()
                .map((h) => (
                  <div key={h.id} className="rounded-[var(--radius-md)] bg-muted/40 px-3 py-2">
                    <p className="text-muted-foreground">{h.message}</p>
                    {h.status === 'answered' ? (
                      <p className="mt-1 flex items-start gap-1.5">
                        <MessageSquareReply className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                        {h.reply}
                        {h.broadcast && <Badge variant="secondary">sent to everyone</Badge>}
                      </p>
                    ) : (
                      <Badge variant={h.status === 'open' ? 'warning' : 'secondary'} className="mt-1">
                        {h.status === 'open' ? 'Waiting for a reply' : 'Closed without reply'}
                      </Badge>
                    )}
                  </div>
                ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setHandOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={handBusy || !handText.trim()}
              onClick={() => void sendHand(handAboutQuestion ? q.id : null)}
            >
              <HandIcon aria-hidden="true" />
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <details className="mt-6 rounded-[var(--radius-md)] border bg-card/60 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">
          <AlertTriangle className="mr-1.5 inline size-4 align-[-3px] text-muted-foreground" aria-hidden="true" />
          Rules for this quiz
        </summary>
        <ul className="mt-2 list-inside list-disc space-y-1 text-muted-foreground">
          {view.quiz.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>

      <p className="muted small mt-4">
        Answers are sent to the server and acknowledged; if the network drops they are kept on this device and sent when
        it returns.
        <Link to={`/quizzes/${view.quiz.quiz_id}/preflight`} className="mt-1 block">
          ← Back to quiz
        </Link>
      </p>
    </div>
  );
}

function isEmptyAnswer(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function SaveIndicator({ state, lastSavedAt }: { state: SaveState; lastSavedAt: string | null }) {
  let label = 'All changes saved';
  let icon: React.ReactNode = <CheckCircle2 className="size-4 text-success" aria-hidden="true" />;
  if (state === 'saving') {
    label = 'Saving…';
    icon = <Clock className="size-4 animate-spin text-warning" aria-hidden="true" />;
  } else if (state === 'error') {
    label = 'Some answers could not be saved — retrying';
    icon = <AlertTriangle className="size-4 text-destructive" aria-hidden="true" />;
  } else if (state === 'offline') {
    label = 'Not saved yet — waiting for the network';
    icon = <CloudOff className="size-4 text-warning" aria-hidden="true" />;
  } else if (lastSavedAt) {
    label = `Saved ${new Date(parseTs(lastSavedAt)).toLocaleTimeString()}`;
  }
  return (
    <div className="save-state" role="status" aria-live="polite">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function AnswerControl({
  questionId,
  qtype,
  options,
  value,
  onChange,
}: {
  questionId: number;
  qtype: AttemptView['questions'][number]['qtype'];
  options: string[];
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (qtype === 'descriptive') {
    const text = typeof value === 'string' ? value : '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return (
      <div>
        <Textarea
          rows={10}
          maxLength={20000}
          spellCheck
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Write your answer"
          aria-label="Your written answer"
          className="min-h-48"
        />
        <p className="mt-1 text-right text-xs text-muted-foreground" aria-live="polite">
          {words} word{words === 1 ? '' : 's'} · marked by your instructor
        </p>
      </div>
    );
  }
  if (qtype === 'single') {
    return (
      <div role="radiogroup" aria-label="Options">
        {options.map((o, i) => {
          const selected = value != null && Number(value) === i;
          return (
            <label key={i} className={`option ${selected ? 'selected' : ''}`}>
              <input
                type="radio"
                name={`q-${questionId}`}
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
            <label key={i} className={`option ${selected ? 'selected' : ''}`}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onChange(selected ? arr.filter((x) => x !== i) : [...arr, i].sort((a, b) => a - b))}
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
        inputMode="decimal"
        value={typeof value === 'number' ? value : String(value ?? '')}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder="Enter a number"
        aria-label="Your answer (a number)"
      />
    );
  }
  return (
    <Input
      type="text"
      maxLength={2000}
      autoComplete="off"
      spellCheck={false}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Type your answer"
      aria-label="Your answer"
    />
  );
}
