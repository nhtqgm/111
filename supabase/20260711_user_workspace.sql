-- Cloud-only account workspaces for the stock forecast application.
-- Run this migration in the Supabase SQL editor as a project administrator.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schema text not null default 'gupiao-cloud-workspace/v1',
  revision bigint not null default 0 check (revision >= 0),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.user_workspaces enable row level security;

drop policy if exists "profiles own row" on public.profiles;
create policy "profiles own row" on public.profiles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "workspace own row" on public.user_workspaces;
create policy "workspace own row" on public.user_workspaces
  for select to authenticated using (user_id = auth.uid());

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

-- Existing accounts also receive a normal-user profile without changing
-- any manually assigned admin role.
insert into public.profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;

create or replace function public.get_my_profile()
returns table (user_id uuid, role text)
language sql
security definer
stable
set search_path = public
as $$
  select p.user_id, p.role
  from public.profiles p
  where p.user_id = auth.uid();
$$;

create or replace function public.get_my_workspace()
returns table (schema text, revision bigint, payload jsonb, updated_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select w.schema, w.revision, w.payload, w.updated_at
  from public.user_workspaces w
  where w.user_id = auth.uid();
$$;

create or replace function public.save_my_workspace(
  p_payload jsonb,
  p_expected_revision bigint
)
returns table (schema text, revision bigint, payload jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_revision bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_payload is null or p_payload->>'schema' <> 'gupiao-cloud-workspace/v1' then
    raise exception 'Unsupported workspace payload.' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'A non-negative revision is required.' using errcode = '22023';
  end if;

  select w.revision into current_revision
  from public.user_workspaces w
  where w.user_id = auth.uid()
  for update;

  if not found then
    if p_expected_revision <> 0 then
      raise exception 'Workspace revision conflict.' using errcode = '40001';
    end if;
    insert into public.user_workspaces (user_id, schema, revision, payload)
    values (auth.uid(), 'gupiao-cloud-workspace/v1', 1, p_payload);
  else
    if current_revision <> p_expected_revision then
      raise exception 'Workspace revision conflict.' using errcode = '40001';
    end if;
    update public.user_workspaces
    set schema = 'gupiao-cloud-workspace/v1',
        revision = revision + 1,
        payload = p_payload,
        updated_at = now()
    where user_id = auth.uid();
  end if;

  return query
  select w.schema, w.revision, w.payload, w.updated_at
  from public.user_workspaces w
  where w.user_id = auth.uid();
end;
$$;

create or replace function public.admin_workspace_count()
returns bigint
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles where user_id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Administrator permission required.' using errcode = '42501';
  end if;
  return (select count(*) from public.user_workspaces);
end;
$$;

revoke all on function public.get_my_profile() from public;
revoke all on function public.get_my_workspace() from public;
revoke all on function public.save_my_workspace(jsonb, bigint) from public;
revoke all on function public.admin_workspace_count() from public;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.get_my_workspace() to authenticated;
grant execute on function public.save_my_workspace(jsonb, bigint) to authenticated;
grant execute on function public.admin_workspace_count() to authenticated;

-- Seed the two initial account workspaces only after creating their Auth users.
-- Replace the UUIDs below in the SQL editor. The ON CONFLICT clause is intentionally
-- DO NOTHING so a later user edit can never be overwritten by the baseline seed.
-- insert into public.user_workspaces (user_id, schema, revision, payload)
-- values ('USER_UUID', 'gupiao-cloud-workspace/v1', 1, '<BASELINE_JSON>'::jsonb)
-- on conflict (user_id) do nothing;
