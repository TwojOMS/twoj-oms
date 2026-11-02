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
import { KOLEJNOSC } from './powiadomienia.js';
import { ekranDlaAdresu, maDostepDoEkranu } from './ekrany.js';
import { NAZWA_ZAPASOWA } from './nazwa-programu.js';
export { KOLEJNOSC } from './powiadomienia.js';

// Wyciszenie awarii integracji obowiązuje DOBĘ i wraca samo: awaria naprawiona gaśnie
// z regułą, a trwająca ma się przypomnieć — trwały klucz zamieniłby „wiem, zajmę się"
// w „nigdy więcej o tym nie mów".
export const WYGASANIE_INTEGRACJI_MS = 24 * 60 * 60 * 1000;

// Awarie infrastruktury pierwsze — od nich zależy prawdziwość reszty tabelki
// (martwy czuwacz znaczy stęchłe lustra). Potem pieniądze (KSeF, terminy, korekty),
// na końcu logistyka i korespondencja.

/**
 * Biała lista kluczy dla trasy POST /ostrzezenia/odrzuc — jedyne miejsce znające
 * komplet prefiksów (schema.sql celowo nie ma CHECK-a: listy w SQLite nie da się
 * rozszerzyć bez przebudowy tabeli, a typy mają rosnąć).
 */
export function kluczDozwolony(klucz) {
  return typeof klucz === 'string'
    && klucz.length <= 300
    && /^(faktura-ksef|faktura-termin|przesylka|wiadomosc|integracja|zwrot|pobranie|automatyzacja):./.test(klucz);
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
 * PRZ-123 C09cb: wysyłka TwojeFaktury do KSeF niepewna dłużej niż doba (`niepewneKsefPonadDobe`, lustro tf_ksef).
 * Czuwacz nadal próbuje sam; człowiek ma sprawdzić fakturę w KSeF, ZANIM wyśle ją ponownie (dubel). Bez ponowienia
 * i bez zmiany stanu — wiersz znika sam, gdy czuwacz rozstrzygnie wysyłkę. Klucz z wersją: nowa wersja = nowy wiersz.
 */
export function ostrzezeniaNiepewnychKsef({ wysylki = [] } = {}) {
  const wiersze = [];
  for (const w of wysylki) {
    try {
      wiersze.push({
        klucz: `faktura-ksef:niepewna:${w.dokument_id}:${w.wersja}`,
        typ: 'faktura-ksef',
        tekst: `Faktura ${w.numer ?? '(bez numeru)'}: KSeF od doby nie potwierdza stanu sesji — sprawdź fakturę w KSeF `
          + '(aplikacja MF) zanim wyślesz ją ponownie.',
        title: `Wysłana ${dzienIGodzina(w.od)}; OMS sprawdza jej stan w KSeF sam i niczego nie ponawia.`,
        przycisk: { href: '/faktury', etykieta: 'Faktury' },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* uszkodzony wiersz nie ma prawa zabrać tabelki */ }
  }
  return wiersze;
}

/**
 * PRZ-102.12: wynik ostatniego przebiegu automatu KSeF (`ksef.automat.wynik`, services/ksef-automat.js).
 * Wiersz tylko wtedy, gdy człowiek ma coś zrobić: błąd (automat stanął), przebieg przerwany restartem,
 * dokumenty „nie wiadomo” albo pominięte przy wysyłce. Udany przebieg milczy — szczegóły są pod przyciskiem.
 * Klucz niesie dzień przebiegu: odrzucony wiersz wraca przy następnym kłopocie, nie przy tym samym.
 */
export function ostrzezeniaAutomatuKsef({ wynik = null, wstrzymane = [], nazwa = NAZWA_ZAPASOWA, gdzie = `w ${nazwa.miejscownik}`, tryb = null } = {}) {
  // C09b: dokument odrzucony przez KSeF, który już jest wśród wstrzymanych, ma swój wiersz — bez dubla w wyniku.
  const juzWstrzymane = new Set((Array.isArray(wstrzymane) ? wstrzymane : []).map((w) => w?.uuid).filter(Boolean));
  const bezDubla = wynik?.tryb && Array.isArray(wynik.odrzucone)
    ? { ...wynik, odrzucone: wynik.odrzucone.filter((d) => !juzWstrzymane.has(d?.uuid)) } : wynik;
  return [...wierszWynikuAutomatu(bezDubla), ...wierszeWstrzymanych(wstrzymane, nazwa, gdzie, tryb)];
}

/**
 * Zdanie o fakturze wstrzymanej — jedno dla ostrzeżenia i ekranu wyniku (ksef-wynik.ejs).
 * PRZ-118.09: `nazwa` = odmiana nazwy programu (`opis.nazwa`; domyślnie inFakt — domena/nazwa-programu.js).
 * ZDROWIE-RECZNIE: `tryb` automatu — w trybie „reczna” poprawionej wersji nikt sam nie wyśle, więc krok mówi „ręcznie”.
 */
export function zdanieWstrzymanej(w, nazwa = NAZWA_ZAPASOWA, gdzie = `w ${nazwa.miejscownik}`, tryb = null) {
  // PRZ-123 C09: korekta TwojeFaktury, której pierwotną zmieniono po odrzuceniu przez KSeF (409 z adaptera).
  if (w?.kod === 'korekta-nieaktualna') {
    return `Korekta ${w?.numer ?? '(bez numeru)'} nie poszła do KSeF — faktura pierwotna zmieniła się po wystawieniu `
      + 'korekty, więc automat KSeF jej nie wyśle. Następny krok: wystaw nową korektę do aktualnej wersji faktury pierwotnej.';
  }
  // PRZ-123 K440c: KSeF zgłosił duplikat (440), a panel 3 razy nie pobrał oryginału — zdanie „co dalej” składa czuwacz
  // (`opisNiesprawdzonegoDuplikatu` w module faktur; domena go nie importuje), tu tylko zapas na pusty powód.
  if (w?.kod === 'duplikat-niesprawdzony') {
    return w?.powod || `Faktura ${w?.numer ?? '(bez numeru)'}: KSeF zgłosił duplikat, a panel nie sprawdził oryginału. `
      + 'Następny krok: kliknij „Sprawdź ponownie” na ekranie wyniku automatu KSeF.';
  }
  // PRZ-123 C09b: automat TwojeFaktury nie ponawia tych samych bajtów — wpis trwa do nowej wersji albo numeru KSeF.
  const numer = w?.numer ?? '(bez numeru)';
  const powod = w?.powod ? ` (${w.powod})` : '';
  if (w?.kod === 'odrzucona') {
    return `Faktura ${numer} odrzucona przez KSeF ${w?.dzien ?? '?'}${powod} — automat jej nie wyśle. `
      + (tryb === 'reczna' ? 'Następny krok: popraw fakturę w zakładce FAKTURY i wyślij poprawioną wersję ręcznie.'
        : 'Następny krok: popraw fakturę w zakładce FAKTURY; poprawioną wersję automat wyśle sam.');
  }
  if (w?.kod === 'nie-wyslano') {
    return `Faktura ${numer} nie doszła do KSeF ${w?.dzien ?? '?'}${powod} — automat nie ponawia tej samej wysyłki. `
      + 'Następny krok: wyślij ją ręcznie bez zmian z zakładki FAKTURY.';
  }
  return `Faktura ${w?.numer ?? '(bez numeru)'} wstrzymana — automat jej nie wyśle (${nazwa.mianownik} odrzucił ją ${w?.dzien ?? '?'}`
    + `${w?.powod ? `: ${w.powod}` : ''}). Następny krok: popraw ${gdzie} i wyślij ręcznie albo zwolnij.`;
}

// Poprawka po recenzji PRZ-102.12 (WAŻNE 1): faktura odrzucona przez inFakt przy wysyłce z automatu jest pomijana
// w kolejnych przebiegach — wiersz trwa, dopóki człowiek jej nie wyśle albo nie zwolni (klucz = uuid).
function wierszeWstrzymanych(wstrzymane, nazwa, gdzie, tryb) {
  const wiersze = [];
  for (const w of Array.isArray(wstrzymane) ? wstrzymane : []) {
    try {
      if (!w?.uuid) continue;
      wiersze.push({
        klucz: `faktura-ksef:automat-wstrzymana:${w.uuid}`,
        typ: 'faktura-ksef',
        tekst: zdanieWstrzymanej(w, nazwa, gdzie, tryb),
        przycisk: { href: '/faktury/ksef/automat', etykieta: 'Wynik automatu' },
        etykietaOdrzucenia: 'Ignoruj',
      });
    } catch { /* jw. */ }
  }
  return wiersze;
}

/** `DD.MM GG:MM` czasu Warszawy (Zdrowie: „czekają … od 27.10 11:15”). */
function dzienIGodzina(iso) {
  const t = fmtDataCzasKrotko(iso);
  return t ? `${t.slice(8, 10)}.${t.slice(5, 7)} ${t.slice(11, 16)}` : '?';
}

const faktur = (n) => {
  const d = n % 10; const s = n % 100;
  if (n === 1) return 'faktura czeka';
  return d >= 2 && d <= 4 && (s < 12 || s > 14) ? 'faktury czekają' : 'faktur czeka';
};

/**
 * PRZ-123 C09: wynik automatu programu z własną wysyłką (TwojeFaktury; `wynik.tryb`). Automat sam ponawia (co 5 minut
 * albo jutro o godzinie), więc zdanie mówi, ile czeka i od kiedy, a nie „automat niczego nie ponawia”.
 */
function wierszWynikuTrybu(wynik) {
  const niepewne = Array.isArray(wynik.niepewne) ? wynik.niepewne : [];
  const pominiete = Array.isArray(wynik.pominiete) ? wynik.pominiete : [];
  const odrzucone = Array.isArray(wynik.odrzucone) ? wynik.odrzucone : [];
  const czeka = Array.isArray(wynik.czekaNaPierwotna) ? wynik.czekaNaPierwotna : [];
  const przerwany = wynik.stan === 'przerwany';
  const awaria = wynik.awaria ?? null;
  if (!awaria && !przerwany && !niepewne.length && !pominiete.length && !odrzucone.length && !czeka.length) return [];
  const numery = (lista) => lista.map((d) => d?.numer ?? '?').join(', ');
  const czesci = [];
  if (awaria) {
    const ponowi = wynik.tryb === 'o_godzinie' ? `jutro o ${wynik.godzina ?? 'ustawionej godzinie'}` : 'sam co 5 minut';
    const blad = String(awaria.blad ?? 'błąd wysyłki').trim();
    const od = dzienIGodzina(awaria.od);
    // ZDROWIE-RECZNIE: „od” to start serii awarii (licznik czekających); „zatrzymał się (HH:MM)” mówi o godzinie
    // przebiegu, który się zatrzymał — `koniecAt` tego wyniku (starszy zapis bez niej: start przebiegu, potem „od”).
    const stanal = dzienIGodzina(wynik.koniecAt ?? wynik.startAt ?? awaria.od);
    const czekaja = `${awaria.czeka} ${faktur(awaria.czeka)} na wysłanie do KSeF od ${od}`;
    // C09b: „ponowi” tylko o dokumentach, które automat weźmie (`czeka` = kandydaci po przebiegu, bez wstrzymanych).
    // C09cb: błąd należy do faktury `numer`; jeśli automat jej nie weźmie (`ponawia: false` — wstrzymana albo
    // niepewna), zdanie mówi to wprost, a licznik pozostałych idzie osobno.
    if (awaria.numer && !awaria.ponawia) {
      czesci.push(`przebieg zatrzymał się na fakturze ${awaria.numer} (${stanal}): ${blad.replace(/[.!?]$/u, '')} — tej faktury `
        + `automat nie wyśle ponownie${awaria.czeka > 0 ? `; pozostałe: ${czekaja} — OMS ponowi je ${ponowi}` : ''}`);
    } else {
      const gdzie = awaria.numer ? ` na fakturze ${awaria.numer}` : '';
      czesci.push(awaria.czeka > 0
        ? `${czekaja} — przebieg zatrzymał się${gdzie}: ${blad}${/[.!?]$/u.test(blad) ? '' : '.'} OMS ponowi ${ponowi}`
        : `przebieg zatrzymał się${gdzie} (${stanal}): ${blad.replace(/[.!?]$/u, '')}`);
    }
  }
  if (przerwany) {
    czesci.push(wynik.wTrakcie?.numer
      ? `przebieg przerwany (panel uruchomił się ponownie) w trakcie wysyłki ${wynik.wTrakcie.numer} — stan rozstrzygnie sprawdzanie KSeF`
      : 'przebieg przerwany (panel uruchomił się ponownie w trakcie)');
  }
  if (niepewne.length) czesci.push(`NIE WIADOMO, czy poszły: ${numery(niepewne)} — stan rozstrzygnie sprawdzanie KSeF, nie wysyłaj ich ponownie`);
  if (odrzucone.length) czesci.push(`KSeF odrzucił: ${numery(odrzucone)} — popraw i wyślij ręcznie`);
  if (czeka.length) czesci.push(`korekty czekają na numer KSeF faktury pierwotnej: ${numery(czeka)}`);
  if (pominiete.length) czesci.push(`pominięte: ${numery(pominiete)}`);
  return [{
    klucz: `faktura-ksef:automat:${awaria?.od ?? wynik.dzien}`,
    typ: 'faktura-ksef',
    tekst: `Automat KSeF: ${czesci.join('; ')}.`,
    title: 'Pełny wynik przebiegu: Faktury → automat KSeF.',
    przycisk: { href: '/faktury/ksef/automat', etykieta: 'Wynik automatu' },
    etykietaOdrzucenia: 'Ignoruj',
  }];
}

function wierszWynikuAutomatu(wynik) {
  try {
    if (!wynik?.dzien) return [];
    if (wynik.tryb) return wierszWynikuTrybu(wynik);
    const niepewne = Array.isArray(wynik.niepewne) ? wynik.niepewne : [];
    const pominiete = Array.isArray(wynik.pominiete) ? wynik.pominiete : [];
    const przerwany = wynik.stan === 'przerwany';
    if (!wynik.blad && !przerwany && !niepewne.length && !pominiete.length) return [];
    const czesci = [];
    if (przerwany) {
      czesci.push(wynik.wTrakcie?.numer
        ? `przebieg przerwany (panel uruchomił się ponownie) w trakcie wysyłki ${wynik.wTrakcie.numer} — sprawdź w inFakcie, czy ma numer KSeF, zanim wyślesz ją ponownie`
        : 'przebieg przerwany (panel uruchomił się ponownie w trakcie) — sprawdź w inFakcie, co poszło');
    }
    if (wynik.blad) czesci.push(`zatrzymał się: ${wynik.blad}`);
    if (niepewne.length) czesci.push(`NIE WIADOMO, czy poszły: ${niepewne.map((n) => n?.numer ?? '?').join(', ')} — sprawdź w inFakcie, zanim wyślesz ponownie`);
    if (pominiete.length) czesci.push(`pominięte: ${pominiete.map((p) => p?.numer ?? '?').join(', ')}`);
    return [{
      klucz: `faktura-ksef:automat:${wynik.dzien}`,
      typ: 'faktura-ksef',
      tekst: `Automat KSeF (${wynik.dzien}): ${czesci.join('; ')}.`,
      title: 'Automat sam niczego nie ponawia. Pełny wynik przebiegu: Faktury → wynik automatu KSeF.',
      przycisk: { href: '/faktury/ksef/automat', etykieta: 'Wynik automatu' },
      etykietaOdrzucenia: 'Ignoruj',
    }];
  } catch { return []; }
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
 * PRZ-108.08 (automatyzacje, C1): reguła wstrzymana bezpiecznikiem (>50 zamówień naraz) i maile, o których nie wiadomo,
 * czy wyszły (`niepewne` — zerwanie w trakcie wysyłki, restart) albo które padły (`blad`). Tylko dla admina — filtr
 * robi wołający (zamowienia/kontekst.js), bo przycisk prowadzi do Ustawień, które edytuje wyłącznie administrator.
 * Klucz wstrzymania niesie chwilę ostatniej zmiany reguły (ponowne wstrzymanie po decyzji = nowy wiersz); klucz
 * niepewnych — id najnowszego z nich (nowy kłopot przywraca odrzucony wiersz).
 * Wejście: `[{ id, nazwa, wstrzymana_powod, zmieniona_at, zalegle, niepewne, blad, ostatni_id }]`.
 */
export function ostrzezeniaAutomatyzacji({ reguly = [] } = {}) {
  const wiersze = [];
  for (const r of Array.isArray(reguly) ? reguly : []) {
    try {
      const href = `/ustawienia/automatyzacje/${r.id}`;
      if (r.wstrzymana_powod) {
        wiersze.push({
          klucz: `automatyzacja:wstrzymana:${r.id}:${r.zmieniona_at ?? ''}`,
          typ: 'automatyzacja',
          tekst: `Automatyzacja „${r.nazwa}” jest wstrzymana: ${r.wstrzymana_powod} Zaległe (${r.zalegle ?? 0}) czekają na Twoją decyzję.`,
          przycisk: { href, etykieta: 'Reguła' },
          etykietaOdrzucenia: 'Ignoruj',
        });
      }
      const n = Number(r.niepewne ?? 0) + Number(r.blad ?? 0);
      if (n > 0) {
        wiersze.push({
          klucz: `automatyzacja:niepewne:${r.id}:${r.ostatni_id ?? ''}`,
          typ: 'automatyzacja',
          tekst: `Automatyzacja „${r.nazwa}”: ${n} ${n === 1 ? 'wysyłka' : 'wysyłki'} z ostatnich 7 dni — nie wiadomo, czy mail wyszedł, albo wysyłka padła. Sprawdź w dzienniku reguły, zanim wyślesz ręcznie.`,
          przycisk: { href: `${href}?stan=bledy`, etykieta: 'Dziennik' },
          etykietaOdrzucenia: 'Ignoruj',
        });
      }
    } catch { /* uszkodzony wiersz nie ma prawa zabrać tabelki */ }
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
 * PRZ-122.B16a: próg uwagi o starej kopii bazy — 26 h to próg „kopia potrzebna” w deploy/klient/kopia.mjs,
 * więc starsza kopia znaczy, że ostatni przebieg oms-kopia się nie udał. Jedno źródło dla /health
 * (moduły/zdrowie/kopie.ts) i tabelki; alarm (budzi czujkę) zostaje przy 48 h.
 */
export const PROG_UWAGI_KOPII_H = 26;

/**
 * PRZ-122.B16a: stan kopii bazy (usługa `zdrowie.kopie`) jako wiersze tabelki. Tylko obserwacja —
 * mechanizm kopii (oms-kopia) bez zmian. Klucz starej kopii niesie datę z nazwy pliku: nowa (też stara)
 * kopia to nowe zdarzenie, więc wyciszenie 24 h poprzedniej go nie chowa.
 */
export function ostrzezeniaKopii({ kopie } = {}) {
  if (!kopie) return [];
  const wiersz = (klucz, tekst) => [{
    klucz: `integracja:kopia:${klucz}`,
    typ: 'integracja',
    tekst,
    przycisk: { href: '/ustawienia/kopie', etykieta: 'Kopie zapasowe' },
    etykietaOdrzucenia: 'Wycisz na 24 h',
  }];
  if (kopie.brakNadzoru) {
    return kopie.wymagany ? wiersz('brak-nadzoru', `Faktury ${kopie.nazwa} są tylko w bazie, a ten OMS nie widzi katalogu kopii.`) : [];
  }
  let wynik = [];
  if (!kopie.katalogDostepny) wynik = wiersz('niedostepny', 'OMS nie widzi katalogu kopii.');
  else if (!kopie.ostatnia) wynik = wiersz('brak', 'Brak kopii bazy w katalogu kopii.');
  else {
    const { plik, wiekH } = kopie.ostatnia;
    if (wiekH >= PROG_UWAGI_KOPII_H) {
      const data = /\d{4}-\d{2}-\d{2}/.exec(String(plik))?.[0] ?? String(plik);
      wynik = wiersz(`stara:${data}`, `Ostatnia kopia bazy ma ${wiekH} h — oms-kopia nie zrobił kopii w ostatniej dobie.`);
    }
  }
  if (kopie.zewnetrznaStan === 'brak-nosnika') wynik.push(...wiersz('nosnik', 'Kopia poza dyskiem nie trafia na nośnik — podłącz nośnik kopii (brak znacznika w katalogu).'));
  else if (kopie.zewnetrznaStan === 'ten-sam-dysk') wynik.push(...wiersz('nosnik', 'Kopia poza dyskiem leży na dysku serwera — nośnik kopii nie jest zamontowany.'));
  else if (kopie.zewnetrznaStan === 'stara-na-nosniku') wynik.push(...wiersz('nosnik', 'Kopia poza dyskiem nie odświeża się — na nośniku brak kopii z ostatnich 48 h (sprawdź oms-kopia).'));
  return wynik;
}

/**
 * PRZ-102.04: wiersz widzi tylko konto, które ma prawo do ekranu za jego przyciskiem.
 * Zgłoszenie: rola Produkcja dostawała „Nowa wiadomość z Allegro…” z przyciskiem
 * „Wiadomości”, a klik kończył się 403. Ta sama reguła prawa, co strażnik i menu
 * (`ekranDlaAdresu` + `maDostepDoEkranu`), więc tabelka nie obiecuje drzwi, których
 * strażnik nie otworzy.
 *
 * - `konto` null/undefined (pierwszy start, zanim powstanie admin) — pełny widok, jak
 *   `maPrawoNawigacji` w menu-stron.js.
 * - Wiersz bez przycisku albo z adresem, którego `ekranDlaAdresu` nie zna (null), ZOSTAJE:
 *   na braku danych nie chowamy — przeoczone ostrzeżenie jest gorsze niż martwy przycisk,
 *   a nieznany adres wyłapie test kompletności tras, nie ta tabelka.
 *
 * Filtruje tylko widok: lustra, odrzucenia, czuwacze i /health zostają bez zmian.
 */
export function ostrzezeniaDlaKonta({ wiersze = [], konto = null } = {}) {
  if (!konto) return wiersze;
  return wiersze.filter((w) => {
    const href = w?.przycisk?.href;
    if (!href) return true;
    const ekran = ekranDlaAdresu(href);
    if (ekran === null) return true;
    return maDostepDoEkranu(konto, ekran);
  });
}

/**
 * Filtr odrzuconych + kolejność typów. Odrzucenie trwałych typów chowa wiersz na
 * zawsze (nowe zdarzenie i tak zmienia klucz); wyciszenie `integracja` wygasa po
 * dobie. Nieparsowalna data odrzucenia POKAZUJE wiersz — na braku danych nie chowamy.
 */
export function zlozOstrzezenia({ wiersze = [], odrzucone = new Map(), teraz = new Date(), ukryteTypy = [] } = {}) {
  const t = teraz instanceof Date ? teraz.getTime() : Number(teraz);
  const widoczne = wiersze.filter((w) => {
    if (ukryteTypy.includes(w.typ)) return false;
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
