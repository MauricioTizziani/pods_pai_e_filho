create or replace function public.open_credit_summary()
returns table (
  open_credit_count bigint,
  receivable_amount numeric(14, 2),
  transfer_pending numeric(14, 2)
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not public.has_write_access() then
    raise exception 'Sem permissão para consultar Fiados';
  end if;

  return query
  select
    count(*)::bigint,
    coalesce(sum(s.total_amount) filter (where s.counts_as_receivable and not s.counts_as_received), 0)::numeric(14, 2),
    coalesce(sum(s.transfer_amount) filter (where s.transfer_due_now), 0)::numeric(14, 2)
  from public.sales_overview s
  where s.is_credit
    and s.counts_as_receivable
    and s.is_valid;
end;
$$;

revoke all on function public.open_credit_summary() from public;
grant execute on function public.open_credit_summary() to authenticated;
