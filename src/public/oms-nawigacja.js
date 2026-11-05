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

// PRZ-152.G8 — „kopiuj numer" na karcie paczki. W HTML przycisk ma `hidden`: bez JS numer zaznacza się
// ręcznie. Clipboard API działa tylko w bezpiecznym kontekście (https, localhost); panel w sieci lokalnej
// po http dostaje zapasowe `execCommand('copy')` na tymczasowym polu.
const czasPotwierdzenia = 1500;

function kopiujZapasowo(tekst) {
  const pole = document.createElement('textarea');
  pole.value = tekst;
  pole.setAttribute('readonly', '');
  pole.style.position = 'fixed';
  pole.style.opacity = '0';
  document.body.append(pole);
  pole.select();
  try { return document.execCommand('copy'); } finally { pole.remove(); }
}

export function podlaczKopiowanie(root = document) {
  const api = typeof navigator !== 'undefined' && navigator.clipboard?.writeText;
  const zapas = typeof document !== 'undefined' && typeof document.execCommand === 'function';
  if (!api && !zapas) return;
  for (const przycisk of root.querySelectorAll('[data-kopiuj-numer]')) {
    const napis = przycisk.textContent;
    przycisk.hidden = false;
    przycisk.addEventListener('click', async () => {
      const numer = przycisk.dataset.kopiujNumer;
      let ok = false;
      try {
        if (api) { await navigator.clipboard.writeText(numer); ok = true; } else ok = kopiujZapasowo(numer);
      } catch { ok = false; }
      przycisk.textContent = ok ? 'Skopiowano' : 'Nie udało się — zaznacz numer';
      setTimeout(() => { przycisk.textContent = napis; }, czasPotwierdzenia);
    });
  }
}

if (typeof document !== 'undefined') {
  podlaczMenu(document);
  podlaczKopiowanie(document);
}
