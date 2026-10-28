import { getFlavorDisplayName, normalizeFlavorName } from "./flavors.ts";

export type PromotionSettings = { header: string; footer: string };

export const DEFAULT_PROMOTION_SETTINGS: PromotionSettings = {
  header: "📦🔥 PODS DISPONÍVEIS 🔥📦",
  footer: "📍 Entrega grátis para Frederico Westphalen\n🔥 Produtos com pronta entrega",
};

export const PROMOTION_HEADER_MAX_LENGTH = 200;
export const PROMOTION_FOOTER_MAX_LENGTH = 2000;
export const EMPTY_PROMOTION_MESSAGE = "Nenhum produto disponível em estoque para divulgação.";
const SEPARATOR = "━━━━━━━━━━━━━━━";
const INVALID_TEXT = /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type PromotionVariant = {
  id: string;
  name: string;
  is_ice: boolean;
  quantity: number;
  active?: boolean;
};

/** Commercial snapshot only: never put costs, transfers, profits or customers here. */
export type PromotionProduct = {
  id: string;
  name: string;
  brand: string;
  model: string;
  promotion_name: string | null;
  approximate_puffs: number | null;
  promotion_features: string[];
  display_order: number | null;
  total_quantity: number;
  normal_price: string | number | null;
  variants: PromotionVariant[];
  active?: boolean;
};

export type PromotionSnapshot = {
  settings: PromotionSettings;
  products: PromotionProduct[];
  warnings: string[];
};

export type PromotionMessageResult =
  | { ok: true; message: string | null; warnings: string[] }
  | { ok: false; message: string };

export function validatePromotionSettings(input: unknown):
  | { ok: true; settings: PromotionSettings }
  | { ok: false; message: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "Configure o cabeçalho e o rodapé da mensagem em Configurações > Divulgação." };
  }
  const { header, footer } = input as Record<string, unknown>;
  if (typeof header !== "string" || typeof footer !== "string") {
    return { ok: false, message: "Informe um cabeçalho e um rodapé válidos." };
  }
  const settings = {
    header: header.replace(/\r\n?/g, "\n").trim(),
    footer: footer.replace(/\r\n?/g, "\n").trim(),
  };
  if (!settings.header || settings.header.length > PROMOTION_HEADER_MAX_LENGTH) {
    return { ok: false, message: `O cabeçalho deve ter entre 1 e ${PROMOTION_HEADER_MAX_LENGTH} caracteres.` };
  }
  if (settings.footer.length > PROMOTION_FOOTER_MAX_LENGTH) {
    return { ok: false, message: `O rodapé deve ter até ${PROMOTION_FOOTER_MAX_LENGTH} caracteres.` };
  }
  if (INVALID_TEXT.test(settings.header) || INVALID_TEXT.test(settings.footer)) {
    return { ok: false, message: "Utilize apenas texto, emojis e quebras de linha, sem HTML, no cabeçalho e no rodapé." };
  }
  return { ok: true, settings };
}

export function formatPromotionPuffs(puffs: number | null) {
  if (puffs == null || !Number.isInteger(puffs) || puffs <= 0) return null;
  return puffs >= 1000
    ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(puffs / 1000)}K Puffs`
    : `${new Intl.NumberFormat("pt-BR").format(puffs)} Puffs`;
}

function singleLine(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Centralizes the product identity shown in the preview, the copied text and the
 * WhatsApp share so the three never diverge: "Name — BRAND MODEL". Brand and/or
 * model are omitted when empty, and either piece already present in the name
 * (case-insensitive) is skipped to avoid repeating it.
 */
export function formatProductIdentity(
  name: string,
  brand: string | null | undefined,
  model: string | null | undefined,
) {
  const cleanName = singleLine(name ?? "");
  const normalizedName = cleanName.toUpperCase();
  const suffix = [brand, model]
    .map((value) => singleLine(value ?? ""))
    .filter((value) => value && !normalizedName.includes(value.toUpperCase()))
    .join(" ")
    .toUpperCase();
  return suffix ? `${cleanName} — ${suffix}` : cleanName;
}

function flavorName(variant: PromotionVariant) {
  return getFlavorDisplayName({
    name: normalizeFlavorName(singleLine(variant.name), variant.is_ice),
    is_ice: variant.is_ice,
  });
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "pt-BR", { sensitivity: "base", numeric: true })
    || left.localeCompare(right, "pt-BR");
}

function compareProducts(left: PromotionProduct, right: PromotionProduct) {
  if (left.display_order !== right.display_order) {
    if (left.display_order == null) return 1;
    if (right.display_order == null) return -1;
    return left.display_order - right.display_order;
  }
  return compareText(left.name, right.name) || compareText(left.id, right.id);
}

function normalPrice(value: PromotionProduct["normal_price"]) {
  if (value == null || (typeof value === "string" && !/^\d+(?:\.\d{1,2})?$/.test(value.trim()))) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format(amount).replace(/\u00a0/g, " ");
}

/** Each call formats the supplied fresh snapshot; no message or inventory is cached. */
export function buildWhatsAppPromotion(snapshot: PromotionSnapshot): PromotionMessageResult {
  const configuration = validatePromotionSettings(snapshot.settings);
  if (!configuration.ok) return configuration;
  const warnings = [...new Set(snapshot.warnings)];
  const products = snapshot.products
    .filter((product) => product.active !== false && Number.isFinite(product.total_quantity) && product.total_quantity > 0)
    .sort(compareProducts);
  const blocks: string[] = [];

  for (const product of products) {
    const variants = product.variants
      .filter((variant) => variant.active !== false && Number.isFinite(variant.quantity) && variant.quantity > 0)
      .sort((left, right) => compareText(flavorName(left), flavorName(right)) || compareText(left.id, right.id));
    if (variants.length === 0) continue;
    const name = formatProductIdentity(product.promotion_name?.trim() || product.name, product.brand, product.model);
    const features = product.promotion_features.map(singleLine).filter(Boolean);
    const flavors = variants.map(flavorName);
    if (!name || INVALID_TEXT.test(name) || features.some((feature) => INVALID_TEXT.test(feature))
      || flavors.some((flavor) => !flavor || INVALID_TEXT.test(flavor))) {
      return { ok: false, message: `Revise o nome, os sabores e as informações para divulgação de ${singleLine(product.name)}. Utilize texto sem HTML.` };
    }
    const price = normalPrice(product.normal_price);
    if (price == null) {
      return { ok: false, message: `Configure um preço de venda válido e ativo para o tipo de cliente Normal em ${singleLine(product.name)} antes de gerar a divulgação.` };
    }
    const puffs = formatPromotionPuffs(product.approximate_puffs);
    blocks.push([
      `🔹 ${name}`,
      `💰 ${price}`,
      ...(puffs ? [`✅ ${puffs}`] : []),
      ...features.map((feature) => `✅ ${feature}`),
      "🍓 Sabores:",
      ...flavors,
    ].join("\n"));
  }

  if (blocks.length === 0) return { ok: true, message: null, warnings };
  const { header, footer } = configuration.settings;
  const body = `${header}\n${SEPARATOR}\n${blocks.join(`\n\n${SEPARATOR}\n`)}`;
  return { ok: true, message: footer ? `${body}\n\n${SEPARATOR}\n${footer}` : body, warnings };
}

/** Recipient-free link. The user selects the contact/group and confirms the send. */
export function getWhatsAppUrl(message: string) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
