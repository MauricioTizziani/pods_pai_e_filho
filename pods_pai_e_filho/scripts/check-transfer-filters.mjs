// Actual pages, loaders and PostgreSQL RPCs with disposable local fixtures only.
// No .env file, credentials, network or production data is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";

const root = fileURLToPath(new URL("../", import.meta.url));
const plain = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;

async function test(name, operation) {
  await operation();
  console.log(`OK ${++checks}: ${name}`);
}

function loadActual(relativePath, mocks = {}, globals = {}) {
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const compiledModule = { exports: {} };
    modules.set(filename, compiledModule);
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(output, {
      module: compiledModule, exports: compiledModule.exports, URLSearchParams, console, ...globals,
      require(name) {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        if (name.startsWith("@/lib/")) return load(path.join(root, `${name.slice(2)}.ts`));
        if (name.startsWith(".")) {
          const resolved = path.resolve(path.dirname(filename), name);
          return load(path.extname(resolved) ? resolved : `${resolved}.ts`);
        }
        if (name.startsWith("@/components/")) return componentMocks;
        throw new Error(`Import externo não simulado: ${name}`);
      },
    }, { filename });
    return compiledModule.exports;
  }
  return load(path.join(root, relativePath));
}

const componentMocks = new Proxy({}, {
  get(_, key) {
    if (key === "__esModule") return true;
    const value = () => null;
    Object.defineProperty(value, "name", { value: String(key) });
    return value;
  },
});
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
function elements(tree, predicate) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) found.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) visit(child);
  }
  visit(tree);
  return found;
}

function sale(id, extra = {}) {
  return {
    id, sale_date: "2026-10-10", created_at: "2026-10-10T12:00:00Z",
    customer_id: null, customer_name: "Cliente histórico excluído", customer_type_id: "retail", customer_type_name: "Varejo",
    payment_status_id: "received", payment_status_name: "Recebido", is_credit: false,
    is_valid: true, counts_as_received: true, counts_as_receivable: false,
    transfer_paid: false, transfer_due_now: true, transfer_is_future: false,
    product_id: "product-7", product_name: "Pod histórico", variant_id: "grape", variant_name: "Uva", variant_is_ice: true,
    quantity: 2, total_amount: "300.00", transfer_amount: "240.00", profit_amount: "60.00", ...extra,
  };
}
function item(id, saleId, amount = "125.00", extra = {}) {
  return {
    id, sale_id: saleId, product_id: "product-7", product_name: "Pod histórico", variant_id: "grape", variant_name: "Uva",
    quantity: 1, unit_price: "150.00", unit_transfer: amount, cost_price_unit: "100.00", line_cost: "100.00",
    product_variants: { name: "Uva", is_ice: true }, ...extra,
  };
}
function allocation(id, batch, soldItem, amount = "125.00", extra = {}) {
  return { id, batch_item_id: batch, sale_item_id: soldItem, quantity: 1, unit_cost: "100.00", unit_price: "150.00", unit_transfer: amount, reversed_at: null, ...extra };
}
const fixtures = {
  sales_overview: [
    sale("mixed"), sale("future", { transfer_due_now: false, transfer_is_future: true, counts_as_received: false, counts_as_receivable: true }),
    sale("paid", { transfer_due_now: false, transfer_paid: true }), sale("credit", { is_credit: true, counts_as_received: false, counts_as_receivable: true }),
    sale("legacy"), sale("cancelled", { is_valid: false, transfer_due_now: false }), sale("reversed"),
  ],
  sale_items: [
    item("mixed-7", "mixed"), item("mixed-8", "mixed", "115.00", { product_id: "product-8", variant_name: "Menta", product_variants: { name: "Menta", is_ice: false } }),
    ...["future", "paid", "credit", "legacy", "cancelled", "reversed"].map((id) => item(`${id}-item`, id)),
  ],
  batch_items: [{ id: "stock-7", batch_id: "lot-7" }, { id: "stock-8", batch_id: "lot-8" }],
  sale_item_batch_allocations: [
    allocation("mixed-allocation-7", "stock-7", "mixed-7"), allocation("mixed-allocation-8", "stock-8", "mixed-8", "115.00"),
    ...["future", "paid", "credit", "cancelled"].map((id) => allocation(`${id}-allocation`, "stock-8", `${id}-item`)),
    allocation("reversed-allocation", "stock-8", "reversed-item", "125.00", { reversed_at: "2026-10-11T12:00:00Z" }),
  ],
};

// Supabase pagination and predicates are simulated; both production loaders run.
function financialHarness(data = fixtures, { cap = 37, failTable, failOffset = 0 } = {}) {
  const requests = [];
  const client = {
    from(table) {
      const request = { table, filters: [], sort: [], from: 0, to: Infinity };
      requests.push(request);
      return {
        select(columns) { request.columns = columns; return this; },
        eq(column, value) { request.filters.push(["eq", column, value]); return this; },
        is(column, value) { request.filters.push(["eq", column, value]); return this; },
        in(column, value) { request.filters.push(["in", column, [...value]]); return this; },
        gte(column, value) { request.filters.push(["gte", column, value]); return this; },
        lte(column, value) { request.filters.push(["lte", column, value]); return this; },
        ilike(column, value) { request.filters.push(["ilike", column, value]); return this; },
        order(column, options = {}) { request.sort.push([column, options.ascending !== false]); return this; },
        range(from, to) { request.from = from; request.to = to; return this; },
        limit(limit) { request.to = limit - 1; return this; },
        then(resolve, reject) {
          if (table === failTable && request.from >= failOffset) {
            return Promise.resolve({ data: null, error: { message: "Falha de carregamento simulada" } }).then(resolve, reject);
          }
          let result = (data[table] ?? []).filter((row) => request.filters.every(([op, column, value]) => {
            if (op === "in") return value.includes(row[column]);
            if (op === "gte") return row[column] >= value;
            if (op === "lte") return row[column] <= value;
            if (op === "ilike") return String(row[column]).toLowerCase().includes(value.replace(/^%|%$/g, "").toLowerCase());
            return row[column] === value;
          }));
          result = result.sort((left, right) => {
            for (const [column, ascending] of request.sort) {
              const compare = String(left[column]).localeCompare(String(right[column]));
              if (compare) return ascending ? compare : -compare;
            }
            return 0;
          });
          result = result.slice(request.from, Math.min(request.to + 1, request.from + cap));
          request.returned = result.length;
          return Promise.resolve({ data: result, error: null }).then(resolve, reject);
        },
      };
    },
  };
  const errors = { dbErrorMessage: (error) => error.message };
  const supabase = { createClient: async () => client };
  const sales = loadActual("lib/data/sales.ts", { "@/lib/supabase/server": supabase });
  const financial = loadActual("lib/data/financial-sales.ts", {
    "@/lib/supabase/server": supabase, "@/lib/data/sales": sales, "@/lib/errors": errors,
  });
  return { ...financial, requests };
}

await test("Snapshots históricos separam R$ 125/R$ 115; consolidado soma R$ 240 uma vez e inclui histórico sem lote", async () => {
  const harness = financialHarness();
  const first = await harness.loadFinancialSales({ batchId: "lot-7" });
  const second = await harness.loadFinancialSales({ batchId: "lot-8" });
  const general = await harness.loadFinancialSales();
  for (const [result, expected] of [[first, "125.00"], [second, "115.00"], [general, "240.00"]]) {
    assert.equal(result.ok, true, result.message);
    assert.equal(result.sales.find((row) => row.id === "mixed").transfer_amount, expected);
    assert.equal(result.sales.filter((row) => row.id === "mixed").length, 1);
  }
  assert.equal(general.sales.some((row) => row.id === "legacy"), true);
  assert.equal(general.sales.find((row) => row.id === "legacy").customer_name, "Cliente histórico excluído");
  assert.equal(second.sales.some((row) => ["legacy", "cancelled", "reversed"].includes(row.id)), false);
  assert.equal(harness.requests.some((request) => ["products", "price_rules"].includes(request.table)), false);
  assert.equal(first.sales[0].transfer_due_now, true);
  assert.equal(second.sales.find((row) => row.id === "future").transfer_is_future, true);
  assert.equal(second.sales.find((row) => row.id === "paid").transfer_paid, true);
  assert.equal(second.sales.find((row) => row.id === "credit").transfer_due_now, true);
});

await test("Filtro combina cliente histórico, período, produto e perfil CONSULTAS sem perder a classificação", async () => {
  const harness = financialHarness();
  const filtered = await harness.loadFinancialSales({ batchId: "lot-8", from: "2026-10-01", to: "2026-10-31", customer: " histórico excluído ", productId: "product-8", consultas: true });
  assert.equal(filtered.ok, true, filtered.message);
  assert.equal(filtered.sales.length, 1);
  assert.equal(filtered.sales[0].transfer_amount, "115.00");
  assert.equal(filtered.sales[0].profit_amount, "0.00");
  assert.equal(filtered.sales[0].unit_profit, "0.00");
  assert.equal(Object.hasOwn(filtered.sales[0], "is_credit"), false);
  const overview = harness.requests.filter((request) => request.table === "sales_overview");
  assert.ok(overview.every((request) => !request.columns.split(",").includes("is_credit")));
  const empty = await harness.loadFinancialSales({ batchId: "empty" });
  assert.equal(empty.ok, true);
  assert.equal(empty.sales.length, 0);
  assert.equal(empty.lines.length, 0);
  const excluded = await harness.loadFinancialSales({ batchId: "lot-8", from: "2026-11-01" });
  assert.equal(excluded.sales.length, 0);
});

await test("Mais de 300 vendas entram nos totais, com paginação e seleção do lote antes das páginas", async () => {
  const many = { sales_overview: [], sale_items: [], batch_items: [], sale_item_batch_allocations: [] };
  for (let index = 0; index < 317; index++) {
    const suffix = String(index).padStart(3, "0");
    many.sales_overview.push(sale(`sale-${suffix}`));
    many.sale_items.push(item(`item-${suffix}`, `sale-${suffix}`, "1.25"));
    many.batch_items.push({ id: `stock-${suffix}`, batch_id: "many" });
    many.sale_item_batch_allocations.push(allocation(`allocation-${suffix}`, `stock-${suffix}`, `item-${suffix}`, "1.25"));
  }
  for (const batchId of [undefined, "many"]) {
    const harness = financialHarness(many, { cap: 31 });
    const result = await harness.loadFinancialSales({ batchId });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.sales.length, 317);
    assert.equal(result.sales.reduce((sum, row) => sum + Math.round(Number(row.transfer_amount) * 100), 0), 39625);
    assert.ok(harness.requests.some((request) => request.from > 0));
    assert.ok(harness.requests.some((request) => request.returned === 0));
  }
  const failed = await financialHarness(many, { cap: 31, failTable: "sale_items", failOffset: 31 }).loadFinancialSales();
  assert.equal(failed.ok, false);
  assert.equal(failed.sales.length, 0);
  assert.match(failed.message, /Falha de carregamento/);
});

const batches = [
  { batch_id: "lot-7", batch_number: 7, status: "ABERTO", purchase_date: "2026-09-01", created_at: "2026-09-01T12:00:00Z" },
  { batch_id: "finished", batch_number: 9, status: "FINALIZADO", purchase_date: "2026-10-06", created_at: "2026-10-06T12:00:00Z" },
  { batch_id: "lot-8", batch_number: 8, status: "ABERTO", purchase_date: "2026-10-01", created_at: "2026-10-01T12:00:00Z" },
  { batch_id: "cancelled", batch_number: 10, status: "CANCELADO", purchase_date: "2026-10-07", created_at: "2026-10-07T12:00:00Z" },
];
class RedirectSignal extends Error { constructor(url) { super(url); this.url = url; } }
async function renderPage(params, options = {}) {
  const calls = [];
  const record = (name, callback) => async (...args) => { calls.push({ name, args }); return callback(...args); };
  const data = financialHarness();
  const page = loadActual("app/(painel)/repasses/page.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/navigation": { redirect: (url) => { throw new RedirectSignal(url); } },
    "@/lib/auth": { getSessionState: record("session", () => ({ status: "ok", profile: { role_code: options.role ?? "ADMIN", can_write: options.role !== "CONSULTAS" } })) },
    "@/lib/data/batches": { listBatches: record("batches", () => ({ ok: !options.batchError, message: options.batchError ?? "", batches: options.batchError ? [] : options.batches ?? batches })) },
    "@/lib/data/financial-sales": { loadFinancialSales: record("financial", (query) => options.financialError ? ({ ok: false, message: "Falha financeira simulada", sales: [], lines: [] }) : data.loadFinancialSales(query)) },
    "lucide-react": componentMocks,
  }).default;
  try { return { tree: await page({ searchParams: Promise.resolve(params) }), calls, redirect: null }; }
  catch (error) { if (error instanceof RedirectSignal) return { tree: null, calls, redirect: error.url }; throw error; }
}
const boardFor = (result) => elements(result.tree, (node) => node.type?.name === "TransferBoard")[0];
const queryFor = (result) => result.calls.find((call) => call.name === "financial")?.args[0];

await test("Repasses reutiliza o lote inicial da Dashboard e canoniza a URL antes de consultar valores", async () => {
  const { resolveBatchFilter } = loadActual("lib/domain/batch-filters.ts");
  for (const role of ["ADMIN", "CONSULTAS"]) {
    for (const available of [batches, batches.filter((batch) => batch.status !== "ABERTO"), [], batches.filter((batch) => batch.status === "CANCELADO")]) {
      for (const selection of [undefined, "inaccessible"]) {
        const params = { lote: selection, cliente: "Cliente com espaço", periodo: "personalizado", de: "2026-09-01", ate: "2026-10-31", aba: "pagos", pagina: "3" };
        const result = await renderPage(params, { role, batches: available });
        const canonical = new URL(result.redirect, "https://local.test");
        assert.equal(canonical.pathname, "/repasses");
        assert.equal(canonical.searchParams.get("lote"), resolveBatchFilter(available, selection).value);
        for (const [name, value] of Object.entries(params)) if (name !== "lote") assert.equal(canonical.searchParams.get(name), value);
        assert.equal(queryFor(result), undefined, "não consulta o consolidado antes de resolver o lote");
      }
    }
  }
});

await test("Seleção explícita, abas e demais parâmetros persistem para ADMIN e CONSULTAS", async () => {
  for (const role of ["ADMIN", "CONSULTAS"]) {
    for (const selected of ["todos", "", "lot-7", "lot-8", "finished", "cancelled"]) {
      const result = await renderPage({ lote: selected, aba: "pagos", periodo: "personalizado", de: "2026-10-01", ate: "2026-10-31", cliente: "histórico", produto: "product-8", fiado: "sim" }, { role });
      assert.equal(result.redirect, null);
      const query = queryFor(result);
      assert.equal(query.batchId ?? null, ["todos", ""].includes(selected) ? null : selected);
      assert.equal(query.from, "2026-10-01");
      assert.equal(query.to, "2026-10-31");
      assert.equal(query.customer, "histórico");
      assert.equal(query.productId, "product-8");
      assert.equal(query.consultas, role === "CONSULTAS");
      assert.equal(query.credit, role === "CONSULTAS" ? undefined : "sim");
      assert.equal(query.limit, undefined, "sem limite de 300 vendas no consolidado");
      const board = boardFor(result);
      assert.ok(board);
      assert.equal(board.props.batchValue, selected === "" ? "todos" : selected);
      assert.equal(board.props.initialTab, "pagos");
      assert.equal(board.props.canWrite, role === "ADMIN");
    }
    const array = await renderPage({ lote: ["lot-7", "lot-8"], aba: ["futuro", "agora"] }, { role });
    assert.equal(queryFor(array).batchId, "lot-7");
    assert.equal(boardFor(array).props.initialTab, "futuro");
  }
});

await test("Cards, contadores, abas e resumo do pai recebem a mesma projeção de lote; vazio difere de falha", async () => {
  for (const role of ["ADMIN", "CONSULTAS"]) {
    const selected = await renderPage({ lote: "lot-8" }, { role });
    const board = boardFor(selected).props;
    assert.deepEqual(plain(board.dueNow.map((row) => row.id).sort()), ["credit", "mixed"]);
    assert.deepEqual(plain(board.future.map((row) => row.id)), ["future"]);
    assert.deepEqual(plain(board.paid.map((row) => row.id)), ["paid"]);
    assert.equal(board.dueNow.reduce((sum, row) => sum + Number(row.transfer_amount), 0), 240);
    if (role === "CONSULTAS") {
      assert.equal(board.receivedTotal, 125);
      assert.equal(board.fatherProfitReceived, 25);
      assert.ok(board.dueNow.every((row) => !Object.hasOwn(row, "is_credit") && row.profit_amount === "0.00"));
    }
    const empty = await renderPage({ lote: "finished" }, { role });
    assert.ok(boardFor(empty));
    assert.equal(boardFor(empty).props.batchValue, "finished");
    assert.equal(boardFor(empty).props.dueNow.length + boardFor(empty).props.future.length + boardFor(empty).props.paid.length, 0);
    for (const params of [{}, { lote: "todos" }, { lote: "lot-8" }]) {
      const error = await renderPage(params, { role, batchError: "Falha nos lotes" });
      assert.equal(queryFor(error), undefined);
      assert.equal(boardFor(error), undefined);
      assert.ok(elements(error.tree, (node) => node.type?.name === "Notice").length > 0);
    }
    const failure = await renderPage({ lote: "lot-8" }, { role, financialError: true });
    assert.equal(boardFor(failure), undefined);
    assert.ok(elements(failure.tree, (node) => node.type?.name === "Notice").length > 0);
  }
});

function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (node == null || typeof node === "boolean") return "";
  return typeof node === "object" ? textOf(node.props?.children) : String(node);
}
function clientHarness(relativePath, initialProps, actions = {}) {
  let cursor = 0;
  const hooks = [];
  const transitions = [];
  const routes = [];
  let refreshes = 0;
  let props = initialProps;
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = typeof initial === "function" ? initial() : initial;
      return [hooks[slot], (value) => { hooks[slot] = typeof value === "function" ? value(hooks[slot]) : value; }];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useId() { return `id-${cursor++}`; },
    useEffect() {},
    useTransition() {
      const slot = cursor++;
      hooks[slot] ??= false;
      return [hooks[slot], (operation) => {
        hooks[slot] = true;
        transitions.push(Promise.resolve(operation()).finally(() => { hooks[slot] = false; }));
      }];
    },
  };
  const exported = loadActual(relativePath, {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/navigation": { useRouter: () => ({ push: (url) => routes.push(url), refresh: () => refreshes++ }) },
    "next/link": { __esModule: true, default: componentMocks.Link },
    "lucide-react": componentMocks,
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    "@/lib/actions/sales": actions,
  });
  const render = exported.TransferBoard ?? exported.TransferFilters;
  return {
    render(nextProps) { if (nextProps) props = { ...props, ...nextProps }; cursor = 0; return render(props); },
    async flush() { await Promise.all(transitions.splice(0)); },
    routes,
    get refreshes() { return refreshes; },
  };
}
const boardProps = {
  dueNow: [sale("mixed", { transfer_amount: "115.00" }), sale("other", { transfer_amount: "40.00" })],
  future: [sale("later", { transfer_amount: "60.00" })], paid: [sale("already", { transfer_amount: "90.00" })],
  canWrite: true, consultas: false,
  batches: [{ value: "lot-7", label: "Lote 007 — Em andamento" }, { value: "lot-8", label: "Lote 008 — Em andamento" }],
  batchValue: "lot-8", batchLabel: "Lote 008 — Em andamento", initialTab: "agora",
  params: { lote: "lot-8", aba: "agora", cliente: "Pessoa", produto: "product-8", de: "2026-10-01", ate: "2026-10-31", page: "4", pagina: "4" },
};
const button = (tree, label) => elements(tree, (node) => node.type?.name === "Button" && textOf(node).includes(label))[0];

await test("Board exige revisão explícita do valor integral, evita cliques duplos e preserva o lote após confirmar", async () => {
  const previews = [];
  const confirms = [];
  const payment = { batchValue: "lot-8", saleIds: ["mixed"], total: "240.00", sales: [{ id: "mixed", customerName: "Cliente histórico excluído", total: "240.00", portions: [
    { batchId: "lot-7", label: "Lote 007", amount: "125.00" }, { batchId: "lot-8", label: "Lote 008", amount: "115.00" },
  ] }] };
  const harness = clientHarness("components/transfers/transfer-board.tsx", boardProps, {
    previewTransfersAction: async (...args) => { previews.push(plain(args)); return { ok: true, preview: payment }; },
    confirmTransfersAction: async (...args) => { confirms.push(plain(args)); return { ok: true }; },
  });
  let tree = harness.render();
  assert.deepEqual(elements(tree, (node) => node.type?.name === "StatCard").map((node) => node.props.value), [155, 60, 90]);
  const review = button(tree, "Revisar pagamento");
  review.props.onClick();
  review.props.onClick();
  assert.deepEqual(previews, [[["mixed"], "lot-8"]]);
  assert.equal(confirms.length, 0, "prévia não confirma silenciosamente");
  await harness.flush();
  tree = harness.render();
  assert.match(textOf(tree), /também afetará outros lotes/);
  assert.match(textOf(tree), /240,00/);
  assert.match(textOf(tree), /125,00/);
  assert.match(textOf(tree), /115,00/);
  const confirm = button(tree, "Confirmar pagamento integral");
  assert.equal(confirm.props.disabled, false);
  confirm.props.onClick();
  confirm.props.onClick();
  await harness.flush();
  assert.equal(confirms.length, 1);
  assert.deepEqual(confirms[0], [["mixed"], "", payment]);
  assert.equal(harness.refreshes, 1);
  assert.equal(harness.routes.length, 0, "refresh mantém a seleção explícita na URL");
  tree = harness.render();
  assert.equal(elements(tree, (node) => node.type?.name === "TransferFilters")[0].props.batchValue, "lot-8");
});

await test("Troca de lote limpa seleção e páginas, oculta números antigos durante navegação e conserva demais filtros", async () => {
  const previews = [];
  const harness = clientHarness("components/transfers/transfer-board.tsx", boardProps, {
    previewTransfersAction: async (...args) => { previews.push(plain(args)); return { ok: false, message: "Teste" }; },
  });
  let tree = harness.render();
  elements(tree, (node) => node.type?.name === "Checkbox" && node.props["aria-label"] === "Selecionar todas as vendas deste filtro")[0].props.onCheckedChange(true);
  tree = harness.render({ dueNow: [boardProps.dueNow[1]] });
  button(tree, "Revisar selecionados").props.onClick();
  await harness.flush();
  assert.deepEqual(previews[0], [["other"], "lot-8"], "IDs ocultos são retirados da seleção antes de revisar");
  tree = harness.render();
  elements(tree, (node) => node.type?.name === "TransferFilters")[0].props.onBatchChange("lot-7");
  tree = harness.render();
  assert.equal(elements(tree, (node) => node.type?.name === "StatCard").length, 0);
  assert.equal(elements(tree, (node) => node.props?.role === "status").length, 1);
  const url = new URL(harness.routes.at(-1), "https://local.test");
  assert.equal(url.searchParams.get("lote"), "lot-7");
  assert.equal(url.searchParams.get("aba"), "agora");
  assert.equal(url.searchParams.has("page"), false);
  assert.equal(url.searchParams.has("pagina"), false);
  for (const key of ["cliente", "produto", "de", "ate"]) assert.equal(url.searchParams.get(key), boardProps.params[key]);
  await harness.flush();
  tree = harness.render({ batchValue: "lot-7", params: { ...boardProps.params, lote: "lot-7" } });
  assert.equal(button(tree, "Selecione as vendas para pagar").props.disabled, true);
  const futureTab = elements(tree, (node) => node.type === "button" && textOf(node).includes("Repasses futuros"))[0];
  futureTab.props.onClick();
  const futureUrl = new URL(harness.routes.at(-1), "https://local.test");
  assert.equal(futureUrl.searchParams.get("lote"), "lot-7");
  assert.equal(futureUrl.searchParams.get("aba"), "futuro");
});

await test("Filtro standalone preserva Todos/aba e CONSULTAS permanece sem ações, Fiado ou lucro do filho", async () => {
  const filter = clientHarness("components/transfers/transfer-filters.tsx", { ...boardProps, initialTab: "pagos" });
  let tree = filter.render();
  elements(tree, (node) => node.type === "select")[0].props.onChange({ target: { value: "todos" } });
  const url = new URL(filter.routes[0], "https://local.test");
  assert.equal(url.searchParams.get("lote"), "todos");
  assert.equal(url.searchParams.get("aba"), "pagos");
  assert.equal(url.searchParams.get("cliente"), "Pessoa");
  assert.equal(url.searchParams.has("pagina"), false);
  const readonly = clientHarness("components/transfers/transfer-board.tsx", { ...boardProps, consultas: true, canWrite: true, dueNow: [sale("credit", { is_credit: true })] });
  tree = readonly.render();
  assert.equal(elements(tree, (node) => node.type?.name === "Checkbox" || node.type?.name === "Button" || node.type === "dialog").length, 0);
  assert.match(textOf(tree), /A receber agora/);
  assert.match(textOf(tree), /A receber futuramente/);
  assert.doesNotMatch(textOf(tree), /Fiado|lucro do filho|Pagar selecionados/i);
  const link = elements(tree, (node) => node.type?.name === "Link")[0];
  const returnUrl = new URL(new URL(link.props.href, "https://local.test").searchParams.get("voltar"), "https://local.test");
  assert.equal(returnUrl.searchParams.get("lote"), "lot-8");
  assert.equal(returnUrl.searchParams.get("aba"), "agora");
  assert.equal(returnUrl.searchParams.get("cliente"), "Pessoa");
  for (const [initialTab, expected] of [["agora", /Nenhum repasse a enviar para este lote/], ["futuro", /Nenhum repasse futuro para este lote/], ["pagos", /Nenhum repasse pago encontrado para este lote/]]) {
    const empty = clientHarness("components/transfers/transfer-board.tsx", { ...boardProps, dueNow: [], future: [], paid: [], initialTab }).render();
    assert.match(elements(empty, (node) => node.type?.name === "EmptyState")[0].props.title, expected);
    assert.ok(elements(empty, (node) => node.type?.name === "StatCard").every((node) => node.props.value === 0));
  }
});

const db = new PGlite();
const admin = "90000000-0000-4000-8000-000000000001";
const viewer = "90000000-0000-4000-8000-000000000002";
const customerType = "30000000-0000-4000-8000-000000000001";
const received = "40000000-0000-4000-8000-000000000001";
const pending = "40000000-0000-4000-8000-000000000002";
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
async function one(sql, args = []) {
  const result = await rows(sql, args);
  assert.equal(result.length, 1);
  return result[0];
}
async function rpc(name, args = [], user = admin) {
  assert.match(name, /^[a-z_]+$/);
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    return (await tx.query(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as value`, args)).rows[0].value;
  });
}
async function mixedSale(extra = {}) {
  const products = [randomUUID(), randomUUID()];
  const variants = [randomUUID(), randomUUID()];
  const batchIds = [];
  for (let index = 0; index < 2; index++) {
    await db.query("insert into public.products(id,name,cost_price) values ($1,$2,100)", [products[index], `Pod ${index}`]);
    await db.query("insert into public.product_variants(id,product_id,name,is_ice) values ($1,$2,'Uva',true)", [variants[index], products[index]]);
    await db.query("insert into public.price_rules(product_id,customer_type_id,sale_price,father_transfer) values ($1,$2,150,$3)", [products[index], customerType, index === 0 ? 125 : 115]);
    batchIds.push(await rpc("create_purchase", [{ purchase_date: `2026-10-0${index + 1}`, items: [{ variant_id: variants[index], quantity: 10, unit_cost: 100 }] }]));
  }
  const id = await rpc("create_sale", [{ sale_date: "2026-10-10", customer_name: "Cliente descritivo preservado", customer_type_id: customerType, payment_status_id: received, is_credit: false,
    items: variants.map((variant) => ({ variant_id: variant, quantity: 1 })), ...extra }]);
  return { id, products, variants, batchIds };
}
async function operationState() {
  return {
    sales: await rows("select * from public.sales order by id"),
    items: await rows("select * from public.sale_items order by id"),
    allocations: await rows("select * from public.sale_item_batch_allocations order by id"),
    transfers: await rows("select * from public.transfers order by id"),
    audits: await rows("select * from public.audit_logs order by id"),
    batches: await rows("select * from public.purchase_batches order by id"),
    stock: await rows("select * from public.stock_movements order by id"),
  };
}

try {
  await db.exec(`
    create role authenticated; create role anon; create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  const migrationDirectory = path.join(root, "supabase/migrations");
  for (const name of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(path.join(migrationDirectory, name), "utf8").replace(/^create extension if not exists pgcrypto;\s*$/gim, ""));
  }
  await db.query("insert into auth.users(id,email) values ($1,'admin@local.test'),($2,'viewer@local.test')", [admin, viewer]);

  await test("Prévia real mostra valor integral e parcelas R$ 125/R$ 115 sem gravar; ignora preços atuais", async () => {
    const fixture = await mixedSale();
    await db.query("update public.price_rules set sale_price=900,father_transfer=800 where product_id=any($1::uuid[])", [fixture.products]);
    const before = await operationState();
    const preview = await rpc("preview_transfers", [[fixture.id], fixture.batchIds[1]]);
    assert.equal(preview.total, "240.00");
    assert.equal(preview.batchValue, fixture.batchIds[1]);
    assert.deepEqual(preview.saleIds, [fixture.id]);
    assert.equal(preview.sales[0].customerName, "Cliente descritivo preservado");
    assert.equal(preview.sales[0].total, "240.00");
    assert.deepEqual(preview.sales[0].portions.map((portion) => [portion.batchId, portion.amount]), [[fixture.batchIds[0], "125.00"], [fixture.batchIds[1], "115.00"]]);
    assert.deepEqual(await operationState(), before);
    assert.equal((await rpc("preview_transfers", [[fixture.id], null])).total, "240.00");
  });

  await test("RPC bloqueia IDs ocultos, repetidos, desconhecidos, futuros, cancelados e perfil CONSULTAS sem efeitos", async () => {
    const fixture = await mixedSale();
    const other = await mixedSale();
    const future = await mixedSale({ payment_status_id: pending });
    const cancelled = await mixedSale();
    await rpc("cancel_sale", [cancelled.id, "Regressão"]);
    const before = await operationState();
    for (const args of [
      [[fixture.id, fixture.id], null], [[randomUUID()], null], [[fixture.id], randomUUID()],
      [[other.id], fixture.batchIds[0]], [[future.id], null], [[cancelled.id], null], [[], null], [null, null],
    ]) await assert.rejects(() => rpc("preview_transfers", args));
    await assert.rejects(() => rpc("preview_transfers", [[fixture.id], null], viewer), /permiss/i);
    const preview = await rpc("preview_transfers", [[fixture.id], fixture.batchIds[0]]);
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", preview], viewer), /permiss/i);
    await assert.rejects(() => rpc("confirm_transfers", [[fixture.id], "Bypass"]), /permission|permiss/i);
    assert.deepEqual(await operationState(), before);
  });

  await test("Confirmação exige a prévia exata, registra R$ 240 integralmente uma vez e rejeita reenvio", async () => {
    const fixture = await mixedSale();
    const preview = await rpc("preview_transfers", [[fixture.id], fixture.batchIds[1]]);
    const before = await operationState();
    const forged = { ...preview, total: "115.00" };
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", forged]), /mudaram|confira/i);
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", null]), /confira/i);
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id, fixture.id], "", preview]), /repet/i);
    assert.deepEqual(await operationState(), before);
    const transfer = await rpc("confirm_transfers_preview", [[fixture.id], "Conferido integralmente", preview]);
    assert.equal(Number((await one("select total_amount from public.transfers where id=$1", [transfer])).total_amount), 240);
    const paidSale = await one("select transfer_paid,transfer_id from public.sales where id=$1", [fixture.id]);
    assert.equal(paidSale.transfer_paid, true);
    assert.equal(paidSale.transfer_id, transfer);
    const paidState = await operationState();
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", preview]), /atualize|agora/i);
    assert.deepEqual(await operationState(), paidState);
  });

  await test("Revalidação rejeita alteração de valor, nome histórico ou vínculo mesmo quando o total não muda", async () => {
    const fixture = await mixedSale();
    const original = await rpc("preview_transfers", [[fixture.id], null]);
    const saleItem = await one("select id from public.sale_items where sale_id=$1 and unit_transfer=125", [fixture.id]);
    await db.query("update public.sale_items set unit_transfer=126 where id=$1", [saleItem.id]);
    await db.query("update public.sale_item_batch_allocations set unit_transfer=126 where sale_item_id=$1", [saleItem.id]);
    let state = await operationState();
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", original]), /mudaram/i);
    assert.deepEqual(await operationState(), state);
    const updated = await rpc("preview_transfers", [[fixture.id], null]);
    await db.query("update public.sales set customer_name='Nome corrigido' where id=$1", [fixture.id]);
    state = await operationState();
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", updated]), /mudaram/i);
    assert.deepEqual(await operationState(), state);
    const renamed = await rpc("preview_transfers", [[fixture.id], null]);
    await db.query("update public.sale_item_batch_allocations set reversed_at=now() where sale_item_id=$1", [saleItem.id]);
    state = await operationState();
    await assert.rejects(() => rpc("confirm_transfers_preview", [[fixture.id], "", renamed]), /mudaram/i);
    assert.deepEqual(await operationState(), state);
  });

  await test("Histórico sem lote aparece na prévia consolidada; inconsistência histórica bloqueia pagamento", async () => {
    const fixture = await mixedSale();
    await db.query("delete from public.sale_item_batch_allocations where sale_item_id in (select id from public.sale_items where sale_id=$1)", [fixture.id]);
    const preview = await rpc("preview_transfers", [[fixture.id], null]);
    assert.equal(preview.total, "240.00");
    assert.deepEqual(preview.sales[0].portions, [{ batchId: null, label: "Sem lote (histórico)", amount: "240.00" }]);
    await assert.rejects(() => rpc("preview_transfers", [[fixture.id], fixture.batchIds[0]]), /fora do lote/i);
    const corrupt = await mixedSale();
    await db.query("update public.sale_item_batch_allocations set unit_transfer=1 where sale_item_id in (select id from public.sale_items where sale_id=$1)", [corrupt.id]);
    const state = await operationState();
    await assert.rejects(() => rpc("preview_transfers", [[corrupt.id], null]), /inconsisten|históric/i);
    assert.deepEqual(await operationState(), state);
  });

  await test("Seleção em grupo soma duas vendas do lote uma vez e registra uma única transferência integral", async () => {
    const fixture = await mixedSale();
    const second = await rpc("create_sale", [{ sale_date: "2026-10-11", customer_name: "Segundo cliente", customer_type_id: customerType, payment_status_id: received, is_credit: false,
      items: fixture.variants.map((variant) => ({ variant_id: variant, quantity: 1 })) }]);
    const ids = [fixture.id, second].sort();
    const preview = await rpc("preview_transfers", [[...ids].reverse(), fixture.batchIds[1]]);
    assert.deepEqual(preview.saleIds, ids);
    assert.equal(preview.sales.length, 2);
    assert.equal(preview.total, "480.00");
    assert.ok(preview.sales.every((sale) => sale.total === "240.00" && sale.portions.length === 2));
    const transferCount = (await one("select count(*)::int as n from public.transfers")).n;
    const transfer = await rpc("confirm_transfers_preview", [ids, "Grupo conferido", preview]);
    assert.equal((await one("select count(*)::int as n from public.transfers")).n, transferCount + 1);
    assert.equal(Number((await one("select total_amount from public.transfers where id=$1", [transfer])).total_amount), 480);
    assert.ok((await rows("select transfer_paid,transfer_id from public.sales where id=any($1::uuid[])", [ids])).every((sale) => sale.transfer_paid && sale.transfer_id === transfer));
  });

  await test("Venda com parcela vinculada e residual histórico mostra ambos antes de confirmar", async () => {
    const fixture = await mixedSale();
    await db.query("delete from public.sale_item_batch_allocations where sale_item_id in (select id from public.sale_items where sale_id=$1 and unit_transfer=125)", [fixture.id]);
    const preview = await rpc("preview_transfers", [[fixture.id], fixture.batchIds[1]]);
    assert.equal(preview.total, "240.00");
    assert.deepEqual(preview.sales[0].portions.map((portion) => [portion.batchId, portion.amount]), [[fixture.batchIds[1], "115.00"], [null, "125.00"]]);
    const transfer = await rpc("confirm_transfers_preview", [[fixture.id], "Legado conferido", preview]);
    assert.equal(Number((await one("select total_amount from public.transfers where id=$1", [transfer])).total_amount), 240);
  });

  await test("Ações reais validam permissão, IDs e prévia antes do RPC; confirmação atualiza os dados", async () => {
    const fixture = await mixedSale();
    const calls = [];
    let revalidated = 0;
    let session = { status: "ok", profile: { role_code: "ADMIN", can_write: true } };
    const client = {
      async rpc(name, input) {
        calls.push({ name, input });
        const args = name === "preview_transfers" ? [input.p_sale_ids, input.p_batch_id] : [input.p_sale_ids, input.p_notes, input.p_expected_preview];
        try { return { data: await rpc(name, args), error: null }; }
        catch (error) { return { data: null, error: { message: error.message } }; }
      },
    };
    const actions = loadActual("lib/actions/sales.ts", {
      "@/lib/auth": { getSessionState: async () => session },
      "@/lib/supabase/server": { createClient: async () => client },
      "@/lib/errors": { dbErrorMessage: (error) => error.message },
      "@/lib/revalidate": { revalidateCommerce: () => revalidated++ },
    });
    for (const ids of [[], ["invalid"], [fixture.id, fixture.id], Array.from({ length: 1001 }, () => randomUUID())]) {
      assert.equal((await actions.previewTransfersAction(ids, "todos")).ok, false);
    }
    assert.equal((await actions.previewTransfersAction([fixture.id], "invalid")).ok, false);
    assert.equal((await actions.confirmTransfersAction([fixture.id], "")).ok, false);
    assert.equal(calls.length, 0);
    session = { status: "ok", profile: { role_code: "CONSULTAS", can_write: false } };
    assert.equal((await actions.previewTransfersAction([fixture.id], "todos")).ok, false);
    assert.equal((await actions.confirmTransfersAction([fixture.id], "")).ok, false);
    assert.equal(calls.length, 0);
    session = { status: "ok", profile: { role_code: "ADMIN", can_write: true } };
    const preview = await actions.previewTransfersAction([fixture.id], fixture.batchIds[1]);
    assert.equal(preview.ok, true, preview.message);
    assert.equal(preview.preview.total, "240.00");
    assert.equal(revalidated, 0, "consultar ou trocar lote não grava nem invalida dados");
    assert.equal((await actions.confirmTransfersAction([randomUUID()], "", preview.preview)).ok, false);
    assert.equal(calls.length, 1, "não inclui ID invisível que não pertence à prévia");
    const confirmed = await actions.confirmTransfersAction([fixture.id], "  Conferência  ", preview.preview);
    assert.equal(confirmed.ok, true, confirmed.message);
    assert.equal(calls.at(-1).name, "confirm_transfers_preview");
    assert.equal(calls.at(-1).input.p_notes, "Conferência");
    assert.equal(revalidated, 1);
  });
} finally {
  await db.close();
}

console.log(`check-transfer-filters: ok (${checks} grupos; páginas/componentes/loaders reais e PostgreSQL descartável)`);
console.log("Limite: PGlite usa uma conexão; as revalidações cobrem as duas ordens de operação, sem simular sessões concorrentes.");
