// PRZ-051 — ekran listy po zalogowaniu: strona po ROZMIAR_STRONY wierszy, liczniki z indeksu,
// liczba wyników frazy liczona dla całości, filtr i zakładka w linkach stron, powrót z karty
// na tę samą stronę, akcja masowa odświeżająca liczniki, karta z tymi samymi licznikami.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { ROZMIAR_STRONY } from '../../src/moduly/zamowienia/lista.js';
import { adresZFiltrami, bezpiecznyPowrotNaListe } from '../../src/domena/filtry-listy.js';
import { KANALY_TESTOWE, wstawGole } from './pomoc.js';

let a; let cookie;
const naglowki = () => ({ cookie });
const formularz = () => ({ cookie, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' });
const ids = (html) => [...html.matchAll(/name="id" value="(\d+)"/g)].map((m) => Number(m[1]));
const licznik = (html, klucz) => Number(html.match(new RegExp(`data-status="${klucz}">(\\d+)<`))?.[1]);

beforeEach(async () => {
  a = await zbudujOms({ env: { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'bootstrap', OMS_PASS: 'syntetyczne', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
    OMS_KANALY: JSON.stringify(KANALY_TESTOWE) } });
  zalozKonto(a.db, { login: 'tester', imie: 'Test', haslo: 'syntetyczne-haslo-051', rola: 'admin', admin: true });
  const login = await a.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'uzytkownik=tester&haslo=syntetyczne-haslo-051&powrot=%2F' });
  cookie = String(login.headers['set-cookie']).match(/sesja_oms=[^;]+/)[0];
});
afterEach(async () => { await a.app.close(); a.db.close(); });

describe('PRZ-051 adres listy niesie stronę', () => {
  it('adresZFiltrami: strona po filtrach, przed zaznaczeniem; strona 1 nie zostawia śladu', () => {
    expect(adresZFiltrami({ kanal: 'kanal_a' }, { wszystkie: true, strona: 3, zaznacz: true })).toBe('/?wszystkie=1&kanal=kanal_a&strona=3&zaznacz=1');
    expect(adresZFiltrami({}, { strona: 1 })).toBe('/');
  });

  it('bezpiecznyPowrotNaListe zachowuje poprawną stronę i odrzuca śmieci', () => {
    expect(bezpiecznyPowrotNaListe('/?wszystkie=1&strona=2', KANALY_TESTOWE)).toBe('/?wszystkie=1&strona=2');
    for (const zla of ['0', '-1', '1', 'x', '2.5', '1e3', '99999999999999999999']) {
      expect(bezpiecznyPowrotNaListe(`/?wszystkie=1&strona=${zla}`, KANALY_TESTOWE), zla).toBe('/?wszystkie=1');
    }
    expect(bezpiecznyPowrotNaListe('/?strona=2&strona=3', KANALY_TESTOWE)).toBe('/');
  });
});

describe('PRZ-051 ekran listy', () => {
  it(`strony po ${ROZMIAR_STRONY}: rozłączne, w porządku listy, z licznikami całości`, async () => {
    const wstawione = wstawGole(a.db, 2 * ROZMIAR_STRONY + 50);
    const s1 = await a.app.inject({ url: '/', headers: naglowki() });
    expect(s1.statusCode, s1.body.slice(0, 300)).toBe(200);
    expect(ids(s1.body)).toHaveLength(ROZMIAR_STRONY);
    expect(licznik(s1.body, 'do_zrobienia')).toBe(wstawione.length);
    expect(licznik(s1.body, 'wszystkie')).toBe(wstawione.length);
    expect(licznik(s1.body, 'nowe')).toBe(wstawione.length);
    expect(s1.body).toContain('href="/?strona=2"');
    const s2 = await a.app.inject({ url: '/?strona=2', headers: naglowki() });
    const s3 = await a.app.inject({ url: '/?strona=3', headers: naglowki() });
    expect(ids(s3.body)).toHaveLength(50);
    expect([...ids(s1.body), ...ids(s2.body), ...ids(s3.body)]).toEqual([...wstawione].reverse());
    // Strona za końcem listy pokazuje ostatnią, a nie pustą tabelę.
    const za = await a.app.inject({ url: '/?strona=9', headers: naglowki() });
    expect(ids(za.body)).toEqual(ids(s3.body));
  });

  it('fraza: liczba wyników dla całości, nie dla strony; filtr i fraza w linku następnej strony', async () => {
    wstawGole(a.db, 2 * ROZMIAR_STRONY + 50, { sklep: 'kanal_b' });
    const r = await a.app.inject({ url: '/?szukaj=T&kanal=kanal_b', headers: naglowki() });
    expect(r.statusCode).toBe(200);
    expect(ids(r.body)).toHaveLength(ROZMIAR_STRONY);
    expect(r.body).toMatch(new RegExp(`Wyniki dla „T”: <strong>${2 * ROZMIAR_STRONY + 50}</strong>`));
    expect(r.body).toContain('href="/?szukaj=T&amp;kanal=kanal_b&amp;strona=2"');
  });

  it('powrót z karty wraca na tę samą stronę tej samej zakładki', async () => {
    const wstawione = wstawGole(a.db, ROZMIAR_STRONY + 5);
    const lista = await a.app.inject({ url: '/?wszystkie=1&strona=2', headers: naglowki() });
    const id = ids(lista.body)[0];
    expect(id).toBe(wstawione[4]);
    const powrot = encodeURIComponent('/?wszystkie=1&strona=2');
    expect(lista.body).toContain(`/zamowienia/${id}?powrot=${powrot}`);
    const karta = await a.app.inject({ url: `/zamowienia/${id}?powrot=${powrot}`, headers: naglowki() });
    expect(karta.statusCode, karta.body.slice(0, 300)).toBe(200);
    expect(karta.body).toContain('/?wszystkie=1&amp;strona=2');
    // Karta rysuje te same liczniki, co lista.
    expect(licznik(karta.body, 'wszystkie')).toBe(wstawione.length);
    expect(licznik(karta.body, 'nowe')).toBe(wstawione.length);
  });

  it('baza odrzuca zapis (pełny dysk): lista z ostatniego stanu indeksu z ostrzeżeniem, karta bez liczb', async () => {
    const [id] = wstawGole(a.db, 3);
    await a.app.inject({ url: '/', headers: naglowki() });
    a.db.prepare('UPDATE zamowienia SET w_realizacji_at = ? WHERE id = ?').run('2026-10-01T10:00:00Z', id);
    const oryginal = a.db.prepare;
    a.db.prepare = function (sql) {
      if (/^\s*(INSERT|DELETE|UPDATE)/i.test(sql) && /lista_/.test(sql)) throw new Error('SQLITE_FULL: database or disk is full');
      return oryginal.call(this, sql);
    };
    try {
      const lista = await a.app.inject({ url: '/', headers: naglowki() });
      expect(lista.statusCode, lista.body.slice(0, 300)).toBe(200);
      expect(lista.body).not.toContain('SQLITE_FULL');
      expect(lista.body).toContain('mogą być nieaktualne');
      expect(ids(lista.body)).toHaveLength(3);
      const karta = await a.app.inject({ url: `/zamowienia/${id}`, headers: naglowki() });
      expect(karta.statusCode, karta.body.slice(0, 300)).toBe(200);
      expect(karta.body).not.toContain('SQLITE_FULL');
      expect(karta.body).not.toMatch(/data-status="wszystkie">\d+</);
    } finally { a.db.prepare = oryginal; }
    // Po ustąpieniu awarii indeks dogania sam, przy następnym odczycie.
    const po = await a.app.inject({ url: '/', headers: naglowki() });
    expect(licznik(po.body, 'w_realizacji')).toBe(1);
    expect(po.body).not.toContain('mogą być nieaktualne');
  });

  it('uszkodzone zamówienie na stronie: reszta strony się wyświetla, a lista mówi, które i dlaczego', async () => {
    const wst = wstawGole(a.db, 5);
    a.db.prepare("UPDATE zamowienia SET klient_json = 'Xq7DaneKlienta' WHERE id = ?").run(wst[3]);
    const r = await a.app.inject({ url: '/', headers: naglowki() });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(ids(r.body).sort()).toEqual([wst[0], wst[1], wst[2], wst[4]].sort());
    expect(r.body).toContain('T-4');
    expect(r.body).toMatch(/nie daje się odczytać/);
    expect(licznik(r.body, 'do_zrobienia')).toBe(5);
    // Przyczyna bez wycinka danych (V8 wkleja fragment złego JSON-u do komunikatu).
    expect(r.body).not.toContain('Xq7DaneKlienta');
    // Numer z komunikatu da się wyszukać.
    const szukaj = await a.app.inject({ url: '/?szukaj=T-4', headers: naglowki() });
    expect(szukaj.body).toMatch(/Wyniki dla „T-4”: <strong>1<\/strong>/);
  });

  it('wiersz uszkodzony POZA wiedzą indeksu (gołe połączenie) też jest nazwany, nie znika po cichu', async () => {
    const wst = wstawGole(a.db, 3);
    await a.app.inject({ url: '/', headers: naglowki() });
    // Zapis z pominięciem wyzwalaczy: indeks ma normalny wiersz, a odczyt strony go nie przeczyta.
    a.db.exec('DROP TRIGGER temp.lista_zamowienia_update');
    a.db.prepare("UPDATE zamowienia SET dostawa_json = '[' WHERE id = ?").run(wst[1]);
    const r = await a.app.inject({ url: '/', headers: naglowki() });
    expect(r.statusCode).toBe(200);
    expect(ids(r.body).sort()).toEqual([wst[0], wst[2]].sort());
    expect(r.body).toMatch(/nie daje się odczytać[\s\S]*T-2/);
  });

  it('otwarcie listy przy zbudowanym indeksie czyta z tabeli zamówień tylko jedną stronę', async () => {
    wstawGole(a.db, 3 * ROZMIAR_STRONY);
    await a.app.inject({ url: '/', headers: naglowki() });
    for (const url of ['/', '/?wszystkie=1&strona=2', '/?szukaj=T-1', '/?status=nowe&kanal=kanal_a']) {
      const sql = [];
      const oryginal = a.db.prepare;
      a.db.prepare = function (tekst) { sql.push(tekst); return oryginal.call(this, tekst); };
      try {
        expect((await a.app.inject({ url, headers: naglowki() })).statusCode).toBe(200);
      } finally { a.db.prepare = oryginal; }
      for (const s of sql.filter((t) => /\bFROM zamowienia\b/.test(t))) {
        const strona = /WHERE id IN \(/.test(s) && s.match(/\?/g).length <= ROZMIAR_STRONY;
        // Bezpiecznik kanałów (moduł zdrowia): DISTINCT po indeksie (sklep, zrodlo_id) kończy grupę
        // po pierwszym trafieniu — pomiar PRZ-051 na 15 000 zamówień: 0,3–2,9 ms, z indeksem wyrażeniowym
        // wolniej (9–10 ms), więc zostaje bez zmian.
        const dozwolone = /DISTINCT metoda_platnosci/.test(s) || /SELECT DISTINCT sklep FROM zamowienia/.test(s);
        expect(strona || dozwolone, `${url}: ${s.slice(0, 120)}`).toBe(true);
      }
    }
  });

  it('ostrzeżenia paczek pytają o numer tylko zamówień, których paczka stoi — nie o całe okno 60 dni', async () => {
    const ids = wstawGole(a.db, 300);
    const teraz = new Date().toISOString();
    const ins = a.db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, status_kuriera, status_kuriera_at, utworzona_at, kolejnosc)
      VALUES (?, 'dpd', 'nadana', ?, '/tmp/e.pdf', ?, ?, ?, 1)`);
    // 299 doręczonych dziś, jedna stoi od miesiąca.
    for (const id of ids.slice(1)) ins.run(id, `L${id}`, 'Doręczona', teraz, teraz);
    const dawno = new Date(Date.now() - 20 * 86400000).toISOString();
    ins.run(ids[0], 'STOI-1', 'W drodze', dawno, dawno);
    const sql = [];
    const oryginal = a.db.prepare;
    a.db.prepare = function (tekst) { sql.push(tekst); return oryginal.call(this, tekst); };
    let r;
    try { r = await a.app.inject({ url: '/', headers: naglowki() }); } finally { a.db.prepare = oryginal; }
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Paczka STOI-1 (zam. T-1)');
    const numery = sql.filter((s) => /SELECT id, numer FROM zamowienia/.test(s));
    expect(numery.length).toBeGreaterThan(0);
    for (const s of numery) expect(s.match(/\?/g).length).toBe(1);
  });

  it('akcje masowe (status, specyfikacje, faktury, nadanie) czytają tylko zaznaczone, nie całą tabelę', async () => {
    const wstawione = wstawGole(a.db, 600);
    await a.app.inject({ url: '/', headers: naglowki() }); // indeks zbudowany — mierzymy same akcje
    const cel = [wstawione[10], wstawione[500]];
    for (const url of ['/zamowienia/masowe/status', '/zamowienia/specyfikacje.pdf', '/zamowienia/lista-produktow.pdf', '/zamowienia/zestawienie.pdf', '/zamowienia/faktury-hurtem/podglad', '/zamowienia/masowe/nadaj-podglad']) {
      const sql = [];
      const oryginal = a.db.prepare;
      a.db.prepare = function (tekst) { sql.push(tekst); return oryginal.call(this, tekst); };
      try {
        const body = new URLSearchParams([...cel.map((id) => ['id', String(id)]), ['status', 'w_realizacji']]).toString();
        const r = await a.app.inject({ method: 'POST', url, headers: formularz(), payload: body });
        expect(r.statusCode, `${url}: ${r.body.slice(0, 200)}`).toBeLessThan(500);
      } finally { a.db.prepare = oryginal; }
      expect(sql.filter((s) => /^SELECT id FROM zamowienia$/.test(s.trim())), url).toEqual([]);
      const odczyty = sql.filter((s) => /FROM zamowienia WHERE id IN \(/.test(s));
      expect(odczyty.length, url).toBeGreaterThan(0);
      for (const s of odczyty) expect(s.match(/\?/g).length, url).toBeLessThanOrEqual(2);
    }
  });

  it('zmiana masowa: liczniki i zakładki widzą ją od razu, powrót na tę samą stronę', async () => {
    const wstawione = wstawGole(a.db, ROZMIAR_STRONY + 5);
    const cel = wstawione.slice(0, 3);
    const body = new URLSearchParams([...cel.map((id) => ['id', String(id)]), ['status', 'w_realizacji'], ['powrot', '/?strona=2']]).toString();
    const m = await a.app.inject({ method: 'POST', url: '/zamowienia/masowe/status', headers: formularz(), payload: body });
    expect(m.statusCode, m.body.slice(0, 300)).toBe(302);
    expect(m.headers.location).toBe('/?strona=2');
    const po = await a.app.inject({ url: '/?status=w_realizacji', headers: naglowki() });
    expect(licznik(po.body, 'w_realizacji')).toBe(3);
    expect(licznik(po.body, 'nowe')).toBe(wstawione.length - 3);
    expect(ids(po.body).sort()).toEqual([...cel].sort());
  });
});
