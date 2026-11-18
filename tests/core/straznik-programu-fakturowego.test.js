// Strażnik granicy programu fakturowego. OMS rozmawia z programem do faktur wyłącznie przez kontrakt
// (`ProgramFakturowy`, `src/integracje/program-fakturowy.ts`); konkretny program (inFakt, Fakturownia…) jest
// wykonawcą tego kontraktu. Klient API programu (`src/oms/<program>/`) i pośrednik o jego metodach
// (`moduly/faktury/<program>-ustawien.ts`) wolno więc importować tylko:
//   • wykonawcy tego programu — wyłącznie w jego miejscach: `integracje/programy/<program>.ts` (i `<program>-*`),
//     `oms/<program>/`, `moduly/faktury/<program>-*`, `moduly/faktury/trasy/ustawienia-<program>.js`;
//   • miejscu składania modułu faktur (`moduly/faktury/modul.ts`), które tworzy klienta i podaje go wykonawcy.
// Nazwa programu w nazwie pliku gdzie indziej (np. `domena/infakt-skrot.js`) nie robi z niego wykonawcy.
// Reszta kodu (domena, trasy, usługi, inne moduły) dostaje program z kontraktu. Gdyby zawołała klienta wprost,
// zmiana programu fakturowego w Ustawieniach nie objęłaby tego miejsca.
//
// Programy z własnym klientem: każdy wykonawca `src/integracje/programy/<program>.ts`, dla którego istnieje katalog
// `src/oms/<program>/`. Importy czytane z drzewa składni TypeScriptu: `import … from`, `export … from`, `import()`
// i `require()` z napisem; ścieżka względna rozwiązywana od katalogu pliku.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);

// Miejsce składania modułu faktur — jedyne poza wykonawcami, które tworzy klienta programu.
const SKLADANIE = new Set(['moduly/faktury/modul.ts']);

/** Programy fakturowe z własnym klientem API: nazwa → katalog klienta względem `src/`. */
export function programyZKlientem(src = SRC) {
  return fs
    .readdirSync(path.join(src, 'integracje/programy'))
    .filter((n) => KOD.has(path.extname(n)))
    .map((n) => path.basename(n, path.extname(n)))
    .filter((p) => fs.existsSync(path.join(src, 'oms', p)))
    .map((p) => ({ program: p, katalog: `oms/${p}/` }));
}

/** Ścieżki modułów, które plik importuje (względne rozwiązane do postaci względem `src/`, reszta bez zmian). */
export function importy(plik, tresc) {
  const roz = path.extname(plik);
  const zrodlo = ts.createSourceFile(
    plik,
    tresc,
    ts.ScriptTarget.Latest,
    true,
    roz === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const wynik = [];
  const dodaj = (wezel) => {
    if (!wezel || !ts.isStringLiteralLike(wezel)) return;
    const s = wezel.text;
    wynik.push(s.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(plik), s)) : s);
  };
  const odwiedz = (wezel) => {
    if (ts.isImportDeclaration(wezel) || ts.isExportDeclaration(wezel)) dodaj(wezel.moduleSpecifier);
    else if (
      ts.isCallExpression(wezel) &&
      (wezel.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(wezel.expression) && wezel.expression.text === 'require'))
    )
      dodaj(wezel.arguments[0]);
    ts.forEachChild(wezel, odwiedz);
  };
  odwiedz(zrodlo);
  return wynik;
}

/** Miejsca wykonawcy programu (ścieżki względem `src/`) — sama nazwa programu w ścieżce nie wystarcza. */
export function miejscaWykonawcy(program) {
  return [
    (plik) => plik === `integracje/programy/${program}.ts` || plik.startsWith(`integracje/programy/${program}-`),
    (plik) => plik.startsWith(`oms/${program}/`),
    (plik) => plik.startsWith(`moduly/faktury/${program}-`),
    (plik) => plik === `moduly/faktury/trasy/ustawienia-${program}.js`,
  ];
}

/** Czy plik (ścieżka względem `src/`) jest wykonawcą programu albo miejscem składania modułu faktur. */
export function wolnoImportowac(plik, program) {
  return SKLADANIE.has(plik) || miejscaWykonawcy(program).some((jest) => jest(plik));
}

/**
 * Czy import trafia w klienta programu: jego katalog albo pośrednika, który podaje te same metody co klient
 * (`moduly/faktury/<program>-ustawien.ts`).
 */
export function celKlienta(cel, program, katalog) {
  return cel.startsWith(katalog) || new RegExp(`^moduly/faktury/${program}-ustawien(\\.[cm]?[jt]s)?$`).test(cel);
}

/** Importy klienta programu z miejsc, którym nie wolno: [`plik → cel`]. */
export function naruszenia(pliki, programy) {
  const bledy = [];
  for (const [plik, tresc] of pliki) {
    for (const cel of importy(plik, tresc)) {
      for (const { program, katalog } of programy) {
        if (celKlienta(cel, program, katalog) && !wolnoImportowac(plik, program)) bledy.push(`${plik} → ${cel}`);
      }
    }
  }
  return bledy;
}

function pliki(katalog) {
  return fs.readdirSync(katalog, { withFileTypes: true }).flatMap((w) => {
    const p = path.join(katalog, w.name);
    return w.isDirectory() ? pliki(p) : [p];
  });
}

function kodSrc() {
  return pliki(SRC)
    .filter((p) => KOD.has(path.extname(p)))
    .map((p) => [path.relative(SRC, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')]);
}

describe('strażnik granicy programu fakturowego', () => {
  const programy = programyZKlientem();

  it('klienta API programu do faktur importuje tylko jego wykonawca albo składanie modułu faktur', () => {
    const bledy = naruszenia(kodSrc(), programy);
    expect(
      bledy,
      'program do faktur bierz z kontraktu ProgramFakturowy, nie z klienta API:\n' + bledy.join('\n'),
    ).toEqual([]);
  });

  it('strażnik widzi programy z klientem (inFakt) i miejsce składania istnieje', () => {
    expect(programy.map((p) => p.program)).toContain('infakt');
    for (const plik of SKLADANIE) expect(fs.existsSync(path.join(SRC, plik)), plik).toBe(true);
    // Lista miejsc wykonawcy i pośrednik opisują prawdziwe drzewo, nie zgadywane nazwy.
    for (const plik of [
      'integracje/programy/infakt.ts',
      'oms/infakt/client.js',
      'moduly/faktury/infakt-ustawien.ts',
      'moduly/faktury/trasy/ustawienia-infakt.js',
    ]) {
      expect(fs.existsSync(path.join(SRC, plik)), plik).toBe(true);
    }
  });

  it('importy: from, export from, import() i require() rozwiązane od katalogu pliku', () => {
    const t = [
      "import { a } from '../../oms/infakt/client.js';",
      "export { b } from './c.js';",
      "const m = await import('../oms/infakt/client.js');",
      "const r = require('../oms/fakturownia/client.js');",
      "import fs from 'node:fs';",
      "const x = imp('../oms/infakt/client.js');",
    ].join('\n');
    expect(importy('moduly/zwroty/a.js', t)).toEqual([
      'oms/infakt/client.js',
      'moduly/zwroty/c.js',
      'moduly/oms/infakt/client.js',
      'moduly/oms/fakturownia/client.js',
      'node:fs',
    ]);
    expect(importy('domena/a.ts', "import type { K } from '../oms/infakt/client.js';")).toEqual([
      'oms/infakt/client.js',
    ]);
  });

  it('reguła: wykonawca i składanie wolno, reszta kodu nie — także dla innego programu', () => {
    const p = [
      { program: 'infakt', katalog: 'oms/infakt/' },
      { program: 'fakturownia', katalog: 'oms/fakturownia/' },
    ];
    const imp = (cel) => `import { k } from '${cel}';`;
    expect(
      naruszenia(
        [
          ['integracje/programy/infakt.ts', imp('../../oms/infakt/client.js')],
          ['moduly/faktury/infakt-ustawien.ts', imp('../../oms/infakt/client.js')],
          ['oms/infakt/pomoc.js', imp('./client.js')],
          ['integracje/programy/infakt-korekty.ts', imp('../../oms/infakt/client.js')],
          ['moduly/faktury/trasy/ustawienia-infakt.js', imp('../infakt-ustawien.ts')],
          ['moduly/faktury/modul.ts', imp('../../oms/fakturownia/client.js')],
          ['moduly/faktury/modul.ts', imp('./fakturownia-ustawien.ts')],
          ['domena/wysylka-ksef.js', imp('../integracje/program-fakturowy.ts')],
        ],
        p,
      ),
    ).toEqual([]);
    expect(
      naruszenia(
        [
          ['domena/wiadomosci.js', imp('../oms/infakt/client.js')],
          ['moduly/faktury/trasy/faktury.js', imp('../../../oms/infakt/client.js')],
          ['integracje/programy/infakt.ts', imp('../../oms/fakturownia/client.js')],
          ['moduly/zwroty/modul.ts', imp('../../oms/infakt/client.js')],
          // Pośrednik o metodach klienta to ta sama droga obok kontraktu co sam klient.
          ['domena/wiadomosci.js', imp('../moduly/faktury/infakt-ustawien.ts')],
          // Nazwa programu w nazwie pliku nie robi z domeny wykonawcy.
          ['domena/infakt-skrot.js', imp('../oms/infakt/client.js')],
          ['moduly/faktury/trasy/ustawienia-fakturownia.js', imp('../infakt-ustawien.ts')],
        ],
        p,
      ),
    ).toEqual([
      'domena/wiadomosci.js → oms/infakt/client.js',
      'moduly/faktury/trasy/faktury.js → oms/infakt/client.js',
      'integracje/programy/infakt.ts → oms/fakturownia/client.js',
      'moduly/zwroty/modul.ts → oms/infakt/client.js',
      'domena/wiadomosci.js → moduly/faktury/infakt-ustawien.ts',
      'domena/infakt-skrot.js → oms/infakt/client.js',
      'moduly/faktury/trasy/ustawienia-fakturownia.js → moduly/faktury/infakt-ustawien.ts',
    ]);
  });
});
