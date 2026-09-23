import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { ResultDetail } from '../types';
import { Pill, formatDateTime } from '../components/ui';
import { RichText } from '../components/RichText';

function prettyAnswer(_qtype: string, v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? `[${v.join(', ')}]` : '—';
  return String(v);
}

export function ResultDetailPage() {
  const { attemptId } = useParams();
  const [result, setResult] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ result: ResultDetail }>(`/results/attempt/${attemptId}`);
      setResult(res.result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this result.');
    }
  }, [attemptId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="banner error">{error}</div>;
  if (!result) return <p className="muted">Loading result…</p>;

  const answered = result.per_question.filter((q) => q.answered).length;

  return (
    <div>
      <div className="card-row">
        <div className="grow">
          <h1>{result.quiz_title}</h1>
          <p className="muted small">
            {result.course_code} · {result.course_name} · v{result.version} · submitted{' '}
            {formatDateTime(result.submitted_at)}
          </p>
        </div>
        <Pill tone={result.score >= result.max_score * 0.6 ? 'ok' : 'warn'} symbol="✓">
          {result.score}/{result.max_score}
        </Pill>
      </div>

      <div className="grid-3" style={{ margin: '1rem 0' }}>
        <div className="card">
          <h3>Score</h3>
          <strong>{result.score}</strong> / {result.max_score}
        </div>
        <div className="card">
          <h3>Answered</h3>
          {answered}/{result.per_question.length} questions
        </div>
        <div className="card">
          <h3>Answer key</h3>
          {result.answer_key_released ? 'Released with result' : 'Not released'}
        </div>
      </div>

      {result.answer_key_released === 0 && (
        <div className="banner info">
          The instructor has not released the answer key for this quiz. You can see your own answers and how many points
          you earned per question.
        </div>
      )}

      <h2>Question breakdown</h2>
      {result.per_question.map((q, i) => (
        <div className="card" key={q.question_id}>
          <div className="card-row">
            <div className="grow">
              <strong>Q{i + 1}</strong> · <Pill tone="neutral" symbol="·">{q.qtype}</Pill> · {q.points} pt
              <div style={{ margin: '0.4rem 0', fontWeight: 600 }}>
                <RichText content={q.text} />
              </div>
            </div>
            <Pill tone={q.earned > 0 ? 'ok' : q.answered ? 'danger' : 'neutral'} symbol={q.earned > 0 ? '✓' : q.answered ? '✗' : '·'}>
              {q.earned} / {q.points} pt
            </Pill>
          </div>
          <div className="grid-3" style={{ marginTop: '0.6rem' }}>
            <div>
              <div className="muted small">Your answer</div>
              <div>{prettyAnswer(q.qtype, q.your_answer)}</div>
            </div>
            {result.answer_key_released && q.correct_answer != null && (
              <div>
                <div className="muted small">Correct answer</div>
                <div>{prettyAnswer(q.qtype, q.correct_answer)}</div>
              </div>
            )}
          </div>
          {q.options.length > 0 && (
            <div className="muted small" style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {q.options.map((o, optIdx) => (
                <div key={optIdx} style={{ display: 'flex', gap: '6px' }}>
                  <span>{String.fromCharCode(65 + optIdx)}.</span>
                  <RichText content={o} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <p style={{ marginTop: '1rem' }}>
        <Link className="btn secondary" to="/results">← All results</Link>
      </p>
    </div>
  );
}