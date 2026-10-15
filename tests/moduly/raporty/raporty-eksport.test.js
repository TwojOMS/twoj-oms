import { describe, it, expect, beforeEach } from 'vitest';

import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';
import { sprzedazWOkresie } from '../../pomoc/raporty-parytetu.js';

const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const BOM = String.fromCharCode(65279);

let db;

beforeEach(() => {
  db = openOmsDb(':memory:');
  for (const k of KANALY) ustawGranice(db, k, '2026-07-02', 'test', null);

  // Czerwiec — WYLACZNIE historia z Apilo. To jest pulapka tego eksportu: zamowien z tego
  // miesiaca NIE MA w tabeli `zamowienia`, wiec plik liczony z samych zamowien panelu bylby
  // pusty i wygladalby jak „nie bylo sprzedazy".
  zapiszHistorie(db, {
    apiloId: 'WO260600001', platformAccountId: 9, numer: '27001', dzien: '2026-06-10',
    utworzoneAt: '2026-06-10T10:00:00.000Z', brutto: '246.00', tagi: [], status: 15,
    paymentStatus: 2, klientEmail: 'k@klient.pl', klientNazwa: 'Klient Testowy', faktura: 1,
    pozycje: [{ nazwa: 'Szablon', ilosc: 1, bruttoLinii: '246.00', typ: 1 }],
  });
  zapiszHistorie(db, {
    apiloId: 'AL260600002', platformAccountId: 3, numer: '27002', dzien: '2026-06-12',
    utworzoneAt: '2026-06-12T10:00:00.000Z', brutto: '100.00', tagi: [], status: 15,
    paymentStatus: 2, klientEmail: 'inny@klient.pl', klientNazwa: 'Drugi', faktura: 0,
    pozycje: [{ nazwa: 'Szablon B', ilosc: 1, bruttoLinii: '100.00', typ: 1 }],
  });
  // Zamowienie PANELU po granicy — w tym samym pliku, gdy zakres obejmuje obie epoki.
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, indywidualne)'
    + " VALUES ('szkicownia', 9001, '28500', '123.00', '2026-07-10 12:00:00', 0)",
  ).run();
});

const wejdz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};

/** Kwoty brutto z pliku, w groszach — czytane tak, jak przeczyta je arkusz. */
const bruttoZPliku = (body) => body
  .replace(BOM, '')
  .split(String.fromCharCode(13) + String.fromCharCode(10))
  .slice(1)
  .filter(Boolean)
  .map((w) => Math.round(Number(w.split(';')[4].replace(',', '.')) * 100));

describe('eksport CSV z raportów', () => {
  it('oddaje plik do pobrania: typ, nazwa z zakresem i BOM dla Excela', async () => {
    const odp = await wejdz('/raporty/eksport.csv?od=2026-06-01&do=2026-06-30');
    expect(odp.statusCode).toBe(200);
    expect(odp.headers['content-type']).toContain('text/csv');
    expect(odp.headers['content-type']).toContain('utf-8');
    expect(odp.headers['content-disposition']).toContain('attachment');
    expect(odp.headers['content-disposition']).toContain('sprzedaz-2026-06-01_2026-06-30.csv');
    // ⚠️ BEZ BOM-u Excel czyta plik jako windows-1250 i „Kanał" staje się „KanaÅ‚".
    expect(odp.body.startsWith(BOM)).toBe(true);
  });

  it('OBEJMUJE HISTORIĘ Z APILO — bez niej czerwiec byłby pustym plikiem', async () => {
    const odp = await wejdz('/raporty/eksport.csv?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('27001');
    expect(odp.body).toContain('27002');
    expect(odp.body).toContain('Apilo');
    expect(bruttoZPliku(odp.body)).toHaveLength(2);
  });

  it('liczy TO SAMO, co ekran — co do grosza, przez obie epoki', async () => {
    const zakres = { od: '2026-06-01', do: '2026-07-31' };
    const zEkranu = sprzedazWOkresie(db, zakres)
      .reduce((s, w) => s + w.bruttoGrosze, 0);
    const odp = await wejdz(`/raporty/eksport.csv?od=${zakres.od}&do=${zakres.do}`);
    const zPliku = bruttoZPliku(odp.body).reduce((s, g) => s + g, 0);
    expect(zPliku).toBe(zEkranu);
    // Obie epoki naprawdę są w pliku, więc porównanie nie jest tautologią na pustym zbiorze.
    expect(odp.body).toContain('Apilo');
    expect(odp.body).toContain('OMS');
  });

  it('domyślnie nie wynosi adresów klientów, a z klient=1 je dokłada', async () => {
    const bez = await wejdz('/raporty/eksport.csv?od=2026-06-01&do=2026-06-30');
    expect(bez.body).not.toContain('k@klient.pl');
    const z = await wejdz('/raporty/eksport.csv?od=2026-06-01&do=2026-06-30&klient=1');
    expect(z.body).toContain('k@klient.pl');
  });

  // ⚠️ TA SAMA REGULA, CO NA EKRANIE: zla data i odwrocony zakres to BLAD, nie pusty plik.
  // Plik z zerem wierszy wyglada jak „nie bylo sprzedazy" i nikt go nie zakwestionuje.
  it('zła data odmawia zamiast oddać pusty plik', async () => {
    const odp = await wejdz('/raporty/eksport.csv?od=2026-02-30&do=2026-06-30');
    expect(odp.statusCode).toBe(400);
  });

  it('odwrócony zakres odmawia', async () => {
    const odp = await wejdz('/raporty/eksport.csv?od=2026-06-30&do=2026-06-01');
    expect(odp.statusCode).toBe(400);
  });

  // Bez przycisku eksport istnieje wylacznie dla tego, kto zna adres — czyli dla nikogo.
  it('ekran ma odnośnik do pobrania z ZACHOWANYM zakresem', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    // Goly `&` w adresie — tak samo, jak buduje odnosniki reszta panelu (faktury.ejs).
    expect(odp.body).toContain('/raporty/eksport.csv?od=2026-06-01&do=2026-06-30');
  });

  it('odnośnik zachowuje też skrót, a nie tylko zakres dat', async () => {
    const odp = await wejdz('/raporty?skrot=poprzedni-miesiac');
    expect(odp.body).toContain('/raporty/eksport.csv?od=');
  });

  it('bez parametrów bierze ten sam skrót, co ekran (bieżący miesiąc)', async () => {
    const odp = await wejdz('/raporty/eksport.csv');
    expect(odp.statusCode).toBe(200);
    expect(odp.headers['content-disposition']).toContain('sprzedaz-');
  });
});
