"use server";

import { getSessionState } from "@/lib/auth";
import { searchBatchCorrectionSales } from "@/lib/data/batches";
import { dbErrorMessage } from "@/lib/errors";
import { revalidateCommerce } from "@/lib/revalidate";
import { createClient } from "@/lib/supabase/server";
import type {
  ActionResult, BatchEditInput, CorrectionPreview, CorrectionPreviewResult, SaleBatchCorrectionInput,
} from "@/lib/types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function adminClient() {
  const session = await getSessionState();
  if (session.status !== "ok" || session.profile.role_code.toLowerCase() !== "admin") {
    return null;
  }
  return createClient();
}

export async function previewBatchEditAction(input: BatchEditInput): Promise<CorrectionPreviewResult> {
  const supabase = await adminClient();
  if (!supabase) return { ok: false, message: "Somente o Administrador pode editar lotes." };
  if (!input || !uuid.test(input.batchId) || !/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate) ||
    typeof input.notes !== "string" || !Array.isArray(input.items) || !input.items.length ||
    input.items.length > 200 || input.items.some((item) => !item || !uuid.test(item.variantId) ||
      (item.batchItemId !== undefined && !uuid.test(item.batchItemId)) ||
      !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 2147483647 ||
      !Number.isFinite(item.unitCost) || item.unitCost < 0 || item.unitCost > 999999999999.99)) {
    return { ok: false, message: "Confira a data, os itens, as quantidades e os custos informados." };
  }
  const { data, error } = await supabase.rpc("preview_batch_edit", {
    p_batch_id: input.batchId,
    payload: {
      purchase_date: input.purchaseDate,
      notes: input.notes.trim() || null,
      same_purchase_confirmed: input.samePurchaseConfirmed === true,
      items: input.items.map((item) => ({
        batch_item_id: item.batchItemId ?? null,
        variant_id: item.variantId,
        quantity: item.quantity,
        unit_cost: item.unitCost,
      })),
    },
  });
  if (error) return { ok: false, message: dbErrorMessage(error) };
  return { ok: true, preview: data as CorrectionPreview };
}

export async function previewSaleBatchCorrectionAction(input: SaleBatchCorrectionInput): Promise<CorrectionPreviewResult> {
  const supabase = await adminClient();
  if (!supabase) return { ok: false, message: "Somente o Administrador pode corrigir a origem da venda." };
  if (!input || !uuid.test(input.batchId) || !uuid.test(input.saleItemId) ||
    !uuid.test(input.destinationItemId) ||
    (input.sourceAllocationId !== null && !uuid.test(input.sourceAllocationId)) ||
    !Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > 2147483647) {
    return { ok: false, message: "Selecione o item, a origem, o destino e uma quantidade válida." };
  }
  const { data, error } = await supabase.rpc("preview_sale_batch_correction", {
    p_batch_id: input.batchId,
    p_sale_item_id: input.saleItemId,
    p_source_allocation_id: input.sourceAllocationId,
    p_quantity: input.quantity,
    p_destination_item_id: input.destinationItemId,
  });
  if (error) return { ok: false, message: dbErrorMessage(error) };
  return { ok: true, preview: data as CorrectionPreview };
}

export async function confirmBatchCorrectionAction(requestId: string, reason: string): Promise<ActionResult> {
  const supabase = await adminClient();
  if (!supabase) return { ok: false, message: "Somente o Administrador pode confirmar correções de lotes." };
  if (!uuid.test(requestId) || typeof reason !== "string" || reason.trim().length < 8) {
    return { ok: false, message: "Informe uma justificativa com pelo menos 8 caracteres." };
  }
  const { data, error } = await supabase.rpc("confirm_batch_correction", {
    p_request_id: requestId, p_reason: reason.trim(),
  });
  if (error) return { ok: false, message: dbErrorMessage(error) };
  revalidateCommerce();
  return { ok: true, id: data as string };
}

export async function searchCorrectionSalesAction(batchId: string, query: string) {
  const supabase = await adminClient();
  if (!supabase) return { ok: false as const, message: "Somente o Administrador pode localizar vendas para correção." };
  if (!uuid.test(batchId) || typeof query !== "string" || query.length > 200) {
    return { ok: false as const, message: "Informe uma busca válida." };
  }
  return searchBatchCorrectionSales(batchId, query);
}
