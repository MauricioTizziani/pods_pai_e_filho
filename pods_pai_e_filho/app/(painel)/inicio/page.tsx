import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Banknote,
  Clock,
  HandCoins,
  Package,
  PiggyBank,
  Receipt,
  Send,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { getSessionState } from "@/lib/auth";
import { listBatches } from "@/lib/data/batches";
import { loadDashboard } from "@/lib/data/dashboard";
import { loadConsultasFinancialSummary } from "@/lib/data/dashboard";
import { ConsultasDashboard } from "@/components/dashboard/consultas-dashboard";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { formatBRL, formatDate, resolvePeriod } from "@/lib/format";
import { getLowStockProducts, summarizeActiveProductStock } from "@/lib/domain/stock";
import { buildFilterUrl, formatBatchLabel, resolveBatchFilter } from "@/lib/domain/batch-filters";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { PaymentBadge, CreditBadge, StockBadge } from "@/components/sales/badges";
import { StatCard } from "@/components/ui/stat-card";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { isConsultasRole } from "@/lib/domain/roles";

export const metadata = { title: "Dashboard" };

export default async function InicioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const params: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(rawParams).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
  const period = resolvePeriod(params);
  const [session, batchesResult] = await Promise.all([getSessionState(), listBatches()]);
  if (!batchesResult.ok && params.lote && params.lote !== "todos") {
    return (
      <div className="grid w-full min-w-0 gap-4">
        <PageHeading title="Dashboard" />
        <Notice>Não foi possível carregar os lotes. {batchesResult.message}</Notice>
      </div>
    );
  }
  const batchFilter = resolveBatchFilter(batchesResult.batches, params.lote);
  if (batchesResult.ok && batchFilter.shouldCanonicalize) {
    redirect(buildFilterUrl("/inicio", params, { lote: batchFilter.value }));
  }
  const batchNotice = batchesResult.ok ? undefined : "Não foi possível carregar os lotes. Exibindo Todos os lotes.";
  const currentUrl = buildFilterUrl("/inicio", params);
  const salesUrl = buildFilterUrl("/vendas", params, {
    lote: batchFilter.batchId ?? undefined,
    periodo: undefined,
    de: period.from ?? undefined,
    ate: period.to ?? undefined,
  });
  const filters = {
    batches: batchesResult.batches.map((batch) => ({ value: batch.batch_id, label: formatBatchLabel(batch) })),
    batchValue: batchFilter.value,
    params,
    periodFrom: period.from,
    periodTo: period.to,
  };
  const canWrite = session.status === "ok" && session.profile.can_write;
  const consultas = session.status === "ok" && isConsultasRole(session.profile.role_code);
  const dashboard = await loadDashboard(period.from, period.to, { consultas, batchId: batchFilter.batchId });

  if (!dashboard.ok) {
    return (
      <div className="grid w-full min-w-0 gap-4">
        <PageHeading title="Dashboard" description={`${batchFilter.label} · ${period.label}`} />
        {batchNotice ? <Notice>{batchNotice}</Notice> : null}
        <div className="order-last md:order-none">
          <DashboardFilters key={currentUrl} {...filters} />
        </div>
        <Notice>{dashboard.message}</Notice>
      </div>
    );
  }

  if (consultas) {
    const financial = await loadConsultasFinancialSummary(period.from, period.to, { batchId: batchFilter.batchId });
    if (!financial.ok) {
      return (
        <div className="grid w-full min-w-0 gap-4">
          <PageHeading title="Início" description={`${batchFilter.label} · ${period.label}`} />
          {batchNotice ? <Notice>{batchNotice}</Notice> : null}
          <div className="order-last md:order-none">
            <DashboardFilters key={currentUrl} {...filters} />
          </div>
          <Notice>{financial.message}</Notice>
        </div>
      );
    }
    return <ConsultasDashboard dashboard={dashboard} summary={financial.summary} periodLabel={period.label} batchLabel={batchFilter.label} filters={filters} currentUrl={currentUrl} salesUrl={salesUrl} batchNotice={batchNotice} />;
  }

  const m = dashboard.metrics;
  const n = (value: string | number) => Number(value ?? 0) || 0;

  const productStock = summarizeActiveProductStock(dashboard.products, dashboard.stock);
  const stockTotal = productStock.reduce((total, product) => total + product.quantity, 0);
  const byProduct = new Map(
    productStock.map((product) => [product.product_id, { name: product.product_name, quantity: product.quantity }]),
  );
  const maxProduct = Math.max(1, ...[...byProduct.values()].map((product) => product.quantity));
  const activeStockByProduct = new Map(productStock.map((product) => [product.product_id, product]));
  const low = getLowStockProducts(productStock, dashboard.lowStockThreshold);

  // Total vendido no período = parte do pai + lucro (soma de total_amount das vendas válidas).
  const soldTotal = n(m.transfer_total) + n(m.profit_total);
  const transferShare = soldTotal > 0 ? (n(m.transfer_total) / soldTotal) * 100 : 0;
  const profitShare = soldTotal > 0 ? (n(m.profit_total) / soldTotal) * 100 : 0;
  const cashBase = n(m.money_received) + n(m.receivable);
  const receivedShare = cashBase > 0 ? (n(m.money_received) / cashBase) * 100 : 0;
  const receivableShare = cashBase > 0 ? (n(m.receivable) / cashBase) * 100 : 0;

  return (
    <div className="grid w-full min-w-0 gap-6">
      <PageHeading
        title="Dashboard"
        eyebrow="Painel de controle"
        description={`${batchFilter.label} · ${period.label}`}
        action={canWrite ? { href: "/vendas/nova", label: "Nova venda", icon: "plus" } : undefined}
      />

      {batchNotice ? <Notice>{batchNotice}</Notice> : null}
      <div className="order-last md:order-none">
        <DashboardFilters key={currentUrl} {...filters} />
      </div>

      {/* Indicadores principais */}
      <section className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Estoque atual · geral"
          value={stockTotal}
          kind="int"
          suffix="un"
          icon={Package}
          tone={low.length > 0 ? "warning" : "success"}
          hint={low.length > 0 ? `${low.length} produto(s) com estoque baixo ou esgotado` : "Nenhum produto abaixo do limite"}
          href="/estoque"
          accent
        />
        <StatCard
          label="Vendas"
          value={soldTotal}
          icon={Receipt}
          hint={`${m.sales_count} vendas · ${m.units_sold} unidades`}
          href={salesUrl}
          accent
        />
        <StatCard
          label="Lucro total"
          value={n(m.profit_total)}
          icon={TrendingUp}
          tone="success"
          hint={`Recebido: ${formatBRL(m.profit_received)}`}
          accent
        />
        <StatCard
          label="A enviar ao pai agora"
          value={n(m.transfer_due_now)}
          icon={Send}
          featured
          hint="Vendas recebidas ou fiadas com repasse pendente"
          href={buildFilterUrl("/repasses", params, { lote: batchFilter.value, aba: "agora" })}
        />
      </section>

      {/* Financeiro detalhado */}
      <section className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Dinheiro recebido" value={n(m.money_received)} icon={Banknote} tone="success" />
        <StatCard
          label="A receber · pendentes e fiados"
          value={n(m.receivable)}
          icon={Clock}
          tone="warning"
          href={batchFilter.batchId ? undefined : "/fiados"}
        />
        <StatCard label="Lucro recebido" value={n(m.profit_received)} icon={PiggyBank} tone="success" />
        <StatCard label="Valor do pai · total vendido" value={n(m.transfer_total)} icon={Wallet} />
        <StatCard label="Repasse de vendas recebidas" value={n(m.transfer_from_received)} icon={HandCoins} />
        <StatCard label="Repasse futuro" value={n(m.transfer_future)} icon={Clock} tone="info" />
      </section>

      <section className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        {/* Estoque por produto */}
        <Panel
          title="Estoque geral"
          description={`${stockTotal} unidades em ${byProduct.size} produto(s)`}
          icon={Package}
          action={
            <Link href="/estoque" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              Ver estoque <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          }
        >
          {byProduct.size === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum produto com estoque.</p>
          ) : (
            <ul className="grid gap-3">
              {[...byProduct.entries()].map(([productId, product]) => {
                const activeProductStock = activeStockByProduct.get(productId);
                const isLow =
                  activeProductStock !== undefined &&
                  activeProductStock.quantity <= dashboard.lowStockThreshold;
                return (
                  <li key={productId} className="grid gap-1.5">
                    <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 break-words font-medium">{product.name}</span>
                      <span className="shrink-0 font-display font-semibold tabular-nums">{product.quantity} un</span>
                    </div>
                    <div className="bar-track">
                      <div
                        className={cn("bar-fill", isLow && "bar-fill-muted")}
                        style={{ width: `${Math.max(3, (product.quantity / maxProduct) * 100)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 grid gap-2 border-t border-border/70 pt-4">
            {low.length > 0 ? (
              <div className="grid gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5 text-warning">
                  <AlertTriangle className="h-4 w-4" /> Estoque baixo · geral:
                </span>
                {low.map((product) => (
                  <div key={product.product_id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{product.product_name}</span>
                    <span className="flex items-center gap-2">
                      <StockBadge quantity={product.quantity} threshold={dashboard.lowStockThreshold} />
                      <span className="text-muted-foreground">
                        {product.quantity} {product.quantity === 1 ? "unidade restante" : "unidades restantes"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nenhum produto abaixo do limite de estoque baixo.
              </p>
            )}
            {dashboard.divergences.length > 0 ? (
              <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{dashboard.divergences.length} divergência(s) na última conferência.</span>
                <Link href="/estoque/conferencia" className="underline underline-offset-4">
                  Conferir
                </Link>
              </p>
            ) : null}
          </div>
        </Panel>

        {/* Composição do dinheiro */}
        <Panel title="Distribuição do período" description="Para onde vai o valor vendido" icon={Activity}>
          {soldTotal <= 0 ? (
            <p className="text-sm text-muted-foreground">Sem vendas neste recorte.</p>
          ) : (
            <div className="grid gap-5">
              <div>
                <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="min-w-0 break-words">Parte do pai × Lucro</span>
                  <span className="shrink-0 tabular-nums">{formatBRL(soldTotal)}</span>
                </div>
                <div className="flex h-3 w-full min-w-0 max-w-full overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full min-w-0 bg-gradient-to-r from-primary-deep to-primary"
                    style={{ width: `${transferShare}%` }}
                    title={`Parte do pai ${formatBRL(m.transfer_total)}`}
                  />
                  <div
                    className="h-full min-w-0 bg-gradient-to-r from-success/70 to-success"
                    style={{ width: `${profitShare}%` }}
                    title={`Lucro ${formatBRL(m.profit_total)}`}
                  />
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <Legend color="bg-primary" label="Parte do pai" value={formatBRL(m.transfer_total)} pct={transferShare} />
                  <Legend color="bg-success" label="Lucro" value={formatBRL(m.profit_total)} pct={profitShare} />
                </div>
              </div>

              <div>
                <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="min-w-0 break-words">Recebido × A receber</span>
                </div>
                <div className="flex h-3 w-full min-w-0 max-w-full overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full min-w-0 bg-gradient-to-r from-success/70 to-success"
                    style={{ width: `${receivedShare}%` }}
                  />
                  <div className="h-full min-w-0 bg-warning/80" style={{ width: `${receivableShare}%` }} />
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                  <Legend color="bg-success" label="Recebido" value={formatBRL(m.money_received)} pct={receivedShare} />
                  <Legend color="bg-warning" label="A receber" value={formatBRL(m.receivable)} pct={receivableShare} />
                </div>
              </div>
            </div>
          )}
        </Panel>
      </section>

      {/* Movimentações recentes */}
      <Panel
        title="Movimentações recentes"
        description={`${m.sales_count} vendas · ${m.units_sold} unidades no período`}
        icon={Receipt}
        action={
          <Link href={salesUrl} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            Ver todas <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        }
        bodyClassName="p-0"
      >
        {dashboard.sales.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nenhuma venda neste recorte.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {dashboard.sales.map((sale) => (
              <li key={sale.id}>
                <Link
                  href={buildFilterUrl(`/vendas/${sale.id}`, { voltar: currentUrl })}
                  className="flex min-w-0 items-start gap-3 px-4 py-3 transition-colors hover:bg-primary/5 sm:items-center"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground">
                    <Receipt className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">{sale.customer_name}</p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                      {formatDate(sale.sale_date)} · {sale.items_label}
                    </p>
                  </div>
                  <div className="flex min-w-0 shrink-0 flex-col items-end gap-1">
                    <span className="break-words text-right font-display font-semibold tabular-nums">{formatBRL(sale.total_amount)}</span>
                    <span className="flex flex-wrap justify-end gap-1">
                      <PaymentBadge name={sale.payment_status_name} received={sale.counts_as_received} />
                      {sale.is_credit ? <CreditBadge /> : null}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Legend({
  color,
  label,
  value,
  pct,
}: {
  color: string;
  label: string;
  value: string;
  pct: number;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-sm", color)} />
      <div className="min-w-0">
        <p className="break-words text-xs text-muted-foreground">
          {label} · {pct.toFixed(0)}%
        </p>
        <p className="break-words font-medium tabular-nums">{value}</p>
      </div>
    </div>
  );
}
