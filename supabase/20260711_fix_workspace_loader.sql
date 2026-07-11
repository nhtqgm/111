-- Hotfix for the normalized workspace loader.
-- The return-column name updated_at conflicted with unqualified table columns
-- inside the PL/pgSQL function and blocked every authenticated workspace load.

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
            jsonb_object_agg(substring(metric from 3), value)
              filter (where metric in ('ma5', 'ma10', 'ma20', 'ma40', 'ma60')),
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
    select h.stock_code || ':' || h.period as scope_key,
      jsonb_agg(h.payload order by h.target_date, h.snapshot_id) as rows
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

revoke all on function public.get_my_prediction_workspace() from public;
grant execute on function public.get_my_prediction_workspace() to authenticated;
