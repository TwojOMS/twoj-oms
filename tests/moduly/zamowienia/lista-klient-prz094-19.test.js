// PRZ-094.19: kolumna „Klient” na liście zamówień — imię i nazwisko, pod nim nazwa firmy (gdy zamówienie jest
// firmowe) i login kupującego z Allegro (tylko kanały Allegro). Test sprawdza WYRENDEROWANY HTML listy: dane
// składają się z trzech miejsc (blok `klient` zamówienia, rodzaj kanału z definicji, szablon).
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { mapujZamowienieAllegro } from '../../../src/domena/allegro-mapowanie.js';
import { metodaZId } from '../../../src/domena/allegro-dostawa.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const definicje = [
  { klucz: 'sklep_a', typ: 'woo', prefiks: 'SKLEP_A', etykieta: 'Sklep Woo' },
  { klucz: 'konto_b', typ: 'allegro', prefiks: 'KONTO_B', etykieta: 'Konto Allegro' },
];

const zam = (id, klient, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { email: 'j@k.pl', ...klient },
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
// Zawartość komórki „Klient” wiersza o danym numerze.
const klient = (html, numer) => {
  const od = html.indexOf(`>${numer}</a>`);
  expect(od, `brak wiersza ${numer}`).toBeGreaterThan(-1);
  const start = html.indexOf('komorka-klient', od);
  return html.slice(start, html.indexOf('</td>', start));
};

describe('login kupującego z Allegro', () => {
  it('zamówienie z kanału Allegro pokazuje login pod imieniem i nazwiskiem', async () => {
    zapiszZamowienie(db, 'konto_b', zam(8001, { first_name: 'Jan', last_name: 'Kowalski', login: 'lampy_jan77' }), {});
    const k = klient(await lista(), 8001);
    expect(k).toContain('lampy_jan77');
    expect(k.indexOf('Jan Kowalski')).toBeGreaterThan(-1);
    expect(k.indexOf('Jan Kowalski')).toBeLessThan(k.indexOf('lampy_jan77'));
  });
  it('tylko kanał Allegro: zamówienie Woo z polem login w bloku klienta go nie pokazuje', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(8002, { first_name: 'Jan', last_name: 'Kowalski', login: 'lampy_jan77' }), {});
    const k = klient(await lista(), 8002);
    expect(k).not.toContain('lampy_jan77');
    expect(k).not.toContain('klient-login');
  });
  it('Allegro bez loginu (zamówienie sprzed zapisu loginu) — bez pustej linii', async () => {
    zapiszZamowienie(db, 'konto_b', zam(8003, { first_name: 'Jan', last_name: 'Kowalski' }), {});
    expect(klient(await lista(), 8003)).not.toContain('klient-login');
  });
});

describe('nazwa firmy', () => {
  it('zamówienie firmowe: imię i nazwisko, pod nim firma, a dla Allegro na końcu login', async () => {
    zapiszZamowienie(db, 'konto_b', zam(8011, { first_name: 'Anna', last_name: 'Nowak', company: 'Hotel Zaciszny Brzeg sp. z o.o.', login: 'hotel_zaciszny' }), {});
    const k = klient(await lista(), 8011);
    const kolejnosc = ['Anna Nowak', 'Hotel Zaciszny Brzeg sp. z o.o.', 'hotel_zaciszny'].map((t) => k.indexOf(t));
    expect(kolejnosc.every((i) => i > -1), k).toBe(true);
    expect([...kolejnosc].sort((a, b) => a - b)).toEqual(kolejnosc);
  });
  it('pełna nazwa firmy także w title (przycięcie do dwóch linii jest tylko wizualne)', async () => {
    const dluga = 'Przedsiębiorstwo Handlowo-Usługowe Bardzo Długa Nazwa Spółka z ograniczoną odpowiedzialnością w likwidacji';
    zapiszZamowienie(db, 'sklep_a', zam(8012, { first_name: 'Anna', last_name: 'Nowak', company: dluga }), {});
    expect(klient(await lista(), 8012)).toContain(`title="${dluga}"`);
  });
  it('zamówienie bez firmy (Woo) — samo imię i nazwisko, bez dodatkowych linii', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(8013, { first_name: 'Jan', last_name: 'Kowalski', company: '' }), {});
    const k = klient(await lista(), 8013);
    expect(k).toContain('Jan Kowalski');
    expect(k).not.toContain('klient-firma');
    expect(k).not.toContain('klient-login');
  });
  it('sama firma bez osoby — firma w pierwszej linii, bez drugiej', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(8014, { first_name: '', last_name: '', company: 'Studio Wnętrz Pokoik Bis' }), {});
    const k = klient(await lista(), 8014);
    expect(k.match(/Studio Wnętrz Pokoik Bis/g).length).toBe(2); // tekst + title
    expect(k).not.toContain('klient-firma');
  });
  it('firma równa imieniu i nazwisku (jednoosobowa, wpisana tak samo) nie powtarza się', async () => {
    zapiszZamowienie(db, 'sklep_a', zam(8015, { first_name: 'Jan', last_name: 'Kowalski', company: ' jan  KOWALSKI ' }), {});
    expect(klient(await lista(), 8015)).not.toContain('klient-firma');
  });
});

describe('escapowanie', () => {
  it('firma i login z kodem HTML są wypisane jako tekst', async () => {
    zapiszZamowienie(db, 'konto_b', zam(8021, { first_name: 'Jan', last_name: 'Kowalski', company: '<b>Zły</b> "sp." & s.c.', login: '<script>alert(1)</script>' }), {});
    const k = klient(await lista(), 8021);
    expect(k).not.toContain('<script>');
    expect(k).not.toContain('<b>Zły</b>');
    expect(k).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(k).toContain('&lt;b&gt;Zły&lt;/b&gt; &#34;sp.&#34; &amp; s.c.');
  });
});

describe('mapowanie Allegro niesie login kupującego do bloku klienta', () => {
  const surowe = (buyer) => ({
    id: 'abc-1', status: 'READY_FOR_PROCESSING', lineItems: [{ boughtAt: '2026-10-17T10:00:00Z', quantity: 1, price: { amount: '10.00' } }],
    summary: { totalToPay: { amount: '10.00', currency: 'PLN' } }, payment: { type: 'ONLINE' }, delivery: { cost: { amount: '0.00' } },
    buyer: { email: 'x@allegromail.pl', firstName: 'Jan', lastName: 'Kowalski', ...buyer },
  });
  it('login z buyer.login trafia do klient.login, z obciętymi spacjami', () => {
    const adres = { street: 'Polna 1', city: 'Pęki', postCode: '00-650', countryCode: 'PL' };
    expect(mapujZamowienieAllegro(surowe({ login: '  lampy_jan77 ', address: adres }), { metodaZId }).klient.login).toBe('lampy_jan77');
  });
  it('brak loginu u Allegro to null, a anonimizowany adres dalej oddaje cały blok null (login go nie ratuje)', () => {
    const adres = { street: 'Polna 1', city: 'Pęki', postCode: '00-650', countryCode: 'PL' };
    expect(mapujZamowienieAllegro(surowe({ address: adres }), { metodaZId }).klient.login).toBeNull();
    const pusty = { street: null, city: null, postCode: null, countryCode: null };
    expect(mapujZamowienieAllegro(surowe({ login: 'lampy_jan77', firstName: null, lastName: null, address: pusty }), { metodaZId }).klient).toBeNull();
  });
});
