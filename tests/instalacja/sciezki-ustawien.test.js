// PRZ-168 A1c: teksty dla użytkownika nie odsyłają do pozycji Ustawień, których nie ma w menu.
// Obcy sprzedawca, który czyta „Ustawienia → Moduły”, a w menu jest „System → Włączone funkcje”, nie znajdzie ekranu.
//
// Test przechodzi src/**/*.{js,ts,mjs,ejs} (bez komentarzy — to samo wycinanie co odsylacze-src.test.js)
// i docs/**/*.md (bez docs/plany, docs/archiwum, plików prz* i rejestru docs/zadania.md), a także deploy/**/*.md
// oraz wiersze „#” w .env.example i deploy/klient/*.yaml. Każde
// „Ustawienia → A” / „Ustawieniach → A” (opcjonalnie „→ B”) musi wskazywać:
// - A = etykieta działu z DZIALY_USTAWIEN (src/domena/dzialy-ustawien.js),
// - B = etykieta zakładki tego działu; dla działu Integracje także `nazwa` z katalogu integracji.
// Sam dział bez „Ustawienia” („Otwórz Integracje → Reklamy”) też musi mieć poprawne B.
// Import z odsylacze-src.test.js uruchamia tu także jego dwa testy (jedno źródło wycinania komentarzy).
// Etykiety dopasowujemy najdłuższą znaną (dział „Faktury i podatki”, nie „Faktury”), z dowolnym białym znakiem
// między słowami (akapit w .md bywa złamany w środku etykiety). Ścieżka z wstawką `${…}`/`<%…%>` w miejscu etykiety
// nie jest sprawdzana (nazwa przychodzi z kodu). Fałszywą zieleń łapie asercja liczby znalezionych ścieżek.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bezKomentarzyEjs, bezKomentarzyJs } from './odsylacze-src.test.js';
import { DZIALY_USTAWIEN, modelNawigacjiUstawien } from '../../src/domena/dzialy-ustawien.js';
import { KATALOG_INTEGRACJI } from '../../src/domena/katalog-integracji.ts';

const KORZEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KOD = new Set(['.js', '.ts', '.mjs', '.ejs']);

// docs/zadania.md to rejestr historyczny zadań (co zrobiono i kiedy) — opisuje dawne menu, jak docs/plany.
const POMIJANE_DOKUMENTY = new Set(['docs/zadania.md']);

// Ścieżki w cudzych systemach (tekst po „Ustawienia → ”). Krótko i z powodem.
const WYJATKI = [
  ['API', 'inFakt: „Ustawienia → API” w panelu inFaktu (klucz API)'],
  ['Zaawansowane → REST API', 'WooCommerce: klucz REST API w panelu sklepu'],
  ['Płatności', 'WooCommerce: ustawienia bramki płatności w panelu sklepu'],
  ['Wysyłka → strefa', 'WooCommerce: strefy wysyłki w panelu sklepu'],
  ['Integracje i dodatki → KSeF', 'Fakturownia: włączenie KSeF w panelu Fakturowni'],
  ['Drukarki i skanery', 'Windows: lista drukarek w ustawieniach systemu (deploy/drukarka)'],
];

// Etykiety sprzed przebudowy menu (PRZ-168): na trzecim poziomie („Integracje → Poczta wychodząca → Podpis maili”)
// nie wolno ich używać — tych pozycji już nie ma.
const STARE_ETYKIETY = ['Podpis maili', 'Kurierzy', 'Moduł faktur', 'Sklepy i usługi'];

const zamaz = (s) => s.replace(/[^\n]/g, ' ');
const bezWierszyGwiazdki = (t) => t.split('\n').map((w) => (/^\s*\*/.test(w) ? zamaz(w) : w)).join('\n');

// .env.example i deploy/klient/*.yaml: dla czytelnika liczą się tylko wiersze komentarza „#” (opis zmiennej).
// Sam znak „#” zamazujemy, żeby etykieta złamana między wierszami („Poczta\n# wychodząca”) była jedną etykietą.
const tylkoWierszeHash = (t) => t.split('\n')
  .map((w) => (/^\s*#/.test(w) ? w.replace(/^\s*#/, zamaz) : zamaz(w))).join('\n');

/** Tekst do skanu: dla kodu bez komentarzy (numery linii bez zmian), dla .md bez zmian, dla .env/.yaml same „#”. */
export function tekstDoSkanu(plik, zrodlo) {
  if (plik.endsWith('.md')) return zrodlo;
  if (/(?:^|[\\/])\.env\.example$|\.ya?ml$/.test(plik)) return tylkoWierszeHash(zrodlo);
  return bezWierszyGwiazdki(plik.endsWith('.ejs') ? bezKomentarzyEjs(zrodlo) : bezKomentarzyJs(zrodlo));
}

// Etykiety zakładek z modelu nawigacji (admin + dane demo = komplet, także „System → Dane demo”).
const ZAKLADKI = new Map(DZIALY_USTAWIEN.map((d) => [d.etykieta,
  modelNawigacjiUstawien(d.zakladki[0].href, { admin: true, daneDemo: true }).zakladki.map((z) => z.etykieta)]));
const DZIAL_INTEGRACJE = DZIALY_USTAWIEN.find((d) => d.klucz === 'integracje').etykieta;
// Integracja planowana nie ma ekranu (karta „wkrótce”), więc nie jest celem ścieżki.
ZAKLADKI.get(DZIAL_INTEGRACJE).push(...KATALOG_INTEGRACJI.filter((i) => i.dostepnosc !== 'planowana').map((i) => i.nazwa));

const ucieknij = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wzorEtykiety = (e) => ucieknij(e).replace(/ /g, '\\s+');
const wzorListy = (etykiety) => [...new Set(etykiety)].sort((a, b) => b.length - a.length).map(wzorEtykiety).join('|');
// Ozdoby przed etykietą: markdown (**, _, `), cudzysłów, znacznik HTML (<a …>, <strong>).
const OZDOBY = String.raw`(?:\*\*?|_|\x60|„|"|“|<[^<>\n]*>|\s)*`;
const OZDOBY_PO = String.raw`(?:\*\*?|_|\x60|”|"|<\/[a-z]+>)*`;
const STRZALKA = String.raw`\s*→`;
const WSTAWKA = String.raw`(?:\$\{|<%)`;
const POCZATEK = new RegExp(String.raw`Ustawienia(?:ch)?(?![\p{L}\p{N}])${OZDOBY_PO}${STRZALKA}`, 'gu');
const dopasowanie = (wzor) => new RegExp(String.raw`${OZDOBY}(?:(${WSTAWKA})|(${wzor})(?![\p{L}\p{N}]))`, 'uy');
const DZIAL = dopasowanie(wzorListy([...ZAKLADKI.keys()]));
const ZAKLADKA = new Map([...ZAKLADKI].map(([dzial, etykiety]) => [dzial, dopasowanie(wzorListy(etykiety))]));
const DALEJ = new RegExp(String.raw`${OZDOBY_PO}${STRZALKA}`, 'uy');
const STARA = dopasowanie(wzorListy(STARE_ETYKIETY));
// Po ostatniej etykiecie ścieżki (dział albo zakładka, bez „→”) zdanie się kończy albo toczy dalej: koniec tekstu
// lub wiersza, interpunkcja, nawias, cudzysłów, znacznik, a po białych znakach wszystko poza wielką literą
// i spójnikiem „i”/„oraz” (słowo zdania, nawias, myślnik, „' +” sklejanego napisu, „|” tabeli). Dopisek do etykiety
// („Firma i logo”, „System i moduły”, „Firma Logo”, „DPD Polska”) to nieistniejąca pozycja menu — także gdy „i …”
// zaczyna następny wiersz, również z wcięciem (złamanie w .env.example, .md, .yaml). `(?!\s)` nie pozwala `\s+`
// oddać ostatniego białego znaku i tak ominąć sprawdzenia.
// Dwa zawężenia (inaczej fałszywy alarm na dobrym tekście): etykieta zamknięta ozdobą („**…Fakturownia**\ni kliknij”,
// „</a>”, „””) jest skończona; „i”/„oraz” + etykieta działu (albo „Analizy i finanse”) i „→” zaczyna
// następną ścieżkę („Ustawienia → Integracje oraz Analizy i finanse → Finanse”, docs/zmienne.md).
const SPOJNIK = String.raw`(?:i|oraz)\s(?!${OZDOBY}(?:${wzorListy([...ZAKLADKI.keys(), 'Analizy i finanse'])})${OZDOBY_PO}\s*→)`;
const KONIEC_ETYKIETY = new RegExp(String.raw`(?:${OZDOBY_PO.replace(/\*$/, '+')}|${OZDOBY_PO}(?:$|[ \t]*\n(?![\s#*]*${SPOJNIK})`
  + String.raw`|[.,;:!?…)\]”"'<]|\s+(?!\s)(?!${SPOJNIK})(?!\p{Lu})))`, 'uy');
// Wszystkie etykiety menu: zakładka, po której stoi dalszy ciąg innej etykiety („Kopie zapasowe → Historia logowań”
// — „Historia logowań” jest w Zespół i dostęp), to pomyłka działu, choć dopisek jest z małej litery.
const KAZDA_ETYKIETA = dopasowanie(wzorListy([...ZAKLADKI.keys(), ...[...ZAKLADKI.values()].flat()]));
// Dział bez przedrostka („Otwórz Integracje → Reklamy”): ten sam wymóg dla B. Pomijamy dział, przed którym stoi „→”
// — to część ścieżki „Ustawienia → …”, sprawdzanej wyżej.
const GOLY_DZIAL = new RegExp(String.raw`(?<!→${OZDOBY})(?<![\p{L}\p{N}])(${wzorListy([...ZAKLADKI.keys()])})${OZDOBY_PO}${STRZALKA}`, 'gu');

const sciezkaDoRaportu = (tekst, od) => `Ustawienia → ${tekst.slice(od, od + 70).replace(/\s+/g, ' ').trim()}`;
const normalizuj = (dziala) => DZIALY_USTAWIEN.find((d) => new RegExp(`^${wzorEtykiety(d.etykieta)}$`, 'u').test(dziala)).etykieta;

function dopasuj(wzor, tekst, od) {
  wzor.lastIndex = od;
  const m = wzor.exec(tekst);
  if (!m) return null;
  return { wstawka: Boolean(m[1]), etykieta: m[2]?.replace(/\s+/g, ' '), koniec: wzor.lastIndex };
}

/** „… → B → C”, gdzie C to etykieta sprzed przebudowy menu. */
function staryTrzeciPoziom(tekst, b) {
  if (b.wstawka) return false;
  DALEJ.lastIndex = b.koniec;
  if (!DALEJ.exec(tekst)) return false;
  const c = dopasuj(STARA, tekst, DALEJ.lastIndex);
  return Boolean(c && !c.wstawka);
}

function dobryKoniec(tekst, od) {
  KONIEC_ETYKIETY.lastIndex = od;
  return KONIEC_ETYKIETY.test(tekst);
}

/** Zakładka B (dopasowana od `od`) nie istnieje, wskazuje starą pozycję albo ma dopisek po sobie. */
function zlaZakladka(tekst, b, od) {
  if (!b) return true;
  if (b.wstawka) return false;
  DALEJ.lastIndex = b.koniec;
  if (DALEJ.exec(tekst)) return staryTrzeciPoziom(tekst, b);
  const dluzsza = dopasuj(KAZDA_ETYKIETA, tekst, od);
  if (dluzsza && dluzsza.koniec > b.koniec) return true;
  return !dobryKoniec(tekst, b.koniec);
}

/**
 * Wszystkie ścieżki „Ustawienia → …” w tekście (już bez komentarzy).
 * Zwraca { sprawdzone, naruszenia: [{ linia, sciezka }], wyjatki }.
 */
export function sprawdzSciezki(tekst) {
  const wynik = { sprawdzone: 0, naruszenia: [], wyjatki: 0 };
  for (const m of tekst.matchAll(POCZATEK)) {
    const od = m.index + m[0].length;
    const linia = tekst.slice(0, m.index).split('\n').length;
    const dalej = tekst.slice(od, od + 80).replace(/\s+/g, ' ').trim().replace(/^(\*\*?|„|")/, '');
    if (WYJATKI.some(([poczatek]) => dalej.startsWith(poczatek))) { wynik.wyjatki += 1; continue; }
    wynik.sprawdzone += 1;
    const blad = () => wynik.naruszenia.push({ linia, sciezka: sciezkaDoRaportu(tekst, od) });
    const a = dopasuj(DZIAL, tekst, od);
    if (!a) { blad(); continue; }
    if (a.wstawka) continue;
    DALEJ.lastIndex = a.koniec;
    if (!DALEJ.exec(tekst)) {
      if (!dobryKoniec(tekst, a.koniec)) blad();
      continue;
    }
    const b = dopasuj(ZAKLADKA.get(normalizuj(a.etykieta)), tekst, DALEJ.lastIndex);
    if (zlaZakladka(tekst, b, DALEJ.lastIndex)) blad();
  }
  for (const m of tekst.matchAll(GOLY_DZIAL)) {
    wynik.sprawdzone += 1;
    const b = dopasuj(ZAKLADKA.get(normalizuj(m[1])), tekst, m.index + m[0].length);
    if (zlaZakladka(tekst, b, m.index + m[0].length)) {
      wynik.naruszenia.push({ linia: tekst.slice(0, m.index).split('\n').length,
        sciezka: `${m[1].replace(/\s+/g, ' ')} → ${tekst.slice(m.index + m[0].length, m.index + m[0].length + 60).replace(/\s+/g, ' ').trim()}` });
    }
  }
  wynik.naruszenia.sort((x, y) => x.linia - y.linia);
  return wynik;
}

function pliki(katalog, czyBrac) {
  const wynik = [];
  for (const wpis of fs.readdirSync(katalog, { withFileTypes: true })) {
    const p = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) wynik.push(...pliki(p, czyBrac));
    else if (czyBrac(p, wpis.name)) wynik.push(p);
  }
  return wynik;
}

// Dziś (PRZ-168 A1d) docs/ daje 128 ścieżek; próg z zapasem na skracanie dokumentów.
const DOCS_MIN = 80;
// PRZ-168 A1e: .env.example (2 ścieżki) i deploy/ (3) mają własne progi — zepsute wycinanie wierszy „#” albo zgubiony
// blok deploy w plikiDoSkanu nie może przejść po cichu, bo reszta repo i tak przekracza próg ogólny.
const ENV_MIN = 2;
const DEPLOY_MIN = 3;
const wzgledna = (p) => path.relative(KORZEN, p).split(path.sep).join('/');

function plikiDoSkanu() {
  const src = pliki(path.join(KORZEN, 'src'), (p) => KOD.has(path.extname(p)));
  const docs = pliki(path.join(KORZEN, 'docs'), (p, nazwa) => nazwa.endsWith('.md') && !nazwa.startsWith('prz')
    && !POMIJANE_DOKUMENTY.has(wzgledna(p)) && !/^docs\/(plany|archiwum)\//.test(wzgledna(p)));
  // PRZ-168 D5: instrukcje instalacji czyta obcy sprzedawca tak samo jak docs/.
  const deploy = [
    ...pliki(path.join(KORZEN, 'deploy'), (p, nazwa) => nazwa.endsWith('.md')),
    ...pliki(path.join(KORZEN, 'deploy/klient'), (p, nazwa) => /\.ya?ml$/.test(nazwa) && path.dirname(p) === path.join(KORZEN, 'deploy/klient')),
    path.join(KORZEN, '.env.example'),
  ];
  return [...src, ...docs, ...deploy];
}

describe('ścieżki „Ustawienia → …” w src/ i docs/ wskazują pozycje z menu Ustawień', () => {
  it('sprawdzanie: dobre ścieżki przechodzą, złe są łapane', () => {
    const dobre = [
      'Uzupełnij NIP w Ustawienia → Firma.',
      'Połącz konto w Ustawienia → Integracje → inFakt (klucz API).',
      'Wybierz program w Ustawienia → Faktury i podatki → Program do faktur.',
      'Włącz w <a href="/ustawienia/moduly">Ustawienia → System → Włączone funkcje</a>.',
      'Statystyki w Ustawienia → Integracje → Meta Ads, Google Analytics 4 albo Google Ads.',
      'Działa w Ustawieniach → Zespół i dostęp → Użytkownicy.',
      'Zobacz **Ustawienia → Zamówienia\ni magazyn → Stany magazynowe**.',
      'Konto w Ustawienia → Integracje → Moje połączenia → ERLI.',
      'Klucz z Ustawienia → API w panelu inFaktu.',
      'Wróć do Ustawienia → Integracje → ${nazwa} i popraw.',
      'Konto w Ustawienia → Integracje → Allegro tego kanału.',
      'Statystyki w Ustawienia → Integracje → Google Analytics 4.',
      'Stopka w Ustawienia → Komunikacja → Podpis i stopka.',
      'Role w Ustawienia → Zespół i dostęp → Role i uprawnienia, klucze w Zespół i dostęp → Klucze API.',
      'Otwórz Integracje → Moje połączenia, a potem kartę konta.',
      'W panelu: Ustawienia → Integracje oraz Analizy i finanse → Finanse → Kompletność danych.',
      'Otwórz **Ustawienia → Integracje → Fakturownia**\ni kliknij **Sprawdziłem**.',
      'Otwórz Integracje → Moje połączenia albo Faktury i podatki → KSeF.',
      'W Ustawienia → Firma uzupełnij NIP, a w Ustawieniach → System (Stan systemu) sprawdź połączenia',
      '**Ustawienia → Kopie zapasowe** — tu kopie.',
    ];
    const zle = [
      'Włącz w Ustawienia → Moduły.',
      'Włącz w Ustawienia → System\ni moduły.',
      'Patrz Ustawienia → Integracje → Moduł faktur.',
      'Patrz Ustawieniach → Konta.',
      'Ustawienia → Faktury („faktura bez prośby”).',
      'Ustawienia → Firma → Logo.',
      'Ustawienia → Integracje → Kurier DPD.',
      'Ustawienia → <a href="/ustawienia/druk">Druk i etykiety</a>',
      'Otwórz <a href="/x">Integracje → Reklamy</a>',
      'W menu Integracje → Moduł faktur wybierz program.',
      'Wpisz w Ustawienia → Integracje → Poczta wychodząca → Podpis maili.',
      'Połącz w Ustawienia → Integracje → GLS.',
      'Logo w Ustawienia → Firma i logo.',
      'Włącz w Ustawienia → System i moduły.',
      'Otwórz Integracje → Moje połączenia → Kurierzy.',
      'Ustawienia → Firma Logo firmy.',
      'Włącz w Ustawienia → System\n    i moduły.',
      'Logo w Ustawienia → Firma  i logo.',
      'Ustawienia → Firma oraz logo.',
      'Ustawienia → Kopie zapasowe → Historia logowań',
      'Ustawienia → Integracje → DPD Polska.',
      'Ustawienia → Komunikacja → Podpis i stopka oraz logo.',
      'Otwórz Integracje → Moje połączenia Allegro.',
      'Ustawienia → System i moduły → Włączone funkcje.',
      'Ustawienia → System i Moduły → Włączone funkcje.',
      'Ustawienia → Integracje i Kurierzy → DPD.',
      'Ustawienia → Integracje → DPD i Kurierzy → InPost.',
      'Ustawienia → Firma oraz Rachunek → Rachunek bankowy.',
    ];
    const zgloszone = (zdanie) => sprawdzSciezki(zdanie).naruszenia.map((n) => n.sciezka);
    for (const zdanie of dobre) expect(zgloszone(zdanie), zdanie).toEqual([]);
    for (const zdanie of zle) expect(zgloszone(zdanie), zdanie).toHaveLength(1);
    expect(sprawdzSciezki('a\nb Ustawienia → Moduły').naruszenia).toEqual([{ linia: 2, sciezka: 'Ustawienia → Moduły' }]);
    expect(sprawdzSciezki('Klucz z Ustawienia → API.').wyjatki).toBe(1);
    expect(sprawdzSciezki('Ustawienia → Integracje i dodatki → KSeF w Fakturowni.').wyjatki).toBe(1);
    // gałąź .env/.yaml: „#” zamazany na spację, więc „i …” w następnym wierszu ma wcięcie
    expect(sprawdzSciezki(tekstDoSkanu('.env.example', '# Ustawienia → System\n# i moduły.')).naruszenia).toHaveLength(1);
  });

  it('w komentarzu kodu ścieżka nie jest sprawdzana, w napisie jest', () => {
    const js = "// Ustawienia → Moduły\nconst t = 'Ustawienia → Moduły';";
    expect(sprawdzSciezki(tekstDoSkanu('x.js', js)).naruszenia.map((n) => n.linia)).toEqual([2]);
    const ejs = '<%# Ustawienia → Moduły %>\n<p>Ustawienia → Moduły</p>';
    expect(sprawdzSciezki(tekstDoSkanu('x.ejs', ejs)).naruszenia.map((n) => n.linia)).toEqual([2]);
  });

  it('każda ścieżka wskazuje dział i zakładkę z menu', () => {
    const naruszenia = [];
    let sprawdzone = 0;
    let zDocs = 0;
    let zEnv = 0;
    let zDeploy = 0;
    for (const plik of plikiDoSkanu()) {
      const wynik = sprawdzSciezki(tekstDoSkanu(plik, fs.readFileSync(plik, 'utf8')));
      sprawdzone += wynik.sprawdzone;
      if (wzgledna(plik).startsWith('docs/')) zDocs += wynik.sprawdzone;
      if (wzgledna(plik) === '.env.example') zEnv += wynik.sprawdzone;
      if (wzgledna(plik).startsWith('deploy/')) zDeploy += wynik.sprawdzone;
      for (const n of wynik.naruszenia) naruszenia.push(`${path.relative(KORZEN, plik)}:${n.linia}: ${n.sciezka}`);
    }
    expect(naruszenia, `ścieżki do pozycji, których nie ma w menu Ustawień:\n${naruszenia.join('\n')}`).toEqual([]);
    // kontrola skanera: inaczej pusty skan dałby zieleń
    expect(sprawdzone).toBeGreaterThan(50);
    // osobno docs/: bez tego progu zgubiony skan docs/ przeszedłby, bo src/ sam ma ponad 50 ścieżek
    expect(zDocs).toBeGreaterThan(DOCS_MIN);
    expect(zEnv, '.env.example').toBeGreaterThanOrEqual(ENV_MIN);
    expect(zDeploy, 'deploy/').toBeGreaterThanOrEqual(DEPLOY_MIN);
  });
});
