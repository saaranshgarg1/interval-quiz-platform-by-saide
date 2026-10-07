# Interval ◇

A from-scratch **quiz portal for the sAIDE website (IIT Ropar)** — designed and built as an HCI
course project. Interval rethinks the existing graded/practice-assessment experience around four
documented usability gaps, with every design decision traced back to a proposal gap (G1–G4) and, in the build,
to working code.



## What problems does it solve?

| Gap | Problem in the legacy experience | How Interval answers it |
|-----|----------------------------------|--------------------------|
| **G1** | Question and answer on separate surfaces | One-surface player: the answer input sits in the question card |
| **G2** | No save feedback → lost answers | Server-acknowledged saves: `pending → saving → saved` with ack timestamps; revision-confirmed idempotent saves; server-generated receipts |
| **G3** | Opaque, unfair integrity "rules" | Preflight policy disclosure (off/warn/strict in plain words), explained lock screens, recorded review decisions with reasons, full audit trail |
| **G4** | Risky live editing of exams | Draft → preview → publish; published versions are immutable; edits clone into a new draft |

---

## Repo layout

```
package.json          # pnpm workspaces; dev/seed/build/typecheck scripts
pnpm-workspace.yaml   # workspace globs + onlyBuiltDependencies: esbuild
apps/
  api/                # Express + TypeScript on Node 24 node:sqlite (no native deps)
    src/              # server, db/schema, auth (scrypt+JWT), repo, services (grading/attempts/policy), routes
    data/interval.db  # SQLite database (created by `npm run seed`)
  web/                # React 18 + Vite + TypeScript, plain-CSS design system
    src/              # api client, auth context, ui components, 10 pages
docs/
  lab5/               # user-tasks.md · user-flows.md (mermaid) · design-rationale.md
  lab6/               # implementation.md · debugging.md
  lab7/               # testing.md · report.md (usability evaluation, P0/P1/P2)
  lab8/               # improvements.md (Lab 7 fixes + regression suite)
e2e/
  lab8-regression.spec.ts  # Playwright/Chromium suite proving Lab 7 P0s are gone
playwright.config.ts  # system-Chromium runner config
lab5/
  prototype/          # clickable low-fi HTML prototype (index.html)
```

---

## Quickstart

Prerequisites: Node **24** (for `node:sqlite`), pnpm **10+** (`corepack enable` provides it).

```bash
pnpm install          # installs all workspaces; esbuild is allow-listed in pnpm-workspace.yaml
pnpm run seed         # (re)build data/interval.db with demo data
pnpm run dev:api      # API dev server on http://localhost:4000 (tsx watch)
pnpm run dev:web      # web dev server on http://localhost:5173 (/api proxied to :4000)
```

Other scripts:

```bash
pnpm run build        # tsc (api) + tsc & vite build (web) -> apps/web/dist
pnpm run start:web    # serve the built web app on :5174
pnpm run typecheck    # tsc --noEmit for both workspaces
pnpm test             # API suite (node:test) — 19 tests
pnpm run test:e2e     # Playwright E2E regression in system Chromium (needs dev servers up)
```

### Demo accounts (seed data)

| Email | Password | Role |
|---|---|---|
| `admin@saide.local` | `admin123` | admin |
| `shlok@iitrpr.ac.in` | `instructor123` | instructor |
| `student1@iitrpr.ac.in` … `student8@iitrpr.ac.in` | `student123` | student |

Two courses are seeded (`AI511` HCI, `CS305` DB), the HCI course already contains a **published** quiz
("HCI Basics – Checkpoint Quiz 1", strict policy) and a couple of locked/expired attempts so the incident
review flow can be demonstrated immediately.

---

## The two demo flows (how to walk an evaluator through)

**Task 1 — Instructor publishes a quiz (G4, G3)**
1. Sign in as `shlok@iitrpr.ac.in` → open AI511 → **New quiz**.
2. Add title/instructions, questions (single/multiple/numeric/short), set points and answer keys.
3. Configure duration, attempts, `show_scores`, and the integrity policy (off/warn/strict) — the UI shows the
   exact student-facing wording at authoring time.
4. **Preview** (same player component students use) → **Publish**. The version is frozen; editing afterwards
   clones a new draft instead of mutating the live one.

**Task 2 — Student completes & submits (G1, G2, G3)**
1. Sign in as `student1@iitrpr.ac.in` → AI511 → quiz → **preflight card** (read the strict policy disclosure).
2. **Start attempt** → answer on the same surface; watch the save indicator and ack time; check the server-clock
   countdown; try editing the same question twice to see revisions reconcile.
3. Switch browser tabs (strict) → **attempt locks (HTTP 423)** with an explanation screen; see the case appear in
   the instructor’s **Incidents** inbox; reinstate or "grade from saved answers" with a recorded reason.
4. Submit → **receipt** with acknowledged-answer count → result breakdown (score now, correct answers after key
   release) → CSV export per version.

---


### Core Capabilities & Deliverables
- **Auth & Access Control**: Scrypt + JWT sessions, role enforcement (student, TA, instructor, admin), and campus sAIDE SSO / CAS integration.
- **Quiz Authoring & Versioning (G4)**: Draft → preview → publish lifecycle, non-destructive clone on edit, shuffle, point weighting, and timing.
- **LaTeX Math & Rich Text**: In-app formula rendering (`$x^2$`, `$$\int f(x)dx$$`) across quiz editor, student player, and results view.
- **Question Banks & Batch Tools**: Category tagging, reusable question banks, and JSON/CSV batch import and export.
- **Student Accessibility & Accommodations**: Course-level student time multipliers (1.5x / 2.0x) and extra-minute adjustments automatically computed at runtime.
- **Attempt Lifecycle (G1, G2)**: One-surface question cards, acknowledged saves with revision conflict reconciliation, server receipts, and server clock deadline enforcement.
- **Auto-Grading**: Real-time evaluation for single choice, multiple choice, numeric with tolerances ($\pm \epsilon$), and case-insensitive short text.
- **Fair Integrity Engine (G3)**: Plain-language disclosures (Off / Warn / Strict), HTTP 423 lock states, instructor incident review inbox, and audit trail.
- **Psychometrics & Analytics**: Score distribution histograms, item difficulty ratings, and discrimination index ($D = P_{top} - P_{bottom}$) calculations.
- **Automated Verification**: End-to-end automated test suite (`npm test`) with 100% pass rate.
- **Containerization**: Multi-stage `Dockerfile` and `docker-compose.yml` for single-command production deployment.

---

## Key engineering decisions

- **`node:sqlite`** (built-in, Postgres-compatible schema) → zero native dependencies; loose driver types are
  isolated behind one module augmentation (`apps/api/src/sqlite-types.d.ts`).
- **Synchronous route handlers** + one central `errorHandler` → a thrown error can never strand a request or
  crash `tsx watch` (see `docs/lab6/debugging.md` P3).
- **Server clock is the authority**: every attempt returns `server_now`; the client timer is an offset, and
  deadline/expiry decisions live in the domain layer (P7).
- **Status codes are domain messages**: `423` = strict lock, `409` = attempt no longer active, `404` = not
  released/not found — and the client branches on them explicitly (P6).

---

## Complete Lab Milestones & Docs Index

- **Lab 4: Define** — [`Literature_Proposal.pdf`](Literature_Proposal.pdf) (Literature review, problem statement, proposal gaps G1–G4).
- **Lab 5: Design** — [`docs/lab5/user-tasks.md`](docs/lab5/user-tasks.md) · [`docs/lab5/user-flows.md`](docs/lab5/user-flows.md) · [`docs/lab5/design-rationale.md`](docs/lab5/design-rationale.md) · [`lab5/prototype/`](lab5/prototype/).
- **Lab 6: Build** — [`docs/lab6/implementation.md`](docs/lab6/implementation.md) · [`docs/lab6/debugging.md`](docs/lab6/debugging.md).
- **Lab 7: Test** — [`docs/lab7/testing.md`](docs/lab7/testing.md) (automated suite) · [`docs/lab7/report.md`](docs/lab7/report.md) (usability evaluation, P0/P1/P2 findings).
- **Lab 8: Improve** — [`docs/lab8/improvements.md`](docs/lab8/improvements.md) (Lab 7 P0/P1 fixes, deeper defects found, Chromium E2E regression suite).

---

## Technologies used

| Layer | Stack |
|-------|-------|
| **Language** | TypeScript (strict) across the whole monorepo |
| **Monorepo** | pnpm workspaces (`apps/api`, `apps/web`) |
| **Backend** | Node 24, Express, built-in `node:sqlite` (no native deps), scrypt password hashing + JWT (HMAC) sessions, RBAC guards, audit logging |
| **Frontend** | React 18, Vite, React Router, Tailwind CSS v4 + shadcn/ui, @tanstack/react-query + react-table, react-hook-form + zod, framer-motion, sonner, lucide-react |
| **Math/rich text** | In-app LaTeX rendering across editor, player, and results |
| **Testing** | Node 24 native test runner (`node:test`) for the API; Playwright on system Chromium for E2E regression |
| **Tooling** | tsc / tsx, ESLint, Docker + docker-compose for deployment |

---

## Team members

| Name | Role |
|------|------|
| Saaransh Garg | Backend / API, RBAC |
| Shlok Vaidya | Frontend / UI |
