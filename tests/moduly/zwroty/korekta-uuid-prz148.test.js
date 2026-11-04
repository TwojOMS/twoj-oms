import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zwrot, zapiszKorekte } from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';

let db; let id; let a; let program;
const dokument = { uuid: 'kor-a', number: '1/KOR/11/2026', corrected_invoice_number: 'FV/1', invoice_date: '2000-01-01' };
const dodaj = (data = '2026-11-04') => dodajZwrot(db, id, { data, kwota: '10.00',
  pozycje: [{ klucz_pozycji: 's1', nazwa: 'Lampa Półcień', ilosc: 1, kwota: '10.00' }] }).id;
const odczytaj = () => createKorekta({ db, program }).doczytaj(id, a);
const wpisy = () => db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'zwrot.korekta.odczyt'").all(id);

beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'reczne', { zrodlo_id: 14809, numer: '14809',
    klient: { company: 'Pracownia Półcień', email: 'biuro@example.test' }, dostawa: {},
    metoda_wysylki: 'dpd', chce_fakture: 1, kwota_pobrania: null, nip: null, oplacone_at: null, anulowane: 0,
    kwota_brutto: '20.00', status_woo: 'processing',
    utworzone_at: '2026-11-01T10:00:00',
    pozycje: [{ zrodlo_id: 1, nazwa: 'Lampa Półcień', sku: 'LAMPA-P1', vat: null,
      ilosc: 2, cena_brutto: '10.00', brutto_linii: '20.00' }],
  }, {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'fv-a', 'FV/1', '2026-11-01T10:00:00Z');
  a = dodaj();
  db.prepare('UPDATE zwroty SET korekta_zlecona_at = ?, korekta_referencja = ? WHERE id = ?')
    .run('2026-11-04T10:00:00Z', 'REF-A', a);
  program = {
    opis: { id: 'infakt', nazwa: { mianownik: 'Program Półcień', miejscownik: 'Programie Półcień' } },
    statusKorekty: vi.fn().mockResolvedValue({ stan: 'wystawiona', uuid: 'kor-a', bledy: [] }),
    pobierzKorekte: vi.fn().mockResolvedValue({ ...dokument }),
    listaKorekt: vi.fn().mockResolvedValue([{ ...dokument, invoice_date: '2026-11-04' }]),
  };
});
afterEach(() => db.close());

it('uuid ze statusu zapisuje numer i ślad bez listy oraz bez sita daty', async () => {
  await odczytaj();
  expect(program.pobierzKorekte).toHaveBeenCalledExactlyOnceWith('kor-a');
  expect(program.listaKorekt).not.toHaveBeenCalled();
  expect(zwrot(db, id, a)).toMatchObject({ korekta_uuid: 'kor-a', korekta_numer: dokument.number });
  expect(wpisy()).toHaveLength(1);
  expect(wpisy()[0].wynik).toContain('po numerze zlecenia');
});

it('uuid rozstrzyga dwa otwarte zwroty przed W3', async () => {
  const b = dodaj('2026-11-03');
  db.prepare('UPDATE zwroty SET korekta_zlecona_at = ?, korekta_referencja = ? WHERE id = ?')
    .run('2026-11-04T10:00:00Z', 'REF-B', b);
  await odczytaj();
  expect(zwrot(db, id, a).korekta_numer).toBe(dokument.number);
  expect(zwrot(db, id, b).korekta_numer).toBeNull();
  expect(program.listaKorekt).not.toHaveBeenCalled();
});

it('błąd odczytu uuid pozostawia drogę listy', async () => {
  program.pobierzKorekte.mockRejectedValue(new Error('404'));
  await odczytaj();
  expect(program.listaKorekt).toHaveBeenCalledExactlyOnceWith({});
  expect(zwrot(db, id, a).korekta_numer).toBe(dokument.number);
});

it.each(['uuid', 'numer'])('zajęty %s blokuje zapis i listę', async (pole) => {
  const b = dodaj('2026-11-03');
  zapiszKorekte(db, id, b, { uuid: pole === 'uuid' ? dokument.uuid : 'inna-kor',
    numer: pole === 'numer' ? dokument.number : '2/KOR/11/2026' });
  await odczytaj();
  expect(zwrot(db, id, a).korekta_numer).toBeNull();
  expect(program.listaKorekt).not.toHaveBeenCalled();
  expect(wpisy()).toHaveLength(0);
});

it.each([null, {}, { ...dokument, number: '' }, { ...dokument, corrected_invoice_number: 'FV/OBCA' }])(
  'niepasujący dokument %j kończy odczyt bez listy', async (wynik) => {
    program.pobierzKorekte.mockResolvedValue(wynik);
    await odczytaj();
    expect(zwrot(db, id, a).korekta_numer).toBeNull();
    expect(program.listaKorekt).not.toHaveBeenCalled();
    expect(wpisy()).toHaveLength(0);
  },
);

it.each([undefined, null, ''])('pusty numer faktury %s dopuszcza odczyt uuid', async (numer) => {
  program.pobierzKorekte.mockResolvedValue({ ...dokument, corrected_invoice_number: numer });
  await odczytaj();
  expect(zwrot(db, id, a).korekta_numer).toBe(dokument.number);
  expect(program.listaKorekt).not.toHaveBeenCalled();
});

it('zlecenie bez referencji idzie listą', async () => {
  db.prepare('UPDATE zwroty SET korekta_referencja = NULL WHERE id = ?').run(a);
  await odczytaj();
  expect(program.pobierzKorekte).not.toHaveBeenCalled();
  expect(program.statusKorekty).not.toHaveBeenCalled();
  expect(program.listaKorekt).toHaveBeenCalledTimes(1);
  expect(zwrot(db, id, a).korekta_numer).toBe(dokument.number);
});

it('program bez odczytu korekty idzie listą', async () => {
  delete program.pobierzKorekte;
  await odczytaj();
  expect(program.listaKorekt).toHaveBeenCalledTimes(1);
  expect(zwrot(db, id, a).korekta_numer).toBe(dokument.number);
});

it('dokument bez uuid sprawdza zajętość uuid ze statusu', async () => {
  const b = dodaj('2026-11-03');
  zapiszKorekte(db, id, b, { uuid: dokument.uuid, numer: '9/KOR/11/2026' });
  program.pobierzKorekte.mockResolvedValue({ number: '2/KOR/11/2026', corrected_invoice_number: 'FV/1' });
  await odczytaj();
  expect(zwrot(db, id, a).korekta_numer).toBeNull();
  expect(program.listaKorekt).not.toHaveBeenCalled();
  expect(wpisy()).toHaveLength(0);
});

it('dokument undefined kończy odczyt bez listy', async () => {
  program.pobierzKorekte.mockResolvedValue(undefined);
  await odczytaj();
  expect(program.listaKorekt).not.toHaveBeenCalled();
});

it('dokument bez uuid zapisuje uuid ze statusu', async () => {
  program.pobierzKorekte.mockResolvedValue({ number: dokument.number, corrected_invoice_number: 'FV/1' });
  await odczytaj();
  expect(zwrot(db, id, a).korekta_uuid).toBe('kor-a');
  expect(zwrot(db, id, a).korekta_numer).toBe(dokument.number);
});

it('błąd zapisu w drodze uuid nie rzuca i nie idzie listą', async () => {
  db.exec('DROP TABLE log');
  await expect(odczytaj()).resolves.toBeUndefined();
  expect(program.listaKorekt).not.toHaveBeenCalled();
});
