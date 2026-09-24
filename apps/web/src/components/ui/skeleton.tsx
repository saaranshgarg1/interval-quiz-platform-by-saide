import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('skeleton rounded-[var(--radius-md)] bg-muted', className)}
      aria-hidden="true"
      {...props}
    />
  );
}
