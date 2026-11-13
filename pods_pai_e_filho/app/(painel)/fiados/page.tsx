import Link from "next/link";
import { redirect } from "next/navigation";
import { Bookmark, ChevronLeft, ChevronRight, Clock, Send } from "lucide-react";
import { getOpenCreditSummary, listSales } from "@/lib/data/sales";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { SaleList } from "@/components/sales/sale-list";
import { StatCard } from "@/components/ui/stat-card";
import { getSessionState } from "@/lib/auth";
import { isConsultasRole } from "@/lib/domain/roles";
import { fiadosHref, FIADOS_PAGE_SIZE, parseFiadosPage } from "@/lib/domain/credit-sales";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata = { title: "Fiados" };

export default async function FiadosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const page = parseFiadosPage(query.pagina);
  const session = await getSessionState();
  if (session.status === "ok" && (isConsultasRole(session.profile.role_code) || !session.profile.can_write)) redirect("/repasses");
  const [sales, summaryResult] = await Promise.all([
    listSales({
      openCredit: true,
      limit: FIADOS_PAGE_SIZE,
      offset: (page - 1) * FIADOS_PAGE_SIZE,
      includeCount: true,
      includeCosts: false,
    }),
    getOpenCreditSummary(),
  ]);
  const totalCount = sales.ok ? sales.totalCount : null;
  const totalPages = totalCount === null ? 1 : Math.max(1, Math.ceil(totalCount / FIADOS_PAGE_SIZE));
  if (sales.ok && totalCount !== null && page > totalPages) redirect(fiadosHref(totalPages));
  const returnPath = fiadosHref(page);

  return (
    <div className="grid w-full min-w-0 gap-5">
      <PageHeading
        title="Fiados"
        eyebrow="Financeiro"
        description="Indicadores do total em aberto; a lista mostra até 50 vendas por página."
      />
      {summaryResult.ok ? (
        <section className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="Fiados em aberto" value={summaryResult.summary.count} kind="int" icon={Bookmark} tone="warning" />
          <StatCard label="A receber dos clientes" value={summaryResult.summary.receivable} icon={Clock} tone="warning" />
          <StatCard
            label="Repasse pendente ao pai"
            value={summaryResult.summary.transferPending}
            icon={Send}
            tone="primary"
            hint="Parte destes fiados ainda em “A enviar ao pai agora”"
            className="sm:col-span-2 lg:col-span-1"
          />
        </section>
      ) : null}
      {!summaryResult.ok ? <Notice>Não foi possível carregar os indicadores de fiados. {summaryResult.message}</Notice> : null}
      {!sales.ok ? <Notice>{sales.message}</Notice> : totalCount === null ? (
        <Notice>Não foi possível carregar a quantidade total de fiados. Atualize a página para tentar novamente.</Notice>
      ) : (
        <>
          <SaleList sales={sales.sales} returnPath={returnPath} />
          {totalCount > 0 ? (
            <nav aria-label="Paginação de fiados" className="tech-card grid min-w-0 gap-3 p-3 md:p-4">
              <p className="text-center text-sm text-muted-foreground" role="status">
                Exibindo {(page - 1) * FIADOS_PAGE_SIZE + 1}–{(page - 1) * FIADOS_PAGE_SIZE + sales.sales.length} de {totalCount} registros
              </p>
              <div className="flex min-w-0 items-center justify-between gap-2">
                {page > 1 ? (
                  <Link href={fiadosHref(page - 1)} rel="prev" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 px-2 sm:px-3")}>
                    <ChevronLeft aria-hidden="true" /> Anterior
                  </Link>
                ) : (
                  <button type="button" disabled className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 px-2 sm:px-3")}>
                    <ChevronLeft aria-hidden="true" /> Anterior
                  </button>
                )}
                <span className="min-w-0 text-center text-xs tabular-nums text-muted-foreground">
                  Página {page} de {totalPages}
                </span>
                {page < totalPages ? (
                  <Link href={fiadosHref(page + 1)} rel="next" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 px-2 sm:px-3")}>
                    Próxima <ChevronRight aria-hidden="true" />
                  </Link>
                ) : (
                  <button type="button" disabled className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 px-2 sm:px-3")}>
                    Próxima <ChevronRight aria-hidden="true" />
                  </button>
                )}
              </div>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
