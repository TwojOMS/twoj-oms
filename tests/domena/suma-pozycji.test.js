import { describe, it, expect } from 'vitest';
import {
  grosze, zl, sumaPozycjiZWysylkaGrosze, kwotaZamowieniaGrosze,
  wartoscPozycjiGrosze, kwotaOczekiwanaGrosze,
} from '../../src/domena/suma-pozycji.js';

describe('grosze', () => {
  it('zamienia kwotę tekstową na grosze, na liczbach całkowitych', () => {
    expect(grosze('123.45', 'x')).toBe(12345);
  });

  it('pusta kwota rzuca czytelnie', () => {
    expect(() => grosze('', 'pozycja "X"')).toThrow(/Brak kwoty.*"X"/);
  });

  it('null rzuca czytelnie', () => {
    expect(() => grosze(null, 'kwota zamówienia')).toThrow(/Brak kwoty/);
  });

  it('nieliczbowa kwota rzuca czytelnie', () => {
    expect(() => grosze('dużo', 'x')).toThrow(/nie jest liczbą/);
  });
});

describe('zl', () => {
  it('zamienia grosze z powrotem na złotówki z dwoma miejscami po przecinku', () => {
    expect(zl(12345)).toBe('123.45');
    expect(zl(0)).toBe('0.00');
  });
});

const zamowienie = (nad = {}) => ({
  kwota_brutto: '212.90',
  koszt_dostawy_brutto: '89.90',
  pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' }],
  ...nad,
});

describe('sumaPozycjiZWysylkaGrosze', () => {
  it('sumuje brutto_linii wszystkich pozycji plus koszt dostawy', () => {
    expect(sumaPozycjiZWysylkaGrosze(zamowienie())).toBe(21290);
  });

  it('brak brutto_linii → fallback cena_brutto × ilość (wiersz sprzed migracji)', () => {
    const z = zamowienie({
      koszt_dostawy_brutto: '0.00',
      pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: null }],
    });
    expect(sumaPozycjiZWysylkaGrosze(z)).toBe(12300);
  });

  it('brak koszt_dostawy_brutto (stara baza, NULL) liczy się jako 0, nie rzuca', () => {
    const z = zamowienie({ koszt_dostawy_brutto: null });
    expect(sumaPozycjiZWysylkaGrosze(z)).toBe(12300);
  });

  it('darmowa dostawa ("0.00") liczy się jako 0', () => {
    const z = zamowienie({ koszt_dostawy_brutto: '0.00' });
    expect(sumaPozycjiZWysylkaGrosze(z)).toBe(12300);
  });

  it('zamówienie bez pozycji → sama wysyłka', () => {
    expect(sumaPozycjiZWysylkaGrosze(zamowienie({ pozycje: [] }))).toBe(8990);
  });

  it('łapie różnicę jednego grosza z zaokrąglenia (fallback 33,33 × 3 vs 100,00)', () => {
    const z = zamowienie({
      koszt_dostawy_brutto: '0.00',
      pozycje: [{ nazwa: 'X', ilosc: 3, cena_brutto: '33.33', brutto_linii: null }],
    });
    expect(sumaPozycjiZWysylkaGrosze(z)).toBe(9999);
  });
});

describe('kwotaZamowieniaGrosze', () => {
  it('zamienia kwota_brutto zamówienia na grosze', () => {
    expect(kwotaZamowieniaGrosze(zamowienie())).toBe(21290);
  });

  it('pusta kwota_brutto rzuca czytelnie', () => {
    expect(() => kwotaZamowieniaGrosze(zamowienie({ kwota_brutto: null }))).toThrow(/Brak kwoty.*kwota zamówienia/);
  });
});

describe('wartoscPozycjiGrosze — JEDNA funkcja licząca wartość pozycji', () => {
  it('bierze brutto_linii, gdy jest', () => {
    expect(wartoscPozycjiGrosze({ nazwa: 'X', ilosc: 3, cena_brutto: '33.33', brutto_linii: '100.00' })).toBe(10000);
  });

  it('bez brutto_linii mnoży cenę przez ilość', () => {
    expect(wartoscPozycjiGrosze({ nazwa: 'X', ilosc: 3, cena_brutto: '33.33', brutto_linii: null })).toBe(9999);
  });

  it('pusta cena rzuca czytelnie, nigdy NaN', () => {
    expect(() => wartoscPozycjiGrosze({ nazwa: 'X', ilosc: 1, cena_brutto: null, brutto_linii: null }))
      .toThrow(/Brak kwoty.*"X"/);
  });
});

// ⚠️ SEDNO CAŁEGO ZADANIA. `kwota_brutto` jest KWOTĄ ZAMÓWIENIA W SKLEPIE i ma nią zostać
// (wpłata o źródle 'sklep' podąża za nią — patrz db/platnosci.js). Kwota, której oczekujemy
// od klienta, jest WYLICZANA: kwota ze sklepu plus to, co dopisaliśmy u siebie.
describe('kwotaOczekiwanaGrosze', () => {
  const zeSklepu = (nad = {}) => ({ zrodlo: 'sklep', nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00', sklep: null, ...nad });

  it('bez ręcznych pozycji równa się kwocie ze sklepu', () => {
    expect(kwotaOczekiwanaGrosze(zamowienie())).toBe(21290);
  });

  it('ręczna pozycja PODNOSI kwotę oczekiwaną, a kwoty ze sklepu NIE RUSZA', () => {
    const z = zamowienie({
      pozycje: [
        zeSklepu(),
        { zrodlo: 'reczna', nazwa: 'Dopłata', ilosc: 1, cena_brutto: '80.00', brutto_linii: '80.00', sklep: null },
      ],
    });
    expect(kwotaOczekiwanaGrosze(z)).toBe(29290);
    expect(kwotaZamowieniaGrosze(z)).toBe(21290);
  });

  // Nadpisanie pozycji sklepowej przesuwa kwotę oczekiwaną o RÓŻNICĘ wobec sklepu — dzięki
  // temu bariera arytmetyczna dalej sprawdza dokładnie to, co sprawdzała: czy dane linii
  // ZE SKLEPU sumują się do kwoty zamówienia W SKLEPIE.
  it('nadpisanie pozycji sklepowej przesuwa kwotę oczekiwaną o różnicę, nie o całą wartość', () => {
    const z = zamowienie({
      pozycje: [
        zeSklepu({ ilosc: 3, brutto_linii: '184.50', sklep: { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' } }),
      ],
    });
    expect(kwotaOczekiwanaGrosze(z)).toBe(21290 + 6150);
  });

  it('nadpisanie w dół obniża kwotę oczekiwaną', () => {
    const z = zamowienie({
      pozycje: [
        zeSklepu({ ilosc: 1, brutto_linii: '61.50', sklep: { nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' } }),
      ],
    });
    expect(kwotaOczekiwanaGrosze(z)).toBe(21290 - 6150);
  });

  // Pozycja bez nałożonej warstwy nadpisań (odczyt z bazy z pominięciem zLinii) nie ma prawa
  // wyglądać na dopisaną ręcznie — inaczej samo pominięcie nakładki podwoiłoby kwotę.
  it('pozycja sklepowa bez pola `sklep` nie wnosi żadnej różnicy', () => {
    const z = zamowienie({ pozycje: [{ zrodlo: 'sklep', nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' }] });
    expect(kwotaOczekiwanaGrosze(z)).toBe(21290);
  });

  it('arytmetyka na groszach — trzy dopłaty po 0,10 zł dają dokładnie 0,30 zł więcej', () => {
    const doplata = (n) => ({ zrodlo: 'reczna', nazwa: n, ilosc: 1, cena_brutto: '0.10', brutto_linii: '0.10', sklep: null });
    const z = zamowienie({ pozycje: [zeSklepu(), doplata('A'), doplata('B'), doplata('C')] });
    expect(kwotaOczekiwanaGrosze(z)).toBe(21320);
  });
});
