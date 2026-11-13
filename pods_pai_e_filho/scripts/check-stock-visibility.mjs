import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
function loadTs(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const compiledModule = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  }).outputText;
  vm.runInNewContext(source, {
    module: compiledModule, exports: compiledModule.exports,
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
const products = [
  { id: "inactive-positive", name: "Antigo com saldo", active: false },
  { id: "inactive-zero", name: "Antigo vazio", active: false },
  { id: "active-positive", name: "Pod ativo", active: true },
  { id: "active-zero", name: "Pod esgotado", active: true },
  { id: "active-no-variants", name: "Pod sem sabores", active: true },
  { id: "active-all-inactive", name: "Pod só inativos", active: true },
].map((product) => ({ ...product, brand: "", model: "", approximate_puffs: null, cost_price: "10.00" }));
const balances = [
  { product_id: "inactive-positive", variant_id: "hidden-grape", variant_name: "Forbidden", variant_is_ice: true, quantity: 3 },
  { product_id: "inactive-zero", variant_id: "hidden-zero", variant_name: "Hidden", variant_is_ice: false, quantity: 0 },
  { product_id: "active-positive", variant_id: "grape", variant_name: "Grape", variant_is_ice: true, quantity: 1 },
  { product_id: "active-positive", variant_id: "strawberry", variant_name: "Strawberry", variant_is_ice: false, quantity: 4 },
  { product_id: "active-zero", variant_id: "zero", variant_name: "Mint", variant_is_ice: false, quantity: 0 },
  { product_id: "active-positive", variant_id: "off-berry", variant_name: "Offberry", variant_is_ice: false, quantity: 3, variant_active: false },
  { product_id: "active-zero", variant_id: "off-zero", variant_name: "Offzero", variant_is_ice: true, quantity: 0, variant_active: false },
  { product_id: "active-all-inactive", variant_id: "off-only", variant_name: "Onlyoff", variant_is_ice: false, quantity: 2, variant_active: false },
].map((balance) => ({ variant_active: true, ...balance }));
const fixtures = {
  products,
  product_variants: balances.map((balance) => ({ id: balance.variant_id, product_id: balance.product_id, active: balance.variant_active })),
  stock_movement_history: [
    ...Array.from({ length: 12 }, (_, index) => ({ id: `hidden-${index}`, product_id: "inactive-positive", product_name: "Antigo com saldo", variant_name: "Forbidden Ice", direction: 1, quantity: 3 })),
    { id: "visible", product_id: "active-positive", product_name: "Pod ativo", variant_name: "Grape Ice", direction: 1, quantity: 1 },
  ],
  sale_items: [{ product_id: "inactive-positive", variant_id: "hidden-grape", line_cost: "10.00", line_total: "150.00" }],
  stock_movements: [{ id: "immutable", product_id: "inactive-positive", variant_id: "hidden-grape", quantity: 3 }],
  batch_item_overview: [{ batch_item_id: "batch-item", product_id: "inactive-positive", variant_id: "hidden-grape", quantity_remaining: 3 }],
};
const immutable = plain({ balances, sales: fixtures.sale_items, movements: fixtures.stock_movements, batches: fixtures.batch_item_overview });
const requests = [];
let stockCap = Infinity;
const client = {
  from(table) {
    const filters = [];
    const trace = { table, operations: [] };
    requests.push(trace);
    let limit = Infinity;
    let single = false;
    let payload;
    return {
      select() { trace.operations.push(["select"]); return this; },
      eq(column, value) { filters.push((row) => row[column] === value); trace.operations.push(["eq", column, value]); return this; },
      in(column, values) { filters.push((row) => values.includes(row[column])); trace.operations.push(["in", column, [...values]]); return this; },
      order(column) { trace.operations.push(["order", column]); return this; },
      limit(value) { limit = value; trace.operations.push(["limit", value]); return this; },
      single() { single = true; return this; },
      update(value) { payload = value; trace.operations.push(["update", value]); return this; },
      then(resolve, reject) {
        let rows = table === "stock_balances" ? balances.map((balance) => {
          const product = products.find((item) => item.id === balance.product_id);
          return { ...balance, product_name: product.name, product_active: product.active };
        }) : fixtures[table] ?? [];
        rows = rows.filter((row) => filters.every((filter) => filter(row)));
        if (payload) rows.forEach((row) => Object.assign(row, payload));
        rows = rows.slice(0, Math.min(limit, table === "stock_balances" ? stockCap : Infinity));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(resolve, reject);
      },
    };
  },
};
const { loadCatalog } = loadTs("lib/data/catalog.ts", {
  "@/lib/supabase/server": { createClient: async () => client },
  "@/lib/errors": { isMissingSchema: () => false },
});
const flavors = loadTs("lib/domain/flavors.ts");
const stockDomain = loadTs("lib/domain/stock.ts");
const format = loadTs("lib/format.ts");
let role = "admin";
const auth = { getSessionState: async () => ({ status: "ok", profile: { can_write: role === "admin", role_code: role } }) };
function marker(name) { return { [name]: function () {} }[name]; }
const PageHeading = marker("PageHeading");
const Panel = marker("Panel");
const StockEntryForm = marker("StockEntryForm");
const StockBadge = marker("StockBadge");
const { default: stockPage } = loadTs("app/(painel)/estoque/page.tsx", {
  "next/link": { default: marker("Link") }, "lucide-react": {},
  "@/lib/auth": auth,
  "@/lib/data/catalog": { loadCatalog, loadLowStockThreshold: async () => 3 },
  "@/lib/supabase/server": { createClient: async () => client },
  "@/lib/domain/stock": stockDomain, "@/lib/domain/flavors": flavors,
  "@/lib/format": format, "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
  "@/lib/domain/roles": loadTs("lib/domain/roles.ts"),
  "@/components/feedback/notice": { Notice: marker("Notice") },
  "@/components/shell/page-heading": { PageHeading },
  "@/components/stock/stock-entry-form": { StockEntryForm },
  "@/components/stock/whatsapp-promotion": { WhatsAppPromotion: marker("WhatsAppPromotion") },
  "@/components/sales/badges": { StockBadge, IceBadge: marker("IceBadge"), VariantAvailabilityBadge: marker("VariantAvailabilityBadge") },
  "@/components/catalog/flavor-filters": { IceFilterSelect: marker("IceFilterSelect") },
  "@/components/ui/panel": { Panel }, "@/components/ui/badge": { Badge: marker("Badge") },
  "@/components/ui/field": { controlClass: "control" }, "@/components/ui/button": { buttonVariants: () => "button" },
});
const render = (params = {}) => stockPage({ searchParams: Promise.resolve(params) });
const productPanels = (tree) => elements(tree).filter((element) => element.type === Panel && element.props.title !== "Movimentações recentes");
const productNames = (tree) => productPanels(tree).map((panel) => panel.props.title);
const stockBadges = (tree) => productPanels(tree).flatMap((panel) => elements(panel.props.action)).filter((element) => element.type === StockBadge);

let tree = await render();
assert.deepEqual(productNames(tree), ["Pod ativo", "Pod esgotado", "Pod sem sabores", "Pod só inativos"]);
assert.equal(text(tree).includes("Forbidden"), false, "produto inativo e seus sabores não aparecem");
for (const hidden of ["Offberry", "Offzero", "Onlyoff"]) assert.equal(text(tree).includes(hidden), false, `sabor inativo ${hidden} não aparece`);
assert.equal(text(tree).includes("Mint"), true, "sabor ativo sem estoque mantém o comportamento atual");
assert.equal(elements(tree).find((element) => element.type === PageHeading).props.eyebrow, "4 produto(s) · 5 unidades exibidas");
assert.deepEqual(stockBadges(tree).map((element) => element.props.quantity), [5, 0, 0, 0], "alerta usa soma do produto");
const allInactivePanel = productPanels(tree).find((panel) => panel.props.title === "Pod só inativos");
assert.ok(text(allInactivePanel.props.children).includes("Nenhum sabor ativo disponível"));
assert.ok(text(productPanels(tree).find((panel) => panel.props.title === "Pod sem sabores").props.children).includes("Nenhuma variação cadastrada."));
assert.ok(elements(tree).find((element) => element.type === StockEntryForm).props.stock.every((balance) => balance.product_active));
const movementRequest = requests.find((request) => request.table === "stock_movement_history");
assert.ok(movementRequest.operations.findIndex(([operation]) => operation === "in") < movementRequest.operations.findIndex(([operation]) => operation === "limit"), "filtra movimentos antes do limite de 12");
assert.equal(text(tree).includes("Grape Ice"), true, "movimento ativo aparece mesmo após 12 movimentos inativos");

for (const params of [{ sabor: "Forbidden Ice" }, { sabor: "Antigo com saldo" }, { sabor: "Hidden", ice: "nao" }, { sabor: "Offberry" }, { sabor: "Offzero Ice", ice: "sim" }, { sabor: "Onlyoff", ice: "nao" }, { ice: "sim", sabor: "Offzero" }]) {
  tree = await render(params);
  assert.equal(productPanels(tree).length, 0);
  assert.ok(text(tree).includes("Nenhum produto ativo encontrado para os filtros informados."));
}
tree = await render({ sabor: "Grape Ice", ice: "sim", lote: "preservado" });
assert.deepEqual(productNames(tree), ["Pod ativo"]);
assert.equal(elements(tree).find((element) => element.type === PageHeading).props.eyebrow, "1 produto(s) · 1 unidades exibidas");
assert.equal(stockBadges(tree)[0].props.quantity, 5, "busca de sabor não altera a regra do alerta por produto");
assert.ok(elements(tree).some((element) => element.type === "input" && element.props.name === "lote" && element.props.value === "preservado"));
stockCap = 1;
requests.length = 0;
const capped = await loadCatalog({ productStatus: "active", stockActiveProductsOnly: true, stockActiveVariantsOnly: true });
assert.equal(capped.data.stock[0].variant_id, "grape", "status aplicado antes do limite do servidor");
const cappedOps = requests.find((request) => request.table === "stock_balances").operations;
assert.ok(cappedOps.some(([operation, column, value]) => operation === "eq" && column === "product_active" && value === true));
assert.ok(cappedOps.some(([operation, column, value]) => operation === "eq" && column === "variant_active" && value === true), "sabor ativo filtrado na consulta");
stockCap = Infinity;
const general = await loadCatalog();
assert.equal(general.data.stock.some((balance) => !balance.product_active && balance.quantity === 3), true, "outras consultas e histórico não recebem o filtro");
assert.equal(general.data.stock.some((balance) => !balance.variant_active && balance.quantity === 3), true, "gerenciamento e demais telas continuam vendo sabores inativos");
assert.equal(general.data.variants.some((variant) => variant.id === "off-berry" && !variant.active), true, "variantes inativas continuam no gerenciamento");
assert.equal(general.data.products.length, 6);
assert.equal((await loadCatalog({ productStatus: "inactive" })).data.products.length, 2, "filtro Inativos de Produtos preservado");

const invalidatedPaths = [];
const revalidate = loadTs("lib/revalidate.ts", { "next/cache": { revalidatePath: (...args) => invalidatedPaths.push(args) } });
const { saveProductAction } = loadTs("lib/actions/catalog.ts", {
  "@/lib/auth": auth, "@/lib/supabase/server": { createClient: async () => client },
  "@/lib/errors": { dbErrorMessage: (error) => error?.message }, "@/lib/domain/flavors": flavors,
  "@/lib/format": format, "@/lib/revalidate": revalidate,
});
const statusInput = (id, active) => ({ id, name: products.find((product) => product.id === id).name, brand: "", model: "", approximatePuffs: "", costPrice: "10,00", active });
assert.equal((await saveProductAction(statusInput("active-positive", false))).ok, true);
assert.equal(productNames(await render()).includes("Pod ativo"), false);
assert.equal((await saveProductAction(statusInput("active-positive", true))).ok, true);
tree = await render({ sabor: "Grape Ice", ice: "sim" });
assert.deepEqual(productNames(tree), ["Pod ativo"]);
assert.equal(stockBadges(tree)[0].props.quantity, 5, "reativação preserva saldo e sabores");
assert.ok(invalidatedPaths.every(([pathname, type]) => pathname === "/" && type === "layout"), "invalidação inclui a tela Estoque");
assert.equal(invalidatedPaths.length, 2);
const berry = balances.find((balance) => balance.variant_id === "off-berry");
berry.variant_active = false;
tree = await render({ sabor: "Offberry" });
assert.equal(productPanels(tree).length, 0, "sabor inativo não aparece na pesquisa");
berry.variant_active = true;
tree = await render({ sabor: "Offberry" });
assert.deepEqual(productNames(tree), ["Pod ativo"], "reativar o sabor o traz de volta");
assert.equal(elements(tree).find((element) => element.type === PageHeading).props.eyebrow, "1 produto(s) · 3 unidades exibidas", "saldo preservado ao reativar");
berry.variant_active = false;
role = "CONSULTAS";
tree = await render();
assert.deepEqual(productNames(tree), ["Pod ativo", "Pod esgotado", "Pod sem sabores", "Pod só inativos"]);
assert.equal(text(tree).includes("Offberry"), false);
assert.equal(elements(tree).some((element) => element.type === StockEntryForm), false);
assert.equal((await saveProductAction(statusInput("active-positive", false))).ok, false, "CONSULTAS permanece sem escrita");
assert.equal(products.find((product) => product.id === "active-positive").active, true);

const originalStatuses = products.map((product) => product.active);
products.forEach((product) => { product.active = false; });
requests.length = 0;
tree = await render();
assert.ok(text(tree).includes("Nenhum produto ativo para exibir."));
assert.equal(productPanels(tree).length, 0);
assert.equal(requests.some((request) => request.table === "stock_movement_history"), false);
products.forEach((product, index) => { product.active = originalStatuses[index]; });
assert.deepEqual(plain({ balances, sales: fixtures.sale_items, movements: fixtures.stock_movements, batches: fixtures.batch_item_overview }), immutable, "saldos e histórico permanecem inalterados");
console.log("Estoque OK: ativos e esgotados, inativos ocultos na consulta, sabores/Ice, totais, alertas, estados vazios, cache, reativação, histórico e permissões.");
