// Filtry listy zamówień z wieloma wartościami: Sposób wysyłki, Płatność, Kanał sprzedaży i Faktura.
// Kilka wartości jednego filtra to SUMA (LUB), różne filtry łączą się przez I, brak wyboru = wszystkie.
// Wybór żyje w adresie jako powtórzony parametr (`?wysylka=dpd&wysylka=inpost_paczkomat`), więc link
// z filtrem da się przesłać dalej, a stare linki z jedną wartością działają jak dawniej.
// Oczekiwania liczone z DANYCH zestawu (tablica `zestaw`), nie z reguły filtrów.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { ROZMIAR_STRONY } from '../../../src/moduly/zamowienia/lista.js';
import { adresZFiltrami, bezpiecznyPowrotNaListe, parsujFiltry } from '../../../src/domena/filtry-listy.js';
import { KANALY_TESTOWE } from './lista/testowe-dane-listy.js';

let a; let cookie; let katalog;
const ids = (html) => [...html.matchAll(/name="id" value="(\d+)"/g)].map((m) => Number(m[1]));
const bezEncji = (s) => s.replaceAll('&amp;', '&');

beforeEach(async () => {
  // Baza w pliku: jeden test otwiera ją drugi raz, jak nowy proces panelu po wydaniu.
  katalog = mkdtempSync(join(tmpdir(), 'oms-filtry-wielu-'));
  a = await zbudujOms({ env: { OMS_DB_PATH: join(katalog, 'oms.sqlite'), OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'bootstrap', OMS_PASS: 'syntetyczne', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
    OMS_KANALY: JSON.stringify(KANALY_TESTOWE) } });
  zalozKonto(a.db, { login: 'tester', imie: 'Test', haslo: 'syntetyczne-haslo-filtry', rola: 'admin', admin: true });
  const login = await a.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'uzytkownik=tester&haslo=syntetyczne-haslo-filtry&powrot=%2F' });
  cookie = String(login.headers['set-cookie']).match(/sesja_oms=[^;]+/)[0];
});
afterEach(async () => { await a.app.close(); a.db.close(); rmSync(katalog, { recursive: true, force: true }); });

const WYSYLKI = ['dpd', 'inpost_paczkomat', 'odbior_osobisty'];
const SKLEPY = ['kanal_a', 'kanal_b'];
const PLATNOSCI = ['BLIK', 'Przelew tradycyjny', 'Za pobraniem'];
const FAKTURY = ['brak', 'wystawiona', 'w_toku'];

/** Pełny iloczyn: 3 wysyłki × 2 kanały × 3 płatności × chce/nie chce × 3 stany faktury = 108 zamówień. */
function wstawZestaw() {
  const insZ = a.db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, metoda_wysylki, metoda_platnosci,
    chce_fakture, utworzone_at) VALUES (?, ?, ?, '10.00', ?, ?, ?, ?)`);
  const insF = a.db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at) VALUES (?,?,?,?,?)');
  const zestaw = [];
  let n = 0;
  for (const wysylka of WYSYLKI) for (const sklep of SKLEPY) for (const platnosc of PLATNOSCI) for (const chce of [0, 1]) for (const faktura of FAKTURY) {
    n += 1;
    const id = Number(insZ.run(sklep, n, `F-${n}`, wysylka, platnosc, chce, `2026-10-01T10:${String(n % 60).padStart(2, '0')}:00`).lastInsertRowid);
    if (faktura === 'wystawiona') insF.run(id, `u${n}`, `FV/${n}`, null, '2026-10-01T11:00:00Z');
    // Wystawianie trwa od niedawna — dokumentu jeszcze nie ma, więc to NIE jest faktura wystawiona.
    if (faktura === 'w_toku') insF.run(id, `u${n}`, null, 'w_toku', new Date().toISOString());
    zestaw.push({ id, wysylka, sklep, platnosc, chce, faktura });
  }
  return zestaw;
}

/** Wszystkie identyfikatory widoku — strona po stronie, linkiem „następna” z samej strony. */
async function wszystkieIds(url) {
  const zebrane = []; let adres = url; let pierwsza = null;
  for (let i = 0; i < 20 && adres; i++) {
    const r = await a.app.inject({ url: adres, headers: { cookie } });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    pierwsza ??= r.body;
    zebrane.push(...ids(r.body));
    const nastepna = bezEncji(r.body).match(/<a[^>]*href="(\/\?[^"]*strona=\d+)"[^>]*>[^<]*(Następna|następna|›|→)/);
    adres = nastepna?.[1] ?? null;
  }
  return { ids: zebrane, html: pierwsza };
}

const posortowane = (t) => [...t].sort((x, y) => x - y);
const wynikFiltra = (html) => Number(html.match(/class="wynik-filtra">(\d+)/)?.[1]);

describe('lista zamówień — filtry wielokrotnego wyboru', () => {
  it('dwie metody wysyłki = suma obu; licznik wyniku zgadza się z listą', async () => {
    const zestaw = wstawZestaw();
    const oczekiwane = zestaw.filter((z) => ['dpd', 'inpost_paczkomat'].includes(z.wysylka)).map((z) => z.id);
    const { ids: wynik, html } = await wszystkieIds('/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat');
    expect(posortowane(wynik)).toEqual(posortowane(oczekiwane));
    expect(wynikFiltra(html)).toBe(oczekiwane.length);
  });

  it('stary link z jedną wartością działa jak dawniej', async () => {
    const zestaw = wstawZestaw();
    const { ids: wynik } = await wszystkieIds('/?wszystkie=1&wysylka=dpd');
    expect(posortowane(wynik)).toEqual(posortowane(zestaw.filter((z) => z.wysylka === 'dpd').map((z) => z.id)));
    // Surowa nazwa metody ze starej zakładki („Przelew tradycyjny”) dalej trafia.
    const { ids: przelew } = await wszystkieIds('/?wszystkie=1&platnosc=Przelew%20tradycyjny');
    expect(posortowane(przelew)).toEqual(posortowane(zestaw.filter((z) => z.platnosc === 'Przelew tradycyjny').map((z) => z.id)));
  });

  it('brak wyboru = wszystkie zamówienia', async () => {
    const zestaw = wstawZestaw();
    const { ids: wynik } = await wszystkieIds('/?wszystkie=1');
    expect(posortowane(wynik)).toEqual(posortowane(zestaw.map((z) => z.id)));
  });

  it('kanały i płatności: suma w filtrze, iloczyn między filtrami', async () => {
    const zestaw = wstawZestaw();
    const { ids: kanaly } = await wszystkieIds('/?wszystkie=1&kanal=kanal_a&kanal=kanal_b');
    expect(kanaly).toHaveLength(zestaw.length);
    const { ids: wynik } = await wszystkieIds('/?wszystkie=1&platnosc=blik&platnosc=pobranie&kanal=kanal_b&wysylka=odbior_osobisty');
    const oczekiwane = zestaw.filter((z) => ['BLIK', 'Za pobraniem'].includes(z.platnosc) && z.sklep === 'kanal_b' && z.wysylka === 'odbior_osobisty');
    expect(oczekiwane.length).toBeGreaterThan(0);
    expect(posortowane(wynik)).toEqual(posortowane(oczekiwane.map((z) => z.id)));
  });

  it('faktura: „tak/nie” to życzenie klienta, „wystawiona/niewystawiona” to dokument; w grupie LUB, między grupami I', async () => {
    const zestaw = wstawZestaw();
    const sprawdz = async (adres, pred) => {
      const oczekiwane = zestaw.filter(pred).map((z) => z.id);
      expect(oczekiwane.length, adres).toBeGreaterThan(0);
      const { ids: wynik } = await wszystkieIds(adres);
      expect(posortowane(wynik), adres).toEqual(posortowane(oczekiwane));
    };
    await sprawdz('/?wszystkie=1&faktura=tak', (z) => z.chce === 1);
    await sprawdz('/?wszystkie=1&faktura=nie', (z) => z.chce === 0);
    await sprawdz('/?wszystkie=1&faktura=wystawiona', (z) => z.faktura === 'wystawiona');
    // „W toku” nie jest wystawioną fakturą — dokumentu jeszcze nie ma.
    await sprawdz('/?wszystkie=1&faktura=niewystawiona', (z) => z.faktura !== 'wystawiona');
    await sprawdz('/?wszystkie=1&faktura=tak&faktura=niewystawiona', (z) => z.chce === 1 && z.faktura !== 'wystawiona');
    await sprawdz('/?wszystkie=1&faktura=tak&faktura=nie', () => true);
    await sprawdz('/?wszystkie=1&faktura=nie&faktura=wystawiona&kanal=kanal_a', (z) => z.chce === 0 && z.faktura === 'wystawiona' && z.sklep === 'kanal_a');
  });

  it('nieznana wartość wypada, znane zostają', async () => {
    const zestaw = wstawZestaw();
    const { ids: wynik } = await wszystkieIds('/?wszystkie=1&wysylka=dpd&wysylka=zmyslona&faktura=moze');
    expect(posortowane(wynik)).toEqual(posortowane(zestaw.filter((z) => z.wysylka === 'dpd').map((z) => z.id)));
    expect(parsujFiltry({ wysylka: ['zmyslona'], faktura: 'moze' }, KANALY_TESTOWE)).toMatchObject({ wysylka: null, faktura: null });
  });

  it('stronicowanie niesie wszystkie wartości filtra', async () => {
    const ins = a.db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, metoda_wysylki, utworzone_at)
      VALUES ('kanal_a', ?, ?, '10.00', ?, '2026-10-01T10:00:00')`);
    const pasujace = [];
    for (let i = 1; i <= 2 * ROZMIAR_STRONY; i++) {
      const w = ['dpd', 'inpost_paczkomat', 'odbior_osobisty'][i % 3];
      const id = Number(ins.run(i, `S-${i}`, w).lastInsertRowid);
      if (w !== 'odbior_osobisty') pasujace.push(id);
    }
    expect(pasujace.length).toBeGreaterThan(ROZMIAR_STRONY);
    const r = await a.app.inject({ url: '/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat', headers: { cookie } });
    expect(ids(r.body)).toHaveLength(ROZMIAR_STRONY);
    expect(bezEncji(r.body)).toContain('href="/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat&strona=2"');
    const { ids: wynik } = await wszystkieIds('/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat');
    expect(wynik).toEqual([...pasujace].reverse());
  });

  it('formularz: zaznaczone pola, podsumowanie „N wybrane”, chip na każdą wartość, wyszukiwarka niesie wybór', async () => {
    wstawZestaw();
    const r = await a.app.inject({ url: '/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat&wysylka=odbior_osobisty&kanal=kanal_b', headers: { cookie } });
    const html = bezEncji(r.body);
    // Bez JavaScriptu: zwykłe pola wyboru o tej samej nazwie w formularzu GET.
    for (const w of ['dpd', 'inpost_paczkomat', 'odbior_osobisty']) {
      expect(html).toMatch(new RegExp(`<input type="checkbox" name="wysylka" value="${w}" checked`));
    }
    expect(html).toMatch(/<input type="checkbox" name="wysylka" value="allegro_dpd"(?! checked)/);
    expect(html).toMatch(/<summary[^>]*>[\s\S]{0,300}?3 wybrane/);
    // Jedna wartość — jej nazwa zamiast liczby; brak wyboru — „Wszystkie”.
    expect(html).toMatch(/<summary[^>]*>[\s\S]{0,300}?Rynek syntetyczny B/);
    expect(html).toMatch(/<summary[^>]*>[\s\S]{0,300}?Wszystkie/);
    // Krzyżyk przy chipie zdejmuje TYLKO tę jedną wartość.
    expect(html).toContain('href="/?wszystkie=1&wysylka=inpost_paczkomat&wysylka=odbior_osobisty&kanal=kanal_b"');
    // Wyszukiwarka niesie każdą wartość osobnym ukrytym polem.
    const szukajka = html.match(/<form class="szukajka"[\s\S]*?<\/form>/)[0];
    for (const w of ['dpd', 'inpost_paczkomat', 'odbior_osobisty']) expect(szukajka).toContain(`<input type="hidden" name="wysylka" value="${w}">`);
    expect(szukajka).toContain('<input type="hidden" name="kanal" value="kanal_b">');
    // Filtr faktury ma cztery wartości w dwóch grupach.
    for (const f of ['tak', 'nie', 'wystawiona', 'niewystawiona']) expect(html).toContain(`name="faktura" value="${f}"`);
  });
});

describe('filtr faktury na bazie sprzed kolumn faktury w indeksie', () => {
  it('wiersze indeksu bez kolumn faktury liczą się od nowa przy pierwszym widoku nowego procesu', async () => {
    const zestaw = wstawZestaw();
    // Indeks zbudowany, a potem cofnięty do stanu tuż po migracji: kolumny faktury puste.
    expect((await a.app.inject({ url: '/?wszystkie=1', headers: { cookie } })).statusCode).toBe(200);
    a.db.exec('UPDATE lista_stan SET chce_fakture = NULL, faktura_wystawiona = NULL');
    const sciezka = a.db.prepare('PRAGMA database_list').get().file;
    expect(sciezka, 'test potrzebuje bazy w pliku').toBeTruthy();
    await a.app.close(); a.db.close();
    // Nowy proces na tej samej bazie — tak, jak panel po wydaniu.
    a = await zbudujOms({ env: { OMS_DB_PATH: sciezka, OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_USER: 'bootstrap', OMS_PASS: 'syntetyczne', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
      OMS_KANALY: JSON.stringify(KANALY_TESTOWE) } });
    const login = await a.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'uzytkownik=tester&haslo=syntetyczne-haslo-filtry&powrot=%2F' });
    cookie = String(login.headers['set-cookie']).match(/sesja_oms=[^;]+/)[0];
    const { ids: wynik } = await wszystkieIds('/?wszystkie=1&faktura=tak&faktura=wystawiona');
    expect(posortowane(wynik)).toEqual(posortowane(zestaw.filter((z) => z.chce === 1 && z.faktura === 'wystawiona').map((z) => z.id)));
  });
});

describe('adres listy z wieloma wartościami', () => {
  it('adresZFiltrami powtarza parametr, w stałej kolejności filtrów', () => {
    expect(adresZFiltrami({ wysylka: ['dpd', 'inpost_paczkomat'], faktura: ['tak'], kanal: ['kanal_a'] }, { strona: 2 }))
      .toBe('/?wysylka=dpd&wysylka=inpost_paczkomat&kanal=kanal_a&faktura=tak&strona=2');
    // Jedna wartość jako napis — tak, jak składają adres starsze miejsca panelu.
    expect(adresZFiltrami({ wysylka: 'dpd' }, {})).toBe('/?wysylka=dpd');
  });

  it('powrót z karty zachowuje powtórzone filtry, ale nie powtórzoną stronę', () => {
    expect(bezpiecznyPowrotNaListe('/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat&faktura=tak&strona=2', KANALY_TESTOWE))
      .toBe('/?wszystkie=1&wysylka=dpd&wysylka=inpost_paczkomat&faktura=tak&strona=2');
    expect(bezpiecznyPowrotNaListe('/?wysylka=dpd&strona=2&strona=3', KANALY_TESTOWE)).toBe('/');
  });

  it('parsujFiltry: lista bez powtórzeń, wartości spoza słownika wypadają', () => {
    const f = parsujFiltry({ wysylka: ['dpd', 'dpd', 'zmyslona'], kanal: 'kanal_b', platnosc: ['BLIK', 'blik', ' '], faktura: ['tak', 'niewystawiona'] }, KANALY_TESTOWE);
    expect(f.wysylka).toEqual(['dpd']);
    expect(f.kanal).toEqual(['kanal_b']);
    expect(f.platnosc).toEqual(['BLIK']);
    expect(f.faktura).toEqual(['tak', 'niewystawiona']);
  });
});
