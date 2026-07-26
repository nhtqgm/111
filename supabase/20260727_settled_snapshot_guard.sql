-- 已定格（settledAt）的历史快照在云端也不得被无戳副本覆盖。
-- 背景：快照按 JSONB payload 整存，upsert 原本只比较 savedAt；
-- 旧版本客户端或时钟偏移设备的无戳写入会连带抹掉 settledAt/settledClose 定格戳。
-- 规则：无戳副本只能覆盖无戳记录；带戳副本按 savedAt 正常比较。

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
      where coalesce(excluded.payload->>'savedAt', '') >= coalesce(user_forecast_history.payload->>'savedAt', '')
        and (
          coalesce(user_forecast_history.payload->>'settledAt', '') = ''
          or coalesce(excluded.payload->>'settledAt', '') <> ''
        );
  end loop;
end;
$$;

revoke all on function public.upsert_my_forecast_history(jsonb) from public;
grant execute on function public.upsert_my_forecast_history(jsonb) to authenticated;
