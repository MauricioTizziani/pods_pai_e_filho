"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { controlClass } from "@/components/ui/field";
import { buildFilterUrl } from "@/lib/domain/batch-filters";
import { cn } from "@/lib/utils";

export type TransferTab = "agora" | "futuro" | "pagos";

type TransferFiltersProps = {
  batches: { value: string; label: string }[];
  batchValue: string;
  batchLabel?: string;
  params: Record<string, string | undefined>;
  initialTab?: TransferTab;
  pending?: boolean;
  disabled?: boolean;
  onBatchChange?: (value: string) => void;
};

export function TransferFilters({ batches, batchValue, batchLabel, params, initialTab = "agora", pending = false, disabled = false, onBatchChange }: TransferFiltersProps) {
  const router = useRouter();
  const [requestedBatch, setRequestedBatch] = useState(batchValue);
  const [navigating, startNavigation] = useTransition();
  const value = navigating ? requestedBatch : batchValue;
  const label = value === "todos" ? "Todos os lotes" : batches.find((batch) => batch.value === value)?.label ?? batchLabel;

  function changeBatch(nextValue: string) {
    if (onBatchChange) return onBatchChange(nextValue);
    setRequestedBatch(nextValue);
    startNavigation(() => {
      router.push(buildFilterUrl("/repasses", params, { lote: nextValue, aba: initialTab, page: undefined, pagina: undefined }), { scroll: false });
    });
  }

  return (
    <div className="grid w-full min-w-0 gap-2" aria-busy={pending || navigating}>
      <label className="grid min-w-0 gap-1 text-sm font-medium sm:max-w-md">
        Lote
        <select name="lote" value={value} onChange={(event) => changeBatch(event.target.value)} disabled={disabled} className={cn(controlClass, "h-10 w-full min-w-0")}>
          <option value="todos">Todos os lotes</option>
          {batches.map((batch) => <option key={batch.value} value={batch.value}>{batch.label}</option>)}
        </select>
      </label>
      <p className="min-w-0 break-words text-xs text-muted-foreground">{label}{pending || navigating ? " · Carregando repasses…" : " · Valores e registros deste filtro"}</p>
    </div>
  );
}
