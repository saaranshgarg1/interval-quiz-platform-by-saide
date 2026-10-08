import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion, useReducedMotion } from 'framer-motion';
import { Eye, EyeOff, Loader2, User, Mail, KeyRound, Info, Hash } from 'lucide-react';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';

const schema = z
  .object({
    name: z.string().min(2, 'Enter your full name.'),
    email: z.string().email('Enter a valid email address.'),
    entry: z
      .string()
      .trim()
      .regex(/^([A-Za-z0-9._/-]{2,32})?$/, 'Use letters and digits only, e.g. 2022CSB1234.'),
    password: z.string().min(8, 'Password must be at least 8 characters.'),
    confirm: z.string().min(8, 'Enter the password again.'),
  })
  .refine((d) => d.password === d.confirm, {
    message: 'Passwords do not match.',
    path: ['confirm'],
  });

type FormData = z.infer<typeof schema>;

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();

  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const {
    register: reg,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', entry: '', password: '', confirm: '' },
  });

  const onValid = async (data: FormData) => {
    setFormError(null);
    setBusy(true);
    try {
      await register(data.name, data.email, data.password, data.entry || undefined);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
        // Surface server-side email conflict on the email field for focus.
        if (err.status === 409) {
          setError('email', {
            message: 'An account with this email already exists.',
          });
        }
      } else {
        setFormError('Registration failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = handleSubmit(onValid);

  const entrance = {
    initial: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 },
    animate: reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
      <motion.div {...entrance} className="w-full max-w-md">
        <Card className="overflow-hidden shadow-[var(--shadow-lg)]">
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-full bg-accent text-primary">
                <User className="size-4" aria-hidden="true" />
              </span>
              <div className="space-y-0.5">
                <CardTitle>Create an account</CardTitle>
                <CardDescription>Quiz portal for sAIDE · IIT Ropar</CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <form onSubmit={submit} noValidate className="space-y-4">
              {formError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
                >
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Name */}
              <div className="space-y-1.5">
                <Label htmlFor="reg-name">
                  <User className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden="true" />
                  Full name
                </Label>
                <Input
                  id="reg-name"
                  autoComplete="name"
                  placeholder="Your name"
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? 'reg-name-error' : undefined}
                  {...reg('name')}
                />
                {errors.name && (
                  <p id="reg-name-error" role="alert" className="text-xs text-destructive">
                    {errors.name.message}
                  </p>
                )}
              </div>

              {/* Email */}
              <div className="space-y-1.5">
                <Label htmlFor="reg-email">
                  <Mail className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden="true" />
                  Email
                </Label>
                <Input
                  id="reg-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@iitrpr.ac.in"
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'reg-email-error' : undefined}
                  {...reg('email')}
                />
                {errors.email && (
                  <p id="reg-email-error" role="alert" className="text-xs text-destructive">
                    {errors.email.message}
                  </p>
                )}
              </div>

              {/* Entry number */}
              <div className="space-y-1.5">
                <Label htmlFor="reg-entry">
                  <Hash className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden="true" />
                  Entry number <span className="font-normal text-muted-foreground">(students)</span>
                </Label>
                <Input
                  id="reg-entry"
                  autoComplete="off"
                  placeholder="e.g. 2022CSB1234 — filled from your institute email if left empty"
                  aria-invalid={!!errors.entry}
                  aria-describedby={errors.entry ? 'reg-entry-error' : undefined}
                  {...reg('entry')}
                />
                {errors.entry && (
                  <p id="reg-entry-error" role="alert" className="text-xs text-destructive">
                    {errors.entry.message}
                  </p>
                )}
              </div>

              {/* Password */}
              <div className="space-y-1.5">
                <Label htmlFor="reg-password">
                  <KeyRound className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden="true" />
                  Password
                </Label>
                <div className="relative">
                  <Input
                    id="reg-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    aria-invalid={!!errors.password}
                    aria-describedby={errors.password ? 'reg-password-error' : undefined}
                    {...reg('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {errors.password && (
                  <p id="reg-password-error" role="alert" className="text-xs text-destructive">
                    {errors.password.message}
                  </p>
                )}
              </div>

              {/* Confirm password */}
              <div className="space-y-1.5">
                <Label htmlFor="reg-confirm">
                  <KeyRound className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden="true" />
                  Confirm password
                </Label>
                <div className="relative">
                  <Input
                    id="reg-confirm"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Re-enter password"
                    aria-invalid={!!errors.confirm}
                    aria-describedby={errors.confirm ? 'reg-confirm-error' : undefined}
                    {...reg('confirm')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                  >
                    {showConfirm ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {errors.confirm && (
                  <p id="reg-confirm-error" role="alert" className="text-xs text-destructive">
                    {errors.confirm.message}
                  </p>
                )}
              </div>

              {/* Info note — roles are assigned by an admin, not self-selected */}
              <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-accent bg-accent/50 px-3 py-2.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>
                  All new accounts start as <strong className="font-semibold text-foreground">student</strong>.
                  Instructor access is granted by an admin.
                </span>
              </div>

              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Creating account…
                  </>
                ) : (
                  'Register'
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="justify-center border-t p-4 text-sm text-muted-foreground">
            <span>
              Already registered?{' '}
              <Link
                to="/login"
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                Sign in
              </Link>
            </span>
          </CardFooter>
        </Card>
      </motion.div>
    </div>
  );
}
