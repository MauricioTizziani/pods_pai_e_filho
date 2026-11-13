// Verifica paginação e agregação de Fiados com dados descartáveis.
// Não usa credenciais, rede nem dados do Supabase.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
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

function marker(name) { return { [name]: function () {} }[name]; }

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

const creditSales = loadTs("lib/domain/credit-sales.ts");

await test("URLs de Fiados validam a página e geram navegação simples", () => {
  assert.equal(creditSales.FIADOS_PAGE_SIZE, 50);
  for (const value of [undefined, "", "0", "-1", "2.5", "abc", "Infinity", "9007199254740992", "1e3"]) {
    assert.equal(creditSales.parseFiadosPage(value), 1, String(value));
  }
  assert.equal(creditSales.parseFiadosPage("5"), 5);
  assert.equal(creditSales.parseFiadosPage(["3", "9"]), 3);
  assert.equal(creditSales.fiadosHref(1), "/fiados");
  assert.equal(creditSales.fiadosHref(3), "/fiados?pagina=3");
});

await test("consulta agregada converte valores do RPC e mantém erros explícitos", async () => {
  const expected = [{ open_credit_count: 201, receivable_amount: "30150.00", transfer_pending: "25125.00" }];
  const salesDataModule = loadTs("lib/data/sales.ts", {
    "@/lib/supabase/server": { createClient: async () => ({ rpc: async (name) => {
      assert.equal(name, "open_credit_summary");
      return { data: expected, error: null };
    } }) },
    "@/lib/domain/flavors": { flavorSearchOrFilter: () => null, iceFilterToBool: () => null, parseIceParam: () => null },
  });
  assert.deepEqual(plain(await salesDataModule.getOpenCreditSummary()), {
    ok: true,
    summary: { count: 201, receivable: 30150, transferPending: 25125 },
  });

  const failedModule = loadTs("lib/data/sales.ts", {
    "@/lib/supabase/server": { createClient: async () => ({ rpc: async () => ({ data: null, error: { message: "RPC indisponível" } }) }) },
    "@/lib/domain/flavors": { flavorSearchOrFilter: () => null, iceFilterToBool: () => null, parseIceParam: () => null },
  });
  assert.deepEqual(plain(await failedModule.getOpenCreditSummary()), { ok: false, message: "RPC indisponível" });
});

await test("função SQL soma os 201 fiados e pagina volumes até 5.000 sem duplicar ou truncar", async () => {
  const migration = fs.readFileSync(path.join(root, "supabase/migrations/20261113120000_012_open_credit_summary.sql"), "utf8");
  const functionSql = migration.match(/create or replace function public\.open_credit_summary\(\)[\s\S]*?\$\$;/i)?.[0];
  assert.ok(functionSql, "migração contém a função agregada");
  assert.match(functionSql, /security invoker/i);
  assert.match(migration, /revoke all on function public\.open_credit_summary\(\) from public/i);
  assert.match(migration, /grant execute on function public\.open_credit_summary\(\) to authenticated/i);

  const database = new PGlite();
  await database.exec(`
    create table public.sales_overview (
      id integer primary key,
      sale_date date not null,
      is_credit boolean not null,
      counts_as_receivable boolean not null,
      counts_as_received boolean not null,
      is_valid boolean not null,
      transfer_due_now boolean not null,
      total_amount numeric(14, 2) not null,
      transfer_amount numeric(14, 2) not null
    );
    create function public.has_write_access() returns boolean
      language sql stable as $$ select current_setting('app.credit_writer', true) = 'true' $$;
  `);
  await database.exec(functionSql);
  await database.query("select set_config('app.credit_writer', 'true', false)");

  for (const count of [30, 50, 51, 200, 201, 500, 1000, 5000]) {
    await database.exec("truncate public.sales_overview");
    await database.query(`
      insert into public.sales_overview
      select id, date '2026-10-01' + (id % 4), true, true, false, true, true, 150.00, 125.00
      from generate_series(1, $1) as id
    `, [count]);

    const pages = Math.max(1, Math.ceil(count / creditSales.FIADOS_PAGE_SIZE));
    const seen = new Set();
    for (let page = 1; page <= pages; page++) {
      const offset = (page - 1) * creditSales.FIADOS_PAGE_SIZE;
      const listed = await database.query(`
        select id from public.sales_overview
        where is_credit and counts_as_receivable and is_valid
        order by sale_date desc, id desc
        limit $1 offset $2
      `, [creditSales.FIADOS_PAGE_SIZE, offset]);
      assert.equal(listed.rows.length, Math.min(creditSales.FIADOS_PAGE_SIZE, count - offset), `página ${page} de ${count}`);
      for (const row of listed.rows) {
        assert.equal(seen.has(row.id), false, `registro repetido ${row.id}`);
        seen.add(row.id);
      }

      const result = await database.query("select * from public.open_credit_summary()");
      const summary = result.rows[0];
      assert.equal(Number(summary.open_credit_count), count);
      assert.equal(Number(summary.receivable_amount), count * 150);
      assert.equal(Number(summary.transfer_pending), count * 125);
    }
    assert.equal(seen.size, count, `todos os ${count} registros foram paginados`);
    if (count === 201) {
      const result = await database.query("select * from public.open_credit_summary()");
      assert.equal(Number(result.rows[0].receivable_amount), 30150);
      assert.equal(Number(result.rows[0].transfer_pending), 25125);
    }
  }

  await database.exec("truncate public.sales_overview");
  await database.exec(`
    insert into public.sales_overview values
      (1, '2026-10-01', true, true, false, true, true, 150.00, 125.00),
      (2, '2026-10-01', true, false, true, true, false, 1000.00, 900.00),
      (3, '2026-10-01', true, true, false, false, false, 1000.00, 900.00),
      (4, '2026-10-01', false, true, false, true, false, 1000.00, 900.00),
      (5, '2026-10-01', true, true, false, true, false, 150.00, 125.00)
  `);
  const exclusions = await database.query("select * from public.open_credit_summary()");
  assert.equal(Number(exclusions.rows[0].open_credit_count), 2, "recebidas, canceladas e sem classificação Fiado ficam fora");
  assert.equal(Number(exclusions.rows[0].receivable_amount), 300, "saldo a receber segue os estados atuais elegíveis");
  assert.equal(Number(exclusions.rows[0].transfer_pending), 125, "repasse já pago não entra no total pendente");

  await database.query("select set_config('app.credit_writer', 'false', false)");
  await assert.rejects(database.query("select * from public.open_credit_summary()"), /Sem permissão para consultar Fiados/);
  await database.close();
});

const Link = marker("Link");
const PageHeading = marker("PageHeading");
const Notice = marker("Notice");
const SaleList = marker("SaleList");
const StatCard = marker("StatCard");

function pageHarness({ totalCount, summary = { count: totalCount, receivable: 30150, transferPending: 25125 }, listOk = true, summaryOk = true, role = "admin" }) {
  const salesQueries = [];
  let summaryCalls = 0;
  const { default: page } = loadTs("app/(painel)/fiados/page.tsx", {
    "next/link": { default: Link },
    "next/navigation": { redirect: (href) => { throw Object.assign(new Error("redirect"), { href }); } },
    "lucide-react": { Bookmark: marker("Bookmark"), ChevronLeft: marker("ChevronLeft"), ChevronRight: marker("ChevronRight"), Clock: marker("Clock"), Send: marker("Send") },
    "@/lib/data/sales": {
      listSales: async (query) => {
        salesQueries.push(query);
        if (!listOk) return { ok: false, message: "Falha de listagem", sales: [], totalCount: null };
        const visible = Math.max(0, Math.min(50, (totalCount ?? 0) - (query.offset ?? 0)));
        return { ok: true, message: "", totalCount, sales: Array.from({ length: visible }, (_, index) => ({ id: `sale-${(query.offset ?? 0) + index + 1}` })) };
      },
      getOpenCreditSummary: async () => {
        summaryCalls++;
        return summaryOk ? { ok: true, summary } : { ok: false, message: "Falha de resumo" };
      },
    },
    "@/components/feedback/notice": { Notice },
    "@/components/shell/page-heading": { PageHeading },
    "@/components/sales/sale-list": { SaleList },
    "@/components/ui/stat-card": { StatCard },
    "@/components/ui/button": { buttonVariants: () => "button" },
    "@/lib/auth": { getSessionState: async () => ({ status: "ok", profile: { role_code: role, can_write: role === "admin" } }) },
    "@/lib/domain/roles": { isConsultasRole: (value) => value === "CONSULTAS" },
    "@/lib/domain/credit-sales": creditSales,
    "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
  });
  return {
    render: (params = {}) => page({ searchParams: Promise.resolve(params) }),
    salesQueries,
    get summaryCalls() { return summaryCalls; },
  };
}

await test("tela usa 50 registros, resumo global invariável e volta à mesma página", async () => {
  for (const [page, offset] of [[1, 0], [2, 50], [5, 200]]) {
    const harness = pageHarness({ totalCount: 201 });
    const tree = await harness.render(page === 1 ? {} : { pagina: String(page) });
    assert.equal(harness.salesQueries.length, 1);
    assert.deepEqual(plain(harness.salesQueries[0]), {
      openCredit: true,
      limit: 50,
      offset,
      includeCount: true,
      includeCosts: false,
    });
    assert.equal(harness.summaryCalls, 1);
    const cards = elements(tree).filter((element) => element.type === StatCard);
    assert.deepEqual(cards.map((element) => element.props.value), [201, 30150, 25125]);
    const list = elements(tree).find((element) => element.type === SaleList);
    assert.equal(list.props.sales.length, Math.min(50, 201 - offset));
    assert.equal(list.props.returnPath, creditSales.fiadosHref(page));
    const nav = elements(tree).find((element) => element.type === "nav");
    assert.ok(nav);
    assert.ok(text(nav).replace(/\s+/g, " ").includes(`Página ${page} de 5`));
    const links = elements(nav).filter((element) => element.type === Link);
    if (page > 1) assert.ok(links.some((link) => link.props.href === creditSales.fiadosHref(page - 1)));
    if (page < 5) assert.ok(links.some((link) => link.props.href === creditSales.fiadosHref(page + 1)));
  }
});

await test("limite de 50 não cria página extra e página fora da contagem volta à última válida", async () => {
  const exact = pageHarness({ totalCount: 50 });
  const tree = await exact.render({ pagina: "1" });
  const nav = elements(tree).find((element) => element.type === "nav");
  assert.ok(text(nav).replace(/\s+/g, " ").includes("Página 1 de 1"));
  assert.equal(elements(nav).filter((element) => element.type === Link).length, 0);

  const beyond = pageHarness({ totalCount: 51 });
  await assert.rejects(beyond.render({ pagina: "99" }), (error) => error.href === "/fiados?pagina=2");
});

await test("falhas aparecem sem apresentar resumo falso e CONSULTAS não consulta Fiados", async () => {
  const failedSummary = pageHarness({ totalCount: 1, summaryOk: false });
  const tree = await failedSummary.render();
  assert.equal(elements(tree).filter((element) => element.type === StatCard).length, 0);
  assert.ok(elements(tree).some((element) => element.type === Notice && text(element).includes("Falha de resumo")));
  assert.ok(elements(tree).some((element) => element.type === SaleList));

  const consultas = pageHarness({ totalCount: 1, role: "CONSULTAS" });
  await assert.rejects(consultas.render(), (error) => error.href === "/repasses");
  assert.equal(consultas.salesQueries.length, 0);
  assert.equal(consultas.summaryCalls, 0);
});

await test("detalhe da venda permite voltar à página de Fiados selecionada", async () => {
  const SaleEditor = marker("SaleEditor");
  const detailPage = loadTs("app/(painel)/vendas/[id]/page.tsx", {
    "next/link": { default: Link },
    "next/navigation": { notFound: () => { throw new Error("not found"); } },
    "@/lib/auth": { getSessionState: async () => ({ status: "ok", profile: { role_code: "admin", can_write: true } }) },
    "@/lib/data/catalog": { loadCatalog: async () => ({ ok: true, data: { batchItems: [] } }) },
    "@/lib/data/sales": { getSale: async () => ({
      ok: true,
      sale: { id: "sale-1", customer_name: "João", sale_date: "2026-10-01", product_name: "Pod", variant_name: "Grape", is_valid: true },
      items: [],
      batchAllocations: [],
      audit: [],
    }) },
    "@/lib/format": loadTs("lib/format.ts"),
    "@/components/feedback/notice": { Notice },
    "@/components/shell/page-heading": { PageHeading },
    "@/components/sales/sale-editor": { SaleEditor },
    "@/lib/domain/roles": { isConsultasRole: () => false },
    "@/components/ui/panel": { Panel: marker("Panel") },
    "@/components/ui/button": { buttonVariants: () => "button" },
  });
  const tree = await detailPage.default({
    params: Promise.resolve({ id: "sale-1" }),
    searchParams: Promise.resolve({ voltar: "/fiados?pagina=2" }),
  });
  const heading = elements(tree).find((element) => element.type === PageHeading);
  assert.equal(heading.props.back.href, "/fiados?pagina=2");
  assert.equal(heading.props.back.label, "Voltar aos fiados");
});

console.log(`\n${checks} verificações de Fiados concluídas sem acessar dados salvos.`);
