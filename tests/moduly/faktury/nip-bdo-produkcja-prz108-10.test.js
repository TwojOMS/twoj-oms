// PRZ-108.10 — NIP i BDO sprzedawcy z Ustawień → Firma. Ten plik PRZYPINA PRODUKCJĘ: instalacja z OMS_SPRZEDAWCA_NIP
// i OMS_SPRZEDAWCA_BDO w pliku (tak działa produkcja właściciela) dostaje proformę, specyfikację i potwierdzenie wywozu
// BAJT W BAJT takie jak przed zmianą — także wtedy, gdy w bazie leży inny NIP i BDO wpisany kiedyś na ekranie (plik
// wygrywa). Skróty SHA-256 to literały zmierzone na kodzie sprzed zmiany (gałąź petla-2026-10-21-10, cb74544): ten sam
// test był zielony przed i jest zielony po. Zegar Date zamrożony (PDF niesie datę utworzenia i numer z miesiącem).
// Prawdziwy skład (zbudujOms), sieć zabroniona, dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';

const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const ADRES_ENV = { DPD_NADAWCA_NAZWA: 'Lampy Zmyślone sp. z o.o.', DPD_NADAWCA_ULICA: 'Fikcyjna 7',
  DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Nibylandia' };
const PLIK = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_SPRZEDAWCA_BDO: '000000001' };
const sha = (b) => createHash('sha256').update(b).digest('hex');

// Zmierzone na cb74544 (przed zmianą) — patrz nagłówek.
const OCZEKIWANE = {
  specyfikacja: 'db1fc9653f8226b6e09303a1bd420ad7a6198732ac07fb288e0141eb1078e2c0',
  wywoz: '047e7619ed82390e0110c2ebd5bcc73bc0d5250997d02740bc3c388de6ada045',
  proforma: 'b68714aeeefe907ec4f0789393c6c796c4b1be22d6afa3f44004182ec60ee886',
};

let katalog;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'prz108-10-produkcja-'));
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-21T10:00:00.000Z') });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

const zamowienie = (numer, nad = {}) => ({
  zrodlo_id: numer.length, numer, klient: { email: 'klient@fikcja.invalid', company: 'Nabywca Testowy',
    address_1: 'Odbiorcza 4', postcode: '00-950', city: 'Nibylandia' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, termin_platnosci: '14',
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-01T12:00:00Z', status_woo: 'processing',
  pozycje: [{ zrodlo_id: 7, nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
  ...nad,
});

async function dokumenty({ zapisWBazie }) {
  const pelne = { OMS_TRYB: 'produkcja', ...PLIK, OMS_RACHUNEK: '34109010140000000000000000', OMS_BANK: 'Bank Zmyślony',
    OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, ...ADRES_ENV };
  const a = await zbudujOms({ env: pelne, moduly: modulyDla(pelne) });
  try {
    if (zapisWBazie) {
      // Stary zapis z ekranu (np. sprzed dopisania do pliku) — przy pliku nie może trafić na żaden dokument.
      zapiszKonfiguracjeIntegracji(a.db, 'nip_firmy', { ustawienia: { nip: '2222222222' }, sekrety: {} });
      zapiszKonfiguracjeIntegracji(a.db, 'bdo_firmy', { ustawienia: { bdo: '000000002' }, sekrety: {} });
    }
    const id = zapiszZamowienie(a.db, 'reczne', zamowienie('NIP-108'), {});
    const wdt = zapiszZamowienie(a.db, 'reczne', zamowienie('WDT-108', { chce_fakture: 1, nip: 'DE123456789',
      klient: { email: 'kunde@fikcja.invalid', company: 'Kunde GmbH', address_1: 'Erfundene Str. 1', postcode: '10115',
        city: 'Berlin', country: 'DE' } }), {});
    const spec = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}/specyfikacja.pdf`, headers: AUTH });
    expect(spec.statusCode, spec.body).toBe(200);
    const wyw = await a.app.inject({ method: 'GET', url: `/zamowienia/${wdt}/potwierdzenie-wywozu.pdf`, headers: AUTH });
    expect(wyw.statusCode, wyw.body).toBe(200);
    const pf = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/proforma`, headers: { ...AUTH, origin: 'http://localhost' } });
    expect(pf.statusCode, pf.body).toBe(302);
    const plik = a.db.prepare('SELECT plik_sciezka FROM proformy WHERE zamowienie_id = ?').get(id).plik_sciezka;
    return { specyfikacja: sha(spec.rawPayload), wywoz: sha(wyw.rawPayload), proforma: sha(readFileSync(plik)) };
  } finally { await a.app.close(); a.db.close(); }
}

describe('PRZ-108.10 produkcja: NIP i BDO z pliku — dokumenty bajt w bajt jak przed zmianą', () => {
  it('bez zapisu w bazie: specyfikacja, potwierdzenie wywozu i proforma identyczne z kodem sprzed zmiany', async () => {
    expect(await dokumenty({ zapisWBazie: false })).toEqual(OCZEKIWANE);
  });

  it('z innym NIP-em i BDO zapisanym w bazie: plik wygrywa, bajty te same', async () => {
    expect(await dokumenty({ zapisWBazie: true })).toEqual(OCZEKIWANE);
  });
});
