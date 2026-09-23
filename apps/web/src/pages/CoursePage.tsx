import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { CourseQuizzesResponse, RosterResponse } from '../types';
import { Pill, formatDateTime } from '../components/ui';
import { AccommodationsModal } from '../components/AccommodationsModal';

export function CoursePage() {
  const { courseId } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<{ course: { id: number; code: string; name: string }; role: string; roster?: RosterResponse['roster'] } | null>(null);
  const [quizzes, setQuizzes] = useState<CourseQuizzesResponse['quizzes']>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAccommodations, setShowAccommodations] = useState(false);

  const isStaff = !!data && data.role !== 'student';

  const load = useCallback(async () => {
    const cid = Number(courseId);
    try {
      const [course, qz] = await Promise.all([
        api.get<{ course: { id: number; code: string; name: string }; role: string; roster?: RosterResponse['roster'] }>(`/courses/${cid}`),
        api.get<CourseQuizzesResponse>(`/quizzes/course/${cid}`),
      ]);
      setData(course);
      setQuizzes(qz.quizzes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load course.');
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createQuiz = async () => {
    try {
      const res = await api.post<{ quiz_id: number }>(`/quizzes/course/${courseId}`);
      window.location.href = `/quizzes/${res.quiz_id}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Creation failed.');
    }
  };

  const release = async (versionId: number) => {
    try {
      const r = await api.post<{ released: number }>(`/results/quiz/${versionId}/release`);
      setMsg(`Released ${r.released} result(s).`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Release failed.');
    }
  };

  const addMember = async (email: string, role: string) => {
    try {
      await api.put(`/courses/${courseId}/members`, { email, memberRole: role });
      setMsg(`Added ${email} as ${role}.`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Adding member failed.');
    }
  };

  const removeMember = async (userId: number) => {
    try {
      await api.del(`/courses/${courseId}/members/${userId}`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove member.');
    }
  };

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading course…</p>;

  return (
    <div>
      <div className="card-row">
        <div className="grow">
          <h1>{data.course.code} · {data.course.name}</h1>
          <span className="muted small">Your role: <strong>{data.role}</strong></span>
        </div>
        {isStaff && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <Link className="btn secondary" to={`/courses/${courseId}/banks`}>
              📚 Question Banks
            </Link>
            <button className="btn secondary" onClick={() => setShowAccommodations(true)}>
              ⏱ Accommodations
            </button>
            <button className="btn" onClick={() => void createQuiz()}>
              + New quiz
            </button>
          </div>
        )}
      </div>
      {msg && <div className="banner ok">{msg}</div>}

      <section style={{ marginTop: '1.25rem' }}>
        <h2>Quizzes</h2>
        {quizzes.length === 0 && <div className="card empty">No quizzes yet.</div>}
        {quizzes.map((q) => {
          const pub = q.published;
          const draft = q.draft;
          const st = pub?.my_attempts;
          return (
            <div className="card" key={q.quiz_id}>
              <div className="card-row">
                <div className="grow">
                  <strong>{pub?.title ?? draft?.title}</strong>
                  {pub && <Pill tone="ok" symbol="✓">Published v{pub.version}</Pill>}
                  {draft && !pub && <Pill tone="warn" symbol="✎">Draft</Pill>}
                  <div className="muted small">
                    {pub
                      ? `${pub.questions.length} questions · ${pub.duration_minutes ? pub.duration_minutes + ' min' : 'no timer'} · policy ${pub.integrity_policy} · ${pub.show_scores} scores`
                      : `${draft?.questions.length ?? 0} questions in draft`}
                  </div>
                  {pub?.published_at && <div className="muted small">Published {formatDateTime(pub.published_at)}</div>}
                  {pub?.attempts && pub.attempts.total > 0 && (
                    <div className="muted small">
                      {pub.attempts.total} attempt(s): {Object.entries(pub.attempts.statuses).map(([k, v]) => `${k} ${v}`).join(', ')} · avg {(pub.attempts.avg_score ?? 0).toFixed(1)}
                    </div>
                  )}
                  {st && st.count > 0 && (
                    <div className="muted small">
                      Your attempts: {st.count} · best {st.best_score ?? '—'}
                      {st.last_status === 'submitted' && st.last_receipt ? ` · receipt ${st.last_receipt}` : ''}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {pub && (
                    <Link className="btn small secondary" to={`/quizzes/${q.quiz_id}/preflight`}>
                      {st?.in_progress ? 'Continue attempt' : user?.role === 'student' ? 'Take quiz' : 'View published'}
                    </Link>
                  )}
                  {isStaff && draft && <Link className="btn small secondary" to={`/quizzes/${q.quiz_id}`}>Edit draft</Link>}
                  {isStaff && pub && (
                    <>
                      <Link className="btn small secondary" to={`/analytics/version/${pub.id}`}>
                        📊 Analytics
                      </Link>
                      <button className="btn small secondary" onClick={() => void release(pub.id)}>Release results</button>
                      <Link className="btn small secondary" to={`/quizzes/${q.quiz_id}`}>View</Link>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {showAccommodations && (
        <AccommodationsModal
          courseId={Number(courseId)}
          isOpen={showAccommodations}
          onClose={() => setShowAccommodations(false)}
        />
      )}

      {isStaff && (
        <RosterCard courseId={Number(courseId)} roster={data.roster ?? []} onAdd={addMember} onRemove={removeMember} />
      )}
    </div>
  );
}

function RosterCard({
  courseId,
  roster,
  onAdd,
  onRemove,
}: {
  courseId: number;
  roster: RosterResponse['roster'];
  onAdd: (email: string, role: string) => void;
  onRemove: (userId: number) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('student');
  void courseId;
  return (
    <section style={{ marginTop: '2rem' }}>
      <h2>Roster</h2>
      <div className="card">
        <div className="field-row" style={{ marginBottom: '0.9rem' }}>
          <div className="field grow" style={{ marginBottom: 0 }}>
            <label htmlFor="member-email">Add member (uses existing account email)</label>
            <input
              id="member-email"
              type="email"
              placeholder="student@iitrpr.ac.in"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="member-role">Role</label>
            <select id="member-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="student">Student</option>
              <option value="ta">TA</option>
              <option value="instructor">Instructor</option>
            </select>
          </div>
          <button
            className="btn secondary"
            style={{ alignSelf: 'flex-end' }}
            disabled={!email}
            onClick={() => {
              void onAdd(email, role);
              setEmail('');
            }}
          >
            Add
          </button>
        </div>
        {roster.length === 0 ? (
          <p className="muted small">No members yet.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th aria-label="actions"></th>
              </tr>
            </thead>
            <tbody>
              {roster.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="mono">{m.email}</td>
                  <td><Pill tone={m.role === 'instructor' ? 'brand' : m.role === 'ta' ? 'warn' : 'neutral'} symbol="·">{m.role}</Pill></td>
                  <td>
                    <button className="btn small ghost-danger" onClick={() => void onRemove(m.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}