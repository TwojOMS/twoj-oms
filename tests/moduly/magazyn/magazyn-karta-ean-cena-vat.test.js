// PRZ-153.E5.3c — karta produktu w MAGAZYNIE: EAN, cena katalogowa (zł → grosze) i stawka VAT.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte, zapiszKarte } from '../../../src/oms/db/magazyn.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const STAN = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });
const serwer = () => buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN } });
const post = (url, payload) => serwer().inject({ method: 'POST', url, headers: auth, payload });
const get = (url) => serwer().inject({ method: 'GET', url, headers: auth });
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);

describe('db/magazyn — nowe pola karty na białej liście', () => {
  it('utworzKarte i zapiszKarte przyjmują cena_gr, stawka_vat, ean i wycofana', () => {
    const id = utworzKarte(db, { nazwa: 'Świecznik Półcień', cena_gr: 4990, stawka_vat: '23', ean: '5901234123457' });
    expect(wiersz(id)).toMatchObject({ cena_gr: 4990, stawka_vat: '23', ean: '5901234123457', wycofana: 0 });
    zapiszKarte(db, id, { wycofana: 1, cena_gr: null });
    expect(wiersz(id)).toMatchObject({ wycofana: 1, cena_gr: null });
  });
});

describe('karta produktu — EAN, cena katalogowa, stawka VAT', () => {
  it('zapis z formularza: cena „12,34" → 1234 gr, EAN i stawka trafiają do bazy', async () => {
    const id = utworzKarte(db, { nazwa: 'Świecznik Półcień' });
    const r = await post(`/magazyn/${id}`, {
      nazwa: 'Świecznik Półcień', ean: ' 5901234123457 ', cena_zl: '12,34', stawka_vat: '8',
    });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ ean: '5901234123457', cena_gr: 1234, stawka_vat: '8' });
  });

  it('cena z kropką i bez groszy też przelicza się na grosze', async () => {
    const id = utworzKarte(db, { nazwa: 'Świecznik Półcień' });
    expect((await post(`/magazyn/${id}`, { nazwa: 'Świecznik Półcień', cena_zl: '89' })).statusCode).toBe(303);
    expect(wiersz(id).cena_gr).toBe(8900);
    expect((await post(`/magazyn/${id}`, { nazwa: 'Świecznik Półcień', cena_zl: '74.9' })).statusCode).toBe(303);
    expect(wiersz(id).cena_gr).toBe(7490);
  });

  it('puste pola kasują cenę, EAN i stawkę (null, nie pusty napis)', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', cena_gr: 4990, stawka_vat: '23', ean: '96385074' });
    const r = await post(`/magazyn/${id}`, { nazwa: 'Kinkiet', cena_zl: '', ean: '', stawka_vat: '' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ cena_gr: null, ean: null, stawka_vat: null });
  });

  it('zły EAN wstrzymuje cały zapis i mówi, czego nie zapisano', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', ean: '96385074' });
    const r = await post(`/magazyn/${id}`, { nazwa: 'Inna nazwa', ean: '5901234123458', cena_zl: '10' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('5901234123458');
    expect(wiersz(id)).toMatchObject({ nazwa: 'Kinkiet', ean: '96385074', cena_gr: null });
  });

  it('cena, której nie rozumiemy (ujemna, z walutą), wstrzymuje cały zapis', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', cena_gr: 4990 });
    for (const zla of ['-5', '12 zł', '1,2,3', 'abc']) {
      const r = await post(`/magazyn/${id}`, { nazwa: 'Inna nazwa', cena_zl: zla });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('to nie jest cena');
    }
    expect(wiersz(id)).toMatchObject({ nazwa: 'Kinkiet', cena_gr: 4990 });
  });

  it('stawka spoza listy jest odrzucona, a „zw" nie jest stawką karty', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', stawka_vat: '23' });
    for (const zla of ['7', 'zw', '08', '23%']) {
      const r = await post(`/magazyn/${id}`, { nazwa: 'Inna nazwa', stawka_vat: zla });
      expect(r.statusCode).toBe(400);
    }
    expect(wiersz(id)).toMatchObject({ nazwa: 'Kinkiet', stawka_vat: '23' });
  });

  it('surowe kolumny cena_gr i wycofana nie wchodzą z formularza tylnymi drzwiami', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet' });
    const r = await post(`/magazyn/${id}`, { nazwa: 'Kinkiet', cena_gr: '9999', wycofana: '1' });
    expect(r.statusCode).toBe(303);
    expect(wiersz(id)).toMatchObject({ cena_gr: null, wycofana: 0 });
  });

  it('karta pokazuje EAN, cenę po polsku i stawkę; formularz ma te wartości', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet', cena_gr: 1234, stawka_vat: '5', ean: '5901234123457' });
    const html = (await get(`/magazyn/${id}`)).body;
    expect(html).toContain('5901234123457');
    expect(html).toContain('12,34 zł');
    expect(html).toContain('5%');

    const edycja = (await get(`/magazyn/${id}?edytuj=dane`)).body;
    const pole = (n) => new RegExp(`<input[^>]*name="${n}"[^>]*>`).exec(edycja)?.[0] ?? '';
    expect(pole('ean')).toContain('value="5901234123457"');
    expect(pole('cena_zl')).toContain('value="12.34"');
    const wybor = /<select name="stawka_vat">[\s\S]*?<\/select>/.exec(edycja)?.[0] ?? '';
    expect(wybor).toMatch(/<option value="5" selected>/);
    for (const s of ['23', '8', '0']) expect(wybor).toContain(`<option value="${s}"`);
    expect(wybor).not.toContain('value="zw"');
  });

  it('karta bez nowych pól pokazuje kreski, a nie „null"', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet' });
    const html = (await get(`/magazyn/${id}`)).body;
    expect(html).toContain('<dt>EAN</dt>');
    expect(html).toContain('<dt>Cena katalogowa</dt>');
    expect(html).toContain('<dt>Stawka VAT</dt>');
    expect(html).not.toContain('null');
  });

  it('po odmowie formularz zostawia to, co człowiek wpisał', async () => {
    const id = utworzKarte(db, { nazwa: 'Kinkiet' });
    const r = await post(`/magazyn/${id}?edytuj=dane`, { nazwa: 'Kinkiet', ean: '123', cena_zl: '15,50' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/name="cena_zl"[^>]*value="15,50"|value="15,50"[^>]*name="cena_zl"/);
  });
});
