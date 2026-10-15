import { odczytajNadpisania, obiektAlboPusty, tekst } from './dane-reczne.js';
// ⚠️ Z `kwoty.js`, NIE z `suma-pozycji.js` (07.08.2026) — mimo że tamten moduł dalej obie
// funkcje re-eksportuje. Od chwili, gdy suma zaczęła pytać o efektywną kwotę wysyłki,
// import stamtąd zamykał cykl `suma-pozycji → wysylka-kwota → pozycje-reczne → suma-pozycji`.
// Powód w całości opisany w nagłówku domain/kwoty.js.
import { grosze, zl } from './kwoty.js';
import { bladOperatora } from './bledy.js';
import { bruttoZNetto } from './vat.js';

// ⚠️ PO CO TO ISTNIEJE. „Klient napisze, że chce dodatkowy szablon albo usługę i musi
// dopłacić" — zamówienie w sklepie zostaje takie, jakie było, a pozycja dochodzi U NAS.
// Do tego operator musi móc poprawić pozycję, którą sklep już przysłał (uzgodniona inna
// ilość, inna cena, czytelniejsza nazwa na fakturze).
//
// Obie te rzeczy rozbijają się o ten sam mur: poller synchronizuje sklep CO DWIE MINUTY,
// a `zapiszPozycje` w db/zamowienia.js kasuje pozycje i wstawia je od nowa (przewodnik OMS,
// 4.7). Dlatego:
//
//  1. POZYCJA RĘCZNA to wiersz w tabeli `pozycje` o `zrodlo = 'reczna'` — dokładnie tak samo,
//     jak wpłata ręczna w tabeli `platnosci`. Synchronizacja operuje WYŁĄCZNIE na wierszach
//     źródła 'sklep' i to jest cała ochrona tej pozycji.
//  2. POPRAWKA POZYCJI SKLEPOWEJ to NADPISANIE PER POLE w `zamowienia.pozycje_reczne_json` —
//     kolumnie, której synchronizacja nie dotyka. Wpisana wprost w wiersz sklepowy zniknęłaby
//     w dwie minuty razem z całym wierszem.
//
// ⚠️ NADPISANIE JEST POLOWE, NIE WIERSZOWE — z tego samego powodu, co przy danych klienta
// (domain/dane-reczne.js): gdyby w kolumnie leżała kopia całego wiersza, zmiana samej ilości
// ZAMRAŻAŁABY nazwę i cenę na zawsze i poprawka ceny w sklepie nigdy by już nie doszła.
// W środku leży `{"s4321": {"ilosc": 3}}`, czyli wyłącznie to, co faktycznie odbiega.

/**
 * Pola, które operator może nadpisać. SKU CELOWO nie ma na liście: to identyfikator towaru
 * w sklepie, a nie uzgodnienie z klientem — podmiana SKU zrobiłaby z pozycji inny produkt,
 * nie ten sam produkt na innych warunkach.
 */
export const POLA_POZYCJI = ['nazwa', 'ilosc', 'cena_brutto'];

// Pola, po których zmianie kwota linii przestaje pochodzić ze sklepu i musi zostać
// przeliczona u nas (patrz nalozNadpisaniaPozycji).
const POLA_KWOTOWE = ['ilosc', 'cena_brutto'];

/**
 * Trwały identyfikator pozycji — to on jedzie w adresie formularza i to pod nim leży
 * nadpisanie.
 *
 * ⚠️ NASZE `pozycje.id` SIĘ DO TEGO NIE NADAJE. Poller kasuje i wstawia pozycje sklepowe
 * przy każdej synchronizacji, więc ich `id` zmienia się co dwie minuty: formularz otwarty
 * minutę wcześniej celowałby w nieistniejący wiersz, a nadpisanie zapisane pod starym `id`
 * osierociałoby się samo. Dlatego dla pozycji ze sklepu bierzemy identyfikator linii
 * U ŹRÓDŁA (`line_items[].id` z Woo) — jedyną wartość, którą synchronizacja odtwarza
 * niezmienioną.
 *
 * Numer porządkowy jest WYŁĄCZNIE zapasem dla wierszy sprzed dołożenia `zrodlo_id`, których
 * migracja nie umiała uzupełnić (brak `surowe_json`, zmieniona liczba pozycji). Jest gorszy
 * i wiadomo dlaczego: gdyby sklep usunął pozycję z zamówienia, numery przesunęłyby się
 * i nadpisanie trafiłoby na INNY produkt. Zapas znika sam przy pierwszej synchronizacji
 * tego zamówienia — a to lepsze niż wiersz, którego w ogóle nie da się poprawić.
 *
 * Wiersz ręczny identyfikujemy naszym `id`, bo sklep o nim nie wie, a poller go nie kasuje,
 * więc `id` jest przy nim trwałe.
 */
export function kluczPozycji(p, index) {
  if (p?.zrodlo === 'reczna') return `r${p.id}`;
  return p?.zrodlo_id != null ? `s${p.zrodlo_id}` : `p${index}`;
}

// Ilość: liczba CAŁKOWITA większa od zera.
//
// Przecinek dziesiętny przyjmujemy (panel już tak działa przy wadze paczki i przy wpłacie),
// ale wartość ułamkowa dostaje jawną odmowę, nie ciche zaokrąglenie. Powód jest arytmetyczny,
// nie estetyczny: cała ta warstwa liczy na liczbach CAŁKOWITYCH w groszach, a 0,01 zł × 1,5
// szt. to półtora grosza — czyli dokładnie ten rodzaj rozjazdu, przed którym broni bariera
// arytmetyczna faktury. Kolumna `pozycje.ilosc` jest zresztą INTEGER-em.
// Eksportowana od 07.08.2026, bo edycja wysyłki (domain/wysylka-kwota.js) przyjmuje ilość
// TYMI SAMYMI regułami — łącznie z odmową ułamka. Druga kopia oznaczałaby, że „1,5 paczki"
// przechodzi tam, gdzie „1,5 szt." się odbija.
export function parsujIlosc(surowa) {
  const t = String(surowa ?? '').trim().replace(',', '.');
  if (!t) throw bladOperatora('Podaj ilość — bez niej nie wiadomo, za ile sztuk klient ma zapłacić.');
  const n = Number(t);
  if (!Number.isFinite(n)) throw bladOperatora(`Ilość nie jest liczbą: "${surowa}".`);
  if (!Number.isInteger(n)) {
    throw bladOperatora(`Ilość musi być liczbą całkowitą: "${surowa}". Ułamek sztuki panel policzyłby z zaokrągleniem.`);
  }
  if (n <= 0) throw bladOperatora('Ilość musi być większa od zera.');
  return n;
}

// Czy sklep sam wycenil ten wiersz na ZERO. Celowo NIE przez `grosze()`: ta rzuca przy
// pustej i nieliczbowej wartosci, a tutaj brak ceny sklepowej (kanal jej nie przysyla,
// wiersz jest nowy) ma znaczyc „nie ma z czym porownac", a nie awarie.
const sklepMaZero = (cena) => cena != null && String(cena).trim() !== '' && Number(cena) === 0;

// Cena brutto za sztukę. Wartości ujemne odrzucamy WPROST: po cichu zmniejszałyby kwotę
// oczekiwaną od klienta i mogły zdjąć z zamówienia niedopłatę.
//
// ⚠️ ZERO ROZSTRZYGA SIĘ WOBEC SKLEPU, a nie w próżni (20.08.2026, usterka zam. 1192).
// Reguła pieniężna zostaje dokładnie ta sama, co była: wpisanie zera tam, gdzie sklep
// policzył pieniądze, ZDEJMUJE klientowi koszt — to decyzja o pieniądzach i dalej jest
// odmową. Nowa jest wyłącznie druga strona tej samej reguły: zero tam, gdzie sklep TEŻ ma
// zero, niczego nie zmienia. To nie jest decyzja, tylko przepisanie wartości, którą
// formularz sam wyświetlił.
//
// ⚠️ DLACZEGO TO W OGÓLE MUSIAŁO SIĘ ZMIENIĆ. Formularz „Zapisz pozycje" odsyła WSZYSTKIE
// wiersze naraz, także te nietknięte. Przy darmowej dostawie (albo pozycji gratis) taki
// wiersz niesie `0.00`, więc bezwarunkowa odmowa wywracała CAŁY zapis zamówienia z powodu
// wiersza, którego nikt nie dotknął — żadnej pozycji w takim zamówieniu nie dało się
// poprawić. `parsujNowaPozycje` woła tę funkcję BEZ ceny sklepowej i tam zero pozostaje
// odmową: nowa pozycja za 0 zł nie wymaga dopłaty, więc nie jest tym, o co chodzi.
export function parsujCeneBrutto(surowa, { cenaSklepu } = {}) {
  const t = String(surowa ?? '').trim().replace(',', '.');
  if (!t) throw bladOperatora('Podaj cenę brutto za sztukę — bez niej nie ma czego doliczyć.');
  if (!Number.isFinite(Number(t))) throw bladOperatora(`Cena brutto nie jest liczbą: "${surowa}".`);
  const gr = grosze(t, 'cena pozycji');
  // Wylacznie ROWNE zeru — ujemna leci nizej nawet przy zerowej cenie sklepowej.
  if (gr === 0 && sklepMaZero(cenaSklepu)) return zl(gr);
  if (gr <= 0) throw bladOperatora('Cena brutto musi być większa od zera.');
  return zl(gr);
}

function parsujNazwe(surowa) {
  const t = tekst(surowa);
  if (!t) throw bladOperatora('Podaj nazwę pozycji — bez niej nie wiadomo, za co klient płaci.');
  return t;
}

/**
 * Nowa pozycja ręczna z formularza „Dodaj pozycję".
 *
 * `brutto_linii` liczymy TUTAJ, w groszach, i zapisujemy razem z pozycją — bo to ono jedzie
 * na fakturę (`gross_price` w inFakcie to SUMA LINII) i do sumy pod tabelą. Mnożenie na
 * floatach (0,07 × 3 = 0,21000000000000002) rozjeżdżałoby się z barierą arytmetyczną.
 *
 * Netto CELOWO nie powstaje jako druga wartość do zapisania: przy pozycji ręcznej wartością
 * źródłową jest brutto, a netto jest wyłącznie wygodniejszym sposobem JEGO PODANIA (patrz
 * bruttoZNetto w domain/vat.js) albo tym, co karta pokazuje po zapisie. Zapisane do bazy
 * zaczęłoby z czasem wyglądać jak dana źródłowa i ktoś wysłałby je na fakturę.
 */
export function parsujNowaPozycje(body) {
  const nazwa = parsujNazwe(body?.nazwa);
  const ilosc = parsujIlosc(body?.ilosc);
  // Brutto wygrywa, gdy podane: to ono jest wartoscia PRZECHOWYWANA, a netto tylko
  // wygodniejszym sposobem jej podania (domain/vat.js: bruttoZNetto).
  const wprost = String(body?.cena_brutto ?? '').trim();
  const zNetto = wprost === '' ? bruttoZNetto(body?.cena_netto) : null;
  const cenaBrutto = parsujCeneBrutto(wprost !== '' ? wprost : zNetto);
  return {
    nazwa,
    sku: tekst(body?.sku),
    ilosc,
    cena_brutto: cenaBrutto,
    brutto_linii: zl(grosze(cenaBrutto, `pozycja "${nazwa}"`) * ilosc),
  };
}

/**
 * Edycja pozycji — te same trzy pola, ta sama walidacja, BEZ SKU. Wynik jest już
 * znormalizowany (nazwa przycięta, ilość liczbą, cena z dwoma miejscami), więc porównanie
 * ze sklepem w roznicePozycji() nie może zobaczyć zmiany tam, gdzie zmieniło się wyłącznie
 * to, jak człowiek zapisał tę samą wartość („61,5" wobec „61.50").
 */
export function parsujEdycjePozycji(body, sklep) {
  return {
    nazwa: parsujNazwe(body?.nazwa),
    ilosc: parsujIlosc(body?.ilosc),
    cena_brutto: parsujCeneBrutto(body?.cena_brutto, { cenaSklepu: sklep?.cena_brutto }),
  };
}

/**
 * Ilość i cena w tej samej postaci, w jakiej wychodzą z `parsujEdycjePozycji` — inaczej
 * porównanie „2" z 2 albo „61.5" z „61.50" pokazywałoby zmianę tam, gdzie jej nie ma,
 * i zamrażało pole na zawsze.
 *
 * Wydzielone z `sklepowoZnormalizowane` 07.08.2026, bo WYSYŁKA porównuje się dokładnie tymi
 * samymi dwiema regułami (domain/wysylka-kwota.js), a nazwy nie ma — druga kopia rozjechałaby
 * się z tą przy pierwszej zmianie sposobu zaokrąglania.
 */
export function znormalizujKwotowe(p) {
  return {
    ilosc: Number(p?.ilosc),
    cena_brutto: p?.cena_brutto == null ? null : String(Number(p.cena_brutto).toFixed(2)),
  };
}

function sklepowoZnormalizowane(p) {
  return { nazwa: tekst(p?.nazwa), ...znormalizujKwotowe(p) };
}

/**
 * Co zapisać po wysłaniu formularza edycji: WYŁĄCZNIE pola odbiegające od sklepu. Ta sama
 * zasada i ten sam powód, co przy roznice() w domain/dane-reczne.js — przeglądarka odsyła
 * komplet pól, więc zapis całości zamrażałby dane, których nikt nie tknął.
 */
export function roznicePozycji(zeSklepu, zFormularza) {
  const sklep = sklepowoZnormalizowane(zeSklepu);
  const wynik = {};
  for (const pole of POLA_POZYCJI) {
    if (String(sklep[pole] ?? '') !== String(zFormularza?.[pole] ?? '')) wynik[pole] = zFormularza[pole];
  }
  return wynik;
}

/**
 * Nowa zawartość kolumny `pozycje_reczne_json` po zmianie JEDNEJ pozycji.
 *
 * Puste nadpisanie KASUJE klucz — to jest „Przywróć ze sklepu" dla pojedynczej pozycji
 * i jednocześnie sprzątanie po edycji, która wróciła do wartości sklepowych. Skasowanie
 * ostatniego klucza daje `null`, a nie `{}`: „brak poprawek" ma w bazie wyglądać tak samo
 * jak przed pierwszą edycją (dokładnie jak jsonAlboNull przy danych klienta).
 *
 * ⚠️ CELOWO nie kasuje kluczy osieroconych (pozycja zniknęła ze sklepu). Nadpisanie samo
 * niczego nie robi, dopóki nie ma do czego przylgnąć, a ciche kasowanie przy każdym zapisie
 * skasowałoby poprawkę pozycji, która akurat czeka na następną synchronizację.
 */
export function ustawNadpisaniePozycji(surowyJson, klucz, nadpisania) {
  const mapa = ustawWMapie(odczytajNadpisania(surowyJson), klucz, nadpisania);
  return Object.keys(mapa).length ? mapa : null;
}

/**
 * To samo, ale na GOTOWEJ MAPIE, nie na JSON-ie z bazy — potrzebne przy zapisie CAŁEGO panelu
 * pozycji naraz, gdzie mapa przechodzi przez tę funkcję raz na wiersz.
 *
 * ⚠️ Nie da się tego zrobić składając `ustawNadpisaniePozycji` samą ze sobą: ona zaczyna od
 * `odczytajNadpisania`, czyli od `JSON.parse`, a `JSON.parse(obiekt)` zamienia argument
 * w napis „[object Object]", rzuca i po cichu oddaje PUSTĄ mapę. Efektem byłoby skasowanie
 * wszystkich nadpisań przy zapisie drugiego wiersza — cicho, bez błędu.
 *
 * Zwraca KOPIĘ: odmowa w połowie pętli nie ma prawa zostawić w pamięci mapy pół-zmienionej.
 */
export function ustawWMapie(mapa, klucz, nadpisania) {
  const kopia = { ...(mapa ?? {}) };
  if (Object.keys(nadpisania ?? {}).length === 0) delete kopia[klucz];
  else kopia[klucz] = nadpisania;
  return kopia;
}

// Pola formularza zbiorczego. `klucz` NIE jest polem pozycji (nie da się go zmienić) — jest
// tym, co mówi, KTÓREGO wiersza dotyczy reszta.
const POLA_HURTU = ['klucz', ...POLA_POZYCJI];

// Przegladarka przysyla powtorzone pole jako tablice, a JEDNO wystapienie jako sam napis.
// Eksportowane, bo formularz zakladania zamowienia (domain/nowe-zamowienie.js) zszywa
// swoje wiersze dokladnie tak samo — jedna regula czytania rownoleglych tablic, nie dwie.
export const jakoTablica = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]));

/**
 * Wiersze z formularza „Edytuj pozycje" (cały panel naraz). Formularz niesie RÓWNOLEGŁE
 * TABLICE — `klucz[]`, `nazwa[]`, `ilosc[]`, `cena_brutto[]` — zszywane po indeksie.
 *
 * Zagnieżdżone nazwy (`pozycje[s555][nazwa]`) świadomie odpadły: `@fastify/formbody` parsuje
 * ciało zwykłym querystringiem, więc przyszłyby jako jeden płaski klucz z nawiasami w nazwie.
 *
 * ⚠️ Tablice różnej długości to ODMOWA, nie zszycie „na ile się da". Zszycie przesunęłoby
 * ceny o jeden wiersz, czyli po cichu zmieniło kwotę oczekiwaną od klienta — a to są
 * pieniądze. Tak samo żądanie bez ani jednego pola: to urwany albo obcy POST, a nie
 * „operator wyczyścił wszystkie pozycje".
 */
export function parsujHurtPozycji(body) {
  const kolumny = Object.fromEntries(POLA_HURTU.map((p) => [p, jakoTablica(body?.[p])]));
  const dlugosci = POLA_HURTU.map((p) => kolumny[p].length);
  if (dlugosci.every((d) => d === 0)) {
    throw bladOperatora('Żądanie nie niosło ani jednego pola formularza — panel niczego nie zmienił.');
  }
  if (new Set(dlugosci).size !== 1) {
    throw bladOperatora(
      'Formularz pozycji przyszedł niekompletny — każdy wiersz musi nieść tyle samo pól. Odśwież kartę i spróbuj jeszcze raz.',
    );
  }
  return kolumny.klucz.map((_, i) => Object.fromEntries(POLA_HURTU.map((p) => [p, kolumny[p][i]])));
}

/**
 * ⚠️ TU I TYLKO TU ręczne poprawki nakładają się na pozycje — dokładnie tak, jak `anulowane`
 * i `metoda_wysylki` nakładają się w warstwie odczytu (zLinii w db/zamowienia.js), i z tego
 * samego powodu: wartości pozycji czyta NARAZ tabela na karcie, suma pod nią, saldo wpłat,
 * bariera arytmetyczna faktury i pozycje wysyłane do inFaktu. Nakładanie u każdego czytelnika
 * osobno znaczyłoby, że jedno pominięte wywołanie wysyła na fakturę cenę, której panel nie
 * pokazuje.
 *
 * Wartości SKLEPOWE nie giną — leżą obok, w `sklep`, bo karta musi umieć pokazać „zmienione
 * ręcznie" i zaproponować przywrócenie, a kwota oczekiwana od klienta liczy się z RÓŻNICY
 * między jednym a drugim (patrz kwotaOczekiwanaGrosze w domain/suma-pozycji.js).
 */
// ⚠️ `obiektAlboPusty` PRZENIESIONE DO dane-reczne.js (07.08.2026) — czyta je teraz także
// moduł nadpisań wysyłki. Ta sama ostrożność, co przy `odczytajNadpisania`, i tam też mieszka.

export function nalozNadpisaniaPozycji(pozycje, surowyJson) {
  const mapa = odczytajNadpisania(surowyJson);
  return (pozycje ?? []).map((p, i) => {
    const klucz = kluczPozycji(p, i);
    const reczna = p.zrodlo === 'reczna';
    // Pozycja ręczna jest NASZA w całości — edytuje się ją wprost w wierszu (poller jej nie
    // tknie), więc nadpisania jej nie dotyczą i nie ma dla niej „wartości ze sklepu".
    const nadpisania = reczna ? {} : obiektAlboPusty(mapa[klucz]);
    const efektywna = { ...p, klucz, reczna, sklep: reczna ? null : { ...p } };

    for (const pole of POLA_POZYCJI) {
      if (Object.hasOwn(nadpisania, pole)) efektywna[pole] = nadpisania[pole];
    }
    const sklepNorm = sklepowoZnormalizowane(p);
    const efektNorm = sklepowoZnormalizowane(efektywna);
    // Liczone z PORÓWNANIA WARTOŚCI, nie z obecności klucza: gdy sklep dogoni ręczną
    // poprawkę, nie ma już czego oznaczać (ta sama zasada, co polaZmienione przy danych
    // klienta).
    efektywna.polaZmienione = POLA_POZYCJI.filter(
      (pole) => String(sklepNorm[pole] ?? '') !== String(efektNorm[pole] ?? ''),
    );

    // Kwota linii ze sklepu przestaje opisywać tę linię z chwilą, gdy człowiek zmienił ilość
    // albo cenę — trzymanie jej dalej znaczyłoby, że suma liczy się z wartości, których karta
    // już nie pokazuje. Przeliczamy w groszach: cena efektywna × ilość efektywna.
    //
    // Netto ze sklepu zeruje się razem z nią i to jest świadome: `netto_linii` jest wartością
    // ŹRÓDŁOWĄ z Woo (przewodnik 4.5) i po przecenieniu linii po prostu do niej nie pasuje.
    // Kolumnę netto liczy wtedy widok, ze stawki VAT (domain/vat.js) — jawnie i tylko do
    // pokazania. Zmiana samej NAZWY kwot nie dotyka, więc rabat linii ze sklepu się nie gubi.
    if (efektywna.polaZmienione.some((pole) => POLA_KWOTOWE.includes(pole))) {
      efektywna.brutto_linii = zl(grosze(efektywna.cena_brutto, `pozycja "${efektywna.nazwa}"`) * Number(efektywna.ilosc));
      efektywna.cena_netto = null;
      efektywna.netto_linii = null;
    }
    return efektywna;
  });
}
