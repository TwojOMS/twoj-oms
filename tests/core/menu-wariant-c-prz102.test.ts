// PRZ-102.03 (właściciel 20.10, wariant C z makiety menu-wariant-C.html): przy zamówieniach w menu bocznym zostają
// Zamówienia, Przesyłki, Faktury, Magazyn; grupa „Klienci” (Wiadomości, Stali klienci, Rozliczenia) rozwinięta;
// analizy (Raporty, Statystyki, Reklamy, Koszty, Finanse, Cele) w górnym pasku pod przyciskiem „Analizy i finanse”,
// a na ekranach analiz także jako rząd zakładek nad treścią. Na telefonie analizy to zwinięta grupa w menu.
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
const ANALIZY = ['/raporty', '/statystyki', '/kampania', '/koszty', '/finanse', '/cele'];

const admin = { imie: 'Admin', admin: true, uprawnienia: new Set<string>() };
const zRoli = (rola: string) => ({ imie: `Konto ${rola}`, admin: false, rola, uprawnienia: new Set(ekranyRoli(rola)) });
const model = (sciezka: string, konto: any, odlozoneEkrany: string[] = []) => nawigacjaDla({ sciezka, konto, menu, odlozoneEkrany });
const render = (sciezka: string, konto: any, odlozoneEkrany: string[] = []) => ejs.renderFile(szablon, {
  title: 'Test', motyw: 'jasny', htmx: false, bezPaska: false, body: '<h1>Treść</h1>', nawigacja: model(sciezka, konto, odlozoneEkrany),
  menuKonta: menuKontaDla(konto, { powrot: sciezka }), marka: { logoAlt: 'Firma testowa' }, modyfikatorStatusu: () => null, zasob,
}) as Promise<string>;
const kawalki = (h: string) => {
  const bok = h.slice(h.indexOf('<aside class="oms-sidebar">'), h.indexOf('</aside>'));
  return {
    bokKomputer: bok.slice(bok.indexOf('<div class="oms-menu-desktop">'), bok.indexOf('<details class="oms-menu-mobile"')),
    bokTelefon: bok.slice(bok.indexOf('<details class="oms-menu-mobile"')),
    pasek: h.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '',
    tresc: h.slice(h.indexOf('<main class="kolumna-glowna">')),
  };
};
const hrefy = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

describe('PRZ-102.03 jedno źródło układu', () => {
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

describe('PRZ-102.03 menu boczne przy zamówieniach', () => {
  it('ma dwie grupy: Obsługa zamówień (Zamówienia, Przesyłki, Faktury, Magazyn) i Klienci — bez analiz', () => {
    const n = model('/', admin) as any;
    expect(n.boczne.map((g: any) => [g.etykieta, g.pozycje.map((p: any) => p.href)])).toEqual([
      ['Obsługa zamówień', ['/', '/przesylki', '/faktury', '/magazyn']],
      ['Klienci', ['/wiadomosci', '/klienci', '/okresy']],
    ]);
  });

  it('w wyrenderowanym menu bocznym (komputer) nie ma Raportów, Reklam ani Finansów', async () => {
    const { bokKomputer } = kawalki(await render('/', admin));
    for (const url of ANALIZY) expect(hrefy(bokKomputer)).not.toContain(url);
    expect(hrefy(bokKomputer)).toEqual(expect.arrayContaining(['/przesylki', '/faktury', '/magazyn', '/wiadomosci', '/klienci', '/okresy']));
  });

  it('pusta grupa „Klienci” znika, a wyłączone moduły (odlozoneEkrany) zostawiają samą resztę', async () => {
    expect((model('/', zRoli('produkcja')) as any).boczne.map((g: any) => g.etykieta)).toEqual(['Obsługa zamówień']);
    const n = model('/', admin, ['klienci', 'okresy']) as any;
    expect(n.boczne.find((g: any) => g.klucz === 'klienci').pozycje.map((p: any) => p.href)).toEqual(['/wiadomosci']);
    const { bokKomputer } = kawalki(await render('/', zRoli('produkcja')));
    expect(bokKomputer).not.toContain('Klienci');
  });
});

describe('PRZ-102.03 analizy w górnym pasku', () => {
  it('do 900 px oddaje miejsce nazwie ekranu: ukrywa Panel / i podpis konta, zachowując dostępny przycisk', async () => {
    const css = readFileSync(new URL('../../src/public/oms-design.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{\s*\.oms-breadcrumb>span\s*,\s*\.oms-topbar \.menu-uzytkownika-nazwa\s*\{\s*display:\s*none\s*\}\s*\}/);
    const { pasek } = kawalki(await render('/', admin));
    expect(pasek).toContain('aria-label="Konto: Admin"');
    expect(pasek).toContain('class="oms-avatar"');
  });

  it('admin ma w pasku przycisk z sześcioma analizami w kolejności manifestów', async () => {
    const n = model('/', admin) as any;
    expect(n.analizy.pozycje.map((p: any) => p.href)).toEqual(ANALIZY);
    expect(n.analizy.aktywna).toBe(false);
    const { pasek } = kawalki(await render('/', admin));
    expect(pasek).toContain('data-menu="analizy"');
    expect(pasek).toContain('Analizy i finanse');
    expect(hrefy(pasek).filter((u) => ANALIZY.includes(u))).toEqual(ANALIZY);
  });

  it('Sprzedaż dostaje analizy bez Finansów; wyłączone ekrany też znikają z przycisku', async () => {
    const { pasek } = kawalki(await render('/', zRoli('sprzedaz')));
    expect(hrefy(pasek).filter((u) => ANALIZY.includes(u))).toEqual(['/raporty', '/statystyki', '/kampania', '/koszty', '/cele']);
    expect((model('/', admin, ['kampania', 'cele', 'finanse']) as any).analizy.pozycje.map((p: any) => p.href))
      .toEqual(['/raporty', '/statystyki', '/koszty']);
  });

  it('Produkcja nie ma przycisku ani grupy analiz — ani w pasku, ani w menu telefonu', async () => {
    expect((model('/', zRoli('produkcja')) as any).analizy).toBeNull();
    const h = await render('/', zRoli('produkcja'));
    expect(h).not.toContain('Analizy i finanse');
    expect(h).not.toContain('data-menu="analizy"');
    for (const url of ANALIZY) expect(hrefy(h)).not.toContain(url);
  });

  it('aktywny ekran analiz zaznacza przycisk i swoją pozycję, a nad treścią stawia rząd zakładek', async () => {
    const n = model('/statystyki', admin) as any;
    expect(n.analizy.aktywna).toBe(true);
    expect(n.analizy.pozycje.filter((p: any) => p.aktywna).map((p: any) => p.href)).toEqual(['/statystyki']);
    expect(n.boczne.flatMap((g: any) => g.pozycje).filter((p: any) => p.aktywna)).toEqual([]);
    const { pasek, tresc, bokKomputer } = kawalki(await render('/statystyki', admin));
    expect(pasek).toMatch(/<summary[^>]*class="oms-menu-analiz-przycisk"[^>]*aria-current="true"/);
    expect(pasek).toContain('href="/statystyki" aria-current="page"');
    const zakladki = tresc.match(/<nav class="oms-order-statuses[^"]*"[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect(hrefy(zakladki)).toEqual(ANALIZY);
    expect(zakladki).toContain('href="/statystyki" aria-current="page"');
    expect(bokKomputer).not.toContain('aria-current');
  });

  it('poza analizami przycisk nie jest zaznaczony i nie ma zakładek nad treścią', async () => {
    const { pasek, tresc } = kawalki(await render('/przesylki', admin));
    expect(pasek).not.toMatch(/<summary[^>]*class="oms-menu-analiz-przycisk"[^>]*aria-current/);
    expect(tresc).not.toContain('oms-order-statuses');
  });

  it('na telefonie analizy schodzą do menu jako zwinięta grupa (bez data-menu, żeby nie zamykała menu)', async () => {
    const { bokTelefon } = kawalki(await render('/', admin));
    const grupa = bokTelefon.match(/<details class="oms-menu-grupa oms-menu-zwijana"[^>]*>[\s\S]*?<\/details>/)?.[0] ?? '';
    expect(grupa).toContain('Analizy i finanse');
    expect(grupa).not.toContain('data-menu');
    expect(grupa).not.toMatch(/<details[^>]*\sopen/);
    expect(hrefy(grupa)).toEqual(ANALIZY);
    const naRaportach = kawalki(await render('/raporty', admin)).bokTelefon.match(/<details class="oms-menu-grupa oms-menu-zwijana"[^>]*>/)?.[0];
    expect(naRaportach).toMatch(/\sopen/);
  });
});
