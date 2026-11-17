// Karta okresu mówi o wysyłce do KSeF zgodnie z tym, co program fakturowy umie.
// Program ze zdolnością wysyłki do KSeF z OMS-u: „wysyłasz ją osobno: przyciskiem…, automatem… albo w <programie>”.
// Program bez niej: „wyślij ją do KSeF bezpośrednio w <programie>” — przycisk i automat i tak by odmówiły.
// Program testowy („Testownik”) przez szew `fabryki.programFakturowy` (tylko OMS_TRYB=proba); nic nie wychodzi z procesu.
// Dane zmyślone.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createAtrapaVies } from '../../../deploy/proba/atrapy/infakt.mjs';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres, zakonczFaktureOkresu } from '../../../src/oms/db/okresy.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const ZE_ZDOLNOSCIA = ', bez wysyłki do KSeF — wysyłasz ją osobno: przyciskiem na ekranie Faktury, '
  + 'automatem (administrator: Ustawienia → Automatyzacje → Automaty systemowe) albo w Testowniku.';
const BEZ_ZDOLNOSCI = ', bez wysyłki do KSeF — wyślij ją do KSeF bezpośrednio w Testowniku.';
const PRZED_WYSTAWIENIEM = 'Wystawienie nie wysyła dokumentu do KSeF.';
const jednaSpacja = (html) => html.replace(/\s+/gu, ' ');

let katalog;
let a;
afterEach(async () => {
  await a?.app.close(); a?.db.close(); a = null;
  if (katalog) rmSync(katalog, { recursive: true, force: true });
});

async function panel(program) {
  katalog = mkdtempSync(join(tmpdir(), 'prz168-01b-'));
  const env = {
    OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    OMS_TRYB: 'proba',
  };
  const fabryki = { programFakturowy: () => program, createVies: () => createAtrapaVies({ env }) };
  const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
  a = await zbudujOms({ env, moduly, teraz: () => new Date('2026-10-15T10:00:00.000Z'), log: () => {} });
  return a;
}

function okresZZamowieniem(db) {
  dopiszKlientaZbiorczego(db);
  const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 9 });
  const z = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 'w-1681', numer: '1681', klient: { first_name: 'Ida' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '249.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
  db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = ? WHERE id = ?').run(okres.id, z);
  return okres.id;
}

describe('karta okresu: zdanie o wysyłce do KSeF zależy od programu', () => {
  it.each([
    ['ze zdolnością wysyłki', [], ZE_ZDOLNOSCIA, BEZ_ZDOLNOSCI],
    ['bez zdolności wysyłki', ['wyslijDokumentDoKsef'], BEZ_ZDOLNOSCI, ZE_ZDOLNOSCIA],
  ])('program %s', async (_opis, pomin, jest, niema) => {
    const { app, db } = await panel(programTestowy({ pomin }));
    const okresId = okresZZamowieniem(db);

    const przed = await app.inject({ method: 'GET', url: `/okresy/${okresId}`, headers: AUTH });
    expect(przed.statusCode, przed.body.slice(0, 300)).toBe(200);
    expect(jednaSpacja(przed.body)).toContain(PRZED_WYSTAWIENIEM);
    expect(przed.body).not.toContain('Panel nie wysyła dokumentu do KSeF.');

    zakonczFaktureOkresu(db, okresId, { uuid: 'prz168-okres', numer: 'TST 9/2026', ksefStatus: null }, { program: 'testowy' });
    const po = await app.inject({ method: 'GET', url: `/okresy/${okresId}`, headers: AUTH });
    expect(po.statusCode, po.body.slice(0, 300)).toBe(200);
    const tekst = jednaSpacja(po.body);
    expect(tekst).toContain(`wystawiona w Testowniku z panelu${jest}`);
    expect(tekst).not.toContain(niema);
  });
});
