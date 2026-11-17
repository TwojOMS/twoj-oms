// Raporty, Statystyki, Reklamy i Finanse wychodzą z górnego paska do menu bocznego jako
// jedna pozycja „Analityka”. Pozycja otwiera ekran podsumowania dnia: ile zamówień dziś (liczba i kwota), ile
// wysłanych dziś, ile czeka na spakowanie — plus odnośniki do podstron.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../pomoc/testowe-dane-miesieczne.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { indeksListy } from '../../../src/oms/db/indeks-listy.js';
import { ustawGranice } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/przykladowe-dane-raportow.js';
import { MODULY } from '../../../src/moduly/lista.ts';
import { nawigacjaDla } from '../../../src/domena/menu-stron.js';
import { ekranyRoli, ekranDlaAdresu } from '../../../src/domena/ekrany.js';
import { menuKontaDla } from '../../../src/domena/menu-konta.js';
import { adresZasobu } from '../../../src/core/web/wersja-zasobow.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
let db;
let kolejny = 0;

const wstaw = (d = {}) => {
  kolejny += 1;
  const w = {
    sklep: 'swietlik', zrodlo_id: kolejny, numer: `N${kolejny}`, metoda_wysylki: 'dpd', kwota_brutto: '100.00',
    klient_json: JSON.stringify({ email: 'k@klient.pl' }), wyslane_at: null, anulowane: 0,
    utworzone_at: new Date().toISOString(), ...d,
  };
  db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, metoda_wysylki, kwota_brutto, klient_json, wyslane_at,
    anulowane, utworzone_at, w_realizacji_at) VALUES (@sklep,@zrodlo_id,@numer,@metoda_wysylki,@kwota_brutto,@klient_json,
    @wyslane_at,@anulowane,@utworzone_at,@w_realizacji_at)`).run({ w_realizacji_at: null, ...w });
};

// Sprzedaż dziś liczy ta sama funkcja co Raporty → „Dzisiaj”, więc jak tam: każdy kanał potrzebuje granicy historii.
const zalozGranice = () => { for (const k of KANALY) ustawGranice(db, k, '2026-07-02', 'test', null); };
beforeEach(() => { db = openOmsDb(':memory:'); kolejny = 0; zalozGranice(); });

const wejdz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};
const kafel = (html, etykieta) => {
  const i = html.indexOf(`<div class="kafel-etykieta">${etykieta}</div>`);
  expect(i, `kafel „${etykieta}”`).toBeGreaterThan(-1);
  return html.slice(i).match(/<div class="kafel-wartosc">([^<]*)<\/div>/)[1].trim();
};

describe('ekran /analityka — podsumowanie dnia', () => {
  it('liczy dzisiejsze zamówienia i kwotę bez anulowanych i wczorajszych', async () => {
    const wczoraj = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    wstaw({ kwota_brutto: '120.50' });
    wstaw({ kwota_brutto: '1000.00', wyslane_at: new Date().toISOString() });
    wstaw({ kwota_brutto: '999.00', anulowane: 1 });
    wstaw({ kwota_brutto: '50.00', utworzone_at: wczoraj, wyslane_at: new Date().toISOString() });
    wstaw({ kwota_brutto: '70.00', utworzone_at: wczoraj, wyslane_at: new Date(Date.now() - 26 * 3600 * 1000).toISOString() }); // w oknie SQL, ale nie dziś
    const odp = await wejdz('/analityka');
    expect(odp.statusCode).toBe(200);
    expect(kafel(odp.body, 'Nowe zamówienia')).toBe('2');
    expect(kafel(odp.body, 'Przychód')).toBe('1 120,50 zł');
    // Wysłane DZIŚ — także zamówienie złożone wczoraj; wysłane wczoraj się nie liczy.
    expect(kafel(odp.body, 'Wysłane')).toBe('2');
  });

  it('„W realizacji” to licznik statusu z indeksu listy zamówień — wszystkie, nie tylko dzisiejsze', async () => {
    const wczoraj = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    wstaw(); wstaw({ w_realizacji_at: new Date().toISOString() }); wstaw({ utworzone_at: wczoraj, w_realizacji_at: wczoraj });
    wstaw({ w_realizacji_at: wczoraj, wyslane_at: new Date().toISOString() });
    const odp = await wejdz('/analityka');
    const teraz = Date.now();
    await indeksListy(db).odswiez(teraz);
    expect(indeksListy(db).liczniki(teraz).statusy.w_realizacji).toBe(2);
    expect(kafel(odp.body, 'W realizacji')).toBe('2');
  });

  it('tytuły kafli bez „dziś” (prośba właściciela 15.11), w kolejności Przychód, Nowe zamówienia, W realizacji, Wysłane', async () => {
    const odp = await wejdz('/analityka');
    const tytuly = [...odp.body.matchAll(/<div class="kafel-etykieta">([^<]+)<\/div>/g)].map((m) => m[1]);
    expect(tytuly).toEqual(['Przychód', 'Nowe zamówienia', 'W realizacji', 'Wysłane']);
  });

  it('pusty dzień to zera, nie pusty ekran', async () => {
    const odp = await wejdz('/analityka');
    expect(odp.statusCode).toBe(200);
    expect(kafel(odp.body, 'Nowe zamówienia')).toBe('0');
    expect(kafel(odp.body, 'Przychód')).toBe('0,00 zł');
  });

  it('bez granicy historii kanału: ekran się otwiera, kafle sprzedaży mówią „—”, a pasek podaje powód z Raportów', async () => {
    db = openOmsDb(':memory:');
    wstaw({ wyslane_at: new Date().toISOString() });
    const odp = await wejdz('/analityka');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('granica historii');
    expect(kafel(odp.body, 'Nowe zamówienia')).toBe('—');
    expect(kafel(odp.body, 'Wysłane')).toBe('1');
  });

  it('prowadzi do podstron analityki', async () => {
    const odp = await wejdz('/analityka');
    const podstrony = odp.body.match(/<nav class="analityka-podstrony"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect([...podstrony.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/raporty', '/statystyki', '/kampania', '/finanse']);
    expect((podstrony.match(/<svg /g) ?? []).length).toBe(4);
  });

  it('należy do ekranu Raporty — to samo prawo, bez nowego ptaszka', () => {
    expect(ekranDlaAdresu('/analityka')).toBe('raporty');
  });
});

const menu = MODULY.flatMap((m) => m.menu).toSorted((a, b) => a.kolejnosc - b.kolejnosc);
const admin = { imie: 'Admin', admin: true, uprawnienia: new Set() };
const zRoli = (rola) => ({ imie: `Konto ${rola}`, admin: false, rola, uprawnienia: new Set(ekranyRoli(rola)) });
const model = (sciezka, konto) => nawigacjaDla({ sciezka, konto, menu });
const pozycjaAnalityki = (n) => n.boczne.flatMap((g) => g.pozycje).find((p) => p.klucz === 'analityka');

describe('menu: Analityka w menu bocznym zamiast górnego paska', () => {
  it('jedna pozycja „Analityka” z podmenu Podsumowanie, Raporty, Statystyki, Reklamy, Finanse', () => {
    const p = pozycjaAnalityki(model('/', admin));
    expect(p.etykieta).toBe('Analityka');
    expect(p.href).toBe('/analityka');
    expect(p.podmenu.map((d) => [d.etykieta, d.href])).toEqual([
      ['Podsumowanie', '/analityka'], ['Raporty', '/raporty'], ['Statystyki', '/statystyki'],
      ['Reklamy', '/kampania'], ['Finanse', '/finanse'],
    ]);
  });

  it('bieżąca jest dokładnie jedna podstrona — Podsumowanie i Raporty dzielą prawo, ale nie adres', () => {
    const naRaportach = pozycjaAnalityki(model('/raporty', admin));
    expect(naRaportach.aktywna).toBe(true);
    expect(naRaportach.podmenu.filter((d) => d.biezaca).map((d) => d.href)).toEqual(['/raporty']);
    const naPodsumowaniu = pozycjaAnalityki(model('/analityka', admin));
    expect(naPodsumowaniu.podmenu.filter((d) => d.biezaca).map((d) => d.href)).toEqual(['/analityka']);
    expect(pozycjaAnalityki(model('/', admin)).aktywna).toBe(false);
  });

  it('rola Sprzedaż nie widzi Finansów, Produkcja nie dostaje Analityki wcale', () => {
    expect(pozycjaAnalityki(model('/', zRoli('sprzedaz'))).podmenu.map((d) => d.href)).not.toContain('/finanse');
    expect(pozycjaAnalityki(model('/', zRoli('produkcja')))).toBeUndefined();
  });

  it('górny pasek i zakładki nad treścią nie niosą już analiz', async () => {
    const ejs = createRequire(import.meta.url)('ejs');
    const widoki = (p) => fileURLToPath(new URL(`../../../src/core/web/widoki/${p}`, import.meta.url));
    const nawigacja = model('/raporty', admin);
    const html = await ejs.renderFile(widoki('layout-oms.ejs'), {
      title: 'Test', motyw: 'jasny', htmx: false, bezPaska: false, nawigacja,
      body: await ejs.renderFile(widoki('_naglowek-ekranu.ejs'), { tytul: 'Raporty', nawigacja }),
      menuKonta: menuKontaDla(admin, { powrot: '/raporty' }), marka: { logoAlt: 'Firma testowa' },
      modyfikatorStatusu: () => null, zasob: adresZasobu(fileURLToPath(new URL('../../../src/public', import.meta.url))),
    });
    expect(html).not.toContain('oms-menu-analiz');
    expect(html).not.toContain('oms-zakladki-analiz');
    expect(html).toContain('data-podmenu-lista="analityka"');
  });
});

describe('Ustawienia na dole menu bocznego (ikona w górnym pasku zostaje)', () => {
  const renderuj = async (sciezka, konto) => {
    const ejs = createRequire(import.meta.url)('ejs');
    const widoki = (p) => fileURLToPath(new URL(`../../../src/core/web/widoki/${p}`, import.meta.url));
    const nawigacja = model(sciezka, konto);
    return ejs.renderFile(widoki('layout-oms.ejs'), {
      title: 'Test', motyw: 'jasny', htmx: false, bezPaska: false, nawigacja, body: '<p>x</p>',
      menuKonta: menuKontaDla(konto, { powrot: sciezka }), marka: { logoAlt: 'Firma testowa' },
      modyfikatorStatusu: () => null, zasob: adresZasobu(fileURLToPath(new URL('../../../src/public', import.meta.url))),
    });
  };
  it('administrator: ostatnia grupa menu bocznego to Ustawienia, a górny pasek nadal ma ikonę', async () => {
    const html = await renderuj('/', admin);
    const bok = html.slice(html.indexOf('<div class="oms-menu-desktop">'), html.indexOf('<details class="oms-menu-mobile"'));
    const grupy = [...bok.matchAll(/<section class="oms-menu-grupa([^"]*)"/g)].map((m) => m[1].trim());
    expect(grupy.at(-1)).toBe('oms-menu-ustawienia');
    expect(bok.slice(bok.lastIndexOf('<section'))).toContain('href="/ustawienia"');
    const pasek = html.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(pasek).toContain('class="oms-theme-button oms-settings-button"');
  });
  it('konto bez prawa do Ustawień nie dostaje pozycji w menu', async () => {
    const html = await renderuj('/', zRoli('sprzedaz'));
    expect(html).not.toContain('oms-menu-ustawienia');
  });
});
