import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import * as zamowienia from '../../../src/oms/db/zamowienia.js';
import * as klienci from '../../../src/oms/db/klienci.js';
import * as klientStaly from '../../../src/domena/klient-staly.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { KOMUNIKAT_BRAK_GUS } from '../../../src/domena/konfiguracja-gus.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };
const ogolne = 'błąd techniczny panelu — szczegóły w logu zamówienia.';
const techniczny = 'SQLITE: tajna-sciezka-do-bazy';
const trasy = [
  ['dane/gus', 'faktura'], ['dane/kopiuj-do-wysylki', 'wysylka'], ['status', null],
  ['wiadomosc/przypomnienie', 'wiadomosci'], ['komentarz', null],
  ['termin-wysylki', 'szczegoly'], ['klient/zapamietaj', 'faktura'], ['sync-sklep', null],
];
let db, app, id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // Drugi numer id wyłapuje przypadkowy powrót zawsze do pierwszego zamówienia.
  const dane = n => ({ zrodlo_id: n, numer: `LAM-${n}`,
    klient: { first_name: 'Ewa', last_name: 'Przykładowa', email: 'ewa@przyklad.invalid' },
    dostawa: { first_name: 'Ewa', last_name: 'Przykładowa', address_1: 'Lampowa 1', postcode: '00-001', city: 'Przykładowo' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T09:00:00',
    pozycje: [{ nazwa: 'Lampa', sku: 'L-1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }],
  });
  zamowienia.zapiszZamowienie(db, 'pro', dane(8101));
  id = zamowienia.zapiszZamowienie(db, 'pro', dane(8102));
});
afterEach(async () => { vi.restoreAllMocks(); if (app) await app.close(); app = null; db.close(); });
function panel(wiadomosci = null) {
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } },
    poller: { stan: () => ({}) }, gus: null, wiadomosci });
}
const post = (trasa, payload = {}, numer = id) => app.inject({ method: 'POST', url: `/zamowienia/${numer}/${trasa}`,
  headers: { ...headers, referer: 'https://obca.invalid/zamowienia/999' },
  payload: { ...payload, powrot: 'https://obca.invalid/' } });
function ekran(r, kod, zdanie, numer, kotwica) {
  expect(r.statusCode).toBe(kod);
  expect(r.headers['content-type']).toContain('text/html');
  expect(r.body).toContain('class="oms-sidebar');
  expect(r.body).toContain('<h1>Zamówienie</h1>');
  expect(r.body).toContain(zdanie);
  // 404: zamowienia nie ma, wiec powrot na jego karte dalby znowu 404 — wtedy lista zamowien.
  if (kod === 404) expect(r.body).toContain('href="/">Wróć do listy zamówień</a>');
  else expect(r.body).toContain(`href="/zamowienia/${numer}${kotwica ? '#' + kotwica : ''}">Wróć do zamówienia</a>`);
  expect(r.body).not.toContain('obca.invalid');
  expect(r.body).not.toContain(techniczny);
}
it.each(trasy)('%s: brak zamówienia zachowuje 404, menu i powrót', async (trasa, kotwica) => {
  panel();
  ekran(await post(trasa, {}, 99999), 404, trasa === 'komentarz' ? 'Nie ma takiego zamowienia' : 'Nie ma takiego zamówienia', 99999, kotwica);
});
it.each([
  ['dane/gus', {}, 503, KOMUNIKAT_BRAK_GUS, 'faktura', null],
  ['dane/kopiuj-do-wysylki', {}, 400, `Nie udało się skopiować danych: ${ogolne}`, 'wysylka', 'kopia'],
  ['status', {}, 400, 'Nie wybrano statusu — panel niczego nie zmienił.', null, null],
  ['status', { status: 'nowe' }, 400, `Nie udało się zmienić statusu: ${ogolne}`, null, 'status'],
  ['wiadomosc/przypomnienie', {}, 503, 'Poczta nie jest skonfigurowana — wiadomości panel nie wyśle.', 'wiadomosci', null],
  ['wiadomosc/przypomnienie', {}, 400, `Wiadomość NIE została wysłana: ${ogolne}`, 'wiadomosci', 'mail'],
  ['komentarz', { komentarz: 'x'.repeat(4001) }, 400,
    'Komentarz wewnętrzny ma 4001 znaków, a mieści się 4000. Skróć go albo załóż sprawę w Asanie i zostaw tu sam odnośnik.', null, null],
  ['termin-wysylki', { data_wysylki: '2026-02-30' }, 400, 'Nie zapisano daty wysyłki: „2026-02-30” to nie jest data (RRRR-MM-DD).', 'szczegoly', null],
  ['termin-wysylki', { data_wysylki: '2099-01-01', przywroc: '1' }, 409,
    'Zamówienie jest już wysłane — daty wysyłki nie da się zmienić.', 'szczegoly', 'wyslane'],
  ['klient/zapamietaj', {}, 400, 'Nie udało się zapamiętać klienta: Dane klienta odrzucone.', 'faktura', 'klient-walidacja'],
  ['klient/zapamietaj', {}, 400, `Nie udało się zapamiętać klienta: ${ogolne}`, 'faktura', 'klient-zapis'],
])('%s: odmowa %s daje ekran bez zmiany zapisu', async (trasa, payload, kod, zdanie, kotwica, awaria) => {
  panel(awaria === 'mail' ? { wyslij: async () => { throw new Error(techniczny); } } : null);
  if (awaria === 'kopia') vi.spyOn(zamowienia, 'zapiszNadpisaniaWysylki').mockImplementationOnce(() => { throw new Error(techniczny); });
  if (awaria === 'status') vi.spyOn(zamowienia, 'zapiszFaktyStatusu').mockImplementationOnce(() => { throw new Error(techniczny); });
  if (awaria === 'wyslane') {
    db.prepare('UPDATE zamowienia SET wyslane_at = ?, termin_wysylki_reczny = ? WHERE id = ?').run('2026-10-20', '2026-10-25', id);
  }
  if (awaria === 'klient-walidacja') vi.spyOn(klientStaly, 'znormalizujKlienta').mockImplementationOnce(() => { throw bladOperatora('Dane klienta odrzucone.'); });
  if (awaria === 'klient-zapis') vi.spyOn(klienci, 'dopiszKlienta').mockImplementationOnce(() => { throw new Error(techniczny); });
  const przed = db.prepare('SELECT * FROM zamowienia WHERE id = ?').get(id);
  ekran(await post(trasa, payload), kod, zdanie, id, kotwica);
  expect(db.prepare('SELECT * FROM zamowienia WHERE id = ?').get(id)).toEqual(przed);
  expect(db.prepare('SELECT COUNT(*) AS n FROM klienci').get().n).toBe(0);
});
// Inwentarz nie znalazł B w karta.js. Nietknięta trasa C nadal ma tekstowy kontrakt.
it('płatności poza zakresem: odmowa nadal text/plain', async () => {
  panel();
  const r = await post('platnosci', { kwota: 'zla' });
  expect(r.statusCode).toBe(400);
  expect(r.headers['content-type']).toContain('text/plain');
  expect(r.body).not.toContain('<html');
});
