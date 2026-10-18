// PRZ-094.18: „Historia zmian” na dole karty zamówienia — tabela `log`, domyślnie zwinięta.
// Tabela `log` nie ma indeksu po `zamowienie_id`, więc zwinięta karta NIE MA PRAWA jej czytać.
import { describe, it, expect, vi } from 'vitest';
import { zapiszZamowienie, historiaLogu } from '../../../src/oms/db/zamowienia.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'kurier', imie: 'Kurier', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'kurier').id, ['przesylki']);
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia']);
  return { ...p, admin: jako(p.db, 'adam'), kurier: jako(p.db, 'kurier'), ewa: jako(p.db, 'ewa') };
}

let numer = 0;
function zamowienie(db) {
  numer += 1;
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: 9000 + numer, numer: String(9000 + numer), klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-17T09:00:00',
    pozycje: [{ nazwa: 'Lampa', sku: null, cena_brutto: '100.00', vat: '23', zdjecie_url: null, zrodlo_id: 1, produkt_id: null, oferta_id: null, wariant_id: null, ilosc: 1 }],
  }, {});
}
/** Wpis wprost SQL-em: `dopiszLog` bierze `kto` z kontekstu żądania, a tu potrzebny jest każdy z trzech rodzajów. */
const wpis = (db, id, akcja, wynik, kto = 'automat', at = '2026-10-17T10:00:00.000Z') =>
  db.prepare('INSERT INTO log (zamowienie_id, at, akcja, wynik, kto) VALUES (?,?,?,?,?)').run(id, at, akcja, wynik, kto);

const sekcja = (html) => /<section class="panel" id="historia">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? null;
const wiersze = (s) => [...s.matchAll(/<tr class="hist-wpis">[\s\S]*?<\/tr>/gu)].map((m) => m[0]);
/** Zapytania do tabeli `log` (poza INSERT-em) — licznik na `db.prepare`, niezależny od nazwy funkcji odczytu. */
function licznikOdczytowLogu(db) {
  const sondy = [];
  const oryginal = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (/\bFROM\s+log\b/iu.test(String(sql))) sondy.push(String(sql));
    return oryginal(sql);
  });
  return sondy;
}

describe('PRZ-094.18 karta — Historia zmian: stan zwinięty', () => {
  it('bez ?historia: sekcja ma nagłówek i link „Pokaż historię zmian”, ZERO wpisów i ZERO zapytań do log', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'status.reczny', 'tajny-wpis-123');
    const sondy = licznikOdczytowLogu(db);
    const r = await get(app, `/zamowienia/${id}`, admin);
    expect(r.statusCode, r.body).toBe(200);
    const s = sekcja(r.body);
    expect(s, 'brak sekcji #historia').not.toBeNull();
    expect(s).toContain('Historia zmian');
    expect(s).toMatch(/<a [^>]*href="\?historia=1#historia"[^>]*>Pokaż historię zmian<\/a>/u);
    expect(s).not.toContain('<table');
    expect(r.body).not.toContain('tajny-wpis-123');
    expect(sondy).toEqual([]);
    vi.restoreAllMocks();
  });

  it('sekcja stoi NA SAMYM DOLE: po Fakturze i po komentarzu wewnętrznym (ostatnim bloku Wiadomości)', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    const r = await get(app, `/zamowienia/${id}`, admin);
    const poz = r.body.indexOf('id="historia"');
    const komentarz = r.body.indexOf(`/zamowienia/${id}/komentarz`);
    expect(komentarz).toBeGreaterThan(0);
    expect(poz).toBeGreaterThan(komentarz);
    expect(poz).toBeGreaterThan(r.body.indexOf('id="faktura"'));
    expect(r.body.indexOf('id="historia"', poz + 1)).toBe(-1);
  });

  it.each(['abc', '0', '-1', '1.5', '', '9999999'])('?historia=%s (nie dodatnia liczba całkowita) = zwinięta, bez zapytania', async (v) => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'x.akcja', 'tajny-wpis-123');
    const sondy = licznikOdczytowLogu(db);
    const r = await get(app, `/zamowienia/${id}?historia=${v}`, admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('tajny-wpis-123');
    expect(sondy).toEqual([]);
    vi.restoreAllMocks();
  });

  it('powtórzony klucz (?historia=1&historia=2 = tablica) = zwinięta', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'x.akcja', 'tajny-wpis-123');
    const r = await get(app, `/zamowienia/${id}?historia=1&historia=2`, admin);
    expect(r.body).not.toContain('tajny-wpis-123');
  });

  it('link „Pokaż” niesie powrót na listę, gdy karta otwarta z listy', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    const r = await get(app, `/zamowienia/${id}?powrot=${encodeURIComponent('/?status=nowe')}`, admin);
    const href = /<a [^>]*href="([^"]*)"[^>]*>Pokaż historię zmian<\/a>/u.exec(sekcja(r.body))?.[1];
    expect(href).toBeDefined();
    expect(href.replaceAll('&amp;', '&')).toContain(`/zamowienia/${id}?`);
    expect(href).toContain('historia=1');
    expect(href).toMatch(/#historia$/u);
    expect(href).toContain('powrot=');
  });
});

describe('PRZ-094.18 karta — Historia zmian: stan rozwinięty', () => {
  it('?historia=1: najnowsze na górze (po id, nie po at), kto: login / „automat” / „—”, akcja i wynik jak w bazie', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    const inne = zamowienie(db);
    // Ten sam `at` w trzech wpisach (rozdzielczość milisekundy) — o kolejności rozstrzyga WYŁĄCZNIE id.
    wpis(db, id, 'a.pierwszy', 'wynik-pierwszy', null, '2026-10-17T10:00:00.000Z');
    wpis(db, id, 'b.drugi', 'wynik-drugi', 'automat', '2026-10-17T10:00:00.000Z');
    wpis(db, id, 'c.trzeci', 'DECYZJA CZŁOWIEKA (anna): wynik-trzeci', 'anna', '2026-10-17T09:00:00.000Z');
    wpis(db, inne, 'z.cudze', 'wynik-cudzego-zamowienia', 'anna');
    const r = await get(app, `/zamowienia/${id}?historia=1`, admin);
    expect(r.statusCode, r.body).toBe(200);
    const s = sekcja(r.body);
    const w = wiersze(s);
    expect(w).toHaveLength(3);
    expect(w[0]).toContain('c.trzeci');
    expect(w[1]).toContain('b.drugi');
    expect(w[2]).toContain('a.pierwszy');
    expect(w[0]).toContain('anna');
    expect(w[1]).toContain('>automat<');
    expect(w[2]).toMatch(/<td class="hist-kto">—<\/td>/u);
    expect(w[0]).toContain('DECYZJA CZŁOWIEKA (anna): wynik-trzeci');
    expect(w[0]).toContain('2026-10-17 11:00:00'); // 09:00 UTC = 11:00 w Warszawie (CEST)
    expect(w[1]).toContain('2026-10-17 12:00:00');
    expect(s).not.toContain('wynik-cudzego-zamowienia');
    expect(s).toMatch(/<a [^>]*href="[^"]*#historia"[^>]*>Zwiń<\/a>/u);
    expect(s).not.toContain('Pokaż historię zmian');
    expect(s).not.toContain('Starsze');
    expect(s).not.toContain('Nowsze');
  });

  it('nagłówki kolumn: czas, kto, akcja, szczegóły', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'a.b', 'c');
    const s = sekcja((await get(app, `/zamowienia/${id}?historia=1`, admin)).body);
    for (const naglowek of ['Czas', 'Kto', 'Akcja', 'Szczegóły']) expect(s).toMatch(new RegExp(`<th[^>]*>${naglowek}</th>`, 'u'));
  });

  it('zamówienie bez wpisów: komunikat zamiast pustej tabeli', async () => {
    const { db, app, admin } = panel();
    const s = sekcja((await get(app, `/zamowienia/${zamowienie(db)}?historia=1`, admin)).body);
    expect(s).toContain('Brak wpisów');
    expect(s).not.toContain('<table');
  });

  it('stronicowanie: 50 na stronę, „Starsze →” / „← Nowsze”, bez COUNT(*)', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    for (let i = 1; i <= 120; i += 1) wpis(db, id, `akcja.n${String(i).padStart(3, '0')}x`, `w${i}`);
    const sondy = licznikOdczytowLogu(db);

    const p1 = sekcja((await get(app, `/zamowienia/${id}?historia=1`, admin)).body);
    expect(wiersze(p1)).toHaveLength(50);
    expect(wiersze(p1)[0]).toContain('akcja.n120x');
    expect(wiersze(p1)[49]).toContain('akcja.n071x');
    expect(p1).toMatch(/<a [^>]*href="\?historia=2#historia"[^>]*>Starsze →<\/a>/u);
    expect(p1).not.toContain('← Nowsze');

    const p2 = sekcja((await get(app, `/zamowienia/${id}?historia=2`, admin)).body);
    expect(wiersze(p2)).toHaveLength(50);
    expect(wiersze(p2)[0]).toContain('akcja.n070x');
    expect(wiersze(p2)[49]).toContain('akcja.n021x');
    expect(p2).toMatch(/<a [^>]*href="\?historia=3#historia"[^>]*>Starsze →<\/a>/u);
    expect(p2).toMatch(/<a [^>]*href="\?historia=1#historia"[^>]*>← Nowsze<\/a>/u);

    const p3 = sekcja((await get(app, `/zamowienia/${id}?historia=3`, admin)).body);
    expect(wiersze(p3)).toHaveLength(20);
    expect(wiersze(p3)[19]).toContain('akcja.n001x');
    expect(p3).not.toContain('Starsze →');
    expect(p3).toMatch(/<a [^>]*href="\?historia=2#historia"[^>]*>← Nowsze<\/a>/u);

    expect(sondy.length).toBe(3); // jedno zapytanie na odsłonę
    expect(sondy.every((q) => !/COUNT\s*\(/iu.test(q))).toBe(true);
    vi.restoreAllMocks();
  });

  it('dokładnie 50 wpisów: brak „Starsze” (pobieramy 51, nie zgadujemy)', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    for (let i = 0; i < 50; i += 1) wpis(db, id, 'a.b', `w${i}`);
    const s = sekcja((await get(app, `/zamowienia/${id}?historia=1`, admin)).body);
    expect(wiersze(s)).toHaveLength(50);
    expect(s).not.toContain('Starsze');
  });

  it('strona za końcem: komunikat i powrót do pierwszej strony', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'a.b', 'c');
    const s = sekcja((await get(app, `/zamowienia/${id}?historia=7`, admin)).body);
    expect(wiersze(s)).toHaveLength(0);
    expect(s).toContain('Brak wpisów na tej stronie');
    expect(s).toMatch(/<a [^>]*href="\?historia=1#historia"[^>]*>← Nowsze<\/a>/u);
  });

  it('powrót na listę zostaje w odnośnikach stronicowania i „Zwiń”', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    for (let i = 0; i < 60; i += 1) wpis(db, id, 'a.b', `w${i}`);
    const s = sekcja((await get(app, `/zamowienia/${id}?historia=1&powrot=${encodeURIComponent('/?status=nowe')}`, admin)).body);
    const hrefy = [...s.matchAll(/<a [^>]*href="([^"]*)"/gu)].map((m) => m[1].replaceAll('&amp;', '&'));
    expect(hrefy.length).toBeGreaterThanOrEqual(2);
    for (const h of hrefy) expect(h).toContain('powrot=');
    expect(hrefy.some((h) => h.includes('historia=2'))).toBe(true);
    expect(hrefy.some((h) => !h.includes('historia='))).toBe(true); // „Zwiń”
  });

  it('długi wynik: w tabeli przycięty do jednej linii, pełny w <details>; krótki — zwykły tekst', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    const dlugi = `START ${'x'.repeat(400)} KONIEC`;
    wpis(db, id, 'a.dluga', dlugi);
    wpis(db, id, 'a.krotka', 'krotki wynik');
    const w = wiersze(sekcja((await get(app, `/zamowienia/${id}?historia=1`, admin)).body));
    const [krotka, dluga] = w;
    expect(krotka).toContain('krotki wynik');
    expect(krotka).not.toContain('<details');
    expect(dluga).toContain('<details');
    expect(dluga).toContain('START');
    expect(dluga).toContain(dlugi); // pełna treść jest w DOM-ie…
    expect(/<summary[^>]*>[\s\S]*?<\/summary>/u.exec(dluga)[0]).not.toContain('KONIEC'); // …ale podsumowanie jej nie niesie
  });
});

describe('PRZ-094.18 karta — Historia zmian: escapowanie', () => {
  it('wynik i akcja z HTML-em (odpowiedź API) nie wykonują się: <script>, atrybuty, cudzysłowy', async () => {
    const { db, app, admin } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'a"><img src=x onerror=alert(2)>', '<script>alert(1)</script> "oops" \'x\' & <b>', '<i>anna</i>');
    wpis(db, id, 'a.dluga', `<script>alert(3)</script>${'y'.repeat(300)}"><svg onload=alert(4)>`);
    const r = await get(app, `/zamowienia/${id}?historia=1`, admin);
    const s = sekcja(r.body);
    expect(s).not.toContain('<script>alert');
    expect(s).not.toContain('<img src=x');
    expect(s).not.toContain('<svg onload');
    expect(s).not.toContain('<b>');
    expect(s).not.toContain('<i>anna');
    expect(s).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(s).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(s).toContain('&lt;i&gt;anna&lt;/i&gt;');
    // `title` na przyciętej treści też nie może wypuścić cudzysłowu
    expect(s).not.toMatch(/title="[^"]*"><svg/u);
  });
});

describe('PRZ-094.18 karta — Historia zmian: uprawnienia jak karta', () => {
  it('konto bez ekranu „Zamówienia” dostaje odmowę jak przy zwykłej karcie i nie widzi wpisów', async () => {
    const { db, app, kurier } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'x.akcja', 'tajny-wpis-123');
    const zwykla = await get(app, `/zamowienia/${id}`, kurier);
    const historia = await get(app, `/zamowienia/${id}?historia=1`, kurier);
    expect(zwykla.statusCode).toBe(403);
    expect(historia.statusCode).toBe(zwykla.statusCode);
    expect(historia.body).not.toContain('tajny-wpis-123');
    expect(historia.body).not.toContain('Historia zmian');
  });

  it('konto z ekranem „Zamówienia” (bez admina) widzi historię — bez osobnego ekranu', async () => {
    const { db, app, ewa } = panel();
    const id = zamowienie(db);
    wpis(db, id, 'x.akcja', 'wpis-dla-agi');
    const r = await get(app, `/zamowienia/${id}?historia=1`, ewa);
    expect(r.statusCode, r.body).toBe(200);
    expect(sekcja(r.body)).toContain('wpis-dla-agi');
  });
});

describe('PRZ-094.18 historiaLogu (baza)', () => {
  it('oddaje najnowsze pierwsze, naStrone wpisów i znacznik „są starsze”', () => {
    const { db } = panel();
    const id = zamowienie(db);
    for (let i = 1; i <= 7; i += 1) wpis(db, id, `a${i}`, `w${i}`);
    const p1 = historiaLogu(db, id, { strona: 1, naStrone: 3 });
    expect(p1.wpisy.map((w) => w.akcja)).toEqual(['a7', 'a6', 'a5']);
    expect(p1.maStarsze).toBe(true);
    const p3 = historiaLogu(db, id, { strona: 3, naStrone: 3 });
    expect(p3.wpisy.map((w) => w.akcja)).toEqual(['a1']);
    expect(p3.maStarsze).toBe(false);
    expect(historiaLogu(db, id, { strona: 4, naStrone: 3 }).wpisy).toEqual([]);
  });
});
