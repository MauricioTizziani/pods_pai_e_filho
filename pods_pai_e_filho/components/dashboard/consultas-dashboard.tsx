import Link from "next/link";
import { AlertTriangle, ArrowRight, Banknote, Clock, HandCoins, Package, PiggyBank, Receipt, Send, TrendingUp, type LucideIcon } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { DashboardFilters, type DashboardFiltersProps } from "@/components/dashboard/dashboard-filters";
import { Notice } from "@/components/feedback/notice";
import { Panel } from "@/components/ui/panel";
import { PaymentBadge, StockBadge } from "@/components/sales/badges";
import { formatBRL, formatDate } from "@/lib/format";
import { getLowStockProducts, summarizeActiveProductStock } from "@/lib/domain/stock";
import { buildFilterUrl } from "@/lib/domain/batch-filters";
import type { ConsultasFinancialSummary } from "@/lib/types";
import type { loadDashboard } from "@/lib/data/dashboard";
import { cn } from "@/lib/utils";

type DashboardData = Extract<Awaited<ReturnType<typeof loadDashboard>>, { ok: true }>;

export function ConsultasDashboard({
  dashboard,
  summary,
  periodLabel,
  batchLabel,
  filters,
  currentUrl,
  salesUrl,
  batchNotice,
}: {
  dashboard: DashboardData;
  summary: ConsultasFinancialSummary;
  periodLabel: string;
  batchLabel: string;
  filters: DashboardFiltersProps;
  currentUrl: string;
  salesUrl: string;
  batchNotice?: string;
}) {
  const n = (value: string | number | null | undefined) => Number(value ?? 0) || 0;
  const productStock = summarizeActiveProductStock(dashboard.products, dashboard.stock);
  const stockTotal = productStock.reduce((total, product) => total + product.quantity, 0);
  const stockedProductCount = productStock.filter((product) => product.quantity > 0).length;
  const low = getLowStockProducts(productStock, dashboard.lowStockThreshold);
  const soldComposition = n(summary.cost_sold) + n(summary.father_profit_total);
  const costShare = soldComposition > 0 ? (n(summary.cost_sold) / soldComposition) * 100 : 0;
  const fatherProfitShare = soldComposition > 0 ? (n(summary.father_profit_total) / soldComposition) * 100 : 0;
  const costUnknown = Number(summary.cost_missing_items) > 0;
  const stockCostUnknown = Number(summary.stock_cost_missing_products) > 0;

  return (
    <div className="grid w-full min-w-0 gap-5">
      <header className="grid gap-1">
        <p className="eyebrow">Visão financeira · CONSULTAS</p>
        <h1 className="font-display text-2xl font-bold">Início</h1>
        <p className="text-sm text-muted-foreground">{batchLabel} · {periodLabel}</p>
      </header>

      {batchNotice ? <Notice>{batchNotice}</Notice> : null}
      <div className="order-last md:order-none">
        <DashboardFilters key={currentUrl} {...filters} />
      </div>

      <section className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="A receber agora" value={n(summary.transfer_due_now)} icon={Send} featured hint={`${summary.due_now_sales} venda(s) · com repasse pendente`} href={buildFilterUrl("/repasses", filters.params, { lote: filters.batchValue, aba: "agora" })} />
        <StatCard label="A receber futuramente" value={n(summary.transfer_future)} icon={Clock} tone="info" hint={`${summary.future_sales} venda(s) ainda não recebidas`} href={buildFilterUrl("/repasses", filters.params, { lote: filters.batchValue, aba: "futuro" })} />
        {costUnknown ? <UncertainMoneyCard label="Meu lucro" value={n(summary.father_profit_total)} unknown missing={summary.father_profit_missing_items} icon={TrendingUp} featured /> : <StatCard label="Meu lucro" value={n(summary.father_profit_total)} icon={TrendingUp} tone="success" accent hint="Lucro do pai nas vendas válidas deste recorte" />}
        {Number(summary.father_profit_missing_received_items) > 0 ? <UncertainMoneyCard label="Lucro já recebido" value={n(summary.father_profit_received)} unknown missing={summary.father_profit_missing_received_items} icon={PiggyBank} /> : <StatCard label="Lucro já recebido" value={n(summary.father_profit_received)} icon={PiggyBank} tone="success" hint="Lucro referente aos repasses já pagos" />}
        <StatCard label="Total já recebido" value={n(summary.transfer_received)} icon={HandCoins} tone="primary" accent hint="Repasses marcados como pagos" />
        <UncertainMoneyCard label="Custo dos produtos vendidos" value={n(summary.cost_sold)} unknown={costUnknown} missing={summary.cost_missing_items} icon={Banknote} />
        <UncertainMoneyCard label="Estoque a custo · geral" value={n(summary.stock_cost_total)} unknown={stockCostUnknown} missing={summary.stock_cost_missing_products} icon={Package} href="/estoque" />
        <StatCard label="Faturamento vendido" value={n(summary.revenue)} icon={Receipt} hint={`${summary.sales_count} venda(s) · ${summary.units_sold} unidade(s) · total cobrado dos clientes`} href={salesUrl} />
        <StatCard label="Estoque atual · geral" value={stockTotal} kind="int" suffix="un" icon={Package} tone={low.length > 0 ? "warning" : "success"} hint={`${stockedProductCount} produto(s) com saldo`} href="/estoque" />
      </section>

      <section className="grid min-w-0 gap-3 lg:grid-cols-2">
        <Panel title="Estoque geral disponível" description={`${stockTotal} unidades em ${stockedProductCount} produto(s)`} icon={Package} action={<Link href="/estoque" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Ver estoque <ArrowRight className="h-3.5 w-3.5" /></Link>}>
          {productStock.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum produto ativo.</p> : (
            <ul className="grid gap-3">
              {productStock.map((product) => (
                <li key={product.product_id} className="grid gap-1.5">
                  <div className="flex min-w-0 items-center justify-between gap-3 text-sm"><span className="min-w-0 break-words font-medium">{product.product_name}</span><span className="shrink-0 font-display font-semibold tabular-nums">{product.quantity} un</span></div>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(3, (product.quantity / Math.max(1, ...productStock.map((item) => item.quantity))) * 100)}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
          {low.length > 0 ? <div className="mt-4 grid gap-2 border-t border-border/70 pt-4 text-sm"><span className="inline-flex items-center gap-1.5 text-warning"><AlertTriangle className="h-4 w-4" />Estoque baixo · geral:</span>{low.map((product) => <div key={product.product_id} className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{product.product_name}</span><span className="flex items-center gap-2"><StockBadge quantity={product.quantity} threshold={dashboard.lowStockThreshold} /><span className="text-muted-foreground">{product.quantity} un</span></span></div>)}</div> : null}
        </Panel>

        <Panel title="Composição dos repasses" description="Recuperação do custo e lucro do pai" icon={Banknote}>
          {costUnknown ? <p className="text-sm text-muted-foreground">O custo histórico de {summary.cost_missing_items} item(ns) não foi informado. A composição completa não pode ser calculada.</p> : soldComposition <= 0 ? <p className="text-sm text-muted-foreground">Sem vendas neste período.</p> : (
            <div className="grid gap-4">
              <div className="flex h-3 w-full min-w-0 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-gradient-to-r from-primary-deep to-primary" style={{ width: `${costShare}%` }} /><div className="h-full bg-gradient-to-r from-success/70 to-success" style={{ width: `${fatherProfitShare}%` }} /></div>
              <div className="grid gap-2 text-sm sm:grid-cols-2"><Legend label="Recuperação do custo" value={formatBRL(summary.cost_sold)} pct={costShare} color="bg-primary" /><Legend label="Lucro do pai" value={formatBRL(summary.father_profit_total)} pct={fatherProfitShare} color="bg-success" /></div>
            </div>
          )}
        </Panel>
      </section>

      <Panel title="Vendas recentes" description={`${summary.sales_count} venda(s) · ${summary.units_sold} unidade(s) no período`} icon={Receipt} action={<Link href={salesUrl} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Ver todas <ArrowRight className="h-3.5 w-3.5" /></Link>} bodyClassName="p-0">
        {dashboard.sales.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nenhuma venda neste recorte.</p> : <ul className="divide-y divide-border/70">{dashboard.sales.map((sale) => <li key={sale.id}><Link href={buildFilterUrl(`/vendas/${sale.id}`, { voltar: currentUrl })} className="flex min-w-0 items-start gap-3 px-4 py-3 transition-colors hover:bg-primary/5 sm:items-center"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground"><Receipt className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="break-words font-medium">{sale.customer_name}</p><p className="mt-0.5 break-words text-xs text-muted-foreground">{formatDate(sale.sale_date)} · {sale.items_label}</p></div><div className="flex min-w-0 shrink-0 flex-col items-end gap-1"><span className="break-words text-right font-display font-semibold tabular-nums">{formatBRL(sale.total_amount)}</span><span className="flex flex-wrap justify-end gap-1"><PaymentBadge name={sale.payment_status_name} received={sale.counts_as_received} /></span></div></Link></li>)}</ul>}
      </Panel>
    </div>
  );
}

function UncertainMoneyCard({
  label,
  value,
  unknown,
  missing,
  icon: Icon,
  href,
  featured = false,
}: {
  label: string;
  value: number;
  unknown: boolean;
  missing: number;
  icon: LucideIcon;
  href?: string;
  featured?: boolean;
}) {
  const content = <><div className="flex min-w-0 items-start justify-between gap-3"><p className="eyebrow break-words">{label}</p><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span></div><p className={cn("mt-3 break-words font-display text-xl font-bold tabular-nums sm:text-2xl", unknown && "text-warning")}>{unknown ? "Dados incompletos" : formatBRL(value)}</p><p className="mt-2 break-words text-xs text-muted-foreground">{unknown ? `${missing} registro(s) sem preço de custo informado.` : "Valores calculados com custos registrados."}</p></>;
  const classes = cn("tech-card group relative w-full min-w-0 p-4", featured && "tech-card-glow hud-corners", href && "hover:border-primary/50");
  return href ? <Link href={href} className={classes}>{content}</Link> : <article className={classes}>{content}</article>;
}

function Legend({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  return <div className="flex min-w-0 items-start gap-2"><span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-sm", color)} /><div className="min-w-0"><p className="break-words text-xs text-muted-foreground">{label} · {pct.toFixed(0)}%</p><p className="break-words font-medium tabular-nums">{value}</p></div></div>;
}
