import { describe, it, expect } from 'vitest';
import {
  agreguj, delty, udzialyDokumentow, wgDni, wgTygodni, deltyKanalow,
} from '../../src/domena/agregacja-sprzedazy.js';

const w = (kanal, brutto, pozycje = []) => ({
  zrodlo: 'oms', id: 1, dzien: '2026-07-10', kanal,
  bruttoGrosze: brutto, nettoGrosze: Math.round(brutto / 1.23),
  faktura: false, oplacone: true, email: 'a@b.pl', tagi: [], pozycje,
});

const poz = (nazwa, ilosc, brutto, typ = 1) => ({ nazwa, ilosc, bruttoGrosze: brutto, typ });

describe('agregacja', () => {
  it('KPI liczy sprzedaz, zamowienia i srednia wartosc', () => {
    const { kpi } = agreguj([w('SZKICOWNIA_PL', 10000), w('SZKICOWNIA_PL', 20000)]);
    expect(kpi).toMatchObject({ bruttoGrosze: 30000, zamowien: 2, aovGrosze: 15000 });
  });

  it('pusty okres NIE dzieli przez zero', () => {
    expect(agreguj([]).kpi).toMatchObject({ bruttoGrosze: 0, zamowien: 0, aovGrosze: 0 });
  });

  it('kanaly ida malejaco i maja udzial', () => {
    const { kanaly } = agreguj([w('SZKICOWNIA_PL', 10000), w('ALLEGRO_SZKICOWNIA', 30000)]);
    expect(kanaly[0].kanal).toBe('ALLEGRO_SZKICOWNIA');
    expect(kanaly[0].udzial).toBeCloseTo(75, 1);
  });

  it('WYSYLKA I USLUGI wchodza do sumy, ale NIE do rankingu produktow ani do sztuk', () => {
    const wiersz = w('SZKICOWNIA_PL', 15000, [
      poz('Szablon Hamptons', 1, 10000, 1),
      poz('Wysyłka kurierem DPD', 1, 1900, 1),
      poz('Realizacja priorytetowa', 1, 3100, 1),
    ]);
    const { kpi, produkty } = agreguj([wiersz]);
    expect(kpi.bruttoGrosze).toBe(15000);
    expect(kpi.sztuk).toBe(1);
    expect(produkty.map((p) => p.nazwa)).toEqual(['Szablon Hamptons']);
  });

  it('ranking sumuje ten sam produkt z roznych zamowien', () => {
    const { produkty } = agreguj([
      w('SZKICOWNIA_PL', 10000, [poz('Szablon A', 2, 10000)]),
      w('ALLEGRO_SZKICOWNIA', 5000, [poz('Szablon A', 1, 5000)]),
    ]);
    expect(produkty[0]).toMatchObject({ nazwa: 'Szablon A', sztuk: 3, bruttoGrosze: 15000 });
  });

  it('ranking ma najwyzej dziesiec pozycji', () => {
    const wiersze = Array.from({ length: 14 }, (_, i) =>
      w('SZKICOWNIA_PL', 1000 * (i + 1), [poz(`P${i}`, 1, 1000 * (i + 1))]));
    expect(agreguj(wiersze).produkty).toHaveLength(10);
  });
});

describe('delty', () => {
  it('liczy zmiane procentowa', () => {
    const teraz = agreguj([w('SZKICOWNIA_PL', 20000)]).kpi;
    const wczesniej = agreguj([w('SZKICOWNIA_PL', 10000)]).kpi;
    expect(delty(teraz, wczesniej).brutto).toBeCloseTo(100, 1);
  });

  it('BRAK PORownania to null, nie zero i nie nieskonczonosc', () => {
    const teraz = agreguj([w('SZKICOWNIA_PL', 20000)]).kpi;
    expect(delty(teraz, agreguj([]).kpi).brutto).toBeNull();
    expect(delty(teraz, null).brutto).toBeNull();
  });
});

// ——— UDZIALY FAKTURA / PARAGON (17.08.2026) ——————————————————————————————————————————
// ⚠️ PROCENTY LICZY DOMENA, NIE WIDOK. Panel trzyma zasade „widok niczego nie liczy"
// (przewodnik, sekcja 3), a tu chodzi o dwie liczby, ktore maja sie ZGADZAC ze soba
// (szerokosc paska i napis w srodku) — policzone dwa razy rozjechalyby sie przy pierwszym
// zaokragleniu.
describe('udzialyDokumentow — proporcja faktura/paragon', () => {
  const wejscie = {
    faktura: { zamowien: 10, bruttoGrosze: 78201 },
    paragon: { zamowien: 14, bruttoGrosze: 132212 },
  };

  it('liczy udzial po liczbie zamowien', () => {
    const u = udzialyDokumentow(wejscie);
    expect(u.zamowien.faktura).toMatchObject({ ile: 10, procent: 42 });
    expect(u.zamowien.paragon).toMatchObject({ ile: 14, procent: 58 });
  });

  it('liczy udzial po wartosci', () => {
    const u = udzialyDokumentow(wejscie);
    expect(u.wartosc.faktura).toMatchObject({ ile: 78201, procent: 37 });
    expect(u.wartosc.paragon).toMatchObject({ ile: 132212, procent: 63 });
  });

  // ⚠️ PASEK MA MIEC DOKLADNIE 100% SZEROKOSCI. Dwa niezalezne zaokraglenia daja 33% + 67%
  // albo 33% + 66% zaleznie od liczb — a wtedy pasek zostawia szpare albo sie rozjezdza.
  // Drugi udzial jest DOPELNIENIEM pierwszego, nie osobnym rachunkiem.
  it('procenty zawsze sumuja sie do 100', () => {
    for (const [f, p] of [[1, 2], [1, 199], [7, 13], [999, 1], [50, 50]]) {
      const u = udzialyDokumentow({
        faktura: { zamowien: f, bruttoGrosze: f * 100 },
        paragon: { zamowien: p, bruttoGrosze: p * 100 },
      });
      expect(u.zamowien.faktura.procent + u.zamowien.paragon.procent).toBe(100);
      expect(u.wartosc.faktura.procent + u.wartosc.paragon.procent).toBe(100);
    }
  });

  // ⚠️ PUSTY OKRES TO `null`, NIE ZERO. „0%" przy pustym pasku wyglada jak zmierzony fakt
  // („nikt nie chcial faktury"), a znaczy „nie bylo ani jednego zamowienia".
  it('okres bez zamowien oddaje null zamiast NaN albo zera', () => {
    const u = udzialyDokumentow({
      faktura: { zamowien: 0, bruttoGrosze: 0 }, paragon: { zamowien: 0, bruttoGrosze: 0 },
    });
    expect(u.zamowien.faktura.procent).toBeNull();
    expect(u.wartosc.paragon.procent).toBeNull();
    expect(u.zamowien.razem).toBe(0);
  });

  // Sprzedaz wylacznie na paragon jest normalnym stanem miesiaca — 0% ma byc prawdziwym zerem,
  // nie brakiem danych.
  it('same paragony to 0% faktury, a nie brak danych', () => {
    const u = udzialyDokumentow({
      faktura: { zamowien: 0, bruttoGrosze: 0 }, paragon: { zamowien: 5, bruttoGrosze: 1000 },
    });
    expect(u.zamowien.faktura.procent).toBe(0);
    expect(u.zamowien.paragon.procent).toBe(100);
  });

  // ⚠️ WARTOSC I LICZBA ZAMOWIEN ROZJEZDZAJA SIE Z NATURY — jedna faktura na 5000 zl obok
  // dziesieciu paragonow po 50 zl to 9% zamowien i 91% wartosci. O to wlasnie chodzi w tym,
  // ze paski sa DWA; test pilnuje, ze panel nie zaczal liczyc obu z tego samego zrodla.
  it('udzial po wartosci NIE JEST kopia udzialu po liczbie', () => {
    const u = udzialyDokumentow({
      faktura: { zamowien: 1, bruttoGrosze: 500000 },
      paragon: { zamowien: 10, bruttoGrosze: 50000 },
    });
    expect(u.zamowien.faktura.procent).toBe(9);
    expect(u.wartosc.faktura.procent).toBe(91);
  });
});

// ——— PRZEBIEG SPRZEDAZY: DZIEN PO DNIU I TYDZIEN PO TYGODNIU (17.08.2026) ————————————
// Lista dni/tygodni przychodzi Z ZAKRESU (okresy-raportu.js), nie z danych — okres bez
// sprzedazy ma miec slupek z zerem, inaczej luka wyglada jak jej brak (wzorzec wgMiesiecy).
const dzien = (d, brutto) => ({ ...w('SZKICOWNIA_PL', brutto), dzien: d });

describe('wgDni', () => {
  it('dzien bez sprzedazy ma wiersz z zerem', () => {
    const dni = wgDni([dzien('2026-07-02', 10000)], ['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(dni).toEqual([
      { dzien: '2026-07-01', bruttoGrosze: 0, zamowien: 0 },
      { dzien: '2026-07-02', bruttoGrosze: 10000, zamowien: 1 },
      { dzien: '2026-07-03', bruttoGrosze: 0, zamowien: 0 },
    ]);
  });

  it('sumuje kilka zamowien tego samego dnia', () => {
    const dni = wgDni([dzien('2026-07-02', 10000), dzien('2026-07-02', 5000)], ['2026-07-02']);
    expect(dni).toEqual([{ dzien: '2026-07-02', bruttoGrosze: 15000, zamowien: 2 }]);
  });

  // ⚠️ Zamowienie SPOZA listy dni jest ignorowane, nie wybucha — te same wiersze ida tez
  // do KPI, ktore liczy caly zakres; lista dni bywa krotsza tylko w testach i przy bledzie,
  // a blad ma byc widoczny w liczbach slupkow, nie w piecsetce.
  it('zamowienie spoza listy dni nie wybucha i nie liczy sie', () => {
    const dni = wgDni([dzien('2026-08-01', 10000)], ['2026-07-01']);
    expect(dni).toEqual([{ dzien: '2026-07-01', bruttoGrosze: 0, zamowien: 0 }]);
  });
});

describe('wgTygodni', () => {
  it('tydzien sumuje swoje dni, granice wlacznie', () => {
    const tygodnie = [{ od: '2026-07-01', do: '2026-07-05' }, { od: '2026-07-06', do: '2026-07-12' }];
    const wynik = wgTygodni([
      dzien('2026-07-01', 1000), dzien('2026-07-05', 2000), dzien('2026-07-06', 4000),
    ], tygodnie);
    expect(wynik).toEqual([
      { od: '2026-07-01', do: '2026-07-05', bruttoGrosze: 3000, zamowien: 2 },
      { od: '2026-07-06', do: '2026-07-12', bruttoGrosze: 4000, zamowien: 1 },
    ]);
  });

  it('tydzien bez sprzedazy ma wiersz z zerem', () => {
    const wynik = wgTygodni([], [{ od: '2026-07-01', do: '2026-07-05' }]);
    expect(wynik).toEqual([{ od: '2026-07-01', do: '2026-07-05', bruttoGrosze: 0, zamowien: 0 }]);
  });
});

// ——— DELTY KANALOW (17.08.2026) — „co uroslo, co spadlo" bez tabeli rok do roku ————————
describe('deltyKanalow', () => {
  const kanal = (k, brutto) => ({ kanal: k, bruttoGrosze: brutto, zamowien: 1, aovGrosze: brutto, udzial: 50 });

  it('kanal obecny w obu okresach dostaje zmiane procentowa', () => {
    const wynik = deltyKanalow([kanal('SZKICOWNIA_PL', 15000)], [kanal('SZKICOWNIA_PL', 10000)]);
    expect(wynik[0].zmiana).toBeCloseTo(50, 5);
  });

  // ⚠️ BRAK PODSTAWY DAJE null, NIE ZERO I NIE „+∞%" — ta sama zasada, co w delty().
  it('kanal nieobecny wczesniej dostaje null, nie zero', () => {
    const wynik = deltyKanalow([kanal('GDD', 15000)], [kanal('SZKICOWNIA_PL', 10000)]);
    expect(wynik[0].zmiana).toBeNull();
  });

  it('brak calego okresu poprzedniego daje null na kazdym kanale', () => {
    const wynik = deltyKanalow([kanal('SZKICOWNIA_PL', 15000)], undefined);
    expect(wynik[0].zmiana).toBeNull();
  });

  it('nie zmienia kolejnosci ani pol kanalu', () => {
    const wynik = deltyKanalow([kanal('A', 2000), kanal('B', 1000)], []);
    expect(wynik.map((k) => k.kanal)).toEqual(['A', 'B']);
    expect(wynik[0]).toMatchObject({ bruttoGrosze: 2000, zamowien: 1 });
  });
});

// ——— KONCENTRACJA: ILE SPRZEDAZY POKRYWA LISTA TOP PRODUKTOW ————————————————————————
describe('udzialTop', () => {
  it('procent brutto okresu pokryty lista produktow', () => {
    const { udzialTop } = agreguj([
      w('SZKICOWNIA_PL', 10000, [poz('Szablon A', 1, 4000)]),
      w('SZKICOWNIA_PL', 10000, [poz('Wysyłka kurierem DPD', 1, 1900, 1)]),
    ]);
    // 4000 z 20000 — wysylka nie jest produktem, wiec nie pokrywa niczego.
    expect(udzialTop).toBeCloseTo(20, 5);
  });

  // ⚠️ PUSTY OKRES ODDAJE null, NIE ZERO — „top 10 = 0%" wygladaloby na zmierzony fakt.
  it('pusty okres oddaje null', () => {
    expect(agreguj([]).udzialTop).toBeNull();
  });
});
