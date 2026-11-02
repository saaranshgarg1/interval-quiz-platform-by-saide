# Interval ◇

A quiz portal for the sAIDE website (IIT Ropar), built as an AI511 Human–Computer Interaction course project.
This README only covers how to run it; everything else is in the documents below.

| | |
|---|---|
| **Presentation deck** | [View on Canva](https://canva.link/hwulqjx5rtmwwvl) · [PDF copy](documents/Presentation-Deck.pdf) (same deck) |
| **Video walkthrough** | [Watch on YouTube](https://www.youtube.com/watch?v=w3dlr-XtMQ8) |
| **How to use it** | [Professor guide](documents/Guide-Professor.pdf) · [Student guide](documents/Guide-Student.pdf) |
| **How it works** | [Route flowcharts](documents/Route-Flowcharts.pdf) · [Access control (RBAC)](documents/RBAC.pdf) |
| **Background** | [Literature proposal](documents/Literature-Proposal.pdf) · [Design system](DESIGN.md) |

---

## Run it locally

Tested from a fresh clone on Windows 11 with Node 24.19.0 and pnpm 12.3.4. Takes about 5 minutes; internet is
needed only for steps 1–3. The same commands work on macOS and Linux.

**1. Install the tools (once):** [Node.js 24](https://nodejs.org) (required: the API uses Node’s built-in SQLite),
[Git](https://git-scm.com), then pnpm:

```bash
npm install -g pnpm@12.3.4      # macOS/Linux: prefix with sudo if you get "permission denied"
node -v                         # → v24.x.x
pnpm -v                         # → 12.3.4
```

**2. Get the code:**

```bash
git clone https://github.com/shlok165/interval-quiz-platform-by-saide.git interval
cd interval
```

> **Windows:** run `cd C:\` first so the project lands in the short path `C:\interval`. Deeply nested folders
> exceed Windows’ path-length limit and make step 4 fail with *“The system cannot find the path specified”*.

**3. Install dependencies:**

```bash
pnpm install                    # ends with: Done in …s using pnpm v12.3.4
```

**4. Create the demo database** (no `.env` or other configuration is needed locally):

```bash
pnpm run seed
```

It should end with:

```text
[seed] done. Demo accounts:
  admin:       admin@saide.local / admin123
  instructor:  shlok@iitrpr.ac.in / instructor123
  students:    student1..student8@iitrpr.ac.in / student123
  access code for "HCI Basics — Checkpoint Quiz 1": HCI-2026
```

**5. Start the app** in two terminals, both inside the `interval` folder:

```bash
# Terminal 1 — API; wait for: [interval-api] listening on http://localhost:4000
pnpm run dev:api

# Terminal 2 — web app; wait for: Local: http://localhost:5173/
pnpm run dev:web
```

Open **http://localhost:5173** in Chrome or Edge and keep both terminals running.

**6. Sign in** with an account printed in step 4: a student (`student1@iitrpr.ac.in` / `student123`), the instructor
(`shlok@iitrpr.ac.in` / `instructor123`) or the admin (`admin@saide.local` / `admin123`).
Use a private/incognito window to be signed in as a second role at the same time; the login is shared by all tabs of
one browser. *“Google sign-in not configured”* is expected locally.

The demo data includes courses AI511 and CS305, an open checkpoint quiz (access code `HCI-2026`) and a finished
exam, *Mid-sem — HCI Principles (graded demo)*, ready for marking, regrading and the cheating check. What to do in
each role is in the [Professor guide](documents/Guide-Professor.pdf) and [Student guide](documents/Guide-Student.pdf).

**7. Run the tests** (optional):

```bash
pnpm test                       # expected: tests 130 · pass 130 · fail 0  (≈5 s)
```

The suite uses its own temporary database and never touches the demo data.

**Stop / reset:** `Ctrl + C` in both terminals. For fresh demo data, stop the API, delete `apps/api/data`, and run
`pnpm run seed` again.

### Troubleshooting

| You see | Fix |
|---|---|
| `pnpm: command not found` | Redo step 1, then open a new terminal. |
| `No such built-in module: node:sqlite` or an engine warning | Node is older than 24 — install Node 24. |
| `EADDRINUSE` on port 4000 or 5173 | Another program (or an earlier run) holds the port — close it and retry. |
| Page loads but sign-in fails with a server/network error | The API (terminal 1) isn’t running. |
| “Invalid email or password” for a demo account | The database wasn’t seeded — run step 4. |
| Windows: “The system cannot find the path specified” | Path too long — clone into `C:\interval`. |

### Other commands

```bash
pnpm run build        # production build: API (tsc) + web (vite) -> apps/web/dist
pnpm run typecheck    # type-check both workspaces
pnpm --filter @interval/api loadtest   # simulate 500 students against a production build
```

---

## License

© 2026 Saaransh Garg and Shlok Vaidya. Licensed under
[Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/): you may
share and adapt this work for any purpose, including commercially, as long as you give appropriate credit, link to
the license and indicate if changes were made. Full text in [LICENSE](LICENSE).
