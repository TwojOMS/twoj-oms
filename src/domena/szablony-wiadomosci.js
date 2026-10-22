import { rozbijNazwe } from './z-panelu/nazwa-osoby.js';
import { adresOdbiorcy } from './adres-odbiorcy.js';
import { firmaNabywcy } from './dane-faktury.js';
import { dzienWarszawa } from './format-daty.js';
import { nazwaDostawy } from './wysylka.js';
import { wierszePozycji } from './tabela-pozycji.js';
import { zlotowki } from './kwoty.js';
import { DOMYSLNE_ZDANIA } from './zdania-platnosci.js';

// SZABLONY WIADOMOŚCI DO KUPUJĄCEGO (PRZ-101.03, zlecenie właściciela 18.10.2026: „maile są na stałe,
// przydałaby się możliwość edycji treści oraz tworzenia nowych szablonów").
//
// Moduł czysty: zna pola, bloki, domyślne treści i reguły zapisu; niczego nie czyta z bazy i nie wysyła.
//
// Jak działa szablon:
//   • POLE `{nazwa}` wstawia krótki napis w środek zdania (numer zamówienia, imię, kwota);
//   • BLOK `{nazwa}` stoi SAM w linii i wstawia sekcję policzoną przez kod (pozycje, dane do przelewu) —
//     w HTML-u tę samą tabelę co dziś, w wersji tekstowej te same linie co dziś;
//   • akapity rozdziela pusta linia; akapit tuż nad blokiem `{podpis}` dostaje w HTML-u kreskę nad sobą
//     (dzisiejsze zdanie zamykające).
//
// ⚠️ BRAK ZAPISANEGO SZABLONU = DZISIEJSZY MAIL CO DO ZNAKU. Usługi w takim wypadku idą starą drogą
// (jakoTekst / renderPotwierdzenieHtml / jakoTekstWiadomosci / renderWiadomoscHtml), a domyślne treści
// niżej są ich zapisem w języku szablonu — test porównuje jedno z drugim na kilku zamówieniach
// (tests/moduly/wiadomosci/szablony-rownosc.test.js), więc edycja zaczyna się od tego, co dziś wychodzi.

export const KLUCZ_USTAWIEN = 'szablony.wiadomosci';

export const MAKS = Object.freeze({ wlasnych: 30, nazwa: 60, temat: 200, tresc: 4000 });

/**
 * Szablony wbudowane — te same tematy, co na karcie zamówienia.
 * PRZ-102.21: `wyslane` („Zamówienie wysłane") — ręcznie z karty albo regułą z Ustawienia → Automatyzacje
 * (PRZ-108.08; reguła z tym szablonem wymusza warunek „ma numer listu”). Zapis w tym samym kluczu ustawień co reszta — bez migracji.
 */
export const WBUDOWANE = Object.freeze(['potwierdzenie', 'proforma', 'faktura', 'przypomnienie', 'wyslane']);
export const PLATNICZE = Object.freeze(['proforma', 'faktura', 'przypomnienie']);

/**
 * PRZ-101.06: maile do ZESPOŁU (pracownika), nie do klienta — zaproszenie do panelu i link do nowego hasła
 * (moduly/ustawienia/poczta-kont.js). Wspólny rodzaj „konto": pola konta, bez pól zamówienia i bez podpisu.
 */
export const KONTA = Object.freeze(['zaproszenie', 'reset']);
const WSZYSTKIE_WBUDOWANE = [...WBUDOWANE, ...KONTA];

export const NAZWA_WBUDOWANEGO = Object.freeze({
  potwierdzenie: 'Potwierdzenie przyjęcia zamówienia',
  proforma: 'Proforma',
  faktura: 'Faktura',
  przypomnienie: 'Przypomnienie o płatności',
  wyslane: 'Zamówienie wysłane',
  zaproszenie: 'Zaproszenie pracownika',
  reset: 'Reset hasła pracownika',
});

const WSZYSTKIE = ['potwierdzenie', 'proforma', 'faktura', 'przypomnienie', 'wyslane', 'wlasny'];

/**
 * Pola i bloki. `w` = w jakich szablonach działa. Kolejność = kolejność na liście pod edytorem.
 * ⚠️ Pola płatnicze (`dane_platnosci`, `zamkniecie`, `numer_dokumentu`) nie działają w szablonach własnych:
 * szablon własny nie ma dokumentu ani stanu płatności, więc kwoty do przelewu nie miałby skąd wziąć.
 */
export const POLA = Object.freeze([
  { nazwa: 'numer_zamowienia', opis: 'Numer zamówienia.', w: WSZYSTKIE },
  { nazwa: 'data_zamowienia', opis: 'Dzień złożenia zamówienia (RRRR-MM-DD).', w: WSZYSTKIE },
  { nazwa: 'imie', opis: 'Imię kupującego z adresu dostawy. Gdy go nie ma, pole znika razem z odstępem przed przecinkiem: „Dzień dobry {imie}," daje „Dzień dobry,"; w „Dzień dobry, {imie}!" znika też wykrzyknik („Dzień dobry,").',
    opisy: { konto: 'Imię pracownika z jego konta (Ustawienia → Użytkownicy).' }, w: [...WSZYSTKIE, 'konto'] },
  // PRZ-101.06: pola maili do zespołu. Link idzie tylko do pracownika — nigdy do logu ani na ekran podglądu.
  { nazwa: 'link', wymagane: ['konto'], powodWymogu: 'bez linku pracownik nie ustawi hasła i nie wejdzie do panelu',
    opis: 'Jednorazowy link do ustawienia hasła. Obowiązkowe — bez niego pracownik nie wejdzie do panelu.', w: ['konto'] },
  { nazwa: 'waznosc', opis: 'Jak długo działa link, np. „48 h".', w: ['konto'] },
  { nazwa: 'kupujacy', opis: 'Imię i nazwisko kupującego z adresu dostawy; przy zamówieniu firmy bez osoby — nazwa firmy.', w: WSZYSTKIE },
  { nazwa: 'kwota', opis: 'Wartość zamówienia brutto (nie kwota do zapłaty) — ta sama suma, co na karcie, także po wpłatach.', w: WSZYSTKIE },
  // Recenzja 18.10: po wpłacie częściowej {kwota} dalej pokazuje całość — przypomnienie „prosimy o dopłatę {kwota}"
  // żądałoby za dużo. {do_zaplaty} to ta sama liczba, co w sekcji DO ZAPŁATY.
  { nazwa: 'do_zaplaty', opis: 'Kwota do zapłaty brutto — po wpłatach częściowych sama reszta, ta sama co w sekcji DO ZAPŁATY. Puste, gdy nie ma czego przelewać (pobranie, opłacone, brak rachunku).', w: PLATNICZE },
  { nazwa: 'metoda_wysylki', opis: 'Sposób dostawy, np. „Kurier DPD".', w: WSZYSTKIE },
  { nazwa: 'numer_przesylki', opis: 'Numer listu przewozowego (kilka paczek — po przecinku; puste przed nadaniem).', w: WSZYSTKIE },
  { nazwa: 'nazwa_firmy', opis: 'Marka z podpisu maili (Ustawienia → Integracje → Poczta wychodząca → Podpis maili albo OMS_MAIL_MARKA w pliku konfiguracji; bez niej „Obsługa sklepu").', w: WSZYSTKIE },
  { nazwa: 'numer_dokumentu', opis: 'Numer proformy albo faktury, której dotyczy mail.', w: PLATNICZE },
  { nazwa: 'zamkniecie', wymagane: PLATNICZE, powodWymogu: 'przy pobraniu to zdanie mówi, że należność pobierze kurier — bez niego klient może zapłacić dwa razy',
    opis: 'Zdanie zamykające liczone ze stanu płatności — przy pobraniu mówi, że płaci się kurierowi, przy opłaconym dziękuje. Obowiązkowe w mailach o płatności. Treść zdań zmienisz niżej w sekcji Zdania o płatności.', w: PLATNICZE },
  { nazwa: 'pozycje', blok: true, opis: 'Sekcja ZAMÓWIENIE: tabela pozycji z ilością, ceną i sumą brutto.', w: ['potwierdzenie', 'wlasny'] },
  { nazwa: 'sposob_platnosci', blok: true, opis: 'Sekcja PŁATNOŚĆ: metoda płatności i termin (przy pobraniu kwota dla kuriera).', w: ['potwierdzenie'] },
  { nazwa: 'wysylka', blok: true, opis: 'Sekcja WYSYŁKA: sposób dostawy i adres.', w: ['potwierdzenie', 'wlasny'] },
  { nazwa: 'dane_do_faktury', blok: true, opis: 'Sekcja FAKTURA: czy klient chce fakturę i na jakie dane.', w: ['potwierdzenie', 'wlasny'] },
  // PRZ-102.21: bez numeru listu mail „zostało wysłane" nie daje klientowi niczego, czym sprawdzi paczkę.
  { nazwa: 'przesylki', blok: true, wymagane: ['wyslane'], powodWymogu: 'bez numeru listu klient nie sprawdzi, gdzie jest paczka',
    opis: 'Sekcja PRZESYŁKA: przewoźnik, numer listu i link do śledzenia każdej nadanej paczki (link, gdy panel zna stronę śledzenia przewoźnika), a przy odbiorze w punkcie — punkt. Obowiązkowe w tym mailu.', w: ['wyslane'] },
  { nazwa: 'dane_platnosci', blok: true, wymagane: PLATNICZE, powodWymogu: 'kwota, rachunek, tytuł przelewu', opis: 'Sekcje DO ZAPŁATY i PRZELEW (kwota, odbiorca, rachunek, tytuł, termin) oraz zdania o załącznikach. Obowiązkowe w mailach o płatności. Treść zdań zmienisz niżej w sekcji Zdania o płatności.', w: PLATNICZE },
  { nazwa: 'podpis', blok: true, opis: '„Pozdrawiamy," i marka. Akapit tuż nad nim dostaje w mailu kreskę oddzielającą. Słowo „Pozdrawiamy," ustawisz na liście szablonów, w części Etykiety i stałe teksty.', w: WSZYSTKIE },
]);

const POLE = new Map(POLA.map((p) => [p.nazwa, p]));

/** Lista pól dostępnych w danym szablonie — do pokazania pod edytorem. */
export function polaSzablonu(rodzaj) {
  return POLA.filter((p) => p.w.includes(rodzaj))
    .map((p) => ({ nazwa: p.nazwa, opis: p.opisy?.[rodzaj] ?? p.opis, blok: Boolean(p.blok), wymagane: Boolean(p.wymagane?.includes(rodzaj)) }));
}

/** Rodzaj szablonu po identyfikatorze: maile do klienta mają własny, maile do zespołu wspólny „konto", reszta „wlasny". */
export const rodzajSzablonu = (id) => (KONTA.includes(id) ? 'konto' : WBUDOWANE.includes(id) ? id : 'wlasny');

// Treści domyślne — zapis DZISIEJSZYCH maili (potwierdzenie-zamowienia.js: jakoTekst; wiadomosc-platnicza.js:
// TEMAT_MAILA, WIODACE, jakoTekstWiadomosci). Zmiana tutaj bez zmiany tamtych = czerwony test równości.
export const DOMYSLNE = Object.freeze({
  potwierdzenie: Object.freeze({
    temat: 'Potwierdzenie przyjęcia zamówienia nr {numer_zamowienia}',
    tresc: [
      'Dzień dobry,', '',
      'potwierdzamy przyjęcie zamówienia nr {numer_zamowienia} z dnia {data_zamowienia}.', '',
      '{pozycje}', '', '{sposob_platnosci}', '', '{wysylka}', '', '{dane_do_faktury}', '',
      'Jeśli coś się nie zgadza, wystarczy odpowiedzieć na tego maila.', '',
      '{podpis}',
    ].join('\n'),
  }),
  proforma: Object.freeze({
    temat: 'Proforma {numer_dokumentu} — zamówienie nr {numer_zamowienia}',
    tresc: [
      'Dzień dobry,', '',
      'w załączeniu przesyłamy proformę {numer_dokumentu} do zamówienia nr {numer_zamowienia}.', '',
      '{dane_platnosci}', '', '{zamkniecie}', '', '{podpis}',
    ].join('\n'),
  }),
  faktura: Object.freeze({
    temat: 'Faktura {numer_dokumentu} — zamówienie nr {numer_zamowienia}',
    tresc: [
      'Dzień dobry,', '',
      'w załączeniu przesyłamy fakturę {numer_dokumentu} do zamówienia nr {numer_zamowienia}.', '',
      '{dane_platnosci}', '', '{zamkniecie}', '', '{podpis}',
    ].join('\n'),
  }),
  przypomnienie: Object.freeze({
    temat: 'Przypomnienie o płatności — zamówienie nr {numer_zamowienia}',
    tresc: [
      'Dzień dobry,', '',
      'przypominamy o płatności za zamówienie nr {numer_zamowienia} z dnia {data_zamowienia}.', '',
      '{dane_platnosci}', '', '{zamkniecie}', '', '{podpis}',
    ].join('\n'),
  }),
  // PRZ-102.21: nowy mail, bez „dzisiejszej" wersji — ta treść JEST mailem, dopóki operator jej nie zmieni.
  wyslane: Object.freeze({
    temat: 'Zamówienie nr {numer_zamowienia} zostało wysłane',
    tresc: [
      'Dzień dobry,', '',
      'Twoje zamówienie nr {numer_zamowienia} zostało wysłane.', '',
      '{przesylki}', '', '{podpis}',
    ].join('\n'),
  }),
  // PRZ-101.06: zapis dzisiejszych maili do pracownika (moduly/ustawienia/poczta-kont.js: TEMATY, trescMaila).
  zaproszenie: Object.freeze({
    temat: 'Zaproszenie do panelu',
    tresc: [
      'Dzień dobry, {imie}!', '',
      'Administrator zaprosił Cię do pracy w systemie obsługi zamówień.', 'Ustaw hasło pod adresem:', '{link}', '',
      'Link działa {waznosc} i tylko raz. Jeśli to nie Ty — zignoruj tę wiadomość.',
    ].join('\n'),
  }),
  reset: Object.freeze({
    temat: 'Ustawienie nowego hasła',
    tresc: [
      'Dzień dobry, {imie}!', '',
      'Administrator przygotował link do ustawienia nowego hasła w systemie obsługi zamówień.', 'Ustaw hasło pod adresem:', '{link}', '',
      'Link działa {waznosc} i tylko raz. Jeśli to nie Ty — zignoruj tę wiadomość.',
    ].join('\n'),
  }),
});

/** Punkt wyjścia nowego szablonu własnego — zwykły list z podpisem, bez treści za operatora. */
export const NOWY_WLASNY = Object.freeze({
  nazwa: '',
  temat: 'Zamówienie nr {numer_zamowienia}',
  tresc: ['Dzień dobry,', '', '', '', '{podpis}'].join('\n'),
});

// Wszystko w klamrach jest kandydatem na pole — także `{Imię}` czy `{ }`: lepiej odmówić zapisu z nazwą,
// niż wysłać klientowi dosłowne „{Imię}".
const RE_POLE = /\{([^{}\n]{0,40})\}/g;

const jedenOdstep = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const O_KLAMRACH = 'Klamry służą tylko do pól z listy pod edytorem, np. {imie} — w zwykłym tekście ich nie używaj.';

/**
 * Pierwsza klamra `{`/`}`, która nie jest częścią znanego pola — jako fragment tekstu wokół niej (do komunikatu) —
 * albo `null`. Znane pole to dokładnie `{nazwa}` z listy POLA; wszystko inne zostałoby w mailu dosłownie.
 */
function zablakanaKlamra(tekst) {
  const pokryte = new Set();
  for (const m of tekst.matchAll(/\{([a-z_]+)\}/g)) {
    if (POLE.has(m[1])) for (let i = m.index; i < m.index + m[0].length; i += 1) pokryte.add(i);
  }
  for (let i = 0; i < tekst.length; i += 1) {
    if ((tekst[i] === '{' || tekst[i] === '}') && !pokryte.has(i)) {
      return jedenOdstep(tekst.slice(Math.max(0, i - 15), i + 25));
    }
  }
  return null;
}

/**
 * Sprawdza szablon przed zapisem. `{ ok: true, szablon }` (przycięte wartości) albo `{ ok: false, blad }`.
 * Odmowa ma nazwać, co poprawić — operator nie zgaduje, które z pól jest „nieznane".
 */
export function sprawdzSzablon(rodzaj, { nazwa, temat, tresc } = {}) {
  const wynik = { temat: jedenOdstep(temat), tresc: String(tresc ?? '').replace(/\r\n?/g, '\n') };
  if (rodzaj === 'wlasny') {
    wynik.nazwa = jedenOdstep(nazwa);
    if (!wynik.nazwa) return { ok: false, blad: 'Podaj nazwę szablonu — po niej wybierasz go na karcie zamówienia.' };
    if (wynik.nazwa.length > MAKS.nazwa) return { ok: false, blad: `Nazwa może mieć najwyżej ${MAKS.nazwa} znaków.` };
  }
  if (!wynik.temat) return { ok: false, blad: 'Temat wiadomości nie może być pusty.' };
  if (wynik.temat.length > MAKS.temat) return { ok: false, blad: `Temat może mieć najwyżej ${MAKS.temat} znaków.` };
  if (!wynik.tresc.trim()) return { ok: false, blad: 'Treść wiadomości nie może być pusta.' };
  if (wynik.tresc.length > MAKS.tresc) return { ok: false, blad: `Treść może mieć najwyżej ${MAKS.tresc} znaków (jest ${wynik.tresc.length}).` };

  const odmowaPola = (gdzie, tekst, wolnoBloki) => {
    for (const [calosc, srodek] of tekst.matchAll(RE_POLE)) {
      const pole = POLE.get(srodek);
      if (!pole) return `Nieznane pole ${calosc} w ${gdzie}. Dostępne pola są wypisane pod edytorem.`;
      if (!pole.w.includes(rodzaj)) return `Pole ${calosc} nie działa w tym szablonie.`;
      if (pole.blok && !wolnoBloki) return `${calosc} to blok — w temacie nie może stać.`;
    }
    return null;
  };
  const wTemacie = odmowaPola('temacie', wynik.temat, false);
  if (wTemacie) return { ok: false, blad: wTemacie };
  const wTresci = odmowaPola('treści', wynik.tresc, true);
  if (wTresci) return { ok: false, blad: wTresci };
  // Każda klamra poza znanym polem — długa („{tu wpisz numer…}"), przez dwie linie, samotna, podwójna — trafiłaby
  // do klienta dosłownie. RE_POLE wyżej łapie tylko krótkie, jednoliniowe; tu domykamy resztę.
  const zablakanaWTemacie = zablakanaKlamra(wynik.temat);
  if (zablakanaWTemacie) return { ok: false, blad: `Klamra w temacie nie tworzy żadnego pola: „${zablakanaWTemacie}". ${O_KLAMRACH}` };
  const zablakanaWTresci = zablakanaKlamra(wynik.tresc);
  if (zablakanaWTresci) return { ok: false, blad: `Klamra w treści nie tworzy żadnego pola: „${zablakanaWTresci}". ${O_KLAMRACH}` };

  // Blok liczy całą sekcję (nagłówek, tabelę) — w środku zdania rozbiłby akapit, więc stoi sam w linii.
  for (const linia of wynik.tresc.split('\n')) {
    for (const [calosc, srodek] of linia.matchAll(RE_POLE)) {
      if (POLE.get(srodek)?.blok && linia.trim() !== calosc) {
        return { ok: false, blad: `Blok ${calosc} musi stać sam w osobnej linii.` };
      }
    }
  }

  // ⚠️ PIENIĄDZE: mail o płatności bez kwoty i rachunku zostawia klienta z pytaniem „ile i dokąd" —
  // albo z przelewem według starej proformy z poczty; bez zdania zamykającego klient przy pobraniu nie dowie się,
  // że płaci kurierowi, i może zapłacić dwa razy. Takiego szablonu nie wolno zapisać.
  // Blok liczy się tylko w osobnej linii (tak go wstawia silnik); pole — gdziekolwiek w treści.
  // Najpierw bloki: brak danych do przelewu jest poważniejszy i to o nim operator ma przeczytać pierwszy.
  for (const pole of POLA.filter((p) => p.wymagane?.includes(rodzaj)).sort((a, b) => Number(Boolean(b.blok)) - Number(Boolean(a.blok)))) {
    const znacznik = `{${pole.nazwa}}`;
    const obecny = pole.blok
      ? wynik.tresc.split('\n').some((l) => l.trim() === znacznik)
      : wynik.tresc.includes(znacznik);
    if (!obecny) {
      return { ok: false, blad: PLATNICZE.includes(rodzaj)
        ? `Ten mail dotyczy pieniędzy — treść musi zawierać ${znacznik} (${pole.powodWymogu}).`
        : `Treść musi zawierać ${znacznik} — ${pole.powodWymogu}.` };
    }
  }
  return { ok: true, szablon: wynik };
}

/** Temat z podstawionymi polami; jeden odstęp, bez znaków nowej linii (nagłówek maila). */
export function zlozTemat(temat, pola = {}) {
  return jedenOdstep(podstaw(String(temat ?? ''), pola));
}

const wartoscPola = (pola, nazwa) => jedenOdstep(Object.hasOwn(pola, nazwa) ? pola[nazwa] : '');

// Pole puste tuż przed znakiem interpunkcji zabiera ze sobą odstęp przed sobą: „Dzień dobry {imie}," przy zamówieniu
// firmy bez imienia daje „Dzień dobry,", a nie „Dzień dobry ,". Wartość podstawiona nie jest skanowana drugi raz.
// PRZ-108.01: gdy puste pole stoi między znakiem interpunkcji przed sobą a znakiem po sobie („Dzień dobry, {imie}!"),
// znika też znak po nim — zostaje „Dzień dobry,", nie „Dzień dobry,!". Po zwykłym słowie znak zostaje:
// „Witaj {imie}!" → „Witaj!".
const RE_POLE_Z_ODSTEPEM = /( ?)\{([^{}\n]{0,40})\}([,.;:!?)]?)/g;
const ZNAK_PRZED_POLEM = /[,.;:!?]/;
const podstaw = (linia, pola) => linia.replace(RE_POLE_Z_ODSTEPEM, (_c, odstep, nazwa, znak, poczatek, calosc) => {
  const wartosc = wartoscPola(pola, nazwa);
  if (wartosc) return odstep + wartosc + znak;
  if (!znak) return odstep;
  // Nawias zamykający zostaje zawsze — „(numer: {numer_przesylki})" nie może zgubić pary.
  return znak !== ')' && ZNAK_PRZED_POLEM.test(calosc.charAt(poczatek - 1)) ? '' : znak;
});

/**
 * Treść z podstawionymi polami jako lista CZĘŚCI: `{ typ: 'akapit', linie }` albo `{ typ: 'blok', nazwa, linie }`,
 * każda z odstępem `sep` od poprzedniej ('' na początku, '\n' bez pustej linii, '\n\n' z pustą).
 *
 * `bloki` = { nazwa: [linie tekstu] }. Blok bez linii (np. brak danych do przelewu przy pobraniu) znika razem
 * ze swoją pustą linią — tak jak dziś znika sekcja. Pole bez wartości daje pusty napis, nigdy dosłowne `{…}`.
 */
export function zlozTresc(tresc, { pola = {}, bloki = {} } = {}) {
  const czesci = [];
  let otwarty = null;
  let pusta = false;
  const sep = () => (czesci.length === 0 ? '' : (pusta ? '\n\n' : '\n'));
  for (const surowa of String(tresc ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const linia = surowa.replace(/\s+$/, '');
    const blok = /^\s*\{([a-z_]+)\}\s*$/.exec(linia);
    if (blok && POLE.get(blok[1])?.blok) {
      otwarty = null;
      const linie = (bloki[blok[1]] ?? []).filter((l) => l !== null && l !== undefined);
      if (linie.length) { czesci.push({ typ: 'blok', nazwa: blok[1], linie, sep: sep() }); pusta = false; }
      continue;
    }
    if (!linia.trim()) { otwarty = null; pusta = true; continue; }
    const tekst = podstaw(linia, pola);
    if (otwarty) { otwarty.linie.push(tekst); continue; }
    otwarty = { typ: 'akapit', linie: [tekst], sep: sep() };
    czesci.push(otwarty);
    pusta = false;
  }
  return { czesci, tekst: czesci.map((c) => c.sep + c.linie.join('\n')).join('') };
}

/**
 * Pola wspólne dla każdego szablonu — z zamówienia (albo puste, gdy go nie ma, np. wątek Allegro bez zamówienia).
 * ⚠️ Kwota z `wierszePozycji` — tej samej funkcji, która rysuje kartę: mail nie pokazuje innej sumy niż ekran.
 */
export function polaZamowienia(z, { podpis = '' } = {}) {
  if (!z) return { numer_zamowienia: '', data_zamowienia: '', imie: '', kupujacy: '', kwota: '', metoda_wysylki: '', numer_przesylki: '', nazwa_firmy: String(podpis ?? '') };
  const adres = adresOdbiorcy(z) ?? {};
  const nazwa = String(adres.nazwa ?? '').trim()
    || [z.klient?.first_name, z.klient?.last_name].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  const razem = wierszePozycji(z).find((w) => w.podsumowanie);
  return {
    numer_zamowienia: String(z.numer ?? ''),
    data_zamowienia: z.utworzone_at ? dzienWarszawa(z.utworzone_at) : '',
    imie: rozbijNazwe(nazwa).first_name,
    // Zamówienie firmy bez osoby w adresie: nazwa firmy (z adresu albo z danych do faktury), nie pusty napis.
    kupujacy: nazwa || String(adres.company ?? '').trim() || String(firmaNabywcy(z) ?? '').trim(),
    kwota: razem ? zlotowki(razem.suma) : '',
    metoda_wysylki: nazwaDostawy(z) ?? '',
    numer_przesylki: (z.przesylki ?? []).map((p) => p.numer_listu).filter(Boolean).join(', '),
    nazwa_firmy: String(podpis ?? ''),
  };
}

/** Linie bloku `{podpis}` — to samo, co dziś kończy każdy mail; `pozdrowienie` z Ustawień (PRZ-102.19), brak = domyślne. */
export const liniePodpisu = (sprzedawca, pozdrowienie = DOMYSLNE_ZDANIA.pozdrowienie) => [pozdrowienie, String(sprzedawca ?? '')];

// ——— Stan zapisany w `ustawienia` (klucz KLUCZ_USTAWIEN, JSON) ————————————————————————————
//
// { wbudowane: { potwierdzenie: { temat, tresc, zmieniono_at } }, wlasne: [{ id, nazwa, temat, tresc, zmieniono_at }], licznik }
// `licznik` rośnie i nie wraca: id usuniętego szablonu nie dostaje nowy, więc wpis w rejestrze wysłanych
// („wlasny-3") nigdy nie zacznie nazywać się cudzą nazwą.

const PUSTY = () => ({ wbudowane: {}, wlasne: [], licznik: 0 });

/** Odczyt z mapy ustawień. Uszkodzony wiersz = brak szablonów (maile wracają do domyślnych, nie padają). */
export function odczytajSzablony(zapis = {}) {
  try {
    const s = JSON.parse(zapis[KLUCZ_USTAWIEN] ?? 'null');
    if (!s || typeof s !== 'object') return PUSTY();
    const wbudowane = {};
    for (const id of WSZYSTKIE_WBUDOWANE) {
      const w = s.wbudowane?.[id];
      if (w && typeof w.temat === 'string' && typeof w.tresc === 'string') wbudowane[id] = w;
    }
    const wlasne = (Array.isArray(s.wlasne) ? s.wlasne : [])
      .filter((w) => w && /^wlasny-\d+$/.test(w.id) && typeof w.nazwa === 'string' && typeof w.temat === 'string' && typeof w.tresc === 'string');
    const licznik = Math.max(Number(s.licznik) || 0, ...wlasne.map((w) => Number(w.id.slice(7))));
    return { wbudowane, wlasne, licznik };
  } catch {
    return PUSTY();
  }
}

/** Szablon do edycji: zapisany albo domyślny (wbudowany), z informacją, czy różni się od domyślnego. */
export function szablonDoEdycji(stan, id) {
  if (WSZYSTKIE_WBUDOWANE.includes(id)) {
    const zapisany = stan.wbudowane[id] ?? null;
    return { id, rodzaj: rodzajSzablonu(id), nazwa: NAZWA_WBUDOWANEGO[id], wbudowany: true, zmieniony: Boolean(zapisany),
      zmieniono_at: zapisany?.zmieniono_at ?? null, temat: zapisany?.temat ?? DOMYSLNE[id].temat, tresc: zapisany?.tresc ?? DOMYSLNE[id].tresc };
  }
  const w = stan.wlasne.find((s) => s.id === id);
  return w ? { ...w, rodzaj: 'wlasny', wbudowany: false } : null;
}

/** Zapis edycji. Zwraca `{ ok, stan }` albo `{ ok: false, blad }`; stanu wejściowego nie zmienia. */
export function zapiszSzablon(stan, id, dane, teraz) {
  const rodzaj = rodzajSzablonu(id);
  const sprawdzony = sprawdzSzablon(rodzaj, dane);
  if (!sprawdzony.ok) return sprawdzony;
  const s = sprawdzony.szablon;
  if (WSZYSTKIE_WBUDOWANE.includes(id)) {
    return { ok: true, id, stan: { ...stan, wbudowane: { ...stan.wbudowane, [id]: { temat: s.temat, tresc: s.tresc, zmieniono_at: teraz } } } };
  }
  if (id === 'nowy') {
    if (stan.wlasne.length >= MAKS.wlasnych) {
      return { ok: false, blad: `Szablonów własnych może być najwyżej ${MAKS.wlasnych}. Usuń niepotrzebny, zanim dodasz następny.` };
    }
    const licznik = stan.licznik + 1;
    const nowy = { id: `wlasny-${licznik}`, nazwa: s.nazwa, temat: s.temat, tresc: s.tresc, zmieniono_at: teraz };
    return { ok: true, id: nowy.id, stan: { ...stan, licznik, wlasne: [...stan.wlasne, nowy] } };
  }
  if (!stan.wlasne.some((w) => w.id === id)) return { ok: false, blad: 'Nie ma takiego szablonu — mógł zostać usunięty.' };
  return { ok: true, id, stan: { ...stan, wlasne: stan.wlasne.map((w) => (w.id === id
    ? { ...w, nazwa: s.nazwa, temat: s.temat, tresc: s.tresc, zmieniono_at: teraz } : w)) } };
}

/** „Przywróć domyślny" (wbudowany) albo „Usuń" (własny). */
export function usunSzablon(stan, id) {
  if (WSZYSTKIE_WBUDOWANE.includes(id)) {
    const { [id]: _usuniety, ...reszta } = stan.wbudowane;
    return { ok: true, stan: { ...stan, wbudowane: reszta } };
  }
  if (!stan.wlasne.some((w) => w.id === id)) return { ok: false, blad: 'Nie ma takiego szablonu — mógł zostać usunięty.' };
  return { ok: true, stan: { ...stan, wlasne: stan.wlasne.filter((w) => w.id !== id) } };
}
