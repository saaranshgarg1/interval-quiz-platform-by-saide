import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  KeyRound,
  Lock,
  MonitorCheck,
  PauseCircle,
  Radio,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useQuiz } from '../lib/queries';
import { api, ApiError, withNetworkRetry } from '../api';
import { useAuth } from '../auth';
import type { AttemptSessionResponse, PublicExamSettings, VersionDetail } from '../types';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { setAttemptSession } from '../lib/attempt-storage';
import { keyboardLockSupported } from '../lib/exam-guard';

const PRESET_LABEL: Record<string, string> = {
  practice: 'Practice',
  standard: 'Monitored',
  strict: 'Strict exam',
  custom: 'Custom rules',
};

function toLocal(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

interface Check {
  label: string;
  ok: boolean | null;
  detail: string;
}

/** Quick pre-exam check of what the rules will need from this browser. */
function useSystemCheck(settings: PublicExamSettings | null, enabled: boolean): Check[] {
  const [latency, setLatency] = useState<number | null>(null);
  const [pingFailed, setPingFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const t0 = performance.now();
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => {
        if (!cancelled) {
          if (r.ok) setLatency(Math.round(performance.now() - t0));
          else setPingFailed(true);
        }
      })
      .catch(() => !cancelled && setPingFailed(true));
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  if (!settings) return [];
  const checks: Check[] = [
    {
      label: 'Connection to the exam server',
      ok: pingFailed ? false : latency === null ? null : true,
      detail: pingFailed ? 'Cannot reach the server.' : latency === null ? 'Checking…' : `Responding in ${latency} ms.`,
    },
  ];
  if (settings.lock_keyboard) {
    const ok = keyboardLockSupported();
    checks.push({
      label: 'Keyboard lock (Windows key, Alt+Tab, Esc)',
      ok,
      detail: ok
        ? 'Supported. These keys will be disabled once the quiz is in full screen.'
        : 'Not available in this browser. This quiz needs an up-to-date Chrome or Edge.',
    });
  }
  if (settings.require_fullscreen) {
    const extended = (window.screen as Screen & { isExtended?: boolean }).isExtended;
    checks.push({
      label: 'Full-screen mode',
      ok: Boolean(document.fullscreenEnabled),
      detail: document.fullscreenEnabled
        ? 'Supported. The quiz will ask to go full screen.'
        : 'Not available in this browser. Use Chrome, Edge or Firefox on a computer.',
    });
    checks.push({
      label: 'Single display',
      ok: extended === undefined ? null : !extended,
      detail:
        extended === undefined
          ? 'Your browser cannot report this. Disconnect extra monitors before starting.'
          : extended
            ? 'More than one display is connected. Disconnect extra monitors; this is reported.'
            : 'One display detected.',
    });
  }
  return checks;
}

export function QuizPreflightPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const quizNumericId = Number(quizId);
  const reduceMotion = useReducedMotion();

  const [startError, setStartError] = useState<string | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [accessCode, setAccessCode] = useState('');
  const [agreed, setAgreed] = useState(false);

  const { data: quizResponse, isLoading, isError, error: queryError, refetch } = useQuiz(quizNumericId);
  const version: VersionDetail | undefined =
    quizResponse?.versions.find((v) => v.status === 'published') ?? quizResponse?.versions[0];
  const settings = (version?.exam_settings ?? null) as PublicExamSettings | null;
  const isStudent = user?.role === 'student';
  const checks = useSystemCheck(settings, Boolean(version) && isStudent);

  if (isLoading) {
    return (
      <Page title="Quiz preflight">
        <LoadingSkeleton rows={4} variant="list" />
      </Page>
    );
  }
  if (isError) {
    return (
      <Page title="Quiz preflight">
        <ErrorState title="Could not load this quiz" error={queryError} onRetry={() => void refetch()} />
      </Page>
    );
  }
  if (!quizResponse || !version || !settings) {
    return (
      <Page title="Quiz preflight">
        <EmptyState icon={FileText} title="No quiz found" description="This quiz does not exist or is not published yet." />
      </Page>
    );
  }

  const isStaff = !isStudent;
  const my = version.my_attempts;
  const attemptsUsed = my?.count ?? 0;
  const attemptsRemaining = version.attempts_allowed - attemptsUsed;
  const needsCode = 'requires_access_code' in settings ? settings.requires_access_code : Boolean((settings as { access_code?: string }).access_code);
  const opensAt = version.window_opens_at ? new Date(`${version.window_opens_at.replace(' ', 'T')}Z`).getTime() : null;
  const notYetOpen = version.quiz_type === 'scheduled' && opensAt !== null && Date.now() < opensAt;
  const canStart =
    isStudent &&
    !my?.in_progress &&
    !my?.locked &&
    version.status === 'published' &&
    attemptsRemaining > 0 &&
    !version.closed &&
    !version.paused;
  const blockingCheck = checks.some((c) => c.ok === false && c.label !== 'Single display');

  const start = async () => {
    setStartBusy(true);
    setStartError(null);
    try {
      const view = await withNetworkRetry(() =>
        api.post<AttemptSessionResponse>(`/attempts/quiz/${version.id}`, needsCode ? { access_code: accessCode } : {}),
      );
      if (view.session_token) setAttemptSession(view.attempt.id, view.session_token);
      if (settings.require_fullscreen && document.fullscreenEnabled) {
        // Same click gesture: browsers only allow full screen in response to user input.
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      }
      navigate(`/attempts/${view.attempt.id}`);
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      setStartBusy(false);
    }
  };

  const entrance = reduceMotion
    ? {}
    : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const } };

  return (
    <Page title={version.title} description={isStaff ? `Version ${version.version} · student preview of the rules` : undefined}>
      <motion.div className="stack-md" {...entrance}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={version.preset === 'strict' ? 'destructive' : version.preset === 'practice' ? 'secondary' : 'default'}>
            <ShieldAlert aria-hidden="true" />
            {PRESET_LABEL[version.preset] ?? 'Custom rules'}
          </Badge>
          {version.quiz_type === 'scheduled' && (
            <Badge variant="outline">
              <CalendarClock aria-hidden="true" />
              {toLocal(version.window_opens_at)} – {toLocal(version.window_closes_at)}
            </Badge>
          )}
          {version.paused && (
            <Badge variant="warning">
              <PauseCircle aria-hidden="true" /> Paused
            </Badge>
          )}
          {version.closed && (
            <Badge variant="destructive">
              <Lock aria-hidden="true" /> Closed
            </Badge>
          )}
        </div>

        {version.instructions && (
          <p className="whitespace-pre-wrap text-sm text-foreground/80">{version.instructions}</p>
        )}

        <Separator />

        {startError && (
          <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {startError}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <InfoCard icon={<FileText className="size-5 text-primary" aria-hidden="true" />} label="Questions">
            {settings.questions_per_attempt && settings.questions_per_attempt < version.question_count
              ? `${settings.questions_per_attempt} of ${version.question_count} (random)`
              : version.question_count}
          </InfoCard>
          <InfoCard icon={<Clock className="size-5 text-primary" aria-hidden="true" />} label="Time limit">
            {version.duration_minutes ? `${version.duration_minutes} min` : 'No overall timer'}
            {settings.question_timer !== 'off' && ' · timed questions'}
          </InfoCard>
          <InfoCard
            icon={
              attemptsRemaining > 0 ? (
                <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
              ) : (
                <XCircle className="size-5 text-destructive" aria-hidden="true" />
              )
            }
            label="Attempts"
          >
            {attemptsUsed} / {version.attempts_allowed} used
            {my?.best_score != null && <span className="ml-1 text-muted-foreground">· best {my.best_score}</span>}
          </InfoCard>
        </div>

        <Card>
          <CardContent className="space-y-3 p-5">
            <h2 className="font-display text-base font-semibold text-foreground">Rules for this quiz</h2>
            <ul className="list-inside list-disc space-y-1.5 text-sm text-foreground/85">
              {version.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Answers save automatically and the server acknowledges each one. Browser signals are recorded as events
              for your instructor; they are never treated as proof of misconduct on their own.
            </p>
          </CardContent>
        </Card>

        {isStudent && checks.length > 0 && (canStart || my?.in_progress) && (
          <Card>
            <CardContent className="space-y-2 p-5">
              <h2 className="flex items-center gap-2 font-display text-base font-semibold text-foreground">
                <MonitorCheck className="size-5 text-primary" aria-hidden="true" />
                System check
              </h2>
              <ul className="space-y-1.5 text-sm">
                {checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2">
                    {c.ok === null ? (
                      <Radio className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : c.ok ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                    )}
                    <span>
                      <strong>{c.label}:</strong> <span className="text-muted-foreground">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {canStart && (
          <Card>
            <CardContent className="space-y-4 p-5">
              {needsCode && (
                <div className="max-w-xs">
                  <Label htmlFor="access-code" className="flex items-center gap-1.5">
                    <KeyRound className="size-4" aria-hidden="true" />
                    Access code
                  </Label>
                  <Input
                    id="access-code"
                    autoComplete="off"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="Announced by your instructor"
                  />
                </div>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--primary)]"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span>I have read the rules above and I will follow them for the whole attempt.</span>
              </label>
              {notYetOpen && (
                <p className="text-sm text-muted-foreground">This quiz opens at {toLocal(version.window_opens_at)}.</p>
              )}
              <Button
                onClick={() => void start()}
                disabled={startBusy || !agreed || (needsCode && !accessCode.trim()) || blockingCheck || notYetOpen}
              >
                {startBusy ? 'Starting…' : 'Start attempt'}
                <ArrowRight aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {my?.in_progress && (
            <Button
              onClick={() => {
                // Same click: browsers only grant full screen in response to user input.
                if (settings.require_fullscreen && document.fullscreenEnabled) {
                  void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
                }
                navigate(`/attempts/${my.in_progress}`);
              }}
            >
              Continue attempt
              <ArrowRight aria-hidden="true" />
            </Button>
          )}
          {isStudent && my?.locked && (
            <Button variant="secondary" onClick={() => navigate(`/attempts/${my.locked}`)}>
              <Lock aria-hidden="true" /> View locked attempt
            </Button>
          )}
          {isStudent && !my?.in_progress && version.closed && (
            <EmptyState icon={Lock} title="Quiz closed" description="Your instructor has ended this quiz." />
          )}
          {isStudent && !my?.in_progress && !version.closed && version.paused && (
            <EmptyState icon={PauseCircle} title="Quiz paused" description="Your instructor paused this quiz. Starting is possible again when it resumes." />
          )}
          {isStudent && attemptsRemaining <= 0 && !my?.in_progress && (
            <EmptyState
              icon={XCircle}
              title="No attempts remaining"
              description={`All ${version.attempts_allowed} allowed attempt(s) have been used. Contact your instructor if you need another.`}
            />
          )}
          {isStaff && (
            <>
              <Button variant="secondary" onClick={() => navigate(`/quizzes/${quizId}`)}>
                Open editor
              </Button>
              {version.status === 'published' && (
                <Button onClick={() => navigate(`/quizzes/${quizId}/monitor`)}>
                  <Radio aria-hidden="true" /> Live monitor
                </Button>
              )}
            </>
          )}
        </div>
      </motion.div>
    </Page>
  );
}

function InfoCard({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        {icon}
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="text-sm font-semibold text-foreground">{children}</p>
        </div>
      </CardContent>
    </Card>
  );
}
