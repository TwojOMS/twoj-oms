// PRZ-118.07 — strażnik „kto woła wysyłkę do KSeF”. Dokument w KSeF jest nieodwracalny (zostaje tylko korekta),
// więc droga do niego ma być JEDNA: zatwierdzenie człowieka (albo automat o godzinie z Ustawień) →
// moduly/faktury/services/wysylka-ksef.js → `program.wyslijDokumentDoKsef`. Wystawienie faktury nie wysyła nigdy
// (niezmiennik „wystawienie ≠ wysyłka”, opis.wystawienieWysylaDoKsef === false).
//
// Skan `src/` po drzewie składni TypeScriptu (jak tests/core/straznik-infakt-uuid-prz118.test.js): komentarze nie są
// węzłami, więc wypadają; widoki .ejs bez komentarzy EJS `<%# %>`; inne pliki w całości. Strażnik pilnuje TRZECH nazw,
// bo do metody prowadzą trzy drogi: sama nazwa `wyslijDokumentDoKsef`, zdolność `wyslijDoKsef` i mapa
// `METODA_ZDOLNOSCI` (src/integracje/program-fakturowy.ts: `METODA_ZDOLNOSCI.wyslijDoKsef === 'wyslijDokumentDoKsef'`).
//
// WARSTWA PROGRAMU = src/integracje/ (kontrakt, adaptery), src/oms/infakt/ (klient), src/core/kontrakty.ts (typy).
// LOGIKA OMS-u = cała reszta src/.
//
// REGUŁA — logika OMS-u:
//  1. `wyslijDokumentDoKsef` pada wyłącznie w moduly/faktury/services/wysylka-ksef.js, dokładnie raz, jako WYWOŁANIE
//     (`x.m(…)`, `x?.m(…)`, `x.m?.(…)`, `x['m'](…)`, `(x.m)(…)`, `x.m.call/apply/bind(…)`, gołe `m(…)`). Każde inne
//     wystąpienie — także odczyt bez wywołania (`const f = x.m`, `typeof x['m']`, `{ m } = x`), definicja czy napis —
//     w dowolnym pliku logiki OMS-u jest naruszeniem.
//  2. `wyslijDoKsef` pada wyłącznie w wysylka-ksef.js, najwyżej raz, i wyłącznie w odczycie zdolności z opisu:
//     `….zdolnosci.includes('wyslijDoKsef')` (tak liczy się `niedostepna`). Gdzie indziej — naruszenie.
//  3. `METODA_ZDOLNOSCI` (import, dostęp, cokolwiek) — w logice OMS-u nigdzie.
//
// REGUŁA — warstwa programu:
//  4. `wyslijDokumentDoKsef` wolno tylko jako: klucz definicji (deklaracja funkcji, metoda, klucz obiektu, skrót
//     `{ m }`, pole typu), element tablicy (lista metod, np. METODY_INFAKTU) albo wartość w obiekcie `METODA_ZDOLNOSCI`.
//     Napis w zmiennej (`const M = 'wyslijDokumentDoKsef'`) i każde inne miejsce — naruszenie.
//  5. Wywołanie albo odczyt `wyslijDokumentDoKsef` oraz wywołanie przez indeks z `METODA_ZDOLNOSCI` / `wyslijDoKsef`
//     (`k[METODA_ZDOLNOSCI.wyslijDoKsef](…)`) — tylko wewnątrz definicji wystawionej POD TĄ NAZWĄ (przekazanie w dół:
//     adapter `wyslijDokumentDoKsef` → klient `wyslijDokumentDoKsef`). Liczy się nazwa, pod którą definicja jest
//     wystawiona (deklaracja funkcji, metoda, klucz obiektu, zmienna), NIE własna nazwa wyrażenia funkcyjnego
//     (`wystaw: async function wyslijDokumentDoKsef() {…}` to `wystaw`).
//  6. `gov_save_and_send` nigdzie w kodzie src/; `send_to_ksef` tylko w plikach z listy dozwolonych — w PRZ-118 lista
//     jest PUSTA (src/oms/infakt/client.js ma tę nazwę wyłącznie w komentarzach, zmierzone 27.10.2026; inFakt wysyła
//     osobnym zasobem `/ksef2/documents/{uuid}/send.json`). PRZ-119 dopisze klienta Fakturowni.
//
// ⚠️ CZEGO TEN STRAŻNIK STATYCZNIE NIE ZŁAPIE — zostaje przeglądowi (recenzja PRZ-118.07):
//   • nazwy sklejonej w czasie wykonania (`'wyslij' + 'DokumentDoKsef'`, szablon z wstawką) i użytej jako indeks;
//   • pętli po kluczach albo wartościach programu (`Object.entries(program)` + `endsWith('DoKsef')`) i wołania tego,
//     co z niej wypadnie;
//   • `Reflect.get/apply`, `Function.prototype` i podobnych dróg bez nazwy w kodzie;
//   • indeksu wyjętego z dozwolonej tablicy w warstwie programu (`k[LISTA[10]](…)`) — tak dziś działa świadome
//     przekazanie `klient[nazwa](…)` w integracje/programy/infakt.ts (`przekaz`, lista METODY_OBOWIAZKOWE +
//     METODA_ZDOLNOSCI) i tego nie da się odróżnić składnią od nadużycia.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const NAZWA = 'wyslijDokumentDoKsef';
const ZDOLNOSC = 'wyslijDoKsef';
const MAPA = 'METODA_ZDOLNOSCI';
const JEDYNY_WOLAJACY = 'moduly/faktury/services/wysylka-ksef.js';
const WARSTWA_PROGRAMU = ['integracje/', 'oms/infakt/', 'core/kontrakty.ts'];
const WOLNO_SEND_TO_KSEF = new Set([]);
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);
const WEZLY_TEKSTU = new Set([
  ts.SyntaxKind.Identifier, ts.SyntaxKind.PrivateIdentifier, ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
]);

const wWarstwieProgramu = (plik) => WARSTWA_PROGRAMU.some((p) => (p.endsWith('/') ? plik.startsWith(p) : plik === p));

/** Wyrażenie „w górę” przez nawiasy, `!`, `as`, `satisfies` — `(x.f)(…)` i `(x.f as F)(…)` to dalej wywołanie x.f. */
function wGore(w) {
  let n = w;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent)
    || ts.isAsExpression(n.parent) || ts.isTypeAssertionExpression(n.parent)
    || (ts.isSatisfiesExpression?.(n.parent) ?? false))) n = n.parent;
  return n;
}
const jestWolanym = (w) => {
  const n = wGore(w);
  if (ts.isCallExpression(n.parent) && n.parent.expression === n) return true;
  // x.m.call(…) / .apply(…) / .bind(…)
  return ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n
    && ['call', 'apply', 'bind'].includes(n.parent.name.text) && jestWolanym(n.parent);
};

/** Nazwa, pod którą funkcja jest wystawiona — deklaracja, metoda, klucz obiektu, zmienna. Nie własna nazwa wyrażenia. */
function nazwaWystawienia(n) {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return n.name?.text;
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n))
    && (ts.isPropertyAssignment(n.parent) || ts.isVariableDeclaration(n.parent)) && n.parent.initializer === n) {
    return n.parent.name?.text;
  }
  return undefined;
}
function wDefinicjiTejSamejNazwy(w) {
  for (let n = w.parent; n; n = n.parent) if (nazwaWystawienia(n) === NAZWA) return true;
  return false;
}
/** Czy węzeł leży w obiekcie przypisanym do zmiennej METODA_ZDOLNOSCI (przez Object.freeze, `as const`, `satisfies`). */
function wMapieZdolnosci(w) {
  for (let n = w.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n)) return n.name?.text === MAPA;
    if (ts.isBlock(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}
const zawieraNazwe = (wezel) => {
  let jest = false;
  const szukaj = (n) => {
    if (jest) return;
    if (WEZLY_TEKSTU.has(n.kind) && [NAZWA, ZDOLNOSC, MAPA].includes(n.text)) { jest = true; return; }
    ts.forEachChild(n, szukaj);
  };
  szukaj(wezel);
  return jest;
};

/**
 * Forma wystąpienia: 'wywolanie' | 'odczyt' | 'definicja' | 'lista' | 'zdolnoscZOpisu' | 'inne'.
 * 'lista' — napis w tablicy albo wartość w obiekcie METODA_ZDOLNOSCI; 'zdolnoscZOpisu' — `….zdolnosci.includes('…')`.
 */
function forma(w) {
  const p = w.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === w) return jestWolanym(p) ? 'wywolanie' : 'odczyt';
  if (ts.isElementAccessExpression(p) && p.argumentExpression === w) return jestWolanym(p) ? 'wywolanie' : 'odczyt';
  if (ts.isIdentifier(w) && ts.isCallExpression(p) && p.expression === w) return 'wywolanie';
  // `const { m } = x` / `const { m: f } = x` — wyjęcie metody z obiektu.
  if (ts.isBindingElement(p) && (p.propertyName === w || (!p.propertyName && p.name === w))) return 'odczyt';
  if (ts.isIdentifier(w) && jestWolanym(w) && !ts.isFunctionDeclaration(p)) return 'wywolanie';
  if (((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)
    || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isFunctionExpression(p)) && p.name === w)
    || ts.isShorthandPropertyAssignment(p)) {
    return 'definicja';
  }
  if (ts.isStringLiteralLike(w) && ts.isArrayLiteralExpression(p)) return 'lista';
  if (ts.isStringLiteralLike(w) && ts.isPropertyAssignment(p) && p.initializer === w && wMapieZdolnosci(p)) return 'lista';
  if (ts.isStringLiteralLike(w) && ts.isCallExpression(p) && p.arguments.length === 1 && p.arguments[0] === w
    && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'includes'
    && ts.isPropertyAccessExpression(p.expression.expression) && p.expression.expression.name.text === 'zdolnosci') {
    return 'zdolnoscZOpisu';
  }
  return 'inne';
}

/**
 * Wystąpienia w pliku: `nazwy` = { linia, nazwa (NAZWA|ZDOLNOSC|MAPA|'wolanieIndeksem'), forma, wDefinicji };
 * `teksty` = węzły z gov_save_and_send / send_to_ksef.
 * 'wolanieIndeksem' — wywołanie `x[wyrażenie](…)`, którego indeks niesie NAZWA, ZDOLNOSC albo MAPA.
 */
export function przeskanuj(sciezka, tresc) {
  const roz = path.extname(sciezka);
  const nazwy = [];
  const teksty = [];
  if (KOD.has(roz)) {
    const zrodlo = ts.createSourceFile(sciezka, tresc, ts.ScriptTarget.Latest, true,
      roz === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const linia = (w) => zrodlo.getLineAndCharacterOfPosition(w.getStart(zrodlo)).line + 1;
    const odwiedz = (w) => {
      if (ts.isElementAccessExpression(w) && !ts.isStringLiteralLike(w.argumentExpression) && jestWolanym(w)
        && zawieraNazwe(w.argumentExpression)) {
        nazwy.push({ linia: linia(w), nazwa: 'wolanieIndeksem', forma: 'wywolanie', wDefinicji: wDefinicjiTejSamejNazwy(w) });
      }
      if (WEZLY_TEKSTU.has(w.kind)) {
        for (const n of [NAZWA, ZDOLNOSC, MAPA]) {
          if (w.text === n) nazwy.push({ linia: linia(w), nazwa: n, forma: forma(w), wDefinicji: wDefinicjiTejSamejNazwy(w) });
          else if (w.text.includes(n)) nazwy.push({ linia: linia(w), nazwa: n, forma: 'inne', wDefinicji: false });
        }
        if (/gov_save_and_send|send_to_ksef/i.test(w.text)) teksty.push({ linia: linia(w), tekst: w.text });
      }
      ts.forEachChild(w, odwiedz);
    };
    odwiedz(zrodlo);
    return { nazwy, teksty };
  }
  const bez = roz === '.ejs' ? tresc.replace(/<%#[\s\S]*?%>/g, (k) => k.replace(/[^\n]/g, '')) : tresc;
  bez.split('\n').forEach((l, i) => {
    for (const n of [NAZWA, ZDOLNOSC, MAPA]) if (l.includes(n)) nazwy.push({ linia: i + 1, nazwa: n, forma: 'poza kodem', wDefinicji: false });
    if (/gov_save_and_send|send_to_ksef/i.test(l)) teksty.push({ linia: i + 1, tekst: l.trim() });
  });
  return { nazwy, teksty };
}

/** Naruszenia reguł 1–5 dla jednego pliku (ścieżka względem src/, z `/`). */
export function naruszeniaWysylki(plik, wystapienia) {
  const zle = [];
  const opis = (w, dlaczego) => `${plik}:${w.linia}  ${w.nazwa} (${w.forma}) — ${dlaczego}`;
  if (wWarstwieProgramu(plik)) {
    for (const w of wystapienia) {
      if (w.forma === 'poza kodem') zle.push(opis(w, 'nazwa w pliku spoza kodu'));
      else if ((w.forma === 'wywolanie' || w.forma === 'odczyt') && (w.nazwa === NAZWA || w.nazwa === 'wolanieIndeksem')) {
        if (!w.wDefinicji) zle.push(opis(w, `w warstwie programu wolno wołać tylko z wnętrza definicji wystawionej jako ${NAZWA}`));
      } else if (w.nazwa === NAZWA && !['definicja', 'lista'].includes(w.forma)) {
        zle.push(opis(w, `${NAZWA} w warstwie programu tylko jako klucz definicji, element listy metod albo wartość w ${MAPA}`));
      }
    }
    return zle;
  }
  const tu = plik === JEDYNY_WOLAJACY;
  const nazwy = wystapienia.filter((w) => w.nazwa === NAZWA);
  const zdolnosci = wystapienia.filter((w) => w.nazwa === ZDOLNOSC);
  for (const w of wystapienia) {
    if (w.nazwa === MAPA) zle.push(opis(w, `logika OMS-u nie sięga po ${MAPA}`));
    else if (w.nazwa === 'wolanieIndeksem') zle.push(opis(w, 'wywołanie przez indeks z nazwą metody lub zdolności'));
    else if (!tu) zle.push(opis(w, `logika OMS-u woła wysyłkę do KSeF tylko przez ${JEDYNY_WOLAJACY}`));
  }
  if (tu) {
    if (nazwy.length !== 1 || nazwy[0].forma !== 'wywolanie') {
      for (const w of nazwy) zle.push(opis(w, `w ${JEDYNY_WOLAJACY} ma być dokładnie jedno wystąpienie: wywołanie`));
      if (!nazwy.length) zle.push(`${plik}: brak wywołania ${NAZWA} — jedyna droga wysyłki zniknęła`);
    }
    if (zdolnosci.length > 1 || zdolnosci.some((w) => w.forma !== 'zdolnoscZOpisu')) {
      for (const w of zdolnosci) zle.push(opis(w, `${ZDOLNOSC} tylko raz, jako \`….zdolnosci.includes('${ZDOLNOSC}')\``));
    }
  }
  return zle;
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
    const w = przeskanuj(p, fs.readFileSync(p, 'utf8'));
    if (w.nazwy.length || w.teksty.length) wynik[wzgledna] = w;
  }
  return wynik;
}

/** Naruszenia dla wycinka kodu udającego plik `plik` (scenariusze skanera). */
const naruszeniaKodu = (plik, kod) => naruszeniaWysylki(plik, przeskanuj(plik, kod).nazwy);

describe('strażnik wysyłki do KSeF (PRZ-118.07)', () => {
  const trafienia = skan();

  it(`${NAZWA}, ${ZDOLNOSC}, ${MAPA}: logika OMS-u woła wysyłkę tylko w ${JEDYNY_WOLAJACY}; warstwa programu tylko definiuje i przekazuje`, () => {
    const naruszenia = Object.entries(trafienia).flatMap(([plik, { nazwy }]) => naruszeniaWysylki(plik, nazwy));
    if (!trafienia[JEDYNY_WOLAJACY]) naruszenia.push(...naruszeniaWysylki(JEDYNY_WOLAJACY, []));
    expect(naruszenia).toEqual([]);
  });

  it('gov_save_and_send nigdzie w kodzie src/; send_to_ksef tylko w plikach z listy dozwolonych (w PRZ-118 pusta)', () => {
    const naruszenia = [];
    for (const [plik, { teksty }] of Object.entries(trafienia)) {
      for (const t of teksty) {
        if (/gov_save_and_send/i.test(t.tekst) || !WOLNO_SEND_TO_KSEF.has(plik)) {
          naruszenia.push(`${plik}:${t.linia}  ${t.tekst.slice(0, 120)}`);
        }
      }
    }
    expect(naruszenia, 'wystawienie nie wysyła do KSeF — wysyłka to osobna, świadoma decyzja człowieka').toEqual([]);
    // Lista dozwolonych nie jest martwa: każdy wpis naprawdę niesie send_to_ksef w kodzie.
    for (const plik of WOLNO_SEND_TO_KSEF) expect(trafienia[plik]?.teksty.length, plik).toBeGreaterThan(0);
  });

  it('dozwolone miejsca naprawdę istnieją (strażnik nie jest ślepy na nie)', () => {
    const formy = (plik, nazwa) => (trafienia[plik]?.nazwy ?? []).filter((w) => w.nazwa === nazwa).map((w) => w.forma);
    // Klient inFaktu: deklaracja funkcji, skrót w obiekcie wyniku, element listy METODY_INFAKTU.
    expect(formy('oms/infakt/client.js', NAZWA)).toEqual(['definicja', 'definicja', 'lista']);
    // Kontrakt: wartość w METODA_ZDOLNOSCI.
    expect(formy('integracje/program-fakturowy.ts', NAZWA)).toEqual(['lista']);
    // Jedyny wołający: jedno wywołanie i jeden odczyt zdolności z opisu (`niedostepna`).
    expect(formy(JEDYNY_WOLAJACY, NAZWA)).toEqual(['wywolanie']);
    expect(formy(JEDYNY_WOLAJACY, ZDOLNOSC)).toEqual(['zdolnoscZOpisu']);
  });

  it('skaner: każda forma wywołania i odczytu, definicje, komentarze pominięte, .ejs bez komentarzy EJS', () => {
    const formy = (kod, p = 'a.js') => przeskanuj(p, kod).nazwy.filter((w) => w.nazwa === NAZWA).map((w) => w.forma);
    for (const kod of [
      'program.wyslijDokumentDoKsef(id);',
      'program?.wyslijDokumentDoKsef(id);',
      'program.wyslijDokumentDoKsef?.(id);',
      "program['wyslijDokumentDoKsef'](id);",
      "program?.['wyslijDokumentDoKsef']?.(id);",
      '(program.wyslijDokumentDoKsef)(id);',
      '(program.wyslijDokumentDoKsef as any)(id);',
      'program.wyslijDokumentDoKsef.call(program, id);',
      'wyslijDokumentDoKsef(id);',
    ]) expect(formy(kod, 'a.ts'), kod).toEqual(['wywolanie']);
    expect(formy('const f = program.wyslijDokumentDoKsef;')).toEqual(['odczyt']);
    expect(formy("if (typeof p['wyslijDokumentDoKsef'] === 'function') {}")).toEqual(['odczyt']);
    expect(formy('const { wyslijDokumentDoKsef: f } = program;')).toEqual(['odczyt']);
    expect(formy('const { wyslijDokumentDoKsef } = program;')).toEqual(['odczyt']);
    expect(formy('async function wyslijDokumentDoKsef(uuid) {}')).toEqual(['definicja']);
    expect(formy('const o = { wyslijDokumentDoKsef, x: 1 };')).toEqual(['definicja']);
    expect(formy("const l = ['listaFaktur', 'wyslijDokumentDoKsef'];")).toEqual(['lista']);
    expect(formy("const METODA_ZDOLNOSCI = Object.freeze({ wyslijDoKsef: 'wyslijDokumentDoKsef' } as const);", 'a.ts')).toEqual(['lista']);
    expect(formy("const INNA = { m: 'wyslijDokumentDoKsef' };")).toEqual(['inne']);
    expect(formy('// program.wyslijDokumentDoKsef(id)\n/* wyslijDokumentDoKsef() */ const y = 1;')).toEqual([]);
    expect(formy('<%# program.wyslijDokumentDoKsef() %>\n<% program.wyslijDokumentDoKsef() %>', 'w.ejs')).toEqual(['poza kodem']);
    // Napisy: kod i szablon tak, komentarz nie.
    const teksty = (kod, p = 'a.js') => przeskanuj(p, kod).teksty.map((t) => t.linia);
    expect(teksty("const q = { send_to_ksef: true };\nconst u = `?gov_save_and_send=${1}`;")).toEqual([1, 2]);
    expect(teksty("post('/x', { 'send_to_ksef': 1 });")).toEqual([1]);
    expect(teksty('// send_to_ksef\n/* gov_save_and_send */')).toEqual([]);
  });

  it('reguła na wycinkach: dozwolone przechodzi, obejścia A, E, F, G (recenzja 07) są czerwone', () => {
    const FAKTURA = 'moduly/faktury/services/faktura.js';
    const ADAPTER = 'integracje/programy/x.ts';
    // Dozwolone: jedyny wołający z odczytem zdolności z opisu; przekazanie w dół w adapterze; klient jak dziś.
    expect(naruszeniaKodu(JEDYNY_WOLAJACY, `const n = !program.opis.zdolnosci.includes('wyslijDoKsef');
      async function wyslij(d) { await program.wyslijDokumentDoKsef(d.uuid); }`)).toEqual([]);
    expect(naruszeniaKodu(ADAPTER, 'const p = { async wyslijDokumentDoKsef(id) { return k.wyslijDokumentDoKsef(id); } };')).toEqual([]);
    expect(naruszeniaKodu(ADAPTER, 'const p = { wyslijDokumentDoKsef: (id) => k[METODA_ZDOLNOSCI.wyslijDoKsef](id) };')).toEqual([]);
    expect(naruszeniaKodu('oms/infakt/client.js', `async function wyslijDokumentDoKsef(uuid) {}
      export const L = ['wystaw', 'wyslijDokumentDoKsef']; const k = { wystaw, wyslijDokumentDoKsef };`)).toEqual([]);
    // A: logika OMS-u woła przez mapę zdolności (w czuwaczu, fakturze…).
    expect(naruszeniaKodu(FAKTURA, `import { METODA_ZDOLNOSCI } from '../../../integracje/program-fakturowy.ts';
      async function wystaw(program, d) { await program[METODA_ZDOLNOSCI.wyslijDoKsef](d.uuid); }`).length).toBeGreaterThan(0);
    expect(naruszeniaKodu(FAKTURA, "async function wystaw(p, d) { await p[Z['wyslijDoKsef']](d.uuid); }").length).toBeGreaterThan(0);
    // Zdolność w logice OMS-u poza wysylka-ksef.js albo w innej formie niż odczyt z opisu.
    expect(naruszeniaKodu(FAKTURA, "const n = program.opis.zdolnosci.includes('wyslijDoKsef');")).toHaveLength(1);
    expect(naruszeniaKodu(JEDYNY_WOLAJACY, `const z = 'wyslijDoKsef';
      async function wyslij(d) { await program.wyslijDokumentDoKsef(d.uuid); }`)).toHaveLength(1);
    // Wywołanie poza wysylka-ksef.js; dwa wystąpienia w wysylka-ksef.js.
    expect(naruszeniaKodu(FAKTURA, 'async function wystaw(d) { await k.wyslijDokumentDoKsef(d.uuid); }')).toHaveLength(1);
    expect(naruszeniaKodu(JEDYNY_WOLAJACY, 'k.wyslijDokumentDoKsef(1); k.wyslijDokumentDoKsef(2);')).toHaveLength(2);
    // E: warstwa programu — nazwa w stałej, potem wywołanie indeksem.
    expect(naruszeniaKodu(ADAPTER, `const M = 'wyslijDokumentDoKsef';
      export function programX(k) { return { async wystaw(d) { const r = await k.wystaw(d); await k[M](r.uuid); return r; } }; }`).length)
      .toBeGreaterThan(0);
    // F: warstwa programu — `wystaw` woła wysyłkę przez mapę zdolności.
    expect(naruszeniaKodu(ADAPTER, `import { METODA_ZDOLNOSCI } from '../program-fakturowy.ts';
      export function programX(k) { return { async wystaw(d) { const r = await k.wystaw(d); await k[METODA_ZDOLNOSCI.wyslijDoKsef](r.uuid); return r; } }; }`))
      .toHaveLength(1);
    // G: wyrażenie funkcyjne nazwane jak metoda wysyłki, ale wystawione jako `wystaw`.
    expect(naruszeniaKodu(ADAPTER, `export function programX(k) { return { wystaw: async function wyslijDokumentDoKsef(d) {
      const r = await k.wystaw(d); await k.wyslijDokumentDoKsef(r.uuid); return r; } }; }`)).toHaveLength(1);
    // Klient: `wystaw` wołające wysyłkę po cichu.
    expect(naruszeniaKodu('oms/infakt/client.js', 'async function wystaw(d) { await wyslijDokumentDoKsef(d.uuid); }')).toHaveLength(1);
  });
});
