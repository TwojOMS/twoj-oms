// PRZ-108.10 — NIP i BDO sprzedawcy w Ustawieniach → Firma (decyzja właściciela 21.10: „NIP i BDO w panelu”).
// Wzór: rachunek PRZ-102.20. Każde pole osobno, plik wygrywa dla swojego pola (OMS_SPRZEDAWCA_NIP / OMS_SPRZEDAWCA_BDO):
// ekran pokazuje wartość z pliku, zapis = 409. Bez NIP-u w pliku panel wstaje; dokumenty, które niosą NIP (proforma,
// specyfikacja, potwierdzenie wywozu), czytają go PRZY UŻYCIU, a bez NIP-u odmawiają czytelnie — nigdy dokument z pustym
// NIP-em. Zapisuje tylko administrator. Bajt w bajt produkcji: tests/moduly/faktury/nip-bdo-produkcja-prz108-10.test.js.
// Prawdziwy skład (zbudujOms) z podsłuchem budowniczych PDF-ów — nic nie wychodzi. Dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/konta-prz068.js';
import { zbudujProformePdf } from '../../../src/moduly/faktury/pdf/proforma-pdf.js';
import { zbudujSpecyfikacjePdf } from '../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js';
import { zbudujOswiadczenieWywozuPdf } from '../../../src/moduly/faktury/pdf/oswiadczenie-wywozu-pdf.js';
import { ZDANIE_NIP_FORMAT, ZDANIE_NIP_SUMA, ZDANIE_BDO } from '../../../src/core/sprzedawca.ts';

vi.mock('../../../src/moduly/faktury/pdf/proforma-pdf.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zbudujProformePdf: vi.fn((...a) => m.zbudujProformePdf(...a)) };
});
vi.mock('../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zbudujSpecyfikacjePdf: vi.fn((...a) => m.zbudujSpecyfikacjePdf(...a)) };
});
vi.mock('../../../src/moduly/faktury/pdf/oswiadczenie-wywozu-pdf.js', async (oryginal) => {
  const m = await oryginal();
  return { ...m, zbudujOswiadczenieWywozuPdf: vi.fn((...a) => m.zbudujOswiadczenieWywozuPdf(...a)) };
});

const EKRAN = '/ustawienia/firma';
const ZAPIS_NIP = '/ustawienia/firma/nip';
const ZAPIS_BDO = '/ustawienia/firma/bdo';
const KSEF = '/ustawienia/integracje/ksef';
// Zmyślone, z poprawną cyfrą kontrolną.
const NIP_PLIK = '1234563218';
const NIP_PANEL = '2222222222';
const NIP_INNY = '1111111111';
const BDO_PLIK = '000000001';
const BDO_PANEL = '000000002';
const ADRES = { DPD_NADAWCA_NAZWA: 'Pracownia Zmyślona', DPD_NADAWCA_ULICA: 'Wymyślona 12', DPD_NADAWCA_KOD: '00-950',
  DPD_NADAWCA_MIASTO: 'Nibylandia' };
const BRAK = 'brak NIP-u firmy — wpisz w Ustawienia → Firma';
// Recenzja D2: „wystawione zostają bez zmian” było nieprawdą dla specyfikacji i wywozu (składane przy każdym pobraniu).
const OSTRZEZENIE = 'Wystawione faktury i proformy zostają z poprzednim NIP-em; specyfikacja i potwierdzenie wywozu pobrane ponownie pokażą nowy NIP.';
const wielka = (s) => s[0].toUpperCase() + s.slice(1);
const ent = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&#34;').replaceAll("'", '&#39;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');

let katalog;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'prz108-10-'));
  for (const f of [zbudujProformePdf, zbudujSpecyfikacjePdf, zbudujOswiadczenieWywozuPdf]) vi.mocked(f).mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

const zamowienie = (numer, nad = {}) => ({
  zrodlo_id: numer.length, numer, klient: { first_name: 'Jan', last_name: 'Testowy', email: 'klient@fikcja.invalid',
    company: 'Nabywca Testowy', address_1: 'Odbiorcza 4', postcode: '00-950', city: 'Nibylandia' },
  dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Odbiorcza 4', postcode: '00-950', city: 'Nibylandia' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, termin_platnosci: '14',
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-01T12:00:00Z', status_woo: 'processing',
  pozycje: [{ zrodlo_id: 7, nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 1, cena_brutto: '123.00', cena_netto: '100.00',
    brutto_linii: '123.00', netto_linii: '100.00', vat: null }],
  ...nad,
});

async function panel(env = {}) {
  const pelne = { OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, ...ADRES, ...env };
  const a = await zbudujOms({ env: pelne, moduly: modulyDla(pelne) });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(a.db, kontoPoLoginie(a.db, 'ewa').id, ['ustawienia', 'zamowienia']);
  const id = zapiszZamowienie(a.db, 'reczne', zamowienie('NIP-010'), {});
  const wdt = zapiszZamowienie(a.db, 'reczne', zamowienie('WDT-010', { chce_fakture: 1, nip: 'DE123456789',
    klient: { email: 'kunde@fikcja.invalid', company: 'Kunde GmbH', address_1: 'Erfundene Str. 1', postcode: '10115',
      city: 'Berlin', country: 'DE' } }), {});
  const admin = jako(a.db, 'adam');
  return { ...a, id, wdt, admin, ewa: jako(a.db, 'ewa'),
    zdrowie: async () => JSON.parse((await a.app.inject({ url: '/health' })).body),
    specyfikacja: () => get(a.app, `/zamowienia/${id}/specyfikacja.pdf`, admin),
    wywoz: () => get(a.app, `/zamowienia/${wdt}/potwierdzenie-wywozu.pdf`, admin),
    proforma: () => post(a.app, `/zamowienia/${id}/proforma`, admin),
    zamknij: async () => { await a.app.close(); a.db.close(); } };
}
const formularz = (html, id) => new RegExp(`<form id="${id}"[\\s\\S]*?<\\/form>`, 'u').exec(html)?.[0] ?? '';
const sprzedawcaSpec = () => vi.mocked(zbudujSpecyfikacjePdf).mock.calls.at(-1)[0].sprzedawca;
const sprzedawcaProformy = () => vi.mocked(zbudujProformePdf).mock.calls.at(-1)[0].sprzedawca;
const sprzedawcaWywozu = () => vi.mocked(zbudujOswiadczenieWywozuPdf).mock.calls.at(-1)[0].sprzedawca;

describe('PRZ-108.10 start bez NIP-u w pliku', () => {
  it('panel wstaje, /health melduje brak NIP-u, ekran Firma ma pola NIP i BDO oraz stan „Brak NIP-u”', async () => {
    const p = await panel();
    try {
      expect((await p.zdrowie()).uwagi).toContain(BRAK);
      const r = await get(p.app, EKRAN, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(formularz(r.body, 'nip-formularz')).toContain('name="nip"');
      expect(formularz(r.body, 'bdo-formularz')).toContain('name="bdo"');
      expect(r.body).toContain('Brak NIP-u');
    } finally { await p.zamknij(); }
  });

  it('bez NIP-u nigdzie: specyfikacja, potwierdzenie wywozu i proforma odmawiają czytelnie — żaden PDF nie powstaje', async () => {
    const p = await panel();
    try {
      for (const r of [await p.specyfikacja(), await p.wywoz(), await p.proforma()]) {
        expect(r.statusCode, r.body).toBe(400);
        expect(r.body).toContain('Wpisz NIP firmy w Ustawienia → Firma');
      }
      expect(vi.mocked(zbudujSpecyfikacjePdf)).not.toHaveBeenCalled();
      expect(vi.mocked(zbudujOswiadczenieWywozuPdf)).not.toHaveBeenCalled();
      expect(vi.mocked(zbudujProformePdf)).not.toHaveBeenCalled();
      // Proforma odmawia w FAZIE 1 — numer z serii nie przepada.
      expect(p.db.prepare('SELECT COUNT(*) AS n FROM proformy').get().n).toBe(0);
    } finally { await p.zamknij(); }
  });

  it('NIP i BDO z panelu: zapis admina 303, dokumenty biorą je od następnego użycia, bez restartu; /health milknie', async () => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS_NIP, p.admin, { nip: 'PL 222-222-22-22' });
      expect(r.statusCode, r.body).toBe(303);
      const zapis = wczytajKonfiguracjeIntegracji(p.db, 'nip_firmy');
      expect(zapis.ustawienia).toEqual({ nip: NIP_PANEL });
      expect(zapis.kontoLogin).toBe('adam');
      expect((await post(p.app, ZAPIS_BDO, p.admin, { bdo: ` ${BDO_PANEL} ` })).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'bdo_firmy').ustawienia).toEqual({ bdo: BDO_PANEL });
      const ekran = await get(p.app, `${EKRAN}?zapisano=nip`, p.admin);
      expect(ekran.body).toContain('Zapisano NIP firmy');
      expect(ekran.body).toContain('Zapisał adam');
      expect((await p.zdrowie()).uwagi).not.toContain(BRAK);

      expect((await p.specyfikacja()).statusCode).toBe(200);
      expect(sprzedawcaSpec()).toMatchObject({ nip: NIP_PANEL, bdo: BDO_PANEL });
      expect((await p.wywoz()).statusCode).toBe(200);
      expect(sprzedawcaWywozu().nip).toBe(`PL${NIP_PANEL}`);
      const pf = await p.proforma();
      expect(pf.statusCode, pf.body).toBe(302);
      expect(sprzedawcaProformy().nip).toBe(NIP_PANEL);

      // Zmiana istniejącego NIP-u: ekran ostrzega, że wystawione dokumenty zostają; następny dokument ma nowy NIP.
      expect(formularz((await get(p.app, EKRAN, p.admin)).body, 'nip-formularz')).toContain(OSTRZEZENIE);
      expect((await post(p.app, ZAPIS_NIP, p.admin, { nip: NIP_INNY })).statusCode).toBe(303);
      await p.specyfikacja();
      expect(sprzedawcaSpec().nip).toBe(NIP_INNY);
      // Pusty BDO = firma bez BDO: wiersz znika, specyfikacja bez BDO.
      expect((await post(p.app, ZAPIS_BDO, p.admin, { bdo: '  ' })).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'bdo_firmy')).toBeNull();
      await p.specyfikacja();
      expect(sprzedawcaSpec().bdo).toBeNull();
    } finally { await p.zamknij(); }
  });

  it('KSeF (faktury kosztowe): NIP formularza tokenu porównywany z NIP-em z panelu, czytanym przy zapisie', async () => {
    const p = await panel();
    try {
      const token = 'a'.repeat(40);
      expect((await post(p.app, KSEF, p.admin, { token, nip: NIP_PANEL })).statusCode).toBe(400);
      await post(p.app, ZAPIS_NIP, p.admin, { nip: NIP_PANEL });
      const r = await post(p.app, KSEF, p.admin, { token, nip: NIP_PANEL });
      expect(r.statusCode, r.body).toBe(303);
      expect(p.usluga('koszty', 'zrodloKsef').nipNiezgodny()).toBe(false);
      // NIP firmy zmieniony po zapisie tokenu: token nie jest używany (kontekst KSeF to inna firma), ekran mówi dlaczego.
      await post(p.app, ZAPIS_NIP, p.admin, { nip: NIP_INNY });
      expect(p.usluga('koszty', 'zrodloKsef').nipNiezgodny()).toBe(true);
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-108.10 walidacja i dostęp', () => {
  it.each([
    ['zła suma kontrolna', '1234563219', ZDANIE_NIP_SUMA],
    ['za krótki', '123456321', ZDANIE_NIP_FORMAT],
    ['litera', '12345632x8', ZDANIE_NIP_FORMAT],
    ['puste pole', '   ', null],
  ])('zły NIP (%s): 400 z tym samym zdaniem co przy starcie, bez wpisanej wartości, nic nie zapisane', async (_n, nip, zdanie) => {
    const p = await panel();
    try {
      const r = await post(p.app, ZAPIS_NIP, p.admin, { nip });
      expect(r.statusCode).toBe(400);
      if (zdanie) expect(r.body).toContain(ent(wielka(zdanie)));
      else expect(r.body).toContain('Wpisz NIP firmy');
      expect(wczytajKonfiguracjeIntegracji(p.db, 'nip_firmy')).toBeNull();
    } finally { await p.zamknij(); }
  });

  it.each([['5 cyfr', '12345'], ['ze spacjami', '000 000 002'], ['litera', '00000000x']])(
    'zły BDO (%s): 400, zdanie jak przy starcie, nic nie zapisane', async (_n, bdo) => {
      const p = await panel();
      try {
        const r = await post(p.app, ZAPIS_BDO, p.admin, { bdo });
        expect(r.statusCode).toBe(400);
        expect(r.body).toContain(ZDANIE_BDO);
        expect(wczytajKonfiguracjeIntegracji(p.db, 'bdo_firmy')).toBeNull();
      } finally { await p.zamknij(); }
    });

  it('nie-admin z dostępem do Ustawień: widzi stan bez formularzy, zapis NIP i BDO = 403, nic nie zapisane', async () => {
    const p = await panel();
    try {
      const ekran = await get(p.app, EKRAN, p.ewa);
      expect(ekran.statusCode).toBe(200);
      expect(formularz(ekran.body, 'nip-formularz')).toBe('');
      expect(formularz(ekran.body, 'bdo-formularz')).toBe('');
      expect(ekran.body).toContain('NIP i BDO wpisuje i zmienia tylko administrator');
      expect((await post(p.app, ZAPIS_NIP, p.ewa, { nip: NIP_PANEL })).statusCode).toBe(403);
      expect((await post(p.app, ZAPIS_BDO, p.ewa, { bdo: BDO_PANEL })).statusCode).toBe(403);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'nip_firmy')).toBeNull();
      expect(wczytajKonfiguracjeIntegracji(p.db, 'bdo_firmy')).toBeNull();
    } finally { await p.zamknij(); }
  });

  it('zapis w bazie, który dziś nie przeszedłby walidacji (ręcznie zmieniona baza) = brak NIP-u, nie zły dokument', async () => {
    const p = await panel();
    try {
      zapiszKonfiguracjeIntegracji(p.db, 'nip_firmy', { ustawienia: { nip: '1234563219' }, sekrety: {} });
      const r = await p.specyfikacja();
      expect(r.statusCode).toBe(400);
      expect(vi.mocked(zbudujSpecyfikacjePdf)).not.toHaveBeenCalled();
      expect((await p.zdrowie()).uwagi).toContain(BRAK);
    } finally { await p.zamknij(); }
  });
});

describe('PRZ-108.10 plik wygrywa (produkcja) — każde pole osobno', () => {
  it('NIP i BDO w pliku: ekran pokazuje wartości z dopiskiem, oba zapisy = 409; zapis w bazie nie trafia na dokumenty', async () => {
    const p = await panel({ OMS_SPRZEDAWCA_NIP: NIP_PLIK, OMS_SPRZEDAWCA_BDO: BDO_PLIK });
    try {
      const ekran = await get(p.app, EKRAN, p.admin);
      // PRZ-108.11 (decyzja właściciela 22.10): wartość tylko do odczytu + plakietka „wkrótce” zamiast zdania o pliku.
      expect(ekran.body).toContain('Zmiana w panelu — wkrótce. Dziś: plik konfiguracji (<code>OMS_SPRZEDAWCA_NIP</code>).');
      expect(ekran.body).toContain('Zmiana w panelu — wkrótce. Dziś: plik konfiguracji (<code>OMS_SPRZEDAWCA_BDO</code>).');
      expect(ekran.body).not.toContain('NIP poprawisz w pliku');
      expect(ekran.body).toContain(NIP_PLIK);
      expect(ekran.body).toContain(BDO_PLIK);
      expect(formularz(ekran.body, 'nip-formularz')).toBe('');
      expect(formularz(ekran.body, 'bdo-formularz')).toBe('');
      expect((await post(p.app, ZAPIS_NIP, p.admin, { nip: NIP_PANEL })).statusCode).toBe(409);
      expect((await post(p.app, ZAPIS_BDO, p.admin, { bdo: BDO_PANEL })).statusCode).toBe(409);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'nip_firmy')).toBeNull();
      expect(wczytajKonfiguracjeIntegracji(p.db, 'bdo_firmy')).toBeNull();
      expect((await p.zdrowie()).uwagi).not.toContain(BRAK);

      // Zapis sprzed dopisania do pliku (wprost do bazy) — plik i tak wygrywa.
      zapiszKonfiguracjeIntegracji(p.db, 'nip_firmy', { ustawienia: { nip: NIP_PANEL }, sekrety: {} });
      zapiszKonfiguracjeIntegracji(p.db, 'bdo_firmy', { ustawienia: { bdo: BDO_PANEL }, sekrety: {} });
      await p.specyfikacja();
      expect(sprzedawcaSpec()).toMatchObject({ nip: NIP_PLIK, bdo: BDO_PLIK });
      await p.wywoz();
      expect(sprzedawcaWywozu().nip).toBe(`PL${NIP_PLIK}`);
      expect((await p.proforma()).statusCode).toBe(302);
      expect(sprzedawcaProformy().nip).toBe(NIP_PLIK);
    } finally { await p.zamknij(); }
  });

  it('NIP w pliku, BDO w panelu: zapis NIP-u = 409, zapis BDO przechodzi i trafia na specyfikację obok NIP-u z pliku', async () => {
    const p = await panel({ OMS_SPRZEDAWCA_NIP: NIP_PLIK });
    try {
      const ekran = await get(p.app, EKRAN, p.admin);
      expect(formularz(ekran.body, 'nip-formularz')).toBe('');
      expect(formularz(ekran.body, 'bdo-formularz')).toContain('name="bdo"');
      expect((await post(p.app, ZAPIS_NIP, p.admin, { nip: NIP_PANEL })).statusCode).toBe(409);
      expect((await post(p.app, ZAPIS_BDO, p.admin, { bdo: BDO_PANEL })).statusCode).toBe(303);
      await p.specyfikacja();
      expect(sprzedawcaSpec()).toMatchObject({ nip: NIP_PLIK, bdo: BDO_PANEL });
    } finally { await p.zamknij(); }
  });

  it('BDO w pliku, NIP w panelu: zapis BDO = 409, NIP z panelu obok BDO z pliku', async () => {
    const p = await panel({ OMS_SPRZEDAWCA_BDO: BDO_PLIK });
    try {
      expect((await post(p.app, ZAPIS_BDO, p.admin, { bdo: BDO_PANEL })).statusCode).toBe(409);
      expect((await post(p.app, ZAPIS_NIP, p.admin, { nip: NIP_PANEL })).statusCode).toBe(303);
      await p.specyfikacja();
      expect(sprzedawcaSpec()).toMatchObject({ nip: NIP_PANEL, bdo: BDO_PLIK });
    } finally { await p.zamknij(); }
  });

  it('zły NIP albo BDO w pliku nadal blokuje start (plik się nie ignoruje po cichu)', async () => {
    await expect(panel({ OMS_SPRZEDAWCA_NIP: '1234563219' })).rejects.toThrow('OMS_SPRZEDAWCA_NIP: niepoprawny NIP');
    await expect(panel({ OMS_SPRZEDAWCA_BDO: '12345' })).rejects.toThrow('OMS_SPRZEDAWCA_BDO');
  });
});
