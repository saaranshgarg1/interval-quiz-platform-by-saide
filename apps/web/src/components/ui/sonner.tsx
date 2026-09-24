import { Toaster as SonnerToaster, toast } from 'sonner';

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast:
            'group rounded-[var(--radius-md)] border bg-card text-foreground shadow-[var(--shadow-lg)]',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground',
          error: 'text-destructive',
          success: 'text-[var(--success)]',
        },
      }}
      {...props}
    />
  );
}

export { toast };
