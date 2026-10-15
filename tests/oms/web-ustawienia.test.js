import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';
import { wczytajUstawienia } from '../../src/oms/db/ustawienia.js';
import { DOSTAWY } from '../../src/domena/nowe-zamowienie.js';

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
// Trasy POST przechodzą przez ochronę CSRF — bez `origin` zgodnego z hostem panel odmawia.
const naglowekPost = { ...naglowek, origin: 'http://localhost' };

let db;
let app;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config });
  await app.ready();
});

const get = () => app.inject({ method: 'GET', url: '/ustawienia/zamowienia-i-wysylka', headers: naglowek });
const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowekPost, payload });

// ⚠️ WYCINAMY SEKCJĘ, nie całe ciało odpowiedzi — arkusz stylów jedzie w <style> układu
// i zawiera nazwy wszystkich klas, więc `body).toContain('ust-paczka')` przeszłoby także
// na stronie, która tej sekcji w ogóle nie ma.
const sekcja = (body, id) => {
  const i = body.indexOf(`id="${id}"`);
  return i < 0 ? null : body.slice(i, body.indexOf('</form>', i));
};

describe('ekran ustawień — domyślna paczka', () => {
  it('pokazuje dzisiejsze wartości panelu na bazie bez ani jednego ustawienia', async () => {
    const s = sekcja((await get()).body, 'ust-paczka');

    expect(s, 'brak sekcji domyślnej paczki').not.toBeNull();
    expect(s).toContain('name="waga" value="1"');
    expect(s).toContain('name="dlugosc" value="110"');
    expect(s).toContain('name="szerokosc" value="75"');
    expect(s).toContain('name="wysokosc" value="1"');
  });

  it('zapisuje nowe wymiary i pokazuje je po przekierowaniu', async () => {
    const r = await post('/ustawienia/paczka', { waga: '2,5', dlugosc: '100', szerokosc: '70', wysokosc: '5' });

    expect(r.statusCode).toBe(302);
    expect(wczytajUstawienia(db)).toMatchObject({
      'paczka.waga': '2.5', 'paczka.dlugosc': '100', 'paczka.szerokosc': '70', 'paczka.wysokosc': '5',
    });
    expect(sekcja((await get()).body, 'ust-paczka')).toContain('name="waga" value="2.5"');
  });

  // ⚠️ ODMOWA NIE KASUJE FORMULARZA. Człowiek ma zobaczyć, co wpisał, i co jest z tym nie tak —
  // czysty formularz po odmowie znaczy przepisywanie wszystkiego od nowa.
  it('odmowa zostawia wpisane wartości na ekranie i nazywa złe pole', async () => {
    const r = await post('/ustawienia/paczka', { waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' });

    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('waga');
    const formularz = sekcja(r.body, 'ust-paczka');
    expect(formularz).toContain('name="waga" value="0"');
    expect(formularz).toContain('name="dlugosc" value="100"');
    expect(formularz).toContain('name="szerokosc" value="70"');
    expect(formularz).toContain('name="wysokosc" value="5"');
  });

  it('odmowa niczego nie zapisuje — także poprawnych pól', async () => {
    await post('/ustawienia/paczka', { waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' });

    expect(wczytajUstawienia(db)).toEqual({});
  });
});

describe('ekran ustawień — koszty dostawy', () => {
  it('pokazuje 19,00 dla każdej metody na bazie bez ustawień', async () => {
    const s = sekcja((await get()).body, 'ust-dostawa');

    expect(s, 'brak sekcji kosztów dostawy').not.toBeNull();
    expect(s).toContain('name="dpd" value="19,00"');
    expect(s).toContain('name="inpost_paczkomat" value="19,00"');
    expect(s).toContain('name="odbior_osobisty" value="19,00"');
  });

  it('nazywa metody tak samo, jak ekran zakładania zamówienia', async () => {
    const s = sekcja((await get()).body, 'ust-dostawa');

    expect(s).toContain('DPD — kurier');
    expect(s).toContain('InPost Paczkomat');
    expect(s).toContain('Odbiór osobisty');
  });

  it('zapisuje kwoty w groszach', async () => {
    const r = await post('/ustawienia/dostawa', { dpd: '19,00', inpost_paczkomat: '13', odbior_osobisty: '0' });

    expect(r.statusCode).toBe(302);
    expect(wczytajUstawienia(db)).toMatchObject({
      'dostawa.dpd': '1900', 'dostawa.inpost_paczkomat': '1300', 'dostawa.odbior_osobisty': '0',
    });
  });

  it('po zapisie pokazuje kwoty z przecinkiem', async () => {
    await post('/ustawienia/dostawa', { dpd: '19,00', inpost_paczkomat: '13', odbior_osobisty: '0' });

    const s = sekcja((await get()).body, 'ust-dostawa');
    expect(s).toContain('name="inpost_paczkomat" value="13,00"');
    expect(s).toContain('name="odbior_osobisty" value="0,00"');
  });

  it('odmowa zostawia wpisane kwoty i nie zapisuje niczego', async () => {
    const klucze = Object.keys(DOSTAWY);
    const wpisane = Object.fromEntries(klucze.map((klucz, indeks) => [klucz, indeks === 0 ? '' : `${indeks}3,7${indeks}`]));
    const r = await post('/ustawienia/dostawa', wpisane);

    expect(r.statusCode).toBe(400);
    const formularz = sekcja(r.body, 'ust-dostawa');
    for (const klucz of klucze) {
      expect(formularz).toContain(`name="${klucz}" value="${wpisane[klucz]}"`);
    }
    expect(wczytajUstawienia(db)).toEqual({});
  });
});

describe('ekran ustawień — reszta strony', () => {
  // Sekcje dołożone 17.08 nie mogą zjeść tego, co było.
  it('dalej ma przełącznik motywu i sekcję dostępu', async () => {
    const body = (await get()).body;

    expect(body).toContain('action="/motyw"');
    expect(body).not.toContain('wyloguj-wszystkie');
  });

  // ⚠️ NIEZMIENNIK 4.10 — ta strona wypisuje CAŁĄ tabelę ustawień, więc musi być pewne,
  // że nie ma w niej poświadczeń. Test pilnuje, żeby nikt nie dołożył ich tu „na chwilę".
  it('nie pokazuje żadnego poświadczenia', async () => {
    const body = (await get()).body;

    expect(body).not.toContain('client_secret');
    expect(body).not.toContain('access_token');
    expect(body.toLowerCase()).not.toContain('hasło dpd');
  });
});
