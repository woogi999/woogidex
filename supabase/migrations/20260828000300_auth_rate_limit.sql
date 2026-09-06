-- ==================== the auth rate limit decision ====================
-- Kept in Postgres rather than duplicated across edge functions, so IPv6
-- masking can use inet instead of being hand-rolled in TypeScript.
--
-- Two buckets counted on every call: per IP /64 prefix (a full IPv6 address
-- limits nothing, since an attacker normally holds a whole /64), and per
-- identifier (stops credential stuffing spread across many IPs).
create or replace function public.auth_rate_ok(p_ip text, p_identifier text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
    bucket text;
    ip_ok boolean;
    id_ok boolean := true;
begin
    begin
        if family(p_ip::inet) = 6 then
            bucket := host(network(set_masklen(p_ip::inet, 64))) || '/64';
        else
            bucket := host(p_ip::inet);
        end if;
    exception when others then
        -- unparseable or absent: still limited, as one shared bucket
        bucket := 'unknown';
    end;

    -- not combined into one expression: `and` short-circuits, and an uncounted bucket is not a limit
    ip_ok := public.rate_limit_hit('auth:ip:' || bucket, 10, interval '5 minutes');
    if coalesce(p_identifier, '') <> '' then
        id_ok := public.rate_limit_hit('auth:id:' || lower(p_identifier), 10, interval '15 minutes');
    end if;

    return ip_ok and id_ok;
end;
$fn$;

-- Called after a successful sign-in. Clearing on success is what makes a
-- shared address (office, carrier NAT) safe, unlike the old limiter which
-- counted successes too.
create or replace function public.auth_rate_clear(p_ip text, p_identifier text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
    bucket text;
begin
    begin
        if family(p_ip::inet) = 6 then
            bucket := host(network(set_masklen(p_ip::inet, 64))) || '/64';
        else
            bucket := host(p_ip::inet);
        end if;
    exception when others then
        bucket := 'unknown';
    end;
    perform public.rate_limit_clear('auth:ip:' || bucket);
    if coalesce(p_identifier, '') <> '' then
        perform public.rate_limit_clear('auth:id:' || lower(p_identifier));
    end if;
end;
$fn$;

revoke all on function public.auth_rate_ok(text, text)    from public, anon, authenticated;
revoke all on function public.auth_rate_clear(text, text) from public, anon, authenticated;
grant execute on function public.auth_rate_ok(text, text)    to service_role;
grant execute on function public.auth_rate_clear(text, text) to service_role;

-- login_attempts is unused now; left in place (emptied) for rollback safety, drop later.
