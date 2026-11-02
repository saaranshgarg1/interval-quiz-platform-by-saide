import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion, useReducedMotion } from 'framer-motion';
import { Lock, Mail, ArrowRight, Loader2, Info, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../auth';
import { api, ApiError } from '../api';
import { Logo } from '../components/Logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({
  email: z.string().min(1, 'Enter your email').email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

type FormData = z.infer<typeof schema>;

interface GoogleConfig {
  enabled: boolean;
  client_id: string | null;
  allowed_domain: string;
  reason: string | null;
}

type GoogleState =
  | { status: 'loading' }
  | { status: 'ready'; clientId: string; domain: string }
  | { status: 'disabled'; reason: string };

interface GoogleIdentity {
  accounts?: {
    id?: {
      initialize: (config: Record<string, unknown>) => void;
      renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
    };
  };
}

let googleScript: Promise<void> | null = null;

/** Load Google Identity Services once; rejects on network block or a 10 s timeout. */
function loadGoogleScript(): Promise<void> {
  if ((window as unknown as { google?: GoogleIdentity }).google?.accounts?.id) return Promise.resolve();
  if (googleScript) return googleScript;
  googleScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.setAttribute('data-gis-script', 'true');
    const timer = window.setTimeout(() => reject(new Error('timeout')), 10_000);
    script.onload = () => {
      window.clearTimeout(timer);
      if ((window as unknown as { google?: GoogleIdentity }).google?.accounts?.id) resolve();
      else reject(new Error('gis missing'));
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('blocked'));
    };
    document.head.appendChild(script);
  }).catch((err) => {
    googleScript = null; // allow a retry on the next visit
    throw err;
  });
  return googleScript;
}

/** Inline Google "G" glyph — no emoji, no external brand icon dependency. */
function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.16 3.32v2.71h3.47c2.05-1.85 3.33-4.64 3.33-8.04Z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.45-.99 7.24-2.66l-3.47-2.71c-.95.63-2.18 1.01-3.77 1.01-2.9 0-5.37-1.96-6.28-4.6l-3.59 2.76C3.44 20.16 7.36 23 12 23Z"
        fill="#34A853"
      />
      <path
        d="M5.72 14.05a6.99 6.99 0 0 1 0-4.1L2.13 7.2A11.05 11.05 0 0 0 1 12c0 1.68.39 3.28 1.13 4.8l3.6-2.75Z"
        fill="#FBBC05"
      />
      <path
        d="M12 4.98c1.62 0 3.06.55 4.19 1.64l3.1-3.1A10.98 10.98 0 0 0 12 1C7.24 1 3.45 3.79 2.13 7.8l3.59 2.76C6.63 7.94 9.1 4.98 12 4.98Z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function LoginPage() {
  const { login, sso } = useAuth();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();

  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [google, setGoogle] = useState<GoogleState>({ status: 'loading' });
  const googleButton = useRef<HTMLDivElement | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const onValid = async (data: FormData) => {
    setFormError(null);
    setBusy(true);
    try {
      await login(data.email, data.password);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        if (err.status === 401) {
          setError('password', { message: 'Invalid email or password.' });
        }
      } else {
        setFormError('Sign in failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = handleSubmit(onValid);

  // framer-motion entrance, guarded by prefers-reduced-motion
  const panelEntrance =
    reducedMotion === false
      ? {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
        }
      : { initial: undefined, animate: undefined, transition: undefined };

  const brandEntrance =
    reducedMotion === false
      ? {
          initial: { opacity: 0, x: -12 },
          animate: { opacity: 1, x: 0 },
          transition: {
            duration: 0.5,
            ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
            delay: 0.05,
          },
        }
      : { initial: undefined, animate: undefined, transition: undefined };

  /**
   * Google sign-in is offered only when it can actually work here: the server
   * must have it configured for this web address, and Google's script must
   * load. Otherwise the button is shown disabled with the reason, so nobody
   * goes through Google just to be told it failed.
   */
  useEffect(() => {
    let cancelled = false;
    const disable = (reason: string) => !cancelled && setGoogle({ status: 'disabled', reason });

    (async () => {
      let config: GoogleConfig;
      try {
        const res = await api.get<{ google: GoogleConfig }>(
          `/auth/config?origin=${encodeURIComponent(window.location.origin)}`,
        );
        config = res.google;
      } catch {
        return disable('Google sign-in is unavailable right now. Use your email and password.');
      }
      if (!config.enabled || !config.client_id) {
        return disable(config.reason ?? 'Google sign-in is turned off. Use your email and password.');
      }
      try {
        await loadGoogleScript();
      } catch {
        return disable(
          'Google sign-in could not load (your network or browser is blocking accounts.google.com). Use your email and password.',
        );
      }
      if (cancelled) return;
      setGoogle({ status: 'ready', clientId: config.client_id, domain: config.allowed_domain });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Render Google's button once the config and script are ready.
  useEffect(() => {
    if (google.status !== 'ready' || !googleButton.current) return;
    const gis = (window as unknown as { google?: GoogleIdentity }).google?.accounts?.id;
    if (!gis) {
      setGoogle({ status: 'disabled', reason: 'Google sign-in could not start. Use your email and password.' });
      return;
    }
    gis.initialize({
      client_id: google.clientId,
      // Only offer accounts from the allowed domain in Google's account chooser.
      hd: google.domain,
      callback: async (response: { credential?: string }) => {
        if (!response?.credential) return;
        setFormError(null);
        try {
          await sso(response.credential);
          navigate('/');
        } catch (err) {
          if (err instanceof ApiError && (err.status === 503 || err.message === 'Invalid Google ID token.')) {
            // A server/config problem: retrying can't succeed, so turn the button off.
            setGoogle({
              status: 'disabled',
              reason: 'Google sign-in is not working on this server right now. Use your email and password.',
            });
          } else if (err instanceof ApiError) {
            // e.g. "Only iitrpr.ac.in accounts are allowed." — another account may work.
            setFormError(`Google sign-in: ${err.message} Choose your @${google.domain} account, or use your email and password.`);
          } else {
            setFormError('Could not reach the server to finish Google sign-in. Check your connection and try again.');
          }
        }
      },
    });
    gis.renderButton(googleButton.current, {
      theme: 'outline',
      size: 'large',
      type: 'standard',
      shape: 'rectangular',
      text: 'continue_with',
      logo_alignment: 'left',
      width: Math.min(400, Math.max(240, googleButton.current.offsetWidth || 340)),
    });
  }, [google, sso, navigate]);

  // Fine ruled-paper texture for the masthead — token-derived, very low contrast.
  const ruledPaper = {
    backgroundImage:
      'repeating-linear-gradient(to bottom, transparent 0 33px, color-mix(in oklab, var(--line) 60%, transparent) 33px 34px)',
  };

  return (
    <div className="grid min-h-[100dvh] bg-background md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* ── Left: editorial masthead ───────────────────────────────── */}
      <motion.aside
        {...brandEntrance}
        style={ruledPaper}
        className="relative hidden flex-col justify-between border-r border-[var(--line)] bg-[var(--muted)] px-11 py-12 md:flex"
      >
        <Logo tile />

        <div className="max-w-sm space-y-5">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.18em] text-primary">
            Assessment portal
          </p>
          <h1 className="font-display text-[2.6rem] font-semibold leading-[1.06] tracking-tight text-foreground">
            Structured practice,
            <br />
            precise feedback.
          </h1>
          <p className="text-[0.92rem] leading-relaxed text-muted-foreground">
            Timed attempts, integrity modes and instructor review — built for the academic
            workflow at IIT Ropar.
          </p>
        </div>

        <div className="flex items-end justify-between">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">
            Est. IIT Ropar
          </p>
          <div className="flex items-end gap-1" aria-hidden="true">
            {[8, 14, 20, 12, 6].map((h, i) => (
              <span
                key={i}
                className="w-px bg-primary/35"
                style={{ height: `${h}px` }}
              />
            ))}
          </div>
        </div>
      </motion.aside>

      {/* ── Right: form column ─────────────────────────────────────── */}
      <motion.main
        {...panelEntrance}
        className="flex flex-col justify-center px-6 py-12 sm:px-10 md:px-16"
      >
        <div className="w-full max-w-[26rem] md:mx-0">
          {/* Mobile-only brand, since the masthead is hidden below md */}
          <div className="mb-10 md:hidden">
            <Logo tile compact />
          </div>

          <div className="h-px w-10 bg-primary" aria-hidden="true" />

          <p className="mt-6 font-mono text-[0.68rem] uppercase tracking-[0.18em] text-muted-foreground">
            Account
          </p>
          <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">
            Sign in
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Use your institute credentials, or continue with Google.
          </p>

          <form onSubmit={submit} noValidate className="mt-8 space-y-5">
            {formError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 border-l-2 border-destructive bg-destructive/5 py-2.5 pl-3 pr-3 text-sm text-destructive"
              >
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{formError}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label
                htmlFor="login-email"
                className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-muted-foreground"
              >
                Email
              </Label>
              <div className="relative">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@iitrpr.ac.in"
                  className="pl-9"
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'login-email-error' : undefined}
                  {...register('email')}
                />
              </div>
              {errors.email && (
                <p id="login-email-error" role="alert" className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <Label
                  htmlFor="login-password"
                  className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-muted-foreground"
                >
                  Password
                </Label>
              </div>
              <div className="relative">
                <Lock
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Your password"
                  className="pl-9 pr-10"
                  aria-invalid={!!errors.password}
                  aria-describedby={errors.password ? 'login-password-error' : undefined}
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              {errors.password && (
                <p id="login-password-error" role="alert" className="text-xs text-destructive">
                  {errors.password.message}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="mt-1 h-12 w-full rounded-full text-[0.95rem]"
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight aria-hidden="true" />
                </>
              )}
            </Button>
          </form>

          <div className="mt-7">
            <div className="relative">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-[var(--line)]" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-background px-3 font-mono text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">
                  or
                </span>
              </div>
            </div>

            <div className="mt-5">
              {google.status === 'ready' ? (
                <>
                  <div
                    id="google-sso-button"
                    ref={googleButton}
                    className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-[var(--radius-md)] border border-border/80 bg-background shadow-xs transition-colors hover:border-foreground/20"
                  />
                  <p className="mt-2 text-center text-xs text-muted-foreground">
                    Google sign-in is for @{google.domain} accounts only.
                  </p>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full gap-2.5 font-medium shadow-xs transition-colors hover:bg-muted/50"
                    disabled
                    aria-disabled="true"
                    aria-describedby="google-sso-note"
                  >
                    {google.status === 'loading' ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <GoogleGlyph className="size-4 shrink-0" />
                    )}
                    <span className="text-sm">
                      {google.status === 'loading' ? 'Checking Google sign-in…' : 'Continue with Google'}
                    </span>
                  </Button>
                  {google.status === 'disabled' && (
                    <p id="google-sso-note" role="status" className="mt-2 text-center text-xs text-muted-foreground">
                      {google.reason}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="mt-9 flex flex-col gap-2 border-t border-[var(--line)] pt-5 text-sm">
            <p className="text-muted-foreground">
              No account?{' '}
              <Link
                to="/register"
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                Register
              </Link>
            </p>
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-muted-foreground">
              Restricted to @iitrpr.ac.in
            </p>
          </div>
        </div>
      </motion.main>
    </div>
  );
}