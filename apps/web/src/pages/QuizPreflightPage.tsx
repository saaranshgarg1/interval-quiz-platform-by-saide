import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuiz } from '../lib/queries';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { VersionDetail } from '../types';
import { Page, EmptyState, ErrorState, LoadingSkeleton } from '../components/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  ShieldAlert,
  Clock,
  FileText,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';

const POLICY_TEXT: Record<VersionDetail['integrity_policy'], { label: string; body: string }> = {
  off: {
    label: 'Off',
    body: 'No focus-monitoring events are collected during your attempt. Your answers are the only recorded data.',
  },
  warn: {
    label: 'Warn & record',
    body: 'Leaving the quiz window may be recorded and shown to your instructor. Nothing locks automatically; you can keep going.',
  },
  strict: {
    label: 'Strict',
    body: 'If the configured trigger happens (leaving the quiz window), the server locks your attempt. Your acknowledged answers are preserved and the deadline keeps running. You can resume only after your instructor reviews and reinstates the attempt.',
  },
};

function policyBadgeVariant(policy: VersionDetail['integrity_policy']): 'default' | 'secondary' | 'destructive' {
  if (policy === 'strict') return 'destructive';
  if (policy === 'warn') return 'secondary';
  return 'default';
}

function statusBadge(status: VersionDetail['status']): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  switch (status) {
    case 'published':
      return { label: 'Published', variant: 'default' };
    case 'archived':
      return { label: 'Archived', variant: 'destructive' };
    default:
      return { label: 'Draft', variant: 'secondary' };
  }
}

export function QuizPreflightPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const quizNumericId = Number(quizId);

  const [startError, setStartError] = useState<string | null>(null);
  const [startBusy, setStartBusy] = useState(false);

  const {
    data: quizResponse,
    isLoading,
    isError,
    error: queryError,
    refetch,
  } = useQuiz(quizNumericId);

  // framer-motion entrance, guarded by prefers-reduced-motion
  const reduceMotion = useReducedMotion();
  const entrance =
    reduceMotion === false
      ? {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const },
        }
      : { initial: undefined, animate: undefined, transition: undefined };

  const version =
    quizResponse?.versions.find((v) => v.status === 'published') ?? quizResponse?.versions[0];

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
        <ErrorState
          title="Could not load this quiz"
          error={queryError}
          onRetry={() => void refetch()}
        />
      </Page>
    );
  }

  if (!quizResponse || !version) {
    return (
      <Page title="Quiz preflight">
        <EmptyState
          icon={FileText}
          title="No quiz found"
          description="This quiz does not exist or has no versions available yet."
        />
      </Page>
    );
  }

  const isStaff = user?.role !== 'student';
  const isStudent = user?.role === 'student';
  const my = version.my_attempts;
  const attemptsUsed = my?.count ?? 0;
  const attemptsAllowed = version.attempts_allowed;
  const attemptsRemaining = attemptsAllowed - attemptsUsed;
  const canStart = isStudent && !my?.in_progress && version.status === 'published' && attemptsRemaining > 0;
  const policy = POLICY_TEXT[version.integrity_policy];
  const statusInfo = statusBadge(version.status);

  const start = async () => {
    setStartBusy(true);
    setStartError(null);
    try {
      const view = await api.post<{ attempt: { id: number } }>(`/attempts/quiz/${version.id}`);
      navigate(`/attempts/${view.attempt.id}`);
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : 'Could not start attempt.');
    } finally {
      setStartBusy(false);
    }
  };

  return (
    <Page title={version.title} description={`Version ${version.version}`}>
      <motion.div className="stack-md" {...entrance}>
        {/* Badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
          <Badge variant={policyBadgeVariant(version.integrity_policy)}>
            Policy: {policy.label}
          </Badge>
        </div>

        <Separator />

        {/* Start error (inline) */}
        {startError && (
          <div
            role="alert"
            className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {startError}
          </div>
        )}

        {/* Info cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="flex items-center gap-3 p-5 pt-0">
              <FileText className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-muted-foreground">Questions</p>
                <p className="text-sm font-semibold text-foreground">{version.questions.length}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-5 pt-0">
              <Clock className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-muted-foreground">Time limit</p>
                <p className="text-sm font-semibold text-foreground">
                  {version.duration_minutes ? `${version.duration_minutes} min` : 'No timer'}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-3 p-5 pt-0">
              {attemptsRemaining > 0 ? (
                <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <XCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
              )}
              <div>
                <p className="text-xs font-medium text-muted-foreground">Attempts</p>
                <p className="text-sm font-semibold text-foreground">
                  {attemptsUsed} / {attemptsAllowed} used
                  {my?.best_score != null ? (
                    <span className="ml-1 text-muted-foreground">· best {my.best_score}</span>
                  ) : null}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Integrity policy disclosure */}
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <ShieldAlert
                className={
                  version.integrity_policy === 'strict'
                    ? 'size-5 text-destructive'
                    : version.integrity_policy === 'warn'
                      ? 'size-5 text-warning'
                      : 'size-5 text-muted-foreground'
                }
                aria-hidden="true"
              />
              <h2 className="font-display text-base font-semibold text-foreground">
                Integrity policy: {policy.label}
              </h2>
            </div>

            <p className="text-sm text-foreground/80">{policy.body}</p>

            {version.integrity_policy === 'strict' && (
              <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-warning/40 bg-[var(--warning)]/10 p-3 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <p>
                  <strong>Strict policy active.</strong> Leaving the quiz window may lock your attempt until an
                  instructor reviews and reinstates it. The deadline keeps running while locked.
                </p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Answers are saved automatically with a server acknowledgement. Look for the <strong>Save status</strong> line
              in the attempt — <strong>Saved</strong> means the server stored it. You can always see your latest
              acknowledged save.
            </p>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3">
          {my?.in_progress && (
            <Button onClick={() => navigate(`/attempts/${my.in_progress}`)}>
              Continue attempt
              <ArrowRight aria-hidden="true" />
            </Button>
          )}

          {canStart && (
            <Button onClick={() => void start()} disabled={startBusy}>
              {startBusy ? 'Starting…' : 'Start attempt'}
            </Button>
          )}

          {version.status !== 'published' && (
            <EmptyState
              icon={FileText}
              title="Not yet published"
              description="Only published versions can be started. Ask the instructor to publish this version first."
            />
          )}

          {version.status === 'published' && isStudent && attemptsRemaining <= 0 && (
            <EmptyState
              icon={XCircle}
              title="No attempts remaining"
              description={`All ${attemptsAllowed} allowed attempt(s) have been used. Contact your instructor if you need another.`}
            />
          )}

          {isStaff && (
            <Button variant="secondary" onClick={() => navigate(`/quizzes/${quizId}`)}>
              Open editor
            </Button>
          )}
        </div>
      </motion.div>
    </Page>
  );
}
