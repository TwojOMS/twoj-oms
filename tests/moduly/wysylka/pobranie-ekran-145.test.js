// Wszystkie dane zmyślone. Prawdziwa trasa i usługa, kurier wyłącznie w atrapie.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const headers = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64'), origin: 'http://localhost' };
const adres = { nazwa: 'Pracownia Półcień', ulica: 'Przykładowa 12', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'klient@example.test' };
const formularz = { ...adres, waga: '1', dlugosc: '30', szerokosc: '20', wysokosc: '10', kolejnosc: '1' };
let db, serwer, katalog;
beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(async () => {
  if (serwer) await serwer.close();
  serwer = undefined;
  db.close();
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = undefined;
});
function przygotuj({ brutto = '212.90', k = '50.00', p = '50.00', pobranie = 1 } = {}) {
  const fetchDpd = vi.fn();
  for (const nazwa of ['v10-ok.xml', 'v4-ok.xml', 'v4-ok-zpl.xml']) {
    const xml = readFileSync(new URL(`./fixtures/dpd/${nazwa}`, import.meta.url), 'utf8');
    fetchDpd.mockResolvedValueOnce({ status: 200, ok: true, text: async () => xml });
  }
  katalog = mkdtempSync(join(tmpdir(), 'oms-145-02-etykiety-'));
  const dpd = createDpdClient({ url: 'https://dpd.example.test/api', login: '99999999', haslo: 'x', fid: '100145', nadawca: adres, fetchImpl: fetchDpd });
  const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: katalog });
  const config = { auth: { user: 'operator', pass: 'atrapa' }, definicje: [{ klucz: 'polcien', typ: 'woo', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }], kanaly: { polcien: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, 'polcien', {
    zrodlo_id: 'pc-145', numer: 'PC-145', klient: { email: adres.email, phone: adres.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: adres.ulica, postcode: adres.kod, city: adres.miasto, country: 'PL' },
    metoda_wysylki: 'dpd', pobranie, kwota_pobrania: k, kwota_brutto: brutto, chce_fakture: 0, nip: null,
    punkt_odbioru: null, oplacone_at: null, status_woo: 'processing', anulowane: 0, pozycje: [], utworzone_at: '2026-11-04T12:00:00',
  }, {});
  const wplata = (kwota) => dodajWplateReczna(db, id, { kwota, data: '2026-11-04', metoda: 'Przelew' });
  if (p) wplata(p);
  return { id, wplata, fetchDpd,
    get: () => serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers }),
    post: (payload) => serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers, payload: { ...formularz, ...payload } }),
    przesylki: () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id),
  };
}
describe('PRZ-145.02 — ekran niedopłaty', () => {
  it('GET podpowiada niedopłatę z brutto i pokazuje ostrzeżenie oraz potwierdzenie', async () => {
    const t = przygotuj(); const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="kwota_pobrania" value="162.90"');
    expect(r.body).toContain('niedopłata 162.90 zł');
    expect(r.body).toContain('różni się od niedopłaty');
    expect(r.body).toContain('name="potwierdz_niedoplate" value="162.90"');
  });
  it.each([['abc', '50.00', 'Kwota zamówienia jest nieczytelna'], ['', 'abc', 'Kwota pobrania na zamówieniu jest nieczytelna']])('GET błędne kwoty %s/%s daje zdanie zamiast 500', async (brutto, k, tekst) => {
    const r = await przygotuj({ brutto, k }).get();
    expect(r.statusCode).toBe(200); expect(r.body).toContain(tekst);
  });
  it('zerowa K też daje ostrzeżenie o różnicy względem niedopłaty', async () => {
    const r = await przygotuj({ k: '0.00' }).get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Kwota pobrania na zamówieniu (0.00 zł) różni się od niedopłaty.');
  });
  it.each([['162.90', undefined, 302], ['100.00', undefined, 400], ['100.00', '162.90', 302]])('POST kwota %s, potwierdzenie %s → %s', async (kwota, potwierdzenie, status) => {
    const t = przygotuj();
    const r = await t.post({ kwota_pobrania: kwota, potwierdz_niedoplate: potwierdzenie });
    expect(r.statusCode).toBe(status);
    if (status === 302) {
      expect(t.przesylki()).toHaveLength(1);
      expect(t.fetchDpd.mock.calls[0][1].body).toContain(`<cod><amount>${kwota}</amount><currency>PLN</currency></cod>`);
    } else {
      expect(r.body).toContain('różni się od niedopłaty 162.90 zł');
      expect(t.przesylki()).toHaveLength(0); expect(t.fetchDpd).not.toHaveBeenCalled();
    }
  });
  it('wpłata między GET a POST unieważnia potwierdzenie', async () => {
    const t = przygotuj(); await t.get(); t.wplata('20.00');
    const r = await t.post({ kwota_pobrania: '100.00', potwierdz_niedoplate: '162.90' });
    expect(r.statusCode).toBe(400); expect(r.body).toContain('niedopłaty 142.90 zł');
    expect(t.przesylki()).toHaveLength(0); expect(t.fetchDpd).not.toHaveBeenCalled();
  });
  it('bez wpłat nie pokazuje nowego ostrzeżenia ani potwierdzenia, nadaje jak dotąd', async () => {
    const t = przygotuj({ p: null, k: '212.90' }); const r = await t.get();
    expect(r.body).not.toContain('potwierdz_niedoplate'); expect(r.body).not.toContain('niedopłata');
    expect((await t.post({ kwota_pobrania: '212.90' })).statusCode).toBe(302);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>212.90</amount>');
  });
  it('bez pobrania nie pokazuje bloku kwoty ani potwierdzenia', async () => {
    const r = await przygotuj({ pobranie: 0 }).get();
    expect(r.statusCode).toBe(200); expect(r.body).not.toContain('name="kwota_pobrania"');
    expect(r.body).not.toContain('potwierdz_niedoplate');
  });
  it('dosyłka podpowiada niedopłatę i przekazuje potwierdzenie po wskazaniu pobrania', async () => {
    const t = przygotuj();
    const pierwsza = rozpocznijPrzesylke(db, t.id, 'dpd', 1);
    zakonczPrzesylke(db, pierwsza.id, { numerListu: 'PC145N1', etykietaSciezka: join(katalog, 'e.pdf'), surowa: '<x/>' });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="kwota_pobrania" value="162.90"');
    expect(r.body).toContain('name="potwierdz_niedoplate" value="162.90"');
    expect(r.body).toContain('niedopłata 162.90 zł');
    expect((await t.post({ kolejnosc: '2', pobranie_na_tej_paczce: 'tak', kwota_pobrania: '100.00', potwierdz_niedoplate: '162.90' })).statusCode).toBe(302);
    expect(t.fetchDpd.mock.calls[0][1].body).toContain('<cod><amount>100.00</amount>');
  });
});
