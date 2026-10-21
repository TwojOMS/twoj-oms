import { describe, it, expect } from 'vitest';
import { pozycjeOkresu, sumaOczekiwanaOkresuGrosze, sprawdzSumeOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { STAWKA_VAT } from '../../../src/domena/vat.js';

const zam = (numer, pozycje, kwotaBrutto) => ({
  numer, sklep: 'reczne', kwota_brutto: kwotaBrutto, koszt_dostawy_brutto: null, pozycje,
});

// Zamowienie ZE SKLEPU — inna galaz `kwotaOczekiwanaGrosze` niz przy recznym: kwota liczy sie
// RÓŻNICĄ efektywnych pozycji wobec sklepowych, nie wprost z `kwota_brutto`. Kszalt pozycji
// bierzemy z warstwy odczytu (nalozNadpisaniaPozycji): wiersz sklepowy niesie obok siebie
// kopie `sklep` z wartosciami sprzed nadpisan.
const zamSklep = (numer, pozycje, kwotaBrutto) => ({
  numer, sklep: 'pro', kwota_brutto: kwotaBrutto, koszt_dostawy_brutto: null, pozycje,
});

// Pozycja sklepowa nietknieta przez operatora: efektywna == sklepowa, wiec czlon roznicowy = 0.
const pozSklep = (nazwa, ilosc, bruttoLinii) => ({
  nazwa, ilosc, brutto_linii: bruttoLinii, zrodlo: 'sklep',
  sklep: { nazwa, ilosc, brutto_linii: bruttoLinii },
});

describe('pozycjeOkresu', () => {
  it('sklada pozycje wszystkich zamowien w jedna liste', () => {
    const zamowienia = [
      zam('R/2026/001', [{ nazwa: 'STOP 70x100', ilosc: 1, brutto_linii: '100.00' }], '104.00'),
      zam('R/2026/002', [{ nazwa: 'PIESZY 45x65', ilosc: 2, brutto_linii: '150.00' }], '169.00'),
    ];
    const p = pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT });
    expect(p.map((x) => x.name)).toEqual(['STOP 70x100', 'PIESZY 45x65']);
    expect(p[1].quantity).toBe(2);
    expect(p[1].gross_price).toBe(15000);
  });

  it('oplata reczna jedzie jako zwykla pozycja, bez zadnego kodu o niej', () => {
    const zamowienia = [zam('R/2026/001', [
      { nazwa: 'STOP 70x100', ilosc: 1, brutto_linii: '100.00' },
      { nazwa: 'Obsługa zamówienia', ilosc: 1, brutto_linii: '4.00', zrodlo: 'reczna' },
    ], '104.00')];
    expect(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }).map((x) => x.name))
      .toEqual(['STOP 70x100', 'Obsługa zamówienia']);
  });

  it('koszt dostawy dokladany osobna linia, gdy niezerowy', () => {
    const z = zam('R/2026/001', [{ nazwa: 'STOP', ilosc: 1, brutto_linii: '100.00' }], '119.00');
    z.koszt_dostawy_brutto = '19.00';
    const p = pozycjeOkresu([z], { stawkaDomyslna: STAWKA_VAT });
    expect(p.at(-1)).toEqual({ name: 'Dostawa', quantity: 1, gross_price: 1900, tax_symbol: STAWKA_VAT });
  });

  it('kazda pozycja niesie stawke VAT panelu', () => {
    const p = pozycjeOkresu([zam('R/2026/001', [{ nazwa: 'A', ilosc: 1, brutto_linii: '100.00' }], '100.00')], { stawkaDomyslna: STAWKA_VAT });
    expect(p.every((x) => x.tax_symbol === STAWKA_VAT)).toBe(true);
  });
});

describe('sumaOczekiwanaOkresuGrosze', () => {
  it('sumuje kwoty oczekiwane wszystkich zamowien', () => {
    const zamowienia = [
      zam('R/2026/001', [{ nazwa: 'A', ilosc: 1, brutto_linii: '104.00' }], '104.00'),
      zam('R/2026/002', [{ nazwa: 'B', ilosc: 1, brutto_linii: '169.00' }], '169.00'),
    ];
    expect(sumaOczekiwanaOkresuGrosze(zamowienia)).toBe(27300);
  });
});

describe('sprawdzSumeOkresu', () => {
  it('przepuszcza zgodna sume', () => {
    const zamowienia = [zam('R/2026/001', [{ nazwa: 'A', ilosc: 1, brutto_linii: '100.00' }], '100.00')];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).not.toThrow();
  });

  it('lapie rozjazd zaokraglenia 33,33 x 3 = 99,99 przy totalu 100,00', () => {
    const zamowienia = [zam('R/2026/001', [{ nazwa: 'A', ilosc: 3, brutto_linii: '99.99' }], '100.00')];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).toThrow(/nie zgadza/i);
  });

  it('odmawia faktury bez ani jednej pozycji', () => {
    expect(() => sprawdzSumeOkresu([], [])).toThrow(/bez pozycji/i);
  });

  // ⚠️ SEDNO BARIERY. Porownanie samych sum zbiorczych przepuszczaloby ten okres: jedno
  // zamowienie zawyzone o 10 zl, drugie zanizone o 10 zl, roznica zbiorcza = 0.
  it('lapie dwa bledy, ktore znosza sie nawzajem w sumie zbiorczej', () => {
    const zawyzone = zam('R/2026/007', [{ nazwa: 'A', ilosc: 1, brutto_linii: '110.00' }], '100.00');
    const zanizone = zam('R/2026/008', [{ nazwa: 'B', ilosc: 1, brutto_linii: '90.00' }], '100.00');
    const zamowienia = [zawyzone, zanizone];
    // Kontrola zalozenia: suma zbiorcza faktycznie sie zgadza, wiec lapie to WYLACZNIE
    // sprawdzenie per zamowienie.
    expect(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }).reduce((a, s) => a + s.gross_price, 0))
      .toBe(sumaOczekiwanaOkresuGrosze(zamowienia));
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).toThrow(/nie zgadza/i);
  });

  it('komunikat nazywa numer rozjechanego zamowienia', () => {
    const zamowienia = [
      zam('R/2026/006', [{ nazwa: 'A', ilosc: 1, brutto_linii: '100.00' }], '100.00'),
      zam('R/2026/007', [{ nazwa: 'B', ilosc: 3, brutto_linii: '99.99' }], '100.00'),
    ];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).toThrow(/R\/2026\/007/);
  });

  // Podwojne liczenie dostawy bylo nazwanym ryzykiem tego zadania: `pozycjeOkresu` dokleja
  // linie „Dostawa", a `kwotaOczekiwanaGrosze` ma ja juz w `kwota_brutto`. Ten test przepuszcza
  // takie zamowienie przez CALA bariere, wiec kazde przyszle podwojenie zapali sie tutaj.
  it('przepuszcza zamowienie z niezerowa dostawa', () => {
    const z = zam('R/2026/001', [{ nazwa: 'STOP', ilosc: 1, brutto_linii: '100.00' }], '119.00');
    z.koszt_dostawy_brutto = '19.00';
    expect(() => sprawdzSumeOkresu(pozycjeOkresu([z], { stawkaDomyslna: STAWKA_VAT }), [z])).not.toThrow();
  });

  it('przepuszcza zamowienie ze sklepu', () => {
    const zamowienia = [zamSklep('S/2026/010', [
      pozSklep('STOP 70x100', 1, '100.00'),
      pozSklep('PIESZY 45x65', 2, '150.00'),
    ], '250.00')];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).not.toThrow();
  });

  it('przepuszcza zamowienie ze sklepu z doklejona pozycja reczna (oplata za obsluge)', () => {
    const zamowienia = [zamSklep('S/2026/011', [
      pozSklep('STOP 70x100', 1, '100.00'),
      // Sklep o tej pozycji nie wie, wiec jej wartosc sklepowa to 0 — kwota oczekiwana rosnie
      // o pelne 4 zl ponad `kwota_brutto`.
      { nazwa: 'Obsługa zamówienia', ilosc: 1, brutto_linii: '4.00', zrodlo: 'reczna', sklep: null },
    ], '100.00')];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).not.toThrow();
  });

  it('lapie rozjazd w zamowieniu ze sklepu', () => {
    const zamowienia = [zamSklep('S/2026/012', [pozSklep('STOP', 1, '100.00')], '119.00')];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).toThrow(/S\/2026\/012/);
  });

  // Okres MIESZANY — najbardziej prawdopodobny uklad w produkcji: zamowienia ze sklepu obok
  // wpisanych recznie (telefon, mail). Kazde idzie inna galezia `kwotaOczekiwanaGrosze`.
  it('przepuszcza okres mieszany: reczne + sklepowe + dostawa', () => {
    const reczne = zam('R/2026/020', [{ nazwa: 'Szablon na wymiar', ilosc: 1, brutto_linii: '246.00' }], '246.00');
    const sklepowe = zamSklep('S/2026/021', [pozSklep('STOP 70x100', 2, '200.00')], '219.00');
    sklepowe.koszt_dostawy_brutto = '19.00';
    const zamowienia = [reczne, sklepowe];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).not.toThrow();
    expect(sumaOczekiwanaOkresuGrosze(zamowienia)).toBe(46500);
  });

  it('w okresie mieszanym wskazuje wlasnie to zamowienie, ktore sie rozjechalo', () => {
    const reczne = zam('R/2026/020', [{ nazwa: 'Szablon', ilosc: 1, brutto_linii: '246.00' }], '246.00');
    const sklepowe = zamSklep('S/2026/021', [pozSklep('STOP', 2, '200.00')], '210.00');
    const zamowienia = [reczne, sklepowe];
    expect(() => sprawdzSumeOkresu(pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT }), zamowienia)).toThrow(/S\/2026\/021/);
  });

  // DOMKNIECIE: pozycja doklejona do `services` poza petla po zamowieniach jest dla sprawdzenia
  // per zamowienie niewidzialna — lapie ja dopiero porownanie sum zbiorczych.
  it('lapie pozycje doklejona do listy poza pozycjeOkresu', () => {
    const zamowienia = [zam('R/2026/001', [{ nazwa: 'A', ilosc: 1, brutto_linii: '100.00' }], '100.00')];
    const services = pozycjeOkresu(zamowienia, { stawkaDomyslna: STAWKA_VAT });
    services.push({ name: 'Doklejka', quantity: 1, gross_price: 500, tax_symbol: STAWKA_VAT });
    expect(() => sprawdzSumeOkresu(services, zamowienia)).toThrow(/sumą zamówień okresu/i);
  });
});
