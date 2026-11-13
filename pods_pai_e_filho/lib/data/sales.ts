import { createClient } from "@/lib/supabase/server";
import { flavorSearchOrFilter, iceFilterToBool, parseIceParam } from "@/lib/domain/flavors";
import type { AuditLog, SaleBatchAllocation, SaleItem, SaleOverview } from "@/lib/types";

export const CONSULTAS_SALE_OVERVIEW_COLUMNS = [
  "id", "sale_date", "customer_id", "customer_name", "customer_type_id", "customer_type_name",
  "payment_status_id", "notes", "total_amount", "transfer_amount", "profit_amount", "transfer_paid",
  "transfer_paid_at", "transfer_id", "cancelled_at", "cancelled_by", "cancel_reason", "created_by",
  "created_at", "payment_status_code", "payment_status_name", "counts_as_received", "counts_as_receivable",
  "is_terminal", "is_valid", "transfer_due_now", "transfer_is_future", "quantity", "items_label",
  "product_id", "product_name", "variant_id", "variant_name", "unit_price", "unit_transfer", "unit_profit",
  "variant_is_ice",
].join(",");

export type SaleQuery = {
  from?: string;
  to?: string;
  productId?: string;
  customerTypeId?: string;
  paymentStatusId?: string;
  credit?: string;
  ice?: string;
  flavor?: string;
  customer?: string;
  customerId?: string;
  situation?: string;
  dueNow?: boolean;
  future?: boolean;
  paid?: boolean;
  batchId?: string;
  openCredit?: boolean;
  consultas?: boolean;
  limit?: number;
  offset?: number;
  saleIds?: string[];
  includeCosts?: boolean;
  includeCount?: boolean;
};

type CostLine = { cost_price_unit: string | null; line_cost: string | null; line_father_profit: string | null };
type RowsResult = { data: unknown[] | null; error: { message: string } | null };
const RELATED_PAGE_SIZE = 500;

// Continue to an empty page so a lower API row cap never hides related sales.
async function readAll<T>(request: (from: number, to: number) => PromiseLike<RowsResult>) {
  const rows: T[] = [];
  for (;;) {
    const result = await request(rows.length, rows.length + RELATED_PAGE_SIZE - 1);
    if (result.error) return { data: [] as T[], error: result.error };
    const page = (result.data ?? []) as T[];
    if (page.length === 0) return { data: rows, error: null };
    rows.push(...page);
  }
}

function chunks<T>(values: T[]): T[][] {
  return Array.from({ length: Math.ceil(values.length / 100) }, (_, index) => values.slice(index * 100, (index + 1) * 100));
}

function withCostFigures(sale: SaleOverview, items: CostLine[]): SaleOverview {
  const missing = items.length === 0 || items.some((item) => item.cost_price_unit == null);
  return {
    ...sale,
    cost_history_missing: missing,
    cost_amount: missing ? null : String(items.reduce((sum, item) => sum + Number(item.line_cost), 0)),
    father_profit_amount: missing ? null : String(items.reduce((sum, item) => sum + Number(item.line_father_profit), 0)),
  };
}

export async function listSales(query: SaleQuery = {}) {
  const supabase = await createClient();
  const limit = query.limit ?? 200;
  if (query.saleIds?.length === 0) {
    return { ok: true as const, message: "", sales: [] as SaleOverview[], totalCount: 0 };
  }
  let batchSaleIds: string[] | undefined;

  if (query.batchId) {
    const { data: batchItems, error: batchError } = await readAll<{ id: string }>((from, to) => supabase
      .from("batch_items")
      .select("id")
      .eq("batch_id", query.batchId!)
      .order("id")
      .range(from, to));
    if (batchError) return { ok: false as const, message: batchError.message, sales: [] as SaleOverview[], totalCount: null };
    const batchItemIds = batchItems.map((item) => item.id);
    if (batchItemIds.length === 0) return { ok: true as const, message: "", sales: [] as SaleOverview[], totalCount: 0 };
    const saleItemIds = new Set<string>();
    for (const group of chunks(batchItemIds)) {
      const { data: allocations, error: allocationError } = await readAll<{ sale_item_id: string }>((from, to) => supabase
        .from("sale_item_batch_allocations")
        .select("sale_item_id")
        .in("batch_item_id", group)
        .order("id")
        .range(from, to));
      if (allocationError) return { ok: false as const, message: allocationError.message, sales: [] as SaleOverview[], totalCount: null };
      for (const allocation of allocations) saleItemIds.add(allocation.sale_item_id);
    }
    if (saleItemIds.size === 0) return { ok: true as const, message: "", sales: [] as SaleOverview[], totalCount: 0 };
    const saleIds = new Set<string>();
    for (const group of chunks([...saleItemIds])) {
      const { data: saleItemsForBatch, error: saleItemsError } = await readAll<{ sale_id: string }>((from, to) => supabase
        .from("sale_items")
        .select("sale_id")
        .in("id", group)
        .order("id")
        .range(from, to));
      if (saleItemsError) return { ok: false as const, message: saleItemsError.message, sales: [] as SaleOverview[], totalCount: null };
      for (const item of saleItemsForBatch) saleIds.add(item.sale_id);
    }
    if (saleIds.size === 0) return { ok: true as const, message: "", sales: [] as SaleOverview[], totalCount: 0 };
    batchSaleIds = query.saleIds ? [...new Set(query.saleIds)].filter((id) => saleIds.has(id)) : [...saleIds];
    if (batchSaleIds.length === 0) return { ok: true as const, message: "", sales: [] as SaleOverview[], totalCount: 0 };
  }

  function salesRequest(ids?: string[], includeCount = query.includeCount, head = false) {
    let request = supabase
      .from("sales_overview")
      .select(query.consultas ? CONSULTAS_SALE_OVERVIEW_COLUMNS : "*", includeCount ? { count: "exact", head } : undefined)
      .order("sale_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (ids) request = request.in("id", ids);
    if (query.from) request = request.gte("sale_date", query.from);
    if (query.to) request = request.lte("sale_date", query.to);
    if (query.productId) request = request.eq("product_id", query.productId);
    if (query.customerTypeId) request = request.eq("customer_type_id", query.customerTypeId);
    if (query.paymentStatusId) request = request.eq("payment_status_id", query.paymentStatusId);
    if (!query.consultas && query.credit === "sim") request = request.eq("is_credit", true);
    if (!query.consultas && query.credit === "nao") request = request.eq("is_credit", false);
    const ice = iceFilterToBool(parseIceParam(query.ice));
    if (ice === true) request = request.eq("variant_is_ice", true);
    if (ice === false) request = request.eq("variant_is_ice", false);
    const flavorOr = query.flavor ? flavorSearchOrFilter(query.flavor) : null;
    if (flavorOr) request = request.or(flavorOr);
    if (query.customer) request = request.ilike("customer_name", `%${query.customer}%`);
    if (query.customerId) request = request.eq("customer_id", query.customerId);
    if (query.situation !== "todas" && query.situation !== "canceladas") {
      request = request.eq("is_valid", true);
    }
    if (query.situation === "canceladas") request = request.eq("is_valid", false);
    if (query.dueNow) request = request.eq("transfer_due_now", true);
    if (query.future) request = request.eq("transfer_is_future", true);
    if (query.paid) request = request.eq("transfer_paid", true).eq("is_valid", true);
    if (!query.consultas && query.openCredit) {
      request = request
        .eq("is_credit", true)
        .eq("counts_as_receivable", true)
        .eq("is_valid", true);
    }
    return request;
  }

  let sales: SaleOverview[];
  let totalCount: number | null;
  if (batchSaleIds) {
    // Keep every request bounded; the final page is selected after the groups are merged.
    const matchingSales: SaleOverview[] = [];
    for (const group of chunks(batchSaleIds)) {
      const result = await readAll<SaleOverview>((from, to) => salesRequest(group, false).range(from, to));
      if (result.error) return { ok: false as const, message: result.error.message, sales: [] as SaleOverview[], totalCount: null };
      matchingSales.push(...result.data);
    }
    matchingSales.sort((a, b) =>
      b.sale_date.localeCompare(a.sale_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    totalCount = query.includeCount || matchingSales.length === 0 ? matchingSales.length : null;
    const offset = query.offset ?? 0;
    sales = matchingSales.slice(offset, offset + limit);
  } else {
    const request = salesRequest(query.saleIds);
    const { data, error, count } = await (query.offset === undefined
      ? request.limit(limit)
      : request.range(query.offset, query.offset + limit - 1));
    if (error?.code === "PGRST103" && query.includeCount) {
      // PostgREST can reject an out-of-range page before returning its total.
      const counted = await salesRequest(query.saleIds, true, true);
      if (counted.error) return { ok: false as const, message: counted.error.message, sales: [] as SaleOverview[], totalCount: null };
      return { ok: true as const, message: "", sales: [] as SaleOverview[], totalCount: counted.count ?? null };
    }
    if (error) return { ok: false as const, message: error.message, sales: [] as SaleOverview[], totalCount: null };
    totalCount = count ?? null;
    sales = (data ?? []) as unknown as SaleOverview[];
    if (query.includeCount) {
      const offset = query.offset ?? 0;
      const expected = totalCount === null ? limit : Math.min(limit, Math.max(0, totalCount - offset));
      while (sales.length < expected) {
        const next = await salesRequest(query.saleIds, false).range(offset + sales.length, offset + limit - 1);
        if (next.error) return { ok: false as const, message: next.error.message, sales: [] as SaleOverview[], totalCount: null };
        const page = (next.data ?? []) as unknown as SaleOverview[];
        if (page.length === 0) break;
        sales.push(...page);
      }
    }
  }
  if (sales.length === 0 || query.includeCosts === false) return { ok: true as const, message: "", sales, totalCount };

  let itemRows: Array<CostLine & { sale_id: string }>;
  if (query.includeCount) {
    itemRows = [];
    for (const group of chunks(sales.map((sale) => sale.id))) {
      const result = await readAll<CostLine & { sale_id: string }>((from, to) => supabase
        .from("sale_items")
        .select("sale_id, cost_price_unit, line_cost, line_father_profit")
        .in("sale_id", group)
        .order("id")
        .range(from, to));
      if (result.error) return { ok: false as const, message: result.error.message, sales: [] as SaleOverview[], totalCount: null };
      itemRows.push(...result.data);
    }
  } else {
    const result = await supabase
      .from("sale_items")
      .select("sale_id, cost_price_unit, line_cost, line_father_profit")
      .in("sale_id", sales.map((sale) => sale.id));
    if (result.error) return { ok: false as const, message: result.error.message, sales: [] as SaleOverview[], totalCount: null };
    itemRows = (result.data ?? []) as Array<CostLine & { sale_id: string }>;
  }

  const itemsBySale = new Map<string, CostLine[]>();
  for (const row of itemRows) {
    const group = itemsBySale.get(row.sale_id) ?? [];
    group.push(row);
    itemsBySale.set(row.sale_id, group);
  }
  return {
    ok: true as const,
    message: "",
    totalCount,
    sales: sales.map((sale) => withCostFigures(sale, itemsBySale.get(sale.id) ?? [])),
  };
}

export async function getSale(id: string, consultas = false) {
  const supabase = await createClient();
  const auditQuery = consultas
    ? Promise.resolve({ data: [] })
    : supabase
        .from("audit_logs")
        .select("id, action, entity_type, entity_id, metadata, created_at, profiles(full_name)")
        .eq("entity_type", "sales")
        .eq("entity_id", id)
        .order("created_at", { ascending: false });
  const [sale, items, audit] = await Promise.all([
    supabase
      .from("sales_overview")
      .select(consultas ? CONSULTAS_SALE_OVERVIEW_COLUMNS : "*")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("sale_items").select("*").eq("sale_id", id).order("created_at"),
    auditQuery,
  ]);

  if (sale.error) return { ok: false as const, message: sale.error.message };
  if (!sale.data) return { ok: false as const, message: "Venda não encontrada." };

  const logs = ((audit.data ?? []) as Array<AuditLog & { profiles?: { full_name: string } | { full_name: string }[] | null }>).map(
    (entry) => {
      const profile = Array.isArray(entry.profiles) ? entry.profiles[0] : entry.profiles;
      return {
        id: entry.id,
        action: entry.action,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        metadata: entry.metadata,
        created_at: entry.created_at,
        user_name: profile?.full_name ?? null,
      } satisfies AuditLog;
    },
  );

  let batchAllocations: SaleBatchAllocation[] = [];
  const saleItemRows = (items.data ?? []) as SaleItem[];
  if (saleItemRows.length > 0) {
    const { data: allocationRows } = await supabase
      .from("sale_item_batch_allocations")
      .select("id, sale_item_id, batch_item_id, quantity, unit_cost, reversed_at")
      .in("sale_item_id", saleItemRows.map((item) => item.id));
    const allocationData = allocationRows ?? [];
    const batchItemIds = [...new Set(allocationData.map((row) => row.batch_item_id))];
    if (batchItemIds.length > 0) {
      const { data: batchItemRows } = await supabase
        .from("batch_items")
        .select("id, batch_id")
        .in("id", batchItemIds);
      const batchIds = [...new Set((batchItemRows ?? []).map((row) => row.batch_id))];
      const { data: batchRows } = batchIds.length > 0
        ? await supabase.from("purchase_batches").select("id, batch_number").in("id", batchIds)
        : { data: [] };
      const batchById = new Map((batchRows ?? []).map((row) => [row.id, row.batch_number]));
      const batchByItem = new Map((batchItemRows ?? []).map((row) => [row.id, row.batch_id]));
      batchAllocations = allocationData.map((row) => ({
        id: row.id,
        sale_item_id: row.sale_item_id,
        quantity: row.quantity,
        unit_cost: row.unit_cost,
        reversed_at: row.reversed_at,
        batch_number: batchById.get(batchByItem.get(row.batch_item_id) ?? "") ?? null,
      }));
    }
  }

  return {
    ok: true as const,
    sale: withCostFigures(sale.data as unknown as SaleOverview, ((items.data ?? []) as SaleItem[]).map((item) => ({
      cost_price_unit: item.cost_price_unit,
      line_cost: item.line_cost,
      line_father_profit: item.line_father_profit,
    }))),
    items: (items.data ?? []) as SaleItem[],
    batchAllocations,
    audit: logs,
  };
}
