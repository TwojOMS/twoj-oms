import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  zwrotyZamowienia, dodajZwrot, oznaczPieniadzeOddane, zarezerwujKorekte, zapiszKorekte,
} from '../../../src/oms/db/zwroty.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';

// Ksztalt wziety z tests/oms/api-sprzedaz.test.js — `buildOmsServer` NIE jest asynchroniczne,
// a config ma `auth: { user, pass }` (nie `authUser`/`authPass`).
// ⚠️ Rozbieznosc z briefem: brakowalo naglowka `origin` — POST bez niego odbija sie o CSRF
// (403 z security/csrf.js), zanim w ogole dotrze do trasy. Ta sama poprawka, co w
// tests/oms/web-pozycje.test.js. Brakowalo tez `content-type` — bez niego @fastify/formbody
// nie parsuje ciala i POST odbija sie o 415 (wzorem tests/oms/koszty-trasy.test.js: AUTH_POST).
const AUTH = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

// Slad w logu zamowienia — I5. Sortujemy po `id`, nie po `at`: `at` ma rozdzielczosc
// milisekundy i dwa wpisy z tej samej milisekundy ustawilyby sie w dowolnej kolejnosci
// (ta sama zasada, co w `ostatniWpisLogu` w db/zamowienia.js).
const log = (zamowienieId) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(zamowienieId);

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '317.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  // ⚠️ DOPISANE 2026-08-15 (dwa kroki ekranu zwrotu). Bez kosztu dostawy fikstura nie miala
  // czego proponowac w polu „Zwrot kosztu dostawy", a 198,00 + 100,90 + 19,00 to dokladnie
  // `kwota_brutto` — zamowienie zaczyna sie w koncu zgadzac samo ze soba.
  koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45',
  utworzone_at: '2026-08-01T10:00:00',
  pozycje: [
    { zrodlo_id: 77, nazwa: 'Kot 70x100', sku: 'PRO-KOT-001', ilosc: 2, cena_brutto: '99.00', brutto_linii: '198.00', vat: null },
    { zrodlo_id: 78, nazwa: 'Pies 50x70', sku: 'PRO-PIES-001', ilosc: 1, cena_brutto: '100.90', brutto_linii: '100.90', vat: null },
  ],
  ...nad,
});

let db;
let app;
let id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Rozbieznosc z briefem: `zapiszZamowienie` oddaje LICZBOWE `id` wprost (return id
  // w db/zamowienia.js), nie obiekt { id } — ta sama pulapka, co w tests/oms/zwroty-db.test.js
  // i tests/oms/zwrot-status.test.js. `.id` na liczbie dawaloby `undefined` i psulo fikture cicho.
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
  app = buildOmsServer({ db, config: CONFIG });
});

// ⚠️ KOLOR NA PROSBE WŁAŚCICIELA (01.09.2026: „zrób na czerwono lub jakiś inny wyraźny kolor").
// Wyglad rozstrzyga WYLACZNIE klasa w HTML-u i regula w arkuszu, wiec cala suita byla na to
// slepa — zdjecie klasy przechodzilo na zielono (zmierzone mutacja). Test sprawdza OBIE
// warstwy, bo sama klasa bez reguly nie farbuje niczego.
describe('karta: „Zarejestruj zwrot" jest wyróżniony kolorem', () => {
  it('odnośnik na karcie niesie klasę btn--groza, a arkusz ją farbuje', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<a class="btn btn--maly btn--groza" href="\/zamowienia\/\d+\/zwrot">Zarejestruj zwrot<\/a>/);
    // ⚠️ WSZYSTKIE reguly konczace sie na `.btn--groza {`, nie pierwsza z brzegu: arkusz ma
    // takze wariant kontekstowy (`.belka-masowa .btn--groza`, sam `color`), a on stoi wyzej.
    const reguly = [...r.body.matchAll(/\.btn--groza\s*\{([^}]*)\}/g)];
    expect(reguly.length).toBeGreaterThan(0);
    expect(reguly.some((x) => /background:\s*var\(--blad-tekst\)/.test(x[1]))).toBe(true);
  });
});

describe('ekran zwrotu', () => {
  it('niesie kontekst listy przez oba kroki i wraca z karty do tego samego wiersza', async () => {
    const powrot = '/?status=nowe&kanal=pro';
    const ekran = await app.inject({
      method: 'GET', url: `/zamowienia/${id}/zwrot?powrot=${encodeURIComponent(powrot)}`, headers: AUTH,
    });
    expect(ekran.body).toContain(`<input type="hidden" name="powrot" value="/?status=nowe&amp;kanal=pro">`);
    expect(ekran.body).toContain(`href="/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro"`);

    const podglad = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot/podglad`, headers: AUTH,
      payload: new URLSearchParams([
        ['powrot', powrot], ['data', '2026-08-14'], ['kwota_dostawy', ''], ['powod', 'nie pasuje'],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
        ['klucz', 's78'], ['ilosc', '0'], ['nazwa', 'Pies 50x70'], ['pozycja_kwota', '0'],
      ]).toString(),
    });
    expect(podglad.body).toContain(`<input type="hidden" name="powrot" value="/?status=nowe&amp;kanal=pro">`);

    const zapis = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: new URLSearchParams([
        ['powrot', powrot], ['data', '2026-08-14'], ['kwota', '99.00'], ['kwota_dostawy', ''],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
        ['klucz', 's78'], ['ilosc', '0'], ['nazwa', 'Pies 50x70'], ['pozycja_kwota', '0'],
      ]).toString(),
    });
    expect(zapis.statusCode).toBe(302);
    expect(zapis.headers.location).toBe(`/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro`);
  });

  it('pokazuje pozycje zamowienia z polem ilosci', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Kot 70x100');
    expect(r.body).toContain('name="ilosc"');
    expect(r.body).toContain('value="s77"');
  });

  it('zapisuje zwrot czesciowy i wraca na karte', async () => {
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: new URLSearchParams([
        ['data', '2026-08-14'], ['kwota', '99.00'], ['kwota_dostawy', ''], ['powod', 'nie pasuje'],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
        ['klucz', 's78'], ['ilosc', '0'], ['nazwa', 'Pies 50x70'], ['pozycja_kwota', '0'],
      ]).toString(),
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    const lista = zwrotyZamowienia(db, id);
    expect(lista).toHaveLength(1);
    expect(lista[0].pozycje).toHaveLength(1);
  });

  // ⚠️ `pozycja_kwota` dopasowana do naglowkowej `kwota` (bariera spojnosci, 2026-08-15) —
  // inaczej ten POST odbijalby sie o NOWA barierę zamiast o barierę "przekracza kwotę
  // zamówienia", ktorej ma dowodzic.
  it('odmowa reguly wraca 400 z polskim komunikatem i NICZEGO nie zapisuje', async () => {
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: new URLSearchParams([
        ['data', '2026-08-14'], ['kwota', '31033'], ['kwota_dostawy', ''],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '31033'],
      ]).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/przekracza/i);
    expect(zwrotyZamowienia(db, id)).toEqual([]);
  });

  it('nieistniejace zamowienie oddaje 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia/99999/zwrot', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------
// ⚠️⚠️ EKRAN NOWEGO ZWROTU MA DWA KROKI (prosba wlasciciela 2026-08-15: „Teraz nie widać kwot
// jakie mam wpisać — powinno być gdzieś podsumowanie zamówienia przed zwrotem. Kwota zwrotu
// (pozycje) — czy to liczy się samo?"). Do tego dnia NIE liczylo sie samo.
// ---------------------------------------------------------------------------------------

// Krotki skrot na cialo formularza kroku 1 — dokladnie te pola, ktore wysyla przegladarka.
const krok1 = (pary) => new URLSearchParams(pary).toString();

describe('ekran zwrotu — KROK 1: podsumowanie zamowienia i wypelnione kwoty', () => {
  it('pokazuje cztery liczby nad tabela: wartosc zamowienia, dostawe, juz zwrocono, zostalo', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain('Wartość zamówienia');
    expect(r.body).toContain('W tym dostawa');
    expect(r.body).toContain('Już zwrócono');
    expect(r.body).toContain('Zostało do zwrotu');
    expect(r.body).toContain('317.90 zł');
    expect(r.body).toContain('19.00 zł');
  });

  // ⚠️ TO JEST SEDNO PROSBY. Do tego dnia pola startowaly na `value="0"` i operator wpisywal
  // KAZDA liczbe z palca, nie widzac zadnej z nich na ekranie.
  it('pola „Wraca (szt.)" i „Kwota zwrotu" sa JUZ WYPELNIONE tym, co moze wrocic', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain('name="ilosc" min="0" max="2" step="1" value="2"');
    expect(r.body).toContain('name="pozycja_kwota" inputmode="decimal" value="198.00"');
    expect(r.body).toContain('name="ilosc" min="0" max="1" step="1" value="1"');
    expect(r.body).toContain('name="pozycja_kwota" inputmode="decimal" value="100.90"');
  });

  it('pokazuje cene jednostkowa z zamowienia', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain('Cena jedn.');
    expect(r.body).toContain('99.00 zł');
  });

  it('pozycja zwrocona wczesniej w CALOSCI ma zero sztuk i nie da sie jej podniesc', async () => {
    dodajZwrot(db, id, {
      data: '2026-08-10',
      kwota: '198.00',
      pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 2, kwota: '198.00' }],
    });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain('name="ilosc" min="0" max="0" step="1" value="0"');
    expect(r.body).toContain('198.00 zł');
  });

  it('checkbox dostawy jest ZAZNACZONY, a kwota wypelniona kosztem z zamowienia', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain('name="zwroc_dostawe" value="1" checked');
    expect(r.body).toContain('name="kwota_dostawy" inputmode="decimal" value="19.00"');
  });

  // ⚠️ Bariera sumy odbilaby to i tak, ale ekran nie ma PROPONOWAC czegos, co sie nie uda.
  it('dostawa oddana we wczesniejszym zwrocie: checkbox odznaczony i kwota pusta', async () => {
    dodajZwrot(db, id, { data: '2026-08-10', kwota: '0.00', kwotaDostawy: '19.00', pozycje: [] });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toContain('name="zwroc_dostawe" value="1" checked');
    expect(r.body).toContain('name="kwota_dostawy" inputmode="decimal" value=""');
    expect(r.body).toContain('Koszt dostawy wrócił już przy wcześniejszym zwrocie');
  });

  // ⚠️ Wzorzec musi objac `<input`, a nie sam `name="kwota"`: arkusz stylow wklejany w kazda
  // strone (layout-oms.ejs) ma regule `.wplata-szybka input[name="kwota"]` i samo szukanie
  // napisu trafialoby W CSS — czyli test bylby ZAWSZE czerwony z powodu, ktory nie ma
  // z ekranem zwrotu nic wspolnego.
  it('krok 1 NIE PYTA juz o kwote laczna — liczy ja serwer', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toMatch(/<input[^>]*name="kwota"/);
    expect(r.body).toContain('Dalej — sprawdź sumę');
  });

  // ⚠️ Jedynym dopuszczonym skryptem jest wspólna OBSŁUGA MENU. Ekran nadal nie może
  // dostać skryptu przeliczającego sumę na żywo, bo wtedy drugi krok stałby się ozdobą.
  it('ekran zwrotu ma tylko wspólny skrypt nawigacji, bez logiki przeliczania', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []).toEqual([
      '<script type="module" src="/public/oms-nawigacja.js"></script>',
    ]);
  });
});

describe('ekran zwrotu — KROK 2: sume liczy SERWER', () => {
  const cialoPelne = () => krok1([
    ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '2'], ['pozycja_kwota', '198.00'],
    ['klucz', 's78'], ['nazwa', 'Pies 50x70'], ['ilosc', '1'], ['pozycja_kwota', '100.90'],
    ['zwroc_dostawe', '1'], ['kwota_dostawy', '19.00'],
    ['data', '2026-08-14'], ['powod', 'nie pasuje'],
  ]);

  it('wypisuje co wraca, dostawe osobno i RAZEM — a NICZEGO nie zapisuje', async () => {
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot/podglad`, headers: AUTH, payload: cialoPelne(),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Kot 70x100');
    expect(r.body).toContain('RAZEM');
    // 198,00 + 100,90 + 19,00 dostawy — operator nie wpisal ani jednej z tych sum.
    expect(r.body).toContain('317.90 zł');
    expect(r.body).toContain('Koszt dostawy');
    expect(zwrotyZamowienia(db, id)).toEqual([]);
  });

  it('niesie kwote laczna w polu ukrytym, a „Zarejestruj zwrot" zapisuje ja bez zmian', async () => {
    const podglad = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot/podglad`, headers: AUTH, payload: cialoPelne(),
    });
    expect(podglad.body).toContain('<input type="hidden" name="kwota" value="298.90">');
    const zapis = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '2'], ['pozycja_kwota', '198.00'],
        ['klucz', 's78'], ['nazwa', 'Pies 50x70'], ['ilosc', '1'], ['pozycja_kwota', '100.90'],
        ['kwota', '298.90'], ['kwota_dostawy', '19.00'],
        ['data', '2026-08-14'], ['powod', 'nie pasuje'],
      ]),
    });
    expect(zapis.statusCode).toBe(302);
    const [w] = zwrotyZamowienia(db, id);
    expect(w.kwota).toBe('298.90');
    expect(w.kwota_dostawy).toBe('19.00');
  });

  // ⚠️ ODZNACZONY CHECKBOX ZERUJE DOSTAWE. Pole kwoty zostaje wypelnione podpowiedzia nawet
  // wtedy, gdy checkbox jest odznaczony (zeby ponowne zaznaczenie nie kazalo szukac kwoty),
  // wiec bez tej reguly panel oddalby koszt dostawy, ktorego nikt nie zaznaczyl.
  it('odznaczony checkbox dostawy zeruje dostawe, mimo wypelnionego pola kwoty', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '2'], ['pozycja_kwota', '198.00'],
        ['klucz', 's78'], ['nazwa', 'Pies 50x70'], ['ilosc', '0'], ['pozycja_kwota', '100.90'],
        ['kwota_dostawy', '19.00'], ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.body).toContain('nie wraca');
    expect(r.body).toContain('<input type="hidden" name="kwota_dostawy" value="">');
    expect(r.body).toContain('198.00 zł');
  });

  it('przyjmuje przecinek dziesietny w kwocie przy pozycji — to on stoi na Allegro', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '1'], ['pozycja_kwota', '99,00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<input type="hidden" name="kwota" value="99.00">');
  });

  // ⚠️⚠️ BARIERA SPOJNOSCI ZOSTAJE STRAZNIKIEM. Kwoty laczej operator juz nie wpisuje, wiec
  // przy normalnej pracy ta bariera nikogo nie odrzuca — ale miedzy krokiem 2 a zapisem obie
  // liczby jada w POLACH UKRYTYCH, a `POST /zwrot` przyjmuje cialo od kogokolwiek (druga
  // otwarta karta, back+resubmit, recznie sklecony POST). Bez tego testu bariera bez ekranu,
  // ktory ja wywoluje, wygladalaby jak bariera usunieta.
  it('podmieniona kwota w polu ukrytym odbija sie o bariere spojnosci i NIC sie nie zapisuje', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '2'], ['pozycja_kwota', '198.00'],
        ['kwota', '79.00'], ['kwota_dostawy', ''],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie zgadza się/i);
    expect(zwrotyZamowienia(db, id)).toEqual([]);
  });

  it('odmowa reguly wraca na KROK 1 z zachowanymi wartosciami, nie na goly ekran bledu', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '9'], ['pozycja_kwota', '198.00'],
        ['data', '2026-08-14'], ['powod', 'za duzo sztuk'],
      ]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/do zwrotu zostało 2 sztuk/i);
    expect(r.body).toContain('value="9"');
    expect(r.body).toContain('value="za duzo sztuk"');
    expect(zwrotyZamowienia(db, id)).toEqual([]);
  });
});

// ⚠️⚠️ „WSTECZ — POPRAW" NIE MA PRAWA NICZEGO ZGUBIC. Bez javascriptu w przegladarce jedynym
// nosnikiem wpisanych liczb sa pola ukryte kroku 2 — a operator, ktory chce poprawic JEDNA
// liczbe, nie ma wpisywac wszystkich od nowa.
describe('ekran zwrotu — „Wstecz — popraw" z kroku 2', () => {
  it('odtwarza formularz z wpisanymi wartosciami — razem z RECZNIE WYZEROWANA pozycja', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot/popraw`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '1'], ['pozycja_kwota', '99.00'],
        ['klucz', 's78'], ['nazwa', 'Pies 50x70'], ['ilosc', '0'], ['pozycja_kwota', '100.90'],
        ['kwota', '99.00'], ['kwota_dostawy', '19.00'], ['zwroc_dostawe', '1'],
        ['data', '2026-08-12'], ['powod', 'uszkodzony w transporcie'],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="ilosc" min="0" max="2" step="1" value="1"');
    expect(r.body).toContain('name="pozycja_kwota" inputmode="decimal" value="99.00"');
    // ⚠️ Wyzerowana RECZNIE pozycja ma zostac wyzerowana — cofniecie jej do podpowiedzi
    // („wraca cala pozostala ilosc") kasowaloby decyzje operatora.
    expect(r.body).toContain('name="ilosc" min="0" max="1" step="1" value="0"');
    expect(r.body).toContain('value="2026-08-12"');
    expect(r.body).toContain('value="uszkodzony w transporcie"');
    expect(r.body).toContain('name="zwroc_dostawe" value="1" checked');
  });

  it('odznaczona dostawa wraca odznaczona', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot/popraw`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '2'], ['pozycja_kwota', '198.00'],
        ['kwota', '198.00'], ['kwota_dostawy', ''],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.body).not.toContain('name="zwroc_dostawe" value="1" checked');
  });
});

// ⚠️⚠️ RABAT NA LINII: CENA JEDNOSTKOWA × SZTUKI NIE ROWNA SIE WARTOSCI LINII. Osobne
// zamowienie, bo fikstura wyzej rabatu nie ma — a bez rabatu ten blad jest NIEWIDOCZNY.
describe('ekran zwrotu — pozycja z RABATEM', () => {
  let idRabat;
  beforeEach(() => {
    idRabat = zapiszZamowienie(db, 'pro', zmapowane({
      zrodlo_id: 1302,
      numer: '1302',
      kwota_brutto: '139.00',
      koszt_dostawy_brutto: '19.00',
      koszt_dostawy_netto: null,
      pozycje: [
        // 3 × 35,00 = 105,00, ale sklep policzyl linie na 100,00 (rabat 5,00).
        { zrodlo_id: 91, nazwa: 'Zestaw 3x', sku: 'Z3', ilosc: 3, cena_brutto: '35.00', brutto_linii: '100.00', vat: null },
        { zrodlo_id: 92, nazwa: 'Ramka', sku: 'RM', ilosc: 1, cena_brutto: '20.00', brutto_linii: '20.00', vat: null },
      ],
    }), {});
  });

  it('krok 1 podpowiada WARTOSC LINII, a nie iloczyn ceny przez sztuki', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idRabat}/zwrot`, headers: AUTH });
    expect(r.body).toContain('name="pozycja_kwota" inputmode="decimal" value="100.00"');
    expect(r.body).not.toContain('name="pozycja_kwota" inputmode="decimal" value="105.00"');
  });

  it('zwrot CALOSCI schodzi sie z zamowieniem co do grosza — RAZEM rowne wartosci zamowienia', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '3'], ['pozycja_kwota', '100.00'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '1'], ['pozycja_kwota', '20.00'],
        ['zwroc_dostawe', '1'], ['kwota_dostawy', '19.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.body).toContain('139.00 zł');
    expect(r.body).not.toContain('144.00 zł');
  });

  // Pierwszy zwrot bierze 1 z 3 sztuk (33,33 zl), drugi ma wziac RESZTE (66,67 zl) — trzy razy
  // po 33,33 zl to 99,99 zl, czyli o grosz mniej niz linia. Ten grosz zostaje na fakturze
  // korygujacej, wiec ma sie zgadzac.
  it('DRUGI zwrot proponuje reszte, a nie iloczyn — suma obu rowna wartosci linii', async () => {
    dodajZwrot(db, idRabat, {
      data: '2026-08-10',
      kwota: '33.33',
      pozycje: [{ klucz_pozycji: 's91', nazwa: 'Zestaw 3x', ilosc: 1, kwota: '33.33' }],
    });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idRabat}/zwrot`, headers: AUTH });
    expect(r.body).toContain('name="ilosc" min="0" max="2" step="1" value="2"');
    expect(r.body).toContain('name="pozycja_kwota" inputmode="decimal" value="66.67"');
    expect(r.body).toContain('Już zwrócono');
    expect(r.body).toContain('33.33 zł');
  });
});

// ---------------------------------------------------------------------------------------
// ⚠️⚠️⚠️ WADA KRYTYCZNA Z RECENZJI 2026-08-15: KWOTA NIE PODAZALA ZA ILOSCIA.
//
// Zmierzone: pozycja „Zestaw 3x", 3 szt., `brutto_linii` 100,00 (rabat — cena jednostkowa
// 35,00). Operator ustawia „wraca 1", kwoty nie rusza (bo stoi tam wiarygodna liczba, a pod
// tabela zdanie, ktore do niej przekonuje). Zapisywal sie ZWROT 100,00 ZL ZA 1 Z 3 SZTUK.
// Przechodzil wszystkie bariery, bo suma zgadzala sie sama ze soba — a `zwrotyWOkresie`
// zdejmowalo z przychodu 100,00 zl zamiast 33,33 i `paryKorekty` skladalo korekte „z 3 szt. /
// 100,00 zl na 2 szt. / 0,00 zl" — dokument u organu.
// ---------------------------------------------------------------------------------------
describe('ekran zwrotu — kwota PODAZA ZA ILOSCIA (pozycja z RABATEM)', () => {
  let idRabat;
  beforeEach(() => {
    idRabat = zapiszZamowienie(db, 'pro', zmapowane({
      zrodlo_id: 1303,
      numer: '1303',
      kwota_brutto: '139.00',
      koszt_dostawy_brutto: '19.00',
      koszt_dostawy_netto: null,
      pozycje: [
        // 3 × 35,00 = 105,00, ale sklep policzyl linie na 100,00 (rabat 5,00).
        { zrodlo_id: 91, nazwa: 'Zestaw 3x', sku: 'Z3', ilosc: 3, cena_brutto: '35.00', brutto_linii: '100.00', vat: null },
        { zrodlo_id: 92, nazwa: 'Ramka', sku: 'RM', ilosc: 1, cena_brutto: '20.00', brutto_linii: '20.00', vat: null },
      ],
    }), {});
  });

  // ⚠️ POLE UKRYTE Z PROPOZYCJA jest calym nosnikiem tej naprawy: bez niego krok 2 nie ma jak
  // odroznic kwoty, ktorej operator NIE TKNAL, od kwoty, ktora sam wpisal.
  it('krok 1 niesie na krok 2 kwote, KTORA PANEL ZAPROPONOWAL', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idRabat}/zwrot`, headers: AUTH });
    expect(r.body).toContain('<input type="hidden" name="pozycja_kwota_propozycja" value="100.00">');
    expect(r.body).toContain('<input type="hidden" name="pozycja_kwota_propozycja" value="20.00">');
  });

  it('zmiana sztuk BEZ dotkniecia kwoty daje 33.33, a nie 100.00 i nie 35.00', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '1'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '100.00'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '0'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<input type="hidden" name="pozycja_kwota" value="33.33">');
    expect(r.body).toContain('<input type="hidden" name="kwota" value="33.33">');
    expect(r.body).toContain('33.33 zł');
    // ⚠️ Wzorce OBEJMUJA ZNACZNIKI, a nie sam napis (zaostrzone 2026-08-15 przy I1): od kiedy
    // krok 2 MOWI o przeliczeniu („panel przeliczył 100.00 → 33.33 zł […] naprawdę wyszło
    // 100.00 zł"), goly napis „100.00 zł" stoi w tresci ostrzezenia — i szukanie go zapalaloby
    // test na czerwono za zdanie, ktore jest tu POZADANE. Sprawdzamy to, o co naprawde chodzi:
    // ze 100,00 zl nie jest KWOTA, ktora ten zwrot niesie do zapisu ani ktora stoi w tabeli.
    expect(r.body).not.toContain('<input type="hidden" name="pozycja_kwota" value="100.00">');
    expect(r.body).not.toContain('<input type="hidden" name="kwota" value="100.00">');
    expect(r.body).not.toContain('>100.00 zł<');
    expect(r.body).not.toContain('>35.00 zł<');
  });

  // ⚠️⚠️ WADA WAZNA I1 (recenzja kontrolna 2026-08-15): PRZELICZENIE BYLO CICHE. Operator,
  // ktory zostawil 100,00 zl SWIADOMIE (bo tyle Allegro naprawde oddalo kupujacemu przy zwrocie
  // 1 z 3 szt. — gest, wyrownanie kosztu odeslania), dostawal zapis na 33,33 zl bez slowa.
  // Ostrzezenie, nie odmowa: przycisk „Zarejestruj zwrot" zostaje.
  it('krok 2 MOWI, ze przeliczyl kwote — z obiema liczbami i z powodem', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '1'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '100.00'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '0'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/panel przeliczył 100\.00 → 33\.33 zł/);
    expect(r.body).toContain('1 z 3 szt.');
    expect(r.body).toContain('Zarejestruj zwrot');
  });

  // Zwrot CALOSCI idzie ta sama sciezka „operator kwoty nie tknal" — i wychodzi z niej z ta
  // sama kwota. Zdanie o przeliczeniu, ktore niczego nie zmienilo, uczyloby tylko tego, zeby
  // zdan na tym ekranie nie czytac.
  it('krok 2 MILCZY, gdy przeliczenie niczego nie zmienilo', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '3'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '100.00'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '1'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/przeliczył/);
  });

  // Cala droga: krok 1 → krok 2 → zapis. To, co zobaczyl operator, ma byc tym, co wpadlo do bazy.
  it('zapis po kroku 2 laduje w bazie jako 33.33 — nie 100.00 za jedna z trzech sztuk', async () => {
    const podglad = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '1'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '100.00'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '0'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', 'jedna sztuka wraca'],
      ]),
    });
    expect(podglad.statusCode).toBe(200);
    const zapis = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '1'], ['pozycja_kwota', '33.33'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '0'], ['pozycja_kwota', '20.00'],
        ['kwota', '33.33'], ['kwota_dostawy', ''],
        ['data', '2026-08-14'], ['powod', 'jedna sztuka wraca'],
      ]),
    });
    expect(zapis.statusCode).toBe(302);
    const [w] = zwrotyZamowienia(db, idRabat);
    expect(w.kwota).toBe('33.33');
    expect(w.pozycje).toEqual([
      expect.objectContaining({ klucz_pozycji: 's91', ilosc: 1, kwota: '33.33' }),
    ]);
  });

  // ⚠️ CZLOWIEK WYGRYWA (decyzja wlasciciela: „kwotę przepisujesz z Allegro i to ONA jest
  // prawdą") — ale krok 2 MA TO POKAZAC. Ostrzezenie, nie odmowa.
  it('recznie zmieniona kwota wygrywa, ale krok 2 pokazuje obie liczby', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '1'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '33.33'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '0'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<input type="hidden" name="kwota" value="100.00">');
    expect(r.body).toContain('Zestaw 3x');
    expect(r.body).toMatch(/1 z 3 szt/);
    expect(r.body).toMatch(/33\.33/);
    // Przycisk zapisu ZOSTAJE — to ostrzezenie, nie odmowa.
    expect(r.body).toContain('Zarejestruj zwrot');
  });

  // ⚠️⚠️ ODMOWA REGULY NIE MA PRAWA COFNAC PRZELICZENIA. Krok 2 odsyla na krok 1 wartosci PO
  // przeliczeniu — inaczej kwota, ktora panel wlasnie policzyl dla nowej liczby sztuk, wracalaby
  // na ekran w starej postaci (100,00 zl przy 1 z 3 szt.), przy nastepnym podejsciu wygladalaby
  // jak „wpisana recznie" i przestalaby podazac za iloscia. Wada krytyczna wracalaby bocznymi
  // drzwiami przy KAZDEJ odmowie reguly — a odmowa reguly jest na tym ekranie zwyczajna.
  it('po odmowie reguly krok 1 pokazuje kwote JUZ PRZELICZONA, razem z jej propozycja', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '1'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '100.00'],
        // Ramka jest jedna, a tu wraca ich piec — odmowa przyjdzie od bariery sztuk.
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '5'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', 'pomylka w sztukach'],
      ]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/do zwrotu zostało 1 sztuk/i);
    expect(r.body).toContain('name="pozycja_kwota" inputmode="decimal" value="33.33"');
    expect(r.body).toContain('<input type="hidden" name="pozycja_kwota_propozycja" value="33.33">');
    // Bledna liczba sztuk ZOSTAJE do poprawienia — to ja operator przyszedl naprawic.
    expect(r.body).toContain('name="ilosc" min="0" max="1" step="1" value="5"');
  });

  // Krok 2 ma tę samą granicę: skrypt menu jest wspólnym sterowaniem, a suma nadal
  // przychodzi wyłącznie z serwera i nie dostaje kodu przeliczającego w przeglądarce.
  it('krok 2 ma tylko wspólny skrypt nawigacji, bez logiki przeliczania', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idRabat}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's91'], ['nazwa', 'Zestaw 3x'], ['ilosc', '3'], ['pozycja_kwota', '100.00'], ['pozycja_kwota_propozycja', '100.00'],
        ['klucz', 's92'], ['nazwa', 'Ramka'], ['ilosc', '1'], ['pozycja_kwota', '20.00'], ['pozycja_kwota_propozycja', '20.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []).toEqual([
      '<script type="module" src="/public/oms-nawigacja.js"></script>',
    ]);
  });
});

// ⚠️⚠️ WADA WAZNA Z RECENZJI 2026-08-15: PROPOZYCJA BYWALA ODBIJANA PRZEZ WLASNA BARIERE PANELU.
// Zmierzone: pozycje 198,00 + 100,90 + dostawa 19,00 przy `kwota_brutto = '317.00'` — kafel
// mowil „Zostało do zwrotu 317,00 zł", pola wypelnialy sie na 317,90 i zapis odbijal sie
// komunikatem „Suma zwrotów (317,90 zł) przekracza kwotę zamówienia (317,00 zł)". Operator
// dostawal odmowe za liczby, ktorych nie wpisal, i nie mial jak zgadnac, ktora pozycje sciac
// o 90 groszy.
describe('ekran zwrotu — zamowienie, ktore nie sumuje sie samo ze soba', () => {
  let idNiespojne;
  beforeEach(() => {
    idNiespojne = zapiszZamowienie(db, 'pro', zmapowane({
      zrodlo_id: 1304, numer: '1304', kwota_brutto: '317.00',
    }), {});
  });

  it('krok 1 MOWI TO WPROST — z obiema liczbami i z roznica do sciecia', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idNiespojne}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('317.90');
    expect(r.body).toContain('317.00');
    expect(r.body).toContain('0.90');
    // Formularz ZOSTAJE — to ostrzezenie o tym, co sie nie uda, a nie zamkniecie ekranu.
    expect(r.body).toContain('Dalej — sprawdź sumę');
  });

  // ⚠️ Wzorzec MUSI pasowac do zdania, ktore panel naprawde pisze — inaczej test jest zielony
  // zawsze i o niczym nie swiadczy (zaostrzone 2026-08-15 przy M2, [[testy-falszywa-zielen]]).
  it('zamowienie zgodne samo ze soba nie dostaje zadnego takiego ostrzezenia', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toMatch(/za dużo, więc panel odmówi zapisu całości/i);
  });

  // ⚠️⚠️ DROBIAZG M2: zdanie na ekranie NIE ORZEKA o przyczynie. Panel zna trzy liczby (sume
  // podpowiedzi, „zostalo" i nadwyzke) i tylko o nich mowi — diagnoza „to zamówienie nie sumuje
  // się samo ze sobą" bywala nieprawdziwa, bo ten sam rozjazd robi wczesniejszy hojny zwrot.
  it('krok 1 nie zgaduje PRZYCZYNY rozjazdu', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idNiespojne}/zwrot`, headers: AUTH });
    expect(r.body).not.toMatch(/nie sumuje się samo ze sobą/i);
    expect(r.body).toMatch(/panel nie wie i nie zgaduje/i);
  });
});

// ⚠️ DROBIAZG 2 Z RECENZJI: zamowienie ANULOWANE dostawalo pelny, wypelniony formularz, a odmowe
// dopiero PO kliknieciu „Zarejestruj zwrot". Ekran ma powiedziec to od razu — i tym samym
// zdaniem, ktore oddaje `parsujZwrot`.
describe('ekran zwrotu — zamowienie anulowane', () => {
  it('mowi o anulowaniu od razu na kroku 1 i NIE rysuje formularza', async () => {
    const idAnulowane = zapiszZamowienie(db, 'pro', zmapowane({
      zrodlo_id: 1305, numer: '1305', anulowane: 1,
    }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idAnulowane}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/anulowane — nie ma czego zwracać/i);
    expect(r.body).not.toContain('Dalej — sprawdź sumę');
    expect(r.body).not.toMatch(/<input[^>]*name="pozycja_kwota"/);
  });
});

// ⚠️ DROBIAZG 4 Z RECENZJI: `kwota_dostawy` nie miala sufitu — recznie sklecony POST zapisywal
// zwrot dostawy 139,00 zl przy dostawie 19,00 zl, a `paryKorekty` odmawialaby potem dokumentu
// na kwote, ktorej w zamowieniu nie ma. Zwrot zostawalby NIEROZLICZALNY.
// ⚠️⚠️ DROBIAZG M1 (recenzja kontrolna 2026-08-15): EKRAN I BARIERA ROZJECHALY SIE PRZY
// CZESCIOWYM ZWROCIE DOSTAWY. Bariera liczy RESZTE i pozwala oddac brakujace 10,00 zl z 19,00 zl,
// a ekran pisal „Koszt dostawy wrócił już przy wcześniejszym zwrocie — drugi raz nie wraca"
// i zostawial puste pole. Zdanie bylo NIEPRAWDA, a operator nie mial jak dojsc do reszty
// inaczej niz recznie sklecajac POST.
describe('ekran zwrotu — CZESCIOWY zwrot kosztu dostawy', () => {
  it('krok 1 proponuje RESZTE dostawy i mowi, ile juz wrocilo', async () => {
    dodajZwrot(db, id, { data: '2026-08-10', kwota: '0.00', kwotaDostawy: '9.00', pozycje: [] });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="kwota_dostawy" inputmode="decimal" value="10.00"');
    expect(r.body).toContain('name="zwroc_dostawe" value="1" checked');
    expect(r.body).not.toContain('drugi raz nie wraca');
    expect(r.body).toMatch(/wróciło już 9\.00 zł/);
  });

  // Dowod, ze ekran i bariera mowia juz JEDNO: reszta zaproponowana na kroku 1 przechodzi
  // przez zapis, zamiast odbic sie o sufit.
  it('zaproponowana reszta PRZECHODZI przez zapis — ekran nie klamie w zadna strone', async () => {
    dodajZwrot(db, id, { data: '2026-08-10', kwota: '0.00', kwotaDostawy: '9.00', pozycje: [] });
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '0'], ['pozycja_kwota', '0'],
        ['kwota', '0'], ['kwota_dostawy', '10.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(302);
    expect(zwrotyZamowienia(db, id).map((w) => w.kwota_dostawy)).toEqual(['9.00', '10.00']);
  });
});

// ⚠️⚠️ DROBIAZG I2 (recenzja kontrolna 2026-08-15): `/podglad` ODDAWALO 500 ZAMIAST ZDANIA.
// `kwotaZaSztukiGrosze` czytalo cene PRZED strazikiem `sztuki <= 0`, a trasa nie miala `try` —
// wiec pozycja bez ceny wywracala krok 2. Z ekranu nieosiagalne (krok 1 blokuje takie
// zamowienie wczesniej), ale sciezka POST istnieje, a ta warstwa ma NIGDY nie rzucac.
describe('ekran zwrotu — pozycja BEZ CENY', () => {
  let idBezCeny;
  beforeEach(() => {
    idBezCeny = zapiszZamowienie(db, 'pro', zmapowane({
      zrodlo_id: 1306,
      numer: '1306',
      pozycje: [
        { zrodlo_id: 95, nazwa: 'Bez ceny', sku: 'BC', ilosc: 3, cena_brutto: '', brutto_linii: null, vat: null },
      ],
    }), {});
  });

  it('krok 1 mowi, dlaczego nie da sie policzyc, i NIE rysuje formularza', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${idBezCeny}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/Brak kwoty/i);
    expect(r.body).not.toContain('Dalej — sprawdź sumę');
  });

  it('POST /podglad oddaje KOMUNIKAT, a nie 500', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${idBezCeny}/zwrot/podglad`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's95'], ['nazwa', 'Bez ceny'], ['ilosc', '1'], ['pozycja_kwota', '10.00'],
        ['pozycja_kwota_propozycja', '10.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Brak kwoty/i);
    expect(zwrotyZamowienia(db, idBezCeny)).toEqual([]);
  });
});

describe('ekran zwrotu — sufit zwrotu dostawy', () => {
  it('POST z kwota dostawy ponad koszt dostawy odbija sie i NIC sie nie zapisuje', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot`,
      headers: AUTH,
      payload: krok1([
        ['klucz', 's77'], ['nazwa', 'Kot 70x100'], ['ilosc', '0'], ['pozycja_kwota', '0'],
        ['kwota', '0'], ['kwota_dostawy', '139.00'],
        ['data', '2026-08-14'], ['powod', ''],
      ]),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/dostaw/i);
    expect(zwrotyZamowienia(db, id)).toEqual([]);
  });
});

describe('karta zamowienia — trzy elementy zwrotu', () => {
  // ⚠️ NAJWAZNIEJSZY TEST TEGO ZADANIA (prosba wlasciciela: „nie chce zeby zwroty zajmowaly
  // za duzo miejsca na ekranie karty zamowienia"). PRZEFORMULOWANY po poprawce Zadania 5:
  // karta dostala JEDEN staly odnosnik akcji „Zarejestruj zwrot" (patrz test nizej), wiec
  // wymog „ani slowa o zwrotach" nie da sie juz dosc doslownie — a nigdy o to nie chodzilo.
  // Wlasciwy wymog wlasciciela to brak PODSUMOWANIA: zadnej nowej sekcji, zadnego znacznika
  // z kwota, zadnego wiersza „Zwrócono…", zadnego wiersza korekty, zadnego naglowka sekcji
  // „Zwroty". Odnosnik akcji (jedna linia, bez tresci o TYM zwrocie) jest dozwolony i
  // POTWIERDZONY osobnym testem zaraz ponizej.
  it('karta BEZ zwrotu nie pokazuje zadnego PODSUMOWANIA zwrotow', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    // Brak znacznika z kwota przy statusie.
    expect(r.body).not.toMatch(/znacznik znacznik--zwrot">Zwrot/);
    // Brak wiersza „Zwrócono …” w platnosciach.
    expect(r.body).not.toMatch(/Zwrócono/);
    // Brak wiersza korekty w tabeli dokumentow.
    expect(r.body).not.toContain('<td>Korekta</td>');
    // Brak jakiegokolwiek naglowka sekcji „Zwroty" (dzisiaj sekcja go celowo nie ma —
    // gdyby ktos kiedys dopisal, ten test ma to zlapac).
    expect(r.body).not.toMatch(/<h2>\s*Zwroty\s*<\/h2>/i);
  });

  // Odnosnik akcji jest DOZWOLONYM WYJATKIEM od „karta bez zwrotu nie pokazuje niczego o
  // zwrocie" — to JEDYNE wejscie z karty na ekran /zamowienia/:id/zwrot (poprawka po
  // recenzji, patrz raport Zadania 5). Dwa osobne sprawdzenia: (1) odnosnik istnieje i (2)
  // jest DOKLADNIE JEDEN — spec mowi wprost „jeden odnosnik", nie sekcja ani kilka miejsc.
  it('karta BEZ zwrotu i tak zawiera JEDEN odnosnik akcji „Zarejestruj zwrot”, prowadzacy pod wlasciwy adres', async () => {
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.body).toContain('Zarejestruj zwrot');
    const adres = `href="/zamowienia/${id}/zwrot"`;
    const ile = (r.body.match(new RegExp(adres.replace(/[/]/g, '\\/'), 'g')) || []).length;
    expect(ile).toBe(1);
  });

  it('karta ZE zwrotem pokazuje znacznik z suma i wiersz w platnosciach', async () => {
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', kwotaDostawy: '19.00', pozycje: [] });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.body).toContain('Zwrot 118.00 zł');
    expect(r.body).toContain('Zwrócono 99.00 zł');
  });

  // ⚠️ Trzeci element (korekta w tabeli dokumentow) jest DZIS niedostepny przez zaden POST —
  // Zadanie 8 (wystawienie korekty w inFakcie) jeszcze nie istnieje (routes/zwroty.js:
  // `korekta = null`). Wiersz zapisujemy wiec WPROST przez SQL, tak jak inne testy karty
  // symuluja stan po dokumencie, ktorego trasa jeszcze nie umie wystawic (np.
  // web-lista.test.js: „wysłane zamówienie z fakturą do wyjaśnienia"). To sprawdza, ze
  // WIDOK jest gotowy na Zadanie 8 juz teraz.
  it('korekta zwrotu, gdy istnieje, jest wierszem w tabeli dokumentow', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, numer, utworzona_at) VALUES (?, ?, ?)')
      .run(id, 'FV/1/2026', '2026-08-01T10:00:00');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_numer = ? WHERE id = ?').run('KOR/1/2026', w.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.body).toContain('<td>Korekta</td>');
    expect(r.body).toContain('KOR/1/2026');
  });

  // Bez korekty (zwrot istnieje, ale nikt jej jeszcze nie wystawil) wiersz NIE rysuje sie —
  // ta sama zasada „nic, dopoki nie ma czego pokazac", co przy pastylce i wierszu platnosci.
  it('bez korekty tabela dokumentow nie dostaje wiersza „Korekta”', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, numer, utworzona_at) VALUES (?, ?, ?)')
      .run(id, 'FV/1/2026', '2026-08-01T10:00:00');
    dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.body).not.toContain('<td>Korekta</td>');
  });
});

// ⚠️ Liczniki AUTOINCREMENT roznych tabel zbiegaja sie w swiezej bazie (przewodnik OMS, 6.3;
// ten sam wzorzec, co `zamowienieZRozjechanymiLicznikami` w tests/oms/web-platnosci.test.js).
// Kilka zamowien-wypelniaczy PRZED „prawdziwym" zamowieniem odsuwa jego `id` od `id` zwrotow,
// zeby test pomylki argumentu (nizej) nie zaliczyl przypadkiem, przez to, ze oba liczniki
// akurat trafily na ta sama liczbe.
function zamowienieZRozjechanymiLicznikami(nad = {}) {
  for (let i = 0; i < 4; i += 1) {
    zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 9000 + i, numer: `900${i}` }), {});
  }
  return zapiszZamowienie(db, 'pro', zmapowane(nad), {});
}

describe('POST /zamowienia/:id/zwroty/:zwrotId/pieniadze', () => {
  it('oznacza pieniadze oddane i wraca na karte', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    expect(w.pieniadze_oddane_at).toBeFalsy();

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/pieniadze`, headers: AUTH,
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);

    const zapisany = zwrotyZamowienia(db, id).find((x) => x.id === w.id);
    expect(zapisany.pieniadze_oddane_at).toBeTruthy();
  });
});

describe('POST /zamowienia/:id/zwroty/:zwrotId/usun', () => {
  it('kasuje swiezy zwrot naprawde — znika z listy zwrotow zamowienia', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/usun`, headers: AUTH,
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(zwrotyZamowienia(db, id)).toEqual([]);
  });

  it('zwrot z oznaczonymi pieniedzmi dostaje ODMOWE (400) i zostaje', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    oznaczPieniadzeOddane(db, id, w.id);

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/usun`, headers: AUTH,
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/pieniądze zostały już oddane/);
    expect(zwrotyZamowienia(db, id)).toHaveLength(1);
  });

  // ⚠️ NAJWAZNIEJSZY TEST TEGO ZADANIA: zwrot NALEZACY do innego zamowienia nie da sie ruszyc
  // przez podanie cudzego `:id` w adresie. Trasy musza szukac po PARZE (id zwrotu, id
  // zamowienia) — sam `id` zwrotu przepuscilby pomylke argumentu. Fikstura ma DWA zamowienia
  // i ROZJECHANE liczniki po OBU stronach (zamowienia i zwroty), zeby id uzyte w tescie nie
  // zgodzilo sie przypadkiem z id zwrotu, ktory bedzie testowany — inaczej test zaliczylby sie
  // nawet z trasa, ktora nie sprawdza wlasciciela zwrotu wcale.
  it('zwrot innego zamowienia nie da sie ruszyc przez podanie cudzego :id', async () => {
    const a = zamowienieZRozjechanymiLicznikami({ zrodlo_id: 1301, numer: '1301' });
    const b = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302' }), {});
    // Wypelniacze zwrotow NA WLASNYM zamowieniu `a`, zeby numer zwrotu ponizej („cudzy")
    // odjechal od numerow OBU zamowien — bez tego numer pierwszego zwrotu w swiezej bazie
    // (1) moglby przypadkiem zgodzic sie z `id` zamowienia `a`, gdyby ono rowniez bylo 1.
    // ⚠️ KWOTY MUSZA SIE ROZNIC (poprawka I6, 2026-08-15): `dodajZwrot` odmawia teraz
    // drugiego IDENTYCZNEGO zwrotu przy tym samym zamowieniu (ta sama data, kwota i zestaw
    // pozycji = powtorne wyslanie formularza). Wypelniaczom chodzi wylacznie o przesuniecie
    // licznika AUTOINCREMENT, wiec rozna kwota niczego tu nie oslabia.
    for (let i = 0; i < 4; i += 1) {
      dodajZwrot(db, a, { data: '2026-08-14', kwota: `${i + 1}.00`, pozycje: [] });
    }
    const cudzy = dodajZwrot(db, b, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    expect(cudzy.id).not.toBe(a);
    expect(cudzy.id).not.toBe(b);
    expect(a).not.toBe(b);

    const rPieniadze = await app.inject({
      method: 'POST', url: `/zamowienia/${a}/zwroty/${cudzy.id}/pieniadze`, headers: AUTH,
    });
    expect(rPieniadze.statusCode).toBe(400);
    expect(zwrotyZamowienia(db, b).find((x) => x.id === cudzy.id).pieniadze_oddane_at).toBeFalsy();

    const rUsun = await app.inject({
      method: 'POST', url: `/zamowienia/${a}/zwroty/${cudzy.id}/usun`, headers: AUTH,
    });
    expect(rUsun.statusCode).toBe(404);
    expect(zwrotyZamowienia(db, b)).toHaveLength(1);
    expect(zwrotyZamowienia(db, b)[0].id).toBe(cudzy.id);
  });
});

// Zadanie 9: ekran zwrotu dociaga numer korekty z inFaktu PRZY KAZDYM otwarciu
// (routes/zwroty.js: petla `korekta.doczytaj`) i pokazuje jasno, gdy zlecenie przepadlo
// (domain/zwrot.js: korektaPrzepadla). Fikstura tutaj potrzebuje FAKTURY zamowienia — bez
// niej `doczytaj` (services/korekta.js) odmawia PRZED wywolaniem inFaktu, bo nie ma czego
// dopasowac.
describe('ekran zwrotu — doczytanie numeru korekty z inFaktu', () => {
  let zwrotId;
  beforeEach(() => {
    db.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
    ).run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    zwrotId = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] }).id;
    zarezerwujKorekte(db, id, zwrotId);
    zapiszKorekte(db, id, zwrotId, { referencja: 'REF-1' });
  });

  it('numer znaleziony u inFaktu pojawia sie NA TYM SAMYM wejsciu, bez przeladowania', async () => {
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([
      { uuid: 'uuid-kor', number: '1/KOR/08/2026', corrected_invoice_number: 'FV 1/08/2026' },
    ]) };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    // ⚠️ STRAZNIK REGRESJI: bez ponownego odczytu zamowienia PO petli `doczytaj`
    // (routes/zwroty.js) `z` w widoku niesie zwroty sprzed zapisu numeru — ten test lapie
    // dokladnie ten blad, bo sprawdza TO SAMO zadanie GET, nie kolejne odswiezenie.
    expect(r.body).toContain('Korekta 1/KOR/08/2026');
    expect(infakt.listaKorekt).toHaveBeenCalledTimes(1);
  });

  it('gdy inFakt nie oddaje dopasowania, ekran nadal pokazuje spokojna pastylke "zlecona"', async () => {
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([]) };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Korekta zlecona — numer pojawi się po przetworzeniu');
  });
});

describe('ekran zwrotu — zlecenie korekty, ktore przepadlo', () => {
  it('po progu bez numeru pokazuje WYRAZNY blad zamiast wiecznej spokojnej pastylki', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    // Zlecone 20 minut temu — powyzej progu 15 minut (domain/zwrot.js: PROG_PRZEPADNIECIA_KOREKTY_MIN).
    const dawno = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(dawno, w.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/inFakt nie wystawił dokumentu/);
    expect(r.body).toMatch(/zlecenie zostało odrzucone/);
    expect(r.body).not.toContain('numer pojawi się po przetworzeniu');
  });

  it('swieze zlecenie (ponizej progu) zostaje przy spokojnej pastylce, nie przy bledzie', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const przedChwila = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(przedChwila, w.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Korekta zlecona — numer pojawi się po przetworzeniu');
    expect(r.body).not.toMatch(/zlecenie zostało odrzucone/);
  });

  // ⚠️⚠️ C2: EKRAN MUSI DAWAC WYJSCIE, A NIE SAM KOMUNIKAT. Do 2026-08-15 gałąź „przepadło"
  // konczyla sie zdaniem „sprawdź w inFakcie" — i na tym koniec: przycisku „Wystaw korektę"
  // juz nie bylo (warunek `!w.korekta_zlecona_at`), kasowania odmawial
  // `powodOdmowyUsunieciaZwrotu`, a zwrot zostawal nierozliczony NA ZAWSZE.
  it('galaz „przepadlo" rysuje OBA wyjscia: odblokowanie rezerwacji i reczny numer korekty', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const dawno = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(dawno, w.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/odblokuj`);
    expect(r.body).toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`);
  });

  // ⚠️ Przycisk odblokowania rysuje sie WYLACZNIE w galezi „przepadlo". Przy swiezej
  // rezerwacji zwolnienie jej otwiera droge do DRUGIEJ korekty do tej samej faktury.
  it('swieze zlecenie NIE dostaje przycisku odblokowania', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const przedChwila = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(przedChwila, w.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/odblokuj`);
  });

  // „Korektę wystawiłem ręcznie" jest droga ZALECANA przy DRUGIEJ korekcie do tej samej
  // faktury — panel jej swiadomie odmawia (services/korekta.js). Bez tego wejscia taki zwrot
  // nie rozliczylby sie nigdy, mimo ze dokument w inFakcie istnieje.
  it('zwrot z faktura i BEZ zadnej korekty tez ma wejscie „wystawilem recznie"', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`);
  });

  // ⚠️⚠️ K2 (recenzja kontrolna 2026-08-15): FORMULARZ RECZNEGO NUMERU RYSOWAL SIE TAKZE PRZY
  // REZERWACJI W TOKU. Gdy zlecenie panelu jeszcze sie przetwarza, a czlowiek w miedzyczasie
  // wystawi korekte recznie, powstaja DWA dokumenty do jednej faktury — i nikt tego juz nie
  // zauwazy. Przycisk odblokowania panel chowa przed progiem CELOWO; ten formularz jest ta sama
  // decyzja o tej samej wadze i ma znikac tak samo.
  it('SWIEZE zlecenie NIE dostaje formularza „wystawilem recznie" — obchodzil prog', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 1000).toISOString(), w.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`);
    expect(r.body).toContain('Korekta zlecona — numer pojawi się po przetworzeniu');
  });

  it('zwrot Z NUMEREM korekty nie dostaje juz zadnego z tych wejsc', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_numer = ? WHERE id = ?').run('1/KOR/08/2026', w.id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/odblokuj`);
    expect(r.body).not.toContain(`/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`);
  });
});

/**
 * ⚠️⚠️ WARUNEK Z RECENZJI 2026-08-15: PANEL NIE MA PRAWA ORZEKAC O DOKUMENCIE, KTOREGO
 * SWIADOMIE NIE SPRAWDZIL.
 *
 * Sekwencja: zamowienie z faktura, zwrot A dostaje rezerwacje korekty, operator dopisuje
 * zwrot B (nic tego nie blokuje) — od tej chwili `doczytaj(A)` wychodzi PRZED zapytaniem do
 * inFaktu (sito W3: „wiecej niz jedna otwarta sprawa korekty", services/korekta.js), bo nie
 * ma jak rozstrzygnac, ktory z dwoch nierozliczonych zwrotow opisuje znaleziony dokument. To
 * jest swiadoma decyzja i ma zostac.
 *
 * Ale do tego dnia ekran po progu (`korektaPrzepadla`) i tak pisal „inFakt nie wystawił
 * dokumentu — zlecenie zostało odrzucone" — zdanie o fakcie, ktorego panel NIE ZNA, bo nigdy
 * nie zapytal. Czlowiek, ktory temu uwierzy, odblokuje rezerwacje i otworzy droge do DRUGIEGO
 * DOKUMENTU u organu podatkowego.
 */
describe('ekran zwrotu — WARUNEK: „nie pytalismy" nie ma prawa brzmiec jak „pytalismy i nie ma"', () => {
  it('sito „wiecej niz jedna otwarta sprawa" zatrzymalo doczytaj — ekran mowi PRAWDE, nie oskarza inFaktu', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const dawno = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(dawno, a.id);
    // Zwrot B BEZ numeru — to on tworzy „wiecej niz jedna otwarta sprawa" (sito W3) i to
    // ON jest powodem, dla ktorego `doczytaj(A)` nigdy nie zapytal inFaktu.
    dodajZwrot(db, id, { data: '2026-08-15', kwota: '50.00', pozycje: [] });

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Zdanie o fakcie, ktorego panel nie zna, ma ZNIKNAC.
    expect(r.body).not.toMatch(/inFakt nie wystawił dokumentu/);
    expect(r.body).not.toMatch(/zlecenie zostało odrzucone/);
    // Zamiast tego: prawda — panel swiadomie nie sprawdzil.
    expect(r.body).toMatch(/nie sprawdził/i);
    expect(r.body).toMatch(/więcej niż jeden zwrot/i);
    // Przycisk odblokowania MOZE zostac — ale bez towarzyszacego mu klamstwa (sprawdzone wyzej).
    expect(r.body).toContain(`/zamowienia/${id}/zwroty/${a.id}/korekta/odblokuj`);
  });

  it('DOKLADNIE JEDNA otwarta sprawa (drugi zwrot ma juz numer) — stary komunikat zostaje PRAWDZIWY', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const dawno = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(dawno, a.id);
    // Drugi zwrot ma juz SWOJ numer — jego sprawa jest zamknieta, wiec otwarta sprawa jest
    // TYLKO jedna (A) i `doczytaj(A)` PYTA inFakt jak dotad.
    const b = dodajZwrot(db, id, { data: '2026-08-15', kwota: '50.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_numer = ? WHERE id = ?').run('4/KOR/09/2026', b.id);

    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toMatch(/inFakt nie wystawił dokumentu/);
    expect(r.body).toMatch(/zlecenie zostało odrzucone/);
    expect(r.body).not.toMatch(/nie sprawdził/i);
  });
});

/**
 * DROBIAZG 1 (recenzja 2026-08-15): PRZYCISK „Wystaw korektę" NIE MA PRAWA OBIECYWAC
 * DZIALANIA, KTORE TRASA ZAWSZE ODMOWI. Gdy INNY zwrot tego zamowienia ma juz korekte (numer
 * albo samo zlecenie), `powodOdmowyKorektyDlaFaktury` (domain/zwrot.js) odmawia KAZDEJ probie
 * POST /korekta dla TEGO zwrotu — wiec przycisk, ktory ekran i tak by narysowal, zawsze
 * dostalby 400. Panel ma go NIE RYSOWAC — albo pokazac z wyjasnieniem, dlaczego jest
 * zablokowany. Droga ZALECANA w tej sytuacji to „Korektę wystawiłem ręcznie", ktora ma
 * zostac widoczna.
 */
describe('ekran zwrotu — przycisk „Wystaw korektę" znika, gdy trasa zawsze odda 400', () => {
  it('inny zwrot tego zamowienia ma juz NUMER korekty — przycisk znika, zostaje wyjasnienie', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_numer = ? WHERE id = ?').run('1/KOR/08/2026', a.id);
    const b = dodajZwrot(db, id, { data: '2026-08-15', kwota: '50.00', pozycje: [] });

    const infakt = { pobierzFakture: vi.fn(), wystawKorekte: vi.fn(), listaKorekt: vi.fn().mockResolvedValue([]) };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    // Przycisk (formularz POST /korekta BEZ przyrostka) dla B ma zniknac.
    expect(r.body).not.toContain(`action="/zamowienia/${id}/zwroty/${b.id}/korekta"`);
    // Wyjasnienie — DOKLADNIE ta sama tresc, ktora trasa i tak by oddala na 400.
    expect(r.body).toMatch(/ma już korektę 1\/KOR\/08\/2026/);
    expect(r.body).toMatch(/wystaw ręcznie w inFakcie/);
    // Droga zalecana (reczny numer) zostaje widoczna.
    expect(r.body).toContain(`action="/zamowienia/${id}/zwroty/${b.id}/korekta/reczna"`);
  });

  it('inny zwrot ma dopiero ZLECONA korekte (bez numeru) — przycisk tez znika', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const a = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?').run(new Date().toISOString(), a.id);
    const b = dodajZwrot(db, id, { data: '2026-08-15', kwota: '50.00', pozycje: [] });

    const infakt = { pobierzFakture: vi.fn(), wystawKorekte: vi.fn(), listaKorekt: vi.fn().mockResolvedValue([]) };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).not.toContain(`action="/zamowienia/${id}/zwroty/${b.id}/korekta"`);
    expect(r.body).toMatch(/ma już korektę zleconą/);
  });

  it('BEZ innego zwrotu z korekta przycisk „Wystaw korektę" rysuje sie jak dotad', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });

    const infakt = { pobierzFakture: vi.fn(), wystawKorekte: vi.fn(), listaKorekt: vi.fn().mockResolvedValue([]) };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: AUTH });
    expect(r.body).toContain(`action="/zamowienia/${id}/zwroty/${w.id}/korekta"`);
  });
});

// ⚠️⚠️ C2 — TRASY WYJSCIOWE. `201` z inFaktu nie dowodzi, ze tresc korekty byla poprawna
// (pomiar 2026-08-14 na zywym koncie: `201` NA PUSTE CIALO), wiec panel MUSI umiec wyjsc
// z rezerwacji, ktora przepadla. Obie trasy CELOWO nie wolaja inFaktu: rozstrzyga czlowiek,
// ktory tam sprawdzil — dokladnie jak przy `/faktura/odblokuj` i `/faktura/skasowana`.
describe('POST /zamowienia/:id/zwroty/:zwrotId/korekta/odblokuj', () => {
  const przepadla = () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const dawno = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ?, korekta_referencja = ? WHERE id = ?')
      .run(dawno, 'REF-1', w.id);
    return w;
  };

  it('kasuje SAMA rezerwacje i wraca na karte', async () => {
    const w = przepadla();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/odblokuj`, headers: AUTH,
    });
    expect(r.statusCode).toBe(302);
    const po = zwrotyZamowienia(db, id).find((x) => x.id === w.id);
    expect(po.korekta_zlecona_at).toBeNull();
    expect(po.korekta_referencja).toBeNull();
  });

  it('zostawia w logu DECYZJE CZLOWIEKA z tym, co skasowal', async () => {
    const w = przepadla();
    await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/odblokuj`, headers: AUTH,
    });
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('zwrot.korekta.odblokowanie');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('REF-1');
  });

  // ⚠️ NAJWAZNIEJSZA ODMOWA TEJ TRASY: prog nie zwalnia rezerwacji SAM. Przed progiem
  // zlecenie moze byc jeszcze w przetwarzaniu, a zwolnienie daloby DRUGA korekte.
  it('ODMAWIA dla rezerwacji swiezej — i zostawia slad nieudanej proby', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 1000).toISOString(), w.id);

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/odblokuj`, headers: AUTH,
    });
    expect(r.statusCode).toBe(400);
    expect(zwrotyZamowienia(db, id).find((x) => x.id === w.id).korekta_zlecona_at).toBeTruthy();
    expect(log(id).at(-1).wynik).toMatch(/^BŁĄD/);
  });

  it('zwrotu z CUDZEGO zamowienia nie da sie odblokowac', async () => {
    const inne = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302' }), {});
    const w = przepadla();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${inne}/zwroty/${w.id}/korekta/odblokuj`, headers: AUTH,
    });
    expect(r.statusCode).toBe(404);
    expect(zwrotyZamowienia(db, id).find((x) => x.id === w.id).korekta_zlecona_at).toBeTruthy();
  });
});

describe('POST /zamowienia/:id/zwroty/:zwrotId/korekta/reczna', () => {
  it('zapisuje numer z formularza — i dopiero to rozlicza zwrot przy fakturze', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`, headers: AUTH,
      payload: new URLSearchParams({ numer: '2/KOR/09/2026' }).toString(),
    });
    expect(r.statusCode).toBe(302);
    expect(zwrotyZamowienia(db, id).find((x) => x.id === w.id).korekta_numer).toBe('2/KOR/09/2026');
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('zwrot.korekta.reczna');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('2/KOR/09/2026');
  });

  it('ODMAWIA pustego numeru, niczego nie zapisuje i zostawia slad', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`, headers: AUTH,
      payload: new URLSearchParams({ numer: '   ' }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(zwrotyZamowienia(db, id).find((x) => x.id === w.id).korekta_numer).toBeNull();
    expect(log(id).at(-1).wynik).toMatch(/^BŁĄD/);
  });

  // ⚠️⚠️ K2: TRASA MUSI ODMOWIC TAKZE WTEDY, GDY FORMULARZA NIE BYLO NA EKRANIE. Widok chowa
  // pole przy swiezej rezerwacji, ale druga otwarta karta i back+resubmit sprzed zlecenia
  // omijaja widok w calosci — a to sa drogi wprost wymienione w specyfikacji.
  it('ODMAWIA przy REZERWACJI W TOKU (przed progiem) i zostawia slad nieudanej proby', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60 * 1000).toISOString(), w.id);

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`, headers: AUTH,
      payload: new URLSearchParams({ numer: '9/KOR/08/2026' }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie minęło/i);
    const po = zwrotyZamowienia(db, id).find((x) => x.id === w.id);
    expect(po.korekta_numer).toBeNull();
    expect(po.korekta_zlecona_at).toBeTruthy();
    expect(log(id).at(-1).wynik).toMatch(/^BŁĄD/);
  });

  // ...ale PO progu ta droga jest jedynym wyjsciem i ma dzialac.
  it('PRZYJMUJE numer, gdy rezerwacja PRZEPADLA', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_zlecona_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), w.id);

    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`, headers: AUTH,
      payload: new URLSearchParams({ numer: '9/KOR/08/2026' }).toString(),
    });
    expect(r.statusCode).toBe(302);
    expect(zwrotyZamowienia(db, id).find((x) => x.id === w.id).korekta_numer).toBe('9/KOR/08/2026');
  });

  it('ODMAWIA nadpisania numeru, ktory juz jest', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    db.prepare('UPDATE zwroty SET korekta_numer = ? WHERE id = ?').run('1/KOR/08/2026', w.id);
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`, headers: AUTH,
      payload: new URLSearchParams({ numer: '2/KOR/09/2026' }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(zwrotyZamowienia(db, id).find((x) => x.id === w.id).korekta_numer).toBe('1/KOR/08/2026');
  });
});

// ⚠️⚠️ I5 (recenzja 2026-08-15): ZADNA AKCJA ZWROTU NIE ZOSTAWIALA SLADU W LOGU ZAMOWIENIA.
// Rejestracja zwrotu przykleja zamowieniu status koncowy i ZDEJMUJE KWOTE Z PRZYCHODU,
// skasowanie usuwa go bez sladu, a zlecenie korekty ma skutki podatkowe. Kazda inna akcja tej
// wagi w panelu pisze slad („DECYZJA CZŁOWIEKA"), a przy fakturze wprost: nieudana proba
// MUSI zostawic slad.
describe('slad w logu zamowienia — kazda akcja zwrotu', () => {
  it('rejestracja zwrotu pisze DECYZJE CZLOWIEKA z data, kwota i liczba pozycji', async () => {
    await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: new URLSearchParams([
        ['data', '2026-08-14'], ['kwota', '99.00'], ['kwota_dostawy', '19.00'], ['powod', 'nie pasuje'],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
      ]).toString(),
    });
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('zwrot.rejestracja');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('99.00');
    expect(wpis.wynik).toContain('2026-08-14');
  });

  it('ODMOWA rejestracji tez zostawia slad — inaczej po miesiacu nie widac, ze ktos probowal', async () => {
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/zwrot`, headers: AUTH,
      payload: new URLSearchParams([
        ['data', '2026-08-14'], ['kwota', '31033'], ['kwota_dostawy', ''],
        ['klucz', 's77'], ['ilosc', '1'], ['nazwa', 'Kot 70x100'], ['pozycja_kwota', '99.00'],
      ]).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(log(id).at(-1).akcja).toBe('zwrot.rejestracja');
    expect(log(id).at(-1).wynik).toMatch(/^BŁĄD/);
  });

  it('oznaczenie oddania pieniedzy pisze slad', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    await app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/pieniadze`, headers: AUTH });
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('zwrot.pieniadze');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
  });

  // ⚠️ SKASOWANY ZWROT ZNIKA Z BAZY BEZ RESZTY — log jest wtedy JEDYNYM miejscem, z ktorego
  // da sie odtworzyc, ze w ogole istnial i za ile byl.
  it('skasowanie zwrotu pisze slad Z KWOTA, ktora znika razem z wierszem', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    await app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/usun`, headers: AUTH });
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('zwrot.usuniecie');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
    expect(wpis.wynik).toContain('99.00');
  });

  it('ODMOWA skasowania tez zostawia slad', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    oznaczPieniadzeOddane(db, id, w.id);
    await app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/usun`, headers: AUTH });
    expect(log(id).at(-1).akcja).toBe('zwrot.usuniecie');
    expect(log(id).at(-1).wynik).toMatch(/^BŁĄD/);
  });

  it('zlecenie korekty pisze slad — udane i nieudane', async () => {
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
    const w = dodajZwrot(db, id, {
      data: '2026-08-14', kwota: '99.00',
      pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    });
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue({
        uuid: 'uuid-fv', number: 'FV 1/08/2026', invoice_date: '2026-08-01',
        services: [
          { name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23' },
          { name: 'Pies 50x70', quantity: 1, gross_price: 10090, tax_symbol: '23' },
        ],
      }),
      wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-9' }),
    };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta`, headers: AUTH,
    });
    expect(r.statusCode).toBe(302);
    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('zwrot.korekta');
    expect(wpis.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
  });

  it('NIEUDANE zlecenie korekty zostawia slad z bledem', async () => {
    const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] });
    const infakt = { pobierzFakture: vi.fn(), wystawKorekte: vi.fn() };
    const appZKorekta = buildOmsServer({ db, config: CONFIG, korekta: createKorekta({ db, infakt }) });
    const r = await appZKorekta.inject({
      method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta`, headers: AUTH,
    });
    expect(r.statusCode).toBe(400);
    expect(log(id).at(-1).akcja).toBe('zwrot.korekta');
    expect(log(id).at(-1).wynik).toMatch(/^BŁĄD/);
  });
});
