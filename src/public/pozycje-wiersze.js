// PRZ-103 (21.10.2026) — ekran „Nowe zamówienie”: wiersze pozycji i klawiatura przy „Dodaj z magazynu”.
//
// ⚠️ TO JEST UŁATWIENIE, NIE WARUNEK. „+ Dodaj wiersz” i „×” są przyciskami formularza
// z `formaction` — bez tego skryptu odsyłają formularz do /zamowienia/nowe/wiersz/* i wracają
// z wierszem więcej albo mniej (domena/nowe-zamowienie.js). Skrypt robi to samo bez przeładowania.
//
// ⚠️ ENTER. Domyślnym przyciskiem formularza jest ukryte „Załóż zamówienie” na górze ekranu
// (celowo — Enter w polu danych klienta ma zakładać zamówienie). Ale Enter w polu szukania
// magazynu zakładał przez to PUSTE zamówienie z nadanym numerem (sprawdzone 21.10 na demo:
// wpisane „lampa” + Enter = nowe R/…). W polu szukania Enter szuka, w polu ilości przy wyniku
// dodaje ten wynik.

export const SELEKTOR_WIERSZA = 'tr[data-wiersz-pozycji]';

/**
 * Pusty wiersz: wszystkie pola (także ukryta tożsamość produktu i cena sprzed rabatu) i suma linii.
 * Ilość wraca do 1 (PRZ-106) — tak wygląda nowy wiersz; wiersz z samą ilością liczy się jako pusty.
 */
export function wyczyscWiersz(tr) {
  tr.querySelectorAll('input').forEach((pole) => { pole.value = pole.name === 'poz_ilosc' ? '1' : ''; });
  // PRZ-105: lista stawek nowego wiersza wraca do domyślnej z Ustawień (data-vat formularza), a nie
  // zostaje przy stawce sklonowanego wiersza.
  const domyslna = typeof tr.closest === 'function' ? tr.closest('form')?.dataset?.vat : undefined;
  if (domyslna !== undefined) tr.querySelectorAll('select[name="poz_vat"]').forEach((l) => { l.value = domyslna; });
  if (tr.dataset) delete tr.dataset.zrodlo;
  const suma = tr.querySelector('[data-suma-linii]');
  if (suma) suma.textContent = '';
}

// Numer w przycisku „×” to indeks wiersza dla drogi bez skryptu — po każdej zmianie od nowa.
export function ponumeruj(tbody) {
  Array.from(tbody.querySelectorAll(SELEKTOR_WIERSZA)).forEach((tr, i) => {
    const przycisk = tr.querySelector('[data-usun-wiersz]');
    if (!przycisk) return;
    przycisk.value = String(i);
    przycisk.setAttribute('aria-label', `Usuń wiersz ${i + 1}`);
  });
}

/** Dokłada pusty wiersz na końcu (kopia ostatniego, wyczyszczona) i go oddaje. */
export function dodajWiersz(tbody) {
  const wiersze = tbody.querySelectorAll(SELEKTOR_WIERSZA);
  const wzor = wiersze[wiersze.length - 1];
  if (!wzor) return null;
  const nowy = wzor.cloneNode(true);
  wyczyscWiersz(nowy);
  tbody.appendChild(nowy);
  ponumeruj(tbody);
  return nowy;
}

/**
 * Kasuje wiersz. ⚠️ Ostatniego nie usuwa, tylko czyści — bez żadnego wiersza nie byłoby
 * czego skopiować przy „+ Dodaj wiersz”, a tabela bez wierszy wygląda na zepsutą.
 */
export function usunWiersz(tr) {
  const tbody = tr.parentNode;
  if (tbody.querySelectorAll(SELEKTOR_WIERSZA).length <= 1) wyczyscWiersz(tr);
  else tr.remove();
  ponumeruj(tbody);
}

/**
 * Enter w polach „Dodaj z magazynu”. Zwraca `true`, gdy klawisz został obsłużony.
 * `htmx` — obiekt biblioteki, gdy jest na stronie: wtedy szukanie idzie żywym fragmentem
 * (zdarzenie `search` jest w `hx-trigger` pola); bez niej — przycisk „Szukaj” (pełny formularz).
 */
export function obsluzEnter(zdarzenie, { htmx } = {}) {
  if (zdarzenie.key !== 'Enter' || zdarzenie.isComposing) return false;
  const pole = zdarzenie.target;
  if (!pole || typeof pole.closest !== 'function') return false;
  if (pole.name === 'magazyn') {
    zdarzenie.preventDefault();
    if (htmx) pole.dispatchEvent(new Event('search'));
    else pole.form?.querySelector('[data-szukaj-magazyn]')?.click();
    return true;
  }
  if (pole.name === 'mag_ilosc') {
    zdarzenie.preventDefault();
    pole.closest('tr')?.querySelector('button[name="wybrany"]')?.click();
    return true;
  }
  return false;
}

export function podepnij(dokument, srodowisko = {}) {
  const tabela = dokument.querySelector('table[data-podglad-kwoty]');
  const formularz = tabela ? tabela.closest('form') : null;
  if (!formularz) return null;
  const tbody = tabela.querySelector('tbody');
  // Suma i „Razem” (public/suma-podglad.js) przeliczają się na zdarzenie `input` formularza.
  const przelicz = () => formularz.dispatchEvent(new Event('input', { bubbles: true }));

  formularz.addEventListener('click', (zdarzenie) => {
    const przycisk = zdarzenie.target.closest('[data-dodaj-wiersz], [data-usun-wiersz]');
    if (!przycisk) return;
    zdarzenie.preventDefault();
    if (przycisk.hasAttribute('data-dodaj-wiersz')) {
      const nowy = dodajWiersz(tbody);
      nowy?.querySelector('input[name="poz_nazwa"]')?.focus();
    } else {
      usunWiersz(przycisk.closest(SELEKTOR_WIERSZA));
    }
    przelicz();
  });
  formularz.addEventListener('keydown', (zdarzenie) => obsluzEnter(zdarzenie, srodowisko));

  // Po „Dodaj” z magazynu pole szukania ma `autofocus` — zaznaczona fraza znika pod pierwszą literą.
  // ⚠️ DOPIERO PO `load`: strona wraca z kotwicą `#magazyn`, a Chrome przewija do niej na końcu
  // wczytywania i przy tym ZDEJMUJE fokus (sprawdzone 21.10: fokus ustawiony od razu kończył na
  // <body>; po przeładowaniu, które nie przewija do kotwicy, zostawał). `autofocus` sam z siebie
  // też nie działa przy kotwicy w adresie — tak mówi specyfikacja HTML.
  const szukaj = dokument.querySelector('input[name="magazyn"][autofocus]');
  if (szukaj) {
    const fokus = () => { szukaj.focus(); szukaj.select(); };
    if (dokument.readyState === 'complete') fokus();
    else dokument.defaultView?.addEventListener('load', () => setTimeout(fokus, 0), { once: true });
  }
  return formularz;
}

if (typeof document !== 'undefined') podepnij(document, { get htmx() { return globalThis.htmx; } });
