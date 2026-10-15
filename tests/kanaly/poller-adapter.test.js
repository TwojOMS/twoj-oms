import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createPoller } from '../../src/moduly/kanaly/services/poller.js';

// Baza jak w kazdym innym tescie modulu: przez `openOmsDb`, a NIE przez surowe wczytanie
// `schema.sql`. Panel nie uzywa better-sqlite3 — siedzi na wbudowanym `node:sqlite`
// (db/db.js), a `openOmsDb` dokłada do schematu migracje kolumn, ktorych sam plik
// schema.sql juz nie zawiera.
function baza() {
  return openOmsDb(':memory:');
}

// Adapter-atrapa: kanał, który NIE JEST WooCommerce. Jeśli poller nadal czyta pola
// `date_modified_gmt`/`date_created_gmt` wprost z surowego zamówienia, ten test padnie.
function kanalObcy(strony) {
  return {
    wolania: [],
    async pobierzStrone(arg) { this.wolania.push(arg); return strony[arg.strona - 1] ?? { zamowienia: [], stron: strony.length }; },
    kursorZ: (s) => s.zmienioneKiedy ?? null,
    zlozoneZ: (s) => s.zlozoneKiedy ?? null,
    // Komplet pol wiersza, bo `zapiszZamowienie` wiaze je do SQLite wprost i `undefined`
    // nie jest wartoscia, ktora da sie zwiazac. Zadne z nich nie interesuje POLLERA —
    // i o to wlasnie chodzi: ksztalt wiersza nalezy do adaptera, nie do niego.
    mapuj: (s) => ({
      zrodlo_id: s.identyfikator,
      numer: String(s.identyfikator),
      klient: {},
      dostawa: {},
      metoda_wysylki: 'nieznana',
      pobranie: false,
      kwota_pobrania: null,
      chce_fakture: 0,
      nip: null,
      kwota_brutto: '0.00',
      status_woo: 'processing',
      oplacone_at: null,
      anulowane: 0,
      pozycje: [],
    }),
  };
}

describe('poller rozmawia z kanałem przez adapter, nie z WooCommerce', () => {
  it('zapisuje zamówienie i przesuwa kursor po polach WSKAZANYCH PRZEZ ADAPTER', async () => {
    const db = baza();
    const kanal = kanalObcy([{
      zamowienia: [{ identyfikator: 77, zlozoneKiedy: '2026-08-01T10:00:00Z', zmienioneKiedy: '2026-08-02T11:00:00Z' }],
      stron: 1,
    }]);
    const poller = createPoller({ db, kanal, sklep: 'allegro_szkicownia', od: null });

    const wynik = await poller.przebieg();

    expect(wynik.pobrane).toBe(1);
    expect(poller.stan().zsynchronizowane_do).toBe('2026-08-02T11:00:00Z');
    expect(db.prepare('SELECT zrodlo_id FROM zamowienia WHERE sklep = ?').get('allegro_szkicownia').zrodlo_id).toBe(77);
  });

  it('PODŁOGA po dacie złożenia obowiązuje tak samo — a kursor i tak przeskakuje pominięte', async () => {
    const db = baza();
    const kanal = kanalObcy([{
      zamowienia: [{ identyfikator: 1, zlozoneKiedy: '2019-05-05T10:00:00Z', zmienioneKiedy: '2026-08-02T11:00:00Z' }],
      stron: 1,
    }]);
    const poller = createPoller({ db, kanal, sklep: 'allegro_szkicownia', od: '2026-07-01' });

    const wynik = await poller.przebieg();

    expect(wynik.pobrane).toBe(0);
    expect(wynik.pominieteStare).toBe(1);
    // Bez tego panel czytałby archiwum w kółko przy każdym przebiegu.
    expect(poller.stan().zsynchronizowane_do).toBe('2026-08-02T11:00:00Z');
  });

  // ⚠️ TEN TEST JEST TU PO WERYFIKACJI MUTACYJNEJ, a nie dla kompletu. Dwa testy wyżej
  // mają po JEDNYM zamówieniu na stronie, więc `!kursor` zwiera warunek i porównanie
  // `znacznik > kursor` w ogóle się nie wykonuje — odwrócenie go na `<` przechodziło przez
  // nie bez mrugnięcia. Kursor MUSI zostać na NAJPÓŹNIEJSZEJ modyfikacji, a nie na
  // ostatniej przetworzonej: przy odwróconym porównaniu cofnąłby się na wcześniejszą,
  // a każdy następny przebieg czytałby te same zamówienia od nowa.
  it('kursor zostaje na NAJPÓŹNIEJSZEJ modyfikacji, choćby przyszła nie na końcu strony', async () => {
    const db = baza();
    const kanal = kanalObcy([{
      zamowienia: [
        { identyfikator: 1, zlozoneKiedy: '2026-08-01T10:00:00Z', zmienioneKiedy: '2026-08-02T15:00:00Z' },
        { identyfikator: 2, zlozoneKiedy: '2026-08-01T10:00:00Z', zmienioneKiedy: '2026-08-02T09:00:00Z' },
      ],
      stron: 1,
    }]);
    const poller = createPoller({ db, kanal, sklep: 'allegro_szkicownia', od: null });

    expect((await poller.przebieg()).pobrane).toBe(2);
    expect(poller.stan().zsynchronizowane_do).toBe('2026-08-02T15:00:00Z');
  });

  // Adapter dostaje komplet parametrow okna: `od` (trwala podloga po dacie ZLOZENIA),
  // `kursor` (ZAPISANY kursor pollera, wiec `null`, gdy pollera jeszcze nie bylo) i numer
  // strony. Gdyby poller przestal podawac ktorys z nich, kanal nie mialby jak zawezic
  // zapytania i pobieralby od poczatku historii.
  it('przekazuje kanałowi okno: `od`, ZAPISANY `kursor` i numer strony', async () => {
    const db = baza();
    const kanal = kanalObcy([{ zamowienia: [], stron: 1 }]);
    const poller = createPoller({ db, kanal, sklep: 'allegro_szkicownia', od: '2026-07-01' });

    await poller.przebieg();

    expect(kanal.wolania).toEqual([{ od: '2026-07-01', kursor: null, strona: 1 }]);
  });

  // ⚠️ TEN TEST PILNUJE KONTRAKTU, NIE ZACHOWANIA WOO. `kursor` przez chwile znaczyl
  // `poprzedni ?? od`, czyli na pierwszym przebiegu NIGDY nie bywal pusty. Woo tego nie
  // odczuwa (i tak pyta po dacie modyfikacji), ale adapter, ktory WYBIERA miedzy filtrem po
  // modyfikacji a filtrem po dacie zlozenia — czyli Allegro — na pustym stanie zawsze
  // wchodzilby w galaz „mam kursor" i pytal o wszystko zmodyfikowane od daty startowej.
  // To jest awaria z 01.08.2026 (wciagniete archiwum) przeniesiona na kolejny kanal.
  // Adapter MUSI widziec prawdziwy brak kursora.
  it('kursor to ZAPISANY kursor: null przy pustym stanie, zapisana wartość później', async () => {
    const db = baza();
    const kanal = kanalObcy([{
      zamowienia: [{ identyfikator: 5, zlozoneKiedy: '2026-07-15T10:00:00Z', zmienioneKiedy: '2026-08-02T11:00:00Z' }],
      stron: 1,
    }]);
    const poller = createPoller({ db, kanal, sklep: 'allegro_szkicownia', od: '2026-07-01' });

    await poller.przebieg();
    // Pusty stan pollera: kursor jest NULLEM, a nie wartoscia `od`.
    expect(kanal.wolania[0]).toEqual({ od: '2026-07-01', kursor: null, strona: 1 });

    await poller.przebieg();
    // Po zapisanym kursorze idzie DOKLADNIE on — `od` zostaje osobno jako podloga.
    expect(kanal.wolania[1]).toEqual({ od: '2026-07-01', kursor: '2026-08-02T11:00:00Z', strona: 1 });
  });
});
