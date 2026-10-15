import { describe, it, expect, vi } from 'vitest';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zwrot } from '../../../src/oms/db/zwroty.js';

const env = { OMS_DB_PATH: ':memory:', OMS_SPRZEDAWCA_NIP: '1234563218',
  OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'test',
  OMS_PROFORMY_KATALOG: '.', OMS_ETYKIETY_KATALOG: '.' };
const headers = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'),
  origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const trasy = [ ['GET', '/zwrot'], ['POST', '/zwrot/podglad'], ['POST', '/zwrot/popraw'],
  ['POST', '/zwrot'], ['POST', '/zwroty/:zwrotId/pieniadze'], ['POST', '/zwroty/:zwrotId/usun'],
  ['POST', '/zwroty/:zwrotId/korekta'], ['POST', '/zwroty/:zwrotId/korekta/odblokuj'],
  ['POST', '/zwroty/:zwrotId/korekta/reczna'] ];
function fixture(db, faktura = false) {
  const id = zapiszZamowienie(db, 'fixture', { zrodlo_id: 901, numer: '901', klient: null,
    dostawa: null, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: Number(faktura),
    nip: null, kwota_brutto: '99.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-01T12:00:00',
    pozycje: [{ zrodlo_id: 77, nazwa: 'Produkt fixture', sku: 'TEST', ilosc: 1,
      cena_brutto: '99.00', brutto_linii: '99.00', vat: null }] }, {});
  if (faktura) db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
    .run(id, 'fixture-fv', 'FV FIXTURE', '2026-08-01T12:00:00Z');
  const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', powod: 'Prywatna notatka operatora',
    pozycje: [{ klucz_pozycji: 's77', nazwa: 'Produkt fixture', ilosc: 1, kwota: '99.00' }] });
  return { id, zwrotId: w.id };
}
async function zAplikacja(nadpisania, dzialanie) {
  const siec = vi.fn(() => { throw new Error('Nie wolno używać sieci w PRZ-024'); });
  vi.stubGlobal('fetch', siec);
  let a;
  try { a = await zbudujOms({ env, nadpisania }); await dzialanie(a); expect(siec).not.toHaveBeenCalled(); }
  finally { if (a) { await a.app.close(); a.db.close(); } vi.unstubAllGlobals(); }
}

describe('PRZ-024 domknięcie — rzeczywisty bootstrap i manifest', () => {
  it('domyślna kompozycja udostępnia wszystkie 9 tras frozen', async () => {
    await zAplikacja(undefined, async ({ app }) => {
      for (const [method, suffix] of trasy) expect(app.hasRoute({ method, url: '/zamowienia/:id' + suffix }), suffix).toBe(true);
    });
  });
  it('brak inFaktu daje realne null, ekran działa, zlecenie oddaje 503', async () => {
    await zAplikacja(undefined, async (a) => {
      expect(a.usluga('faktury', 'infakt')).toBeNull();
      expect(a.usluga('zwroty', 'korekta')).toBeNull();
      const { id, zwrotId } = fixture(a.db, true);
      const ekran = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers });
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).not.toContain('Wystaw korektę');
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${zwrotId}/korekta`, headers, payload: '' });
      expect(r.statusCode).toBe(503);
      expect(zwrot(a.db, id, zwrotId).korekta_zlecona_at).toBeNull();
    });
  });
  it('oznaczenie pieniędzy przez HTTP zapisuje fakt i log bez przelewu', async () => {
    await zAplikacja(undefined, async (a) => {
      const { id, zwrotId } = fixture(a.db);
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${zwrotId}/pieniadze`, headers, payload: '' });
      expect(r.statusCode).toBe(302);
      expect(zwrot(a.db, id, zwrotId).pieniadze_oddane_at).not.toBeNull();
      expect(a.db.prepare("SELECT wynik FROM log WHERE zamowienie_id=? AND akcja='zwrot.pieniadze'").all(id)).toHaveLength(1);
    });
  });
  it('usługa manifestu korzysta z dokładnie faktury.infakt, rezerwuje przed wywołaniem i chroni notatkę', async () => {
    const infakt = { pobierzFakture: vi.fn().mockResolvedValue({ uuid: 'fixture-fv', number: 'FV FIXTURE', invoice_date: '2026-08-01',
      services: [{ name: 'Produkt fixture', quantity: 1, gross_price: 9900, tax_symbol: '23' }] }),
      wystawKorekte: vi.fn(), listaKorekt: vi.fn().mockResolvedValue([]) };
    await zAplikacja({ 'faktury.infakt': infakt }, async (a) => {
      expect(a.usluga('faktury', 'infakt')).toBe(infakt);
      const { id, zwrotId } = fixture(a.db, true);
      infakt.wystawKorekte.mockImplementation(async (dokument) => {
        expect(zwrot(a.db, id, zwrotId).korekta_zlecona_at).not.toBeNull();
        expect(dokument.correction_reason).toBe('zwrot towaru');
        expect(JSON.stringify(dokument)).not.toContain('Prywatna notatka operatora');
        return { referencja: 'REF-FIXTURE', uuid: null, numer: null };
      });
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${zwrotId}/korekta`, headers, payload: '' });
      expect(r.statusCode).toBe(302);
      expect(infakt.pobierzFakture).toHaveBeenCalledWith('fixture-fv');
      expect(infakt.wystawKorekte).toHaveBeenCalledTimes(1);
      expect(zwrot(a.db, id, zwrotId).korekta_referencja).toBe('REF-FIXTURE');
      await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${zwrotId}/korekta`, headers, payload: '' });
      expect(infakt.wystawKorekte).toHaveBeenCalledTimes(1);
    });
  });
  it('odmowa korekty przez HTTP zapisuje dokładnie jeden log z akcją i treścią błędu', async () => {
    const infakt = { pobierzFakture: vi.fn().mockResolvedValue({ uuid: 'fixture-fv', number: 'FV FIXTURE', invoice_date: '2026-08-01',
      services: [{ name: 'Produkt fixture', quantity: 1, gross_price: 9900, tax_symbol: '23' }] }),
      wystawKorekte: vi.fn().mockRejectedValue(Object.assign(new Error('Odmowa korekty fixture'), { status: 422, dlaOperatora: true })),
      listaKorekt: vi.fn().mockResolvedValue([]) };
    await zAplikacja({ 'faktury.infakt': infakt }, async (a) => {
      const { id, zwrotId } = fixture(a.db, true);
      const logi = () => a.db.prepare("SELECT akcja, wynik FROM log WHERE zamowienie_id=? AND akcja='zwrot.korekta' ORDER BY id").all(id);
      expect(logi()).toHaveLength(0);
      const r = await a.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${zwrotId}/korekta`, headers, payload: '' });
      expect(r.statusCode).toBe(400);
      expect(r.body).toBe('Odmowa korekty fixture');
      expect(infakt.wystawKorekte).toHaveBeenCalledTimes(1);
      expect(zwrot(a.db, id, zwrotId).korekta_zlecona_at).toBeNull();
      const wpisy = logi();
      expect(wpisy).toHaveLength(1);
      expect(wpisy).toEqual([{ akcja: 'zwrot.korekta', wynik: 'BŁĄD: Odmowa korekty fixture' }]);
    });
  });
});
