import { bladOperatora } from '../../../domena/bledy.js';
import {
  zakresMiesiaca, scalDokumenty, stanKsef, stanTerminu, opisTerminu, czekaNaPrzelew, stanZaplaty,
} from '../../../domena/lista-faktur.js';
import { zl } from '../../../domena/suma-pozycji.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { czyPaczkaBezGotowki } from '../../../domena/pobranie-zaplacone.js';
import { czyPobranie } from '../../../domena/wysylka.js';
import { OSTATNIA_ZYWA_PACZKA } from '../../wysylka/db/ostatnia-paczka.js';

// Jedyne miejsce, które zna naraz inFakt i bazę panelu. Reguły są w domain/, I/O tutaj.
//
// ⚠️ Z BAZY BIERZEMY WYŁĄCZNIE POWIĄZANIE DOKUMENTU Z PANELEM — nigdy zdania o tym, czy
// faktura jest zapłacona (spec §4.1, decyzja właściciela 06.08.2026). Panel ma dane po temu
// (wpłaty zamówienia), ale statusy porządkuje właściciel w inFakcie, a druga prawda
// o pieniądzach zostałaby tu na zawsze. Sędzią jest inFakt — jego `status`, nie nasz rachunek.
//
// ⚠️ SPROSTOWANIE 10.08.2026: stało tu „sędzią jest `left_to_pay`" i to było zdanie o jedno
// pole za wąskie. Oznaczenie zapłaty w inFakcie NIE ZERUJE `left_to_pay`, więc pas długów
// pokazywał 67 dokumentów zamiast dwóch. Doktryna się nie zmienia — dalej rozstrzyga inFakt,
// a nie wpłaty z panelu — zmienia się pole, którego słuchamy. Reguła: `czekaNaPrzelew`
// w domain/lista-faktur.js, tam też pomiar.

// ⚠️ BIAŁA LISTA PÓL DATY — I TO NIE JEST OSTROŻNOŚĆ NA ZAPAS. Zmierzone na żywym API
// 06.08.2026: inFakt odpowiada HTTP 200 i MILCZĄCO IGNORUJE nieznany klucz filtra, więc
// ograniczenie dat po prostu znika, a zapytanie zamienia się w „całe archiwum":
//
//   q[invoice_date_gteq]=2026-07-01&q[invoice_date_lteq]=2026-07-31  → total_count  64
//   q[sale_date_gteq]=2026-07-01&q[sale_date_lteq]=2026-07-31        → total_count  61
//   q[sale_date_gteq]=2026-07-15&q[sale_date_lteq]=2026-07-15        → total_count   4
//   q[nie_ma_takiego_gteq]=2026-07-01&q[nie_ma_takiego_lteq]=…       → total_count 329
//   q[invoice_date_bzdura]=2026-07-01                                → total_count 329
//
// OBA pola z listy niżej są więc zmierzone i realnie zawężają — nie tylko `invoice_date`.
// Różnica między nimi jest realna, nie kosmetyczna: przykładowa faktura `3/08/2026` ma
// `sale_date: 2026-07-31`, ale `invoice_date: 2026-08-03` — dokument sprzedażowo należy do
// lipca, a wystawiony jest w sierpniu. Po to jest ten przełącznik.
//
// Literówka tutaj NIE WYWALA SIĘ — ONA ROZSZERZA. To dokładnie ta awaria, przed którą stoi
// strażnik miesiąca niżej, więc pole daty musi przechodzić przez tę samą bramkę. Ta sama
// rodzina pułapki, co przy `order` z nieistniejącym polem (komentarz w infakt/client.js).
// Każdą nową nazwę dopisaną tu trzeba WCZEŚNIEJ sprawdzić na żywym API.
const POLA_DATY = new Set(['invoice_date', 'sale_date']);

// Zamówienia po `faktury.infakt_uuid` — jedno zapytanie na całą listę, nie jedno na wiersz.
const POWIAZANIA = `
  SELECT f.infakt_uuid AS uuid, z.id AS zamowienie_id, z.numer AS zamowienie_numer
  FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id
  WHERE f.infakt_uuid IS NOT NULL
`;

// ⚠️ DRUGIE ŹRÓDŁO DOKUMENTÓW WYSTAWIONYCH Z PANELU. Faktura zbiorcza klienta dropshippingowego
// nie ma wiersza w `faktury` — jej `infakt_uuid` leży w `okresy_rozliczeniowe` (jeden dokument
// na cały miesiąc, patrz db/okresy.js). Bez tego mapowania cały pieniądz B2B renderowałby się
// z `zamowienie: null`, czyli nie do odróżnienia od faktury wklepanej wprost w inFakcie.
//
// Osobne zapytanie na CAŁĄ listę, tak samo jak wyżej — nie jedno na wiersz.
const POWIAZANIA_OKRESOW = `
  SELECT infakt_uuid AS uuid, id, klient_klucz, rok, miesiac
  FROM okresy_rozliczeniowe
  WHERE infakt_uuid IS NOT NULL
`;

// ⚠️⚠️ TRZECIE ŹRÓDŁO FAKTÓW O DOKUMENCIE: WYSYŁKI ZLECONE Z PANELU (recenzja całości,
// Finding 1). Bez tego mapowania lista pokazywała „brak KSeF" przez ~70 sekund po wysyłce,
// którą sama zleciła — razem z polem wyboru i z licznikiem na czerwonym przycisku. inFakt
// nadaje numer dopiero po tym czasie (docblock `wyslijDokumentDoKsef` w infakt/client.js), więc
// `ksef_number` z listy jest wtedy ŚLEPY na fakt, który panel ma u siebie w bazie.
//
// ⚠️ KLUCZEM JEST UUID inFAKTU — dokładnie to, co trzyma ta tabela i co przychodzi na
// dokumencie z listy. Dzięki temu widać także rezerwację dokumentu wystawionego POZA panelem
// (taki nie ma wiersza ani w `faktury`, ani w `okresy_rozliczeniowe`, a wysłać go wolno).
//
// JEDNO zapytanie na CAŁĄ listę, tak samo jak dwa mapowania wyżej — nie jedno na wiersz.
const ZLECONE_WYSYLKI = `SELECT uuid, zlecona_at FROM wysylki_ksef`;

// ⚠️ CZWARTE ŹRÓDŁO FAKTÓW: POBRANIA, PRZY KTÓRYCH GOTÓWKI NIE MA. Bez niego nieodebrana
// paczka znika z pasa długów razem z doręczonymi (patrz `czekaNaPrzelew`) — a to jedyny realny
// dług w tym zbiorze. JEDNO zapytanie na CAŁĄ listę.
//
// ⚠️⚠️ ROZSTRZYGA `czyPaczkaBezGotowki` (domain/pobranie-zaplacone.js), NIE gołe porównanie
// z `'zwrot'` (recenzja poprawkowa 28.08.2026, W4). Ta sama funkcja rządzi ścieżką pieniędzy,
// więc obie warstwy mówią o paczce JEDNO ZDANIE. Gołe `etapPrzesylki(...) === 'zwrot'` gubiło
// NIEUDANE DORĘCZENIE („Nie doręczono — adresat nieobecny" ma etap `doreczona`): czuwacz
// przesyłek przestawał taką paczkę odpytywać, a pas długów jej nie pokazywał — dokument
// znikał z listy „kto nam zalega" NA STAŁE. Uzasadnienie i świadomie przyjęty fałszywy
// alarm — w docblocku tamtej funkcji.
//
// ⚠️⚠️ DOKŁADNIE JEDNA PACZKA NA ZAMÓWIENIE, I TO TA Z NAJNOWSZYM ZDARZENIEM U KURIERA —
// `OSTATNIA_ZYWA_PACZKA`, DOSŁOWNIE TA SAMA KLAUZULA, co w services/oznaczanie-pobran.js
// i w skrypcie sprzątającym (usterka krytyczna, Zadanie 5, K1; trzecia kopia usunięta
// 28.08.2026). Zwykły `JOIN przesylki p ON p.zamowienie_id = z.id` bez zawężenia dawałby TYLE
// wierszy, ile paczek — a przy paczce ZWRÓCONEJ ORAZ dosyłce DORĘCZONEJ dokument trafiłby do
// zbioru „bez gotówki" i wisiałby na pasie długów mimo zainkasowanej przez kuriera gotówki.
// Klauzula jest `LEFT JOIN`: zamówienie bez ani jednej żywej paczki zostaje w wyniku z pustymi
// kolumnami statusu, a reguła niżej odpowiada przy nim „gotówka może jeszcze przyjść".
//
// ⚠️ PREFILTR CZYTA OBIE DROGI DO POBRANIA, A ROZSTRZYGA `czyPobranie` (usterka krytyczna,
// recenzja poprawkowa 28.08.2026, W3). `z.pobranie` to wartość ZE SKLEPU, a o pobraniu naprawdę
// rozstrzyga wartość EFEKTYWNA — nadpisanie z karty (`wysylka_reczna_json`, `czyPobranie` w
// domain/wysylka.js) wygrywa z kolumną, w OBIE strony. Zamówienie złożone BEZ pobrania
// i przełączone na nie RĘCZNIE (`zapiszNadpisanieWysylki` w db/zamowienia.js pisze WYŁĄCZNIE do
// `wysylka_reczna_json` i nigdy nie rusza `z.pobranie`) miało tu `z.pobranie = 0` i wypadało z
// tego zapytania PRZED regułą. Odwrotny kierunek był gorszy, bo cichy: zamówienie sklepowe
// Z pobraniem przełączone na PRZEDPŁATĘ przechodziło prefiltr i — po zwrocie paczki — lądowało
// na pasie długów jako „zwrócone pobranie", choć pobrania już tam nie ma. Trzy warstwy mówiły
// wtedy o jednym zamówieniu trzy różne zdania.
//
// ⚠️ SORTOWANIE PORÓWNUJE NAPISY W RÓŻNYCH FORMATACH — patrz komentarz przy
// `OSTATNIA_ZYWA_PACZKA` (services/oznaczanie-pobran.js).
const POBRANIA_PRZESYLKI = `
  SELECT
    f.infakt_uuid AS uuid, z.pobranie, z.wysylka_reczna_json,
    p.status_kuriera, p.status_kuriera_kod
  FROM faktury f
  JOIN zamowienia z ON z.id = f.zamowienie_id
  ${OSTATNIA_ZYWA_PACZKA}
  WHERE f.infakt_uuid IS NOT NULL AND (z.pobranie = 1 OR z.wysylka_reczna_json IS NOT NULL)
`;

export function createFakturyWidok({ db, infakt }) {
  function powiazania() {
    const zamowienia = new Map();
    for (const w of db.prepare(POWIAZANIA).all()) {
      zamowienia.set(w.uuid, { id: w.zamowienie_id, numer: w.zamowienie_numer });
    }
    const okresy = new Map();
    for (const w of db.prepare(POWIAZANIA_OKRESOW).all()) {
      okresy.set(w.uuid, { id: w.id, klient: w.klient_klucz, rok: w.rok, miesiac: w.miesiac });
    }
    const wysylkiKsef = new Map();
    for (const w of db.prepare(ZLECONE_WYSYLKI).all()) wysylkiKsef.set(w.uuid, w.zlecona_at);
    const bezGotowki = new Set();
    for (const w of db.prepare(POBRANIA_PRZESYLKI).all()) {
      // Wartość EFEKTYWNA rozstrzyga, czy to w ogóle jest pobranie — prefiltr SQL tylko
      // zawęża. Zamówienie przełączone RĘCZNIE na przedpłatę nie jest „zwróconym pobraniem",
      // choćby paczka wróciła: pobrania przy nim nie ma i nikt gotówki nie oczekiwał.
      if (!czyPobranie(w)) continue;
      if (czyPaczkaBezGotowki(w)) bezGotowki.add(w.uuid);
    }
    return {
      zamowienia, okresy, wysylkiKsef, bezGotowki,
    };
  }

  // ⚠️ `d` bywa `null`: zdegradowana odpowiedź inFaktu potrafi wstawić pustą pozycję do
  // `entities`, a ekran ma się wtedy wyrenderować z pustym wierszem, a nie wywalić całą
  // zakładkę. Stąd `d?.` i spread po `(d ?? {})`.
  //
  // `zamowienie` i `okres` wykluczają się nawzajem W PRAKTYCE — dokument należy najwyżej do
  // jednego z dwóch światów (pojedyncze zamówienie ALBO miesiąc klienta zbiorczego), a brak
  // obu znaczy „wystawione poza panelem" i NIE jest błędem. To NIEZMIENNIK NIEEGZEKWOWANY
  // PRZEZ KOD: `wzbogac` dokłada oba pola niezależnie, po tym samym `uuid`, z dwóch osobnych
  // map, więc gdyby ten sam `infakt_uuid` trafił kiedyś do obu tabel, dokument dostałby OBA
  // pola naraz. Test „gdy ten sam infakt_uuid trafi do obu tabel (sztucznie)…" w
  // tests/oms/faktury-widok.test.js wymusza tę kolizję celowo i pina dzisiejsze zachowanie.
  function wzbogac(d, mapy, dzis) {
    // ⚠️ STEMPEL REZERWACJI JEDZIE NA DOKUMENCIE, a nie tylko w wyliczonym `stanKsef`. Bariera
    // (`coWolnoWyslac` w domain/wysylka-ksef.js) pyta o FAKT, nie o napis — a ekran pokazuje
    // po nim, KIEDY panel zlecił tę wysyłkę, bo to jest pierwsza rzecz, której szuka człowiek
    // sprawdzający dokument w inFakcie.
    const ksefZleconaAt = mapy.wysylkiKsef.get(d?.uuid) ?? null;
    return {
      ...(d ?? {}),
      zamowienie: mapy.zamowienia.get(d?.uuid) ?? null,
      okres: mapy.okresy.get(d?.uuid) ?? null,
      stanKsef: stanKsef(d, Boolean(ksefZleconaAt)),
      ksefZleconaAt,
      stanTerminu: stanTerminu(d?.payment_date, dzis),
      opisTerminu: opisTerminu(d?.payment_date, dzis),
      // ⚠️ KWOTY Z inFAKTU SĄ LICZBAMI CAŁKOWITYMI W GROSZACH — zmierzone 06.08.2026:
      // `gross_price: 88842` to 888,42 zł. Podanie tego wprost na ekran (albo podzielenie
      // przez 100 na floatach) daje kwoty rozjechane o dwa rzędy wielkości; `zl()` z
      // domain/suma-pozycji.js jest jedynym przeliczeniem, które tu wolno zrobić.
      kwotaZl: zl(Number(d?.gross_price ?? 0)),
      pozostaloZl: zl(Number(d?.left_to_pay ?? 0)),
      // ⚠️ STAN, NIE KWOTA. Do 28.08.2026 widok sam rozstrzygał zapłatę porównaniem
      // `Number(pozostaloZl) > 0` — czyli czytał `left_to_pay`, pole, które oznaczenie
      // zapłaty w inFakcie zostawia nietknięte. Kwota zostaje na obiekcie, ale wolno ją
      // pokazać WYŁĄCZNIE przy `do_zaplaty`.
      stanZaplaty: stanZaplaty(d),
    };
  }

  async function dokumenty({ miesiac, pole = 'invoice_date', dzis = dzienWarszawa(new Date().toISOString()) } = {}) {
    const zakres = zakresMiesiaca(miesiac);
    if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
    if (!POLA_DATY.has(pole)) {
      throw bladOperatora(
        `„${pole ?? ''}" to nie jest pole daty, po którym można filtrować faktury — `
        + `dozwolone są tylko: ${[...POLA_DATY].join(', ')}.`,
      );
    }
    const pytanie = { ...zakres, pole };
    const [faktury, korekty] = await Promise.all([infakt.listaFaktur(pytanie), infakt.listaKorekt(pytanie)]);
    const mapy = powiazania();
    return scalDokumenty(faktury, korekty).map((d) => wzbogac(d, mapy, dzis));
  }

  // ⚠️ TU CELOWO NIE ROBIMY „?? []" / `Array.isArray ? x : []` — inaczej niż `dokumenty()`
  // i inaczej niż `scalDokumenty` w domain/lista-faktur.js. Ta lista mówi właścicielowi, KTO
  // MU ZALEGA PIENIĄDZE; zdegradowana odpowiedź inFaktu, cicho zamieniona w pustą tablicę,
  // wyrenderowałaby się jako „nikt nie zalega" — a to nie jest brak informacji, to fałszywe
  // zdanie. Ten sam kompromis co przy `wszystkieStrony` w infakt/client.js: milczenie kosztuje
  // tu więcej niż odmowa, więc kontener, który nie jest tablicą, ma dać `bladOperatora`, a nie
  // pustą listę. Tolerancja na poziomie POJEDYNCZEGO WIERSZA (np. `null` w tablicy) zostaje —
  // to obsługuje `wzbogac` niżej przez `d ?? {}`.
  async function nieoplacone({ dzis = dzienWarszawa(new Date().toISOString()) } = {}) {
    const lista = await infakt.listaNieoplaconych();
    if (!Array.isArray(lista)) {
      throw bladOperatora(
        'inFakt oddał listę nieopłaconych faktur w formacie, którego panel nie rozumie — '
        + 'nie pokazujemy jej, żeby pusta tabela nie znaczyła „nikt nie zalega".',
      );
    }
    const mapy = powiazania();
    // ⚠️ ODSIEW JEST TUTAJ, A NIE W ZAPYTANIU — świadomie. Zapytanie zawęża tanio
    // (`q[left_to_pay_gt]=0`, zmierzone), ale ROZSTRZYGA czysta reguła, którą widać i którą
    // trzymają testy. Dołożenie do URL-a drugiego `q[...]` kosztowałoby dwie ciche awarie
    // naraz: nieznany klucz ransacka nie wywala się, tylko ROZSZERZA zapytanie do całego
    // archiwum (pomiar 06.08.2026, komentarz przy `POLA_DATY` wyżej), a `not_eq` na kolumnie
    // z NULL-em po cichu gubi wiersze — na ekranie długów obie kończą się liczbą, której nikt
    // nie ma jak zakwestionować. Lista ma 67 wierszy, więc filtrowanie u siebie nic nie kosztuje.
    return lista
      .filter((d) => czekaNaPrzelew(d, { pobranieBezGotowki: mapy.bezGotowki.has(d?.uuid) }))
      .map((d) => wzbogac(d, mapy, dzis));
  }

  /**
   * Proformy jednego miesiąca serii.
   *
   * ⚠️ FILTRUJEMY PO PARZE (`rok`, `miesiac`) Z WIERSZA, A NIE PO `utworzona_at`. Dwa powody,
   * oba zmierzone na tym kodzie:
   *
   *  1. `utworzona_at` to UTC (`new Date().toISOString()` w db/proformy.js), a miesiąc, o który
   *     pyta operator, jest warszawski. Proforma wystawiona 1 września o 00:30 leży w bazie
   *     jako '2026-08-31T22:30Z' i po `substr(...,1,10)` wpadała do SIERPNIA — znikając
   *     z września, mimo że na PDF-ie u klienta stoi `PF/…/09/2026`.
   *  2. `zapiszProforme` przyjmuje `rok`/`miesiac` WPROST (dokument „za poprzedni miesiąc"),
   *     a numer serii składa się właśnie z nich. Filtr po stemplu potrafił więc wsadzić
   *     dokument numer `PF/3/07/2026` do listy sierpniowej.
   *
   * Rozstrzyga NUMER WYDRUKOWANY NA DOKUMENCIE, bo to on stoi w tytule przelewu klienta.
   * Przy okazji zapytanie trafia w indeks `proformy_kolejny` (rok, miesiac, kolejny) zamiast
   * skanować całą tabelę, a pytanie o strefę czasową znika z tego miejsca na dobre.
   *
   * ⚠️ Proformy UNIEWAŻNIONE zostają na liście — klient dostał taki dokument mailem i może go
   * mieć przed sobą, więc ekran musi umieć powiedzieć „ten już nie obowiązuje". Ukrycie ich
   * znaczyłoby, że operator nie widzi dokumentu, o który dzwoni klient.
   */
  function proformy({ miesiac } = {}) {
    const zakres = zakresMiesiaca(miesiac);
    if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
    // Format sprawdził już `zakresMiesiaca` — tu tylko rozbieramy go na liczby serii.
    const [rok, nrMiesiaca] = String(miesiac).trim().split('-').map(Number);
    return db.prepare(`
      SELECT p.*, z.numer AS zamowienie_numer, z.id AS zamowienie_id
      FROM proformy p JOIN zamowienia z ON z.id = p.zamowienie_id
      WHERE p.rok = ? AND p.miesiac = ?
      ORDER BY p.kolejny DESC, p.id DESC
    `).all(rok, nrMiesiaca);
  }

  return { dokumenty, nieoplacone, proformy };
}
