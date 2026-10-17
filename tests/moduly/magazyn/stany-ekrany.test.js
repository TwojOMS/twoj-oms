// PRZ-091 — ekrany stanów magazynowych w zakładce Magazyn: lista, karta, ruch ręczny, import, pozycje bez karty.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { przelaczStany, stanKarty } from '../../../src/oms/db/stany-magazynowe.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const STAN = { trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null };

let db;
let karta;
beforeEach(() => {
  db = openOmsDb(':memory:');
  karta = utworzKarte(db, { nazwa: 'Lampa stołowa Grzybek', sku: 'LMP-GRZ-30' });
  powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: 'allegro_a', produkt_id: '9000000001', wariant_id: '',
    nazwa: 'Grzybek', odczytane_at: '2026-10-17T06:00:00.000Z' }), karta);
});
const serwer = () => buildOmsServer({ db, config, magazyn: { start: vi.fn(), stan: () => STAN } });
const get = (url) => serwer().inject({ method: 'GET', url, headers: auth });
const post = (url, payload) => serwer().inject({ method: 'POST', url, headers: auth, payload });
const wlacz = () => przelaczStany(db, { wlacz: true, konto: { id: 1, login: 'adam' }, at: '2026-10-17T08:00:00.000Z' });
const naglowekTabeli = (html) => /<table class="tresc-lista magazyn-tabela">[\s\S]*?<\/thead>/u.exec(html)?.[0] ?? '';
const sekcjaStanu = (html) => /<section class="panel" id="stan-karty">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';
const kluczFormularza = (html) => /name="klucz" value="([0-9a-f]+)"/u.exec(sekcjaStanu(html))?.[1];
const zamowienieAllegro = (ilosc, at = '2026-10-17T09:00:00.000Z') => zapiszZamowienie(db, 'allegro_a', {
  zrodlo_id: `z-${ilosc}-${at}`, numer: `A-${ilosc}`, klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '50.00', status_woo: null,
  oplacone_at: null, anulowane: 0, utworzone_at: at,
  pozycje: [{ nazwa: 'Grzybek', sku: null, ilosc, cena_brutto: '50.00', vat: '23', zdjecie_url: null, zrodlo_id: 1,
    produkt_id: null, oferta_id: '9000000001' }],
}, {});

describe('stany wyłączone (domyślnie) — ekrany jak przed PRZ-091', () => {
  it('lista bez kolumny „Na stanie” i bez paska stanów, karta bez sekcji stanu', async () => {
    const lista = (await get('/magazyn')).body;
    expect(naglowekTabeli(lista)).toContain('Paczkomat');
    expect(naglowekTabeli(lista)).not.toContain('Na stanie');
    expect(lista).not.toContain('class="magazyn-stany"');
    const k = (await get(`/magazyn/${karta}`)).body;
    expect(k).toContain('id="produkty-karty"');
    expect(sekcjaStanu(k)).toBe('');
  });

  it('import i pozycje bez karty odmawiają 409, ruch na karcie 409', async () => {
    expect((await get('/magazyn/stany/import')).statusCode).toBe(409);
    expect((await get('/magazyn/stany/bez-karty')).statusCode).toBe(409);
    expect((await post(`/magazyn/${karta}/ruch`, { rodzaj: 'przyjecie', ilosc: '5', klucz: 'abcdefgh12' })).statusCode).toBe(409);
  });
});

describe('stany włączone', () => {
  beforeEach(() => wlacz());

  it('lista: kolumna „Na stanie” z liczbą, minus oznaczony, pasek z odnośnikami', async () => {
    zamowienieAllegro(2);
    const html = (await get('/magazyn')).body;
    expect(naglowekTabeli(html)).toContain('Na stanie');
    expect(/<td class="liczba kol-na-stanie stan-minus">-2<\/td>/u.test(html)).toBe(true);
    const pasek = /<p class="magazyn-stany">[\s\S]*?<\/p>/u.exec(html)?.[0] ?? '';
    expect(pasek).toContain('1 na minusie');
    expect(pasek).toContain('href="/magazyn/stany/import"');
  });

  it('karta: przyjęcie zapisuje, podwójne kliknięcie tym samym formularzem nie dubluje', async () => {
    const klucz = kluczFormularza((await get(`/magazyn/${karta}`)).body);
    expect(klucz).toMatch(/^[0-9a-f]{24}$/u);
    const r = await post(`/magazyn/${karta}/ruch`, { rodzaj: 'przyjecie', ilosc: '10', klucz });
    expect(r.statusCode).toBe(303);
    expect((await post(`/magazyn/${karta}/ruch`, { rodzaj: 'przyjecie', ilosc: '10', klucz })).statusCode).toBe(303);
    expect(stanKarty(db, karta).stan).toBe(10);
    const sekcja = sekcjaStanu((await get(`/magazyn/${karta}`)).body);
    expect(sekcja).toContain('10 szt.');
    expect(sekcja).toContain('przyjęcie');
    expect(sekcja).toContain('adam');
  });

  it('drugie wysłanie tego samego formularza mówi wprost, że ruch nie wszedł drugi raz', async () => {
    const klucz = kluczFormularza((await get(`/magazyn/${karta}`)).body);
    await post(`/magazyn/${karta}/ruch`, { rodzaj: 'przyjecie', ilosc: '4', klucz });
    const drugi = await post(`/magazyn/${karta}/ruch`, { rodzaj: 'przyjecie', ilosc: '4', klucz });
    expect(drugi.headers.location).toBe(`/magazyn/${karta}?ruch=powtorzony#stan-karty`);
    const sekcja = sekcjaStanu((await get(drugi.headers.location)).body);
    expect(sekcja).toContain('ten formularz był już zapisany');
    expect(stanKarty(db, karta).stan).toBe(4);
  });

  it('korekta bez powodu: 400, nic nie zapisane, wpisana ilość zostaje w polu', async () => {
    const klucz = kluczFormularza((await get(`/magazyn/${karta}`)).body);
    const r = await post(`/magazyn/${karta}/ruch`, { rodzaj: 'korekta', ilosc: '-3', powod: '', klucz });
    expect(r.statusCode).toBe(400);
    const sekcja = sekcjaStanu(r.body);
    expect(sekcja).toContain('Korekta wymaga powodu');
    expect(sekcja).toContain('value="-3"');
    expect(stanKarty(db, karta).stan).toBe(0);
  });

  it('karta: zamówienie w historii i ostrzeżenie o braku', async () => {
    zamowienieAllegro(3);
    const sekcja = sekcjaStanu((await get(`/magazyn/${karta}`)).body);
    expect(sekcja).toContain('-3 szt.');
    expect(sekcja).toContain('Brak na stanie');
    expect(sekcja).toContain('zamówienie A-3');
  });

  it('import: podgląd niczego nie zapisuje, zapis ustawia stan otwarcia, drugi zapis odrzuca', async () => {
    const podglad = await post('/magazyn/stany/import', { tekst: 'lmp-grz-30;12\nNIEMA;1' });
    expect(podglad.statusCode).toBe(200);
    expect(podglad.body).toContain('wejdzie 1, odrzucone 1');
    expect(stanKarty(db, karta).stan).toBe(0);
    const zapis = await post('/magazyn/stany/import/zapisz', { tekst: 'lmp-grz-30;12' });
    expect(zapis.body).toContain('Zapisano stan otwarcia dla 1 kart');
    expect(stanKarty(db, karta).stan).toBe(12);
    const drugi = await post('/magazyn/stany/import/zapisz', { tekst: 'lmp-grz-30;12' });
    expect(drugi.body).toContain('ma już stan otwarcia');
    expect(stanKarty(db, karta).stan).toBe(12);
  });

  it('pozycje bez karty: oferta niepowiązana na liście z powodem', async () => {
    zapiszZamowienie(db, 'allegro_a', {
      zrodlo_id: 'x1', numer: 'A-X', klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' }, metoda_wysylki: 'allegro_dpd',
      kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '50.00', status_woo: null, oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-10-17T09:00:00.000Z',
      pozycje: [{ nazwa: 'Klosz nieznany', sku: null, ilosc: 1, cena_brutto: '50.00', vat: '23', zdjecie_url: null, zrodlo_id: 1,
        produkt_id: null, oferta_id: '1111111111' }],
    }, {});
    const tabela = /<table class="tresc-lista" id="pozycje-bez-karty">[\s\S]*?<\/table>/u.exec((await get('/magazyn/stany/bez-karty')).body)?.[0] ?? '';
    expect(tabela).toContain('Klosz nieznany');
    expect(tabela).toContain('nie jest powiązana z żadną kartą');
  });
});
