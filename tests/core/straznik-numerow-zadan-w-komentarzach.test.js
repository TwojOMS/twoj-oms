// Strażnik: w komentarzach kodu nie ma numerów zadań pętli (wzorzec /PRZ-\d+/). Numer zadania w komentarzu
// starzeje się od razu i nic nie mówi obcej firmie, która czyta kod — historia zmian jest w gicie.
//
// Zasięg:
//   • `src/` (.js .mjs .cjs .ts .ejs .css) i `tests/` (te same rozszerzenia);
//   • pliki `scripts/` i `deploy/` z listy SKRYPTY_I_DEPLOY poniżej — czyli te, które trafiają do kopii publicznej.
//     Pozostałe skrypty zostają poza zasięgiem, bo obca firma ich nie czyta. Plik z listy, którego nie ma w drzewie,
//     robi test czerwonym, żeby lista nie starzała się po cichu.
//
// Co jest komentarzem:
//   • .js .mjs .cjs .ts — komentarze z parsera TypeScriptu: drzewo z ts.createSourceFile, dla każdego tokenu
//     ts.getLeadingCommentRanges / ts.getTrailingCommentRanges. Napisy, szablony i wyrażenia regularne są
//     tokenami, więc 'http://…' albo numer zadania w napisie komentarzem nie są;
//   • .ejs — treść `<%# … %>` oraz komentarze `//` i `/* */` w scriptletach `<% %>`, `<%- %>`, `<%= %>`:
//     scriptlety idą do tego samego parsera jako jeden program (HTML między nimi zamieniony na spacje, znaczniki
//     na średniki — pozycje i numery linii zostają prawdziwe);
//   • .css — `/* … */`;
//   • .sh .yaml .yml .ps1 Dockerfile — komentarze `#`: linia zaczynająca się od `#` albo ` #` po kodzie, gdy przed nim
//     nie ma otwartego cudzysłowu (prosta reguła, nie pełny parser powłoki). Shebang `#!` komentarzem nie jest.
//     Tak odczytany napis z numerem w skrypcie (np. tekst komunikatu) nie jest komentarzem;
//   • .md i .json nie mają komentarzy — pomijane.
// Tytuły testów (`describe`, `it`, `test`) w `tests/` sprawdza osobny test niżej: stała część pierwszego argumentu
// (napis, szablon bez `${…}`), także przy `.each`, `.skip`, `.concurrent`. Liczone ze źródła, nie z `vitest list` —
// lista całego repo trwa minuty. Luka: część tytułu z danych `.each` (`%s`, `$x`) i ze zmiennych nie jest widoczna.
// Tu wzorzec obejmuje też numer bez łącznika (`PRZ027F`), bo w tytułach taki się trafiał.
//
// Pomijamy (nie ruszamy ich treści):
//   • pliki z sekcji „# kod”, „# testy” (i gołe ścieżki pod „# linie”) w docs/wyciecie-twojefaktury.txt (lista
//     czytana z pliku): nie trafiają do kopii publicznej, a w porządkach komentarzy przeszły tylko zamiany maszynowe;
//   • TESTY_USUWANE_Z_KOPII — testy, które budowa kopii publicznej usuwa; jej lista leży poza tym repo, więc jest
//     tu przepisana;
//   • dane zamiast kodu: `__migawki__/`, `*.snap`, `tests/fixtures/`, `tests/dane/` oraz zamrożony klient
//     `tests/pomoc/klient-oms-frozen.js`.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const KORZEN = fileURLToPath(new URL('../../', import.meta.url));
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);
const ROZSZERZENIA = new Set([...KOD, '.ejs', '.css']);
const HASZ = new Set(['.sh', '.yaml', '.yml', '.ps1']);
const NUMER = /PRZ-\d+/;

const TESTY_USUWANE_Z_KOPII = [
  'tests/core/mapa-prz-010.test.ts',
  'tests/core/przenoszenie.test.ts',
  'tests/core/straznik-klienta-wlasciciela.test.ts',
  'tests/instalacja/atrapa-iptables.mjs',
  'tests/instalacja/demo-publiczne-izolacja.test.js',
  'tests/instalacja/demo-reset-prz083.test.js',
  'tests/instalacja/demo-vm-izolacja.test.js',
  'tests/instalacja/demo-wydanie.test.js',
  'tests/instalacja/eksport-publiczny-prz129.test.js',
  'tests/instalacja/klucz-env-skrypt-prz182.test.js',
  'tests/instalacja/konfiguracja-klucz-prz182.test.js',
  'tests/instalacja/proba-vm-zapora.test.js',
  'tests/integracje/prz119-pomiary-skrypt.test.js',
  'tests/oms/oms-production-marker.test.js',
  'tests/oms/oms-release-guard.test.js',
  'tests/oms/oms-release-przejscie.test.js',
  'tests/oms/oms-release-przenosiny-vm.test.js',
  'tests/oms/oms-release-remote-contract.test.js',
  'tests/oms/oms-release-remote-klucz-prz182.test.js',
  'tests/oms/oms-release-remote-przejscie.test.js',
  'tests/oms/oms-release-remote-retry.test.js',
  'tests/oms/oms-runtime-manifest.test.js',
  'tests/oms/proba-ps1-cel.test.js',
  'tests/oms/prz147-proba-korekty-sandbox.test.js',
  'tests/oms/prz151-proba-ksef-korekty-sandbox.test.js',
  'tests/oms/reset-proba-sandbox-prz149.test.js',
  'tests/oms/wydaj-ps1-cel.test.js',
  'tests/prz062/mutacje-prz058-kotwice.test.ts',
];

const SKRYPTY_I_DEPLOY = [
  'deploy/demo/baza.mjs',
  'deploy/demo/cykl.mjs',
  'deploy/demo/klucz-demo.mjs',
  'deploy/demo/nastepna.mjs',
  'deploy/demo/reset.mjs',
  'deploy/demo/sonda.mjs',
  'deploy/demo/start.mjs',
  'deploy/drukarka/README.md',
  'deploy/drukarka/config-faktury.przyklad.json',
  'deploy/drukarka/config.przyklad.json',
  'deploy/drukarka/czuwacz-etykiet.ps1',
  'deploy/drukarka/czuwacz-faktur.ps1',
  'deploy/klient/Dockerfile',
  'deploy/klient/aktualizuj.sh',
  'deploy/klient/compose.yaml',
  'deploy/klient/diagnostyka.sh',
  'deploy/klient/kopia.mjs',
  'deploy/zdjecia/Dockerfile',
  'deploy/zdjecia/README.md',
  'deploy/zdjecia/compose.yaml',
  'deploy/zdjecia/tunel.yml',
  'scripts/backup-db.mjs',
  'scripts/backup-rotation.mjs',
  'scripts/demo-dane-erli.mjs',
  'scripts/demo-dane-firma.mjs',
  'scripts/demo-dane-katalog.mjs',
  'scripts/demo-dane.mjs',
  'scripts/demo-zdjecia-rysunki.mjs',
  'scripts/inicjalizuj-granice-bez-historii.mjs',
  'scripts/instalacja-demo.mjs',
  'scripts/instalacja-kontener.mjs',
  'scripts/instalacja-otworz.mjs',
  'scripts/instalacja-proba.mjs',
  'scripts/instalacja-przygotuj.mjs',
  'scripts/instalacja-wspolne.mjs',
  'scripts/link-hasla-admina.mjs',
  'scripts/oms-import-istniejacy-podjazd-dpd.mjs',
  'scripts/oms-reklamy-odswiez.mjs',
  'scripts/oms-reklamy-polacz.mjs',
  'scripts/oms-reklamy-provision.mjs',
  'scripts/paczka-klienta.mjs',
  'scripts/produkcja-pierwszy-start.mjs',
  'scripts/sekrety.mjs',
  'scripts/straznik-kanalow.mjs',
  'scripts/straznik-konfiguracji.mjs',
  'scripts/straznik-kurierow.mjs',
  'scripts/straznik-migracji.mjs',
  'scripts/straznik-sekretow.mjs',
  'scripts/uruchom-lokalnie.mjs',
  'scripts/zmienne-panel.mjs',
  'scripts/zmienne-tabela.mjs',
];

const KATALOGI_DANYCH = ['tests/fixtures/', 'tests/dane/'];
const ZAMROZONE = ['tests/pomoc/klient-oms-frozen.js'];

/** Wpisy sekcji listy wycięcia: od nagłówka `# <nazwa>` do następnego nagłówka (wiersz `# słowa` bez znaków przestankowych). */
function listaWyciecia(sekcja) {
  // Kopia publiczna nie ma modułu TwojeFaktury ani jego listy wycięcia — nie ma czego pomijać.
  const plikListy = path.join(KORZEN, 'docs/wyciecie-twojefaktury.txt');
  if (!fs.existsSync(plikListy)) return [];
  const linie = fs.readFileSync(plikListy, 'utf8').split(/\r?\n/);
  const wpisy = [];
  let wSekcji = false;
  for (const surowa of linie) {
    if (/^#( [\p{L} ]+)?$/u.test(surowa.trim())) {
      wSekcji = surowa.trim() === `# ${sekcja}`;
      continue;
    }
    if (!wSekcji) continue;
    const wpis = surowa.replace(/\s+#.*$/, '').trim();
    if (wpis && !wpis.startsWith('#')) wpisy.push(wpis);
  }
  return wpisy;
}

const pominiety = (wzgledna, wpisy) => wpisy.some((w) => (w.endsWith('/') ? wzgledna.startsWith(w) : wzgledna === w));

const wzgl = (p) => path.relative(KORZEN, p).split(path.sep).join('/');

function plikiKatalogu(katalog, wynik = []) {
  for (const wpis of fs.readdirSync(katalog, { withFileTypes: true })) {
    const pelna = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) {
      if (wpis.name === '__migawki__' || wpis.name === 'node_modules') continue;
      plikiKatalogu(pelna, wynik);
    } else if (ROZSZERZENIA.has(path.extname(wpis.name))) wynik.push(pelna);
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

const NUMER_W_TYTULE = /PRZ-?\d+/;
const FUNKCJE_TESTOW = new Set(['describe', 'it', 'test']);

/** Pierwszy identyfikator łańcucha wywołania: `it`, `describe.skip`, `test.each([...])` → nazwa funkcji testów. */
function korzenWywolania(wyrazenie) {
  let w = wyrazenie;
  for (;;) {
    if (ts.isIdentifier(w)) return w.text;
    if (ts.isPropertyAccessExpression(w)) w = w.expression;
    else if (ts.isCallExpression(w) || ts.isTaggedTemplateExpression(w))
      w = ts.isCallExpression(w) ? w.expression : w.tag;
    else return null;
  }
}

/** Stałe części tytułów testów jako `{ poz, tekst }` — pierwszy argument wywołania `describe`/`it`/`test`. */
export function tytulyTestow(nazwa, tekst) {
  const zrodlo = ts.createSourceFile(
    nazwa,
    tekst,
    ts.ScriptTarget.Latest,
    true,
    nazwa.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const tytuly = [];
  const odwiedz = (wezel) => {
    if (ts.isCallExpression(wezel) && FUNKCJE_TESTOW.has(korzenWywolania(wezel.expression) ?? '')) {
      const a = wezel.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)))
        tytuly.push({ poz: a.getStart(zrodlo), tekst: a.text });
      else if (a && ts.isTemplateExpression(a)) {
        tytuly.push({
          poz: a.getStart(zrodlo),
          tekst: [a.head.text, ...a.templateSpans.map((s) => s.literal.text)].join('…'),
        });
      }
    }
    ts.forEachChild(wezel, odwiedz);
  };
  odwiedz(zrodlo);
  return tytuly;
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

/** Komentarze `#` skryptów powłoki, YAML-a, PowerShella i Dockerfile (prosta reguła, nie pełny parser). */
function komentarzeHasz(tekst) {
  const wynik = [];
  let poz = 0;
  for (const linia of tekst.split('\n')) {
    const wciecie = linia.length - linia.trimStart().length;
    if (linia[wciecie] === '#') {
      if (linia[wciecie + 1] !== '!') wynik.push({ poz: poz + wciecie, tekst: linia.slice(wciecie) });
    } else {
      for (const m of linia.matchAll(/\s#(?=\s|$)/g)) {
        const przed = linia.slice(0, m.index);
        if ((przed.match(/'/g) ?? []).length % 2 === 0 && (przed.match(/"/g) ?? []).length % 2 === 0) {
          wynik.push({ poz: poz + m.index + 1, tekst: linia.slice(m.index + 1) });
          break;
        }
      }
    }
    poz += linia.length + 1;
  }
  return wynik;
}

/** Komentarze pliku jako `{ poz, tekst }` według rozszerzenia. */
export function komentarze(nazwa, tekst) {
  const roz = path.extname(nazwa);
  if (KOD.has(roz)) return komentarzeProgramu(nazwa, tekst, roz === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (roz === '.ejs') return komentarzeEjs(nazwa, tekst);
  if (roz === '.css') return komentarzeCss(tekst);
  if (HASZ.has(roz) || path.basename(nazwa) === 'Dockerfile') return komentarzeHasz(tekst);
  return [];
}

describe('komentarze bez numerów zadań', () => {
  // Lista wycięcia ma też gołe ścieżki testów pod nagłówkiem „# linie” (bez „ :: treść”) — to całe pliki do wycięcia.
  const testyZLinii = listaWyciecia('linie').filter((w) => !w.includes(' :: '));
  const pomijaneTesty = [...listaWyciecia('kod'), ...listaWyciecia('testy'), ...testyZLinii, ...TESTY_USUWANE_Z_KOPII];
  const zdatne = (p) => {
    const w = wzgl(p);
    return !pominiety(w, pomijaneTesty) && !pominiety(w, KATALOGI_DANYCH) && !ZAMROZONE.includes(w);
  };
  const src = plikiKatalogu(path.join(KORZEN, 'src'));
  const pominieteSrc = src.filter((p) => pominiety(wzgl(p), listaWyciecia('kod')));
  const sprawdzaneSrc = src.filter((p) => !pominieteSrc.includes(p));
  const testy = plikiKatalogu(path.join(KORZEN, 'tests')).filter(zdatne);
  const skrypty = SKRYPTY_I_DEPLOY.map((p) => path.join(KORZEN, p)).filter((p) => fs.existsSync(p));
  const sprawdzane = [...sprawdzaneSrc, ...testy, ...skrypty];

  it('listy wycięcia mają sekcje, a skan widzi pliki', () => {
    expect(listaWyciecia('kod')).toEqual([]);
    expect(listaWyciecia('testy')).toEqual([]);
    expect(sprawdzaneSrc.length).toBeGreaterThan(100);
    expect(testy.length).toBeGreaterThan(100);
  });

  it('każdy plik z listy skryptów i deploy istnieje', () => {
    const brakujace = SKRYPTY_I_DEPLOY.filter((p) => !fs.existsSync(path.join(KORZEN, p)));
    expect(brakujace).toEqual([]);
  });

  it('parser rozróżnia komentarz od napisu', () => {
    const js = "const a = 'http://x/PRZ-1'; const r = /PRZ-2/; const s = `${a} // PRZ-3`; // PRZ-4\n/* PRZ-5 */";
    expect(komentarze('a.js', js).map((k) => k.tekst)).toEqual(['// PRZ-4', '/* PRZ-5 */']);
    const ejs = "<p>PRZ-1</p><%# PRZ-2 %><% if (x) { // PRZ-3\n %><%= 'PRZ-4' %><% } %>";
    expect(
      komentarze('a.ejs', ejs)
        .map((k) => k.tekst)
        .sort(),
    ).toEqual(['// PRZ-3', '<%# PRZ-2 %>']);
    const sh = '#!/bin/sh\n# PRZ-1\necho "a # PRZ-2"\nx=1 # PRZ-3\necho \'PRZ-4 # PRZ-5\'';
    expect(komentarze('a.sh', sh).map((k) => k.tekst)).toEqual(['# PRZ-1', '# PRZ-3']);
  });

  it('parser tytułów widzi stałą część pierwszego argumentu describe/it/test', () => {
    const js =
      "describe('a PRZ-1', () => { it.each([['PRZ-2']])('b %s', () => {}); test.skip(`c ${x} PRZ-3`, () => {}); foo('PRZ-4'); });";
    expect(tytulyTestow('a.js', js).map((t) => t.tekst)).toEqual(['a PRZ-1', 'b %s', 'c … PRZ-3']);
  });

  it(`żaden komentarz nie zawiera numeru zadania (plików: ${sprawdzane.length})`, () => {
    console.log(
      `straznik numerow: sprawdzono ${sprawdzane.length} plikow (src ${sprawdzaneSrc.length}, tests ${testy.length}, scripts i deploy ${skrypty.length})`,
    );
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

  it(`żaden tytuł testu nie zawiera numeru zadania (plików: ${testy.length})`, () => {
    const trafienia = [];
    for (const plik of testy) {
      if (!KOD.has(path.extname(plik))) continue;
      const tekst = fs.readFileSync(plik, 'utf8');
      for (const t of tytulyTestow(plik, tekst)) {
        if (NUMER_W_TYTULE.test(t.tekst))
          trafienia.push(`${path.relative(KORZEN, plik)}:${tekst.slice(0, t.poz).split('\n').length}: ${t.tekst}`);
      }
    }
    expect(trafienia).toEqual([]);
  });
});
