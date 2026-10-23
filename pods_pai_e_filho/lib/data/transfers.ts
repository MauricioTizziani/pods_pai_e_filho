import { createClient } from "@/lib/supabase/server";
import { dbErrorMessage } from "@/lib/errors";
import {
  isTransferPaymentPreview,
  type TransferPaymentPreviewResult,
} from "@/lib/domain/transfers";

/** The read-only RPC applies the same authorization and eligibility as confirmation. */
export async function loadTransferPaymentPreview(
  saleIds: string[],
  batchValue: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<TransferPaymentPreviewResult> {
  const { data, error } = await supabase.rpc("preview_transfers", {
    p_sale_ids: saleIds,
    p_batch_id: batchValue === "todos" ? null : batchValue,
  });
  if (error) return { ok: false, message: dbErrorMessage(error) };
  if (!isTransferPaymentPreview(data)) {
    return { ok: false, message: "Não foi possível conferir os valores do repasse. Atualize os dados e tente novamente." };
  }
  return { ok: true, preview: data };
}
