"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmBatchCorrectionAction } from "@/lib/actions/batches";
import { formatBRL, shortId } from "@/lib/format";
import type { CorrectionPreview } from "@/lib/types";
import { Notice } from "@/components/feedback/notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, TextArea } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";

export function CorrectionPreviewPanel({
  preview,
  onBack,
}: {
  preview: CorrectionPreview;
  onBack: () => void;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  function confirm() {
    if (inFlight.current || !confirmed || reason.trim().length < 8) return;
    inFlight.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await confirmBatchCorrectionAction(preview.request_id, reason.trim());
        if (!result.ok) {
          setError(result.message);
          return;
        }
        router.push("/lotes/" + preview.summary.batch_id);
        router.refresh();
      } catch {
        setError("Não foi possível confirmar a correção. Tente novamente; a mesma solicitação não será aplicada duas vezes.");
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <Panel title="Confira a correção antes de confirmar" description={preview.summary.description}>
      <div className="grid gap-4">
        {preview.summary.sale_id ? <Link href={"/vendas/" + preview.summary.sale_id} className="w-fit text-sm text-primary underline underline-offset-4">Conferir venda #{shortId(preview.summary.sale_id)}</Link> : null}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface text-xs text-muted-foreground">
              <tr><th scope="col" className="p-3">Informação</th><th scope="col" className="p-3">Antes</th><th scope="col" className="p-3">Depois</th></tr>
            </thead>
            <tbody>
              {preview.summary.changes.map((change, index) => {
                const display = (value: string | number | null) => value == null ? "—" : change.unit === "money" ? formatBRL(value) : String(value);
                return <tr key={index} className="border-b border-border/60 last:border-0"><th scope="row" className="p-3 font-medium">{change.label}</th><td className="break-words p-3">{display(change.before)}</td><td className="break-words p-3 font-semibold">{display(change.after)}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
        <Notice tone="info">
          Variação no estoque geral: {preview.summary.stock_delta > 0 ? "+" : ""}{preview.summary.stock_delta} unidade(s).
          {preview.summary.kind === "allocation" ? " A quantidade vendida, os preços, os pagamentos e os repasses permanecem iguais. Somente a parcela selecionada muda de origem e custo." : " Somente a diferença da entrada será movimentada. O lote mantém sua identificação e data original de cadastro."}
        </Notice>
        <Field label="Justificativa da correção" htmlFor={"reason-" + preview.request_id} hint="Informe pelo menos 8 caracteres. A justificativa ficará no histórico.">
          <TextArea id={"reason-" + preview.request_id} value={reason} onChange={(event) => setReason(event.target.value)} minLength={8} maxLength={2000} disabled={pending} required />
        </Field>
        <label className="flex items-start gap-3 text-sm">
          <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} disabled={pending} className="mt-0.5" />
          <span>Conferi os valores anteriores e posteriores e confirmo esta correção.</span>
        </label>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex flex-wrap gap-3">
          <Button type="button" size="lg" onClick={confirm} disabled={pending || !confirmed || reason.trim().length < 8}>{pending ? "Confirmando correção..." : "Confirmar correção"}</Button>
          <Button type="button" variant="outline" onClick={onBack} disabled={pending}>Voltar e editar</Button>
        </div>
        <p className="text-xs text-muted-foreground">Os saldos e as permissões serão conferidos novamente na confirmação. Se os dados mudaram, gere uma nova prévia.</p>
      </div>
    </Panel>
  );
}
