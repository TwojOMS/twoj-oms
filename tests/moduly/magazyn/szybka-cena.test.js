// Szybka zmiana ceny karty z listy magazynu: trasa POST /magazyn/:id/cena.
// Ta sama walidacja i ten sam zapis co formularz karty (pole `cena_zl`, źródło ręczne), odpowiedź JSON
// z kwotą w formacie listy i ostrzeżeniem o ofertach zarządzanych przez OMS.
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';

const auth = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost' };
let db, app;

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'x' } },
    magazyn: { stan: () => ({ trwa: false }) },
  });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const zapisz = (id, cena_zl, headers = auth) =>
  app.inject({
    method: 'POST',
    url: `/magazyn/${id}/cena`,
    headers: { ...headers, accept: 'application/json' },
    payload: cena_zl === undefined ? {} : { cena_zl },
  });
const cena = (id) => db.prepare('SELECT cena_gr FROM karty_produktow WHERE id = ?').get(id).cena_gr;
const zrodlo = (id) =>
  db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'cena_gr'").get(id);
const oferta = (karta, nr, tryb) =>
  db
    .prepare(
      `INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan, utworzono_at, zmieniono_at)
      VALUES (?, ?, ?, ?, ?, 'aktywna', 'x', 'x')`,
    )
    .run(karta, `allegro_polcien_${nr}`, `ext-${nr}`, tryb === 'zarzadzana' ? 'oms' : 'przejeta', tryb);

describe('POST /magazyn/:id/cena — zapis', () => {
  it('„69" zapisuje 6900 gr ze źródłem ręcznym i oddaje kwotę w formacie listy', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    const r = await zapisz(id, '69');
    expect(r.statusCode).toBe(200);
    expect(cena(id)).toBe(6900);
    expect(zrodlo(id)).toMatchObject({ zrodlo: 'reczne', reczne: 1 });
    const json = r.json();
    expect(json.cena).toBe('69,00 zł');
    expect(json.cena_gr).toBe(6900);
    expect(json.ostrzezenie ?? null).toBeNull();
  });

  it('„69,5" — przecinek dziesiętny przez wspólny parser karty → 6950 gr', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    const r = await zapisz(id, '69,5');
    expect(r.statusCode).toBe(200);
    expect(cena(id)).toBe(6950);
    expect(r.json().cena).toBe('69,50 zł');
  });

  it('kwota z tysiącami w formacie listy (twarda spacja Intl)', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    const r = await zapisz(id, '12345,67');
    expect(r.json().cena.replace(/\s/g, ' ')).toBe('12 345,67 zł');
  });

  it('1234,50 po zapisie wygląda tak samo jak w komórce listy (odstęp tysięcy także przy 4 cyfrach)', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    const r = await zapisz(id, '1234,5');
    expect(r.statusCode).toBe(200);
    const lista = await app.inject({ method: 'GET', url: '/magazyn', headers: auth });
    const naLiscie = new RegExp(
      `data-adres="/magazyn/${id}/cena"[^>]*>\\s*<span data-szybka-cena-kwota>([^<]*)</span>`,
    ).exec(lista.body)?.[1];
    expect(naLiscie).toBeDefined();
    expect(r.json().cena).toBe(naLiscie);
    expect(r.json().cena.replace(/\s/g, ' ')).toBe('1 234,50 zł');
  });
});

describe('POST /magazyn/:id/cena — odmowy bez zapisu', () => {
  it('„abc" → 400 z komunikatem formularza karty, cena bez zmian', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    const r = await zapisz(id, 'abc');
    expect(r.statusCode).toBe(400);
    expect(r.json().blad).toContain('to nie jest cena');
    // Na liście puste pole nie kasuje ceny, więc rada z karty „zostaw pole puste” byłaby nieprawdą.
    expect(r.json().blad).not.toContain('zostaw pole puste');
    expect(cena(id)).toBe(9900);
    expect(zrodlo(id)).toBeUndefined();
  });

  it('pusty napis (i same spacje, i brak pola) → 400 „Wpisz cenę albo anuluj", cena NIE jest czyszczona', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    for (const pusty of ['', '   ', undefined]) {
      const r = await zapisz(id, pusty);
      expect(r.statusCode).toBe(400);
      expect(r.json().blad).toBe('Wpisz cenę albo anuluj');
    }
    expect(cena(id)).toBe(9900);
  });

  it('zero i kwota ujemna → 400 „Cena musi być większa od zera", cena bez zmian', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    for (const zla of ['0', '0,00', '-5', '-12,50']) {
      const r = await zapisz(id, zla);
      expect(r.statusCode, zla).toBe(400);
      expect(r.json().blad, zla).toBe('Cena musi być większa od zera.');
    }
    expect(cena(id)).toBe(9900);
    expect(zrodlo(id)).toBeUndefined();
  });

  it('nieistniejąca karta → 404', async () => {
    const r = await zapisz(9999, '10');
    expect(r.statusCode).toBe(404);
  });

  it('CSRF: bez Origin i Referer → 403 bez zapisu', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    const r = await zapisz(id, '10', { authorization: auth.authorization });
    expect(r.statusCode).toBe(403);
    expect(cena(id)).toBe(9900);
  });

  it('konto bez prawa do magazynu → 403 bez zapisu', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    zalozKonto(db, { login: 'pakowacz', imie: 'Jan', haslo: 'x', rola: 'produkcja', admin: false });
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { origin: auth.origin },
      payload: { uzytkownik: 'pakowacz', haslo: 'x' },
    });
    expect(login.statusCode).toBe(302);
    const cookie = []
      .concat(login.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const r = await zapisz(id, '10', { origin: auth.origin, cookie });
    expect(r.statusCode).toBe(403);
    expect(cena(id)).toBe(9900);
  });
});

describe('POST /magazyn/:id/cena — ostrzeżenie o ofertach zarządzanych', () => {
  it('karta z 2 ofertami zarządzanymi (i jedną obserwowaną) → „Zmieni cenę w 2 ofertach…"', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień', cena_gr: 9900 });
    oferta(id, 1, 'zarzadzana');
    oferta(id, 2, 'zarzadzana');
    oferta(id, 3, 'obserwowana');
    const inna = utworzKarte(db, { nazwa: 'Kinkiet Półcień' });
    oferta(inna, 4, 'zarzadzana');
    const r = await zapisz(id, '79');
    expect(r.statusCode).toBe(200);
    expect(r.json().ostrzezenie).toBe('Zmieni cenę w 2 ofertach przy najbliższym przebiegu');
  });

  it('jedna oferta zarządzana → „w 1 ofercie"', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    oferta(id, 1, 'zarzadzana');
    expect((await zapisz(id, '79')).json().ostrzezenie).toBe('Zmieni cenę w 1 ofercie przy najbliższym przebiegu');
  });

  it('same oferty obserwowane → bez napisu', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Półcień' });
    oferta(id, 1, 'obserwowana');
    expect((await zapisz(id, '79')).json().ostrzezenie ?? null).toBeNull();
  });
});
