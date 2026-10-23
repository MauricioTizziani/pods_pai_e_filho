-- Correções explícitas: prévia persistida, confirmação atômica e razão obrigatória.
alter table public.purchase_batches
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references public.profiles(id) on delete set null;
alter table public.batch_items
  add column updated_at timestamptz not null default now(),
  add column updated_by uuid references public.profiles(id) on delete set null;

insert into public.movement_types(code, name, direction, manual) values
  ('CORRECAO_ENTRADA', 'Correção auditada de entrada', 1, false),
  ('CORRECAO_SAIDA', 'Correção auditada de saída', -1, false),
  ('REALOCACAO_DEVOLUCAO', 'Correção de lote: devolução à origem', 1, false),
  ('REALOCACAO_CONSUMO', 'Correção de lote: consumo no destino', -1, false);

create table public.batch_correction_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('entry', 'allocation')),
  batch_id uuid not null references public.purchase_batches(id) on delete restrict,
  payload jsonb not null,
  summary jsonb not null,
  expected_state jsonb not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid references public.profiles(id) on delete restrict,
  reason text,
  result_state jsonb,
  check ((confirmed_at is null and confirmed_by is null and reason is null and result_state is null)
    or (confirmed_at is not null and confirmed_by is not null and length(trim(reason)) > 0 and result_state is not null))
);
create index batch_correction_requests_batch_idx on public.batch_correction_requests(batch_id, created_at desc);
alter table public.batch_correction_requests enable row level security;
create policy batch_correction_requests_read on public.batch_correction_requests
  for select to authenticated using (created_by = auth.uid() and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role_code = 'admin'
  ));
revoke all on public.batch_correction_requests from public, anon, authenticated;
grant select on public.batch_correction_requests to authenticated;

-- A auditoria desta operação inclui custos e lucros completos, inclusive do filho.
-- Não ampliar por esse caminho as informações disponíveis ao perfil CONSULTAS.
drop policy audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select to authenticated using (
  action not in ('batch.entry_corrected','batch.allocation_corrected','sale.batch_corrected')
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role_code = 'admin')
);

create function public.require_batch_correction_admin()
returns uuid language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or not exists (
    select 1 from public.profiles where id = v_user and role_code = 'admin'
  ) then raise exception 'Somente ADMIN pode corrigir lotes'; end if;
  return v_user;
end;
$$;

-- Uma requisição confirmada e as movimentações de compensação são imutáveis.
create function public.protect_batch_correction_history()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'stock_movements' then
    if old.movement_type in ('CORRECAO_ENTRADA', 'CORRECAO_SAIDA', 'REALOCACAO_DEVOLUCAO', 'REALOCACAO_CONSUMO') then
      raise exception 'Movimentação de correção é imutável; registre outra correção auditada';
    end if;
  else
    if tg_op = 'DELETE' or old.confirmed_at is not null then
      raise exception 'Histórico de correção é imutável';
    end if;
    if (to_jsonb(new) - array['confirmed_at','confirmed_by','reason','result_state'])
       is distinct from (to_jsonb(old) - array['confirmed_at','confirmed_by','reason','result_state']) then
      raise exception 'A prévia de uma correção é imutável';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger stock_movements_correction_immutable before update or delete on public.stock_movements
  for each row execute function public.protect_batch_correction_history();
create trigger batch_correction_requests_immutable before update or delete on public.batch_correction_requests
  for each row execute function public.protect_batch_correction_history();

-- Locks de variante são os mesmos usados pelo FIFO. Nunca decidir pelo saldo enviado pela tela.
-- Retorna tanto a apresentação quanto a prova exata do estado usado na decisão.
create function public.prepare_batch_entry_correction(p_batch_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_batch public.purchase_batches%rowtype;
  v_item jsonb;
  v_old public.batch_items%rowtype;
  v_variant public.product_variants%rowtype;
  v_quantity integer;
  v_cost numeric(14,2);
  v_date date;
  v_notes text;
  v_id uuid;
  v_delta integer;
  v_remaining integer;
  v_global integer;
  v_unassigned integer;
  v_total_delta integer := 0;
  v_variant_delta record;
  v_changes jsonb := '[]'::jsonb;
  v_state jsonb;
  v_label text;
begin
  perform public.require_batch_correction_admin();
  if jsonb_typeof(payload) is distinct from 'object'
    or jsonb_typeof(payload->'items') is distinct from 'array' then
    raise exception 'Informe os dados do lote e seus itens';
  end if;
  if jsonb_array_length(payload->'items') = 0 then raise exception 'O lote precisa de ao menos um item'; end if;
  if coalesce(payload->>'purchase_date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Data da compra inválida'; end if;
  v_date := (payload->>'purchase_date')::date;
  if v_date > current_date then raise exception 'A data da compra não pode ser futura'; end if;
  if payload ? 'notes' and jsonb_typeof(payload->'notes') not in ('string','null') then raise exception 'Observação inválida'; end if;
  v_notes := nullif(trim(payload->>'notes'), '');
  if length(coalesce(v_notes,'')) > 10000 then raise exception 'Observação muito longa'; end if;
  for v_item in select value from jsonb_array_elements(payload->'items') loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or jsonb_typeof(v_item->'quantity') is distinct from 'number'
      or coalesce(v_item->>'quantity','') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(v_item->'unit_cost') is distinct from 'number'
      or coalesce(v_item->>'unit_cost','') !~ '^[0-9]+(\.[0-9]{1,2})?$'
      or nullif(v_item->>'variant_id','') is null then
      raise exception 'Informe sabor, quantidade inteira positiva e custo não negativo com até duas casas';
    end if;
    v_quantity := (v_item->>'quantity')::integer;
    v_cost := (v_item->>'unit_cost')::numeric(14,2);
    perform (v_item->>'variant_id')::uuid;
    perform nullif(v_item->>'batch_item_id','')::uuid;
  end loop;
  if exists (select 1 from jsonb_array_elements(payload->'items') e
    where nullif(e->>'batch_item_id','') is not null
    group by e->>'batch_item_id' having count(*) > 1) then raise exception 'Item repetido na correção'; end if;

  perform 1 from public.product_variants v where v.id in (
    select (e->>'variant_id')::uuid from jsonb_array_elements(payload->'items') e
    union select bi.variant_id from public.batch_items bi where bi.batch_id = p_batch_id
  ) order by v.id for update;
  select * into v_batch from public.purchase_batches where id = p_batch_id for update;
  if not found then raise exception 'Lote não encontrado'; end if;
  if v_batch.status <> 'ABERTO' then raise exception 'Somente lotes ABERTOS podem ser editados'; end if;
  perform 1 from public.batch_items where batch_id = p_batch_id order by id for update;
  if exists (select 1 from public.batch_items bi where bi.batch_id = p_batch_id and not exists (
    select 1 from jsonb_array_elements(payload->'items') e where nullif(e->>'batch_item_id','')::uuid = bi.id
  )) then raise exception 'Não é permitido excluir itens do lote; envie todos os itens existentes'; end if;
  if v_date is distinct from v_batch.purchase_date and (exists (select 1 from public.stock_movements m where m.batch_id = p_batch_id
    and m.movement_type not in ('ENTRADA_COMPRA','ENTRADA_LEGADO') and m.movement_date < v_date)
    or exists (select 1 from public.sale_item_batch_allocations a
      join public.batch_items bi on bi.id = a.batch_item_id
      join public.sale_items si on si.id = a.sale_item_id join public.sales s on s.id = si.sale_id
      where bi.batch_id = p_batch_id and s.sale_date < v_date)) then
    raise exception 'A data da compra não pode ser posterior a vendas ou movimentações já registradas neste lote';
  end if;
  if v_date is distinct from v_batch.purchase_date then
    v_changes := v_changes || jsonb_build_array(jsonb_build_object('label','Data da compra','before',v_batch.purchase_date,'after',v_date,'unit','text'));
  end if;
  if v_notes is distinct from v_batch.notes then
    v_changes := v_changes || jsonb_build_array(jsonb_build_object('label','Observações','before',v_batch.notes,'after',v_notes,'unit','text'));
  end if;
  for v_item in select value from jsonb_array_elements(payload->'items') loop
    v_id := nullif(v_item->>'batch_item_id','')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_cost := (v_item->>'unit_cost')::numeric(14,2);
    select * into v_variant from public.product_variants where id = (v_item->>'variant_id')::uuid;
    if not found then raise exception 'Sabor não encontrado'; end if;
    v_label := (select name from public.products where id = v_variant.product_id) || ' · ' || public.flavor_display_name(v_variant.name, v_variant.is_ice);
    if v_id is not null then
      select * into v_old from public.batch_items where id = v_id and batch_id = p_batch_id;
      if not found then raise exception 'Item não pertence ao lote'; end if;
      if v_old.variant_id <> v_variant.id or v_old.product_id <> v_variant.product_id then
        raise exception 'Não é permitido trocar produto ou sabor de um item existente';
      end if;
      if v_cost <> v_old.unit_cost and (exists (
        select 1 from public.sale_item_batch_allocations where batch_item_id = v_id
      ) or exists (select 1 from public.stock_movements where batch_item_id = v_id and sale_id is not null)) then
        raise exception 'O custo de um item com histórico de venda exige correção histórica específica';
      end if;
      select quantity_remaining into v_remaining from public.batch_item_balances where batch_item_id = v_id;
      v_delta := v_quantity - v_old.quantity_purchased;
      if v_delta <> 0 and v_remaining + v_delta < 0 then raise exception 'A quantidade de % não comporta as saídas já registradas. Saldo: %', v_label, v_remaining; end if;
      if v_delta <> 0 then
        v_changes := v_changes || jsonb_build_array(
          jsonb_build_object('label',v_label || ' — entrada','before',v_old.quantity_purchased,'after',v_quantity,'unit','quantity'),
          jsonb_build_object('label',v_label || ' — saldo','before',v_remaining,'after',v_remaining + v_delta,'unit','quantity'));
      end if;
      if v_cost <> v_old.unit_cost then
        v_changes := v_changes || jsonb_build_array(jsonb_build_object('label',v_label || ' — custo unitário','before',v_old.unit_cost,'after',v_cost,'unit','money'));
      end if;
    else
      if not v_variant.active or not exists (select 1 from public.products where id = v_variant.product_id and active) then
        raise exception 'Produto ou sabor inativo não pode ser adicionado';
      end if;
      if (select count(*) from jsonb_array_elements(payload->'items') e where (e->>'variant_id')::uuid = v_variant.id) > 1
        or exists (select 1 from public.batch_items where batch_id = p_batch_id and variant_id = v_variant.id) then
        raise exception 'Este sabor já consta no lote; corrija a quantidade do item existente';
      end if;
      v_delta := v_quantity;
      v_changes := v_changes || jsonb_build_array(
        jsonb_build_object('label',v_label || ' — novo item da compra original','before',0,'after',v_quantity,'unit','quantity'),
        jsonb_build_object('label',v_label || ' — custo unitário','before',null,'after',v_cost,'unit','money'));
    end if;
    v_total_delta := v_total_delta + v_delta;
  end loop;
  if not v_batch.is_legacy and exists (
    select 1 from jsonb_array_elements(payload->'items') e
    left join public.batch_items bi on bi.id = nullif(e->>'batch_item_id','')::uuid
    where bi.id is null or (e->>'quantity')::integer <> bi.quantity_purchased
  ) and (payload->'same_purchase_confirmed') is distinct from 'true'::jsonb then
    raise exception 'Confirme que os itens e quantidades corrigidos pertencem à mesma compra original. Uma nova compra deve gerar outro lote';
  end if;
  -- Lotes antigos podem ter mais de uma linha do mesmo sabor. Validar a soma,
  -- pois duas correções isoladamente válidas podem exceder o saldo sem lote.
  for v_variant_delta in
    select (e->>'variant_id')::uuid as variant_id,
      sum((e->>'quantity')::integer - coalesce(bi.quantity_purchased,0))::integer as delta
    from jsonb_array_elements(payload->'items') e
    left join public.batch_items bi on bi.id = nullif(e->>'batch_item_id','')::uuid
    group by (e->>'variant_id')::uuid
  loop
    select coalesce(sum(m.quantity::bigint * mt.direction),0)::integer into v_global
      from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type
      where m.variant_id = v_variant_delta.variant_id;
    if not v_batch.is_legacy and v_variant_delta.delta <> 0 and v_global + v_variant_delta.delta < 0 then raise exception 'A correção deixaria o estoque geral negativo'; end if;
    if v_batch.is_legacy and v_variant_delta.delta > 0 then
      select v_global - coalesce(sum(quantity_remaining),0)::integer into v_unassigned
        from public.batch_item_balances where variant_id = v_variant_delta.variant_id;
      if v_unassigned < v_variant_delta.delta then raise exception 'Estoque sem lote insuficiente para complementar a classificação de legado'; end if;
    end if;
  end loop;
  if jsonb_array_length(v_changes) = 0 then raise exception 'Nenhuma alteração foi informada'; end if;
  select jsonb_build_object(
    'batch',to_jsonb(v_batch),
    'items',(select coalesce(jsonb_agg(to_jsonb(bi) order by bi.id),'[]') from public.batch_items bi where bi.batch_id = p_batch_id),
    'allocations',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.sale_item_batch_allocations a join public.batch_items bi on bi.id = a.batch_item_id where bi.batch_id = p_batch_id),
    'variant_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') from public.stock_movements m where m.variant_id in (select (e->>'variant_id')::uuid from jsonb_array_elements(payload->'items') e)),
    'variants',(select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]') from public.product_variants v where v.id in (select (e->>'variant_id')::uuid from jsonb_array_elements(payload->'items') e)),
    'sales',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]') from public.sales s where s.id in (select si.sale_id from public.sale_items si join public.sale_item_batch_allocations a on a.sale_item_id = si.id join public.batch_items bi on bi.id = a.batch_item_id where bi.batch_id = p_batch_id))
  ) into v_state;
  return jsonb_build_object('state',v_state,'summary',jsonb_build_object(
    'kind','entry','batch_id',p_batch_id,'batch_number',v_batch.batch_number,
    'description','Correção dos dados e da entrada da mesma compra original','changes',v_changes,
    'stock_delta',case when v_batch.is_legacy then 0 else v_total_delta end));
end;
$$;

create function public.prepare_sale_batch_correction(p_batch_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item public.sale_items%rowtype;
  v_sale public.sales%rowtype;
  v_source public.sale_item_batch_allocations%rowtype;
  v_origin public.batch_items%rowtype;
  v_destination public.batch_items%rowtype;
  v_batch public.purchase_batches%rowtype;
  v_source_batch public.purchase_batches%rowtype;
  v_quantity integer := (payload->>'quantity')::integer;
  v_source_id uuid := nullif(payload->>'source_allocation_id','')::uuid;
  v_allocated integer;
  v_unallocated integer;
  v_net_unbatched integer;
  v_source_remaining integer;
  v_destination_remaining integer;
  v_source_cost numeric;
  v_new_line_cost numeric(14,2);
  v_unallocated_cost numeric(14,2);
  v_delta numeric(14,2);
  v_changes jsonb;
  v_state jsonb;
begin
  perform public.require_batch_correction_admin();
  if v_quantity is null or v_quantity <= 0 then raise exception 'Quantidade deve ser inteira e positiva'; end if;
  select * into v_item from public.sale_items where id = (payload->>'sale_item_id')::uuid;
  if not found then raise exception 'Item da venda não encontrado'; end if;
  -- Venda primeiro: a edição e o cancelamento existentes usam a mesma trava.
  select * into v_sale from public.sales where id = v_item.sale_id for update;
  select * into v_item from public.sale_items where id = v_item.id for update;
  if v_sale.cancelled_at is not null then raise exception 'Venda cancelada não pode ter o lote corrigido'; end if;
  if v_sale.transfer_paid then raise exception 'O repasse desta venda já foi pago; a operação está conciliada e não permite correção de origem'; end if;
  if v_item.line_cost is null then raise exception 'O custo histórico desta venda é desconhecido; é necessária uma correção histórica específica'; end if;
  perform 1 from public.product_variants where id = v_item.variant_id for update;
  select * into v_destination from public.batch_items where id = (payload->>'destination_item_id')::uuid and batch_id = p_batch_id;
  if not found then raise exception 'Item de destino não pertence ao lote'; end if;
  if v_destination.product_id <> v_item.product_id or v_destination.variant_id <> v_item.variant_id then
    raise exception 'O destino deve ter exatamente o produto e o sabor da venda';
  end if;
  if v_source_id is not null then
    select * into v_source from public.sale_item_batch_allocations where id = v_source_id and sale_item_id = v_item.id and reversed_at is null for update;
    if not found then raise exception 'Vínculo de origem não está mais ativo'; end if;
    select * into v_origin from public.batch_items where id = v_source.batch_item_id;
    if v_origin.id = v_destination.id then raise exception 'A venda já está vinculada a este item do lote'; end if;
    if v_origin.product_id <> v_item.product_id or v_origin.variant_id <> v_item.variant_id then raise exception 'Origem da venda está inconsistente'; end if;
    if v_quantity > v_source.quantity then raise exception 'Quantidade excede a parcela vinculada à origem'; end if;
    v_source_cost := v_quantity::numeric * v_source.unit_cost;
  end if;
  perform 1 from public.purchase_batches where id in (p_batch_id, v_origin.batch_id) order by id for update;
  select * into v_batch from public.purchase_batches where id = p_batch_id;
  if v_batch.status is distinct from 'ABERTO' then raise exception 'O lote de destino precisa estar ABERTO'; end if;
  if v_source_id is not null then
    select * into v_source_batch from public.purchase_batches where id = v_origin.batch_id;
    if v_source_batch.status = 'CANCELADO' then raise exception 'Lote de origem cancelado não pode ser corrigido'; end if;
  end if;
  perform 1 from public.batch_items where id in (v_destination.id, v_origin.id) order by id for update;
  if v_sale.sale_date < v_batch.purchase_date then raise exception 'A venda ocorreu antes da entrada do lote de destino'; end if;
  select quantity_remaining into v_destination_remaining from public.batch_item_balances where batch_item_id = v_destination.id;
  if v_destination_remaining < v_quantity then raise exception 'Saldo insuficiente no lote de destino. Disponível: %', v_destination_remaining; end if;
  select coalesce(sum(quantity),0)::integer into v_allocated from public.sale_item_batch_allocations where sale_item_id = v_item.id and reversed_at is null;
  if v_allocated > v_item.quantity then raise exception 'A soma dos vínculos da venda está inconsistente'; end if;
  if exists (select 1 from public.sale_item_batch_allocations a where a.sale_item_id = v_item.id
      and a.reversed_at is null and (a.unit_price <> v_item.unit_price or a.unit_transfer <> v_item.unit_transfer))
    or (select coalesce(sum(a.quantity::numeric * a.unit_cost),0) from public.sale_item_batch_allocations a
      where a.sale_item_id = v_item.id and a.reversed_at is null) > v_item.line_cost
    or (v_allocated = v_item.quantity and (select coalesce(sum(a.quantity::numeric * a.unit_cost),0)
      from public.sale_item_batch_allocations a where a.sale_item_id = v_item.id and a.reversed_at is null) <> v_item.line_cost) then
    raise exception 'Os valores históricos dos vínculos da venda estão inconsistentes';
  end if;
  v_unallocated := v_item.quantity - v_allocated;
  if v_source_id is null then
    if v_quantity > v_unallocated then raise exception 'Quantidade excede a parcela sem lote desta venda'; end if;
    -- A venda já precisa ter uma baixa líquida no estoque sem lote. Não criar outra venda/baixa global.
    -- As correções anteriores entram na soma (devolução sem lote), assim como estornos de edição.
    select -coalesce(sum(m.quantity::bigint * mt.direction),0)::integer into v_net_unbatched
    from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type
    where m.sale_id = v_sale.id and m.product_id = v_item.product_id and m.variant_id = v_item.variant_id and m.batch_item_id is null;
    if v_net_unbatched <> (select coalesce(sum(si.quantity - (select coalesce(sum(a.quantity),0) from public.sale_item_batch_allocations a where a.sale_item_id = si.id and a.reversed_at is null)),0)::integer
      from public.sale_items si where si.sale_id = v_sale.id and si.product_id = v_item.product_id and si.variant_id = v_item.variant_id)
      or v_net_unbatched < v_quantity then
      raise exception 'Não foi encontrada uma baixa líquida sem lote compatível com esta venda; confira o histórico antes de corrigir';
    end if;
    select v_item.line_cost - coalesce(sum(a.quantity::numeric * a.unit_cost),0) into v_unallocated_cost
      from public.sale_item_batch_allocations a where a.sale_item_id = v_item.id and a.reversed_at is null;
    if v_unallocated_cost < 0 or v_unallocated = 0 then raise exception 'O custo histórico sem lote está inconsistente'; end if;
    -- Distribuir só o residual histórico, sem consultar o custo atual do produto.
    v_source_cost := round(v_unallocated_cost * v_quantity / v_unallocated, 2);
    v_source_remaining := v_net_unbatched;
  else
    select quantity_remaining into v_source_remaining from public.batch_item_balances where batch_item_id = v_origin.id;
    if (select -coalesce(sum(m.quantity::bigint * mt.direction),0)::integer
        from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type
        where m.sale_id = v_sale.id and m.product_id = v_item.product_id and m.variant_id = v_item.variant_id
          and m.batch_item_id = v_origin.id)
      <> (select coalesce(sum(a.quantity),0)::integer from public.sale_item_batch_allocations a
        join public.sale_items si on si.id = a.sale_item_id
        where si.sale_id = v_sale.id and si.product_id = v_item.product_id and si.variant_id = v_item.variant_id
          and a.batch_item_id = v_origin.id and a.reversed_at is null) then
      raise exception 'A baixa líquida do lote de origem não corresponde aos vínculos ativos desta venda; confira o histórico antes de corrigir';
    end if;
  end if;
  v_delta := (v_quantity::numeric * v_destination.unit_cost - v_source_cost)::numeric(14,2);
  v_new_line_cost := v_item.line_cost + v_delta;
  if v_new_line_cost < 0 then raise exception 'A correção deixaria o custo da venda negativo'; end if;
  v_changes := jsonb_build_array(
    jsonb_build_object('label','Venda e item','before',v_sale.customer_name || ' · ' || v_sale.sale_date::text || ' · ' || v_item.product_name || ' · ' || public.flavor_display_name(v_item.variant_name, (select is_ice from public.product_variants where id = v_item.variant_id)), 'after',v_sale.customer_name || ' · ' || v_sale.sale_date::text || ' · ' || v_item.product_name || ' · ' || public.flavor_display_name(v_item.variant_name, (select is_ice from public.product_variants where id = v_item.variant_id)),'unit','text'),
    jsonb_build_object('label','Quantidade realocada','before',v_quantity,'after',v_quantity,'unit','quantity'),
    jsonb_build_object('label','Origem das unidades','before',case when v_source_id is null then 'Sem lote' else 'Lote ' || v_source_batch.batch_number::text end,'after','Lote ' || v_batch.batch_number::text,'unit','text'),
    jsonb_build_object('label','Saldo da origem','before',case when v_source_id is null then (select coalesce(sum(m.quantity::bigint * mt.direction),0)::integer from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type where m.variant_id = v_item.variant_id and m.batch_item_id is null) else v_source_remaining end,'after',case when v_source_id is null then (select coalesce(sum(m.quantity::bigint * mt.direction),0)::integer + v_quantity from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type where m.variant_id = v_item.variant_id and m.batch_item_id is null) else v_source_remaining + v_quantity end,'unit','quantity'),
    jsonb_build_object('label','Saldo do destino','before',v_destination_remaining,'after',v_destination_remaining - v_quantity,'unit','quantity'),
    jsonb_build_object('label','Custo das unidades corrigidas','before',v_source_cost,'after',v_quantity::numeric * v_destination.unit_cost,'unit','money'),
    jsonb_build_object('label','Custo total deste item da venda','before',v_item.line_cost,'after',v_new_line_cost,'unit','money'),
    jsonb_build_object('label','Lucro do pai neste item','before',v_item.line_father_profit,'after',v_item.quantity::numeric * v_item.unit_transfer - v_new_line_cost,'unit','money'),
    jsonb_build_object('label','Resultado total deste item','before',v_item.line_total - v_item.line_cost,'after',v_item.line_total - v_new_line_cost,'unit','money'),
    jsonb_build_object('label','Lucro do filho neste item','before',v_item.line_profit,'after',v_item.line_profit,'unit','money'),
    jsonb_build_object('label','Faturamento da venda','before',v_sale.total_amount,'after',v_sale.total_amount,'unit','money'),
    jsonb_build_object('label','Repasse da venda','before',v_sale.transfer_amount,'after',v_sale.transfer_amount,'unit','money')
  );
  select jsonb_build_object(
    'sale',to_jsonb(v_sale),'sale_item',to_jsonb(v_item),
    'source_cost',v_source_cost,'new_line_cost',v_new_line_cost,
    'allocations',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.sale_item_batch_allocations a where a.sale_item_id = v_item.id),
    'batches',(select coalesce(jsonb_agg(to_jsonb(b) order by b.id),'[]') from public.purchase_batches b where b.id in (p_batch_id,v_origin.batch_id)),
    'batch_items',(select coalesce(jsonb_agg(to_jsonb(bi) order by bi.id),'[]') from public.batch_items bi where bi.batch_id in (p_batch_id,v_origin.batch_id)),
    'variant_movements',(select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') from public.stock_movements m where m.variant_id = v_item.variant_id)
  ) into v_state;
  return jsonb_build_object('state',v_state,'summary',jsonb_build_object('kind','allocation','batch_id',p_batch_id,
    'batch_number',v_batch.batch_number,'sale_id',v_sale.id,'description','Correção explícita da origem de unidades já vendidas','changes',v_changes,'stock_delta',0));
end;
$$;

create function public.preview_batch_edit(p_batch_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prepared jsonb; v_request uuid; v_user uuid := public.require_batch_correction_admin();
begin
  v_prepared := public.prepare_batch_entry_correction(p_batch_id,payload);
  insert into public.batch_correction_requests(kind,batch_id,payload,summary,expected_state,created_by)
    values ('entry',p_batch_id,payload,v_prepared->'summary',v_prepared->'state',v_user) returning id into v_request;
  return jsonb_build_object('request_id',v_request,'summary',v_prepared->'summary');
end;
$$;

create function public.preview_sale_batch_correction(p_batch_id uuid,p_sale_item_id uuid,p_source_allocation_id uuid,p_quantity integer,p_destination_item_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prepared jsonb; v_request uuid; v_user uuid := public.require_batch_correction_admin(); v_payload jsonb;
begin
  v_payload := jsonb_build_object('sale_item_id',p_sale_item_id,'source_allocation_id',p_source_allocation_id,'quantity',p_quantity,'destination_item_id',p_destination_item_id);
  v_prepared := public.prepare_sale_batch_correction(p_batch_id,v_payload);
  insert into public.batch_correction_requests(kind,batch_id,payload,summary,expected_state,created_by)
    values ('allocation',p_batch_id,v_payload,v_prepared->'summary',v_prepared->'state',v_user) returning id into v_request;
  return jsonb_build_object('request_id',v_request,'summary',v_prepared->'summary');
end;
$$;

create function public.confirm_batch_correction(p_request_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := public.require_batch_correction_admin();
  v_request public.batch_correction_requests%rowtype;
  v_prepared jsonb;
  v_batch public.purchase_batches%rowtype;
  v_old public.batch_items%rowtype;
  v_destination public.batch_items%rowtype;
  v_source public.sale_item_batch_allocations%rowtype;
  v_sale_item public.sale_items%rowtype;
  v_origin public.batch_items%rowtype;
  v_variant public.product_variants%rowtype;
  v_item jsonb;
  v_item_id uuid;
  v_delta integer;
  v_quantity integer;
  v_reason text := nullif(trim(p_reason),'');
  v_result jsonb;
begin
  if v_reason is null then raise exception 'Informe a justificativa da correção'; end if;
  if length(v_reason) > 4000 then raise exception 'Justificativa muito longa'; end if;
  select * into v_request from public.batch_correction_requests where id = p_request_id for update;
  if not found or v_request.created_by <> v_user then raise exception 'Prévia de correção não encontrada para este administrador'; end if;
  if v_request.confirmed_at is not null then return v_request.batch_id; end if;
  if v_request.kind = 'entry' then
    v_prepared := public.prepare_batch_entry_correction(v_request.batch_id,v_request.payload);
  else
    v_prepared := public.prepare_sale_batch_correction(v_request.batch_id,v_request.payload);
  end if;
  if v_prepared->'state' is distinct from v_request.expected_state or v_prepared->'summary' is distinct from v_request.summary then
    raise exception 'Os dados mudaram desde a prévia. Gere uma nova prévia e confira os impactos antes de confirmar';
  end if;
  select * into v_batch from public.purchase_batches where id = v_request.batch_id;
  if v_request.kind = 'entry' then
    for v_item in select value from jsonb_array_elements(v_request.payload->'items') loop
      v_item_id := nullif(v_item->>'batch_item_id','')::uuid;
      v_quantity := (v_item->>'quantity')::integer;
      if v_item_id is not null then
        select * into v_old from public.batch_items where id = v_item_id;
        v_delta := v_quantity - v_old.quantity_purchased;
        if v_delta <> 0 or v_old.unit_cost <> (v_item->>'unit_cost')::numeric(14,2) then
          update public.batch_items set quantity_purchased = v_quantity,unit_cost = (v_item->>'unit_cost')::numeric(14,2),updated_at = now(),updated_by = v_user where id = v_item_id;
        end if;
      else
        select * into v_variant from public.product_variants where id = (v_item->>'variant_id')::uuid;
        insert into public.batch_items(batch_id,product_id,variant_id,product_name,variant_name,quantity_purchased,unit_cost,updated_by)
          values (v_batch.id,v_variant.product_id,v_variant.id,(select name from public.products where id = v_variant.product_id),v_variant.name,v_quantity,(v_item->>'unit_cost')::numeric(14,2),v_user) returning id into v_item_id;
        v_delta := v_quantity;
      end if;
      select * into v_old from public.batch_items where id = v_item_id;
      if v_delta <> 0 then
        insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date,notes,created_by,batch_id,batch_item_id)
          values(v_old.product_id,v_old.variant_id,case when v_delta > 0 then 'CORRECAO_ENTRADA' else 'CORRECAO_SAIDA' end,abs(v_delta),current_date,
            'Correção ' || v_request.id || ' · ' || v_reason,v_user,v_batch.id,v_item_id);
        if v_batch.is_legacy then
          insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date,notes,created_by)
            values(v_old.product_id,v_old.variant_id,case when v_delta > 0 then 'CORRECAO_SAIDA' else 'CORRECAO_ENTRADA' end,abs(v_delta),current_date,
              'Contrapartida de classificação legada · correção ' || v_request.id || ' · ' || v_reason,v_user);
        end if;
      end if;
    end loop;
    update public.purchase_batches set purchase_date = (v_request.payload->>'purchase_date')::date,
      notes = nullif(trim(v_request.payload->>'notes'),''),updated_at = now(),updated_by = v_user where id = v_batch.id;
  else
    select * into v_sale_item from public.sale_items where id = (v_request.payload->>'sale_item_id')::uuid;
    select * into v_destination from public.batch_items where id = (v_request.payload->>'destination_item_id')::uuid;
    v_quantity := (v_request.payload->>'quantity')::integer;
    if nullif(v_request.payload->>'source_allocation_id','') is not null then
      select * into v_source from public.sale_item_batch_allocations where id = (v_request.payload->>'source_allocation_id')::uuid;
      select * into v_origin from public.batch_items where id = v_source.batch_item_id;
      -- Preservar integralmente o vínculo anterior. A parcela residual recebe outro ID.
      update public.sale_item_batch_allocations set reversed_at = now() where id = v_source.id;
      if v_source.quantity > v_quantity then
        insert into public.sale_item_batch_allocations(sale_item_id,batch_item_id,quantity,unit_cost,unit_transfer,unit_price)
          values(v_source.sale_item_id,v_source.batch_item_id,v_source.quantity - v_quantity,v_source.unit_cost,v_source.unit_transfer,v_source.unit_price);
      end if;
    end if;
    insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date,sale_id,notes,created_by,batch_id,batch_item_id)
      values(v_sale_item.product_id,v_sale_item.variant_id,'REALOCACAO_DEVOLUCAO',v_quantity,current_date,v_sale_item.sale_id,
        'Correção ' || v_request.id || ' · ' || v_reason,v_user,v_origin.batch_id,v_origin.id);
    insert into public.sale_item_batch_allocations(sale_item_id,batch_item_id,quantity,unit_cost,unit_transfer,unit_price)
      values(v_sale_item.id,v_destination.id,v_quantity,v_destination.unit_cost,v_sale_item.unit_transfer,v_sale_item.unit_price);
    insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date,sale_id,notes,created_by,batch_id,batch_item_id)
      values(v_sale_item.product_id,v_sale_item.variant_id,'REALOCACAO_CONSUMO',v_quantity,current_date,v_sale_item.sale_id,
        'Correção ' || v_request.id || ' · ' || v_reason,v_user,v_destination.batch_id,v_destination.id);
    perform set_config('pods.batch_cost_override',round((v_prepared->'state'->>'new_line_cost')::numeric / v_sale_item.quantity,2)::text,true);
    update public.sale_items set line_cost = (v_prepared->'state'->>'new_line_cost')::numeric(14,2),
      cost_price_unit = round((v_prepared->'state'->>'new_line_cost')::numeric / quantity,2)
      where id = v_sale_item.id;
    perform set_config('pods.batch_cost_override','',true);
    update public.batch_items set updated_at = now(),updated_by = v_user where id in (v_origin.id,v_destination.id);
    update public.purchase_batches set updated_at = now(),updated_by = v_user where id in (v_origin.batch_id,v_destination.batch_id);
  end if;
  v_result := jsonb_build_object(
    'batches',(select jsonb_agg(to_jsonb(b) order by b.id) from public.purchase_batches b where b.id in (v_batch.id,v_origin.batch_id)),
    'items',(select jsonb_agg(to_jsonb(bi) order by bi.id) from public.batch_items bi where bi.batch_id in (v_batch.id,v_origin.batch_id)),
    'sale_item',(select to_jsonb(si) from public.sale_items si where si.id = v_sale_item.id),
    'allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.sale_item_batch_allocations a where a.sale_item_id = v_sale_item.id)
  );
  update public.batch_correction_requests set confirmed_at = now(),confirmed_by = v_user,reason = v_reason,result_state = v_result where id = v_request.id;
  perform public.write_audit(v_user,'batch.' || v_request.kind || '_corrected','purchase_batches',v_batch.id,
    jsonb_build_object('request_id',v_request.id,'reason',v_reason,'summary',v_request.summary,'before',v_request.expected_state,'after',v_result));
  if v_origin.batch_id is not null and v_origin.batch_id <> v_batch.id then
    perform public.write_audit(v_user,'batch.allocation_corrected','purchase_batches',v_origin.batch_id,
      jsonb_build_object('request_id',v_request.id,'reason',v_reason,'summary',v_request.summary,'before',v_request.expected_state,'after',v_result));
  end if;
  if v_sale_item.sale_id is not null then
    perform public.write_audit(v_user,'sale.batch_corrected','sales',v_sale_item.sale_id,
      jsonb_build_object('request_id',v_request.id,'reason',v_reason,'summary',v_request.summary,'before',v_request.expected_state,'after',v_result));
  end if;
  return v_batch.id;
end;
$$;

revoke all on function public.require_batch_correction_admin() from public,anon,authenticated;
revoke all on function public.protect_batch_correction_history() from public,anon,authenticated;
revoke all on function public.prepare_batch_entry_correction(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.prepare_sale_batch_correction(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.preview_batch_edit(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.preview_sale_batch_correction(uuid,uuid,uuid,integer,uuid) from public,anon,authenticated;
revoke all on function public.confirm_batch_correction(uuid,text) from public,anon,authenticated;
grant execute on function public.preview_batch_edit(uuid,jsonb),public.preview_sale_batch_correction(uuid,uuid,uuid,integer,uuid),public.confirm_batch_correction(uuid,text) to authenticated;

-- Mesma ordem de travas em correções, FIFO, edição e cancelamento: variantes, depois lotes.

create or replace function public.allocate_sale_item_fifo(
  p_sale_item_id uuid, p_product_id uuid, p_variant_id uuid, p_quantity integer,
  p_sale_date date, p_unit_price numeric(14, 2), p_unit_transfer numeric(14, 2), p_user uuid
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_available integer;
  v_batch_total integer;
  v_legacy integer;
  v_left integer := p_quantity;
  v_take integer;
  v_product_cost numeric(14, 2);
  v_cost_total numeric(14, 2) := 0;
  v_avg_cost numeric(14, 2);
  v_batch record;
  v_sale_id uuid;
begin
  if p_quantity <= 0 then raise exception 'Quantidade inválida'; end if;
  perform 1 from public.product_variants where id = p_variant_id for update;
  perform 1 from public.purchase_batches b where b.status <> 'CANCELADO' and exists (
    select 1 from public.batch_items bi where bi.batch_id = b.id and bi.variant_id = p_variant_id
  ) order by b.id for update;
  select coalesce(sum(m.quantity * mt.direction), 0)::integer into v_available
  from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type
  where m.variant_id = p_variant_id;
  if coalesce(v_available, 0) < p_quantity then
    raise exception 'Estoque insuficiente. Disponível: %', coalesce(v_available, 0);
  end if;
  select coalesce(sum(quantity_remaining), 0)::integer into v_batch_total
  from public.batch_item_balances where variant_id = p_variant_id;
  v_legacy := greatest(v_available - v_batch_total, 0);
  select sale_id into v_sale_id from public.sale_items where id = p_sale_item_id;

  -- Unidades antigas ou de ajuste sem origem permanecem explicitamente sem lote.
  if v_legacy > 0 then
    select cost_price into v_product_cost from public.products where id = p_product_id;
    if v_product_cost is null then raise exception 'O estoque sem lote deste produto não possui custo configurado'; end if;
    if v_product_cost > p_unit_transfer then raise exception 'O custo atual supera o repasse desta venda'; end if;
    v_take := least(v_left, v_legacy);
    insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, sale_id, notes, created_by)
    values (p_product_id, p_variant_id, 'VENDA', v_take, p_sale_date, v_sale_id, 'Baixa de estoque sem lote conhecido', p_user);
    v_cost_total := v_cost_total + v_take::numeric * v_product_cost;
    v_left := v_left - v_take;
  end if;

  for v_batch in
    select bal.batch_item_id, bal.batch_id, bal.quantity_remaining, bi.unit_cost, b.batch_number
    from public.batch_item_balances bal
    join public.batch_items bi on bi.id = bal.batch_item_id
    join public.purchase_batches b on b.id = bal.batch_id
    where bal.variant_id = p_variant_id and bal.quantity_remaining > 0 and b.status <> 'CANCELADO'
    order by b.is_legacy desc, b.purchase_date, b.batch_number, bi.created_at, bi.id
  loop
    exit when v_left = 0;
    v_take := least(v_left, v_batch.quantity_remaining);
    if v_batch.unit_cost > p_unit_transfer then
      raise exception 'O custo do Lote % supera o repasse desta venda', lpad(v_batch.batch_number::text, greatest(3, length(v_batch.batch_number::text)), '0');
    end if;
    insert into public.sale_item_batch_allocations (sale_item_id, batch_item_id, quantity, unit_cost, unit_transfer, unit_price)
    values (p_sale_item_id, v_batch.batch_item_id, v_take, v_batch.unit_cost, p_unit_transfer, p_unit_price);
    insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, sale_id, notes, created_by, batch_id, batch_item_id)
    values (p_product_id, p_variant_id, 'VENDA', v_take, p_sale_date, v_sale_id,
      'Baixa automática da venda · lote ' || lpad(v_batch.batch_number::text, greatest(3, length(v_batch.batch_number::text)), '0'),
      p_user, v_batch.batch_id, v_batch.batch_item_id);
    v_cost_total := v_cost_total + v_take::numeric * v_batch.unit_cost;
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then raise exception 'Não foi possível associar todas as unidades ao estoque disponível'; end if;
  v_avg_cost := round(v_cost_total / p_quantity, 2);
  perform set_config('pods.batch_cost_override', v_avg_cost::text, true);
  update public.sale_items set cost_price_unit = v_avg_cost, line_cost = v_cost_total::numeric(14, 2),
    line_father_profit = (p_quantity::numeric * p_unit_transfer - v_cost_total)::numeric(14, 2)
  where id = p_sale_item_id;
  perform set_config('pods.batch_cost_override', '', true);
end;
$$;

create or replace function public.create_sale(payload jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_sale_id uuid := gen_random_uuid();
  v_item jsonb;
  v_sale_item_id uuid;
  v_customer_type_id uuid;
  v_payment_status_id uuid;
  v_counts_as_received boolean;
  v_is_credit boolean;
  v_customer_id uuid;
  v_customer_name text;
  v_sale_date date;
  v_notes text;
  v_type_name text;
  v_variant_id uuid;
  v_qty integer;
  v_product_id uuid;
  v_product_name text;
  v_variant_name text;
  v_price numeric(14, 2);
  v_transfer numeric(14, 2);
  v_rule_id uuid;
begin
  if v_user is null then raise exception 'Não autenticado'; end if;
  if not public.has_write_access() then raise exception 'Sem permissão para registrar vendas'; end if;
  v_sale_date := coalesce(nullif(payload ->> 'sale_date', '')::date, current_date);
  v_customer_type_id := nullif(payload ->> 'customer_type_id', '')::uuid;
  v_payment_status_id := nullif(payload ->> 'payment_status_id', '')::uuid;
  v_is_credit := coalesce((payload ->> 'is_credit')::boolean, false);
  v_customer_id := nullif(payload ->> 'customer_id', '')::uuid;
  v_customer_name := nullif(trim(coalesce(payload ->> 'customer_name', '')), '');
  v_notes := nullif(payload ->> 'notes', '');
  if v_customer_name is null and v_customer_id is not null then
    select name into v_customer_name from public.customers where id = v_customer_id;
  end if;
  if v_customer_name is null then raise exception 'Informe o nome do cliente'; end if;
  select counts_as_received into v_counts_as_received from public.payment_statuses
  where id = v_payment_status_id and active and not is_terminal;
  if v_counts_as_received is null then raise exception 'Status de pagamento inválido'; end if;
  if v_counts_as_received then v_is_credit := false; end if;
  select name into v_type_name from public.customer_types where id = v_customer_type_id and active;
  if v_type_name is null then raise exception 'Tipo de cliente inválido'; end if;
  if jsonb_typeof(payload -> 'items') <> 'array' or jsonb_array_length(payload -> 'items') = 0 then
    raise exception 'Informe ao menos um item';
  end if;
  perform 1 from public.product_variants v where v.id in (
    select nullif(e->>'variant_id','')::uuid from jsonb_array_elements(payload->'items') e
  ) order by v.id for update;
  perform 1 from public.purchase_batches b where b.status <> 'CANCELADO' and exists (
    select 1 from public.batch_items bi where bi.batch_id = b.id and bi.variant_id in (
      select nullif(e->>'variant_id','')::uuid from jsonb_array_elements(payload->'items') e
    )
  ) order by b.id for update;
  insert into public.sales (id, sale_date, customer_id, customer_name, customer_type_id, customer_type_name,
    payment_status_id, is_credit, notes, created_by)
  values (v_sale_id, v_sale_date, v_customer_id, v_customer_name, v_customer_type_id, v_type_name,
    v_payment_status_id, v_is_credit, v_notes, v_user);

  for v_item in select value from jsonb_array_elements(payload -> 'items') loop
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_qty := nullif(v_item ->> 'quantity', '')::integer;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantidade inválida'; end if;
    select v.product_id, v.name, p.name into v_product_id, v_variant_name, v_product_name
    from public.product_variants v join public.products p on p.id = v.product_id
    where v.id = v_variant_id and v.active and p.active;
    if v_product_id is null then raise exception 'Produto ou sabor inválido'; end if;
    select id, sale_price, father_transfer into v_rule_id, v_price, v_transfer
    from public.price_rules where product_id = v_product_id and customer_type_id = v_customer_type_id and active;
    if v_price is null then raise exception 'Não há preço configurado para este produto e tipo de cliente'; end if;
    perform set_config('pods.batch_cost_override', '0', true);
    insert into public.sale_items (sale_id, product_id, product_name, variant_id, variant_name, price_rule_id,
      quantity, unit_price, unit_transfer, cost_price_unit, line_cost, line_father_profit)
    values (v_sale_id, v_product_id, v_product_name, v_variant_id, v_variant_name, v_rule_id,
      v_qty, v_price, v_transfer, 0, 0, 0)
    returning id into v_sale_item_id;
    perform set_config('pods.batch_cost_override', '', true);
    perform public.allocate_sale_item_fifo(v_sale_item_id, v_product_id, v_variant_id, v_qty,
      v_sale_date, v_price, v_transfer, v_user);
  end loop;
  perform public.write_audit(v_user, 'sale.created', 'sales', v_sale_id, payload);
  return v_sale_id;
end;
$$;

create or replace function public.update_sale(p_sale_id uuid, payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_existing public.sale_items%rowtype;
  v_type uuid;
  v_type_name text;
  v_status uuid;
  v_status_received boolean;
  v_is_credit boolean;
  v_customer_id uuid;
  v_customer_name text;
  v_notes text;
  v_sale_date date;
  v_new_variant uuid;
  v_new_qty integer;
  v_product_id uuid;
  v_product_name text;
  v_variant_name text;
  v_price numeric(14, 2);
  v_transfer numeric(14, 2);
  v_rule_id uuid;
  v_changed boolean;
  v_alloc record;
  v_allocated integer;
  v_untracked integer;
begin
  if v_user is null or not public.has_write_access() then raise exception 'Sem permissão para editar vendas'; end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Venda não encontrada'; end if;
  if v_sale.cancelled_at is not null then raise exception 'Venda cancelada não pode ser editada'; end if;
  if (select count(*) from public.sale_items where sale_id = p_sale_id) <> 1 then
    raise exception 'Edição disponível para vendas com um item';
  end if;
  select * into v_existing from public.sale_items where sale_id = p_sale_id limit 1;
  v_type := coalesce(nullif(payload ->> 'customer_type_id', '')::uuid, v_sale.customer_type_id);
  v_status := coalesce(nullif(payload ->> 'payment_status_id', '')::uuid, v_sale.payment_status_id);
  v_customer_id := case when payload ? 'customer_id' then nullif(payload ->> 'customer_id', '')::uuid else v_sale.customer_id end;
  v_customer_name := coalesce(nullif(trim(coalesce(payload ->> 'customer_name', '')), ''), v_sale.customer_name);
  v_notes := case when payload ? 'notes' then nullif(payload ->> 'notes', '') else v_sale.notes end;
  v_sale_date := coalesce(nullif(payload ->> 'sale_date', '')::date, v_sale.sale_date);
  v_new_variant := coalesce(nullif(payload ->> 'variant_id', '')::uuid, v_existing.variant_id);
  v_new_qty := coalesce(nullif(payload ->> 'quantity', '')::integer, v_existing.quantity);
  if v_new_qty is null or v_new_qty <= 0 then raise exception 'Quantidade inválida'; end if;
  select name into v_type_name from public.customer_types where id = v_type and active;
  if v_type_name is null then raise exception 'Tipo de cliente inválido'; end if;
  select counts_as_received into v_status_received from public.payment_statuses
  where id = v_status and active and not is_terminal;
  if v_status_received is null then raise exception 'Status de pagamento inválido'; end if;
  if v_status_received then v_is_credit := v_sale.is_credit;
  else v_is_credit := coalesce((payload ->> 'is_credit')::boolean, v_sale.is_credit); end if;
  v_changed := v_new_variant is distinct from v_existing.variant_id
    or v_new_qty is distinct from v_existing.quantity or v_type is distinct from v_sale.customer_type_id;
  if v_sale.transfer_paid and (v_changed or v_is_credit is distinct from v_sale.is_credit) then
    raise exception 'O repasse desta venda já foi pago. Não é possível alterar produto, quantidade, tipo ou fiado.';
  end if;

  perform 1 from public.product_variants where id in (v_existing.variant_id,v_new_variant) order by id for update;
  perform 1 from public.purchase_batches b where b.status <> 'CANCELADO' and exists (
    select 1 from public.batch_items bi where bi.batch_id = b.id and bi.variant_id in (v_existing.variant_id,v_new_variant)
  ) order by b.id for update;
  if v_changed then
    select coalesce(sum(a.quantity), 0)::integer into v_allocated
    from public.sale_item_batch_allocations a where a.sale_item_id = v_existing.id and a.reversed_at is null;
    for v_alloc in
      select a.*, bi.product_id, bi.variant_id, bi.batch_id
      from public.sale_item_batch_allocations a join public.batch_items bi on bi.id = a.batch_item_id
      where a.sale_item_id = v_existing.id and a.reversed_at is null
    loop
      insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, sale_id,
        notes, created_by, batch_id, batch_item_id)
      values (v_alloc.product_id, v_alloc.variant_id, 'ESTORNO_EDICAO', v_alloc.quantity, current_date,
        p_sale_id, 'Devolução ao lote por edição da venda', v_user, v_alloc.batch_id, v_alloc.batch_item_id);
      update public.sale_item_batch_allocations set reversed_at = now() where id = v_alloc.id;
    end loop;
    v_untracked := v_existing.quantity - coalesce(v_allocated, 0);
    if v_untracked > 0 then
      insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, sale_id, notes, created_by)
      values (v_existing.product_id, v_existing.variant_id, 'ESTORNO_EDICAO', v_untracked, current_date,
        p_sale_id, 'Devolução de estoque sem lote por edição da venda', v_user);
    end if;

    select v.product_id, v.name, p.name into v_product_id, v_variant_name, v_product_name
    from public.product_variants v join public.products p on p.id = v.product_id
    where v.id = v_new_variant and v.active and p.active;
    if v_product_id is null then raise exception 'Produto ou sabor inválido'; end if;
    if v_new_variant = v_existing.variant_id and v_type = v_sale.customer_type_id then
      v_price := v_existing.unit_price; v_transfer := v_existing.unit_transfer; v_rule_id := v_existing.price_rule_id;
    else
      select id, sale_price, father_transfer into v_rule_id, v_price, v_transfer
      from public.price_rules where product_id = v_product_id and customer_type_id = v_type and active;
      if v_price is null then raise exception 'Não há preço configurado para este produto e tipo de cliente'; end if;
    end if;
    perform set_config('pods.batch_cost_override', '0', true);
    update public.sale_items set product_id = v_product_id, product_name = v_product_name,
      variant_id = v_new_variant, variant_name = v_variant_name, price_rule_id = v_rule_id,
      quantity = v_new_qty, unit_price = v_price, unit_transfer = v_transfer,
      cost_price_unit = 0, line_cost = 0, line_father_profit = 0
    where id = v_existing.id;
    perform set_config('pods.batch_cost_override', '', true);
    perform public.allocate_sale_item_fifo(v_existing.id, v_product_id, v_new_variant, v_new_qty,
      v_sale_date, v_price, v_transfer, v_user);
  end if;

  update public.sales set sale_date = v_sale_date, customer_id = v_customer_id,
    customer_name = v_customer_name, customer_type_id = v_type, customer_type_name = v_type_name,
    payment_status_id = v_status, is_credit = v_is_credit, notes = v_notes where id = p_sale_id;
  update public.stock_movements set movement_date = v_sale_date
  where sale_id = p_sale_id and movement_type = 'VENDA';
  perform public.write_audit(v_user, 'sale.updated', 'sales', p_sale_id, payload);
end;
$$;

create or replace function public.cancel_sale(p_sale_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_item public.sale_items%rowtype;
  v_alloc record;
  v_allocated integer;
  v_untracked integer;
begin
  if v_user is null or not public.has_write_access() then raise exception 'Sem permissão para cancelar vendas'; end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Venda não encontrada'; end if;
  if v_sale.cancelled_at is not null then raise exception 'Venda já cancelada'; end if;
  perform 1 from public.product_variants v where v.id in (
    select si.variant_id from public.sale_items si where si.sale_id = p_sale_id
  ) order by v.id for update;
  perform 1 from public.purchase_batches b where exists (
    select 1 from public.batch_items bi join public.sale_item_batch_allocations a on a.batch_item_id = bi.id
    join public.sale_items si on si.id = a.sale_item_id
    where bi.batch_id = b.id and si.sale_id = p_sale_id and a.reversed_at is null
  ) order by b.id for update;
  for v_item in select * from public.sale_items where sale_id = p_sale_id loop
    select coalesce(sum(a.quantity), 0)::integer into v_allocated
    from public.sale_item_batch_allocations a where a.sale_item_id = v_item.id and a.reversed_at is null;
    for v_alloc in
      select a.*, bi.product_id, bi.variant_id, bi.batch_id
      from public.sale_item_batch_allocations a join public.batch_items bi on bi.id = a.batch_item_id
      where a.sale_item_id = v_item.id and a.reversed_at is null
    loop
      insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, sale_id,
        notes, created_by, batch_id, batch_item_id)
      values (v_alloc.product_id, v_alloc.variant_id, 'CANCELAMENTO_VENDA', v_alloc.quantity, current_date,
        p_sale_id, 'Devolução ao lote por cancelamento', v_user, v_alloc.batch_id, v_alloc.batch_item_id);
      update public.sale_item_batch_allocations set reversed_at = now() where id = v_alloc.id;
    end loop;
    v_untracked := v_item.quantity - coalesce(v_allocated, 0);
    if v_untracked > 0 then
      perform public.write_stock_movement(v_item.product_id, v_item.variant_id, 'CANCELAMENTO_VENDA',
        v_untracked, current_date, p_sale_id, 'Devolução de estoque sem lote por cancelamento', v_user);
    end if;
  end loop;
  update public.sales set cancelled_at = now(), cancelled_by = v_user,
    cancel_reason = nullif(trim(coalesce(p_reason, '')), '') where id = p_sale_id;
  perform public.write_audit(v_user, 'sale.cancelled', 'sales', p_sale_id, jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.register_stock_movement(
  p_variant_id uuid, p_type text, p_quantity integer, p_date date, p_notes text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_product uuid;
  v_manual boolean;
  v_id uuid;
  v_left integer := p_quantity;
  v_take integer;
  v_item record;
  v_available integer;
  v_batch_total integer;
  v_legacy integer;
begin
  if v_user is null or not public.has_write_access() then raise exception 'Sem permissão para movimentar estoque'; end if;
  if p_type = 'ENTRADA' then
    raise exception 'Registre compras em Estoque > Nova compra para criar o lote e guardar o custo histórico';
  end if;
  select manual into v_manual from public.movement_types where code = p_type;
  if v_manual is distinct from true or p_type not in ('AJUSTE_ENTRADA', 'AJUSTE_SAIDA') then
    raise exception 'Use compra para novas mercadorias e ajuste para corrigir divergências';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantidade inválida'; end if;
  select product_id into v_product from public.product_variants where id = p_variant_id and active;
  if v_product is null then raise exception 'Sabor inválido'; end if;
  perform 1 from public.product_variants where id = p_variant_id for update;
  perform 1 from public.purchase_batches b where b.status <> 'CANCELADO' and exists (
    select 1 from public.batch_items bi where bi.batch_id = b.id and bi.variant_id = p_variant_id
  ) order by b.id for update;

  if p_type = 'AJUSTE_SAIDA' then
    select coalesce(sum(m.quantity * mt.direction), 0)::integer into v_available
    from public.stock_movements m join public.movement_types mt on mt.code = m.movement_type where m.variant_id = p_variant_id;
    select coalesce(sum(quantity_remaining), 0)::integer into v_batch_total
    from public.batch_item_balances where variant_id = p_variant_id;
    v_legacy := greatest(v_available - v_batch_total, 0);
    v_take := least(v_left, v_legacy);
    if v_take > 0 then
      v_id := public.write_stock_movement(v_product, p_variant_id, p_type, v_take, p_date, null,
        nullif(trim(coalesce(p_notes, '')), ''), v_user);
      v_left := v_left - v_take;
    end if;
    for v_item in
      select bal.batch_item_id, bal.batch_id, bal.quantity_remaining
      from public.batch_item_balances bal join public.batch_items bi on bi.id = bal.batch_item_id
      join public.purchase_batches b on b.id = bal.batch_id
      where bal.variant_id = p_variant_id and bal.quantity_remaining > 0 and b.status <> 'CANCELADO'
      order by b.purchase_date desc, b.batch_number desc, bi.created_at desc, bi.id desc
    loop
      exit when v_left = 0;
      v_take := least(v_left, v_item.quantity_remaining);
      insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, notes,
        created_by, batch_id, batch_item_id)
      values (v_product, p_variant_id, p_type, v_take, coalesce(p_date, current_date),
        nullif(trim(coalesce(p_notes, '')), ''), v_user, v_item.batch_id, v_item.batch_item_id)
      returning id into v_id;
      v_left := v_left - v_take;
    end loop;
  end if;
  if v_left > 0 then
    v_id := public.write_stock_movement(v_product, p_variant_id, p_type, v_left, p_date, null,
      nullif(trim(coalesce(p_notes, '')), ''), v_user);
  end if;
  perform public.write_audit(v_user, 'stock.movement', 'stock_movements', v_id,
    jsonb_build_object('variant_id', p_variant_id, 'type', p_type, 'quantity', p_quantity, 'notes', p_notes));
  return v_id;
end;
$$;

create or replace function public.cancel_purchase_batch(p_batch_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_batch public.purchase_batches%rowtype;
  v_item record;
begin
  if v_user is null or not public.has_write_access() then raise exception 'Sem permissão para cancelar compras'; end if;
  perform 1 from public.product_variants v where exists (
    select 1 from public.batch_items bi where bi.batch_id = p_batch_id and bi.variant_id = v.id
  ) order by v.id for update;
  select * into v_batch from public.purchase_batches where id = p_batch_id for update;
  if not found then raise exception 'Lote não encontrado'; end if;
  if v_batch.status = 'CANCELADO' then raise exception 'Lote já cancelado'; end if;
  if exists (
    select 1 from public.sale_item_batch_allocations a join public.batch_items bi on bi.id = a.batch_item_id
    where bi.batch_id = p_batch_id
  ) then raise exception 'Este lote já participou de uma venda e não pode ser cancelado'; end if;
  for v_item in select * from public.batch_item_balances where batch_id = p_batch_id loop
    if v_item.quantity_remaining <> v_item.quantity_purchased then
      raise exception 'O estoque do lote mudou; confira e corrija antes de cancelar a compra';
    end if;
    insert into public.stock_movements (product_id, variant_id, movement_type, quantity, movement_date, notes,
      created_by, batch_id, batch_item_id)
    values (v_item.product_id, v_item.variant_id, 'AJUSTE_SAIDA', v_item.quantity_purchased,
      current_date, 'Cancelamento seguro da compra', v_user, p_batch_id, v_item.batch_item_id);
    if v_batch.is_legacy then
      perform public.write_stock_movement(v_item.product_id, v_item.variant_id, 'AJUSTE_ENTRADA',
        v_item.quantity_purchased, current_date, null,
        'Retorno ao saldo sem lote após desfazer associação de legado', v_user);
    end if;
  end loop;
  update public.purchase_batches set status = 'CANCELADO', cancelled_at = now(), closed_at = now()
  where id = p_batch_id;
  perform public.write_audit(v_user, 'purchase.cancelled', 'purchase_batches', p_batch_id, '{}'::jsonb);
end;
$$;

notify pgrst,'reload schema';
