import { formatBRL, formatDateTime } from "@/lib/format";
import type { AuditLog } from "@/lib/types";

type HistoryChange = { label: string; before: string | number | null; after: string | number | null; unit?: string };

export function CorrectionAuditDetails({ metadata }: { metadata: AuditLog["metadata"] }) {
  const summary = metadata?.summary;
  const changes = summary && typeof summary === "object" && "changes" in summary && Array.isArray(summary.changes)
    ? summary.changes.filter((change): change is HistoryChange => !!change && typeof change === "object" && typeof change.label === "string" && (change.before == null || typeof change.before === "string" || typeof change.before === "number") && (change.after == null || typeof change.after === "string" || typeof change.after === "number"))
    : [];
  const reason = typeof metadata?.reason === "string" ? metadata.reason : typeof metadata?.justification === "string" ? metadata.justification : "";
  return <>
    {reason ? <p className="mt-1 break-words text-sm">Justificativa: {reason}</p> : null}
    {changes.length ? <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">{changes.map((change, index) => {
      const display = (value: HistoryChange["before"]) => value == null ? "—" : change.unit === "money" ? formatBRL(value) : String(value);
      return <li key={index} className="break-words">{change.label}: {display(change.before)} → {display(change.after)}</li>;
    })}</ul> : null}
  </>;
}

const labels: Record<string, string> = {
  "batch.entry_corrected": "Entrada do lote corrigida",
  "batch.sale_reallocated": "Origem de venda corrigida",
  "batch.allocation_corrected": "Origem de venda corrigida",
  "batch.updated": "Dados do lote alterados",
  "batch.created": "Lote registrado",
  "batch.cancelled": "Lote cancelado",
  "purchase.created": "Compra registrada",
  "purchase.cancelled": "Compra cancelada",
  "batch.legacy_created": "Estoque legado associado",
};

export function CorrectionHistory({ history }: { history: AuditLog[] }) {
  if (!history.length) return <p className="text-sm text-muted-foreground">Nenhuma correção registrada para este lote.</p>;
  return <ol className="grid gap-3">{history.map((entry) => <li key={entry.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
    <p className="font-semibold">{labels[entry.action] ?? entry.action}</p>
    <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(entry.created_at)} · {entry.user_name ?? "Usuário registrado"}</p>
    <CorrectionAuditDetails metadata={entry.metadata} />
  </li>)}</ol>;
}
