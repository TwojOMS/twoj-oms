// STATYSTYKI PŁATNOŚCI — czysta agregacja nad listą z domain/statystyki-okresu.js.
import { normalizujMetode } from './metody-platnosci.js';
import { czyKanalAllegro } from './wysylka.js';
import { udzialProcent } from './statystyki-wysylki.js';

/**
 * Rozkład metod płatności — i jedna rzecz, którą ten ekran MUSI powiedzieć wprost.
 *
 * ⚠️⚠️ ALLEGRO NIE MÓWI, CZYM KUPUJĄCY ZAPŁACIŁ. Kanał oddaje wyłącznie `payment.type`
 * (ONLINE / CASH_ON_DELIVERY), który mapuje się na „Allegro (płatność online)" i
 * „Za pobraniem" — o BLIK-u, karcie ani przelewie nie ma tam ani słowa. Na produkcji
 * 13.09.2026 to 92 z 226 zamówień, czyli 41% bazy.
 *
 * Dlatego procent liczy się z mianownika BEZ ALLEGRO, a te zamówienia dostają OSOBNY
 * licznik, pokazywany obok tabeli i wyłączony z procentów. Zmierzone trzy odpowiedzi na
 * pytanie „ile % BLIK": 43/226 = 19%, 43/120 (bez Allegro) = 36%, 43/83 (tylko Woo) = 52%.
 * Wrzucenie Allegro do kubełka „inne" albo doliczenie go do przelewów byłoby zmyśleniem
 * danych, których nie mamy — a 19% czytałoby się jak odpowiedź.
 *
 * ⚠️ KANAŁ ROZSTRZYGA `czyKanalAllegro`, czyli KOLUMNA `sklep` — nie treść metody. Metoda
 * jest edytowalna z karty (`wysylka_reczna_json` i formularz wpłaty ręcznej), więc reguła
 * kluczowana napisem miałaby furtkę: poprawka metody przenosiłaby zamówienie między
 * mianownikami.
 *
 * ⚠️ ZAMÓWIENIA RĘCZNE ZOSTAJĄ w rozkładzie (na produkcji 36× „Przelew"). Metodę wpisał
 * operator, ale zamówienie jest prawdziwe i pieniądze naprawdę przyszły przelewem.
 * Wyrzucenie ich podniosłoby udział BLIK-u z 36% na 52% — czyli zmieniłoby odpowiedź,
 * a nie tylko mianownik. Ekran mówi o tym w bloku metodologii.
 */
export function rozkladMetod(zamowienia) {
  const kubelki = new Map();
  let mianownik = 0;
  let allegroBezInformacji = 0;

  for (const z of zamowienia) {
    if (czyKanalAllegro(z)) { allegroBezInformacji += 1; continue; }
    mianownik += 1;
    const { etykieta } = normalizujMetode(z.metoda_platnosci);
    kubelki.set(etykieta, (kubelki.get(etykieta) ?? 0) + 1);
  }

  const pozycje = [...kubelki.entries()]
    .map(([etykieta, ile]) => ({ etykieta, ile, udzial: udzialProcent(ile, mianownik) }))
    .sort((a, b) => (b.ile - a.ile) || a.etykieta.localeCompare(b.etykieta, 'pl'));

  return { pozycje, mianownik, allegroBezInformacji, wszystkie: zamowienia.length };
}
