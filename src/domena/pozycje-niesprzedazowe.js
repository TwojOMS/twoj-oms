// POZYCJE, KTÓRE NIE SĄ TOWAREM, choć przychodzą ze sklepu jako zwykłe pozycje produktowe.
//
// ⚠️ To jest ŁATA NA WTYCZKĘ, a nie reguła biznesowa. Wtyczka panelu indywidualnego
// (`psm-zamowienia-indywidualne`) wstawia do koszyka WSZYSTKO jednym produktem-zaślepką
// (`psm-zam-placeholder`): i szablon, i wysyłkę, i realizację priorytetową. Woo dostaje więc
// zamówienie, w którym wysyłka jest `line_item`, a `shipping_lines` jest puste — po stronie
// sklepu nie ma ani jednego pola, po którym dałoby się je odróżnić od towaru. Zostaje NAZWA.
//
// ⚠️ DLATEGO TA REGUŁA ZGADUJE i ma być JEDNA. Do 2026-08-21 istniała wyłącznie w
// `domain/agregacja-sprzedazy.js` (żeby „wysyłka kurierem DPD" nie konkurowała z szablonami
// w rankingu i nie zawyżała licznika sztuk); od tej daty czyta ją także karta zamówienia,
// żeby nie rysować pustego wiersza „Wysyłka 0,00" pod pozycją, która TĄ wysyłką jest.
// Druga kopia listy wzorców rozjechałaby te dwa miejsca po cichu.
//
// Właściwa naprawa jest we WTYCZCE — wysyłka ma jechać jako `shipping_line`, a realizacja
// priorytetowa jako `fee_line`. Do tego czasu ta lista jest jedynym, co je rozpoznaje.

// Sama WYSYŁKA — to jej szuka karta zamówienia, gdy pyta „czy transport przyszedł jako
// pozycja". Realizacji priorytetowej TU NIE MA i być nie może: zamówienie z ekspresem, ale
// bez wysyłki, ma dalej pokazywać wiersz wysyłki.
const WYSYLKA = [/wysy[łl]k/i, /kurier/i, /dostawa/i, /us[łl]uga kurierska/i, /pobrani/i];

// Reszta usług, które też nie są towarem — liczy się wyłącznie w rankingu produktów.
const USLUGI = [/realizacja priorytetowa/i];

const pasuje = (wzorce, nazwa) => wzorce.some((r) => r.test(String(nazwa ?? '')));

/**
 * Czy ta pozycja jest TRANSPORTEM przebranym za towar (nazwa, bo innego sygnału nie ma).
 */
export function czyPozycjaWysylki(nazwa) {
  return pasuje(WYSYLKA, nazwa);
}

/**
 * Czy ta pozycja NIE JEST towarem — transport albo usługa dodatkowa.
 *
 * Suma obu list, i to jest dokładnie ta lista, która stała w agregacji sprzedaży przed
 * wydzieleniem tego modułu: rozdzielenie nie zmieniło ani jednego wyniku raportu.
 */
export function czyPozycjaNieTowar(nazwa) {
  return pasuje(WYSYLKA, nazwa) || pasuje(USLUGI, nazwa);
}
