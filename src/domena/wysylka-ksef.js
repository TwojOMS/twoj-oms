// src/oms/domain/wysylka-ksef.js
//
// ⚠️⚠️ TA FUNKCJA STOI PRZED OPERACJĄ NIEODWRACALNĄ. Dokumentu wysłanego do KSeF nie da się
// skasować — zostaje wyłącznie korekta. Cała wartość tego modułu jest w tym, CZEGO NIE
// PRZEPUSZCZA, dokładnie jak przy nadaniu masowym (domain/masowe.js, przewodnik 4.13a).
//
// ⚠️ WOŁANA DWA RAZY: przy ekranie podglądu i PONOWNIE przy zatwierdzeniu. Zbiór z podglądu
// nigdy nie jest przepisywany — między jednym a drugim właściciel mógł wysłać dokument
// ręcznie w inFakcie, a wtedy drugie zgłoszenie byłoby duplikatem u organu.

import { stanKsef } from './lista-faktur.js';
import { NAZWA_ZAPASOWA } from './nazwa-programu.js';

/** Typy dokumentów, które wolno wysłać. Korekty świadomie POZA listą (decyzja z 06.08.2026). */
const WOLNO_WYSLAC = new Set(['vat']);

/** Zdanie o korekcie — jedno dla podglądu (`coWolnoWyslac`) i wiersza korekty na karcie zamówienia (PRZ-102.23). */
export const POWOD_KOREKTA = 'Korekty wysyła się w inFakcie — panel ich nie wysyła.';

/**
 * Zdanie o dokumencie, którego wysyłkę panel JUŻ ZLECIŁ — JEDNO, bo pada w DWÓCH miejscach:
 * tutaj (odsiew przed ekranem podglądu) i w services/wysylka-ksef.js (dokument odbity od
 * rezerwacji w bazie). Dwie kopie tego samego zdania rozjechałyby się przy pierwszej zmianie,
 * a człowiek dostawałby dwa różne opisy TEGO SAMEGO stanu, w odstępie jednego kliknięcia.
 *
 * ⚠️ ODSTĘP PRZED MYŚLNIKIEM SIEDZI W STAŁEJ CZĘŚCI ZDANIA, nie za interpolacją — inaczej
 * wariant bez stempla („panel nie zdążył odczytać wiersza rezerwacji") dokłada drugi odstęp.
 *
 * ⚠️ NASTĘPNY KROK JEST NAZWANY, bo panel z tego stanu sam nie wyjdzie i wyjść nie ma prawa:
 * ponowione zgłoszenie to duplikat u organu, po którym zostaje wyłącznie korekta.
 */
export function powodJuzZlecona(zleconaAt) {
  return `Panel już zlecił wysyłkę tego dokumentu do KSeF${zleconaAt ? ` (${zleconaAt})` : ''}`
    + ' — drugie zgłoszenie byłoby duplikatem u organu, a duplikatu nie da się skasować. '
    + 'Następny krok: otwórz ten dokument w inFakcie — tam widać, czy zlecenie doszło i czy ma '
    + 'już numer KSeF. Panel sam tego NIE ponowi.';
}

/**
 * Czy to dokument KONSUMENCKI, czyli wystawiony nabywcy BEZ NIP-u.
 *
 * ⚠️⚠️ TO JEST BARIERA PRZED OPERACJĄ NIEODWRACALNĄ, a nie kosmetyka listy. Do 28.08.2026
 * `coWolnoWyslac` nie pytała o NIP NIGDZIE — ani ona, ani widok, ani trasa — więc faktura
 * konsumencka miała pole wyboru i „zaznacz wszystkie" brało ją razem z resztą miesiąca.
 *
 * POMIAR NA ŻYWYM KONCIE (VI–VIII.2026): 169 faktur, 168 z NIP-em i wszystkie 168 w KSeF,
 * DOKŁADNIE JEDNA bez NIP-u — `30/06/2026` — i jej w KSeF nie ma. Ta jedna była zarazem
 * jedyną czerwcową bez numeru KSeF, więc „zaznacz wszystkie" w czerwcu zaznaczyłoby wyłącznie
 * ją i wysłało. Wysyłki do KSeF nie da się cofnąć — zostaje wyłącznie korekta.
 *
 * PRZEPIS (Ministerstwo Finansów, ksef.podatki.gov.pl): „Zarówno przed 1 lutego 2026 r. jak
 * i po tej dacie wystawianie faktur B2C (na rzecz osób prywatnych – konsumentów) w KSeF jest
 * dobrowolne". Dokument konsumencki NIE JEST więc usterką ani brakiem danych — to stan
 * normalny, przy którym KSeF jest wyborem właściciela, a panel takiego wyboru nie podejmuje
 * za niego. Decyzja właściciela 28.08.2026: blokada TWARDA, dokładnie jak przy korektach.
 * Od 20.10.2026 (PRZ-102.26) to ustawienie właściciela: domyślnie nadal blokada, po świadomym
 * włączeniu wolno wysłać B2C z danymi dokumentu i nabywcy. Pusta odpowiedź API nadal odmawia.
 *
 * ⚠️⚠️ „BRAK NIP-u" ZNACZY PUSTE POLE, A NIE „NIE WYGLĄDA JAK POLSKI NIP". Klient zagraniczny
 * (WDT) ma w `client_tax_code` numer VAT UE z prefiksem literowym — `'SK1098765431'` — i to
 * JEST podatnik, którego faktura ma iść do KSeF normalnie (domain/wdt.js: „numer zaczyna się
 * od dwóch liter" znaczy dokładnie „nabywca z innego państwa Unii"). Walidacja długości,
 * cyfr albo „dokładnie 10 znaków" zablokowałaby WDT — czyli zamieniłaby jedną cichą pomyłkę
 * na drugą, gorszą, bo dotyczącą dokumentów, które do KSeF iść MUSZĄ. Pytamy WYŁĄCZNIE, czy
 * po `trim()` cokolwiek zostało.
 *
 * ⚠️ BRAK POLA TRAKTUJEMY JAK KONSUMENCKĄ, CZYLI ODMAWIAMY. Zdegradowana odpowiedź inFaktu
 * (2xx z pustym ciałem daje dokument z samych `null`, patrz domain/lista-faktur.js) nie ma
 * prawa OTWORZYĆ drogi do operacji nieodwracalnej. Odmowa jest zawsze odwracalna — właściciel
 * wyśle dokument z inFaktu; wysyłka nie jest. To ta sama doktryna, którą moduł ma w
 * `lista-faktur.js`: na braku danych nie działamy.
 *
 * ⚠️ POLE JEST JEDNO I NAZWANE: `client_tax_code` — zweryfikowane na żywym API 28.08.2026,
 * jedyne pole tego rodzaju w odpowiedzi (obok `client_company_name`, `client_first_name`,
 * `client_last_name`, `client_country` i pozostałych `client_*`).
 */
export function czyKonsumencka(dok) {
  return String(dok?.client_tax_code ?? '').trim() === '';
}

// Brak NIP-u z nazwą lub imieniem/nazwiskiem nabywcy to B2C. Sam brak pól to zdegradowana
// odpowiedź API, nie zgoda na wysyłkę: wymagamy także numeru i kwoty (zero jest poprawną kwotą).
// Dotychczasowej ścieżki z NIP-em nie zmieniamy; przełącznik rozszerza wyłącznie B2C.
function maDaneKonsumenckiej(d) {
  return Boolean(String(d?.number ?? '').trim())
    && d?.gross_price != null && String(d.gross_price).trim() !== '' && Number.isFinite(Number(d.gross_price))
    && ['client_company_name', 'client_first_name', 'client_last_name'].some((p) => String(d?.[p] ?? '').trim());
}

function powodBlokadyKonsumenckiej(d, konsumenckie, nazwa = NAZWA_ZAPASOWA) {
  if (!czyKonsumencka(d)) return null;
  if (konsumenckie !== true) return POWOD_KONSUMENCKA;
  return maDaneKonsumenckiej(d) ? null
    : `Brak danych faktury lub nabywcy — panel nie wysyła pustej odpowiedzi ${nazwa.dopelniacz} do KSeF.`;
}

/**
 * Zdanie o dokumencie konsumenckim — JEDNO, tak jak `powodJuzZlecona` wyżej, bo pada i tutaj,
 * i (jako podpowiedź znacznika) w web/views/faktury.ejs.
 *
 * ⚠️ ANI „BŁĄD", ANI „BRAK DANYCH". Faktura bez NIP-u to normalna sprzedaż osobie prywatnej,
 * a nie usterka do naprawienia — powód ma nazwać stan, powiedzieć, że KSeF jest przy nim
 * DOBROWOLNY, i wskazać drogę, gdyby właściciel jednak chciał ten dokument wysłać.
 */
export const POWOD_KONSUMENCKA = 'Faktura konsumencka — nabywca bez NIP-u. KSeF jest przy '
  + 'takim dokumencie DOBROWOLNY (stanowisko Ministerstwa Finansów), więc panel go nie wysyła. '
  + 'Jeśli ta jedna ma jednak pojechać do KSeF, wyślij ją w inFakcie.';

/**
 * PRZ-102.12: czy dokument z listy (`services/faktury-widok.js`) dostaje pole wyboru i jest brany przez
 * „zaznacz wszystkie” na ekranie Faktur. JEDNA reguła dla dwóch miejsc: widoku `faktury.ejs` i automatu
 * KSeF (services/ksef-automat.js), który ma wysyłać dokładnie to, co przycisk po „zaznacz wszystkie”.
 * To nie jest bariera — barierą zostaje `coWolnoWyslac` niżej, liczona od nowa przy każdej wysyłce.
 */
export function doZaznaczeniaWszystkich(d, konsumenckie = false) {
  return d?.stanKsef === 'brak' && d?.rodzaj === 'vat' && !powodBlokadyKonsumenckiej(d, konsumenckie);
}

/**
 * PRZ-102.23: przycisk „Wyślij do KSeF” przy fakturze na karcie zamówienia. Karta zna dokument z NASZEJ bazy
 * (wiersz `faktury`: uuid inFaktu, numer KSeF od czuwacza, rezerwacja `wysylki_ksef`), nie z inFaktu — karta
 * nie pyta inFaktu przy otwarciu. Przycisk stoi przy fakturze VAT ze `stanKsef === 'brak'` (jak pole wyboru
 * na liście Faktur).
 *
 * ⚠️ „KONSUMENCKA” ROZSTRZYGA DOKUMENT, NIE KARTA (poprawka po recenzji PRZ-102.23). NIP na karcie to BIEŻĄCE
 * dane zamówienia — edytowalne po wystawieniu, a NIP da się też dopisać w inFakcie; ani `faktury`, ani lustro
 * `ksef_luki` nie trzymają NIP-u dokumentu. Zdanie „Faktura konsumencka” na karcie mogłoby więc zamknąć drogę
 * fakturze, którą lista Faktur wysyła. Przy braku NIP-u na karcie przycisk zostaje z dopiskiem
 * (`UWAGA_BEZ_NIP_NA_KARCIE` przy domyślnej blokadzie), a podgląd rozstrzyga na świeżym dokumencie
 * i bieżącym ustawieniu B2C (`coWolnoWyslac`).
 *
 * ⚠️ TO NIE JEST BARIERA. Przycisk prowadzi do podglądu, który liczy `coWolnoWyslac` od nowa z listy pobranej
 * z inFaktu (i jeszcze raz przy zatwierdzeniu) — dokument zmieniony w inFakcie odbije się tam z powodem.
 *
 * Oddaje `null` (faktura bez dokumentu w inFakcie — karta mówi o tym swoimi paskami), `{ wolno: false, powod }`
 * albo `{ wolno: true, uuid, miesiac, pole, uwaga? }` — dane formularza podglądu. Każdy wynik niesie też `stan`
 * (`stanKsef`: 'jest' / 'wyslana_czeka' / 'brak'), żeby kolumna stanu na karcie mówiła to samo, co lista Faktur.
 * Bez przycisku tylko na pewnych faktach panelu: numer KSeF (bez zdania: stan wiersza mówi „KSeF <numer>”)
 * i rezerwacja (`powodJuzZlecona`).
 */
export function wysylkaZKarty({ uuid, ksefNumer = null, nip = null, zleconaAt = null, dzienWystawienia = null, konsumenckie = false } = {}) {
  if (!uuid) return null;
  const stan = stanKsef({ ksef_number: ksefNumer || null }, Boolean(zleconaAt));
  if (stan === 'jest') return { wolno: false, powod: null, stan };
  if (stan !== 'brak') return { wolno: false, powod: powodJuzZlecona(zleconaAt), stan };
  const uwaga = czyKonsumencka({ client_tax_code: nip })
    ? { uwaga: konsumenckie ? 'Na karcie nie ma NIP-u nabywcy — panel sprawdzi dane dokumentu w inFakcie na ekranie podglądu.' : UWAGA_BEZ_NIP_NA_KARCIE } : {};
  // Miesiąc listy Faktur, na której ten dokument leży (filtr po dacie wystawienia). Bez daty nie zgadujemy.
  const miesiac = /^\d{4}-\d{2}-\d{2}/.test(String(dzienWystawienia ?? '')) ? String(dzienWystawienia).slice(0, 7) : null;
  if (!miesiac) {
    return { wolno: false, powod: 'Panel nie zna daty wystawienia tej faktury — wyślij ją z zakładki Faktury.', stan };
  }
  return { wolno: true, uuid, miesiac, pole: 'invoice_date', stan, ...uwaga };
}

/** Dopisek przy przycisku, gdy na karcie nie ma NIP-u nabywcy — o konsumenckiej rozstrzyga dokument w inFakcie. */
export const UWAGA_BEZ_NIP_NA_KARCIE = 'Na karcie nie ma NIP-u nabywcy — panel sprawdzi dokument w inFakcie na ekranie '
  + 'podglądu; faktury konsumenckiej do KSeF nie wyśle.';

// Jedyny adres powrotu spoza listy Faktur: karta zamówienia (sam numer, bez parametrów). Wszystko inne — w tym
// `//host`, pełny adres, `..`, tablica z powtórzonego pola — wraca na listę Faktur. Bez otwartego przekierowania.
const POWROT_NA_KARTE = /^\/zamowienia\/[1-9]\d{0,9}$/;

/**
 * PRZ-102.23: dokąd prowadzi „Wróć”/„Anuluj” na ekranach podglądu i wyniku wysyłki do KSeF. `powrot` jedzie
 * dalej w formularzu zatwierdzenia tylko wtedy, gdy przeszedł białą listę (inaczej `null`).
 */
export function powrotWysylkiKsef(powrot, { miesiac, pole } = {}) {
  if (typeof powrot === 'string' && POWROT_NA_KARTE.test(powrot)) {
    return { adres: `${powrot}#faktura`, etykieta: 'Wróć do zamówienia', powrot };
  }
  return {
    adres: `/faktury?miesiac=${encodeURIComponent(miesiac ?? '')}&pole=${encodeURIComponent(pole ?? '')}`,
    etykieta: 'Wróć do listy faktur',
    powrot: null,
  };
}

// PRZ-118.09: `nazwa` = odmiana nazwy programu fakturowego w powodach pominięcia (domyślnie inFakt).
export function coWolnoWyslac(zaznaczone, dokumenty, konsumenckie = false, nazwa = NAZWA_ZAPASOWA) {
  const doWyslania = [];
  const pominiete = [];
  const widziane = new Set();
  // ⚠️ Nie wystarczy `?? []` — zdegradowana odpowiedź API potrafi oddać PRAWDZIWY, niepusty
  // obiekt zamiast tablicy (patrz lista-faktur.js, `bierz`), a to jest truthy, więc `??` by go
  // przepuściło i `.filter` rzuciłby `TypeError` zamiast zwykłej odmowy.
  const listaDokumentow = Array.isArray(dokumenty) ? dokumenty : [];
  const poUuid = new Map(listaDokumentow.filter(Boolean).map((d) => [d.uuid, d]));

  // Jeden zaznaczony checkbox przychodzi z Fastify jako napis, kilka — jako tablica
  // (ta sama pułapka co w masowe.js, `wybraneZListy`). Bez tego `for...of` po stringu
  // iterowałby ZNAKI, nie identyfikatory.
  const lista = zaznaczone == null ? [] : [].concat(zaznaczone);

  for (const uuid of lista) {
    if (widziane.has(uuid)) continue;
    widziane.add(uuid);
    const d = poUuid.get(uuid);
    if (!d) {
      // ⚠️ POMINIĘTE MUSI WRÓCIĆ Z POWODEM — `continue`, nie `break`. Reszta zaznaczenia
      // ma zostać rozpatrzona; jedno złe id nie może uciszyć wszystkich pozostałych wierszy.
      pominiete.push({ numer: `(id ${uuid})`, powod: 'Ten dokument jest spoza listy, z której wysyłasz — panel go nie zna.' });
      continue;
    }
    // ⚠️⚠️ BIAŁA LISTA RODZAJU IDZIE PIERWSZA — PRZED KAŻDYM POWODEM WYLICZONYM ZE STANU
    // (recenzja całości, Finding A3). Do 06.08.2026 stała NIŻEJ, po `ksef_number` i po
    // `ksefZleconaAt` — więc claimowana korekta (dziś nieosiągalne: panel korekt nie rezerwuje,
    // ale kolejność ma być poprawna zanim ta droga się pojawi) dostawałaby „panel już zlecił",
    // czyli powód PRZEJŚCIOWY (sam znika po odpowiedzi inFaktu albo po dobie), zamiast powodu
    // TRWAŁEGO — korekta nie stanie się wysyłalna NIGDY, niezależnie od stanu rezerwacji.
    // Najbardziej specyficzny i najbardziej trwały powód ma wygrywać pierwszy.
    if (!WOLNO_WYSLAC.has(d.rodzaj)) {
      // Nieznany `rodzaj` to NIE korekta — odróżniamy, żeby nie wysyłać człowieka szukać
      // dokumentu w inFakcie, którego tam nigdy nie było (ta sama zasada co w masowe.js:
      // „nieznana metoda" vs. nazwany, rozpoznany przypadek).
      pominiete.push({
        numer: d.number,
        powod:
          d.rodzaj === 'korekta'
            ? POWOD_KOREKTA
            : 'Nieznany rodzaj dokumentu — panel wysyła wyłącznie faktury VAT.',
      });
      continue;
    }
    if (d.ksef_number) {
      pominiete.push({ numer: d.number, powod: `Ten dokument jest już w KSeF (${d.ksef_number}).` });
      continue;
    }
    // ⚠️⚠️ DOKUMENT KONSUMENCKI (nabywca bez NIP-u) — PRZED „panel już zlecił", a PO
    // „jest już w KSeF". Ta sama zasada kolejności, co przy białej liście rodzaju wyżej:
    // wygrywa powód najbardziej TRWAŁY i najbardziej informatywny. „Jest już w KSeF" jest
    // trwały ORAZ niesie numer, po którym człowiek odnajdzie dokument u organu, więc stoi
    // pierwszy. Przy wyłączonym B2C „konsumencka" nie znika po dobie ani po odpowiedzi
    // inFaktu — wymaga zmiany ustawienia właściciela. „Panel już zlecił" jest PRZEJŚCIOWY (sam znika),
    // więc zostaje ostatni: pokazany przy dokumencie konsumenckim kłamałby, że wystarczy
    // poczekać. Uzasadnienie i pomiar — w docblocku `czyKonsumencka` wyżej.
    const powodKonsumenckiej = powodBlokadyKonsumenckiej(d, konsumenckie, nazwa);
    if (powodKonsumenckiej) {
      pominiete.push({ numer: d.number, powod: powodKonsumenckiej });
      continue;
    }
    // ⚠️⚠️ DOKUMENT, KTÓREGO WYSYŁKĘ PANEL JUŻ ZLECIŁ. Sam `ksef_number` tego NIE ŁAPIE:
    // inFakt nadaje numer dopiero po ~70 sekundach, więc świeżo pobrana lista jest przez ten
    // czas ŚLEPA na wysyłkę zleconą przed chwilą z tego samego panelu. Bez tego warunku ekran
    // podglądu liczył taki dokument do „Poleci do KSeF" i obiecywał wysłanie czegoś, co i tak
    // odbije się od rezerwacji w bazie — czyli kłamał dokładnie tam, gdzie człowiek ma ostatnią
    // szansę złapać pomyłkę (recenzja całości, Finding 1).
    //
    // ⚠️ TO NIE JEST BARIERA ZAMIAST TAMTEJ. Gwarancją zostaje wiersz w `wysylki_ksef`
    // (db/wysylki-ksef.js): tylko on odbija dwa RÓWNOLEGŁE zatwierdzenia i tylko on wie
    // o wysyłce zleconej z drugiej karty przeglądarki. Ten warunek istnieje po to, żeby EKRAN
    // mówił prawdę o tym, co poleci — a odczyt sprzed kilkuset milisekund nigdy nie będzie
    // barierą przed operacją nieodwracalną.
    //
    // ⚠️ FAKT, NIE STAN WYLICZONY: pytamy o `ksefZleconaAt` (stempel `zlecona_at` z rezerwacji,
    // dokłada go services/faktury-widok.js), a nie o `stanKsef` — napis na ekranie wolno
    // przeredagować, fakt z tabeli nie.
    if (d.ksefZleconaAt) {
      pominiete.push({ numer: d.number, powod: powodJuzZlecona(d.ksefZleconaAt) });
      continue;
    }
    doWyslania.push({ uuid: d.uuid, numer: d.number });
  }
  return { doWyslania, pominiete };
}
