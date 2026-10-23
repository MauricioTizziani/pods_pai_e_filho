"use client";

import { useRef, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { previewBatchEditAction } from "@/lib/actions/batches";
import { getFlavorDisplayName } from "@/lib/domain/flavors";
import { formatBRL, formatDateTime } from "@/lib/format";
import type { BatchItemOverview, BatchOverview, CatalogSnapshot, CorrectionPreview } from "@/lib/types";
import { Notice } from "@/components/feedback/notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Select, TextArea } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { CorrectionPreviewPanel } from "@/components/stock/correction-preview";

type EditLine = { key: string; batchItemId?: string; productId: string; variantId: string; quantity: number; unitCost: string };

export function BatchEditor({ batch, items, catalog }: { batch: BatchOverview; items: BatchItemOverview[]; catalog: CatalogSnapshot }) {
  const [purchaseDate, setPurchaseDate] = useState(batch.purchase_date.slice(0, 10));
  const [notes, setNotes] = useState(batch.notes ?? "");
  const [lines, setLines] = useState<EditLine[]>(items.map((item) => ({ key: item.batch_item_id, batchItemId: item.batch_item_id, productId: item.product_id, variantId: item.variant_id, quantity: item.quantity_purchased, unitCost: String(item.unit_cost) })));
  const [samePurchase, setSamePurchase] = useState(false);
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const quantityChanged = lines.some((line) => !line.batchItemId || items.find((item) => item.batch_item_id === line.batchItemId)?.quantity_purchased !== line.quantity);
  const products = catalog.products.filter((product) => product.active);

  function changed() {
    setPreview(null);
    setError(null);
  }

  function update(index: number, change: Partial<EditLine>) {
    setLines((current) => current.map((line, i) => i === index ? { ...line, ...change } : line));
    if (change.quantity != null || change.variantId != null) setSamePurchase(false);
    changed();
  }

  function review(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    if (quantityChanged && !samePurchase) { setError(batch.is_legacy ? "Confirme que a classificação corresponde ao estoque antigo real." : "Confirme que os itens e quantidades corrigidos pertencem à mesma compra original."); return; }
    if (!lines.length || lines.some((line) => !line.variantId || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.unitCost.trim() === "" || !Number.isFinite(Number(line.unitCost)) || Number(line.unitCost) < 0)) {
      setError("Confira o produto, o sabor, a quantidade inteira e o custo de cada item."); return;
    }
    inFlight.current = true;
    startTransition(async () => {
      try {
        const result = await previewBatchEditAction({ batchId: batch.batch_id, purchaseDate, notes, samePurchaseConfirmed: samePurchase, items: lines.map((line) => ({ batchItemId: line.batchItemId, variantId: line.variantId, quantity: line.quantity, unitCost: Math.round(Number(line.unitCost) * 100) / 100 })) });
        if (!result.ok) { setError(result.message); return; }
        setPreview(result.preview);
      } catch {
        setError("Não foi possível preparar a prévia. Tente novamente.");
      } finally {
        inFlight.current = false;
      }
    });
  }

  if (preview) return <CorrectionPreviewPanel key={preview.request_id} preview={preview} onBack={() => setPreview(null)} />;

  return (
    <form onSubmit={review} className="grid gap-5">
      <fieldset disabled={pending} className="grid min-w-0 gap-5">
        <Panel title="Dados do lote" description={"Cadastrado em " + formatDateTime(batch.created_at) + ". A data do cadastro é preservada."}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Data da compra / entrada" htmlFor="batch-purchase-date" hint="A data precisa ser compatível com as movimentações e as vendas existentes."><Input id="batch-purchase-date" type="date" value={purchaseDate} onChange={(event) => { setPurchaseDate(event.target.value); changed(); }} required /></Field>
            <Field label="Descrição / observações" htmlFor="batch-notes"><TextArea id="batch-notes" value={notes} onChange={(event) => { setNotes(event.target.value); changed(); }} maxLength={2000} /></Field>
          </div>
        </Panel>
        <Panel title={batch.is_legacy ? "Itens do estoque legado associado" : "Itens da compra original"} description="Vendidos e saldo atual são valores de conferência. O produto e o sabor dos itens existentes são preservados.">
          <div className="grid gap-4">
            {lines.map((line, index) => {
              const original = items.find((item) => item.batch_item_id === line.batchItemId);
              const variants = catalog.variants.filter((variant) => variant.active && variant.product_id === line.productId);
              const costLocked = !!original && original.quantity_sold > 0;
              return <div key={line.key} className="grid gap-3 rounded-lg border border-border bg-surface p-3">
                {original ? <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <div><p className="font-semibold">{original.product_name}</p><p className="text-sm text-muted-foreground">{original.variant_name}</p></div>
                  <dl className="flex flex-wrap gap-4 text-sm"><div><dt className="text-xs text-muted-foreground">Entrada atual</dt><dd className="font-semibold">{original.quantity_purchased}</dd></div><div><dt className="text-xs text-muted-foreground">Vendidos</dt><dd className="font-semibold">{original.quantity_sold}</dd></div><div><dt className="text-xs text-muted-foreground">Saldo atual</dt><dd className="font-semibold">{original.quantity_remaining}</dd></div></dl>
                </div> : <div className="grid gap-3 md:grid-cols-2">
                  <Field label="Produto" htmlFor={"product-" + line.key}><Select id={"product-" + line.key} value={line.productId} onChange={(event) => {
                    const productId = event.target.value;
                    update(index, { productId, variantId: catalog.variants.find((variant) => variant.active && variant.product_id === productId)?.id ?? "", unitCost: String(products.find((product) => product.id === productId)?.cost_price ?? "") });
                  }} required><option value="">Selecione</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></Field>
                  <Field label="Sabor / variação" htmlFor={"variant-" + line.key}><Select id={"variant-" + line.key} value={line.variantId} onChange={(event) => update(index, { variantId: event.target.value })} required><option value="">Selecione</option>{variants.map((variant) => <option key={variant.id} value={variant.id}>{getFlavorDisplayName(variant)}</option>)}</Select></Field>
                </div>}
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
                  <Field label="Quantidade correta da entrada" htmlFor={"quantity-" + line.key}><Input id={"quantity-" + line.key} type="number" min={1} step={1} value={line.quantity} onChange={(event) => update(index, { quantity: Number(event.target.value) })} required /></Field>
                  <Field label="Custo unitário (R$)" htmlFor={"cost-" + line.key} hint={costLocked ? "Custo preservado: este item já possui vendas. Custos históricos exigem correção auditada específica." : undefined}><Input id={"cost-" + line.key} type="number" min={0} step="0.01" value={line.unitCost} onChange={(event) => update(index, { unitCost: event.target.value })} disabled={costLocked} required /></Field>
                  {!original ? <Button type="button" variant="ghost" size="icon" className="sm:mt-6" aria-label="Remover item adicionado" onClick={() => { setLines((current) => current.filter((_, i) => index !== i)); setSamePurchase(false); changed(); }}><Trash2 /></Button> : null}
                </div>
                {original && line.quantity !== original.quantity_purchased ? <p className="text-sm text-muted-foreground">Diferença na entrada: <strong>{line.quantity > original.quantity_purchased ? "+" : ""}{line.quantity - original.quantity_purchased}</strong> unidade(s). Saldo estimado: <strong>{original.quantity_remaining + line.quantity - original.quantity_purchased}</strong>; sujeito à conferência de todas as movimentações.</p> : null}
              </div>;
            })}
            <Button type="button" variant="outline" disabled={!products.length} onClick={() => {
              const product = products[0];
              setLines((current) => [...current, { key: crypto.randomUUID(), productId: product?.id ?? "", variantId: catalog.variants.find((variant) => variant.active && variant.product_id === product?.id)?.id ?? "", quantity: 1, unitCost: String(product?.cost_price ?? "") }]);
              setSamePurchase(false); changed();
            }}><Plus /> {batch.is_legacy ? "Associar outro item do estoque legado" : "Adicionar item omitido da mesma compra"}</Button>
            <p className="text-sm text-muted-foreground">Custo total da entrada após a correção: <strong className="text-foreground">{formatBRL(lines.reduce((sum, line) => sum + line.quantity * (Number(line.unitCost) || 0), 0))}</strong></p>
            <p className="text-xs text-muted-foreground">Itens com histórico operacional, inclusive vendas estornadas, podem ter a alteração de custo bloqueada na conferência. O custo de unidades já vendidas não é recalculado por esta edição.</p>
            {batch.is_legacy ? <Notice tone="info">Este lote representa estoque legado. Corrigir as quantidades reclassifica somente o saldo real ainda sem lote, sem aumentar o estoque geral.</Notice> : null}
          </div>
        </Panel>
        <Panel title="Revisar alterações">
          <div className="grid gap-4">
            {quantityChanged ? <>
              <Notice tone="info">{batch.is_legacy ? "Esta correção classifica apenas estoque antigo real e disponível sem lote. O estoque geral permanece igual. Uma nova compra deve gerar outro lote." : "Use esta correção somente para representar a compra original. Uma compra independente deve gerar outro lote. Não aumente a entrada apenas para conseguir vincular uma venda."}</Notice>
              <label className="flex items-start gap-3 text-sm"><Checkbox checked={samePurchase} onCheckedChange={(value) => setSamePurchase(value === true)} className="mt-0.5" /><span>{batch.is_legacy ? "Confirmo que a classificação corresponde ao estoque antigo real, sem incluir novas compras." : "Confirmo que os produtos e as quantidades corrigidos pertencem à mesma compra original."}</span></label>
            </> : null}
            {error ? <Notice>{error}</Notice> : null}
            <Button type="submit" size="lg" disabled={pending || (quantityChanged && !samePurchase)}>{pending ? "Preparando prévia..." : "Revisar alterações do lote"}</Button>
            <p className="text-xs text-muted-foreground">A próxima etapa apresenta os impactos e exige justificativa e confirmação. O vínculo de vendas é corrigido na seção própria abaixo.</p>
          </div>
        </Panel>
      </fieldset>
    </form>
  );
}
