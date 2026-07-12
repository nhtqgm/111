-- Atomically replace every user-entered prediction and forecast snapshot for
-- the signed-in account. Real K-line data is deliberately not stored here.

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

  -- Any validation error below rolls the whole RPC back, including deletes.
  delete from public.user_prediction_values where user_id = auth.uid();

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
            user_id, stock_code, period, target_date, metric, value
          ) values (
            auth.uid(), stock_code_value, period_value, target_date_value::date,
            'ma' || window_value, metric_value
          )
          on conflict (user_id, stock_code, period, target_date, metric) do update
            set value = excluded.value, updated_at = now();
        end if;
      end loop;

      note_value := coalesce(prediction_row->>'note', '');
      if btrim(note_value) <> '' then
        insert into public.user_prediction_values (
          user_id, stock_code, period, target_date, metric, value
        ) values (
          auth.uid(), stock_code_value, period_value, target_date_value::date,
          'note', note_value
        )
        on conflict (user_id, stock_code, period, target_date, metric) do update
          set value = excluded.value, updated_at = now();
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

revoke all on function public.replace_my_prediction_workspace(jsonb) from public;
grant execute on function public.replace_my_prediction_workspace(jsonb) to authenticated;
