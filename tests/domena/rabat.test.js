import { describe, it, expect } from 'vitest';
import {
  parsujRabat, cenaPoRabacie, cenaPoRabacieGrosze, czyPozycjaPanelu, przeliczenieRabatu, RABAT_MAX,
} from '../../src/domena/rabat.js';
import { pozycjaZProduktu } from '../pomoc/cenniki-historyczne-fixture.js';

const poz = (nad = {}) => ({
  id: 1, nazwa: 'Szablon inwalida 30x30', zrodlo: 'reczna', ilosc: 10,
  cena_brutto: '74.90', cena_katalogowa: '74.90', ...nad,
});

describe('procent rabatu', () => {
  it('puste pole to zero, nie odmowa', () => {
    expect(parsujRabat('')).toBe(0);
    expect(parsujRabat(null)).toBe(0);
    expect(parsujRabat(undefined)).toBe(0);
  });

  it('liczba całkowita przechodzi', () => {
    expect(parsujRabat('30')).toBe(30);
    expect(parsujRabat(30)).toBe(30);
  });

  // ⚠️ CALKOWITA, BO CALA TA WARSTWA LICZY W GROSZACH NA LICZBACH CALKOWITYCH, a bariera
  // arytmetyczna faktury porownuje wynik CO DO GROSZA. Odmowa MUSI mowic o ulamku, a nie
  // „to nie jest liczba" — inaczej operator poprawia przecinek na kropke i probuje dalej.
  it('ułamek dostaje odmowę mówiącą o ułamku, nie o literówce', () => {
    expect(() => parsujRabat('7,5')).toThrow(/pełnym procentem/);
    expect(() => parsujRabat('7.5')).toThrow(/pełnym procentem/);
  });

  it('ujemny i za duży dostają odmowę', () => {
    expect(() => parsujRabat('-5')).toThrow(/ujemny/);
    expect(() => parsujRabat(String(RABAT_MAX + 1))).toThrow(/dopuszczalne/);
    expect(parsujRabat(String(RABAT_MAX))).toBe(RABAT_MAX);
  });

  it('śmieć dostaje odmowę', () => {
    expect(() => parsujRabat('trzydzieści')).toThrow(/nie jest liczbą procent/);
  });
});

describe('cena po rabacie', () => {
  it('liczy się w groszach i zaokrągla do grosza', () => {
    expect(cenaPoRabacie(7490, 30)).toBe('52.43');
    expect(cenaPoRabacie(7490, 0)).toBe('74.90');
    expect(cenaPoRabacie(10000, 10)).toBe('90.00');
  });

  // ⚠️ ZERO JEST W TYM PANELU ODMOWA (`parsujCeneBrutto`), wiec rabat nie ma prawa go
  // wyprodukowac zaokragleniem — inaczej zamowienie z drobna pozycja nie daloby sie zalozyc,
  // a komunikat mowilby o cenie, ktorej operator nigdzie nie wpisal.
  it('nigdy nie schodzi do zera', () => {
    expect(cenaPoRabacieGrosze(1, 90)).toBe(1);
  });

  it('cena katalogowa musi być kwotą dodatnią', () => {
    expect(() => cenaPoRabacieGrosze(0, 30)).toThrow(/większą od zera/);
  });
});

describe('pozycja z magazynu bierze rabat', () => {
  const produkt = {
    kanal: 'pro', nazwa: 'Szablon inwalida', rozmiar_tekst: '30x30', cena_gr: 7490,
    produkt_id: '101', wariant_id: '102', sku_sklepu: 'SZ-INW-30',
  };

  it('cena płacona jest po rabacie, a katalogowa leży obok', () => {
    const p = pozycjaZProduktu(produkt, '10', { rabatProcent: 30 });
    expect(p.cena_brutto).toBe('52.43');
    expect(p.cena_katalogowa).toBe('74.90');
    // ⚠️ SUMA LINII LICZY SIE Z CENY PO ZAOKRAGLENIU, nie z rabatu od sumy — inaczej cena
    // jednostkowa pomnozona przez ilosc nie dawalaby sumy linii i bariera arytmetyczna
    // faktury odbilaby dokument.
    expect(p.brutto_linii).toBe('524.30');
  });

  // ⚠️ CENA KATALOGOWA JEDZIE TAKZE PRZY RABACIE ZEROWYM — bez niej pozycja jest
  // NIEWIDZIALNA dla przeliczenia, wiec rabat wpisany PO dodaniu towaru nie mialby czego
  // dotknac. To jest najczestsza kolejnosc klikniec: najpierw towar, potem ustalenia.
  it('bez rabatu też zapisuje cenę katalogową', () => {
    const p = pozycjaZProduktu(produkt, '1');
    expect(p.cena_katalogowa).toBe('74.90');
    expect(p.cena_brutto).toBe('74.90');
  });
});

describe('co wolno przeliczyć', () => {
  it('pozycja z ceną, którą wpisał panel — wolno', () => {
    expect(czyPozycjaPanelu(poz(), 0)).toBe(true);
    expect(czyPozycjaPanelu(poz({ cena_brutto: '52.43' }), 30)).toBe(true);
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEGO MODULU. Operator, ktory wynegocjowal z klientem inna kwote
  // na JEDNA rzecz, nie ma prawa stracic jej przez automat uruchomiony przy innej okazji.
  it('pozycja z ceną wystukaną ręcznie — NIE WOLNO', () => {
    expect(czyPozycjaPanelu(poz({ cena_brutto: '60.00' }), 0)).toBe(false);
  });

  it('pozycja bez ceny katalogowej — nie ma od czego liczyć', () => {
    expect(czyPozycjaPanelu(poz({ cena_katalogowa: null }), 0)).toBe(false);
  });

  // Pozycji ZE SKLEPU nie zapisuje sie wprost — jej poprawka mieszka obok, jako nadpisanie.
  it('pozycja ze sklepu — nie ta droga', () => {
    expect(czyPozycjaPanelu(poz({ zrodlo: 'sklep' }), 0)).toBe(false);
  });
});

describe('przeliczenie zamówienia', () => {
  it('nakłada rabat na pozycje panelu i wylicza kwoty linii', () => {
    const { doZmiany, pominiete } = przeliczenieRabatu([poz()], { rabatPoprzedni: 0, rabatNowy: 30 });
    expect(pominiete).toEqual([]);
    expect(doZmiany).toEqual([
      { id: 1, nazwa: 'Szablon inwalida 30x30', ilosc: 10, cena_brutto: '52.43', brutto_linii: '524.30' },
    ]);
  });

  // ⚠️ TO JEST DROGA POWROTU PO POMYLCE i musi oddawac cene katalogowa CO DO GROSZA.
  // Istnieje wylacznie dlatego, ze cena sprzed rabatu jest zapisana.
  it('rabat 0 po rabacie 30 przywraca cenę katalogową', () => {
    const { doZmiany } = przeliczenieRabatu(
      [poz({ cena_brutto: '52.43' })],
      { rabatPoprzedni: 30, rabatNowy: 0 },
    );
    expect(doZmiany[0].cena_brutto).toBe('74.90');
    expect(doZmiany[0].brutto_linii).toBe('749.00');
  });

  it('pozycję z ceną wpisaną ręcznie WYMIENIA jako pominiętą, zamiast ją cicho zostawić', () => {
    const { doZmiany, pominiete } = przeliczenieRabatu(
      [poz(), poz({ id: 2, nazwa: 'Szablon pieszy', cena_brutto: '60.00' })],
      { rabatPoprzedni: 0, rabatNowy: 30 },
    );
    expect(doZmiany.map((p) => p.id)).toEqual([1]);
    expect(pominiete).toEqual([{ id: 2, nazwa: 'Szablon pieszy' }]);
  });

  // Pozycja wpisana z reki nie jest „pominieta" — jest POZA ZAKRESEM tej operacji. Wymieniona
  // na ekranie razem z recznie poprawionymi zamienilaby prawdziwa informacje w szum.
  it('pozycja bez ceny katalogowej nie trafia do żadnego worka', () => {
    const { doZmiany, pominiete } = przeliczenieRabatu(
      [poz({ cena_katalogowa: null })],
      { rabatPoprzedni: 0, rabatNowy: 30 },
    );
    expect(doZmiany).toEqual([]);
    expect(pominiete).toEqual([]);
  });

  it('zmiana, która niczego nie zmienia, nie jedzie do bazy', () => {
    expect(przeliczenieRabatu([poz()], { rabatPoprzedni: 0, rabatNowy: 0 }).doZmiany).toEqual([]);
  });
});
