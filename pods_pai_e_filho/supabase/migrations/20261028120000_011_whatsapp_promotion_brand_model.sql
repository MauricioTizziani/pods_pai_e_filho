-- The product identity in the WhatsApp message now includes brand and model.
-- Both already exist on public.products; this migration only extends the
-- read-only snapshot RPC to return them, without adding or duplicating columns.
begin;

create or replace function public.get_whatsapp_promotion_snapshot()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_snapshot jsonb;
begin
  if auth.uid() is null or not public.is_whatsapp_promotion_admin() then
    raise exception 'A divulgação está disponível apenas para o Administrador';
  end if;
  with active_balances as (
    select sb.variant_id, sb.product_id, sb.variant_name, sb.variant_is_ice, sb.quantity
    from public.stock_balances sb
    where sb.product_active and sb.variant_active
  ), available_products as (
    select p.id, p.name, p.brand, p.model, p.promotion_name, p.approximate_puffs,
      p.promotion_features, p.display_order, sum(sb.quantity) as total_quantity
    from public.products p
    join active_balances sb on sb.product_id = p.id
    where p.active
    group by p.id
    having sum(sb.quantity) > 0
  ), normal_prices as (
    select pr.product_id, pr.sale_price
    from public.price_rules pr
    join public.customer_types ct on ct.id = pr.customer_type_id
    where pr.active and ct.active and ct.code = 'normal'
  )
  select jsonb_build_object(
    'settings', (
      select jsonb_build_object('header', s.value ->> 'header', 'footer', s.value ->> 'footer')
      from public.app_settings s where s.key = 'whatsapp_promotion'
    ),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'brand', p.brand,
        'model', p.model,
        'promotion_name', p.promotion_name,
        'approximate_puffs', p.approximate_puffs,
        'promotion_features', p.promotion_features,
        'display_order', p.display_order,
        'total_quantity', p.total_quantity,
        'normal_price', pr.sale_price::text,
        'variants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', sb.variant_id,
            'name', sb.variant_name,
            'is_ice', sb.variant_is_ice,
            'quantity', sb.quantity
          ) order by public.flavor_display_name(sb.variant_name, sb.variant_is_ice), sb.variant_id)
          from active_balances sb
          where sb.product_id = p.id and sb.quantity > 0
        ), '[]'::jsonb)
      ) order by p.display_order nulls last, p.name, p.id)
      from available_products p
      left join normal_prices pr on pr.product_id = p.id
    ), '[]'::jsonb),
    'warnings', coalesce((
      select jsonb_agg(
        'Estoque negativo em ' || p.name || ' · '
        || public.flavor_display_name(sb.variant_name, sb.variant_is_ice)
        || '. Confira as movimentações em Estoque.'
        order by p.name, public.flavor_display_name(sb.variant_name, sb.variant_is_ice), sb.variant_id
      )
      from active_balances sb join public.products p on p.id = sb.product_id
      where sb.quantity < 0
    ), '[]'::jsonb)
  ) into v_snapshot;
  return v_snapshot;
end;
$$;
revoke all on function public.get_whatsapp_promotion_snapshot() from public;
grant execute on function public.get_whatsapp_promotion_snapshot() to authenticated;

notify pgrst, 'reload schema';

commit;
