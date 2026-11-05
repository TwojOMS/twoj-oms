import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-152.G13w3: odmowy modułu wiadomości (klienci, szablony, odpowiedź na wątek) w układzie OMS.
// Status i tekst bez zmian; zmienia się opakowanie. Atrapa klienta Allegro nic nie wysyła.
const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const FORM = { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' };
const SZ = '/ustawienia/szablony-wiadomosci';
let db; let app; let wyslane;

const watek = (nadpisz = {}) => ({
  kanal: 'allegro_swietlik', threadId: 't1', interlocutorLogin: 'kupujacy_jan',
  lastMessageDateTime: '2026-08-28T20:00:00Z', typ: 'COMMON', przeczytany: 0,
  ostatniaOdKupujacego: 1, ostatniaTresc: 'Czy jest większy rozmiar?', pobranyAt: '2026-08-28T20:01:00Z', ...nadpisz,
});
const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });
const wyslij = (url, payload = '') => app.inject({ method: 'POST', url, headers: FORM, payload });

function sprawdz(r, status, tekst, h1, href, napis) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  if (tekst instanceof RegExp) expect(r.body).toMatch(tekst);
  else expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  if (h1) expect(r.body).toContain(`<h1>${h1}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${href}">${napis}</a>`);
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  wyslane = [];
  app = buildOmsServer({
    db, config: CONFIG,
    klienciWiadomosci: { allegro_swietlik: { wyslijWiadomosc: async (id, tekst) => { wyslane.push({ id, tekst }); return { id: 'm1' }; } } },
  });
  zapiszWatek(db, watek());
});
afterEach(async () => { await app?.close(); db?.close(); app = db = null; });

describe('klienci', () => {
  it('karta, edycja i zapis nieznanego klienta', async () => {
    const op = 'Wróć do klientów';
    sprawdz(await pobierz('/klienci/9999'), 404, 'Nie ma takiego klienta', null, '/klienci', op);
    sprawdz(await pobierz('/klienci/9999/edytuj'), 404, 'Nie ma takiego klienta', null, '/klienci', op);
    sprawdz(await wyslij('/klienci', 'id=9999&nazwa=Pracownia'), 404, 'Nie ma takiego klienta', null, '/klienci', op);
  });
});

describe('szablony', () => {
  it('nieznane zdanie, szablon (podgląd, zapis, usunięcie)', async () => {
    const op = 'Wróć do szablonów wiadomości';
    sprawdz(await wyslij(`${SZ}/zdania-platnosci/nie-ma/przywroc`), 404, 'Nie ma takiego zdania.', null, SZ, op);
    const t = 'Nie ma takiego szablonu — mógł zostać usunięty.';
    sprawdz(await pobierz(`${SZ}/wlasny-nie-ma`), 404, t, null, SZ, op);
    sprawdz(await wyslij(`${SZ}/wlasny-nie-ma`, 'nazwa=a&temat=b&tresc=c'), 404, t, null, SZ, op);
    sprawdz(await wyslij(`${SZ}/wlasny-nie-ma/usun`), 404, t, null, SZ, op);
  });
});

describe('odpowiedź na wątek i „załatwione"', () => {
  const W = '/wiadomosci/allegro_swietlik/t1';
  const op = 'Wróć do wątku';
  it('nieznany wątek odpowiedzi i „załatwione” wraca na listę wiadomości', async () => {
    sprawdz(await wyslij('/wiadomosci/allegro_swietlik/brak/odpowiedz', 'potwierdzam=tak&tresc=x'), 404, 'Nie ma takiego wątku.', null, '/wiadomosci', 'Wróć do wiadomości');
    sprawdz(await wyslij('/wiadomosci/allegro_swietlik/brak/zalatwione'), 404, 'Panel nie zna tego wątku.', null, '/wiadomosci', 'Wróć do wiadomości');
  });
  it('spór, brak potwierdzenia, brak kanału: wątek, nic nie wysłano', async () => {
    zapiszWatek(db, watek({ threadId: 'spor', typ: 'POST_PURCHASE_ISSUE' }));
    sprawdz(await wyslij('/wiadomosci/allegro_swietlik/spor/odpowiedz', 'potwierdzam=tak&tresc=x'), 400, 'To problem z zakupem — odpowiedz w Allegro, nie stąd.', null, '/wiadomosci/allegro_swietlik/spor', op);
    sprawdz(await wyslij(`${W}/odpowiedz`, 'tresc=x'), 400, 'Brak potwierdzenia — nic nie wysłano.', null, W, op);
    zapiszWatek(db, watek({ kanal: 'allegro_inny', threadId: 't2' }));
    sprawdz(await wyslij('/wiadomosci/allegro_inny/t2/odpowiedz', 'potwierdzam=tak&tresc=x'), 503, 'Kanał Allegro nie jest skonfigurowany.', null, '/wiadomosci/allegro_inny/t2', op);
    expect(wyslane).toEqual([]);
  });
  it('dowód wysyłki się nie zapisał: 409, nic nie wysłano', async () => {
    db.exec('DROP TABLE allegro_odpowiedzi_zalaczniki');
    db.exec('DROP TABLE allegro_odpowiedzi');
    sprawdz(await wyslij(`${W}/odpowiedz`, 'potwierdzam=tak&tresc=x'), 409, /<p class="pasek-uwaga" role="alert">Nie zapisano dowodu wysyłki, więc nic nie wysłano: [^<]+<\/p>/, null, W, op);
    expect(wyslane).toEqual([]);
  });
  it('„załatwione” bez daty ostatniej wiadomości: wątek', async () => {
    db.prepare('UPDATE allegro_watki SET last_message_date_time = NULL WHERE thread_id = ?').run('t1');
    sprawdz(await wyslij(`${W}/zalatwione`), 409, 'Wątek nie ma daty ostatniej wiadomości — nie ma czego zamknąć.', null, W, op);
  });
});
