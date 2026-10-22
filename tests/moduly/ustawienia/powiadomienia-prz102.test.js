import { afterEach, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia, ustawCzynne } from '../../../src/core/bezpieczenstwo/konta.js';
import { podmienLukiKsef } from '../../../src/oms/db/ostrzezenia.js';
import { RODZAJE_OSTRZEZEN } from '../../../src/domena/powiadomienia.js';
import { nowyPanel, jako, get, post, BASIC } from '../../pomoc/konta-prz068.js';

// PRZ-108.08: ósmy rodzaj „automatyzacja” jest tylko dla administratora — konto sprzedaży nadal widzi siedem pól.
const typy = ['integracja', 'automatyzacja', 'faktura-ksef', 'faktura-termin', 'pobranie-korekta', 'zwrot-korekta', 'przesylka', 'wiadomosc-allegro'];
const panele = [];
afterEach(async () => { for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); } });
function panel() {
  const p = nowyPanel();
  panele.push(p);
  zalozKonto(p.db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'sprzedawca-test', imie: 'Sprzedawca', haslo: 'h', rola: 'sprzedaz' });
  const id = kontoPoLoginie(p.db, 'sprzedawca-test').id;
  ustawUprawnienia(p.db, id, ['zamowienia']);
  return { ...p, id, admin: jako(p.db, 'admin-test'), osoba: jako(p.db, 'sprzedawca-test') };
}
const pola = html => html.match(/<input[^>]*type="checkbox"[^>]*>/gu) ?? [];

it('każdy zalogowany widzi siedem domyślnie zaznaczonych pól i link z Mojego konta', async () => {
  const { app, osoba, admin } = panel();
  const r = await get(app, '/ustawienia/powiadomienia', osoba);
  expect(r.statusCode).toBe(200);
  expect(pola(r.body)).toHaveLength(7);
  for (const rodzaj of RODZAJE_OSTRZEZEN.filter(x => !x.tylkoAdmin)) {
    expect(r.body.includes(rodzaj.nazwa)).toBe(true);
    expect(r.body.includes(rodzaj.opis)).toBe(true);
  }
  expect(r.body).not.toContain('value="automatyzacja"');
  for (const typ of typy.filter(t => t !== 'automatyzacja')) expect(pola(r.body).find(p => p.includes(`value="${typ}"`))).toContain('checked');
  const a = await get(app, '/ustawienia/powiadomienia', admin);
  expect(pola(a.body)).toHaveLength(8);
  expect((await get(app, '/konto', osoba)).body).toContain('href="/ustawienia/powiadomienia"');
  expect((await get(app, '/ustawienia/magazyn', osoba)).statusCode).toBe(403);
});

it('POST zapisuje tylko wyłączone rodzaje per konto, a ponowny zapis włącza wszystko', async () => {
  const { app, db, id, osoba, admin } = panel();
  const r = await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy.filter(t => t !== 'faktura-ksef') });
  expect(r.statusCode).toBe(303);
  expect(JSON.parse(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(`powiadomienia.ukryte.${id}`).wartosc)).toEqual(['faktura-ksef']);
  const ekran = await get(app, r.headers.location, osoba);
  expect(ekran.body).toContain('Zapisano ustawienia powiadomień.');
  expect(pola(ekran.body).find(p => p.includes('value="faktura-ksef"'))).not.toContain('checked');
  expect(pola((await get(app, '/ustawienia/powiadomienia', admin)).body).every(p => p.includes('checked'))).toBe(true);
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy });
  expect(JSON.parse(db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(`powiadomienia.ukryte.${id}`).wartosc)).toEqual([]);
});

it('nieznany rodzaj jest odrzucony, pusty formularz wyłącza wszystkie, pojedyncze pole też działa', async () => {
  const { app, db, id, osoba } = panel();
  expect((await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: ['obcy'] })).statusCode).toBe(400);
  expect(db.prepare('SELECT * FROM ustawienia WHERE klucz = ?').get(`powiadomienia.ukryte.${id}`)).toBeUndefined();
  expect((await post(app, '/ustawienia/powiadomienia', osoba)).statusCode).toBe(303);
  expect(pola((await get(app, '/ustawienia/powiadomienia', osoba)).body).some(p => p.includes('checked'))).toBe(false);
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: 'przesylka' });
  expect(pola((await get(app, '/ustawienia/powiadomienia', osoba)).body).filter(p => p.includes('checked'))).toHaveLength(1);
});

it('admin widzi bezpiecznik dopiero gdy wszystkie czynne konta wyłączą rodzaj', async () => {
  const { app, db, id, osoba, admin } = panel();
  const payload = { widoczne: typy.filter(t => t !== 'faktura-ksef') };
  await post(app, '/ustawienia/powiadomienia', admin, payload);
  expect((await get(app, '/ustawienia/powiadomienia', admin)).body).not.toContain('Nikt w firmie nie widzi:');
  await post(app, '/ustawienia/powiadomienia', osoba, payload);
  expect((await get(app, '/ustawienia/powiadomienia', admin)).body).toContain('Nikt w firmie nie widzi: Faktury niewysłane do KSeF.');
  expect((await get(app, '/ustawienia/powiadomienia', osoba)).body).not.toContain('Nikt w firmie nie widzi:');
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy });
  ustawCzynne(db, id, false);
  expect((await get(app, '/ustawienia/powiadomienia', admin)).body).toContain('Nikt w firmie nie widzi:');
});

it('konto bez id nie zapisuje; brak konta nie ukrywa ostrzeżeń', async () => {
  const p = nowyPanel(); panele.push(p);
  podmienLukiKsef(p.db, [{ uuid: 'demo-luka', numer: 'FV-DEMO', invoiceDate: '2020-01-01' }]);
  expect((await post(p.app, '/ustawienia/powiadomienia', BASIC)).statusCode).toBe(403);
  expect((await get(p.app, '/', BASIC)).body).toContain('FV-DEMO');
});

it('na stronie głównej A ukrywa KSeF, B nadal widzi ten sam wiersz, lustro i odrzucenia bez zmian', async () => {
  const { app, db, id, osoba, admin } = panel();
  // PRZ-102.04: wiersz KSeF prowadzi do /faktury, więc widzi go tylko konto z prawem `faktury`.
  ustawUprawnienia(db, id, ['zamowienia', 'faktury']);
  podmienLukiKsef(db, [{ uuid: 'demo-luka', numer: 'FV-DEMO', invoiceDate: '2020-01-01' }]);
  expect((await get(app, '/', osoba)).body).toContain('FV-DEMO');
  await post(app, '/ustawienia/powiadomienia', osoba, { widoczne: typy.filter(t => t !== 'faktura-ksef') });
  expect((await get(app, '/', osoba)).body).not.toContain('FV-DEMO');
  expect((await get(app, '/', admin)).body).toContain('FV-DEMO');
  expect(db.prepare('SELECT * FROM ksef_luki').all()).toHaveLength(1);
  expect(db.prepare('SELECT * FROM ostrzezenia_odrzucone').all()).toHaveLength(0);
});

it('POST z obcego Origin nie zapisuje ustawień', async () => {
  const { app, osoba } = panel();
  const r = await app.inject({ method: 'POST', url: '/ustawienia/powiadomienia', headers: { ...osoba, origin: 'http://obca.invalid' }, payload: {} });
  expect(r.statusCode).toBe(403);
});
