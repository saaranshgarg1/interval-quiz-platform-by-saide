import { useId } from 'react';
import { Dices, Fullscreen, KeyRound, ListOrdered, LogOut, Network, ShieldAlert, Timer } from 'lucide-react';
import type { ExamSettings, SettingsPreset } from '../types';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';

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
  { key: 'practice', title: 'Practice', body: 'Nothing monitored. Students can come and go.' },
  { key: 'standard', title: 'Monitored', body: 'Switches recorded and warned; copy/paste blocked; watermark.' },
  { key: 'strict', title: 'Strict exam', body: 'Full screen with Windows key / Alt+Tab blocked, no re-entry, lock after 3 violations.' },
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

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-lg)] border p-4">
      <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </h4>
      {children}
    </section>
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
  const anyDetected = !value.allow_tab_switch || !value.allow_window_switch || value.require_fullscreen;

  const generateCode = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    set({ access_code: Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('') });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Label>Start from a preset</Label>
          <Badge variant={preset === 'custom' ? 'outline' : 'secondary'}>
            {preset === 'custom' ? 'Custom rules' : PRESET_INFO.find((p) => p.key === preset)?.title}
          </Badge>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {PRESET_INFO.map((p) => (
            <button
              key={p.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, ...PRESETS[p.key] })}
              className={`rounded-[var(--radius-md)] border p-3 text-left text-sm transition-colors hover:bg-accent/40 disabled:opacity-60 ${
                preset === p.key ? 'border-primary bg-primary/5' : ''
              }`}
            >
              <div className="font-semibold text-foreground">{p.title}</div>
              <div className="text-xs text-muted-foreground">{p.body}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={<ShieldAlert className="size-4 text-primary" aria-hidden="true" />} title="Browser rules">
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
            description="Off: copy, cut, paste, drag-in, print and dev-tools shortcuts are blocked and logged."
            checked={value.allow_copy_paste}
            onChange={(v) => set({ allow_copy_paste: v })}
            disabled={disabled}
          />
          <Toggle
            label="Allow right-click"
            checked={value.allow_right_click}
            onChange={(v) => set({ allow_right_click: v })}
            disabled={disabled}
          />
          <Toggle
            label="Require full screen"
            description="Opens in full screen when the student starts; questions are hidden outside it and leaving is a violation."
            checked={value.require_fullscreen}
            onChange={(v) => set({ require_fullscreen: v, ...(v ? {} : { lock_keyboard: false }) })}
            disabled={disabled}
          />
          <Toggle
            label="Block Windows key, Alt+Tab and Esc"
            description="Chrome/Edge keyboard lock in full screen: these keys go to the quiz, not the OS; leaving full screen needs Esc held down. Students must use Chrome or Edge. Turns on full screen."
            checked={value.lock_keyboard}
            onChange={(v) => set({ lock_keyboard: v, ...(v ? { require_fullscreen: true } : {}) })}
            disabled={disabled}
          />
          <Toggle
            label="Watermark with name & entry number"
            description="Makes leaked screenshots traceable."
            checked={value.watermark}
            onChange={(v) => set({ watermark: v })}
            disabled={disabled}
          />
        </Section>

        <div className="space-y-4">
          <Section icon={<ShieldAlert className="size-4 text-warning" aria-hidden="true" />} title="When rules are broken">
            {!anyDetected ? (
              <p className="py-2 text-xs text-muted-foreground">
                Turn off tab/window switching or require full screen to count violations.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 py-2">
                <div>
                  <Label htmlFor="violation-action">Action</Label>
                  <select
                    id="violation-action"
                    className={selectClass}
                    value={value.violation_action}
                    disabled={disabled}
                    onChange={(e) => set({ violation_action: e.target.value as ExamSettings['violation_action'] })}
                  >
                    <option value="none">Warn & record only</option>
                    <option value="lock">Lock for my review</option>
                    <option value="submit">Submit automatically</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="max-violations">After how many</Label>
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
                <p className="col-span-2 text-xs text-muted-foreground">
                  Students see a warning with the running count every time. One real switch is counted once.
                </p>
              </div>
            )}
          </Section>

          <Section icon={<LogOut className="size-4 text-primary" aria-hidden="true" />} title="Exit & resume">
            <Toggle
              label="Allow leaving and continuing later"
              description="On: a student who closes the tab (or switches device) can come back while time remains. Reloading is always fine."
              checked={value.allow_resume}
              onChange={(v) => set({ allow_resume: v })}
              disabled={disabled}
            />
            {!value.allow_resume && (
              <div className="pb-2">
                <Label htmlFor="reentry">If a student comes back after leaving</Label>
                <select
                  id="reentry"
                  className={selectClass}
                  value={value.reentry_action}
                  disabled={disabled}
                  onChange={(e) => set({ reentry_action: e.target.value as ExamSettings['reentry_action'] })}
                >
                  <option value="lock">Lock the attempt for my review</option>
                  <option value="submit">Submit it with saved answers</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  You can approve a re-entry for one student from the live monitor (e.g. a crashed laptop).
                </p>
              </div>
            )}
          </Section>
        </div>

        <Section icon={<Timer className="size-4 text-primary" aria-hidden="true" />} title="Navigation & question timers">
          <div className="grid grid-cols-2 gap-3 py-2">
            <div>
              <Label htmlFor="question-timer">Per-question timer</Label>
              <select
                id="question-timer"
                className={selectClass}
                value={value.question_timer}
                disabled={disabled}
                onChange={(e) => set({ question_timer: e.target.value as ExamSettings['question_timer'] })}
              >
                <option value="off">Off</option>
                <option value="uniform">Same time for every question</option>
                <option value="per_question">Set on each question</option>
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
          <div className="pb-2">
            <Label htmlFor="navigation" className="flex items-center gap-1.5">
              <ListOrdered className="size-4" aria-hidden="true" /> Navigation
            </Label>
            <select
              id="navigation"
              className={selectClass}
              value={value.navigation}
              disabled={disabled || value.question_timer !== 'off'}
              onChange={(e) => set({ navigation: e.target.value as ExamSettings['navigation'] })}
            >
              <option value="free">Free — move between questions, change answers</option>
              <option value="sequential">One way — one question at a time, no going back</option>
            </select>
            {value.question_timer !== 'off' && (
              <p className="mt-1 text-xs text-muted-foreground">Question timers always use one-way navigation.</p>
            )}
          </div>
        </Section>

        <Section icon={<KeyRound className="size-4 text-primary" aria-hidden="true" />} title="Access & question pool">
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="access-code">Access code (announce it in the exam hall)</Label>
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
                placeholder="e.g. 10.10.0.0/16 for the exam-hall LAN — leave empty for any network"
                value={value.allowed_networks.join('\n')}
                onChange={(e) => set({ allowed_networks: e.target.value.split(/[\s,;]+/).filter(Boolean) })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="draw" className="flex items-center gap-1.5">
                  <Dices className="size-4" aria-hidden="true" /> Random questions per student
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
            {value.questions_per_attempt !== null && (
              <p className="text-xs text-muted-foreground">
                Use equal points per question so every student’s paper is worth the same.
              </p>
            )}
          </div>
        </Section>
      </div>

      {value.require_fullscreen && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Fullscreen className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Browser rules deter and record; they cannot make cheating impossible. For high-stakes exams combine them with
          invigilation, an access code and the exam-hall network restriction.
        </p>
      )}
    </div>
  );
}
