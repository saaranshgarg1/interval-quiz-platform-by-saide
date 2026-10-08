import * as React from 'react';
import { AlertTriangle, Inbox, RefreshCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Shared page-level primitives. Every page composes these instead of
 * hand-rolling headers, loading, empty, and error surfaces — see DESIGN.md
 * "States": each data surface must express loading / empty / error.
 */

interface PageProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Constrain body width; defaults to the standard reading column. */
  width?: 'default' | 'wide' | 'full';
}

const WIDTHS: Record<NonNullable<PageProps['width']>, string> = {
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

/** Semantic page wrapper: <main> landmark, standard rhythm, optional header. */
export function Page({
  title,
  description,
  actions,
  width = 'default',
  className,
  children,
  ...props
}: PageProps) {
  const hasHeader = title || description || actions;
  return (
    <main className={cn('mx-auto w-full px-4 py-8 sm:px-6 lg:px-8', WIDTHS[width], className)} {...props}>
      {hasHeader && (
        <header className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 space-y-1.5 lg:max-w-[60%]">
            {title && (
              <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                {title}
              </h1>
            )}
            {description && (
              <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>}
        </header>
      )}
      {children}
    </main>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Guidance-first empty surface: tells the user what to do next, not just "nothing here". */
export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed bg-card/40 px-6 py-16 text-center',
        className,
      )}
    >
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  /** Accepts an Error, an ApiError, or a plain message. */
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}

function messageOf(error: unknown): string {
  if (!error) return 'Something went wrong.';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/** Recoverable error surface: states what failed and offers a retry when possible. */
export function ErrorState({ title = 'Could not load this', error, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-destructive/30 bg-destructive/5 px-6 py-16 text-center',
        className,
      )}
    >
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" aria-hidden="true" />
      </span>
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{messageOf(error)}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}

interface LoadingSkeletonProps {
  /** Number of placeholder rows to render. */
  rows?: number;
  /** Layout preset: stacked list rows or a responsive card grid. */
  variant?: 'list' | 'cards' | 'text';
  className?: string;
}

/** Structural loading placeholder that mirrors the content it stands in for. */
export function LoadingSkeleton({ rows = 3, variant = 'list', className }: LoadingSkeletonProps) {
  if (variant === 'cards') {
    return (
      <div
        className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-[var(--radius-lg)] border bg-card p-5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === 'text') {
    return (
      <div className={cn('space-y-2', className)} role="status" aria-busy="true" aria-label="Loading">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className={cn('h-4', i === rows - 1 ? 'w-3/5' : 'w-full')} />
        ))}
      </div>
    );
  }
  return (
    <div className={cn('space-y-3', className)} role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 rounded-[var(--radius-lg)] border bg-card p-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
