// PRZ-163 (właściciel 14.11: „zrób 5 pozycji”, wzór Apilo): lista zamówień pokazuje pierwsze 5 pozycji, resztę zwija
// pod „Pokaż jeszcze N”. Przy 100 pozycjach wiersz miał ok. 4300 px (pozycja = miniatura 38 px + odstęp).
// Zwinięte pozycje są w `<details>`: zostają w HTML-u, więc „Znajdź na stronie” je odnajduje i rozwija.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const definicje = [{ klucz: 'sklep_a', typ: 'woo', prefiks: 'SKLEP_A', etykieta: 'Sklep Woo' }];

const pozycje = (n) => Array.from({ length: n }, (_, i) => ({
  nazwa: `Produkt numer ${i + 1} koniec`, sku: `P-${i + 1}`, ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00', vat: null,
}));
const zam = (id, n) => ({
  zrodlo_id: id, numer: String(id), klient: { email: 'j@k.pl', first_name: 'Jan', last_name: 'Kowalski' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: `${n * 10}.00`,
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-11-14T08:00:00', pozycje: pozycje(n),
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, definicje }, poller });
  await app.ready();
});

// Komórka „Produkty” zamówienia o danym numerze klienta (jeden wiersz na liście).
async function komorka(n) {
  zapiszZamowienie(db, 'sklep_a', zam(700 + n, n), {});
  const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
  expect(r.statusCode, r.body).toBe(200);
  const m = r.body.match(/<td class="komorka-produkty">([\s\S]*?)<\/td>/);
  expect(m, 'brak komórki Produkty').toBeTruthy();
  return m[1];
}
const nazwy = (html) => [...html.matchAll(/Produkt numer (\d+) koniec/g)].map(m => Number(m[1]));

describe('PRZ-163: zwijanie pozycji na liście zamówień', () => {
  it('5 pozycji — wszystkie widoczne, bez przycisku', async () => {
    const html = await komorka(5);
    expect(nazwy(html)).toEqual([1, 2, 3, 4, 5]);
    expect(html).not.toContain('<details');
  });

  it('6 pozycji — 5 widocznych, szósta w <details> „Pokaż jeszcze 1”', async () => {
    const html = await komorka(6);
    const [przed, zwiniete] = html.split('<details');
    expect(nazwy(przed)).toEqual([1, 2, 3, 4, 5]);
    expect(zwiniete).toMatch(/<summary[^>]*>[\s\S]*Pokaż jeszcze 1[\s\S]*<\/summary>/);
    expect(nazwy(zwiniete)).toEqual([6]);
    expect(zwiniete).not.toMatch(/<details[^>]*\sopen/);
  });

  it('100 pozycji — 5 widocznych, 95 zwiniętych, żadna nie ginie', async () => {
    const html = await komorka(100);
    const [przed, zwiniete] = html.split('<details');
    expect(nazwy(przed)).toHaveLength(5);
    expect(zwiniete).toContain('Pokaż jeszcze 95');
    expect(nazwy(zwiniete)).toEqual(Array.from({ length: 95 }, (_, i) => i + 6));
    expect(html.match(/<details/g)).toHaveLength(1);
  });
});
