import { czyKanalAllegro } from './wysylka.js';

// CZY TE PACZKE WOLNO NADAC Z OMS-U PRZEZ „Wysylam z Allegro" (WzA).
//
// To jest JEDYNA bariera miedzy kliknieciem czlowieka a KUPIONYM PRZEWOZEM. Allegro nie
// odmowi nam nic: token niesie `allegro:api:shipments:write` (zmierzone 05.08 i 10.08.2026),
// nie ma trybu probnego, nie ma sandboxa, a kupionej etykiety nie cofa sie kliknieciem.
// Dlatego decyzja jest CZYSTA — bez sieci i bez bazy — zeby dala sie przetestowac
// wyczerpujaco, i dlatego kazde „nie wiem" znaczy tutaj ODMOWE.

// ⚠️ TU WOLNO WPISAC WYLACZNIE USLUGI O `owner: ALLEGRO`.
//
// `GET /shipment-management/delivery-services` oddaje przy kazdej usludze pole `owner`.
// Zmierzone 10.08.2026 na koncie `allegro_a`: 298 uslug, z tego 292 ma
// `owner: ALLEGRO` (umowa Allegro — my nie mamy z przewoznikiem nic wspolnego) i 6 ma
// `owner: CLIENT`. Te szesc to WYLACZNIE InPost: Kurier24, miniKurier24 i Paczkomaty,
// kazda w wariancie zwyklym i „pobranie".
//
// ⚠️ DOPISANIE TU METODY INPOSTOWEJ ZNACZY PACZKE NA NASZEJ UMOWIE — czyli DRUGI, PLATNY
// przewoz do klienta, ktory swoj ma juz oplacony w cenie dostawy. To ta sama rodzina bledu,
// przed ktora broni brak wpisu `odbior_osobisty` w `DLA_METODY` (kurierzy/index.js).
// Allegro takiego zadania NIE ODRZUCI — sprawdzi wylacznie, czy mamy `credentialsId`.
//
// Identyfikatory zmierzone, nie przepisane z dokumentacji. Mapowanie idzie PO
// `delivery.method.id`, NIGDY po nazwie — nazwa to tekst, ktory Allegro zmieni bez pytania
// nas o zdanie (ta sama regula, co w domain/allegro-dostawa.js).
// ⚠️ `wymagaKonta` ODPOWIADA POLU `cashOnDelivery.forceRequireIban` USLUGI — zmierzone
// 11.08.2026 (`GET /shipment-management/delivery-services`):
//   „Allegro Kurier DPD (AD)"          cashOnDelivery: null
//   „Allegro Kurier DPD pobranie (AD)" cashOnDelivery: {"limit":6000,"currency":"PLN",
//                                        "paymentType":"WALLET_TRANSFER","forceRequireIban":false}
// `WALLET_TRANSFER` = gotowke inkasuje ALLEGRO i rozlicza przez portfel sprzedawcy, a NIE
// przewoznik na nasz rachunek. Gdyby Allegro kiedys podnioslo to na `true`, panel wysle
// przesylke bez konta i dostanie GLOSNY blad — a nie po cichu zle rozliczone pobranie.
// ⚠️⚠️ OSIEM USLUG PUNKTOWYCH I KURIERSKICH DOSZLO 18.09.2026 (zgloszenie właściciela: „nie da sie
// nadac orlena i DHL z OMS"). Ograniczenie bylo NASZE, nie Allegro: biala lista miala dwa
// wpisy przy 299 uslugach na umowie Allegro.
//
// ⚠️ IDENTYFIKATORY ZMIERZONE, NIE PRZEPISANE Z KATALOGU PO NAZWIE. Zrodlo: `delivery.method.id`
// z SUROWYCH zamowien produkcyjnych, zestawione z `GET /shipment-management/delivery-services`
// (18.09.2026: 305 uslug, 299 `owner: ALLEGRO`, 6 `owner: CLIENT`). Dopasowanie po nazwie jest
// zawodne i dlatego go nie uzyto: „Allegro Kurier DPD" daje w katalogu CZTERY trafienia,
// a uslugi DHL z naszych zamowien nie pasuja do katalogu wcale — tam nosza sufiks „(AD)".
//
// ⚠️ PUNKT ODBIORU PRZECHODZI SAM i to nie jest zalozenie: `delivery-proposals` oddaje
// `receiver.point` rowny naszej kolumnie `punkt_odbioru` (zmierzone 18.09 na zamowieniu
// z automatem ORLEN: `point: "849019"`), a adapter WzA rozlewa cala podpowiedz przez `...p`.
// Gdyby Allegro tego pola kiedys nie przyslalo, paczka pojechalaby pod adres DOMOWY
// kupujacego zamiast do automatu — dlatego zmiana tego rozlania wymaga ponownego pomiaru.
//
// ⚠️ WSZYSTKIE OSIEM SA BEZPOBRANIOWE (`cashOnDelivery: null` w katalogu). `pobranie: false`
// znaczy tu „usluga nie inkasuje", a nie „zamowienie jest przedplacone" — zamowienie
// za pobraniem na takiej usludze odbija sie o `pobranieDoWysylki`, i tak ma zostac.
export const METODY_WZA = {
  '03f26351-f683-4db2-8895-f2c599280e3c': { nazwa: 'Allegro Kurier DPD (AD)', pobranie: false, wymagaKonta: false },
  '13f26351-26fb-48d4-b5dd-f2c599280e3c': { nazwa: 'Allegro Kurier DPD pobranie (AD)', pobranie: true, wymagaKonta: false },
  '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483': { nazwa: 'Allegro One Box, One Kurier', pobranie: false, wymagaKonta: false },
  '0d83955a-4297-4169-adef-9790d53b11ff': { nazwa: 'Allegro One Kurier - dostawa jutro', pobranie: false, wymagaKonta: false },
  '09164667-daa5-42dc-8087-33d7485790ac': { nazwa: 'Allegro Automat ORLEN Paczka', pobranie: false, wymagaKonta: false },
  '09bcdcdb-c62a-41c4-ba42-f2c599280e3c': { nazwa: 'Allegro Automaty Paczkowe DPD (AD)', pobranie: false, wymagaKonta: false },
  '0960fef9-cc88-4558-b2b2-62331a20b5b2': { nazwa: 'Allegro Kurier DHL (AD)', pobranie: false, wymagaKonta: false },
  '0fe5b4af-9f09-443d-9d49-62331a20b5b2': { nazwa: 'Allegro Automat DHL BOX 24/7 (AD)', pobranie: false, wymagaKonta: false },
  '0560b75e-88c3-4b79-bcf7-62331a20b5b2': { nazwa: 'Allegro Odbiór w Punkcie DHL (AD)', pobranie: false, wymagaKonta: false },
  '0b257488-c85d-4507-b967-9b45ffbfa2e8': { nazwa: 'Allegro One Box, DPD', pobranie: false, wymagaKonta: false },
  // PRZ-124 (28.10.2026, zam. #1508). Zmierzone w katalogu: owner ALLEGRO, credentialsId null,
  // cashOnDelivery {"limit":6000,"currency":"PLN","paymentType":"WALLET_TRANSFER","forceRequireIban":false}
  // — ten sam profil pobrania, co „Kurier DPD pobranie (AD)". `delivery-proposals` #1508 oddalo
  // `receiver.point` rowny `punkt_odbioru` i kwote pobrania rowna kwocie zamowienia.
  // Wariant bez pobrania (`06af1169-…`) jest w katalogu, ale nie w zadnym zamowieniu — nie wpisany.
  '16af1169-db74-4e94-a16d-f2c599280e3c': { nazwa: 'Allegro Odbiór w Punkcie DPD Pickup pobranie (AD)', pobranie: true, wymagaKonta: false },
};

// Uslugi InPostu, ktore Allegro wystawia na umowie NADAWCY (`owner: CLIENT`, zmierzone 18.09.2026).
// Sluza WYLACZNIE do brzmienia odmowy — o zgodzie rozstrzyga `METODY_WZA`, nie ta lista.
const INPOST_UMOWA_NADAWCY = new Set([
  '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93', // Allegro Paczkomaty InPost
  'b20ef9e1-faa2-4f25-9032-adbea23e5cb9', // Allegro Paczkomaty InPost pobranie
  '5d9c7838-e05f-4dec-afdd-58e884170ba7', // Allegro Kurier24 InPost
]);

const nie = (powod) => ({ wolno: false, powod });

/**
 * @param zamowienie wiersz z tabeli `zamowienia`
 * @param deliveryMethodIdZywy `delivery.method.id` z ZADANIA, ktore wlasnie wrocilo z Allegro
 *
 * ⚠️ `deliveryMethodIdZywy` MUSI pochodzic z zywego odczytu, nigdy z kolumny w bazie.
 * Allegro NIE PODBIJA `updatedAt` przy zmianach w zamowieniu (zmierzone 05.08.2026 na
 * 10 zamowieniach, 5 rozjechanych), wiec nasza kopia bywa nieswieza Z DEFINICJI, a nie
 * przez usterke pollera. Decyzja o wydaniu pieniedzy podjeta na takiej kopii to decyzja
 * na danych sprzed doby.
 */
export function wolnoNadacZOms(zamowienie, { deliveryMethodIdZywy } = {}) {
  if (!zamowienie) return nie('Nie ma takiego zamówienia.');

  // Kanal rozstrzyga PRZED metoda — tym samym predykatem, ktory pilnuje odmowy zmiany
  // metody wysylki. Klucze sklepow i kanalow leza w JEDNEJ przestrzeni nazw (kolumna
  // `zamowienia.sklep`), wiec sam pasujacy identyfikator uslugi niczego nie dowodzi.
  if (!czyKanalAllegro(zamowienie)) {
    return nie('To zamówienie nie przyszło z Allegro — „Wysyłam z Allegro" go nie nada.');
  }

  if (zamowienie.anulowane) return nie('To zamówienie jest anulowane — nie ma czego nadawać.');

  if (!deliveryMethodIdZywy) {
    return nie('Panel nie odczytał z Allegro metody dostawy tego zamówienia — bez niej nie wolno kupować przewozu.');
  }

  const usluga = METODY_WZA[deliveryMethodIdZywy];
  if (!usluga) {
    // Rozdzielamy dwa POWODY, bo prowadza do dwoch roznych rzeczy po stronie czlowieka:
    // przy InPoscie paczke nadaje sie jak dotad, przy metodzie nieznanej trzeba sprawdzic,
    // co Allegro dolozylo do slownika. Do PRZ-124 obie dostawaly tekst o InPoscie — takze
    // DPD Pickup na umowie Allegro (zam. #1508), co odsylalo czlowieka w zla strone.
    if (INPOST_UMOWA_NADAWCY.has(deliveryMethodIdZywy)) {
      return nie(
        'Tej metody dostawy panel nie nada przez „Wysyłam z Allegro". Metody InPostu Allegro '
        + 'wystawia na WŁASNEJ UMOWIE nadawcy, a nie na swojej — paczkę nadaj jak dotąd.',
      );
    }
    // ⚠️ `INPOST_UMOWA_NADAWCY` zna 3 z 6 uslug `owner: CLIENT` (brak id Kurier24 pobranie
    // i miniKurier24 w obu wariantach) — stad zastrzezenie w tekscie, zeby zgloszenie nie
    // skonczylo sie dopisaniem InPostu do `METODY_WZA`.
    return nie(
      'Panel nie zna jeszcze tej usługi Allegro, więc jej nie nada przez „Wysyłam z Allegro" — '
      + 'paczkę nadaj jak dotąd. Jeśli to nie InPost, zgłoś usługę do sprawdzenia '
      + `(id ${deliveryMethodIdZywy}).`,
    );
  }

  return {
    wolno: true,
    deliveryMethodId: deliveryMethodIdZywy,
    usluga: usluga.nazwa,
    pobranie: usluga.pobranie,
    wymagaKonta: usluga.wymagaKonta,
  };
}

// ⚠️⚠️ POBRANIE — PIENIADZE KUPUJACEGO. Osobna, czysta regula, bo tu KAZDY blad kosztuje
// gotowke, a nie tylko przesylke.
//
// Zmierzone 11.08.2026 na zamowieniu #1148 (`13f26351-…`, „Allegro Kurier DPD pobranie (AD)"):
//   payment.type                     : "CASH_ON_DELIVERY"
//   summary.totalToPay               : 83.99 PLN
//   suggestedInput.cashOnDelivery    : {"amount":"83.99","currency":"PLN","ownerName":null,"iban":null}
//   deliveryOptions[].limits.cashOnDelivery : 6000 PLN
//
// ⚠️ KWOTA IDZIE Z PODPOWIEDZI ALLEGRO, NIGDY Z NASZEJ KOLUMNY. `zamowienia.kwota_pobrania`
// nadpisuje poller co dwie minuty (4.7), a operator moze ja nadpisac z ekranu nadania BEZ
// gornego progu — literowka „8399" zamiast „83,99" pojechalaby do kuriera taka, jaka jest.
// Allegro zna kwote, ktora kupujacy ZOBOWIAZAL SIE zaplacic, i to ona ma trafic na etykiete.
const GROSZE = (kwota) => Math.round(Number(String(kwota ?? '').replace(',', '.')) * 100);
const IBAN_PL = /^(PL)?\d{26}$/;

export function pobranieDoWysylki({
  pobranieUslugi, cashOnDelivery, limit, ownerName, iban, nadpisanieOperatora, wymaganeKonto = false,
}) {
  const maKwote = cashOnDelivery && GROSZE(cashOnDelivery.amount) > 0;

  // ⚠️ OBIE NIEZGODNOSCI SA GROZNE I KAZDA INACZEJ — dlatego dwa osobne warunki, a nie jeden.
  //  - usluga pobraniowa BEZ kwoty  = kurier nie zainkasuje nic, towar oddany za darmo;
  //  - usluga przedplacona Z kwota  = zamowienie za pobraniem jedzie jak oplacone, czyli
  //    kupujacy dostaje paczke i nikt nie prosi go o pieniadze.
  if (pobranieUslugi && !maKwote) {
    return nie('Allegro nie podało kwoty pobrania dla tej przesyłki — bez niej kurier nie zainkasowałby nic.');
  }
  if (!pobranieUslugi && maKwote) {
    return nie('To zamówienie jest za pobraniem, a wybrana usługa Allegro jest przedpłacona — panel niczego nie nadał.');
  }
  if (!pobranieUslugi) return { wolno: true, cashOnDelivery: null };

  if (String(cashOnDelivery.currency ?? '') !== 'PLN') {
    return nie(`Pobranie w walucie „${cashOnDelivery.currency}" — panel obsługuje wyłącznie PLN.`);
  }
  // Porownanie NA GROSZACH, nigdy na liczbach zmiennoprzecinkowych.
  if (limit != null && GROSZE(cashOnDelivery.amount) > GROSZE(limit)) {
    return nie(`Kwota pobrania ${cashOnDelivery.amount} PLN przekracza limit usługi (${limit} PLN).`);
  }

  // ⚠️ NADPISANIE OPERATORA NIE JEST TU HONOROWANE, ale TEZ NIE JEST PO CICHU IGNOROWANE.
  // Przy naszej umowie operator wolno zmienic kwote (dosylka, korekta). Tutaj kwota jest
  // zobowiazaniem miedzy KUPUJACYM A ALLEGRO — zmiana jej znaczylaby, ze kurier inkasuje
  // co innego, niz kupujacy widzial przy zakupie. Rozbieznosc = ODMOWA z nazwaniem obu liczb.
  if (nadpisanieOperatora != null && String(nadpisanieOperatora) !== ''
      && GROSZE(nadpisanieOperatora) !== GROSZE(cashOnDelivery.amount)) {
    return nie(
      `Wpisano kwotę pobrania ${nadpisanieOperatora} zł, a Allegro rozliczy `
      + `${cashOnDelivery.amount} zł — przy „Wysyłam z Allegro" kwota musi być ta, którą `
      + 'zobowiązał się zapłacić kupujący. Panel niczego nie nadał.',
    );
  }

  // ⚠️⚠️ NASZEGO RACHUNKU TU NIE MA I MIEC NIE MOZE — poprawka po zgloszeniu wlasciciela
  // 11.08.2026: „pobranie idzie na konto allegro a nie na nasze".
  //
  // Zmierzone na uslugze `13f26351-…`:
  //   cashOnDelivery: {"limit":6000,"currency":"PLN","paymentType":"WALLET_TRANSFER",
  //                    "forceRequireIban":false}
  //
  // `WALLET_TRANSFER` znaczy, ze gotowke od kupujacego inkasuje ALLEGRO i rozlicza ja przez
  // portfel sprzedawcy — nie przewoznik na nasz rachunek. `forceRequireIban: false` mowi
  // wprost, ze konta podawac NIE TRZEBA. Pierwsza wersja tej reguly WYMAGALA naszego IBAN-u
  // i bez niego odmawiala; wartosc ta w najlepszym razie bylaby ignorowana, a w najgorszym
  // kazalaby przewoznikowi wyslac pieniadze droga, ktorej nikt nie uzgodnil.
  //
  // ⚠️ Pole zostaje OBSLUGIWANE, bo `forceRequireIban` bywa `true` przy innych uslugach —
  // wtedy konto jest warunkiem i jego brak MA byc odmowa. Rozstrzyga USLUGA, nie my.
  if (!wymaganeKonto) {
    return { wolno: true, cashOnDelivery: { amount: String(cashOnDelivery.amount), currency: 'PLN' } };
  }

  if (!String(ownerName ?? '').trim()) return nie('Ta usługa wymaga konta do zwrotu pobrania, a panel go nie ma.');
  const kontoBezSpacji = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!IBAN_PL.test(kontoBezSpacji)) {
    return nie('Numer rachunku do pobrania w konfiguracji panelu nie wygląda na polski IBAN.');
  }

  return {
    wolno: true,
    cashOnDelivery: {
      amount: String(cashOnDelivery.amount),
      currency: 'PLN',
      ownerName: String(ownerName).trim(),
      iban: kontoBezSpacji.startsWith('PL') ? kontoBezSpacji : `PL${kontoBezSpacji}`,
    },
  };
}
