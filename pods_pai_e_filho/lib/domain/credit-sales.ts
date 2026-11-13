export const FIADOS_PAGE_SIZE = 50;

export function parseFiadosPage(value: string | string[] | undefined) {
  const pageValue = Array.isArray(value) ? value[0] : value;
  if (!pageValue || !/^\d+$/.test(pageValue)) return 1;
  const page = Number(pageValue);
  return page >= 1 && Number.isSafeInteger(page * FIADOS_PAGE_SIZE) ? page : 1;
}

export function fiadosHref(page: number) {
  if (page <= 1) return "/fiados";
  const query = new URLSearchParams({ pagina: String(page) });
  return `/fiados?${query.toString()}`;
}
