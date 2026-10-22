// PRZ-108.07 (zmiana B planu automatyzacji, właściciel 21.10): czyste reguły automatyzacji „zdarzenie → warunki → akcja”.
// Bez bazy i bez zegara — wszystko, co tu jest, da się sprawdzić w teście bez serwera (tests/domena/automatyzacje.test.js).
//
// Liczby z decyzji właściciela 21.10 (plan, „Zmiany po akceptacji”):
//  • 20 maili/h na regułę (zakres 1–200), 100/h na cały OMS;
//  • więcej niż 50 nowych wykonań jednej reguły w jednym przebiegu → reguła WSTRZYMANA (błąd albo import historii);
//  • 48 h liczone od `termin_at` (planowanej chwili wykonania), nie od zdarzenia — opóźnienie 7 dni się nie przeterminuje;
//  • opóźnienie 0–10 080 min (7 dni).

import { METODY_WYSYLKI } from './wysylka.js';
import { POBRANIE } from './warunki-automatyzacji.js';

export const OPOZNIENIE_MAX_MIN = 10080;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;
export const LIMIT_DOMYSLNY = 20;
export const LIMIT_OMS_NA_GODZINE = 100;
export const BEZPIECZNIK_NARAZ = 50;
export const PRZETERMINOWANIE_H = 48;
export const ZAKLADKA_KURSORA_MIN = 5;
export const PONOWIENIE_MIN = 15;
export const MAKS_PROB = 3;
export const NAZWA_MAKS = 60;
/** Ile kandydatów detektor oddaje w jednym przebiegu jednej reguły (i tak powyżej 50 reguła się wstrzymuje). */
export const LIMIT_KANDYDATOW = 1000;

const MIN_MS = 60_000;
const GODZINA_MS = 60 * MIN_MS;

export const GRUPY_ZDARZEN = Object.freeze([
  { klucz: 'przesylka', etykieta: 'Przesyłka' },
  { klucz: 'zamowienie', etykieta: 'Zamówienie' },
  { klucz: 'dokumenty', etykieta: 'Dokumenty' },
]);

/**
 * Pełny katalog zdarzeń z planu (sekcja 2) — do wyświetlenia w kreatorze. DOSTĘPNE jest tylko to, co jest w
 * rejestrze zdarzeń modułu (moduly/automatyzacje/zdarzenia); reszta jest przygaszona z dopiskiem „wkrótce”.
 * W zmianie B rejestr jest pusty: „Paczka nadana” i „Status zmienił się na” wchodzą w C1, „Kurier odebrał” w C2.
 */
export const KATALOG_ZDARZEN = Object.freeze([
  { klucz: 'paczka_nadana', grupa: 'przesylka', etykieta: 'Paczka nadana — ma numer listu' },
  { klucz: 'paczka_odebrana', grupa: 'przesylka', etykieta: 'Kurier odebrał paczkę' },
  { klucz: 'paczka_doreczona', grupa: 'przesylka', etykieta: 'Paczka doręczona' },
  { klucz: 'status_zmieniony', grupa: 'zamowienie', etykieta: 'Status zamówienia zmienił się na…' },
  { klucz: 'zamowienie_nowe', grupa: 'zamowienie', etykieta: 'Nowe zamówienie' },
  { klucz: 'proforma_wystawiona', grupa: 'dokumenty', etykieta: 'Proforma wystawiona' },
  { klucz: 'faktura_wystawiona', grupa: 'dokumenty', etykieta: 'Faktura wystawiona' },
]);

/** Akcje z planu; dostępne = w rejestrze akcji modułu (w B pusty — mail do kupującego wchodzi w C1). */
export const KATALOG_AKCJI = Object.freeze([
  { klucz: 'mail_kupujacy', etykieta: 'Wyślij mail do kupującego' },
  { klucz: 'zmien_status', etykieta: 'Zmień status zamówienia' },
  { klucz: 'mail_zespol', etykieta: 'Wyślij mail do zespołu' },
]);

// Plan, sekcja 4: szablon filtrowany zgodnością ze zdarzeniem, żeby nie dało się zbudować reguły, która zawsze odmówi.
// „Przypomnienie o płatności” potrzebuje zdarzenia czasowego („X dni po terminie”) — poza zakresem, więc nigdzie.
const ZDARZENIA_SZABLONU = Object.freeze({
  wyslane: ['paczka_nadana', 'paczka_odebrana', 'paczka_doreczona', 'status_zmieniony'],
  potwierdzenie: ['zamowienie_nowe'],
  proforma: ['proforma_wystawiona'],
  faktura: ['faktura_wystawiona'],
  przypomnienie: [],
});
const WLASNY = /^wlasny-\d+$/;

export function zgodnoscSzablonu(zdarzenie, szablon) {
  if (WLASNY.test(String(szablon ?? ''))) return true;
  return Object.hasOwn(ZDARZENIA_SZABLONU, szablon) && ZDARZENIA_SZABLONU[szablon].includes(zdarzenie);
}

const lista = (w) => (Array.isArray(w) ? w : w === undefined || w === null || w === '' ? [] : [w]).map(String);
const tekst = (w) => (Array.isArray(w) ? w[w.length - 1] : w ?? '').toString().trim();

function liczbaCalkowita(w, { pusta, min, max }) {
  const s = tekst(w);
  if (s === '') return pusta;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/**
 * Walidacja formularza reguły (kreator i edycja). `kanaly` = kanały konfiguracji (`kanalyWidoku`), `zdarzenia` i `akcje`
 * = DOSTĘPNE wpisy rejestrów, `szablony` = identyfikatory istniejących szablonów (wbudowane + własne).
 * Zwraca `{ ok: true, regula }` albo `{ ok: false, bledy }`. Warunki to biała lista kanałów plus migawka kanałów
 * znanych w chwili zapisu — z niej ekran liczy „nowe kanały od zapisu”. PRZ-108.08 (C1): do tego parametr zdarzenia
 * (`zdarzenie_status`) i warunki status / numer listu / dostawa / pobranie — sprawdza je silnik w chwili wykonania
 * (domena/warunki-automatyzacji.js). `statusy` = klucze wszystkich statusów z Ustawień (wbudowane + własne).
 */
export function sprawdzRegule(formularz = {}, { kanaly = [], zdarzenia = [], akcje = [], szablony = [], statusy = [] } = {}) {
  const bledy = [];
  const nazwa = tekst(formularz.nazwa);
  if (!nazwa) bledy.push('Podaj nazwę reguły.');
  else if ([...nazwa].length > NAZWA_MAKS) bledy.push(`Nazwa: najwyżej ${NAZWA_MAKS} znaków.`);

  const zdarzenie = tekst(formularz.zdarzenie);
  if (!zdarzenia.some((z) => z.klucz === zdarzenie)) {
    bledy.push(zdarzenie ? 'To zdarzenie jest niedostępne w tej wersji OMS-u — wybierz inne.' : 'Wybierz zdarzenie.');
  }

  const znane = kanaly.map((k) => k.klucz);
  const zaznaczone = [...new Set(lista(formularz.kanaly).filter(Boolean))];
  if (!zaznaczone.length) bledy.push('Zaznacz co najmniej jeden kanał sprzedaży.');
  for (const k of zaznaczone) if (!znane.includes(k)) bledy.push(`Kanału „${k}” nie ma w konfiguracji.`);

  const opoznienie = liczbaCalkowita(formularz.opoznienie, { pusta: 0, min: 0, max: OPOZNIENIE_MAX_MIN });
  if (opoznienie === null) bledy.push(`Opóźnienie: liczba całkowita minut od 0 do ${OPOZNIENIE_MAX_MIN.toLocaleString('pl-PL')} (7 dni).`);
  const limit = liczbaCalkowita(formularz.limit, { pusta: LIMIT_DOMYSLNY, min: LIMIT_MIN, max: LIMIT_MAX });
  if (limit === null) bledy.push(`Limit: od ${LIMIT_MIN} do ${LIMIT_MAX} maili na godzinę.`);

  const akcja = tekst(formularz.akcja);
  const wpisAkcji = akcje.find((a) => a.klucz === akcja);
  if (!wpisAkcji) bledy.push(akcja ? 'Ta akcja jest niedostępna w tej wersji OMS-u.' : 'Wybierz akcję.');
  const akcja_json = {};
  if (wpisAkcji?.szablon) {
    const szablon = tekst(formularz.szablon);
    if (!szablon) bledy.push('Wybierz szablon maila.');
    else if (!szablony.includes(szablon)) bledy.push('Nie ma takiego szablonu — mógł zostać usunięty.');
    else if (zdarzenie && !zgodnoscSzablonu(zdarzenie, szablon)) bledy.push('Ten szablon nie pasuje do wybranego zdarzenia.');
    akcja_json.szablon = szablon;
  }

  // PRZ-108.08 (C1): parametr zdarzenia (np. „status zmienił się na: Wysłane”) i warunki sprawdzane w chwili wykonania.
  const zdarzenie_json = parametrZdarzenia(formularz, zdarzenia.find((z) => z.klucz === zdarzenie), bledy);
  const warunkiWykonania = warunkiZFormularza(formularz, { statusy, szablon: akcja_json.szablon, bledy });

  if (bledy.length) return { ok: false, bledy };
  return { ok: true, regula: {
    nazwa, zdarzenie, zdarzenie_json,
    warunki: { kanaly: zaznaczone, kanalyZnane: znane, ...warunkiWykonania },
    akcja, akcja_json, opoznienie_min: opoznienie, limit_na_godzine: limit,
  } };
}

/** Szablony, które same wymagają warunku (plan, „Zmiany po akceptacji”, pkt 4): mail twierdzi, że paczka ma numer listu. */
export const SZABLONY_Z_NUMEREM_LISTU = Object.freeze(['wyslane']);
export const wymagaNumeruListu = (szablon) => SZABLONY_Z_NUMEREM_LISTU.includes(szablon);

/**
 * Parametr zdarzenia. Wpis rejestru z `opcje` (lista dozwolonych kluczy, np. statusy, których zmianę umiemy wykryć)
 * wymaga wyboru jednej z nich — zapis `{ status }`. Zdarzenie bez parametru → `{}`.
 */
function parametrZdarzenia(formularz, wpis, bledy) {
  if (!Array.isArray(wpis?.opcje)) return {};
  const status = tekst(formularz.zdarzenie_status);
  if (!status) bledy.push('Wybierz status, na który ma się zmienić zamówienie.');
  else if (!wpis.opcje.includes(status)) {
    bledy.push('Tego statusu nie da się (jeszcze) rozpoznać jako zdarzenia albo nie ma go już w Ustawieniach → Statusy zamówień — wybierz inny.');
  }
  return { status };
}

/**
 * Warunki w chwili wykonania z formularza (kreator, krok 2):
 *  • „status jest …”: `status_warunek` = dowolny | jeden_z, `statusy` z konfiguracji statusów (wbudowane + własne);
 *  • „przesyłka ma numer listu”: `ma_numer_listu` — formularz wysyła ukryte „0” i pole wyboru „1”, liczy się ostatnie.
 *    Szablon „Zamówienie wysłane” wymusza warunek: brak pola → wymuszony, jawne „0” → błąd (plan, C1, test 9);
 *  • sposób dostawy (`dostawa`, puste = wszystkie) z METODY_WYSYLKI; pobranie dowolne | tak | nie.
 */
function warunkiZFormularza(formularz, { statusy, szablon, bledy }) {
  const tryb = tekst(formularz.status_warunek);
  let wybraneStatusy = [];
  if (tryb !== 'dowolny') {
    wybraneStatusy = [...new Set(lista(formularz.statusy).filter(Boolean))];
    if (tryb === 'jeden_z' && !wybraneStatusy.length) bledy.push('Zaznacz co najmniej jeden status albo wybierz „dowolny”.');
    for (const s of wybraneStatusy) if (!statusy.includes(s)) bledy.push(`Statusu „${s}” nie ma w Ustawieniach → Statusy zamówień.`);
  }

  const pole = formularz.ma_numer_listu;
  const numer = pole === undefined ? null : tekst(pole);
  let maNumerListu = numer === '1';
  if (wymagaNumeruListu(szablon)) {
    if (numer === '0') bledy.push('Szablon „Zamówienie wysłane” wymaga warunku „przesyłka ma numer listu” — bez numeru ten mail nie ma czego pokazać.');
    maNumerListu = true;
  }

  const metody = [...new Set(lista(formularz.dostawa).map((m) => String(m).trim()).filter(Boolean))];
  for (const m of metody) if (!METODY_WYSYLKI.includes(m)) bledy.push('Nie ma takiego sposobu dostawy.');
  const pobranie = tekst(formularz.pobranie) || 'dowolne';
  if (!POBRANIE.includes(pobranie)) bledy.push('Pobranie: dowolnie, tylko za pobraniem albo tylko bez pobrania.');

  return { statusy: wybraneStatusy, maNumerListu, metody, pobranie };
}

/**
 * BIAŁA LISTA: zamówienie pasuje tylko, gdy jego kanał jest zaznaczony. Kanał dodany do konfiguracji po zapisie
 * reguły nie jest zaznaczony, więc reguła go nie obejmuje (decyzja właściciela: nowy kanał domyślnie odznaczony).
 */
export function czyPasujeKanalom(sklep, warunki) {
  const kanaly = Array.isArray(warunki?.kanaly) ? warunki.kanaly : [];
  return sklep !== undefined && sklep !== null && kanaly.includes(sklep);
}

/** Różnica zbiorów: kanały konfiguracji nieznane przy zapisie i zaznaczone kanały, których w konfiguracji już nie ma. */
export function noweKanalyOdZapisu(warunki, kanaly) {
  const teraz = kanaly.map((k) => k.klucz);
  const znane = Array.isArray(warunki?.kanalyZnane) ? warunki.kanalyZnane : warunki?.kanaly ?? [];
  return {
    nowe: teraz.filter((k) => !znane.includes(k)),
    usuniete: (warunki?.kanaly ?? []).filter((k) => !teraz.includes(k)),
  };
}

/**
 * Granica = chwila włączenia + migawka największych id. Data zamówienia ze sklepu się nie nadaje (Woo `date_created`,
 * Allegro `boughtAt` są cofnięte wstecz), id rośnie zawsze.
 */
export function nowaGranica(teraz, migawka = {}) {
  const ids = {};
  for (const tabela of Object.keys(migawka)) ids[tabela] = Number(migawka[tabela] ?? 0) || 0;
  return { granica_at: teraz.toISOString(), granica_json: ids };
}

/** Zmiana zdarzenia albo warunków reguły włączonej przesuwa granicę — rozszerzone warunki nie zgarną historii. */
export function zmianaPrzesuwaGranice(stara, nowa) {
  const kanaly = (r) => [...(r.warunki?.kanaly ?? [])].sort();
  const reszta = ({ kanaly: _k, kanalyZnane: _z, ...w } = {}) => w;
  return stara.zdarzenie !== nowa.zdarzenie
    || JSON.stringify(stara.zdarzenie_json ?? {}) !== JSON.stringify(nowa.zdarzenie_json ?? {})
    || JSON.stringify(kanaly(stara)) !== JSON.stringify(kanaly(nowa))
    || JSON.stringify(reszta(stara.warunki)) !== JSON.stringify(reszta(nowa.warunki));
}

function parsuj(json) {
  try { return JSON.parse(json ?? 'null'); } catch { return null; }
}

/**
 * Od kiedy detektor czyta zdarzenia: od kursora (ostatni udany przebieg) minus 5 min zakładki, ale nigdy sprzed
 * granicy. Zakładka łapie zdarzenie ze znacznikiem sprzed kursora, które stało się widoczne dopiero po nim (zapis
 * w transakcji zaczętej przed przebiegiem). Koszt przebiegu nie rośnie z wiekiem reguły.
 */
export function odKursora({ granica_at, kursor_json }) {
  return odczytKursora({ granica_at, kursor_json }).od;
}

/**
 * Kursor złożony (PRZ-108.07, recenzja 07, usterka 3). Zwykły przebieg: `{ od: kursor − 5 min, po: null }`. Gdy poprzedni
 * przebieg dostał obciętą listę (LIMIT_KANDYDATOW), kursor trzyma `po = { at, id }` ostatniego przeczytanego kandydata
 * i to samo `od` — detektor czyta ŚCIŚLE po (at, id), więc 1100 zdarzeń z tej samej sekundy przechodzi w dwóch
 * przebiegach, zamiast w kółko czytać te same 1000.
 */
export function odczytKursora({ granica_at, kursor_json }) {
  const kursor = parsuj(kursor_json);
  if (kursor?.po?.at && kursor.po.id !== undefined && kursor.od) {
    return { od: kursor.od > granica_at ? kursor.od : granica_at, po: { at: kursor.po.at, id: kursor.po.id } };
  }
  if (!kursor?.at) return { od: granica_at, po: null };
  const od = new Date(Date.parse(kursor.at) - ZAKLADKA_KURSORA_MIN * MIN_MS).toISOString();
  return { od: od > granica_at ? od : granica_at, po: null };
}

/** Kursor po przebiegu: chwila przebiegu albo — przy obciętej liście — kontynuacja ściśle po ostatnim kandydacie. */
export function nowyKursor({ chwila, od, kandydaci, limit = LIMIT_KANDYDATOW }) {
  if (kandydaci.length < limit) return { at: chwila };
  const ostatni = kandydaci[kandydaci.length - 1];
  return { at: chwila, od, po: { at: ostatni.zdarzenie_at, id: ostatni.id ?? ostatni.zamowienie_id } };
}

export function terminWykonania(zdarzenieAt, opoznienieMin) {
  return new Date(Date.parse(zdarzenieAt) + opoznienieMin * MIN_MS).toISOString();
}

/** 48 h od TERMINU (planowanej chwili wykonania), nie od zdarzenia. */
export function czyPrzeterminowane(terminAt, teraz) {
  return teraz.getTime() - Date.parse(terminAt) > PRZETERMINOWANIE_H * GODZINA_MS;
}

export const godzineWczesniej = (teraz) => new Date(teraz.getTime() - GODZINA_MS).toISOString();
export const ponowienieOd = (teraz) => new Date(teraz.getTime() + PONOWIENIE_MIN * MIN_MS).toISOString();

// core/poczta/smtp.js przenosi `err.code` nodemailera. Ponawiamy WYŁĄCZNIE kody, które nodemailer (10.x,
// smtp-connection/index.js) daje na pewno przed `MAIL FROM`: EDNS (nie rozwiązano nazwy serwera), ETLS (nawiązanie /
// podniesienie TLS przy łączeniu i STARTTLS), EAUTH (logowanie). ⚠️ NIE ECONNECTION (PRZ-108.07, recenzja 07, usterka 1):
// ten sam kod dostaje każde zamknięcie połączenia, na które czekała odpowiedź — także czekanie na `250` po kropce
// kończącej DATA, gdy serwer ma już całą treść; ponowienie wysłałoby drugi mail. Wszystko inne (ECONNECTION, ESOCKET,
// ETIMEDOUT, EMESSAGE, brak kodu) → „niepewne” bez ponowienia: wolimy jeden brakujący mail niż dwa wysłane.
const KODY_PRZED_PRZYJECIEM = new Set(['EDNS', 'ETLS', 'EAUTH']);
export function klasyfikujBladPoczty(err) {
  return KODY_PRZED_PRZYJECIEM.has(err?.code) ? 'ponow' : 'niepewne';
}

/** Czy reguła ma warunki poza kanałem (sprawdzane w chwili wykonania, zmiana C1). */
export function maWarunkiWykonania(warunki = {}) {
  const { kanaly: _k, kanalyZnane: _z, ...reszta } = warunki ?? {};
  return Object.values(reszta).some((w) => (Array.isArray(w) ? w.length > 0 : w !== null && w !== undefined
    && w !== false && w !== 'dowolne'));
}

/** `RRRR-MM-DD GG:MM` (czas Warszawy) → `DD.MM.RRRR GG:MM`. */
export function pokazChwile(sformatowana) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(sformatowana ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}` : '';
}
