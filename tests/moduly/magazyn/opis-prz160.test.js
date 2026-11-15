import { beforeEach, afterEach, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';

let db, app, id, magazyn;
const auth = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
const tekst = html => ({ typ: 'tekst', html });
const opis = (...elementy) => ({ sekcje: [{ elementy }] });
const post = (dane, akcja = 'zapisz', headers = auth) => app.inject({ method: 'POST', url: `/magazyn/${id}/opis`,
  headers, payload: { opis_sekcje_json: JSON.stringify(dane), akcja } });
const zapisany = () => db.prepare('SELECT opis_sekcje_json FROM karty_produktow WHERE id=?').get(id).opis_sekcje_json;
const podglad = body => body.match(/<div id="opis-podglad"[^>]*>([\s\S]*?)<!-- koniec podgladu -->/)?.[1] ?? '';
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
  magazyn = { stan: () => ({ trwa: false }) };
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' } }, magazyn });
});
afterEach(async () => { await app.close(); db.close(); });

it('niegotowy magazyn przekierowuje 302 bez zapisu opisu i źródła', async () => {
  magazyn.gotowy = () => false;
  const przed = db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id=?').all(id);
  const r = await post(opis(tekst('<p>Nowy opis</p>')));
  expect(r.statusCode).toBe(302);
  expect(r.headers.location).toBe('/magazyn');
  expect(zapisany()).toBeNull();
  expect(db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id=?').all(id)).toEqual(przed);
});
it.each(['<script>x</script>', '   ', '<p> &nbsp; </p>'])('zapis pomija pusty po oczyszczeniu tekst %s i usuwa pustą sekcję', async html => {
  const dane = opis(tekst(html));
  const r = await post(dane, 'podglad');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('name="opis_liczba" value="1"');
  expect(zapisany()).toBeNull();
  expect((await post(dane)).statusCode).toBe(303);
  expect(zapisany()).toBe('{"sekcje":[]}');
});
it('zapis sekcji z pustym tekstem zachowuje zdjęcie karty i pozostałą treść', async () => {
  const zdjecie = { typ: 'zdjecie', adres: 'https://obrazy.example/lampa.jpg' };
  db.prepare(`INSERT INTO zdjecia_kart (karta_id,kolejnosc,zrodlo,adres_zrodlowy,utworzono_at)
    VALUES (?,0,'api',?,'2026-11-13')`).run(id, zdjecie.adres);
  const dane = { sekcje: [opis(tekst('<script>x</script>'), zdjecie).sekcje[0], opis(tekst('<p>Opis</p>')).sekcje[0]] };
  expect((await post(dane)).statusCode).toBe(303);
  expect(JSON.parse(zapisany())).toEqual({ sekcje: [opis(zdjecie).sekcje[0], opis(tekst('<p>Opis</p>')).sekcje[0]] });
});

it('CSRF: bez Origin i Referer odmawia 403', async () => {
  expect((await post(opis(tekst('<p>A</p>')), 'zapisz', { authorization: auth.authorization })).statusCode).toBe(403);
  expect(zapisany()).toBeNull();
});
it('brak roli magazynu odmawia 403', async () => {
  zalozKonto(db, { login: 'pakowacz', imie: 'Jan', haslo: 'x', rola: 'produkcja', admin: false });
  const login = await app.inject({ method: 'POST', url: '/login', headers: { origin: auth.origin }, payload: { uzytkownik: 'pakowacz', haslo: 'x' } });
  expect(login.statusCode).toBe(302);
  const headers = { origin: auth.origin, cookie: [].concat(login.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).join('; ') };
  expect((await post(opis(tekst('<p>A</p>')), 'zapisz', headers)).statusCode).toBe(403);
  expect(zapisany()).toBeNull();
});
it('sekcja z 3 elementami odmawia po polsku i zachowuje treść', async () => {
  const r = await post(opis(...['Pierwszy', 'Drugi', 'Trzeci'].map(s => tekst(`<p>${s}</p>`))));
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('musi zawierać 1–2 elementy');
  expect(r.body).toContain('&lt;p&gt;Trzeci&lt;/p&gt;');
  expect(zapisany()).toBeNull();
});
it('script nie trafia do podglądu ani bazy; podgląd nie zapisuje', async () => {
  const dane = opis(tekst('<p onclick="alert(1)">Opis <b>lampy</b></p><script>alert(7)</script>'));
  const r = await post(dane, 'podglad');
  expect(r.statusCode).toBe(200);
  expect(podglad(r.body)).toContain('<p>Opis <b>lampy</b></p>');
  expect(podglad(r.body)).not.toMatch(/script|onclick|alert/);
  expect(r.body).toContain('&lt;script&gt;');
  expect(zapisany()).toBeNull();
  expect((await post(dane)).statusCode).toBe(303);
  expect(JSON.parse(zapisany())).toEqual(opis(tekst('<p>Opis <b>lampy</b></p>')));
});
it('html nie będący napisem nie trafia surowo do podglądu (JSON i powtórzone pole)', async () => {
  const a = await post(opis({ typ: 'tekst', html: ['<img src=x onerror=alert(1)>'] }), 'podglad');
  expect(podglad(a.body)).not.toMatch(/<img|onerror/);
  const b = await app.inject({ method: 'POST', url: `/magazyn/${id}/opis`,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'akcja=podglad&opis_liczba=1&s0_liczba=1&t0_0=tekst&h0_0=%3Cscript%3Ealert(1)%3C%2Fscript%3E&h0_0=x' });
  expect(podglad(b.body)).not.toMatch(/<script|alert/);
  expect(zapisany()).toBeNull();
});
it('zapis oznacza opis_sekcje_json jako ręczne, także przy wyczyszczeniu', async () => {
  expect((await post(opis(tekst('<p>Nowy opis</p>')))).statusCode).toBe(303);
  expect(db.prepare('SELECT reczne FROM karty_zrodla_pol WHERE karta_id=? AND pole=?').get(id, 'opis_sekcje_json')).toEqual({ reczne: 1 });
  expect((await post({ sekcje: [] })).statusCode).toBe(303);
  expect(JSON.parse(zapisany())).toEqual({ sekcje: [] });
});
it('odmawia zdjęcia spoza karty, również w podglądzie', async () => {
  for (const akcja of ['zapisz', 'podglad']) {
    const r = await post(opis({ typ: 'zdjecie', adres: 'https://obce.example/lampa.jpg' }), akcja);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Zdjęcie nie należy do tej karty');
    expect(podglad(r.body)).not.toContain('obce.example');
  }
  expect(zapisany()).toBeNull();
});
it('zdjęcia karty są do wyboru po kolejności, a wybrane można zapisać', async () => {
  for (const nr of [2, 1]) db.prepare(`INSERT INTO zdjecia_kart (karta_id,kolejnosc,zrodlo,adres_zrodlowy,utworzono_at)
    VALUES (?,?,'api',?,'2026-11-13')`).run(id, nr, `https://obrazy.example/${nr}.jpg`);
  const r = await post(opis(tekst('')), 'podglad');
  expect(r.statusCode).toBe(200);
  expect(r.body.indexOf('https://obrazy.example/1.jpg')).toBeLessThan(r.body.indexOf('https://obrazy.example/2.jpg'));
  expect((await post(opis({ typ: 'zdjecie', adres: 'https://obrazy.example/1.jpg' })) ).statusCode).toBe(303);
});
it('formularz bez JS dodaje, przesuwa i usuwa sekcje oraz drugi element bez zapisu', async () => {
  const wyslij = payload => app.inject({ method: 'POST', url: `/magazyn/${id}/opis`, headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload).toString() });
  let r = await wyslij({ opis_liczba: '0', akcja: 'dodaj' });
  expect(r.body).toContain('name="opis_liczba" value="1"');
  const pola = { opis_liczba: '2', s0_liczba: '1', s1_liczba: '1', t0_0: 'tekst', h0_0: '<p>A</p>', t1_0: 'tekst', h1_0: '<p>B</p>' };
  r = await wyslij({ ...pola, akcja: 'gora:1' });
  expect(r.body.indexOf('&lt;p&gt;B&lt;/p&gt;')).toBeLessThan(r.body.indexOf('&lt;p&gt;A&lt;/p&gt;'));
  r = await wyslij({ ...pola, akcja: 'dol:0' });
  expect(r.body.indexOf('&lt;p&gt;B&lt;/p&gt;')).toBeLessThan(r.body.indexOf('&lt;p&gt;A&lt;/p&gt;'));
  r = await wyslij({ ...pola, akcja: 'dodaj-element:0' });
  expect(r.body).toContain('name="s0_liczba" value="2"');
  r = await wyslij({ ...pola, s0_liczba: '2', t0_1: 'tekst', h0_1: 'Drugi', akcja: 'usun-element:0' });
  expect(r.body).toContain('name="s0_liczba" value="1"');
  r = await wyslij({ ...pola, akcja: 'usun:0' });
  expect(r.body).not.toContain('&lt;p&gt;A&lt;/p&gt;');
  expect(zapisany()).toBeNull();
});
it('bez zdjęć wybór zdjęcia jest niedostępny z wyjaśnieniem', async () => {
  const r = await post(opis(tekst('')), 'podglad');
  expect(r.body).toMatch(/value="zdjecie" disabled/);
  expect(r.body).toContain('brak zdjęć karty');
});
it('błędny JSON i nieprawidłowy typ elementu odmawiają bez zapisu', async () => {
  expect((await app.inject({ method: 'POST', url: `/magazyn/${id}/opis`, headers: auth, payload: { opis_sekcje_json: '{' } })).statusCode).toBe(400);
  expect((await post(opis({ typ: 'obcy', html: 'Tekst' }))).statusCode).toBe(400);
  expect(zapisany()).toBeNull();
});
