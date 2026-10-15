import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { NAJDLUZSZY_PRZEBIEG_MS } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import { NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS } from '../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';

const katalogi = [];
const aplikacje = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of aplikacje.splice(0)) { await a.app.close(); a.db.close(); }
  for (const p of katalogi.splice(0)) rmSync(p, { recursive: true, force: true });
});
function env() {
  const p = mkdtempSync(join(tmpdir(), 'faktury-konfig-')); katalogi.push(p);
  return { OMS_PROFORMY_KATALOG: p, OMS_ETYKIETY_KATALOG: p,
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'operator', OMS_PASS: 'fixture', INFAKT_API_KEY: 'fixture', INFAKT_ARCHIWUM: p };
}
const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };
function zamowienie() {
  return { zrodlo_id: 1, numer: 'TEST-WDT', klient: { company: 'Firma testowa UE',
    first_name: 'Jan', last_name: 'Testowy', address_1: 'Testowa 1', postcode: '10000', city: 'Miasto' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1,
    nip: 'SK1000000001', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
    anulowane: 0, status_woo: 'processing', oplacone_at: null, utworzone_at: '2026-09-10T10:00:00Z',
    pozycje: [{ nazwa: 'Towar testowy', sku: null, ilosc: 1, cena_brutto: '123.00', vat: null }] };
}
describe('faktury: konfiguracja rzeczywistego manifestu i HTTP', () => {
  it.each(['zamowienie', 'okres'])('%s wysyła NIP z env do payloadu WDT przez prawdziwą fabrykę', async droga => {
    const payloady = [], vies = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opcje = {}) => {
      const u = String(url);
      let dane;
      if (u.includes('/vat/')) { vies.push(u); dane = { isValid: true, requestIdentifier: 'TEST', requestDate: '2026-09-30' }; }
      else if (u.includes('/clients.json')) dane = { entities: [{ id: 77 }], metainfo: { total_count: 1 } };
      else if (opcje.method === 'POST' && u.includes('/invoices.json')) {
        const p = JSON.parse(opcje.body).invoice; payloady.push(p);
        dane = { uuid: 'fixture-uuid', number: p.number };
      } else if (u.includes('/invoices.json')) dane = { entities: [], metainfo: { total_count: 0 } };
      else throw new Error('Nieoczekiwane API: ' + u);
      return new Response(JSON.stringify(dane), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const a = await zbudujOms({ env: env() }); aplikacje.push(a);
    const id = zapiszZamowienie(a.db, 'reczne', zamowienie(), {});
    let url = `/zamowienia/${id}/faktura`;
    if (droga === 'okres') {
      dopiszKlientaZbiorczego(a.db, { klucz: 'test-ue', nazwa: 'Firma testowa UE', nip: 'SK1000000001' });
      const o = zapewnijOkres(a.db, { klientKlucz: 'test-ue', rok: 2026, miesiac: 9 });
      a.db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = ? WHERE id = ?').run(o.id, id);
      url = `/okresy/${o.id}/wystaw-fakture`;
    }
    const r = await a.app.inject({ method: 'POST', url, headers, payload: {} });
    expect(r.statusCode, r.body).toBe(302);
    expect(payloady).toHaveLength(1);
    expect(payloady[0].notes).toContain('PL1234563218');
    expect(payloady[0].notes.match(/\d{10}/g)).toEqual(['1234563218']); // zaden inny numer NIP (np. zaszyty domyslny)
    expect(vies).toHaveLength(1);
    expect(new URL(vies[0]).searchParams.get('requesterNumber')).toBe('1234563218');
  });
  it.each(['1', '7200000'])('rzeczywiste zegary zachowują godzinę mimo starego parametru %s', odstep => {
    expect(modulFaktury.konfiguracja({ ...env(), OMS_FAKTURY_ODSTEP_MS: odstep }).odstepMs).toBe(3600000);
  });
  it('rzeczywiste zegary manifestu mają godzinę, mieszczą oba budżety i literalne uprawnienie', async () => {
    const a = await zbudujOms({ env: env() }); aplikacje.push(a);
    const k = modulFaktury.konfiguracja(env());
    const z = modulFaktury.zbuduj({ db: a.db, konfiguracja: k, teraz: () => new Date(), log: () => {},
      usluga: (m, n) => ({ 'kanaly.klienciKanalow': { fixture: {} }, 'kanaly.config': { definicje: [] } })[`${m}.${n}`] });
    expect(z.zegary.map(x => [x.nazwa, x.odstepMs])).toEqual([
      ['czuwaczKsef', 3600000], ['czuwaczArchiwumSprzedazy', 3600000] ]);
    for (const zegar of z.zegary) {
      expect(NAJDLUZSZY_PRZEBIEG_MS).toBeLessThan(zegar.odstepMs);
      expect(NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS).toBeLessThan(zegar.odstepMs);
    }
    expect(modulFaktury.uprawnienia.find(x => x.klucz === 'okresy').etykieta).toBe('Okresy rozliczeniowe');
  });
  it('bez INFAKT_ARCHIWUM nie tworzy archiwum ani jego zegara', async () => {
    const e = env(); delete e.INFAKT_ARCHIWUM;
    const a = await zbudujOms({ env: e }); aplikacje.push(a);
    const z = modulFaktury.zbuduj({ db: a.db, konfiguracja: modulFaktury.konfiguracja(e),
      teraz: () => new Date(), log: () => {},
      usluga: (m, n) => ({ 'kanaly.klienciKanalow': { fixture: {} }, 'kanaly.config': { definicje: [] } })[`${m}.${n}`] });
    expect(z.uslugi.czuwaczArchiwumSprzedazy).toBeNull();
    expect(z.zegary.map(x => x.nazwa)).toEqual(['czuwaczKsef']);
  });
});
