import { czyKanalAllegro } from './wysylka.js';

// CZY TĘ PACZKĘ WOLNO NADAĆ Z OMS-U PRZEZ „Wysyłam z Allegro" (WzA).
//
// To jest JEDYNA bariera między kliknięciem człowieka a KUPIONYM PRZEWOZEM. Allegro nie
// odmówi nam nic: token niesie `allegro:api:shipments:write` (sprawdzone pomiarem),
// nie ma trybu próbnego, nie ma sandboxa, a kupionej etykiety nie cofa się kliknięciem.
// Dlatego decyzja jest CZYSTA — bez sieci i bez bazy — żeby dała się przetestować
// wyczerpująco, i dlatego każde „nie wiem" znaczy tutaj ODMOWĘ.

// ⚠️ TU WOLNO WPISAĆ WYŁĄCZNIE USŁUGI O `owner: ALLEGRO`.
//
// `GET /shipment-management/delivery-services` oddaje przy każdej usłudze pole `owner`.
// Zmierzone w katalogu: prawie wszystkie usługi (kilkaset) mają `owner: ALLEGRO` (umowa
// Allegro — my nie mamy z przewoźnikiem nic wspólnego), a sześć ma `owner: CLIENT`. Te sześć
// to WYŁĄCZNIE InPost: Kurier24, miniKurier24 i Paczkomaty, każda w wariancie zwykłym
// i „pobranie".
//
// ⚠️ DOPISANIE TU METODY INPOSTOWEJ ZNACZY PACZKĘ NA NASZEJ UMOWIE — czyli DRUGI, PŁATNY
// przewóz do klienta, który swój ma już opłacony w cenie dostawy. To ta sama rodzina błędu,
// przed którą broni brak wpisu `odbior_osobisty` w mapie „metoda → kurier” (`metody` kurierów
// w rejestrze `MODULY_KURIEROW`, domena/moduly-kurierow.ts).
// Allegro takiego żądania NIE ODRZUCI — sprawdzi wyłącznie, czy mamy `credentialsId`.
//
// Identyfikatory zmierzone, nie przepisane z dokumentacji. Mapowanie idzie PO
// `delivery.method.id`, NIGDY po nazwie — nazwa to tekst, który Allegro zmieni bez pytania
// nas o zdanie (ta sama reguła, co w domena/allegro-dostawa.js).
// ⚠️ `wymagaKonta` ODPOWIADA POLU `cashOnDelivery.forceRequireIban` USŁUGI — zmierzone
// w `GET /shipment-management/delivery-services`:
//   „Allegro Kurier DPD (AD)"          cashOnDelivery: null
//   „Allegro Kurier DPD pobranie (AD)" cashOnDelivery: {"limit":6000,"currency":"PLN",
//                                        "paymentType":"WALLET_TRANSFER","forceRequireIban":false}
// `WALLET_TRANSFER` = gotówkę inkasuje ALLEGRO i rozlicza przez portfel sprzedawcy, a NIE
// przewoźnik na nasz rachunek. Gdyby Allegro kiedyś podniosło to na `true`, panel wyśle
// przesyłkę bez konta i dostanie GŁOŚNY błąd — a nie po cichu źle rozliczone pobranie.
// ⚠️⚠️ BIAŁA LISTA JEST OGRANICZENIEM NASZYM, NIE ALLEGRO: usługa, której tu nie ma, nie nada
// się z OMS-u, choć Allegro by ją przyjęło. Usługa spotykana w zamówieniach wymaga wpisu.
//
// ⚠️ IDENTYFIKATORY ZMIERZONE, NIE PRZEPISANE Z KATALOGU PO NAZWIE. Źródło: `delivery.method.id`
// z SUROWYCH prawdziwych zamówień, zestawione z `GET /shipment-management/delivery-services`.
// Dopasowanie po nazwie jest zawodne i dlatego go nie użyto: „Allegro Kurier DPD" daje
// w katalogu CZTERY trafienia, a usługi DHL z zamówień nie pasują do katalogu wcale — tam noszą
// sufiks „(AD)".
//
// ⚠️ PUNKT ODBIORU PRZECHODZI SAM i to nie jest założenie: `delivery-proposals` oddaje
// `receiver.point` równy naszej kolumnie `punkt_odbioru` (zmierzone na zamówieniu
// z automatem ORLEN), a adapter WzA rozlewa całą podpowiedź przez `...p`.
// Gdyby Allegro tego pola kiedyś nie przysłało, paczka pojechałaby pod adres DOMOWY
// kupującego zamiast do automatu — dlatego zmiana tego rozlania wymaga ponownego pomiaru.
//
// ⚠️ USŁUGI Z `pobranie: false` NIE INKASUJĄ — przy zmierzonych `cashOnDelivery` jest `null`.
// `pobranie: false` znaczy tu „usługa nie inkasuje", a nie „zamówienie jest przedpłacone" — zamówienie
// za pobraniem na takiej usłudze odbija się o `pobranieDoWysylki`, i tak ma zostać.
export const METODY_WZA = {
  '03f26351-f683-4db2-8895-f2c599280e3c': { nazwa: 'Allegro Kurier DPD (AD)', pobranie: false, wymagaKonta: false },
  '13f26351-26fb-48d4-b5dd-f2c599280e3c': {
    nazwa: 'Allegro Kurier DPD pobranie (AD)',
    pobranie: true,
    wymagaKonta: false,
  },
  '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483': { nazwa: 'Allegro One Box, One Kurier', pobranie: false, wymagaKonta: false },
  '0d83955a-4297-4169-adef-9790d53b11ff': {
    nazwa: 'Allegro One Kurier - dostawa jutro',
    pobranie: false,
    wymagaKonta: false,
  },
  '09164667-daa5-42dc-8087-33d7485790ac': {
    nazwa: 'Allegro Automat ORLEN Paczka',
    pobranie: false,
    wymagaKonta: false,
  },
  '09bcdcdb-c62a-41c4-ba42-f2c599280e3c': {
    nazwa: 'Allegro Automaty Paczkowe DPD (AD)',
    pobranie: false,
    wymagaKonta: false,
  },
  '0960fef9-cc88-4558-b2b2-62331a20b5b2': { nazwa: 'Allegro Kurier DHL (AD)', pobranie: false, wymagaKonta: false },
  '0fe5b4af-9f09-443d-9d49-62331a20b5b2': {
    nazwa: 'Allegro Automat DHL BOX 24/7 (AD)',
    pobranie: false,
    wymagaKonta: false,
  },
  '0560b75e-88c3-4b79-bcf7-62331a20b5b2': {
    nazwa: 'Allegro Odbiór w Punkcie DHL (AD)',
    pobranie: false,
    wymagaKonta: false,
  },
  '0b257488-c85d-4507-b967-9b45ffbfa2e8': { nazwa: 'Allegro One Box, DPD', pobranie: false, wymagaKonta: false },
  // Zmierzone w katalogu: owner ALLEGRO, credentialsId null,
  // cashOnDelivery {"limit":6000,"currency":"PLN","paymentType":"WALLET_TRANSFER","forceRequireIban":false}
  // — ten sam profil pobrania, co „Kurier DPD pobranie (AD)". `delivery-proposals` prawdziwego zamówienia
  // oddało `receiver.point` równy `punkt_odbioru` i kwotę pobrania równą kwocie zamówienia.
  // Wariant bez pobrania (`06af1169-…`) jest w katalogu, ale nie w żadnym zamówieniu — nie wpisany.
  '16af1169-db74-4e94-a16d-f2c599280e3c': {
    nazwa: 'Allegro Odbiór w Punkcie DPD Pickup pobranie (AD)',
    pobranie: true,
    wymagaKonta: false,
  },
};

// Usługi InPostu, które Allegro wystawia na umowie NADAWCY (`owner: CLIENT`, zmierzone w katalogu).
// Służą WYŁĄCZNIE do brzmienia odmowy — o zgodzie rozstrzyga `METODY_WZA`, nie ta lista.
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
 * ⚠️ `deliveryMethodIdZywy` MUSI pochodzić z żywego odczytu, nigdy z kolumny w bazie.
 * Allegro NIE PODBIJA `updatedAt` przy zmianach w zamówieniu (zmierzone: w próbce rozjechała
 * się mniej więcej połowa zamówień), więc nasza kopia bywa nieświeża Z DEFINICJI, a nie
 * przez usterkę pollera. Decyzja o wydaniu pieniędzy podjęta na takiej kopii to decyzja
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
    // Rozdzielamy dwa POWODY, bo prowadzą do dwóch różnych rzeczy po stronie człowieka:
    // przy InPoście paczkę nadaje się jak dotąd, przy metodzie nieznanej trzeba sprawdzić,
    // co Allegro dołożyło do słownika. Wspólny tekst o InPoście dostałaby też usługa innego
    // przewoźnika na umowie Allegro, której brak na liście — i odesłałby człowieka w złą stronę.
    if (INPOST_UMOWA_NADAWCY.has(deliveryMethodIdZywy)) {
      return nie(
        'Tej metody dostawy panel nie nada przez „Wysyłam z Allegro". Metody InPostu Allegro ' +
          'wystawia na WŁASNEJ UMOWIE nadawcy, a nie na swojej — paczkę nadaj jak dotąd.',
      );
    }
    // ⚠️ `INPOST_UMOWA_NADAWCY` zna 3 z 6 uslug `owner: CLIENT` (brak id Kurier24 pobranie
    // i miniKurier24 w obu wariantach) — stad zastrzezenie w tekscie, zeby zgloszenie nie
    // skonczylo sie dopisaniem InPostu do `METODY_WZA`.
    return nie(
      'Panel nie zna jeszcze tej usługi Allegro, więc jej nie nada przez „Wysyłam z Allegro" — ' +
        'paczkę nadaj jak dotąd. Jeśli to nie InPost, zgłoś usługę do sprawdzenia ' +
        `(id ${deliveryMethodIdZywy}).`,
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

// ⚠️⚠️ POBRANIE — PIENIĄDZE KUPUJĄCEGO. Osobna, czysta reguła, bo tu KAŻDY błąd kosztuje
// gotówkę, a nie tylko przesyłkę.
//
// Zmierzone na zamówieniu za pobraniem (`13f26351-…`, „Allegro Kurier DPD pobranie (AD)"):
//   payment.type                     : "CASH_ON_DELIVERY"
//   summary.totalToPay               : 83.99 PLN
//   suggestedInput.cashOnDelivery    : {"amount":"83.99","currency":"PLN","ownerName":null,"iban":null}
//   deliveryOptions[].limits.cashOnDelivery : 6000 PLN
//
// ⚠️ KWOTA IDZIE Z PODPOWIEDZI ALLEGRO, NIGDY Z NASZEJ KOLUMNY. `zamowienia.kwota_pobrania`
// nadpisuje poller przy każdej synchronizacji (reguła: dane ręczne obok danych sklepu), a operator
// może ją nadpisać z ekranu nadania BEZ górnego progu — literówka „8399" zamiast „83,99"
// pojechałaby do kuriera taka, jaka jest. Allegro zna kwotę, którą kupujący ZOBOWIĄZAŁ SIĘ
// zapłacić, i to ona ma trafić na etykietę.
const GROSZE = (kwota) => Math.round(Number(String(kwota ?? '').replace(',', '.')) * 100);
const IBAN_PL = /^(PL)?\d{26}$/;

export function pobranieDoWysylki({
  pobranieUslugi,
  cashOnDelivery,
  limit,
  ownerName,
  iban,
  nadpisanieOperatora,
  wymaganeKonto = false,
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
    return nie(
      'To zamówienie jest za pobraniem, a wybrana usługa Allegro jest przedpłacona — panel niczego nie nadał.',
    );
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
  if (
    nadpisanieOperatora != null &&
    String(nadpisanieOperatora) !== '' &&
    GROSZE(nadpisanieOperatora) !== GROSZE(cashOnDelivery.amount)
  ) {
    return nie(
      `Wpisano kwotę pobrania ${nadpisanieOperatora} zł, a Allegro rozliczy ` +
        `${cashOnDelivery.amount} zł — przy „Wysyłam z Allegro" kwota musi być ta, którą ` +
        'zobowiązał się zapłacić kupujący. Panel niczego nie nadał.',
    );
  }

  // ⚠️⚠️ NASZEGO RACHUNKU TU NIE MA I MIEĆ NIE MOŻE: pobranie idzie na konto Allegro,
  // a nie na nasze.
  //
  // Zmierzone na usłudze `13f26351-…`:
  //   cashOnDelivery: {"limit":6000,"currency":"PLN","paymentType":"WALLET_TRANSFER",
  //                    "forceRequireIban":false}
  //
  // `WALLET_TRANSFER` znaczy, że gotówkę od kupującego inkasuje ALLEGRO i rozlicza ją przez
  // portfel sprzedawcy — nie przewoźnik na nasz rachunek. `forceRequireIban: false` mówi
  // wprost, że konta podawać NIE TRZEBA. Wymaganie tu naszego IBAN-u (i odmowa bez niego)
  // byłoby błędem: wartość ta w najlepszym razie byłaby ignorowana, a w najgorszym
  // kazałaby przewoźnikowi wysłać pieniądze drogą, której nikt nie uzgodnił.
  //
  // ⚠️ Pole zostaje OBSŁUGIWANE, bo `forceRequireIban` bywa `true` przy innych usługach —
  // wtedy konto jest warunkiem i jego brak MA być odmową. Rozstrzyga USŁUGA, nie my.
  if (!wymaganeKonto) {
    return { wolno: true, cashOnDelivery: { amount: String(cashOnDelivery.amount), currency: 'PLN' } };
  }

  if (!String(ownerName ?? '').trim()) return nie('Ta usługa wymaga konta do zwrotu pobrania, a panel go nie ma.');
  const kontoBezSpacji = String(iban ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
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
