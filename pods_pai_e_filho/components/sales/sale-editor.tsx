"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, History, Layers3, Pencil, Send } from "lucide-react";
import { cancelSaleAction, confirmReceiptAction, updateSaleAction } from "@/lib/actions/sales";
import { formatBRL, formatDateTime } from "@/lib/format";
import { getFlavorDisplayName } from "@/lib/domain/flavors";
import type { AuditLog, CatalogSnapshot, SaleBatchAllocation, SaleItem, SaleOverview } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Select, TextArea } from "@/components/ui/field";
import { Notice } from "@/components/feedback/notice";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { CreditBadge, PaymentBadge, TransferBadge } from "@/components/sales/badges";
import { cn } from "@/lib/utils";
import { CorrectionAuditDetails } from "@/components/stock/correction-history";

const auditLabels: Record<string, string> = {
  "sale.created": "Venda registrada",
  "sale.updated": "Venda alterada",
  "sale.cancelled": "Venda cancelada",
  "sale.payment_confirmed": "Recebimento confirmado",
  "transfer.confirmed": "Repasse confirmado",
  "batch.sale_reallocated": "Origem de lote corrigida",
  "sale.batch_corrected": "Origem de lote corrigida",
  "sale.batch_reallocated": "Origem de lote corrigida",
};

export function SaleEditor({
  sale,
  items,
  batchAllocations,
  catalog,
  audit,
  canWrite,
  consultas,
}: {
  sale: SaleOverview;
  items: SaleItem[];
  batchAllocations: SaleBatchAllocation[];
  catalog: CatalogSnapshot;
  audit: AuditLog[];
  canWrite: boolean;
  consultas: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(sale.sale_date);
  const [customerId, setCustomerId] = useState(sale.customer_id ?? "");
  const [customerName, setCustomerName] = useState(sale.customer_name);
  const [typeId, setTypeId] = useState(sale.customer_type_id);
  const [statusId, setStatusId] = useState(sale.payment_status_id);
  const [variantId, setVariantId] = useState(sale.variant_id ?? "");
  const [quantity, setQuantity] = useState(sale.quantity);
  const [fiado, setFiado] = useState(sale.is_credit === true);
  const [notes, setNotes] = useState(sale.notes ?? "");

  const products = catalog.products.filter((product) => product.active);
  const selectedVariant = catalog.variants.find((variant) => variant.id === variantId);
  const productId = selectedVariant?.product_id ?? sale.product_id ?? products[0]?.id ?? "";
  const variants = catalog.variants.filter(
    (variant) => variant.product_id === productId && (variant.active || variant.id === sale.variant_id),
  );
  const statuses = catalog.statuses.filter(
    (status) => status.active && !status.is_terminal,
  );
  const status = statuses.find((item) => item.id === statusId);
  const received = Boolean(status?.counts_as_received);
  const locked = sale.transfer_paid;
  const fiadoChecked = received ? sale.is_credit === true : fiado;
  const allocationsByItem = new Map<string, SaleBatchAllocation[]>();
  for (const allocation of batchAllocations) {
    const group = allocationsByItem.get(allocation.sale_item_id) ?? [];
    group.push(allocation);
    allocationsByItem.set(allocation.sale_item_id, group);
  }

  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.message ?? "Não foi possível salvar.");
        return;
      }
      setMessage("Alteração salva.");
      setConfirmCancel(false);
      router.refresh();
    });
  }

  return (
    <div className="grid w-full min-w-0 gap-5">
      {/* Resumo da venda */}
      <section className={cn("tech-card tech-card-accent p-4", !sale.is_valid && "opacity-80")}>
        <div className="flex flex-wrap gap-1.5">
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
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          {consultas ? (
            <>
              <Money label="Valor da venda" value={sale.total_amount} large />
              <Money label="Meu repasse" value={sale.transfer_amount} tone="text-primary" />
              <Money label="Meu lucro" value={sale.father_profit_amount ?? null} fallback="Custo histórico não informado" tone="text-success" />
              <Money label="Custo dos produtos" value={sale.cost_amount ?? null} fallback="Custo histórico não informado" />
            </>
          ) : (
            <>
              <Money label="Total" value={sale.total_amount} large />
              <Money label="Parte do pai" value={sale.transfer_amount} tone="text-primary" />
              <Money label="Lucro" value={sale.profit_amount} tone="text-success" />
              <Money label="Unitário" value={sale.unit_price} />
            </>
          )}
        </dl>
        {sale.cancel_reason ? (
          <p className="mt-3 text-sm text-muted-foreground">Motivo do cancelamento: {sale.cancel_reason}</p>
        ) : null}
      </section>

      <Panel title="Origem do estoque" description="Unidades vinculadas aos lotes que atenderam cada item." icon={Layers3}>
        <ul className="grid gap-3">
          {items.map((item) => {
            const allocations = allocationsByItem.get(item.id) ?? [];
            const canceled = sale.cancelled_at !== null;
            const allocated = allocations.filter((allocation) => canceled ? allocation.reversed_at !== null : allocation.reversed_at === null);
            const allocatedQuantity = allocated.reduce((sum, allocation) => sum + allocation.quantity, 0);
            const withoutOrigin = Math.max(0, item.quantity - allocatedQuantity);
            return (
              <li key={item.id} className="grid gap-1 rounded-md border border-border/70 bg-surface p-3 text-sm">
                <p className="font-medium">{item.product_name} · {item.variant_name}</p>
                {allocated.map((allocation) => (
                  <p key={allocation.id} className="text-muted-foreground">
                    {allocation.batch_number ? `Lote ${String(allocation.batch_number).padStart(3, "0")}` : "Lote sem identificação"}
                    {canceled ? " · devolvido ao estoque" : ""} · {allocation.quantity} un · custo {formatBRL(allocation.unit_cost)} / un
                  </p>
                ))}
                {withoutOrigin > 0 ? <p className="text-muted-foreground">Sem lote conhecido · {withoutOrigin} un</p> : null}
                {allocations.length === 0 ? <p className="text-muted-foreground">Origem anterior à implantação dos lotes.</p> : null}
              </li>
            );
          })}
        </ul>
      </Panel>

      {consultas ? (
        <Panel title="Detalhes do meu repasse" description="Valores e situação de cada produto vendido" icon={Send}>
          <ul className="grid gap-3">
            {items.map((item) => (
              <li key={item.id} className="grid min-w-0 gap-3 rounded-md border border-border/70 bg-surface p-3">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 break-words font-semibold">{item.product_name} · {item.variant_name}</p>
                  <Badge variant="neutral">{item.quantity} un</Badge>
                </div>
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Money label="Custo" value={item.cost_price_unit} fallback="Custo histórico não informado" />
                  <Money label="Venda" value={item.line_total} />
                  <Money label="Meu repasse" value={item.line_transfer} tone="text-primary" />
                  <Money label="Meu lucro" value={item.line_father_profit} fallback="Custo histórico não informado" tone="text-success" />
                </dl>
                <p className="break-words text-xs text-muted-foreground">
                  Pagamento: {sale.payment_status_name} · Repasse: {sale.transfer_paid ? "Recebido" : sale.transfer_due_now ? "Pendente agora" : sale.transfer_is_future ? "Futuro" : "Sem pendência"}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {canWrite && sale.is_valid ? (
        <Panel title="Editar venda" icon={Pencil}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              run(() =>
                updateSaleAction({
                  saleId: sale.id,
                  saleDate: date,
                  customerId,
                  customerName,
                  customerTypeId: typeId,
                  paymentStatusId: statusId,
                  isCredit: received ? sale.is_credit === true : fiado,
                  notes,
                  variantId,
                  quantity,
                }),
              );
            }}
          >
            {locked ? (
              <Notice tone="info">
                O repasse já foi pago. Produto, quantidade, tipo e fiado ficam preservados.
              </Notice>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Data">
                <Input className="h-12" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </Field>
              <Field label="Cliente cadastrado">
                <Select
                  value={customerId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCustomerId(next);
                    const customer = catalog.customers.find((item) => item.id === next);
                    if (customer) setCustomerName(customer.name);
                  }}
                >
                  <option value="">Sem cadastro</option>
                  {catalog.customers.filter((customer) => customer.active).map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Nome" className="md:col-span-2">
                <Input className="h-12" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required />
              </Field>
              <Field label="Produto">
                <Select
                  disabled={locked}
                  value={productId}
                  onChange={(event) => {
                    const next = catalog.variants.find(
                      (variant) => variant.product_id === event.target.value && variant.active,
                    );
                    setVariantId(next?.id ?? "");
                  }}
                >
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sabor">
                <Select disabled={locked} value={variantId} onChange={(event) => setVariantId(event.target.value)}>
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {getFlavorDisplayName(variant)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tipo">
                <Select disabled={locked} value={typeId} onChange={(event) => setTypeId(event.target.value)}>
                  {catalog.customerTypes.filter((type) => type.active).map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantidade">
                <Input
                  className="h-12"
                  disabled={locked}
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(event) => setQuantity(Number(event.target.value))}
                />
              </Field>
              <Field label="Pagamento">
                <Select value={statusId} onChange={(event) => setStatusId(event.target.value)}>
                  {statuses.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Venda fiada" hint="Só altera o repasse enquanto a venda está a receber.">
                <label
                  className={cn(
                    "flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-lg border bg-surface px-3 transition-[border-color,box-shadow,background-color]",
                    fiadoChecked
                      ? "border-primary/60 bg-primary/10 shadow-glow-sm"
                      : "border-input hover:border-primary/40",
                    (locked || received) && "cursor-not-allowed opacity-60",
                  )}
                >
                  <Checkbox
                    checked={fiadoChecked}
                    disabled={locked || received}
                    onCheckedChange={(checked) => setFiado(checked === true)}
                  />
                  <span className="text-sm font-medium">
                    {received && sale.is_credit ? "Histórico de fiado mantido" : "Fiado"}
                  </span>
                  {fiadoChecked ? <Badge variant="danger" className="ml-auto">Fiado</Badge> : null}
                </label>
              </Field>
              {!received && fiado ? (
                <div className="animate-enter flex items-start gap-3 rounded-lg border border-primary/40 bg-primary/10 px-3 py-3 text-sm md:col-span-2">
                  <Send className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="leading-relaxed">
                    O repasse do pai desta venda entra em <strong>“A enviar ao pai agora”</strong>, mesmo antes do
                    recebimento do cliente.
                  </p>
                </div>
              ) : null}
              <Field label="Observações" className="md:col-span-2">
                <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} />
              </Field>
            </div>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Salvando..." : "Salvar alterações"}
            </Button>
          </form>
        </Panel>
      ) : null}

      {canWrite && sale.is_valid && !sale.counts_as_received ? (
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="border-success/40 text-success hover:border-success hover:bg-success/10"
          disabled={pending}
          onClick={() => run(() => confirmReceiptAction(sale.id))}
        >
          <CheckCircle2 />
          Confirmar recebimento
        </Button>
      ) : null}

      {canWrite && sale.is_valid ? (
        <section className="tech-card border-primary/30 p-4">
          {!confirmCancel ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="h-4 w-4 text-primary" />
                Cancelar devolve o estoque e tira os valores dos indicadores.
              </p>
              <Button type="button" variant="outline" onClick={() => setConfirmCancel(true)}>
                Cancelar venda
              </Button>
            </div>
          ) : (
            <div className="animate-enter grid gap-3">
              <p className="text-sm">
                O estoque volta e os valores saem dos indicadores. A venda permanece no histórico.
              </p>
              <TextArea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motivo" />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  disabled={pending}
                  onClick={() => run(() => cancelSaleAction(sale.id, reason))}
                >
                  Confirmar cancelamento
                </Button>
                <Button type="button" variant="ghost" size="lg" onClick={() => setConfirmCancel(false)}>
                  Voltar
                </Button>
              </div>
            </div>
          )}
        </section>
      ) : null}

      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      <Panel title="Histórico" icon={History} bodyClassName="p-0">
        {audit.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nenhum evento registrado.</p>
        ) : (
          <ol className="relative ml-6 border-l border-border/80 py-2">
            {audit.map((entry) => (
              <li key={entry.id} className="relative px-4 py-2.5 text-sm">
                <span
                  aria-hidden
                  className="absolute -left-[5px] top-[1.05rem] h-2.5 w-2.5 rounded-full border-2 border-background bg-primary shadow-glow-sm"
                />
                <p className="font-medium">{auditLabels[entry.action] ?? entry.action}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(entry.created_at)}
                  {entry.user_name ? ` · ${entry.user_name}` : ""}
                </p>
                {!consultas && entry.action.includes("batch") ? <CorrectionAuditDetails metadata={entry.metadata} /> : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function Money({
  label,
  value,
  fallback,
  tone,
  large,
}: {
  label: string;
  value: string | null | undefined;
  fallback?: string;
  tone?: string;
  large?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/70 bg-surface px-3 py-2.5">
      <dt className="eyebrow text-[10px]">{label}</dt>
      <dd
        className={cn(
          "mt-1 break-words font-display font-bold tabular-nums",
          large ? "text-xl glow-text sm:text-2xl" : "text-base sm:text-lg",
          tone,
        )}
      >
        {value == null ? (fallback ?? "—") : formatBRL(value)}
      </dd>
    </div>
  );
}
