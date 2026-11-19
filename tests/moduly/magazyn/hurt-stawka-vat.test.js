import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { polecenieZFormularza, polaDoPrzeniesienia, zmianyHurtem } from '../../../src/domena/magazyn-hurt.js';
import { STAWKI_VAT } from '../../../src/domena/vat.js';

// STAWKA VAT HURTEM. Bez stawki marży z ceny katalogowej (brutto) nie da się policzyć, a uzupełnianie
// stawki karta po karcie przy setkach kart to godziny klikania.
//
// Czego pilnuje ta suita:
//   - wartość spoza listy stawek panelu (STAWKI_VAT z domena/vat.js) odmawia CAŁEGO zapisu;
//   - puste pole znaczy „nie zmieniaj", nigdy „skasuj stawkę";
//   - podgląd pokazuje „z czego na co" i niczego nie zapisuje;
//   - zapis hurtem oznacza pole jako ręczne (karty_zrodla_pol), tak samo jak zapis z karty —
//     inaczej następny import z kanału nadpisałby stawkę ustawioną przez człowieka.

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
const serwer = () => buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN_PUSTY } });

beforeEach(() => {
  db = openOmsDb(':memory:');
});

const kartaO = (nazwa, reszta = {}) => utworzKarte(db, { nazwa, ...reszta });
const wiersz = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const zrodloStawki = (id) =>
  db.prepare("SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'stawka_vat'").get(id);
const post = (app, url, payload) => app.inject({ method: 'POST', url, headers: auth, payload });
const podglad = (app, payload) => post(app, '/magazyn/hurt', payload);
const zatwierdz = (app, payload) => post(app, '/magazyn/hurt/zatwierdz', payload);

function sekcja(body, id) {
  const trafienie = new RegExp(`<(section|details)[^>]*id="${id}"[\\s\\S]*?</\\1>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie nie ma sekcji „${id}"`);
  return trafienie[0];
}
function wierszZmiany(body, nazwa) {
  const znacznik = `<div class="nazwa-karty">${nazwa}</div>`;
  const w = sekcja(body, 'zmiany-hurtem')
    .split('<tr')
    .find((t) => t.includes(znacznik));
  if (!w) throw new Error(`W podgladzie nie ma karty „${nazwa}"`);
  return w;
}
const nazwyWPodgladzie = (body) =>
  [...sekcja(body, 'zmiany-hurtem').matchAll(/<div class="nazwa-karty">([^<]*)<\/div>/g)].map((m) => m[1]);
function ileNaEkranie(body) {
  const m = /<strong class="hurt-ile">([^<]*)<\/strong>/.exec(body);
  if (!m) throw new Error('Ekran hurtu nie podaje liczby kart (brak znacznika hurt-ile)');
  return m[1];
}
// Komórki „Z" i „Na" jednego wiersza podglądu, bez znaczników.
const komorki = (w) => [...w.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());

const trzyKarty = () => ({
  bez: kartaO('Lampa Kopuła'),
  osiem: kartaO('Lampa Stożek', { stawka_vat: '8' }),
  piec: kartaO('Lampa Walec', { stawka_vat: '5' }),
});
const zaznacz = (...id) => id.map(String);

describe('stawka VAT hurtem — podgląd i zapis', () => {
  it('podgląd: 3 karty, „z czego na co" każdej, baza bez zmian', async () => {
    const { bez, osiem, piec } = trzyKarty();
    const r = await podglad(serwer(), { zaznaczone: zaznacz(bez, osiem, piec), stawka_vat: '23' });

    expect(r.statusCode).toBe(200);
    expect(ileNaEkranie(r.body)).toBe('3');
    expect(komorki(wierszZmiany(r.body, 'Lampa Kopuła')).slice(1)).toEqual(['Stawka VAT', '—', '23%']);
    expect(komorki(wierszZmiany(r.body, 'Lampa Stożek')).slice(1)).toEqual(['Stawka VAT', '8%', '23%']);
    expect(komorki(wierszZmiany(r.body, 'Lampa Walec')).slice(1)).toEqual(['Stawka VAT', '5%', '23%']);

    expect(wiersz(bez).stawka_vat).toBe(null);
    expect(wiersz(osiem).stawka_vat).toBe('8');
    expect(wiersz(piec).stawka_vat).toBe('5');
    expect(zrodloStawki(bez)).toBeUndefined();
  });

  it('podgląd niesie stawkę ukrytym polem do zatwierdzenia', async () => {
    const { bez } = trzyKarty();
    const r = await podglad(serwer(), { zaznaczone: zaznacz(bez), stawka_vat: '23' });
    expect(r.body).toMatch(/<input[^>]*type="hidden"[^>]*name="stawka_vat"[^>]*value="23"/);
  });

  it('zatwierdzenie: 3 karty z „23", każda z polem oznaczonym jako ręczne', async () => {
    const { bez, osiem, piec } = trzyKarty();
    const r = await zatwierdz(serwer(), { zaznaczone: zaznacz(bez, osiem, piec), stawka_vat: '23' });

    expect(r.statusCode).toBe(200);
    for (const id of [bez, osiem, piec]) {
      expect(wiersz(id).stawka_vat).toBe('23');
      expect(zrodloStawki(id)).toEqual({ zrodlo: 'reczne', reczne: 1 });
    }
  });

  it('karta, która już ma 23, nie wchodzi do podglądu ani do liczby', async () => {
    const { bez, osiem } = trzyKarty();
    const ma = kartaO('Lampa Kula', { stawka_vat: '23' });
    const r = await podglad(serwer(), { zaznaczone: zaznacz(bez, osiem, ma), stawka_vat: '23' });

    expect(ileNaEkranie(r.body)).toBe('2');
    expect(nazwyWPodgladzie(r.body)).toEqual(['Lampa Kopuła', 'Lampa Stożek']);
  });

  it('stawka 0 przechodzi — zero to stawka z listy, nie brak', async () => {
    const { osiem } = trzyKarty();
    await zatwierdz(serwer(), { zaznaczone: zaznacz(osiem), stawka_vat: '0' });
    expect(wiersz(osiem).stawka_vat).toBe('0');
  });
});

describe('stawka spoza listy odmawia CAŁEGO zapisu', () => {
  it('„7" → 400, komunikat z „7", żadna karta nie zmieniona', async () => {
    const { bez, osiem, piec } = trzyKarty();
    const r = await zatwierdz(serwer(), { zaznaczone: zaznacz(bez, osiem, piec), stawka_vat: '7' });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('„7” to nie jest stawka VAT z listy');
    expect([bez, osiem, piec].map((id) => wiersz(id).stawka_vat)).toEqual([null, '8', '5']);
  });

  it('poprawna szerokość w tym samym formularzu też NIE wchodzi', async () => {
    const { bez, osiem } = trzyKarty();
    const r = await zatwierdz(serwer(), { zaznaczone: zaznacz(bez, osiem), stawka_vat: '7', szerokosc_cm: '70' });

    expect(r.statusCode).toBe(400);
    expect(wiersz(bez).szerokosc_mm).toBe(null);
    expect(wiersz(osiem).szerokosc_mm).toBe(null);
    expect(wiersz(osiem).stawka_vat).toBe('8');
  });

  it('podgląd też odmawia, zamiast pokazywać zgadnięty zestaw', async () => {
    const { bez } = trzyKarty();
    const r = await podglad(serwer(), { zaznaczone: zaznacz(bez), stawka_vat: '7' });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('class="nazwa-karty"');
  });

  it('„zw" odmawia — hurt karty nie zna zwolnienia, tak jak formularz karty', async () => {
    const { osiem } = trzyKarty();
    const r = await zatwierdz(serwer(), { zaznaczone: zaznacz(osiem), stawka_vat: 'zw' });
    expect(r.statusCode).toBe(400);
    expect(wiersz(osiem).stawka_vat).toBe('8');
  });

  it('pole przysłane dwa razy odmawia', async () => {
    const { osiem } = trzyKarty();
    const r = await zatwierdz(serwer(), { zaznaczone: zaznacz(osiem), stawka_vat: ['23', '5'] });
    expect(r.statusCode).toBe(400);
    expect(wiersz(osiem).stawka_vat).toBe('8');
  });
});

describe('puste pole stawki znaczy „nie zmieniaj"', () => {
  it('puste przy innej zmianie — stawki zostają, inne pole wchodzi', async () => {
    const { bez, osiem, piec } = trzyKarty();
    await zatwierdz(serwer(), { zaznaczone: zaznacz(bez, osiem, piec), stawka_vat: '', kategoria_glowna: 'Lampy' });

    expect([bez, osiem, piec].map((id) => wiersz(id).stawka_vat)).toEqual([null, '8', '5']);
    expect(wiersz(osiem).kategoria_glowna).toBe('Lampy');
    expect(zrodloStawki(osiem)).toBeUndefined();
  });

  it('samo puste pole stawki to brak decyzji — odmowa, nic nie zapisane', async () => {
    const { osiem } = trzyKarty();
    const r = await zatwierdz(serwer(), { zaznaczone: zaznacz(osiem), stawka_vat: '' });
    expect(r.statusCode).toBe(400);
    expect(wiersz(osiem).stawka_vat).toBe('8');
  });
});

describe('reguły czyste — stawka VAT', () => {
  it('każda stawka z listy panelu daje polecenie', () => {
    for (const s of STAWKI_VAT) {
      expect(polecenieZFormularza({ stawka_vat: s })).toEqual({ polecenie: { stawka_vat: s }, blad: null });
    }
  });

  it('spacje wokół stawki obcinane', () => {
    expect(polecenieZFormularza({ stawka_vat: ' 23 ' }).polecenie).toEqual({ stawka_vat: '23' });
  });

  it('zapisy spoza listy („08", „23%", „8.0", „zw") odmawiają', () => {
    for (const s of ['08', '23%', '8.0', 'zw', '7']) {
      const { polecenie, blad } = polecenieZFormularza({ stawka_vat: s });
      expect(polecenie).toBe(null);
      expect(blad).toContain(s);
    }
  });

  it('puste i nieprzysłane nie dają klucza stawki', () => {
    expect(polecenieZFormularza({ stawka_vat: '  ' }).polecenie).toEqual({});
    expect(polecenieZFormularza({}).polecenie).toEqual({});
  });

  it('polaDoPrzeniesienia przenosi stawkę', () => {
    expect(polaDoPrzeniesienia({ stawka_vat: '8' })).toEqual([{ name: 'stawka_vat', value: '8' }]);
  });

  it('zmianyHurtem: opis „Stawka VAT" z procentem, karta z tą samą stawką pominięta', () => {
    const plan = zmianyHurtem(
      [
        { id: 1, nazwa: 'A', stawka_vat: null },
        { id: 2, nazwa: 'B', stawka_vat: '8' },
        { id: 3, nazwa: 'C', stawka_vat: '23' },
      ],
      { stawka_vat: '23' },
    );
    expect(plan).toEqual([
      { id: 1, nazwa: 'A', zmiany: { stawka_vat: '23' }, opisy: [{ pole: 'Stawka VAT', z: null, na: '23%' }] },
      { id: 2, nazwa: 'B', zmiany: { stawka_vat: '23' }, opisy: [{ pole: 'Stawka VAT', z: '8%', na: '23%' }] },
    ]);
  });
});
