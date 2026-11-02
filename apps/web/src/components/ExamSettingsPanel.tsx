import { useId, useState } from 'react';
import {
  Dices,
  Fullscreen,
  KeyRound,
  ListOrdered,
  LogOut,
  Network,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Timer,
} from 'lucide-react';
import type { ExamSettings, SettingsPreset } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

/** Proctoring presets — must match api/services/exam-settings.ts PRESETS. */
const PRESETS: Record<SettingsPreset, Partial<ExamSettings>> = {
  practice: {
    allow_tab_switch: true,
    allow_window_switch: true,
    allow_copy_paste: true,
    allow_right_click: true,
    require_fullscreen: false,
    lock_keyboard: false,
    allow_resume: true,
    reentry_action: 'lock',
    violation_action: 'none',
    max_violations: 3,
    watermark: false,
  },
  standard: {
    allow_tab_switch: false,
    allow_window_switch: false,
    allow_copy_paste: false,
    allow_right_click: false,
    require_fullscreen: false,
    lock_keyboard: false,
    allow_resume: true,
    reentry_action: 'lock',
    violation_action: 'none',
    max_violations: 3,
    watermark: true,
  },
  strict: {
    allow_tab_switch: false,
    allow_window_switch: false,
    allow_copy_paste: false,
    allow_right_click: false,
    require_fullscreen: true,
    lock_keyboard: true,
    allow_resume: false,
    reentry_action: 'lock',
    violation_action: 'lock',
    max_violations: 3,
    watermark: true,
  },
};

const PRESET_INFO: { key: SettingsPreset; title: string; body: string }[] = [
  { key: 'practice', title: 'Practice', body: 'Nothing monitored. Students can come and go freely.' },
  { key: 'standard', title: 'Monitored', body: 'Switches recorded and warned; copy/paste blocked; watermark.' },
  { key: 'strict', title: 'Strict exam', body: 'Full screen with system shortcuts trapped, no re-entry, locks after 3 violations.' },
];

export function presetOf(s: ExamSettings): SettingsPreset | 'custom' {
  for (const [name, p] of Object.entries(PRESETS) as [SettingsPreset, Partial<ExamSettings>][]) {
    if (Object.entries(p).every(([k, v]) => s[k as keyof ExamSettings] === v)) return name;
  }
  return 'custom';
}

export const DEFAULT_EXAM_SETTINGS: ExamSettings = {
  navigation: 'free',
  question_timer: 'off',
  question_time_seconds: 60,
  ...(PRESETS.practice as Omit<ExamSettings, 'navigation' | 'question_timer' | 'question_time_seconds' | 'access_code' | 'allowed_networks' | 'late_entry_minutes' | 'questions_per_attempt'>),
  access_code: '',
  allowed_networks: [],
  late_entry_minutes: null,
  questions_per_attempt: null,
};

function Toggle({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50 ${
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block size-5 rounded-full bg-card shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  );
}

const selectClass =
  'mt-1 block w-full rounded-[var(--radius-md)] border border-[var(--line-strong)] bg-card px-3 py-2 text-sm focus:outline-none focus:ring-[3px] focus:ring-ring/40 disabled:opacity-60';

export function ExamSettingsPanel({
  value,
  onChange,
  disabled,
  questionCount,
  scheduled,
}: {
  value: ExamSettings;
  onChange: (next: ExamSettings) => void;
  disabled?: boolean;
  questionCount: number;
  scheduled: boolean;
}) {
  const set = (patch: Partial<ExamSettings>) => {
    const next = { ...value, ...patch };
    if (next.question_timer !== 'off') next.navigation = 'sequential';
    onChange(next);
  };
  const preset = presetOf(value);
  const [configMode, setConfigMode] = useState<'preset' | 'manual'>(() =>
    preset === 'custom' ? 'manual' : 'preset',
  );

  const anyDetected = !value.allow_tab_switch || !value.allow_window_switch || value.require_fullscreen;

  const generateCode = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    set({ access_code: Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('') });
  };

  return (
    <div className="space-y-4">
      {/* Top mode switcher: Presets vs Manual configuration */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-semibold">Configuration mode:</Label>
          <Badge variant={preset === 'custom' ? 'outline' : 'secondary'}>
            {preset === 'custom' ? 'Custom rules' : PRESET_INFO.find((p) => p.key === preset)?.title}
          </Badge>
        </div>
        <Tabs
          value={configMode}
          onValueChange={(v) => setConfigMode(v as 'preset' | 'manual')}
          className="w-auto"
        >
          <TabsList className="h-9">
            <TabsTrigger value="preset" className="gap-1.5 px-3 text-xs">
              <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
              Use preset
            </TabsTrigger>
            <TabsTrigger value="manual" className="gap-1.5 px-3 text-xs">
              <SlidersHorizontal className="size-3.5" aria-hidden="true" />
              Manual configuration
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {configMode === 'preset' ? (
        <div className="space-y-4 pt-1">
          <p className="text-xs text-muted-foreground">
            Select a battle-tested rule preset, or switch to <strong>Manual configuration</strong> to fine-tune individual policies.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {PRESET_INFO.map((p) => (
              <button
                key={p.key}
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...value, ...PRESETS[p.key] })}
                className={`rounded-[var(--radius-lg)] border p-4 text-left transition-all hover:bg-accent/40 disabled:opacity-60 ${
                  preset === p.key
                    ? 'border-primary bg-primary/5 shadow-xs ring-1 ring-primary/25'
                    : 'border-border/80 bg-card hover:border-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-foreground">{p.title}</div>
                  {preset === p.key && (
                    <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                  )}
                </div>
                <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{p.body}</div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        /* Tabbed Manual Controls */
        <Tabs defaultValue="browser" className="w-full pt-1">
          <TabsList className="grid h-10 w-full grid-cols-4 bg-muted/70 p-1">
            <TabsTrigger value="browser" className="text-xs sm:text-sm">
              Browser rules
            </TabsTrigger>
            <TabsTrigger value="violations" className="text-xs sm:text-sm">
              Violations & Exit
            </TabsTrigger>
            <TabsTrigger value="timing" className="text-xs sm:text-sm">
              Timers & Flow
            </TabsTrigger>
            <TabsTrigger value="access" className="text-xs sm:text-sm">
              Access & Pool
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: Browser rules */}
          <TabsContent value="browser" className="mt-3 rounded-[var(--radius-lg)] border border-border/80 bg-card p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldAlert className="size-4 text-primary" aria-hidden="true" />
              Browser integrity & environment
            </div>
            <div className="divide-y divide-border/60">
              <Toggle
                label="Allow switching tabs"
                description="Off: leaving the quiz tab counts as a violation."
                checked={value.allow_tab_switch}
                onChange={(v) => set({ allow_tab_switch: v })}
                disabled={disabled}
              />
              <Toggle
                label="Allow switching windows / apps"
                description="Off: moving focus to another window or app counts as a violation."
                checked={value.allow_window_switch}
                onChange={(v) => set({ allow_window_switch: v })}
                disabled={disabled}
              />
              <Toggle
                label="Allow copy & paste"
                description="Off: copy, cut, paste, drag-in, print and devtools shortcuts are blocked and logged."
                checked={value.allow_copy_paste}
                onChange={(v) => set({ allow_copy_paste: v })}
                disabled={disabled}
              />
              <Toggle
                label="Allow right-click"
                description="Off: disables browser context menu during the attempt."
                checked={value.allow_right_click}
                onChange={(v) => set({ allow_right_click: v })}
                disabled={disabled}
              />
              <Toggle
                label="Require full screen"
                description="Opens in full screen when starting; questions are hidden outside it and leaving is a violation."
                checked={value.require_fullscreen}
                onChange={(v) => set({ require_fullscreen: v, ...(v ? {} : { lock_keyboard: false }) })}
                disabled={disabled}
              />
              <Toggle
                label="Block Windows key, Alt+Tab and Esc"
                description="Cross-browser keyboard protection: hardware lock on Chrome/Edge, DOM interceptor guard on Firefox and other browsers."
                checked={value.lock_keyboard}
                onChange={(v) => set({ lock_keyboard: v, ...(v ? { require_fullscreen: true } : {}) })}
                disabled={disabled}
              />
              <Toggle
                label="Watermark with student identity"
                description="Adds student name and entry number watermark across questions."
                checked={value.watermark}
                onChange={(v) => set({ watermark: v })}
                disabled={disabled}
              />
            </div>
          </TabsContent>

          {/* Tab 2: Violations & Exit */}
          <TabsContent value="violations" className="mt-3 space-y-4">
            <div className="rounded-[var(--radius-lg)] border border-border/80 bg-card p-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldAlert className="size-4 text-warning" aria-hidden="true" />
                Violation handling
              </div>
              {!anyDetected ? (
                <p className="py-2 text-xs text-muted-foreground">
                  Turn off tab/window switching or require full screen in Browser rules to count violations.
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 pt-2">
                  <div>
                    <Label htmlFor="violation-action">Action on threshold</Label>
                    <select
                      id="violation-action"
                      className={selectClass}
                      value={value.violation_action}
                      disabled={disabled}
                      onChange={(e) => set({ violation_action: e.target.value as ExamSettings['violation_action'] })}
                    >
                      <option value="none">Warn & record only</option>
                      <option value="lock">Lock for instructor review</option>
                      <option value="submit">Submit attempt automatically</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="max-violations">Max allowed violations</Label>
                    <Input
                      id="max-violations"
                      type="number"
                      min={1}
                      max={100}
                      value={value.max_violations}
                      disabled={disabled || value.violation_action === 'none'}
                      onChange={(e) => set({ max_violations: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </div>
                  <p className="sm:col-span-2 text-xs text-muted-foreground">
                    Students receive warning popups with a live strike count each time. One real switch counts as one violation.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-[var(--radius-lg)] border border-border/80 bg-card p-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <LogOut className="size-4 text-primary" aria-hidden="true" />
                Exit & Resume
              </div>
              <Toggle
                label="Allow leaving and resuming later"
                description="On: students who close their tab or switch devices can continue while time remains."
                checked={value.allow_resume}
                onChange={(v) => set({ allow_resume: v })}
                disabled={disabled}
              />
              {!value.allow_resume && (
                <div className="pt-2">
                  <Label htmlFor="reentry">If student returns after leaving</Label>
                  <select
                    id="reentry"
                    className={selectClass}
                    value={value.reentry_action}
                    disabled={disabled}
                    onChange={(e) => set({ reentry_action: e.target.value as ExamSettings['reentry_action'] })}
                  >
                    <option value="lock">Lock attempt for review</option>
                    <option value="submit">Submit immediately with saved answers</option>
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Instructors can unlock attempts from the live monitor (e.g. for computer reboots).
                  </p>
                </div>
              )}
            </div>
          </TabsContent>

          {/* Tab 3: Timers & Navigation */}
          <TabsContent value="timing" className="mt-3 rounded-[var(--radius-lg)] border border-border/80 bg-card p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <Timer className="size-4 text-primary" aria-hidden="true" />
              Navigation flow & per-question timing
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="question-timer">Per-question timer mode</Label>
                <select
                  id="question-timer"
                  className={selectClass}
                  value={value.question_timer}
                  disabled={disabled}
                  onChange={(e) => set({ question_timer: e.target.value as ExamSettings['question_timer'] })}
                >
                  <option value="off">Off (whole quiz timer only)</option>
                  <option value="uniform">Same time for every question</option>
                  <option value="per_question">Individual time per question</option>
                </select>
              </div>
              <div>
                <Label htmlFor="question-seconds">
                  {value.question_timer === 'per_question' ? 'Default seconds' : 'Seconds per question'}
                </Label>
                <Input
                  id="question-seconds"
                  type="number"
                  min={5}
                  max={7200}
                  value={value.question_time_seconds}
                  disabled={disabled || value.question_timer === 'off'}
                  onChange={(e) => set({ question_time_seconds: Math.max(5, Number(e.target.value) || 5) })}
                />
              </div>
            </div>
            <div className="mt-4 border-t border-border/60 pt-4">
              <Label htmlFor="navigation" className="flex items-center gap-1.5">
                <ListOrdered className="size-4" aria-hidden="true" /> Question navigation flow
              </Label>
              <select
                id="navigation"
                className={selectClass}
                value={value.navigation}
                disabled={disabled || value.question_timer !== 'off'}
                onChange={(e) => set({ navigation: e.target.value as ExamSettings['navigation'] })}
              >
                <option value="free">Free — move between questions, review and change answers</option>
                <option value="sequential">One way — one question at a time, no backtracking</option>
              </select>
              {value.question_timer !== 'off' && (
                <p className="mt-1 text-xs text-muted-foreground">Question timers enforce one-way sequential navigation.</p>
              )}
            </div>
          </TabsContent>

          {/* Tab 4: Access & Pool */}
          <TabsContent value="access" className="mt-3 rounded-[var(--radius-lg)] border border-border/80 bg-card p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <KeyRound className="size-4 text-primary" aria-hidden="true" />
              Access code, network restrictions & pools
            </div>
            <div>
              <Label htmlFor="access-code">Exam access code</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  id="access-code"
                  value={value.access_code}
                  maxLength={64}
                  disabled={disabled}
                  placeholder="None — anyone enrolled can start"
                  onChange={(e) => set({ access_code: e.target.value })}
                />
                <Button type="button" variant="secondary" size="sm" className="h-10" disabled={disabled} onClick={generateCode}>
                  Generate
                </Button>
              </div>
            </div>

            <div>
              <Label htmlFor="networks" className="flex items-center gap-1.5">
                <Network className="size-4" aria-hidden="true" /> Allowed networks (IP or CIDR, optional)
              </Label>
              <Textarea
                id="networks"
                rows={2}
                disabled={disabled}
                placeholder="e.g. 10.10.0.0/16 for exam-hall LAN — leave empty for any network"
                value={value.allowed_networks.join('\n')}
                onChange={(e) => set({ allowed_networks: e.target.value.split(/[\s,;]+/).filter(Boolean) })}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="draw" className="flex items-center gap-1.5">
                  <Dices className="size-4" aria-hidden="true" /> Random question pool per student
                </Label>
                <Input
                  id="draw"
                  type="number"
                  min={1}
                  max={Math.max(1, questionCount)}
                  disabled={disabled}
                  placeholder={`All ${questionCount}`}
                  value={value.questions_per_attempt ?? ''}
                  onChange={(e) => set({ questions_per_attempt: e.target.value === '' ? null : Math.max(1, Number(e.target.value)) })}
                />
                {value.questions_per_attempt !== null && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ensure equal points across questions for score uniformity.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="late-entry">Late entry closes after (min)</Label>
                <Input
                  id="late-entry"
                  type="number"
                  min={0}
                  max={1440}
                  disabled={disabled || !scheduled}
                  placeholder={scheduled ? 'No limit' : 'Scheduled quizzes only'}
                  value={value.late_entry_minutes ?? ''}
                  onChange={(e) => set({ late_entry_minutes: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })}
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {value.require_fullscreen && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground pt-1">
          <Fullscreen className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          Full-screen mode deter and record events. For secure in-person exams, combine with invigilation, an access code, and campus network restrictions.
        </p>
      )}
    </div>
  );
}
