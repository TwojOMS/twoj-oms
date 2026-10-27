// PRZ-118.04 — strażnik kolumny `infakt_uuid`. Od migracji rdzen/0008 identyfikator dokumentu
// czyta się WYŁĄCZNIE przez src/domena/dokument-programu.js (`idDokumentu`, `programDokumentu`,
// `idDokumentuSql`), a `infakt_uuid` jest tylko zapasem tego odczytu i celem podwójnego zapisu.
// Każdy inny odczyt tej kolumny w `src/` to miejsce, które przy programie innym niż inFakt
// (`infakt_uuid` pusty) zgubi dokument, a w oknie wycofania — wiersz zapisany przez stary obraz.
//
// Skan jak w scripts/prz118-spis-infaktu.mjs (PRZ-118.01): kod .js/.mjs/.ts po drzewie składni
// TypeScriptu (Identifier, StringLiteral, NoSubstitutionTemplateLiteral, części szablonu — komentarze
// wypadają), widoki .ejs w całości poza komentarzami EJS `<%# %>`, każdy inny plik (np. .sql) w całości.
// Bez względu na wielkość liter: SQLite przyjmie też `INFAKT_UUID`.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const KOLUMNA = /infakt_uuid/i;
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);
const WEZLY = new Set([
  ts.SyntaxKind.Identifier, ts.SyntaxKind.PrivateIdentifier, ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
]);

// Pliki, w których kolumna wolno występować bez ograniczeń: schemat, migracja i jedyny moduł odczytu.
const WOLNO_CALY_PLIK = new Set([
  'moduly/rdzen/migracje/0001-baseline.sql',
  'moduly/rdzen/migracje/0008-dokument-programu.ts',
  'domena/dokument-programu.js',
]);
// Podwójny zapis (PRZ-118.03): w tych plikach WYŁĄCZNIE ten jeden napis instrukcji UPDATE, raz.
// Nowy odczyt w tym samym pliku = drugie trafienie = czerwony.
const WOLNO_TYLKO_ZAPIS = {
  'moduly/faktury/db/faktury.js': [
    'UPDATE faktury SET program = ?, dokument_id = ?, infakt_uuid = ?, numer = ?, ksef_status = ?, blad_opis = NULL',
  ],
  'oms/db/okresy.js': [
    'UPDATE okresy_rozliczeniowe SET program = ?, dokument_id = ?, infakt_uuid = ?, numer = ?, ksef_status = ?,',
  ],
};

/** Wszystkie wystąpienia kolumny w treści pliku — teksty węzłów (kod) albo linie (reszta). */
export function wystapienia(sciezka, tresc) {
  const roz = path.extname(sciezka);
  if (KOD.has(roz)) {
    const zrodlo = ts.createSourceFile(sciezka, tresc, ts.ScriptTarget.Latest, true,
      roz === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const wynik = [];
    const odwiedz = (wezel) => {
      if (WEZLY.has(wezel.kind) && KOLUMNA.test(wezel.text)) {
        const { line } = zrodlo.getLineAndCharacterOfPosition(wezel.getStart(zrodlo));
        wynik.push({ linia: line + 1, tekst: wezel.text });
      }
      ts.forEachChild(wezel, odwiedz);
    };
    odwiedz(zrodlo);
    return wynik;
  }
  // .ejs: komentarz EJS zamieniony na tyle samo nowych linii — numery linii zostają prawdziwe.
  const bez = roz === '.ejs'
    ? tresc.replace(/<%#[\s\S]*?%>/g, (k) => k.replace(/[^\n]/g, ''))
    : tresc;
  return bez.split('\n').flatMap((l, i) => (KOLUMNA.test(l) ? [{ linia: i + 1, tekst: l.trim() }] : []));
}

function pliki(katalog) {
  return fs.readdirSync(katalog, { withFileTypes: true }).flatMap((w) => {
    const p = path.join(katalog, w.name);
    return w.isDirectory() ? pliki(p) : [p];
  });
}

function skan() {
  const wynik = {};
  for (const p of pliki(SRC)) {
    const wzgledna = path.relative(SRC, p).split(path.sep).join('/');
    const w = wystapienia(p, fs.readFileSync(p, 'utf8'));
    if (w.length) wynik[wzgledna] = w;
  }
  return wynik;
}

describe('strażnik kolumny infakt_uuid (PRZ-118.04)', () => {
  const trafienia = skan();

  it('poza dokument-programu.js, schematem, migracją 0008 i dwoma UPDATE podwójnego zapisu — zero wystąpień w src/', () => {
    const naruszenia = [];
    for (const [plik, lista] of Object.entries(trafienia)) {
      if (WOLNO_CALY_PLIK.has(plik)) continue;
      const dozwolone = [...(WOLNO_TYLKO_ZAPIS[plik] ?? [])];
      for (const t of lista) {
        const i = dozwolone.indexOf(t.tekst);
        if (i >= 0) { dozwolone.splice(i, 1); continue; }
        naruszenia.push(`${plik}:${t.linia}  ${t.tekst.slice(0, 120)}`);
      }
    }
    expect(naruszenia, 'czytaj identyfikator przez src/domena/dokument-programu.js').toEqual([]);
  });

  it('każdy dozwolony zapis naprawdę stoi w swoim pliku (lista nie jest martwa)', () => {
    for (const [plik, napisy] of Object.entries(WOLNO_TYLKO_ZAPIS)) {
      expect((trafienia[plik] ?? []).map((t) => t.tekst), plik).toEqual(napisy);
    }
    expect(Object.keys(trafienia)).toEqual(expect.arrayContaining([...WOLNO_CALY_PLIK]));
  });

  it('skaner widzi odczyt w kodzie, SQL w napisie i szablonie, widok .ejs; komentarze pomija', () => {
    const tekst = (p, t) => wystapienia(p, t).map((w) => w.linia);
    expect(tekst('a.js', 'const x = f.infakt_uuid;')).toEqual([1]);
    expect(tekst('a.js', 'const { infakt_uuid } = f;')).toEqual([1]);
    expect(tekst('a.js', "db.prepare('SELECT INFAKT_UUID FROM faktury')")).toEqual([1]);
    expect(tekst('a.ts', 'const q = `SELECT ${a} FROM faktury\nWHERE f.infakt_uuid = ${b}`;')).toEqual([1]);
    expect(tekst('a.js', '// f.infakt_uuid\n/* infakt_uuid */ const y = 1;')).toEqual([]);
    expect(tekst('w.ejs', '<%# f.infakt_uuid\n %>\n<% if (z.faktura.infakt_uuid) { %>')).toEqual([3]);
    expect(tekst('w.ejs', '<!-- infakt_uuid -->')).toEqual([1]);
    expect(tekst('x.sql', 'SELECT 1;\nUPDATE faktury SET infakt_uuid = 1;')).toEqual([2]);
  });
});
