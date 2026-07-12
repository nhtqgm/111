-- Repair the two confirmed accounts whose 2026-07-10 weekly MA40 input was
-- previously copied into day/month history by the period-switch bug.
-- The predicates deliberately target only the exact contaminated records.

begin;

create temporary table gupiao_688571_repair_users on commit drop as
select distinct history.user_id
from public.user_forecast_history history
join public.user_prediction_values weekly_input
  on weekly_input.user_id = history.user_id
 and weekly_input.stock_code = '688571'
 and weekly_input.period = 'week'
 and weekly_input.target_date = date '2026-07-10'
 and weekly_input.metric = 'ma40'
 and weekly_input.value = '8.1700'
where history.stock_code = '688571'
  and history.period = 'day'
  and history.snapshot_id = '688571:day:2026-07-10:MA40'
  and history.target_date = date '2026-07-10'
  and jsonb_typeof(history.payload->'inputMaValue') = 'number'
  and jsonb_typeof(history.payload->'predictedClose') = 'number'
  and (history.payload->>'inputMaValue')::numeric = 8.17
  and abs((history.payload->>'predictedClose')::numeric - (-30.03)) < 0.000001;

insert into public.user_prediction_values (
  user_id, stock_code, period, target_date, metric, value, updated_at
)
select
  user_id, '688571', 'day', date '2026-07-10', 'ma40', '9.1500', now()
from gupiao_688571_repair_users
on conflict (user_id, stock_code, period, target_date, metric) do update
set value = excluded.value, updated_at = excluded.updated_at;

update public.user_forecast_history history
set payload = jsonb_build_object(
      'schema', 'gupiao-forecast-history/v1',
      'id', '688571:day:2026-07-10:MA40',
      'stockCode', '688571',
      'period', 'day',
      'targetDate', '2026-07-10',
      'inputMaWindow', 40,
      'inputMaValue', 9.15,
      'predictedClose', 9.17,
      'predictedMaValues', jsonb_build_object(
        '5', 9.604,
        '10', 9.658,
        '20', 9.2285,
        '40', 9.15,
        '60', 8.924333333333335
      ),
      'note', coalesce(history.payload->>'note', ''),
      'savedAt', now()::text
    ),
    updated_at = now()
from gupiao_688571_repair_users affected
where history.user_id = affected.user_id
  and history.stock_code = '688571'
  and history.period = 'day'
  and history.snapshot_id = '688571:day:2026-07-10:MA40'
  and history.target_date = date '2026-07-10';

delete from public.user_forecast_history history
using gupiao_688571_repair_users affected
where history.user_id = affected.user_id
  and history.stock_code = '688571'
  and history.period = 'month'
  and history.snapshot_id = '688571:month:2026-07-10:MA40'
  and history.target_date = date '2026-07-10'
  and jsonb_typeof(history.payload->'inputMaValue') = 'number'
  and jsonb_typeof(history.payload->'predictedClose') = 'number'
  and (history.payload->>'inputMaValue')::numeric = 8.17
  and abs((history.payload->>'predictedClose')::numeric - 50.08) < 0.000001
  and not exists (
    select 1
    from public.user_prediction_values month_input
    where month_input.user_id = history.user_id
      and month_input.stock_code = '688571'
      and month_input.period = 'month'
      and month_input.target_date = date '2026-07-10'
  );

do $$
begin
  if exists (
    select 1
    from gupiao_688571_repair_users affected
    left join public.user_prediction_values day_input
      on day_input.user_id = affected.user_id
     and day_input.stock_code = '688571'
     and day_input.period = 'day'
     and day_input.target_date = date '2026-07-10'
     and day_input.metric = 'ma40'
     and day_input.value = '9.1500'
    where day_input.user_id is null
  ) then
    raise exception '688571 day MA40 repair verification failed.';
  end if;

  if exists (
    select 1
    from gupiao_688571_repair_users affected
    left join public.user_forecast_history history
      on history.user_id = affected.user_id
     and history.snapshot_id = '688571:day:2026-07-10:MA40'
     and history.payload->>'inputMaValue' = '9.15'
     and history.payload->>'predictedClose' = '9.17'
    where history.user_id is null
  ) then
    raise exception '688571 day forecast-history repair verification failed.';
  end if;
end;
$$;

select count(*) as repaired_user_count
from gupiao_688571_repair_users;

commit;
