// Testy nie mogą zależeć od katalogów jednej maszyny. Test, który czyta albo zapisuje w katalogu domowym
// użytkownika albo w katalogu roboczym serwera (`/srv/…`, `/root/…`, `/mnt/…`), przechodzi tylko tam, gdzie ten
// katalog akurat istnieje — u obcego i w CI pada (brak katalogu, EACCES). Katalog roboczy testu zakłada się
// w `os.tmpdir()` (np. `fs.mkdtempSync(path.join(os.tmpdir(), 'oms-'))`).
//
// Strażnik czyta napisy w kodzie testów (drzewo składni TypeScriptu: napisy i części szablonów), nie komentarze —
// komentarz nie otwiera pliku. Ścieżka wewnątrz adresu (`https://…/home/…`) nie jest ścieżką maszyny.
// Katalogi instalacji samego produktu (`/srv/oms…`, układ ze skryptów `deploy/`) są danymi testów tych skryptów.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const KORZEN = path.resolve(import.meta.dirname, '../..');
const TEN_PLIK = path.resolve(import.meta.filename);

// Katalogi zależne od maszyny: domowy (Linux, macOS, Windows), konta root, robocze serwera i zamontowane dyski.
// Przed ścieżką nie może stać znak adresu (litera, cyfra, kropka, dwukropek, ukośnik, kreska).
// Bez flagi `i`: `/Users/` (macOS) zaczyna się wielką literą, a `/users/5` to trasa HTTP. `/media/`
// liczy się dopiero z dwoma segmentami (`/media/<użytkownik>/<dysk>`) — `/media/logo.png` to plik statyczny.
// Litera dysku Windows nie rozróżnia wielkości, więc `Users` po niej w dowolnej pisowni.
const SCIEZKA_MASZYNY = new RegExp(
  String.raw`(?<![\w.:/\\-])(?:` +
    String.raw`/home/|/Users/|/root/|/mnt/[^/\s'"\x60]+|/media/[^/\s'"\x60]+/` +
    String.raw`|/srv/(?!oms)[^/\s'"\x60]+` +
    String.raw`|[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+[^\\/\s'"\x60]+)`,
);

// Jawne wyjątki: plik + dokładny napis + powód. Napisy są tam próbkami dla innego skanera, nikt ich nie otwiera.
// Wyjątek obejmuje tylko wskazany napis — każda inna ścieżka maszyny w tym pliku jest trafieniem.
const WYJATKI = [
  {
    plik: 'tests/core/straznik-danych-firmy.test.ts',
    fragment: '/root/monitoring.sh',
    powod: 'próbka ścieżki, którą skaner danych firmy ma odrzucić w paczce klienta',
  },
  {
    plik: 'tests/core/straznik-danych-firmy.test.ts',
    fragment: 'C:\\Users\\adam\\x',
    powod: 'próbka ścieżki Windows, którą skaner danych firmy ma odrzucić w paczce klienta',
  },
];

const WEZLY = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** Napisy kodu, w których stoi ścieżka maszyny: [{ linia, tekst }]. Komentarze pominięte. */
export function sciezkiMaszyny(plik, tresc) {
  if (!SCIEZKA_MASZYNY.test(tresc)) return [];
  const zrodlo = ts.createSourceFile(
    plik,
    tresc,
    ts.ScriptTarget.Latest,
    true,
    plik.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const wynik = [];
  const odwiedz = (wezel) => {
    // Część szablonu po `${…}` zaczyna się w środku ścieżki (`${baza}/srv/x`) — to nie początek ścieżki.
    const poWstawce = wezel.kind === ts.SyntaxKind.TemplateMiddle || wezel.kind === ts.SyntaxKind.TemplateTail;
    if (WEZLY.has(wezel.kind) && SCIEZKA_MASZYNY.test(poWstawce ? `x${wezel.text}` : wezel.text)) {
      const { line } = zrodlo.getLineAndCharacterOfPosition(wezel.getStart(zrodlo));
      wynik.push({ linia: line + 1, tekst: wezel.text });
    }
    ts.forEachChild(wezel, odwiedz);
  };
  odwiedz(zrodlo);
  return wynik;
}

/** Trafienia pliku bez napisów wskazanych w wyjątkach. */
export function trafieniaPoWyjatkach(plik, tresc) {
  return sciezkiMaszyny(plik, tresc).filter((t) => !WYJATKI.some((w) => w.plik === plik && t.tekst === w.fragment));
}

function plikiTestow(katalog) {
  const wynik = [];
  for (const wpis of fs.readdirSync(katalog, { withFileTypes: true })) {
    const pelna = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) wynik.push(...plikiTestow(pelna));
    else if (/\.(js|mjs|ts)$/.test(wpis.name) && pelna !== TEN_PLIK) wynik.push(pelna);
  }
  return wynik;
}

describe('strażnik ścieżek maszyny w testach', () => {
  it('żaden test nie czyta ani nie zapisuje w katalogu domowym ani roboczym konkretnej maszyny', () => {
    const trafienia = plikiTestow(path.join(KORZEN, 'tests'))
      .map((plik) => path.relative(KORZEN, plik).replaceAll('\\', '/'))
      .flatMap((plik) =>
        trafieniaPoWyjatkach(plik, fs.readFileSync(path.join(KORZEN, plik), 'utf8')).map(
          (t) => `${plik}:${t.linia}  ${t.tekst.slice(0, 120)}`,
        ),
      );
    expect(trafienia, 'katalog roboczy testu zakładaj w os.tmpdir()').toEqual([]);
  });

  it('każdy wyjątek wskazuje napis, który naprawdę stoi w tym pliku i jest ścieżką maszyny', () => {
    for (const { plik, fragment, powod } of WYJATKI) {
      const teksty = sciezkiMaszyny(plik, fs.readFileSync(path.join(KORZEN, plik), 'utf8')).map((t) => t.tekst);
      expect(teksty, plik).toContain(fragment);
      expect(powod.length).toBeGreaterThan(20);
    }
  });

  it('wzorzec: katalogi domowe i robocze dowolnej maszyny tak, adresy, katalogi produktu i komentarze nie', () => {
    const ile = (t) => sciezkiMaszyny('a.test.js', t).length;
    for (const napis of [
      '/home/ola/oms/tmp',
      '/Users/ola/oms',
      '/root/x.sh',
      '/srv/praca/tmp/a',
      '/srv/dane',
      '/mnt/dysk/oms',
      '/media/ola/pendrive',
      'C:\\Users\\Ola\\oms',
      'd:/users/ola/oms',
    ]) {
      expect(ile(`const k = ${JSON.stringify(napis)};`), napis).toBe(1);
    }
    expect(ile('const k = `${baza}/srv/x`;')).toBe(0);
    expect(ile('const k = `/home/${uzytkownik}/oms`;')).toBe(1);
    expect(ile("const u = 'https://www.example.com/pl-pl/home/sledzenie.html';")).toBe(0);
    expect(ile("const k = '/srv/oms-proba/oms.env';")).toBe(0);
    expect(ile("const x = '<root><a>1</a></root>';")).toBe(0);
    expect(ile("const k = path.join(os.tmpdir(), 'oms-');")).toBe(0);
    expect(ile('// katalog /srv/praca/tmp był tylko na jednej maszynie\nconst x = 1;')).toBe(0);
    expect(ile('/* C:\\Users\\Ola\\oms */ const x = 1;')).toBe(0);
    // Trasy HTTP i pliki statyczne to nie katalogi maszyny.
    expect(ile("const t = '/users/5';")).toBe(0);
    expect(ile("const t = '/api/users/5';")).toBe(0);
    expect(ile("const t = '/media/logo.png';")).toBe(0);
  });

  it('wyjątek zwalnia tylko wskazany fragment — nowa ścieżka maszyny w tym samym pliku jest trafieniem', () => {
    const plik = 'tests/core/straznik-danych-firmy.test.ts';
    expect(trafieniaPoWyjatkach(plik, "const a = ['/root/monitoring.sh'];")).toEqual([]);
    expect(trafieniaPoWyjatkach(plik, "const a = ['/root/monitoring.sh', '/home/ola/x'];")).toHaveLength(1);
  });
});
