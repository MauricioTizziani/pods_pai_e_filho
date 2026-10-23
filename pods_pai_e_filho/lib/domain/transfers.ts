export type TransferPaymentPortion = {
  batchId: string | null;
  label: string;
  amount: string;
};

/** Values shown for explicit confirmation of the existing, indivisible sale payment. */
export type TransferPaymentPreview = {
  batchValue: string;
  saleIds: string[];
  total: string;
  sales: {
    id: string;
    customerName: string;
    total: string;
    portions: TransferPaymentPortion[];
  }[];
};

export type TransferPaymentPreviewResult =
  | { ok: true; preview: TransferPaymentPreview }
  | { ok: false; message: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const moneyPattern = /^\d+\.\d{2}$/;

export function isTransferBatchValue(value: unknown): value is string {
  return typeof value === "string" && (value === "todos" || uuidPattern.test(value));
}

/** Reject duplicate or malformed selections before any request reaches the database. */
export function normalizeTransferSaleIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000 ||
    value.some((id) => typeof id !== "string" || !uuidPattern.test(id))) return null;
  const ids = (value as string[]).map((id) => id.toLowerCase()).sort();
  return new Set(ids).size === ids.length ? ids : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Shape validation only; the database re-reads and compares every trusted value. */
export function isTransferPaymentPreview(value: unknown): value is TransferPaymentPreview {
  if (!isRecord(value) || !isTransferBatchValue(value.batchValue) ||
    !Array.isArray(value.saleIds) || !normalizeTransferSaleIds(value.saleIds) || typeof value.total !== "string" ||
    !moneyPattern.test(value.total) || !Array.isArray(value.sales) || value.sales.length !== value.saleIds.length) {
    return false;
  }
  return value.sales.every((sale) => isRecord(sale) && typeof sale.id === "string" && uuidPattern.test(sale.id) &&
    typeof sale.customerName === "string" && typeof sale.total === "string" && moneyPattern.test(sale.total) &&
    Array.isArray(sale.portions) && sale.portions.length > 0 && sale.portions.every((portion) =>
      isRecord(portion) && (portion.batchId === null ||
        (typeof portion.batchId === "string" && uuidPattern.test(portion.batchId))) &&
      typeof portion.label === "string" && typeof portion.amount === "string" && moneyPattern.test(portion.amount)));
}
