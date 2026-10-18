import { czyPobranieRozliczone, dataZaplatyPobrania } from '../../../domena/pobranie-zaplacone.js';
import { stanZaplaty } from '../../../domena/lista-faktur.js';
import { zajmijOznaczenieZaplaty } from '../db/oznaczenia-zaplaty.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { OSTATNIA_ZYWA_PACZKA } from '../db/ostatnia-paczka.js';

// DOMKNIĘCIE PĘTLI PIENIĘDZY PRZY POBRANIU (spec 2026-08-28). Kurier inkasuje gotówkę, ale
// z księgowością nie rozmawia — faktura za pobraniem zostawała więc w inFakcie NIEOPŁACONA
// na zawsze: wystawia się bez `paid_price` (czyli `left_to_pay` > 0), a oznaczenie zapłaty
// wołało się wyłącznie dla wariantu „zapłacone" (services/faktura.js).
//
// ⚠️ TO NIE JEST DRUGA PRAWDA O PIENIĄDZACH. Panel dalej NIE rozstrzyga, czy faktura jest
// zapłacona — rozstrzyga inFakt i jego `status` (spec §4.1). Panel dostarcza mu FAKT,
// którego tamten nie ma: że paczka została doręczona.
//
// ⚠️⚠️ SKAN BAZY, A NIE HAK NA PRZEJŚCIU STATUSU. Dwa powody, oba realne: paczka doręczona
// PRZED wdrożeniem nigdy żadnego przejścia nie wykona, a restart panelu w złej sekundzie
// zgubiłby zdarzenie. Skan po fakcie jest idempotentny (rezerwacja w `oznaczenia_zaplaty`)
// i sam się naprawia przy następnym przebiegu.

// Awaria JEDNOZNACZNA = inFakt odpowiedział i odrzucił (4xx). O dokumencie wiemy wtedy coś
// TRWAŁEGO — nie ma go albo inFakt go nie odda — więc wolno przestać o niego pytać. Wszystko
// inne (zerwane połączenie, 5xx, timeout) jest NIEJEDNOZNACZNE i wraca w następnym przebiegu.
// `status` niesie na wyjątku `bladOperatora` z infakt/client.js.
//
// ⚠️ CZWARTA KOPIA TEJ SAMEJ LINIJKI W REPO (services/faktura.js, services/faktura-okresu.js,
// services/wysylka-ksef.js) i tak ma na razie zostać: tamte trzy siedzą w domknięciach fabryk,
// a wyprowadzenie wspólnej funkcji dotyka trzech ścieżek wystawiania dokumentów naraz — to
// osobna zmiana, nie doczepka do poprawki czuwacza. Próg jest tu WSZĘDZIE ten sam i taki ma
// zostać; gdyby kiedykolwiek się rozjechał, rozjedzie się rozumienie słowa „jednoznaczna".
const jednoznacznaOdmowa = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;

// Kandydaci: pobranie + jest faktura + nie zlecaliśmy jeszcze oznaczenia. Etapu przesyłki
// NIE filtrujemy w SQL — rozstrzyga czysta reguła (domain/pobranie-zaplacone.js), którą
// widać i którą trzymają testy. Wierszy jest tu kilkadziesiąt, więc odsianie u siebie nic
// nie kosztuje; ta sama zasada, co przy pasie długów w services/faktury-widok.js.
// ⚠️ DATY WYSTAWIENIA TU NIE MA I NIE DA SIĘ JEJ STĄD WZIĄĆ. Tabela `faktury` trzyma
// wyłącznie `utworzona_at` (moment zapisu wiersza przez panel), a `paid_date` wcześniejsza
// niż wystawienie kończy się odmową inFaktu. Prawdziwa data przychodzi z `pobierzFakture`.
//
// ⚠️⚠️ DOKŁADNIE JEDNA PACZKA NA FAKTURĘ, I TO TA Z NAJNOWSZYM ZDARZENIEM U KURIERA
// (recenzja 28.08.2026, K1). Zwykły `LEFT JOIN przesylki ON p.zamowienie_id = z.id` dawał
// TYLE wierszy, ile paczek — a reguła niżej chodzi po WIERSZU, więc wystarczyła JEDNA
// doręczona paczka, żeby faktura poszła do inFaktu jako opłacona. Prawdziwy scenariusz
// pieniędzy: paczka z pobraniem WRÓCIŁA ZWROTEM (klient nie odebrał, gotówki nie ma),
// a dosyłka wysłana BEZ pobrania (wymiana z reklamacji — kwota pobrania na ekranie nadania
// jest jednorazowa i nie zapisuje się do zamówienia) została doręczona. Skan oznaczał
// wtedy fakturę jako opłaconą przy ZEROWEJ gotówce.
//
// Dlaczego „najnowsze zdarzenie", a nie „którakolwiek doręczona": to jedyna reguła, która
// trafia OBA kierunki. Doręczona 25.08 + zwrot 26.08 → ostatnie zdarzenie to zwrot → NIE
// wysyłamy, patrzy człowiek. Zwrot + dosyłka doręczona → wysyłamy z datą dosyłki.
//
// `status <> 'blad'` to ustalony w tym repo idiom „żywej paczki" (db/przesylki.js,
// `zywePrzesylki`) — nieudane nadanie nie ma prawa rządzić rozliczeniem. `kolejnosc DESC`
// rozstrzyga remis, gdy kurier nie oddał ani jednego stempla czasu (`status_kuriera_at`
// bywa puste): wygrywa paczka nadana później.
//
// Przy okazji znika drugi `GET` na ten sam dokument, zawyżone `kandydatow`/`pominiete`/
// `bezDaty` i PODWÓJNA identyczna linia w logu zamówienia w jednym przebiegu.
//
// ⚠️ PREFILTR CZYTA OBIE KOLUMNY, A DECYDUJE REGUŁA. `z.pobranie` to wartość ZE SKLEPU,
// a `czyPobranie` (domain/wysylka.js) rozstrzyga po wartości EFEKTYWNEJ — nadpisanie
// z karty (`wysylka_reczna_json`) wygrywa z kolumną. Zamówienie przełączone RĘCZNIE na
// pobranie ma `z.pobranie = 0` i przy węższym warunku NIGDY nie zostawało kandydatem:
// nie trafiało do żadnego kubełka, więc cisza w liczbach niczego o nim nie mówiła.
// ⚠️ Klauzula „jedna paczka na zamowienie" PRZENIESIONA 31.08.2026 do `db/ostatnia-paczka.js` —
// czwartym czytelnikiem jest teraz warstwa `db/` (kandydaci ostrzezenia o zwroconym pobraniu),
// a ta nie ma prawa importowac z serwisu. Uzasadnienie samej reguly zostalo przy definicji.

const KANDYDACI = `
  SELECT
    z.id AS zamowienie_id, z.numer AS zamowienie_numer, z.pobranie, z.wysylka_reczna_json,
    f.infakt_uuid, f.numer AS faktura_numer,
    p.status_kuriera, p.status_kuriera_kod, p.status_kuriera_at
  FROM faktury f
  JOIN zamowienia z ON z.id = f.zamowienie_id
  ${OSTATNIA_ZYWA_PACZKA}
  WHERE f.infakt_uuid IS NOT NULL
    AND f.infakt_uuid NOT IN (SELECT uuid FROM oznaczenia_zaplaty)
    AND (z.pobranie = 1 OR z.wysylka_reczna_json IS NOT NULL)
`;

// ⚠️⚠️ SUFIT NA JEDEN PRZEBIEG — ten sam wzorzec i ten sam powód, co `LIMIT_PRZEBIEGU`
// w services/czuwacz-ksef.js (recenzja poprawkowa 28.08.2026, W6). Pętla niżej jest
// SEKWENCYJNA, a jeden kandydat to `GET` PLUS ewentualny `POST`, każdy z cierpliwością
// `LIMIT_ZADANIA_MS` = 60 s (infakt/client.js). Bez sufitu jeden przebieg przy dłuższej awarii
// inFaktu rósłby bez żadnej granicy, a czuwacz przesyłek, w którym ten skan chodzi, tyka co
// godzinę i ma strażnik „jeden przebieg naraz" (`trwa`): przebieg dłuższy niż odstęp NIE
// ZGŁASZA BŁĘDU — po prostu ZJADA następne tyknięcia, po cichu.
//
// 20 x (60 s + 60 s) = 40 min, czyli najgorszy przypadek tego skanu mieści się w godzinie.
// ⚠️ To jest budżet SAMEGO SKANU. Pętla odpytywania kurierów przed nim własnego sufitu nie ma
// (services/czuwacz-przesylek.js) — to osobna sprawa i celowo jej tu nie rozstrzygamy;
// dokładamy granicę tam, gdzie jej dotąd nie było wcale, zamiast udawać, że liczymy całość.
//
// Realna lista jest jednocyfrowa (kilka pobrań na tydzień), więc sufit widać wyłącznie po
// awarii albo na pierwszym przebiegu po wdrożeniu, gdy zaległość historyczna jest większa.
// Nic wtedy nie przepada: skan jest idempotentny, a resztę bierze następne tyknięcie.
export const LIMIT_PRZEBIEGU_POBRAN = 20;

/**
 * Jeden przebieg skanu. ŻADEN DOKUMENT NIE MA PRAWA GO PRZERWAĆ.
 *
 * ⚠️ AWARIA POJEDYNCZEGO DOKUMENTU JEST NIESZKODLIWA I MUSI TAKA ZOSTAĆ — ten skan chodzi
 * w czuwaczu przesyłek, który pilnuje WSZYSTKICH paczek. Rzucenie stąd zatrzymałoby
 * śledzenie z powodu jednej faktury. Dlatego łapiemy WSZYSTKO (nie tylko `bladOperatora` —
 * także `TypeError` z naszego kodu), zapisujemy do logu zamówienia i jedziemy dalej.
 * Jedynym skutkiem nieudanego zlecenia jest STATUS W inFAKCIE, czyli stan sprzed projektu.
 *
 * ⚠️⚠️ CAŁE CIAŁO PĘTLI SIEDZI W `try`, I TO JEST TREŚĆ TEJ OBIETNICY (recenzja 28.08.2026,
 * W1). Wcześniej `try` obejmowały WYŁĄCZNIE dwa wywołania sieciowe i trzy `dopiszLog`, więc
 * reszta była naga: `pobierzFakture` oddające `null` (2xx z pustym ciałem) dawało `TypeError`
 * na `dok.invoice_date`, a rzucający `zajmijOznaczenieZaplaty` (SQLITE_BUSY, naruszenie
 * `CHECK`) — wyjątek z bazy. Oba WYCHODZIŁY Z FUNKCJI, a następny kandydat w przebiegu nie
 * był nawet odpytany. Węższe `try` w środku ZOSTAJĄ: niosą własne komunikaty i to one
 * odróżniają „awarię odczytu" (bez rezerwacji, wolno ponowić) od „awarii zlecenia"
 * (rezerwacja zostaje, ponawiać NIE WOLNO). Zewnętrzny łapie całą resztę.
 *
 * ⚠️ Poza zasięgiem tego `try` zostaje jedynie ODCZYT KANDYDATÓW z bazy (`db.prepare(...)`)
 * — awaria samego SQLite to nie jest „awaria dokumentu" i czuwacz przesyłek ma na nią
 * własną bramkę (services/czuwacz-przesylek.js).
 *
 * Oddaje `{ kandydatow, obsluzone, ponadSufit, zlecone, pominiete, bezDaty, bledy }`.
 * `bezDaty` stoi OSOBNO od `bledy` i od `zlecone` celowo — nic się nie zepsuło i nic nie
 * poszło, a wiersz czeka na człowieka; wliczony w błędy zapalałby czujkę awarii, wliczony
 * w zlecone byłby kłamstwem.
 *
 * ⚠️ `kandydatow` LICZY WSZYSTKICH, a `obsluzone`/`ponadSufit` mówią, ilu z nich wzięliśmy
 * na ten przebieg. Obcięcie ma być SŁYCHAĆ: cicha różnica między „nie było nic do zrobienia"
 * a „nie zdążyliśmy" jest dokładnie tą, której nikt później nie odtworzy z logu.
 */
export async function oznaczDoreczonePobrania({ db, infakt, limit = LIMIT_PRZEBIEGU_POBRAN }) {
  // Panel bez klienta inFaktu ma po prostu nie mieć tego kroku — to nie jest awaria.
  if (!infakt?.oznaczZaplacona || !infakt?.pobierzFakture) {
    return {
      kandydatow: 0, obsluzone: 0, ponadSufit: 0, zlecone: 0, pominiete: 0, bezDaty: 0, bledy: 0,
    };
  }

  const wiersze = db.prepare(KANDYDACI).all().filter((w) => czyPobranieRozliczone({
    zamowienie: w, przesylka: w, uuidFaktury: w.infakt_uuid,
  }));
  // Sufit STOI NA WYNIKU REGUŁY, nie na `LIMIT` w SQL: liczba kandydatów ma być prawdziwa,
  // a nie obcięta zanim ktokolwiek ją policzy. Wierszy jest kilkadziesiąt, więc to nic nie
  // kosztuje — ta sama zasada, co przy odsiewaniu etapu u siebie zamiast w zapytaniu.
  const doObslugi = wiersze.slice(0, limit);

  let zlecone = 0;
  let pominiete = 0;
  let bezDaty = 0;
  let bledy = 0;
  for (const w of doObslugi) {
    // ⚠️ CAŁE CIAŁO PĘTLI W JEDNYM `try` — patrz docblock. Ten `catch` jest siatką pod
    // WSZYSTKIM, czego nie łapią węższe bloki niżej: `TypeError` z naszego kodu, wyjątek
    // sterownika SQLite przy rezerwacji, cokolwiek dojdzie tu w przyszłości.
    try {
      // ⚠️ ODCZYT PRZED REZERWACJĄ, I W TEJ KOLEJNOŚCI. Potrzebujemy stąd DWÓCH rzeczy:
      // prawdziwej `invoice_date` (w bazie panelu jej nie ma) oraz AKTUALNEGO stanu zapłaty —
      // właściciel oznacza część pobrań ręcznie i taki dokument ma wypaść z kandydatów.
      // Rezerwacja przed odczytem zamykałaby dokument na zawsze po zwykłym 503.
      let dok;
      try {
        // eslint-disable-next-line no-await-in-loop -- dokumenty sekwencyjnie, jak w czuwaczu KSeF
        dok = await infakt.pobierzFakture(w.infakt_uuid);
      } catch (e) {
        bledy += 1;
        // ⚠️ PRZ-093.10 (P2 z recenzji): odmowa POŚREDNIKA „inFakt z Ustawień” (klucz odłączony do restartu,
        // piaskownica bez atrapy) niesie 4xx, ale to nie jest odpowiedź inFaktu o tym dokumencie — do inFaktu nic
        // nie poszło. Bez rezerwacji i bez wpisu w logu zamówienia; przerywamy przebieg, bo każdy następny dokument
        // dostałby tę samą odmowę. Po ponownym podłączeniu następny przebieg oznaczy pobrania jak zwykle.
        if (e?.bezInfaktu) break;
        // ⚠️⚠️ ODMOWA JEDNOZNACZNA (4xx) NIE MA PRAWA WRACAĆ CO GODZINĘ (recenzja poprawkowa
        // 28.08.2026, W5). Faktura SKASOWANA w inFakcie — przepływ wprost wspierany — oddaje
        // 404 NA ZAWSZE: bez rezerwacji byłby jeden `GET` na godzinę, jedna linia w logu
        // ZAMÓWIENIA na godzinę i stała lampka w logu procesu, czyli fałszywy alarm, który
        // uczy ignorować całą tę linię. Rezerwacja z własnym powodem zamyka dokument ŚWIADOMIE
        // i zostawia go w bazie do odróżnienia od zlecenia, które naprawdę poszło.
        //
        // ⚠️ Odmowa NIEJEDNOZNACZNA (5xx, timeout, zerwane połączenie) zostaje jak była: błąd,
        // BEZ rezerwacji, następny przebieg ma prawo spróbować. Domyślna odpowiedź na niewiedzę
        // musi być ostrożna — dokument, którego nie umieliśmy odczytać raz, jutro się odczyta.
        const jednoznaczna = jednoznacznaOdmowa(e);
        if (jednoznaczna) {
          zajmijOznaczenieZaplaty(db, w.infakt_uuid, {
            powod: 'nieznana_w_infakcie', dataZaplaty: null,
          });
        }
        try {
          dopiszLog(db, w.zamowienie_id, {
            akcja: 'faktura',
            wynik: jednoznaczna
              ? 'UWAGA: paczka za pobraniem została doręczona, ale inFakt NIE ZNA faktury '
                + `${w.faktura_numer ?? '(bez numeru)'} (odrzucił odczyt) — panel NIE ZLECIŁ `
                + 'oznaczenia zapłaty i NIE BĘDZIE PONAWIAŁ. Jeśli dokument został skasowany '
                + 'w inFakcie, nie ma tu nic do zrobienia; jeśli nie — sprawdź go ręcznie. '
                + `Powód: ${e.message}`
              : 'Paczka za pobraniem doręczona, ale inFakt nie oddał dokumentu, więc panel '
                + `nie zlecił oznaczenia zapłaty. Spróbuje ponownie. Powód: ${e.message}`,
          });
        } catch { /* celowo puste */ }
        continue;
      }

      // ⚠️⚠️ ZDEGRADOWANA ODPOWIEDŹ inFAKTU TO AWARIA ODCZYTU, A NIE ZGODA NA WYSYŁKĘ
      // (recenzja poprawkowa 28.08.2026, K1 — BLOKUJĄCE). `zapytaj` (infakt/client.js) oddaje
      // `dane = null` dla KAŻDEJ odpowiedzi 2xx, której ciała nie da się sparsować, a
      // `pobierzFakture` składa wtedy dokument z samych `null`-i. `stanZaplaty` mówi na taki
      // dokument `nieznany` — i dopóki sprawdzaliśmy tu wyłącznie `=== 'zaplacona'`, skan
      // JECHAŁ DALEJ i wysyłał `POST /paid.json`. Ten `GET` istnieje DOKŁADNIE po to, żeby
      // dokument oznaczony ręcznie przez właściciela wypadł z kandydatów; przy jednej złej
      // odpowiedzi nie robił tego, a `bledy: 0, zlecone: 1` było nie do odróżnienia od czystego
      // sukcesu. Do tego rezerwacja `pobranie_doreczone` zostawała, funkcji zwalniającej nie ma,
      // więc dokument nie wracał NIGDY.
      //
      // To odwrócenie doktryny z domain/lista-faktur.js: „ODSIEWAMY WYŁĄCZNIE NA DOWÓD ZAPŁATY,
      // nigdy na braku danych". Tam brak danych zostawia dokument na liście długów; tutaj
      // ma zostawić go NIETKNIĘTEGO. Brak rezerwacji jest tu treścią: stan jest PRZEJŚCIOWY,
      // więc ponowienie za godzinę to właściwa odpowiedź.
      if (stanZaplaty(dok) === 'nieznany') {
        bledy += 1;
        try {
          dopiszLog(db, w.zamowienie_id, {
            akcja: 'faktura',
            wynik: 'UWAGA: paczka za pobraniem została doręczona, ale inFakt oddał dokument BEZ '
              + 'STATUSU I BEZ KWOTY DO ZAPŁATY, więc panel nie wie, czy faktura '
              + `${w.faktura_numer ?? '(bez numeru)'} nie została już opłacona ręcznie — NIE `
              + 'ZLECIŁ oznaczenia zapłaty i w inFakcie zostaje na razie jako NIEOPŁACONA. '
              + 'Panel spróbuje ponownie przy następnym przebiegu.',
          });
        } catch { /* celowo puste */ }
        continue;
      }

      // Ta sama reguła, co na ekranie i w pasie długów — nie drugi warunek dopisany tutaj.
      if (stanZaplaty(dok) === 'zaplacona') {
        pominiete += 1;
        // Rezerwacja ZE ZNANYM POWODEM: nie ma tu nic do zrobienia, a bez wiersza skan pytałby
        // inFakt o ten dokument co godzinę do końca świata.
        zajmijOznaczenieZaplaty(db, w.infakt_uuid, { powod: 'juz_zaplacona', dataZaplaty: null });
        continue;
      }

      const paidDate = dataZaplatyPobrania(w, dok.invoice_date);

      // ⚠️⚠️ `null` ZNACZY „NIE ZNAMY ŻADNEJ DATY" (kontrakt `dataZaplatyPobrania` od Poprawki 1,
      // 28.08.2026): kurier nie oddał stempla czasu, a `invoice_date` z inFaktu nie jest
      // poprawną datą. Zmyślona albo pusta data w DOKUMENCIE KSIĘGOWYM jest gorsza niż brak
      // oznaczenia, więc do inFaktu nie idzie NIC.
      //
      // ⚠️ REZERWACJA MIMO BRAKU WYSYŁKI, i to jest decyzja: bez wiersza skan wracałby do tego
      // dokumentu co godzinę i co godzinę dopisywał tę samą linię do logu zamówienia. Powód
      // 'brak_daty' odróżnia go w bazie od zlecenia, które faktycznie poszło — skrypt
      // sprzątający ma po czym rozdzielić kubełki.
      if (!paidDate) {
        bezDaty += 1;
        zajmijOznaczenieZaplaty(db, w.infakt_uuid, { powod: 'brak_daty', dataZaplaty: null });
        try {
          dopiszLog(db, w.zamowienie_id, {
            akcja: 'faktura',
            wynik: 'UWAGA: paczka za pobraniem została doręczona, ale panel NIE ZNA daty zapłaty '
              + '(kurier nie podał czasu doręczenia, a inFakt nie podał daty wystawienia), więc '
              + `NIE ZLECIŁ oznaczenia faktury ${w.faktura_numer ?? '(bez numeru)'} jako opłaconej `
              + '— w inFakcie zostanie jako NIEOPŁACONA. Przestaw jej status ręcznie. Panel NIE '
              + 'ponowi tego sam.',
          });
        } catch { /* celowo puste */ }
        continue;
      }

      // ⚠️ REZERWACJA PRZED ZLECENIEM. `201` z inFaktu znaczy „przyjęto zlecenie", nie
      // „oznaczono" — po awarii NIEJEDNOZNACZNEJ (zerwane połączenie, 5xx) dokument MÓGŁ już
      // zostać oznaczony, więc ponowienie byłoby zgadywaniem. Wiersz zostaje, a wyjściem jest
      // człowiek i skrypt sprzątający.
      const { zajete } = zajmijOznaczenieZaplaty(db, w.infakt_uuid, {
        powod: 'pobranie_doreczone', dataZaplaty: paidDate,
      });
      // Równoległy przebieg zdążył pierwszy — nic się nie stało, po prostu nie nasza kolej.
      if (!zajete) continue;

      let wynik;
      try {
        // eslint-disable-next-line no-await-in-loop -- jak wyżej
        await infakt.oznaczZaplacona(w.infakt_uuid, { paidDate });
        zlecone += 1;
        // ⚠️ „ZLECONO", NIGDY „OZNACZONO" — panel nie sprawdza, czy status się zmienił.
        wynik = 'Paczka za pobraniem doręczona — zlecono w inFakcie oznaczenie faktury '
          + `${w.faktura_numer ?? '(bez numeru)'} jako opłaconej (data zapłaty ${paidDate}). `
          + 'inFakt przetwarza to zadanie w tle.';
      } catch (e) {
        bledy += 1;
        wynik = 'UWAGA: paczka za pobraniem została doręczona, ale nie udało się zlecić '
          + `oznaczenia faktury ${w.faktura_numer ?? '(bez numeru)'} jako opłaconej — `
          + 'w inFakcie zostanie jako NIEOPŁACONA. Przestaw jej status ręcznie. Panel NIE '
          + `ponowi tego sam, bo zlecenie mogło dojść mimo błędu. Powód: ${e.message}`;
      }
      // Nawet zapis do logu nie ma prawa wywalić przebiegu.
      try { dopiszLog(db, w.zamowienie_id, { akcja: 'faktura', wynik }); } catch { /* celowo puste */ }
    } catch (e) {
      // Awaria SPOZA dwóch znanych dróg (odczyt / zlecenie) — nie wiemy, czy rezerwacja
      // powstała, więc niczego tu nie zakładamy i nie sprzątamy. Liczy się jako błąd, żeby
      // zegar zapalił własną linię w logu procesu (bootstrap.js), i idziemy do następnego.
      bledy += 1;
      try {
        dopiszLog(db, w.zamowienie_id, {
          akcja: 'faktura',
          wynik: 'UWAGA: paczka za pobraniem została doręczona, ale rozliczenie faktury '
            + `${w.faktura_numer ?? '(bez numeru)'} przerwała awaria panelu — w inFakcie `
            + 'zostanie jako NIEOPŁACONA. Sprawdź jej status ręcznie. '
            + `Powód: ${e?.message ?? e}`,
        });
      } catch { /* celowo puste */ }
      continue;
    }
  }

  return {
    kandydatow: wiersze.length,
    obsluzone: doObslugi.length,
    ponadSufit: wiersze.length - doObslugi.length,
    zlecone,
    pominiete,
    bezDaty,
    bledy,
  };
}
