import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Lock,
  Maximize,
  Megaphone,
  MonitorSmartphone,
  PauseCircle,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import type { Announcement, AttemptMeta } from '../../types';

/** Student name + entry number tiled faintly over the questions (deters sharing screenshots). */
export function Watermark({ lines }: { lines: string[] }) {
  const url = useMemo(() => {
    const esc = (t: string) => t.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const text = lines
      .map((l, i) => `<text x="0" y="${20 + i * 18}" font-family="sans-serif" font-size="13">${esc(l)}</text>`)
      .join('');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160">` +
      `<g transform="rotate(-24 150 80) translate(40 60)" fill="rgb(128,128,128)" fill-opacity="0.16">${text}</g></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  }, [lines]);
  return <div aria-hidden="true" className="exam-watermark" style={{ backgroundImage: url }} />;
}

export function AnnouncementsBar({ items }: { items: Announcement[] }) {
  if (items.length === 0) return null;
  const latest = [...items].reverse();
  return (
    <section aria-label="Announcements from your instructor" className="mb-3 space-y-2" aria-live="polite">
      {latest.slice(0, 3).map((a) => (
        <div
          key={a.id}
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
        >
          <Megaphone className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">
              {a.personal ? 'Message for you' : 'Announcement'}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{formatClock(a.created_at)}</span>
            </p>
            <p className="whitespace-pre-wrap break-words text-foreground/90">{a.message}</p>
          </div>
        </div>
      ))}
      {latest.length > 3 && (
        <p className="text-xs text-muted-foreground">{latest.length - 3} earlier announcement(s) not shown.</p>
      )}
    </section>
  );
}

export interface ViolationNotice {
  message: string;
  count: number;
  max: number;
  action: 'none' | 'lock' | 'submit';
}

export function ViolationDialog({ notice, onClose }: { notice: ViolationNotice | null; onClose: () => void }) {
  return (
    <AlertDialog open={notice !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-warning" aria-hidden="true" />
            Exam rule warning
          </AlertDialogTitle>
          <AlertDialogDescription>{notice?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {notice && notice.action !== 'none' && (
          <div className="flex items-center gap-2" aria-label={`${notice.count} of ${notice.max} violations`}>
            {Array.from({ length: notice.max }).map((_, i) => (
              <span
                key={i}
                className={`h-2 flex-1 rounded-full ${i < notice.count ? 'bg-destructive' : 'bg-muted'}`}
              />
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>I understand — back to the quiz</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-background/95 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      {children}
    </div>
  );
}

export function FullscreenGate({
  supported,
  onEnter,
  started,
}: {
  supported: boolean;
  onEnter: () => void;
  started: boolean;
}) {
  // Browsers only allow full screen in response to the student's own input, so
  // the first click or key press anywhere puts them straight back.
  useEffect(() => {
    if (!supported) return;
    const back = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') return;
      onEnter();
    };
    window.addEventListener('pointerdown', back, { capture: true });
    window.addEventListener('keydown', back, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', back, { capture: true });
      window.removeEventListener('keydown', back, { capture: true });
    };
  }, [supported, onEnter]);
  return (
    <Overlay>
      <Card className="max-w-md text-center">
        <CardHeader>
          <div className="mb-3 flex justify-center">
            <Maximize className="size-10 text-primary" aria-hidden="true" />
          </div>
          <CardTitle>{started ? 'Return to full screen' : 'This quiz runs in full screen'}</CardTitle>
          <CardDescription>
            {supported
              ? started
                ? 'You left full screen, which was recorded. Click anywhere or press any key to go back — your timer is still running.'
                : 'Click anywhere or press any key to enter full screen. The questions appear once the quiz is in full screen.'
              : 'Your browser does not allow full screen here. Use an up-to-date Chrome, Edge or Firefox on a laptop or desktop.'}
          </CardDescription>
        </CardHeader>
        {supported && (
          <CardFooter className="justify-center">
            <Button onClick={onEnter} autoFocus>
              <Maximize aria-hidden="true" />
              Enter full screen
            </Button>
          </CardFooter>
        )}
      </Card>
    </Overlay>
  );
}

export function PausedOverlay() {
  return (
    <Overlay>
      <Card className="max-w-md text-center">
        <CardHeader>
          <div className="mb-3 flex justify-center">
            <PauseCircle className="size-10 text-warning" aria-hidden="true" />
          </div>
          <CardTitle>Quiz paused by your instructor</CardTitle>
          <CardDescription>
            Your timer is stopped and no time is lost. Stay on this page — the quiz continues automatically when it
            resumes. Leaving the page while paused is not counted.
          </CardDescription>
        </CardHeader>
      </Card>
    </Overlay>
  );
}

export function CenteredCard({
  icon,
  title,
  description,
  children,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="player">
      <Card className="mx-auto max-w-md text-center">
        <CardHeader>
          <div className="mb-3 flex justify-center">{icon}</div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children && <CardContent className="space-y-3">{children}</CardContent>}
        {footer && <CardFooter className="flex flex-wrap justify-center gap-3">{footer}</CardFooter>}
      </Card>
    </div>
  );
}

export interface ClaimInfo {
  otherActive: boolean;
  canTakeover: boolean;
  /** Exit & resume is off: claiming will apply the re-entry rule. */
  reentryAction: 'lock' | 'submit' | null;
}

export function ClaimScreen({
  info,
  busy,
  onClaim,
  onRetry,
  onBack,
}: {
  info: ClaimInfo;
  busy: boolean;
  onClaim: (takeover: boolean) => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  if (info.otherActive && info.canTakeover) {
    return (
      <CenteredCard
        icon={<MonitorSmartphone className="size-10 text-primary" aria-hidden="true" />}
        title="This attempt is open in another window"
        description="You can continue here instead. The other window will be disconnected and this change is recorded for your instructor."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={onBack}>
              Go back
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onClaim(true)}>
              Continue in this window
            </Button>
          </>
        }
      />
    );
  }
  if (info.otherActive) {
    return (
      <CenteredCard
        icon={<MonitorSmartphone className="size-10 text-warning" aria-hidden="true" />}
        title="Continue in your original window"
        description="This attempt is still active in another window, and exit & resume is not allowed for this quiz. Switch back to that window. If you closed it, wait a minute and try again here."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={onBack}>
              Go back
            </Button>
            <Button size="sm" disabled={busy} onClick={onRetry}>
              Check again
            </Button>
          </>
        }
      />
    );
  }
  return (
    <CenteredCard
      icon={<AlertTriangle className="size-10 text-destructive" aria-hidden="true" />}
      title="Exit & resume is not allowed"
      description={
        info.reentryAction === 'submit'
          ? 'You left this attempt. If you continue, it will be submitted with your saved answers.'
          : 'You left this attempt. If you continue, it will be locked until your instructor reviews it. Your saved answers are kept.'
      }
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onBack}>
            Go back
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => onClaim(false)}>
            {info.reentryAction === 'submit' ? 'Continue and submit' : 'Continue and request review'}
          </Button>
        </>
      }
    />
  );
}

const LOCK_TEXT: Record<string, string> = {
  violation_limit:
    'You reached the violation limit for this quiz (switching tabs or windows, or leaving full screen), so your attempt was locked.',
  reentry: 'Exit & resume is not allowed for this quiz, and you came back after leaving it, so your attempt was locked.',
  instructor: 'Your instructor locked this attempt.',
};

export function LockedScreen({
  meta,
  busy,
  onCheck,
  onBack,
}: {
  meta: AttemptMeta;
  busy: boolean;
  onCheck: () => void;
  onBack: () => void;
}) {
  return (
    <CenteredCard
      icon={<Lock className="size-10 text-destructive" aria-hidden="true" />}
      title="Attempt locked"
      description={`${LOCK_TEXT[meta.lock_reason ?? ''] ?? 'The quiz’s integrity policy locked this attempt.'} Your saved answers are preserved and the deadline keeps running.`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onBack}>
            Back
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCheck}>
            Check status
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-left">
        <p className="text-sm font-semibold">What happens next</p>
        <ol className="list-inside list-decimal space-y-1 text-sm text-muted-foreground">
          <li>Your instructor sees this attempt on the live monitor and in Incidents.</li>
          <li>They review the recorded events and your saved answers.</li>
          <li>If they reinstate it, you continue exactly where you left off.</li>
        </ol>
      </div>
    </CenteredCard>
  );
}

const FINISH_TEXT: Record<string, string> = {
  submitted_by_student: 'Your answers were accepted by the server.',
  time_expired: 'Time ran out, so your attempt was submitted automatically with your saved answers.',
  question_time_elapsed: 'The question timers ran out, so your attempt was submitted automatically.',
  violation_limit: 'You reached the violation limit, so your attempt was submitted automatically with your saved answers.',
  reentry: 'You re-entered after leaving the quiz, so your attempt was submitted with your saved answers.',
  instructor_forced: 'Your instructor submitted this attempt with your saved answers.',
  closed_by_instructor: 'Your instructor ended the quiz, so your attempt was submitted with your saved answers.',
};

export function FinishedScreen({
  meta,
  acknowledged,
  onViewResult,
  onHome,
}: {
  meta: AttemptMeta;
  acknowledged: number | null;
  onViewResult: () => void;
  onHome: () => void;
}) {
  const timedOut = meta.status === 'expired';
  return (
    <CenteredCard
      icon={
        timedOut ? (
          <Clock className="size-10 text-warning" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
        )
      }
      title={timedOut ? 'Time’s up — attempt submitted' : 'Submitted'}
      description={FINISH_TEXT[meta.finalize_reason ?? ''] ?? 'Your attempt has been graded with your saved answers.'}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onHome}>
            Back to home
          </Button>
          {meta.score != null && (
            <Button size="sm" onClick={onViewResult}>
              View result
            </Button>
          )}
        </>
      }
    >
      {meta.receipt && (
        <p className="break-all rounded-[var(--radius-md)] bg-muted px-3 py-1.5 font-mono text-sm" role="status">
          Receipt: <strong>{meta.receipt}</strong>
        </p>
      )}
      {acknowledged != null && (
        <p className="text-sm text-muted-foreground">
          Answers stored on the server: <strong>{acknowledged}</strong>
        </p>
      )}
      {meta.score != null ? (
        <Badge variant="success" className="mx-auto">
          Score: {meta.score}/{meta.max_score}
        </Badge>
      ) : (
        <p className="text-xs text-muted-foreground">Your score appears once your instructor has marked any written answers and released results.</p>
      )}
    </CenteredCard>
  );
}

export function formatClock(ts: string): string {
  const d = new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatMs(ms: number): string {
  if (ms <= 0) return '00:00';
  const total = Math.ceil(ms / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}
