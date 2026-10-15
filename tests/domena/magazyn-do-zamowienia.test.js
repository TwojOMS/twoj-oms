import { describe, it, expect } from 'vitest';
import {
  cennikDlaZamowienia, nazwaPozycji, pozycjaZProduktu, rozmiarDoPokazania, KANALY_CENNIKA, CENNIK_DOMYSLNY,
} from '../pomoc/cenniki-historyczne-fixture.js';

const produkt = (nad = {}) => ({
  kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', nazwa: 'Szablon malarski Pieszy',
  sku_sklepu: 'SZ-PIE-70', cena_gr: 7490, rozmiar_tekst: '70x100', ...nad,
});

describe('cennik — Allegro nigdy nie jest źródłem ceny', () => {
  it('zamknięta lista to wyłącznie sklepy', () => {
    expect(KANALY_CENNIKA).toEqual(['szkicownia', 'pro']);
  });

  it('zamówienie ze sklepu bierze cennik tego sklepu', () => {
    expect(cennikDlaZamowienia({ sklepZamowienia: 'pro' })).toBe('pro');
    expect(cennikDlaZamowienia({ sklepZamowienia: 'szkicownia' })).toBe('szkicownia');
  });

  // ⚠️ SEDNO ZGLOSZENIA. Kanal allegrowy zamowienia NIE przenosi sie na cennik: cene
  // z prowizja podstawiona do zamowienia telefonicznego zawyzalaby je o kwote, ktorej
  // nikomu nie placimy.
  it('zamówienie z Allegro NIE daje cennika allegrowego, tylko detal', () => {
    expect(cennikDlaZamowienia({ sklepZamowienia: 'allegro_szkicownia' })).toBe('szkicownia');
    expect(cennikDlaZamowienia({ sklepZamowienia: 'allegro_amarka' })).toBe('szkicownia');
  });

  it('zamówienie ręczne zaczyna od detalu', () => {
    expect(cennikDlaZamowienia({ sklepZamowienia: 'reczne' })).toBe(CENNIK_DOMYSLNY);
    expect(cennikDlaZamowienia({})).toBe('szkicownia');
  });

  it('świadomy wybór operatora wygrywa z kanałem zamówienia', () => {
    expect(cennikDlaZamowienia({ sklepZamowienia: 'szkicownia', wybrany: 'pro' })).toBe('pro');
  });

  it('wybór spoza listy jest ignorowany, nie przepuszczany', () => {
    expect(cennikDlaZamowienia({ sklepZamowienia: 'reczne', wybrany: 'allegro_szkicownia' })).toBe('szkicownia');
    expect(cennikDlaZamowienia({ sklepZamowienia: 'pro', wybrany: 'wymyślony' })).toBe('pro');
  });
});

describe('nazwa pozycji — rozmiar w nazwie, ale tylko raz', () => {
  it('dokłada rozmiar z wariantu', () => {
    expect(nazwaPozycji(produkt())).toBe('Szablon malarski Pieszy 70x100');
  });

  it('nie dokłada rozmiaru, który już jest w nazwie', () => {
    expect(nazwaPozycji({ nazwa: 'szablon malarski wielorazowy logo 50cm', rozmiar_tekst: '50cm' }))
      .toBe('szablon malarski wielorazowy logo 50cm');
  });

  it('porównuje bez wielkości liter', () => {
    expect(nazwaPozycji({ nazwa: 'Szablon Pieszy 70X100', rozmiar_tekst: '70x100' })).toBe('Szablon Pieszy 70X100');
  });

  it('produkt bez wariantu zostaje ze swoją nazwą', () => {
    expect(nazwaPozycji({ nazwa: 'Pędzel gąbkowy', rozmiar_tekst: null })).toBe('Pędzel gąbkowy');
  });
});

describe('pozycjaZProduktu', () => {
  it('składa pozycję z ceną z lustra i sumą linii', () => {
    expect(pozycjaZProduktu(produkt(), '3')).toEqual({
      nazwa: 'Szablon malarski Pieszy 70x100',
      sku: 'SZ-PIE-70',
      // ⚠️ CENA KATALOGOWA JEDZIE ZAWSZE, takze przy rabacie zerowym (21.08.2026) — pozycja
      // bez niej jest niewidzialna dla przeliczenia rabatem, wiec rabat wpisany na karcie
      // PO dodaniu towaru nie mialby czego dotknac.
      cena_katalogowa: '74.90',
      ilosc: 3,
      cena_brutto: '74.90',
      brutto_linii: '224.70',
      produkt_id: 28040,
      wariant_id: null,
    });
  });

  // ⚠️ Suma linii liczona na GROSZACH, nie na zlotowkach: 74.90 * 3 na floatach daje
  // 224.70000000000002, a bariera arytmetyczna faktury porownuje liczby calkowite.
  it('suma linii liczy się na groszach', () => {
    expect(pozycjaZProduktu(produkt({ cena_gr: 1990 }), '3').brutto_linii).toBe('59.70');
  });

  it('wariant trafia do pozycji — bez tego nie wiadomo, jaki rozmiar poszedł', () => {
    expect(pozycjaZProduktu(produkt({ wariant_id: '28041' }), '1').wariant_id).toBe('28041');
  });

  it('brak ilości znaczy jedną sztukę', () => {
    expect(pozycjaZProduktu(produkt(), undefined).ilosc).toBe(1);
  });

  it('ilość ułamkowa, zerowa i ujemna to odmowa', () => {
    for (const zla of ['0', '-2', '1,5', 'trzy']) {
      expect(() => pozycjaZProduktu(produkt(), zla)).toThrow(/Ilość/);
    }
  });

  // ⚠️ TU SIE PILNUJE PIENIEDZY: produkt z kanalu allegrowego ma ODMOWIC, nawet gdyby
  // ktos podal go wprost w formularzu.
  it('produkt z Allegro → odmowa, choćby miał cenę', () => {
    expect(() => pozycjaZProduktu(produkt({ kanal: 'allegro_szkicownia', cena_gr: 9900 }), '1'))
      .toThrow(/nie jest cennikiem/);
  });

  it('produkt bez ceny w tym cenniku → odmowa z podpowiedzią, a nie cena z innego kanału', () => {
    expect(() => pozycjaZProduktu(produkt({ cena_gr: null }), '1')).toThrow(/nie ma ceny w cenniku/);
    expect(() => pozycjaZProduktu(produkt({ cena_gr: 0 }), '1')).toThrow(/nie ma ceny w cenniku/);
  });

  it('brak produktu → odmowa, a nie pozycja bez nazwy', () => {
    expect(() => pozycjaZProduktu(null, '1')).toThrow(/Nie ma takiego produktu/);
  });

  // Lustro trzyma identyfikatory jako TEKST (miesci tez Allegro), a kolumna pozycji jest
  // INTEGER — nie-liczba ma isc jako brak, a nie jako NaN.
  it('nieliczbowy identyfikator produktu idzie jako brak, pozycja i tak powstaje', () => {
    const p = pozycjaZProduktu(produkt({ produkt_id: 'abc' }), '1');
    expect(p.produkt_id).toBeNull();
    expect(p.nazwa).toBe('Szablon malarski Pieszy 70x100');
  });
});

describe('rozmiarDoPokazania', () => {
  // ⚠️ Lustro wpisuje w `rozmiar_tekst` CALA NAZWE, gdy produkt nie ma atrybutu rozmiaru
  // (`rozmiarZAtrybutow(...) ?? nazwa` w services/magazyn-sync.js). Zmierzone na produkcji:
  // „Dwa kotki - aplikacja 30x48cm" wychodzilo na liscie dwa razy pod rzad.
  it('nie pokazuje rozmiaru, który jest całą nazwą', () => {
    expect(rozmiarDoPokazania({ nazwa: 'Dwa kotki - aplikacja 30x48cm', rozmiar_tekst: 'Dwa kotki - aplikacja 30x48cm' }))
      .toBeNull();
  });

  it('pokazuje prawdziwy rozmiar wariantu', () => {
    expect(rozmiarDoPokazania({ nazwa: 'Szablon malarski Pieszy', rozmiar_tekst: '70x100' })).toBe('70x100');
  });

  it('milczy, gdy rozmiaru nie ma', () => {
    expect(rozmiarDoPokazania({ nazwa: 'Pędzel', rozmiar_tekst: null })).toBeNull();
  });

  // Ta sama regula, co przy nazwie pozycji — ekran i faktura maja mowic o tym samym.
  it('gaśnie dokładnie wtedy, gdy nazwa pozycji też nie dostaje rozmiaru', () => {
    const p = { nazwa: 'szablon logo 50cm', rozmiar_tekst: '50cm' };
    expect(rozmiarDoPokazania(p)).toBeNull();
    expect(nazwaPozycji(p)).toBe('szablon logo 50cm');
  });
});
