import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { loadCatalog } from "@/lib/data/catalog";
import { getSale } from "@/lib/data/sales";
import { formatDate, shortId } from "@/lib/format";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { SaleEditor } from "@/components/sales/sale-editor";
import { isConsultasRole } from "@/lib/domain/roles";
import { Panel } from "@/components/ui/panel";
import { buttonVariants } from "@/components/ui/button";

export const metadata = { title: "Venda" };

function saleReturnPath(value: string | string[] | undefined) {
  const path = Array.isArray(value) ? value[0] : value;
  return path && /^\/(?:inicio|relatorios|repasses|vendas)(?:\?[^#\\\u0000-\u001F\u007F]*)?$/.test(path)
    ? path
    : "/vendas";
}

export default async function VendaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const backHref = saleReturnPath(query.voltar);
  const backLabel = backHref.startsWith("/inicio")
    ? "Voltar ao início"
    : backHref.startsWith("/relatorios")
      ? "Voltar aos relatórios"
      : backHref.startsWith("/repasses")
        ? "Voltar aos repasses"
        : "Voltar às vendas";
  const session = await getSessionState();
  const consultas = session.status === "ok" && isConsultasRole(session.profile.role_code);
  const [sale, catalog] = await Promise.all([
    getSale(id, consultas),
    loadCatalog(),
  ]);

  if (!sale.ok) {
    if (sale.message === "Venda não encontrada.") notFound();
    return <Notice>{sale.message}</Notice>;
  }
  if (!catalog.ok) return <Notice>{catalog.message}</Notice>;

  const canWrite = session.status === "ok" && session.profile.can_write;
  const canCorrectOrigin = session.status === "ok" && session.profile.role_code.toLowerCase() === "admin" && sale.sale.is_valid;
  const correctionBatches = [...new Map((catalog.data.batchItems ?? [])
    .filter((item) => item.status === "ABERTO" && sale.items.some((line) => line.product_id === item.product_id && line.variant_id === item.variant_id))
    .map((item) => [item.batch_id, item])).values()];

  return (
    <div className="w-full min-w-0">
      <PageHeading
        title={sale.sale.customer_name}
        eyebrow={`Venda #${shortId(sale.sale.id)}`}
        back={{ href: backHref, label: backLabel }}
        description={`${formatDate(sale.sale.sale_date)} · ${sale.sale.product_name} · ${sale.sale.variant_name}`}
      />
      <SaleEditor sale={sale.sale} items={sale.items} batchAllocations={sale.batchAllocations} catalog={catalog.data} audit={sale.audit} canWrite={canWrite} consultas={consultas} />
      {canCorrectOrigin ? <Panel className="mt-5" title="Corrigir lote da venda" description="Escolha o lote de destino para revisar somente o item e a quantidade necessários.">
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">A correção mantém os preços, pagamentos, repasses e a quantidade vendida. O impacto no custo e no lucro da parcela realocada será apresentado antes de confirmar.</p>
          {correctionBatches.length ? <div className="flex flex-wrap gap-2">{correctionBatches.map((batch) => <Link key={batch.batch_id} href={"/lotes/" + batch.batch_id + "/editar?venda=" + id + "#vincular-venda"} className={buttonVariants({ variant: "outline", size: "sm" })}>{"Lote " + String(batch.batch_number).padStart(3, "0")}</Link>)}</div> : <p className="text-sm text-muted-foreground">Não há lote em andamento com o mesmo produto e sabor para revisar esta origem.</p>}
        </div>
      </Panel> : null}
    </div>
  );
}
