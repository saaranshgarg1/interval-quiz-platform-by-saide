# Interval — Design System

Quiz portal for sAIDE, IIT Ropar. Editorial-academic aesthetic: calm, precise, confident. Built Tailwind v4 (CSS-first) + shadcn/ui + Radix.

## Direction

Refined academic tool, not a playful consumer app. Generous whitespace, strong typographic hierarchy, one restrained accent. Reads like a well-set journal, behaves like a fast native app.

## Color (OKLCH)

Tokens live in `src/styles.css` `:root` / `.dark`, surfaced to Tailwind via `@theme inline`.

- **Accent** — teal `--primary: oklch(0.55 0.098 205)`. Single accent, saturation kept < 80%. Used for primary actions, active nav, focus rings, links.
- **Neutrals** — tinted, never pure. Background/foreground/card/muted/border carry a faint cool tint (no `#000`/`#fff`).
- **Semantic** — `--success` (green), `--warning` (amber), `--destructive` (red). Used only for state, never decoration.
- **Legacy aliases** — `--brand/--surface/--ink/--ok/--warn/--danger` mapped onto new tokens so pre-existing class-based markup restyles for free.

Dark mode: `.dark` class on `<html>`, driven by `ThemeProvider` (`src/lib/theme.tsx`), persisted to `localStorage`, honors `prefers-color-scheme` on first load.

## Type

- **Display** — Outfit (headings, brand, card titles). `--font-display`.
- **Body** — Plus Jakarta Sans. `--font-sans`.
- **Mono** — JetBrains Mono (timers, kbd, code). `--font-mono`.
- No Inter. Headings use display font with tight tracking.

## Shape & depth

- Radius scale: `--radius-sm/md/lg`. Cards `lg`, controls `md`, chips full-round.
- Tinted soft shadows `--shadow-sm/md/lg` (never harsh black). Cards lift on hover.

## Motion

- Spring-ish easing `cubic-bezier(0.22, 1, 0.36, 1)` for page/element entrances.
- Micro-interactions: buttons nudge `-1px` on hover, `+1px` on press.
- Timer pulse, save-state spinner, skeleton shimmer.
- All wrapped by `@media (prefers-reduced-motion: reduce)` guard.

## Layout

- `min-h-[100dvh]` (never `h-screen`).
- Content max-width 1140px, centered, comfortable padding.
- Sticky glassy topbar (blur + saturate).

## Components

shadcn/ui primitives in `src/components/ui/`: button, card, input, textarea, label, badge, skeleton, separator, progress, tabs, tooltip, dialog, dropdown-menu, command, sonner. Legacy facade `src/components/ui.tsx` (Icons, Pill, statusLabel, Card, Badge, Button) retained — pages importing `../components/ui` keep working under restyled classes.

## Platform affordances

- **Dark mode** toggle in topbar + command palette.
- **⌘K command palette** (`CommandPalette.tsx`) — navigate + actions.
- **Toasts** — sonner, bottom-right, tokenized.
- **Tooltips** — global provider, 200ms delay.

## States (required per surface)

Every data surface ships: **loading** (skeleton), **empty** (guidance, not blank), **error** (recoverable message). No raw spinners-only.

## Accessibility (WCAG AA target)

- Visible focus rings (`ring-ring/40`, 3px) on all interactive elements.
- Icons paired with text or `aria-label`; decorative marks `aria-hidden`.
- Keyboard: full nav, palette, dialog focus-trap (Radix), Esc to close.
- No emoji as UI; lucide icons throughout.
- Semantic landmarks (`header`, `nav[aria-label]`, `main`).
