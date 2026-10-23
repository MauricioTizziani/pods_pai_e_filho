// Runs PostgreSQL migrations and RPCs in a new, disposable in-memory database.
// No .env file, Supabase URL, network connection, or production data is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const admin = "90000000-0000-4000-8000-000000000001";
const viewer = "90000000-0000-4000-8000-000000000002";
const customerType = "30000000-0000-4000-8000-000000000001";
const paymentStatus = "40000000-0000-4000-8000-000000000002";
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

async function rejects(operation, message) {
  await assert.rejects(operation, message);
}

async function test(name, operation) {
  await operation();
  checks += 1;
  console.log(`OK ${checks}: ${name}`);
}

async function catalog() {
  const product = randomUUID();
  const variant = randomUUID();
  const otherVariant = randomUUID();
  await db.query("insert into public.products(id,name,cost_price) values ($1,$2,100)",
    [product, `Integration ${product}`]);
  await db.query("insert into public.product_variants(id,product_id,name,is_ice) values ($1,$3,'Uva',true),($2,$3,'Morango',false)",
    [variant, otherVariant, product]);
  await db.query("insert into public.price_rules(product_id,customer_type_id,sale_price,father_transfer) values ($1,$2,150,125)",
    [product, customerType]);
  return { product, variant, otherVariant };
}

async function purchase(variant, quantity = 10, cost = 100, date = "2026-10-01") {
  const id = await rpc("create_purchase", [{ purchase_date: date, notes: "Compra original", items: [{ variant_id: variant, quantity, unit_cost: cost }] }]);
  return one("select b.*,bi.id as item_id,bi.variant_id,bi.quantity_purchased,bi.unit_cost from public.purchase_batches b join public.batch_items bi on bi.batch_id=b.id where b.id=$1", [id]);
}

async function sale(variant, quantity = 3, date = "2026-10-10") {
  const id = await rpc("create_sale", [{ sale_date: date, customer_name: "Cliente de teste", customer_type_id: customerType, payment_status_id: paymentStatus, is_credit: true, notes: "Financeiro preservado", items: [{ variant_id: variant, quantity }] }]);
  const item = await one("select * from public.sale_items where sale_id=$1", [id]);
  return { id, item };
}

async function fixture({ sourceQuantity = 10, quantity = 3, destinationQuantity = 10, sourceCost = 100, destinationCost = 105 } = {}) {
  const cat = await catalog();
  const source = await purchase(cat.variant, sourceQuantity, sourceCost, "2026-10-05");
  const sold = await sale(cat.variant, quantity);
  // An older purchase can be corrected after this sale was entered.
  const destination = await purchase(cat.variant, destinationQuantity, destinationCost, "2026-10-01");
  const allocation = await one("select * from public.sale_item_batch_allocations where sale_item_id=$1 and reversed_at is null", [sold.item.id]);
  return { ...cat, source, sold, destination, allocation };
}

async function stock(variant) {
  return Number((await one("select quantity from public.stock_balances where variant_id=$1", [variant])).quantity);
}

async function balance(item) {
  return Number((await one("select quantity_remaining from public.batch_item_balances where batch_item_id=$1", [item])).quantity_remaining);
}

async function activeAllocations(item) {
  return rows("select * from public.sale_item_batch_allocations where sale_item_id=$1 and reversed_at is null order by batch_item_id", [item]);
}

async function finance(id) {
  return one(`select s.id,s.sale_date,s.created_at,s.customer_id,s.customer_name,s.customer_type_id,
    s.payment_status_id,s.is_credit,s.notes,s.total_amount,s.transfer_amount,s.profit_amount,
    s.transfer_paid,s.transfer_paid_at,s.transfer_paid_by,s.transfer_id,
    si.quantity,si.unit_price,si.unit_transfer,si.line_total,si.line_transfer,si.line_profit
    from public.sales s join public.sale_items si on si.sale_id=s.id where s.id=$1`, [id]);
}

async function previewMove(f, quantity = 1, user = admin) {
  return rpc("preview_sale_batch_correction", [f.destination.id, f.sold.item.id, f.allocation?.id ?? null, quantity, f.destination.item_id], user);
}

async function editPayload(batch, changes = {}) {
  const items = (await rows("select id as batch_item_id,variant_id,quantity_purchased as quantity,unit_cost from public.batch_items where batch_id=$1 order by id", [batch.id]))
    .map((item) => ({ ...item, quantity: Number(item.quantity), unit_cost: Number(item.unit_cost) }));
  const date = batch.purchase_date instanceof Date ? batch.purchase_date.toISOString() : batch.purchase_date;
  return { purchase_date: String(date).slice(0, 10), notes: batch.notes, same_purchase_confirmed: true, items, ...changes };
}

async function confirm(preview, reason = "Conferência documentada da compra original", user = admin) {
  assert.ok(preview.request_id, "Preview must persist a request ID");
  assert.ok(preview.summary && Array.isArray(preview.summary.changes), "Preview must expose its impact");
  return rpc("confirm_batch_correction", [preview.request_id, reason], user);
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
  for (const name of migrations) {
    const sql = await readFile(new URL(name, migrationDirectory), "utf8");
    // PostgreSQL's built-in gen_random_uuid() is available in PGlite. These
    // migrations do not use any other pgcrypto operation.
    await db.exec(sql.replace(/^create extension if not exists pgcrypto;\s*$/gim, ""));
    console.log(`Migration applied: ${name}`);
  }
  assert.ok(migrations.some((name) => name.includes("_008_")), "Migration 008 must exist before running correction tests");
  await db.query("insert into auth.users(id,email) values ($1,'admin@local.test'),($2,'consulta@local.test')", [admin, viewer]);
  // Explicit role grants also permit testing future write-enabled non-admin roles.
  await db.exec("insert into public.roles(code,name,can_write) values ('writer_test','Writer test',true)");

  await test("Caso 1: observação preserva estoque, vendas, custos e criação do lote", async () => {
    const f = await fixture();
    const before = await finance(f.sold.id);
    const beforeStock = await stock(f.variant);
    const beforeMovements = (await one("select count(*)::int as n from public.stock_movements")).n;
    const payload = await editPayload(f.destination, { notes: "Observação corrigida" });
    await confirm(await rpc("preview_batch_edit", [f.destination.id, payload]));
    const batch = await one("select * from public.purchase_batches where id=$1", [f.destination.id]);
    assert.equal(batch.notes, payload.notes);
    assert.deepEqual(batch.created_at, f.destination.created_at);
    assert.ok(batch.updated_at);
    assert.equal(batch.updated_by, admin);
    assert.equal(await stock(f.variant), beforeStock);
    assert.equal((await one("select count(*)::int as n from public.stock_movements")).n, beforeMovements);
    assert.deepEqual(await finance(f.sold.id), before);
  });

  await test("Caso 2: entrada 10 → 12 movimenta apenas +2 e exige justificativa", async () => {
    const cat = await catalog();
    const batch = await purchase(cat.variant);
    const payload = await editPayload(batch);
    payload.items[0].quantity = 12;
    const preview = await rpc("preview_batch_edit", [batch.id, payload]);
    assert.equal(preview.summary.stock_delta, 2);
    await rejects(() => rpc("preview_batch_edit", [batch.id, { ...payload, same_purchase_confirmed: false }]));
    await rejects(() => confirm(preview, " "));
    await confirm(preview);
    assert.equal(await balance(batch.item_id), 12);
    assert.equal(await stock(cat.variant), 12);
    const movements = await rows("select m.quantity,mt.direction from public.stock_movements m join public.movement_types mt on mt.code=m.movement_type where m.batch_item_id=$1 order by m.created_at,m.id", [batch.item_id]);
    assert.equal(movements.length, 2);
    assert.ok(movements.some((m) => m.quantity === 2 && m.direction === 1));
    assert.equal((await one("select quantity_purchased from public.batch_items where id=$1", [batch.item_id])).quantity_purchased, 12);
  });

  await test("Caso 3: redução considera vendas e perdas e bloqueia saldo negativo", async () => {
    const f = await fixture({ quantity: 6 });
    await db.query("insert into public.stock_movements(product_id,variant_id,movement_type,quantity,batch_id,batch_item_id) values ($1,$2,'AJUSTE_SAIDA',2,$3,$4)", [f.product, f.variant, f.source.id, f.source.item_id]);
    const payload = await editPayload(f.source);
    payload.items[0].quantity = 7;
    const stockBefore = await stock(f.variant);
    await rejects(() => rpc("preview_batch_edit", [f.source.id, payload]));
    assert.equal(await stock(f.variant), stockBefore);
    assert.equal(await balance(f.source.item_id), 2);
  });

  await test("Casos 4–5: venda posterior muda para lote anterior sem duplicar baixa ou faturamento", async () => {
    const f = await fixture();
    const before = await finance(f.sold.id);
    const total = await stock(f.variant);
    await confirm(await previewMove(f));
    assert.equal(await balance(f.source.item_id), 8);
    assert.equal(await balance(f.destination.item_id), 9);
    assert.equal(await stock(f.variant), total);
    assert.deepEqual(await finance(f.sold.id), before);
    assert.equal((await one("select count(*)::int as n from public.sales where id=$1", [f.sold.id])).n, 1);
    assert.equal((await activeAllocations(f.sold.item.id)).reduce((n, a) => n + a.quantity, 0), 3);
    const audit = await rows("select * from public.audit_logs where entity_id in ($1,$2,$3) and action not in ('purchase.created','sale.created')", [f.source.id, f.destination.id, f.sold.id]);
    assert.ok(audit.length > 0, "Correction audit must identify the sale or involved batches");
    assert.ok(audit.some((a) => a.user_id === admin));
    assert.ok(audit.every((a) => a.metadata.reason && a.metadata.before && a.metadata.after && a.metadata.summary));
    assert.ok(audit.some((a) => a.entity_id === f.sold.id));
    assert.ok(audit.some((a) => a.entity_id === f.destination.id));
    assert.ok(audit.some((a) => a.entity_id === f.source.id));
  });

  await test("Caso 6: venda de dois lotes preserva parcela não selecionada e histórico", async () => {
    const cat = await catalog();
    const source = await purchase(cat.variant, 1, 100, "2026-10-02");
    const second = await purchase(cat.variant, 2, 101, "2026-10-03");
    const sold = await sale(cat.variant);
    const destination = await purchase(cat.variant, 10, 105, "2026-10-01");
    const allocations = await activeAllocations(sold.item.id);
    const allocation = allocations.find((a) => a.batch_item_id === source.item_id);
    const untouched = allocations.find((a) => a.batch_item_id === second.item_id);
    await confirm(await previewMove({ destination, sold, allocation }));
    const active = await activeAllocations(sold.item.id);
    assert.equal(active.length, 2);
    assert.deepEqual(active.find((a) => a.id === untouched.id), untouched);
    assert.equal(active.reduce((n, a) => n + a.quantity, 0), sold.item.quantity);
    assert.ok((await one("select reversed_at from public.sale_item_batch_allocations where id=$1", [allocation.id])).reversed_at);
    assert.equal((await one("select status from public.purchase_batches where id=$1", [source.id])).status, "ABERTO");
  });

  await test("Caso 7: prévia mostra diferença de custo e altera somente uma unidade", async () => {
    const f = await fixture();
    const before = await finance(f.sold.id);
    const preview = await previewMove(f);
    assert.ok(preview.summary.changes.some((change) => change.unit === "money" && Number(change.before) !== Number(change.after)), "Cost impact must be visible before confirmation");
    await confirm(preview);
    const item = await one("select * from public.sale_items where id=$1", [f.sold.item.id]);
    assert.equal(Number(item.line_cost), 305);
    assert.equal(Number(item.line_father_profit), 70);
    assert.equal(Number(item.line_profit), 75);
    assert.deepEqual(await finance(f.sold.id), before);
    const active = await activeAllocations(item.id);
    assert.equal(active.find((a) => a.batch_item_id === f.source.item_id).quantity, 2);
    assert.equal(Number(active.find((a) => a.batch_item_id === f.source.item_id).unit_cost), 100);
  });

  await test("Caso 8: venda antiga sem lote com saída existente mantém baixa única", async () => {
    const cat = await catalog();
    await db.query("insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date) values ($1,$2,'ENTRADA',10,'2026-09-01')", [cat.product, cat.variant]);
    const sold = await sale(cat.variant);
    const destination = await purchase(cat.variant, 10, 105);
    assert.equal((await activeAllocations(sold.item.id)).length, 0);
    const before = await stock(cat.variant);
    const financial = await finance(sold.id);
    await confirm(await previewMove({ destination, sold }));
    assert.equal(await stock(cat.variant), before);
    assert.equal(await balance(destination.item_id), 9);
    assert.deepEqual(await finance(sold.id), financial);
    assert.equal(Number((await one("select line_cost from public.sale_items where id=$1", [sold.item.id])).line_cost), 305);
    await rpc("cancel_sale", [sold.id, "Conferir devoluções após classificação parcial"]);
    assert.equal(await stock(cat.variant), before + 3);
    assert.equal(await balance(destination.item_id), 10);
  });

  await test("Caso 9: saldo consumido entre prévia e confirmação bloqueia tudo", async () => {
    const f = await fixture({ destinationQuantity: 1 });
    const preview = await previewMove(f);
    await db.query("insert into public.stock_movements(product_id,variant_id,movement_type,quantity,batch_id,batch_item_id) values ($1,$2,'AJUSTE_SAIDA',1,$3,$4)", [f.product, f.variant, f.destination.id, f.destination.item_id]);
    const before = await activeAllocations(f.sold.item.id);
    const total = await stock(f.variant);
    await rejects(() => confirm(preview));
    assert.deepEqual(await activeAllocations(f.sold.item.id), before);
    assert.equal(await balance(f.source.item_id), 7);
    assert.equal(await stock(f.variant), total);
  });

  await test("Caso 10: duplo clique/reenvio aplica uma vez e retorna o mesmo lote", async () => {
    const f = await fixture();
    const preview = await previewMove(f);
    const first = await confirm(preview);
    const state = await rows("select * from public.stock_movements where sale_id=$1 order by id", [f.sold.id]);
    assert.equal(await confirm(preview), first);
    assert.deepEqual(await rows("select * from public.stock_movements where sale_id=$1 order by id", [f.sold.id]), state);
    assert.equal((await activeAllocations(f.sold.item.id)).reduce((n, a) => n + a.quantity, 0), 3);
  });

  await test("Caso 11: CONSULTAS não edita por RPC, confirmação roubada ou escrita direta", async () => {
    const f = await fixture();
    const payload = await editPayload(f.destination, { notes: "Alteração proibida" });
    const preview = await previewMove(f);
    await rejects(() => rpc("preview_batch_edit", [f.destination.id, payload], viewer));
    await rejects(() => previewMove(f, 1, viewer));
    await rejects(() => confirm(preview, "Tentativa por CONSULTAS", viewer));
    await rejects(() => asUser(viewer, "update public.purchase_batches set notes='proibido' where id=$1", [f.destination.id]));
    await rejects(() => asUser(viewer, "update public.batch_items set quantity_purchased=100 where id=$1", [f.destination.item_id]));
    assert.equal(await balance(f.destination.item_id), 10);
    // A future role with generic writing rights is still not ADMIN.
    await db.query("update public.profiles set role_code='writer_test' where id=$1", [viewer]);
    await rejects(() => rpc("preview_batch_edit", [f.destination.id, payload], viewer));
    await rejects(() => previewMove(f, 1, viewer));
    await db.query("update public.profiles set role_code='viewer' where id=$1", [viewer]);
  });

  await test("Adição omitida da mesma compra usa o lote existente e uma entrada exata", async () => {
    const cat = await catalog();
    const batch = await purchase(cat.variant);
    const payload = await editPayload(batch);
    payload.items.push({ variant_id: cat.otherVariant, quantity: 2, unit_cost: 98 });
    await confirm(await rpc("preview_batch_edit", [batch.id, payload]));
    assert.equal((await one("select count(*)::int as n from public.batch_items where batch_id=$1", [batch.id])).n, 2);
    assert.equal(await stock(cat.otherVariant), 2);
    assert.equal((await one("select total_purchased from public.batch_overview where batch_id=$1", [batch.id])).total_purchased, 12);
  });

  await test("Itens com histórico não mudam sabor nem custo histórico silenciosamente", async () => {
    const f = await fixture();
    const payload = await editPayload(f.source);
    payload.items[0].variant_id = f.otherVariant;
    await rejects(() => rpc("preview_batch_edit", [f.source.id, payload]));
    payload.items[0].variant_id = f.variant;
    payload.items[0].unit_cost = 110;
    await rejects(() => rpc("preview_batch_edit", [f.source.id, payload]));
    payload.items = [];
    await rejects(() => rpc("preview_batch_edit", [f.source.id, payload]));
    assert.equal(Number((await one("select line_cost from public.sale_items where id=$1", [f.sold.item.id])).line_cost), 300);
  });

  await test("Correção exige sabor exato, cronologia válida e lote manualmente aberto", async () => {
    const f = await fixture();
    const other = await purchase(f.otherVariant, 10);
    await rejects(() => rpc("preview_sale_batch_correction", [other.id, f.sold.item.id, f.allocation.id, 1, other.item_id]));
    const future = await purchase(f.variant, 10, 105, "2026-10-15");
    await rejects(() => rpc("preview_sale_batch_correction", [future.id, f.sold.item.id, f.allocation.id, 1, future.item_id]));
    const payload = await editPayload(f.source, { purchase_date: "2026-10-15" });
    await rejects(() => rpc("preview_batch_edit", [f.source.id, payload]));
    await db.query("update public.purchase_batches set status='FINALIZADO' where id=$1", [f.destination.id]);
    const closedPayload = await editPayload(f.destination);
    await rejects(() => rpc("preview_batch_edit", [f.destination.id, closedPayload]));
    await rejects(() => previewMove(f));
  });

  await test("Venda conciliada bloqueia correção e cancelamento continua devolvendo a origem corrigida", async () => {
    const f = await fixture();
    await db.query("update public.sales set transfer_paid=true,transfer_paid_at=now(),transfer_paid_by=$2 where id=$1", [f.sold.id, admin]);
    await rejects(() => previewMove(f));
    await db.query("update public.sales set transfer_paid=false,transfer_paid_at=null,transfer_paid_by=null where id=$1", [f.sold.id]);
    await confirm(await previewMove(f));
    const total = await stock(f.variant);
    await rpc("cancel_sale", [f.sold.id, "Conferir devoluções depois da correção"]);
    assert.equal(await stock(f.variant), total + 3);
    assert.equal(await balance(f.source.item_id), 10);
    assert.equal(await balance(f.destination.item_id), 10);
    assert.equal((await activeAllocations(f.sold.item.id)).length, 0);
  });

  await test("Editar venda depois da correção estorna todas as parcelas uma vez", async () => {
    const f = await fixture();
    await confirm(await previewMove(f));
    const total = await stock(f.variant);
    await rpc("update_sale", [f.sold.id, { quantity: 2 }]);
    assert.equal(await stock(f.variant), total + 1);
    assert.equal((await activeAllocations(f.sold.item.id)).reduce((n, a) => n + a.quantity, 0), 2);
    await rpc("cancel_sale", [f.sold.id, "Conferir edição e cancelamento"]);
    assert.equal(await balance(f.source.item_id) + await balance(f.destination.item_id), 20);
  });

  await test("Prévia obsoleta após alteração cadastral não sobrescreve edição posterior", async () => {
    const f = await fixture();
    const first = await rpc("preview_batch_edit", [f.destination.id, await editPayload(f.destination, { notes: "Primeira prévia" })]);
    const second = await rpc("preview_batch_edit", [f.destination.id, await editPayload(f.destination, { notes: "Edição posterior" })]);
    await confirm(second);
    await rejects(() => confirm(first));
    assert.equal((await one("select notes from public.purchase_batches where id=$1", [f.destination.id])).notes, "Edição posterior");
  });

  await test("Prévia de custo obsoleta e falha na auditoria desfazem a transação completa", async () => {
    const f = await fixture();
    const preview = await previewMove(f);
    await db.query("update public.batch_items set unit_cost=106 where id=$1", [f.destination.item_id]);
    await rejects(() => confirm(preview));
    const fresh = await previewMove(f);
    const before = await activeAllocations(f.sold.item.id);
    const total = await stock(f.variant);
    await db.exec(`create function public.integration_reject_audit() returns trigger language plpgsql as $$begin raise exception 'Injected audit failure'; end;$$;
      create trigger integration_audit_failure before insert on public.audit_logs for each row execute function public.integration_reject_audit()`);
    try {
      await rejects(() => confirm(fresh));
    } finally {
      await db.exec("drop trigger integration_audit_failure on public.audit_logs; drop function public.integration_reject_audit()");
    }
    assert.deepEqual(await activeAllocations(f.sold.item.id), before);
    assert.equal(await stock(f.variant), total);
    await confirm(fresh);
    assert.equal(await balance(f.destination.item_id), 9);
  });

  await test("Venda sem lote com custo histórico desconhecido ou saída sem comprovação bloqueia", async () => {
    const cat = await catalog();
    await db.query("insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date) values ($1,$2,'ENTRADA',10,'2026-09-01')", [cat.product, cat.variant]);
    const sold = await sale(cat.variant);
    const destination = await purchase(cat.variant);
    const total = await stock(cat.variant);
    // Reproduce a pre-snapshot historical row, which migration 004 deliberately
    // preserves with unknown costs. Fixture setup bypasses the newer triggers.
    await db.exec("alter table public.sale_items disable trigger sale_items_cost_snapshot; alter table public.sale_items disable trigger sale_items_cost_totals");
    await db.query("update public.sale_items set cost_price_unit=null,line_cost=null,line_father_profit=null where id=$1", [sold.item.id]);
    await db.exec("alter table public.sale_items enable trigger sale_items_cost_snapshot; alter table public.sale_items enable trigger sale_items_cost_totals");
    await rejects(() => previewMove({ destination, sold }));
    await db.query("update public.sale_items set line_cost=300 where id=$1", [sold.item.id]);
    await db.query("delete from public.stock_movements where sale_id=$1 and movement_type='VENDA'", [sold.id]);
    const withoutDebit = await stock(cat.variant);
    await rejects(() => previewMove({ destination, sold }));
    assert.equal(await stock(cat.variant), withoutDebit);
    assert.equal(withoutDebit, total + 3);
    assert.equal((await activeAllocations(sold.item.id)).length, 0);
  });

  await test("Venda legada com duas linhas do mesmo sabor comprova o total e corrige cada parcela", async () => {
    const cat = await catalog();
    await db.query("insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date) values ($1,$2,'ENTRADA',10,'2026-09-01')", [cat.product, cat.variant]);
    const id = await rpc("create_sale", [{ sale_date: "2026-10-10", customer_name: "Duas linhas legadas", customer_type_id: customerType, payment_status_id: paymentStatus,
      items: [{ variant_id: cat.variant, quantity: 3 }, { variant_id: cat.variant, quantity: 4 }] }]);
    const items = await rows("select * from public.sale_items where sale_id=$1 order by quantity", [id]);
    const destination = await purchase(cat.variant, 10, 105);
    const total = await stock(cat.variant);
    for (const item of items) {
      await confirm(await previewMove({ destination, sold: { id, item } }, item.quantity));
      assert.equal((await activeAllocations(item.id)).reduce((n, a) => n + a.quantity, 0), item.quantity);
      assert.equal(await stock(cat.variant), total);
      assert.equal(Number((await one("select line_cost from public.sale_items where id=$1", [item.id])).line_cost), item.quantity * 105);
    }
    assert.equal(await balance(destination.item_id), 3);
    await rejects(() => previewMove({ destination, sold: { id, item: items[0] } }));
    await rpc("cancel_sale", [id, "Devolver as duas linhas classificadas"]);
    assert.equal(await stock(cat.variant), total + 7);
    assert.equal(await balance(destination.item_id), 10);
  });

  await test("Duas linhas do mesmo sabor no lote legado validam a soma das reclassificações", async () => {
    const cat = await catalog();
    await db.query("insert into public.stock_movements(product_id,variant_id,movement_type,quantity,movement_date) values ($1,$2,'ENTRADA',10,'2026-09-01')", [cat.product, cat.variant]);
    const id = await rpc("create_legacy_batch", [{ items: [{ variant_id: cat.variant, quantity: 3, unit_cost: 100 }, { variant_id: cat.variant, quantity: 4, unit_cost: 100 }] }]);
    const batch = await one("select * from public.purchase_batches where id=$1", [id]);
    const payload = await editPayload(batch);
    for (const item of payload.items) item.quantity += 2;
    // Each +2 would fit in the unassigned balance 3, but the aggregate +4 does not.
    await rejects(() => rpc("preview_batch_edit", [id, payload]));
    payload.items[0].quantity -= 1;
    await confirm(await rpc("preview_batch_edit", [id, payload]));
    assert.equal(await stock(cat.variant), 10);
    assert.equal((await one("select quantity_remaining from public.batch_overview where batch_id=$1", [id])).quantity_remaining, 10);
    // No unassigned stock remains. A +1/-1 correction among duplicated flavor
    // rows is nevertheless valid because its aggregate reclassification is zero.
    payload.items[0].quantity += 1;
    payload.items[1].quantity -= 1;
    await confirm(await rpc("preview_batch_edit", [id, payload]));
    assert.equal(await stock(cat.variant), 10);
    assert.equal((await one("select quantity_remaining from public.batch_overview where batch_id=$1", [id])).quantity_remaining, 10);
  });

  await test("Funções internas de correção não concedem EXECUTE ao perfil autenticado", async () => {
    const helpers = await rows(`select p.oid::regprocedure::text as signature,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as allowed
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like '%batch%correction%'
        or p.proname like '%batch%edit%' or p.proname like '%sale%batch%')
        and p.proname not in ('preview_batch_edit','preview_sale_batch_correction','confirm_batch_correction')`);
    for (const helper of helpers) {
      assert.equal(helper.allowed, false, `Internal helper exposed: ${helper.signature}`);
    }
    assert.ok(helpers.length >= 4, "Helper privilege check must inspect the correction helpers");
  });

  await test("Prévia é imutável, restrita ao ADMIN responsável e não pode ser forjada", async () => {
    const f = await fixture();
    const preview = await previewMove(f);
    assert.equal((await asUser(viewer, "select id from public.batch_correction_requests where id=$1", [preview.request_id])).length, 0);
    assert.equal((await asUser(admin, "select id from public.batch_correction_requests where id=$1", [preview.request_id])).length, 1);
    await rejects(() => asUser(admin, "update public.batch_correction_requests set payload='{}'::jsonb where id=$1", [preview.request_id]));
    await confirm(preview);
    assert.equal((await asUser(viewer, "select id from public.audit_logs where action in ('batch.entry_corrected','batch.allocation_corrected','sale.batch_corrected')")).length, 0);
    assert.ok((await asUser(admin, "select id from public.audit_logs where entity_id=$1 and action='sale.batch_corrected'", [f.sold.id])).length > 0);
    await rejects(() => db.query("update public.batch_correction_requests set reason='alterada' where id=$1", [preview.request_id]));
    const movement = await one("select id from public.stock_movements where sale_id=$1 and movement_type='REALOCACAO_CONSUMO'", [f.sold.id]);
    await rejects(() => db.query("delete from public.stock_movements where id=$1", [movement.id]));
    await rejects(() => db.query("update public.stock_movements set quantity=2 where id=$1", [movement.id]));
  });

  await test("Correção reabre origem esgotada e finaliza destino sem liberar edição manual", async () => {
    const f = await fixture({ sourceQuantity: 3, destinationQuantity: 1 });
    assert.equal((await one("select status from public.purchase_batches where id=$1", [f.source.id])).status, "FINALIZADO");
    await confirm(await previewMove(f));
    assert.equal((await one("select status from public.purchase_batches where id=$1", [f.source.id])).status, "ABERTO");
    assert.equal((await one("select status from public.purchase_batches where id=$1", [f.destination.id])).status, "FINALIZADO");
    const payload = await editPayload(f.destination);
    await rejects(() => rpc("preview_batch_edit", [f.destination.id, payload]));
    assert.equal(await balance(f.source.item_id), 1);
    assert.equal(await balance(f.destination.item_id), 0);
  });

  await test("Observação de lote com venda antiga fora da cronologia não altera nem força datas", async () => {
    const cat = await catalog();
    const batch = await purchase(cat.variant, 10, 100, "2026-10-05");
    // The unchanged FIFO behavior historically allowed entering a backdated
    // sale. A metadata-only correction must preserve that existing history.
    const sold = await sale(cat.variant, 3, "2026-10-01");
    const before = await finance(sold.id);
    const payload = await editPayload(batch, { notes: "Conferência de informação antiga" });
    await confirm(await rpc("preview_batch_edit", [batch.id, payload]));
    assert.deepEqual(await finance(sold.id), before);
    assert.equal(await balance(batch.item_id), 7);
    payload.purchase_date = "2026-10-06";
    await rejects(() => rpc("preview_batch_edit", [batch.id, payload]));
  });

  await test("Divergência entre baixa comprovada e alocação da origem bloqueia correção", async () => {
    const f = await fixture();
    await db.query("update public.stock_movements set quantity=2 where sale_id=$1 and movement_type='VENDA' and batch_item_id=$2", [f.sold.id, f.source.item_id]);
    const before = await activeAllocations(f.sold.item.id);
    const total = await stock(f.variant);
    await rejects(() => previewMove(f));
    assert.deepEqual(await activeAllocations(f.sold.item.id), before);
    assert.equal(await stock(f.variant), total);
  });

  console.log(`${checks} integration checks passed using disposable PostgreSQL (${fileURLToPath(migrationDirectory)}).`);
} catch (error) {
  console.error(error.stack?.split("\n").slice(0, 6).join("\n") ?? error);
  if (error.detail) console.error(`Detail: ${error.detail}`);
  if (error.where) console.error(`Context: ${error.where}`);
  if (error.position) console.error(`SQL position: ${error.position}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
