import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { historiaCenZakupu, zapiszCeneZakupu } from '../../../src/oms/db/ceny-zakupu.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { STAWKI_VAT } from '../../../src/domena/vat.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

// FORMULARZ EDYCJI HURTEM NA LIŚCIE MAGAZYNU — stawka VAT i cena zakupu. Domena umie je od dawna,
// ale człowiek dochodzi do niej wyłącznie przez pola tego formularza: tu sprawdzamy, że pola są,
// że noszą nazwy, które czyta trasa, i że droga lista → podgląd → zatwierdzenie dowozi wartości
// do bazy. Payload podglądu i zatwierdzenia jest składany Z HTML-a, nie wpisany w test — inaczej
// test przeszedłby także przy formularzu bez tych pól.

const origin = 'http://localhost';
let db, app, headers;

async function zaloguj(login, rola) {
  zalozKonto(db, { login, imie: 'Ada', haslo: 'test', rola, admin: false });
  const r = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin },
    payload: { uzytkownik: login, haslo: 'test' },
  });
  expect(r.statusCode).toBe(302);
  return {
    origin,
    cookie: []
      .concat(r.headers['set-cookie'])
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'test' } },
    magazyn: { stan: () => ({ trwa: false }) },
  });
  headers = await zaloguj('sprzedawca', 'sprzedaz');
});

afterEach(async () => {
  await app.close();
  db.close();
});

const dzis = () => dzienWarszawa(new Date().toISOString());
const get = (url) => app.inject({ method: 'GET', url, headers });
const post = (url, payload) => app.inject({ method: 'POST', url, headers, payload });

function formularz(body, akcja) {
  const start = body.search(new RegExp(`<form method="post" action="${akcja}"[ >]`));
  if (start < 0) throw new Error(`Na ekranie nie ma formularza ${akcja}`);
  const koniec = body.indexOf('</form>', start);
  return body.slice(start, koniec);
}
function select(html, name) {
  const m = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!m) throw new Error(`Formularz nie ma pola wyboru „${name}"`);
  return [...m[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((o) => ({
    value: o[1],
    selected: /\bselected\b/.test(o[2]),
    tekst: o[3].trim(),
  }));
}
function input(html, name) {
  const m = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html);
  if (!m) throw new Error(`Formularz nie ma pola „${name}"`);
  return m[0];
}
// Ukryte pola formularza zatwierdzenia → payload; powtórzona nazwa zbiera się w tablicę,
// tak jak przy wysłaniu przez przeglądarkę.
function ukryte(html) {
  const payload = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    const [, n, v] = m;
    if (n in payload) payload[n] = [].concat(payload[n], v);
    else payload[n] = v;
  }
  return payload;
}
// Pola wyboru kart stoją w tabeli podglądu poza formularzem i dołączają do niego atrybutem `form`;
// przeglądarka wysyła tylko zaznaczone.
function polaZatwierdzenia(body) {
  const payload = ukryte(formularz(body, '/magazyn/hurt/zatwierdz'));
  for (const m of body.matchAll(/<input type="checkbox" name="([^"]*)" value="([^"]*)" form="zatwierdz-hurt"[^>]*>/g)) {
    if (!/\bchecked\b/.test(m[0])) continue;
    const [, n, v] = m;
    payload[n] = n in payload ? [].concat(payload[n], v) : v;
  }
  return payload;
}

describe('formularz hurtu na liście magazynu — pola stawki VAT i ceny zakupu', () => {
  it('stawka VAT: pierwsza opcja pusta „nie zmieniaj", potem dokładnie stawki z listy domeny', async () => {
    utworzKarte(db, { nazwa: 'Lampa Kopuła' });
    const r = await get('/magazyn');
    expect(r.statusCode).toBe(200);

    const opcje = select(formularz(r.body, '/magazyn/hurt'), 'stawka_vat');
    expect(opcje[0]).toEqual({ value: '', selected: false, tekst: '— nie zmieniaj —' });
    expect(opcje.slice(1)).toEqual(STAWKI_VAT.map((s) => ({ value: s, selected: false, tekst: `${s}%` })));
  });

  it('cena zakupu: pole kwoty z klawiaturą dziesiętną i pole daty „obowiązuje od"', async () => {
    utworzKarte(db, { nazwa: 'Lampa Kopuła' });
    const html = formularz((await get('/magazyn')).body, '/magazyn/hurt');

    const kwota = input(html, 'cena_zakupu_netto');
    expect(kwota).toContain('type="text"');
    expect(kwota).toContain('inputmode="decimal"');
    expect(input(html, 'cena_zakupu_od')).toContain('type="date"');
    expect(html).toContain('Cena zakupu netto');
    expect(html).toContain('Obowiązuje od');
  });
});

describe('formularz hurtu — jedno określenie pustej pozycji i dopisek przy cenie zakupu', () => {
  // Paczkomatu nie ma w panelu Edytuj — ustawia go karta albo import.
  it('kategoria i stawka: pusta pozycja to wszędzie „— nie zmieniaj —"; paczkomatu w panelu nie ma', async () => {
    utworzKarte(db, { nazwa: 'Lampa Kopuła' });
    const html = formularz((await get('/magazyn')).body, '/magazyn/hurt');
    for (const pole of ['kategoria_glowna', 'stawka_vat']) {
      expect(select(html, pole)[0], pole).toEqual({ value: '', selected: false, tekst: '— nie zmieniaj —' });
    }
    expect(html).not.toMatch(/<select[^>]*name="paczkomat"/);
    expect(html).not.toContain('nie ruszaj');
  });

  it('cena zakupu ma dopisek o historii, czytany jako opis pola (nie drugi raz w nazwie)', async () => {
    utworzKarte(db, { nazwa: 'Lampa Kopuła' });
    const html = formularz((await get('/magazyn')).body, '/magazyn/hurt');
    const opis = /aria-describedby="([^"]+)"/.exec(input(html, 'cena_zakupu_netto'))?.[1];
    expect(opis).toBeDefined();
    const dopisek = new RegExp(`<small[^>]*\\bid="${opis}"([^>]*)>([^<]*)</small>`).exec(html);
    expect(dopisek).not.toBeNull();
    expect(dopisek[2]).toContain('Puste „od” = dziś');
    expect(dopisek[2]).toContain('historii');
  });
});

describe('„dziś" ceny zakupu liczone raz — w podglądzie', () => {
  afterEach(() => vi.useRealTimers());

  it('podgląd o 23:59:59, zatwierdzenie o 00:00:01 następnego dnia → zapisana data z podglądu', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 22:59:59 UTC = 23:59:59 w Warszawie (czas zimowy, UTC+1).
    vi.setSystemTime(new Date('2026-11-18T22:59:59Z'));
    headers = await zaloguj('zakupy', 'sprzedaz');
    const karta = utworzKarte(db, { nazwa: 'Lampa Kopuła' });

    const podglad = await post('/magazyn/hurt', {
      zakres: 'zaznaczone',
      zaznaczone: [String(karta)],
      cena_zakupu_netto: '13,10',
      cena_zakupu_od: '',
    });
    expect(podglad.statusCode).toBe(200);
    const doZatwierdzenia = polaZatwierdzenia(podglad.body);
    expect(doZatwierdzenia.cena_zakupu_od).toBe('2026-11-18');

    vi.setSystemTime(new Date('2026-11-18T23:00:01Z'));
    const r = await post('/magazyn/hurt/zatwierdz', doZatwierdzenia);
    expect(r.statusCode).toBe(200);
    expect(historiaCenZakupu(db, karta).map((w) => [w.cena_netto_gr, w.obowiazuje_od])).toEqual([[1310, '2026-11-18']]);
  });
});

describe('filtr „Braki danych" zna cenę zakupu', () => {
  it('?brak=cena_zakupu zaznacza „bez ceny zakupu", przed „komplet"', async () => {
    utworzKarte(db, { nazwa: 'Lampa Kopuła' });
    const r = await get('/magazyn?brak=cena_zakupu');
    expect(r.statusCode).toBe(200);

    const opcje = select(r.body, 'brak');
    const zaznaczone = opcje.filter((o) => o.selected);
    expect(zaznaczone).toEqual([{ value: 'cena_zakupu', selected: true, tekst: 'bez ceny zakupu' }]);
    const klucze = opcje.map((o) => o.value);
    expect(klucze.indexOf('cena_zakupu')).toBe(klucze.indexOf('komplet') - 1);
  });
});

describe('lista → podgląd → zatwierdzenie z polami z HTML-a', () => {
  it('stawka i cena zakupu z formularza listy dojeżdżają przez podgląd do bazy', async () => {
    const kopula = utworzKarte(db, { nazwa: 'Lampa Kopuła' });
    const stozek = utworzKarte(db, { nazwa: 'Lampa Stożek' });
    db.prepare("UPDATE karty_produktow SET stawka_vat = '23' WHERE id = ?").run(stozek);
    zapiszCeneZakupu(db, stozek, { gr: 1000, od: '2020-01-01' }, { zrodlo: 'karta', kto: 'ktos' });

    const lista = formularz((await get('/magazyn')).body, '/magazyn/hurt');
    // Wartości wybierane SPOŚRÓD tego, co formularz pokazuje — tak jak klika człowiek.
    const stawka = select(lista, 'stawka_vat').find((o) => o.value === '8');
    expect(stawka).toBeDefined();
    const nazwaKwoty = /name="(cena_zakupu_netto)"/.exec(input(lista, 'cena_zakupu_netto'))[1];
    const nazwaOd = /name="(cena_zakupu_od)"/.exec(input(lista, 'cena_zakupu_od'))[1];

    const podglad = await post('/magazyn/hurt', {
      zakres: 'zaznaczone',
      zaznaczone: [String(kopula), String(stozek)],
      stawka_vat: stawka.value,
      [nazwaKwoty]: '13,10',
      [nazwaOd]: '',
    });
    expect(podglad.statusCode).toBe(200);
    expect(podglad.body).toContain('<td>Stawka VAT</td>');
    expect(podglad.body).toContain('<td>Cena zakupu netto</td>');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ceny_zakupu_kart').get().n).toBe(1);

    const doZatwierdzenia = polaZatwierdzenia(podglad.body);
    expect(doZatwierdzenia).toMatchObject({ stawka_vat: '8', cena_zakupu_netto: '13,10' });
    const r = await post('/magazyn/hurt/zatwierdz', doZatwierdzenia);

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Zmieniono <b>2 karty</b>');
    const stawki = db.prepare('SELECT id, stawka_vat FROM karty_produktow ORDER BY id').all();
    expect(stawki).toEqual([
      { id: kopula, stawka_vat: '8' },
      { id: stozek, stawka_vat: '8' },
    ]);
    expect(historiaCenZakupu(db, kopula).map((w) => [w.cena_netto_gr, w.obowiazuje_od])).toEqual([[1310, dzis()]]);
    expect(historiaCenZakupu(db, stozek).map((w) => [w.cena_netto_gr, w.obowiazuje_od])).toEqual([
      [1000, '2020-01-01'],
      [1310, dzis()],
    ]);
  });
});
