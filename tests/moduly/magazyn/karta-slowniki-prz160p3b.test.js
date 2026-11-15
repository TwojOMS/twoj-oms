import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';

const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
let db, app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' } }, magazyn: {
    stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
  } });
  for (const [t, n] of [['kategorie_kart', 'Lampy'], ['kategorie_kart', 'Ramki'], ['marki', 'Cienie'], ['marki', 'Pracownia Półcień']]) {
    db.prepare(`INSERT INTO ${t} (nazwa, utworzona_at) VALUES (?, 'x')`).run(n);
  }
});
afterEach(async () => { await app.close(); db.close(); });
const wiersz = id => db.prepare('SELECT kategoria_glowna, marka FROM karty_produktow WHERE id = ?').get(id);
const zrodla = id => db.prepare("SELECT pole, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole IN ('kategoria_glowna', 'marka') ORDER BY pole").all(id);
const post = (id, payload) => app.inject({ method: 'POST', url: `/magazyn/${id}`, headers: auth, payload });
const slownik = t => db.prepare(`SELECT nazwa FROM ${t} ORDER BY nazwa`).all().map(r => r.nazwa);

it('karta pokazuje Kategorię główną i Markę jako wybór ze słownika z polem „dodaj nową”', async () => {
  const id = utworzKarte(db, { nazwa: 'Lampa', kategoria_glowna: 'Spoza słownika', marka: 'Cienie' });
  const podglad = await app.inject({ url: `/magazyn/${id}`, headers: auth });
  expect(podglad.body).toMatch(/<dt>Marka<\/dt>\s*<dd>Cienie/);
  const { statusCode, body } = await app.inject({ url: `/magazyn/${id}?edytuj=dane`, headers: auth });
  expect(statusCode).toBe(200);
  const marka = body.match(/<select name="marka">[\s\S]*?<\/select>/)[0];
  expect(marka).toContain('<option value="Cienie" selected>Cienie</option>');
  expect(marka).toContain('<option value="Pracownia Półcień">');
  const kategoria = body.match(/<select name="kategoria_glowna">[\s\S]*?<\/select>/)[0];
  for (const k of ['Lampy', 'Ramki']) expect(kategoria).toContain(`<option value="${k}">`);
  expect(kategoria).toContain('<option value="Spoza słownika" selected>');
  expect(body).toContain('name="kategoria_glowna_nowa"');
  expect(body).toContain('name="marka_nowa"');
});

it('zapis karty: wybór ze słownika i „dodaj nową” dopisuje do słownika; pola stają się ręczne', async () => {
  const id = utworzKarte(db, { nazwa: 'Lampa' });
  expect((await post(id, { nazwa: 'Lampa', kategoria_glowna: 'Lampy', marka: 'Cienie' })).statusCode).toBe(303);
  expect(wiersz(id)).toEqual({ kategoria_glowna: 'Lampy', marka: 'Cienie' });
  expect(zrodla(id)).toEqual([{ pole: 'kategoria_glowna', reczne: 1 }, { pole: 'marka', reczne: 1 }]);

  expect((await post(id, { nazwa: 'Lampa', kategoria_glowna: 'Lampy', kategoria_glowna_nowa: '  Lampy wiszące ',
    marka: 'Cienie', marka_nowa: 'Nowa Marka' })).statusCode).toBe(303);
  expect(wiersz(id)).toEqual({ kategoria_glowna: 'Lampy wiszące', marka: 'Nowa Marka' });
  expect(slownik('kategorie_kart')).toEqual(['Lampy', 'Lampy wiszące', 'Ramki']);
  expect(slownik('marki')).toEqual(['Cienie', 'Nowa Marka', 'Pracownia Półcień']);

  // Puste „—” czyści markę; formularz bez pola marki jej nie rusza.
  expect((await post(id, { nazwa: 'Lampa', marka: '' })).statusCode).toBe(303);
  expect(wiersz(id).marka).toBe(null);
  expect((await post(id, { nazwa: 'Lampa' })).statusCode).toBe(303);
  expect(wiersz(id)).toEqual({ kategoria_glowna: 'Lampy wiszące', marka: null });
});

it('odmowa zapisu karty nie dopisuje nic do słowników', async () => {
  const id = utworzKarte(db, { nazwa: 'Lampa' });
  const r = await post(id, { nazwa: 'Lampa', ean: 'zly', kategoria_glowna_nowa: 'Nowa kat', marka_nowa: 'Nowa marka' });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain('value="Nowa marka"');
  expect(slownik('kategorie_kart')).toEqual(['Lampy', 'Ramki']);
  expect(slownik('marki')).toEqual(['Cienie', 'Pracownia Półcień']);
  expect(wiersz(id)).toEqual({ kategoria_glowna: null, marka: null });
});
