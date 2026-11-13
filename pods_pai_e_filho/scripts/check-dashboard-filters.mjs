import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const routes = ["inicio", "relatorios"];
const financialNames = new Set(["loadDashboard", "loadFinancialSales", "loadConsultasFinancialSummary"]);
const summary = {
  sales_count: 0, units_sold: 0, due_now_sales: 0, future_sales: 0,
  revenue: "0", cost_sold: "0", cost_missing_items: 0,
  transfer_total: "0", transfer_received: "0", transfer_due_now: "0", transfer_future: "0",
  father_profit_total: "0", father_profit_received: "0",
  father_profit_missing_items: 0, father_profit_missing_received_items: 0,
  stock_cost_total: "0", stock_cost_missing_products: 0,
};
const dashboard = {
  ok: true,
  metrics: {
    money_received: "0", receivable: "0", profit_received: "0", profit_total: "0",
    transfer_from_received: "0", transfer_future: "0", transfer_due_now: "0", transfer_total: "0",
    sales_count: 0, units_sold: 0,
  },
  sales: [], stock: [], products: [], divergences: [], lowStockThreshold: 5,
};
const batches = [
  { batch_id: "open-old", batch_number: 7, status: "ABERTO", purchase_date: "2026-09-01", created_at: "2026-09-01T12:00:00Z" },
  { batch_id: "finished", batch_number: 9, status: "FINALIZADO", purchase_date: "2026-10-06", created_at: "2026-10-06T12:00:00Z" },
  { batch_id: "open-new", batch_number: 8, status: "ABERTO", purchase_date: "2026-10-01", created_at: "2026-10-01T12:00:00Z" },
  { batch_id: "cancelled", batch_number: 10, status: "CANCELADO", purchase_date: "2026-10-07", created_at: "2026-10-07T12:00:00Z" },
];

class RedirectSignal extends Error {
  constructor(url) {
    super(`redirect: ${url}`);
    this.url = url;
  }
}

function component(name) {
  const result = () => null;
  Object.defineProperty(result, "name", { value: name });
  return result;
}

function jsx(type, props, key) {
  return { type, props: props ?? {}, key };
}

function walk(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    const found = walk(child, predicate);
    if (found) return found;
  }
  return null;
}

async function render(route, params, options = {}) {
  const calls = [];
  const available = options.batches ?? batches;
  const role = options.role ?? "ADMIN";
  const registry = new Map();
  const ui = new Proxy({}, {
    get: (_, name) => name === "__esModule" ? true : component(String(name)),
  });
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return result;
  };
  const mocks = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/link": { __esModule: true, default: component("Link") },
    "next/navigation": {
      redirect: (url) => {
        calls.push({ name: "redirect", args: [url] });
        throw new RedirectSignal(url);
      },
    },
    "lucide-react": ui,
    "@/lib/auth": { getSessionState: record("getSessionState", { status: "ok", profile: { role_code: role, can_write: true } }) },
    "@/lib/data/batches": {
      listBatches: record("listBatches", {
        ok: !options.batchError,
        message: options.batchError ?? "",
        batches: options.batchError ? [] : available,
      }),
    },
    "@/lib/data/catalog": {
      loadCatalog: record("loadCatalog", {
        ok: true,
        data: { products: [], stock: [], customerTypes: [], statuses: [], variants: [], prices: [], customers: [] },
      }),
    },
    "@/lib/data/dashboard": {
      loadDashboard: record("loadDashboard", dashboard),
      loadConsultasFinancialSummary: record("loadConsultasFinancialSummary", { ok: true, summary }),
    },
    "@/lib/data/financial-sales": {
      loadFinancialSales: record("loadFinancialSales", { ok: true, sales: [], lines: [] }),
    },
    "@/components/ui/field": { controlClass: "control" },
    "@/components/ui/button": { buttonVariants: () => "button" },
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
  };

  function loadModule(filename) {
    if (registry.has(filename)) return registry.get(filename).exports;
    const compiledModule = { exports: {} };
    registry.set(filename, compiledModule);
    const source = readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText;
    function requireModule(name) {
      if (name in mocks) return mocks[name];
      if (name.startsWith("@/components/")) return ui;
      if (name.startsWith("@/lib/domain/") || name === "@/lib/format") {
        return loadModule(path.join(projectRoot, `${name.slice(2)}.ts`));
      }
      if (name.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), name);
        return loadModule(path.extname(resolved) ? resolved : `${resolved}.ts`);
      }
      throw new Error(`Import não simulado; acesso externo bloqueado: ${name}`);
    }
    vm.runInNewContext(output, {
      module: compiledModule, exports: compiledModule.exports, require: requireModule, URLSearchParams, console,
    }, { filename });
    return compiledModule.exports;
  }

  const page = loadModule(path.join(projectRoot, "app", "(painel)", route, "page.tsx")).default;
  try {
    const tree = await page({ searchParams: Promise.resolve(params) });
    return { calls, tree, redirect: null };
  } catch (error) {
    if (error instanceof RedirectSignal) return { calls, tree: null, redirect: error.url };
    throw error;
  }
}

function assertNoFinancialCalls(result, label) {
  assert.equal(result.calls.some((call) => financialNames.has(call.name)), false, label);
}

function assertSelectedQueries(result, route, role, selected) {
  assert.equal(result.redirect, null, "seleção explícita não redireciona");
  const queries = result.calls.filter((call) => financialNames.has(call.name));
  const expectedNames = route === "inicio"
    ? role === "CONSULTAS" ? ["loadDashboard", "loadConsultasFinancialSummary"] : ["loadDashboard"]
    : role === "CONSULTAS" ? ["loadConsultasFinancialSummary"] : ["loadFinancialSales"];
  assert.deepEqual(queries.map((call) => call.name), expectedNames);
  for (const query of queries) {
    const filters = query.name === "loadFinancialSales" ? query.args[0] : query.args[2];
    assert.equal(filters.batchId ?? null, selected, `${query.name} recebe o lote desde a primeira consulta`);
  }
}

let scenarios = 0;
for (const route of routes) {
  for (const role of ["ADMIN", "CONSULTAS"]) {
    const missing = await render(route, {
      cliente: "Cliente com espaço", produto: "product-1", periodo: "personalizado", de: "2026-09-01", ate: "2026-10-07",
    }, { role });
    assertNoFinancialCalls(missing, "redireciona a seleção inicial antes de qualquer consulta financeira");
    const canonical = new URL(missing.redirect, "https://example.test");
    assert.equal(canonical.pathname, `/${route}`);
    assert.equal(canonical.searchParams.get("lote"), "open-new");
    assert.equal(canonical.searchParams.get("cliente"), "Cliente com espaço");
    assert.equal(canonical.searchParams.get("produto"), "product-1");
    assert.equal(canonical.searchParams.get("periodo"), "personalizado");
    assert.equal(canonical.searchParams.get("de"), "2026-09-01");
    assert.equal(canonical.searchParams.get("ate"), "2026-10-07");
    scenarios++;

    for (const selection of ["todos", "", "open-old", "finished", "cancelled"]) {
      const result = await render(route, { lote: selection }, { role });
      assertSelectedQueries(result, route, role, selection === "todos" || selection === "" ? null : selection);
      scenarios++;
    }
    const refresh = await render(route, { lote: "todos" }, { role });
    assertSelectedQueries(refresh, route, role, null);
    scenarios++;

    for (const unavailable of ["invalid", "inaccessible"]) {
      const result = await render(route, { lote: unavailable }, { role });
      assert.equal(new URL(result.redirect, "https://example.test").searchParams.get("lote"), "open-new");
      assertNoFinancialCalls(result, "lote inválido/inacessível redireciona antes de ler números");
      scenarios++;
    }

    for (const available of [[], batches.filter((batch) => batch.status === "CANCELADO")]) {
      const empty = await render(route, {}, { role, batches: available });
      assert.equal(empty.redirect, `/${route}?lote=todos`);
      assertNoFinancialCalls(empty, "sem lote elegível canoniza a visão geral antes de ler números");
      const general = await render(route, { lote: "todos" }, { role, batches: available });
      assertSelectedQueries(general, route, role, null);
      scenarios += 2;
    }
    const finalized = await render(route, {}, { role, batches: batches.filter((batch) => batch.status !== "ABERTO") });
    assert.equal(new URL(finalized.redirect, "https://example.test").searchParams.get("lote"), "finished");
    assertNoFinancialCalls(finalized, "finalizado automático só consulta depois de canonizar");
    scenarios++;

    const failure = await render(route, { lote: "open-old" }, { role, batchError: "Falha ao carregar lotes" });
    assert.equal(failure.redirect, null);
    assertNoFinancialCalls(failure, "falha no lote explicitamente selecionado não consulta valores gerais");
    assert.ok(walk(failure.tree, (element) => element.type?.name === "Notice"), "falha de lotes mostra aviso");
    const legacy = await render(route, {}, { role, batchError: "Schema indisponível" });
    assertSelectedQueries(legacy, route, role, null);
    const legacyNotice = route === "inicio" && role === "CONSULTAS"
      ? legacy.tree.props.batchNotice
      : walk(legacy.tree, (element) => element.type?.name === "Notice");
    assert.ok(legacyNotice, "falha sem seleção específica preserva a visão geral com aviso");
    scenarios += 2;

    const normalized = await render(route, {
      lote: ["open-old", "open-new"], periodo: ["personalizado", "mes"],
      de: ["2026-09-01", "2026-10-01"], ate: ["2026-09-30", "2026-10-07"],
    }, { role });
    assertSelectedQueries(normalized, route, role, "open-old");
    const firstQuery = normalized.calls.find((call) => financialNames.has(call.name));
    const from = firstQuery.name === "loadFinancialSales" ? firstQuery.args[0].from : firstQuery.args[0];
    const to = firstQuery.name === "loadFinancialSales" ? firstQuery.args[0].to : firstQuery.args[1];
    assert.equal(from, "2026-09-01");
    assert.equal(to, "2026-09-30");
    scenarios++;
  }
}

// Opening Vendas must preserve the dashboard's selection now that its default
// is the newest open batch rather than the general sales history.
for (const role of ["ADMIN", "CONSULTAS"]) {
  for (const selection of ["todos", "", "open-new", "open-old", "finished", "cancelled"]) {
    const result = await render("inicio", {
      lote: selection,
      periodo: "personalizado",
      de: "2026-09-01",
      ate: "2026-09-30",
      cliente: "João & Filhos",
    }, { role });
    assert.equal(result.redirect, null);
    let salesUrls;
    if (role === "CONSULTAS") {
      assert.equal(result.tree.type.name, "ConsultasDashboard");
      salesUrls = [result.tree.props.salesUrl];
    } else {
      const salesCard = walk(result.tree, (element) => element.type?.name === "StatCard" && element.props.label === "Vendas");
      const recentPanel = walk(result.tree, (element) => element.type?.name === "Panel" && element.props.title === "Movimentações recentes");
      assert.ok(salesCard, "o indicador de vendas está presente");
      assert.ok(recentPanel?.props.action, "o histórico recente tem ação para abrir todas as vendas");
      salesUrls = [salesCard.props.href, recentPanel.props.action.props.href];
    }
    for (const salesUrl of salesUrls) {
      const target = new URL(salesUrl, "https://example.test");
      assert.equal(target.pathname, "/vendas");
      assert.equal(target.searchParams.get("lote"), selection || "todos", `${role}: a navegação preserva o lote, inclusive Todos explícito`);
      assert.equal(target.searchParams.get("de"), "2026-09-01");
      assert.equal(target.searchParams.get("ate"), "2026-09-30");
      assert.equal(target.searchParams.get("cliente"), "João & Filhos");
      assert.equal(target.searchParams.has("periodo"), false, "Vendas recebe o intervalo já resolvido");
    }
    scenarios++;
  }
}

console.log(`check-dashboard-filters: ok (${scenarios} cenários; páginas reais com dados simulados)`);
