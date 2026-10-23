import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plain = (value) => JSON.parse(JSON.stringify(value));

// Exercise the actual page/client modules while replacing I/O and React hooks.
function loadTs(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(source, {
    module: compiledModule,
    exports: compiledModule.exports,
    URLSearchParams,
    require(name) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Dependência não simulada: ${name}`);
    },
  }, { filename });
  return compiledModule.exports;
}

function elements(node, output = []) {
  if (Array.isArray(node)) node.forEach((child) => elements(child, output));
  else if (node && typeof node === "object" && node.props) {
    output.push(node);
    elements(node.props.children, output);
  }
  return output;
}

const products = [
  { id: "inactive", name: "A inativo", brand: "", model: "", active: false },
  { id: "zero", name: "B ativo sem estoque", brand: "", model: "", active: true },
  { id: "stocked", name: "C ativo com estoque", brand: "", model: "", active: true },
];
const fixtures = {
  products,
  product_variants: [
    { id: "v-inactive", product_id: "inactive", name: "Grape", is_ice: true },
    { id: "v-zero", product_id: "zero", name: "Grape", is_ice: true },
    { id: "v-stocked", product_id: "stocked", name: "Mint", is_ice: false },
  ],
  stock_balances: [
    { product_id: "zero", variant_id: "v-zero", quantity: 0 },
    { product_id: "stocked", variant_id: "v-stocked", quantity: 5 },
  ],
  sale_items: [{ product_id: "inactive", variant_id: "v-inactive" }],
};
let cap = 50;
const requests = [];
const client = {
  from(table) {
    const filters = [];
    const trace = [table];
    requests.push(trace);
    return {
      select() { trace.push("select"); return this; },
      eq(column, value) { trace.push(["eq", column, value]); filters.push([column, value]); return this; },
      order(column) { trace.push(["order", column]); return this; },
      then(resolve, reject) {
        trace.push("execute");
        let data = (fixtures[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
        if (table === "products") data = data.slice(0, cap);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
  },
};
const { loadCatalog } = loadTs("lib/data/catalog.ts", {
  "@/lib/supabase/server": { createClient: async () => client },
  "@/lib/errors": { isMissingSchema: () => false },
});
function ids(result) {
  assert.equal(result.ok, true, result.message);
  return plain(result.data.products.map((product) => product.id));
}

assert.deepEqual(ids(await loadCatalog()), ["inactive", "zero", "stocked"]);
assert.equal((await loadCatalog()).data.products.find((product) => product.id === "inactive").has_history, true);
cap = 2;
requests.length = 0;
assert.deepEqual(ids(await loadCatalog({ productStatus: "active" })), ["zero", "stocked"]);
const productTrace = requests.find((trace) => trace[0] === "products");
assert.deepEqual(plain(productTrace[2]), ["eq", "active", true]);
assert.equal(productTrace.at(-1), "execute");
assert.deepEqual(ids(await loadCatalog({ productStatus: "inactive" })), ["inactive"]);
cap = 50;
assert.deepEqual(ids(await loadCatalog({ productStatus: "all" })), ["inactive", "zero", "stocked"]);

let requestedStatus;
let role = "admin";
function ProductManagerMarker() {}
const { default: productPage } = loadTs("app/(painel)/produtos/page.tsx", {
  "@/lib/auth": { getSessionState: async () => ({ status: "ok", profile: { can_write: role === "admin", role_code: role } }) },
  "@/lib/data/catalog": { loadCatalog: async (options) => { requestedStatus = options.productStatus; return { ok: true, data: {} }; } },
  "@/components/feedback/notice": { Notice: function Notice() {} },
  "@/components/shell/page-heading": { PageHeading: function PageHeading() {} },
  "@/components/catalog/product-manager": { ProductManager: ProductManagerMarker },
});
for (const [params, expected] of [
  [{}, "active"], [{ status: "active" }, "active"], [{ status: "inactive" }, "inactive"],
  [{ status: "all" }, "all"], [{ status: ["inactive", "all"] }, "inactive"], [{ status: "invalid" }, "active"],
]) {
  const tree = await productPage({ searchParams: Promise.resolve(params) });
  const manager = elements(tree).find((element) => element.type === ProductManagerMarker);
  assert.equal(requestedStatus, expected);
  assert.equal(manager.props.productStatus, expected);
}
role = "CONSULTAS";
const readOnlyProduct = elements(await productPage({ searchParams: Promise.resolve({ status: "all" }) })).find((element) => element.type === ProductManagerMarker);
assert.equal(readOnlyProduct.props.canWrite, false);
assert.equal(readOnlyProduct.props.isAdmin, false);

const state = [];
let hookIndex = 0;
const actions = [];
let currentParams = new URLSearchParams("extra=preservado");
let pushedUrl;
let refreshes = 0;
const hooks = {
  useState(initial) {
    const index = hookIndex++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
  },
  useTransition() {
    return [false, (callback) => {
      const promise = callback();
      if (promise?.then) actions.push(promise);
    }];
  },
};
function Button() {}
function Input() {}
const { ProductManager } = loadTs("components/catalog/product-manager.tsx", {
  react: hooks,
  "next/navigation": {
    useRouter: () => ({
      push(url) { pushedUrl = url; currentParams = new URLSearchParams(url.split("?")[1]); },
      refresh() { refreshes++; },
    }),
    usePathname: () => "/produtos",
    useSearchParams: () => currentParams,
  },
  "lucide-react": {}, "@/lib/actions/catalog": {}, "@/lib/format": {},
  "@/lib/domain/flavors": loadTs("lib/domain/flavors.ts"),
  "@/components/ui/button": { Button }, "@/components/ui/input": { Input },
  "@/components/ui/field": {}, "@/components/feedback/notice": {},
  "@/components/ui/panel": {}, "@/components/ui/badge": {},
  "@/components/sales/badges": {}, "@/components/catalog/flavor-ice-field": {}, "@/lib/utils": {},
});
async function render(status) {
  const catalog = (await loadCatalog({ productStatus: status })).data;
  hookIndex = 0;
  return ProductManager({ catalog, productStatus: status, canWrite: false, isAdmin: false });
}
function cards(tree) { return elements(tree).filter((element) => element.type?.name === "ProductCard"); }
function cardIds(tree) { return plain(cards(tree).map((card) => card.props.product.id)); }
function button(tree, text, group) {
  const groupElement = elements(tree).find((element) => element.props["aria-label"] === group);
  const control = elements(groupElement).find((element) => element.type === Button && element.props.children === text);
  assert.ok(control, `Botão ausente: ${group} / ${text}`);
  return control;
}
function search(tree) { return elements(tree).find((element) => element.type === Input && element.props["aria-label"] === "Pesquisar sabor"); }

let tree = await render("active");
assert.deepEqual(cardIds(tree), ["zero", "stocked"]);
assert.equal(button(tree, "Ativos", "Filtrar produtos").props["aria-pressed"], true);
search(tree).props.onChange({ target: { value: "Grape Ice" } });
button(tree, "Ice", "Filtrar sabores Ice").props.onClick();
tree = await render("active");
assert.deepEqual(cardIds(tree), ["zero"]);
button(tree, "Inativos", "Filtrar produtos").props.onClick();
assert.equal(pushedUrl, "/produtos?extra=preservado&status=inactive");
tree = await render("inactive");
assert.deepEqual(cardIds(tree), ["inactive"]);
assert.equal(search(tree).props.value, "Grape Ice");
assert.equal(button(tree, "Ice", "Filtrar sabores Ice").props.variant, "secondary");
button(tree, "Todos", "Filtrar produtos").props.onClick();
tree = await render("all");
assert.deepEqual(cardIds(tree), ["inactive", "zero"]);
assert.equal(button(tree, "Todos", "Filtrar produtos").props["aria-pressed"], true);
search(tree).props.onChange({ target: { value: "" } });
button(tree, "Todos", "Filtrar sabores Ice").props.onClick();
tree = await render("active");
const zeroCard = cards(tree).find((card) => card.props.product.id === "zero");
zeroCard.props.onSave(async () => {
  products.find((product) => product.id === "zero").active = false;
  return { ok: true };
}, "Produto inativado.");
await Promise.all(actions);
assert.equal(refreshes, 1);
assert.deepEqual(cardIds(await render("active")), ["stocked"]);
assert.equal(cards(await render("all")).find((card) => card.props.product.id === "zero").props.product.active, false);

// Sale details preserve a safe origin URL and all existing editor/batch data.
function Heading() {}
function Editor() {}
function LinkMarker() {}
function PanelMarker() {}
const allocations = [{ batch_id: "lote-preservado" }];
const historicalSale = { id: "sale-1", customer_name: "Cliente", sale_date: "2026-10-07", product_name: "Produto histórico", variant_name: "Grape Ice", is_valid: true };
const historicalItems = [{ id: "item-historico", product_id: "historico-inativo", variant_id: "sabor-historico" }];
const batchItems = [
  { batch_id: "destino-compativel", batch_number: 7, product_id: "historico-inativo", variant_id: "sabor-historico", status: "ABERTO" },
  { batch_id: "outro-sabor", batch_number: 8, product_id: "historico-inativo", variant_id: "outro-sabor", status: "ABERTO" },
  { batch_id: "lote-finalizado", batch_number: 9, product_id: "historico-inativo", variant_id: "sabor-historico", status: "FINALIZADO" },
];
let requestedConsultas;
let catalogArguments;
const { default: salePage } = loadTs("app/(painel)/vendas/[id]/page.tsx", {
  "next/link": { default: LinkMarker },
  "next/navigation": { notFound: () => { throw new Error("notFound"); } },
  "@/lib/auth": { getSessionState: async () => ({ status: "ok", profile: { can_write: role === "admin", role_code: role } }) },
  "@/lib/data/catalog": { loadCatalog: async (...args) => { catalogArguments = args; return { ok: true, data: { products: [{ id: "historico-inativo", active: false }], batchItems } }; } },
  "@/lib/data/sales": { getSale: async (id, consultas) => { assert.equal(id, "sale-1"); requestedConsultas = consultas; return { ok: true, sale: historicalSale, items: historicalItems, batchAllocations: allocations, audit: [] }; } },
  "@/lib/format": { formatDate: (value) => value, shortId: (value) => value },
  "@/components/feedback/notice": {}, "@/components/shell/page-heading": { PageHeading: Heading },
  "@/components/sales/sale-editor": { SaleEditor: Editor },
  "@/components/ui/panel": { Panel: PanelMarker },
  "@/components/ui/button": { buttonVariants: () => "outline-button" },
  "@/lib/domain/roles": loadTs("lib/domain/roles.ts"),
});
async function detail(voltar) {
  return salePage({ params: Promise.resolve({ id: "sale-1" }), searchParams: Promise.resolve({ voltar }) });
}
function back(tree) { return elements(tree).find((element) => element.type === Heading).props.back; }
role = "admin";
for (const origin of [
  "/inicio", "/inicio?de=2026-10-01&ate=2026-10-07&lote=batch-1",
  "/relatorios?produto=p1&sabor=Grape%20Ice", "/vendas",
  "/vendas?cliente=Jo%C3%A3o&status=paid&lote=batch-1", "/inicio?filtro=https%3A%2F%2Fexterno.invalid",
]) {
  const pageTree = await detail(origin);
  assert.equal(back(pageTree).href, origin);
  const editor = elements(pageTree).find((element) => element.type === Editor);
  assert.equal(editor.props.batchAllocations, allocations);
  assert.equal(editor.props.sale, historicalSale);
  assert.equal(editor.props.catalog.products[0].active, false);
  assert.deepEqual(elements(pageTree).filter((element) => element.type === LinkMarker).map((element) => element.props.href), ["/lotes/destino-compativel/editar?venda=sale-1#vincular-venda"]);
  assert.deepEqual(catalogArguments, []);
}
for (const invalid of [
  undefined, "", "https://evil.invalid/inicio", "//evil.invalid/inicio", "javascript:alert(1)",
  "/produtos", "/inicio/outra", "/inicio#fragmento", "/inicio?filtro=x#fragmento",
  "/inicio/../relatorios", "/%69nicio", "/inicio\\evil", "/inicio?x=\\evil", "/inicio?x=\n",
]) assert.equal(back(await detail(invalid)).href, "/vendas", String(invalid));
assert.equal(back(await detail(["/relatorios?de=2026-10-01", "//evil.invalid"])).href, "/relatorios?de=2026-10-01");
assert.equal(back(await detail("/inicio")).label, "Voltar ao início");
assert.equal(back(await detail("/relatorios")).label, "Voltar aos relatórios");
role = "CONSULTAS";
const readonlyPage = await detail("/inicio");
const readonlyDetail = elements(readonlyPage).find((element) => element.type === Editor);
assert.equal(requestedConsultas, true);
assert.equal(readonlyDetail.props.consultas, true);
assert.equal(readonlyDetail.props.canWrite, false);
assert.equal(elements(readonlyPage).some((element) => element.type === PanelMarker), false);

console.log("Produtos OK: Ativos por padrão, status antes do limite, estoque zero, pesquisa/Ice, URL, inativação e histórico preservados.");
console.log("Retorno de venda OK: origens locais com filtros, fallback seguro, lote/editor e permissões preservados.");
