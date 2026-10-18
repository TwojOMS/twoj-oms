// PRZ-093.08 — Ustawienia → Firma. Instalacja bez DPD_NADAWCA_* w pliku wpisuje adres firmy na ekranie;
// ten sam adres idzie na proformę, specyfikację i jako nadawca DPD skonfigurowanego w Ustawieniach — od razu,
// bez ponownego uruchomienia. Gdy adres jest w pliku (.env), plik wygrywa: ekran tylko pokazuje, zapis = 409.
// Prawdziwy skład (zbudujOms) z podmienioną fabryką klienta DPD i podsłuchem budowniczych PDF-ów — nic nie wychodzi
// do DPD. Dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/konta-prz068.js';
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

const ADRES = '/ustawienia/firma';
const FORMULARZ = { nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia',
  kraj: 'PL', telefon: '500 600 700', email: 'biuro@fikcja.invalid' };
const ADRES_ENV = { DPD_NADAWCA_NAZWA: 'Firma z Pliku', DPD_NADAWCA_ULICA: 'Plikowa 1', DPD_NADAWCA_KOD: '00-001',
  DPD_NADAWCA_MIASTO: 'Plikowo' };
const DPD_FORMULARZ = { nazwa: 'DPD', login: '11112222', fid: '333444', haslo: 'Haslo-Testowe-1', typEtykiety: 'A4', kanal: '' };

let katalog;
beforeEach(() => { katalog = mkdtempSync(join(tmpdir(), 'prz093-firma-')); vi.mocked(zbudujProformePdf).mockClear(); vi.mocked(zbudujSpecyfikacjePdf).mockClear(); });
afterEach(() => { rmSync(katalog, { recursive: true, force: true }); });

async function panel(env = {}) {
  const utworzone = [];
  const createDpd = vi.fn((o) => { utworzone.push(o); return { nadaj: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn(async () => ({ ok: true })) }; });
  const pelne = { OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, ...env };
  let kurierzy;
  const podgladacz = { nazwa: 'test-podgladacz', wersja: '1.0.0', wymaga: ['wysylka'], migracje: [], menu: [], uprawnienia: [],
    konfiguracja: () => null, zbuduj: (ctx) => { kurierzy = ctx.usluga('wysylka', 'kurierzy'); return {}; } };
  const moduly = [...modulyDla(pelne).map((m) => (m.nazwa === 'wysylka' ? createModulWysylka({ fabryki: { createDpd } }) : m)), podgladacz];
  const a = await zbudujOms({ env: pelne, moduly });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(a.db, kontoPoLoginie(a.db, 'ewa').id, ['zamowienia']);
  const id = zapiszZamowienie(a.db, 'reczne', {
    zrodlo_id: 1, numer: 'FIRMA-093', klient: { email: 'klient@fikcja.invalid', company: 'Nabywca Testowy' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-10-01T12:00:00Z', status_woo: 'processing',
    pozycje: [{ nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
  }, {});
  return { ...a, id, utworzone, kurierzy: () => kurierzy, admin: jako(a.db, 'adam'), ewa: jako(a.db, 'ewa'),
    zamknij: async () => { await a.app.close(); a.db.close(); } };
}
const formularz = (html) => /<form id="firma-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('PRZ-093.08 Ustawienia → Firma (bez adresu w pliku)', () => {
  it('panel wstaje bez adresu; pusty ekran z polami; podmenu Ustawień ma pozycję „Firma”', async () => {
    const p = await panel();
    try {
      const r = await get(p.app, ADRES, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      const f = formularz(r.body);
      for (const pole of ['nazwa', 'ulica', 'kod', 'miasto', 'kraj', 'telefon', 'email']) expect(f).toContain(`name="${pole}"`);
      expect(r.body).toContain('Brak adresu');
      expect(r.body).toContain(`href="${ADRES}"`);
      const dpd = await get(p.app, '/ustawienia/integracje/dpd', p.admin);
      expect(dpd.body).toContain(`href="${ADRES}"`);
    } finally { await p.zamknij(); }
  });

  it('bez adresu: proforma i specyfikacja odmawiają czytelnie, z adresem ekranu; numer proformy nie przepada', async () => {
    const p = await panel();
    try {
      const pf = await post(p.app, `/zamowienia/${p.id}/proforma`, p.admin);
      expect(pf.statusCode).toBe(400);
      expect(pf.body).toContain('Panel nie zna adresu sprzedawcy');
      expect(pf.body).toContain(ADRES);
      expect(vi.mocked(zbudujProformePdf)).not.toHaveBeenCalled();
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM proformy').get().n).toBe(0);
      const sp = await get(p.app, `/zamowienia/${p.id}/specyfikacja.pdf`, p.admin);
      expect(sp.statusCode).toBe(400);
      expect(sp.body).toContain(ADRES);
      expect(vi.mocked(zbudujSpecyfikacjePdf)).not.toHaveBeenCalled();
    } finally { await p.zamknij(); }
  });

  it('zapis: 303, wiersz w bazie, ekran pokazuje wpisany adres; proforma, specyfikacja i DPD biorą go bez restartu', async () => {
    const p = await panel();
    try {
      await post(p.app, '/ustawienia/integracje/dpd', p.admin, DPD_FORMULARZ);
      const r = await post(p.app, ADRES, p.admin, FORMULARZ);
      expect(r.statusCode, r.body).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'firma').ustawienia).toEqual({
        nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL',
        telefon: '500 600 700', email: 'biuro@fikcja.invalid' });
      const ekran = await get(p.app, r.headers.location, p.admin);
      expect(ekran.body).toContain('Zapisano adres firmy');
      expect(formularz(ekran.body)).toContain('value="Wymyślona 12"');

      const pf = await post(p.app, `/zamowienia/${p.id}/proforma`, p.admin);
      expect(pf.statusCode, pf.body).toBe(302);
      expect(vi.mocked(zbudujProformePdf).mock.calls[0][0].sprzedawca).toEqual({
        nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL', nip: '1234563218' });
      const sp = await get(p.app, `/zamowienia/${p.id}/specyfikacja.pdf`, p.admin);
      expect(sp.statusCode, sp.body).toBe(200);
      expect(vi.mocked(zbudujSpecyfikacjePdf).mock.calls[0][0].sprzedawca).toMatchObject({
        nazwa: 'Pracownia Zmyślona', adres: 'Wymyślona 12, 00-950 Nibylandia' });

      await p.kurierzy().dpd.sprawdzPolaczenie();
      expect(p.utworzone.at(-1).nadawca).toEqual({ nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950',
        miasto: 'Nibylandia', kraj: 'PL', phone: '500 600 700', email: 'biuro@fikcja.invalid' });

      // Ekran DPD nie odsyła już do pliku — pokazuje adres firmy z linkiem do ekranu adresu.
      const dpd = await get(p.app, '/ustawienia/integracje/dpd', p.admin);
      expect(dpd.body).toContain('Wymyślona 12');
      expect(dpd.body).toContain(`href="${ADRES}"`);
      expect(dpd.body).not.toContain('uzupełnij <code>DPD_NADAWCA_');
    } finally { await p.zamknij(); }
  });

  it('zmiana adresu działa od następnego dokumentu i następnej paczki (bez restartu)', async () => {
    const p = await panel();
    try {
      await post(p.app, '/ustawienia/integracje/dpd', p.admin, DPD_FORMULARZ);
      await post(p.app, ADRES, p.admin, FORMULARZ);
      await p.kurierzy().dpd.sprawdzPolaczenie();
      await post(p.app, ADRES, p.admin, { ...FORMULARZ, ulica: 'Nowa 3' });
      await p.kurierzy().dpd.sprawdzPolaczenie();
      expect(p.utworzone.at(-1).nadawca.ulica).toBe('Nowa 3');
      await get(p.app, `/zamowienia/${p.id}/specyfikacja.pdf`, p.admin);
      expect(vi.mocked(zbudujSpecyfikacjePdf).mock.calls.at(-1)[0].sprzedawca.adres).toBe('Nowa 3, 00-950 Nibylandia');
    } finally { await p.zamknij(); }
  });

  it('walidacja: wymagane pola, kod PL NN-NNN, e-mail; 400 z powodami, nic nie zapisane', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ADRES, p.admin, { ...FORMULARZ, nazwa: '', kod: '00950x', email: 'nie-mail' });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('Podaj nazwę firmy');
      expect(r.body).toContain('NN-NNN');
      expect(r.body).toContain('adres e-mail');
      expect(wczytajKonfiguracjeIntegracji(p.db, 'firma')).toBeNull();
      expect(formularz(r.body)).toContain('value="Wymyślona 12"'); // wpisane zostaje w formularzu
      const zagranica = await post(p.app, ADRES, p.admin, { ...FORMULARZ, kraj: 'de', kod: '10115' });
      expect(zagranica.statusCode, zagranica.body).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'firma').ustawienia).toMatchObject({ kraj: 'DE', kod: '10115' });
    } finally { await p.zamknij(); }
  });

  it('bez uprawnienia „ustawienia” — 403 na ekran i na zapis', async () => {
    const p = await panel();
    try {
      expect((await get(p.app, ADRES, p.ewa)).statusCode).toBe(403);
      expect((await post(p.app, ADRES, p.ewa, FORMULARZ)).statusCode).toBe(403);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'firma')).toBeNull();
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-093.08 adres firmy w pliku (.env) wygrywa', () => {
  it('ekran tylko pokazuje adres z pliku, bez formularza; zapis = 409 i baza nietknięta', async () => {
    const p = await panel(ADRES_ENV);
    try {
      const r = await get(p.app, ADRES, p.admin);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Plikowa 1');
      expect(r.body).toContain('w pliku konfiguracji');
      expect(formularz(r.body)).toBe('');
      const z = await post(p.app, ADRES, p.admin, FORMULARZ);
      expect(z.statusCode).toBe(409);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'firma')).toBeNull();
    } finally { await p.zamknij(); }
  });

  it('stary zapis w bazie nie przesłania pliku: proforma i DPD z Ustawień biorą adres z pliku', async () => {
    const p = await panel(ADRES_ENV);
    try {
      zapiszKonfiguracjeIntegracji(p.db, 'firma', { ustawienia: FORMULARZ, sekrety: {} });
      await post(p.app, '/ustawienia/integracje/dpd', p.admin, DPD_FORMULARZ);
      const pf = await post(p.app, `/zamowienia/${p.id}/proforma`, p.admin);
      expect(pf.statusCode, pf.body).toBe(302);
      expect(vi.mocked(zbudujProformePdf).mock.calls[0][0].sprzedawca).toMatchObject({ nazwa: 'Firma z Pliku', ulica: 'Plikowa 1' });
      await p.kurierzy().dpd.sprawdzPolaczenie();
      expect(p.utworzone.at(-1).nadawca).toMatchObject({ nazwa: 'Firma z Pliku', ulica: 'Plikowa 1' });
      const ekran = await get(p.app, ADRES, p.admin);
      expect(ekran.body).toContain('Usuń adres zapisany na ekranie');
      expect((await post(p.app, `${ADRES}/usun`, p.admin, {})).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'firma')).toBeNull();
    } finally { await p.zamknij(); }
  });
});
