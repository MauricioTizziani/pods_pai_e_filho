-- Repasses continuam indivisíveis por venda. A prévia é somente leitura;
-- a confirmação compara todos os valores apresentados sob as mesmas travas.
begin;

create function public.preview_transfers(p_sale_ids uuid[], p_batch_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_sale public.sales_overview%rowtype;
  v_item record;
  v_portions jsonb;
  v_sales jsonb := '[]'::jsonb;
  v_total numeric(14,2) := 0;
  v_sale_total numeric(14,2);
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not public.has_write_access() then raise exception 'Sem permissão para confirmar repasses'; end if;
  if p_sale_ids is null or cardinality(p_sale_ids) = 0 or cardinality(p_sale_ids) > 1000 then
    raise exception 'Selecione de 1 a 1000 vendas';
  end if;
  select array_agg(distinct id order by id) into v_ids from unnest(p_sale_ids) id where id is not null;
  if cardinality(v_ids) is distinct from cardinality(p_sale_ids) then
    raise exception 'Seleção de vendas inválida ou com repetições';
  end if;
  if p_batch_id is not null and not exists (select 1 from public.purchase_batches where id = p_batch_id) then
    raise exception 'Lote não encontrado';
  end if;
  if (select count(*) from public.sales where id = any(v_ids)) <> cardinality(v_ids) then
    raise exception 'Uma ou mais vendas não foram encontradas';
  end if;

  for v_sale in select * from public.sales_overview where id = any(v_ids) order by id loop
    if not v_sale.transfer_due_now then
      raise exception 'A venda de % não está em "A enviar ao pai agora". Atualize os dados.', v_sale.customer_name;
    end if;
    if p_batch_id is not null and not exists (
      select 1 from public.sale_items si
      join public.sale_item_batch_allocations a on a.sale_item_id = si.id and a.reversed_at is null
      join public.batch_items bi on bi.id = a.batch_item_id
      where si.sale_id = v_sale.id and bi.batch_id = p_batch_id
    ) then
      raise exception 'A seleção contém venda fora do lote selecionado. Atualize os dados.';
    end if;

    -- Somente snapshots da operação: não consultar o cadastro atual de preços.
    for v_item in
      select si.id, si.quantity, si.unit_transfer, si.line_transfer,
        coalesce(sum(a.quantity),0) as allocated_quantity,
        coalesce(sum(a.quantity::numeric * a.unit_transfer),0) as allocated_transfer
      from public.sale_items si
      left join public.sale_item_batch_allocations a on a.sale_item_id = si.id and a.reversed_at is null
      where si.sale_id = v_sale.id
      group by si.id
    loop
      if v_item.allocated_quantity > v_item.quantity or v_item.allocated_transfer > v_item.line_transfer
        or (v_item.allocated_quantity = v_item.quantity and v_item.allocated_transfer <> v_item.line_transfer)
        or (v_item.allocated_quantity < v_item.quantity and
          v_item.allocated_transfer + (v_item.quantity - v_item.allocated_quantity)::numeric * v_item.unit_transfer <> v_item.line_transfer) then
        raise exception 'Os valores históricos dos vínculos da venda de % estão inconsistentes. Confira a origem antes de confirmar.', v_sale.customer_name;
      end if;
    end loop;

    with item_amounts as (
      select si.id, si.quantity, si.line_transfer,
        coalesce(sum(a.quantity),0) as allocated_quantity,
        coalesce(sum(a.quantity::numeric * a.unit_transfer),0) as allocated_transfer
      from public.sale_items si
      left join public.sale_item_batch_allocations a on a.sale_item_id = si.id and a.reversed_at is null
      where si.sale_id = v_sale.id group by si.id
    ), portions as (
      select b.id as batch_id, b.batch_number,
        sum(a.quantity::numeric * a.unit_transfer) as amount
      from public.sale_items si
      join public.sale_item_batch_allocations a on a.sale_item_id = si.id and a.reversed_at is null
      join public.batch_items bi on bi.id = a.batch_item_id
      join public.purchase_batches b on b.id = bi.batch_id
      where si.sale_id = v_sale.id group by b.id
      union all
      -- Quantidades sem vínculo já pertenciam ao histórico sem lote.
      select null::uuid, null::bigint, sum(line_transfer - allocated_transfer)
      from item_amounts where allocated_quantity < quantity
      having count(*) > 0
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'batchId', batch_id,
      'label', case when batch_id is null then 'Sem lote (histórico)'
                    else 'Lote ' || lpad(batch_number::text, greatest(3,length(batch_number::text)), '0') end,
      'amount', amount::numeric(14,2)::text
    ) order by batch_number nulls last, batch_id), '[]'::jsonb), coalesce(sum(amount),0)::numeric(14,2)
    into v_portions, v_sale_total from portions;

    if jsonb_array_length(v_portions) = 0 or v_sale_total <> v_sale.transfer_amount then
      raise exception 'O detalhamento histórico da venda de % não confere com o total. Atualize e confira a origem.', v_sale.customer_name;
    end if;
    v_sales := v_sales || jsonb_build_array(jsonb_build_object(
      'id',v_sale.id, 'customerName',v_sale.customer_name,
      'total',v_sale.transfer_amount::numeric(14,2)::text, 'portions',v_portions
    ));
    v_total := v_total + v_sale.transfer_amount;
  end loop;

  return jsonb_build_object('batchValue',coalesce(p_batch_id::text,'todos'),
    'saleIds',to_jsonb(v_ids), 'total',v_total::text, 'sales',v_sales);
end;
$$;

create function public.confirm_transfers_preview(p_sale_ids uuid[], p_notes text, p_expected_preview jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid;
  v_current jsonb;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  if not public.has_write_access() then raise exception 'Sem permissão para confirmar repasses'; end if;
  if jsonb_typeof(p_expected_preview) is distinct from 'object'
    or coalesce(p_expected_preview->>'batchValue','') = '' then
    raise exception 'Confira o valor integral e os lotes afetados antes de confirmar o repasse';
  end if;
  if p_expected_preview->>'batchValue' <> 'todos' then
    if (p_expected_preview->>'batchValue') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Lote inválido';
    end if;
    v_batch := (p_expected_preview->>'batchValue')::uuid;
  end if;
  if p_sale_ids is null or cardinality(p_sale_ids) = 0 or cardinality(p_sale_ids) > 1000 then
    raise exception 'Selecione de 1 a 1000 vendas';
  end if;

  -- Edição, recebimento, cancelamento e correção de origem também travam a
  -- venda primeiro. Assim nenhuma mudança financeira passa entre conferir e pagar.
  perform 1 from public.sales where id = any(p_sale_ids) order by id for update;
  perform 1 from public.sale_items where sale_id = any(p_sale_ids) order by id for update;
  perform 1 from public.sale_item_batch_allocations a
    where a.sale_item_id in (select id from public.sale_items where sale_id = any(p_sale_ids))
    order by a.id for share;
  perform 1 from public.purchase_batches b where b.id = v_batch or b.id in (
    select bi.batch_id from public.batch_items bi
    join public.sale_item_batch_allocations a on a.batch_item_id = bi.id
    join public.sale_items si on si.id = a.sale_item_id where si.sale_id = any(p_sale_ids)
  ) order by b.id for share;
  perform 1 from public.batch_items bi where bi.id in (
    select a.batch_item_id from public.sale_item_batch_allocations a
    join public.sale_items si on si.id = a.sale_item_id where si.sale_id = any(p_sale_ids)
  ) order by bi.id for share;
  perform 1 from public.payment_statuses where id in (
    select payment_status_id from public.sales where id = any(p_sale_ids)
  ) order by id for share;

  v_current := public.preview_transfers(p_sale_ids, v_batch);
  if v_current is distinct from p_expected_preview then
    raise exception 'Os repasses mudaram desde a conferência. Atualize os dados e confira novamente os valores e lotes antes de confirmar.';
  end if;
  -- Mantém integralmente as regras, o registro e a auditoria do pagamento existente.
  return public.confirm_transfers(p_sale_ids, p_notes);
end;
$$;

revoke all on function public.preview_transfers(uuid[],uuid) from public, anon;
revoke all on function public.confirm_transfers_preview(uuid[],text,jsonb) from public, anon;
grant execute on function public.preview_transfers(uuid[],uuid) to authenticated;
grant execute on function public.confirm_transfers_preview(uuid[],text,jsonb) to authenticated;
-- O cliente não pode contornar a conferência usando o endpoint antigo.
revoke execute on function public.confirm_transfers(uuid[],text) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
