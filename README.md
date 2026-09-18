# CCI Staff Interviews

Web app replacing the printed assessment forms used during client-onboarding
staff interviews. Consultants load the roster before the visit, interview each
employee on an iPad, and the app cross-tabulates what different departments said
about the same things.

---

## Why it's built this way

The four paper forms deliberately ask the **same questions of different roles**.
All four ask how the Parts/Service relationship is working. Parts and Technicians
are both asked whether parts get delivered to the stall, and what causes delays.
Technicians and Support Staff both nominate the strongest Service Advisor.

On paper those answers sit in separate stacks and nobody cross-tabs them. That
comparison is the product, so the schema is built around it:

- **`question_catalog`** — one row per question *concept*, shared by every survey.
- **`form_templates`** — ordered assemblies of catalog keys, versioned.
- **`analysis.dimension`** on a catalog entry is the comparison axis. Every
  question carrying the same dimension pools into the same chart regardless of
  which survey it came from.

Seeded data produces exactly what that's for:

```
parts_service_relationship
   Parts               3.00  n=2
   Service Advisors    2.33  n=3
   Support Staff       2.00  n=2
   Technicians         1.25  n=4
   spread 1.75

parts_delivery       Parts -> "Yes"          Technicians -> "No"
parts_delay_cause    Parts -> "Communication" Technicians -> "Availability"
```

Add a Service Manager survey later that includes `rel_parts_service` and the
SM's rating drops into that chart automatically. No code change — there's a
test for it.

---

## Quick start (local)

```bash
cp .env.example .env          # set DATABASE_URL and SESSION_SECRET
npm install
npm run setup                 # migrate + seed catalog, templates, aliases
npm start                     # http://localhost:3000
```

Open the app and it will offer to create the first admin account — no CLI step.
(`npm run create-user` still exists as a fallback for a locked-out install.)

Useful:

```bash
npm run validate     # checks seeds without a DB; prints the cross-role dimension map
npm run smoke        # 44 end-to-end tests: roster, capture, analytics, templates
npm run smoke:users  # 27 tests: bootstrap, roles, last-admin guard, passwords
```

## Deploy to Render

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point at the repo. `render.yaml` provisions the
   web service and a Postgres instance and wires `DATABASE_URL` automatically.
3. Set `ANTHROPIC_API_KEY` in the service's environment (marked `sync: false`).
4. First deploy runs migrations via the start command. Open the URL and the app
   walks you through creating the first admin — no shell access needed. Seed the
   question catalog and templates by running `npm run seed` once from the Render
   shell (or add it to the start command for the first deploy).

### The API key

`ANTHROPIC_API_KEY` is only needed for the written narrative. Everything else —
roster, capture, the whole dashboard, CSV export — works without it, and an
analysis run without it saves the computed facts with `status: facts_only`.

It is a **separate product from a Claude.ai subscription**. A Pro or Max plan
does not include API credits; the key comes from the Anthropic Console
(console.anthropic.com → API keys) and is billed per token against credit you
buy there.

Set it on the Render service under Environment, not in the repo — `render.yaml`
marks it `sync: false` for exactly that reason.

Cost is small: one store analysis sends the computed facts plus up to 60 KB of
verbatims and asks for at most 8k tokens back, which at Claude Sonnet 5 rates
works out around **$0.07 per run**. Re-running an engagement's analysis a few
times is still cents.

---

## The field workflow

1. **Before the visit** — create the engagement and its stores, paste the roster
   into *Import roster*. Each dealer job title is mapped to a survey; you correct
   anything it got wrong and it remembers your correction for next time.
2. **Import management too.** They have no survey today and are stored with
   `template_key = null`, `interview_status = not_applicable`. They're on the
   roster so they can be named in answers, counted in the org picture, and picked
   up the day a management survey ships. They're excluded from coverage math.
3. **In the store** — open a person, work through the sections. Every answer
   saves to the iPad immediately and syncs when there's signal.
4. **Roster drift** — add people who aren't on the list (flagged `added_onsite`),
   and mark `no_show` / `declined` / `no_longer_employed`. Those statuses are
   data: three `no_longer_employed` on a two-week-old roster is a turnover signal.
5. **Management one-on-ones** — the lead consultant's conversation is captured as
   a freeform **leadership note** on that person, so it lives in the engagement
   record and feeds the analysis.
6. **Analysis** — cross-role gaps, divergent causes, and nomination tallies are
   computed live. *Run LLM analysis* adds a narrative over those numbers.

---

## Offline behaviour

Dealership wifi is unreliable and an interview is ~40 minutes of someone's
candour, so the **iPad owns the draft**:

- Every answer writes to IndexedDB on change, before any network call.
- Server syncs are debounced; failures go to a durable outbox and retry on
  reconnect, on tab focus, and every 30s.
- `client_ref` makes interview creation idempotent, and an open draft is reused —
  tapping *Start* twice cannot create two interviews.
- The service worker caches the app shell but **never** caches `/api`. Stale
  answers are worse than no answers; IndexedDB is the offline source of truth.
- No CDNs anywhere. CSP blocks external scripts, and a font that won't load on
  bad wifi isn't worth the risk.

Install to the home screen via Safari → Share → Add to Home Screen.

---

## Adding a survey later

Two levels, and the split is what keeps the analysis intact:

```jsonc
// 1. question_catalog — the shared concept
{ "key": "rel_parts_service", "type": "rating",
  "scale": { "min": 1, "max": 3, "labels": {"1":"Poor","2":"Average","3":"Excellent"} },
  "analysis": { "dimension": "parts_service_relationship", "compare_across_roles": true } }

// 2. form_templates — an ordered assembly referencing catalog keys
{ "template_key": "service_manager", "version": 1, "status": "published",
  "sections": [ { "title": "Relationships", "questions": [
      { "key": "rel_parts_service", "required": true },
      { "key": "sm_accountability_style", "prompt_override": "How do you handle accountability?" } ] } ] }
```

`POST /api/templates` (admin) publishes it. Guardrails:

- Published templates are immutable — edits create a new version, so historical
  interviews still render exactly the questions that were asked.
- Publishing **validates every referenced key exists**. This is the check that
  stops a new survey quietly falling out of the cross-role analysis.
- `POST /api/catalog` runs a `pg_trgm` similarity check and returns possible
  duplicates. Creating `parts_service_rel` next to `rel_parts_service` is how the
  whole thing silently breaks.
- `prompt_override` lets a survey keep its own wording while sharing the key.

## Question types

`short_text` · `long_text` · `number` · `yes_no` · `rating` · `single_select`
(+ `allow_other`) · `multi_select` · `employee_ref`

`employee_ref` is the important one: nominations are roster picks, not free text,
which is what makes the nomination graph possible. It has an escape hatch for
someone not on the roster, and `ref_filter` scopes the picker to a role.

Conditional questions use `show_if`, evaluated identically on the client and the
server: `{ "key": "dispatch_rating", "op": "lt", "value": 2 }`.

---

## Logins and roles

Managed in-app under **Team** (admins only). No CLI, no Render shell.

| Role | Can do |
|---|---|
| **Consultant** | Run interviews, see rosters and analysis |
| **Lead** | Consultant, plus reopening completed interviews and locking them |
| **Admin** | Everything, plus managing logins and publishing new surveys |

- **First run** — while the `users` table is empty, `/api/setup/status` reports
  `needs_setup` and the app shows a create-first-admin screen. `POST
  /api/setup/bootstrap` refuses once any user exists, so the door closes behind you.
- **Passwords** — minimum 10 characters, not all digits, no obvious strings. The
  add-person dialog generates a readable passphrase so an admin never has to
  invent one. Passwords are bcrypt hashed (cost 12) and are never emailed —
  hand them over directly.
- **Last-admin protection** — the only remaining active admin cannot demote or
  disable themselves. That would lock everyone out of user management with no way
  back in from a browser.
- **Disable, don't delete** — deactivating a login blocks sign-in while keeping
  that person attached to the interviews they ran. Interview attribution is part
  of the record.
- **Self-service** — anyone can change their own password under **Account**,
  which requires their current one.
- Every create, role change, enable/disable and password reset is written to
  `audit_log`.

## Confidentiality

Everything here is internal to CCI. Interviewer notes carry
`analysis.internal_only` and are excluded from aggregation. `export.csv`
includes attribution and notes and is **not** a client-facing artifact — there is
deliberately no redacted export yet. Build one before anything goes to a dealer.

## Analysis provenance

Every analysis run inserts a new `analyses` row with `model`, `prompt_version`,
`computed_facts`, and `input_interview_ids`. Nothing is overwritten — a finding
quoted to a client in March stays reproducible in June.

The LLM never does arithmetic. It receives already-computed facts plus verbatims
and is asked to interpret, with interview ids required on every claim.

---

## Layout

```
db/migrations/001_init.sql        schema
db/seeds/question_catalog.json    68 questions + data-quality flags from the forms
db/seeds/templates/*.json         the four surveys
src/lib/analytics.js              deterministic cross-role computation
src/lib/llm.js                    narrative pass
src/lib/positionMap.js            dealer job title -> survey
src/routes/                       users, core, interviews, analysis
public/                           the PWA (vanilla, no build step)
scripts/                          migrate, seed, create-user, validate, smoke, smoke-users
```

## Known gaps

- No client-facing redacted export yet (see Confidentiality).
- Template authoring is API-only; there's no admin UI for building a survey.
- No password reset by email — an admin sets a new one and hands it over.
- Re-interviewing the same store later works (interviews are timestamped) but
  nothing compares engagement N against N−1 yet.
- `interviewer_notes` is one field per interview rather than per section.

## Data-quality notes from the source forms

`db/seeds/question_catalog.json` → `_data_quality_flags` records what was found
while digitising, including a duplicated question on the Technician form and a
Parts question whose answer options don't match what it asks. Worth reviewing
before the first live engagement. The Service Advisor and Parts forms are also
not marked APPROVED, unlike the other two.
