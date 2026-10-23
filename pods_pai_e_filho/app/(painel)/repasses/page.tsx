import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth";
import { listBatches } from "@/lib/data/batches";
import { loadFinancialSales } from "@/lib/data/financial-sales";
import { consultasSummaryForBatchSales } from "@/lib/domain/batch-sales";
import { buildFilterUrl, formatBatchLabel, resolveBatchFilter } from "@/lib/domain/batch-filters";
import { resolvePeriod } from "@/lib/format";
import { Notice } from "@/components/feedback/notice";
import { PageHeading } from "@/components/shell/page-heading";
import { TransferBoard } from "@/components/transfers/transfer-board";
import { TransferFilters } from "@/components/transfers/transfer-filters";
import { isConsultasRole } from "@/lib/domain/roles";

export const metadata = { title: "Repasses" };

export default async function RepassesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const params: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(rawParams).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  );
  const [session, batchesResult] = await Promise.all([getSessionState(), listBatches()]);
  if (session.status !== "ok") return <Notice>Não foi possível carregar seu perfil. Entre novamente.</Notice>;
  const consultas = isConsultasRole(session.profile.role_code) || !session.profile.can_write;
  const canWrite = session.profile.can_write && !consultas;
  const title = consultas ? "Financeiro" : "Repasses";

  // Without the batch lookup, the initial scope cannot be resolved safely.
  if (!batchesResult.ok) {
    return (
      <div className="grid w-full min-w-0 gap-4">
        <PageHeading title={title} eyebrow="Financeiro" />
        <Notice>Não foi possível carregar os lotes. {batchesResult.message}</Notice>
      </div>
    );
  }
  const batchFilter = resolveBatchFilter(batchesResult.batches, params.lote);
  if (batchFilter.shouldCanonicalize) {
    redirect(buildFilterUrl("/repasses", params, { lote: batchFilter.value }));
  }
  const initialTab: "agora" | "futuro" | "pagos" = params.aba === "futuro" || params.aba === "pagos" ? params.aba : "agora";
  const filters = {
    batches: batchesResult.batches.map((batch) => ({ value: batch.batch_id, label: formatBatchLabel(batch) })),
    batchValue: batchFilter.value,
    batchLabel: batchFilter.label,
    params,
    initialTab,
  };
  const period = resolvePeriod(params);
  // Cards, counters and lists share the complete set of historical allocations.
  const financial = await loadFinancialSales({
    batchId: batchFilter.batchId ?? undefined,
    consultas,
    from: period.from ?? params.de,
    to: period.to ?? params.ate,
    productId: params.produto,
    customer: params.cliente,
    customerTypeId: params.tipo,
    paymentStatusId: params.status,
    credit: consultas ? undefined : params.fiado,
    ice: params.ice,
    flavor: params.sabor,
  });
  const summary = financial.ok && consultas ? consultasSummaryForBatchSales(financial.lines) : null;
  const validSales = financial.sales.filter((sale) => sale.is_valid);

  return (
    <div className="w-full min-w-0">
      <PageHeading
        title={title}
        eyebrow="Financeiro"
        description={consultas ? "Acompanhe seus repasses pendentes e recebidos." : "A enviar agora junta venda recebida ou fiada cujo repasse ainda não foi pago."}
      />
      {!financial.ok ? (
        <div className="grid min-w-0 gap-4">
          <TransferFilters {...filters} />
          <Notice>{financial.message}</Notice>
        </div>
      ) : (
        <TransferBoard
          key={buildFilterUrl("/repasses", params, { lote: batchFilter.value, aba: initialTab })}
          {...filters}
          dueNow={validSales.filter((sale) => sale.transfer_due_now)}
          future={validSales.filter((sale) => sale.transfer_is_future)}
          paid={validSales.filter((sale) => sale.transfer_paid)}
          canWrite={canWrite}
          consultas={consultas}
          receivedTotal={Number(summary?.transfer_received ?? 0)}
          fatherProfitReceived={Number(summary?.father_profit_received ?? 0)}
          fatherProfitMissingItems={Number(summary?.father_profit_missing_received_items ?? 0)}
        />
      )}
    </div>
  );
}
