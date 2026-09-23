import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { Incident, Audit } from '../types';
import { Pill, statusLabel, formatDateTime } from '../components/ui';

export function IncidentsPage() {
  const { attemptId: focusAttemptId } = useParams();
  const navigate = useNavigate();
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [auditId, setAuditId] = useState<number | null>(focusAttemptId ? Number(focusAttemptId) : null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const courses = await api.get<{ courses: { id: number; code: string; my_role?: string }[] }>('/courses');
      const staffCourses = courses.courses.filter((c) => c.my_role !== 'student');
      const per = await Promise.all(
        staffCourses.map(async (c) => {
          const r = await api.get<{ incidents: Incident[] }>(`/attempts/course/${c.id}/incidents`);
          return r.incidents.map((i) => ({ ...i, _course: `${c.code}` as string }));
        }),
      );
      setIncidents(per.flat());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load incidents.');
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const openAudit = useCallback(async (id: number) => {
    setAuditId(id);
    navigate(`/incidents/attempt/${id}`);
    try {
      const res = await api.get<Audit>(`/review/attempt/${id}`);
      setAudit(res);
      setMsg(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load audit trail.');
    }
  }, [navigate]);

  useEffect(() => {
    if (focusAttemptId) void openAudit(Number(focusAttemptId));
  }, [focusAttemptId, openAudit]);

  const decide = async (attId: number, decision: string) => {
    const reason =
      decision === 'reinstate' ? window.prompt('Reason for reinstating (shown in the audit trail).', 'Authorized re-entry after review') : null;
    if (decision === 'reinstate' && reason === null) return;
    try {
      await api.post<unknown>(`/review/attempt/${attId}`, { decision, reason });
      setMsg(`Decision '${decision}' recorded.`);
      setAudit(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Decision failed.');
    }
  };

  return (
    <div>
      <div className="card-row">
        <div className="grow">
          <h1>Incidents & review</h1>
          <p className="muted small">
            Attempts that were locked by the strict policy or finalized when a deadline passed. Review the recorded events
            and the saved answers before deciding.
          </p>
        </div>
      </div>

      {msg && <div className="banner ok">{msg}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="grid-2" style={{ marginTop: '1rem', gridTemplateColumns: 'minmax(360px, 1fr) minmax(360px, 1.4fr)' }}>
        <section>
          <h2>Open items</h2>
          {!incidents && <p className="muted">Loading…</p>}
          {incidents && incidents.length === 0 && (
            <div className="card empty">No locked or expired attempts right now.</div>
          )}
          {incidents?.map((i) => {
            const st = statusLabel(i.status);
            return (
              <div className="card" key={i.attempt_id} style={{ padding: '0.85rem 1rem' }}>
                <button
                  className="btn small ghost"
                  onClick={() => void openAudit(i.attempt_id)}
                  style={{ width: '100%', justifyContent: 'space-between' }}
                >
                  <span>
                    <strong>{i.quiz_title}</strong>
                    <span className="muted small"> · attempt #{i.attempt_id}</span>
                    <span className="muted small"> · started {formatDateTime(i.started_at)}</span>
                  </span>
                  <Pill tone={st.tone} symbol={st.symbol}>{st.label}</Pill>
                </button>
              </div>
            );
          })}
        </section>

        <section>
          <h2>Audit trail</h2>
          {!audit && auditId == null && (
            <div className="card empty">Select an incident to review its audit trail.</div>
          )}
          {!audit && auditId != null && <p className="muted">Loading audit…</p>}
          {audit && <AuditPanel audit={audit} onDecide={(d) => void decide(audit.attempt.id, d)} />}
        </section>
      </div>
    </div>
  );
}

function AuditPanel({ audit, onDecide }: { audit: Audit; onDecide: (decision: string) => void }) {
  const st = statusLabel(audit.attempt.status);
  return (
    <div className="card">
      <div className="card-row">
        <div className="grow">
          <strong>{audit.attempt.quiz_title}</strong> <span className="muted small">v{audit.attempt.version}</span>
        </div>
        <Pill tone={st.tone} symbol={st.symbol}>{st.label}</Pill>
      </div>
      <p className="small muted" style={{ margin: '0.5rem 0' }}>
        Student: <strong>{audit.student?.name}</strong> ({audit.student?.email})
        <br />
        Score: {audit.attempt.score ?? '—'}/{audit.attempt.max_score ?? '—'} · Receipt: <code>{audit.attempt.receipt ?? '—'}</code>
        <br />
        Started {formatDateTime(audit.attempt.started_at)} · Expiry {formatDateTime(audit.attempt.expires_at)}
      </p>

      <h3>Recorded events ({audit.events.length})</h3>
      {audit.events.length === 0 ? (
        <p className="muted small">No policy events recorded.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Kind</th>
              <th>Time</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {audit.events.map((e, i) => (
              <tr key={e.id}>
                <td>{i + 1}</td>
                <td><code>{e.kind}</code></td>
                <td className="small">{new Date(e.recorded_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
                <td className="small">{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Saved answers ({audit.answers.length})</h3>
      {audit.answers.length === 0 ? (
        <p className="muted small">No answers saved yet.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Q</th>
              <th>Answer</th>
              <th>Rev</th>
              <th>Saved at</th>
            </tr>
          </thead>
          <tbody>
            {audit.answers.map((a) => (
              <tr key={a.question_id}>
                <td>{a.position + 1}</td>
                <td className="mono small">{JSON.stringify(a.answer)}</td>
                <td>{a.revision}</td>
                <td className="small">{new Date(a.saved_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {audit.decisions.length > 0 && (
        <>
          <h3>Review decisions</h3>
          <ul className="small">
            {audit.decisions.map((d) => (
              <li key={d.id}>
                <strong>{d.decision}</strong> — {d.decided_by_name} ({d.decided_by_email}) — {new Date(d.created_at.replace(' ', 'T') + 'Z').toLocaleString()}
                {d.reason ? ` — "${d.reason}"` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      {audit.attempt.status === 'locked' && (
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => onDecide('reinstate')}>Reinstate & re-enter</button>
          <button className="btn secondary" onClick={() => onDecide('allow_submit')}>Grade & submit from saved answers</button>
          <button className="btn ghost-danger" onClick={() => onDecide('lock')}>Confirm lock</button>
        </div>
      )}
    </div>
  );
}