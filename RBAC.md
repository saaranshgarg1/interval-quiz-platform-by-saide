# RBAC — Role-Based Access Control Specification

**Status:** design contract for v0.0.2. Defines every HTTP endpoint, the principals allowed to reach it, and the enforcement mechanism. Deny-by-default: an endpoint that is not explicitly granted to a principal MUST reject with `403`.

This document is the authority for authorization. Any code that diverges from this matrix is a bug.

---

## 1. Principals

There are two independent role dimensions. **Both** are consulted on course-scoped endpoints.

### 1.1 Global account role (JWT `role` claim)

Stored on `users.role`, embedded in the signed token (`{uid, role, v}`). Values:

| Role         | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `student`    | Default for every self-registered / SSO account. No elevated rights.    |
| `instructor` | May **create** courses. Is *not* automatically staff of any course.     |
| `admin`      | Platform superuser. Global bypass on every course-scoped check.         |

There is intentionally **no global `ta` role**. "TA" exists only as a course membership.

### 1.2 Course membership role (`memberships.role`)

Resolved per request via `courseRepo.courseRole(courseId, userId)`. Values:

| Role         | Meaning                                                                          |
|--------------|----------------------------------------------------------------------------------|
| `student`    | Enrolled learner. Takes quizzes, views own results.                              |
| `ta`         | Course assistant. Authors/drafts content, grades, monitors, investigates.        |
| `instructor` | Course owner. All TA rights **plus** every irreversible / release / delete control. |

`admin` (global) is treated as an implicit `instructor` on **all** courses.

### 1.3 The instructor-vs-TA line (core requirement)

> Crucial course controls belong to the **instructor**. Content and review work is delegated to the **TA**.

| TA **may** (delegated work)                             | Instructor **only** (crucial controls)                          |
|---------------------------------------------------------|-----------------------------------------------------------------|
| Create/edit quiz drafts, questions, reorder             | **Publish** a quiz version                                      |
| Create question banks, add/import bank questions        | **Release** results / toggle answer key / export grades         |
| View incidents, audit trails, analytics                 | **Delete** courses, banks, published content; **destructive** ops |
| Investigate attempts (read)                             | **Roster** management (add/remove/promote members)              |
| View accommodations                                     | **Set/delete** accommodations (exam-fairness control)           |
|                                                         | **Authoritative attempt rulings** (lock / reinstate / allow-submit) |

---

## 2. Enforcement model

**Deny by default.** Never infer authorization from the request body. Always resolve the protected resource → its owning course → the caller's course role.

### 2.1 Middleware to introduce (replaces `staffOnly` / `staffRole` / `requireStaff`)

```ts
// apps/api/src/auth.ts (or a new authz.ts)

/** Resolve courseId from a route param and gate on course role. Admin bypasses. */
export function requireCourseRole(
  param: string,
  ...allowed: CourseRole[]
) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const courseId = Number(req.params[param]);
    if (!Number.isInteger(courseId)) throw new AppError(400, 'Invalid course id.');
    if (req.userRole === 'admin') { req.courseRole = 'instructor'; return next(); }
    const role = courseRepo.courseRole(courseId, req.userId as number);
    if (!role || !allowed.includes(role)) {
      throw new AppError(403, 'You do not have permission for this action.');
    }
    req.courseRole = role;
    next();
  };
}

// Convenience gates:
export const courseMember     = (p: string) => requireCourseRole(p, 'student', 'ta', 'instructor');
export const courseStaff      = (p: string) => requireCourseRole(p, 'ta', 'instructor');
export const courseInstructor = (p: string) => requireCourseRole(p, 'instructor');
```

### 2.2 Nested resources (attempt / quiz / version / bank)

When the URL carries an attempt/quiz/version/bank id rather than a courseId, the handler MUST look the resource up, derive `course_id`, then apply the same role rule. Provide helpers so no handler hand-rolls it:

- `attemptId → attempts.quiz_version_id → quiz_versions.course_id`
- `quizId → quizzes.course_id`
- `quizVersionId → quiz_versions.course_id`
- `bankId → question_banks.course_id`
- `questionId → questions.quiz_version_id → quiz_versions.course_id`

Ownership-scoped endpoints (a student acting on their own attempt) check `attempt.user_id === req.userId` **instead of** a course role.

### 2.3 Invariants

1. Every `/api/*` route except the public auth endpoints runs `requireAuth` first.
2. No endpoint reads `courseId`/`role`/`user_id` from the request body for an authz decision.
3. `admin` bypass is explicit and the only global override.
4. Instructor-only actions never fall through to a TA, even a course-instructor's TA.
5. A member cannot change or delete their own membership/role.

---

## 3. Endpoint permission matrix

Legend — ✅ allowed · ❌ denied · **own** = only on caller's own resource · admin = ✅ everywhere unless noted.

### 3.1 `/api/auth` (public except `/me`)

| Method | Path        | Student | TA | Instructor | Admin | Notes |
|--------|-------------|:-------:|:--:|:----------:|:-----:|-------|
| POST   | `/register` | public  | —  | —          | —     | **Always creates `student`.** Client-supplied `role` MUST be ignored (current bug: self-selects instructor). |
| POST   | `/login`    | public  | —  | —          | —     | |
| GET    | `/me`       | ✅      | ✅ | ✅         | ✅    | any authenticated caller |
| POST   | `/sso`      | public  | —  | —          | —     | **Redesign required.** MUST verify a Google `id_token` server-side and enforce `hd === 'iitrpr.ac.in'`. Current handler trusts client `email`/`role` → full auth bypass. New accounts are `student`. |

### 3.2 `/api/courses` (all `requireAuth`)

| Method | Path                          | Student | TA | Instructor | Admin | Gate |
|--------|-------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/`                           | ✅ own list | ✅ | ✅       | ✅ all | authed; scoped to membership |
| POST   | `/`                           | ❌      | ❌ | ✅ (global) | ✅   | **Global** `instructor`/`admin` only. Creator seeded as course `instructor`. (Currently any authed user can create → tighten.) |
| GET    | `/:courseId`                  | ✅ member | ✅ | ✅       | ✅    | `courseMember` |
| GET    | `/:courseId/roster`           | ❌      | ✅ | ✅         | ✅    | `courseStaff` — roster exposes member PII, restrict from students (currently any member). |
| PUT    | `/:courseId/members`          | ❌      | ❌ | ✅         | ✅    | `courseInstructor` — add/promote members. **Was staff** → TA could promote peers to instructor or plant accounts. |
| DELETE | `/:courseId/members/:userId`  | ❌      | ❌ | ✅         | ✅    | `courseInstructor` — cannot remove self; removing the last instructor MUST be blocked. |
| DELETE | `/:courseId` *(to add)*       | ❌      | ❌ | ✅         | ✅    | `courseInstructor`. No delete-course endpoint exists yet; when added it is instructor-only + confirmation. |

### 3.3 `/api/quizzes` (all `requireAuth`)

| Method | Path                              | Student | TA | Instructor | Admin | Gate |
|--------|-----------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/course/:courseId`               | ❌      | ✅ | ✅         | ✅    | `courseStaff` (drafts visible to staff only; students reach quizzes via attempts) |
| POST   | `/course/:courseId`               | ❌      | ✅ | ✅         | ✅    | `courseStaff` — create draft (TA drafting) |
| GET    | `/:quizId`                        | ❌      | ✅ | ✅         | ✅    | `courseStaff` (resolve course via quiz) |
| PUT    | `/:quizId`                        | ❌      | ✅ | ✅         | ✅    | `courseStaff` — edit latest draft only |
| POST   | `/:quizId/versions`               | ❌      | ✅ | ✅         | ✅    | `courseStaff` — clone published → new draft |
| POST   | `/:quizId/questions`              | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| PUT    | `/questions/:questionId`          | ❌      | ✅ | ✅         | ✅    | `courseStaff` — frozen once published |
| DELETE | `/questions/:questionId`          | ❌      | ✅ | ✅         | ✅    | `courseStaff` — **draft-scoped only.** Published questions are frozen, so this deletes only draft content = routine TA drafting. (Not the "delete anything" instructors guard; that means courses/versions/banks.) |
| POST   | `/:quizId/questions/reorder`      | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| GET    | `/:quizId/preview`                | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| PATCH  | `/:quizId/publish`                | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — publishing is a crucial control. **Was staff.** |
| PATCH  | `/:quizId/archive` *(to add)*     | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/:quizId/schedule` *(to add)*    | ❌      | ❌ | ✅         | ✅    | `courseInstructor` — set `open_at`/`close_at` (v0.0.2 scheduling) |

### 3.4 `/api/attempts` (all `requireAuth`)

| Method | Path                              | Student | TA | Instructor | Admin | Gate |
|--------|-----------------------------------|:-------:|:--:|:----------:|:-----:|------|
| POST   | `/quiz/:quizVersionId`            | ✅ enrolled | ❌ | ❌     | ❌    | enrolled **student** member; version must be published and within open window. Staff do not take attempts (they have preview). |
| GET    | `/quiz/:quizVersionId/mine`       | ✅ own  | —  | —          | —     | ownership |
| GET    | `/:attemptId`                     | ✅ own  | ❌ | ❌         | ❌    | ownership only (staff use `/api/review`) |
| PUT    | `/:attemptId/answers`             | ✅ own  | ❌ | ❌         | ❌    | ownership; server-side deadline enforced |
| POST   | `/:attemptId/submit`              | ✅ own  | ❌ | ❌         | ❌    | ownership |
| POST   | `/:attemptId/events`              | ✅ own  | ❌ | ❌         | ❌    | ownership; returns `423` when locked |
| GET    | `/course/:courseId/incidents`     | ❌      | ✅ | ✅         | ✅    | `courseStaff` — monitoring; TA allowed |

### 3.5 `/api/results` (all `requireAuth`)

| Method | Path                                  | Student | TA | Instructor | Admin | Gate |
|--------|---------------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/mine`                               | ✅ own  | ✅ own | ✅ own | ✅ own | ownership |
| GET    | `/attempt/:attemptId`                 | ✅ own (if released / immediate) | ✅ | ✅ | ✅ | owner **or** `courseStaff` — TA may inspect for checking |
| POST   | `/quiz/:quizVersionId/release`        | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — releasing results is a crucial control. **Was staff.** |
| PUT    | `/attempt/:attemptId`                 | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — release / answer-key toggle. **Was staff.** |
| GET    | `/quiz/:quizVersionId/export.csv`     | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — bulk grade+PII export. **Was staff.** |

### 3.6 `/api/review` (all `requireAuth`)

| Method | Path                             | Student | TA | Instructor | Admin | Gate |
|--------|----------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/attempt/:attemptId`            | ❌      | ✅ | ✅         | ✅    | `courseStaff` — full audit trail; TA investigates |
| GET    | `/attempt/:attemptId/current`    | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| POST   | `/attempt/:attemptId`            | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — `lock`/`reinstate`/`allow_submit` are authoritative integrity rulings. TA investigates (read) but does not rule. *Delegable to TA per-course if the instructor later wants it — flag.* |

### 3.7 `/api/banks` (all `requireAuth`)

| Method | Path                                  | Student | TA | Instructor | Admin | Gate |
|--------|---------------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/course/:courseId`                   | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| POST   | `/course/:courseId`                   | ❌      | ✅ | ✅         | ✅    | `courseStaff` — author bank |
| GET    | `/:bankId`                            | ❌      | ✅ | ✅         | ✅    | `courseStaff` (resolve via bank) |
| POST   | `/:bankId/questions`                  | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| POST   | `/:bankId/import`                     | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| DELETE | `/:bankId/questions/:questionId`      | ❌      | ✅ | ✅         | ✅    | `courseStaff` — removing one authored item; TA content work |
| DELETE | `/:bankId`                            | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — deleting a whole bank is destructive. **Was staff.** |

### 3.8 `/api/accommodations` (all `requireAuth`)

| Method | Path                                  | Student | TA | Instructor | Admin | Gate |
|--------|---------------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/course/:courseId/my`                | ✅ own  | ✅ | ✅         | ✅    | self-disclosure of own timer |
| GET    | `/course/:courseId`                   | ❌      | ✅ | ✅         | ✅    | `courseStaff` — list |
| POST   | `/course/:courseId`                   | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`** — accommodations alter exam fairness. **Was staff.** |
| DELETE | `/course/:courseId/user/:userId`      | ❌      | ❌ | ✅         | ✅    | **`courseInstructor`.** **Was staff.** |

### 3.9 `/api/analytics` (all `requireAuth`)

| Method | Path                    | Student | TA | Instructor | Admin | Gate |
|--------|-------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/version/:versionId`   | ❌      | ✅ | ✅         | ✅    | `courseStaff` |

### 3.10 `/api/admin` *(to add)*

No platform-role management endpoints exist today. Add, all `requireRoles('admin')`:

| Method | Path                        | Purpose |
|--------|-----------------------------|---------|
| GET    | `/users`                    | list accounts |
| PATCH  | `/users/:id/role`           | set global role (`student`/`instructor`/`admin`) — the only way to mint an instructor/admin |
| GET    | `/audit`                    | read the audit log (§5) |

### 3.10a `/api/proctor` — live exam control (all `requireAuth`)

TAs invigilate (watch, message, flag); everything that changes a student's time or outcome is an
instructor-only exam-fairness control, consistent with accommodations and rulings above.

| Method | Path                                   | Student | TA | Instructor | Admin | Gate |
|--------|----------------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/live`                                | (empty) | ✅ | ✅         | ✅ all | courses where caller is staff |
| GET    | `/quiz/:quizId`                        | ❌      | ✅ | ✅         | ✅    | `courseStaff` — monitor snapshot |
| GET    | `/quiz/:quizId/events`                 | ❌      | ✅ | ✅         | ✅    | `courseStaff` — activity feed |
| GET    | `/quiz/:quizId/flags`                  | ❌      | ✅ | ✅         | ✅    | `courseStaff` — flagged candidates |
| POST   | `/quiz/:quizId/resolve`                | ❌      | ✅ | ✅         | ✅    | `courseStaff` — preview entry numbers |
| POST   | `/quiz/:quizId/announce`               | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| POST   | `/attempt/:attemptId/flags`            | ❌      | ✅ | ✅         | ✅    | `courseStaff` — invigilator flag |
| POST   | `/flags/:flagId/resolve`               | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/quiz/:quizId/extend`                 | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/quiz/:quizId/pause` · `/resume`      | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/quiz/:quizId/close` · `/reopen`      | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/attempt/:attemptId/action`           | ❌      | ❌ | ✅         | ✅    | `courseInstructor` — lock, reinstate, force_submit, allow_reentry, reset_session, reset_violations |

Student attempt endpoints (`/api/attempts/:id/*`) additionally require the per-attempt
`X-Attempt-Session` token: ownership alone is not enough, only the one window holding the attempt may act on it.
This includes `POST /api/attempts/:id/hand` (raise hand).

### 3.10b `/api/insights` — marking, regrading, fairness, appeals (all `requireAuth`)

Course staff read reports, mark written answers and answer raised hands; decisions that change grading for
everyone, or a student's standing, are instructor-only.

| Method | Path                                            | Student | TA | Instructor | Admin | Gate |
|--------|-------------------------------------------------|:-------:|:--:|:----------:|:-----:|------|
| GET    | `/version/:id/grading` · `/questions` · `/fairness` · `/appeals` | ❌ | ✅ | ✅ | ✅ | `courseStaff` |
| PUT    | `/attempt/:attemptId/question/:questionId/marks`| ❌      | ✅ | ✅         | ✅    | `courseStaff` — hand marking |
| POST   | `/questions/:questionId/regrade`                | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/slots/:slotId/normalize`                      | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| POST   | `/version/:id/collusion`                        | ❌      | ❌ | ✅         | ✅    | `courseInstructor` — audit-logged |
| POST   | `/appeals/:appealId/resolve`                    | ❌      | ❌ | ✅         | ✅    | `courseInstructor` |
| GET    | `/attempt/:attemptId/appeals`                   | own     | ✅ | ✅         | ✅    | owner or `courseStaff` |
| POST   | `/attempt/:attemptId/appeals`                   | own     | ❌ | ❌         | ❌    | owner only; mark appeals need a visible result |
| GET    | `/quiz/:quizId/question-health` · `/hands`      | ❌      | ✅ | ✅         | ✅    | `courseStaff` |
| POST   | `/hands/:handId/answer`                         | ❌      | ✅ | ✅         | ✅    | `courseStaff` |

`PATCH /api/banks/:bankId/questions/:questionId` (re-rate difficulty) is `courseStaff`.
`GET/PUT /api/auth/accessibility` is the caller's own profile (PUT refused while an attempt is in progress);
`PUT /api/admin/users/:id/accessibility` (prefs + extra-time multiplier) is admin-only.

### 3.11 `/api/health`

Public, unauthenticated, no data. Leave open.

---

## 4. Required code changes (delta from current code)

Each item is a discrete build task for the v0.0.2 swarm.

**Privilege-escalation fixes (P0 — do first):**
1. `routes/auth.ts` `/register` — drop `role` from input; always create `student`.
2. `routes/auth.ts` `/sso` — replace with Google `id_token` verification (`google-auth-library`), enforce `hd === 'iitrpr.ac.in'`, ignore client-supplied `role`/`email`. New accounts `student`.
3. `routes/courses.ts` — roster mgmt (`PUT`/`DELETE /:courseId/members`) from `staffOnly` → `courseInstructor`. Block removing the last instructor and self-removal.
4. `routes/courses.ts` `POST /` — restrict course creation to global `instructor`/`admin`.

**Instructor-only reclassification (was collapsed into staff):**
5. `routes/quizzes.ts` `PATCH /:quizId/publish` → `courseInstructor`.
6. `routes/results.ts` `POST /release`, `PUT /attempt/:id`, `export.csv` → `courseInstructor`.
7. `routes/banks.ts` `DELETE /:bankId` → `courseInstructor`.
8. `routes/accommodations.ts` `POST` + `DELETE` → `courseInstructor`.
9. `routes/review.ts` `POST /attempt/:id` (rulings) → `courseInstructor`.

**Middleware:**
10. Add `requireCourseRole` + `courseMember`/`courseStaff`/`courseInstructor` (§2.1). Delete the three divergent local `staffOnly`/`staffRole`/`requireStaff` copies; route every handler through the shared gate. Add `courseRole?: CourseRole` to `AuthedRequest`.
11. `routes/courses.ts` `/:courseId/roster` → `courseStaff` (was any member).

**Correctness bug that corrupts authorization (P0):**
12. `routes/attempts.ts` — the service calls pass arguments in the wrong order: `saveAnswers(attempt.id, req.userId, …)`, `submitAttempt(attempt.id, req.userId)`, `reportClientEvent(attempt.id, req.userId, …)`, but the signatures are `(userId, attemptId, …)`. This scrambles the ownership check inside the service. Swap to `(req.userId, attempt.id, …)`.

**Hardening (not strictly RBAC but gates the same surface):**
13. Replace wide-open `cors()` with an origin allow-list.
14. Add `helmet` and rate limiting (login + register + sso especially).
15. Refuse to boot if `INTERVAL_JWT_SECRET` / `INTERVAL_PASSWORD_PEPPER` are the dev defaults in production.

---

## 5. Audit log

Every instructor-only mutation (publish, release, delete, roster change, accommodation change, attempt ruling, global-role change) writes an append-only audit row: `{actor_id, actor_global_role, course_id, action, target, before, after, at}`. Admin bypasses are logged with `actor_global_role = 'admin'` so cross-course access is always traceable.

---

## 6. Open decisions (need user input)

1. **Course creation** — global `instructor`/`admin` only (spec above), or any authenticated user self-serves? Spec assumes the former.
2. **`DELETE /questions/:questionId` and `DELETE /:bankId/questions/:questionId`** — kept as `courseStaff` (draft/content work). Confirm TAs should be able to delete draft questions, or lock all deletion to instructor.
3. **Attempt rulings (`review POST`)** — spec sets instructor-only. Confirm, or allow TAs to lock/reinstate.
4. **Accommodations** — spec sets instructor-only. Confirm, or let TAs manage them.


