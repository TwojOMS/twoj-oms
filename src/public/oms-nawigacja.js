// Menu rozwijane: `data-menu` (konto, nawigacja główna) oraz `.wydruki` (karta zamówienia i pasek
// akcji listy). Inne `<details>` w panelu (komentarz wewnętrzny, `.drobne`, metodologia, akordeon
// akcji magazynu) to treść, nie menu — nie wolno ich zamykać kliknięciem obok.
export const SELEKTOR_MENU = 'details[data-menu], details.wydruki';
const POZYCJA_WYDRUKOW = '.wydruki-menu a, .wydruki-menu button';

export function podlaczMenu(root = document) {
  const menu = [...root.querySelectorAll(SELEKTOR_MENU)];

  const zamknijPozostale = (otwarte) => {
    if (!otwarte.open) return;
    for (const element of menu) if (element !== otwarte) element.open = false;
  };
  const zamknijPoza = (event) => {
    const wewnatrz = menu.find((element) => element.contains(event.target));
    if (!wewnatrz) {
      for (const element of menu) element.open = false;
      return;
    }
    // Wybór pozycji wydruku zamyka menu, ale dopiero po obsłudze kliknięcia (setTimeout): link
    // z `target=_blank` i przycisk z `formaction`/`formtarget` wykonują się PO nim, a przycisk
    // w zamkniętym `<details>` jest ukryty. Zdarzenia nie przechwytujemy.
    if (event.target.closest?.(POZYCJA_WYDRUKOW)) setTimeout(() => { wewnatrz.open = false; }, 0);
  };
  const zamknijEscape = (event) => {
    if (event.key !== 'Escape') return;
    const otwarte = menu.find((element) => element.open);
    if (!otwarte) return;
    otwarte.open = false;
    otwarte.querySelector('summary')?.focus();
    event.preventDefault();
  };

  const obslugaOtwarcia = new Map(menu.map((element) => [
    element, () => zamknijPozostale(element),
  ]));
  for (const element of menu) element.addEventListener('toggle', obslugaOtwarcia.get(element));
  root.addEventListener('click', zamknijPoza);
  root.addEventListener('keydown', zamknijEscape);

  return () => {
    root.removeEventListener('click', zamknijPoza);
    root.removeEventListener('keydown', zamknijEscape);
    for (const element of menu) element.removeEventListener('toggle', obslugaOtwarcia.get(element));
  };
}

if (typeof document !== 'undefined') podlaczMenu(document);
