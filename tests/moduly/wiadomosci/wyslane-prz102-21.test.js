import { beforeEach, afterEach, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wiadomosciZamowienia } from '../../../src/oms/db/wiadomosci.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { przykladoweZamowienie } from '../../../src/moduly/wiadomosci/szablony.js';
import { DOMYSLNE } from '../../../src/domena/szablony-wiadomosci.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-102.21: szablon „Zamówienie wysłane" — tylko szablon i ręczna wysyłka z karty. Poczta to atrapa.

const ADRES = '/ustawienia/szablony-wiadomosci/wyslane';
const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
let db, app, id, poczta, usluga;
const get = (url) => app.inject({ method: 'GET', url, headers });
const post = (url, payload = {}) => app.inject({ method: 'POST', url, headers, payload });
function paczka(numer = '0000123456789U', kurier = 'dpd', status = 'nadana') {
  db.prepare('INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, kurier, status, numer, db.prepare('SELECT COUNT(*) AS n FROM przesylki').get().n + 1, '2026-10-20T10:00:00Z');
}
beforeEach(async () => {
  db = openOmsDb(':memory:'); poczta = [];
  // Zamówienie zapisywane jak ze sklepu (pełny komplet kolumn) — ten sam katalog lamp co przykład w Ustawieniach.
  const { klient, dostawa, numer, kwota_brutto, koszt_dostawy_brutto, koszt_dostawy_netto, metoda_wysylki } = przykladoweZamowienie();
  id = zapiszZamowienie(db, 'reczne', {
    zrodlo_id: 9001, numer, klient, dostawa, metoda_wysylki, kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto, koszt_dostawy_brutto, koszt_dostawy_netto, status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-10-19T09:15:00',
    pozycje: [{ zrodlo_id: 7001, nazwa: 'Lampa stołowa Grzybek 30 cm', sku: 'LMP-GRZ-30', ilosc: 2, cena_brutto: '189.00',
      cena_netto: '153.66', brutto_linii: '378.00', netto_linii: '307.32', vat: null }],
  });
  const config = { auth: { user: 'operator', pass: 'x' }, klienciZbiorczy: [],
    oprawaPoczty: { podpis: 'Pracownia Przykładowa', footer: 'Stopka przykładowa' } };
  usluga = createWiadomosci({ db, config, mailer: { sendMail: async (m) => { poczta.push(m); } } });
  app = buildOmsServer({ db, config, wiadomosci: usluga,
    poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) } });
  await app.ready();
});
afterEach(async () => { await app?.close(); db.close(); });

it('lista i podgląd w Ustawieniach pokazują wysłane zamówienie z jedną przesyłką', async () => {
  expect((await get('/ustawienia/szablony-wiadomosci')).body).toContain('<td>Zamówienie wysłane</td>');
  const edytor = await get(ADRES);
  expect(edytor.statusCode).toBe(200);
  expect(edytor.body).toContain('<code>{przesylki}</code>');
  expect(edytor.body).not.toContain('<code>{dane_platnosci}</code>');
  const r = await get(`${ADRES}?${new URLSearchParams({ podglad: '1', temat: DOMYSLNE.wyslane.temat, tresc: DOMYSLNE.wyslane.tresc })}`);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Twoje zamówienie nr 1024 zostało wysłane.');
  expect(r.body).toContain('0000123456789U');
  expect(r.body).toContain('https://tracktrace.dpd.com.pl/parcelDetails?p1=0000123456789U');
  expect(r.body).not.toContain('Załącznik PDF dokłada panel');
  expect(poczta).toHaveLength(0);
});

it('zapis wymaga bloku przesyłek, przyjmuje edycję bez migracji i stosuje ją na karcie', async () => {
  const brak = await post(ADRES, { temat: 'W drodze', tresc: 'Dzień dobry,\n\n{podpis}' });
  expect(brak.statusCode).toBe(400);
  expect(brak.body).toContain('Treść musi zawierać {przesylki}');
  expect(brak.body).not.toContain('Ten mail dotyczy pieniędzy');
  expect((await post(ADRES, { temat: 'W drodze {numer_zamowienia}', tresc: 'Dzień dobry,\n\n{przesylki}\n\n{podpis}' })).statusCode).toBe(303);
  paczka();
  expect((await usluga.podglad(id, 'wyslane')).temat).toBe('W drodze 1024');
  expect((await post(ADRES, { temat: 'T', tresc: '{przesylki}\n\n{dane_platnosci}' })).statusCode).toBe(400);
});

it('karta, podgląd i ręczna wysyłka używają tej samej treści DPD, bez automatycznej poczty', async () => {
  paczka();
  const wybor = await get(`/zamowienia/${id}?wiadomosc=nowa`);
  expect(wybor.body).toContain('<span class="temat-nazwa">Zamówienie wysłane</span>');
  const karta = await get(`/zamowienia/${id}?wiadomosc=wyslane`);
  expect(karta.statusCode).toBe(200);
  expect(karta.body).toContain(`action="/zamowienia/${id}/wiadomosc/wyslane"`);
  const p = await usluga.podglad(id, 'wyslane');
  expect(p.tekst).toContain('DPD');
  expect(p.tekst).toContain('0000123456789U');
  expect(p.tekst).toContain('https://tracktrace.dpd.com.pl/parcelDetails?p1=0000123456789U');
  expect(p.html).toContain('<a href="https://tracktrace.dpd.com.pl/parcelDetails?p1=0000123456789U"');
  expect(p.tekst).toContain('Stopka przykładowa');
  expect(p.html).toContain('Stopka przykładowa');
  expect(p.zalacznik).toBeNull();
  expect(poczta).toHaveLength(0);
  expect((await post(`/zamowienia/${id}/wiadomosc/wyslane`)).statusCode).toBe(302);
  expect(poczta).toHaveLength(1);
  expect(poczta[0]).toMatchObject({ text: p.tekst, html: p.html, subject: p.temat });
  expect(wiadomosciZamowienia(db, id)).toHaveLength(1);
});

// 'do_wyjasnienia': numer przydzielony, ale nadanie nie doszło do końca — paczki może nie być.
it.each(['brak', 'blad', 'w_trakcie', 'do_wyjasnienia'])('odmawia bez żywej przesyłki z numerem: %s', async (stan) => {
  if (stan !== 'brak') paczka(stan === 'w_trakcie' ? null : 'NIE-WYSYLAC', 'dpd', stan);
  const wybor = await get(`/zamowienia/${id}?wiadomosc=nowa`);
  expect(wybor.body).toContain('Zamówienie nie ma przesyłki z numerem listu');
  expect(wybor.body).not.toContain(`href="/zamowienia/${id}?wiadomosc=wyslane`);
  await expect(usluga.podglad(id, 'wyslane')).rejects.toThrow(/nie ma przesyłki z numerem listu/);
  await post(`/zamowienia/${id}/wiadomosc/wyslane`);
  expect(poczta).toHaveLength(0);
  expect(wiadomosciZamowienia(db, id)).toHaveLength(0);
});

it('wszystkie paczki, nieznany kurier bez linku i punkt odbioru; HTML numeru jest escapowany', async () => {
  paczka('A\"<img src=x>&', 'dpd'); paczka('DRUGA-1', 'nieznany'); paczka('POMIN', 'dpd', 'blad');
  db.prepare('UPDATE zamowienia SET punkt_odbioru = ?, punkt_odbioru_opis = ? WHERE id = ?').run('BOX01', 'Punkt Przykładowy', id);
  const p = await usluga.podglad(id, 'wyslane');
  expect(p.tekst).toContain('A\"<img src=x>&');
  expect(p.html).toContain('A&quot;&lt;img src=x&gt;&amp;');
  expect(p.html).toContain('href="https://tracktrace.dpd.com.pl/parcelDetails?p1=A%22%3Cimg%20src%3Dx%3E%26"');
  expect(p.html).not.toContain('<img src=x>');
  expect(p.tekst).toContain('DRUGA-1');
  expect(p.tekst).toContain('Punkt Przykładowy');
  expect(p.tekst).not.toContain('POMIN');
  expect(p.html.match(/<a href=/g)).toHaveLength(1);
});

it('link w HTML jest escapowany niezależnie od wzorca przewoźnika', async () => {
  // Import w teście, nie na górze: na starym kodzie pliku nie ma, a reszta testów ma paść na asercjach.
  const { blokiHtmlWyslane } = await import('../../../src/core/poczta/wyslane-html.js');
  const html = blokiHtmlWyslane({ przesylki: [{ przewoznik: 'DPD', numer: '1', link: 'https://x.example/?a=1&b="2"' }], punkt: null }).przesylki;
  expect(html).toContain('href="https://x.example/?a=1&amp;b=&quot;2&quot;"');
  expect(html).not.toContain('b="2"');
});
