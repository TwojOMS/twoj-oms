// Przy zamówieniach w menu bocznym zostają
// Zamówienia, Przesyłki, Faktury, Magazyn; grupa „Klienci” (Wiadomości, Stali klienci) rozwinięta;
// Analityka jest jedną pozycją w grupie „Wyniki” z podmenu;
// górny przycisk i zakładki nad treścią nie są renderowane.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { MODULY } from '../../src/moduly/lista.ts';
import { nawigacjaDla } from '../../src/domena/menu-stron.js';
import { menuKontaDla } from '../../src/domena/menu-konta.js';
import { EKRANY, ekranyRoli } from '../../src/domena/ekrany.js';
import { adresZasobu } from '../../src/core/web/wersja-zasobow.js';

const ejs = createRequire(import.meta.url)('ejs');
const szablon = fileURLToPath(new URL('../../src/core/web/widoki/layout-oms.ejs', import.meta.url));
const zasob = adresZasobu(fileURLToPath(new URL('../../src/public', import.meta.url)));
const menu = MODULY.flatMap((m) => m.menu).toSorted((a, b) => a.kolejnosc - b.kolejnosc);
const ANALIZY = ['/analityka', '/raporty', '/statystyki', '/kampania', '/finanse'];

const admin = { imie: 'Admin', admin: true, uprawnienia: new Set<string>() };
const zRoli = (rola: string) => ({ imie: `Konto ${rola}`, admin: false, rola, uprawnienia: new Set(ekranyRoli(rola)) });
const model = (sciezka: string, konto: any, odlozoneEkrany: string[] = []) => nawigacjaDla({ sciezka, konto, menu, odlozoneEkrany });
const render = async (sciezka: string, konto: any, odlozoneEkrany: string[] = []) => ejs.renderFile(szablon, {
  title: 'Test', motyw: 'jasny', htmx: false, bezPaska: false,
  // Zakładki są częścią nagłówka ekranu, renderowanego przed layoutem.
  body: await ejs.renderFile(fileURLToPath(new URL('../../src/core/web/widoki/_naglowek-ekranu.ejs', import.meta.url)), {tytul: 'Treść', nawigacja: model(sciezka, konto, odlozoneEkrany)}),
  nawigacja: model(sciezka, konto, odlozoneEkrany),
  menuKonta: menuKontaDla(konto, { powrot: sciezka }), marka: { logoAlt: 'Firma testowa' }, modyfikatorStatusu: () => null, zasob,
}) as Promise<string>;
const kawalki = (h: string) => {
  const bok = h.slice(h.indexOf('<aside class="oms-sidebar">'), h.indexOf('</aside>'));
  return {
    bokKomputer: bok.slice(bok.indexOf('<div class="oms-menu-desktop">'), bok.indexOf('<details class="oms-menu-mobile"')),
    bokTelefon: bok.slice(bok.indexOf('<details class="oms-menu-mobile"')),
    pasek: h.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '',
    tresc: h.slice(h.indexOf('<main class="kolumna-glowna')),
  };
};
const hrefy = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe('jedno źródło układu', () => {
  // Układ menu stoi w dwóch miejscach: EKRANY.nawigacja (menu bez manifestów, strażnik) i pola `menu` manifestów
  // (menu HTTP). Rozjazd znaczyłby inne menu w teście i inne na produkcji.
  it('dzial, grupa i kolejność w manifestach zgadzają się z EKRANY.nawigacja', () => {
    const zEkranow = Object.fromEntries(EKRANY.filter((e: any) => e.nawigacja && e.href)
      .map((e: any) => [e.klucz, { dzial: e.nawigacja.dzial, grupa: e.nawigacja.grupa, kolejnosc: e.nawigacja.kolejnosc }]));
    const zManifestow = Object.fromEntries(menu.filter((p) => p.dzial !== 'ustawienia')
      .map((p) => [p.uprawnienie, { dzial: p.dzial, grupa: p.grupa, kolejnosc: p.kolejnosc }]));
    expect(zManifestow).toEqual(zEkranow);
  });
});

const podmenuAnalityki = (html: string) => html.match(/<ul class="oms-podmenu-lista"[^>]*data-podmenu-lista="analityka"[\s\S]*?<\/ul>/)?.[0] ?? '';

describe('menu boczne', () => {
  it('trzy grupy: Obsługa zamówień, Klienci i Wyniki (Analityka)', () => {
    const n = model('/', admin) as any;
    expect(n.boczne.map((g: any) => [g.etykieta, g.pozycje.map((p: any) => p.href)])).toEqual([
      ['Obsługa zamówień', ['/', '/przesylki', '/faktury', '/magazyn']],
      ['Klienci', ['/wiadomosci', '/klienci']],
      ['Wyniki', ['/analityka']],
    ]);
  });

  it('pusta grupa „Klienci” znika, a wyłączone moduły (odlozoneEkrany) zostawiają samą resztę', async () => {
    expect((model('/', zRoli('produkcja')) as any).boczne.map((g: any) => g.etykieta)).toEqual(['Obsługa zamówień']);
    const n = model('/', admin, ['klienci', 'okresy']) as any;
    expect(n.boczne.find((g: any) => g.klucz === 'klienci').pozycje.map((p: any) => p.href)).toEqual(['/wiadomosci']);
    const { bokKomputer } = kawalki(await render('/', zRoli('produkcja')));
    expect(bokKomputer).not.toContain('Klienci');
  });
});

describe('analizy w podmenu „Analityka”', () => {
  it('górny pasek do 900 px oddaje miejsce nazwie ekranu i nie ma już przycisku analiz', async () => {
    const css = readFileSync(new URL('../../src/public/oms-design.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{\s*\.oms-breadcrumb>span\s*,\s*\.oms-topbar \.menu-uzytkownika-nazwa\s*\{\s*display:\s*none\s*\}\s*\}/);
    const { pasek } = kawalki(await render('/', admin));
    expect(pasek).toContain('aria-label="Konto: Admin"');
    expect(pasek).not.toContain('data-menu="analizy"');
    expect(hrefy(pasek).filter((u) => ANALIZY.includes(u))).toEqual([]);
  });

  it('admin ma w podmenu pięć pozycji w kolejności manifestów — na komputerze i na telefonie', async () => {
    const { bokKomputer, bokTelefon } = kawalki(await render('/', admin));
    expect(hrefy(podmenuAnalityki(bokKomputer))).toEqual(ANALIZY);
    expect(hrefy(podmenuAnalityki(bokTelefon))).toEqual(ANALIZY);
  });

  it('Sprzedaż dostaje analizy bez Finansów; wyłączone ekrany też znikają z podmenu', async () => {
    const { bokKomputer } = kawalki(await render('/', zRoli('sprzedaz')));
    expect(hrefy(podmenuAnalityki(bokKomputer))).toEqual(['/analityka', '/raporty', '/statystyki', '/kampania']);
    expect((model('/', admin, ['kampania', 'finanse']) as any).analizy.pozycje.map((p: any) => p.href))
      .toEqual(['/analityka', '/raporty', '/statystyki']);
  });

  it('Produkcja nie ma Analityki — ani na komputerze, ani na telefonie', async () => {
    expect((model('/', zRoli('produkcja')) as any).analizy).toBeNull();
    const h = await render('/', zRoli('produkcja'));
    expect(h).not.toContain('data-podmenu-lista="analityka"');
    for (const url of ANALIZY) expect(hrefy(h)).not.toContain(url);
  });

  it('na ekranie analiz zaznaczona jest Analityka i jej podstrona; nad treścią nie ma zakładek', async () => {
    const n = model('/statystyki', admin) as any;
    expect(n.boczne.flatMap((g: any) => g.pozycje).filter((p: any) => p.aktywna).map((p: any) => p.href)).toEqual(['/analityka']);
    const { tresc, bokKomputer } = kawalki(await render('/statystyki', admin));
    expect(podmenuAnalityki(bokKomputer)).toContain('href="/statystyki" aria-current="page"');
    expect(tresc).not.toContain('oms-order-statuses');
  });
});
