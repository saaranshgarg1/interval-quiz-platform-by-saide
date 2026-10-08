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

## Strict exam platform (500 students at once)

Interval runs proctored exams for a whole class simultaneously. Full guide:
**[`docs/exam-platform.md`](docs/exam-platform.md)**.

* **Instructor-configurable rules per quiz** (presets: Practice / Monitored / Strict exam): allow or forbid tab
  switching, window/app switching, copy & paste, right-click; require full screen; watermark with name + entry
  number; exit & resume allowed or not (re-entry locks or submits); violation threshold with lock / auto-submit /
  warn-only.
* **Timing**: server-side overall timer, optional per-question timers (same for all or set per question) with
  one-way navigation, scheduled windows, late-entry cut-off, accommodations.
* **Access**: hall access code, exam-network IP allow-list, random N-of-M question draw, per-student question and
  option shuffling.
* **Random questions from banks**: bank questions carry a difficulty (easy/medium/hard) and tags; a quiz slot
  draws a different question of that difficulty for every student, worth the marks you set.
* **Users page (admins)**: promote accounts to instructor/admin, fix entry numbers, revoke sessions, back up.
* **Live monitor**: who is writing, online/offline, time left, progress, violations, IP changes; extend time for
  everyone or for specific students **by entry number** (even reopen a timed-out attempt), pause/resume the whole
  quiz, end it, announce or message students, lock/reinstate/submit/allow re-entry per student.
* **Flagged candidates**: every unauthorized-activity signal per candidate rolled into a Low/Medium/High level,
  plus flags raised by invigilators; resolved with a recorded note.
* **Several quizzes live at once**, in the same or different courses, each fully independent; a *Live now*
  overview for staff and an *Exam schedule* for students.
* **Integrity of the record**: one active window per attempt, append-only answer history, audit log, receipts,
  gradebook CSV with entry numbers, absentees, per-question marks and flag columns.
* **Written answers & assumptions**: descriptive questions marked by hand (scores stay hidden until marked);
  any question can let students state an assumption, which the marker sees.
* **After the exam, on demand**: a statistical **cheating check** (rare shared wrong answers, corrected for the
  number of pairs, plus near-identical written answers), **fairness check & normalization** of random questions
  with a comparison chart, **regrading** (accept another answer, change key, full marks, drop), **difficulty
  re-rating** suggestions for bank questions, **appeals**, and a per-attempt **timeline**.
* **During the exam**: students **raise a hand**; staff reply privately or pin a clarification to that question;
  **question health** warns about questions that look broken.
* **Accessibility profiles**: text size, contrast, spacing, readable font, reduced motion — set by the student
  (outside exams) or an admin, who can also grant account-wide extra time.
* **Scale**: 500 students — 0 errors, saves 2 ms p50 / 15 ms p99 — measured by the bundled load test
  ([results](docs/loadtest/results-500-students.json)); 1000 students across 10 simultaneous quizzes used about
  a quarter of one CPU core ([results](docs/loadtest/results-1000-students-10-quizzes.json)).

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
pnpm test             # API suite (node:test) — 78 tests
pnpm run test:e2e     # Playwright E2E in system Chromium/Edge (needs dev servers up; set CHROMIUM_PATH)
pnpm --filter @interval/api loadtest   # 500 simultaneous students against a production build
pnpm --filter @interval/api backup     # online database backup (safe during an exam)
```

### Demo accounts (seed data)

| Email | Password | Role |
|---|---|---|
| `admin@saide.local` | `admin123` | admin |
| `shlok@iitrpr.ac.in` | `instructor123` | instructor |
| `student1@iitrpr.ac.in` … `student8@iitrpr.ac.in` | `student123` | student (entry numbers `2023CSB0001`…`0008`) |

The HCI checkpoint quiz is a monitored exam with access code **`HCI-2026`**; CS305 also has a timed, one-way,
full-screen quiz so two exams can be demonstrated live at the same time.

**"Mid-sem — HCI Principles (graded demo)"** in AI511 is already finished by all 8 students, for the post-exam
tools: 6 written answers to mark, assumptions on Q5, a wrongly keyed Q2 to regrade, a random question with three
variants, and two students (Kabir Singh, Dev Joshi) who copied. Open it from the course page → Analytics.

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

### Lab 8 improvement set (instructor experience)

Lab 7 testing surfaced that the instructor-side surfaces lagged the student player in both
function and polish. Lab 8 closes that gap with a 13-item improvement set, all merged behind
the existing RBAC guards and covered by new HTTP tests:

| # | Improvement | Area |
|---|-------------|------|
| 1 | Dashboard quick-actions now navigate; equal-height cards | `DashboardPage` |
| 2 | Draft question editor shows a list, not cards | `QuizEditorPage` |
| 3 | Add-question panel height matches the settings card | `QuizEditorPage` |
| 4 | Default numeric tolerance is `0.01` | `QuizEditorPage`, `QuestionBankPage` |
| 5 | Accommodations/import modals rebuilt on shadcn `Dialog` | `AccommodationsModal` |
| 6 | Version history — restore any prior version into a new draft | `CoursePage`, `routes/quizzes.ts` |
| 7 | Published quizzes: answer key is re-keyable in place; structure stays frozen | `QuizEditorPage`, `routes/quizzes.ts` |
| 8 | Two quiz types — attempt-anytime and scheduled start/duration window | editor + `services/attempts.ts` |
| 9 | Duplicate a quiz into a fresh draft | `CoursePage`, `QuizEditorPage`, `routes/quizzes.ts` |
| 10 | Delete a quiz (guarded) + renovated instructor home | `CoursePage`, `DashboardPage` |
| 11 | "Create first bank" empty-state opens the New-Bank dialog | `QuestionBankPage` |
| 12 | Course creation + bulk email enrolment (reports unknown emails) | `DashboardPage`, `CoursePage`, `routes/courses.ts` |
| 13 | Professional, consistent course-card grid | `DashboardPage` |

Backend changes are exercised by `apps/api/src/__tests__/rbac.http.test.ts` (copy, delete, restore,
answer-rekey, scheduled-window enforcement, bulk enrol) — **26 API tests + 3 Chromium E2E, all green**.

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
