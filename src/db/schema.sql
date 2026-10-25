-- Sales Rescue schema. Money is integer kobo. Every id is human-readable (prefix + sequence)
-- so it can be quoted in WhatsApp messages and tool results.

create sequence if not exists ref_seq start 1001;

create table if not exists merchant (
  id                     int primary key default 1 check (id = 1),
  name                   text not null,
  owner_name             text not null,
  owner_phone            text not null,
  owner_pin_hash         text not null,
  owner_chord_thread_id  text,
  owner_sender_id        text,
  timezone               text not null default 'Africa/Lagos',
  hold_minutes           int  not null default 30,   -- customer-initiated holds
  offer_hold_minutes     int  not null default 60,   -- holds created when restocked stock is offered
  demand_threshold       int  not null default 3,
  large_qty_change       int  not null default 20,
  large_price_change_pct int  not null default 30,
  pin_failures           int  not null default 0,
  pin_locked_until       timestamptz
);

-- Made-to-order items share baking capacity per day (e.g. 3 cakes/day). A date is "sold out" when
-- its slots are booked; overrides let the owner open, reduce or close a specific date.
create table if not exists capacity_groups (
  code         text primary key,
  name         text not null,
  daily_slots  int  not null check (daily_slots >= 0)
);
create table if not exists capacity_overrides (
  group_code  text not null references capacity_groups(code),
  day         date not null,
  slots       int  not null check (slots >= 0),
  updated_at  timestamptz not null default now(),
  primary key (group_code, day)
);

create table if not exists products (
  sku          text primary key,
  name         text not null,
  category     text not null,
  colour       text not null,
  style        text not null,
  description  text not null default '',
  price_kobo   bigint not null check (price_kobo > 0),
  qty_on_hand  int not null check (qty_on_hand >= 0),
  image_url    text,  -- merchant's own photo; when null a generated card is served (/products/<sku>.svg)
  fulfilment      text not null default 'stock' check (fulfilment in ('stock', 'made_to_order')),
  capacity_group  text references capacity_groups(code),   -- made_to_order: which daily slots it uses
  lead_time_days  int  not null default 0 check (lead_time_days >= 0),
  status       text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISCONTINUED')),
  updated_at   timestamptz not null default now()
);

create table if not exists customers (
  ref              text primary key,          -- the channel sender id as the agent sees it
  display_name     text,
  email            text,
  notify_consent   boolean not null default false,
  opted_out_at     timestamptz,
  chord_thread_id  text,
  created_at       timestamptz not null default now()
);

-- The core object: a customer's intent to buy something we couldn't sell them on the spot.
create table if not exists opportunities (
  id                  text primary key,
  customer_ref        text not null references customers(ref),
  sku                 text not null references products(sku),
  qty                 int  not null check (qty > 0),
  status              text not null check (status in (
                        'WAITING_RESTOCK', 'OFFERED', 'CHECKOUT', 'WON',
                        'DECLINED', 'CANCELLED', 'EXPIRED', 'NOT_RESTOCKING')),
  consent             boolean not null default false,
  alternative_sku     text references products(sku),   -- set when the customer chose a substitute
  for_date            date,                             -- made_to_order: the (full) date they want
  next_action         text,
  next_action_owner   text check (next_action_owner in ('customer', 'owner', 'system')),
  next_action_due_at  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz
);

create table if not exists reservations (
  id               text primary key,
  sku              text not null references products(sku),
  customer_ref     text not null references customers(ref),
  opportunity_id   text references opportunities(id),
  qty              int  not null check (qty > 0),
  unit_price_kobo  bigint not null,
  kind             text not null check (kind in ('customer', 'offer')),
  for_date         date,   -- made_to_order: the production/delivery date this hold books
  notes            text,   -- customisation (flavour, inscription…), customer-typed, length-capped
  status           text not null check (status in ('HELD', 'CONVERTED', 'RELEASED', 'EXPIRED')),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);
create unique index if not exists reservations_one_held_per_opportunity
  on reservations (opportunity_id) where status = 'HELD' and opportunity_id is not null;

create table if not exists quotes (
  id                  text primary key,
  reservation_id      text not null references reservations(id),
  zone                text not null,
  address             text,
  email               text not null,
  logistics_quote_id  text not null,
  delivery_service    text not null,
  delivery_eta_text   text not null,
  items_total_kobo    bigint not null,
  delivery_fee_kobo   bigint not null,
  total_kobo          bigint not null,
  created_at          timestamptz not null default now()
);

create table if not exists orders (
  ref                text primary key,              -- SR-1042
  quote_id           text not null unique references quotes(id),
  reservation_id     text not null references reservations(id),
  customer_ref       text not null references customers(ref),
  opportunity_id     text references opportunities(id),
  sku                text not null references products(sku),
  qty                int not null,
  unit_price_kobo    bigint not null,
  items_total_kobo   bigint not null,
  delivery_fee_kobo  bigint not null,
  total_kobo         bigint not null,
  recovery_type      text not null check (recovery_type in ('restock', 'alternative', 'direct')),
  for_date           date,
  notes              text,
  status             text not null check (status in (
                       'PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAID', 'FULFILLMENT_PENDING',
                       'DELIVERY_BOOKED', 'DELIVERED', 'CANCELLED')),
  issue              text,                          -- e.g. stock_conflict, amount_mismatch, delivery_booking_failed
  delivery_attempts  int not null default 0,
  next_delivery_at   timestamptz,
  delivery_id        text,
  tracking_ref       text,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);

-- One payable order per hold, so a re-quote can't produce a second link for the same unit.
create unique index if not exists orders_one_per_reservation on orders (reservation_id) where status <> 'CANCELLED';

create table if not exists payments (
  reference          text primary key,              -- SR-1042-1
  order_ref          text not null references orders(ref),
  attempt            int  not null,
  amount_kobo        bigint not null,
  currency           text not null default 'NGN',
  status             text not null check (status in ('INITIALIZED', 'PENDING', 'SUCCESS', 'FAILED', 'ABANDONED')),
  authorization_url  text,
  gateway_status     text,
  failure_reason     text,
  verified_at        timestamptz,
  last_checked_at    timestamptz,                   -- reconciliation sweep (worker)
  created_at         timestamptz not null default now(),
  unique (order_ref, attempt)
);

-- Owned by the mock logistics service (same database, separate routes and API key).
create table if not exists logistics_quotes (
  id          text primary key,
  zone        text not null,
  fee_kobo    bigint not null,
  service     text not null,
  eta_text    text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create table if not exists deliveries (
  id              text primary key,                -- DEL-2042
  order_ref       text not null unique,
  quote_id        text not null references logistics_quotes(id),
  zone            text not null,
  recipient_name  text,
  address         text,
  status          text not null check (status in ('BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED_ATTEMPT')),
  eta_text        text not null,
  history         jsonb not null default '[]',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create table if not exists logistics_flags (
  name   text primary key,
  value  text not null
);

create table if not exists restocks (
  id             text primary key,
  sku            text not null references products(sku),
  expected_date  date,
  confirmed      boolean not null default false,
  qty_expected   int,
  note           text,
  status         text not null check (status in ('OPEN', 'RECEIVED', 'NOT_RESTOCKING')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists deliveries_order on deliveries (order_ref);
create unique index if not exists restocks_one_open on restocks (sku) where status = 'OPEN';

create table if not exists reminders (
  id             text primary key,
  restock_id     text not null references restocks(id),
  kind           text not null check (kind in ('eta_check', 'arrival_check')),
  due_at         timestamptz not null,
  body           text not null,
  status         text not null check (status in ('ACTIVE', 'DONE', 'CANCELLED', 'SUPERSEDED')),
  chord_task_id  text,
  created_at     timestamptz not null default now(),
  closed_at      timestamptz
);
create unique index if not exists reminders_one_active on reminders (restock_id) where status = 'ACTIVE';

create table if not exists notifications (
  id              text primary key,
  recipient_type  text not null check (recipient_type in ('customer', 'owner')),
  recipient_ref   text not null,
  reason          text not null,
  body            text not null,
  dedupe_key      text not null unique,
  status          text not null check (status in ('QUEUED', 'SUBMITTED', 'SENT', 'FAILED', 'SKIPPED')),
  channel         text not null default 'chord_message' check (channel in ('chord_message', 'pull')),
  chord_task_id   text,
  submitted_at    timestamptz,
  attempts        int not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default 'epoch', -- due immediately; retries set an explicit time
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create table if not exists owner_sessions (
  token_hash  text primary key,
  sender_id   text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table if not exists inventory_changes (
  id                 text primary key,
  sku                text not null references products(sku),
  op                 text not null check (op in ('increment', 'set', 'price', 'sold_out', 'discontinue')),
  value              numeric,
  before_qty         int not null,
  after_qty          int not null,
  before_price_kobo  bigint not null,
  after_price_kobo   bigint not null,
  status             text not null check (status in ('PENDING_CONFIRMATION', 'APPLIED', 'EXPIRED')),
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  applied_at         timestamptz
);

-- Transactional outbox: written in the same transaction as the state change it describes.
create table if not exists events (
  id            bigserial primary key,
  type          text not null,
  payload       jsonb not null,
  status        text not null default 'PENDING' check (status in ('PENDING', 'DONE', 'FAILED')),
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists events_pending on events (id) where status = 'PENDING';

-- Upgrades for databases created before the security/integration review (idempotent).
alter table products      add column if not exists image_url         text;
alter table products      add column if not exists fulfilment        text not null default 'stock';
alter table products      add column if not exists capacity_group    text references capacity_groups(code);
alter table products      add column if not exists lead_time_days    int not null default 0;
alter table opportunities add column if not exists for_date          date;
alter table reservations  add column if not exists for_date          date;
alter table reservations  add column if not exists notes             text;
alter table orders        add column if not exists for_date          date;
alter table orders        add column if not exists notes             text;
alter table orders        add column if not exists delivery_attempts int not null default 0;
alter table orders        add column if not exists next_delivery_at  timestamptz;
alter table payments      add column if not exists last_checked_at   timestamptz;
alter table notifications add column if not exists submitted_at      timestamptz;

-- One open waitlist entry per customer, product and date (after the upgrades above add for_date).
create unique index if not exists opportunities_one_open_v2
  on opportunities (customer_ref, sku, coalesce(for_date, '1970-01-01'::date))
  where status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT');
drop index if exists opportunities_one_open;
