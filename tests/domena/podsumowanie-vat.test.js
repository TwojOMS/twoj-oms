import { describe, it, expect } from 'vitest';
import { podsumowanieVat } from '../../src/domena/podsumowanie-vat.js';

const poz = (gross_price, tax_symbol = '23') => ({ gross_price, tax_symbol });

describe('podsumowanieVat — test kontrolny z prawdziwego dokumentu', () => {
  // ⚠️ TO JEST TEST KONTROLNY CAŁEGO MODUŁU. Liczby nie są wymyślone ani przeliczone
  // kalkulatorem — pochodzą z proformy, którą właściciel wystawia dziś w Apilo
  // (PRO_1_08_2026-4131.pdf, obejrzana 2026-08-04). Klient dostanie oba dokumenty obok
  // siebie, więc kolumny muszą się zgadzać CO DO GROSZA, a nie „w przybliżeniu".
  it('654,00 zł przy 23% daje 531,71 netto i 122,29 VAT', () => {
    const [wiersz] = podsumowanieVat([poz(65400)]);
    expect(wiersz.nettoGr).toBe(53171);
    expect(wiersz.vatGr).toBe(12229);
    expect(wiersz.bruttoGr).toBe(65400);
    expect(wiersz.stawka).toBe(23);
  });
});

describe('podsumowanieVat — niezmiennik kolumn', () => {
  // ⚠️ TO JEST WŁAŚCIWY TEST TEGO MODUŁU, nie kilka ładnych przykładów.
  //
  // Na dokumencie dla klienta kolumny Netto + Kwota VAT MUSZĄ dawać kolumnę Brutto —
  // zawsze, dla każdej kwoty, bez wyjątków „przy tych groszach się nie zgadza".
  // Liczenie VAT-u DRUGIM DZIELENIEM (`round(brutto * 23 / 123)`) daje parę, która po
  // zaokrągleniu potrafi chybić o grosz. Ten test to jedyna rzecz, która taką zmianę
  // zatrzyma, i dlatego jest PĘTLĄ po całym zakresie realnych kwot, a nie zestawem
  // przykładów — chybienia siedzą w rzadkich, nieoczywistych punktach.
  it('netto + VAT === brutto dla każdej kwoty od 1 do 100 000 gr przy 23%', () => {
    const zle = [];
    for (let gr = 1; gr <= 100000; gr += 1) {
      const [wiersz] = podsumowanieVat([poz(gr)]);
      if (wiersz.nettoGr + wiersz.vatGr !== gr) zle.push(gr);
      if (zle.length >= 5) break;
    }
    expect(zle, 'kwoty, przy których kolumny się nie sumują').toEqual([]);
  });

  // ⚠️ TEN TEST ISTNIEJE, BO NIEZMIENNIK PRZY 23% NIE WYSTARCZA — sprawdzone mutacją
  // (2026-08-04), nie przewidziane na sucho. Podmiana odejmowania na drugie dzielenie
  // (`round(brutto * stawka / (100 + stawka))`) NIE zaczerwieniła niczego: przy stawkach
  // 0/5/8/23% obie formuły dają identyczne liczby na całym zakresie 1–200 000 gr, bo przy
  // tych mianownikach iloraz nigdy nie trafia dokładnie w połowę (dla 23% wymagałoby to
  // `200*brutto ≡ 123 (mod 246)`, czyli parzystej lewej strony równej nieparzystej prawej).
  //
  // Rozjazd pojawia się DOPIERO tam, gdzie remis jest możliwy — bo wtedy `Math.round`
  // zaokrągla W GÓRĘ po OBU stronach naraz i wynik przekracza brutto o grosz (stawka 20%,
  // 3 gr: netto 3 + VAT 1 = 4 zamiast 3). Moduł przyjmuje stawkę jako DANE, nie jako stałą,
  // więc niezmiennik ma obowiązywać dla KAŻDEJ stawki, jaką przepuszcza — i dopiero tak
  // zapisany jest w stanie obronić wymagany algorytm przed „równoważnym" przepisaniem.
  it('netto + VAT === brutto dla każdej stawki, którą moduł w ogóle przyjmuje', () => {
    const zle = [];
    for (const stawka of [0, 5, 8, 20, 23, 100]) {
      for (let gr = 1; gr <= 3000; gr += 1) {
        const [wiersz] = podsumowanieVat([poz(gr, String(stawka))]);
        if (wiersz.nettoGr + wiersz.vatGr !== gr) zle.push({ stawka, gr, ...wiersz });
        if (zle.length >= 5) break;
      }
    }
    expect(zle, 'stawki i kwoty, przy których kolumny się nie sumują').toEqual([]);
  });

  it('netto jest zaokrągleniem brutto/1,23 — nie tylko „coś, co się sumuje"', () => {
    // Sam niezmiennik przeszedłby także dla netto=brutto i vat=0, więc drugą stroną
    // porównania jest niezależnie policzone zaokrąglenie na liczbach całkowitych.
    const zle = [];
    for (let gr = 1; gr <= 100000; gr += 1) {
      const [wiersz] = podsumowanieVat([poz(gr)]);
      const oczekiwaneNetto = Math.floor((gr * 100 * 2 + 123) / (123 * 2));
      if (wiersz.nettoGr !== oczekiwaneNetto) zle.push({ gr, dostal: wiersz.nettoGr, oczekiwane: oczekiwaneNetto });
      if (zle.length >= 5) break;
    }
    expect(zle).toEqual([]);
  });
});

describe('podsumowanieVat — grupowanie i sortowanie', () => {
  it('pozycje o tej samej stawce schodzą się w JEDEN wiersz', () => {
    const wiersze = podsumowanieVat([poz(10000), poz(20000), poz(35400)]);
    expect(wiersze.filter((w) => !w.suma)).toHaveLength(1);
    expect(wiersze[0].bruttoGr).toBe(65400);
    expect(wiersze[0].nettoGr).toBe(53171);
    expect(wiersze[0].vatGr).toBe(12229);
  });

  // ⚠️ Podatek liczymy od SUMY stawki, nie od każdej pozycji z osobna i potem dodajemy.
  // Dwie pozycje po 50 gr: per pozycja wyszłoby 41+41=82 netto i 9+9=18 VAT, a poprawnie
  // (i tak, jak liczy to każdy dokument księgowy) jest 81 netto i 19 VAT. Kolumny sumują
  // się w obu wariantach, więc niezmiennik tego NIE złapie — łapie to dopiero ten test.
  it('netto liczone jest od sumy stawki, nie pozycja po pozycji', () => {
    const [wiersz] = podsumowanieVat([poz(50), poz(50)]);
    expect(wiersz.bruttoGr).toBe(100);
    expect(wiersz.nettoGr).toBe(81);
    expect(wiersz.vatGr).toBe(19);
  });

  it('każda stawka dostaje własny wiersz, posortowane malejąco', () => {
    const wiersze = podsumowanieVat([poz(1000, '8'), poz(65400, '23'), poz(500, '5')])
      .filter((w) => !w.suma);
    expect(wiersze.map((w) => w.stawka)).toEqual([23, 8, 5]);
    expect(wiersze.map((w) => w.bruttoGr)).toEqual([65400, 1000, 500]);
  });

  it('stawka podana liczbą i napisem to ta sama stawka', () => {
    const wiersze = podsumowanieVat([poz(100, 23), poz(100, '23')]).filter((w) => !w.suma);
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0].bruttoGr).toBe(200);
  });
});

describe('podsumowanieVat — wiersz sumy', () => {
  it('suma jest sumą wierszy — osobno netto, VAT i brutto', () => {
    const wynik = podsumowanieVat([poz(65400, '23'), poz(1080, '8'), poz(500, '5')]);
    const wiersze = wynik.filter((w) => !w.suma);
    const suma = wynik.at(-1);

    expect(suma.suma).toBe(true);
    expect(suma.stawka).toBeNull();
    expect(suma.nettoGr).toBe(wiersze.reduce((a, w) => a + w.nettoGr, 0));
    expect(suma.vatGr).toBe(wiersze.reduce((a, w) => a + w.vatGr, 0));
    expect(suma.bruttoGr).toBe(wiersze.reduce((a, w) => a + w.bruttoGr, 0));
  });

  it('wiersz sumy jest ostatni i jest dokładnie jeden', () => {
    const wynik = podsumowanieVat([poz(100, '23'), poz(100, '8')]);
    expect(wynik.filter((w) => w.suma)).toHaveLength(1);
    expect(wynik.at(-1).suma).toBe(true);
    expect(wynik).toHaveLength(3);
  });

  // Suma brutto na dokumencie to kwota, którą klient ma przelać — nie wolno jej zgubić
  // ani dorobić przy przechodzeniu przez arytmetykę stawek.
  it('suma brutto równa się sumie brutto pozycji wejściowych', () => {
    const pozycje = [poz(12345, '23'), poz(999, '23'), poz(1, '8'), poz(70000, '5')];
    const suma = podsumowanieVat(pozycje).at(-1);
    expect(suma.bruttoGr).toBe(12345 + 999 + 1 + 70000);
  });
});

describe('podsumowanieVat — przypadki brzegowe', () => {
  it('pusta lista daje pusty wynik i NIE rzuca', () => {
    expect(podsumowanieVat([])).toEqual([]);
    expect(() => podsumowanieVat([])).not.toThrow();
  });

  it('brak argumentu też daje pusty wynik', () => {
    expect(podsumowanieVat()).toEqual([]);
  });

  // Stawki 0% panel dziś nie wystawia, ale gdyby się pojawiła, dzielnik (100 + 0) = 100
  // jest zupełnie zwyczajny — moduł nie ma prawa wywalić się na dzieleniu.
  it('stawka 0 daje netto równe brutto i zerowy VAT', () => {
    const [wiersz] = podsumowanieVat([poz(65400, '0')]);
    expect(wiersz.stawka).toBe(0);
    expect(wiersz.nettoGr).toBe(65400);
    expect(wiersz.vatGr).toBe(0);
  });

  it('kwota 1 grosz nie znika i nie robi ujemnego VAT-u', () => {
    const [wiersz] = podsumowanieVat([poz(1)]);
    expect(wiersz.nettoGr).toBe(1);
    expect(wiersz.vatGr).toBe(0);
    expect(wiersz.bruttoGr).toBe(1);
  });

  // Uszkodzona kwota ma zatrzymać dokument, a nie wydrukować się jako zero — proforma
  // mówi klientowi, ile ma przelać.
  it('kwota nie-całkowita albo nieliczbowa jest odmową, nie cichym zerem', () => {
    expect(() => podsumowanieVat([poz(65.4)])).toThrow(/grosz/i);
    expect(() => podsumowanieVat([poz('654,00')])).toThrow(/grosz/i);
    expect(() => podsumowanieVat([poz(null)])).toThrow(/grosz/i);
  });

  it('nierozpoznana stawka jest odmową, nie stawką zerową', () => {
    expect(() => podsumowanieVat([poz(100, 'zw')])).toThrow(/stawk/i);
    expect(() => podsumowanieVat([poz(100, null)])).toThrow(/stawk/i);
  });

  it('błędy są komunikatami dla operatora, nie technicznymi', () => {
    try {
      podsumowanieVat([poz(65.4)]);
      throw new Error('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });

  it('nie modyfikuje listy wejściowej', () => {
    const pozycje = [poz(65400), poz(100, '8')];
    const kopia = JSON.parse(JSON.stringify(pozycje));
    podsumowanieVat(pozycje);
    expect(pozycje).toEqual(kopia);
  });
});
