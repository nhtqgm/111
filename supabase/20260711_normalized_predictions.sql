-- Normalize user-entered predictions. Run once in the Supabase SQL editor.
-- Market K-line data is intentionally excluded from every table in this file.

create table if not exists public.user_prediction_values (
  user_id uuid not null references auth.users(id) on delete cascade,
  stock_code text not null check (stock_code ~ '^\d{6}$'),
  period text not null check (period in ('day', 'week', 'month')),
  target_date date not null,
  metric text not null check (metric in ('ma5', 'ma10', 'ma20', 'ma40', 'ma60', 'note')),
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, stock_code, period, target_date, metric)
);

create table if not exists public.user_workspace_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stock_code text not null default '000166' check (stock_code ~ '^\d{6}$'),
  period text not null default 'month' check (period in ('day', 'week', 'month')),
  base_date date,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_forecast_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  stock_code text not null check (stock_code ~ '^\d{6}$'),
  period text not null check (period in ('day', 'week', 'month')),
  snapshot_id text not null,
  target_date date not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, snapshot_id)
);

alter table public.user_prediction_values enable row level security;
alter table public.user_workspace_preferences enable row level security;
alter table public.user_forecast_history enable row level security;

drop policy if exists "prediction values own rows" on public.user_prediction_values;
create policy "prediction values own rows" on public.user_prediction_values
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "workspace preferences own row" on public.user_workspace_preferences;
create policy "workspace preferences own row" on public.user_workspace_preferences
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "forecast history own rows" on public.user_forecast_history;
create policy "forecast history own rows" on public.user_forecast_history
  for select to authenticated using (user_id = auth.uid());

-- Preserve existing cloud predictions before the application begins using the
-- normalized tables. Market caches were never in payload.predictions.
with source_rows as (
  select
    w.user_id,
    split_part(scope.key, ':', 1) as stock_code,
    split_part(scope.key, ':', 2) as period,
    point.value as point
  from public.user_workspaces w
  cross join lateral jsonb_each(coalesce(w.payload->'predictions', '{}'::jsonb)) scope
  cross join lateral jsonb_array_elements(scope.value) point
), values_from_map as (
  select user_id, stock_code, period, point->>'targetDate' as target_date,
    'ma' || value.key as metric, value.value as value
  from source_rows
  cross join lateral jsonb_each_text(coalesce(point->'predictedMaValues', '{}'::jsonb)) value
  where value.key in ('5', '10', '20', '40', '60') and btrim(value.value) <> ''
), legacy_ma40 as (
  select user_id, stock_code, period, point->>'targetDate' as target_date,
    'ma40' as metric, point->>'predictedMa40' as value
  from source_rows
  where coalesce(point->'predictedMaValues'->>'40', '') = ''
    and btrim(coalesce(point->>'predictedMa40', '')) <> ''
), notes as (
  select user_id, stock_code, period, point->>'targetDate' as target_date,
    'note' as metric, point->>'note' as value
  from source_rows
  where btrim(coalesce(point->>'note', '')) <> ''
)
insert into public.user_prediction_values (user_id, stock_code, period, target_date, metric, value)
select user_id, stock_code, period, target_date::date, metric, value
from (
  select * from values_from_map
  union all select * from legacy_ma40
  union all select * from notes
) migrated
where stock_code ~ '^\d{6}$' and period in ('day', 'week', 'month')
  and target_date ~ '^\d{4}-\d{2}-\d{2}$'
on conflict (user_id, stock_code, period, target_date, metric) do nothing;

insert into public.user_workspace_preferences (user_id, stock_code, period, base_date)
select
  user_id,
  coalesce(nullif(payload->'workspace'->>'stockCode', ''), '000166'),
  case when payload->'workspace'->>'period' in ('day', 'week', 'month')
    then payload->'workspace'->>'period' else 'month' end,
  nullif(payload->'workspace'->>'baseDate', '')::date
from public.user_workspaces
where coalesce(payload->'workspace'->>'stockCode', '000166') ~ '^\d{6}$'
on conflict (user_id) do nothing;

insert into public.user_forecast_history (user_id, stock_code, period, snapshot_id, target_date, payload)
select
  w.user_id,
  split_part(scope.key, ':', 1),
  split_part(scope.key, ':', 2),
  snapshot.value->>'id',
  (snapshot.value->>'targetDate')::date,
  snapshot.value
from public.user_workspaces w
cross join lateral jsonb_each(coalesce(w.payload->'forecastHistory', '{}'::jsonb)) scope
cross join lateral jsonb_array_elements(scope.value) snapshot
where split_part(scope.key, ':', 1) ~ '^\d{6}$'
  and split_part(scope.key, ':', 2) in ('day', 'week', 'month')
  and coalesce(snapshot.value->>'id', '') <> ''
  and coalesce(snapshot.value->>'targetDate', '') ~ '^\d{4}-\d{2}-\d{2}$'
on conflict (user_id, snapshot_id) do nothing;

create or replace function public.get_my_prediction_workspace()
returns table (payload jsonb, updated_at timestamptz)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  preferences public.user_workspace_preferences%rowtype;
  prediction_payload jsonb := '{}'::jsonb;
  history_payload jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select * into preferences from public.user_workspace_preferences where user_id = auth.uid();
  if not found then
    preferences.user_id := auth.uid();
    preferences.stock_code := '000166';
    preferences.period := 'month';
    preferences.base_date := null;
    preferences.updated_at := now();
  end if;

  select coalesce(jsonb_object_agg(scope_key, rows), '{}'::jsonb) into prediction_payload
  from (
    select stock_code || ':' || period as scope_key, jsonb_agg(row_payload order by target_date) as rows
    from (
      select
        stock_code,
        period,
        target_date,
        jsonb_build_object(
          'targetDate', target_date::text,
          'predictedMa40', coalesce(max(value) filter (where metric = 'ma40'), ''),
          'predictedMaValues', coalesce(
            jsonb_object_agg(substring(metric from 3), value) filter (where metric in ('ma5', 'ma10', 'ma20', 'ma40', 'ma60')),
            '{}'::jsonb
          ),
          'note', coalesce(max(value) filter (where metric = 'note'), '')
        ) as row_payload
      from public.user_prediction_values
      where user_id = auth.uid()
      group by stock_code, period, target_date
    ) rows
    group by stock_code, period
  ) scopes;

  select coalesce(jsonb_object_agg(scope_key, rows), '{}'::jsonb) into history_payload
  from (
    select h.stock_code || ':' || h.period as scope_key, jsonb_agg(h.payload order by h.target_date, h.snapshot_id) as rows
    from public.user_forecast_history h
    where h.user_id = auth.uid()
    group by h.stock_code, h.period
  ) scopes;

  return query select jsonb_build_object(
    'schema', 'gupiao-cloud-workspace/v1',
    'workspace', jsonb_build_object(
      'stockCode', preferences.stock_code,
      'period', preferences.period,
      'baseDate', coalesce(preferences.base_date::text, '')
    ),
    'predictions', prediction_payload,
    'forecastHistory', history_payload,
    'updatedAt', now()::text
  ), greatest(
    preferences.updated_at,
    coalesce((
      select max(prediction_value.updated_at)
      from public.user_prediction_values prediction_value
      where prediction_value.user_id = auth.uid()
    ), preferences.updated_at),
    coalesce((
      select max(forecast_history.updated_at)
      from public.user_forecast_history forecast_history
      where forecast_history.user_id = auth.uid()
    ), preferences.updated_at)
  );
end;
$$;

create or replace function public.save_my_prediction_values(p_values jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' then
    raise exception 'Prediction values must be an array.' using errcode = '22023';
  end if;

  for item in
    select * from jsonb_to_recordset(p_values) as value(
      stock_code text, period text, target_date date, metric text, value text
    )
  loop
    if item.stock_code !~ '^\d{6}$' or item.period not in ('day', 'week', 'month')
      or item.target_date is null or item.metric not in ('ma5', 'ma10', 'ma20', 'ma40', 'ma60', 'note') then
      raise exception 'Invalid prediction value.' using errcode = '22023';
    end if;
    if item.metric <> 'note' and item.value is not null
      and btrim(item.value) <> '' and item.value !~ '^-?\d+(\.\d{1,4})?$' then
      raise exception 'Prediction MA must have at most four decimal places.' using errcode = '22023';
    end if;

    if item.value is null or btrim(item.value) = '' then
      delete from public.user_prediction_values
      where user_id = auth.uid() and stock_code = item.stock_code and period = item.period
        and target_date = item.target_date and metric = item.metric;
    else
      insert into public.user_prediction_values (user_id, stock_code, period, target_date, metric, value)
      values (auth.uid(), item.stock_code, item.period, item.target_date, item.metric, item.value)
      on conflict (user_id, stock_code, period, target_date, metric) do update
        set value = excluded.value, updated_at = now();
    end if;
  end loop;
end;
$$;

create or replace function public.save_my_workspace_preferences(
  p_stock_code text,
  p_period text,
  p_base_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if p_stock_code !~ '^\d{6}$' or p_period not in ('day', 'week', 'month') then
    raise exception 'Invalid workspace preference.' using errcode = '22023';
  end if;
  insert into public.user_workspace_preferences (user_id, stock_code, period, base_date)
  values (auth.uid(), p_stock_code, p_period, p_base_date)
  on conflict (user_id) do update
    set stock_code = excluded.stock_code, period = excluded.period,
        base_date = excluded.base_date, updated_at = now();
end;
$$;

create or replace function public.upsert_my_forecast_history(p_snapshots jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare snapshot jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication is required.' using errcode = '42501'; end if;
  if p_snapshots is null or jsonb_typeof(p_snapshots) <> 'array' then
    raise exception 'Forecast history must be an array.' using errcode = '22023';
  end if;
  for snapshot in select value from jsonb_array_elements(p_snapshots)
  loop
    if coalesce(snapshot->>'stockCode', '') !~ '^\d{6}$'
      or snapshot->>'period' not in ('day', 'week', 'month')
      or coalesce(snapshot->>'id', '') = ''
      or coalesce(snapshot->>'targetDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Invalid forecast history snapshot.' using errcode = '22023';
    end if;
    insert into public.user_forecast_history (user_id, stock_code, period, snapshot_id, target_date, payload)
    values (auth.uid(), snapshot->>'stockCode', snapshot->>'period', snapshot->>'id', (snapshot->>'targetDate')::date, snapshot)
    on conflict (user_id, snapshot_id) do update
      set payload = excluded.payload, target_date = excluded.target_date, updated_at = now()
      where coalesce(excluded.payload->>'savedAt', '') >= coalesce(user_forecast_history.payload->>'savedAt', '');
  end loop;
end;
$$;

revoke all on function public.get_my_prediction_workspace() from public;
revoke all on function public.save_my_prediction_values(jsonb) from public;
revoke all on function public.save_my_workspace_preferences(text, text, date) from public;
revoke all on function public.upsert_my_forecast_history(jsonb) from public;
grant execute on function public.get_my_prediction_workspace() to authenticated;
grant execute on function public.save_my_prediction_values(jsonb) to authenticated;
grant execute on function public.save_my_workspace_preferences(text, text, date) to authenticated;
grant execute on function public.upsert_my_forecast_history(jsonb) to authenticated;
