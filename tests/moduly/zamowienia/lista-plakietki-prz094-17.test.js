// PRZ-094.17: plakietki marek na liście zamówień — przewoźnik w kolumnie „Dostawa” (tło w kolorze marki) i rodzaj
// kanału (Allegro „a”, WooCommerce „W”) przy nazwie sklepu. Test sprawdza WYRENDEROWANY HTML listy, bo to on
// składa dwie rzeczy z trzech miejsc: rozpoznanie (domena), kontekst trasy i szablon.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
// Etykieta kanału Woo brzmi „Allegro Sklep” celowo: rodzaj ma iść z `typ`, nie z nazwy wpisanej przez firmę.
const definicje = [
  { klucz: 'sklep_a', typ: 'woo', prefiks: 'SKLEP_A', etykieta: 'Allegro Sklep' },
  { klucz: 'konto_b', typ: 'allegro', prefiks: 'KONTO_B', etykieta: 'Pracownia Półcień' },
];

const zam = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-17T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'S-1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, definicje }, poller });
  await app.ready();
});

const lista = async () => {
  const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
  expect(r.statusCode, r.body).toBe(200);
  return r.body;
};
// Fragment wiersza zamówienia o danym numerze (do następnego `<tr`).
const wiersz = (html, numer) => {
  const od = html.indexOf(`>${numer}</a>`);
  expect(od, `brak wiersza ${numer}`).toBeGreaterThan(-1);
  const poczatek = html.lastIndexOf('<tr', od);
  const koniec = html.indexOf('</tr>', od);
  return html.slice(poczatek, koniec);
};

describe('plakietka rodzaju kanału', () => {
  it('Woo i Allegro po typie definicji, z title i aria-label; nazwa sklepu zostaje obok', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(7001), {});
    zapiszZamowienie(db, 'konto_b', zam(7002, { metoda_wysylki: 'allegro_paczkomat' }), {});
    const html = await lista();
    const woo = wiersz(html, 7001);
    expect(woo).toContain('plakietka plakietka--kanal plakietka--woo" role="img" aria-label="WooCommerce" title="WooCommerce">W</span>Allegro Sklep');
    expect(woo).not.toContain('plakietka--allegro');
    const allegro = wiersz(html, 7002);
    expect(allegro).toContain('plakietka plakietka--kanal plakietka--allegro" role="img" aria-label="Allegro" title="Allegro">a</span>Pracownia Półcień');
  });
  it('kanał ręczny — bez plakietki kanału', async () => {
    zapiszZamowienie(db, 'reczne', zam(7003), {});
    expect(wiersz(await lista(), 7003)).not.toContain('plakietka--kanal');
  });
});

describe('plakietka przewoźnika w kolumnie „Dostawa”', () => {
  const dostawa = (w) => w.slice(w.indexOf('komorka-dostawa'), w.indexOf('komorka-kwota'));
  it('klasa marki z rozpoznania w domenie; pełna nazwa i dopisek „(pobranie)” zostają w tekście', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(7011, { metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '100.00' }), {});
    zapiszZamowienie(db, 'sklep_a', zam(7012, { metoda_wysylki: 'inpost_paczkomat' }), {});
    zapiszZamowienie(db, 'konto_b', zam(7013, { metoda_wysylki: 'allegro_kurier' }), {});
    const html = await lista();
    expect(dostawa(wiersz(html, 7011))).toMatch(/plakietka plakietka--dpd"[\s\S]*Kurier DPD \(pobranie\)/);
    expect(dostawa(wiersz(html, 7012))).toMatch(/plakietka plakietka--inpost"[\s\S]*InPost Paczkomat/);
    expect(dostawa(wiersz(html, 7013))).toContain('plakietka--allegro-one');
  });
  it('odbiór osobisty i punkt Allegro (przewoźnik nieustalony) — bez plakietki', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(7021, { metoda_wysylki: 'odbior_osobisty' }), {});
    zapiszZamowienie(db, 'konto_b', zam(7022, { metoda_wysylki: 'allegro_punkt' }), {});
    const html = await lista();
    expect(dostawa(wiersz(html, 7021))).not.toContain('plakietka');
    expect(dostawa(wiersz(html, 7022))).not.toContain('plakietka');
  });
});
