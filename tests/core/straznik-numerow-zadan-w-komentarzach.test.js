// Strażnik: w komentarzach kodu `src/` nie ma numerów zadań pętli (wzorzec /PRZ-\d+/). Numer zadania w komentarzu
// starzeje się od razu i nic nie mówi obcej firmie, która czyta kod — historia zmian jest w gicie.
//
// Co jest komentarzem:
//   • .js .mjs .cjs .ts — komentarze z parsera TypeScriptu: drzewo z ts.createSourceFile, dla każdego tokenu
//     ts.getLeadingCommentRanges / ts.getTrailingCommentRanges. Napisy, szablony i wyrażenia regularne są
//     tokenami, więc 'http://…' albo 'PRZ-068' w napisie komentarzem nie są;
//   • .ejs — treść `<%# … %>` oraz komentarze `//` i `/* */` w scriptletach `<% %>`, `<%- %>`, `<%= %>`:
//     scriptlety idą do tego samego parsera jako jeden program (HTML między nimi zamieniony na spacje, znaczniki
//     na średniki — pozycje i numery linii zostają prawdziwe);
//   • .css — `/* … */`.
//
// Pomijamy pliki z sekcji „# kod” w docs/wyciecie-twojefaktury.txt (lista czytana z pliku): nie trafiają one do
// kopii publicznej, a w etapie porządków komentarzy przeszły tylko zamiany maszynowe.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const KORZEN = fileURLToPath(new URL('../../', import.meta.url));
const SRC = path.join(KORZEN, 'src');
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);
const ROZSZERZENIA = new Set([...KOD, '.ejs', '.css']);
const NUMER = /PRZ-\d+/;

/** Wpisy sekcji „# kod” listy wycięcia: od nagłówka `# kod` do następnego nagłówka `# `. */
function listaWyciecia() {
  const linie = fs.readFileSync(path.join(KORZEN, 'docs/wyciecie-twojefaktury.txt'), 'utf8').split(/\r?\n/);
  const wpisy = [];
  let wSekcji = false;
  for (const surowa of linie) {
    if (/^#\s/.test(surowa) || surowa === '#') {
      wSekcji = surowa.trim() === '# kod';
      continue;
    }
    if (!wSekcji) continue;
    const wpis = surowa.replace(/\s+#.*$/, '').trim();
    if (wpis && !wpis.startsWith('#')) wpisy.push(wpis);
  }
  return wpisy;
}

const pominiety = (wzgledna, wpisy) =>
  wpisy.some((w) => (w.endsWith('/') ? wzgledna.startsWith(w) : wzgledna === w));

function plikiSrc(katalog = SRC, wynik = []) {
  for (const wpis of fs.readdirSync(katalog, { withFileTypes: true })) {
    const pelna = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) plikiSrc(pelna, wynik);
    else if (ROZSZERZENIA.has(path.extname(wpis.name))) wynik.push(pelna);
  }
  return wynik;
}

/** Komentarze programu JS/TS jako `{ poz, tekst }` — z trivia tokenów drzewa składni. */
function komentarzeProgramu(nazwa, tekst, rodzaj) {
  const zrodlo = ts.createSourceFile(nazwa, tekst, ts.ScriptTarget.Latest, true, rodzaj);
  const znalezione = new Map();
  const dodaj = (zakresy) => {
    for (const z of zakresy ?? []) if (!znalezione.has(z.pos)) znalezione.set(z.pos, tekst.slice(z.pos, z.end));
  };
  const odwiedz = (wezel) => {
    dodaj(ts.getLeadingCommentRanges(tekst, wezel.pos));
    dodaj(ts.getTrailingCommentRanges(tekst, wezel.end));
    for (const dziecko of wezel.getChildren(zrodlo)) odwiedz(dziecko);
  };
  odwiedz(zrodlo);
  return [...znalezione].map(([poz, t]) => ({ poz, tekst: t }));
}

const ZNACZNIK_EJS = /<%([_#=-]?)([\s\S]*?)[-_]?%>/g;

function komentarzeEjs(nazwa, tekst) {
  const wynik = [];
  // Program ze scriptletów: wszystko poza kodem na spacje (z zachowaniem końców linii).
  const program = tekst.replace(/[^\r\n]/g, ' ').split('');
  for (const m of tekst.matchAll(ZNACZNIK_EJS)) {
    const [calosc, rodzaj, srodek] = m;
    const poczatekSrodka = m.index + 2 + rodzaj.length;
    if (rodzaj === '#') {
      wynik.push({ poz: m.index, tekst: calosc });
      continue;
    }
    program[m.index] = ';';
    for (let i = 0; i < srodek.length; i++) program[poczatekSrodka + i] = srodek[i];
    program[m.index + calosc.length - 1] = ';';
  }
  for (const k of komentarzeProgramu(`${nazwa}.js`, program.join(''), ts.ScriptKind.JS)) wynik.push(k);
  return wynik;
}

function komentarzeCss(tekst) {
  return [...tekst.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => ({ poz: m.index, tekst: m[0] }));
}

/** Komentarze pliku jako `{ poz, tekst }` według rozszerzenia. */
export function komentarze(nazwa, tekst) {
  const roz = path.extname(nazwa);
  if (KOD.has(roz)) return komentarzeProgramu(nazwa, tekst, roz === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (roz === '.ejs') return komentarzeEjs(nazwa, tekst);
  if (roz === '.css') return komentarzeCss(tekst);
  return [];
}

describe('komentarze w src bez numerów zadań', () => {
  const wpisy = listaWyciecia();
  const wszystkie = plikiSrc();
  const pominiete = wszystkie.filter((p) => pominiety(path.relative(KORZEN, p).split(path.sep).join('/'), wpisy));
  const sprawdzane = wszystkie.filter((p) => !pominiete.includes(p));

  it('lista wycięcia ma sekcję kodu, a skan widzi pliki', () => {
    expect(wpisy.length).toBeGreaterThan(0);
    expect(sprawdzane.length).toBeGreaterThan(100);
  });

  it('parser rozróżnia komentarz od napisu', () => {
    const js = "const a = 'http://x/PRZ-1'; const r = /PRZ-2/; const s = `${a} // PRZ-3`; // PRZ-4\n/* PRZ-5 */";
    expect(komentarze('a.js', js).map((k) => k.tekst)).toEqual(['// PRZ-4', '/* PRZ-5 */']);
    const ejs = "<p>PRZ-1</p><%# PRZ-2 %><% if (x) { // PRZ-3\n %><%= 'PRZ-4' %><% } %>";
    expect(komentarze('a.ejs', ejs).map((k) => k.tekst).sort()).toEqual(['// PRZ-3', '<%# PRZ-2 %>']);
  });

  it(`żaden komentarz nie zawiera numeru zadania (plików: ${sprawdzane.length}, pominiętych z listy wycięcia: ${pominiete.length})`, () => {
    console.log(`straznik numerow: sprawdzono ${sprawdzane.length} plikow, pominieto ${pominiete.length} z listy wyciecia`);
    const trafienia = [];
    for (const plik of sprawdzane) {
      const tekst = fs.readFileSync(plik, 'utf8');
      const linie = tekst.split('\n');
      for (const k of komentarze(plik, tekst)) {
        if (!NUMER.test(k.tekst)) continue;
        // Linia każdego trafienia wewnątrz komentarza (komentarz blokowy może mieć wiele linii).
        const start = tekst.slice(0, k.poz).split('\n').length;
        k.tekst.split('\n').forEach((czesc, i) => {
          if (NUMER.test(czesc)) {
            const nr = start + i;
            trafienia.push(`${path.relative(KORZEN, plik)}:${nr}: ${linie[nr - 1].trim()}`);
          }
        });
      }
    }
    expect(trafienia).toEqual([]);
  });
});
