import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, ClipboardCheck, Filter, History, Package, ShoppingCart } from "lucide-react";
import { getSessionState } from "@/lib/auth";
import { loadCatalog, loadLowStockThreshold } from "@/lib/data/catalog";
import { summarizeActiveProductStock } from "@/lib/domain/stock";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { matchesFlavorSearch, matchesIceFilter, parseIceParam } from "@/lib/domain/flavors";
import type { StockMovement } from "@/lib/types";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { StockEntryForm } from "@/components/stock/stock-entry-form";
import { WhatsAppPromotion } from "@/components/stock/whatsapp-promotion";
import { IceBadge, StockBadge, VariantAvailabilityBadge } from "@/components/sales/badges";
import { IceFilterSelect } from "@/components/catalog/flavor-filters";
import { Panel } from "@/components/ui/panel";
import { controlClass } from "@/components/ui/field";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isConsultasRole } from "@/lib/domain/roles";

export const metadata = { title: "Estoque" };

export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const params: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(rawParams).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
  const [catalog, session, threshold] = await Promise.all([
    loadCatalog({ productStatus: "active", stockActiveProductsOnly: true, stockActiveVariantsOnly: true }),
    getSessionState(),
    loadLowStockThreshold(),
  ]);
  const canWrite = session.status === "ok" && session.profile.can_write;
  const isAdmin = session.status === "ok" && session.profile.role_code.toLowerCase() === "admin";
  const consultas = session.status === "ok" && isConsultasRole(session.profile.role_code);
  if (!catalog.ok) {
    return (
      <div>
        <PageHeading title="Estoque" />
        <Notice>{catalog.message}</Notice>
      </div>
    );
  }

  const supabase = await createClient();
  const activeProductIds = catalog.data.products.map((product) => product.id);
  const { data: movements } = activeProductIds.length === 0
    ? { data: [] }
    : await supabase
      .from("stock_movement_history")
      .select("*")
      .in("product_id", activeProductIds)
      .order("created_at", { ascending: false })
      .limit(12);

  const iceFilter = parseIceParam(params.ice);
  const flavorQuery = params.sabor ?? "";
  const visibleStock = catalog.data.stock.filter(
    (item) =>
      matchesIceFilter(item.variant_is_ice, iceFilter) &&
      matchesFlavorSearch({ name: item.variant_name, is_ice: item.variant_is_ice }, flavorQuery),
  );

  const productById = new Map(catalog.data.products.map((product) => [product.id, product]));
  const groups = new Map<string, { name: string; items: typeof visibleStock }>();
  for (const item of visibleStock) {
    const product = productById.get(item.product_id);
    const group = groups.get(item.product_id) ?? {
      name: product?.name ?? item.product_name,
      items: [],
    };
    group.items.push(item);
    groups.set(item.product_id, group);
  }
  // Active products stay listed without filters even when no active flavor is left to show.
  const hasVariant = new Set(catalog.data.variants.map((variant) => variant.product_id));
  if (!flavorQuery.trim() && iceFilter === "all") {
    for (const product of catalog.data.products) {
      if (product.active && !groups.has(product.id)) {
        groups.set(product.id, { name: product.name, items: [] });
      }
    }
  }
  const productStock = summarizeActiveProductStock(catalog.data.products, catalog.data.stock);
  const activeStockByProduct = new Map(productStock.map((product) => [product.product_id, product]));
  const total = visibleStock.reduce((sum, item) => sum + item.quantity, 0);
  const field = cn(controlClass, "h-11");

  return (
    <div className="grid w-full min-w-0 gap-6">
      <PageHeading
        title="Estoque"
        eyebrow={`${groups.size} produto(s) · ${total} unidades exibidas`}
        description={consultas ? "O saldo vem das movimentações. Toda venda reduz o estoque na hora." : "O saldo vem das movimentações. Venda, fiado ou a receber baixam na hora."}
        action={{ href: "/estoque/conferencia", label: "Conferir" }}
      />

      {canWrite ? (
        <Link
          href="/estoque/nova-compra"
          className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-fit")}
        >
          <ShoppingCart className="h-4 w-4" /> Nova compra · criar lote
        </Link>
      ) : null}

      {isAdmin ? <WhatsAppPromotion /> : null}

      <form className="tech-card grid w-full min-w-0 gap-2 p-3 md:p-4" method="get">
        {Object.entries(params).filter(([key]) => key !== "sabor" && key !== "ice").map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <p className="eyebrow flex items-center gap-1.5">
          <Filter className="h-3 w-3" /> Filtros
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
          <input
            className={cn(field, "sm:col-span-2")}
            name="sabor"
            placeholder="Pesquisar sabor (ex.: Grape Ice)"
            defaultValue={params.sabor ?? ""}
            aria-label="Pesquisar sabor"
          />
          <IceFilterSelect defaultValue={params.ice} />
          <button className={cn(buttonVariants(), "h-11 w-full")} type="submit">
            Filtrar
          </button>
        </div>
      </form>

      <div className="stagger grid gap-3 md:grid-cols-2">
        {groups.size === 0 ? (
          <p className="text-sm text-muted-foreground md:col-span-2" role="status">
            {catalog.data.products.length === 0
              ? "Nenhum produto ativo para exibir."
              : "Nenhum produto ativo encontrado para os filtros informados."}
          </p>
        ) : null}
        {[...groups.entries()].map(([productId, group]) => {
          const items = group.items;
          const activeProductStock = activeStockByProduct.get(productId);
          const productTotal = activeProductStock?.quantity ?? 0;
          const max = Math.max(1, ...items.map((item) => item.quantity));
          return (
            <Panel
              key={productId}
              title={group.name}
              icon={Package}
              accent
              action={
                <div className="grid justify-items-end gap-1">
                  <StockBadge quantity={productTotal} threshold={threshold} />
                  <p className="text-right">
                    <span className="block font-display text-2xl font-bold leading-none tabular-nums">{productTotal}</span>
                    <span className="eyebrow text-[10px]">estoque total</span>
                  </p>
                </div>
              }
            >
              {items.length > 0 ? (
                <ul className="grid min-w-0 gap-3">
                  {items.map((item) => (
                    <li key={item.variant_id} className="grid min-w-0 gap-1.5">
                      <div className="flex min-w-0 items-start justify-between gap-2 text-sm">
                        <span className="flex min-w-0 flex-1 items-start gap-2">
                          <span className="min-w-0 break-words">{item.variant_name}</span>
                          {item.variant_is_ice ? <IceBadge /> : <span className="shrink-0 text-xs text-muted-foreground">Normal</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <VariantAvailabilityBadge quantity={item.quantity} />
                          <span
                            className={cn(
                              "min-w-6 text-right font-display font-semibold tabular-nums",
                              item.quantity <= 0 && "text-danger",
                            )}
                          >
                            {item.quantity}
                          </span>
                        </span>
                      </div>
                      <div className="bar-track h-1.5">
                        <div
                          className={cn("bar-fill", item.quantity <= 0 && "bar-fill-muted")}
                          style={{ width: `${Math.max(3, (item.quantity / max) * 100)}%` }}
                        />
                      </div>
                      {item.quantity > 0 ? (
                        <details className="mt-1 text-xs text-muted-foreground">
                          <summary className="w-fit cursor-pointer hover:text-foreground">Origem do saldo</summary>
                          <ul className="mt-1 grid gap-1 pl-3">
                            {(catalog.data.batchItems ?? [])
                              .filter((batchItem) => batchItem.variant_id === item.variant_id && batchItem.quantity_remaining > 0)
                              .sort((a, b) => a.batch_number - b.batch_number)
                              .map((batchItem) => (
                                <li key={batchItem.batch_item_id}>
                                  Lote {String(batchItem.batch_number).padStart(3, "0")} → {batchItem.quantity_remaining} un
                                </li>
                              ))}
                            {Math.max(0, item.quantity - (catalog.data.batchItems ?? [])
                              .filter((batchItem) => batchItem.variant_id === item.variant_id)
                              .reduce((sum, batchItem) => sum + batchItem.quantity_remaining, 0)) > 0 ? (
                                <li>
                                  Sem lote conhecido → {Math.max(0, item.quantity - (catalog.data.batchItems ?? [])
                                    .filter((batchItem) => batchItem.variant_id === item.variant_id)
                                    .reduce((sum, batchItem) => sum + batchItem.quantity_remaining, 0))} un
                                </li>
                              ) : null}
                          </ul>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {hasVariant.has(productId) ? "Nenhum sabor ativo disponível" : "Nenhuma variação cadastrada."}
                </p>
              )}
            </Panel>
          );
        })}
      </div>

      {canWrite ? <StockEntryForm stock={catalog.data.stock} canWrite={canWrite} /> : null}

      <Panel
        title="Movimentações recentes"
        description="Últimas 12 entradas, saídas e ajustes de produtos ativos"
        icon={History}
        bodyClassName="p-0"
        action={canWrite ? (
          <Link
            href="/estoque/conferencia"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <ClipboardCheck className="h-3.5 w-3.5" /> Conferência
          </Link>
        ) : undefined}
      >
        {(movements ?? []).length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nenhuma movimentação registrada.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {((movements ?? []) as StockMovement[]).map((movement) => {
              const positive = movement.direction > 0;
              return (
                <li key={movement.id} className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm">
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-md border",
                      positive
                        ? "border-success/35 bg-success/10 text-success"
                        : "border-primary/40 bg-primary/10 text-primary",
                    )}
                  >
                    {positive ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">
                      {movement.product_name} · {movement.variant_name}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {movement.movement_name} · {formatDate(movement.movement_date)}
                      {movement.batch_number ? ` · Lote ${String(movement.batch_number).padStart(3, "0")}` : ""}
                      {movement.user_name ? ` · ${movement.user_name}` : ""}
                      {movement.sale_id ? (
                        <>
                          {" · "}
                          <Link href={`/vendas/${movement.sale_id}`} className="text-primary underline-offset-4 hover:underline">
                            ver venda
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 font-display text-base font-semibold tabular-nums",
                      positive ? "text-success" : "text-primary",
                    )}
                  >
                    {positive ? "+" : "−"}
                    {movement.quantity}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
