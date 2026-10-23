import { createClient } from "@/lib/supabase/server";
import { getSessionState } from "@/lib/auth";
import { loadCatalog } from "@/lib/data/catalog";
import { loadFinancialSales } from "@/lib/data/financial-sales";
import { getFlavorDisplayName } from "@/lib/domain/flavors";
import { dbErrorMessage } from "@/lib/errors";
import type { AuditLog, BatchItemOverview, BatchOverview, CorrectionSaleCandidate } from "@/lib/types";

export async function listBatches() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("batch_overview")
    .select("*")
    .order("batch_number", { ascending: false });
  if (error) return { ok: false as const, message: error.message, batches: [] as BatchOverview[] };
  return { ok: true as const, message: "", batches: (data ?? []) as BatchOverview[] };
}

export async function getBatchDetails(id: string) {
  const supabase = await createClient();
  const [batch, items] = await Promise.all([
    supabase.from("batch_overview").select("*").eq("batch_id", id).maybeSingle(),
    supabase.from("batch_item_overview").select("*").eq("batch_id", id).order("product_name").order("variant_name"),
  ]);
  if (batch.error) return { ok: false as const, message: batch.error.message };
  if (items.error) return { ok: false as const, message: items.error.message };
  if (!batch.data) return { ok: false as const, message: "Lote não encontrado." };
  return {
    ok: true as const,
    batch: batch.data as BatchOverview,
    items: (items.data ?? []) as BatchItemOverview[],
  };
}

export async function listBatchLinkedSales(batchId: string, consultas = false) {
  const session = await getSessionState();
  if (session.status !== "ok") return { ok: false as const, message: "Não foi possível carregar seu perfil." };
  // Enforce the restricted projection here as well as in the calling page.
  const result = await loadFinancialSales({ batchId, consultas: consultas || !session.profile.can_write });
  if (!result.ok) return { ok: false as const, message: result.message };
  return { ok: true as const, sales: result.sales };
}

export async function listBatchHistory(batchId: string) {
  const session = await getSessionState();
  if (session.status !== "ok" || session.profile.role_code.toLowerCase() !== "admin") {
    return { ok: false as const, message: "O histórico de correções está disponível apenas para o Administrador." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.from("audit_logs")
    .select("id, action, entity_type, entity_id, metadata, created_at, profiles(full_name)")
    .eq("entity_type", "purchase_batches").eq("entity_id", batchId)
    .order("created_at", { ascending: false }).limit(100);
  if (error) return { ok: false as const, message: dbErrorMessage(error) };
  const history: AuditLog[] = (data ?? []).map((row) => {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    return { ...row, metadata: row.metadata as Record<string, unknown> | null, user_name: profile?.full_name ?? null };
  });
  return { ok: true as const, history };
}

type QueryRows = {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
};

async function readCorrectionRows<T>(page: (from: number, to: number) => PromiseLike<QueryRows>): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const result = await page(rows.length, rows.length + 499);
    if (result.error) throw new Error(dbErrorMessage(result.error));
    if (!result.data?.length) return rows;
    rows.push(...result.data as T[]);
  }
}

function groupsOf<T>(rows: T[]) {
  return Array.from({ length: Math.ceil(rows.length / 100) }, (_, index) => rows.slice(index * 100, index * 100 + 100));
}

type CorrectionItemRow = {
  id: string; sale_id: string; product_id: string; variant_id: string;
  product_name: string; variant_name: string; quantity: number;
  product_variants: { is_ice: boolean } | { is_ice: boolean }[] | null;
};
type CorrectionSaleRow = {
  id: string; sale_date: string; created_at: string; customer_name: string;
};
type CorrectionAllocationRow = {
  id: string; sale_item_id: string; batch_item_id: string; quantity: number; unit_cost: string;
};
type CorrectionBatchItemRow = { id: string; batch_id: string };
type CorrectionBatchRow = { id: string; batch_number: number };

/** Search all dates, including sales entered after a newer batch was opened. */
export async function searchBatchCorrectionSales(batchId: string, query: string) {
  const session = await getSessionState();
  if (session.status !== "ok" || session.profile.role_code.toLowerCase() !== "admin") {
    return { ok: false as const, message: "Somente o Administrador pode corrigir vínculos de vendas." };
  }
  const details = await getBatchDetails(batchId);
  if (!details.ok) return details;
  if (details.batch.status !== "ABERTO") {
    return { ok: false as const, message: "A correção manual está disponível somente para lotes em andamento." };
  }
  const supabase = await createClient();
  try {
    const variants = [...new Set(details.items.map((item) => item.variant_id))];
    const items: CorrectionItemRow[] = [];
    for (const variantGroup of groupsOf(variants)) {
      items.push(...await readCorrectionRows<CorrectionItemRow>((from, to) => supabase.from("sale_items")
        .select("id, sale_id, product_id, variant_id, product_name, variant_name, quantity, product_variants(is_ice)")
        .in("variant_id", variantGroup).order("id").range(from, to)));
    }
    const sales: CorrectionSaleRow[] = [];
    for (const saleGroup of groupsOf([...new Set(items.map((item) => item.sale_id))])) {
      sales.push(...await readCorrectionRows<CorrectionSaleRow>((from, to) => supabase.from("sales_overview")
        .select("id, sale_date, created_at, customer_name").in("id", saleGroup).eq("is_valid", true)
        .order("id").range(from, to)));
    }
    const q = query.trim().toLocaleLowerCase("pt-BR");
    const selected = sales.filter((sale) => !q || sale.id.toLowerCase().startsWith(q) ||
      sale.customer_name.toLocaleLowerCase("pt-BR").includes(q) || sale.sale_date.includes(q) ||
      items.some((item) => item.sale_id === sale.id &&
        `${item.product_name} ${item.variant_name}`.toLocaleLowerCase("pt-BR").includes(q)))
      .sort((a, b) => b.sale_date.localeCompare(a.sale_date) || b.created_at.localeCompare(a.created_at))
      .slice(0, 30);
    const selectedIds = new Set(selected.map((sale) => sale.id));
    const selectedItems = items.filter((item) => selectedIds.has(item.sale_id));
    const allocations: CorrectionAllocationRow[] = [];
    for (const itemGroup of groupsOf(selectedItems.map((item) => item.id))) {
      allocations.push(...await readCorrectionRows<CorrectionAllocationRow>((from, to) => supabase.from("sale_item_batch_allocations")
        .select("id, sale_item_id, batch_item_id, quantity, unit_cost")
        .in("sale_item_id", itemGroup).is("reversed_at", null).order("id").range(from, to)));
    }
    const batchItems: CorrectionBatchItemRow[] = [];
    for (const group of groupsOf([...new Set(allocations.map((allocation) => allocation.batch_item_id))])) {
      batchItems.push(...await readCorrectionRows<CorrectionBatchItemRow>((from, to) => supabase.from("batch_items")
        .select("id, batch_id").in("id", group).order("id").range(from, to)));
    }
    const batches: CorrectionBatchRow[] = [];
    for (const group of groupsOf([...new Set(batchItems.map((item) => item.batch_id))])) {
      batches.push(...await readCorrectionRows<CorrectionBatchRow>((from, to) => supabase.from("purchase_batches")
        .select("id, batch_number").in("id", group).order("id").range(from, to)));
    }
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    const batchItemById = new Map(batchItems.map((item) => [item.id, item]));
    const candidates: CorrectionSaleCandidate[] = selected.map((sale) => ({
      saleId: sale.id, saleDate: sale.sale_date, createdAt: sale.created_at, customerName: sale.customer_name,
      items: selectedItems.filter((item) => item.sale_id === sale.id).map((item) => {
        const variant = Array.isArray(item.product_variants) ? item.product_variants[0] : item.product_variants;
        const itemAllocations = allocations.filter((allocation) => allocation.sale_item_id === item.id);
        return {
          id: item.id, productId: item.product_id, variantId: item.variant_id,
          productName: item.product_name,
          variantName: getFlavorDisplayName({ name: item.variant_name, is_ice: variant?.is_ice }),
          quantity: item.quantity,
          allocations: itemAllocations.map((allocation) => {
            const batchItem = batchItemById.get(allocation.batch_item_id)!;
            const batch = batchById.get(batchItem.batch_id)!;
            return {
              id: allocation.id, batchItemId: batchItem.id, batchId: batch.id,
              batchNumber: batch.batch_number, quantity: allocation.quantity, unitCost: Number(allocation.unit_cost),
            };
          }),
          unallocatedQuantity: Math.max(0, item.quantity - itemAllocations.reduce((total, allocation) => total + allocation.quantity, 0)),
        };
      }),
    }));
    return { ok: true as const, sales: candidates };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : "Não foi possível localizar as vendas." };
  }
}

export async function getBatchEditorData(batchId: string) {
  const session = await getSessionState();
  if (session.status !== "ok" || session.profile.role_code.toLowerCase() !== "admin") {
    return { ok: false as const, message: "Somente o Administrador pode editar lotes." };
  }
  const details = await getBatchDetails(batchId);
  if (!details.ok) return details;
  if (details.batch.status !== "ABERTO") {
    return { ok: false as const, message: "Somente lotes em andamento podem ser editados." };
  }
  const [catalog, candidates] = await Promise.all([loadCatalog(), searchBatchCorrectionSales(batchId, "")]);
  if (!catalog.ok) return catalog;
  if (!candidates.ok) return candidates;
  return { ok: true as const, batch: details.batch, items: details.items, catalog: catalog.data, sales: candidates.sales };
}
