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
  katalog = mkdtempSync(join(tmpdir(), 'oms-148-05-etykiety-'));
  const dpd = createDpdClient({ url: 'https://dpd.example.test/api', login: '99999999', haslo: 'x', fid: '100145', nadawca: adres, fetchImpl: fetchDpd });
  const nadanie = createNadanie({ db, kurierzy: { dpd }, katalogEtykiet: katalog });
  const config = { auth: { user: 'operator', pass: 'atrapa' }, definicje: [{ klucz: 'polcien', typ: 'woo', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }], kanaly: { polcien: {} }, sklepy: {} };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const id = zapiszZamowienie(db, 'polcien', {
    zrodlo_id: 'pc-148', numer: 'PC-148', klient: { email: adres.email, phone: adres.phone },
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
// PRZ-148.05: drobne uwagi recenzji PRZ-145 — tylko ekran i obsługa błędów, kwoty bez zmian.
describe('PRZ-148.05 — ekran nadania przy pobraniu z wpłatami', () => {
  it('(1, 4) nieczytelna wpłata daje zdanie dla operatora zamiast 500, pole kwoty puste', async () => {
    const t = przygotuj({ p: null });
    db.prepare("INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, zrodlo, utworzona_at) VALUES (?, 'abc', '2026-11-04', 'Przelew', 'reczna', '2026-11-04')").run(t.id);
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Wpłaty zamówienia są nieczytelne — panel nie policzy niedopłaty: Kwota nie jest liczbą: wpłata z 2026-11-04');
    expect(r.body).toContain('name="kwota_pobrania" value=""');
    expect(r.body).not.toContain('potwierdz_niedoplate');
  });
  it('(4) nieczytelna wpłata nie odblokowuje nadania — POST dalej odmawia', async () => {
    const t = przygotuj({ p: null });
    db.prepare("INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, zrodlo, utworzona_at) VALUES (?, 'abc', '2026-11-04', 'Przelew', 'reczna', '2026-11-04')").run(t.id);
    const r = await t.post({ kwota_pobrania: '50.00' });
    expect(r.statusCode).not.toBe(302);
    expect(t.przesylki()).toHaveLength(0); expect(t.fetchDpd).not.toHaveBeenCalled();
  });
  it('(2) K 0 i puste brutto przy wpłatach — zdanie bez pustej kwoty', async () => {
    const r = await przygotuj({ brutto: '', k: '0.00' }).get();
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/najwyżej\s+zł/);
    expect(r.body).toContain('Zamówienie ma wpłaty 50.00 zł, ale nie ma kwoty zamówienia ani kwoty pobrania większej od zera — panel nie policzy niedopłaty. Uzupełnij kwotę pobrania na karcie zamówienia albo wyłącz pobranie.');
  });
  it('(2) to samo na dosyłce — podpowiedź bez pustej kwoty', async () => {
    const t = przygotuj({ brutto: '', k: '0.00' });
    const pierwsza = rozpocznijPrzesylke(db, t.id, 'dpd', 1);
    zakonczPrzesylke(db, pierwsza.id, { numerListu: 'PC148N1', etykietaSciezka: join(katalog, 'e.pdf'), surowa: '<x/>' });
    const r = await t.get();
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/najwyżej\s+zł/);
    expect(r.body).toContain('uzupełnij kwotę pobrania na karcie zamówienia.');
  });
  it('(3) brutto 0 — niedopłata liczona od kwoty pobrania i tak podpisana', async () => {
    const r = await przygotuj({ brutto: '0.00', k: '50.00', p: '20.00' }).get();
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="kwota_pobrania" value="30.00"');
    expect(r.body).toContain('niedopłata 30.00 zł (kwota pobrania na zamówieniu 50.00 zł minus wpłaty)');
    expect(r.body).not.toContain('kwota zamówienia 50.00 zł');
  });
  it('(3) brutto 0 na dosyłce — ta sama etykieta w podpowiedzi', async () => {
    const t = przygotuj({ brutto: '0.00', k: '50.00', p: '20.00' });
    const pierwsza = rozpocznijPrzesylke(db, t.id, 'dpd', 1);
    zakonczPrzesylke(db, pierwsza.id, { numerListu: 'PC148N1', etykietaSciezka: join(katalog, 'e.pdf'), surowa: '<x/>' });
    const r = await t.get();
    expect(r.body).toContain('niedopłata 30.00 zł (kwota pobrania na zamówieniu 50.00 zł minus wpłaty)');
    expect(r.body).not.toContain('kwota zamówienia 50.00 zł');
  });
  it('(3) brutto czytelne — etykieta jak dotąd „kwota zamówienia”', async () => {
    const r = await przygotuj().get();
    expect(r.body).toContain('niedopłata 162.90 zł (kwota zamówienia 212.90 zł minus wpłaty)');
  });
});
