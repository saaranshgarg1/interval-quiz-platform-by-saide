import { cn } from '@/lib/utils';

/**
 * Interval mark — interval-notation glyph: two brackets framing a measured span.
 * Geometric and on-name, drawn on a 24×24 grid so it strokes cleanly at any size.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* left bracket */}
      <path
        d="M8.5 4.5H5.25A.75.75 0 0 0 4.5 5.25v13.5c0 .414.336.75.75.75H8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* right bracket */}
      <path
        d="M15.5 4.5h3.25a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* measured span */}
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

/**
 * Full lockup. `tile` renders the mark on a filled teal tile (login masthead,
 * empty states); the default renders mark + wordmark inline (topbar).
 */
export function Logo({
  tile = false,
  compact = false,
  className,
}: {
  tile?: boolean;
  compact?: boolean;
  className?: string;
}) {
  if (tile) {
    return (
      <span className={cn('flex items-center gap-3', className)}>
        <span
          className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-primary text-primary-foreground"
          aria-hidden="true"
        >
          <LogoMark className="size-[18px]" />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="font-display text-base font-semibold tracking-tight text-foreground">
            Interval
          </span>
          <span className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">
            {compact ? 'IIT Ropar' : 'sAIDE · IIT Ropar'}
          </span>
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn('flex items-center gap-2 text-foreground', className)}
      aria-label="Interval quiz portal"
    >
      <LogoMark className="size-[1.15em] text-primary" />
      <span className="font-display font-bold tracking-[-0.03em]">Interval</span>
    </span>
  );
}