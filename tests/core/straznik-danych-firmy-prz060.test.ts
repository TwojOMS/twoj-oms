// PRZ-060: strażnik paczki klienta — żaden plik, który `scripts/paczka-klienta.mjs` pakuje dla
// klienta, nie niesie nazw firmy właściciela, jej identyfikatorów ani prawdziwych numerów NIP/rachunku.
// Lista plików pochodzi z TEJ SAMEJ funkcji, którą buduje się paczkę (bez kopii listy), a dane
// firmy z historycznych fixture testów (bez drugiego wpisu tych wartości tutaj).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extname, basename } from 'node:path';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';
import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
import { MARKA_HISTORYCZNA } from '../pomoc/marka-poczty-fixture.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Nazwy firmy, marek i ich miejsc. Porównanie bez wielkości liter.
const SLOWA = [
  /szkicownia/i, /lumina/i, /drugamarka/i, /trzeciamarka/i, /amarka/i,
  /zywiecki/i, /fundacja przyk/i, /\bEwa\b/, /\b00-65[0-9]\b/, /\/root\/monitoring/, /c:[\\/]+users[\\/]+adam/i, /\\\\serwer|\/\/serwer/i, /192\.168\.0\./,
  // PRZ-073: nazwa biura rachunkowego właściciela. Wielka litera — „paragraf regulaminu” to nie ona.
  /\bBiuro Rachunkowe\b/,
];
// PRZ-073: GDD to kanał algorytmiczny produktu — jako identyfikator ('GDD' w kodzie, `GDD` w liście
// zastrzeżonych nazw w docs) zostaje. Każde INNE wystąpienie (zdanie na ekranie, komentarz
// o kliencie właściciela) to wiedza o firmie, nie o produkcie.
const gddPozaIdentyfikatorem = (tresc: string) => /\bGDD\b/.test(tresc.replaceAll("'GDD'", '').replaceAll('`GDD`', ''));

// Jawne wyjątki: dokładny plik + dokładna wartość + powód. Bez wyjątków „na zapas”.
const WYJATKI_NIP: Record<string, { plik: string; powod: string }[]> = {
  '5252674798': [
    { plik: 'src/domena/wskazniki-zarzadcze.js', powod: 'NIP Allegro.pl sp. z o.o. — publiczny identyfikator platformy; po nim wskaźniki rozpoznają faktury prowizji Allegro (reguła produktu, nie dane właściciela).' },
    { plik: 'src/domena/koszt-metadane.js', powod: 'Ten sam publiczny NIP Allegro jako przykład zapisu z kreskami i bez (komentarz o normalizacji klucza kosztu).' },
    { plik: 'src/oms/db/kategorie-kosztow.js', powod: 'Ten sam publiczny NIP Allegro jako przykład zapisu z kreskami i bez (komentarz o kluczu głównym kategorii).' },
  ],
  '1234563218': [
    { plik: 'src/moduly/koszty/pdf/zestawienie-dla-biura-pdf.js', powod: 'Fikcyjny NIP przykładowy (ten sam co w fixture testów) w komentarzu o szerokości numeru KSeF.' },
    { plik: 'scripts/instalacja-przygotuj.mjs', powod: 'Fikcyjny NIP instalacji próbnej (konfiguracja bez danych firmy, PRZ-050).' },
  ],
};
const WYJATKI_RACHUNEK: Record<string, { plik: string; powod: string }[]> = {
  '34109010140000000000000000': [{ plik: 'scripts/instalacja-przygotuj.mjs', powod: 'Fikcyjny rachunek instalacji próbnej (konfiguracja bez danych firmy, PRZ-050).' }],
};
const FIKCYJNE_VAT_UE = new Set(['SK1234567890', 'SK1098765431', 'DE123456789']);

const TEKSTOWE = new Set(['.js', '.mjs', '.ts', '.ejs', '.css', '.sql', '.json', '.md', '.sh', '.yaml', '.yml', '.txt', '']);
const tekstowy = (p: string) => TEKSTOWE.has(extname(p).toLowerCase()) || basename(p) === 'Dockerfile';

function czyNip(cyfry: string) {
  if (!/^\d{10}$/.test(cyfry)) return false;
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const suma = wagi.reduce((s, w, i) => s + w * Number(cyfry[i]), 0) % 11;
  return suma !== 10 && suma === Number(cyfry[9]);
}
function czyRachunekPl(cyfry: string) {
  if (!/^\d{26}$/.test(cyfry)) return false;
  const liczba = `${cyfry.slice(2)}2521${cyfry.slice(0, 2)}`; // PL = 25 21
  let reszta = 0;
  for (const c of liczba) reszta = (reszta * 10 + Number(c)) % 97;
  return reszta === 1;
}

/** Naruszenia w treści jednego pliku paczki. Czysta funkcja — sprawdzana też wprost niżej. */
export function naruszenia(plik: string, tresc: string): string[] {
  const wynik: string[] = [];
  for (const wzor of SLOWA) if (wzor.test(tresc)) wynik.push(`${plik}: słowo firmy ${wzor}`);
  if (gddPozaIdentyfikatorem(tresc)) wynik.push(`${plik}: GDD poza identyfikatorem kanału 'GDD'`);
  for (const nazwa of [MARKA_HISTORYCZNA.podpis, MARKA_HISTORYCZNA.naglowek, ...definicjeKanalowHistoryczne.map((d) => d.etykieta)])
    if (nazwa && tresc.toLowerCase().includes(nazwa.toLowerCase())) wynik.push(`${plik}: historyczna nazwa „${nazwa}”`);
  if (!tekstowy(plik)) return wynik;
  for (const m of tresc.matchAll(/(?<![\d-])\d{3}[- ]?\d{3}[- ]?\d{2}[- ]?\d{2}(?![\d-])/g)) {
    const cyfry = m[0].replace(/[- ]/g, '');
    if (!czyNip(cyfry)) continue;
    if (WYJATKI_NIP[cyfry]?.some((w) => w.plik === plik)) continue;
    wynik.push(`${plik}: NIP z poprawną sumą kontrolną ${cyfry}`);
  }
  for (const m of tresc.matchAll(/(?<!\d)(?:PL)?\d{2}(?: ?\d{4}){6}(?!\d)/g)) {
    const cyfry = m[0].replace(/^PL/, '').replaceAll(' ', '');
    if (czyRachunekPl(cyfry) && !WYJATKI_RACHUNEK[cyfry]?.some((w) => w.plik === plik)) wynik.push(`${plik}: numer rachunku z poprawną sumą kontrolną`);
  }
  for (const m of tresc.matchAll(/\b(?:SK|CZ|DE|AT|LT|LV|EE|HU|SI|HR|RO|BG|FR|IT|ES|NL|BE|LU|DK|SE|FI|IE|PT|GR|CY|MT)\d{8,12}\b/g))
    if (!FIKCYJNE_VAT_UE.has(m[0])) wynik.push(`${plik}: numer VAT UE ${m[0].slice(0, 2)}… spoza fikcyjnych przykładów`);
  return wynik;
}

const sledzone = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const paczka = plikiPaczki(sledzone).filter((p: string) => { try { readFileSync(`${ROOT}${p}`); return true; } catch { return false; } });

describe('PRZ-060 — paczka klienta bez danych firmy właściciela', () => {
  it('lista plików jest tą z paczki i obejmuje src/, deploy/klient/ i package.json', () => {
    expect(paczka.length).toBeGreaterThan(400);
    expect(paczka).toContain('package.json');
    expect(paczka.some((p: string) => p.startsWith('deploy/klient/'))).toBe(true);
    expect(paczka.filter((p: string) => p.startsWith('src/')).length).toBeGreaterThan(400);
  });

  it('żaden plik paczki nie niesie nazw, identyfikatorów ani prawdziwych numerów firmy', () => {
    const wszystkie = paczka.flatMap((p: string) => {
      const bajty = readFileSync(`${ROOT}${p}`);
      return naruszenia(p, tekstowy(p) ? bajty.toString('utf8') : bajty.toString('latin1'));
    });
    expect(wszystkie).toEqual([]);
  });

  it('każdy wyjątek wskazuje plik paczki, który naprawdę go zawiera', () => {
    for (const [nip, lista] of [...Object.entries(WYJATKI_NIP), ...Object.entries(WYJATKI_RACHUNEK)]) for (const w of lista) {
      expect(paczka).toContain(w.plik);
      expect(readFileSync(`${ROOT}${w.plik}`, 'utf8')).toContain(nip);
      expect(w.powod.length).toBeGreaterThan(20);
    }
  });

  it('skaner łapie każde słowo i każdy rodzaj numeru (bez tego zielone nic nie znaczy)', () => {
    for (const tekst of ['// sklep Szkicownia.pl', 'LUMINA', 'drugamarka', 'Trzeciamarka', 'Amarka', 'Zywiecki', 'Fundacja Fundacja Przykładowa',
      'C:\\Users\\adam\\x', '\\\\serwer\\indyw', '192.168.0.10', 'rola Ewa', 'kod 00-650', '/root/monitoring.sh']) expect(naruszenia('src/x.js', tekst)).not.toEqual([]);
    expect(naruszenia('src/x.js', 'NIP 100-000-11-93')).toEqual(['src/x.js: NIP z poprawną sumą kontrolną 1000001193']);
    expect(naruszenia('src/x.js', 'NIP 100 000 11 93')).toEqual(['src/x.js: NIP z poprawną sumą kontrolną 1000001193']);
    expect(naruszenia('src/x.js', 'saga i Julia')).toEqual([]);
    expect(naruszenia('src/x.ejs', 'Wiążące są liczby biura „Biuro Rachunkowe".')).not.toEqual([]);
    expect(naruszenia('src/x.js', '// Wiazace sa liczby biura Biuro Rachunkowe.')).not.toEqual([]);
    expect(naruszenia('src/x.js', 'paragraf 3 regulaminu')).toEqual([]);
    expect(naruszenia('src/x.js', "tresc: 'Po granicy historii kanał GDD nie istnieje —'")).not.toEqual([]);
    expect(naruszenia('src/x.js', '// klient GDD zamawia z konta 21')).not.toEqual([]);
    expect(naruszenia('src/x.js', "return 'GDD'; const t = klasyfikacja.tagGdd;")).toEqual([]);
    expect(naruszenia('docs/x.md', 'zastrzeżone: `DROPSHIPPING`, `GDD`, `INDYWIDUALNE`')).toEqual([]);
    expect(naruszenia('src/x.js', 'rachunek PL61 1090 1014 0000 0712 1981 2874')).toEqual(['src/x.js: numer rachunku z poprawną sumą kontrolną']);
    expect(naruszenia('src/x.js', 'VAT SK1000000001')).not.toEqual([]);
    expect(naruszenia('src/x.js', '5252674798')).not.toEqual([]); // wyjątek działa tylko w swoim pliku
    expect(naruszenia('src/x.js', 'zwykły tekst 1234567890 i 12345678901234567890123456')).toEqual([]);
    expect(naruszenia('src/public/x.png', 'binarne SZKICOWNIA')).not.toEqual([]);
  });
});
