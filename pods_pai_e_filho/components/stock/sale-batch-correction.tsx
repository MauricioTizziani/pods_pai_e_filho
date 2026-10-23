"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { previewSaleBatchCorrectionAction, searchCorrectionSalesAction } from "@/lib/actions/batches";
import { formatBRL, formatDate, formatDateTime, shortId } from "@/lib/format";
import type { BatchItemOverview, BatchOverview, CorrectionPreview, CorrectionSaleCandidate } from "@/lib/types";
import { Notice } from "@/components/feedback/notice";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { CorrectionPreviewPanel } from "@/components/stock/correction-preview";

function batchLabel(number: number) { return "Lote " + String(number).padStart(3, "0"); }

export function SaleBatchCorrection({ batch, items, initialQuery = "", initialSales = [] }: { batch: BatchOverview; items: BatchItemOverview[]; initialQuery?: string; initialSales?: CorrectionSaleCandidate[] }) {
  const [query, setQuery] = useState(initialQuery);
  const [sales, setSales] = useState<CorrectionSaleCandidate[]>(initialQuery ? initialSales.filter((sale) => sale.saleId === initialQuery) : initialSales);
  const [searched, setSearched] = useState(initialSales.length > 0);
  const [saleId, setSaleId] = useState(initialQuery && initialSales.some((sale) => sale.saleId === initialQuery) ? initialQuery : "");
  const [saleItemId, setSaleItemId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const sale = sales.find((entry) => entry.saleId === saleId);
  const saleItem = sale?.items.find((item) => item.id === saleItemId);
  const allocations = saleItem?.allocations.filter((allocation) => allocation.batchId !== batch.batch_id) ?? [];
  const source = allocations.find((allocation) => allocation.id === sourceId);
  const maxSource = sourceId === "legacy" ? saleItem?.unallocatedQuantity ?? 0 : source?.quantity ?? 0;
  const destinations = items.filter((item) => item.product_id === saleItem?.productId && item.variant_id === saleItem?.variantId);
  const destination = destinations.find((item) => item.batch_item_id === destinationId);

  function resetPreview() { setPreview(null); setError(null); }

  function selectSale(candidate: CorrectionSaleCandidate) {
    setSaleId(candidate.saleId);
    setSaleItemId(""); setSourceId(""); setDestinationId(""); setQuantity(1);
    resetPreview();
  }

  function search(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    resetPreview();
    startTransition(async () => {
      try {
        const result = await searchCorrectionSalesAction(batch.batch_id, query.trim());
        if (!result.ok) { setError(result.message); return; }
        setSales(result.sales); setSearched(true);
        if (result.sales.length === 1) selectSale(result.sales[0]);
        else { setSaleId(""); setSaleItemId(""); setSourceId(""); setDestinationId(""); }
      } catch {
        setError("Não foi possível buscar as vendas. Tente novamente.");
      } finally { inFlight.current = false; }
    });
  }

  function review(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    resetPreview();
    if (!saleItem || !sourceId || !destination || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxSource) {
      setError("Selecione o item, a origem, o destino e uma quantidade válida da parcela que será corrigida."); return;
    }
    if (quantity > destination.quantity_remaining) { setError("O lote de destino não tem saldo suficiente deste produto e sabor."); return; }
    inFlight.current = true;
    startTransition(async () => {
      try {
        const result = await previewSaleBatchCorrectionAction({ batchId: batch.batch_id, saleItemId: saleItem.id, sourceAllocationId: sourceId === "legacy" ? null : sourceId, quantity, destinationItemId: destination.batch_item_id });
        if (!result.ok) { setError(result.message); return; }
        setPreview(result.preview);
      } catch {
        setError("Não foi possível preparar a correção. Tente novamente.");
      } finally { inFlight.current = false; }
    });
  }

  if (preview) return <div id="vincular-venda" className="scroll-mt-6"><CorrectionPreviewPanel key={preview.request_id} preview={preview} onBack={() => setPreview(null)} /></div>;

  return (
    <div id="vincular-venda" className="scroll-mt-6">
      <Panel title="Vincular venda existente / corrigir lote da venda" description={"Destino: " + batchLabel(batch.batch_number) + ". A correção afeta somente o item e a quantidade selecionados."}>
        <div className="grid gap-5">
          <Notice tone="info">Uma venda pode ter sido cadastrada depois da abertura deste lote. Use a data em que a venda ocorreu para conferir sua origem. A quantidade total vendida e o faturamento permanecem iguais.</Notice>
          <form onSubmit={search} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Localizar venda" htmlFor="correction-sale-query" hint="Busque pelo cliente, identificador da venda, produto ou sabor."><Input id="correction-sale-query" value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setSales([]); setSearched(false); setSaleId(""); resetPreview(); }} disabled={pending} placeholder="Nome, produto ou código da venda" /></Field>
            <Button type="submit" variant="outline" disabled={pending}><Search />{pending ? "Aguarde..." : "Buscar vendas"}</Button>
          </form>
          {searched && sales.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma venda elegível encontrada. Confira a busca e o produto/sabor disponível neste lote.</p> : null}
          {sales.length ? <fieldset disabled={pending} className="grid min-w-0 gap-3">
            <legend className="mb-2 text-sm font-semibold">Selecione a venda já cadastrada</legend>
            {sales.map((candidate) => <label key={candidate.saleId} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3 text-sm">
              <input type="radio" name="correction-sale" checked={candidate.saleId === saleId} onChange={() => selectSale(candidate)} className="mt-1 accent-primary" />
              <span className="grid min-w-0 gap-1"><strong className="break-words">{candidate.customerName} · #{shortId(candidate.saleId)}</strong><span className="text-xs text-muted-foreground">Venda ocorrida em {formatDate(candidate.saleDate)} · Cadastrada em {formatDateTime(candidate.createdAt)}</span><span className="break-words text-xs">{candidate.items.map((item) => item.productName + " · " + item.variantName + " (" + item.quantity + ")").join("; ")}</span></span>
            </label>)}
            <p className="text-xs text-muted-foreground">A busca apresenta até 30 vendas. Refine os termos se a venda desejada não aparecer.</p>
          </fieldset> : null}
          {sale ? <form onSubmit={review} className="grid gap-4">
            <fieldset disabled={pending} className="grid min-w-0 gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><strong>{sale.customerName} · #{shortId(sale.saleId)}</strong><Link href={"/vendas/" + sale.saleId} className="text-primary underline underline-offset-4">Conferir venda completa</Link></div>
              <Field label="Item da venda" htmlFor="correction-sale-item"><Select id="correction-sale-item" value={saleItemId} onChange={(event) => {
                const selected = sale.items.find((item) => item.id === event.target.value);
                setSaleItemId(event.target.value); setSourceId(""); setQuantity(1);
                setDestinationId(items.find((item) => item.product_id === selected?.productId && item.variant_id === selected?.variantId)?.batch_item_id ?? "");
                resetPreview();
              }} required><option value="">Selecione o item</option>{sale.items.map((item) => <option key={item.id} value={item.id}>{item.productName} · {item.variantName} · {item.quantity} vendido(s)</option>)}</Select></Field>
              {saleItem ? <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Origem que será corrigida" htmlFor="correction-source"><Select id="correction-source" value={sourceId} onChange={(event) => { setSourceId(event.target.value); setQuantity(1); resetPreview(); }} required><option value="">Selecione a parcela de origem</option>{allocations.map((allocation) => <option key={allocation.id} value={allocation.id}>{batchLabel(allocation.batchNumber)} · {allocation.quantity} unidade(s) · custo {formatBRL(allocation.unitCost)}</option>)}{saleItem.unallocatedQuantity > 0 ? <option value="legacy">Sem lote · {saleItem.unallocatedQuantity} unidade(s)</option> : null}</Select></Field>
                  <Field label="Item de destino (mesmo produto e sabor)" htmlFor="correction-destination"><Select id="correction-destination" value={destinationId} onChange={(event) => { setDestinationId(event.target.value); resetPreview(); }} required><option value="">Selecione o destino</option>{destinations.map((item) => <option key={item.batch_item_id} value={item.batch_item_id}>{item.product_name} · {item.variant_name} · saldo {item.quantity_remaining} · custo {formatBRL(item.unit_cost)}</option>)}</Select></Field>
                </div>
                {!destinations.length ? <Notice>Este lote não possui o mesmo produto e sabor da venda. Não é possível usar o saldo de outra variação.</Notice> : null}
                {!allocations.length && saleItem.unallocatedQuantity === 0 ? <Notice tone="info">Todas as unidades deste item já estão vinculadas ao lote de destino.</Notice> : null}
                {sourceId === "legacy" ? <Notice tone="info">A saída antiga será conferida antes da associação. Uma venda sem lote que já baixou estoque não gerará uma segunda baixa.</Notice> : null}
                <Field label="Quantidade desta parcela a corrigir" htmlFor="correction-quantity" hint={sourceId ? "Disponível na parcela de origem: " + maxSource + ". Saldo atual no destino: " + (destination?.quantity_remaining ?? 0) + "." : "As demais parcelas e itens da venda serão preservados."}><Input id="correction-quantity" type="number" value={quantity} min={1} max={maxSource || undefined} step={1} onChange={(event) => { setQuantity(Number(event.target.value)); resetPreview(); }} required /></Field>
                <Button type="submit" size="lg" disabled={pending || !sourceId || !destinationId || quantity < 1 || quantity > maxSource}>{pending ? "Preparando prévia..." : "Revisar correção da origem"}</Button>
              </> : null}
            </fieldset>
          </form> : null}
          {error ? <Notice>{error}</Notice> : null}
        </div>
      </Panel>
    </div>
  );
}
