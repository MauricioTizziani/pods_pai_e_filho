export type Profile = {
  id: string;
  full_name: string;
  email: string | null;
  role_code: string;
  role_name: string;
  can_write: boolean;
};

export type CustomerType = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  sort_order: number;
};

export type PaymentStatus = {
  id: string;
  code: string;
  name: string;
  counts_as_received: boolean;
  counts_as_receivable: boolean;
  is_terminal: boolean;
  active: boolean;
  sort_order: number;
};

export type Product = {
  id: string;
  name: string;
  brand: string;
  model: string;
  approximate_puffs: number | null;
  cost_price: string | null;
  promotion_name?: string | null;
  promotion_features?: string[];
  display_order?: number | null;
  active: boolean;
  has_history?: boolean;
};

export type ProductVariant = {
  id: string;
  product_id: string;
  name: string;
  is_ice: boolean;
  active: boolean;
  has_history?: boolean;
};

export type PriceRule = {
  id: string;
  product_id: string;
  customer_type_id: string;
  sale_price: string;
  father_transfer: string;
  unit_profit: string;
  active: boolean;
};

export type Customer = {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  customer_type_id: string | null;
  active: boolean;
};

export type StockBalance = {
  variant_id: string;
  variant_name: string;
  variant_active: boolean;
  variant_is_ice: boolean;
  product_id: string;
  product_name: string;
  brand: string;
  model: string;
  approximate_puffs: number | null;
  product_active: boolean;
  quantity: number;
};

export type StockMovement = {
  id: string;
  movement_type: string;
  movement_name: string;
  direction: number;
  quantity: number;
  movement_date: string;
  sale_id: string | null;
  notes: string | null;
  created_at: string;
  product_name: string;
  variant_name: string;
  variant_is_ice?: boolean;
  user_name: string | null;
  batch_number?: number | null;
};

export type BatchOverview = {
  batch_id: string;
  batch_number: number;
  purchase_date: string;
  notes: string | null;
  is_legacy: boolean;
  status: "ABERTO" | "FINALIZADO" | "CANCELADO";
  created_by: string | null;
  created_at: string;
  closed_at: string | null;
  total_purchased: number;
  quantity_sold: number;
  quantity_remaining: number;
  capital_invested: string;
  capital_in_stock: string;
  capital_recovered: string;
  revenue: string;
  revenue_received: string;
  revenue_receivable: string;
  transfer_total: string;
  transfer_paid: string;
  transfer_due_now: string;
  transfer_future: string;
  father_profit: string;
  child_profit: string | null;
  total_profit: string | null;
  last_sale_date: string | null;
  has_sales: boolean;
  duration_days: number | null;
};

export type BatchItemOverview = {
  batch_item_id: string;
  batch_id: string;
  batch_number: number;
  purchase_date: string;
  status: "ABERTO" | "FINALIZADO" | "CANCELADO";
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_name: string;
  quantity_purchased: number;
  quantity_sold: number;
  quantity_remaining: number;
  unit_cost: string;
  investment: string;
  capital_in_stock: string;
};

export type SaleOverview = {
  id: string;
  sale_date: string;
  customer_id: string | null;
  customer_name: string;
  customer_type_id: string;
  customer_type_name: string;
  payment_status_id: string;
  is_credit?: boolean;
  notes: string | null;
  total_amount: string;
  transfer_amount: string;
  profit_amount: string;
  transfer_paid: boolean;
  transfer_paid_at: string | null;
  transfer_id: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: string;
  payment_status_code: string;
  payment_status_name: string;
  counts_as_received: boolean;
  counts_as_receivable: boolean;
  is_terminal: boolean;
  is_valid: boolean;
  transfer_due_now: boolean;
  transfer_is_future: boolean;
  quantity: number;
  items_label: string;
  product_id: string | null;
  product_name: string | null;
  variant_id: string | null;
  variant_name: string | null;
  variant_is_ice?: boolean | null;
  unit_price: string | null;
  unit_transfer: string | null;
  unit_profit: string | null;
  cost_amount?: string | null;
  father_profit_amount?: string | null;
  cost_history_missing?: boolean;
};

export type SaleItem = {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_name: string;
  quantity: number;
  unit_price: string;
  unit_transfer: string;
  unit_profit: string;
  cost_price_unit: string | null;
  unit_father_profit: string | null;
  line_cost: string | null;
  line_father_profit: string | null;
  line_total: string;
  line_transfer: string;
  line_profit: string;
};

export type AuditLog = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  user_name?: string | null;
};

export type Metrics = {
  money_received: string;
  receivable: string;
  profit_received: string;
  profit_total: string;
  transfer_from_received: string;
  transfer_future: string;
  transfer_due_now: string;
  transfer_total: string;
  sales_count: number;
  units_sold: number;
};

export type ReportRow = {
  name: string;
  quantity: number;
  revenue: string;
  transfer: string;
  profit: string;
  stock?: number;
};

export type SalesReport = {
  by_customer_type: ReportRow[];
  by_status: ReportRow[];
  by_product: ReportRow[];
};

export type ConsultasFinancialSummary = {
  sales_count: number;
  units_sold: number;
  due_now_sales: number;
  future_sales: number;
  revenue: string;
  cost_sold: string;
  cost_missing_items: number;
  transfer_total: string;
  transfer_received: string;
  transfer_due_now: string;
  transfer_future: string;
  father_profit_total: string;
  father_profit_received: string;
  father_profit_missing_items: number;
  father_profit_missing_received_items: number;
  stock_cost_total: string;
  stock_cost_missing_products: number;
};

export type StockDivergence = {
  variant_id: string;
  product_id: string;
  product_name: string;
  variant_name: string;
  variant_is_ice?: boolean;
  system_quantity: number;
  physical_quantity: number;
  difference: number;
  counted_at: string;
};

export type TransferRecord = {
  id: string;
  paid_at: string;
  notes: string | null;
  total_amount: string;
  payer_name: string | null;
};

export type ActionResult =
  | { ok: true; id?: string }
  | { ok: false; message: string };

export type CatalogSnapshot = {
  products: Product[];
  variants: ProductVariant[];
  customerTypes: CustomerType[];
  statuses: PaymentStatus[];
  prices: PriceRule[];
  customers: Customer[];
  stock: StockBalance[];
  batchItems?: BatchItemOverview[];
};

export type SaleBatchAllocation = {
  id: string;
  sale_item_id: string;
  quantity: number;
  unit_cost: string;
  reversed_at: string | null;
  batch_number: number | null;
};

export type BatchEditInput = {
  batchId: string;
  purchaseDate: string;
  notes: string;
  samePurchaseConfirmed?: boolean;
  items: { batchItemId?: string; variantId: string; quantity: number; unitCost: number }[];
};

export type SaleBatchCorrectionInput = {
  batchId: string;
  saleItemId: string;
  sourceAllocationId: string | null;
  quantity: number;
  destinationItemId: string;
};

export type CorrectionPreview = {
  request_id: string;
  summary: {
    kind: "entry" | "allocation";
    batch_id: string;
    batch_number: number;
    sale_id?: string;
    description: string;
    stock_delta: number;
    changes: {
      label: string;
      before: string | number | null;
      after: string | number | null;
      unit?: "money" | "quantity" | "text";
    }[];
  };
};

export type CorrectionPreviewResult =
  | { ok: true; preview: CorrectionPreview }
  | { ok: false; message: string };

export type CorrectionSaleCandidate = {
  saleId: string;
  saleDate: string;
  createdAt: string;
  customerName: string;
  items: {
    id: string;
    productId: string;
    variantId: string;
    productName: string;
    variantName: string;
    quantity: number;
    allocations: {
      id: string;
      batchItemId: string;
      batchId: string;
      batchNumber: number;
      quantity: number;
      unitCost: number;
    }[];
    unallocatedQuantity: number;
  }[];
};
