import assert from "node:assert/strict";
import {
  buildWhatsAppPromotion,
  DEFAULT_PROMOTION_SETTINGS,
  formatProductIdentity,
  formatPromotionPuffs,
  getWhatsAppUrl,
  validatePromotionSettings,
} from "../lib/domain/promotion.ts";
import type { PromotionProduct, PromotionSnapshot, PromotionVariant } from "../lib/domain/promotion.ts";

function variant(name: string, quantity: number, isIce = false): PromotionVariant {
  return { id: name, name, quantity, is_ice: isIce };
}

function product(id: string, variants: PromotionVariant[], overrides: Partial<PromotionProduct> = {}): PromotionProduct {
  return {
    id,
    name: id,
    brand: "",
    model: "",
    promotion_name: null,
    approximate_puffs: 30000,
    promotion_features: [],
    display_order: null,
    total_quantity: variants.reduce((total, flavor) => total + (flavor.active === false ? 0 : flavor.quantity), 0),
    normal_price: "140.00",
    variants,
    ...overrides,
  };
}

function snapshot(products: PromotionProduct[], overrides: Partial<PromotionSnapshot> = {}): PromotionSnapshot {
  return { settings: { ...DEFAULT_PROMOTION_SETTINGS }, products, warnings: [], ...overrides };
}

function message(data: PromotionSnapshot) {
  const result = buildWhatsAppPromotion(data);
  assert.equal(result.ok, true);
  if (!result.ok || result.message == null) throw new Error("Esperada uma mensagem com estoque disponível.");
  return result.message;
}

const ignite = product("Pod 30k", [
  variant("Watermelon Mix", 1),
  variant("Watermelon", 1, true),
  variant("Strawberry Kiwi", 1),
  variant("Banana Coconut Water", 1),
  variant("Aloe Grape", 1, true),
  variant("Outro sabor", 0),
], { brand: "Ignite", model: "V300 Ultra Slim", promotion_features: ["2 Modos de Potência"], display_order: 1 });
const sheep = product("Pod 40k", [
  variant("Grape + Menthol", 1),
  variant("Grape + Grape Mango", 1),
  variant("Grape + Grape", 1),
], {
  brand: "The Black Sheep", model: "40K Dual Flavor", approximate_puffs: 40000,
  promotion_features: ["Dual Flavor", "3 Modos de Potência"], normal_price: "150.00", display_order: 2,
});

// Two available products use configured commercial fields and alphabetic flavors.
const complete = message(snapshot([sheep, ignite]));
assert.equal(complete, [
  "📦🔥 PODS DISPONÍVEIS 🔥📦",
  "━━━━━━━━━━━━━━━",
  "🔹 Pod 30k — IGNITE V300 ULTRA SLIM",
  "💰 R$ 140,00",
  "✅ 30K Puffs",
  "✅ 2 Modos de Potência",
  "🍓 Sabores:",
  "Aloe Grape Ice",
  "Banana Coconut Water",
  "Strawberry Kiwi",
  "Watermelon Ice",
  "Watermelon Mix",
  "",
  "━━━━━━━━━━━━━━━",
  "🔹 Pod 40k — THE BLACK SHEEP 40K DUAL FLAVOR",
  "💰 R$ 150,00",
  "✅ 40K Puffs",
  "✅ Dual Flavor",
  "✅ 3 Modos de Potência",
  "🍓 Sabores:",
  "Grape + Grape",
  "Grape + Grape Mango",
  "Grape + Menthol",
  "",
  "━━━━━━━━━━━━━━━",
  "📍 Entrega grátis para Frederico Westphalen",
  "🔥 Produtos com pronta entrega",
].join("\n"));

// Sold-out products and flavors never appear, including after a new snapshot.
const soldOutSheep = { ...sheep, total_quantity: 0, variants: sheep.variants.map((flavor) => ({ ...flavor, quantity: 0 })) };
assert.ok(!message(snapshot([ignite, soldOutSheep])).includes("THE BLACK SHEEP"));
const flavors = message(snapshot([product("Sabores", [variant("Watermelon", 1), variant("Grape", 0, true), variant("Strawberry", 2)])]));
assert.ok(flavors.includes("🍓 Sabores:\nStrawberry\nWatermelon"));
assert.ok(!flavors.includes("Grape"));
const afterSale = message(snapshot([{ ...ignite, variants: ignite.variants.map((flavor) => flavor.id === "Watermelon" ? { ...flavor, quantity: 0 } : flavor), total_quantity: 4 }]));
assert.ok(!afterSale.includes("Watermelon Ice"));
assert.ok(complete.includes("Watermelon Ice"));

// Ice flag does not duplicate suffixes, including legacy repeated trailing Ice.
const ice = message(snapshot([product("Ice", [variant("Aloe Grape", 1, true), variant("Grape Ice", 1, true), variant("Banana Ice Ice", 1, true), variant("Grape", 1)])]));
assert.ok(ice.includes("Aloe Grape Ice"));
assert.ok(ice.includes("\nGrape\nGrape Ice"));
assert.ok(!ice.includes("Ice Ice"));

// No stock produces no sendable message; negative balances remain internal warnings.
assert.deepEqual(buildWhatsAppPromotion(snapshot([soldOutSheep])), { ok: true, message: null, warnings: [] });
const warnings = ["Estoque negativo em Inconsistente · Uva. Confira as movimentações em Estoque."];
const inconsistent = buildWhatsAppPromotion(snapshot([
  product("Inconsistente", [variant("Uva", -3), variant("Morango", 2)]),
  product("Disponível", [variant("Negativo", -1), variant("Positivo", 3)]),
], { warnings }));
assert.equal(inconsistent.ok, true);
if (inconsistent.ok) {
  assert.deepEqual(inconsistent.warnings, warnings);
  assert.ok(inconsistent.message?.includes("Disponível"));
  assert.ok(!inconsistent.message?.includes("Inconsistente"));
  assert.ok(!inconsistent.message?.includes("Negativo"));
  assert.ok(!inconsistent.message?.includes(warnings[0]));
}

// Inactive records remain excluded, and empty variants cannot make a block.
const inactive = message(snapshot([
  { ...sheep, active: false },
  product("Ativo", [{ ...variant("Sabor inativo", 8), active: false }, variant("Ativo", 1)]),
  product("Sem sabores", [], { total_quantity: 10 }),
]));
assert.ok(!inactive.includes("THE BLACK SHEEP"));
assert.ok(!inactive.includes("Sabor inativo"));
assert.ok(!inactive.includes("Sem sabores"));

// An active Normal price is mandatory; no other monetary data can be substituted.
for (const missing of [null, -1, "-5", "NaN", Infinity, "", "140,00"]) {
  const result = buildWhatsAppPromotion(snapshot([{ ...ignite, normal_price: missing }]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.message.includes("tipo de cliente Normal"));
}
assert.ok(message(snapshot([{ ...ignite, normal_price: 0 }])).includes("💰 R$ 0,00"));
const extraInternalFields = {
  ...ignite, cost_price: 88.67, father_transfer: 100.21, unit_profit: 39.79,
  friend_price: 120.12, customer_name: "Cliente secreto", is_credit: true,
};
const safe = message(snapshot([extraInternalFields]));
assert.ok(safe.includes("💰 R$ 140,00"));
for (const privateValue of ["88,67", "100,21", "39,79", "120,12", "Cliente secreto", "Fiado", "unidade", "— 1"]) assert.ok(!safe.includes(privateValue));

// Custom product order takes priority; fallback order and flavor order ignore quantity.
const ordering = message(snapshot([
  product("Zebra", [variant("Zulu", 100), variant("Alpha", 1)]),
  product("Beta", [variant("Teste", 1)], { display_order: 0 }),
  product("Alfa", [variant("Teste", 1)]),
]));
assert.ok(ordering.indexOf("🔹 Beta") < ordering.indexOf("🔹 Alfa"));
assert.ok(ordering.indexOf("🔹 Alfa") < ordering.indexOf("🔹 Zebra"));
assert.ok(ordering.indexOf("\nAlpha") < ordering.indexOf("\nZulu"));
assert.equal(formatPromotionPuffs(30500), "30,5K Puffs");
assert.equal(formatPromotionPuffs(900), "900 Puffs");
assert.equal(formatPromotionPuffs(null), null);

// Product identity centralizes name + brand + model, skipping empty or duplicated pieces.
assert.equal(formatProductIdentity("Pod 30k", "Ignite", "V300 Ultra Slim"), "Pod 30k — IGNITE V300 ULTRA SLIM");
assert.equal(formatProductIdentity("Pod 40k", "The Black Sheep", "40K Dual Flavor"), "Pod 40k — THE BLACK SHEEP 40K DUAL FLAVOR");
assert.equal(formatProductIdentity("Pod 30k", "Ignite", null), "Pod 30k — IGNITE");
assert.equal(formatProductIdentity("Pod 30k", "", ""), "Pod 30k");
assert.equal(formatProductIdentity("Pod 30k", null, undefined), "Pod 30k");
assert.equal(formatProductIdentity("Pod 30k", "  ", "  "), "Pod 30k");
assert.equal(formatProductIdentity("IGNITE V300 ULTRA SLIM", "Ignite", "V300 Ultra Slim"), "IGNITE V300 ULTRA SLIM");
assert.equal(formatProductIdentity("Pod 30k Ignite", "Ignite", "V300 Ultra Slim"), "Pod 30k Ignite — V300 ULTRA SLIM");
assert.ok(!formatProductIdentity("Pod 30k", "Ignite", "V300 Ultra Slim").includes("null"));
assert.ok(!formatProductIdentity("Pod 30k", "Ignite", "V300 Ultra Slim").includes("undefined"));

// A product without brand/model keeps working and shows only the registered name.
const noBrandModel = message(snapshot([product("Simples", [variant("Teste", 1)])]));
assert.ok(noBrandModel.includes("🔹 Simples\n"));
// A product with brand but no model shows "Name — BRAND" without stray separators.
const brandOnly = message(snapshot([product("Com marca", [variant("Teste", 1)], { brand: "Ignite" })]));
assert.ok(brandOnly.includes("🔹 Com marca — IGNITE\n"));
// Preview, copy and WhatsApp share all read from the same buildWhatsAppPromotion message,
// so brand/model changes in the catalog are reflected the next time it is generated.
const beforeBrandChange = message(snapshot([product("Atualiza", [variant("Teste", 1)], { brand: "Antigo" })]));
assert.ok(beforeBrandChange.includes("🔹 Atualiza — ANTIGO\n"));
const afterBrandChange = message(snapshot([product("Atualiza", [variant("Teste", 1)], { brand: "Novo" })]));
assert.ok(afterBrandChange.includes("🔹 Atualiza — NOVO\n"));
// A custom commercial name (promotion_name) still gets brand/model appended.
const customName = message(snapshot([product("Interno", [variant("Teste", 1)], {
  promotion_name: "Nome Comercial", brand: "Marca", model: "Modelo X",
})]));
assert.ok(customName.includes("🔹 Nome Comercial — MARCA MODELO X\n"));

// Header/footer are configurable plain text, with bounded inputs and legacy HTML blocked.
const custom = message(snapshot([ignite], { settings: { header: "Novidades 🥳", footer: "📍 São Paulo\nPeça já!" } }));
assert.ok(custom.startsWith("Novidades 🥳\n"));
assert.ok(custom.endsWith("📍 São Paulo\nPeça já!"));
assert.equal(validatePromotionSettings({ header: "", footer: "" }).ok, false);
assert.equal(validatePromotionSettings({ header: "A".repeat(201), footer: "" }).ok, false);
assert.equal(validatePromotionSettings({ header: "A", footer: "B".repeat(2001) }).ok, false);
assert.equal(validatePromotionSettings({ header: "<strong>Oi</strong>", footer: "" }).ok, false);
assert.equal(validatePromotionSettings({ header: "A", footer: "<br>" }).ok, false);
assert.equal(buildWhatsAppPromotion(snapshot([{ ...ignite, promotion_features: ["<b>Dual Flavor</b>"] }])).ok, false);
assert.equal(buildWhatsAppPromotion(snapshot([{ ...ignite, variants: [variant("<script>Flavor</script>", 1)] }])).ok, false);
assert.ok(!message(snapshot([ignite], { settings: { header: "Oi", footer: "" } })).endsWith("━━━━━━━━━━━━━━━"));

// WhatsApp round trip preserves exact content, emojis, accents, symbols and line breaks.
const url = new URL(getWhatsAppUrl(complete + "\nAçúcar & frutas + gelo #promo 100%"));
assert.equal(url.origin, "https://wa.me");
assert.equal(url.searchParams.get("text"), complete + "\nAçúcar & frutas + gelo #promo 100%");
assert.equal(url.searchParams.has("phone"), false);
assert.equal(url.pathname, "/");

console.log("check-promotion: ok");
