// Runs against disposable, in-memory PostgreSQL only. No .env, network,
// Supabase project, or real customer data is read or modified.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const admin = "90000000-0000-4000-8000-000000000001";
const viewer = "90000000-0000-4000-8000-000000000002";
const customerType = "30000000-0000-4000-8000-000000000001";
const pending = "40000000-0000-4000-8000-000000000002";
const received = "40000000-0000-4000-8000-000000000001";
const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
let checks = 0;

async function rows(sql, args = []) {
  return (await db.query(sql, args)).rows;
}

async function one(sql, args = []) {
  const result = await rows(sql, args);
  assert.equal(result.length, 1, `Expected exactly one row: ${sql}`);
  return result[0];
}

async function asUser(user, sql, args = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    return (await tx.query(sql, args)).rows;
  });
}

async function rpc(name, args = [], user = admin) {
  assert.match(name, /^[a-z_]+$/);
  const result = await asUser(user,
    `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`, args);
  return result[0].value;
}

async function test(name, operation) {
  await operation();
  checks += 1;
  console.log(`OK ${checks}: ${name}`);
}

async function customer(name = `Cliente ${randomUUID()}`) {
  const id = randomUUID();
  await db.query("insert into public.customers(id,name,phone,notes,customer_type_id) values ($1,$2,'telefone privado','nota privada',$3)", [id, name, customerType]);
  return { id, name };
}

async function catalog() {
  const product = randomUUID();
  const variant = randomUUID();
  await db.query("insert into public.products(id,name,cost_price) values ($1,$2,100)", [product, `Produto ${product}`]);
  await db.query("insert into public.product_variants(id,product_id,name,is_ice) values ($1,$2,'Uva',true)", [variant, product]);
  await db.query("insert into public.price_rules(product_id,customer_type_id,sale_price,father_transfer) values ($1,$2,150,125)", [product, customerType]);
  const batch = await rpc("create_purchase", [{ purchase_date: "2026-10-01", items: [{ variant_id: variant, quantity: 30, unit_cost: 100 }] }]);
  return { product, variant, batch };
}

async function sale(cat, client, changes = {}) {
  return rpc("create_sale", [{ sale_date: "2026-10-10", customer_id: client?.id ?? null,
    ...(client ? {} : { customer_name: "Nome manual" }), customer_type_id: customerType,
    payment_status_id: pending, is_credit: false, notes: "Operação original",
    items: [{ variant_id: cat.variant, quantity: 2 }], ...changes }]);
}

async function saleRow(id) {
  return one("select * from public.sales where id=$1", [id]);
}

// Include historical prices, costs, profits, dates, payment/credit/transfer
// fields and operation identifiers; only the intended relationship/name and
// the normal modification timestamp are excluded.
async function preservedSales(ids) {
  return rows("select to_jsonb(s) - 'customer_id' - 'customer_name' - 'updated_at' as value from public.sales s where id=any($1::uuid[]) order by id", [ids]);
}

async function operationalState(ids, cat) {
  return {
    sales: await preservedSales(ids),
    items: await rows("select * from public.sale_items where sale_id=any($1::uuid[]) order by id", [ids]),
    movements: await rows("select * from public.stock_movements where variant_id=$1 order by id", [cat.variant]),
    allocations: await rows("select a.* from public.sale_item_batch_allocations a join public.sale_items si on si.id=a.sale_item_id where si.sale_id=any($1::uuid[]) order by a.id", [ids]),
    batch: await rows("select * from public.purchase_batches where id=$1", [cat.batch]),
    batchItems: await rows("select * from public.batch_items where batch_id=$1 order by id", [cat.batch]),
    batchBalances: await rows("select * from public.batch_item_balances where batch_id=$1 order by batch_item_id", [cat.batch]),
    stock: await rows("select * from public.stock_balances where variant_id=$1", [cat.variant]),
    transfers: await rows("select * from public.transfers order by id"),
    priorAudits: await rows("select * from public.audit_logs where entity_id=any($1::uuid[]) order by id", [ids]),
  };
}

async function deletionAudit(client, count) {
  const audit = await one("select * from public.audit_logs where entity_type='customers' and entity_id=$1 and action='customer.deleted'", [client.id]);
  assert.equal(audit.user_id, admin);
  assert.ok(audit.created_at);
  assert.equal(audit.metadata.customer_name, client.name);
  assert.equal(audit.metadata.detached_sales_count, count);
}

async function applyMigration(name) {
  const sql = await readFile(new URL(name, migrationDirectory), "utf8");
  // PGlite already provides gen_random_uuid(); no other pgcrypto operation is used.
  await db.exec(sql.replace(/^create extension if not exists pgcrypto;\s*$/gim, ""));
  console.log(`Migration applied: ${name}`);
}

try {
  await db.exec(`
    create role authenticated;
    create role anon;
    create schema auth;
    create table auth.users (id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const deletionIndex = migrations.findIndex((name) => name.includes("_009_"));
  assert.ok(deletionIndex >= 0, "Migration 009 must exist before running customer deletion tests");
  for (const name of migrations.slice(0, deletionIndex)) await applyMigration(name);
  await db.query("insert into auth.users(id,email) values ($1,'admin@local.test'),($2,'consulta@local.test')", [admin, viewer]);

  const legacy = await customer("Nome atual do cadastro antigo");
  const legacyCat = await catalog();
  const legacyBlank = await sale(legacyCat, legacy);
  const legacyWhitespace = await sale(legacyCat, legacy);
  const legacyExact = await sale(legacyCat, legacy, { customer_name: "Histórico diferente" });
  const manual = await sale(legacyCat, null, { customer_name: "Cliente manual preservado" });
  await db.query("update public.sales set customer_name='' where id=$1", [legacyBlank]);
  await db.query("update public.sales set customer_name=E' \\t ' where id=$1", [legacyWhitespace]);
  // Preserve exactly, including intentional surrounding whitespace, if filled.
  await db.query("update public.sales set customer_name='  Nome histórico exato  ' where id=$1", [legacyExact]);
  const legacyState = await operationalState([legacyBlank, legacyWhitespace, legacyExact, manual], legacyCat);
  const consultasCreditPrivilege = (await asUser(viewer, "select has_column_privilege('authenticated','public.sales','is_credit','select') as allowed"))[0].allowed;
  const consultasSummaryArguments = (await one("select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='consultas_financial_summary'")).args;
  for (const name of migrations.slice(deletionIndex)) await applyMigration(name);

  await test("Migração preenche descrições ausentes e preserva nomes históricos e manuais exatamente", async () => {
    assert.equal((await saleRow(legacyBlank)).customer_name, legacy.name);
    assert.equal((await saleRow(legacyWhitespace)).customer_name, legacy.name);
    assert.equal((await saleRow(legacyExact)).customer_name, "  Nome histórico exato  ");
    assert.equal((await saleRow(manual)).customer_name, "Cliente manual preservado");
    assert.equal((await saleRow(manual)).customer_id, null);
    assert.deepEqual(await operationalState([legacyBlank, legacyWhitespace, legacyExact, manual], legacyCat), legacyState);
  });

  await test("Cliente sem vendas é excluído fisicamente com auditoria", async () => {
    const client = await customer();
    const result = await rpc("delete_customer", [client.id]);
    assert.equal(result.customer_id, client.id);
    assert.equal(result.customer_name, client.name);
    assert.equal(result.detached_sales_count, 0);
    assert.equal((await rows("select id from public.customers where id=$1", [client.id])).length, 0);
    assert.equal((await asUser(admin, "select id from public.customers where id=$1", [client.id])).length, 0);
    await deletionAudit(client, 0);
  });

  await test("Uma venda permanece com seu snapshot mesmo após mudança do nome no cadastro", async () => {
    const cat = await catalog();
    const client = await customer("João Silva");
    const id = await sale(cat, client);
    assert.equal((await saleRow(id)).customer_name, "João Silva", "Backend must snapshot the customer when no name is supplied");
    await db.query("update public.customers set name='João Silva Santos' where id=$1", [client.id]);
    const before = await operationalState([id], cat);
    const result = await rpc("delete_customer", [client.id]);
    assert.equal(result.detached_sales_count, 1);
    assert.equal((await saleRow(id)).customer_name, "João Silva");
    assert.equal((await saleRow(id)).customer_id, null);
    assert.deepEqual(await operationalState([id], cat), before);
  });

  await test("Backend copia o nome cadastrado nas novas associações e mantém nomes manuais independentes", async () => {
    const cat = await catalog();
    const first = await customer("Nome verdadeiro do cadastro");
    const second = await customer("Outro nome verdadeiro");
    const id = await sale(cat, first, { customer_name: "Nome antigo enviado pelo formulário" });
    assert.equal((await saleRow(id)).customer_name, first.name);
    await rpc("update_sale", [id, { customer_id: second.id }]);
    assert.equal((await saleRow(id)).customer_name, second.name);
    assert.equal((await saleRow(id)).customer_id, second.id);
    await db.query("update public.sales set customer_name='' where id=$1", [id]);
    assert.equal((await saleRow(id)).customer_name, second.name);
    const manualId = await sale(cat, null, { customer_name: "Pessoa sem cadastro" });
    assert.equal((await saleRow(manualId)).customer_id, null);
    assert.equal((await saleRow(manualId)).customer_name, "Pessoa sem cadastro");
    await assert.rejects(() => sale(cat, null, { customer_name: " " }));
    assert.doesNotMatch(JSON.stringify(await saleRow(id)), /telefone privado|nota privada/);
  });

  await test("Várias vendas recebidas, pendentes, fiado e canceladas preservam todos os registros operacionais", async () => {
    const cat = await catalog();
    const client = await customer("Cliente com operações diversas");
    const due = await sale(cat, client, { customer_name: "Histórico pendente" });
    const credit = await sale(cat, client, { customer_name: "Histórico fiado", is_credit: true });
    const paid = await sale(cat, client, { customer_name: "Histórico recebido" });
    const cancelled = await sale(cat, client, { customer_name: "Histórico cancelado" });
    // Reproduce independently stored historical descriptions; a new linked
    // operation correctly snapshots the current registry name in the backend.
    for (const [id, name] of [[due, "Histórico pendente"], [credit, "Histórico fiado"], [paid, "Histórico recebido"], [cancelled, "Histórico cancelado"]]) {
      await db.query("update public.sales set customer_name=$2 where id=$1", [id, name]);
    }
    await rpc("confirm_receipt", [paid]);
    await rpc("confirm_transfers", [[paid], "Pagamento anterior à exclusão"]);
    await rpc("cancel_sale", [cancelled, "Cancelamento anterior à exclusão"]);
    const ids = [due, credit, paid, cancelled];
    const names = await rows("select id,customer_name from public.sales where id=any($1::uuid[]) order by id", [ids]);
    const before = await operationalState(ids, cat);
    const totals = await asUser(admin, "select * from public.dashboard_metrics(null,null)");
    const report = await rpc("sales_report", [null, null, cat.product]);
    const result = await rpc("delete_customer", [client.id]);
    assert.equal(result.detached_sales_count, 4);
    assert.deepEqual(await operationalState(ids, cat), before);
    assert.deepEqual(await rows("select id,customer_name from public.sales where id=any($1::uuid[]) order by id", [ids]), names);
    assert.equal((await rows("select id from public.sales where customer_id=$1", [client.id])).length, 0);
    assert.deepEqual(await asUser(admin, "select * from public.dashboard_metrics(null,null)"), totals);
    assert.deepEqual(await rpc("sales_report", [null, null, cat.product]), report);
    const pendingSale = await one("select * from public.sales_overview where id=$1", [due]);
    assert.equal(pendingSale.counts_as_receivable, true);
    assert.equal(pendingSale.customer_name, "Histórico pendente");
    assert.equal(Number(pendingSale.total_amount), 300);
    assert.equal((await saleRow(credit)).is_credit, true);
    assert.equal((await saleRow(paid)).payment_status_id, received);
    assert.equal((await saleRow(paid)).transfer_paid, true);
    await deletionAudit(client, 4);
  });

  await test("Vendas legadas continuam editáveis como nome manual e nomes iguais não religam operações", async () => {
    await rpc("delete_customer", [legacy.id]);
    const before = await preservedSales([legacyExact]);
    await rpc("update_sale", [legacyExact, { notes: "Observação alterada após excluir cliente" }]);
    const updated = await saleRow(legacyExact);
    assert.equal(updated.customer_id, null);
    assert.equal(updated.customer_name, "  Nome histórico exato  ");
    const expected = structuredClone(before);
    expected[0].value.notes = "Observação alterada após excluir cliente";
    assert.deepEqual(await preservedSales([legacyExact]), expected);
    const replacement = await customer(legacy.name);
    assert.notEqual(replacement.id, legacy.id);
    for (const id of [legacyBlank, legacyWhitespace, legacyExact]) assert.equal((await saleRow(id)).customer_id, null);
    assert.equal((await rows("select id from public.customers where name=$1", [legacy.name])).length, 1);
    const own = await sale(legacyCat, replacement);
    assert.equal((await saleRow(own)).customer_id, replacement.id);
    assert.equal((await saleRow(legacyBlank)).customer_id, null);
  });

  await test("Pesquisa e relatórios encontram vendas desvinculadas pelo nome salvo e mantêm totais individuais", async () => {
    const cat = await catalog();
    const first = await customer(`Homônimo ${randomUUID()}`);
    const second = await customer(first.name);
    const ids = [await sale(cat, first), await sale(cat, second)];
    const before = await rpc("sales_report", [null, null, cat.product, null, first.name]);
    await rpc("delete_customer", [first.id]);
    await rpc("delete_customer", [second.id]);
    const found = await asUser(admin, "select id,customer_name,customer_id from public.sales_overview where customer_name ilike $1 order by id", [`%${first.name}%`]);
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((row) => row.id).sort(), ids.sort());
    assert.ok(found.every((row) => row.customer_id === null && row.customer_name === first.name));
    assert.deepEqual(await rpc("sales_report", [null, null, cat.product, null, first.name]), before);
    assert.equal(Number(before.by_product[0].revenue), 600);
  });

  await test("Falha na auditoria desfaz exclusão, snapshots e vínculos como uma única transação", async () => {
    const cat = await catalog();
    const client = await customer();
    const id = await sale(cat, client);
    // Reproduce an old/incomplete row independently of the new write guard,
    // so this failure proves the fallback write also rolls back.
    await db.exec("alter table public.sales disable trigger sales_preserve_customer_name");
    try {
      await db.query("update public.sales set customer_name=E' \\t ' where id=$1", [id]);
    } finally {
      await db.exec("alter table public.sales enable trigger sales_preserve_customer_name");
    }
    const before = await saleRow(id);
    const beforeCustomer = await one("select * from public.customers where id=$1", [client.id]);
    await db.exec(`create function public.integration_reject_customer_audit() returns trigger language plpgsql as $$
      begin if new.action='customer.deleted' then raise exception 'Injected customer audit failure'; end if; return new; end; $$;
      create trigger integration_customer_audit_failure before insert on public.audit_logs for each row execute function public.integration_reject_customer_audit()`);
    try {
      await assert.rejects(() => rpc("delete_customer", [client.id]), /Injected customer audit failure/);
    } finally {
      await db.exec("drop trigger integration_customer_audit_failure on public.audit_logs; drop function public.integration_reject_customer_audit()");
    }
    assert.deepEqual(await saleRow(id), before);
    assert.deepEqual(await one("select * from public.customers where id=$1", [client.id]), beforeCustomer);
    assert.equal((await rows("select id from public.audit_logs where entity_id=$1 and action='customer.deleted'", [client.id])).length, 0);
    await rpc("delete_customer", [client.id]);
    assert.equal((await saleRow(id)).customer_id, null);
    assert.equal((await saleRow(id)).customer_name, client.name);
  });

  await test("CONSULTAS não exclui por RPC ou DELETE direto; permissões genéricas de escrita também não bastam", async () => {
    const client = await customer();
    await assert.rejects(() => rpc("delete_customer", [client.id], viewer));
    try {
      const removed = await asUser(viewer, "delete from public.customers where id=$1 returning id", [client.id]);
      assert.equal(removed.length, 0);
    } catch (error) {
      assert.match(error.message, /permission|permiss|acesso|denied/i);
    }
    assert.equal((await rows("select id from public.customers where id=$1", [client.id])).length, 1);
    await db.exec("insert into public.roles(code,name,can_write) values ('writer_test','Writer test',true)");
    await db.query("update public.profiles set role_code='writer_test' where id=$1", [viewer]);
    try {
      await assert.rejects(() => rpc("delete_customer", [client.id], viewer));
    } finally {
      await db.query("update public.profiles set role_code='CONSULTAS' where id=$1", [viewer]);
    }
    await assert.rejects(() => rpc("delete_customer", [client.id], null));
    await db.transaction(async (tx) => {
      await tx.exec("set local role anon");
      await assert.rejects(() => tx.query("select public.delete_customer($1)", [client.id]));
    });
    assert.equal((await rows("select id from public.customers where id=$1", [client.id])).length, 1);
  });

  await test("CONSULTAS mantém leitura e o contrato de ocultação de Fiado do resumo depois da exclusão", async () => {
    const cat = await catalog();
    const client = await customer();
    const ordinary = await sale(cat, client);
    const credit = await sale(cat, client, { is_credit: true });
    const summary = await asUser(viewer, "select * from public.consultas_financial_summary(null,null,$1)", [cat.product]);
    const columns = (await rows("select column_name from information_schema.columns where table_schema='public' and table_name='sales_overview' order by ordinal_position")).map((row) => row.column_name);
    const visibleBefore = await asUser(viewer, "select * from public.sales_overview where id=any($1::uuid[]) order by id", [[ordinary, credit]]);
    await rpc("delete_customer", [client.id]);
    assert.deepEqual(await asUser(viewer, "select * from public.consultas_financial_summary(null,null,$1)", [cat.product]), summary);
    const visibleAfter = await asUser(viewer, "select * from public.sales_overview where id=any($1::uuid[]) order by id", [[ordinary, credit]]);
    assert.equal(visibleAfter.length, visibleBefore.length);
    assert.ok(visibleAfter.every((row) => row.customer_name === client.name && row.customer_id === null));
    // Existing Fiado visibility rules must not be widened by this migration.
    assert.deepEqual((await rows("select column_name from information_schema.columns where table_schema='public' and table_name='sales_overview' order by ordinal_position")).map((row) => row.column_name), columns);
    assert.equal((await asUser(viewer, "select has_column_privilege('authenticated','public.sales','is_credit','select') as allowed"))[0].allowed, consultasCreditPrivilege);
    const args = (await one("select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='consultas_financial_summary'")).args;
    assert.equal(args, consultasSummaryArguments);
    assert.doesNotMatch(args, /p_is_credit/);
    assert.ok(summary.every((row) => !Object.hasOwn(row, "is_credit")));
  });

  await test("Ordem criar/depois excluir preserva nome; excluir/depois criar com ID obsoleto falha sem efeitos", async () => {
    const cat = await catalog();
    const client = await customer();
    const id = await sale(cat, client);
    await rpc("delete_customer", [client.id]);
    assert.equal((await saleRow(id)).customer_id, null);
    assert.equal((await saleRow(id)).customer_name, client.name);
    const before = await operationalState([id], cat);
    const count = (await one("select count(*)::int as n from public.sales")).n;
    await assert.rejects(() => sale(cat, client));
    await assert.rejects(() => sale(cat, client, { customer_name: "Nome de formulário obsoleto" }));
    assert.equal((await one("select count(*)::int as n from public.sales")).n, count);
    assert.deepEqual(await operationalState([id], cat), before);
    assert.equal((await rows("select s.id from public.sales s left join public.customers c on c.id=s.customer_id where s.customer_id is not null and c.id is null")).length, 0);
  });

  await test("ID inexistente ou nulo e reenvio não alteram vendas nem duplicam a auditoria", async () => {
    const client = await customer();
    await rpc("delete_customer", [client.id]);
    const audit = await rows("select * from public.audit_logs where entity_id=$1 order by id", [client.id]);
    await assert.rejects(() => rpc("delete_customer", [client.id]));
    await assert.rejects(() => rpc("delete_customer", [randomUUID()]));
    await assert.rejects(() => rpc("delete_customer", [null]));
    assert.deepEqual(await rows("select * from public.audit_logs where entity_id=$1 order by id", [client.id]), audit);
  });

  console.log(`${checks} integration checks passed using disposable PostgreSQL.`);
  console.log("Concurrency limit: PGlite is single-session; both transaction orderings were tested, not two simultaneous database connections.");
} catch (error) {
  console.error(error.stack?.split("\n").slice(0, 7).join("\n") ?? error);
  if (error.detail) console.error(`Detail: ${error.detail}`);
  if (error.where) console.error(`Context: ${error.where}`);
  if (error.position) console.error(`SQL position: ${error.position}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
