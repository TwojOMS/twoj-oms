import { describe, it, expect } from 'vitest';
import { wybierzKampanie, stanKampanii, agregatKuponow } from '../../src/domena/kampania.js';

// Zakladka /kampania (WRZESIEN30, 2026-08-25). Domena dostaje zamowienia PO zLinii
// (anulowane juz efektywne, oplacone_at juz z listy wplat) i NIE liczy zadnej reguly
// statusu ani platnosci drugi raz — sklada wylacznie kafle, dni i tabele.

const KAMPANIA = {
  id: 1, kod: 'wrzesien30', nazwa: 'Nowy początek. Bez remontu.',
  od_dnia: '2026-08-24', do_dnia: '2026-09-07', sklep: 'szkicownia', cel_uzyc: 10,
};

// Ksztalt zLinii: kupony_json prosto z kolumny, kwoty napisami, anulowane efektywne.
const zam = (nad = {}) => ({
  id: 1, numer: '28224', sklep: 'szkicownia', kwota_brutto: '150.72',
  utworzone_at: '2026-08-25T17:42:45Z', anulowane: 0, oplacone_at: '2026-08-25T17:43:27Z',
  kupony_json: '[{"kod":"wrzesien30","rabat":"58.17"}]',
  pozycje: [], ...nad,
});

describe('wybierzKampanie', () => {
  const LISTA = [
    { ...KAMPANIA, id: 2, kod: 'zima40', od_dnia: '2026-12-01', do_dnia: '2026-12-14' },
    KAMPANIA,
  ];

  it('wskazany kod wygrywa, niezależnie od okna (wielkość liter bez znaczenia)', () => {
    expect(wybierzKampanie(LISTA, '2026-08-25', 'ZIMA40')?.id).toBe(2);
  });

  it('nieznany kod → null, a nie cicha podmiana na inną kampanię', () => {
    expect(wybierzKampanie(LISTA, '2026-08-25', 'nie-ma')).toBeNull();
  });

  it('bez wskazania bierze kampanię, której okno obejmuje dziś', () => {
    expect(wybierzKampanie(LISTA, '2026-08-25')?.kod).toBe('wrzesien30');
  });

  it('gdy żadne okno nie obejmuje dziś — pierwsza z listy (najnowsza)', () => {
    expect(wybierzKampanie(LISTA, '2026-10-01')?.kod).toBe('zima40');
  });

  it('pusta lista → null', () => {
    expect(wybierzKampanie([], '2026-08-25')).toBeNull();
  });
});

describe('stanKampanii — kafle', () => {
  it('liczy użycia, przychód, rabaty i średnią z zamówień nieanulowanych w oknie', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [
        zam(),
        zam({ id: 2, numer: '28230', kwota_brutto: '100.00', kupony_json: '[{"kod":"wrzesien30","rabat":"42.86"}]', oplacone_at: null }),
      ],
      dzis: '2026-08-25',
    });
    expect(stan.uzycia).toBe(2);
    expect(stan.przychodZl).toBe('250.72');
    expect(stan.rabatyZl).toBe('101.03');
    expect(stan.sredniaZl).toBe('125.36');
    expect(stan.oplaconeZl).toBe('150.72');
    expect(stan.doZaplatyZl).toBe('100.00');
  });

  it('anulowane nie wchodzi do kafli, ale jest policzone osobno i widoczne w tabeli', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam(), zam({ id: 2, numer: '28231', anulowane: 1 })],
      dzis: '2026-08-25',
    });
    expect(stan.uzycia).toBe(1);
    expect(stan.anulowanych).toBe(1);
    expect(stan.przychodZl).toBe('150.72');
    expect(stan.wiersze).toHaveLength(2);
    expect(stan.wiersze.find((w) => w.numer === '28231').status).toBe('anulowane');
  });

  it('rabat liczy WYŁĄCZNIE kod kampanii, także przy zamówieniu z dwoma kodami', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({
        kupony_json: '[{"kod":"wrzesien30","rabat":"10.00"},{"kod":"inny","rabat":"99.00"}]',
      })],
      dzis: '2026-08-25',
    });
    expect(stan.rabatyZl).toBe('10.00');
  });

  it('kod w kolumnie wielkimi literami też się liczy', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({ kupony_json: '[{"kod":"WRZESIEN30","rabat":"58.17"}]' })],
      dzis: '2026-08-25',
    });
    expect(stan.uzycia).toBe(1);
  });
});

describe('stanKampanii — okno i zasięg', () => {
  it('dni graniczne okna wchodzą z obu stron', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [
        zam({ utworzone_at: '2026-08-24T00:10:00' }),
        zam({ id: 2, numer: '2', utworzone_at: '2026-09-07T23:50:00' }),
      ],
      dzis: '2026-08-25',
    });
    expect(stan.uzycia).toBe(2);
    expect(stan.pozaZasiegiem).toBe(0);
  });

  // 25.08 22:30 UTC to juz 26.08 w Warszawie — zamowienie z nocy ma stanac w slupku
  // wlasciwego dnia kalendarza, ktory widzi wlasciciel (ta sama regula, co filtr listy).
  it('dzień liczy się czasem warszawskim, nie UTC', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({ utworzone_at: '2026-08-25T22:30:00Z' })],
      dzis: '2026-08-26',
    });
    expect(stan.dni.find((d) => d.dzien === '2026-08-26').uzycia).toBe(1);
    expect(stan.dni.find((d) => d.dzien === '2026-08-25').uzycia).toBe(0);
  });

  it('użycie poza oknem albo z innego sklepu idzie do „poza zasięgiem", nie do kafli', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [
        zam({ utworzone_at: '2026-08-20T10:00:00' }),
        zam({ id: 2, numer: '2', sklep: 'pro' }),
        zam({ id: 3, numer: '3' }),
      ],
      dzis: '2026-08-25',
    });
    expect(stan.uzycia).toBe(1);
    expect(stan.pozaZasiegiem).toBe(2);
  });

  it('zamówienie bez kodu kampanii w ogóle nie wchodzi do stanu', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zam({ kupony_json: '[{"kod":"free50","rabat":"12.15"}]' })],
      dzis: '2026-08-25',
    });
    expect(stan.uzycia).toBe(0);
    expect(stan.pozaZasiegiem).toBe(0);
    expect(stan.wiersze).toHaveLength(0);
  });
});

describe('stanKampanii — dni i faza', () => {
  it('buduje słupek dla każdego dnia okna i oznacza dziś', () => {
    const stan = stanKampanii({ kampania: KAMPANIA, zamowienia: [zam()], dzis: '2026-08-25' });
    expect(stan.dni).toHaveLength(15);
    expect(stan.dni[0].dzien).toBe('2026-08-24');
    expect(stan.dni.at(-1).dzien).toBe('2026-09-07');
    expect(stan.dni.find((d) => d.dzis)?.dzien).toBe('2026-08-25');
    expect(stan.dni.find((d) => d.dzien === '2026-08-25').uzycia).toBe(1);
  });

  it('faza i dzień kampanii: trwa → „dzień 2 z 15"', () => {
    const stan = stanKampanii({ kampania: KAMPANIA, zamowienia: [], dzis: '2026-08-25' });
    expect(stan.faza).toBe('trwa');
    expect(stan.dzienKampanii).toBe(2);
    expect(stan.dniOkna).toBe(15);
  });

  it('faza przed startem i po końcu', () => {
    expect(stanKampanii({ kampania: KAMPANIA, zamowienia: [], dzis: '2026-08-20' }).faza).toBe('przed');
    expect(stanKampanii({ kampania: KAMPANIA, zamowienia: [], dzis: '2026-09-10' }).faza).toBe('po');
  });

  // Zla konfiguracja wiersza kampanii (literowka w dacie) nie ma prawa wywalic zakladki —
  // ekran mowi o bledzie wprost zamiast oddawac 500 albo pusty wykres bez slowa.
  it('odwrócone okno → bladOkna i zero dni, bez wyjątku', () => {
    const stan = stanKampanii({
      kampania: { ...KAMPANIA, od_dnia: '2026-09-07', do_dnia: '2026-08-24' },
      zamowienia: [], dzis: '2026-08-25',
    });
    expect(stan.bladOkna).toBeTruthy();
    expect(stan.dni).toHaveLength(0);
  });
});

// ⚠️ TE ASERCJE POWSTALY PO WERYFIKACJI MUTACYJNEJ (Etap 3). Test WIDOKU sprawdzal
// obecnosc napisu „Nie wiadomo (sprzed atrybucji)" na stronie — a ten sam napis stoi
// w TABELI ZAMOWIEN, wiec przechodzil takze wtedy, gdy rozbicie wg zrodel doliczalo
// zamowienia bez atrybucji do „Bezpośrednich". Zestawienie mowilo wtedy nieprawde
// o zachowaniu klientow, a strona wygladala poprawnie.
describe('stanKampanii — rozbicie wg źródeł', () => {
  const zAtrybucja = (id, atrybucja, nad = {}) => zam({
    id, numer: String(id), atrybucja_json: atrybucja ? JSON.stringify(atrybucja) : null, ...nad,
  });

  it('grupuje użycia po źródle, z kwotami i rabatami', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [
        zAtrybucja(1, { typ: 'typein', zrodlo: '(direct)' }),
        zAtrybucja(2, { typ: 'typein', zrodlo: '(direct)' }, { kwota_brutto: '100.00' }),
        zAtrybucja(3, { typ: 'organic', zrodlo: 'google' }, { kwota_brutto: '50.00' }),
      ],
      dzis: '2026-08-25',
    });

    expect(stan.zrodla.map((z) => [z.etykieta, z.uzycia])).toEqual([
      ['Bezpośrednie', 2],
      ['Google — wyszukiwarka', 1],
    ]);
    expect(stan.zrodla[0].kwotaZl).toBe('250.72');
    expect(stan.zrodla[1].kwotaZl).toBe('50.00');
  });

  // ⚠️⚠️ SEDNO: brak atrybucji ma WŁASNY wiersz. Doliczony do „Bezpośrednich" zamieniałby
  // lukę w danych (zamówienie sprzed włączenia atrybucji) w fakt o zachowaniu klienta.
  it('zamówienia bez atrybucji stoją osobno, NIE w „Bezpośrednich"', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zAtrybucja(1, { typ: 'typein', zrodlo: '(direct)' }), zAtrybucja(2, null)],
      dzis: '2026-08-25',
    });

    expect(stan.zrodla).toHaveLength(2);
    const bezpo = stan.zrodla.find((z) => z.etykieta === 'Bezpośrednie');
    const brak = stan.zrodla.find((z) => z.klucz === 'brak');
    expect(bezpo.uzycia).toBe(1);
    expect(brak.uzycia).toBe(1);
  });

  it('anulowane nie wchodzą do rozbicia (tak samo jak do kafli)', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [
        zAtrybucja(1, { typ: 'organic', zrodlo: 'google' }),
        zAtrybucja(2, { typ: 'organic', zrodlo: 'google' }, { anulowane: 1 }),
      ],
      dzis: '2026-08-25',
    });
    expect(stan.zrodla).toHaveLength(1);
    expect(stan.zrodla[0].uzycia).toBe(1);
  });

  it('każdy wiersz tabeli zamówień niesie gotowy opis źródła', () => {
    const stan = stanKampanii({
      kampania: KAMPANIA,
      zamowienia: [zAtrybucja(1, { typ: 'referral', zrodlo: 'm.facebook.com' })],
      dzis: '2026-08-25',
    });
    expect(stan.wiersze[0].zrodlo.etykieta).toBe('m.facebook.com — odsyłacz');
  });
});

describe('agregatKuponow', () => {
  it('grupuje po kodzie bez względu na wielkość liter, anulowane osobno', () => {
    const wynik = agregatKuponow([
      zam(),
      zam({ id: 2, numer: '2', kupony_json: '[{"kod":"WRZESIEN30","rabat":"42.86"}]', kwota_brutto: '100.00' }),
      zam({ id: 3, numer: '3', anulowane: 1 }),
      zam({ id: 4, numer: '4', kupony_json: '[{"kod":"free50","rabat":"12.15"}]', kwota_brutto: '14.95', sklep: 'pro' }),
    ]);
    const wrz = wynik.find((k) => k.kod === 'wrzesien30');
    expect(wrz.uzycia).toBe(2);
    expect(wrz.anulowane).toBe(1);
    expect(wrz.rabatyZl).toBe('101.03');
    expect(wrz.obrotZl).toBe('250.72');
    expect(wrz.ostatnio).toBe('2026-08-25');
    expect(wynik[0].kod).toBe('wrzesien30');
  });

  it('zamówienia bez kuponów dają pustą listę', () => {
    expect(agregatKuponow([zam({ kupony_json: null })])).toEqual([]);
  });
});
