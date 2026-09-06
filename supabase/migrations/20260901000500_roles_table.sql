-- ==================== the roles table ====================
-- public.roles was read by the client since roles went db-driven, but the
-- table was never created, so every hub render 404'd and fell back to a
-- static roles map. Seeded from that same map, so switching to the table
-- changes no label, colour or rank -- just makes them editable without a deploy.
--
-- Readable by everyone since a role label sits next to an author's name on a
-- public listing. No write policy, matching public.badges: role definitions
-- are changed deliberately from the dashboard, not by the app.

create table if not exists public.roles (
    key   text primary key,
    label text    not null,
    color text    not null default '#6b7280',
    rank  integer not null default 0
);

alter table public.roles enable row level security;

drop policy if exists "Anyone can read role definitions" on public.roles;
create policy "Anyone can read role definitions"
    on public.roles for select
    to anon, authenticated
    using (true);

insert into public.roles (key, label, color, rank) values
    ('user',      'User',      '#6b7280', 0),
    ('trusted',   'Trusted',   '#22c55e', 1),
    ('moderator', 'Moderator', '#3b82f6', 2),
    ('admin',     'Admin',     '#ef4444', 3),
    ('developer', 'Developer', '#a855f7', 4)
on conflict (key) do nothing;
