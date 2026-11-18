// Widoczne teksty w widokach `src/**/*.ejs` nie zakładają, że firma używająca Twojego OMS ma program, którego
// produkt nie obsługuje. Nazwa innego systemu sprzedaży (Apilo, BaseLinker, Sellasist) albo aplikacji spoza
// produktu (osobny panel zamówień indywidualnych z przyciskiem „Dodaj do OMS”) wolno pokazać tylko wtedy, gdy:
//   • ten program jest w katalogu integracji (`src/domena/katalog-integracji.ts`) jako dostępny albo przez
//     konfigurację — produkt go obsługuje (wpis „planowana” nie wystarcza), albo
//   • tekst podaje go jako przykład innego programu („np. BaseLinker”) — zwolniony jest tylko ten przykład,
//     reszta linii jest sprawdzana dalej.
// Komentarze (`<%# … %>`, `<!-- … -->`, `/* … */`) czytają programiści, nie użytkownicy — strażnik patrzy na to,
// co widać na ekranie. Uzupełnia `straznik-danych-firmy.test.ts` (nazwy firmy i numery).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trescMaila } from '../../src/moduly/ustawienia/poczta-kont.js';
import { KATALOG_INTEGRACJI } from '../../src/domena/katalog-integracji.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Programy spoza produktu. `nazwa` porównuje się z katalogiem integracji i z przykładem „np. …”.
const PROGRAMY: { nazwa: string; wzor: RegExp; opis: string }[] = [
  { nazwa: 'Apilo', wzor: /apilo/i, opis: 'inny system sprzedaży' },
  { nazwa: 'BaseLinker', wzor: /base\s*linker/i, opis: 'inny system sprzedaży' },
  { nazwa: 'Sellasist', wzor: /sellasist/i, opis: 'inny system sprzedaży' },
  {
    nazwa: 'panel zamówień indywidualnych',
    wzor: /panel\w*\s+zam[óo]wie[ńn]\s+indywidualn/i,
    opis: 'aplikacja spoza produktu',
  },
  { nazwa: 'panel indywidualny', wzor: /panel\w*\s+indywidualn/i, opis: 'aplikacja spoza produktu' },
  { nazwa: 'Dodaj do OMS', wzor: /dodaj do OMS/i, opis: 'przycisk aplikacji spoza produktu' },
];

// Jawne wyjątki: plik + fragment + powód. Pusta lista = żaden widoczny tekst nie jest wyjątkiem.
const WYJATKI: { plik: string; fragment: string; powod: string }[] = [];

type WpisKatalogu = { nazwa: string; dostepnosc: string };

// Planowana integracja jest w katalogu, ale produkt jej jeszcze nie obsługuje — nie zwalnia nazwy.
const wKatalogu = (nazwa: string, katalog: WpisKatalogu[]) =>
  katalog.some((i) => i.nazwa.toLowerCase() === nazwa.toLowerCase() && i.dostepnosc !== 'planowana');
// Wycina z linii same przykłady „np. X”; reszta linii jest sprawdzana dalej.
const bezPrzykladow = (linia: string, wzor: RegExp) =>
  linia.replace(new RegExp(String.raw`\bnp\.\s*(?:${wzor.source})`, 'gi'), '');

/** Widoczna treść widoku: bez komentarzy ejs, HTML i CSS/JS blokowych; z kodu `<% … %>` zostają tylko napisy
 * w cudzysłowach (nazwy zmiennych i funkcji nie trafiają na ekran, napis może). `<%= %>` i `<%- %>` zostają całe.
 * Czysta funkcja — sprawdzana też wprost niżej. */
export function widocznaTresc(ejs: string): string {
  return ejs
    .replace(/<%#[\s\S]*?%>/g, '')
    .replace(/<%(?![=-])([\s\S]*?)%>/g, (_, kod: string) => (kod.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []).join(' '))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

export function naruszenia(plik: string, ejs: string, katalog: WpisKatalogu[] = KATALOG_INTEGRACJI): string[] {
  const tresc = widocznaTresc(ejs);
  const wynik: string[] = [];
  for (const { nazwa, wzor, opis } of PROGRAMY) {
    if (wKatalogu(nazwa, katalog)) continue;
    for (const linia of tresc.split('\n')) {
      if (!wzor.test(bezPrzykladow(linia, wzor))) continue;
      if (WYJATKI.some((w) => w.plik === plik && linia.includes(w.fragment))) continue;
      wynik.push(`${plik}: ${nazwa} (${opis}) — „${linia.trim().slice(0, 120)}”`);
    }
  }
  return wynik;
}

const widoki = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((p) => p.endsWith('.ejs'));

describe('widoki bez nazw programów, których produkt nie obsługuje', () => {
  it('znajduje widoki do sprawdzenia', () => {
    expect(widoki.length).toBeGreaterThan(40);
  });

  it('żaden widoczny tekst widoku nie odsyła do programu spoza produktu', () => {
    const wszystkie = widoki.flatMap((p) => naruszenia(p, readFileSync(`${ROOT}${p}`, 'utf8')));
    expect(wszystkie).toEqual([]);
  });

  it('wiadomość z zaproszeniem i resetem hasła nie mówi o „panelu zamówień”', () => {
    for (const cel of ['zaproszenie', 'reset']) {
      const { text } = trescMaila({ cel, imie: 'Ola', link: 'https://oms.example/x' });
      expect(text).not.toMatch(/panel\w*\s+zam[óo]wie[ńn]/i);
    }
  });

  it('wyjątki wskazują fragment, który naprawdę istnieje, i mają powód', () => {
    for (const w of WYJATKI) {
      expect(widoki).toContain(w.plik);
      expect(widocznaTresc(readFileSync(`${ROOT}${w.plik}`, 'utf8'))).toContain(w.fragment);
      expect(w.powod.length).toBeGreaterThan(20);
    }
  });

  it('skaner łapie każdy program w widocznym tekście, pomija komentarze, przykład „np.” i integracje z katalogu', () => {
    const pusty: WpisKatalogu[] = [];
    expect(naruszenia('src/x.ejs', '<p>nadaj w Apilo</p>', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<span>z APILO</span>', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>Zamówienia przyjdą z BaseLinkera.</p>', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>Eksport do Sellasist</p>', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', 'Integracja z panelem zamówień indywidualnych (API)', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', 'w panelu zamowien indywidualnych', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<label>API panelu (Dodaj do OMS)</label>', pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<%# Apilo, panel indywidualny %>', pusty)).toEqual([]);
    expect(naruszenia('src/x.ejs', '<%# wielo\nliniowy Apilo %><p>ok</p>', pusty)).toEqual([]);
    expect(naruszenia('src/x.ejs', '<!-- Apilo --><style>/* panel indywidualny */ .a{}</style>', pusty)).toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>termin: indywidualne — 7 dni</p>', pusty)).toEqual([]);
    expect(naruszenia('src/x.ejs', '<% notaBaseLinker() %>', pusty)).toEqual([]);
    expect(naruszenia('src/x.ejs', "<p><%= 'Apilo' %></p>", pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', "<% const t = 'Import z Apilo'; %><p><%= t %></p>", pusty)).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>podłączony do innego programu (np. BaseLinker)</p>', pusty)).toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>podłączony do innego programu (np. BaseLinker, np. Apilo)</p>', pusty)).toEqual(
      [],
    );
    // „np. X” zwalnia tylko sam przykład — reszta tej samej linii dalej się liczy.
    expect(naruszenia('src/x.ejs', '<p>Zamówienia z Apilo przyjdą tu same (np. Apilo Pro).</p>', pusty)).not.toEqual(
      [],
    );
    expect(
      naruszenia('src/x.ejs', '<p>Klucz API skopiuj z Apilo: np. Apilo → Ustawienia → API.</p>', pusty),
    ).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>nadaj w Apilo</p>', [{ nazwa: 'Apilo', dostepnosc: 'dostepna' }])).toEqual([]);
    expect(
      naruszenia('src/x.ejs', '<p>nadaj w Apilo</p>', [{ nazwa: 'Apilo', dostepnosc: 'przez_konfiguracje' }]),
    ).toEqual([]);
    // Integracja dopiero planowana — produkt jej jeszcze nie obsługuje.
    expect(naruszenia('src/x.ejs', '<p>nadaj w Apilo</p>', [{ nazwa: 'Apilo', dostepnosc: 'planowana' }])).not.toEqual(
      [],
    );
    expect(wKatalogu('Allegro', KATALOG_INTEGRACJI)).toBe(true);
  });
});
