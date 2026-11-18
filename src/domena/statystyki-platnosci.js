// STATYSTYKI PŁATNOŚCI — czysta agregacja nad listą z domena/statystyki-okresu.js.
import { normalizujMetode } from './metody-platnosci.js';
import { czyKanalAllegro } from './wysylka.js';
import { udzialProcent } from './statystyki-wysylki.js';

/**
 * Rozkład metod płatności — i jedna rzecz, którą ten ekran MUSI powiedzieć wprost.
 *
 * ⚠️⚠️ ALLEGRO NIE MÓWI, CZYM KUPUJĄCY ZAPŁACIŁ. Kanał oddaje wyłącznie `payment.type`
 * (ONLINE / CASH_ON_DELIVERY), który mapuje się na „Allegro (płatność online)" i
 * „Za pobraniem" — o BLIK-u, karcie ani przelewie nie ma tam ani słowa. Przy sprzedaży
 * na Allegro to bywa duża część bazy — w zmierzonej instalacji ponad jedna trzecia zamówień.
 *
 * Dlatego procent liczy się z mianownika BEZ ALLEGRO, a te zamówienia dostają OSOBNY
 * licznik, pokazywany obok tabeli i wyłączony z procentów. Te same zamówienia dają trzy
 * różne odpowiedzi na pytanie „ile % BLIK": z całości, bez Allegro i tylko z Woo — i potrafią
 * się różnić o dziesiątki punktów procentowych.
 * Wrzucenie Allegro do kubełka „inne" albo doliczenie go do przelewów byłoby zmyśleniem
 * danych, których nie mamy — a wynik z całości czytałoby się jak odpowiedź.
 *
 * ⚠️ KANAŁ ROZSTRZYGA `czyKanalAllegro`, czyli KOLUMNA `sklep` — nie treść metody. Metoda
 * jest edytowalna z karty (`wysylka_reczna_json` i formularz wpłaty ręcznej), więc reguła
 * kluczowana napisem miałaby furtkę: poprawka metody przenosiłaby zamówienie między
 * mianownikami.
 *
 * ⚠️ ZAMÓWIENIA RĘCZNE ZOSTAJĄ w rozkładzie (zwykle z metodą „Przelew"). Metodę wpisał
 * operator, ale zamówienie jest prawdziwe i pieniądze naprawdę przyszły przelewem.
 * Wyrzucenie ich podniosłoby udział BLIK-u — czyli zmieniłoby odpowiedź,
 * a nie tylko mianownik. Ekran mówi o tym w bloku metodologii.
 */
export function rozkladMetod(zamowienia) {
  const a = agregatorMetod();
  for (const z of zamowienia) a.dodaj(z);
  return a.wynik();
}

export function agregatorMetod() {
  const kubelki = new Map();
  let mianownik = 0;
  let allegroBezInformacji = 0;
  let wszystkie = 0;

  const dodaj = (z) => {
    wszystkie += 1;
    if (czyKanalAllegro(z)) {
      allegroBezInformacji += 1;
      return;
    }
    mianownik += 1;
    const { etykieta } = normalizujMetode(z.metoda_platnosci);
    kubelki.set(etykieta, (kubelki.get(etykieta) ?? 0) + 1);
  };

  const wynik = () => {
    const pozycje = [...kubelki.entries()]
      .map(([etykieta, ile]) => ({ etykieta, ile, udzial: udzialProcent(ile, mianownik) }))
      .sort((a, b) => b.ile - a.ile || a.etykieta.localeCompare(b.etykieta, 'pl'));

    return { pozycje, mianownik, allegroBezInformacji, wszystkie };
  };
  return { dodaj, wynik };
}
