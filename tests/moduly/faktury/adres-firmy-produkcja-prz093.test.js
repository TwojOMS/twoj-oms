// PRZ-093.08 — adres firmy z Ustawień. Ten plik PRZYPINA PRODUKCJĘ: instalacja z DPD_NADAWCA_* w .env
// (tak działa produkcja właściciela) ma dostać na proformie, specyfikacji i etykiecie DPD DOKŁADNIE to samo,
// co przed zmianą — także wtedy, gdy w bazie leży inny adres wpisany kiedyś na ekranie (plik wygrywa).
// Wartości oczekiwane to literały, zmierzone na kodzie sprzed zmiany (gałąź petla-2026-10-17, 0d1add7):
// ten sam test był zielony przed i jest zielony po.
// Prawdziwy skład (zbudujOms), podmienione tylko fabryka klienta DPD i budowniczy PDF-ów (podsłuch argumentów).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zbudujProformePdf } from '../../../src/moduly/faktury/pdf/proforma-pdf.js';
import { zbudujSpecyfikacjePdf } from '../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js';

vi.mock('../../../src/moduly/faktury/pdf/proforma-pdf.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zbudujProformePdf: vi.fn((...a) => m.zbudujProformePdf(...a)) };
});
vi.mock('../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zbudujSpecyfikacjePdf: vi.fn((...a) => m.zbudujSpecyfikacjePdf(...a)) };
});

const AUTH = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
// Zmyślona firma — żadnych prawdziwych danych.
const ADRES_ENV = { DPD_NADAWCA_NAZWA: 'Lampy Zmyślone sp. z o.o.', DPD_NADAWCA_ULICA: 'Fikcyjna 7',
  DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Nibylandia' };
const DPD_ENV = { DPD_URL: 'https://dpd.invalid/ws', DPD_LOGIN: 'plik', DPD_PASSWORD: 'z-pliku', DPD_FID: '1',
  DPD_INFO_URL: 'https://dpd.invalid/info', DPD_INFO_CHANNEL: 'k' };
// Adres wpisany kiedyś na ekranie — przy adresie w .env nie może trafić na żaden dokument ani etykietę.
const ADRES_BAZY = { nazwa: 'Inna Firma z Ekranu', ulica: 'Ekranowa 99', kod: '11-111', miasto: 'Zła Wola',
  kraj: 'PL', telefon: '111222333', email: 'ekran@fikcja.invalid' };

let katalog;
beforeEach(() => { katalog = mkdtempSync(join(tmpdir(), 'prz093-produkcja-')); vi.mocked(zbudujProformePdf).mockClear(); vi.mocked(zbudujSpecyfikacjePdf).mockClear(); });
afterEach(() => { rmSync(katalog, { recursive: true, force: true }); });

async function panel(env) {
  const utworzone = [];
  const createDpd = vi.fn((o) => { utworzone.push(o); return { nadaj: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn() }; });
  const pelne = { OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_SPRZEDAWCA_BDO: '000000001', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_PROFORMY_KATALOG: katalog,
    OMS_ETYKIETY_KATALOG: katalog, ...env };
  const moduly = modulyDla(pelne).map((m) => (m.nazwa === 'wysylka' ? createModulWysylka({ fabryki: { createDpd } }) : m));
  const a = await zbudujOms({ env: pelne, moduly });
  // Stary zapis z ekranu (np. sprzed dopisania adresu do pliku).
  zapiszKonfiguracjeIntegracji(a.db, 'firma', { ustawienia: ADRES_BAZY, sekrety: {} });
  const id = zapiszZamowienie(a.db, 'reczne', {
    zrodlo_id: 1, numer: 'ADRES-093', klient: { email: 'klient@fikcja.invalid', company: 'Nabywca Testowy' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-10-01T12:00:00Z', status_woo: 'processing',
    pozycje: [{ nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
  }, {});
  return { ...a, id, utworzone };
}

describe('PRZ-093.08 produkcja: adres z .env wychodzi jak przed zmianą (baza ma inny adres)', () => {
  it('proforma: sprzedawca dokładnie z DPD_NADAWCA_* + NIP', async () => {
    const a = await panel(ADRES_ENV);
    try {
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${a.id}/proforma`, headers: { ...AUTH, origin: 'http://localhost' } });
      expect(r.statusCode, r.body).toBe(302);
      expect(vi.mocked(zbudujProformePdf)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(zbudujProformePdf).mock.calls[0][0].sprzedawca).toEqual({
        nazwa: 'Lampy Zmyślone sp. z o.o.', ulica: 'Fikcyjna 7', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL', nip: '1234563218',
      });
    } finally { await a.app.close(); a.db.close(); }
  });

  it('specyfikacja: sprzedawca dokładnie z DPD_NADAWCA_* + NIP + BDO', async () => {
    const a = await panel(ADRES_ENV);
    try {
      const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${a.id}/specyfikacja.pdf`, headers: AUTH });
      expect(r.statusCode, r.body).toBe(200);
      expect(vi.mocked(zbudujSpecyfikacjePdf).mock.calls[0][0].sprzedawca).toEqual({
        nazwa: 'Lampy Zmyślone sp. z o.o.', adres: 'Fikcyjna 7, 00-950 Nibylandia', nip: '1234563218', bdo: '000000001',
      });
    } finally { await a.app.close(); a.db.close(); }
  });

  it('DPD z .env: klient DPD dostaje nadawcę dokładnie z DPD_NADAWCA_*', async () => {
    const a = await panel({ ...ADRES_ENV, ...DPD_ENV, DPD_NADAWCA_TELEFON: '500600700', DPD_NADAWCA_EMAIL: 'wysylka@fikcja.invalid' });
    try {
      expect(a.utworzone).toHaveLength(1);
      expect(a.utworzone[0].nadawca).toEqual({
        nazwa: 'Lampy Zmyślone sp. z o.o.', ulica: 'Fikcyjna 7', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL',
        phone: '500600700', email: 'wysylka@fikcja.invalid',
      });
    } finally { await a.app.close(); a.db.close(); }
  });

  it('niepełny adres w .env (bez ulicy) nadal odmawia proformy — baza go nie uzupełnia', async () => {
    const a = await panel({ ...ADRES_ENV, DPD_NADAWCA_ULICA: '' });
    try {
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${a.id}/proforma`, headers: { ...AUTH, origin: 'http://localhost' } });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('Panel nie zna adresu sprzedawcy');
      expect(vi.mocked(zbudujProformePdf)).not.toHaveBeenCalled();
    } finally { await a.app.close(); a.db.close(); }
  });
});
