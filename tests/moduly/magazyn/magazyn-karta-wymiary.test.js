// PRZ-090 — karta produktu: głębokość (cm) i waga (kg) obok szerokości i wysokości.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const STAN = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });
const serwer = () => buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN } });
const post = (url, payload) => serwer().inject({ method: 'POST', url, headers: auth, payload });
const get = (url) => serwer().inject({ method: 'GET', url, headers: auth });
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

describe('karta produktu — głębokość i waga', () => {
  it('zapis głębokości w cm i wagi w kg ląduje w mm i gramach', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa stołowa Grzybek', szerokosc_mm: 300, wysokosc_mm: 450 });
    const r = await post(`/magazyn/${id}`, { nazwa: 'Lampa stołowa Grzybek', glebokosc_cm: '12,5', waga_kg: '1,8' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ glebokosc_mm: 125, waga_g: 1800, szerokosc_mm: 300, wysokosc_mm: 450 });
  });

  it('puste pola kasują głębokość i wagę, a sama głębokość nie wymaga pary', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', glebokosc_mm: 90, waga_g: 700 });
    expect((await post(`/magazyn/${id}`, { nazwa: 'Kinkiet', glebokosc_cm: '', waga_kg: '' })).statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ glebokosc_mm: null, waga_g: null });
    expect((await post(`/magazyn/${id}`, { nazwa: 'Kinkiet', glebokosc_cm: '9' })).statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ glebokosc_mm: 90, szerokosc_mm: null, wysokosc_mm: null });
  });

  it('napis, którego nie rozumiemy, wstrzymuje cały zapis', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', waga_g: 700 });
    const r = await post(`/magazyn/${id}`, { nazwa: 'Inna nazwa', waga_kg: '0,7 kg' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('0,7 kg');
    expect(wiersz(id)).toMatchObject({ nazwa: 'Kinkiet', waga_g: 700 });
  });

  it('formularz edycji pokazuje oba pola z wartościami w cm i kg', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', glebokosc_mm: 125, waga_g: 1800 });
    const html = (await get(`/magazyn/${id}?edytuj=dane`)).body;
    const pole = (n) => new RegExp(`<input[^>]*name="${n}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(pole('glebokosc_cm')).toContain('value="12.5"');
    expect(pole('waga_kg')).toContain('value="1.8"');
  });
});
