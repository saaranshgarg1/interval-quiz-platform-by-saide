import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  QuizDetailResponse,
  QuestionType,
  IntegrityPolicy,
  ShowScores,
  QuestionEditor,
  QuestionBank,
  BankQuestion,
} from '../types';
import { Pill } from '../components/ui';
import { RichText } from '../components/RichText';

const EMPTY_QUESTION = () => ({
  qtype: 'single' as QuestionType,
  text: '',
  options: ['', ''],
  answer: 0 as number | number[] | string,
  tolerance: '',
  points: 1,
  id: null as number | null,
});

export function QuizEditorPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<QuizDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);

  // meta form
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [duration, setDuration] = useState('');
  const [shuffleQ, setShuffleQ] = useState<boolean>(false);
  const [shuffleO, setShuffleO] = useState<boolean>(false);
  const [attempts, setAttempts] = useState('1');
  const [policy, setPolicy] = useState<IntegrityPolicy>('off');
  const [trigger, setTrigger] = useState('focus_exit');
  const [showScores, setShowScores] = useState<ShowScores>('release');

  const [newQ, setNewQ] = useState(EMPTY_QUESTION());
  const [edits, setEdits] = useState<Record<number, ReturnType<typeof EMPTY_QUESTION>>>({});

  // Question bank modal state
  const [showBankModal, setShowBankModal] = useState(false);
  const [banks, setBanks] = useState<QuestionBank[]>([]);
  const [selectedBankId, setSelectedBankId] = useState<number | ''>('');
  const [bankQuestions, setBankQuestions] = useState<BankQuestion[]>([]);
  const [importingBank, setImportingBank] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<QuizDetailResponse>(`/quizzes/${quizId}`);
      setDetail(res);
      const draft = res.versions.find((v) => v.status === 'draft') ?? res.versions[0];
      if (draft) {
        setTitle(draft.title);
        setInstructions(draft.instructions);
        setDuration(draft.duration_minutes == null ? '' : String(draft.duration_minutes));
        setShuffleQ(!!draft.shuffle_questions);
        setShuffleO(!!draft.shuffle_options);
        setAttempts(String(draft.attempts_allowed));
        setPolicy(draft.integrity_policy);
        setTrigger(draft.policy_trigger);
        setShowScores(draft.show_scores);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load quiz.');
    }
  }, [quizId]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = detail?.versions.find((v) => v.status === 'draft');
  const published = detail?.versions.find((v) => v.status === 'published');
  const editable = !!draft;

  if (error) return <div className="banner error">{error}</div>;
  if (!detail) return <p className="muted">Loading quiz…</p>;

  const saveMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingMeta(true);
    setError(null);
    setMsg(null);
    try {
      await api.put(`/quizzes/${quizId}`, {
        title,
        instructions,
        duration_minutes: duration === '' ? null : Number(duration),
        shuffle_questions: shuffleQ ? 1 : 0,
        shuffle_options: shuffleO ? 1 : 0,
        attempts_allowed: Number(attempts),
        integrity_policy: policy,
        policy_trigger: trigger,
        show_scores: showScores,
      });
      setMsg('Quiz settings saved.');
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSavingMeta(false);
    }
  };

  const publish = async () => {
    try {
      await api.patch(`/quizzes/${quizId}/publish`, {});
      navigate(`/quizzes/${quizId}/preflight`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publish failed.');
    }
  };

  const cloneDraft = async () => {
    try {
      await api.post(`/quizzes/${quizId}/clone`, {});
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clone new draft.');
    }
  };

  const saveNewQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    try {
      await api.post(`/quizzes/${quizId}/draft/questions`, buildQuestionPayload(newQ));
      setNewQ(EMPTY_QUESTION());
      setMsg('Question added.');
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add question.');
    }
  };

  const saveEdit = async (q: QuestionEditor) => {
    const payload = edits[q.id];
    if (!payload) return;
    try {
      await api.put(`/quizzes/${quizId}/draft/questions/${q.id}`, buildQuestionPayload(payload));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      setMsg('Question updated.');
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update question.');
    }
  };

  const deleteQuestion = async (q: QuestionEditor) => {
    try {
      await api.del(`/quizzes/${quizId}/draft/questions/${q.id}`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete question.');
    }
  };

  const openBankModal = async () => {
    try {
      setShowBankModal(true);
      const res = await api.get<{ banks: QuestionBank[] }>(`/banks/course/${detail.course_id}`);
      setBanks(res.banks);
    } catch (err) {
      setError('Failed to load course question banks.');
    }
  };

  const handleSelectBank = async (bId: number) => {
    setSelectedBankId(bId);
    try {
      const res = await api.get<{ questions: BankQuestion[] }>(`/banks/${bId}`);
      setBankQuestions(res.questions);
    } catch (err) {
      setError('Failed to load bank questions.');
    }
  };

  const importBankQuestion = async (bq: BankQuestion) => {
    if (!draft) return;
    try {
      setImportingBank(true);
      await api.post(`/quizzes/${quizId}/draft/questions`, {
        qtype: bq.qtype,
        text: bq.text,
        options: bq.options,
        answer: bq.answer,
        tolerance: bq.tolerance,
        points: bq.points,
      });
      setMsg(`Imported "${bq.text.slice(0, 30)}..." into draft.`);
      void load();
    } catch (err) {
      setError('Failed to import question from bank.');
    } finally {
      setImportingBank(false);
    }
  };

  return (
    <div>
      <div className="card-row">
        <div className="grow">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{title || 'Untitled quiz'}</h1>
            {draft && <Pill tone="warn" symbol="✎">Draft v{draft.version}</Pill>}
            {published && <Pill tone="ok" symbol="✓">Live v{published.version}</Pill>}
          </div>
          <span className="muted small">
            Course ID #{detail.course_id} · {draft ? `Editing draft v${draft.version}` : `Viewing published v${published?.version}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {editable && (
            <>
              <button className="btn secondary" onClick={() => void openBankModal()}>
                📚 Import from Bank
              </button>
              <button className="btn" onClick={() => void publish()} disabled={draft.questions.length === 0}>
                Publish live version
              </button>
            </>
          )}
          {!editable && published && (
            <button className="btn" onClick={() => void cloneDraft()}>
              Create new draft version
            </button>
          )}
        </div>
      </div>

      {msg && <div className="banner ok">{msg}</div>}

      {showBankModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg, #fff)', borderRadius: '12px', width: '700px', maxHeight: '85vh', overflowY: 'auto', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>Import Questions from Bank</h3>
              <button className="btn small secondary" onClick={() => setShowBankModal(false)}>Close</button>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>Select Bank</label>
              <select
                value={selectedBankId}
                onChange={(e) => handleSelectBank(Number(e.target.value))}
                style={{ width: '100%', padding: '8px' }}
              >
                <option value="">-- Choose a Question Bank --</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.question_count ?? 0} questions)
                  </option>
                ))}
              </select>
            </div>

            {bankQuestions.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <h4 style={{ margin: '8px 0 4px', fontSize: '0.9rem' }}>Available Questions ({bankQuestions.length})</h4>
                {bankQuestions.map((bq) => (
                  <div key={bq.id} style={{ padding: '12px', border: '1px solid var(--border, #e2e8f0)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flex: 1, marginRight: '12px' }}>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{bq.qtype.toUpperCase()} · {bq.points} pt</div>
                      <RichText content={bq.text} />
                    </div>
                    <button
                      className="btn small secondary"
                      disabled={importingBank}
                      onClick={() => void importBankQuestion(bq)}
                    >
                      + Import
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid-2" style={{ marginTop: '1.25rem' }}>
        <div className="card">
          <h3>Settings</h3>
          <form onSubmit={saveMeta}>
            <div className="field">
              <label htmlFor="meta-title">Title</label>
              <input id="meta-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} />
            </div>
            <div className="field">
              <label htmlFor="meta-inst">Instructions (Markdown & LaTeX math supported)</label>
              <textarea id="meta-inst" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={!editable} />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="meta-dur">Duration (minutes, blank = no limit)</label>
                <input id="meta-dur" type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} disabled={!editable} />
              </div>
              <div className="field">
                <label htmlFor="meta-att">Attempts allowed</label>
                <input id="meta-att" type="number" min={1} max={10} value={attempts} onChange={(e) => setAttempts(e.target.value)} disabled={!editable} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="meta-pol">Integrity policy</label>
                <select id="meta-pol" value={policy} onChange={(e) => setPolicy(e.target.value as IntegrityPolicy)} disabled={!editable}>
                  <option value="off">Off (practice)</option>
                  <option value="warn">Warn on tab exit</option>
                  <option value="strict">Strict lock on tab exit (HTTP 423)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="meta-scores">Show scores</label>
                <select id="meta-scores" value={showScores} onChange={(e) => setShowScores(e.target.value as ShowScores)} disabled={!editable}>
                  <option value="immediate">Immediately on submit</option>
                  <option value="release">When instructor releases</option>
                  <option value="never">Never (private)</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>Randomization</label>
              <div className="field-row" style={{ marginTop: '0.2rem' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="option">
                    <input type="checkbox" checked={shuffleQ} onChange={(e) => setShuffleQ(e.target.checked)} disabled={!editable} style={{ width: 'auto' }} />
                    Shuffle questions
                  </label>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="option">
                    <input type="checkbox" checked={shuffleO} onChange={(e) => setShuffleO(e.target.checked)} disabled={!editable} style={{ width: 'auto' }} />
                    Shuffle options
                  </label>
                </div>
              </div>
            </div>
            <button className="btn secondary" type="submit" disabled={!editable || savingMeta}>
              {savingMeta ? 'Saving…' : 'Save settings'}
            </button>
          </form>
        </div>

        <div className="card">
          <h3>Questions ({draft ? draft.questions.length : detail.versions[0]?.questions.length ?? 0})</h3>
          {draft && draft.questions.length === 0 && <p className="muted small">Add your first question below. You need at least one before publishing.</p>}
          {editable && (
            <form onSubmit={saveNewQuestion} style={{ borderTop: '1px solid var(--line)', paddingTop: '0.8rem' }}>
              <QuestionFields q={newQ} setQ={setNewQ} />
              <button className="btn small" type="submit">Add question</button>
            </form>
          )}
        </div>
      </div>

      {draft && draft.questions.length > 0 && (
        <section style={{ marginTop: '1rem' }}>
          <h3>Question list</h3>
          <div className="grid-2" style={{ gridTemplateColumns: usersGrid }}>
            {draft.questions.map((q) => {
              const edit = edits[q.id];
              return (
                <div className="card" key={q.id}>
                  <div className="card-row">
                    <div className="grow">
                      <strong>Q{q.order_index + 1}</strong> · <Pill tone="neutral" symbol="·">{q.qtype}</Pill> · {q.points} pt
                    </div>
                    <button className="btn small ghost-danger" onClick={() => void deleteQuestion(q)}>Delete</button>
                    {edits[q.id] && (
                      <button className="btn small" onClick={() => void saveEdit(q)} disabled={editable === false}>Save</button>
                    )}
                  </div>
                  {edits[q.id] ? (
                    <QuestionFields q={edit} setQ={(next) => setEdits({ ...edits, [q.id]: next })} />
                  ) : (
                    <div style={{ marginTop: '0.5rem' }}>
                      <div style={{ margin: '0 0 0.4rem', fontWeight: 600 }}>
                        <RichText content={q.text} />
                      </div>
                      {q.qtype === 'single' || q.qtype === 'multiple' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {q.options.map((o, i) => (
                            <div key={i} style={{ fontSize: '0.85rem', display: 'flex', gap: '6px' }}>
                              <span>·</span>
                              <RichText content={o} />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted small">
                          Key: <code>{String(q.answer)}</code>{q.tolerance != null ? ` ± ${q.tolerance}` : ''}
                        </p>
                      )}
                    </div>
                  )}
                  <button
                    className="btn small ghost"
                    style={{ marginTop: '0.5rem' }}
                    onClick={() => setEdits((prev) => ({ ...prev, [q.id]: toEditForm(q) }))}
                  >
                    Edit
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function toEditForm(q: QuestionEditor): ReturnType<typeof EMPTY_QUESTION> {
  return {
    qtype: q.qtype,
    text: q.text,
    options: q.options.length ? q.options : ['', ''],
    answer: q.answer as number | number[] | string,
    tolerance: q.tolerance == null ? '' : String(q.tolerance),
    points: q.points,
    id: q.id,
  };
}

function buildQuestionPayload(q: ReturnType<typeof EMPTY_QUESTION>) {
  const body: Record<string, unknown> = {
    qtype: q.qtype,
    text: q.text,
    points: Number(q.points) || 1,
  };
  if (q.qtype === 'single' || q.qtype === 'multiple') {
    body.options = q.options.filter((o) => o.trim() !== '');
  }
  if (q.qtype === 'single') body.answer = Number(q.answer);
  if (q.qtype === 'multiple') {
    body.answer = Array.isArray(q.answer) ? q.answer.map(Number) : [];
  }
  if (q.qtype === 'numeric') {
    body.answer = Number(q.answer);
    body.tolerance = q.tolerance === '' ? 0 : Number(q.tolerance);
  }
  if (q.qtype === 'short') {
    body.answer = String(q.answer ?? '');
  }
  return body;
}

function QuestionFields({
  q,
  setQ,
}: {
  q: ReturnType<typeof EMPTY_QUESTION>;
  setQ: (next: ReturnType<typeof EMPTY_QUESTION>) => void;
}) {
  const set = (patch: Partial<ReturnType<typeof EMPTY_QUESTION>>) => setQ({ ...q, ...patch });

  return (
    <div>
      <input type="hidden" />
      <div className="field">
        <label htmlFor="q-text">Question text (Supports LaTeX e.g. $$x^2$$ and Markdown)</label>
        <textarea id="q-text" rows={2} value={q.text} onChange={(e) => set({ text: e.target.value })} />
        {q.text && (
          <div style={{ marginTop: '6px', padding: '6px 10px', background: '#f8fafc', borderRadius: '4px', border: '1px dashed #cbd5e1' }}>
            <span style={{ fontSize: '0.7rem', color: '#64748b' }}>Live Preview:</span>
            <RichText content={q.text} />
          </div>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="q-type">Type</label>
          <select id="q-type" value={q.qtype} onChange={(e) => set({ qtype: e.target.value as QuestionType })}>
            <option value="single">Single choice</option>
            <option value="multiple">Multiple choice</option>
            <option value="short">Short answer</option>
            <option value="numeric">Numeric</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="q-points">Points</label>
          <input id="q-points" type="number" min={0.25} step={0.25} value={q.points} onChange={(e) => set({ points: Number(e.target.value) })} />
        </div>
      </div>

      {(q.qtype === 'single' || q.qtype === 'multiple') && (
        <div className="field">
          <label htmlFor="q-options">
            Options (one per line). Mark the correct one{q.qtype === 'multiple' ? 's (check ' + (Array.isArray(q.answer) ? (q.answer as unknown[]).length : 0) + ' selected)' : ''}.
          </label>
          <textarea
            id="q-options"
            rows={3}
            value={q.options.join('\n')}
            onChange={(e) => {
              const options = e.target.value.split('\n');
              let answer: number | number[] = q.qtype === 'single' ? Number(q.answer) : (Array.isArray(q.answer) ? q.answer.filter((i) => i < options.length) : []);
              if (q.qtype === 'single' && Number(answer) >= options.filter((o) => o.trim() !== '').length) {
                answer = 0;
              }
              set({ options, answer });
            }}
          />
          <div style={{ marginTop: '0.5rem' }} role="radiogroup" aria-label="correct options">
            {q.options.map((o, i) =>
              o.trim() === '' ? null : (
                <label key={i} className="option" style={{ marginTop: '0.35rem' }}>
                  <input
                    type={q.qtype === 'single' ? 'radio' : 'checkbox'}
                    name="correct"
                    checked={
                      q.qtype === 'single' ? Number(q.answer) === i : Array.isArray(q.answer) && (q.answer as unknown[]).includes(i)
                    }
                    onChange={() => set({ answer: q.qtype === 'single' ? i : toggleMulti(q.answer, i) })}
                    style={{ width: 'auto' }}
                  />
                  <span className="option-label small">
                    <RichText content={o} />
                  </span>
                </label>
              ),
            )}
          </div>
        </div>
      )}

      {q.qtype === 'numeric' && (
        <div className="field-row">
          <div className="field">
            <label htmlFor="q-num">Expected number</label>
            <input id="q-num" type="number" step="any" value={String(q.answer ?? '')} onChange={(e) => set({ answer: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="q-tol">Tolerance (±)</label>
            <input id="q-tol" type="number" step="any" min={0} value={q.tolerance} onChange={(e) => set({ tolerance: e.target.value })} />
          </div>
        </div>
      )}

      {q.qtype === 'short' && (
        <div className="field">
          <label htmlFor="q-short">Accepted answer (case-insensitive)</label>
          <input id="q-short" value={String(q.answer ?? '')} onChange={(e) => set({ answer: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function toggleMulti(current: unknown, index: number): number[] {
  const arr = Array.isArray(current) ? (current as unknown[]).map(Number) : [];
  return arr.includes(index) ? arr.filter((i) => i !== index) : [...arr, index];
}

export const usersGrid = 'repeat(auto-fit, minmax(420px, 1fr))';