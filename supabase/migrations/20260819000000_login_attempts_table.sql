create table if not exists public.login_attempts (
    id bigint generated always as identity primary key,
    ip text not null,
    attempted_at timestamptz not null default now()
);

create index if not exists idx_login_attempts_ip_time
    on public.login_attempts (ip, attempted_at);
