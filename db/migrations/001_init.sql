-- CCI Staff Interview Platform — initial schema
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------- users

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  password_hash text not null,
  role          text not null default 'consultant' check (role in ('consultant','lead','admin')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- express-session store
create table if not exists session (
  sid    varchar primary key,
  sess   json not null,
  expire timestamp(6) not null
);
create index if not exists idx_session_expire on session (expire);

-- ------------------------------------------------------- engagement tree

create table if not exists engagements (
  id           uuid primary key default gen_random_uuid(),
  client_name  text not null,
  dealer_group text,
  status       text not null default 'planning'
               check (status in ('planning','fieldwork','analysis','complete','archived')),
  started_on   date,
  notes        text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists stores (
  id            uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  name          text not null,
  franchise     text,
  city          text,
  state         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_stores_engagement on stores(engagement_id);

-- Roster. Loaded before the visit; drifts during it.
create table if not exists employees (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  first_name      text not null,
  last_name       text not null,
  -- position_title is the dealer's own words, preserved verbatim.
  position_title  text,
  -- template_key is what form they get. null = no form exists for them yet
  -- (management today), which is deliberate, not an error.
  template_key    text,
  department      text check (department in
                    ('service','parts','support','management','sales','other')),
  roster_status   text not null default 'on_roster'
                  check (roster_status in ('on_roster','added_onsite','off_roster_reference')),
  interview_status text not null default 'pending'
                  check (interview_status in ('pending','in_progress','complete',
                                              'no_show','declined','no_longer_employed',
                                              'not_applicable')),
  assigned_to     uuid references users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_employees_store on employees(store_id);
create index if not exists idx_employees_template on employees(template_key);

-- ------------------------------------------------- questions & templates

-- Canonical question catalog. One row per question CONCEPT, shared across
-- every survey. This is what makes cross-role comparison possible: four
-- different forms asking about the Parts/Service relationship all point at
-- the same key, so their answers pool automatically.
create table if not exists question_catalog (
  key          text primary key,
  prompt       text not null,
  type         text not null check (type in
                 ('short_text','long_text','single_select','multi_select',
                  'rating','number','yes_no','employee_ref','section_note')),
  options      jsonb,          -- [{value,label}] for selects
  allow_other  boolean not null default false,
  scale        jsonb,          -- {min,max,labels:{"1":"Poor",...}} for rating
  ref_filter   jsonb,          -- {department:'service', template_key:'service_advisor'}
  nomination   jsonb,          -- {target:'advisor', direction:'strongest'}
  analysis     jsonb,          -- {dimension, compare_across_roles, polarity, verbatim}
  help_text    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Templates are ordered assemblies of catalog keys. Immutable once published;
-- an edit publishes a new version so historical interviews still render
-- exactly the questions that were actually asked.
create table if not exists form_templates (
  id           uuid primary key default gen_random_uuid(),
  template_key text not null,
  version      int  not null,
  title        text not null,
  description  text,
  status       text not null default 'draft' check (status in ('draft','published','retired')),
  applies_to   jsonb,         -- {positions:[...], department:'service'}
  sections     jsonb not null,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (template_key, version)
);
create index if not exists idx_templates_key_status on form_templates(template_key, status);

-- Dealer job titles -> template mapping. Learns aliases over time.
create table if not exists position_aliases (
  id           uuid primary key default gen_random_uuid(),
  alias        text not null unique,   -- stored lowercased/trimmed
  template_key text,                   -- null = no form (e.g. management)
  department   text,
  hits         int not null default 0,
  created_at   timestamptz not null default now()
);

-- -------------------------------------------------------------- capture

create table if not exists interviews (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references employees(id) on delete cascade,
  store_id         uuid not null references stores(id) on delete cascade,
  engagement_id    uuid not null references engagements(id) on delete cascade,
  interviewer_id   uuid references users(id),
  template_id      uuid references form_templates(id),
  template_key     text not null,
  template_version int  not null,
  status           text not null default 'draft' check (status in ('draft','complete','locked')),
  -- client_ref is the iPad's own id for this interview. Unique, so an
  -- offline device that syncs the same draft twice cannot create duplicates.
  client_ref       text unique,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  locked_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_interviews_store on interviews(store_id);
create index if not exists idx_interviews_employee on interviews(employee_id);
create index if not exists idx_interviews_status on interviews(status);

create table if not exists answers (
  interview_id uuid not null references interviews(id) on delete cascade,
  question_key text not null,
  value        jsonb,
  other_text   text,
  updated_at   timestamptz not null default now(),
  primary key (interview_id, question_key)
);

-- Derived from employee_ref answers on save. Kept as its own table so the
-- nomination graph is queryable without digging through jsonb.
create table if not exists nominations (
  id                    uuid primary key default gen_random_uuid(),
  interview_id          uuid not null references interviews(id) on delete cascade,
  engagement_id         uuid not null references engagements(id) on delete cascade,
  store_id              uuid not null references stores(id) on delete cascade,
  question_key          text not null,
  nominator_employee_id uuid references employees(id) on delete set null,
  nominator_template_key text,
  nominee_employee_id   uuid references employees(id) on delete set null,
  nominee_freetext      text,            -- off-roster escape hatch
  target_role           text,
  direction             text check (direction in ('strongest','needs_support')),
  reason                text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_nominations_store on nominations(store_id);
create index if not exists idx_nominations_nominee on nominations(nominee_employee_id);

-- The lead consultant's one-on-one with management. Unstructured on purpose:
-- that conversation isn't a survey, but it shouldn't evaporate either.
create table if not exists leadership_notes (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references employees(id) on delete cascade,
  store_id      uuid not null references stores(id) on delete cascade,
  engagement_id uuid not null references engagements(id) on delete cascade,
  author_id     uuid references users(id),
  occurred_on   date not null default current_date,
  body          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_leadnotes_store on leadership_notes(store_id);

-- -------------------------------------------------------------- analysis

-- Every run is a new row. Never overwrite: a finding quoted to a client in
-- March must still be reproducible in June.
create table if not exists analyses (
  id                  uuid primary key default gen_random_uuid(),
  scope               text not null check (scope in ('store','engagement')),
  store_id            uuid references stores(id) on delete cascade,
  engagement_id       uuid not null references engagements(id) on delete cascade,
  model               text,
  prompt_version      text,
  computed_facts      jsonb,
  narrative           jsonb,
  input_interview_ids uuid[],
  status              text not null default 'complete'
                      check (status in ('complete','facts_only','error')),
  error               text,
  generated_by        uuid references users(id),
  generated_at        timestamptz not null default now()
);
create index if not exists idx_analyses_store on analyses(store_id, generated_at desc);

create table if not exists audit_log (
  id         bigserial primary key,
  user_id    uuid references users(id),
  action     text not null,
  entity     text,
  entity_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_log(created_at desc);
