import Link from "next/link";
import { ArrowDownToLine, ArrowUpRight, Layers3, Pencil } from "lucide-react";
import { getSessionState } from "@/lib/auth";
import { listBatches } from "@/lib/data/batches";
import { formatBRL, formatDate } from "@/lib/format";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";

export const metadata = { title: "Lotes" };

function batchLabel(number: number) {
  return "Lote " + String(number).padStart(3, "0");
}

export default async function LotesPage() {
  const [session, result] = await Promise.all([getSessionState(), listBatches()]);
  if (session.status !== "ok") return <Notice>Não foi possível carregar seu perfil.</Notice>;
  const admin = session.profile.can_write;
  const canEdit = session.profile.role_code.toLowerCase() === "admin";

  return (
    <div className="grid w-full min-w-0 gap-5">
      <PageHeading
        title="Lotes"
        eyebrow="Ciclos de compra"
        description="Cada lote acompanha uma compra, o estoque restante e os resultados das unidades vendidas."
        action={admin ? { href: "/lotes/estoque-legado", label: "Associar estoque legado" } : undefined}
      />
      {!result.ok ? <Notice>Execute a migration de lotes no Supabase para habilitar esta tela.</Notice> : null}
      {result.ok && result.batches.length === 0 ? (
        <Panel title="Ainda não há lotes" icon={Layers3}>
          <p className="text-sm text-muted-foreground">
            Compras registradas depois da implantação aparecerão aqui. O estoque anterior permanece sem lote, sem atribuir uma origem que não foi registrada.
          </p>
        </Panel>
      ) : null}
      {result.ok && result.batches.length > 0 ? (
        <div className="grid gap-3">
          {result.batches.map((batch) => (
            <div key={batch.batch_id}
              className="tech-card grid min-w-0 gap-4 p-4 transition-colors hover:border-primary/50 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="grid min-w-0 gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 className="font-display text-lg font-bold"><Link href={"/lotes/" + batch.batch_id} className="hover:text-primary">{batchLabel(batch.batch_number)}</Link></h2>
                  {batch.is_legacy ? <Badge variant="info">ESTOQUE LEGADO</Badge> : null}
                  <Badge variant={batch.status === "ABERTO" ? "warning" : batch.status === "FINALIZADO" ? "success" : "neutral"}>{batch.status}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{batch.is_legacy ? "Associado em " : "Compra em "}{formatDate(batch.purchase_date)}</p>
                <p className="text-sm">
                  {batch.total_purchased} comprados <span className="text-muted-foreground">·</span> {batch.quantity_sold} vendidos
                  <span className="text-muted-foreground"> · </span>{batch.quantity_remaining} restantes
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:min-w-64">
                <p><span className="block text-xs text-muted-foreground">Capital investido</span><strong>{formatBRL(batch.capital_invested)}</strong></p>
                <p><span className="block text-xs text-muted-foreground">Capital em estoque</span><strong>{formatBRL(batch.capital_in_stock)}</strong></p>
                <p><span className="block text-xs text-muted-foreground">Capital recuperado</span><strong>{formatBRL(batch.capital_recovered)}</strong></p>
                <p><span className="block text-xs text-muted-foreground">{admin ? "Lucro do pai" : "Meu lucro"}</span><strong>{formatBRL(batch.father_profit)}</strong></p>
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <Link href={"/lotes/" + batch.batch_id} className={buttonVariants({ variant: "outline", size: "sm" })}>Ver detalhes<ArrowUpRight /></Link>
                {canEdit && batch.status === "ABERTO" ? <Link href={"/lotes/" + batch.batch_id + "/editar"} className={buttonVariants({ variant: "secondary", size: "sm" })}><Pencil />Editar lote</Link> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {admin && result.ok ? (
        <Panel title="Estoque sem lote" description="Movimentos anteriores permanecem sem origem inventada." icon={ArrowDownToLine}>
          <p className="text-sm text-muted-foreground">
            O estoque legado e ajustes sem origem continuam no saldo geral e podem ser vendidos sem vínculo a lote. Custos antigos não são estimados.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
