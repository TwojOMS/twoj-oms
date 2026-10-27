// PRZ-118.10 — strażnik nazw programu fakturowego. Po PRZ-118 OMS rozmawia z programem fakturowym przez kontrakt
// (`ProgramFakturowy`), a inFakt jest jednym z wykonawców. Słowo „infakt” (bez względu na wielkość liter: inFakt,
// inFaktu, inFakcie, inFaktem, INFAKT_*, infakt_uuid…) w KODZIE `src/` wolno więc tylko tam, gdzie mieszka
// wykonawca inFakt albo jego zapas (lista WOLNO_* niżej, plan 10.1 + dopiski z 05–09), oraz w plikach z jawnej listy
// ZALEGLOSCI — z dokładną liczbą wystąpień zmierzoną 27.10.2026. Lista zaległości ma się kurczyć świadomie:
//   • w pliku więcej wystąpień niż na liście → czerwony (nowy napis z inFaktem);
//   • mniej → też czerwony, z komunikatem „zmniejsz zaległość w teście do N” (lista nie może gnić);
//   • plik spoza obu list z inFaktem → czerwony.
//
// Skan jak w scripts/prz118-spis-infaktu.mjs i tests/core/straznik-infakt-uuid-prz118.test.js: kod .js/.mjs/.cjs/.ts
// po drzewie składni TypeScriptu (Identifier, PrivateIdentifier, StringLiteral, NoSubstitutionTemplateLiteral, części
// szablonu — komentarze nie są węzłami, więc wypadają), widoki .ejs w całości poza komentarzami EJS `<%# %>` (HTML
// i skrypty widoku idą do przeglądarki), każdy inny plik tekstowy (np. .sql, .css) w całości. Liczy się każde
// trafienie wzorca /infak[ct]/i w tekście węzła/linii (napis „w inFakcie albo w inFaktu” = 2; „inFakcie” nie zawiera
// „infakt”, stąd [ct]). Fałszywe trafienie `terminFaktur…`
// (t-e-r-m-INFAKT-u-r) jest wycinane przed liczeniem.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const KOD = new Set(['.js', '.mjs', '.cjs', '.ts']);
const TEKST = new Set([...KOD, '.ejs', '.sql', '.css', '.md', '.json', '.svg', '.html', '.txt']);
const WEZLY = new Set([
  ts.SyntaxKind.Identifier, ts.SyntaxKind.PrivateIdentifier, ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail,
]);

/** Liczba trafień „infakt”/„infakc” (inFakcie nie ma „t”; bez wielkości liter) po wycięciu `terminFaktur…`. */
export const ileInfaktu = (tekst) => (String(tekst).replace(/terminfaktur/gi, '').match(/infak[ct]/gi) ?? []).length;

/** Wszystkie wystąpienia w kodzie pliku: `{ linia, tekst, ile }` — węzeł składni (kod) albo linia (reszta). */
export function wystapienia(sciezka, tresc) {
  const roz = path.extname(sciezka);
  if (KOD.has(roz)) {
    const zrodlo = ts.createSourceFile(sciezka, tresc, ts.ScriptTarget.Latest, true,
      roz === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const wynik = [];
    const odwiedz = (wezel) => {
      if (WEZLY.has(wezel.kind)) {
        const ile = ileInfaktu(wezel.text);
        if (ile) {
          const { line } = zrodlo.getLineAndCharacterOfPosition(wezel.getStart(zrodlo));
          wynik.push({ linia: line + 1, tekst: wezel.text, ile });
        }
      }
      ts.forEachChild(wezel, odwiedz);
    };
    odwiedz(zrodlo);
    return wynik;
  }
  // .ejs: komentarz EJS zamieniony na tyle samo nowych linii — numery linii zostają prawdziwe.
  const bez = roz === '.ejs' ? tresc.replace(/<%#[\s\S]*?%>/g, (k) => k.replace(/[^\n]/g, '')) : tresc;
  return bez.split('\n').flatMap((l, i) => {
    const ile = ileInfaktu(l);
    return ile ? [{ linia: i + 1, tekst: l.trim(), ile }] : [];
  });
}

// ── Dozwolone ────────────────────────────────────────────────────────────────────────────────────────────────────

// Cały plik (plan 10.1 + dopiski). Wartość = uzasadnienie (jedno zdanie).
const WOLNO_CALY_PLIK = {
  'integracje/programy/infakt.ts': 'plan 10.1: adapter inFaktu — wykonawca kontraktu.',
  'domena/konfiguracja-infakt.js': 'plan 10.1: wnętrze wykonawcy inFakt (adres, ekran, NAZWA_INFAKTU z 09 — jedno źródło odmiany dla adaptera).',
  'moduly/faktury/infakt-ustawien.ts': 'plan 10.1: wnętrze wykonawcy inFakt (pośrednik z Ustawień).',
  'moduly/faktury/trasy/ustawienia-infakt.js': 'plan 10.1: ekran Ustawienia → Integracje → inFakt.',
  'moduly/faktury/widoki/ustawienia-infakt.ejs': 'plan 10.1: widok ekranu inFaktu.',
  'integracje/klucze.js': 'plan 10.1: klucze integracji, wiersz „infakt” w konfiguracja_integracji.',
  'domena/dokument-programu.js': 'plan 10.1: jedyny odczyt identyfikatora z zapasem infakt_uuid (PRZ-118.04).',
  'domena/wybor-programu.js': 'PRZ-121.01: identyfikator modułu „infakt” na liście modułów faktur i w zdaniach o wartości OMS_PROGRAM_FAKTUROWY.',
  'domena/ekrany.js': 'plan 10.1: adres ekranu inFaktu w Ustawieniach.',
  'domena/podmenu-ustawien.js': 'plan 10.1: pozycja menu Ustawienia → Integracje → inFakt.',
  'moduly/ustawienia/widoki/ustawienia-integracje.ejs': 'plan 10.1: kafelek inFaktu na liście integracji.',
  'integracje/program-fakturowy.ts': 'dopisek 02: podkładka `zProgramu` przyjmuje starą nazwę parametru `infakt` i owija ją adapterem (Decyzje techniczne, wiersz „testy”).',
  'domena/nazwa-programu.js':'dopisek 09: zapasowa odmiana i ekran inFaktu, gdy wołający nie podał programu (jedyny program w PRZ-118).',
  'moduly/rdzen/migracje/0008-dokument-programu.ts': 'dopisek 03: migracja przepisuje infakt_uuid do program/dokument_id — kolumna i wartość, nie tekst dla człowieka.',
  'moduly/rdzen/migracje/0001-baseline.sql': 'dopisek: schemat bazy z kolumną infakt_uuid (migracje addytywne, kolumna zostaje).',
};
// Katalog wykonawcy w całości: klient inFaktu (plan 10.1, `src/oms/infakt/` bez zmian w PRZ-118).
const WOLNO_KATALOG = ['oms/infakt/'];

// Nazwy kanoniczne z decyzji planu — wolno w każdym pliku (dokładny tekst węzła). Wartość = uzasadnienie.
const WOLNO_NAZWY = {
  konfiguracjaInfaktu: 'plan 10.1: usługa konfiguracji inFaktu (automatyzacje, automat KSeF).',
  polaWdtInfakt: 'plan 10.1: nazwa kanoniczna pól WDT w kształcie ładunku v3 inFaktu.',
  groszeZInfaktu: 'plan 10.1: nazwa kanoniczna przeliczenia kwot z kształtu v3 inFaktu.',
  nieznana_w_infakcie: 'plan 10.1: nazwa kanoniczna stanu dokumentu.',
};

// `*/modul.ts` (składanie modułów): odczyty `INFAKT_*` i klucz usługi `infakt` (alias zostaje do końca PRZ-118 —
// „Odejścia od planu”, wiersz „Alias infakt”). Statycznie nie da się odróżnić klucza usługi od zmiennej o tej
// samej nazwie — dokładny tekst `infakt` przechodzi w obu rolach.
const MODUL = /^moduly\/[^/]+\/modul\.ts$/;
const wolnoWModule = (tekst) => /^INFAKT_[A-Z0-9_]+$/.test(tekst) || tekst === 'infakt';

// Podwójny zapis z PRZ-118.03: dokładne napisy w tych plikach (każdy tyle razy, ile stoi na liście).
const WOLNO_NAPISY = {
  'moduly/faktury/db/faktury.js': [
    // domyślny program zapisu i warunek podwójnego zapisu (`program === 'infakt'` → infakt_uuid)
    'infakt', 'infakt',
    'UPDATE faktury SET program = ?, dokument_id = ?, infakt_uuid = ?, numer = ?, ksef_status = ?, blad_opis = NULL',
  ],
  'oms/db/okresy.js': [
    // to samo dla faktury okresu (`zakonczFaktureOkresu`)
    'infakt', 'infakt',
    'UPDATE okresy_rozliczeniowe SET program = ?, dokument_id = ?, infakt_uuid = ?, numer = ?, ksef_status = ?,',
  ],
};

// ── Zaległości (pomiar 27.10.2026 na gałęzi pętli po PRZ-118.09) ─────────────────────────────────────────────────
// plik → dokładna liczba wystąpień POZA dozwolonymi wyżej. Zmniejszasz — popraw liczbę; zwiększasz — nie wolno.
// Co w nich siedzi (50 plików, 234 wystąpienia): (a) parametr `infakt` podkładki `zProgramu` w usługach i trasach
// (para `{ program, infakt }` → zniknie z końcem aliasu, „Odejścia od planu”); (b) zdania dla człowieka „sprawdź
// w inFakcie” w domenie i trasach (wymagają programu w wywołaniu); (c) zdania o braku programu (`BEZ_INFAKTU`,
// 503 „Panel nie ma podpiętego inFaktu”, `GDZIE_KLUCZ_INFAKTU`) — celowo zostawione, zmieni je wybór programu
// (PRZ-119); (d) budżety czuwaczy ze stałych klienta (`LIMIT_ZADANIA_INFAKTU_MS`) i diagnostyka łączności z API
// inFaktu; (e) składanie wykonawcy w `faktury/modul.ts` (fabryki, pośrednik z Ustawień); (f) komentarze JS
// wewnątrz `<% %>` w trzech widokach .ejs (liczone, bo reguła .ejs pomija tylko `<%# %>`).
const ZALEGLOSCI = {
  'domena/lacznosc.js': 7,
  'domena/lista-ikony.js': 2,
  'domena/masowe.js': 1,
  'domena/ostrzezenia.js': 5,
  'domena/paczka-dla-biura.js': 2,
  'domena/powiadomienia.js': 1,
  'domena/pozycje-faktury.js': 1,
  'domena/scalanie.js': 1,
  'domena/wiadomosci.js': 1,
  'domena/wysylka-ksef.js': 5,
  'domena/zmiana-okresu.js': 1,
  'domena/zwrot.js': 2,
  'moduly/automatyzacje/trasy/ekran.js': 2,
  'moduly/faktury/db/faktury.js': 9,
  'moduly/faktury/modul.ts': 45,
  'moduly/faktury/services/archiwum-sprzedazy.js': 2,
  'moduly/faktury/services/czuwacz-archiwum-sprzedazy.js': 5,
  'moduly/faktury/services/czuwacz-ksef.js': 5,
  'moduly/faktury/services/faktura-allegro.js': 2,
  'moduly/faktury/services/faktura-okresu.js': 2,
  'moduly/faktury/services/faktura.js': 2,
  'moduly/faktury/services/faktury-widok.js': 2,
  'moduly/faktury/services/ksef-doczytanie.js': 2,
  'moduly/faktury/services/wysylka-ksef.js': 4,
  'moduly/faktury/trasy/automat-ksef-ekran.js': 2,
  'moduly/faktury/trasy/dokumenty.js': 13,
  'moduly/faktury/trasy/druk.js': 3,
  'moduly/faktury/trasy/faktury.js': 25,
  'moduly/faktury/trasy/okresy.js': 13,
  'moduly/faktury/widoki/faktury.ejs': 4,
  'moduly/faktury/widoki/ksef-podglad.ejs': 1,
  'moduly/faktury/widoki/okres.ejs': 4,
  'moduly/koszty/pdf/zestawienie-dla-biura-pdf.js': 1,
  'moduly/koszty/services/paczka-dla-biura.js': 2,
  'moduly/koszty/trasy/ustawienia-ksef.js': 2,
  'moduly/ustawienia/cele-diagnostyki.ts': 6,
  'moduly/ustawienia/widoki/lacznosc.ejs': 1,
  'moduly/wiadomosci/services/wiadomosci.js': 3,
  'moduly/wiadomosci/uslugi.ts': 3,
  'moduly/wysylka/services/czuwacz-przesylek.js': 2,
  'moduly/wysylka/services/oznaczanie-pobran.js': 2,
  'moduly/zamowienia/kontekst.js': 4,
  'moduly/zdrowie/services/czuwacz-ostrzezen.js': 6,
  'moduly/zwroty/services/korekta.js': 2,
  'moduly/zwroty/trasy/akcje.js': 2,
  'moduly/zwroty/trasy/formularz.js': 2,
  'moduly/zwroty/trasy/korekty.js': 10,
  'moduly/zwroty/trasy/wspolne.js': 2,
  'oms/db/okresy.js': 2,
  'oms/db/zwroty.js': 1,
};

// ── Skan ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function pliki(katalog) {
  return fs.readdirSync(katalog, { withFileTypes: true }).flatMap((w) => {
    const p = path.join(katalog, w.name);
    return w.isDirectory() ? pliki(p) : [p];
  });
}

/** Wystąpienia, które nie mieszczą się w dozwolonych: plik → [{ linia, tekst, ile }]. */
export function nadmiar(plik, lista) {
  if (Object.hasOwn(WOLNO_CALY_PLIK, plik) || WOLNO_KATALOG.some((k) => plik.startsWith(k))) return [];
  const napisy = [...(WOLNO_NAPISY[plik] ?? [])];
  return lista.filter((t) => {
    if (Object.hasOwn(WOLNO_NAZWY, t.tekst)) return false;
    if (MODUL.test(plik) && wolnoWModule(t.tekst)) return false;
    const i = napisy.indexOf(t.tekst);
    if (i >= 0) { napisy.splice(i, 1); return false; }
    return true;
  });
}

function skan() {
  const wszystkie = {};
  const poza = {};
  for (const p of pliki(SRC)) {
    if (!TEKST.has(path.extname(p))) continue;
    const plik = path.relative(SRC, p).split(path.sep).join('/');
    const w = wystapienia(p, fs.readFileSync(p, 'utf8'));
    if (!w.length) continue;
    wszystkie[plik] = w;
    const n = nadmiar(plik, w);
    if (n.length) poza[plik] = n;
  }
  return { wszystkie, poza };
}

const suma = (lista) => lista.reduce((s, t) => s + t.ile, 0);

describe('strażnik nazw programu fakturowego (PRZ-118.10)', () => {
  const { wszystkie, poza } = skan();

  it('„infakt” w kodzie src/ tylko u wykonawcy inFakt albo w zaległości o dokładnej liczbie', () => {
    const bledy = [];
    for (const [plik, lista] of Object.entries(poza)) {
      const ile = suma(lista);
      if (!Object.hasOwn(ZALEGLOSCI, plik)) {
        bledy.push(`${plik}: ${ile} wystąpień poza listami — nazwa z programu (domena/nazwa-programu.js, opis.nazwa)`
          + lista.map((t) => `\n    l.${t.linia}  ${t.tekst.slice(0, 110)}`).join(''));
      } else if (ile > ZALEGLOSCI[plik]) {
        bledy.push(`${plik}: ${ile} > ${ZALEGLOSCI[plik]} na liście zaległości — nowy napis z inFaktem`
          + lista.map((t) => `\n    l.${t.linia}  ${t.tekst.slice(0, 110)}`).join(''));
      } else if (ile < ZALEGLOSCI[plik]) {
        bledy.push(`${plik}: zmniejsz zaległość w teście do ${ile} (jest ${ZALEGLOSCI[plik]})`);
      }
    }
    for (const plik of Object.keys(ZALEGLOSCI)) {
      if (!poza[plik]) bledy.push(`${plik}: zmniejsz zaległość w teście do 0 (usuń wiersz; jest ${ZALEGLOSCI[plik]})`);
    }
    expect(bledy, bledy.join('\n')).toEqual([]);
  });

  it('listy dozwolonych nie są martwe: każdy plik i napis naprawdę stoi w src/', () => {
    for (const plik of Object.keys(WOLNO_CALY_PLIK)) expect(wszystkie[plik], plik).toBeDefined();
    for (const [plik, napisy] of Object.entries(WOLNO_NAPISY)) {
      const teksty = (wszystkie[plik] ?? []).map((t) => t.tekst);
      for (const n of new Set(napisy)) {
        expect(teksty.filter((t) => t === n).length, `${plik}: ${n}`).toBeGreaterThanOrEqual(napisy.filter((x) => x === n).length);
      }
    }
    const teksty = new Set(Object.values(wszystkie).flat().map((t) => t.tekst));
    for (const nazwa of Object.keys(WOLNO_NAZWY)) expect(teksty.has(nazwa), nazwa).toBe(true);
  });

  it('skaner: komentarz pominięty, napis i szablon złapane, <%= %> złapany, <%# %> pominięty, wielkość liter bez znaczenia', () => {
    const ile = (p, t) => suma(wystapienia(p, t));
    expect(ile('a.js', '// inFakt\n/* w inFakcie */ const y = 1;')).toBe(0);
    expect(ile('a.js', "const t = 'Brak połączenia z inFaktem';")).toBe(1);
    expect(ile('a.js', "const t = 'w inFakcie albo w inFaktu';")).toBe(2);
    expect(ile('a.ts', 'const t = `${a} nie ma w inFakcie ${b}`;')).toBe(1);
    expect(ile('a.ts', 'const t = `start ${a} środek inFaktu ${b} koniec`;')).toBe(1);
    expect(ile('a.js', 'const k = process.env.INFAKT_API_KEY;')).toBe(1);
    expect(ile('a.js', 'const { infakt } = uslugi;')).toBe(1);
    expect(ile('a.js', 'const terminFaktury = 14;')).toBe(0);
    expect(ile('w.ejs', '<p><%= nazwa %> — w inFakcie</p>')).toBe(1);
    expect(ile('w.ejs', "<p><%= 'inFakt' %></p>")).toBe(1);
    expect(ile('w.ejs', '<%# inFakt\n inFaktu %>\n<p>ok</p>')).toBe(0);
    expect(wystapienia('w.ejs', '<%# inFakt\n %>\n<p>inFakt</p>').map((t) => t.linia)).toEqual([3]);
    expect(ile('x.sql', 'UPDATE faktury SET infakt_uuid = 1;')).toBe(1);
  });

  it('reguły: nazwa kanoniczna wolna wszędzie, modul.ts tylko INFAKT_* i klucz infakt, napisy zapisu policzone', () => {
    const w = (p, t) => nadmiar(p, wystapienia(p, t)).map((x) => x.tekst);
    expect(w('domena/x.js', 'export const polaWdtInfakt = 1;')).toEqual([]);
    expect(w('moduly/x/modul.ts', "const a = env.INFAKT_API_KEY; const b = ctx.usluga('faktury', 'infakt');")).toEqual([]);
    expect(w('moduly/x/modul.ts', "const t = 'Brak inFaktu';")).toEqual(['Brak inFaktu']);
    expect(w('moduly/x/inne.ts', 'const a = env.INFAKT_API_KEY;')).toEqual(['INFAKT_API_KEY']);
    expect(w('oms/infakt/client.js', "const t = 'inFakt';")).toEqual([]);
    expect(w('moduly/faktury/db/faktury.js', "f('infakt'); g('infakt'); h('infakt');")).toEqual(['infakt']);
  });
});
