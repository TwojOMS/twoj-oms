// PRZ-102.20 — rachunek bankowy (i bank) w Ustawieniach → Firma. Decyzja właściciela 20.10: „po prostu pole do wpisania
// rachunku. tylko przez admina”. Plik (OMS_RACHUNEK / OMS_BANK) wygrywa: ekran pokazuje wartość z pliku, zapis = 409,
// a maile, proformy i WzA produkcji zostają bajt w bajt. Bez rachunku w pliku panel wstaje; rachunek z panelu działa
// od następnego maila i dokumentu, bez restartu; bez rachunku nigdzie /health melduje brak.
// Prawdziwy skład (zbudujOms) z atrapą poczty i podsłuchem budowniczego PDF-u proformy — nic nie wychodzi. Dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/konta-prz068.js';
import { zbudujProformePdf } from '../../../src/moduly/faktury/pdf/proforma-pdf.js';
import { ZDANIE_RACHUNEK_FORMAT, ZDANIE_RACHUNEK_SUMA } from '../../../src/core/sprzedawca.ts';

vi.mock('../../../src/moduly/faktury/pdf/proforma-pdf.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zbudujProformePdf: vi.fn((...a) => m.zbudujProformePdf(...a)) };
});

const EKRAN = '/ustawienia/firma';
const ZAPIS = '/ustawienia/firma/rachunek';
const PLIK = { OMS_RACHUNEK: '34109010140000000000000000', OMS_BANK: 'Bank z Pliku' };
// Drugi poprawny NRB (suma mod 97) — zmyślony, inny niż w pliku.
const PANEL = '09109010140000000000000062';
const ADRES = { DPD_NADAWCA_NAZWA: 'Pracownia Zmyślona', DPD_NADAWCA_ULICA: 'Wymyślona 12', DPD_NADAWCA_KOD: '00-950',
  DPD_NADAWCA_MIASTO: 'Nibylandia' };
const BRAK = 'brak rachunku firmy — wpisz w Ustawienia → Firma';
const wielka = (s) => s[0].toUpperCase() + s.slice(1);
const ent = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&#34;').replaceAll("'", '&#39;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');

let katalog;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'prz102-20-'));
  vi.mocked(zbudujProformePdf).mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

async function panel(env = {}) {
  const wyslane = [];
  const createMailer = () => ({ sendMail: async (m) => { wyslane.push(m); return { messageId: 'atrapa' }; } });
  const pelne = { OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_USER: 'operator', OMS_PASS: 'fixture',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, ...ADRES,
    SMTP_HOST: 'smtp.fikcja.invalid', SMTP_USER: 'sklep@fikcja.invalid', SMTP_PASS: 'atrapa', ...env };
  const moduly = modulyDla(pelne).map((m) => (m.nazwa === 'wiadomosci' ? createModulWiadomosci({ fabryki: { createMailer } }) : m));
  const a = await zbudujOms({ env: pelne, moduly });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(a.db, kontoPoLoginie(a.db, 'ewa').id, ['ustawienia', 'zamowienia']);
  const id = zapiszZamowienie(a.db, 'reczne', {
    zrodlo_id: 1, numer: 'RACH-020', klient: { first_name: 'Jan', last_name: 'Testowy', email: 'klient@fikcja.invalid',
      company: 'Nabywca Testowy' },
    dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Odbiorcza 4', postcode: '00-950', city: 'Nibylandia' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, termin_platnosci: '14',
    kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-10-01T12:00:00Z', status_woo: 'processing',
    pozycje: [{ zrodlo_id: 7, nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 1, cena_brutto: '123.00', cena_netto: '100.00',
      brutto_linii: '123.00', netto_linii: '100.00', vat: null }],
  }, {});
  return { ...a, id, wyslane, admin: jako(a.db, 'adam'), ewa: jako(a.db, 'ewa'),
    zdrowie: async () => JSON.parse((await a.app.inject({ url: '/health' })).body),
    zamknij: async () => { await a.app.close(); a.db.close(); } };
}
const formularz = (html) => /<form id="rachunek-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const rachunekWMailu = (tekst) => /Rachunek: ?(.*)/u.exec(tekst)?.[1] ?? null;

describe('PRZ-102.20 start bez rachunku w pliku', () => {
  it('bez rachunku nigdzie: panel wstaje, /health melduje brak, ekran Firma ma puste pola i stan „Brak rachunku”', async () => {
    const p = await panel();
    try {
      const z = await p.zdrowie();
      expect(z.uwagi).toContain(BRAK);
      const r = await get(p.app, EKRAN, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      const f = formularz(r.body);
      expect(f).toContain('name="rachunek"');
      expect(f).toContain('name="bank"');
      expect(r.body).toContain('Brak rachunku');
    } finally { await p.zamknij(); }
  });

  it('bez rachunku nigdzie: proforma odmawia czytelnie, numer nie przepada; mail płatniczy bez danych do przelewu', async () => {
    const p = await panel();
    try {
      const pf = await post(p.app, `/zamowienia/${p.id}/proforma`, p.admin);
      expect(pf.statusCode).toBe(400);
      expect(pf.body).toContain(EKRAN);
      expect(vi.mocked(zbudujProformePdf)).not.toHaveBeenCalled();
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM proformy').get().n).toBe(0);
      const m = await p.usluga('wiadomosci', 'wiadomosci').podglad(p.id, 'przypomnienie');
      expect(m.tekst).not.toContain('Rachunek:');
    } finally { await p.zamknij(); }
  });

  it('rachunek z panelu: zapis admina 303, a proforma, podgląd i wysłany mail biorą go bez restartu; /health milknie', async () => {
    const p = await panel();
    try {
      const przed = await p.usluga('wiadomosci', 'wiadomosci').podglad(p.id, 'przypomnienie');
      expect(przed.tekst).not.toContain('Rachunek:');
      const r = await post(p.app, ZAPIS, p.admin, { rachunek: 'PL09 1090-1014 0000 0000 0000 0062', bank: '  Bank   Przykładowy ' });
      expect(r.statusCode, r.body).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy').ustawienia).toEqual({ rachunek: PANEL, bank: 'Bank Przykładowy' });
      const ekran = await get(p.app, r.headers.location, p.admin);
      expect(ekran.body).toContain('Zapisano rachunek firmy');
      expect(formularz(ekran.body)).toContain(`value="${PANEL}"`);
      expect((await p.zdrowie()).uwagi).not.toContain(BRAK);

      const m = await p.usluga('wiadomosci', 'wiadomosci').podglad(p.id, 'przypomnienie');
      expect(rachunekWMailu(m.tekst)).toBe(PANEL);
      await p.usluga('wiadomosci', 'wiadomosci').wyslij(p.id, 'przypomnienie');
      expect(rachunekWMailu(p.wyslane.at(-1).text)).toBe(PANEL);
      expect(p.wyslane.at(-1).html).toContain(PANEL);

      const pf = await post(p.app, `/zamowienia/${p.id}/proforma`, p.admin);
      expect(pf.statusCode, pf.body).toBe(302);
      expect(vi.mocked(zbudujProformePdf).mock.calls.at(-1)[0]).toMatchObject({ rachunek: PANEL, bank: 'Bank Przykładowy' });

      // Zmiana działa od następnego dokumentu i maila.
      await post(p.app, ZAPIS, p.admin, { rachunek: '34109010140000000000000000', bank: '' });
      expect(rachunekWMailu((await p.usluga('wiadomosci', 'wiadomosci').podglad(p.id, 'przypomnienie')).tekst))
        .toBe('34109010140000000000000000');
    } finally { await p.zamknij(); }
  });

  it('usunięcie rachunku z panelu (admin): wraca stan „brak”', async () => {
    const p = await panel();
    try {
      await post(p.app, ZAPIS, p.admin, { rachunek: PANEL, bank: '' });
      const r = await post(p.app, `${ZAPIS}/usun`, p.admin);
      expect(r.statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy')).toBeNull();
      expect((await p.zdrowie()).uwagi).toContain(BRAK);
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-102.20 walidacja i dostęp', () => {
  it.each([
    ['zła długość', '3410901014', ZDANIE_RACHUNEK_FORMAT],
    ['litera', '3410901014000000000000000x', ZDANIE_RACHUNEK_FORMAT],
    ['zła suma kontrolna', '34109010140000000000000001', ZDANIE_RACHUNEK_SUMA],
    ['puste pole', '   ', null],
  ])('zły numer (%s): 400 z tym samym zdaniem co przy starcie, nic nie zapisane', async (_n, numer, zdanie) => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS, p.admin, { rachunek: numer, bank: 'Bank Przykładowy' });
      expect(r.statusCode).toBe(400);
      if (zdanie) expect(r.body).toContain(ent(wielka(zdanie)));
      else expect(r.body).toContain('Wpisz numer rachunku');
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy')).toBeNull();
    } finally { await p.zamknij(); }
  });

  it('nie-admin z dostępem do Ustawień: widzi stan bez formularza, zapis i usunięcie = 403, nic nie zapisane', async () => {
    const p = await panel();
    try {
      const ekran = await get(p.app, EKRAN, p.ewa);
      expect(ekran.statusCode).toBe(200);
      expect(formularz(ekran.body)).toBe('');
      expect(ekran.body).toContain('tylko administrator');
      const r = await post(p.app, ZAPIS, p.ewa, { rachunek: PANEL, bank: '' });
      expect(r.statusCode).toBe(403);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy')).toBeNull();
      await post(p.app, ZAPIS, p.admin, { rachunek: PANEL, bank: '' });
      expect((await post(p.app, `${ZAPIS}/usun`, p.ewa)).statusCode).toBe(403);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy')).not.toBeNull();
    } finally { await p.zamknij(); }
  });

  it('adres firmy zapisany i usunięty na tym samym ekranie nie rusza rachunku (osobny wiersz)', async () => {
    const p = await panel(Object.fromEntries(Object.keys(ADRES).map((k) => [k, ''])));
    try {
      await post(p.app, ZAPIS, p.admin, { rachunek: PANEL, bank: 'Bank Przykładowy' });
      await post(p.app, EKRAN, p.admin, { nazwa: 'Pracownia', ulica: 'Ulica 1', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL' });
      await post(p.app, `${EKRAN}/usun`, p.admin);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy').ustawienia).toEqual({ rachunek: PANEL, bank: 'Bank Przykładowy' });
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-102.20 plik wygrywa (produkcja)', () => {
  it('ekran pokazuje wartość z pliku z dopiskiem, zapis = 409; zapis w bazie nie zmienia maila, proformy ani /health', async () => {
    const p = await panel(PLIK);
    try {
      const ekran = await get(p.app, EKRAN, p.admin);
      // PRZ-108.11 (decyzja właściciela 22.10): plakietka „wkrótce” + krótka pomoc zamiast zdania o pliku.
      expect(ekran.body).toContain('Zmiana w panelu — wkrótce. Dziś: plik konfiguracji (<code>OMS_RACHUNEK</code>).');
      expect(ekran.body).toContain('Zmiana w panelu — wkrótce. Dziś: plik konfiguracji (<code>OMS_BANK</code>).');
      expect(ekran.body).toContain('Bank z Pliku');
      expect(ekran.body).toContain('34 1090 1014 0000 0000 0000 0000');
      expect(formularz(ekran.body)).toBe('');
      const r = await post(p.app, ZAPIS, p.admin, { rachunek: PANEL, bank: 'Bank z Panelu' });
      expect(r.statusCode).toBe(409);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'rachunek_firmy')).toBeNull();
      expect((await p.zdrowie()).uwagi).not.toContain(BRAK);

      // Zapis sprzed dopisania rachunku do pliku (wprost do bazy) — plik i tak wygrywa.
      zapiszKonfiguracjeIntegracji(p.db, 'rachunek_firmy', { ustawienia: { rachunek: PANEL, bank: 'Bank z Panelu' }, sekrety: {} });
      const m = await p.usluga('wiadomosci', 'wiadomosci').podglad(p.id, 'przypomnienie');
      expect(rachunekWMailu(m.tekst)).toBe(PLIK.OMS_RACHUNEK);
      expect(m.html).not.toContain(PANEL);
      const pf = await post(p.app, `/zamowienia/${p.id}/proforma`, p.admin);
      expect(pf.statusCode, pf.body).toBe(302);
      expect(vi.mocked(zbudujProformePdf).mock.calls.at(-1)[0]).toMatchObject({ rachunek: PLIK.OMS_RACHUNEK, bank: 'Bank z Pliku' });
    } finally { await p.zamknij(); }
  });

  it('sam OMS_BANK w pliku też blokuje zapis (plik wygrywa w całości)', async () => {
    const p = await panel({ OMS_BANK: 'Bank z Pliku' });
    try {
      expect((await post(p.app, ZAPIS, p.admin, { rachunek: PANEL, bank: '' })).statusCode).toBe(409);
    } finally { await p.zamknij(); }
  });

  it('zły rachunek w pliku nadal blokuje start (plik się nie ignoruje po cichu)', async () => {
    await expect(panel({ OMS_RACHUNEK: '34109010140000000000000001' })).rejects.toThrow('OMS_RACHUNEK: niepoprawny numer rachunku');
  });
});
