import Link from "next/link";
import { getSessionState } from "@/lib/auth";
import { getBatchEditorData, listBatchLinkedSales, searchBatchCorrectionSales } from "@/lib/data/batches";
import { formatDate, formatDateTime, shortId } from "@/lib/format";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { BatchEditor } from "@/components/stock/batch-editor";
import { SaleBatchCorrection } from "@/components/stock/sale-batch-correction";
import { Panel } from "@/components/ui/panel";

export const metadata = { title: "Editar lote" };

export default async function EditarLotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { id }, query] = await Promise.all([getSessionState(), params, searchParams]);
  if (session.status !== "ok" || session.profile.role_code.toLowerCase() !== "admin") return <Notice>Somente o Administrador pode editar lotes e corrigir vínculos de vendas.</Notice>;
  const result = await getBatchEditorData(id);
  if (!result.ok) return <Notice>{result.message}</Notice>;
  const { batch, items, catalog, sales } = result;
  if (batch.status !== "ABERTO") return <Notice>A edição manual está disponível somente para lotes em andamento. Este lote está {batch.status.toLowerCase()}.</Notice>;
  const initialQuery = typeof query.venda === "string" ? query.venda.slice(0, 200) : "";
  const [linked, initialSearch] = await Promise.all([
    listBatchLinkedSales(id),
    initialQuery ? searchBatchCorrectionSales(id, initialQuery) : Promise.resolve({ ok: true as const, sales }),
  ]);

  return <div className="grid w-full min-w-0 gap-5">
    <PageHeading title={"Editar Lote " + String(batch.batch_number).padStart(3, "0")} eyebrow="Correção auditada" back={{ href: "/lotes/" + id, label: "Voltar ao lote" }} description="Corrija a compra original ou a origem de unidades já vendidas. Cada operação tem sua própria prévia e confirmação." />
    <BatchEditor key={batch.batch_id + batch.total_purchased + batch.capital_invested + (batch.notes ?? "") + batch.purchase_date} batch={batch} items={items} catalog={catalog} />
    {!initialSearch.ok ? <Notice>{initialSearch.message}</Notice> : null}
    <SaleBatchCorrection key={batch.batch_id + initialQuery + items.map((item) => item.quantity_remaining).join(":")} batch={batch} items={items} initialQuery={initialQuery} initialSales={initialSearch.ok ? initialSearch.sales : []} />
    <Panel title="Vendas vinculadas" description="Confira a data da venda e a data do cadastro. As quantidades abaixo pertencem a este lote.">
      {!linked.ok ? <Notice>{linked.message}</Notice> : !linked.sales.length ? <p className="text-sm text-muted-foreground">Nenhuma venda ativa vinculada a este lote.</p> : <div className="grid gap-3">{linked.sales.map((sale) => <div key={sale.id} className="grid gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
        <Link href={"/vendas/" + sale.id} className="font-semibold text-primary underline underline-offset-4">{sale.customer_name} · #{shortId(sale.id)}</Link>
        <p className="text-xs text-muted-foreground">Ocorrida em {formatDate(sale.sale_date)} · Cadastrada em {formatDateTime(sale.created_at)}</p>
        <p>{sale.items_label} · <strong>{sale.quantity}</strong> unidade(s) neste lote</p>
      </div>)}</div>}
    </Panel>
  </div>;
}
