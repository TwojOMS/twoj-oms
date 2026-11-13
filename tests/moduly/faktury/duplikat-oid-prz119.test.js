// PRZ-119.03 — identyfikator zamówienia (`oid`) dla programu i odmowa „duplikat”.
//
// Fakturownia z `oid_unique` odrzuca (422) drugi dokument dla tego samego zamówienia. To NIE jest zwykła odmowa 4xx
// („dokumentu na pewno nie ma”): pierwszy dokument ISTNIEJE. Usługa nie może więc zwolnić rezerwacji — zostaje
// „do wyjaśnienia”, jak przy awarii niejednoznacznej. Program testowy — kontrakt, nie Fakturownia.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres, pobierzOkres } from '../../../src/oms/db/okresy.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { stanFaktury } from '../../../src/domena/faktura-stan.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const NIP_PRACOWNI = '5250000009'; // zmyślony
const TERAZ = () => '2026-11-12T10:00:00.000Z';

const zamowienie = {
  zrodlo_id: 4101, numer: 'R/2026/041',
  klient: { first_name: 'Ewa', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid', address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: NIP_PRACOWNI, kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing', oplacone_at: '2026-11-11T13:00:00', anulowane: 0, utworzone_at: '2026-11-11T13:00:00',
  pozycje: [{ nazwa: 'Lampa stołowa Kałamarz (zmyślona)', sku: 'LMP-01', ilosc: 2, cena_brutto: '61.50', vat: null }],
};

const duplikat = () => Object.assign(new Error('Już jest faktura dla zamówienia X w Programie'), { dlaOperatora: true, status: 422, duplikat: true });
const zwykla422 = () => Object.assign(new Error('Program odrzucił fakturę (422)'), { dlaOperatora: true, status: 422 });

function zestaw(program) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', zamowienie, {});
  const faktura = createFaktura({ db, program, nipSprzedawcy: '1234563218', teraz: TERAZ });
  return { db, id, faktura };
}
const wiersz = (db, id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);

function bazaZOkresem() {
  const db = openOmsDb();
  const okres = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 3 });
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600041, 'R/2026/041', '100.00', ?, '2026-10-10T10:00:00.000Z')",
  ).run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/041').id;
  db.prepare(
    "INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo) VALUES (?, 'Lampa (zmyślona)', 1, '100.00', '100.00', 'reczna')",
  ).run(zamId);
  return { db, okres };
}

describe('PRZ-119.03 faktura zamówienia — oid i duplikat', () => {
  it('program dostaje oid = sklep-numer zamówienia jako drugi argument wystaw', async () => {
    const program = programTestowy();
    const { id, faktura } = zestaw(program);
    await faktura.wystaw(id);
    expect(program.wystaw.mock.calls[0][1]).toEqual({ oid: 'pro-R/2026/041' });
  });

  it('odmowa „duplikat” (422) → rezerwacja ZOSTAJE, stan do wyjaśnienia, drugie wystawienie odmawia bez programu', async () => {
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(duplikat()) } });
    const { db, id, faktura } = zestaw(program);
    await expect(faktura.wystaw(id)).rejects.toThrow(/Już jest faktura/);
    const f = wiersz(db, id);
    expect(f).toBeDefined();
    expect(stanFaktury(f)).toBe('do_wyjasnienia');
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(program.ile('wystaw')).toBe(1);
  });

  it('zwykła 422 bez flagi duplikatu → rezerwacja zwolniona jak dotąd', async () => {
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(zwykla422()) } });
    const { db, id, faktura } = zestaw(program);
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(wiersz(db, id)).toBeUndefined();
  });
});

describe('PRZ-119.03 faktura okresu — oid i duplikat', () => {
  it('program dostaje oid = okres-<klient_klucz>-<RRRR>-<MM> (plan; reset bazy nie daje fałszywego duplikatu)', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy();
    await createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI });
    expect(program.wystaw.mock.calls[0][1]).toEqual({ oid: 'okres-polcien-2026-03' });
  });

  it('odmowa „duplikat” → okres do wyjaśnienia, NIE otwarty z powrotem', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(duplikat()) } });
    await expect(createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI })).rejects.toThrow(/Już jest faktura/);
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBe('do_wyjasnienia');
    expect(po.stan).not.toBe(STAN.OTWARTY);
  });

  it('zwykła 422 → okres otwarty z powrotem jak dotąd', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(zwykla422()) } });
    await expect(createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI })).rejects.toThrow();
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.OTWARTY);
  });
});
