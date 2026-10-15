// src/oms/domain/ostrzezenia.js
//
// Tabelka ostrzeżeń na stronie głównej (spec 2026-08-29). Czyste reguły: budowa
// wierszy czterech typów, klucze odrzuceń, filtr odrzuconych z wygasaniem, kolejność.
//
// ⚠️ NIC tu nie jest liczone od nowa — ta sama zasada, co w sprawyKarty. Każdy typ woła
// funkcję, która już rządzi swoją zakładką: paczki `bezRuchu`/`przesylkaUkryta`
// (pastylka, karta, /przesylki?pokaz=bez_ruchu), wiadomości `czyjRuch` (kolejki
// /wiadomosci), integracje strukturalny wynik `ocenZdrowie` (/health — model liczy się
// raz, renderują go dwa renderery, wzorzec 4.43), a luki KSeF przychodzą z lustra
// pisanego przez czuwacza barierą `coWolnoWyslac` (pola wyboru na /faktury).
//
// ⚠️ ŻADEN TYP NIE RZUCA. Uszkodzony wiersz ma zniknąć z tabelki, a nie zabrać listy
// zamówień — dokładnie jak przy sprawach karty. Stąd try wokół POJEDYNCZEGO elementu.
//
// Kształt wiersza: { klucz, typ, tekst, title?, przycisk: {href, etykieta},
// etykietaOdrzucenia }. Klucz jest deterministyczny (typ + tożsamość + znacznik
// zdarzenia): nowe zdarzenie tej samej rzeczy — kolejna wiadomość w wątku, kolejny
// ruch paczki — daje NOWY klucz, więc odrzucone ostrzeżenie wraca samo.

import {
  etapPrzesylki, etykietaEtapu, bezRuchu, dniKalendarzowe,
} from './etap-przesylki.js';
import { przesylkaUkryta } from './przesylka-stan.js';
import { czyPaczkaBezGotowki } from './pobranie-zaplacone.js';
import { czyPobranie } from './wysylka.js';
import { czyjRuch } from './czyj-ruch-watku.js';
import { dzienWarszawa, fmtDataCzasKrotko } from './format-daty.js';
import { fmtWiek } from './zdrowie.js';
import { zl } from './kwoty.js';

// Wyciszenie awarii integracji obowiązuje DOBĘ i wraca samo: awaria naprawiona gaśnie
// z regułą, a trwająca ma się przypomnieć — trwały klucz zamieniłby „wiem, zajmę się"
// w „nigdy więcej o tym nie mów".
export const WYGASANIE_INTEGRACJI_MS = 24 * 60 * 60 * 1000;

// Awarie infrastruktury pierwsze — od nich zależy prawdziwość reszty tabelki
// (martwy czuwacz znaczy stęchłe lustra). Potem pieniądze (KSeF, terminy, korekty),
// na końcu logistyka i korespondencja.
const KOLEJNOSC = ['integracja', 'faktura-ksef', 'faktura-termin', 'pobranie-korekta', 'zwrot-korekta', 'przesylka', 'wiadomosc-allegro'];

/**
 * Biała lista kluczy dla trasy POST /ostrzezenia/odrzuc — jedyne miejsce znające
 * komplet prefiksów (schema.sql celowo nie ma CHECK-a: listy w SQLite nie da się
 * rozszerzyć bez przebudowy tabeli, a typy mają rosnąć).
 */
export function kluczDozwolony(klucz) {
  return typeof klucz === 'string'
    && klucz.length <= 300
    && /^(faktura-ksef|faktura-termin|przesylka|wiadomosc|integracja|zwrot|pobranie):./.test(klucz);
}

/**
 * Dokumenty do wysłania do KSeF, wystawione PRZED dzisiejszym dniem. Dokument
 * z dzisiejszą datą milczy — wieczorna zbiorcza wysyłka to normalny tryb właściciela,
 * ostrzeżenie ma łapać to, co z niej wypadło.
 *
 * ⚠️ Luka bez daty wystawienia NIE znika po cichu: to dziwo w lustrze, a ostrzeżenie
 * jest odwracalne (inaczej niż operacje, przy których na braku danych się odmawia).
 */
export function ostrzezeniaFaktur({ luki = [], dzis } = {}) {
  const wiersze = [];
  for (const l of luki) {
    try {
      if (l.invoice_date && String(l.invoice_date) >= String(dzis)) continue;
      wiersze.push({
        klucz: `faktura-ksef:${l.uuid}`,
        typ: 'faktura-ksef',
        tekst: `Faktura ${l.numer ?? '(bez numeru)'} (${l.invoice_date ?? 'bez daty wystawienia'}) nie została wysłana do KSeF.`,
        title: `Stan z odczytu ${l.sprawdzona_at}. Wysłana ręcznie w inFakcie zniknie stąd przy następnym przebiegu czuwacza.`,
        przycisk: {
          href: l.invoice_date ? `/faktury?miesiac=${String(l.invoice_date).slice(0, 7)}` : '/faktury',
          etykieta: 'Faktury',
        },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* uszkodzony wiersz lustra nie ma prawa zabrać tabelki */ }
  }
  return wiersze;
}

/**
 * Paczki bez ruchu — TA SAMA reguła, co filtr /przesylki?pokaz=bez_ruchu (>3 dni
 * ROBOCZE od ostatniego zdarzenia kuriera, bez zdarzeń — od nadania; doręczona
 * i zwrot nie stoją; ukryta milczy, bo człowiek już o niej zdecydował).
 *
 * @param przesylki wiersze z przesylkiDoSledzenia (SELECT * FROM przesylki)
 * @param zamowienia Map id → { numer } — do treści wiersza
 */
export function ostrzezeniaPrzesylek({ przesylki = [], zamowienia = new Map(), teraz = new Date() } = {}) {
  const terazIso = teraz instanceof Date ? teraz.toISOString() : String(teraz);
  const wiersze = [];
  for (const p of przesylki) {
    try {
      if (przesylkaUkryta(p)) continue;
      const etap = etapPrzesylki(p.status_kuriera, p.status_kuriera_kod);
      const stoi = bezRuchu({
        etap, statusKurieraAt: p.status_kuriera_at, nadanaAt: p.utworzona_at, teraz,
      });
      if (!stoi) continue;
      const od = p.status_kuriera_at || p.utworzona_at;
      const zamowienie = zamowienia.get(p.zamowienie_id);
      const etykieta = etykietaEtapu(etap ?? 'nadana', dniKalendarzowe(p.utworzona_at, terazIso));
      wiersze.push({
        // Znacznik OSTATNIEGO zdarzenia w kluczu: paczka, która ruszyła i znów
        // stanęła, dostaje nowy klucz i alarmuje od nowa mimo starego odrzucenia.
        klucz: `przesylka:${p.id}:${od}`,
        typ: 'przesylka',
        tekst: `Paczka ${p.numer_listu ?? '(bez numeru)'} (zam. ${zamowienie?.numer ?? '?'}) stoi bez ruchu od ${dzienWarszawa(od)} — ${etykieta}.`,
        przycisk: { href: '/przesylki?pokaz=bez_ruchu', etykieta: 'Przesyłki' },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* jw. */ }
  }
  return wiersze;
}

// „Nowa wiadomość" znaczy Z OSTATNICH 7 DNI. ⚠️ Zmierzone na produkcji 29.08.2026,
// godzinę po pierwszym wdrożeniu: bez okna tabelka pokazała 18 wierszy z kwietnia–
// 7 sierpnia. SPROSTOWANIE z tego samego dnia: pierwotna diagnoza („klient miał
// ostatnie słowo «dziękuję»") była błędna — prawdziwą przyczyną był poller biorący
// z odpowiedzi Allegro NAJSTARSZĄ wiadomość zamiast najnowszej (naprawione w b9a14a3,
// po naprawie zostały 2 prawdziwie czekające wątki). Okno ZOSTAJE mimo naprawy:
// definiuje, co znaczy „nowa" — wątek czekający od miesięcy żyje na /wiadomosci,
// a tabelka jest szturchnięciem o ŚWIEŻE (i drugą linią obrony, gdyby lustro wątków
// znów zestarzało się niepostrzeżenie).
export const OKNO_WIADOMOSCI_DNI = 7;

/**
 * Wątki Allegro czekające na odpowiedź — `czyjRuch` z pustymi dowodami, bo „czeka"
 * zależy WYŁĄCZNIE od tego, czy ostatnia wiadomość jest od kupującego (odpowiedź
 * wysłana wprost w aplikacji Allegro gasi ostrzeżenie przy następnym przebiegu
 * pollera wiadomości, bo lustro wątków przestawia `ostatnia_od_kupujacego`).
 *
 * Wątek bez daty ostatniej wiadomości MILCZY: bez daty nie ma jak być świeżym,
 * a taki wiersz i tak widać w kolejce na /wiadomosci.
 */
export function ostrzezeniaWiadomosci({ watki = [], teraz = new Date() } = {}) {
  const t = teraz instanceof Date ? teraz.getTime() : Number(teraz);
  const wiersze = [];
  for (const w of watki) {
    try {
      if (czyjRuch(w, []) !== 'czeka') continue;
      const kiedy = Date.parse(w.last_message_date_time ?? '');
      const swieza = Number.isFinite(kiedy) && t - kiedy <= OKNO_WIADOMOSCI_DNI * 24 * 3600 * 1000;
      if (!swieza) continue;
      const skrot = String(w.ostatnia_tresc ?? '').slice(0, 120);
      wiersze.push({
        klucz: `wiadomosc:${w.kanal}:${w.thread_id}:${w.last_message_date_time}`,
        typ: 'wiadomosc-allegro',
        // Treść wiadomości NIE wchodzi do wiersza (ma zostać zwięzły) — skrót w title.
        tekst: `Nowa wiadomość z Allegro od ${w.interlocutor_login ?? '(nieznany login)'} (${fmtDataCzasKrotko(w.last_message_date_time)}).`,
        title: skrot || undefined,
        przycisk: { href: '/wiadomosci', etykieta: 'Wiadomości' },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* jw. */ }
  }
  return wiersze;
}

// Polska odmiana liczebnika dla zbiorczego wiersza terminów — ta sama klasa mini-odmiany,
// co `dniPoPolsku` w etap-przesylki.js (więcej form nie potrzeba).
const fakturPoPolsku = (n) => {
  if (n === 1) return '1 faktura';
  const r10 = n % 10;
  const r100 = n % 100;
  if (r10 >= 2 && r10 <= 4 && (r100 < 12 || r100 > 14)) return `${n} faktury`;
  return `${n} faktur`;
};

/**
 * ZBIORCZY wiersz „N przeterminowanych na X zł" — z lustra pasa długów
 * (`faktury_po_terminie`, pisze je czuwacz ostrzeżeń regułami zakładki /faktury:
 * `czekaNaPrzelew` + `stanTerminu === 'po_terminie'`). Jeden wiersz, nie N — długi
 * ogląda się na zakładce, tabelka ma tylko szturchnąć.
 *
 * Klucz jest ODCISKIEM ZBIORU (liczba + suma w groszach): nowa przeterminowana albo
 * częściowa spłata zmienia odcisk i odrzucone ostrzeżenie wraca samo.
 */
export function ostrzezeniaTerminow({ poTerminie = [] } = {}) {
  if (!poTerminie.length) return [];
  try {
    const sumaGr = poTerminie.reduce((s, f) => s + (Number(f.pozostalo_gr) || 0), 0);
    const lista = poTerminie.slice(0, 6)
      .map((f) => `${f.numer ?? f.uuid} (termin ${f.payment_date ?? '?'})`)
      .join(', ');
    const ogon = poTerminie.length > 6 ? '…' : '';
    return [{
      klucz: `faktura-termin:${poTerminie.length}:${sumaGr}`,
      typ: 'faktura-termin',
      tekst: `${fakturPoPolsku(poTerminie.length)} po terminie płatności — łącznie ${zl(sumaGr)} zł do zapłaty.`,
      title: `${lista}${ogon} Stan z odczytu ${poTerminie[0]?.sprawdzona_at ?? '?'}.`,
      przycisk: { href: '/faktury', etykieta: 'Faktury' },
      etykietaOdrzucenia: 'Ignoruj',
    }];
  } catch {
    return []; /* uszkodzony wiersz lustra nie ma prawa zabrać tabelki */
  }
}

/**
 * Zwroty czekające na korektę w inFakcie — wiersze z `zwrotyBezKorekty`
 * (db/ostrzezenia.js; granica „ma fakturę → korekta należna" ta sama, co
 * `zwrotRozliczony` w domain/zwrot.js). Zwrot zarejestrowany DZISIAJ milczy —
 * korekta zaraz po rejestracji to normalny tryb, ostrzeżenie łapie to, co zaległo
 * (ten sam próg, co przy typie `faktura-ksef`).
 */
export function ostrzezeniaZwrotow({ zwroty = [], dzis } = {}) {
  const wiersze = [];
  for (const w of zwroty) {
    try {
      const zarejestrowany = dzienWarszawa(w.utworzony_at);
      if (zarejestrowany && String(zarejestrowany) >= String(dzis)) continue;
      wiersze.push({
        klucz: `zwrot:${w.id}`,
        typ: 'zwrot-korekta',
        tekst: `Zwrot do zamówienia ${w.zamowienie_numer ?? '?'} (z ${w.data ?? '?'}) nie ma korekty w inFakcie.`,
        przycisk: { href: `/zamowienia/${w.zamowienie_id}`, etykieta: 'Zamówienie' },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* jw. */ }
  }
  return wiersze;
}

/**
 * PACZKA Z POBRANIEM WRÓCIŁA, A FAKTURA ZOSTAŁA — drugi biegun czuwacza pobrań.
 *
 * ⚠️⚠️ ISTNIEJE, BO PĘTLA PIENIĘDZY BYŁA DOMKNIĘTA TYLKO W JEDNĄ STRONĘ. Doręczenie
 * uruchamia oznaczenie faktury jako zapłaconej (services/oznaczanie-pobran.js); zwrot
 * nie uruchamiał NICZEGO. Faktura zostawała w KSeF jako dokument dostawy, do której nie
 * doszło — a fakturę z nadanym numerem KSeF można już tylko SKORYGOWAĆ, nigdy anulować
 * (not korygujących nie ma od 1.02.2026, art. 106k uchylony). Bez tego wiersza panel
 * milczał aż do chwili, gdy człowiek sam zarejestrował zwrot; do tego czasu VAT był
 * zapłacony od sprzedaży, której nie było.
 *
 * ⚠️ TA SAMA BRAMKA, CO W ŚCIEŻCE PIENIĘDZY — `czyPaczkaBezGotowki`, nie własna kopia
 * warunku. Ona jedna wie, że „Nie doręczono — adresat nieobecny" wpada w `etapPrzesylki`
 * jako `doreczona`, i że przy znanym kodzie maszynowym Allegro bezpiecznik z opisu nie
 * obowiązuje. Druga kopia rozjechałaby się z pasem długów i z czuwaczem.
 *
 * ⚠️ „W DRODZE" MILCZY. Przy paczce jadącej gotówki też jeszcze nie ma — ale będzie,
 * i to nie jest sprawa dla człowieka. Alarmujemy wyłącznie tam, gdzie kurier już nie
 * zainkasuje.
 *
 * ⚠️ WARTOŚĆ EFEKTYWNA POBRANIA (`czyPobranie`), nie kolumna `pobranie` — zamówienie
 * przełączone ręcznie z karty ma kolumnę ze sklepu i przy pytaniu o nią nigdy by tu
 * nie trafiło. Ta sama zasada, co w `czyPobranieRozliczone`.
 *
 * ⚠️ ZAKRES ROZDZIELONY ZE `zwrot-korekta`, a nie nałożony na niego: kandydaci przychodzą
 * z `pobraniaBezGotowki` (db/ostrzezenia.js), które odsiewa zamówienia z ZAREJESTROWANYM
 * zwrotem. Od chwili rejestracji o korektę upomina się tamten typ — dwa wiersze o tej
 * samej fakturze byłyby szumem, nie dwoma sprawami.
 *
 * Klucz niesie znacznik zdarzenia u kuriera, więc ruch paczki przywraca odrzucone
 * ostrzeżenie — ta sama zasada, co przy typie `przesylka`.
 */
export function ostrzezeniaPobran({ pobrania = [] } = {}) {
  const wiersze = [];
  for (const p of pobrania) {
    try {
      if (!czyPobranie(p)) continue;
      if (!czyPaczkaBezGotowki(p)) continue;
      wiersze.push({
        klucz: `pobranie:${p.zamowienie_id}:${p.status_kuriera_at ?? ''}`,
        typ: 'pobranie-korekta',
        tekst: `Paczka za pobraniem do zamówienia ${p.zamowienie_numer ?? '?'} wróciła bez gotówki — `
          + `faktura ${p.faktura_numer ?? '(bez numeru)'} czeka na korektę do zera.`,
        title: p.status_kuriera ? `Ostatni status kuriera: ${p.status_kuriera}.` : undefined,
        przycisk: { href: `/zamowienia/${p.zamowienie_id}`, etykieta: 'Zamówienie' },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* uszkodzony wiersz nie ma prawa zabrać tabelki */ }
  }
  return wiersze;
}

// Nazwy zegarów na ekran — pola wyniku ocenZdrowie → (klucz odrzucenia, nazwa).
const ZEGARY = [
  ['czuwaczKsef', 'czuwacz-ksef', 'Czuwacz KSeF'],
  ['czuwaczPrzesylek', 'czuwacz-przesylek', 'Czuwacz przesyłek'],
  ['czuwaczOstrzezen', 'czuwacz-ostrzezen', 'Czuwacz ostrzeżeń'],
  ['czuwaczKosztow', 'czuwacz-kosztow', 'Czuwacz kosztów'],
];

// ⚠️ BLAD NIEAKTUALNY NIE MA PRAWA TLUMACZYC POSTOJU (zgloszenie wlasciciela 10.09.2026).
// `blad` w wyniku ocenZdrowie bywa PAMIATKA: puls czuwacza trzyma ostatni slad bledu takze
// wtedy, gdy pozniejszy przebieg sie udal (`bladSwiezszy: false`). Zdanie „Czuwacz X nie
// działa: <blad sprzed doby>" wskazywalo wtedy przyczyne, ktorej JUZ NIE MA, i przemilczalo
// prawdziwa — ze zegar po prostu stoi. Czlowiek szukal awarii tam, gdzie jej nie bylo.
//
// ⚠️ BRAK POLA (obiekt zlozony recznie, wynik sprzed tej zmiany) POKAZUJE blad — na braku
// wiedzy nie chowamy, tak samo jak przy nieparsowalnej dacie odrzucenia nizej.
const bladAktualny = (z) => Boolean(z?.blad) && z?.bladSwiezszy !== false;

const zdanieZegara = (nazwa, z) => (bladAktualny(z)
  ? `${nazwa} nie działa: ${z.blad}`
  : `${nazwa}: ostatni udany przebieg ${z.wiekS != null ? `${fmtWiek(z.wiekS)} temu` : 'nieznany'}.`);

/**
 * Niedziałające integracje — ze STRUKTURALNEGO wyniku `ocenZdrowie` (reguła zdrowia
 * liczy się w domain/zdrowie.js; tu tylko drugi renderer tego samego modelu).
 *
 * ⚠️ KANAŁY ALLEGRO CELOWO POZA tym typem: mają na tej samej stronie własny pas
 * z wyjściem (wiązanie, 4.37) — drugi wiersz o tym samym uczyłby ignorowania obu.
 */
export function ostrzezeniaIntegracji({ zdrowie } = {}) {
  if (!zdrowie) return [];
  const wiersze = [];
  const przycisk = { href: '/ustawienia/lacznosc', etykieta: 'Łączność' };
  for (const z of zdrowie.poller?.zrodla ?? []) {
    try {
      if (z.zdrowy) continue;
      wiersze.push({
        klucz: `integracja:poller:${z.zrodlo}`,
        typ: 'integracja',
        tekst: z.blad
          ? `Poller ${z.zrodlo} nie działa: ${z.blad}`
          : `Poller ${z.zrodlo} stoi — ostatni przebieg ${z.wiekS != null ? `${fmtWiek(z.wiekS)} temu` : 'nieznany'}.`,
        przycisk,
        etykietaOdrzucenia: 'Wycisz na 24 h',
      });
    } catch { /* jw. */ }
  }
  for (const [pole, klucz, nazwa] of ZEGARY) {
    try {
      const z = zdrowie[pole];
      if (!z?.wlaczony || z.zdrowy) continue;
      wiersze.push({
        klucz: `integracja:${klucz}`,
        typ: 'integracja',
        tekst: zdanieZegara(nazwa, z),
        przycisk,
        etykietaOdrzucenia: 'Wycisz na 24 h',
      });
    } catch { /* jw. */ }
  }
  return wiersze;
}

/**
 * Filtr odrzuconych + kolejność typów. Odrzucenie trwałych typów chowa wiersz na
 * zawsze (nowe zdarzenie i tak zmienia klucz); wyciszenie `integracja` wygasa po
 * dobie. Nieparsowalna data odrzucenia POKAZUJE wiersz — na braku danych nie chowamy.
 */
export function zlozOstrzezenia({ wiersze = [], odrzucone = new Map(), teraz = new Date() } = {}) {
  const t = teraz instanceof Date ? teraz.getTime() : Number(teraz);
  const widoczne = wiersze.filter((w) => {
    const odrzuconeAt = odrzucone.get(w.klucz);
    if (!odrzuconeAt) return true;
    if (w.typ !== 'integracja') return false;
    return !(t - Date.parse(odrzuconeAt) < WYGASANIE_INTEGRACJI_MS);
  });
  return widoczne
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (KOLEJNOSC.indexOf(a.w.typ) - KOLEJNOSC.indexOf(b.w.typ)) || (a.i - b.i))
    .map(({ w }) => w);
}
