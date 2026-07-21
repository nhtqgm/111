-- Register one queried code and return the account's complete canonical list
-- in the same transaction. This prevents overlapping UI requests from
-- replacing a previously queried code with a stale in-memory list.

create or replace function public.remember_and_get_my_stock_codes(p_stock_code text)
returns table (stock_code text, last_opened_at timestamptz)
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
  on conflict on constraint user_stock_codes_pkey do update
    set last_opened_at = now();

  return query
  select registry.stock_code, registry.last_opened_at
  from public.user_stock_codes registry
  where registry.user_id = auth.uid()
  order by registry.stock_code;
end;
$$;

revoke all on function public.remember_and_get_my_stock_codes(text) from public;
grant execute on function public.remember_and_get_my_stock_codes(text) to authenticated;
