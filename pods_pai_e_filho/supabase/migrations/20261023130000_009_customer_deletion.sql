-- Excluir o cadastro sem apagar operações nem perder o nome histórico da venda.
-- Reutiliza sales.customer_name e o FK opcional ON DELETE SET NULL já existente.
begin;

-- Instala o backfill e a proteção de novas escritas sem uma janela intermediária.
lock table public.sales in exclusive mode;

update public.sales s
set customer_name = c.name
from public.customers c
where s.customer_id = c.id
  and coalesce(s.customer_name, '') !~ '[^[:space:]]'
  and c.name ~ '[^[:space:]]';

create function public.preserve_sale_customer_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_new_association boolean := false;
begin
  if new.customer_id is not null then
    if tg_op = 'INSERT' then
      v_new_association := true;
    else
      v_new_association := new.customer_id is distinct from old.customer_id;
    end if;

    if v_new_association or coalesce(new.customer_name, '') !~ '[^[:space:]]' then
      select c.name into v_name
      from public.customers c where c.id = new.customer_id for key share;
      if not found then
        raise exception 'Cliente não encontrado. Atualize a página e informe o nome sem cadastro ou selecione outro cliente.';
      end if;
      new.customer_name := v_name;
    end if;
  end if;

  if coalesce(new.customer_name, '') !~ '[^[:space:]]' then
    raise exception 'Informe o nome do cliente';
  end if;
  return new;
end;
$$;

create trigger sales_preserve_customer_name
before insert or update of customer_id, customer_name on public.sales
for each row execute function public.preserve_sale_customer_name();

revoke all on function public.preserve_sale_customer_name() from public, anon, authenticated;

create function public.delete_customer(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_count integer;
  v_result jsonb;
begin
  if v_user is null or not exists (
    select 1 from public.profiles p
    where p.id = v_user and p.role_code = 'admin'
  ) or not public.has_write_access() then
    raise exception 'Somente ADMIN pode excluir clientes';
  end if;

  -- Mesmo lock de create_sale/update_sale, sempre ANTES dos locks de linhas.
  -- Assim uma venda concorrente termina antes da exclusão ou revalida o ID
  -- depois dela. Não existe intervalo entre salvar o nome e remover o vínculo.
  perform pg_advisory_xact_lock(764223);
  select * into v_customer from public.customers where id = p_customer_id for update;
  if not found then raise exception 'Cliente não encontrado. Atualize a página.'; end if;

  update public.sales
  set customer_name = case
        when coalesce(customer_name, '') !~ '[^[:space:]]' then v_customer.name
        else customer_name
      end,
      customer_id = null
  where customer_id = p_customer_id;
  get diagnostics v_count = row_count;

  delete from public.customers where id = p_customer_id;

  v_result := jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'detached_sales_count', v_count
  );
  -- entity_id não possui FK para o cliente; a auditoria sobrevive à exclusão.
  perform public.write_audit(v_user, 'customer.deleted', 'customers', v_customer.id, v_result);
  return v_result;
end;
$$;

-- Exclusão somente pela RPC que valida ADMIN e preserva as descrições.
-- Não adicionar policy DELETE: CONSULTAS continua somente leitura.
revoke delete on public.customers from public, anon, authenticated;
revoke all on function public.delete_customer(uuid) from public, anon, authenticated;
grant execute on function public.delete_customer(uuid) to authenticated;

-- create_sale/update_sale abaixo mantêm as regras financeiras e de FIFO da 008.
-- O único acréscimo é o lock da associação, antes de qualquer lock de linha.

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
  perform pg_advisory_xact_lock(764223);
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
  perform pg_advisory_xact_lock(764223);
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

commit;
