import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// Kolumna „Cena” w widoku „Produkty”: komórka z atrybutami, których szuka public/szybka-cena.js, i ołówek
// prowadzący bez skryptu do edycji karty. Konto bez prawa do adresu zapisu ceny widzi samą kwotę.

const config = { auth: { user: 'operator', pass: 'atrapa' } };
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` };

// `mozeAdres` w widokach to `maDostepDoAdresu`; strażnik tras pyta osobno, więc lista nadal się otwiera.
const odmowa = vi.hoisted(() => ({ wzorzec: null }));
vi.mock('../../../src/domena/ekrany.js', async (oryginal) => {
  const m = await oryginal();
  return {
    ...m,
    maDostepDoAdresu: (konto, url) =>
      !(odmowa.wzorzec && odmowa.wzorzec.test(String(url).split('?')[0])) && m.maDostepDoAdresu(konto, url),
  };
});

let db;
let app;
beforeEach(() => {
  db = openOmsDb(':memory:');
  odmowa.wzorzec = null;
  app = buildOmsServer({ db, config, magazyn: { stan: () => ({ trwa: false, kanaly: [] }) } });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const lista = async (url = '/magazyn') => {
  const r = await app.inject({ method: 'GET', url, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
};
const komorkaCeny = (html, id) =>
  new RegExp(`<td\\b[^>]*data-adres="/magazyn/${id}/cena"[^>]*>[\\s\\S]*?</td>`).exec(html)?.[0] ?? null;
const SKRYPT = /<script type="module" src="\/[^"]*szybka-cena[^"]*\.js[^"]*"><\/script>/g;

describe('lista magazynu — szybka zmiana ceny', () => {
  it('komórka ceny ma adres zapisu, wartość do pola, kwotę i ołówek do edycji karty', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa „Półcień”', cena_gr: 123450 });
    const html = await lista();
    const td = komorkaCeny(html, id);
    expect(td).not.toBeNull();
    expect(td).toMatch(/^<td class="liczba" data-szybka-cena /);
    expect(td).toContain('data-wartosc="1234,50"');
    expect(td).toMatch(/<span data-szybka-cena-kwota>1\s234,50 zł<\/span>/);
    const olowek = /<a href="([^"]+)" data-szybka-cena-olowek aria-label="([^"]+)">✎<\/a>/.exec(td);
    expect(olowek).not.toBeNull();
    const adres = olowek[1].replaceAll('&amp;', '&');
    expect(adres).toMatch(new RegExp(`^/magazyn/${id}\\?edytuj=dane&wroc=[^#]+#dane-karty$`));
    // Powrót z karty tam, skąd człowiek przyszedł — ten sam `wroc`, co odnośnik nazwy karty.
    const wrocNazwy = new RegExp(`<div><a href="/magazyn/${id}\\?wroc=([^"]+)">`).exec(html)[1];
    expect(adres).toContain(`wroc=${wrocNazwy}#`);
    expect(olowek[2]).toBe('Zmień cenę: Lampa „Półcień”');
  });

  it('karta bez ceny: pusta wartość, kreska i ołówek', async () => {
    const id = utworzKarte(db, { nazwa: 'Bez ceny' });
    const td = komorkaCeny(await lista(), id);
    expect(td).toContain('data-wartosc=""');
    expect(td).toMatch(/<span data-szybka-cena-kwota><span class="magazyn-brak">—<\/span><\/span>/);
    expect(td).toContain('data-szybka-cena-olowek');
  });

  it('skrypt dołączony raz na stronę, niezależnie od liczby wierszy', async () => {
    for (const nazwa of ['A', 'B', 'C']) utworzKarte(db, { nazwa, cena_gr: 100 });
    expect((await lista()).match(SKRYPT)).toHaveLength(1);
  });

  it('bez prawa do zapisu ceny: sama kwota, bez ołówka, atrybutów i skryptu', async () => {
    const id = utworzKarte(db, { nazwa: 'Tylko odczyt', cena_gr: 9900 });
    odmowa.wzorzec = /^\/magazyn\/\d+\/cena$/;
    const html = await lista();
    expect(html).not.toContain('data-szybka-cena');
    expect(html).not.toMatch(SKRYPT);
    expect(html).toMatch(/<td class="liczba">99,00 zł<\/td>/);
    expect(komorkaCeny(html, id)).toBeNull();
  });

  it('widok „Ceny w kanałach” bez szybkiej edycji', async () => {
    utworzKarte(db, { nazwa: 'Katalog', cena_gr: 9900 });
    const html = await lista('/magazyn?widok=katalog');
    expect(html).not.toContain('data-szybka-cena');
    expect(html).not.toMatch(SKRYPT);
  });
});
