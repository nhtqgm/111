-- Immutable, cloud-only storage for submitted forecast revisions.
--
-- Apply after 20260711_normalized_predictions.sql. Submitted batches are
-- append-only; draft predictions remain in the existing normalized tables.

begin;

create table if not exists public.user_issued_forecast_batches (
  server_sequence bigint generated always as identity,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id text not null,
  stock_code text not null check (stock_code ~ '^\d{6}$'),
  period text not null check (period in ('day', 'week', 'month')),
  input_ma_window integer not null check (input_ma_window in (5, 10, 20, 40, 60)),
  as_of_date date not null,
  source text not null check (source in ('issued', 'migration', 'legacy-history')),
  batch_payload jsonb not null check (jsonb_typeof(batch_payload) = 'object'),
  snapshot_payloads jsonb not null check (jsonb_typeof(snapshot_payloads) = 'array'),
  persisted_at timestamptz not null default now(),
  primary key (user_id, batch_id),
  unique (server_sequence),
  check (batch_payload->>'id' = batch_id),
  check (batch_payload->>'stockCode' = stock_code),
  check (batch_payload->>'period' = period),
  check ((batch_payload->>'inputMaWindow')::integer = input_ma_window),
  check ((batch_payload->>'asOfDate')::date = as_of_date)
);

create index if not exists user_issued_forecast_batches_user_sequence_idx
  on public.user_issued_forecast_batches (user_id, server_sequence);

alter table public.user_issued_forecast_batches enable row level security;

drop policy if exists "issued forecast batches own rows" on public.user_issued_forecast_batches;
create policy "issued forecast batches own rows"
  on public.user_issued_forecast_batches
  for select
  to authenticated
  using (user_id = auth.uid());

-- Defense in depth: normal clients have no write grants or write policies, and
-- this trigger also rejects UPDATE if broader grants are added later. DELETE is
-- left to privileged maintenance so auth.users ON DELETE CASCADE remains valid.
create or replace function public.reject_issued_forecast_batch_mutation_v2()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Submitted forecast batches are append-only.' using errcode = '55000';
end;
$$;

drop trigger if exists reject_issued_forecast_batch_mutation_v2
  on public.user_issued_forecast_batches;
create trigger reject_issued_forecast_batch_mutation_v2
  before update on public.user_issued_forecast_batches
  for each row execute function public.reject_issued_forecast_batch_mutation_v2();

create or replace function public.insert_my_issued_forecast_batch_v2(
  p_batch jsonb,
  p_snapshots jsonb,
  p_source text default 'issued'
)
returns table (
  server_sequence bigint,
  batch_payload jsonb,
  source text,
  persisted_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_batch_id text;
  v_stock_code text;
  v_period text;
  v_window integer;
  v_revision text;
  v_as_of_date_text text;
  v_as_of_date date;
  v_as_of_period_key text;
  v_expected_as_of_period_key text;
  v_issued_at_text text;
  v_issued_at timestamptz;
  v_row_count integer;
  v_row record;
  v_row_payload jsonb;
  v_row_target_date_text text;
  v_row_target_date date;
  v_previous_target_date date;
  v_previous_period_key text;
  v_expected_period_key text;
  v_basis record;
  v_basis_target_date_text text;
  v_basis_target_date date;
  v_snapshot record;
  v_snapshot_payload jsonb;
  v_snapshot_meta jsonb;
  v_snapshot_row jsonb;
  v_snapshot_id text;
  v_fingerprint text;
  v_expected_snapshot_ma_values jsonb;
  v_stored_sequence bigint;
  v_stored_payload jsonb;
  v_stored_snapshots jsonb;
  v_stored_source text;
  v_stored_persisted_at timestamptz;
  v_history_stock_code text;
  v_history_period text;
  v_history_target_date date;
  v_history_payload jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  if p_batch is null or jsonb_typeof(p_batch) <> 'object' then
    raise exception 'Issued forecast batch must be a JSON object.' using errcode = '22023';
  end if;
  if p_snapshots is null or jsonb_typeof(p_snapshots) <> 'array' then
    raise exception 'Issued forecast snapshots must be a JSON array.' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('issued', 'migration', 'legacy-history') then
    raise exception 'Invalid issued forecast source.' using errcode = '22023';
  end if;

  if not (
    p_batch ? 'schema' and p_batch ? 'id' and p_batch ? 'stockCode'
    and p_batch ? 'period' and p_batch ? 'inputMaWindow'
    and p_batch ? 'revision' and p_batch ? 'asOfDate'
    and p_batch ? 'asOfPeriodKey' and p_batch ? 'issuedAt' and p_batch ? 'rows'
  ) or exists (
    select 1
    from jsonb_object_keys(p_batch) as batch_key(key)
    where batch_key.key not in (
      'schema', 'id', 'stockCode', 'period', 'inputMaWindow',
      'revision', 'asOfDate', 'asOfPeriodKey', 'issuedAt', 'rows'
    )
  ) then
    raise exception 'Issued forecast batch has missing or unsupported fields.' using errcode = '22023';
  end if;

  if p_batch->>'schema' is distinct from 'gupiao-issued-forecast-batch/v1' then
    raise exception 'Unsupported issued forecast batch schema.' using errcode = '22023';
  end if;

  v_batch_id := p_batch->>'id';
  v_stock_code := p_batch->>'stockCode';
  v_period := p_batch->>'period';
  v_revision := btrim(p_batch->>'revision');
  v_as_of_date_text := p_batch->>'asOfDate';
  v_as_of_period_key := p_batch->>'asOfPeriodKey';
  v_issued_at_text := p_batch->>'issuedAt';

  if jsonb_typeof(p_batch->'stockCode') is distinct from 'string'
    or jsonb_typeof(p_batch->'revision') is distinct from 'string' then
    raise exception 'Issued forecast stock code and revision must be strings.' using errcode = '22023';
  end if;

  if coalesce(v_batch_id, '') = '' or length(v_batch_id) > 512 then
    raise exception 'Invalid issued forecast batch id.' using errcode = '22023';
  end if;
  if coalesce(v_stock_code, '') !~ '^\d{6}$' then
    raise exception 'Invalid issued forecast stock code.' using errcode = '22023';
  end if;
  if v_period is null or v_period not in ('day', 'week', 'month') then
    raise exception 'Invalid issued forecast period.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_batch->'inputMaWindow') is distinct from 'number' then
    raise exception 'Invalid issued forecast MA window.' using errcode = '22023';
  end if;
  begin
    v_window := (p_batch->>'inputMaWindow')::integer;
  exception when others then
    raise exception 'Invalid issued forecast MA window.' using errcode = '22023';
  end;
  if v_window not in (5, 10, 20, 40, 60)
    or (p_batch->'inputMaWindow') <> to_jsonb(v_window) then
    raise exception 'Invalid issued forecast MA window.' using errcode = '22023';
  end if;
  if coalesce(v_revision, '') = '' or length(v_revision) > 200
    or v_revision !~ '^[A-Za-z0-9._~-]+$'
    or p_batch->>'revision' is distinct from v_revision then
    raise exception 'Invalid issued forecast revision.' using errcode = '22023';
  end if;
  if coalesce(v_as_of_date_text, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Invalid issued forecast as-of date.' using errcode = '22023';
  end if;
  begin
    v_as_of_date := v_as_of_date_text::date;
  exception when others then
    raise exception 'Invalid issued forecast as-of date.' using errcode = '22023';
  end;
  if v_as_of_date::text <> v_as_of_date_text then
    raise exception 'Invalid issued forecast as-of date.' using errcode = '22023';
  end if;
  -- issuedAt is immutable payload provenance only. The authoritative issue
  -- order/time are server_sequence and persisted_at, both assigned by Postgres.
  if coalesce(v_issued_at_text, '') !~
    '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
    raise exception 'Invalid issued forecast issue timestamp.' using errcode = '22023';
  end if;
  begin
    v_issued_at := v_issued_at_text::timestamptz;
  exception when others then
    raise exception 'Invalid issued forecast issue timestamp.' using errcode = '22023';
  end;
  if not isfinite(v_issued_at) then
    raise exception 'Invalid issued forecast issue timestamp.' using errcode = '22023';
  end if;

  v_expected_as_of_period_key := case v_period
    when 'day' then v_as_of_date::text
    when 'month' then to_char(v_as_of_date, 'YYYY-MM')
    when 'week' then (v_as_of_date - (extract(isodow from v_as_of_date)::integer - 1))::text
  end;
  if v_as_of_period_key is distinct from v_expected_as_of_period_key then
    raise exception 'Issued forecast as-of period key does not match its date.' using errcode = '22023';
  end if;
  if v_batch_id <> concat(
    v_stock_code, ':', v_period, ':MA', v_window::text, ':',
    v_as_of_date_text, ':', v_revision
  ) then
    raise exception 'Issued forecast batch id does not match its scope and revision.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_batch->'rows') is distinct from 'array' then
    raise exception 'Issued forecast rows must be an array.' using errcode = '22023';
  end if;
  v_row_count := jsonb_array_length(p_batch->'rows');
  if v_row_count < 1 or v_row_count > 512 then
    raise exception 'Issued forecast batch must contain between 1 and 512 rows.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_snapshots) <> v_row_count then
    raise exception 'Issued forecast snapshot count must match the batch row count.' using errcode = '22023';
  end if;

  -- Validate every immutable row before any data is inserted.
  for v_row in
    select row_item.value as payload, row_item.ordinality::integer as ordinal
    from jsonb_array_elements(p_batch->'rows') with ordinality as row_item(value, ordinality)
    order by row_item.ordinality
  loop
    v_row_payload := v_row.payload;
    if jsonb_typeof(v_row_payload) <> 'object' or not (
      v_row_payload ? 'id' and v_row_payload ? 'targetDate'
      and v_row_payload ? 'periodKey' and v_row_payload ? 'horizon'
      and v_row_payload ? 'inputMaValue' and v_row_payload ? 'predictedClose'
      and v_row_payload ? 'predictedMaValues' and v_row_payload ? 'note'
      and v_row_payload ? 'previousSumAtIssue' and v_row_payload ? 'basisValues'
    ) or exists (
      select 1
      from jsonb_object_keys(v_row_payload) as row_key(key)
      where row_key.key not in (
        'id', 'targetDate', 'periodKey', 'horizon', 'inputMaValue',
        'predictedClose', 'predictedMaValues', 'note',
        'previousSumAtIssue', 'basisValues'
      )
    ) then
      raise exception 'Issued forecast row % has missing or unsupported fields.', v_row.ordinal
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_row_payload->'horizon') is distinct from 'number'
      or v_row_payload->'horizon' <> to_jsonb(v_row.ordinal)
      or jsonb_typeof(v_row_payload->'inputMaValue') is distinct from 'number'
      or jsonb_typeof(v_row_payload->'predictedClose') is distinct from 'number'
      or jsonb_typeof(v_row_payload->'previousSumAtIssue') is distinct from 'number'
      or jsonb_typeof(v_row_payload->'note') is distinct from 'string' then
      raise exception 'Issued forecast row % contains invalid scalar values.', v_row.ordinal
        using errcode = '22023';
    end if;

    v_row_target_date_text := v_row_payload->>'targetDate';
    if coalesce(v_row_target_date_text, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Issued forecast row % has an invalid target date.', v_row.ordinal
        using errcode = '22023';
    end if;
    begin
      v_row_target_date := v_row_target_date_text::date;
    exception when others then
      raise exception 'Issued forecast row % has an invalid target date.', v_row.ordinal
        using errcode = '22023';
    end;
    if v_row_target_date::text <> v_row_target_date_text
      or v_row_target_date <= v_as_of_date
      or (v_previous_target_date is not null and v_row_target_date <= v_previous_target_date) then
      raise exception 'Issued forecast row target dates must be valid, future, and strictly increasing.'
        using errcode = '22023';
    end if;
    v_previous_target_date := v_row_target_date;

    v_expected_period_key := case v_period
      when 'day' then v_row_target_date::text
      when 'month' then to_char(v_row_target_date, 'YYYY-MM')
      when 'week' then (v_row_target_date - (extract(isodow from v_row_target_date)::integer - 1))::text
    end;
    if coalesce(v_row_payload->>'periodKey', '') <> v_expected_period_key then
      raise exception 'Issued forecast row % period key does not match its target date.', v_row.ordinal
        using errcode = '22023';
    end if;
    if v_expected_period_key is not distinct from v_previous_period_key then
      raise exception 'Issued forecast rows must use unique period keys.' using errcode = '22023';
    end if;
    v_previous_period_key := v_expected_period_key;
    if coalesce(v_row_payload->>'id', '')
      <> concat(v_batch_id, ':', v_expected_period_key, ':H', v_row.ordinal::text) then
      raise exception 'Issued forecast row % id does not match its batch and horizon.', v_row.ordinal
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_row_payload->'predictedMaValues') is distinct from 'object'
      or not (
        v_row_payload->'predictedMaValues' ? '5'
        and v_row_payload->'predictedMaValues' ? '10'
        and v_row_payload->'predictedMaValues' ? '20'
        and v_row_payload->'predictedMaValues' ? '40'
        and v_row_payload->'predictedMaValues' ? '60'
      ) or exists (
        select 1
        from jsonb_each(v_row_payload->'predictedMaValues') as ma_value(key, value)
        where ma_value.key not in ('5', '10', '20', '40', '60')
          or jsonb_typeof(ma_value.value) not in ('number', 'null')
      ) then
      raise exception 'Issued forecast row % has invalid predicted MA values.', v_row.ordinal
        using errcode = '22023';
    end if;

    if jsonb_typeof(v_row_payload->'basisValues') is distinct from 'array'
      or jsonb_array_length(v_row_payload->'basisValues') <> v_window - 1 then
      raise exception 'Issued forecast row % has an invalid basis window.', v_row.ordinal
        using errcode = '22023';
    end if;
    if (
      select count(distinct basis_item.value->>'periodKey')
      from jsonb_array_elements(v_row_payload->'basisValues') as basis_item(value)
    ) <> v_window - 1 then
      raise exception 'Issued forecast row % has duplicate basis periods.', v_row.ordinal
        using errcode = '22023';
    end if;

    for v_basis in
      select basis_item.value as payload, basis_item.ordinality::integer as ordinal
      from jsonb_array_elements(v_row_payload->'basisValues') with ordinality
        as basis_item(value, ordinality)
      order by basis_item.ordinality
    loop
      if jsonb_typeof(v_basis.payload) <> 'object' or not (
        v_basis.payload ? 'periodKey' and v_basis.payload ? 'targetDate'
        and v_basis.payload ? 'value' and v_basis.payload ? 'source'
      ) or exists (
        select 1
        from jsonb_object_keys(v_basis.payload) as basis_key(key)
        where basis_key.key not in ('periodKey', 'targetDate', 'value', 'source')
      ) or jsonb_typeof(v_basis.payload->'value') is distinct from 'number'
        or coalesce(v_basis.payload->>'source', '') not in ('actual', 'predicted') then
        raise exception 'Issued forecast row % has an invalid basis value.', v_row.ordinal
          using errcode = '22023';
      end if;

      v_basis_target_date_text := v_basis.payload->>'targetDate';
      if coalesce(v_basis_target_date_text, '') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Issued forecast row % has an invalid basis date.', v_row.ordinal
          using errcode = '22023';
      end if;
      begin
        v_basis_target_date := v_basis_target_date_text::date;
      exception when others then
        raise exception 'Issued forecast row % has an invalid basis date.', v_row.ordinal
          using errcode = '22023';
      end;
      if v_basis_target_date::text <> v_basis_target_date_text then
        raise exception 'Issued forecast row % has an invalid basis date.', v_row.ordinal
          using errcode = '22023';
      end if;
      v_expected_period_key := case v_period
        when 'day' then v_basis_target_date::text
        when 'month' then to_char(v_basis_target_date, 'YYYY-MM')
        when 'week' then (v_basis_target_date - (extract(isodow from v_basis_target_date)::integer - 1))::text
      end;
      if coalesce(v_basis.payload->>'periodKey', '') <> v_expected_period_key then
        raise exception 'Issued forecast row % basis period key does not match its date.', v_row.ordinal
          using errcode = '22023';
      end if;
    end loop;
  end loop;

  -- Validate the v1 history bridge. It is inserted in the same transaction so
  -- legacy history readers see either the complete issued batch or no batch.
  for v_snapshot in
    select snapshot_item.value as payload, snapshot_item.ordinality::integer as ordinal
    from jsonb_array_elements(p_snapshots) with ordinality
      as snapshot_item(value, ordinality)
    order by snapshot_item.ordinality
  loop
    v_snapshot_payload := v_snapshot.payload;
    v_snapshot_row := p_batch->'rows'->(v_snapshot.ordinal - 1);
    if jsonb_typeof(v_snapshot_payload) <> 'object' or not (
      v_snapshot_payload ? 'schema' and v_snapshot_payload ? 'id'
      and v_snapshot_payload ? 'stockCode' and v_snapshot_payload ? 'period'
      and v_snapshot_payload ? 'targetDate' and v_snapshot_payload ? 'inputMaWindow'
      and v_snapshot_payload ? 'inputMaValue' and v_snapshot_payload ? 'predictedClose'
      and v_snapshot_payload ? 'predictedMaValues' and v_snapshot_payload ? 'note'
      and v_snapshot_payload ? 'savedAt' and v_snapshot_payload ? 'issuedForecast'
    ) or exists (
      select 1
      from jsonb_object_keys(v_snapshot_payload) as snapshot_key(key)
      where snapshot_key.key not in (
        'schema', 'id', 'stockCode', 'period', 'targetDate', 'inputMaWindow',
        'inputMaValue', 'predictedClose', 'predictedMaValues', 'note',
        'savedAt', 'issuedForecast'
      )
    ) then
      raise exception 'Issued forecast snapshot % has missing or unsupported fields.', v_snapshot.ordinal
        using errcode = '22023';
    end if;

    v_snapshot_meta := v_snapshot_payload->'issuedForecast';
    if jsonb_typeof(v_snapshot_meta) is distinct from 'object' or not (
      v_snapshot_meta ? 'schema' and v_snapshot_meta ? 'batchSchema'
      and v_snapshot_meta ? 'batchId' and v_snapshot_meta ? 'revision'
      and v_snapshot_meta ? 'asOfDate' and v_snapshot_meta ? 'asOfPeriodKey'
      and v_snapshot_meta ? 'issuedAt' and v_snapshot_meta ? 'rowCount'
      and v_snapshot_meta ? 'fingerprint' and v_snapshot_meta ? 'source'
      and v_snapshot_meta ? 'rowId' and v_snapshot_meta ? 'periodKey'
      and v_snapshot_meta ? 'horizon' and v_snapshot_meta ? 'previousSumAtIssue'
      and v_snapshot_meta ? 'basisValues'
    ) or exists (
      select 1
      from jsonb_object_keys(v_snapshot_meta) as meta_key(key)
      where meta_key.key not in (
        'schema', 'batchSchema', 'batchId', 'revision', 'asOfDate',
        'asOfPeriodKey', 'issuedAt', 'rowCount', 'fingerprint', 'source',
        'rowId', 'periodKey', 'horizon', 'previousSumAtIssue', 'basisValues'
      )
    ) then
      raise exception 'Issued forecast snapshot % has invalid bridge metadata.', v_snapshot.ordinal
        using errcode = '22023';
    end if;

    if v_fingerprint is null then
      v_fingerprint := v_snapshot_meta->>'fingerprint';
      if coalesce(v_fingerprint, '') !~ '^[0-9a-f]{32}$' then
        raise exception 'Issued forecast snapshots have an invalid fingerprint.' using errcode = '22023';
      end if;
    elsif v_snapshot_meta->>'fingerprint' is distinct from v_fingerprint then
      raise exception 'Issued forecast snapshots do not share one fingerprint.' using errcode = '22023';
    end if;

    select coalesce(jsonb_object_agg(ma_value.key, ma_value.value), '{}'::jsonb)
      into v_expected_snapshot_ma_values
    from jsonb_each(v_snapshot_row->'predictedMaValues') as ma_value(key, value)
    where jsonb_typeof(ma_value.value) <> 'null';

    v_snapshot_id := v_snapshot_payload->>'id';
    if v_snapshot_payload->>'schema' is distinct from 'gupiao-forecast-history/v1'
      or v_snapshot_id is distinct from concat(
        'issued:', v_fingerprint, ':', v_snapshot_row->>'id'
      )
      or v_snapshot_payload->>'stockCode' is distinct from v_stock_code
      or v_snapshot_payload->>'period' is distinct from v_period
      or v_snapshot_payload->>'targetDate' is distinct from v_snapshot_row->>'targetDate'
      or v_snapshot_payload->'inputMaWindow' is distinct from to_jsonb(v_window)
      or v_snapshot_payload->'inputMaValue' is distinct from v_snapshot_row->'inputMaValue'
      or v_snapshot_payload->'predictedClose' is distinct from v_snapshot_row->'predictedClose'
      or jsonb_typeof(v_snapshot_payload->'predictedMaValues') is distinct from 'object'
      or v_snapshot_payload->'predictedMaValues' is distinct from v_expected_snapshot_ma_values
      or v_snapshot_payload->'note' is distinct from v_snapshot_row->'note'
      or v_snapshot_payload->>'savedAt' is distinct from v_issued_at_text
      or v_snapshot_meta->>'schema' is distinct from 'gupiao-issued-forecast-history-bridge/v1'
      or v_snapshot_meta->>'batchSchema' is distinct from p_batch->>'schema'
      or v_snapshot_meta->>'batchId' is distinct from v_batch_id
      or v_snapshot_meta->>'revision' is distinct from v_revision
      or v_snapshot_meta->>'asOfDate' is distinct from v_as_of_date_text
      or v_snapshot_meta->>'asOfPeriodKey' is distinct from v_as_of_period_key
      or v_snapshot_meta->>'issuedAt' is distinct from v_issued_at_text
      or v_snapshot_meta->'rowCount' is distinct from to_jsonb(v_row_count)
      or v_snapshot_meta->>'source' is distinct from p_source
      or v_snapshot_meta->>'rowId' is distinct from v_snapshot_row->>'id'
      or v_snapshot_meta->>'periodKey' is distinct from v_snapshot_row->>'periodKey'
      or v_snapshot_meta->'horizon' is distinct from v_snapshot_row->'horizon'
      or v_snapshot_meta->'previousSumAtIssue' is distinct from v_snapshot_row->'previousSumAtIssue'
      or v_snapshot_meta->'basisValues' is distinct from v_snapshot_row->'basisValues' then
      raise exception 'Issued forecast snapshot % does not belong to this batch row.', v_snapshot.ordinal
        using errcode = '22023';
    end if;
  end loop;

  -- ON CONFLICT serializes concurrent submissions of the same account/batch.
  insert into public.user_issued_forecast_batches (
    user_id, batch_id, stock_code, period, input_ma_window, as_of_date,
    source, batch_payload, snapshot_payloads
  ) values (
    v_user_id, v_batch_id, v_stock_code, v_period, v_window, v_as_of_date,
    p_source, p_batch, p_snapshots
  )
  on conflict (user_id, batch_id) do nothing
  returning
    user_issued_forecast_batches.server_sequence,
    user_issued_forecast_batches.batch_payload,
    user_issued_forecast_batches.snapshot_payloads,
    user_issued_forecast_batches.source,
    user_issued_forecast_batches.persisted_at
  into
    v_stored_sequence,
    v_stored_payload,
    v_stored_snapshots,
    v_stored_source,
    v_stored_persisted_at;

  if not found then
    select
      stored.server_sequence,
      stored.batch_payload,
      stored.snapshot_payloads,
      stored.source,
      stored.persisted_at
    into
      v_stored_sequence,
      v_stored_payload,
      v_stored_snapshots,
      v_stored_source,
      v_stored_persisted_at
    from public.user_issued_forecast_batches as stored
    where stored.user_id = v_user_id and stored.batch_id = v_batch_id;
  end if;

  if v_stored_sequence is null then
    raise exception 'Issued forecast batch could not be persisted.' using errcode = '55000';
  end if;
  if v_stored_payload is distinct from p_batch
    or v_stored_snapshots is distinct from p_snapshots
    or v_stored_source is distinct from p_source then
    raise exception 'Issued forecast batch id already exists with different content.'
      using errcode = '23505';
  end if;

  -- Insert each bridge snapshot without ever overwriting an existing history
  -- row. Same id/same payload is idempotent; any conflict fails the transaction.
  for v_snapshot in
    select snapshot_item.value as payload
    from jsonb_array_elements(p_snapshots) as snapshot_item(value)
  loop
    v_snapshot_payload := v_snapshot.payload;
    v_snapshot_id := v_snapshot_payload->>'id';
    insert into public.user_forecast_history (
      user_id, stock_code, period, snapshot_id, target_date, payload
    ) values (
      v_user_id,
      v_stock_code,
      v_period,
      v_snapshot_id,
      (v_snapshot_payload->>'targetDate')::date,
      v_snapshot_payload
    )
    on conflict (user_id, snapshot_id) do nothing;

    select history.stock_code, history.period, history.target_date, history.payload
    into v_history_stock_code, v_history_period, v_history_target_date, v_history_payload
    from public.user_forecast_history as history
    where history.user_id = v_user_id and history.snapshot_id = v_snapshot_id;

    if v_history_payload is null
      or v_history_stock_code is distinct from v_stock_code
      or v_history_period is distinct from v_period
      or v_history_target_date is distinct from (v_snapshot_payload->>'targetDate')::date
      or v_history_payload is distinct from v_snapshot_payload then
      raise exception 'Forecast history snapshot id already exists with different content.'
        using errcode = '23505';
    end if;
  end loop;

  server_sequence := v_stored_sequence;
  batch_payload := v_stored_payload;
  source := v_stored_source;
  persisted_at := v_stored_persisted_at;
  return next;
end;
$$;

create or replace function public.get_my_issued_forecast_batches_v2()
returns table (
  server_sequence bigint,
  batch_payload jsonb,
  source text,
  persisted_at timestamptz
)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  return query
  select
    batches.server_sequence,
    batches.batch_payload,
    batches.source,
    batches.persisted_at
  from public.user_issued_forecast_batches as batches
  where batches.user_id = auth.uid()
  order by batches.server_sequence;
end;
$$;

revoke all on table public.user_issued_forecast_batches from public, anon, authenticated;
grant select on table public.user_issued_forecast_batches to authenticated;

revoke all on sequence public.user_issued_forecast_batches_server_sequence_seq
  from public, anon, authenticated;

-- Supabase may add direct anon/authenticated EXECUTE grants when a function is
-- created. Revoke all three explicitly, then grant only the authenticated RPCs.
revoke all on function public.reject_issued_forecast_batch_mutation_v2()
  from public, anon, authenticated;
revoke all on function public.insert_my_issued_forecast_batch_v2(jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.get_my_issued_forecast_batches_v2()
  from public, anon, authenticated;

grant execute on function public.insert_my_issued_forecast_batch_v2(jsonb, jsonb, text)
  to authenticated;
grant execute on function public.get_my_issued_forecast_batches_v2()
  to authenticated;

commit;
