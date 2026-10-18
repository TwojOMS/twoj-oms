// PRZ-093.05: widoczne teksty w widokach `src/**/*.ejs` nie mówią obcej firmie o rzeczach, których nie ma.
// Dwie takie rzeczy znalazł przegląd 17.10: osobna aplikacja do zamówień indywidualnych (obca firma jej
// nie ma) i dawny system sprzedawcy, z którego pochodzi historia importu. Komentarze (`<%# … %>`,
// `<!-- … -->`, `/* … */`) czytają programiści, nie użytkownicy — strażnik patrzy na to, co widać na ekranie.
// Uzupełnia `straznik-danych-firmy-prz060.test.ts` (nazwy firmy i numery) o wiedzę o jej oprogramowaniu.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trescMaila } from '../../src/moduly/ustawienia/poczta-kont.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const WZORCE: { wzor: RegExp; opis: string }[] = [
  { wzor: /apilo/i, opis: 'Apilo (dawny system właściciela)' },
  { wzor: /panel\w*\s+zam[óo]wie[ńn]\s+indywidualn/i, opis: 'panel zamówień indywidualnych (aplikacja właściciela)' },
  { wzor: /panel\w*\s+indywidualn/i, opis: 'panel indywidualny (aplikacja właściciela)' },
  { wzor: /dodaj do OMS/i, opis: '„Dodaj do OMS” (przycisk w aplikacji właściciela)' },
];

// Jawne wyjątki: plik + fragment + powód. Pusta lista = żaden widoczny tekst nie jest wyjątkiem.
const WYJATKI: { plik: string; fragment: string; powod: string }[] = [];

/** Widoczna treść widoku: bez komentarzy ejs, HTML i CSS/JS blokowych. Czysta funkcja — sprawdzana też wprost niżej. */
export function widocznaTresc(ejs: string): string {
  return ejs.replace(/<%#[\s\S]*?%>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function naruszenia(plik: string, ejs: string): string[] {
  const tresc = widocznaTresc(ejs);
  const wynik: string[] = [];
  for (const { wzor, opis } of WZORCE) {
    for (const linia of tresc.split('\n')) {
      if (wzor.test(linia) && !WYJATKI.some((w) => w.plik === plik && linia.includes(w.fragment)))
        wynik.push(`${plik}: ${opis} — „${linia.trim().slice(0, 120)}”`);
    }
  }
  return wynik;
}

const widoki = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((p) => p.endsWith('.ejs'));

describe('PRZ-093.05 — widoki bez śladów oprogramowania właściciela', () => {
  it('znajduje widoki do sprawdzenia', () => {
    expect(widoki.length).toBeGreaterThan(40);
  });

  it('żaden widoczny tekst widoku nie wspomina Apilo ani panelu zamówień indywidualnych', () => {
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

  it('skaner łapie każdy wzorzec w widocznym tekście i pomija komentarze (bez tego zielone nic nie znaczy)', () => {
    expect(naruszenia('src/x.ejs', '<p>nadaj w Apilo</p>')).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<span>z APILO</span>')).not.toEqual([]);
    expect(naruszenia('src/x.ejs', 'Integracja z panelem zamówień indywidualnych (API)')).not.toEqual([]);
    expect(naruszenia('src/x.ejs', 'w panelu zamowien indywidualnych')).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<label>API panelu (Dodaj do OMS)</label>')).not.toEqual([]);
    expect(naruszenia('src/x.ejs', '<%# Apilo, panel indywidualny %>')).toEqual([]);
    expect(naruszenia('src/x.ejs', '<%# wielo\nliniowy Apilo %><p>ok</p>')).toEqual([]);
    expect(naruszenia('src/x.ejs', '<!-- Apilo --><style>/* panel indywidualny */ .a{}</style>')).toEqual([]);
    expect(naruszenia('src/x.ejs', '<p>termin: indywidualne — 7 dni</p>')).toEqual([]);
  });
});
