import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog';
import { Moon, Sun, LogOut, Search } from 'lucide-react';
import { useTheme } from './lib/theme';
import { Button } from './components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { CommandPalette } from './components/CommandPalette';
import { AccessibilityMenu, AccessibilityProvider } from './components/AccessibilityMenu';
import { Logo } from './components/Logo';
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
import { MonitorPage } from './pages/MonitorPage';
import { AdminPage } from './pages/AdminPage';

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Toggle theme</TooltipContent>
    </Tooltip>
  );
}

/** Other parts of the app (e.g. the command palette) ask for sign-out through this event. */
export const SIGN_OUT_EVENT = 'interval:request-sign-out';

function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const inAttempt = location.pathname.startsWith('/attempts/');

  useEffect(() => {
    const ask = () => setConfirmSignOut(true);
    window.addEventListener(SIGN_OUT_EVENT, ask);
    return () => window.removeEventListener(SIGN_OUT_EVENT, ask);
  }, []);

  return (
    <AccessibilityProvider>
    <div className="min-h-[100dvh]">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <Logo />
          </span>
          <nav className="topnav" aria-label="Primary">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/results">My results</NavLink>
            {user?.role !== 'student' && <NavLink to="/incidents">Incidents</NavLink>}
            {user?.role === 'admin' && <NavLink to="/admin">Users</NavLink>}
          </nav>
          <div className="topbar-user">
            <button
              type="button"
              className="cmdk-hint"
              onClick={() =>
                document.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'k', metaKey: true }),
                )
              }
              aria-label="Open command palette"
            >
              <Search aria-hidden="true" />
              <span>Search</span>
              <kbd>⌘K</kbd>
            </button>
            <AccessibilityMenu inAttempt={inAttempt} />
            <ThemeToggle />
            <span className="topbar-name">{user?.name}</span>
            <span className="role-badge">{user?.role}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="sm" onClick={() => setConfirmSignOut(true)}>
                  <LogOut />
                  Sign out
                </Button>
              </TooltipTrigger>
              <TooltipContent>End your session</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{inAttempt ? 'Sign out in the middle of a quiz?' : 'Sign out?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {inAttempt
                ? 'This window stops working on your attempt. Your saved answers are kept, but the timer keeps running, and if exit & resume is not allowed for this quiz, coming back will lock or submit your attempt.'
                : 'You will need to sign in again to continue. Anything not yet saved on this device is cleared.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{inAttempt ? 'Stay in the quiz' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:brightness-105"
              onClick={() => {
                logout();
                navigate('/login');
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </AccessibilityProvider>
  );
}

function Shell() {
  const { user, ready } = useAuth();
  // Wait for the session bootstrap before deciding — otherwise a hard refresh or
  // deep link bounces a logged-in user to /login before their token is restored.
  if (!ready) {
    return (
      <div className="min-h-[100dvh] grid place-items-center" role="status" aria-live="polite">
        <span className="muted">Restoring your session…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return (
    <Layout>
      <CommandPalette />
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/courses/:courseId" element={<CoursePage />} />
        <Route path="/courses/:courseId/banks" element={<QuestionBankPage />} />
        <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
        <Route path="/quizzes/:quizId/preflight" element={<QuizPreflightPage />} />
        <Route path="/quizzes/:quizId/monitor" element={<MonitorPage />} />
        <Route path="/admin" element={<AdminPage />} />
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

export function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Shell />} />
      </Routes>
      <Toaster />
    </>
  );
}
