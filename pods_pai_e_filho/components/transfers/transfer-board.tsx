"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCheck, Clock, Send, HandCoins, TrendingUp, Loader2 } from "lucide-react";
import { confirmTransfersAction, previewTransfersAction } from "@/lib/actions/sales";
import { buildFilterUrl } from "@/lib/domain/batch-filters";
import type { TransferPaymentPreview } from "@/lib/domain/transfers";
import { formatBRL, formatDate, formatDateTime } from "@/lib/format";
import type { SaleOverview } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextArea } from "@/components/ui/field";
import { Notice } from "@/components/feedback/notice";
import { EmptyState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { TransferFilters, type TransferTab } from "@/components/transfers/transfer-filters";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "agora", label: "A enviar agora" },
  { id: "futuro", label: "Repasses futuros" },
  { id: "pagos", label: "Já enviados" },
] as const;

export function TransferBoard({
  dueNow,
  future,
  paid,
  canWrite,
  consultas = false,
  receivedTotal = 0,
  fatherProfitReceived = 0,
  fatherProfitMissingItems = 0,
  batches,
  batchValue,
  batchLabel,
  params,
  initialTab = "agora",
}: {
  dueNow: SaleOverview[];
  future: SaleOverview[];
  paid: SaleOverview[];
  canWrite: boolean;
  consultas?: boolean;
  receivedTotal?: number;
  fatherProfitReceived?: number;
  fatherProfitMissingItems?: number;
  batches: { value: string; label: string }[];
  batchValue: string;
  batchLabel: string;
  params: Record<string, string | undefined>;
  initialTab?: TransferTab;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operationInFlight = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<TransferPaymentPreview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [pending, startPayment] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [requestedFilter, setRequestedFilter] = useState({ batchValue, tab: initialTab });

  const tab = navigating ? requestedFilter.tab : initialTab;
  const activeBatch = navigating ? requestedFilter.batchValue : batchValue;
  const activeBatchLabel = activeBatch === "todos" ? "Todos os lotes" : batches.find((batch) => batch.value === activeBatch)?.label ?? batchLabel;
  const writable = canWrite && !consultas;

  const current = tab === "agora" ? dueNow : tab === "futuro" ? future : paid;
  const counts = { agora: dueNow.length, futuro: future.length, pagos: paid.length };
  const visibleTabs = tabs.map((item) => consultas
    ? { ...item, label: item.id === "agora" ? "A receber agora" : item.id === "futuro" ? "A receber futuramente" : "Já recebidos" }
    : item);
  const dueTotal = dueNow.reduce((total, sale) => total + Number(sale.transfer_amount), 0);
  const futureTotal = future.reduce((total, sale) => total + Number(sale.transfer_amount), 0);
  const paidTotal = paid.reduce((total, sale) => total + Number(sale.transfer_amount), 0);
  const selectedIds = selected.filter((id) => dueNow.some((sale) => sale.id === id));
  const selectedTotal = dueNow
    .filter((sale) => selectedIds.includes(sale.id))
    .reduce((total, sale) => total + Number(sale.transfer_amount), 0);
  const allSelected = dueNow.length > 0 && selectedIds.length === dueNow.length;
  const affectsOtherBatches = preview && preview.batchValue !== "todos"
    && preview.sales.some((sale) => sale.portions.some((portion) => portion.batchId !== preview.batchValue));
  const returnHref = buildFilterUrl("/repasses", params, { lote: batchValue, aba: tab });
  const emptyScope = batchValue === "todos" ? "nos filtros selecionados" : "para este lote";
  const emptyTitle = tab === "agora" ? `Nenhum repasse a ${consultas ? "receber" : "enviar"} ${emptyScope}.`
    : tab === "futuro" ? `Nenhum repasse futuro ${emptyScope}.`
      : `Nenhum repasse ${consultas ? "recebido" : "pago"} encontrado ${emptyScope}.`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (reviewOpen && !dialog.open) dialog.showModal();
    if (!reviewOpen && dialog.open) dialog.close();
    if (!reviewOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [reviewOpen]);

  function navigate(nextBatch: string, nextTab: TransferTab) {
    if (operationInFlight.current) return;
    setSelected([]);
    setPreview(null);
    setReviewOpen(false);
    setMessage(null);
    setRequestedFilter({ batchValue: nextBatch, tab: nextTab });
    startNavigation(() => {
      router.push(buildFilterUrl("/repasses", params, { lote: nextBatch, aba: nextTab, page: undefined, pagina: undefined }), { scroll: false });
    });
  }

  function toggle(id: string) {
    if (pending || navigating) return;
    setSelected((currentIds) =>
      currentIds.includes(id) ? currentIds.filter((item) => item !== id) : [...currentIds, id],
    );
  }

  function review(ids: string[]) {
    if (!writable || navigating || operationInFlight.current) return;
    const visibleIds = [...new Set(ids)].filter((id) => dueNow.some((sale) => sale.id === id));
    if (!visibleIds.length) return;
    operationInFlight.current = true;
    setMessage(null);
    setPreview(null);
    setReviewError(null);
    setReviewOpen(true);
    startPayment(async () => {
      try {
        const result = await previewTransfersAction(visibleIds, batchValue);
        if (!result.ok) {
          setReviewError(result.message);
          return;
        }
        setPreview(result.preview);
      } catch {
        setReviewError("Não foi possível conferir os repasses. Tente novamente.");
      } finally {
        operationInFlight.current = false;
      }
    });
  }

  function confirm() {
    if (!writable || !preview || preview.batchValue !== batchValue || operationInFlight.current) return;
    operationInFlight.current = true;
    setReviewError(null);
    startPayment(async () => {
      try {
        const result = await confirmTransfersAction(preview.saleIds, notes, preview);
        if (!result.ok) {
          setReviewError(result.message);
          setPreview(null);
          return;
        }
        setSelected([]);
        setNotes("");
        setPreview(null);
        setReviewOpen(false);
        setMessage("Repasse registrado. Os valores saíram de “A enviar ao pai agora”.");
        router.refresh();
      } catch {
        setReviewError("Não foi possível confirmar o repasse. Atualize os dados e confira a situação antes de tentar novamente.");
        setPreview(null);
      } finally {
        operationInFlight.current = false;
      }
    });
  }

  return (
    <div className="grid w-full min-w-0 gap-4">
      <TransferFilters batches={batches} batchValue={activeBatch} batchLabel={activeBatchLabel} params={params} initialTab={tab} pending={navigating} disabled={pending} onBatchChange={(value) => navigate(value, tab)} />
      {navigating ? (
        <div className="tech-card flex min-h-48 min-w-0 items-center justify-center gap-2 p-4 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
          <span className="break-words">Carregando repasses de {activeBatchLabel}…</span>
        </div>
      ) : <>
      {consultas ? (
        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="A receber agora" value={dueTotal} icon={Send} featured hint={`${dueNow.length} venda(s)`} />
          <StatCard label="A receber futuramente" value={futureTotal} icon={Clock} tone="info" hint={`${future.length} venda(s)`} />
          <StatCard label="Total já recebido" value={receivedTotal} icon={HandCoins} tone="success" hint="Repasses marcados como pagos" />
          {fatherProfitMissingItems > 0 ? (
            <article className="tech-card w-full min-w-0 p-4">
              <p className="eyebrow break-words">Lucro já recebido</p>
              <p className="mt-3 break-words font-display text-xl font-bold text-warning sm:text-2xl">Dados incompletos</p>
              <p className="mt-2 break-words text-xs text-muted-foreground">{fatherProfitMissingItems} item(ns) sem custo histórico.</p>
            </article>
          ) : <StatCard label="Lucro já recebido" value={fatherProfitReceived} icon={TrendingUp} tone="success" hint="Lucro incluído nos repasses recebidos" />}
        </div>
      ) : (
        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard label="A enviar ao pai agora" value={dueTotal} icon={Send} featured hint={`${dueNow.length} venda(s)`} />
          <StatCard label="Repasse futuro" value={futureTotal} icon={Clock} tone="info" hint={`${future.length} venda(s)`} />
          <StatCard label="Já enviados" value={paidTotal} icon={HandCoins} tone="success" hint={`${paid.length} venda(s)`} />
        </div>
      )}

      <div className="segmented grid w-full min-w-0 max-w-full grid-cols-1 sm:grid-cols-3" role="group" aria-label="Situação dos repasses">
        {visibleTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigate(activeBatch, item.id)}
            disabled={pending}
            aria-pressed={tab === item.id}
            data-active={tab === item.id}
            className="segmented-item min-w-0 gap-1.5 whitespace-normal px-2.5 text-xs sm:px-2 sm:text-sm"
          >
            <span className="min-w-0 break-words">{item.label}</span>
            <span
              className={cn(
                "rounded px-1.5 text-[10px] font-bold tabular-nums",
                tab === item.id ? "bg-primary-foreground/20" : "bg-surface-2 text-muted-foreground",
              )}
            >
              {counts[item.id]}
            </span>
          </button>
        ))}
      </div>

      {tab === "agora" && writable && dueNow.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2.5">
            <Checkbox
              checked={allSelected}
              disabled={pending}
              onCheckedChange={(checked) => setSelected(checked === true ? dueNow.map((sale) => sale.id) : [])}
              aria-label="Selecionar todas as vendas deste filtro"
            />
            <span className="text-muted-foreground">Selecionar todas deste filtro</span>
          </label>
          <span className="min-w-0 break-words text-muted-foreground">
            {selectedIds.length} selecionada(s) ·{" "}
            <span className="font-medium tabular-nums text-foreground">{formatBRL(selectedTotal)}</span>
          </span>
        </div>
      ) : null}

      {current.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <div key={tab} className="stagger grid gap-2">
          {current.map((sale) => {
            const checked = selectedIds.includes(sale.id);
            return (
              <article
                key={sale.id}
                className={cn(
                  "tech-card min-w-0 p-4 transition-[border-color,box-shadow]",
                  checked && "border-primary/60 shadow-glow-sm",
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  {tab === "agora" && writable ? (
                    <Checkbox
                      checked={checked}
                      disabled={pending}
                      onCheckedChange={() => toggle(sale.id)}
                      className="mt-1 shrink-0"
                      aria-label={`Selecionar venda de ${sale.customer_name}`}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 break-words font-semibold">{sale.customer_name}</p>
                      <p
                        className={cn(
                          "min-w-0 break-words text-right font-display text-base font-bold tabular-nums sm:text-lg",
                          tab === "agora" && "text-primary",
                          tab === "pagos" && "text-success",
                        )}
                      >
                        {formatBRL(sale.transfer_amount)}
                      </p>
                    </div>
                    {batchValue !== "todos" ? <p className="mt-1 break-words text-xs text-muted-foreground">Valor referente ao lote selecionado.</p> : null}
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span className="block sm:inline">{formatDate(sale.sale_date)}</span>
                      <span className="hidden sm:inline"> · </span>
                      <span className="block min-w-0 break-words sm:inline">{sale.product_name}</span>
                      <span className="hidden sm:inline"> · </span>
                      <span className="block min-w-0 break-words sm:inline">{sale.variant_name}</span>
                      <span className="hidden sm:inline"> · </span>
                      <span className="block sm:inline">{sale.customer_type_name}</span>
                    </div>
                    {consultas ? (
                      <div className="mt-3 grid grid-cols-1 gap-2 rounded-md border border-border/70 bg-surface px-3 py-2 text-xs sm:grid-cols-2">
                        <span className="min-w-0 break-words text-muted-foreground">Custo: <strong className="text-foreground">{sale.cost_history_missing ? "Custo histórico não informado" : formatBRL(sale.cost_amount)}</strong></span>
                        <span className="min-w-0 break-words text-muted-foreground">Venda: <strong className="text-foreground">{formatBRL(sale.total_amount)}</strong></span>
                        <span className="min-w-0 break-words text-muted-foreground">Meu repasse: <strong className="text-primary">{formatBRL(sale.transfer_amount)}</strong></span>
                        <span className="min-w-0 break-words text-muted-foreground">Meu lucro: <strong className="text-success">{sale.cost_history_missing ? "Custo histórico não informado" : formatBRL(sale.father_profit_amount)}</strong></span>
                      </div>
                    ) : null}
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="break-words">Venda {formatBRL(sale.total_amount)}</span>
                      {!consultas && sale.is_credit ? <Badge variant="danger">Fiado</Badge> : null}
                      {sale.transfer_paid_at ? (
                        <Badge variant="success">{consultas ? "recebido em" : "pago em"} {formatDateTime(sale.transfer_paid_at)}</Badge>
                      ) : null}
                    </div>
                    {tab === "agora" && writable ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3 h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto"
                        disabled={pending}
                        onClick={() => review([sale.id])}
                      >
                        <CheckCheck />
                        Revisar pagamento
                      </Button>
                    ) : null}
                    <Link href={`/vendas/${sale.id}?${new URLSearchParams({ voltar: returnHref })}`} className="mt-3 inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline">Ver venda</Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {tab === "agora" && writable && dueNow.length > 0 ? (
        <div className="tech-card tech-card-accent grid gap-3 p-4 md:sticky md:bottom-4">
          <TextArea
            value={notes}
            disabled={pending}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Observação do repasse, se quiser"
            className="min-h-20"
          />
          <Button
            type="button"
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal"
            disabled={pending || selectedIds.length === 0}
            onClick={() => review(selectedIds)}
          >
            <Send />
            {pending
              ? "Conferindo repasses..."
              : selectedIds.length > 0
                ? `Revisar selecionados (${selectedIds.length}) · ${formatBRL(selectedTotal)}`
                : "Selecione as vendas para pagar"}
          </Button>
        </div>
      ) : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      </>}

      {writable ? (
        <dialog
          ref={dialogRef}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onCancel={(event) => { if (operationInFlight.current) event.preventDefault(); else setReviewOpen(false); }}
          onClose={() => { if (!operationInFlight.current) setReviewOpen(false); }}
          className="fixed inset-0 m-auto max-h-[calc(100dvh-1.5rem)] w-[calc(100%-1.5rem)] max-w-xl overflow-y-auto rounded-xl border border-border bg-card p-4 text-foreground shadow-2xl backdrop:bg-black/80 sm:p-5"
        >
          <h2 id={titleId} className="break-words font-display text-lg font-semibold">Revisar confirmação do repasse</h2>
          <p id={descriptionId} className="mt-2 break-words text-sm text-muted-foreground">O pagamento é registrado para cada venda inteira. Confira o valor integral e a parcela de cada lote antes de confirmar.</p>
          {pending && !preview ? <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Conferindo os valores atuais…</p> : null}
          {preview ? (
            <div className="mt-4 grid min-w-0 gap-3">
              {affectsOtherBatches ? <Notice tone="info">Esta confirmação também afetará outros lotes. Será pago o repasse integral das vendas abaixo, incluindo as parcelas fora do lote selecionado.</Notice> : null}
              <p className="break-words text-sm">Valor total que será pago: <strong className="font-display text-lg text-primary">{formatBRL(preview.total)}</strong></p>
              {preview.sales.map((sale) => (
                <article key={sale.id} className="grid min-w-0 gap-2 rounded-lg border border-border bg-surface p-3 text-sm">
                  <p className="flex min-w-0 flex-wrap justify-between gap-2"><span className="min-w-0 break-words font-semibold">{sale.customerName}</span><strong>{formatBRL(sale.total)}</strong></p>
                  <ul className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                    {sale.portions.map((portion, index) => <li key={`${portion.batchId ?? "sem-lote"}:${index}`} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1"><span className="min-w-0 break-words">{portion.label}</span><span>{formatBRL(portion.amount)}</span></li>)}
                  </ul>
                </article>
              ))}
            </div>
          ) : null}
          {reviewError ? <div className="mt-4"><Notice>{reviewError}</Notice></div> : null}
          <div className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setReviewOpen(false)} autoFocus>Voltar</Button>
            <Button type="button" disabled={pending || !preview} className="h-auto min-h-11 whitespace-normal py-2" onClick={confirm}>
              {pending && preview ? "Registrando..." : preview ? `Confirmar pagamento integral · ${formatBRL(preview.total)}` : "Confirmar pagamento integral"}
            </Button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
