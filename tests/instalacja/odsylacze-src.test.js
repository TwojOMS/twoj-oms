// Komunikaty w `src/` nie odsyłają do nieistniejących skryptów. Obcy sprzedawca, który dostaje
// „uruchom scripts/x.js”, a takiego pliku nie ma, zostaje z kanałem, który milczy dalej.
// Test przechodzi src/**/*.{js,ts,mjs,ejs}, wycina komentarze i w pozostałym tekście szuka
// odwołań `scripts/<nazwa>.(js|mjs|ts|sh)` (także `/app/scripts/…`, `../scripts/…`,
// `src/…/scripts/…`). Każda wskazana ścieżka musi istnieć w repo. Martwe ścieżki w samych
// komentarzach nie są tu sprawdzane.
//
// Wycinanie komentarzy:
// - .js/.ts/.mjs — prosty skaner znak po znaku, który zna napisy ('…', "…", `…` z ${…})
//   i literały wyrażeń regularnych. `//` i `/* */` liczą się jako komentarz tylko poza napisem,
//   więc `https://…` w napisie nie ucina kodu, a 'src/**/*.js' w napisie nie otwiera komentarza.
// - .ejs — tekst to głównie HTML (apostrofy bez pary), więc bez śledzenia napisów: wycinane są
//   `<%# … %>` (także wielowierszowe), `/* … */`, `//…` na początku wiersza albo po białym
//   znaku (nie `https://`).
// - w obu: wiersze zaczynające się (po wcięciu) od `*`.
// Wycięte znaki zastępuje spacja, a znaki nowego wiersza zostają — numery linii się zgadzają.
// Fałszywą zieleń (skaner, który nic nie widzi) łapie asercja liczby odwołań do istniejących plików.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KORZEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROZSZERZENIA = new Set(['.js', '.ts', '.mjs', '.ejs']);
const ODWOLANIE = /((?:\.{1,2}\/|\/app\/|[A-Za-z0-9_-]+\/)*)scripts\/([A-Za-z0-9_.-]+\.(?:js|mjs|ts|sh))(?![A-Za-z0-9_])/g;

function pliki(katalog) {
  const wynik = [];
  for (const wpis of fs.readdirSync(katalog, { withFileTypes: true })) {
    const p = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) wynik.push(...pliki(p));
    else if (ROZSZERZENIA.has(path.extname(wpis.name))) wynik.push(p);
  }
  return wynik;
}

const zamaz = (s) => s.replace(/[^\n]/g, ' ');

// Skaner JS/TS: zwraca tekst tej samej długości z komentarzami zamienionymi na spacje.
export function bezKomentarzyJs(zrodlo) {
  let wynik = '';
  let i = 0;
  const n = zrodlo.length;
  const stos = []; // otwarte szablony `…${ — głębokość klamer wewnątrz ${…}
  let ostatniZnaczacy = ''; // do odróżnienia regexu od dzielenia
  const poRegexDozwolony = (c) => c === '' || '(,=:[!&|?{};+-*%<>~^'.includes(c);
  while (i < n) {
    const c = zrodlo[i];
    const d = zrodlo[i + 1];
    if (c === '/' && d === '/') {
      let j = zrodlo.indexOf('\n', i);
      if (j === -1) j = n;
      wynik += zamaz(zrodlo.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = zrodlo.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      wynik += zamaz(zrodlo.slice(i, j));
      i = j;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && zrodlo[j] !== c && zrodlo[j] !== '\n') j += zrodlo[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      wynik += zrodlo.slice(i, j);
      i = j;
      ostatniZnaczacy = 'a';
      continue;
    }
    if (c === '`' || (c === '}' && stos.length && stos[stos.length - 1] === 0)) {
      if (c === '}') stos.pop();
      let j = i + 1;
      while (j < n && zrodlo[j] !== '`' && !(zrodlo[j] === '$' && zrodlo[j + 1] === '{')) j += zrodlo[j] === '\\' ? 2 : 1;
      if (j < n && zrodlo[j] === '$') { stos.push(0); j += 2; ostatniZnaczacy = '{'; } else { j = Math.min(j + 1, n); ostatniZnaczacy = 'a'; }
      wynik += zrodlo.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/' && poRegexDozwolony(ostatniZnaczacy)) {
      let j = i + 1;
      let klasa = false;
      while (j < n && zrodlo[j] !== '\n' && (klasa || zrodlo[j] !== '/')) {
        if (zrodlo[j] === '\\') j += 1;
        else if (zrodlo[j] === '[') klasa = true;
        else if (zrodlo[j] === ']') klasa = false;
        j += 1;
      }
      j = Math.min(j + 1, n);
      wynik += zrodlo.slice(i, j);
      i = j;
      ostatniZnaczacy = 'a';
      continue;
    }
    if (stos.length && c === '{') stos[stos.length - 1] += 1;
    if (stos.length && c === '}') stos[stos.length - 1] -= 1;
    if (!/\s/.test(c)) ostatniZnaczacy = /[A-Za-z0-9_$)\]]/.test(c) ? 'a' : c;
    wynik += c;
    i += 1;
  }
  return wynik;
}

export function bezKomentarzyEjs(zrodlo) {
  return zrodlo
    .replace(/<%#[\s\S]*?%>/g, zamaz)
    .replace(/\/\*[\s\S]*?\*\//g, zamaz)
    .replace(/(^|\s)\/\/[^\n]*/gm, (m, przed) => przed + zamaz(m.slice(przed.length)));
}

function bezWierszyGwiazdki(tekst) {
  return tekst.split('\n').map((w) => (/^\s*\*/.test(w) ? zamaz(w) : w)).join('\n');
}

export function odwolania(plik, tekst) {
  const czysty = bezWierszyGwiazdki(plik.endsWith('.ejs') ? bezKomentarzyEjs(tekst) : bezKomentarzyJs(tekst));
  const wynik = [];
  for (const m of czysty.matchAll(ODWOLANIE)) {
    const przedrostek = m[1];
    const wzgledna = przedrostek.startsWith('./') || przedrostek.startsWith('../');
    const baza = wzgledna ? path.dirname(plik) : KORZEN;
    const cel = path.resolve(baza, przedrostek.replace(/^\/app\//, ''), 'scripts', m[2]);
    const linia = czysty.slice(0, m.index).split('\n').length;
    wynik.push({ linia, tekst: m[0], cel });
  }
  return wynik;
}

describe('odsyłacze do scripts/ w kodzie src/ (poza komentarzami)', () => {
  it('skaner pomija komentarze, ale nie ucina kodu na // w napisie', () => {
    const js = [
      "const a = 'https://example.invalid/x'; const b = 'node scripts/brak-a.js';",
      '// node scripts/brak-b.js',
      '/* scripts/brak-c.js',
      ' * scripts/brak-d.js */',
      "const g = 'src/**/*.js'; const h = `${x} scripts/brak-e.sh`;",
      'const r = /["]/; const t = `/app/scripts/brak-f.mjs`;',
    ].join('\n');
    const znalezione = odwolania(path.join(KORZEN, 'src/x.js'), js).map((o) => [o.linia, path.basename(o.cel)]);
    expect(znalezione).toEqual([[1, 'brak-a.js'], [5, 'brak-e.sh'], [6, 'brak-f.mjs']]);
    const ejs = "<%# scripts/brak-a.js %>\n<a href=\"https://x.invalid\">scripts/brak-b.js</a> // scripts/brak-c.js";
    expect(odwolania(path.join(KORZEN, 'src/x.ejs'), ejs).map((o) => path.basename(o.cel))).toEqual(['brak-b.js']);
  });

  it('każda ścieżka scripts/… poza komentarzem istnieje w repo', () => {
    const martwe = [];
    let istniejace = 0;
    for (const plik of pliki(path.join(KORZEN, 'src'))) {
      for (const o of odwolania(plik, fs.readFileSync(plik, 'utf8'))) {
        if (fs.existsSync(o.cel)) istniejace += 1;
        else martwe.push(`${path.relative(KORZEN, plik)}:${o.linia}: ${o.tekst} (brak ${path.relative(KORZEN, o.cel)})`);
      }
    }
    expect(martwe, `martwe odsyłacze:\n${martwe.join('\n')}`).toEqual([]);
    // kontrola skanera: inaczej pusty skan dałby zieleń
    expect(istniejace).toBeGreaterThan(0);
  });
});
