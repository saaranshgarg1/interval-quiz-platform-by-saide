import { useEffect, useState, type ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Accessibility, Lock } from 'lucide-react';
import { api, ApiError } from '../api';
import type { AccessibilityPrefs, AccessibilityProfile } from '../types';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { toast } from './ui/sonner';

export const DEFAULT_PREFS: AccessibilityPrefs = {
  text_size: 'normal',
  contrast: 'normal',
  reduce_motion: false,
  dyslexia_font: false,
  line_spacing: 'normal',
  underline_links: false,
};

const KEY = ['accessibility'] as const;

export function useAccessibility() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get<{ accessibility: AccessibilityProfile }>('/auth/accessibility')).accessibility,
    staleTime: 60_000,
  });
}

/** Mirror the preferences onto <html> so the CSS in styles.css can apply them everywhere. */
function applyToDocument(p: AccessibilityPrefs) {
  const root = document.documentElement;
  root.dataset.textSize = p.text_size;
  root.dataset.contrast = p.contrast;
  root.dataset.lineSpacing = p.line_spacing;
  root.toggleAttribute('data-reduce-motion', p.reduce_motion);
  root.toggleAttribute('data-readable-font', p.dyslexia_font);
  root.toggleAttribute('data-underline-links', p.underline_links);
}

/** Applies the signed-in user's display preferences to every page (and every exam). */
export function AccessibilityProvider({ children }: { children: ReactNode }) {
  const { data } = useAccessibility();
  const prefs = data?.prefs ?? DEFAULT_PREFS;
  useEffect(() => {
    applyToDocument(prefs);
  }, [prefs]);
  useEffect(() => () => applyToDocument(DEFAULT_PREFS), []);
  return <MotionConfig reducedMotion={prefs.reduce_motion ? 'always' : 'user'}>{children}</MotionConfig>;
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-[var(--radius-md)] border px-3 py-1.5 text-sm transition-colors ${
              value === o.value ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-[var(--line-strong)] hover:bg-muted'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--primary)]"
        style={{ width: 'auto' }}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/** Editor for a set of preferences, shared by the self-service dialog and the admin Users page. */
export function AccessibilityFields({
  prefs,
  onChange,
  disabled = false,
}: {
  prefs: AccessibilityPrefs;
  onChange: (next: AccessibilityPrefs) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<AccessibilityPrefs>) => onChange({ ...prefs, ...patch });
  return (
    <div className="space-y-4">
      <Choice
        label="Text size"
        value={prefs.text_size}
        disabled={disabled}
        onChange={(text_size) => set({ text_size })}
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'large', label: 'Large' },
          { value: 'x-large', label: 'Extra large' },
        ]}
      />
      <Choice
        label="Contrast"
        value={prefs.contrast}
        disabled={disabled}
        onChange={(contrast) => set({ contrast })}
        options={[
          { value: 'normal', label: 'Standard' },
          { value: 'high', label: 'High contrast' },
        ]}
      />
      <Choice
        label="Line spacing"
        value={prefs.line_spacing}
        disabled={disabled}
        onChange={(line_spacing) => set({ line_spacing })}
        options={[
          { value: 'normal', label: 'Normal' },
          { value: 'relaxed', label: 'Relaxed' },
        ]}
      />
      <Toggle
        label="Readable font"
        hint="Wider, more distinct letters with extra spacing (helps with dyslexia)."
        checked={prefs.dyslexia_font}
        disabled={disabled}
        onChange={(dyslexia_font) => set({ dyslexia_font })}
      />
      <Toggle
        label="Reduce motion"
        hint="Turn off sliding and fading animations."
        checked={prefs.reduce_motion}
        disabled={disabled}
        onChange={(reduce_motion) => set({ reduce_motion })}
      />
      <Toggle
        label="Underline links"
        hint="Make links recognisable without relying on colour."
        checked={prefs.underline_links}
        disabled={disabled}
        onChange={(underline_links) => set({ underline_links })}
      />
    </div>
  );
}

/**
 * Top-bar button + dialog. Students (and staff) can change their own display
 * settings at any time except while an attempt is in progress; extra time is
 * an accommodation only an admin grants, so it is shown but not editable.
 */
export function AccessibilityMenu({ inAttempt }: { inAttempt: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useAccessibility();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AccessibilityPrefs>(DEFAULT_PREFS);
  const locked = inAttempt || Boolean(data?.locked_by_attempt);

  useEffect(() => {
    if (open) {
      setDraft(data?.prefs ?? DEFAULT_PREFS);
      void queryClient.invalidateQueries({ queryKey: KEY });
    }
    // Only when the dialog opens: refresh the lock state, start from the saved prefs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useMutation({
    mutationFn: async (prefs: AccessibilityPrefs) =>
      (await api.put<{ accessibility: AccessibilityProfile }>('/auth/accessibility', { prefs })).accessibility,
    onSuccess: (profile) => {
      queryClient.setQueryData(KEY, profile);
      toast.success('Accessibility settings saved');
      setOpen(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save your settings.'),
  });

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Accessibility settings">
            <Accessibility />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Accessibility</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Accessibility</DialogTitle>
            <DialogDescription>
              These settings follow your account to every page and every quiz.
            </DialogDescription>
          </DialogHeader>
          {locked && (
            <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-warning/50 bg-warning/10 px-3 py-2 text-sm" role="status">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              You have a quiz in progress. Settings can be changed before or after a quiz, not during one.
            </div>
          )}
          <AccessibilityFields prefs={draft} onChange={setDraft} disabled={locked} />
          {(data?.time_multiplier ?? 1) > 1 && (
            <p className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">Extra time</Badge>
              You get {Math.round(((data?.time_multiplier ?? 1) - 1) * 100)}% more time on every timed quiz (set by an
              administrator).
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDraft(DEFAULT_PREFS)} disabled={locked}>
              Reset
            </Button>
            <Button onClick={() => save.mutate(draft)} disabled={locked || save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
