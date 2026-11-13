import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatBRL, formatDate } from "@/lib/format";
import type { SaleOverview } from "@/lib/types";
import { EmptyState } from "@/components/ui/empty-state";
import { CreditBadge, PaymentBadge, TransferBadge } from "@/components/sales/badges";

export function SaleList({ sales, consultas = false, returnPath }: { sales: SaleOverview[]; consultas?: boolean; returnPath?: string }) {
  const saleHref = (id: string) => `/vendas/${id}${returnPath ? `?voltar=${encodeURIComponent(returnPath)}` : ""}`;
  if (sales.length === 0) {
    return (
      <EmptyState
        title="Nenhuma venda encontrada"
        description="Ajuste os filtros ou registre a primeira venda."
      />
    );
  }

  return (
    <>
      {/* Desktop: tabela */}
      <div className="tech-card hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="table-tech">
            <thead>
              <tr>
                <th>Data</th>
                <th>Cliente</th>
                <th>Produto</th>
                <th className="text-right">Qtd</th>
                <th className="text-right">{consultas ? "Venda" : "Total"}</th>
                <th className="text-right">{consultas ? "Meu repasse" : "Lucro"}</th>
                {consultas ? <th className="text-right">Meu lucro</th> : null}
                <th>Situação</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <tr key={sale.id} className="group">
                  <td className="whitespace-nowrap text-muted-foreground">{formatDate(sale.sale_date)}</td>
                  <td>
                    <Link href={saleHref(sale.id)} className="font-medium hover:text-primary">
                      {sale.customer_name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{sale.customer_type_name}</p>
                  </td>
                  <td className="text-muted-foreground">
                    {sale.product_name} · {sale.variant_name}
                  </td>
                  <td className="text-right tabular-nums">{sale.quantity}</td>
                  <td className="text-right font-display font-semibold tabular-nums">{formatBRL(sale.total_amount)}</td>
                  <td className={consultas ? "text-right tabular-nums" : "text-right tabular-nums text-success"}>{consultas ? formatBRL(sale.transfer_amount) : formatBRL(sale.profit_amount)}</td>
                  {consultas ? <td className="text-right tabular-nums text-success">{sale.cost_history_missing ? "Custo histórico não informado" : formatBRL(sale.father_profit_amount)}</td> : null}
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <PaymentBadge
                        name={sale.payment_status_name}
                        received={sale.counts_as_received}
                        cancelled={!sale.is_valid}
                      />
                      {!consultas && sale.is_credit ? <CreditBadge /> : null}
                      <TransferBadge
                        paid={sale.transfer_paid}
                        dueNow={sale.transfer_due_now}
                        future={sale.transfer_is_future}
                        cancelled={!sale.is_valid}
                        consultas={consultas}
                      />
                    </div>
                  </td>
                  <td>
                    <Link
                      href={saleHref(sale.id)}
                      aria-label={`Abrir venda de ${sale.customer_name}`}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile: cards */}
      <div className="stagger grid gap-3 md:hidden">
        {sales.map((sale) => (
          <Link
            key={sale.id}
            href={saleHref(sale.id)}
            className="tech-card press block min-w-0 p-4 transition-colors hover:border-primary/50"
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold">{sale.customer_name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span className="block sm:inline">{formatDate(sale.sale_date)}</span>
                  <span className="hidden sm:inline"> · </span>
                  <span className="block min-w-0 break-words sm:inline">{sale.product_name}</span>
                  <span className="hidden sm:inline"> · </span>
                  <span className="block min-w-0 break-words sm:inline">{sale.variant_name}</span>
                </p>
              </div>
              <p className="shrink-0 text-right font-display text-base font-bold tabular-nums sm:text-lg">
                {formatBRL(sale.total_amount)}
              </p>
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap gap-1">
              <PaymentBadge
                name={sale.payment_status_name}
                received={sale.counts_as_received}
                cancelled={!sale.is_valid}
              />
              {!consultas && sale.is_credit ? <CreditBadge /> : null}
              <TransferBadge
                paid={sale.transfer_paid}
                dueNow={sale.transfer_due_now}
                future={sale.transfer_is_future}
                cancelled={!sale.is_valid}
                consultas={consultas}
              />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/70 pt-3 text-xs">
              <span className="min-w-0">
                <span className="block text-muted-foreground">Qtd</span>
                <span className="font-medium tabular-nums">{sale.quantity} un</span>
              </span>
              {consultas ? (
                <>
                  <span className="min-w-0"><span className="block text-muted-foreground">Custo</span><span className="break-words font-medium tabular-nums">{sale.cost_history_missing ? "Custo histórico não informado" : formatBRL(sale.cost_amount)}</span></span>
                  <span className="min-w-0"><span className="block text-muted-foreground">Meu lucro</span><span className="break-words font-medium tabular-nums text-success">{sale.cost_history_missing ? "Custo histórico não informado" : formatBRL(sale.father_profit_amount)}</span></span>
                </>
              ) : (
                <span className="min-w-0">
                  <span className="block text-muted-foreground">Lucro</span>
                  <span className="break-words font-medium tabular-nums text-success">{formatBRL(sale.profit_amount)}</span>
                </span>
              )}
              <span className="min-w-0">
                <span className="block text-muted-foreground">Repasse</span>
                <span className="break-words font-medium tabular-nums">{formatBRL(sale.transfer_amount)}</span>
              </span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
