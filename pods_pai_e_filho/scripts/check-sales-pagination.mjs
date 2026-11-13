// Execute os carregadores e componentes reais com dados descartáveis em memória.
// Sem credenciais, rede ou acesso ao Supabase.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
let checks = 0;
async function test(name, operation) {
  await operation();
  console.log(`OK ${++checks}: ${name}`);
}
function loadTs(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const compiledModule = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  }).outputText;
  vm.runInNewContext(source, {
    module: compiledModule, exports: compiledModule.exports, URLSearchParams,
    require(name) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Dependência não simulada: ${name}`);
    },
  }, { filename });
  return compiledModule.exports;
}
function elements(node, result = []) {
  if (Array.isArray(node)) node.forEach((item) => elements(item, result));
  else if (node && typeof node === "object" && node.props) {
    result.push(node);
    elements(node.props.children, result);
  }
  return result;
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && node.props) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function marker(name) { return { [name]: function () {} }[name]; }

const flavors = loadTs("lib/domain/flavors.ts");
const roles = loadTs("lib/domain/roles.ts");
function sale(index, extra = {}) {
  return {
    id: `sale-${String(index).padStart(5, "0")}`, sale_date: "2026-10-07", created_at: "2026-10-07T12:00:00Z",
    customer_id: index % 2 ? "alice" : "joao", customer_name: index % 2 ? "Alice" : "João & Filhos",
    customer_type_id: index % 2 ? "normal" : "amigo", customer_type_name: index % 2 ? "Normal" : "Amigo",
    payment_status_id: index % 3 ? "paid" : "pending", payment_status_code: index % 3 ? "RECEBIDO" : "A_RECEBER",
    payment_status_name: index % 3 ? "Recebido" : "A receber", counts_as_received: index % 3 !== 0,
    counts_as_receivable: index % 3 === 0, is_terminal: false, is_valid: true,
    is_credit: index % 2 === 0, transfer_paid: false, transfer_due_now: index % 3 !== 0, transfer_is_future: index % 3 === 0,
    product_id: index % 2 ? "pod-40" : "pod-30", product_name: index % 2 ? "Pod 40k" : "Pod 30k",
    variant_id: "grape", variant_name: "Grape", variant_is_ice: index % 2 === 0,
    quantity: 1, total_amount: "150.00", transfer_amount: "125.00", profit_amount: "25.00",
    ...extra,
  };
}
function item(row, index = 0, extra = {}) {
  return {
    id: `item-${row.id}-${index}`, sale_id: row.id, product_id: row.product_id,
    variant_id: row.variant_id, quantity: 1, cost_price_unit: "90.00", line_cost: "90.00", line_father_profit: "35.00", ...extra,
  };
}
function splitExpression(value) {
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++;
    if (value[index] === ")") depth--;
    if (value[index] === "," && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts;
}
function ilike(actual, pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "iu").test(String(actual ?? ""));
}
function matchesExpression(row, expression) {
  if (expression.startsWith("and(")) return splitExpression(expression.slice(4, -1)).every((part) => matchesExpression(row, part));
  const [column, operation, ...parts] = expression.split(".");
  const value = parts.join(".");
  if (operation === "ilike") return ilike(row[column], value);
  if (operation === "eq") return String(row[column]) === value;
  throw new Error(`Expressão não simulada: ${expression}`);
}
function harness(fixtures, { caps = {}, fail = () => false } = {}) {
  const requests = [];
  const immutable = plain(fixtures);
  const client = {
    from(table) {
      const request = { table, operations: [], filters: [], orders: [], offset: 0, end: Infinity, columns: "*", count: false, head: false, executed: false };
      requests.push(request);
      const builder = {
        select(columns, options) { request.columns = columns; request.count = options?.count === "exact"; request.head = options?.head === true; request.operations.push(["select", columns, options]); return this; },
        eq(column, value) { request.filters.push((row) => row[column] === value); request.operations.push(["eq", column, value]); return this; },
        in(column, values) { request.filters.push((row) => values.includes(row[column])); request.operations.push(["in", column, [...values]]); return this; },
        is(column, value) { request.filters.push((row) => row[column] === value); request.operations.push(["is", column, value]); return this; },
        gte(column, value) { request.filters.push((row) => row[column] >= value); request.operations.push(["gte", column, value]); return this; },
        lte(column, value) { request.filters.push((row) => row[column] <= value); request.operations.push(["lte", column, value]); return this; },
        ilike(column, value) { request.filters.push((row) => ilike(row[column], value)); request.operations.push(["ilike", column, value]); return this; },
        or(expression) { request.filters.push((row) => splitExpression(expression).some((part) => matchesExpression(row, part))); request.operations.push(["or", expression]); return this; },
        order(column, options = {}) { request.orders.push([column, options.ascending !== false]); request.operations.push(["order", column, options]); return this; },
        limit(limit) { request.end = request.offset + limit; request.operations.push(["limit", limit]); return this; },
        range(from, to) { request.offset = from; request.end = to + 1; request.operations.push(["range", from, to]); return this; },
        then(resolve, reject) {
          request.executed = true;
          if (fail(request)) return Promise.resolve({ data: null, error: { message: "Falha simulada na consulta." }, count: null }).then(resolve, reject);
          const rows = (fixtures[table] ?? []).filter((row) => request.filters.every((filter) => filter(row)));
          rows.sort((left, right) => {
            for (const [column, ascending] of request.orders) {
              const comparison = String(left[column] ?? "").localeCompare(String(right[column] ?? ""));
              if (comparison) return ascending ? comparison : -comparison;
            }
            return 0;
          });
          const count = request.count ? rows.length : null;
          // PostgREST refuses a counted range starting beyond the filtered rows.
          // The separate HEAD count must not inherit that invalid range.
          if (request.count && !request.head && request.offset > rows.length) {
            return Promise.resolve({ data: null, error: { code: "PGRST103", message: "Requested range not satisfiable", details: `An offset of ${request.offset} was requested, but there are only ${rows.length} rows.` }, count: null }).then(resolve, reject);
          }
          const selected = rows.slice(request.offset, Math.min(request.end, request.offset + (caps[table] ?? Infinity)));
          const data = selected.map((row) => request.columns === "*" ? { ...row } : Object.fromEntries(request.columns.split(",").map((column) => [column.trim(), row[column.trim()]])));
          request.returned = data.length;
          return Promise.resolve({ data: request.head ? null : data, error: null, count }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const data = loadTs("lib/data/sales.ts", { "@/lib/supabase/server": { createClient: async () => client }, "@/lib/domain/flavors": flavors });
  return { ...data, requests, assertUnchanged: () => assert.deepEqual(plain(fixtures), immutable, "consultas preservam integralmente os dados fornecidos") };
}

await test("histórico com mais de 200 vendas e limite de resposta menor que 50 percorre todas as páginas sem perdas", async () => {
  const rows = Array.from({ length: 251 }, (_, index) => sale(index));
  const data = harness({ sales_overview: rows }, { caps: { sales_overview: 20 } });
  const ids = [];
  for (let page = 0; page < 6; page++) {
    const result = await data.listSales({ offset: page * 50, limit: 50, includeCount: true, includeCosts: false });
    assert.equal(result.ok, true);
    assert.equal(result.totalCount, 251);
    assert.equal(result.sales.length, page === 5 ? 1 : 50);
    ids.push(...result.sales.map((row) => row.id));
  }
  assert.deepEqual(ids, rows.map((row) => row.id).sort().reverse(), "id desempata vendas com datas e horários iguais");
  assert.equal(new Set(ids).size, 251);
  assert.deepEqual(data.requests[0].orders, [["sale_date", false], ["created_at", false], ["id", false]]);
  data.assertUnchanged();
});

await test("contagem usa todos os filtros antes do intervalo e preserva o limite padrão existente", async () => {
  const rows = Array.from({ length: 251 }, (_, index) => sale(index));
  const data = harness({ sales_overview: rows });
  const filtered = await data.listSales({ from: "2026-10-01", to: "2026-10-31", customer: "João &", customerTypeId: "amigo", productId: "pod-30", paymentStatusId: "pending", credit: "sim", ice: "sim", flavor: "Grape Ice", offset: 2, limit: 3, includeCount: true, includeCosts: false });
  const expected = rows.filter((row) => row.customer_type_id === "amigo" && row.payment_status_id === "pending");
  assert.equal(filtered.ok, true);
  assert.equal(filtered.totalCount, expected.length);
  assert.deepEqual(plain(filtered.sales.map((row) => row.id)), expected.map((row) => row.id).sort().reverse().slice(2, 5));
  const legacy = await data.listSales({ includeCosts: false });
  assert.equal(legacy.sales.length, 200);
  assert.equal(legacy.totalCount, null);
  assert.equal(data.requests.at(-1).count, false, "contagem exata é opt-in");
  data.assertUnchanged();
});

await test("CONSULTAS mantém a seleção segura e ignora filtros de fiado", async () => {
  const rows = Array.from({ length: 11 }, (_, index) => sale(index));
  const data = harness({ sales_overview: rows });
  const result = await data.listSales({ consultas: true, credit: "sim", openCredit: true, includeCount: true, includeCosts: false, offset: 0, limit: 50 });
  assert.equal(result.totalCount, 11);
  assert.equal(result.sales.length, 11);
  assert.equal(data.requests[0].columns.split(",").includes("is_credit"), false);
  assert.equal(data.requests[0].operations.some((operation) => operation[1] === "is_credit"), false);
  assert.ok(result.sales.every((row) => !Object.hasOwn(row, "is_credit")));
  data.assertUnchanged();
});

await test("canceladas continuam disponíveis e separadas das vendas válidas", async () => {
  const data = harness({ sales_overview: [sale(1), sale(2, { is_valid: false, cancelled_at: "2026-10-08T12:00:00Z" })] });
  for (const [situation, count, valid] of [[undefined, 1, true], ["canceladas", 1, false], ["todas", 2, undefined]]) {
    const result = await data.listSales({ situation, includeCount: true, includeCosts: false, offset: 0, limit: 50 });
    assert.equal(result.totalCount, count);
    assert.equal(result.sales.length, count);
    if (valid !== undefined) assert.ok(result.sales.every((row) => row.is_valid === valid));
  }
  data.assertUnchanged();
});

await test("lote percorre mais de mil vínculos e respeita resposta da API menor que a página solicitada", async () => {
  const rows = Array.from({ length: 1105 }, (_, index) => sale(index));
  const fixtures = {
    sales_overview: rows,
    batch_items: rows.map((row, index) => ({ id: `batch-item-${String(index).padStart(5, "0")}`, batch_id: "large-batch" })),
    sale_items: rows.map((row) => item(row)),
    sale_item_batch_allocations: rows.flatMap((row, index) => [
      { id: `allocation-${String(index).padStart(5, "0")}`, batch_item_id: `batch-item-${String(index).padStart(5, "0")}`, sale_item_id: item(row).id, reversed_at: index === 0 ? "2026-11-01T12:00:00Z" : null },
      ...(index === 0 ? [{ id: "allocation-duplicate", batch_item_id: "batch-item-00000", sale_item_id: item(row).id, reversed_at: null }] : []),
    ]),
  };
  const data = harness(fixtures, { caps: { batch_items: 17, sale_items: 17, sale_item_batch_allocations: 17 } });
  const result = await data.listSales({ batchId: "large-batch", includeCount: true, includeCosts: false, offset: 1100, limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.totalCount, 1105, "múltiplas alocações não duplicam vendas");
  assert.deepEqual(plain(result.sales.map((row) => row.id)), rows.map((row) => row.id).sort().reverse().slice(1100));
  for (const table of ["batch_items", "sale_item_batch_allocations", "sale_items"]) {
    assert.ok(data.requests.some((request) => request.table === table && request.returned === 0), `${table}: leitura segue até página vazia`);
  }
  assert.ok(data.requests.filter((request) => request.table !== "sales_overview").every((request) => request.orders.length > 0), "leituras intermediárias possuem ordenação estável");
  assert.ok(data.requests.every((request) => request.operations.filter(([operation]) => operation === "in").every(([, , ids]) => ids.length <= 100)), "grupos de IDs limitam o tamanho de todas as requisições");
  data.assertUnchanged();
});

await test("página além do resultado, lote vazio e lista de IDs vazia mantêm contagem correta", async () => {
  const data = harness({ sales_overview: [sale(1)], batch_items: [] });
  const beyond = await data.listSales({ offset: 50, limit: 50, includeCount: true });
  assert.equal(beyond.ok, true);
  assert.equal(beyond.sales.length, 0);
  assert.equal(beyond.totalCount, 1);
  assert.ok(data.requests.some((request) => request.head && request.count && request.offset === 0), "recupera contagem via HEAD após PostgREST416");
  for (const query of [{ batchId: "missing" }, { saleIds: [] }]) {
    const empty = await data.listSales({ ...query, includeCount: true });
    assert.equal(empty.ok, true);
    assert.equal(empty.sales.length, 0);
    assert.equal(empty.totalCount, 0);
  }
  data.assertUnchanged();
});

await test("falhas na venda, nos custos e em páginas intermediárias não viram resultado parcial", async () => {
  const row = sale(1);
  const fixtures = { sales_overview: [row], sale_items: [item(row)], batch_items: [{ id: "batch-item", batch_id: "batch" }], sale_item_batch_allocations: [{ id: "allocation", batch_item_id: "batch-item", sale_item_id: item(row).id }] };
  for (const table of ["sales_overview", "sale_items", "batch_items", "sale_item_batch_allocations"]) {
    const data = harness(fixtures, { fail: (request) => request.table === table });
    const result = await data.listSales({ includeCount: true, ...(table === "batch_items" || table === "sale_item_batch_allocations" ? { batchId: "batch" } : {}) });
    assert.equal(result.ok, false, table);
    assert.equal(result.totalCount, null, table);
    assert.equal(result.sales.length, 0, table);
    assert.match(result.message, /Falha simulada/);
    data.assertUnchanged();
  }
  const data = harness({ sales_overview: [row], batch_items: [{ id: "one", batch_id: "batch" }, { id: "two", batch_id: "batch" }] }, { caps: { batch_items: 1 }, fail: (request) => request.table === "batch_items" && request.offset > 0 });
  const result = await data.listSales({ batchId: "batch", includeCount: true });
  assert.equal(result.ok, false);
  assert.equal(result.sales.length, 0);
  assert.equal(result.totalCount, null);
  data.assertUnchanged();
  const headFailure = harness({ sales_overview: [row] }, { fail: (request) => request.head });
  const counted = await headFailure.listSales({ includeCount: true, offset: 50, limit: 50 });
  assert.equal(counted.ok, false, "falha na recuperação HEAD permanece um erro de consulta");
  assert.equal(counted.totalCount, null);
  assert.equal(counted.sales.length, 0);
  headFailure.assertUnchanged();
});

await test("custos históricos conhecidos e ausentes continuam com o mesmo significado", async () => {
  const rows = [sale(1), sale(2), sale(3)];
  const data = harness({ sales_overview: rows, sale_items: [item(rows[0]), item(rows[1], 0, { cost_price_unit: null, line_cost: null, line_father_profit: null })] });
  const result = await data.listSales({ includeCount: true, offset: 0, limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.totalCount, 3);
  const known = result.sales.find((row) => row.id === rows[0].id);
  assert.equal(known.cost_history_missing, false);
  assert.equal(Number(known.cost_amount), 90);
  assert.equal(Number(known.father_profit_amount), 35);
  assert.ok(result.sales.filter((row) => row.id !== known.id).every((row) => row.cost_history_missing && row.cost_amount === null));
  data.assertUnchanged();
});

await test("custos da página são completos mesmo com limite baixo de resposta na tabela de itens", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => sale(index));
  const fixtures = { sales_overview: rows, sale_items: rows.map((row) => item(row)) };
  const data = harness(fixtures, { caps: { sale_items: 2 } });
  const result = await data.listSales({ includeCount: true, offset: 0, limit: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.sales.length, 50);
  assert.ok(result.sales.every((row) => row.cost_history_missing === false && Number(row.cost_amount) === 90 && Number(row.father_profit_amount) === 35));
  assert.ok(data.requests.filter((request) => request.table === "sale_items").some((request) => request.offset >= 48));
  data.assertUnchanged();
  const failing = harness(fixtures, { caps: { sale_items: 2 }, fail: (request) => request.table === "sale_items" && request.offset > 0 });
  const failure = await failing.listSales({ includeCount: true, offset: 0, limit: 50 });
  assert.equal(failure.ok, false);
  assert.equal(failure.totalCount, null);
  assert.equal(failure.sales.length, 0, "falha na segunda página de custos não exibe apuração parcial");
  failing.assertUnchanged();
});

const history = loadTs("lib/domain/sales-history.ts");
const batchFilters = loadTs("lib/domain/batch-filters.ts");
await test("URLs normalizam parâmetros repetidos, rejeitam páginas inválidas e preservam todos os filtros", () => {
  assert.equal(history.SALES_HISTORY_PAGE_SIZE, 50);
  for (const value of [undefined, "", "0", "-1", "2.5", "abc", "Infinity", "9007199254740992", "1e3"]) assert.equal(history.parseSalesHistoryPage(value), 1, String(value));
  assert.equal(history.parseSalesHistoryPage("6"), 6);
  const raw = { de: "2026-10-01", ate: "2026-10-31", cliente: ["João & Filhos", "ignorado"], produto: "pod-30", tipo: "amigo", status: "pending", fiado: "sim", ice: "sim", sabor: "Grape Ice", situacao: "todas", lote: "large-batch", pagina: ["3", "9"], desconhecido: "removido" };
  const normalized = history.normalizeSalesHistoryParams(raw);
  assert.equal(normalized.cliente, "João & Filhos");
  assert.equal(normalized.pagina, "3");
  assert.equal(Object.hasOwn(normalized, "desconhecido"), false);
  const href = history.salesHistoryHref(normalized, 4);
  assert.ok(href.startsWith("/vendas?"));
  const params = new URLSearchParams(href.split("?")[1]);
  assert.equal(params.get("pagina"), "4");
  for (const [key, value] of Object.entries(normalized)) if (key !== "pagina" && value) assert.equal(params.get(key), value, key);
  assert.equal(new URLSearchParams(history.salesHistoryHref(normalized, 1).split("?")[1]).has("pagina"), false);
  assert.equal(history.salesHistoryHref({}, 1), "/vendas");
  assert.equal(new URLSearchParams(history.salesHistoryHref({ lote: "" }, 3).split("?")[1]).get("lote"), "todos", "seleção vazia explícita continua significando todos ao navegar");
});

const Link = marker("Link");
const PageHeading = marker("PageHeading");
const SaleListMarker = marker("SaleList");
const Notice = marker("Notice");
const commonComponents = {
  "next/link": { default: Link }, "lucide-react": {},
  "@/components/shell/page-heading": { PageHeading },
  "@/components/sales/sale-list": { SaleList: SaleListMarker },
  "@/components/feedback/notice": { Notice },
  "@/components/ui/field": { controlClass: "control" },
  "@/components/ui/button": { buttonVariants: () => "button" },
  "@/components/catalog/flavor-filters": { IceFilterSelect: marker("IceFilterSelect") },
  "@/lib/domain/roles": roles, "@/lib/domain/sales-history": history,
  "@/lib/domain/batch-filters": batchFilters,
  "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
};
function pageHarness({ result, role = "admin", batches = [], batchesResult }) {
  const queries = [];
  const { default: page } = loadTs("app/(painel)/vendas/page.tsx", {
    ...commonComponents,
    "next/navigation": { redirect: (href) => { throw Object.assign(new Error("redirect"), { href }); } },
    "@/lib/data/catalog": { loadCatalog: async () => ({ ok: true, data: { products: [], statuses: [], customerTypes: [] } }) },
    "@/lib/data/batches": { listBatches: async () => batchesResult ?? ({ ok: true, batches }) },
    "@/lib/data/sales": { listSales: async (query) => { queries.push(query); return result; } },
    "@/lib/auth": { getSessionState: async () => ({ status: "ok", profile: { role_code: role, can_write: role === "admin" } }) },
  });
  return { render: (params = {}) => page({ searchParams: Promise.resolve(params) }), queries };
}

await test("tela usa contagem total, navegação filtrada e volta à primeira ao aplicar filtros", async () => {
  const data = pageHarness({ result: { ok: true, sales: [sale(1)], totalCount: 251, message: "" } });
  const tree = await data.render({ pagina: "3", cliente: "João & Filhos", ice: "sim", lote: "todos" });
  assert.equal(data.queries[0].includeCount, true);
  assert.equal(data.queries[0].offset, 100);
  assert.equal(data.queries[0].limit, 50);
  const heading = elements(tree).find((element) => element.type === PageHeading);
  assert.match(heading.props.eyebrow, /251/);
  const saleList = elements(tree).find((element) => element.type === SaleListMarker);
  assert.equal(new URLSearchParams(saleList.props.returnPath.split("?")[1]).get("pagina"), "3");
  const forms = elements(tree).filter((element) => element.type === "form");
  assert.ok(forms.length);
  assert.ok(forms.every((form) => elements(form).every((element) => element.props.name !== "pagina")), "aplicar filtros reinicia a paginação");
  const navLinks = elements(tree).filter((element) => element.type === Link && typeof element.props.href === "string" && element.props.href.startsWith("/vendas?"));
  assert.ok(navLinks.some((element) => new URLSearchParams(element.props.href.split("?")[1]).get("pagina") === "2"));
  assert.ok(navLinks.some((element) => new URLSearchParams(element.props.href.split("?")[1]).get("pagina") === "4"));
  assert.ok(navLinks.every((element) => new URLSearchParams(element.props.href.split("?")[1]).get("cliente") === "João & Filhos"));
});

await test("tela recupera página fora do resultado e separa vazio de falha de consulta", async () => {
  const data = pageHarness({ result: { ok: true, sales: [], totalCount: 51, message: "" } });
  await assert.rejects(data.render({ pagina: "99", cliente: "Alice", lote: "todos" }), (error) => {
    const query = new URLSearchParams(error.href.split("?")[1]);
    return query.get("pagina") === "2" && query.get("cliente") === "Alice";
  });
  const empty = pageHarness({ result: { ok: true, sales: [], totalCount: 0, message: "" } });
  const tree = await empty.render({ lote: "todos" });
  assert.equal(elements(tree).some((element) => element.type === Notice), false);
  const failure = pageHarness({ result: { ok: false, sales: [], totalCount: null, message: "Falha simulada" } });
  const failedTree = await failure.render({ pagina: "2", lote: "todos" });
  assert.ok(elements(failedTree).some((element) => element.type === Notice && text(element).includes("Falha simulada")));
  assert.equal(elements(failedTree).some((element) => element.type === SaleListMarker), false);
});

await test("CONSULTAS omite filtro Fiado também na tela paginada", async () => {
  const data = pageHarness({ result: { ok: true, sales: [sale(1)], totalCount: 1, message: "" }, role: "CONSULTAS" });
  const tree = await data.render({ fiado: "sim", lote: "todos" });
  assert.equal(data.queries[0].consultas, true);
  assert.equal(data.queries[0].credit, undefined);
  assert.equal(elements(tree).some((element) => element.props.name === "fiado"), false);
  assert.equal(elements(tree).find((element) => element.type === SaleListMarker).props.consultas, true);
});

await test("contagem ausente não apresenta uma lista parcial como histórico completo", async () => {
  const data = pageHarness({ result: { ok: true, sales: [sale(1)], totalCount: null, message: "" } });
  const tree = await data.render({ pagina: "não-é-página", lote: "todos" });
  assert.equal(data.queries[0].offset, 0);
  assert.equal(elements(tree).some((element) => element.type === SaleListMarker), false);
  assert.ok(elements(tree).some((element) => element.type === Notice));
  assert.equal(elements(tree).find((element) => element.type === PageHeading).props.eyebrow, undefined);
});

function batch(id, number, status, purchaseDate, createdAt = `${purchaseDate}T12:00:00Z`) {
  return { batch_id: id, batch_number: number, status, purchase_date: purchaseDate, created_at: createdAt, is_legacy: false };
}
const selectableBatches = [
  batch("old-open", 1, "ABERTO", "2026-10-01"),
  batch("last-closed", 9, "FINALIZADO", "2026-11-10"),
  batch("cancelled-new", 12, "CANCELADO", "2026-11-12"),
  batch("latest-open", 6, "ABERTO", "2026-11-01", "2026-11-01T15:00:00Z"),
  batch("same-date-open", 5, "ABERTO", "2026-11-01", "2026-11-01T14:00:00Z"),
];
const populatedPage = { ok: true, sales: [sale(1)], totalCount: 151, message: "" };
async function canonicalRedirect(data, params) {
  let href;
  await assert.rejects(data.render(params), (error) => {
    href = error.href;
    return error.message === "redirect" && typeof href === "string";
  });
  return { href, query: new URLSearchParams(href.split("?")[1]) };
}
await test("Vendas inicia no lote aberto mais recente e fixa a escolha na URL antes da consulta", async () => {
  const immutable = plain(selectableBatches);
  for (const role of ["admin", "CONSULTAS"]) {
    const data = pageHarness({ result: populatedPage, role, batches: selectableBatches });
    const { query } = await canonicalRedirect(data, { pagina: "3", cliente: "João & Filhos", ice: "sim", sabor: "Grape Ice" });
    assert.equal(data.queries.length, 0, "não consulta vendas gerais antes de resolver o lote");
    assert.equal(query.get("lote"), "latest-open");
    assert.equal(query.get("pagina"), "3");
    assert.equal(query.get("cliente"), "João & Filhos");
    assert.equal(query.get("ice"), "sim");
    assert.equal(query.get("sabor"), "Grape Ice");
    const tree = await data.render(Object.fromEntries(query));
    assert.equal(data.queries.length, 1);
    assert.equal(data.queries[0].batchId, "latest-open");
    assert.equal(data.queries[0].offset, 100);
    const selected = elements(tree).find((element) => element.type === "select" && element.props.name === "lote");
    assert.equal(selected.props.defaultValue, "latest-open");
    assert.ok(text(selected).includes("Lote 006 — Em andamento"));
    const list = elements(tree).find((element) => element.type === SaleListMarker);
    assert.equal(new URLSearchParams(list.props.returnPath.split("?")[1]).get("lote"), "latest-open");
    assert.ok(elements(tree).some((element) => element.type === Link && element.props.href === "/vendas" && text(element).includes("Limpar filtros")), "limpar filtros volta à escolha automática");
  }
  assert.deepEqual(plain(selectableBatches), immutable, "resolver o lote não altera sua lista original");
});

await test("seleção explícita de lote, todos ou vazio é respeitada ao paginar e voltar da venda", async () => {
  for (const selection of ["old-open", "last-closed", "cancelled-new", "todos", ""]) {
    const data = pageHarness({ result: populatedPage, batches: selectableBatches });
    const tree = await data.render({ lote: selection, pagina: "2", cliente: "Alice" });
    const expected = selection === "" || selection === "todos" ? undefined : selection;
    assert.equal(data.queries[0].batchId, expected, `seleção=${selection}`);
    const selected = elements(tree).find((element) => element.type === "select" && element.props.name === "lote");
    assert.equal(selected.props.defaultValue, expected ?? "todos");
    const list = elements(tree).find((element) => element.type === SaleListMarker);
    const back = new URLSearchParams(list.props.returnPath.split("?")[1]);
    assert.equal(back.get("lote"), expected ?? "todos");
    assert.equal(back.get("pagina"), "2");
    for (const link of elements(tree).filter((element) => element.type === Link && element.props.href.startsWith("/vendas?"))) {
      const target = new URLSearchParams(link.props.href.split("?")[1]);
      assert.equal(target.get("lote"), expected ?? "todos");
      assert.equal(target.get("cliente"), "Alice");
    }
  }
});

await test("ausência de abertos usa o finalizado mais recente e ausência de elegíveis usa todos", async () => {
  const cases = [
    { batches: selectableBatches.filter((row) => row.status !== "ABERTO"), expected: "last-closed" },
    { batches: [batch("only-cancelled", 20, "CANCELADO", "2026-11-12")], expected: "todos" },
    { batches: [], expected: "todos" },
  ];
  for (const { batches, expected } of cases) {
    const data = pageHarness({ result: populatedPage, batches });
    const { query } = await canonicalRedirect(data, { cliente: "Alice" });
    assert.equal(query.get("lote"), expected);
    await data.render(Object.fromEntries(query));
    assert.equal(data.queries[0].batchId, expected === "todos" ? undefined : expected);
  }
  const invalid = pageHarness({ result: populatedPage, batches: selectableBatches });
  const { query } = await canonicalRedirect(invalid, { lote: "lote-inexistente", pagina: "2", cliente: "Alice" });
  assert.equal(query.get("lote"), "latest-open");
  assert.equal(query.get("pagina"), "2");
});

await test("falha ao carregar lotes mostra aviso sem executar consulta geral de vendas", async () => {
  for (const role of ["admin", "CONSULTAS"]) {
    const data = pageHarness({ result: populatedPage, role, batchesResult: { ok: false, batches: [], message: "Falha ao carregar lotes" } });
    const tree = await data.render({ pagina: "2", lote: "todos" });
    assert.equal(data.queries.length, 0);
    assert.ok(elements(tree).some((element) => element.type === Notice && text(element).includes("Falha ao carregar lotes")));
    assert.equal(elements(tree).some((element) => element.type === SaleListMarker), false);
  }
});

await test("links de desktop e celular retornam à mesma página e filtros", () => {
  const { SaleList } = loadTs("components/sales/sale-list.tsx", {
    "next/link": { default: Link }, "lucide-react": {},
    "@/lib/format": loadTs("lib/format.ts"),
    "@/components/ui/empty-state": { EmptyState: marker("EmptyState") },
    "@/components/sales/badges": { CreditBadge: marker("CreditBadge"), PaymentBadge: marker("PaymentBadge"), TransferBadge: marker("TransferBadge") },
  });
  const returnPath = history.salesHistoryHref({ cliente: "João & Filhos", situacao: "todas", lote: "batch" }, 5);
  const row = sale(2);
  const tree = SaleList({ sales: [row], returnPath });
  const links = elements(tree).filter((element) => element.type === Link);
  assert.equal(links.length, 3);
  for (const link of links) {
    const [pathname, query] = link.props.href.split("?");
    assert.equal(pathname, `/vendas/${row.id}`);
    assert.equal(new URLSearchParams(query).get("voltar"), returnPath);
  }
  const oldLinks = elements(SaleList({ sales: [row] })).filter((element) => element.type === Link);
  assert.ok(oldLinks.every((link) => link.props.href === `/vendas/${row.id}`), "outras telas mantêm seus links atuais");
});

console.log(`\n${checks} verificações de paginação concluídas sem alterar dados salvos.`);
