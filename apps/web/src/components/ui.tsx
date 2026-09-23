export const IconSave = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={className}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </svg>
);

export const IconCheck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="16" height="16" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const IconClock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 3" />
  </svg>
);

export const IconAlert = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true">
    <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  </svg>
);

export const IconLock = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

/**
 * Non-colour-only status pill: every status pairs a symbol with text.
 * Colour is a secondary cue, never the only one.
 */
export function Pill({
  tone,
  symbol,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'brand';
  symbol?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`pill ${tone}`}>
      {symbol !== undefined && <span aria-hidden="true">{symbol}</span>}
      {children}
    </span>
  );
}

/** Human label for an attempt status with an explicit text symbol. */
export function statusLabel(status: string): { label: string; symbol: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'brand' } {
  switch (status) {
    case 'in_progress':
      return { label: 'In progress', symbol: '◐', tone: 'brand' };
    case 'submitted':
      return { label: 'Submitted', symbol: '✓', tone: 'ok' };
    case 'expired':
      return { label: 'Expired', symbol: '!', tone: 'warn' };
    case 'locked':
      return { label: 'Locked (review)', symbol: '🔒', tone: 'danger' };
    case 'under_review':
      return { label: 'Under review', symbol: '?', tone: 'warn' };
    case 'reinstated':
      return { label: 'Reinstated', symbol: '↩', tone: 'ok' };
    default:
      return { label: status, symbol: '·', tone: 'neutral' };
  }
}

export function formatDateTime(utc: string | null | undefined): string {
  if (!utc) return '—';
  const d = new Date(utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return utc;
  return d.toLocaleString();
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}) {
  const vClass = variant === 'secondary' ? 'secondary' : variant === 'danger' ? 'ghost-danger' : variant === 'ghost' ? 'ghost' : '';
  const sClass = size === 'sm' ? 'small' : '';
  return (
    <button className={`btn ${vClass} ${sClass} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}

export function Card({
  children,
  className = '',
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`.trim()} style={style} {...props}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  variant = 'secondary',
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const tone = variant === 'primary' ? 'brand' : variant === 'danger' ? 'danger' : 'neutral';
  return <Pill tone={tone}>{children}</Pill>;
}