import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import type { QuizAnalytics } from '../types';
import { Button, Card, Badge, Pill, formatDateTime, statusLabel } from '../components/ui';
import { RichText } from '../components/RichText';

export const AnalyticsPage: React.FC = () => {
  const { versionId } = useParams<{ versionId: string }>();
  const vId = Number(versionId);

  const [analytics, setAnalytics] = useState<QuizAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vId) return;
    const fetchAnalytics = async () => {
      try {
        setLoading(true);
        const res = await api.get<{ analytics: QuizAnalytics }>(`/analytics/version/${vId}`);
        setAnalytics(res.analytics);
      } catch (err: any) {
        setError(err.message || 'Failed to load quiz analytics.');
      } finally {
        setLoading(false);
      }
    };
    fetchAnalytics();
  }, [vId]);

  if (loading) {
    return (
      <div style={{ maxWidth: '1000px', margin: '40px auto', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading quiz analytics & submissions...
      </div>
    );
  }

  if (error || !analytics) {
    return (
      <div style={{ maxWidth: '1000px', margin: '40px auto', padding: '24px' }}>
        <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '16px', borderRadius: '8px' }}>
          {error || 'Analytics not found.'}
        </div>
      </div>
    );
  }

  const maxBucketCount = Math.max(...analytics.score_buckets.map((b) => b.count), 1);

  const exportSubmissionsCsv = () => {
    if (!analytics || !analytics.submissions) return;
    const headers = ['Attempt ID', 'Student Name', 'Student Email', 'Status', 'Score', 'Max Score', 'Started At', 'Submitted At', 'Receipt'];
    const rows = analytics.submissions.map((s) => [
      s.attempt_id,
      `"${s.user_name.replace(/"/g, '""')}"`,
      s.user_email,
      s.status,
      s.score ?? '',
      s.max_score ?? '',
      s.started_at,
      s.submitted_at ?? '',
      s.receipt ?? '',
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${analytics.title.replace(/\s+/g, '_')}_submissions.csv`;
    a.click();
  };

  return (
    <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.75rem' }}>Quiz Analytics: {analytics.title}</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted, #64748b)' }}>
            Student submissions, item psychometrics, and score distribution.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant="secondary" onClick={exportSubmissionsCsv} disabled={!analytics.submissions?.length}>
            📥 Export CSV
          </Button>
          <Button variant="secondary" onClick={() => window.history.back()}>
            ← Back
          </Button>
        </div>
      </div>

      {/* Metric Cards Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <Card style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Total Attempts</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '4px 0' }}>{analytics.total_attempts}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {analytics.submitted_count} submitted · {analytics.locked_count} locked
          </div>
        </Card>

        <Card style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Average Score</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '4px 0', color: 'var(--primary, #2563eb)' }}>
            {analytics.mean_score} <span style={{ fontSize: '1rem', fontWeight: 400 }}>/ {analytics.max_score}</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {analytics.max_score > 0 ? Math.round((analytics.mean_score / analytics.max_score) * 100) : 0}% mean performance
          </div>
        </Card>

        <Card style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Median Score</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '4px 0' }}>{analytics.median_score}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>50th percentile mark</div>
        </Card>

        <Card style={{ padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Score Range</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700, margin: '4px 0' }}>
            {analytics.lowest_score} - {analytics.highest_score}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Min to Max achieved</div>
        </Card>
      </div>

      {/* Student Submissions Table */}
      <Card style={{ padding: '24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Student Submissions & Score Roster ({analytics.submissions?.length ?? 0})</h3>
            <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Individual student attempts, scores, submission timestamps, and receipts.
            </p>
          </div>
        </div>

        {!analytics.submissions || analytics.submissions.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>No student attempts recorded for this quiz version yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border, #cbd5e1)', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '10px 8px' }}>Student</th>
                  <th style={{ padding: '10px 8px' }}>Status</th>
                  <th style={{ padding: '10px 8px' }}>Score</th>
                  <th style={{ padding: '10px 8px' }}>Submitted</th>
                  <th style={{ padding: '10px 8px' }}>Receipt #</th>
                  <th style={{ padding: '10px 8px', textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {analytics.submissions.map((sub) => {
                  const sl = statusLabel(sub.status);
                  return (
                    <tr key={sub.attempt_id} style={{ borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                      <td style={{ padding: '12px 8px' }}>
                        <div style={{ fontWeight: 600 }}>{sub.user_name}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{sub.user_email}</div>
                      </td>
                      <td style={{ padding: '12px 8px' }}>
                        <Pill tone={sl.tone} symbol={sl.symbol}>
                          {sl.label}
                        </Pill>
                      </td>
                      <td style={{ padding: '12px 8px' }}>
                        {sub.score !== null ? (
                          <strong>{sub.score} / {sub.max_score}</strong>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '12px 8px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                        {formatDateTime(sub.submitted_at || sub.started_at)}
                      </td>
                      <td style={{ padding: '12px 8px', fontSize: '0.85rem' }}>
                        {sub.receipt ? <code>{sub.receipt}</code> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right' }}>
                        {sub.status === 'locked' || sub.status === 'under_review' ? (
                          <Link className="btn small secondary" to={`/incidents/attempt/${sub.attempt_id}`}>
                            Review Incident
                          </Link>
                        ) : (
                          <Link className="btn small secondary" to={`/results/attempt/${sub.attempt_id}`}>
                            View Result
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Score Distribution Chart */}
      <Card style={{ padding: '24px', marginBottom: '24px' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '1.15rem' }}>Score Distribution</h3>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '20px', height: '180px', padding: '10px 0', borderBottom: '2px solid var(--border, #cbd5e1)' }}>
          {analytics.score_buckets.map((bucket, idx) => {
            const heightPct = Math.round((bucket.count / maxBucketCount) * 100);
            return (
              <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>{bucket.count}</span>
                <div
                  style={{
                    width: '100%',
                    maxWidth: '60px',
                    height: `${Math.max(heightPct, 6)}%`,
                    backgroundColor: bucket.count > 0 ? 'var(--primary, #3b82f6)' : '#e2e8f0',
                    borderRadius: '6px 6px 0 0',
                    transition: 'height 0.3s ease',
                  }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px' }}>{bucket.range}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Question Item Analysis Table */}
      <Card style={{ padding: '24px' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '1.15rem' }}>Question Item Analysis & Psychometrics</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border, #cbd5e1)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '10px 8px', width: '50px' }}>#</th>
                <th style={{ padding: '10px 8px' }}>Question Text</th>
                <th style={{ padding: '10px 8px', width: '90px' }}>Type</th>
                <th style={{ padding: '10px 8px', width: '70px' }}>Points</th>
                <th style={{ padding: '10px 8px', width: '90px' }}>Responses</th>
                <th style={{ padding: '10px 8px', width: '120px' }}>Accuracy Rate</th>
                <th style={{ padding: '10px 8px', width: '140px' }}>Discrimination (D)</th>
              </tr>
            </thead>
            <tbody>
              {analytics.question_analytics.map((qa, idx) => {
                const accPct = Math.round(qa.accuracy_rate * 100);
                let accColor = '#16a34a'; // High
                if (accPct < 40) accColor = '#dc2626'; // Hard
                else if (accPct < 70) accColor = '#ca8a04'; // Moderate

                let dRating = 'Poor';
                let dBadgeVariant: 'primary' | 'secondary' | 'danger' = 'secondary';
                if (qa.discrimination_index >= 0.4) {
                  dRating = 'Excellent';
                  dBadgeVariant = 'primary';
                } else if (qa.discrimination_index >= 0.2) {
                  dRating = 'Good';
                }

                return (
                  <tr key={qa.question_id} style={{ borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                    <td style={{ padding: '12px 8px', fontWeight: 600 }}>{idx + 1}</td>
                    <td style={{ padding: '12px 8px' }}>
                      <RichText content={qa.text} />
                    </td>
                    <td style={{ padding: '12px 8px' }}>
                      <Badge variant="secondary">{qa.qtype.toUpperCase()}</Badge>
                    </td>
                    <td style={{ padding: '12px 8px' }}>{qa.points}</td>
                    <td style={{ padding: '12px 8px' }}>
                      {qa.correct_answers} / {qa.total_answers}
                    </td>
                    <td style={{ padding: '12px 8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div
                          style={{
                            width: '40px',
                            height: '6px',
                            background: '#e2e8f0',
                            borderRadius: '3px',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${accPct}%`,
                              height: '100%',
                              backgroundColor: accColor,
                            }}
                          />
                        </div>
                        <span style={{ fontWeight: 600, color: accColor }}>{accPct}%</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600 }}>{qa.discrimination_index}</span>
                        <Badge variant={dBadgeVariant}>{dRating}</Badge>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};
