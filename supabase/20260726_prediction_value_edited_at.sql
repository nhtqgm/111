-- Multi-device arbitration for hand-entered prediction values.
-- Run once in the Supabase SQL editor.
--
-- Before this migration save_my_prediction_values was last-write-wins by
-- arrival order: a device that had been offline for days could replay its old
-- outbox and silently overwrite newer edits made on another device — the only
-- data in this app that cannot be regenerated. user_forecast_history already
-- guards against this with savedAt; this migration gives prediction values the
-- same protection:
--   1. edited_at column records when the client actually made the edit
--      (backfilled from updated_at for existing rows).
--   2. save_my_prediction_values only applies a write when its edited_at is
--      not older than the stored row, and reports every rejected cell back
--      with the surviving value so the client can converge its local view.
--   3. Clearing a cell keeps the row as an empty-value tombstone instead of
--      deleting it, so a deletion also carries an arbitration baseline and a
--      stale offline device cannot resurrect the cleared value.
-- get_my_prediction_workspace filters the tombstones out of the payload.

alter table public.user_prediction_values
  add column if not exists edited_at timestamptz;

update public.user_prediction_values
  set edited_at = updated_at
  where edited_at is null;

alter table public.user_prediction_values
  alter column edited_at set default now(),
  alter column edited_at set not null;

-- The return type changes from void to a row set, so the old function must go.
drop function if exists public.save_my_prediction_values(jsonb);

create function public.save_my_prediction_values(p_values jsonb)
returns table (
  r_stock_code text,
  r_period text,
  r_target_date text,
  r_metric text,
  r_value text,
  r_edited_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  v_edited_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' then
    raise exception 'Prediction values must be an array.' using errcode = '22023';
  end if;

  -- Tombstones only need to outlive realistic offline gaps.
  delete from public.user_prediction_values pv
  where pv.user_id = auth.uid()
    and btrim(pv.value) = ''
    and pv.edited_at < now() - interval '90 days';

  for item in
    select * from jsonb_to_recordset(p_values) as v(
      stock_code text, period text, target_date date, metric text, value text, edited_at timestamptz
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

    -- Clients without edited_at (older builds) keep last-write-wins. Clamp
    -- future stamps hard: legitimate stamps trail the server (network delay)
    -- or lead it by milliseconds (the client's monotonic bump), so anything
    -- further ahead is a wrong device clock. Every stored future stamp
    -- suppresses other devices' edits until real time catches up — keep that
    -- window tiny.
    v_edited_at := least(coalesce(item.edited_at, now()), now() + interval '2 minutes');

    -- A clear is an edit too: store it as an empty tombstone rather than a
    -- delete so its edited_at keeps arbitrating against stale offline writes.
    insert into public.user_prediction_values as pv
      (user_id, stock_code, period, target_date, metric, value, edited_at)
    values
      (auth.uid(), item.stock_code, item.period, item.target_date, item.metric,
       coalesce(item.value, ''), v_edited_at)
    on conflict (user_id, stock_code, period, target_date, metric) do update
      set value = excluded.value, edited_at = excluded.edited_at, updated_at = now()
      where excluded.edited_at >= pv.edited_at;

    -- When this write lost arbitration, report the surviving newer row so the
    -- client can converge its local view instead of drifting from the cloud.
    return query
    select pv.stock_code, pv.period, pv.target_date::text, pv.metric, pv.value, pv.edited_at
    from public.user_prediction_values pv
    where pv.user_id = auth.uid()
      and pv.stock_code = item.stock_code
      and pv.period = item.period
      and pv.target_date = item.target_date
      and pv.metric = item.metric
      and pv.edited_at > v_edited_at;
  end loop;
end;
$$;

-- Same loader as 20260711_fix_workspace_loader.sql, plus the tombstone filter:
-- cleared cells must not reappear in the workspace payload.
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
        and btrim(value) <> ''
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
    -- The client seeds its edit clock from this value so its next edit
    -- outranks everything stored. edited_at is a clamped *client* stamp that
    -- may run ahead of every server-written updated_at, so it must be part
    -- of the maximum or a fast-clocked device would suppress edits made on
    -- other devices after sign-in.
    coalesce((
      select max(prediction_value.edited_at)
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

-- The full-import RPC previously deleted every prediction row outright, which
-- also destroyed arbitration baselines: a cell removed by an import had no row
-- left, so a stale offline outbox could re-insert its old value afterwards.
-- Rebuild it on the same contract, but demote existing rows to now()-stamped
-- tombstones first so the import — the user's declared newest state — wins
-- arbitration for every cell it touched or dropped.
create or replace function public.replace_my_prediction_workspace(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  workspace_value jsonb;
  scope_item record;
  prediction_row jsonb;
  history_row jsonb;
  stock_code_value text;
  period_value text;
  target_date_value text;
  window_value text;
  metric_value text;
  note_value text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'schema' <> 'gupiao-cloud-workspace/v1' then
    raise exception 'Cloud workspace payload is invalid.' using errcode = '22023';
  end if;

  workspace_value := p_payload->'workspace';
  if jsonb_typeof(workspace_value) <> 'object'
    or coalesce(workspace_value->>'stockCode', '') !~ '^\d{6}$'
    or workspace_value->>'period' not in ('day', 'week', 'month')
    or (
      coalesce(workspace_value->>'baseDate', '') <> ''
      and workspace_value->>'baseDate' !~ '^\d{4}-\d{2}-\d{2}$'
    ) then
    raise exception 'Cloud workspace selection is invalid.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload->'predictions') <> 'object'
    or jsonb_typeof(p_payload->'forecastHistory') <> 'object' then
    raise exception 'Cloud workspace collections are invalid.' using errcode = '22023';
  end if;

  -- Any validation error below rolls the whole RPC back, including this.
  -- Tombstone instead of delete: cells absent from the imported payload keep
  -- an edited_at = now() baseline that outranks stale offline replays.
  update public.user_prediction_values
    set value = '', edited_at = now(), updated_at = now()
    where user_id = auth.uid();

  for scope_item in select key, value from jsonb_each(p_payload->'predictions')
  loop
    if scope_item.key !~ '^\d{6}:(day|week|month)$'
      or jsonb_typeof(scope_item.value) <> 'array' then
      raise exception 'Prediction scope is invalid: %', scope_item.key using errcode = '22023';
    end if;
    stock_code_value := split_part(scope_item.key, ':', 1);
    period_value := split_part(scope_item.key, ':', 2);

    for prediction_row in select value from jsonb_array_elements(scope_item.value)
    loop
      target_date_value := coalesce(prediction_row->>'targetDate', '');
      if jsonb_typeof(prediction_row) <> 'object'
        or target_date_value !~ '^\d{4}-\d{2}-\d{2}$'
        or (
          prediction_row ? 'predictedMaValues'
          and jsonb_typeof(prediction_row->'predictedMaValues') <> 'object'
        ) then
        raise exception 'Prediction row is invalid in scope %.', scope_item.key using errcode = '22023';
      end if;

      foreach window_value in array array['5', '10', '20', '40', '60']
      loop
        metric_value := coalesce(
          prediction_row->'predictedMaValues'->>window_value,
          case when window_value = '40' then prediction_row->>'predictedMa40' end,
          ''
        );
        if btrim(metric_value) <> '' then
          if metric_value !~ '^-?\d+(\.\d{1,4})?$' then
            raise exception 'Prediction MA must have at most four decimal places.' using errcode = '22023';
          end if;
          insert into public.user_prediction_values (
            user_id, stock_code, period, target_date, metric, value, edited_at
          ) values (
            auth.uid(), stock_code_value, period_value, target_date_value::date,
            'ma' || window_value, metric_value, now()
          )
          on conflict (user_id, stock_code, period, target_date, metric) do update
            set value = excluded.value, edited_at = now(), updated_at = now();
        end if;
      end loop;

      note_value := coalesce(prediction_row->>'note', '');
      if btrim(note_value) <> '' then
        insert into public.user_prediction_values (
          user_id, stock_code, period, target_date, metric, value, edited_at
        ) values (
          auth.uid(), stock_code_value, period_value, target_date_value::date,
          'note', note_value, now()
        )
        on conflict (user_id, stock_code, period, target_date, metric) do update
          set value = excluded.value, edited_at = now(), updated_at = now();
      end if;
    end loop;
  end loop;

  delete from public.user_forecast_history where user_id = auth.uid();

  for scope_item in select key, value from jsonb_each(p_payload->'forecastHistory')
  loop
    if scope_item.key !~ '^\d{6}:(day|week|month)$'
      or jsonb_typeof(scope_item.value) <> 'array' then
      raise exception 'Forecast history scope is invalid: %', scope_item.key using errcode = '22023';
    end if;
    stock_code_value := split_part(scope_item.key, ':', 1);
    period_value := split_part(scope_item.key, ':', 2);

    for history_row in select value from jsonb_array_elements(scope_item.value)
    loop
      target_date_value := coalesce(history_row->>'targetDate', '');
      if jsonb_typeof(history_row) <> 'object'
        or history_row->>'schema' <> 'gupiao-forecast-history/v1'
        or history_row->>'stockCode' <> stock_code_value
        or history_row->>'period' <> period_value
        or coalesce(history_row->>'id', '') = ''
        or target_date_value !~ '^\d{4}-\d{2}-\d{2}$'
        or history_row->>'inputMaWindow' not in ('5', '10', '20', '40', '60')
        or jsonb_typeof(history_row->'inputMaValue') <> 'number'
        or jsonb_typeof(history_row->'predictedClose') <> 'number'
        or jsonb_typeof(history_row->'predictedMaValues') <> 'object' then
        raise exception 'Forecast history row is invalid in scope %.', scope_item.key using errcode = '22023';
      end if;

      insert into public.user_forecast_history (
        user_id, stock_code, period, snapshot_id, target_date, payload
      ) values (
        auth.uid(), stock_code_value, period_value, history_row->>'id',
        target_date_value::date, history_row
      )
      on conflict (user_id, snapshot_id) do update
        set stock_code = excluded.stock_code,
            period = excluded.period,
            target_date = excluded.target_date,
            payload = excluded.payload,
            updated_at = now();
    end loop;
  end loop;

  insert into public.user_workspace_preferences (user_id, stock_code, period, base_date)
  values (
    auth.uid(),
    workspace_value->>'stockCode',
    workspace_value->>'period',
    nullif(workspace_value->>'baseDate', '')::date
  )
  on conflict (user_id) do update
    set stock_code = excluded.stock_code,
        period = excluded.period,
        base_date = excluded.base_date,
        updated_at = now();
end;
$$;

revoke all on function public.save_my_prediction_values(jsonb) from public;
revoke all on function public.get_my_prediction_workspace() from public;
revoke all on function public.replace_my_prediction_workspace(jsonb) from public;
grant execute on function public.save_my_prediction_values(jsonb) to authenticated;
grant execute on function public.get_my_prediction_workspace() to authenticated;
grant execute on function public.replace_my_prediction_workspace(jsonb) to authenticated;
