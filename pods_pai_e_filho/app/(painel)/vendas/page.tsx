import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { loadCatalog } from "@/lib/data/catalog";
import { listSales } from "@/lib/data/sales";
import { listBatches } from "@/lib/data/batches";
import { getSessionState } from "@/lib/auth";
import { PageHeading } from "@/components/shell/page-heading";
import { SaleList } from "@/components/sales/sale-list";
import { Notice } from "@/components/feedback/notice";
import { controlClass } from "@/components/ui/field";
import { IceFilterSelect } from "@/components/catalog/flavor-filters";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isConsultasRole } from "@/lib/domain/roles";
import { formatBatchLabel, resolveBatchFilter } from "@/lib/domain/batch-filters";
import { normalizeSalesHistoryParams, parseSalesHistoryPage, SALES_HISTORY_PAGE_SIZE, salesHistoryHref } from "@/lib/domain/sales-history";

export const metadata = { title: "Vendas" };

export default async function VendasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = normalizeSalesHistoryParams(await searchParams);
  const page = parseSalesHistoryPage(params.pagina);
  const [session, batches] = await Promise.all([getSessionState(), listBatches()]);
  const consultas = session.status === "ok" && isConsultasRole(session.profile.role_code);
  if (consultas) delete params.fiado;
  if (!batches.ok) {
    return (
      <div className="grid w-full min-w-0 gap-4">
        <PageHeading title="Vendas" />
        <Notice>Não foi possível carregar os lotes. {batches.message}</Notice>
      </div>
    );
  }
  const selected = resolveBatchFilter(batches.batches, params.lote);
  params.lote = selected.value;
  if (selected.shouldCanonicalize) {
    redirect(salesHistoryHref(params, page));
  }
  const [catalog, sales] = await Promise.all([
    loadCatalog(),
    listSales({
      from: params.de,
      to: params.ate,
      productId: params.produto,
      customerTypeId: params.tipo,
      paymentStatusId: params.status,
      credit: consultas ? undefined : params.fiado,
      consultas,
      ice: params.ice,
      flavor: params.sabor,
      customer: params.cliente,
      situation: params.situacao,
      batchId: selected.batchId ?? undefined,
      limit: SALES_HISTORY_PAGE_SIZE,
      offset: (page - 1) * SALES_HISTORY_PAGE_SIZE,
      includeCount: true,
    }),
  ]);
  const canWrite = session.status === "ok" && session.profile.can_write;
  const field = cn(controlClass, "h-11");
  const totalCount = sales.ok ? sales.totalCount : null;
  const totalPages = totalCount === null ? 1 : Math.max(1, Math.ceil(totalCount / SALES_HISTORY_PAGE_SIZE));
  if (sales.ok && totalCount !== null && page > totalPages) {
    redirect(salesHistoryHref(params, totalPages));
  }
  const returnPath = salesHistoryHref(params, page);

  return (
    <div className="w-full min-w-0">
      <PageHeading
        title="Vendas"
        eyebrow={totalCount !== null ? `${totalCount} registro(s)` : undefined}
        description={`${selected.label} · Histórico com os valores praticados em cada venda.`}
        action={canWrite ? { href: "/vendas/nova", label: "Nova venda", icon: "plus" } : undefined}
      />
      {!catalog.ok ? <Notice>{catalog.message}</Notice> : null}

      <form key={returnPath} className="tech-card mb-4 grid gap-2 p-3 md:p-4" method="get">
        <p className="eyebrow flex items-center gap-1.5">
          <Filter className="h-3 w-3" /> Filtros
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
          <input className={field} type="date" name="de" defaultValue={params.de ?? ""} aria-label="De" />
          <input className={field} type="date" name="ate" defaultValue={params.ate ?? ""} aria-label="Até" />
          <input
            className={cn(field, "sm:col-span-2")}
            name="cliente"
            placeholder="Cliente"
            defaultValue={params.cliente ?? ""}
          />
          <select className={field} name="lote" defaultValue={selected.value} aria-label="Lote">
            <option value="todos">Todos os lotes</option>
            {batches.batches.map((batch) => (
              <option key={batch.batch_id} value={batch.batch_id}>
                {formatBatchLabel(batch)}{batch.is_legacy ? " · estoque legado" : ""}
              </option>
            ))}
          </select>
          <select className={field} name="produto" defaultValue={params.produto ?? ""} aria-label="Produto">
            <option value="">Todos os produtos</option>
            {catalog.ok
              ? catalog.data.products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))
              : null}
          </select>
          <select className={field} name="tipo" defaultValue={params.tipo ?? ""} aria-label="Tipo de cliente">
            <option value="">Todos os tipos</option>
            {catalog.ok
              ? catalog.data.customerTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))
              : null}
          </select>
          <select className={field} name="status" defaultValue={params.status ?? ""} aria-label="Status">
            <option value="">Todos os status</option>
            {catalog.ok
              ? catalog.data.statuses
                  .filter((status) => status.active)
                  .map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.name}
                    </option>
                  ))
              : null}
          </select>
          {!consultas ? (
            <select className={field} name="fiado" defaultValue={params.fiado ?? ""} aria-label="Fiado">
              <option value="">Fiado: todos</option>
              <option value="sim">Só fiado</option>
              <option value="nao">Sem fiado</option>
            </select>
          ) : null}
          <IceFilterSelect defaultValue={params.ice} className={field} />
          <input
            className={field}
            name="sabor"
            placeholder="Sabor (ex.: Grape Ice)"
            defaultValue={params.sabor ?? ""}
            aria-label="Sabor"
          />
          <select className={field} name="situacao" defaultValue={params.situacao ?? ""} aria-label="Situação">
            <option value="">Válidas</option>
            <option value="canceladas">Canceladas</option>
            <option value="todas">Todas</option>
          </select>
          <button className={cn(buttonVariants(), "h-11 w-full md:col-span-4")} type="submit">
            Filtrar
          </button>
          <Link href="/vendas" className={cn(buttonVariants({ variant: "ghost" }), "h-11 w-full md:col-span-4")}>
            Limpar filtros
          </Link>
        </div>
      </form>

      {!sales.ok ? <Notice>{sales.message}</Notice> : totalCount === null ? (
        <Notice>Não foi possível carregar a contagem de vendas. Atualize a página para tentar novamente.</Notice>
      ) : (
        <>
          <SaleList sales={sales.sales} consultas={consultas} returnPath={returnPath} />
          {totalCount > 0 ? (
            <nav aria-label="Paginação de vendas" className="tech-card mt-4 grid min-w-0 gap-3 p-3 md:p-4">
              <p className="text-center text-sm text-muted-foreground" role="status">
                Mostrando {(page - 1) * SALES_HISTORY_PAGE_SIZE + 1}–{(page - 1) * SALES_HISTORY_PAGE_SIZE + sales.sales.length} de {totalCount} vendas
              </p>
              <div className="flex min-w-0 items-center justify-between gap-2">
                {page > 1 ? (
                  <Link href={salesHistoryHref(params, page - 1)} rel="prev" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 px-2 sm:px-3")}>
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
                  <Link href={salesHistoryHref(params, page + 1)} rel="next" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 px-2 sm:px-3")}>
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
