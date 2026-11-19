import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { dodajProducenta, przypiszMarki, ustawDomyslnego } from '../../../src/oms/db/producenci.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Formularz „Nowy produkt” pokazuje producenta wynikającego z marki — tylko do odczytu. Stan bez
// JavaScriptu (pierwszy ekran i powrót po błędzie walidacji) liczy serwer; mapa marka → producent
// i producent domyślny jadą w atrybucie dla skryptu, który odświeża pole po wyborze marki.

let db, app, katalog;
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const AT = '2026-11-19T08:00:00.000Z';

beforeEach(async () => {
  katalog = await mkdtemp(join(tmpdir(), 'nowa-karta-producent-'));
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    env: { OMS_KATALOG_ZDJEC: katalog },
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: {
      stan: () => ({ trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null }),
    },
  });
  for (const nazwa of ['Lampa Półcień', 'Świeca Cienista'])
    db.prepare('INSERT INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(nazwa, AT);
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(katalog, { recursive: true, force: true });
});

const producent = (nazwa) =>
  dodajProducenta(
    db,
    { nazwa, ulica: 'ul. Zmyślona 1', kod: '00-001', miasto: 'Przykładowo', kraj: 'PL', email: 'kontakt@example.com' },
    { at: AT },
  ).id;
function slownik({ domyslny = true } = {}) {
  const pracownia = producent('Pracownia Półcień');
  przypiszMarki(db, [{ marka: 'Lampa Półcień', producentId: pracownia }], { at: AT });
  if (domyslny) ustawDomyslnego(db, producent('Zakład Przykładowy'), { at: AT });
}

// Bez nazwy formularz wraca z błędem walidacji i wpisaną marką — to droga „bez JS” dla każdego stanu.
const zBledem = (pola) =>
  app.inject({ method: 'POST', url: '/magazyn/nowa-karta', headers: auth, payload: { nazwa: '', ...pola } });
const pole = (html) => {
  const m = html.match(/<output id="nowa-producent"[^>]*>([\s\S]*?)<\/output>/);
  expect(m, 'pole producenta na formularzu').not.toBeNull();
  return m[1].replace(/\s+/g, ' ').trim();
};
const daneSkryptu = (html) => {
  const m = html.match(/<output id="nowa-producent"[^>]*data-producenci="([^"]*)"/);
  return JSON.parse(
    m[1]
      .replace(/&#34;|&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
};

describe('nowa karta — producent z marki', () => {
  it('pierwszy ekran bez marki podpowiada wybór marki, a skrypt dostaje mapę i producenta domyślnego', async () => {
    slownik();
    const r = await app.inject({ url: '/magazyn/nowa-karta', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<output id="nowa-producent"[^>]*aria-live="polite"/);
    expect(pole(r.body)).toBe('Wybierz markę — producent wynika z marki.');
    expect(daneSkryptu(r.body)).toEqual({
      marki: { 'Lampa Półcień': 'Pracownia Półcień' },
      domyslny: 'Zakład Przykładowy',
    });
    expect(r.body).toMatch(/<script type="module" src="\/public\/nowa-karta-producent\.js\?v=/);
  });

  it('marka z przypisanym producentem → producent z marki', async () => {
    slownik();
    const r = await zBledem({ marka: 'Lampa Półcień' });
    expect(r.statusCode).toBe(400);
    expect(pole(r.body)).toBe('Producent: Pracownia Półcień (z marki Lampa Półcień)');
  });

  it('marka bez przypisania, gdy jest producent domyślny → producent domyślny', async () => {
    slownik();
    const r = await zBledem({ marka: 'Świeca Cienista' });
    expect(pole(r.body)).toBe('Producent: Zakład Przykładowy (producent domyślny)');
  });

  it('marka bez przypisania i bez domyślnego → komunikat z linkiem do producentów w nowej karcie', async () => {
    slownik({ domyslny: false });
    const r = await zBledem({ marka: 'Świeca Cienista' });
    expect(pole(r.body)).toBe(
      'Marka bez producenta — <a href="/magazyn/producenci" target="_blank" rel="noopener">przypisz w Magazyn → Producenci</a>',
    );
    expect(daneSkryptu(r.body).domyslny).toBeNull();
  });

  it('nowa marka wpisana w „albo dodaj nową” wygrywa z wyborem i dostaje producenta domyślnego', async () => {
    slownik();
    const r = await zBledem({ marka: 'Lampa Półcień', marka_nowa: '  Mgła Poranna ' });
    expect(pole(r.body)).toBe('Producent: Zakład Przykładowy (producent domyślny)');
  });

  it('nowa marka bez producenta domyślnego → komunikat o braku', async () => {
    slownik({ domyslny: false });
    const r = await zBledem({ marka_nowa: 'Mgła Poranna' });
    expect(pole(r.body)).toContain('Marka bez producenta');
  });

  it('nazwy w polu i w danych skryptu są escapowane', async () => {
    db.prepare('INSERT INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run('<b>Ostra</b>', AT);
    const id = producent('Zakład "Cudzysłów" & <i>Syn</i>');
    przypiszMarki(db, [{ marka: '<b>Ostra</b>', producentId: id }], { at: AT });
    const r = await zBledem({ marka: '<b>Ostra</b>' });
    expect(r.body).not.toContain('<i>Syn</i>');
    expect(r.body).not.toContain('<b>Ostra</b>)');
    expect(daneSkryptu(r.body).marki).toEqual({ '<b>Ostra</b>': 'Zakład "Cudzysłów" & <i>Syn</i>' });
  });

  it('utworzenie karty nie zapisuje producenta ani nie tworzy przypisania marki', async () => {
    slownik();
    const przed = db.prepare('SELECT marka, producent_id FROM marki_producenci ORDER BY marka').all();
    const r = await app.inject({
      method: 'POST',
      url: '/magazyn/nowa-karta',
      headers: auth,
      payload: {
        nazwa: 'Lampa stołowa',
        marka_nowa: 'Mgła Poranna',
        producent: 'Zakład Przykładowy',
        producent_id: '1',
      },
    });
    expect(r.statusCode).toBe(303);
    expect(db.prepare('SELECT marka, producent_id FROM marki_producenci ORDER BY marka').all()).toEqual(przed);
    const kolumny = db
      .prepare('PRAGMA table_info(karty_produktow)')
      .all()
      .map((k) => k.name);
    expect(kolumny.filter((k) => k.includes('producent'))).toEqual([]);
    expect(db.prepare('SELECT nazwa, marka FROM karty_produktow').get()).toEqual({
      nazwa: 'Lampa stołowa',
      marka: 'Mgła Poranna',
    });
  });
});
