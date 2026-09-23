import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { QuizDetailResponse } from '../types';
import { Pill, statusLabel } from '../components/ui';
import type { ReactNode } from 'react';

const POLICY_TEXT: Record<string, { label: string; body: string }> = {
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

interface PastAttempt {
  id: number;
  status: string;
  started_at: string;
  submitted_at: string | null;
  receipt: string | null;
  score: number | null;
  max_score: number | null;
  can_view_result: boolean;
}

export function QuizPreflightPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [detail, setDetail] = useState<QuizDetailResponse | null>(null);
  const [past, setPast] = useState<PastAttempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<QuizDetailResponse>(`/quizzes/${quizId}`);
      setDetail(res);
      const version = res.versions.find((v) => v.status === 'published') ?? res.versions[0];
      if (version) {
        const mine = await api.get<{ attempts: PastAttempt[] }>(`/attempts/quiz/${version.id}/mine`);
        setPast(mine.attempts);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load quiz.');
    }
  }, [quizId]);

  useEffect(() => {
    void load();
  }, [load]);

  const version = detail?.versions.find((v) => v.status === 'published') ?? detail?.versions[0];
  const my = version?.my_attempts;
  const isStaff = user?.role !== 'student';
  const canStart = !!version && user?.role === 'student' && !my?.in_progress;

  const start = async () => {
    if (!version) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.post<{ attempt: { id: number } }>(`/attempts/quiz/${version.id}`);
      navigate(`/attempts/${view.attempt.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start attempt.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) return <div className="banner error">{error}</div>;
  if (!detail || !version) return <p className="muted">Loading quiz…</p>;

  const policy = POLICY_TEXT[version.integrity_policy] ?? POLICY_TEXT.off;

  return (
    <div>
      <div className="card-row">
        <div className="grow">
          <h1>{version.title}</h1>
          <p className="muted small">Version {version.version}</p>
        </div>
        <Pill tone={version.status === 'published' ? 'ok' : 'warn'} symbol={version.status === 'published' ? '✓' : '✎'}>
          {version.status}
        </Pill>
      </div>

      {error && <div className="banner error">{error}</div>}
      <p>{version.instructions || 'No further instructions were provided.'}</p>

      <div className="grid-3" style={{ margin: '1rem 0' }}>
        <div className="card">
          <h3>Questions</h3>
          <div className="muted">{version.questions.length} question(s)</div>
        </div>
        <div className="card">
          <h3>Time limit</h3>
          <div className="muted">{version.duration_minutes ? `${version.duration_minutes} minutes` : 'No timer'}</div>
        </div>
        <div className="card">
          <h3>Attempts</h3>
          <div className="muted">
            {my?.count ?? 0}/{version.attempts_allowed} used
            {my?.best_score != null ? ` · best ${my.best_score}` : ''}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>What we monitor (preflight disclosure)</h3>
        <p className="small">
          <Pill tone={version.integrity_policy === 'off' ? 'ok' : version.integrity_policy === 'warn' ? 'warn' : 'danger'} symbol="·">
            Policy: {policy.label}
          </Pill>
        </p>
        <p className="small muted">{policy.body}</p>
        <p className="small muted">
          Answers are saved automatically with a server acknowledgement. Look for the <strong>Save status</strong> line;{' '}
          <strong>Saved</strong> means the server stored it. You can always see your latest acknowledged save.
        </p>
      </div>

      <div style={{ marginTop: '1.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {user?.role === 'student' && my?.in_progress ? (
          <button className="btn" onClick={() => navigate(`/attempts/${my.in_progress}`)}>
            ◐ Continue attempt
          </button>
        ) : null}
        {canStart && version.status === 'published' && (my?.count ?? 0) < version.attempts_allowed && (
          <button className="btn" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Start attempt'}
          </button>
        )}
        {version.status === 'published' && isStaff && (
          <button className="btn secondary" onClick={() => navigate(`/quizzes/${quizId}`)}>
            Open editor
          </button>
        )}
        {isStaff && (
          <a className="btn secondary" href={`/api/results/quiz/${version.id}/export.csv`} target="_blank" rel="noreferrer">
            Export results CSV
          </a>
        )}
      </div>

      {(my?.count ?? 0) >= version.attempts_allowed && user?.role === 'student' && (
        <div className="banner warn" style={{ marginTop: '1rem' }}>
          You have used all {version.attempts_allowed} allowed attempt(s). Contact your instructor if you need another.
        </div>
      )}

      {past.length > 0 && (
        <section style={{ marginTop: '1.5rem' }}>
          <h3>Your attempts</h3>
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>Status</th>
                <th>Started</th>
                <th>Submitted</th>
                <th>Receipt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {past.map((a, i) => {
                const st = statusLabel(a.status);
                return (
                  <tr key={a.id}>
                    <td>{past.length - i}</td>
                    <td><Pill tone={st.tone} symbol={st.symbol}>{st.label}</Pill></td>
                    <td className="small">{new Date(a.started_at).toLocaleString()}</td>
                    <td className="small">{a.submitted_at ? new Date(a.submitted_at).toLocaleString() : '—'}</td>
                    <td className="mono small">{a.receipt ?? '—'}</td>
                    <td>
                      {a.can_view_result && (
                        <LinkButton to={`/results/attempt/${a.id}`}>View result</LinkButton>
                      )}
                      {a.status === 'locked' && <span className="muted small">Locked · request review</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function LinkButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="btn small secondary" to={to}>
      {children}
    </Link>
  );
}