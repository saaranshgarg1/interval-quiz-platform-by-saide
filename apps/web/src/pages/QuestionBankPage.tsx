import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import type { QuestionBank, BankQuestion, QuestionType } from '../types';
import { Button, Card, Badge } from '../components/ui';
import { RichText } from '../components/RichText';

export const QuestionBankPage: React.FC = () => {
  const { courseId } = useParams<{ courseId: string }>();
  const cId = Number(courseId);

  const [banks, setBanks] = useState<QuestionBank[]>([]);
  const [selectedBank, setSelectedBank] = useState<QuestionBank | null>(null);
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New Bank state
  const [showNewBank, setShowNewBank] = useState(false);
  const [bankName, setBankName] = useState('');
  const [bankDesc, setBankDesc] = useState('');

  // New Question state
  const [showNewQuestion, setShowNewQuestion] = useState(false);
  const [qType, setQType] = useState<QuestionType>('single');
  const [qText, setQText] = useState('');
  const [options, setOptions] = useState<string[]>(['', '', '', '']);
  const [answer, setAnswer] = useState<any>(0);
  const [points, setPoints] = useState<number>(1);
  const [tolerance, setTolerance] = useState<number>(0);
  const [tags, setTags] = useState<string>('');

  // Batch import state
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');

  const loadBanks = async () => {
    try {
      setLoading(true);
      const res = await api.get<{ banks: QuestionBank[] }>(`/banks/course/${cId}`);
      setBanks(res.banks);
      if (res.banks.length > 0 && !selectedBank) {
        selectBank(res.banks[0]!);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load question banks.');
    } finally {
      setLoading(false);
    }
  };

  const selectBank = async (bank: QuestionBank) => {
    setSelectedBank(bank);
    try {
      const res = await api.get<{ bank: QuestionBank; questions: BankQuestion[] }>(
        `/banks/${bank.id}`,
      );
      setQuestions(res.questions);
    } catch (err: any) {
      setError(err.message || 'Failed to load bank questions.');
    }
  };

  useEffect(() => {
    if (cId) loadBanks();
  }, [cId]);

  const handleCreateBank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bankName.trim()) return;
    try {
      const res = await api.post<{ bank: QuestionBank }>(`/banks/course/${cId}`, {
        name: bankName.trim(),
        description: bankDesc.trim(),
      });
      setBankName('');
      setBankDesc('');
      setShowNewBank(false);
      await loadBanks();
      selectBank(res.bank);
    } catch (err: any) {
      setError(err.message || 'Failed to create question bank.');
    }
  };

  const handleDeleteBank = async (bankId: number) => {
    if (!confirm('Are you sure you want to delete this question bank?')) return;
    try {
      await api.del(`/banks/${bankId}`);
      if (selectedBank?.id === bankId) setSelectedBank(null);
      await loadBanks();
    } catch (err: any) {
      setError(err.message || 'Failed to delete question bank.');
    }
  };

  const handleAddQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBank || !qText.trim()) return;

    let finalAnswer = answer;
    if (qType === 'single') finalAnswer = Number(answer);
    if (qType === 'numeric') finalAnswer = Number(answer);
    if (qType === 'multiple') {
      finalAnswer = Array.isArray(answer) ? answer : [Number(answer)];
    }

    try {
      await api.post(`/banks/${selectedBank.id}/questions`, {
        qtype: qType,
        text: qText.trim(),
        options: qType === 'single' || qType === 'multiple' ? options : [],
        answer: finalAnswer,
        tolerance: qType === 'numeric' ? tolerance : null,
        points,
        tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      });
      setShowNewQuestion(false);
      setQText('');
      setOptions(['', '', '', '']);
      setAnswer(0);
      setTags('');
      selectBank(selectedBank);
    } catch (err: any) {
      setError(err.message || 'Failed to add question.');
    }
  };

  const handleDeleteQuestion = async (qId: number) => {
    if (!selectedBank) return;
    try {
      await api.del(`/banks/${selectedBank.id}/questions/${qId}`);
      selectBank(selectedBank);
    } catch (err: any) {
      setError(err.message || 'Failed to delete question.');
    }
  };

  const handleImportJson = async () => {
    if (!selectedBank || !importJson.trim()) return;
    try {
      const parsed = JSON.parse(importJson);
      const list = Array.isArray(parsed) ? parsed : parsed.questions;
      await api.post(`/banks/${selectedBank.id}/import`, { questions: list });
      setImportJson('');
      setShowImport(false);
      selectBank(selectedBank);
    } catch (err: any) {
      setError('Invalid JSON format. Expected an array of question objects.');
    }
  };

  const handleExportJson = () => {
    if (!selectedBank) return;
    const blob = new Blob([JSON.stringify(questions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedBank.name.replace(/\s+/g, '_')}_questions.json`;
    a.click();
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
            <Link to={`/courses/${cId}`} style={{ color: 'var(--text-muted, #64748b)', fontSize: '0.9rem' }}>
              ← Back to Course
            </Link>
          </div>
          <h1 style={{ margin: 0, fontSize: '1.75rem' }}>Question Banks</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted, #64748b)' }}>
            Organize reusable question repositories with LaTeX math support and batch JSON import/export.
          </p>
        </div>
        <Button onClick={() => setShowNewBank(true)}>+ New Question Bank</Button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '12px 16px', borderRadius: '8px', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      {/* New Bank Modal */}
      {showNewBank && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <Card style={{ width: '450px', padding: '24px', background: 'var(--bg, #fff)' }}>
            <h3 style={{ margin: '0 0 16px' }}>Create Question Bank</h3>
            <form onSubmit={handleCreateBank}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>
                  Bank Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Midterm AI Questions"
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border, #cbd5e1)' }}
                />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>
                  Description
                </label>
                <textarea
                  rows={3}
                  placeholder="Optional description or topic coverage..."
                  value={bankDesc}
                  onChange={(e) => setBankDesc(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border, #cbd5e1)' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <Button type="button" variant="secondary" onClick={() => setShowNewBank(false)}>
                  Cancel
                </Button>
                <Button type="submit">Create Bank</Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Main Grid: Left Banks List, Right Questions List */}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '24px' }}>
        {/* Left Column: Banks */}
        <div>
          <h3 style={{ fontSize: '1rem', marginBottom: '12px' }}>All Banks ({banks.length})</h3>
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
          ) : banks.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No question banks created yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {banks.map((b) => {
                const isSelected = selectedBank?.id === b.id;
                return (
                  <div
                    key={b.id}
                    onClick={() => selectBank(b)}
                    style={{
                      padding: '12px 16px',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      border: isSelected ? '2px solid var(--primary, #2563eb)' : '1px solid var(--border, #e2e8f0)',
                      background: isSelected ? 'var(--bg-active, #eff6ff)' : 'var(--bg, #ffffff)',
                    }}
                  >
                    <div style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
                      <span>{b.name}</span>
                      <Badge variant="secondary">{b.question_count ?? 0} Qs</Badge>
                    </div>
                    {b.description && (
                      <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {b.description}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Column: Selected Bank Questions */}
        <div>
          {selectedBank ? (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingBottom: '16px',
                  borderBottom: '1px solid var(--border, #e2e8f0)',
                  marginBottom: '20px',
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.35rem' }}>{selectedBank.name}</h2>
                  <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    {questions.length} questions in this bank
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Button size="sm" variant="secondary" onClick={() => setShowImport(true)}>
                    📥 Import JSON
                  </Button>
                  <Button size="sm" variant="secondary" onClick={handleExportJson} disabled={questions.length === 0}>
                    📤 Export JSON
                  </Button>
                  <Button size="sm" onClick={() => setShowNewQuestion(true)}>
                    + Add Question
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => handleDeleteBank(selectedBank.id)}>
                    Delete Bank
                  </Button>
                </div>
              </div>

              {/* Import Modal */}
              {showImport && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
                  <Card style={{ width: '600px', padding: '24px', background: 'var(--bg, #fff)' }}>
                    <h3 style={{ margin: '0 0 8px' }}>Batch Import Questions</h3>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                      Paste a JSON array of question objects (keys: qtype, text, options, answer, points, tags).
                    </p>
                    <textarea
                      rows={10}
                      value={importJson}
                      onChange={(e) => setImportJson(e.target.value)}
                      placeholder={`[\n  {\n    "qtype": "single",\n    "text": "What is $$E=mc^2$$?",\n    "options": ["Energy formula", "Force", "Power", "Work"],\n    "answer": 0,\n    "points": 2\n  }\n]`}
                      style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem', padding: '10px', borderRadius: '6px', border: '1px solid var(--border)' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                      <Button variant="secondary" onClick={() => setShowImport(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleImportJson}>Import Questions</Button>
                    </div>
                  </Card>
                </div>
              )}

              {/* Add Question Modal */}
              {showNewQuestion && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
                  <Card style={{ width: '650px', maxHeight: '90vh', overflowY: 'auto', padding: '24px', background: 'var(--bg, #fff)' }}>
                    <h3 style={{ margin: '0 0 16px' }}>Add Question to Bank</h3>
                    <form onSubmit={handleAddQuestion}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Question Type</label>
                          <select
                            value={qType}
                            onChange={(e) => setQType(e.target.value as QuestionType)}
                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                          >
                            <option value="single">Single Choice (Radio)</option>
                            <option value="multiple">Multiple Choice (Checkboxes)</option>
                            <option value="numeric">Numeric (Math / Range)</option>
                            <option value="short">Short Answer</option>
                          </select>
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Points</label>
                          <input
                            type="number"
                            min="0.5"
                            step="0.5"
                            value={points}
                            onChange={(e) => setPoints(Number(e.target.value))}
                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                          />
                        </div>
                      </div>

                      <div style={{ marginBottom: '12px' }}>
                        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>
                          Question Text (Supports Markdown & LaTeX: e.g. $$x^2 + y^2$$)
                        </label>
                        <textarea
                          rows={3}
                          required
                          value={qText}
                          onChange={(e) => setQText(e.target.value)}
                          placeholder="e.g. Calculate the integral $\int_0^1 x dx$"
                          style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                        />
                        {qText && (
                          <div style={{ marginTop: '8px', padding: '8px', background: '#f8fafc', borderRadius: '6px', border: '1px dashed #cbd5e1' }}>
                            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Live Preview:</span>
                            <RichText content={qText} />
                          </div>
                        )}
                      </div>

                      {(qType === 'single' || qType === 'multiple') && (
                        <div style={{ marginBottom: '12px' }}>
                          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Options</label>
                          {options.map((opt, idx) => (
                            <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                              <span style={{ width: '20px', fontWeight: 600 }}>{String.fromCharCode(65 + idx)}.</span>
                              <input
                                type="text"
                                value={opt}
                                onChange={(e) => {
                                  const next = [...options];
                                  next[idx] = e.target.value;
                                  setOptions(next);
                                }}
                                placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                                style={{ flex: 1, padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)' }}
                              />
                              {qType === 'single' ? (
                                <input
                                  type="radio"
                                  name="bank_answer"
                                  checked={Number(answer) === idx}
                                  onChange={() => setAnswer(idx)}
                                />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={Array.isArray(answer) && answer.includes(idx)}
                                  onChange={(e) => {
                                    const curr = Array.isArray(answer) ? [...answer] : [];
                                    if (e.target.checked) setAnswer([...curr, idx]);
                                    else setAnswer(curr.filter((x) => x !== idx));
                                  }}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {qType === 'numeric' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Correct Number</label>
                            <input
                              type="number"
                              step="any"
                              value={answer}
                              onChange={(e) => setAnswer(Number(e.target.value))}
                              style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                            />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Tolerance (±)</label>
                            <input
                              type="number"
                              step="any"
                              value={tolerance}
                              onChange={(e) => setTolerance(Number(e.target.value))}
                              style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                            />
                          </div>
                        </div>
                      )}

                      {qType === 'short' && (
                        <div style={{ marginBottom: '12px' }}>
                          <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Correct Answer (String)</label>
                          <input
                            type="text"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                          />
                        </div>
                      )}

                      <div style={{ marginBottom: '16px' }}>
                        <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '4px' }}>Tags (comma-separated)</label>
                        <input
                          type="text"
                          value={tags}
                          onChange={(e) => setTags(e.target.value)}
                          placeholder="e.g. calculus, integrals, easy"
                          style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)' }}
                        />
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <Button type="button" variant="secondary" onClick={() => setShowNewQuestion(false)}>
                          Cancel
                        </Button>
                        <Button type="submit">Add to Bank</Button>
                      </div>
                    </form>
                  </Card>
                </div>
              )}

              {/* Questions List */}
              {questions.length === 0 ? (
                <Card style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <p style={{ margin: '0 0 12px' }}>This bank doesn't have any questions yet.</p>
                  <Button size="sm" onClick={() => setShowNewQuestion(true)}>
                    + Add Your First Question
                  </Button>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {questions.map((q, idx) => (
                    <Card key={q.id} style={{ padding: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>#{idx + 1}</span>
                          <Badge variant="secondary">{q.qtype.toUpperCase()}</Badge>
                          <Badge variant="primary">{q.points} pt{q.points !== 1 ? 's' : ''}</Badge>
                          {q.tags.map((t, tIdx) => (
                            <span key={tIdx} style={{ fontSize: '0.75rem', background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px' }}>
                              #{t}
                            </span>
                          ))}
                        </div>
                        <Button variant="danger" size="sm" onClick={() => handleDeleteQuestion(q.id)}>
                          Delete
                        </Button>
                      </div>

                      <div style={{ margin: '8px 0', fontSize: '1rem' }}>
                        <RichText content={q.text} />
                      </div>

                      {q.options && q.options.length > 0 && (
                        <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                          {q.options.map((opt, oIdx) => {
                            const isCorrect =
                              q.qtype === 'single'
                                ? Number(q.answer) === oIdx
                                : Array.isArray(q.answer) && q.answer.includes(oIdx);
                            return (
                              <div
                                key={oIdx}
                                style={{
                                  padding: '6px 10px',
                                  borderRadius: '6px',
                                  fontSize: '0.85rem',
                                  background: isCorrect ? '#dcfce7' : 'var(--bg-muted, #f8fafc)',
                                  border: isCorrect ? '1px solid #86efac' : '1px solid var(--border, #e2e8f0)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                }}
                              >
                                <strong>{String.fromCharCode(65 + oIdx)}.</strong>
                                <RichText content={opt} />
                                {isCorrect && <span style={{ marginLeft: 'auto', color: '#16a34a', fontWeight: 600 }}>✓</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Card style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              Select a question bank on the left or create a new one.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
