import { describe, it, expect } from 'vitest';
import { MAPOWANIE_SKLEPOW, metodaWysylkiZamowienia } from '../pomoc/mapowanie-sklepow-historyczne-fixture.js';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';

// PRZ-134.01 — ZŁOTY TEST: zachowanie reguły pobrania PRZED wejściem sygnału z bramki płatności.
//
// Sklepy z pliku (`<PREFIKS>_MAPOWANIE`) i dawna mapa PRZ-060 nie mają `bramkiPobrania`, więc po PRZ-134
// mają dawać bajt w bajt to samo co dziś — także wtedy, gdy zamówienie niesie `payment_method`.
// Tabela niżej została ZAPISANA z wyniku funkcji na kodzie sprzed PRZ-134 (2af2523f) i jest stałą,
// nie wywołaniem tej samej funkcji. ⚠️ Tego pliku nie poprawia się „pod nowy kod": czerwony = zmiana
// zachowania sklepów z pliku, czyli pieniądze (pobranie, kwota pobrania).

// Dawna mapa PRZ-060 ma dwa sklepy; w tabeli nazywamy je A i B (kolejność alfabetyczna kluczy fixture).
const KLUCZE = Object.keys(MAPOWANIE_SKLEPOW).sort();
const SKLEPY = {
  A: MAPOWANIE_SKLEPOW[KLUCZE[0]],
  B: MAPOWANIE_SKLEPOW[KLUCZE[1]],
  // Zmyślony sklep z pliku („Pracownia Półcień") z przypadkami brzegowymi, które walidator `.env`
  // przepuszcza: odbiór osobisty z flagą pobrania, paczkomat z flagą, flaga nie-boolowska, literówka metody.
  P: {
    instancje: {
      1: { metoda: 'dpd' },
      2: { metoda: 'dpd', pobranie: true },
      4: { metoda: 'odbior_osobisty' },
      5: { metoda: 'odbior_osobisty', pobranie: true },
      7: { metoda: 'inpost_paczkomat', pobranie: true },
      8: { metoda: 'teleport', pobranie: true },
      11: { metoda: 'dpd', pobranie: 'tak' },
    },
    poPozycji: [{ nazwaZawiera: 'odbiór w pracowni', metoda: 'odbior_osobisty' }],
  },
};

const BRAMKI = { cod: 'cod', bacs: 'bacs', pusta: '', brak: undefined };

const zamowienie = (wysylka, bramka) => {
  const z = {
    id: 7, number: '7001', total: '149.90', status: 'processing',
    shipping_lines: wysylka.instancja === undefined ? [] : [{ instance_id: wysylka.instancja, method_id: 'flat_rate', method_title: 'x' }],
    line_items: [{ name: wysylka.nazwa ?? 'Lampa stołowa Półcień', sku: wysylka.sku ?? 'pc-1', quantity: 1, total: '149.90' }],
  };
  if (bramka !== undefined) z.payment_method = bramka;
  return z;
};

function przypadki() {
  const wynik = [];
  for (const [nazwa, mapa] of Object.entries(SKLEPY)) {
    const wysylki = [
      ...Object.keys(mapa.instancje).map((id) => [`instancja ${id}`, { instancja: Number(id) }]),
      ['instancja spoza mapy', { instancja: 999 }],
      ['bez linii, zaślepka', { sku: 'psm-zam-placeholder' }],
      ['bez linii, nazwa pozycji', { nazwa: 'Odbiór w pracowni — Kraków' }],
      ['bez wysyłki', {}],
    ];
    for (const [opis, wysylka] of wysylki) {
      for (const [b, bramka] of Object.entries(BRAMKI)) {
        wynik.push([`${nazwa} | ${opis} | ${b}`, mapa, zamowienie(wysylka, bramka)]);
      }
    }
  }
  return wynik;
}

// [metoda, pobranie] z metodaWysylkiZamowienia, potem [metoda_wysylki, pobranie, kwota_pobrania] z mapujZamowienie.
const ZLOTE = {
  "A | instancja 1 | cod": ["dpd", false, "dpd", 0, null],
  "A | instancja 1 | bacs": ["dpd", false, "dpd", 0, null],
  "A | instancja 1 | pusta": ["dpd", false, "dpd", 0, null],
  "A | instancja 1 | brak": ["dpd", false, "dpd", 0, null],
  "A | instancja 2 | cod": ["dpd", true, "dpd", 1, "149.90"],
  "A | instancja 2 | bacs": ["dpd", true, "dpd", 1, "149.90"],
  "A | instancja 2 | pusta": ["dpd", true, "dpd", 1, "149.90"],
  "A | instancja 2 | brak": ["dpd", true, "dpd", 1, "149.90"],
  "A | instancja 3 | cod": ["dpd", false, "dpd", 0, null],
  "A | instancja 3 | bacs": ["dpd", false, "dpd", 0, null],
  "A | instancja 3 | pusta": ["dpd", false, "dpd", 0, null],
  "A | instancja 3 | brak": ["dpd", false, "dpd", 0, null],
  "A | instancja spoza mapy | cod": ["nieznana", false, "nieznana", 0, null],
  "A | instancja spoza mapy | bacs": ["nieznana", false, "nieznana", 0, null],
  "A | instancja spoza mapy | pusta": ["nieznana", false, "nieznana", 0, null],
  "A | instancja spoza mapy | brak": ["nieznana", false, "nieznana", 0, null],
  "A | bez linii, zaślepka | cod": ["dpd", false, "dpd", 0, null],
  "A | bez linii, zaślepka | bacs": ["dpd", false, "dpd", 0, null],
  "A | bez linii, zaślepka | pusta": ["dpd", false, "dpd", 0, null],
  "A | bez linii, zaślepka | brak": ["dpd", false, "dpd", 0, null],
  "A | bez linii, nazwa pozycji | cod": ["nieznana", false, "nieznana", 0, null],
  "A | bez linii, nazwa pozycji | bacs": ["nieznana", false, "nieznana", 0, null],
  "A | bez linii, nazwa pozycji | pusta": ["nieznana", false, "nieznana", 0, null],
  "A | bez linii, nazwa pozycji | brak": ["nieznana", false, "nieznana", 0, null],
  "A | bez wysyłki | cod": ["nieznana", false, "nieznana", 0, null],
  "A | bez wysyłki | bacs": ["nieznana", false, "nieznana", 0, null],
  "A | bez wysyłki | pusta": ["nieznana", false, "nieznana", 0, null],
  "A | bez wysyłki | brak": ["nieznana", false, "nieznana", 0, null],
  "B | instancja 3 | cod": ["dpd", false, "dpd", 0, null],
  "B | instancja 3 | bacs": ["dpd", false, "dpd", 0, null],
  "B | instancja 3 | pusta": ["dpd", false, "dpd", 0, null],
  "B | instancja 3 | brak": ["dpd", false, "dpd", 0, null],
  "B | instancja 9 | cod": ["dpd", true, "dpd", 1, "149.90"],
  "B | instancja 9 | bacs": ["dpd", true, "dpd", 1, "149.90"],
  "B | instancja 9 | pusta": ["dpd", true, "dpd", 1, "149.90"],
  "B | instancja 9 | brak": ["dpd", true, "dpd", 1, "149.90"],
  "B | instancja 12 | cod": ["inpost_paczkomat", false, "inpost_paczkomat", 0, null],
  "B | instancja 12 | bacs": ["inpost_paczkomat", false, "inpost_paczkomat", 0, null],
  "B | instancja 12 | pusta": ["inpost_paczkomat", false, "inpost_paczkomat", 0, null],
  "B | instancja 12 | brak": ["inpost_paczkomat", false, "inpost_paczkomat", 0, null],
  "B | instancja spoza mapy | cod": ["nieznana", false, "nieznana", 0, null],
  "B | instancja spoza mapy | bacs": ["nieznana", false, "nieznana", 0, null],
  "B | instancja spoza mapy | pusta": ["nieznana", false, "nieznana", 0, null],
  "B | instancja spoza mapy | brak": ["nieznana", false, "nieznana", 0, null],
  "B | bez linii, zaślepka | cod": ["dpd", false, "dpd", 0, null],
  "B | bez linii, zaślepka | bacs": ["dpd", false, "dpd", 0, null],
  "B | bez linii, zaślepka | pusta": ["dpd", false, "dpd", 0, null],
  "B | bez linii, zaślepka | brak": ["dpd", false, "dpd", 0, null],
  "B | bez linii, nazwa pozycji | cod": ["nieznana", false, "nieznana", 0, null],
  "B | bez linii, nazwa pozycji | bacs": ["nieznana", false, "nieznana", 0, null],
  "B | bez linii, nazwa pozycji | pusta": ["nieznana", false, "nieznana", 0, null],
  "B | bez linii, nazwa pozycji | brak": ["nieznana", false, "nieznana", 0, null],
  "B | bez wysyłki | cod": ["nieznana", false, "nieznana", 0, null],
  "B | bez wysyłki | bacs": ["nieznana", false, "nieznana", 0, null],
  "B | bez wysyłki | pusta": ["nieznana", false, "nieznana", 0, null],
  "B | bez wysyłki | brak": ["nieznana", false, "nieznana", 0, null],
  "P | instancja 1 | cod": ["dpd", false, "dpd", 0, null],
  "P | instancja 1 | bacs": ["dpd", false, "dpd", 0, null],
  "P | instancja 1 | pusta": ["dpd", false, "dpd", 0, null],
  "P | instancja 1 | brak": ["dpd", false, "dpd", 0, null],
  "P | instancja 2 | cod": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 2 | bacs": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 2 | pusta": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 2 | brak": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 4 | cod": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | instancja 4 | bacs": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | instancja 4 | pusta": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | instancja 4 | brak": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | instancja 5 | cod": ["odbior_osobisty", true, "odbior_osobisty", 1, "149.90"],
  "P | instancja 5 | bacs": ["odbior_osobisty", true, "odbior_osobisty", 1, "149.90"],
  "P | instancja 5 | pusta": ["odbior_osobisty", true, "odbior_osobisty", 1, "149.90"],
  "P | instancja 5 | brak": ["odbior_osobisty", true, "odbior_osobisty", 1, "149.90"],
  "P | instancja 7 | cod": ["inpost_paczkomat", true, "inpost_paczkomat", 1, "149.90"],
  "P | instancja 7 | bacs": ["inpost_paczkomat", true, "inpost_paczkomat", 1, "149.90"],
  "P | instancja 7 | pusta": ["inpost_paczkomat", true, "inpost_paczkomat", 1, "149.90"],
  "P | instancja 7 | brak": ["inpost_paczkomat", true, "inpost_paczkomat", 1, "149.90"],
  "P | instancja 8 | cod": ["nieznana", false, "nieznana", 0, null],
  "P | instancja 8 | bacs": ["nieznana", false, "nieznana", 0, null],
  "P | instancja 8 | pusta": ["nieznana", false, "nieznana", 0, null],
  "P | instancja 8 | brak": ["nieznana", false, "nieznana", 0, null],
  "P | instancja 11 | cod": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 11 | bacs": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 11 | pusta": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja 11 | brak": ["dpd", true, "dpd", 1, "149.90"],
  "P | instancja spoza mapy | cod": ["nieznana", false, "nieznana", 0, null],
  "P | instancja spoza mapy | bacs": ["nieznana", false, "nieznana", 0, null],
  "P | instancja spoza mapy | pusta": ["nieznana", false, "nieznana", 0, null],
  "P | instancja spoza mapy | brak": ["nieznana", false, "nieznana", 0, null],
  "P | bez linii, zaślepka | cod": ["nieznana", false, "nieznana", 0, null],
  "P | bez linii, zaślepka | bacs": ["nieznana", false, "nieznana", 0, null],
  "P | bez linii, zaślepka | pusta": ["nieznana", false, "nieznana", 0, null],
  "P | bez linii, zaślepka | brak": ["nieznana", false, "nieznana", 0, null],
  "P | bez linii, nazwa pozycji | cod": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | bez linii, nazwa pozycji | bacs": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | bez linii, nazwa pozycji | pusta": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | bez linii, nazwa pozycji | brak": ["odbior_osobisty", false, "odbior_osobisty", 0, null],
  "P | bez wysyłki | cod": ["nieznana", false, "nieznana", 0, null],
  "P | bez wysyłki | bacs": ["nieznana", false, "nieznana", 0, null],
  "P | bez wysyłki | pusta": ["nieznana", false, "nieznana", 0, null],
  "P | bez wysyłki | brak": ["nieznana", false, "nieznana", 0, null],
};

describe('PRZ-134 złoty test — sklepy bez bramkiPobrania liczą pobranie jak przed PRZ-134', () => {
  it('fixture ma dokładnie dwa sklepy', () => {
    expect(KLUCZE).toHaveLength(2);
  });

  it('każdy przypadek ma zapisany wynik (instancje × linia pozycji × bez wysyłki × payment_method)', () => {
    const wyniki = Object.fromEntries(przypadki().map(([opis, mapa, surowe]) => {
      const { metoda, pobranie } = metodaWysylkiZamowienia(surowe, mapa);
      const z = mapujZamowienie(surowe, mapa);
      return [opis, [metoda, pobranie, z.metoda_wysylki, z.pobranie, z.kwota_pobrania]];
    }));
    expect(wyniki).toEqual(ZLOTE);
  });
});
