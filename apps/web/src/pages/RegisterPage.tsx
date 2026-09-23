import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'student' | 'instructor'>('student');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(name, email, password, role);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h1 className="auth-title">Create an account</h1>
        <p className="auth-sub">Used for course membership; your institution controls access.</p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="name">Full name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password (6+ characters)</label>
            <input id="password" type="password" autoComplete="new-password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="field">
            <label id="role-label">I am a…</label>
            <div role="radiogroup" aria-labelledby="role-label" style={{ display: 'flex', gap: '0.75rem' }}>
              {(['student', 'instructor'] as const).map((r) => (
                <label key={r} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input
                    type="radio"
                    name="role"
                    checked={role === r}
                    onChange={() => setRole(r)}
                    style={{ width: 'auto' }}
                  />
                  {r[0].toUpperCase() + r.slice(1)}
                </label>
              ))}
            </div>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Creating account…' : 'Register'}
          </button>
        </form>
        <div className="divider" />
        <p className="small muted" style={{ margin: 0 }}>
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}