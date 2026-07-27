-- Explicit, authenticated reset for one stock and one K-line period.
--
-- Draft values, legacy/history bridge rows, and every submitted MA revision in
-- the selected scope are deleted atomically. Market K-lines, stock registry,
-- workspace preferences, other periods, and other stocks are intentionally
-- outside this function.

begin;

create or replace function public.reset_my_forecast_scope_v1(
  p_stock_code text,
  p_period text,
  p_expected_user_id uuid
)
returns table (
  prediction_values_deleted bigint,
  forecast_history_deleted bigint,
  issued_batches_deleted bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_prediction_values_deleted bigint := 0;
  v_forecast_history_deleted bigint := 0;
  v_issued_batches_deleted bigint := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_expected_user_id is null or p_expected_user_id is distinct from v_user_id then
    raise exception 'Cloud account changed during forecast reset.' using errcode = '42501';
  end if;
  if p_stock_code is null or p_stock_code !~ '^\d{6}$'
    or p_period is null or p_period not in ('day', 'week', 'month') then
    raise exception 'Invalid forecast reset scope.' using errcode = '22023';
  end if;

  -- Take a stable cross-table cut. Issued batches come first to serialize with
  -- immutable submissions; prediction values then history matches the existing
  -- full-workspace import order. These locks are held only for this short reset
  -- transaction and prevent a concurrent writer from leaving an orphan bridge.
  lock table public.user_issued_forecast_batches in share row exclusive mode;
  lock table public.user_prediction_values in share row exclusive mode;
  lock table public.user_forecast_history in share row exclusive mode;

  delete from public.user_prediction_values
  where user_id = v_user_id
    and stock_code = p_stock_code
    and period = p_period;
  get diagnostics v_prediction_values_deleted = row_count;

  delete from public.user_forecast_history
  where user_id = v_user_id
    and stock_code = p_stock_code
    and period = p_period;
  get diagnostics v_forecast_history_deleted = row_count;

  -- Submitted rows stay immutable during normal use. This explicit reset is
  -- the only authenticated path that may remove all revisions in one scope.
  delete from public.user_issued_forecast_batches
  where user_id = v_user_id
    and stock_code = p_stock_code
    and period = p_period;
  get diagnostics v_issued_batches_deleted = row_count;

  prediction_values_deleted := v_prediction_values_deleted;
  forecast_history_deleted := v_forecast_history_deleted;
  issued_batches_deleted := v_issued_batches_deleted;
  return next;
end;
$$;

revoke all on function public.reset_my_forecast_scope_v1(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.reset_my_forecast_scope_v1(text, text, uuid)
  to authenticated;

commit;
