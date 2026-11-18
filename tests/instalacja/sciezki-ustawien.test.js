// Teksty dla użytkownika nie odsyłają do pozycji Ustawień, których nie ma w menu.
// Obcy sprzedawca, który czyta „Ustawienia → Moduły”, a w menu jest „System → Włączone funkcje”, nie znajdzie ekranu.
//
// Test przechodzi src/**/*.{js,ts,mjs,ejs} (bez komentarzy — to samo wycinanie co odsylacze-src.test.js)
// i dokumentację (bez planów, archiwum i rejestru zadań), a także deploy/**/*.md
// oraz wiersze „#” w .env.example i deploy/klient/*.yaml. Także docs/konfiguracja.json (opisy zmiennych
// trafiają do panelu i docs/konfiguracja.md), scripts/ (napisy na ekran; bez jednorazowych prz*/mutacje-*)
// i deploy/**/*.{json,sh,mjs} (np. deploy/klient/aktualizuj.sh, deploy/drukarka/config*.przyklad.json). Każde
// „Ustawienia → A” / „Ustawieniach → A” / „z Ustawień → A” / „Ustawieniami → A” (opcjonalnie „→ B”, „→ C”) musi wskazywać:
// - A = etykieta działu z DZIALY_USTAWIEN (src/domena/dzialy-ustawien.js),
// - B = etykieta zakładki tego działu; dla działu Integracje także `nazwa` z katalogu integracji,
// - C (trzeci poziom) tylko tam, gdzie menu go ma: Integracje → Moje połączenia / Dodaj integrację → nazwa integracji;
//   dalej tylko element ekranu z ELEMENTY_EKRANU („→ ERLI → Metody dostawy”) albo polecenie małą literą („→ połącz kanał”).
// Strzałka: „→”, „->”, „»” albo „ > ” (ze spacjami). Sam dział bez „Ustawienia” („Otwórz Integracje → Reklamy”) też
// musi mieć poprawne B. Import z odsylacze-src.test.js uruchamia tu także jego dwa testy (jedno źródło wycinania komentarzy).
// Etykiety dopasowujemy najdłuższą znaną (dział „Faktury i podatki”, nie „Faktury”), z dowolnym białym znakiem
// między słowami (akapit w .md bywa złamany w środku etykiety) i z literą bez ogonka zamiast polskiej (pliki drukarki
// są w ASCII: „Zespol i dostep”). Wstawka `${…}`/`<%…%>` w miejscu etykiety nie jest sprawdzana (nazwa przychodzi
// z kodu), ale to, co stoi po niej („${dzial} → Magazyn”), już tak. Fałszywą zieleń łapią progi liczby ścieżek.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bezKomentarzyEjs, bezKomentarzyJs } from './odsylacze-src.test.js';
import { DZIALY_USTAWIEN, modelNawigacjiUstawien } from '../../src/domena/dzialy-ustawien.js';
import { KATALOG_INTEGRACJI } from '../../src/domena/katalog-integracji.ts';

const KORZEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KOD = new Set(['.js', '.ts', '.mjs', '.ejs']);

// Historyczny rejestr zadań i plany opisują dawne menu, więc nie są sprawdzane.
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

const zamaz = (s) => s.replace(/[^\n]/g, ' ');
const bezWierszyGwiazdki = (t) =>
  t
    .split('\n')
    .map((w) => (/^\s*\*/.test(w) ? zamaz(w) : w))
    .join('\n');

// .env.example i deploy/klient/*.yaml: dla czytelnika liczą się tylko wiersze komentarza „#” (opis zmiennej).
// Sam znak „#” zamazujemy, żeby etykieta złamana między wierszami („Poczta\n# wychodząca”) była jedną etykietą.
const tylkoWierszeHash = (t) =>
  t
    .split('\n')
    .map((w) => (/^\s*#/.test(w) ? w.replace(/^\s*#/, zamaz) : zamaz(w)))
    .join('\n');

// .json: ucieczki w napisie („\n”, „\"”) zamieniamy na białe znaki tej samej długości, żeby nie kleiły się z etykietą.
const bezUcieczekJson = (t) => t.replace(/\\[nrt]/g, '  ').replace(/\\"/g, ' "');

/** Tekst do skanu: dla kodu bez komentarzy (numery linii bez zmian), dla .md i .sh bez zmian, dla .env/.yaml same „#”. */
export function tekstDoSkanu(plik, zrodlo) {
  if (plik.endsWith('.md') || plik.endsWith('.sh')) return zrodlo;
  if (plik.endsWith('.json')) return bezUcieczekJson(zrodlo);
  if (/(?:^|[\\/])\.env\.example$|\.ya?ml$/.test(plik)) return tylkoWierszeHash(zrodlo);
  return bezWierszyGwiazdki(plik.endsWith('.ejs') ? bezKomentarzyEjs(zrodlo) : bezKomentarzyJs(zrodlo));
}

// Etykiety zakładek z modelu nawigacji (admin + dane demo = komplet, także „System → Dane demo”).
const ZAKLADKI = new Map(
  DZIALY_USTAWIEN.map((d) => [
    d.etykieta,
    modelNawigacjiUstawien(d.zakladki[0].href, { admin: true, daneDemo: true }).zakladki.map((z) => z.etykieta),
  ]),
);
const DZIAL_INTEGRACJE = DZIALY_USTAWIEN.find((d) => d.klucz === 'integracje');
// Integracja planowana nie ma ekranu (karta „wkrótce”), więc nie jest celem ścieżki.
const INTEGRACJE = KATALOG_INTEGRACJI.filter((i) => i.dostepnosc !== 'planowana').map((i) => i.nazwa);
ZAKLADKI.get(DZIAL_INTEGRACJE.etykieta).push(...INTEGRACJE);
// Trzeci poziom w menu istnieje tylko pod zakładkami-listami integracji (karta konta na „Moje połączenia”,
// karta w „Dodaj integrację”) — tam C to nazwa integracji. Etykiety z kodu, nie z ręcznej listy.
const ZAKLADKI_Z_INTEGRACJAMI = DZIAL_INTEGRACJE.zakladki.map((z) => z.etykieta);

const ucieknij = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OGONKI = {
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z',
  Ą: 'A',
  Ć: 'C',
  Ę: 'E',
  Ł: 'L',
  Ń: 'N',
  Ó: 'O',
  Ś: 'S',
  Ź: 'Z',
  Ż: 'Z',
};
const wzorEtykiety = (e) =>
  [...e].map((c) => (c === ' ' ? '\\s+' : OGONKI[c] ? `[${c}${OGONKI[c]}]` : ucieknij(c))).join('');
const wzorListy = (etykiety) =>
  [...new Set(etykiety)]
    .sort((a, b) => b.length - a.length)
    .map(wzorEtykiety)
    .join('|');
// Ozdoby przed etykietą: markdown (**, _, `), cudzysłów, znacznik HTML (<a …>, <strong>).
const OZDOBY = String.raw`(?:\*\*?|_|\x60|„|"|“|<[^<>\n]*>|\s)*`;
const OZDOBY_PO = String.raw`(?:\*\*?|_|\x60|”|"|<\/[a-z]+>)*`;
// „>” tylko ze spacjami po obu stronach (inaczej to koniec znacznika HTML albo „=>”/„->” w kodzie).
const STRZALKA = String.raw`(?:\s*(?:→|->|»)|[ \t]+>(?=[ \t]))`;
const STRZALKA_PRZED = String.raw`(?:→|->|»|[ \t]>)`;
const WSTAWKA = String.raw`(?:\$\{[^}\n]*\}|<%[^%]*%>)`;
const POCZATEK = new RegExp(
  String.raw`(?<![\p{L}\p{N}])Ustawie(?:nia(?:ch)?|niami|[ńn])(?![\p{L}\p{N}])${OZDOBY_PO}${STRZALKA}`,
  'gu',
);
const dopasowanie = (wzor) => new RegExp(String.raw`${OZDOBY}(?:(${WSTAWKA})|(${wzor})(?![\p{L}\p{N}]))`, 'uy');
const DZIAL = dopasowanie(wzorListy([...ZAKLADKI.keys()]));
const ZAKLADKA = new Map([...ZAKLADKI].map(([dzial, etykiety]) => [dzial, dopasowanie(wzorListy(etykiety))]));
const DALEJ = new RegExp(String.raw`${OZDOBY_PO}${STRZALKA}`, 'uy');
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
const KONIEC_ETYKIETY = new RegExp(
  String.raw`(?:${OZDOBY_PO.replace(/\*$/, '+')}|${OZDOBY_PO}(?:$|[ \t]*\n(?![\s#*]*${SPOJNIK})` +
    String.raw`|[.,;:!?…)\]”"'<]|\s+(?!\s)(?!${SPOJNIK})(?!\p{Lu})))`,
  'uy',
);
// Dopisek małą literą sklejony z etykietą w nieistniejącą nazwę — JEDNO słowo (albo „i”/„oraz”
// + jedno słowo) w tym samym wierszu, zaraz po nim koniec zdania, wiersza, napisu albo znacznika:
// „→ Włączone funkcje sklepu.”, „**Ustawienia → Firma** i logo”. Zdanie, które toczy się dalej, przechodzi:
// „→ Allegro tego kanału.” (dwa słowa), „→ Firma uzupełnij NIP” (dalej słowo), „→ KSeF sprawdź, czy…” (po słowie
// przecinek, „;” albo „:” — zdanie biegnie dalej), „→ Fakturownia ponownie.” (słowo zdania, nie nazwy: krótka lista
// przysłówków z tekstów repo). Ozdoba zamykająca („**”, „</a>”) nie zwalnia z tego sprawdzenia.
const SLOWA_ZDANIA = ['ponownie', 'jeszcze', 'też', 'także', 'teraz', 'potem', 'najpierw', 'wcześniej', 'ręcznie'];
const DOPISEK = new RegExp(
  String.raw`${OZDOBY_PO}[ \t]+(?:(?:i|oraz)[ \t]+)?(?!(?:${SLOWA_ZDANIA.join('|')})(?![\p{L}\p{N}]))` +
    String.raw`\p{Ll}[\p{L}\p{N}-]*${OZDOBY_PO}(?:$|[ \t]*\n|[.!?…)\]”"'\x60<])`,
  'uy',
);
// Wszystkie etykiety menu: zakładka, po której stoi dalszy ciąg innej etykiety („Kopie zapasowe → Historia logowań”
// — „Historia logowań” jest w Zespół i dostęp), to pomyłka działu, choć dopisek jest z małej litery.
const KAZDA_ZAKLADKA = dopasowanie(wzorListy([...ZAKLADKI.values()].flat()));
const KAZDA_ETYKIETA = dopasowanie(wzorListy([...ZAKLADKI.keys(), ...[...ZAKLADKI.values()].flat()]));
// Elementy ekranu (sekcja, przycisk), do których prowadzi dalszy ciąg ścieżki: menu ich nie ma, ale ekran tak
// („Integracje → ERLI → Metody dostawy”, „Integracje → Poczta wychodząca → Usuń ustawienia poczty”). Klucz = etykieta
// poprzedniego poziomu (zakładka albo nazwa integracji), wartość = napisy z tego ekranu. Każdy napis musi stać
// w widoku tego ekranu (EKRANY_ELEMENTOW, osobny test niżej), więc przemianowany przycisk wyrzuci go z listy,
// a nie zostawi martwego wyjątku. Sekcje „Poczty wychodzącej” to prawdziwe nagłówki <h2> widoku, nie ręczna lista.
const EKRAN_POCZTY = 'src/moduly/ustawienia/widoki/ustawienia-poczta.ejs';
export const naglowkiH2 = (zrodlo) => [...zrodlo.matchAll(/<h2[^>]*>([^<>]+)<\/h2>/g)].map((m) => m[1].trim());
export const ELEMENTY_EKRANU = {
  ERLI: ['Metody dostawy', 'Dodaj konto'],
  Allegro: ['Dodaj konto'],
  WooCommerce: ['Dodaj sklep'],
  DPD: ['Odłącz DPD'],
  InPost: ['Pobranie przy paczkomatach', 'Odłącz InPost'],
  'Pobranie przy paczkomatach': ['Mam umowę z InPostem na przesyłki za pobraniem'],
  'Poczta wychodząca': [
    ...naglowkiH2(fs.readFileSync(path.join(KORZEN, EKRAN_POCZTY), 'utf8')),
    'Usuń ustawienia poczty',
  ],
  'Stany magazynowe': ['Wyłącz stany'],
  'Automaty systemowe': ['Automatyczna wysyłka do KSeF'],
};
// Pliki, w których dany ekran ma te napisy (konfigurator integracji z kroków modułu, reszta z widoku).
export const EKRANY_ELEMENTOW = {
  ERLI: ['src/domena/modul-erli.ts'],
  Allegro: ['src/domena/modul-allegro.ts'],
  WooCommerce: ['src/domena/modul-woo.ts'],
  DPD: ['src/moduly/wysylka/widoki/ustawienia-dpd.ejs'],
  InPost: ['src/moduly/wysylka/widoki/ustawienia-inpost.ejs'],
  'Pobranie przy paczkomatach': ['src/moduly/wysylka/widoki/ustawienia-inpost.ejs'],
  'Poczta wychodząca': [EKRAN_POCZTY],
  'Stany magazynowe': ['src/moduly/ustawienia/widoki/ustawienia-magazyn.ejs'],
  'Automaty systemowe': ['src/moduly/faktury/widoki/_automat-ksef.ejs'],
};
const WSZYSTKIE_ELEMENTY = Object.values(ELEMENTY_EKRANU).flat();
const WSZYSTKIE_ETYKIETY = [...ZAKLADKI.keys(), ...[...ZAKLADKI.values()].flat(), ...WSZYSTKIE_ELEMENTY];
const ELEMENTY = new Map(Object.entries(ELEMENTY_EKRANU).map(([e, lista]) => [e, dopasowanie(wzorListy(lista))]));
const TRZECI_POZIOM = dopasowanie(wzorListy(INTEGRACJE));
const TRZECI_POZIOM_I_ELEMENTY = dopasowanie(wzorListy([...INTEGRACJE, ...WSZYSTKIE_ELEMENTY]));
const KAZDY_ELEMENT = dopasowanie(wzorListy(WSZYSTKIE_ELEMENTY));
// Na poziomie ≥ 3 słowo małą literą („→ połącz kanał”, „→ kliknij”) to polecenie, nie pozycja — kończy ścieżkę.
const POLECENIE = new RegExp(String.raw`${OZDOBY}\p{Ll}`, 'uy');
// Dział bez przedrostka („Otwórz Integracje → Reklamy”): ten sam wymóg dla B. Pomijamy dział, przed którym stoi
// strzałka — to część ścieżki „Ustawienia → …”, sprawdzanej wyżej.
const GOLY_DZIAL = new RegExp(
  String.raw`(?<!${STRZALKA_PRZED}${OZDOBY})(?<![\p{L}\p{N}])(${wzorListy([...ZAKLADKI.keys()])})${OZDOBY_PO}${STRZALKA}`,
  'gu',
);

const sciezkaDoRaportu = (tekst, od) =>
  `Ustawienia → ${tekst
    .slice(od, od + 70)
    .replace(/\s+/g, ' ')
    .trim()}`;
const kanoniczna = (lista, etykieta) => lista.find((e) => new RegExp(`^${wzorEtykiety(e)}$`, 'u').test(etykieta));
const NIEZNANA = Symbol('wstawka');

function dopasuj(wzor, tekst, od) {
  wzor.lastIndex = od;
  const m = wzor.exec(tekst);
  if (!m) return null;
  return { wstawka: Boolean(m[1]), etykieta: m[2]?.replace(/\s+/g, ' '), koniec: wzor.lastIndex };
}

function dobryKoniec(tekst, od) {
  DOPISEK.lastIndex = od;
  if (DOPISEK.test(tekst)) return false;
  KONIEC_ETYKIETY.lastIndex = od;
  return KONIEC_ETYKIETY.test(tekst);
}

/**
 * Wzór etykiet dozwolonych na danym poziomie ścieżki albo null, gdy menu ani ekran takiego poziomu nie mają.
 * `poprzednia` = kanoniczna etykieta poprzedniego poziomu (NIEZNANA po wstawce).
 */
function kandydaci(poziom, dzial, poprzednia) {
  if (poziom === 1) return DZIAL;
  if (poziom === 2) return dzial === NIEZNANA ? KAZDA_ZAKLADKA : ZAKLADKA.get(dzial);
  if (poprzednia === NIEZNANA) return poziom === 3 ? TRZECI_POZIOM_I_ELEMENTY : KAZDY_ELEMENT;
  if (
    poziom === 3 &&
    (dzial === NIEZNANA || dzial === DZIAL_INTEGRACJE.etykieta) &&
    ZAKLADKI_Z_INTEGRACJAMI.includes(poprzednia)
  )
    return TRZECI_POZIOM;
  return ELEMENTY.get(poprzednia) ?? null;
}

/**
 * Ścieżka od pozycji `od` (poziom 1 = dział; dla gołego działu poziom 2 ze znanym działem) wskazuje pozycje z menu.
 * Każdy kolejny poziom po „→” jest sprawdzany, także po wstawce; po ostatniej etykiecie — koniec bez dopisku.
 */
function sciezkaDobra(tekst, od, poziomStart, dzialStart) {
  let poziom = poziomStart;
  let dzial = dzialStart;
  let poprzednia = dzialStart;
  let poz = od;
  for (;;) {
    if (poziom >= 3) {
      POLECENIE.lastIndex = poz;
      if (POLECENIE.test(tekst)) return true;
    }
    const wzor = kandydaci(poziom, dzial, poprzednia);
    if (!wzor) return false;
    const e = dopasuj(wzor, tekst, poz);
    if (!e) return false;
    if (!e.wstawka && poziom > 1) {
      const dluzsza = dopasuj(KAZDA_ETYKIETA, tekst, poz);
      if (dluzsza && !dluzsza.wstawka && dluzsza.koniec > e.koniec) return false;
    }
    poprzednia = e.wstawka ? NIEZNANA : kanoniczna(WSZYSTKIE_ETYKIETY, e.etykieta);
    if (poziom === 1) dzial = poprzednia;
    DALEJ.lastIndex = e.koniec;
    if (!DALEJ.exec(tekst)) return e.wstawka || dobryKoniec(tekst, e.koniec);
    poz = DALEJ.lastIndex;
    poziom += 1;
  }
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
    const dalej = tekst
      .slice(od, od + 80)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(\*\*?|„|")/, '');
    if (WYJATKI.some(([poczatek]) => dalej.startsWith(poczatek))) {
      wynik.wyjatki += 1;
      continue;
    }
    wynik.sprawdzone += 1;
    if (!sciezkaDobra(tekst, od, 1, null)) wynik.naruszenia.push({ linia, sciezka: sciezkaDoRaportu(tekst, od) });
  }
  for (const m of tekst.matchAll(GOLY_DZIAL)) {
    wynik.sprawdzone += 1;
    const od = m.index + m[0].length;
    if (!sciezkaDobra(tekst, od, 2, kanoniczna([...ZAKLADKI.keys()], m[1].replace(/\s+/g, ' ')))) {
      wynik.naruszenia.push({
        linia: tekst.slice(0, m.index).split('\n').length,
        sciezka: `${m[1].replace(/\s+/g, ' ')} → ${tekst
          .slice(od, od + 60)
          .replace(/\s+/g, ' ')
          .trim()}`,
      });
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

const wzgledna = (p) => path.relative(KORZEN, p).split(path.sep).join('/');
const KONFIGURACJA = 'docs/konfiguracja.json';

// Grupy plików z własnym progiem: zgubiony skan jednej grupy (zła ścieżka katalogu, zepsute wycinanie) nie może
// przejść po cichu, bo reszta repo i tak przekracza próg ogólny. Progi z zapasem w dół (ok. połowa pomiaru:
// ogółem 391 — src 132, docs 133, konfiguracja.json 80, scripts 31, deploy 12 (w tym config.przyklad.json 1, aktualizuj.sh 7), .env.example 3; z wiersza
// „stan skanu” w teście niżej), ale każdy > 0: skaner, który w grupie nic nie widzi, pada.
// Dwa pliki deploy/ mają własny próg: przykład konfiguracji drukarki (JSON) i skrypt powłoki, bo ich rodzaje
// (.json, .sh) skanuje osobna gałąź tekstDoSkanu — zgubiona gałąź nie może zniknąć w sumie grupy deploy.
const PLIKI_Z_PROGIEM = {
  'deploy/drukarka/config.przyklad.json': 'drukarka-json',
  'deploy/klient/aktualizuj.sh': 'aktualizuj-sh',
};
const PROGI = {
  src: 65,
  docs: 65,
  konfiguracja: 40,
  scripts: 15,
  deploy: 2,
  env: 1,
  'drukarka-json': 1,
  'aktualizuj-sh': 1,
};
const OGOLEM_MIN = 195;

// Znane rozbieżności tekstu z ekranem, do poprawienia w tekście (nie w teście): sekcja Poczty wychodzącej ma
// nagłówek „Adres OMS-u w mailach”, a te teksty nazywają ją „Adres panelu”. Wpis znika razem z poprawką tekstu.
const ROZBIEZNE_Z_EKRANEM = [
  ['docs/instalacja-docker.md', 'Ustawienia → Integracje → Poczta wychodząca → Adres panelu'],
  ['docs/zmienne.md', 'Ustawienia → Integracje → Poczta wychodząca → Adres panelu'],
  ['docs/konfiguracja.json', 'Ustawienia → Integracje → Poczta wychodząca → Adres panelu'],
  ['scripts/zmienne-panel.mjs', 'Integracje → Poczta wychodząca → Adres panelu'],
];

function grupa(p) {
  const w = wzgledna(p);
  if (w === KONFIGURACJA) return 'konfiguracja';
  if (w === '.env.example') return 'env';
  if (PLIKI_Z_PROGIEM[w]) return PLIKI_Z_PROGIEM[w];
  return w.split('/')[0];
}

function plikiDoSkanu() {
  const src = pliki(path.join(KORZEN, 'src'), (p) => KOD.has(path.extname(p)));
  const docs = pliki(
    path.join(KORZEN, 'docs'),
    (p, nazwa) =>
      nazwa.endsWith('.md') &&
      !nazwa.startsWith('prz') &&
      !POMIJANE_DOKUMENTY.has(wzgledna(p)) &&
      !/^docs\/(plany|archiwum)\//.test(wzgledna(p)),
  );
  // scripts/ — napisy wypisywane na ekran i wpisywane do dokumentów (zmienne-tabela.mjs → docs/zmienne.md).
  // Pomijamy jednorazowe skrypty zadań (prz*, mutacje-*): cytują stare teksty i celowo zepsute wersje.
  const scripts = pliki(
    path.join(KORZEN, 'scripts'),
    (p, nazwa) =>
      /\.(?:m?js|ts|sh)$/.test(nazwa) && !/^(?:prz|mutacje-)/.test(nazwa) && !wzgledna(p).startsWith('scripts/testy/'),
  );
  // Instrukcje instalacji czyta obcy sprzedawca tak samo jak docs/; także skrypty
  // i przykładowe pliki konfiguracji w deploy/ (echo na ekran, zdania wpisywane do produkcja.env).
  const deploy = [
    ...pliki(path.join(KORZEN, 'deploy'), (p, nazwa) => /\.(?:md|json|sh|mjs)$/.test(nazwa)),
    ...pliki(
      path.join(KORZEN, 'deploy/klient'),
      (p, nazwa) => /\.ya?ml$/.test(nazwa) && path.dirname(p) === path.join(KORZEN, 'deploy/klient'),
    ),
    path.join(KORZEN, '.env.example'),
  ];
  return [...src, ...docs, path.join(KORZEN, KONFIGURACJA), ...scripts, ...deploy];
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
      // Odmienione formy, po jednym dobrym przypadku na każdą
      'Dane wpiszesz z Ustawień → Firma.', // „z Ustawień →”
      'Zarządzasz Ustawieniami → Zespół i dostęp → Użytkownicy.', // „Ustawieniami →”
      'Rachunek w Ustawienia -> Firma -> Rachunek bankowy.', // „->”
      'KSeF w Ustawienia > Faktury i podatki > KSeF.', // „ > ”
      'Konto w Ustawienia » Integracje » Moje połączenia » Allegro.', // „»”
      'Klucz z Ustawienia -> Zespol i dostep -> Klucze API, zakres druk.', // ASCII bez ogonków (deploy/drukarka)
      'Dodaj w Ustawienia → Integracje → Dodaj integrację → GUS.', // trzeci poziom z menu
      'Otwórz Integracje -> Moje połączenia, a potem kartę konta.', // goły dział ze strzałką ASCII
      'Moduł włączysz w Ustawieniach → System → Włączone funkcje, sekcja Koszty.', // zdanie toczy się dalej
      'W Ustawieniach → System → Włączone funkcje włączysz moduł kosztów.', // więcej niż jedno słowo po etykiecie
      'Otwórz **Ustawienia → Integracje → Fakturownia** i kliknij **Sprawdziłem**.', // „**” + zdanie dalej
      '**Ustawienia → Firma** — dane i logo.', // „**” + myślnik
      'Wróć do Ustawienia → ${dzial} → Stany magazynowe.', // po wstawce dobra zakładka
      'Wróć do Ustawienia → <%= dzial %> → Klucze API.', // po wstawce EJS dobra zakładka
      'Wróć do Ustawienia → Integracje → ${zakladka} → ERLI.', // po wstawce dobra integracja z katalogu
      'Wróć do Ustawienia → Integracje → ${zakladka} → KSeF.', // po wstawce dobra integracja z katalogu
      'Wróć do Ustawienia → Integracje → ${zakladka} → ERLI → Metody dostawy.', // po wstawce integracja i jej element
      'Ustawienia → Faktury i podatki → KSeF → sprawdź połączenie.', // trzeci poziom małą literą = polecenie
      'Wróć do Ustawienia → Integracje → ${zakladka} → inFakt.', // po wstawce dobra integracja
      'if (Ustawienia => 1) x();', // „=>” w kodzie to nie strzałka
      'Połącz ponownie w Ustawieniach → Integracje → Fakturownia ponownie.', // słowo zdania, nie dopisek
      'W Ustawieniach → Faktury i podatki → KSeF sprawdź, czy token działa.', // po słowie przecinek — zdanie dalej
      'Ustawienia → Integracje → ERLI → Metody dostawy.', // element ekranu integracji
      'Ustawienia → Integracje → Dodaj integrację → Allegro → „Dodaj konto”.', // element na czwartym poziomie
      'Ustawienia → Integracje → InPost → Pobranie przy paczkomatach → Mam umowę z InPostem na przesyłki za pobraniem.', // element w elemencie
      'Ustawienia → Integracje → Poczta wychodząca → Usuń ustawienia poczty.', // element ekranu zakładki
      'Ustawienia → Integracje → Poczta wychodząca → Podpis maili.', // sekcja z nagłówka <h2> widoku
      'Ustawienia → Integracje → Allegro → połącz kanał z kontem.', // mała litera na poziomie ≥ 3 = polecenie
      'Wróć do Ustawienia → ${dzial} → ${zakladka} → Wyłącz stany.', // po wstawce znany element
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
      'Wpisz w Ustawienia → Integracje → Poczta wychodząca → Podpis wiadomości.',
      'Wpisz w Ustawienia → Integracje → Poczta wychodząca → Adres OMS-u.', // nagłówek brzmi „Adres OMS-u w mailach”
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
      // Odmienione formy, po jednym złym przypadku na każdą
      'włącz je z Ustawień → Magazyn.', // M05a
      'Zarządzasz Ustawieniami → Konta.', // „Ustawieniami →”
      'włącz je w Ustawieniach -> Magazyn.', // M05b
      'włącz je w Ustawieniach > Magazyn.', // M05e
      'włącz je w Ustawieniach » Magazyn.', // „»”
      'w Ustawieniach → Zamówienia i magazyn → Stany magazynowe → Progi alarmowe.', // M05c — trzeci poziom spoza menu
      'Ustawienia → Integracje → Moje połączenia → Sklep.', // trzeci poziom: nie nazwa integracji
      'Ustawienia → Integracje → Moje połączenia → ERLI → Klucz.', // czwarty poziom
      'z Ustawień → Zamówienia i magazyn → Magazyn.', // M05d — dobry dział, zła zakładka
      'Otwórz Integracje -> Reklamy.', // goły dział ze strzałką ASCII
      'włączysz go w Ustawieniach → System → Włączone funkcje sklepu.', // M14
      '<a href="/ustawienia/moduly">Ustawienia → System → Włączone funkcje sklepu</a>', // M14 przed znacznikiem
      '**Ustawienia → Firma** i logo', // „**” nie zwalnia z dopisku
      'Wróć do Ustawienia → ${dzial} → Magazyn.', // po wstawce zła zakładka
      'Wróć do Ustawienia → <%= dzial %> → Magazyn.', // po wstawce EJS zła zakładka
      'Wróć do Ustawienia → Integracje → ${zakladka} → Klucz.', // po wstawce trzeci poziom spoza menu
      'Wróć do Ustawienia → Integracje → ${zakladka} → ERLI → Klucz.', // po wstawce dobra integracja, zły element
      'Wróć do Ustawienia → Integracje → ${zakladka} → KSeF → Metody dostawy.', // element innej integracji
      'Ustawienia → Faktury i podatki → KSeF → Sprawdź połączenie.', // trzeci poziom wielką literą = nieistniejąca pozycja
      'Ustawienia → Faktury i podatki → Program do faktur → Wysyłka do KSeF.', // B4b — zakładka bez takiego elementu
      'Ustawienia → Integracje → DPD → Dodaj konto.', // element z innego ekranu
      'Ustawienia → Integracje → ERLI → Metody dostawy → Kurier.', // poziom dalej niż ekran
    ];
    const zgloszone = (zdanie) => sprawdzSciezki(zdanie).naruszenia.map((n) => n.sciezka);
    for (const zdanie of dobre) expect(zgloszone(zdanie), zdanie).toEqual([]);
    for (const zdanie of zle) expect(zgloszone(zdanie), zdanie).toHaveLength(1);
    expect(sprawdzSciezki('a\nb Ustawienia → Moduły').naruszenia).toEqual([
      { linia: 2, sciezka: 'Ustawienia → Moduły' },
    ]);
    expect(sprawdzSciezki('Klucz z Ustawienia → API.').wyjatki).toBe(1);
    expect(sprawdzSciezki('Ustawienia → Integracje i dodatki → KSeF w Fakturowni.').wyjatki).toBe(1);
    // gałąź .env/.yaml: „#” zamazany na spację, więc „i …” w następnym wierszu ma wcięcie
    expect(sprawdzSciezki(tekstDoSkanu('.env.example', '# Ustawienia → System\n# i moduły.')).naruszenia).toHaveLength(
      1,
    );
  });

  it('pliki .json i .sh — ucieczki w napisie JSON, cały skrypt powłoki', () => {
    const json = '{\n  "skutekBraku": "Wysyłkę włączysz w Ustawienia → Program do faktur → Wysyłka do KSeF."\n}';
    expect(sprawdzSciezki(tekstDoSkanu('docs/konfiguracja.json', json)).naruszenia.map((n) => n.linia)).toEqual([2]);
    const jsonDobry = '{ "opis": "Wpisz w \\"Ustawienia → Firma\\"\\nDane z panelu wygrywają." }';
    const wynik = sprawdzSciezki(tekstDoSkanu('x.json', jsonDobry));
    expect(wynik.naruszenia).toEqual([]);
    expect(wynik.sprawdzone).toBe(1);
    const sh = '# wpisz w panelu (Ustawienia → Firma)\necho "albo w panelu (Ustawienia → Magazyn)"';
    expect(sprawdzSciezki(tekstDoSkanu('deploy/klient/x.sh', sh)).naruszenia.map((n) => n.linia)).toEqual([2]);
  });

  it('elementy ekranu z ELEMENTY_EKRANU stoją w widoku swojego ekranu (lista nie butwieje)', () => {
    expect(Object.keys(EKRANY_ELEMENTOW).sort(), 'każdy klucz ELEMENTY_EKRANU ma plik ekranu').toEqual(
      Object.keys(ELEMENTY_EKRANU).sort(),
    );
    const brak = [];
    for (const [klucz, elementy] of Object.entries(ELEMENTY_EKRANU)) {
      const tekst = EKRANY_ELEMENTOW[klucz]
        .map((plik) => tekstDoSkanu(plik, fs.readFileSync(path.join(KORZEN, plik), 'utf8')))
        .join('\n');
      for (const e of elementy) if (!tekst.includes(e)) brak.push(`${klucz} → ${e}`);
    }
    expect(brak, 'element, którego nie ma w widoku swojego ekranu — usuń go z ELEMENTY_EKRANU').toEqual([]);
  });

  it('sekcje Poczty wychodzącej pochodzą z nagłówków <h2> widoku', () => {
    const zrodlo = fs.readFileSync(path.join(KORZEN, EKRAN_POCZTY), 'utf8');
    expect(naglowkiH2('<h2>A</h2><h2 class="x">B c</h2><h2><%= x %></h2>')).toEqual(['A', 'B c']);
    for (const h of naglowkiH2(zrodlo).filter((t) => !t.includes('<%')))
      expect(ELEMENTY_EKRANU['Poczta wychodząca']).toContain(h);
    expect(zrodlo).toContain('<h2>Serwer poczty</h2>');
    expect(sprawdzSciezki('Ustawienia → Integracje → Poczta wychodząca → Serwer poczty.').naruszenia).toEqual([]);
  });

  it('w komentarzu kodu ścieżka nie jest sprawdzana, w napisie jest', () => {
    const js = "// Ustawienia → Moduły\nconst t = 'Ustawienia → Moduły';";
    expect(sprawdzSciezki(tekstDoSkanu('x.js', js)).naruszenia.map((n) => n.linia)).toEqual([2]);
    const ejs = '<%# Ustawienia → Moduły %>\n<p>Ustawienia → Moduły</p>';
    expect(sprawdzSciezki(tekstDoSkanu('x.ejs', ejs)).naruszenia.map((n) => n.linia)).toEqual([2]);
  });

  it('każda ścieżka wskazuje dział i zakładkę z menu', () => {
    const naruszenia = [];
    const liczby = Object.fromEntries(Object.keys(PROGI).map((g) => [g, 0]));
    let sprawdzone = 0;
    for (const plik of plikiDoSkanu()) {
      const wynik = sprawdzSciezki(tekstDoSkanu(plik, fs.readFileSync(plik, 'utf8')));
      sprawdzone += wynik.sprawdzone;
      liczby[grupa(plik)] += wynik.sprawdzone;
      for (const n of wynik.naruszenia) {
        if (!ROZBIEZNE_Z_EKRANEM.some(([f, poczatek]) => f === wzgledna(plik) && n.sciezka.startsWith(poczatek)))
          naruszenia.push(`${wzgledna(plik)}:${n.linia}: ${n.sciezka}`);
      }
    }
    expect(naruszenia, `ścieżki do pozycji, których nie ma w menu Ustawień:\n${naruszenia.join('\n')}`).toEqual([]);
    // kontrola skanera: inaczej pusty skan dałby zieleń; osobno każda grupa (stan skanu w komunikacie)
    const stan = `stan skanu: ogółem ${sprawdzone}, ${JSON.stringify(liczby)}`;
    expect(sprawdzone, stan).toBeGreaterThanOrEqual(OGOLEM_MIN);
    for (const [g, min] of Object.entries(PROGI)) expect(liczby[g], `${g} — ${stan}`).toBeGreaterThanOrEqual(min);
  });
});
