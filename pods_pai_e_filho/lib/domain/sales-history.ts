export const SALES_HISTORY_PAGE_SIZE = 50;

const FILTER_NAMES = [
  "de", "ate", "cliente", "lote", "produto", "tipo", "status", "fiado", "ice", "sabor", "situacao",
] as const;

export function normalizeSalesHistoryParams(raw: Record<string, string | string[] | undefined>) {
  const params: Record<string, string | undefined> = {};
  for (const name of [...FILTER_NAMES, "pagina"]) {
    const value = raw[name];
    params[name] = Array.isArray(value) ? value[0] : value;
  }
  return params;
}

export function parseSalesHistoryPage(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  // Both endpoints of the database range must remain safe integers.
  return page >= 1 && Number.isSafeInteger(page * SALES_HISTORY_PAGE_SIZE) ? page : 1;
}

export function salesHistoryHref(params: Record<string, string | undefined>, page: number) {
  const query = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = params[name];
    if (name === "lote" && value === "") query.set(name, "todos");
    else if (value) query.set(name, value);
  }
  if (page > 1) query.set("pagina", String(page));
  const search = query.toString();
  return search ? `/vendas?${search}` : "/vendas";
}
