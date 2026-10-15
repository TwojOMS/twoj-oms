import { createHash } from 'node:crypto';
import { bladOperatora } from '../../domena/bledy.js';
import { wolnoNadacZOms, pobranieDoWysylki } from '../../domena/allegro-wysylka.js';
import {
  profilGabarytuAllegro, parsujGabarytAllegro, sprawdzLimityGabarytuAllegro,
} from '../../domena/gabaryty-allegro.js';

// KURIER, KTORY NIE MA WLASNEJ UMOWY — kupuje przewoz u Allegro („Wysylam z Allegro").
//
// Spelnia TEN SAM kontrakt, co kurierzy/dpd.js i kurierzy/inpost.js, i wlasnie dlatego
// `services/nadanie.js` nie wymagal ani jednej zmiany: rezerwacja przed zakupem, zapis
// etykiety, stany bledu i „Sprawdz ponownie" dzialaja tu tak samo, jak przy InPoscie.
//
// ⚠️ `nadaj` KUPUJE PRAWDZIWY PRZEWOZ. Nie ma trybu probnego ani sandboxa. Kazda odmowa
// stoi PRZED pierwszym bajtem, ktory moglby cokolwiek kosztowac.

const ODSTEP_MS = 1000;
const MAKS_PROB = 10;

/**
 * ⚠️ KLUCZ IDEMPOTENCJI WYPROWADZONY Z REZERWACJI, A NIE WYLOSOWANY.
 *
 * Allegro odsiewa powtorzone `create-commands` po `commandId`. Zeby to dzialalo, klucz musi
 * byc TEN SAM przy powtorzeniu — a losowy jest z definicji inny, wiec drugie klikniecie
 * kupiloby DRUGI przewoz. Bierzemy go z pary `(zamowienie, kolejnosc)`, czyli dokladnie
 * z tego, co indeks `przesylki_kolejnosc_zywa` uznaje za JEDNA zywa paczke. Dwa rownolegle
 * klikniecia dostaja wiec ten sam klucz nawet wtedy, gdy oba przejda przez rezerwacje.
 *
 * To nie jest ostroznosc teoretyczna: 10.08.2026 wlasciciel kupil w panelu Allegro dwie
 * etykiety do zamowienia #1140, dwie minuty od siebie. Panel Allegro takiej oslony nie ma.
 *
 * Ksztalt UUID (wersja 5, wariant RFC 4122) — Allegro innego nie przyjmie.
 */
export function commandIdDlaPaczki(zamowienieId, kolejnosc) {
  const h = createHash('sha1').update(`oms-wza:${zamowienieId}:${kolejnosc}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // wersja 5
  b[8] = (b[8] & 0x3f) | 0x80; // wariant RFC 4122
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const czekaj = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ⚠️⚠️ NUMER LISTU NIE JEST W ODPOWIEDZI KOMENDY — i to kosztowalo jedno wdrozenie.
//
// ZMIERZONE 11.08.2026 na pierwszej prawdziwej paczce (`AD0LHNWJ8L661FQRL`). Komenda
// tworzenia oddaje przy powodzeniu DOKLADNIE tyle:
//   {"commandId":"…","status":"SUCCESS","errors":null,"shipmentId":"…"}
// Numeru listu tam nie ma i nie bedzie. Trzeba pojsc po niego do OSOBNEGO zasobu przesylki,
// gdzie siedzi w `packages[].waybill`. Poprzednia wersja szukala go w `shipment.waybill`
// i `waybill` — obu tych pol Allegro nie zwraca NIGDZIE, wiec paczka konczyla jako
// „tworzona u kuriera" mimo statusu SUCCESS: kupiona, oplacona i bez etykiety.
//
// ⚠️ Ksztalt byl ZGADNIETY, nie zmierzony — rozpoznanie 10.08 nie umialo tego sprawdzic,
// bo GET na komende bez prawdziwej paczki oddaje `404 SHIPMENT_NOT_FOUND`. Domysl przeszedl
// przez testy, bo atrapa zwracala to, co zalozylem.
const numerListuZPrzesylki = (p) => p?.packages?.find((x) => x?.waybill)?.waybill ?? null;

// Numer u PRZEWOZNIKA (DPD: `1000987654321U`) — inny niz allegrowy „AD…". Zapisujemy oba,
// bo sledzenie u DPD dziala wylacznie po tym drugim.
const numerPrzewoznika = (p) => p?.packages
  ?.flatMap((x) => x?.transportingInfo ?? [])
  .find((t) => t?.carrierWaybill)?.carrierWaybill ?? null;

// ⚠️ KLIENT WYBIERANY PER ZAMOWIENIE, a nie jeden na cala usluge. Kanaly Allegro sa DWA
// (np. `allegro_a`, `allegro_b`) i to OSOBNE KONTA: przesylka kupiona na koncie A
// nie istnieje dla konta B. Jeden klient na mape kurierow znaczylby, ze paczka z drugiego
// kanalu jedzie na cudzej umowie — i nikt by tego nie zobaczyl, bo etykieta by powstala.
/** @param {import('../../integracje/opcje.ts').OpcjeWza} opcje */
export function createAllegroWzaClient({
  allegroDla, metodaZywa, pobranieNadawca, odstepMs = ODSTEP_MS, maksProb = MAKS_PROB,
}) {
  /**
   * Gotowa przesylka -> wynik dla `services/nadanie.js`. JEDNO miejsce, w ktorym ten ksztalt
   * powstaje — obie drogi (po `commandId` i po `shipmentId`) musza oddawac to samo, inaczej
   * „Sprawdz ponownie" zapisywaloby wiersz inaczej niz pierwsze nadanie.
   */
  async function zbierzGotowa(allegro, shipmentId, przesylka, numerListu) {
    try {
      const format = przesylka?.labelFormat;
      if (format !== 'PDF' && format !== 'ZPL') {
        throw bladOperatora(`Allegro nie podało obsługiwanego formatu etykiety dla przesyłki ${shipmentId}.`);
      }
      const etykieta = await allegro.pobierzEtykieteWza([shipmentId], format);
      const bajty = Buffer.from(etykieta ?? []);
      const poczatek = bajty.subarray(0, 4096).toString('ascii');
      const tekstZpl = format === 'ZPL' ? bajty.toString('ascii') : '';
      if (!bajty.length || (format === 'PDF' && !poczatek.startsWith('%PDF-'))
        || (format === 'ZPL' && (!tekstZpl.includes('^XA') || !tekstZpl.includes('^XZ')))) {
        throw bladOperatora(`Allegro oddało pustą lub niezgodną z ${format} etykietę przesyłki ${shipmentId}.`);
      }
      return {
      shipmentId,
      numerListu,
      numerPrzewoznika: numerPrzewoznika(przesylka),
      wTrakcieTworzenia: false,
      etykietaPdf: format === 'PDF' ? bajty : null,
      etykietaZpl: format === 'ZPL' ? bajty : null,
      // ⚠️⚠️ TEKST, NIGDY OBIEKT. Kolumna `przesylki.odpowiedz_surowa` jest tekstowa,
      // a `node:sqlite` na obiekcie RZUCA („Provided value cannot be bound to SQLite
      // parameter 4") — i rzuca DOPIERO PO tym, jak przewoz u Allegro juz powstal
      // i kosztowal. Zdarzylo sie 11.08.2026 na zamowieniach 1142 i 1145: paczki
      // kupione, a panel pokazywal „blad techniczny". To ta sama rodzina, co pulapka
      // z `ksef_data` (notatka 2026-08-05, §1.2). DPD i InPost oddaja tu surowy TEKST
      // odpowiedzi — trzymamy sie tej samej umowy.
      surowa: JSON.stringify(przesylka),
      };
    } catch (e) {
      // Przewóz już istnieje. Numer musi przeżyć nawet awarię etykiety.
      e.shipmentId = shipmentId;
      e.numerListu = numerListu;
      throw e;
    }
  }

  /** Odpytuje o stan tworzenia i — gdy juz jest numer — dociaga etykiete. */
  async function dokonczPoCommandId(allegro, commandId) {
    for (let proba = 1; proba <= maksProb; proba += 1) {
      const stan = await allegro.stanTworzeniaPrzesylki(commandId);
      const status = String(stan?.status ?? '').toUpperCase();

      if (status === 'ERROR' || (Array.isArray(stan?.errors) && stan.errors.length)) {
        const powod = (stan.errors ?? []).map((e) => e.userMessage || e.message).filter(Boolean).join('; ');
        throw bladOperatora(`Allegro odmówiło utworzenia przesyłki: ${powod || 'bez podanego powodu'}.`);
      }

      // ⚠️ DOPIERO `shipmentId` OTWIERA DROGE DO NUMERU LISTU — sam status SUCCESS go nie ma.
      const shipmentId = stan?.shipmentId ?? null;
      if (shipmentId) {
        // Od tej chwili KAZDY wyjatek musi niesc `shipmentId`: przewoz istnieje i kosztowal,
        // a bez identyfikatora nie da sie o niego zapytac (4.9).
        try {
          const przesylka = await allegro.pobierzPrzesylkeWza(shipmentId);
          const numerListu = numerListuZPrzesylki(przesylka);
          if (numerListu) return await zbierzGotowa(allegro, shipmentId, przesylka, numerListu);
        } catch (e) {
          e.shipmentId = shipmentId;
          throw e;
        }
      }

      if (proba < maksProb) await czekaj(odstepMs);
    }

    // ⚠️ TO NIE JEST BLAD, tylko okno odpytywania krotsze niz robota Allegro. Wolajacy
    // (`services/nadanie.js`) zapisze wiersz 'w_trakcie', a czlowiek domknie go przyciskiem
    // „Sprawdz ponownie". Rzucenie tutaj kazaloby zapisac 'blad', co zwolniloby indeks
    // czesciowy i pozwolilo kupic DRUGI przewoz.
    return { shipmentId: commandId, numerListu: null, wTrakcieTworzenia: true, etykietaPdf: null, etykietaZpl: null, surowa: null };
  }

  /** @param {import('../../core/kontrakty.ts').ZlecenieKuriera} zlecenie */
  async function nadaj({ zamowienie, paczka, kolejnosc = 1, kwotaPobrania = null, drukowac = false }) {
    // ⚠️ ZYWY ODCZYT METODY, nie kolumna. Allegro nie podbija `updatedAt` przy zmianach
    // w zamowieniu, wiec nasza kopia bywa nieswieza z definicji (zmierzone 05.08.2026).
    const deliveryMethodIdZywy = await metodaZywa(zamowienie);

    // Bariera domenowa PRZED pierwszym bajtem, ktory cokolwiek kosztuje.
    const zgoda = wolnoNadacZOms(zamowienie, { deliveryMethodIdZywy });
    if (!zgoda.wolno) throw bladOperatora(zgoda.powod);
    if (paczka?.oczekiwanyDeliveryMethodId
      && paczka.oczekiwanyDeliveryMethodId !== deliveryMethodIdZywy) {
      throw bladOperatora('Metoda dostawy zmieniła się — odśwież ekran nadania.');
    }

    let paczkaDoWysylki = paczka;
    if (profilGabarytuAllegro(deliveryMethodIdZywy)) {
      if (paczka?.oczekiwanyDeliveryMethodId !== deliveryMethodIdZywy) {
        throw bladOperatora('Metoda dostawy zmieniła się — odśwież ekran nadania.');
      }
      const rozmiar = parsujGabarytAllegro(paczka, deliveryMethodIdZywy);
      if (rozmiar.blad) throw bladOperatora(rozmiar.blad);
      for (const pole of ['waga', 'dlugosc', 'szerokosc', 'wysokosc']) {
        if (paczka?.[pole] !== rozmiar.paczka[pole]) {
          throw bladOperatora('Wymiary lub waga nie pasują do wybranego gabarytu Allegro — odśwież ekran nadania.');
        }
      }
      paczkaDoWysylki = rozmiar.paczka;
    } else if (Object.hasOwn(paczka ?? {}, 'gabaryt')) {
      throw bladOperatora('Gabaryt automatu nie pasuje do usługi kurierskiej — odśwież ekran nadania.');
    }

    const commandId = commandIdDlaPaczki(zamowienie.id, kolejnosc);
    const allegro = allegroDla(zamowienie);

    // ⚠️⚠️ CZY ETYKIETA NIE ZOSTALA JUZ KUPIONA RECZNIE W PANELU ALLEGRO.
    //
    // `commandId` chroni przed powtorzeniem TEGO SAMEGO zadania, ale nie przed etykieta,
    // ktora powstala INNA DROGA — a wlasnie ta droga jest dzis normalna: wlasciciel kupuje
    // etykiety w panelu Allegro. Wiersze takich paczek trafiaja do nas dopiero przy
    // odswiezeniu (`services/przesylki-allegro.js`), wiec rezerwacja w bazie moze ich
    // JESZCZE NIE ZNAC — a wtedy klikniecie w OMS kupiloby DRUGI, platny przewoz do klienta,
    // ktory swoj juz ma. Pytamy wiec ALLEGRO, a nie siebie: to jedyne zrodlo, ktore wie
    // o obu drogach naraz. Zmierzone 10.08.2026: `GET .../shipments` oddaje 200 i liste
    // (przy zamowieniu #1140 pokazal obie recznie kupione etykiety).
    //
    // ⚠️ Awarii tego odczytu NIE POLYKAMY. „Nie wiem, czy paczka juz jest" musi znaczyc
    // ODMOWE, a nie zakup — bo cicha zgoda kosztuje tu prawdziwe pieniadze.
    const juzNadane = await allegro.pobierzPrzesylki(zamowienie.zrodlo_id);
    if (Array.isArray(juzNadane) && juzNadane.length) {
      const numery = juzNadane.map((p) => p.waybill).filter(Boolean).join(', ');
      throw bladOperatora(
        `To zamówienie ma już w Allegro ${juzNadane.length === 1 ? 'przesyłkę' : `${juzNadane.length} przesyłki`}`
        + `${numery ? ` (${numery})` : ''} — panel niczego nie kupił. Jeśli potrzebna jest kolejna paczka, `
        + 'nadaj ją świadomie jako dosyłkę.',
      );
    }
    const propozycja = await allegro.pobierzPropozycjeWysylki(zamowienie.zrodlo_id);
    if (profilGabarytuAllegro(deliveryMethodIdZywy)) {
      const limity = sprawdzLimityGabarytuAllegro(paczkaDoWysylki, propozycja?.deliveryOptions);
      if (limity.blad) throw bladOperatora(limity.blad);
    }
    const p = propozycja?.suggestedInput ?? {};

    const input = {
      ...p,
      // ⚠️ NADPISUJEMY podpowiedz, a nie uzupelniamy ja: Allegro oddaje tu ZAWSZE `null`
      // (zmierzone 10.08.2026), a puste pole znaczyloby, ze usluge dobiera Allegro.
      deliveryMethodId: zgoda.deliveryMethodId,
      // ⚠️ WYMIARY WLASNE. Podpowiedz bierze je z OFERTY i bywaja fikcyjne — zmierzone
      // 120 × 80 × 55 cm przy 0,5 kg. O wlasnej paczce wiemy wiecej niz Allegro.
      packages: [{
        type: 'PACKAGE',
        length: { value: paczkaDoWysylki.dlugosc, unit: 'CENTIMETER' },
        width: { value: paczkaDoWysylki.szerokosc, unit: 'CENTIMETER' },
        height: { value: paczkaDoWysylki.wysokosc, unit: 'CENTIMETER' },
        weight: { value: paczkaDoWysylki.waga, unit: 'KILOGRAMS' },
      }],
      labelFormat: drukowac ? 'ZPL' : 'PDF',
    };

    // ⚠️⚠️ POBRANIE — PIENIADZE KUPUJACEGO. Regula jest CZYSTA (domain/allegro-wysylka.js),
    // tu tylko podajemy jej fakty. Limit bierzemy z TEJ SAMEJ podpowiedzi, ktora dala kwote,
    // a nie ze stalej w kodzie: Allegro rozni go miedzy uslugami (6000 zl przy DPD (AD),
    // 15000 przy „DPD Polska") i moze zmienic bez pytania nas o zdanie.
    const limitPobrania = (propozycja?.deliveryOptions ?? [])
      .find((o) => o?.limits?.cashOnDelivery?.amount)?.limits?.cashOnDelivery?.amount ?? null;
    const pobranie = pobranieDoWysylki({
      pobranieUslugi: zgoda.pobranie,
      cashOnDelivery: p.cashOnDelivery,
      limit: limitPobrania,
      ownerName: pobranieNadawca?.nazwa,
      iban: pobranieNadawca?.rachunek,
      nadpisanieOperatora: kwotaPobrania,
      wymaganeKonto: zgoda.wymagaKonta,
    });
    if (!pobranie.wolno) throw bladOperatora(pobranie.powod);
    // ⚠️ JAWNE `null` przy przesylce przedplaconej, a nie pominiete pole: podpowiedz mogla
    // niesc `cashOnDelivery` i rozlozenie jej przez `...p` wyzej przemycilobyby inkaso tam,
    // gdzie regula wlasnie orzekla, ze go nie ma.
    input.cashOnDelivery = pobranie.cashOnDelivery;

    const deliveryMethodIdPrzedZakupem = await metodaZywa(zamowienie);
    if (deliveryMethodIdPrzedZakupem !== deliveryMethodIdZywy) {
      throw bladOperatora('Metoda dostawy zmieniła się podczas nadania — panel niczego nie kupił. Odśwież ekran.');
    }
    await allegro.utworzPrzesylke({ commandId, input });

    // ⚠️ OD TEJ LINII PRZEWOZ MOZE JUZ ISTNIEC I KOSZTOWAC. Kazdy wyjatek stad MUSI niesc
    // `commandId` — to jedyny uchwyt, po ktorym panel umie zapytac o te przesylke ponownie.
    try {
      return await dokonczPoCommandId(allegro, commandId);
    } catch (e) {
      if (!e.shipmentId) e.shipmentId = commandId;
      throw e;
    }
  }

  /**
   * ⚠️ TA FUNKCJA NIE MA PRAWA UTWORZYC ZADNEJ PRZESYLKI — wola wylacznie odczyt po
   * zapisanym identyfikatorze. Dziesiec klikniec pod rzad ma dac zero nowych paczek.
   */
  async function sprawdzPrzesylke(identyfikator, zamowienie) {
    const allegro = allegroDla(zamowienie);

    // ⚠️⚠️ W KOLUMNIE `id_przesylki_kuriera` ZYJA DWA ROZNE IDENTYFIKATORY — i to nie jest
    // niechlujstwo, tylko skutek dwoch drog zapisu, ktorych nie da sie uzgodnic wstecz:
    //
    //  - droga udana zapisuje `shipmentId` (trwaly uchwyt do gotowej przesylki),
    //  - droga awaryjna (`oznaczTworzonaUKuriera`) zapisuje to, co niosl wyjatek — czyli
    //    RAZ `commandId`, a RAZ `shipmentId`, zaleznie od tego, jak daleko doszlo.
    //
    // Zamowienie 1145 (11.08.2026) mialo w tej kolumnie `shipmentId`, a „Sprawdz ponownie"
    // pytalo o nie jak o `commandId` — Allegro odpowiadalo `404`, wiec paczka KUPIONA
    // I GOTOWA (etykieta widoczna w panelu Allegro) wisiala w panelu jako „tworzona
    // u kuriera", bez wyjscia (4.9).
    //
    // Zamiast zgadywac po ksztalcie (commandId jest UUID-em wersji 5, shipmentId wersji 4 —
    // to prawda DZIS i zadna umowa na jutro), PYTAMY. Najpierw jako o przesylke, bo to jest
    // stan docelowy i najczestszy przy tym przycisku; dopiero potem jako o komende.
    let przesylka;
    try {
      przesylka = await allegro.pobierzPrzesylkeWza(identyfikator);
    } catch {
      // Nie przesylka — sprobujemy jako komenda. Milczymy tu CELOWO: `404` znaczy tylko
      // „to nie ten rodzaj identyfikatora", a prawdziwa awaria i tak wyjdzie nizej.
    }
    const numerListu = numerListuZPrzesylki(przesylka);
    if (numerListu) return zbierzGotowa(allegro, identyfikator, przesylka, numerListu);

    return dokonczPoCommandId(allegro, identyfikator);
  }

  return {
    nadaj,
    sprawdzPrzesylke,
    pobierzMetodeDostawy: metodaZywa,
    // ⚠️ ZADEKLAROWANY BRAK SLEDZENIA W TYM ADAPTERZE, a nie przeoczona metoda. Zasob
    // przesylki (`GET /shipment-management/shipments/{id}`) niesie NUMERY (`waybill`,
    // `carrierWaybill`), nie historie. Karta nie pyta TEGO adaptera; wybor w
    // domain/sledzenie-przesylki.js kieruje DPD do DPD, a pozostale WzA do klienta
    // sledzenia Allegro. Bez tej flagi karta dopisywala „BLAD TECHNICZNY" do logu
    // przy KAZDYM otwarciu (zgloszenie wlasciciela 11.08.2026).
    //
    // ⚠️⚠️ SPROSTOWANIE 25.08.2026. Do tego dnia stalo tu zdanie „Allegro nie oddaje przez
    // to API zdarzen przewozu" — prawdziwe o TYM zasobie i FALSZYWE jako wniosek o calym
    // API. Zasob obok, `GET /order/carriers/{carrierId}/tracking?waybill=`, oddaje PELNA
    // historie zdarzen (publiczny od 16.08.2022; zmierzone sonda na zywym koncie). Ten
    // za szeroki wniosek kazal uznac caly kanal Allegro za slepy: szesc paczek wisialo
    // w zakladce jako „bez ruchu", bedac w rzeczywistosci DORECZONYMI.
    //
    // Flaga tutaj ZOSTAJE: adapter NADANIA nie ma metody statusPrzesylki. Od 22.09.2026
    // WzA inne niz DPD korzystaja z tego samego klienta ODCZYTU Allegro, ktory sluzy
    // paczkom nadanym poza OMS; zrodlo `carrier`/`packages.waybill` jest zmierzone na
    // One Box i potwierdzone oficjalnym kontraktem API.
    //
    // ⚠️ FLAGA JEST JAWNA CELOWO: gdyby karta wnioskowala brak sledzenia z braku metody,
    // uciszylaby TEZ regresje u kuriera, ktory sledzenie MIEC POWINIEN — a wlasnie taka
    // regresja (`dpd.statusPrzesylki is not a function`) zdarzyla sie tu juz raz.
    bezSledzenia: true,
  };
}
