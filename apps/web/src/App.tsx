import { useEffect } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import type { ReactNode } from 'react';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { CoursePage } from './pages/CoursePage';
import { QuizEditorPage } from './pages/QuizEditorPage';
import { QuizPreflightPage } from './pages/QuizPreflightPage';
import { AttemptPage } from './pages/AttemptPage';
import { ResultsPage } from './pages/ResultsPage';
import { ResultDetailPage } from './pages/ResultDetailPage';
import { IncidentsPage } from './pages/IncidentsPage';
import { QuestionBankPage } from './pages/QuestionBankPage';
import { AnalyticsPage } from './pages/AnalyticsPage';

function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand" aria-label="Interval quiz portal">
            Interval<span aria-hidden="true">◇</span>
          </span>
          <nav className="topnav" aria-label="Primary">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/results">My results</NavLink>
            {user?.role !== 'student' && <NavLink to="/incidents">Incidents</NavLink>}
          </nav>
          <div className="topbar-user">
            <span>{user?.name}</span>
            <span className="role-badge">{user?.role}</span>
            <button
              className="btn small secondary"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

function Shell() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/courses/:courseId" element={<CoursePage />} />
        <Route path="/courses/:courseId/banks" element={<QuestionBankPage />} />
        <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
        <Route path="/quizzes/:quizId/preflight" element={<QuizPreflightPage />} />
        <Route path="/attempts/:attemptId" element={<AttemptPage />} />
        <Route path="/analytics/version/:versionId" element={<AnalyticsPage />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/results/attempt/:attemptId" element={<ResultDetailPage />} />
        <Route path="/incidents" element={<IncidentsPage />} />
        <Route path="/incidents/attempt/:attemptId" element={<IncidentsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

function AuthSync() {
  const { user, refresh } = useAuth();
  useEffect(() => {
    if (!user) {
      void refresh();
    }
  }, [user, refresh]);
  return null;
}

export function App() {
  return (
    <>
      <AuthSync />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </>
  );
}