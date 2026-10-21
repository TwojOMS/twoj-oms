// PRZ-104: pole „Data wysyłki” na ekranie zakładania zamówienia ręcznego (prośba właściciela 21.10.2026:
// „dodaj też pole data wysyłki. Puste = standardowy czas”). Data znaczy „najpóźniej do”.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { parsujNoweZamowienie } from '../../../src/domena/nowe-zamowienie.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { wiekZamowienia } from '../../../src/domena/wiek-zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const dzis = dzienWarszawa(new Date().toISOString());
const zaDni = (n) => new Date(Date.parse(`${dzis}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const formularz = (nad = {}) => ({
  w_nazwa: 'Ala Lampowa', w_ulica: 'Świetlna 2', w_kod: '00-001', w_miasto: 'Lampowo',
  dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '19,00',
  poz_nazwa: 'Lampa stołowa Półcień', poz_ilosc: '1', poz_cena_brutto: '189.00', poz_sku: '', poz_cena_netto: '',
  ...nad,
});

describe('parsujNoweZamowienie — data wysyłki', () => {
  it('puste pole = standardowy czas (null)', () => {
    expect(parsujNoweZamowienie(formularz()).termin_wysylki_reczny).toBeNull();
    expect(parsujNoweZamowienie(formularz({ data_wysylki: '' })).termin_wysylki_reczny).toBeNull();
  });
  it('poprawna data przechodzi dosłownie', () => {
    expect(parsujNoweZamowienie(formularz({ data_wysylki: zaDni(3) })).termin_wysylki_reczny).toBe(zaDni(3));
  });
  it('zła data to odmowa z powodem dla operatora', () => {
    expect(() => parsujNoweZamowienie(formularz({ data_wysylki: zaDni(-2) }))).toThrow(/wcześniejsza niż dziś/);
  });
});

describe('POST /zamowienia/nowe — data wysyłki', () => {
  let db, app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, poller });
    await app.ready();
  });
  const zaloz = (payload) => app.inject({ method: 'POST', url: '/zamowienia/nowe', headers: naglowek, payload });

  it('ekran ma pole daty w „Szczegółach zamówienia” z podpowiedzią o standardzie', async () => {
    const body = (await app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek })).body;
    const szczegoly = body.slice(body.indexOf('<h2>Szczegóły zamówienia</h2>'));
    expect(szczegoly).toMatch(/<input[^>]*type="date"[^>]*name="data_wysylki"/);
    expect(szczegoly).toContain('puste = standardowy czas');
  });

  it('data zapisuje się z zamówieniem, zegar listy ją czyta, dziennik ją wymienia', async () => {
    const r = await zaloz(formularz({ data_wysylki: zaDni(6) }));
    expect(r.statusCode, r.body).toBe(302);
    const id = Number(r.headers.location.split('/').pop());
    const z = pobierzZamowienie(db, id);
    expect(z.termin_wysylki_reczny).toBe(zaDni(6));
    // Przelew nieopłacony — ręczna data i tak prowadzi zegar (decyzja właściciela 21.10.2026).
    expect(wiekZamowienia(z, new Date()).opis).toContain('data ręczna');
    const wpis = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'zamowienie.reczne'").get(id).wynik;
    expect(wpis).toContain(`Data wysyłki: ${zaDni(6).split('-').reverse().join('.')}.`);
  });

  it('bez daty: standardowy termin i dziennik bez wzmianki o dacie', async () => {
    const r = await zaloz(formularz());
    const id = Number(r.headers.location.split('/').pop());
    expect(pobierzZamowienie(db, id).termin_wysylki_reczny).toBeNull();
    const wpis = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'zamowienie.reczne'").get(id).wynik;
    expect(wpis).not.toContain('Data wysyłki');
  });

  it('zła data: 400, formularz wraca z wpisaną wartością i powodem, zamówienie nie powstaje', async () => {
    const zla = zaDni(-1);
    const r = await zaloz(formularz({ data_wysylki: zla }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('wcześniejsza niż dziś');
    expect(r.body).toMatch(new RegExp(`name="data_wysylki"[^>]*value="${zla}"`));
    expect(db.prepare("SELECT COUNT(*) AS n FROM zamowienia WHERE sklep = 'reczne'").get().n).toBe(0);
  });
});
