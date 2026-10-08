import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Flag,
  Gavel,
  Hand,
  LogIn,
  PencilLine,
  ShieldAlert,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import type { Audit } from '../../types';
import { Button } from '../ui/button';

type Category = 'answers' | 'integrity' | 'session' | 'communication' | 'outcome';

interface Entry {
  at: number;
  ts: string;
  category: Category;
  icon: LucideIcon;
  title: string;
  detail?: string | null;
}

const CATEGORY_TEXT: Record<Category, string> = {
  answers: 'Answers',
  integrity: 'Integrity',
  session: 'Session',
  communication: 'Hands & appeals',
  outcome: 'Outcome',
};

const parse = (ts: string) => new Date(ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`).getTime();

const SESSION_KINDS = new Set([
  'started',
  'session_start',
  'session_resume',
  'session_takeover',
  'reconnected',
  'ip_changed',
  'session_reset',
  'page_exit',
  'reentry_allowed',
  'reentry_blocked',
  'reopened',
  'time_extended',
]);
const OUTCOME_KINDS = new Set(['submitted', 'expired', 'locked', 'locked_confirm', 'reinstated', 'force_submitted', 'violations_cleared']);
/** Logged as events too, but shown from their richer records (hands, flags, appeals, rulings). */
const DUPLICATE_KINDS = new Set(['hand_raised', 'appeal_filed', 'appeal_accepted', 'appeal_rejected', 'flag_raised', 'flag_resolved']);

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'blank';
  if (Array.isArray(v)) return v.length ? v.map((i) => String.fromCharCode(65 + Number(i))).join(', ') : 'blank';
  if (typeof v === 'number') return String(v);
  const t = String(v);
  return t.length > 80 ? `“${t.slice(0, 80)}…”` : `“${t}”`;
}

/**
 * One chronological story of an attempt — every saved answer change, browser
 * and session event, raised hand, appeal and ruling — so a dispute can be
 * settled from evidence rather than memory.
 */
export function AttemptTimeline({ audit }: { audit: Audit }) {
  const [only, setOnly] = useState<Category | 'all'>('all');
  const labels = audit.labels ?? {};
  const label = (qid: number) => labels[String(qid)] ?? `question #${qid}`;

  const entries = useMemo(() => {
    const out: Entry[] = [];
    const push = (ts: string | null | undefined, e: Omit<Entry, 'at' | 'ts'>) => {
      if (ts) out.push({ ...e, ts, at: parse(ts) });
    };
    if (!audit.events.some((e) => e.kind === 'started')) {
      push(audit.attempt.started_at, { category: 'session', icon: LogIn, title: 'Started the attempt', detail: audit.attempt.user_agent });
    }

    // Answer history: show changes, not every keystroke-level save of the same answer.
    const last = new Map<number, string>();
    for (const h of audit.history) {
      const key = JSON.stringify([h.answer, h.assumption ?? null]);
      if (last.get(h.question_id) === key) continue;
      const first = !last.has(h.question_id);
      last.set(h.question_id, key);
      push(h.saved_at, {
        category: 'answers',
        icon: PencilLine,
        title: `${first ? 'Answered' : 'Changed'} ${label(h.question_id)}: ${show(h.answer)}`,
        detail: h.assumption ? `Assumption: ${h.assumption}` : null,
      });
    }
    for (const e of audit.events) {
      if (DUPLICATE_KINDS.has(e.kind)) continue;
      const category: Category = OUTCOME_KINDS.has(e.kind) ? 'outcome' : SESSION_KINDS.has(e.kind) ? 'session' : 'integrity';
      push(e.recorded_at, {
        category,
        icon: e.kind === 'started' ? LogIn : category === 'integrity' ? ShieldAlert : category === 'session' ? Wifi : CheckCircle2,
        title: e.kind.replace(/_/g, ' '),
        detail: `${e.detail ?? ''}${e.source && e.source !== 'client' ? ` (${e.source})` : ''}`,
      });
    }
    for (const h of audit.hands ?? []) {
      push(h.created_at, {
        category: 'communication',
        icon: Hand,
        title: `Raised a hand${h.question_id ? ` about ${label(h.question_id)}` : ''}`,
        detail: h.message,
      });
      if (h.answered_at) {
        push(h.answered_at, {
          category: 'communication',
          icon: Hand,
          title: h.status === 'answered' ? `Invigilator replied${h.broadcast ? ' to everyone' : ''}` : 'Invigilator closed the question',
          detail: h.reply,
        });
      }
    }
    for (const f of audit.flags ?? []) {
      push(f.created_at, { category: 'integrity', icon: Flag, title: `Staff flag (${f.severity})`, detail: f.reason });
      if (f.resolved_at) push(f.resolved_at, { category: 'integrity', icon: Flag, title: 'Flag resolved', detail: f.resolution });
    }
    for (const a of audit.appeals ?? []) {
      push(a.created_at, {
        category: 'communication',
        icon: Gavel,
        title: `Filed a ${a.kind === 'grading' ? 'mark' : 'integrity'} appeal${a.question_id ? ` on ${label(a.question_id)}` : ''}`,
        detail: a.message,
      });
      if (a.resolved_at) {
        push(a.resolved_at, { category: 'communication', icon: Gavel, title: `Appeal ${a.status}`, detail: a.response });
      }
    }
    for (const d of audit.decisions) {
      push(d.created_at, { category: 'outcome', icon: CheckCircle2, title: `Ruling: ${d.decision.replace(/_/g, ' ')} by ${d.decided_by_name}`, detail: d.reason });
    }
    return out.sort((a, b) => a.at - b.at);
  }, [audit]);

  const start = parse(audit.attempt.started_at);
  const visible = only === 'all' ? entries : entries.filter((e) => e.category === only);
  const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.category]: (acc[e.category] ?? 0) + 1 }), {});

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Filter the timeline">
        <Button size="sm" variant={only === 'all' ? 'default' : 'ghost'} onClick={() => setOnly('all')}>
          All ({entries.length})
        </Button>
        {(Object.keys(CATEGORY_TEXT) as Category[])
          .filter((c) => counts[c])
          .map((c) => (
            <Button key={c} size="sm" variant={only === c ? 'default' : 'ghost'} onClick={() => setOnly(c)}>
              {CATEGORY_TEXT[c]} ({counts[c]})
            </Button>
          ))}
      </div>
      <ol className="relative space-y-0 border-l border-[var(--line-strong)] pl-5">
        {visible.map((e, i) => {
          const Icon = e.icon;
          const offset = Math.max(0, Math.round((e.at - start) / 1000));
          return (
            <li key={i} className="relative pb-3">
              <span className="absolute -left-[30px] top-0.5 grid size-5 place-items-center rounded-full border bg-card">
                <Icon
                  className={`size-3 ${e.category === 'integrity' ? 'text-warning' : e.category === 'outcome' ? 'text-primary' : 'text-muted-foreground'}`}
                  aria-hidden="true"
                />
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <time className="font-mono text-xs text-muted-foreground" dateTime={new Date(e.at).toISOString()}>
                  {new Date(e.at).toLocaleTimeString()} · +{Math.floor(offset / 60)}:{String(offset % 60).padStart(2, '0')}
                </time>
                <span className="font-medium first-letter:uppercase">{e.title}</span>
                <span className="sr-only">({CATEGORY_TEXT[e.category]})</span>
              </div>
              {e.detail && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{e.detail}</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
