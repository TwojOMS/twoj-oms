import { szewTwojeFaktury } from '../../src/moduly/faktury/wczytaj-szew.ts';
// PRZ-123 C05 — strażnik „jedno miejsce wysyłki do KSeF”. Wysłanie faktury jest nieodwracalne, więc w src/ jest
// JEDEN plik, który zna ścieżki sesji KSeF (`/sessions…`), i JEDNA krótka lista plików, które go importują.
//
// REGUŁY (skan `src/` po drzewie składni TypeScriptu — komentarze nie są węzłami, więc wypadają):
//  1. Napis albo fragment szablonu zawierający `/sessions` — wyłącznie w src/oms/ksef/wysylka.js. Strażnik jest
//     ostrzejszy niż „POST /sessions”: także odczyty sesji (stan, lista, UPO) mieszkają tylko tam, żeby nie
//     powstała druga, „tylko czytająca” kopia klienta, do której ktoś kiedyś dopisze POST.
//  2. Ścieżka modułu wskazująca na src/oms/ksef/wysylka.js (import, export…from, import(), require() — w praktyce
//     KAŻDY napis, który rozwiązany względem pliku daje ten plik) — wyłącznie w plikach z listy WOLNO_IMPORTOWAC.
//     Lista jest JAWNA: dopisanie pliku to świadoma decyzja w diffie tego testu (C06/C07 dopiszą fabrykę i adapter,
//     jeśli będą go importować — dziś nikt nie importuje).
//
// ⚠️ Czego statycznie nie złapie: ścieżki sklejonej w czasie wykonania i importu przez pośrednika (plik z listy
// re-eksportujący klienta dalej) — zostaje recenzji.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const KLIENT = 'oms/ksef/wysylka.js';
// Adapter TwojeFaktury (C07) i fabryka wysyłki modułu faktur (C06/C07, od ZGODA-TFc w szwie) — jedyni, którzy mogą trzymać klienta.
const WOLNO_IMPORTOWAC = new Set([
  'integracje/programy/twojefaktury.ts',
  'moduly/faktury/szew-twojefaktury.ts', // PRZ-122.ZGODA-TFc: połączenie wysyłki przeniesione z modul.ts do szwu
  'moduly/faktury/ksef-sprzedazy.ts',
]);
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);
const NAPISY = new Set([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
]);

function plikiKodu(katalog, wynik = []) {
  for (const w of fs.readdirSync(katalog, { withFileTypes: true })) {
    const p = path.join(katalog, w.name);
    if (w.isDirectory()) plikiKodu(p, wynik);
    else if (KOD.has(path.extname(w.name))) wynik.push(p);
  }
  return wynik;
}

const doKlienta = (wzgledna, plik) => {
  if (!wzgledna.startsWith('.')) return false;
  const cel = path.relative(SRC, path.resolve(path.dirname(path.join(SRC, plik)), wzgledna)).split(path.sep).join('/');
  return cel === KLIENT || cel === KLIENT.replace(/\.js$/, '') || cel === KLIENT.replace(/\.js$/, '.ts');
};

/** Naruszenia w jednym pliku (`plik` względem src/, ukośniki „/”). */
function naruszenia(plik, tekst) {
  const zrodlo = ts.createSourceFile(plik, tekst, ts.ScriptTarget.Latest, true);
  const wynik = [];
  const odwiedz = (w) => {
    if (NAPISY.has(w.kind)) {
      const napis = w.text ?? '';
      const linia = zrodlo.getLineAndCharacterOfPosition(w.getStart()).line + 1;
      if (napis.includes('/sessions') && plik !== KLIENT) wynik.push(`${plik}:${linia} ścieżka sesji KSeF „${napis}”`);
      if (doKlienta(napis, plik) && !WOLNO_IMPORTOWAC.has(plik)) wynik.push(`${plik}:${linia} import klienta wysyłki „${napis}”`);
    }
    ts.forEachChild(w, odwiedz);
  };
  odwiedz(zrodlo);
  return wynik;
}

describe('PRZ-123 C05 — strażnik wysyłki do KSeF', () => {
  const pliki = plikiKodu(SRC).map((p) => path.relative(SRC, p).split(path.sep).join('/'));

  it.runIf(szewTwojeFaktury)('klient wysyłki istnieje i to on zna ścieżki sesji (strażnik coś widzi)', () => {
    expect(pliki).toContain(KLIENT);
    const tekst = fs.readFileSync(path.join(SRC, KLIENT), 'utf8');
    expect(tekst).toMatch(/['`]\/sessions\/online['`/]/);
  });

  it('`/sessions` tylko w wysylka.js, import wysylka.js tylko z listy dozwolonych', () => {
    const wszystkie = pliki.flatMap((p) => naruszenia(p, fs.readFileSync(path.join(SRC, p), 'utf8')));
    expect(wszystkie).toEqual([]);
  });

  describe('samokontrola na zmyślonych plikach', () => {
    it('łapie POST /sessions poza klientem — napis i szablon', () => {
      expect(naruszenia('moduly/faktury/services/wysylka-ksef.js', "await f('/sessions/online', { method: 'POST' });"))
        .toHaveLength(1);
      expect(naruszenia('oms/ksef/client.js', 'zapytaj(`/sessions/online/${ref}/invoices`);')).toHaveLength(1);
    });

    it('nie liczy komentarzy', () => {
      expect(naruszenia('oms/ksef/client.js', '// nie ma tu POST /sessions/*\nconst a = 1;')).toEqual([]);
    });

    it('łapie import, re-eksport, import() i require spoza listy', () => {
      const p = 'moduly/faktury/services/wysylka-ksef.js';
      expect(naruszenia(p, "import { createKsefWysylka } from '../../../oms/ksef/wysylka.js';")).toHaveLength(1);
      expect(naruszenia(p, "export * from '../../../oms/ksef/wysylka.js';")).toHaveLength(1);
      expect(naruszenia(p, "const m = await import('../../../oms/ksef/wysylka.js');")).toHaveLength(1);
      expect(naruszenia('oms/ksef/inny.js', "const m = require('./wysylka');")).toHaveLength(1);
    });

    it('przepuszcza plik z listy i inne pliki o tej nazwie', () => {
      expect(naruszenia('moduly/faktury/szew-twojefaktury.ts', "import { createKsefWysylka } from '../../oms/ksef/wysylka.js';"))
        .toEqual([]);
      expect(naruszenia('moduly/faktury/x.js', "import { a } from './services/wysylka-ksef.js';")).toEqual([]);
    });
  });
});
