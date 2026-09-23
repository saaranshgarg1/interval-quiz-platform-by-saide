import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import type { CourseQuizzesResponse, QuizList } from '../types';
import { Pill } from '../components/ui';

interface CourseBlock {
  id: number;
  code: string;
  name: string;
  my_role?: string;
  quizzes: QuizList[];
}

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<CourseBlock[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ courses: { id: number; code: string; name: string; my_role?: string }[] }>('/courses');
      const blocks: CourseBlock[] = await Promise.all(
        res.courses.map(async (c) => {
          const qz = await api.get<CourseQuizzesResponse>(`/quizzes/course/${c.id}`);
          return { id: c.id, code: c.code, name: c.name, my_role: c.my_role, quizzes: qz.quizzes };
        }),
      );
      setCourses(blocks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load courses.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const published = (c: CourseBlock) => c.quizzes.filter((q) => q.published);
  const drafts = (c: CourseBlock) => c.quizzes.filter((q) => q.draft && !q.published);

  return (
    <div>
      <div className="card-row">
        <div className="grow">
          <h1>Hello, {user?.name.split(' ')[0]}.</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {user?.role === 'student'
              ? 'Your courses and available quizzes. Saved answers survive interruptions — watch the save indicator.'
              : 'Your courses. You can author, publish, review incidents and release results here.'}
          </p>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {courses.length === 0 && !error && <p className="muted">Loading courses…</p>}

      <section style={{ marginTop: '1.25rem' }}>
        <h2>Your courses</h2>
        {courses.length === 0 && !error && (
          <div className="card empty">No courses yet. Contact an instructor to be enrolled.</div>
        )}
        <div className="grid-2">
          {courses.map((c) => (
            <div className="card" key={c.id}>
              <div className="card-row">
                <div className="grow">
                  <strong style={{ color: 'var(--brand)' }}>{c.code}</strong>
                  <div>{c.name}</div>
                  <div className="muted small">Your role: {c.my_role}</div>
                </div>
                <Link className="btn small secondary" to={`/courses/${c.id}`}>
                  Open course
                </Link>
              </div>
              <div style={{ marginTop: '0.6rem', fontSize: '0.9rem' }}>
                {published(c).length === 0 && drafts(c).length === 0 && (
                  <span className="muted small">No quizzes yet.</span>
                )}
                {published(c).map((q) => {
                  const st = q.published?.my_attempts;
                  return (
                    <div key={q.quiz_id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                      <Link to={`/quizzes/${q.quiz_id}/preflight`}>{q.published?.title}</Link>
                      {st?.in_progress ? (
                        <Pill tone="brand" symbol="◐">Continue attempt</Pill>
                      ) : st && (st.count ?? 0) > 0 ? (
                        <Pill tone="ok" symbol="✓">{st.count} attempt(s)</Pill>
                      ) : (
                        <Pill tone="neutral" symbol="·">v{q.published?.version}</Pill>
                      )}
                      <span className="muted small">
                        {st?.count ?? 0}/{q.published?.attempts_allowed ?? 1}
                      </span>
                    </div>
                  );
                })}
                {drafts(c).map((q) => (
                  <div key={q.quiz_id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                    {q.draft?.title}
                    <Pill tone="warn" symbol="✎">Draft</Pill>
                    <Link className="small" to={`/quizzes/${q.quiz_id}`}>Edit draft</Link>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Quick actions</h2>
        <div className="grid-3">
          <div className="card">
            <h3>Complete a quiz</h3>
            <p className="small muted">Pick a course above and enter a published quiz. Review the rules on the preflight screen, then start.</p>
          </div>
          {user?.role !== 'student' && (
            <div className="card">
              <h3>Publish a quiz</h3>
              <p className="small muted">Create a draft in a course, add questions, preview, then publish. Grading and results follow.</p>
            </div>
          )}
          <div className="card">
            <h3>Review incidents</h3>
            <p className="small muted">
              Locked or expired attempts appear under Incidents for authorized review.
              {user?.role !== 'student' && (
                <button className="btn small secondary" onClick={() => navigate('/incidents')} style={{ marginTop: '0.4rem' }}>
                  Open incidents
                </button>
              )}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}