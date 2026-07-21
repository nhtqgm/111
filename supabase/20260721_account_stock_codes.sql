-- Persist every successfully queried stock code independently per account.
-- Market K-lines and synthetic prediction rows are deliberately not stored.

create table if not exists public.user_stock_codes (
  user_id uuid not null references auth.users(id) on delete cascade,
  stock_code text not null check (stock_code ~ '^\d{6}$'),
  first_seen_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  primary key (user_id, stock_code)
);

alter table public.user_stock_codes enable row level security;

drop policy if exists "stock codes own rows select" on public.user_stock_codes;
create policy "stock codes own rows select" on public.user_stock_codes
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "stock codes own rows insert" on public.user_stock_codes;
create policy "stock codes own rows insert" on public.user_stock_codes
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "stock codes own rows update" on public.user_stock_codes;
create policy "stock codes own rows update" on public.user_stock_codes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.register_stock_code_from_account_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_stock_codes (user_id, stock_code)
  values (new.user_id, new.stock_code)
  on conflict (user_id, stock_code) do update
    set last_opened_at = now();
  return new;
end;
$$;

drop trigger if exists register_stock_code_from_preferences on public.user_workspace_preferences;
create trigger register_stock_code_from_preferences
  after insert or update on public.user_workspace_preferences
  for each row execute function public.register_stock_code_from_account_row();

drop trigger if exists register_stock_code_from_predictions on public.user_prediction_values;
create trigger register_stock_code_from_predictions
  after insert or update on public.user_prediction_values
  for each row execute function public.register_stock_code_from_account_row();

drop trigger if exists register_stock_code_from_history on public.user_forecast_history;
create trigger register_stock_code_from_history
  after insert or update on public.user_forecast_history
  for each row execute function public.register_stock_code_from_account_row();

insert into public.user_stock_codes (user_id, stock_code)
select user_id, stock_code
from public.user_workspace_preferences
where stock_code ~ '^\d{6}$'
on conflict (user_id, stock_code) do nothing;

insert into public.user_stock_codes (user_id, stock_code)
select distinct user_id, stock_code
from public.user_prediction_values
where stock_code ~ '^\d{6}$'
on conflict (user_id, stock_code) do nothing;

insert into public.user_stock_codes (user_id, stock_code)
select distinct user_id, stock_code
from public.user_forecast_history
where stock_code ~ '^\d{6}$'
on conflict (user_id, stock_code) do nothing;

create or replace function public.get_my_stock_codes()
returns table (stock_code text, last_opened_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select registry.stock_code, registry.last_opened_at
  from public.user_stock_codes registry
  where registry.user_id = auth.uid()
  order by registry.stock_code;
$$;

create or replace function public.remember_my_stock_code(p_stock_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := regexp_replace(coalesce(p_stock_code, ''), '\D', '', 'g');
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if normalized_code !~ '^\d{6}$' then
    raise exception 'Stock code must contain exactly six digits.' using errcode = '22023';
  end if;

  insert into public.user_stock_codes (user_id, stock_code)
  values (auth.uid(), normalized_code)
  on conflict (user_id, stock_code) do update
    set last_opened_at = now();
end;
$$;

revoke all on function public.get_my_stock_codes() from public;
revoke all on function public.remember_my_stock_code(text) from public;
revoke all on function public.register_stock_code_from_account_row() from public;
grant execute on function public.get_my_stock_codes() to authenticated;
grant execute on function public.remember_my_stock_code(text) to authenticated;
