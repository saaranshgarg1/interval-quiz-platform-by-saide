import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ResultRow } from '../types';
import { Pill, formatDateTime } from '../components/ui';

export function ResultsPage() {
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ results: ResultRow[] }>('/results/mine');
      setResults(res.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load results.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>My results</h1>
      <p className="muted small">
        Results appear once your instructor releases them (or immediately for practice quizzes configured that way).
      </p>
      {error && <div className="banner error">{error}</div>}
      {!results && !error && <p className="muted">Loading…</p>}
      {results && results.length === 0 && (
        <div className="card empty">No results released yet.</div>
      )}
      {results && results.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Course</th>
              <th>Quiz</th>
              <th>Score</th>
              <th>Submitted</th>
              <th>Released</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td><span style={{ color: 'var(--brand)', fontWeight: 600 }}>{r.course_code}</span> <span className="muted small">{r.course_name}</span></td>
                <td>{r.quiz_title} <span className="muted small">v{r.version}</span></td>
                <td><Pill tone="ok" symbol="✓">{r.score}/{r.max_score}</Pill></td>
                <td className="small">{formatDateTime(r.submitted_at)}</td>
                <td className="small">{formatDateTime(r.released_at)}</td>
                <td>
                  <Link className="btn small secondary" to={`/results/attempt/${r.attempt_id}`}>
                    View breakdown
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}