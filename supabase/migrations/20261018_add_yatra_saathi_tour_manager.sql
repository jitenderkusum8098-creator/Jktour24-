-- Add Yatra Saathi and Tour Manager tables without changing existing bookings.
create table if not exists public.tour_managers (
 user_id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null, email text not null unique, mobile text,
 active boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.tour_journeys (
 id uuid primary key default gen_random_uuid(), title text not null, package_slug text,
 travel_date date, bus_label text, pickup_points jsonb not null default '[]'::jsonb,
 manager_user_id uuid references public.tour_managers(user_id) on delete set null,
 status text not null default 'scheduled' check(status in ('scheduled','in_progress','completed','cancelled')),
 welcome_message text, packing_list jsonb not null default '[]'::jsonb,
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.tour_journey_stops (
 id uuid primary key default gen_random_uuid(), journey_id uuid not null references public.tour_journeys(id) on delete cascade,
 stop_order integer not null default 1, stop_name text not null, stop_type text not null default 'other',
 address text, latitude double precision, longitude double precision, planned_time timestamptz, expected_minutes integer,
 public_message text, status text not null default 'upcoming' check(status in ('upcoming','in_progress','reached','completed','skipped')),
 is_temporary boolean not null default false, created_by uuid references auth.users(id) on delete set null,
 reached_at timestamptz, departed_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists tour_journey_stops_journey_order_idx on public.tour_journey_stops(journey_id,stop_order);
create table if not exists public.tour_passenger_attendance (
 id uuid primary key default gen_random_uuid(), journey_id uuid not null references public.tour_journeys(id) on delete cascade,
 booking_id uuid references public.bookings(id) on delete set null, ticket_number text not null, passenger_name text not null,
 pickup_point text, attendance_status text not null default 'not_present' check(attendance_status in ('present','not_present')),
 marked_by uuid references auth.users(id) on delete set null, marked_at timestamptz, created_at timestamptz not null default now(),
 unique(journey_id,ticket_number,passenger_name)
);
create table if not exists public.tour_live_locations (
 journey_id uuid primary key references public.tour_journeys(id) on delete cascade,
 manager_user_id uuid references public.tour_managers(user_id) on delete set null,
 latitude double precision not null, longitude double precision not null, accuracy_m double precision, updated_at timestamptz not null default now()
);
create table if not exists public.tour_journey_updates (
 id uuid primary key default gen_random_uuid(), journey_id uuid not null references public.tour_journeys(id) on delete cascade,
 update_type text not null default 'info', message text not null, created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now()
);
alter table public.tour_managers enable row level security;
alter table public.tour_journeys enable row level security;
alter table public.tour_journey_stops enable row level security;
alter table public.tour_passenger_attendance enable row level security;
alter table public.tour_live_locations enable row level security;
alter table public.tour_journey_updates enable row level security;