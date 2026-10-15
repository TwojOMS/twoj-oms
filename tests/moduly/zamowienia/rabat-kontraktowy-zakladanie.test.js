import { describe, it, expect, beforeEach } from 'vitest';

import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { NAZWA_KURIERA } from '../../../src/domena/oplata-obslugi.js';

const NIP = '1000001017';
const znacznik = '2026-08-24T09:00:00.000Z';

const config = {};

let db;

beforeEach(() => {
  db = openOmsDb(':memory:');
  dopiszKlienta(db, {
    klucz: 'zetaklient', nazwa: 'Zetaklient Drogowe', nip: NIP, b2b: 1, rabat_procent: 40,
    chce_fakture: 1, metoda_wysylki: 'dpd', aktywny: 1,
    koszt_dostawy_brutto: '0.00', platnosc: 'Przelew', termin_platnosci: null, komentarz: null,
    // ⚠️ WARUNKI UMOWY MIESZKAJA OD 24.08.2026 NA KARCIE KLIENTA — do tego dnia szly
    // z `OMS_KLIENCI_ZBIORCZY`, wiec ten sam test budowal je w `config`.
    rozliczenie_zbiorcze: 1, prog_darmowej_dostawy_gr: 50000,
    oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
  });
});

/** Zamówienie ręczne dla klienta z NIP-em, z jedną pozycją po cenie katalogowej. */
const daneZ = ({ nip = NIP, rabat = 0, cena = '100.00', ilosc = 1 } = {}) => ({
  klient: { first_name: 'Ewa', last_name: 'Zieliński', email: 'biuro@zetaklientdrogowe.pl' },
  dostawa: { first_name: 'Ewa', last_name: 'Zieliński', address_1: 'Długa 1' },
  nip,
  chce_fakture: 1,
  metoda_wysylki: 'dpd',
  pobranie: 0,
  metoda_platnosci: 'Przelew',
  koszt_dostawy_brutto: '0.00',
  b2b: 1,
  termin_platnosci: null,
  rabat_procent: rabat,
  pozycje: [{
    nazwa: 'Szablon PIESI', sku: null, ilosc, cena_brutto: cena,
    brutto_linii: (Number(cena) * ilosc).toFixed(2), cena_katalogowa: cena,
  }],
});

const pozycjeTowaru = (z) => z.pozycje.filter((p) => p.nazwa === 'Szablon PIESI');

describe('rabat kontraktowy przy zakładaniu zamówienia', () => {
  it('NIP klienta z umową obniża cenę pozycji, bez klikania „Wstaw dane klienta"', () => {
    const { id } = zalozZamowienieReczne({ db, dane: daneZ(), znacznik });
    const z = pobierzZamowienie(db, id);
    expect(z.rabat_procent).toBe(40);
    expect(pozycjeTowaru(z)[0].cena_brutto).toBe('60.00');
    expect(pozycjeTowaru(z)[0].cena_katalogowa).toBe('100.00');
  });

  // ⚠️ TEN TEST PILNUJE KOLEJNOSCI W `dokoncz`, a nie samej opłaty. Próg darmowej dostawy
  // (500 zł) liczy się od wartości towaru PO rabacie: 520 zł katalogowo to po 40% jedyne
  // 312 zł, czyli PONIŻEJ progu — należy się „Usługa kurierska". Rabat naliczony PO opłacie
  // policzyłby próg od 520 zł i opłata by nie weszła. Test padnie, gdy ktoś przestawi
  // kolejność kroków.
  it('próg darmowej dostawy liczy się od ceny PO rabacie', () => {
    const { id } = zalozZamowienieReczne({
      db, dane: daneZ({ cena: '520.00' }), znacznik,
    });
    const z = pobierzZamowienie(db, id);
    expect(pozycjeTowaru(z)[0].cena_brutto).toBe('312.00');
    expect(z.pozycje.map((p) => p.nazwa)).toContain(NAZWA_KURIERA);
  });

  it('rabat uzgodniony ręcznie (25%) NIE jest nadpisywany stawką z umowy', () => {
    const { id } = zalozZamowienieReczne({
      db, dane: daneZ({ rabat: 25, cena: '100.00' }), znacznik,
    });
    const z = pobierzZamowienie(db, id);
    expect(z.rabat_procent).toBe(25);
    expect(pozycjeTowaru(z)[0].cena_brutto).toBe('100.00');
  });

  it('klient bez umowy nie dostaje żadnego rabatu', () => {
    const { id } = zalozZamowienieReczne({
      db, dane: daneZ({ nip: '5252248481' }), znacznik,
    });
    const z = pobierzZamowienie(db, id);
    expect(z.rabat_procent).toBe(0);
    expect(pozycjeTowaru(z)[0].cena_brutto).toBe('100.00');
  });
});
