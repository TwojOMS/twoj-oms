import {
  zl, wartoscPozycjiGrosze, kwotaOczekiwanaGrosze, sumaPozycjiZWysylkaGrosze, wysylkaBruttoGrosze,
} from '../../../domena/suma-pozycji.js';
import { wysylkaEfektywna } from '../../../domena/wysylka-kwota.js';
import { STAWKA_VAT } from '../../../domena/vat.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import {
  pobierzOkres, zamowieniaOkresu, zamknijOkres,
  rozpocznijFaktureOkresu, zakonczFaktureOkresu, zwolnijFaktureOkresu, oznaczOkresDoWyjasnienia,
} from '../../../oms/db/okresy.js';
import { stanFakturyOkresu } from '../../../domena/okres-rozliczeniowy.js';
import { datyFaktury } from '../../../domena/termin-platnosci.js';
// WDT (spec 2026-08-26): stawke i pola payloadu rozstrzyga domena po NIP-ie KLIENTA
// OKRESU (nabywcy dokumentu); VIES i serie numeracji trzyma WSPOLNA galaz obu drog
// wystawiania (services/wdt-faktury.js) — zeby okres i karta nie mialy dwoch kopii.
import { czyNipUe, stawkaDokumentu, polaWdtInfakt } from '../../../domena/wdt.js';
import {
  sprawdzWdtWVies, przygotujSerieWdt, seriaWdtPoAwarii, seriaWdtPoSukcesie,
} from './wdt-faktury.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';

/**
 * Pozycje faktury zbiorczej — sklejone pozycje WSZYSTKICH zamowien okresu.
 *
 * ⚠️ Bierzemy `z.pozycje`, czyli pozycje JUZ EFEKTYWNE (warstwa odczytu naklada na nie
 * reczne nadpisania, a pozycje dopisane recznie leza w tej samej liscie). Dzieki temu
 * oplata za obsluge i kuriera trafia na fakture BEZ ani jednej linii kodu o niej tutaj —
 * dokladnie tak samo, jak w services/faktura.js dla pojedynczego zamowienia.
 */
export function pozycjeOkresu(zamowienia, { stawka = STAWKA_VAT } = {}) {
  // Stawka przychodzi OD WOLAJACEGO i jest JEDNA na caly dokument, bo dokument ma jednego
  // nabywce — klienta okresu. Liczenie jej per zamowienie (z NIP-u zamowienia) moglaby
  // rozjechac jedna zbiorcza fakture na dwie stawki, gdyby ktores zamowienie mialo
  // uszkodzony numer. Bez opcji zostaje STAWKA_VAT — dotychczasowe zachowanie.
  const services = [];
  for (const z of zamowienia) {
    for (const p of z.pozycje ?? []) {
      services.push({
        name: p.nazwa,
        quantity: p.ilosc,
        // TA SAMA funkcja, ktora liczy sume pozycji pojedynczego zamowienia (faktura.js),
        // sume pod tabela na karcie i druga strone tej bariery nizej — jedno miejsce
        // arytmetyki na caly panel, zeby fakturze zbiorczej i karcie nigdy nie roznila sie
        // ani jedna pozycja.
        gross_price: wartoscPozycjiGrosze(p),
        tax_symbol: stawka,
      });
    }
    // Koszt dostawy jest czescia `kwota_brutto`, ale nie ma go w pozycjach — bez tej
    // linii faktura bylaby zanizona o wysylke przy kazdym platnym transporcie zamowienia
    // w tym okresie.
    // ⚠️ EFEKTYWNA kwota i ilosc (od 07.08.2026), TA SAMA funkcja co przy fakturze
    // pojedynczej — inaczej faktura zbiorcza rozjezdzalaby sie z karta o kazda reczna
    // poprawke dostawy, a bariera nizej odmawialaby calego okresu przez jedno zamowienie.
    const dostawa = wysylkaBruttoGrosze(z);
    if (dostawa > 0) {
      services.push({
        name: 'Dostawa', quantity: wysylkaEfektywna(z).ilosc, gross_price: dostawa, tax_symbol: stawka,
      });
    }
  }
  return services;
}

/** Kwota, ktorej oczekujemy od klienta za caly okres — druga strona bariery. */
export function sumaOczekiwanaOkresuGrosze(zamowienia) {
  return zamowienia.reduce((acc, z) => acc + kwotaOczekiwanaGrosze(z), 0);
}

/**
 * JEDYNA definicja tego, co wchodzi na fakture zbiorcza, a co z niej wypada.
 *
 * ⚠️ ZAMOWIENIA ANULOWANE WYPADAJA Z FAKTURY, a nie blokuja jej wystawienia. Faktura
 * pojedyncza (services/faktura.js) w tej sytuacji ODMAWIA — i slusznie, bo tam anulowane
 * zamowienie JEST calym dokumentem. Tutaj byloby inaczej: jedno anulowane zamowienie
 * zablokowaloby fakture za caly miesiac, a klient i tak musi ja dostac — wiec wlasciciel
 * wystawilby ja recznie w inFakcie, czyli POZA kazda bariera tego panelu. Anulowane
 * zamowienie nie jest sprzedaza, wiec na fakturze nie ma go po co szukac.
 *
 * `z.anulowane` z warstwy odczytu jest EFEKTYWNE (suma logiczna kolumny sklepowej
 * i `anulowane_recznie`, patrz domain/status-reczny.js) — czytanie samej kolumny
 * sklepowej wystawialoby fakture za zamowienie anulowane w panelu.
 *
 * ⚠️ TO JEST FUNKCJA EKSPORTOWANA, A NIE `filter` W DWOCH MIEJSCACH — i to jest sedno
 * poprawki po recenzji Zadania 9. Ekran okresu (web/routes/okresy.js) liczyl sume z WSZYSTKICH
 * zamowien, a `wystaw` nizej — bez anulowanych. Skutek zmierzony na okresie 100,00 aktywne
 * + 40,00 anulowane: karta obiecywala „Razem do zafakturowania 140.00 zł", do inFaktu szlo
 * 100,00, zaplata co do grosza wygladala na NIEDOPLATE 40 zl, a nadplata 40 zl nie pojawiala
 * sie NIGDZIE. Ostatni ekran przed dokumentem, ktory po wieczornej wysylce do KSeF poprawia
 * sie juz tylko korekta, ma pokazywac dokladnie ta liczbe, ktora pojdzie na fakture — wiec
 * warunek moze byc TYLKO jeden i musi mieszkac tam, gdzie faktura naprawde powstaje.
 */
export function podzialZamowienOkresu(wszystkie) {
  return {
    zamowienia: wszystkie.filter((z) => !z.anulowane),
    anulowane: wszystkie.filter((z) => z.anulowane),
  };
}

/**
 * BARIERA ARYTMETYCZNA DLA OKRESU — ta sama zasada co przy pojedynczym zamowieniu
 * (services/faktura.js, sprawdzSume), tylko powtorzona dla kazdego zamowienia okresu.
 *
 * ⚠️ Przy fakturze na kilkadziesiat zamowien i kilkaset pozycji bariera jest WAZNIEJSZA
 * niz kiedykolwiek: bledu w takiej sumie nikt nie wylapie okiem, a dokument, ktory pojdzie
 * wieczorem do KSeF, poprawia sie juz tylko korekta.
 */
export function sprawdzSumeOkresu(services, zamowienia) {
  // Ta sama dziura, co przy pojedynczym zamowieniu: okres bez ani jednej pozycji
  // przechodzilby bariere bezblednie (suma pustej listy = 0 = suma zamowien = 0), a do
  // inFaktu poszlaby faktura z pustym `services`. Dokument bez pozycji trzeba by recznie
  // znalezc i skasowac w inFakcie, zanim wieczorem pojedzie do KSeF.
  if (services.length === 0) {
    throw bladOperatora(
      'Okres nie ma żadnej pozycji do zafakturowania — faktury bez pozycji panel nie wystawi.',
    );
  }

  // ⚠️ SPRAWDZENIE IDZIE ZAMOWIENIE PO ZAMOWIENIU, I TO JEST ISTOTA TEJ BARIERY.
  //
  // Porownanie samych sum ZBIORCZYCH (jedna liczba po obu stronach) przepuszcza bledy,
  // ktore sie NAWZAJEM ZNOSZA — sprawdzone na tym kodzie:
  //   zamowienie z1 zawyzone o 10 zl, sprawdzane samo  -> ODMOWA, roznica  10,00 zl
  //   zamowienie z2 zanizone o 10 zl, sprawdzane samo  -> ODMOWA, roznica -10,00 zl
  //   z1 + z2 w jednej sumie zbiorczej                 -> PRZESZLO (10 - 10 = 0)
  // Faktura zbiorcza to kilkadziesiat zamowien, wiec szansa na taka kompensacje ROSNIE,
  // a nie maleje. Bariera pojedynczej faktury (services/faktura.js) porownuje sume JEDNEGO
  // zamowienia z kwota TEGO zamowienia i dlatego lapie kazdy rozjazd osobno — tutaj musi
  // byc dokladnie tak samo.
  //
  // Suma liczona `sumaPozycjiZWysylkaGrosze` — TA SAMA funkcja, ktorej uzywa bariera
  // pojedynczej faktury, i liczaca DOKLADNIE to, co `pozycjeOkresu` wypycha do `services`
  // dla tego zamowienia (pozycje efektywne plus wysylka). Zadnej drugiej kopii arytmetyki.
  for (const z of zamowienia) {
    const sumaZam = sumaPozycjiZWysylkaGrosze(z);
    const oczekiwanaZam = kwotaOczekiwanaGrosze(z);
    if (sumaZam !== oczekiwanaZam) {
      // Numer zamowienia W KOMUNIKACIE, bo bez niego operator dostaje „roznica 10,00 zl"
      // na fakturze za caly miesiac i musi przeszukac go recznie. `numer` (R/2026/007) jest
      // jedynym identyfikatorem, ktory czlowiek rozpozna na karcie i w sklepie.
      throw bladOperatora(
        `Zamówienie ${z.numer}: suma pozycji (${zl(sumaZam)} zł) nie zgadza się z kwotą `
        + `zamówienia (${zl(oczekiwanaZam)} zł). Różnica: ${zl(sumaZam - oczekiwanaZam)} zł. `
        + 'Faktura za okres NIE została wystawiona.',
      );
    }
  }

  // DOMKNIECIE, nie glowne sprawdzenie: porownanie sum zbiorczych lapie to, czego petla wyzej
  // z definicji nie widzi — pozycje doklejona do tablicy `services` POZA petla po zamowieniach
  // (albo zgubiona z niej). Kosztuje jedno przejscie po liscie, wiec zostaje.
  const suma = services.reduce((acc, s) => acc + s.gross_price, 0);
  const oczekiwana = sumaOczekiwanaOkresuGrosze(zamowienia);
  if (suma !== oczekiwana) {
    throw bladOperatora(
      `Suma pozycji (${zl(suma)} zł) nie zgadza się z sumą zamówień okresu `
      + `(${zl(oczekiwana)} zł). Różnica: ${zl(suma - oczekiwana)} zł. Faktura nie została wystawiona.`,
    );
  }
}

/**
 * Wystawienie JEDNEJ faktury za caly okres rozliczeniowy klienta zbiorczego.
 *
 * Podzial faz jest DOKLADNIE taki, jak przy fakturze pojedynczej (services/faktura.js),
 * bo powod jest ten sam: dokumentu w inFakcie sie nie edytuje, tylko kasuje i wystawia od
 * nowa — a po wieczornej zbiorczej wysylce do KSeF (robi ja wlasciciel recznie, panel NIGDY)
 * zostaje juz tylko korekta.
 */
export function createFakturaOkresu({
  db, infakt, vies = null, nipSprzedawcy, teraz = () => new Date().toISOString(),
}) {
  // Awaria JEDNOZNACZNA = inFakt odpowiedzial i odrzucil (4xx): dokumentu na pewno nie ma.
  // Wszystko inne — 5xx, zerwane polaczenie (to w ogole NIE NIESIE statusu, patrz
  // infakt/client.js), blad techniczny w trakcie wywolania — jest NIEJEDNOZNACZNE.
  // Domyslna odpowiedz na niewiedze musi byc ostrozna. Ta sama regula co w faktura.js.
  const jednoznacznaOdmowa = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;

  // Komunikat odmowy MUSI powiedziec czlowiekowi, co zrobic — inaczej okres w stanie
  // 'do_wyjasnienia' wyglada jak awaria panelu, a nie jak decyzja czekajaca na czlowieka.
  // Tresc idzie za `opisKolizji` z db/faktury.js, bo sytuacja jest ta sama.
  function opisOdmowyFaktury(stan, okres) {
    if (stan === 'do_wyjasnienia' || stan === 'zawieszona') {
      const powod = stan === 'zawieszona'
        ? `Rezerwacja faktury tego okresu wisi od ${okres.utworzona_at} i żadne wystawianie już nie trwa `
          + '— panel najpewniej został zrestartowany w trakcie wywołania inFaktu.'
        : 'Poprzednia próba wystawienia faktury za ten okres zerwała się w miejscu, w którym dokument mógł już powstać'
          + `${okres.blad_opis ? ` (${okres.blad_opis})` : ''}.`;
      // ⚠️ KOMUNIKAT NIE OBIECUJE PONOWIENIA. Wczesniej mowil „skasuj ja tam, zanim cokolwiek
      // ponowisz" — a ponowic sie nie dalo: ze stanow 'do_wyjasnienia' i 'zawieszona' nie ma
      // wyjscia przez zadne klikniecie. Wyjscie w bazie JEST (`odblokujFaktureOkresu`
      // w db/okresy.js), ale trasy i przycisku jeszcze nie ma — powstana w Zadaniu 9. Do tego
      // czasu komunikat ma mowic prawde: blokada zostaje, dopoki ktos jej swiadomie nie zdejmie.
      return `${powod} Sprawdź RĘCZNIE w inFakcie, czy faktura za ten okres istnieje. `
        + 'Jeśli JEST i jeszcze nie poszła do KSeF (wysyłkę robi właściciel ręcznie, wieczorem) — '
        + 'skasuj ją tam. Panel sam z tego stanu NIE WYJDZIE i wystawienia nie ponowi: okres '
        + 'zostaje zablokowany, dopóki ktoś go świadomie nie odblokuje. Ta blokada jest po to, '
        + 'żeby drugie podejście nie dołożyło drugiej faktury za ten sam miesiąc.';
    }
    if (stan === 'w_toku') return 'Wystawianie faktury za ten okres właśnie trwa.';
    return `Faktura za ten okres jest już wystawiona${okres.numer ? ` (${okres.numer})` : ''} `
      + '— panel nie wystawi jej drugi raz.';
  }

  /**
   * @param {number} okresId
   * @param {{nip: string, nazwa?: string}} klient dane nabywcy z konfiguracji (Zadanie 1)
   * @param {{dataWystawienia?: string, termin?: string|number}|null} termin OPCJONALNY wybor
   *   operatora z formularza. Brak = ZADNYCH dat w payloadzie, czyli termin z ustawien konta
   *   inFakt — dokladnie tak samo, jak przy fakturze pojedynczej (services/faktura.js).
   *   ⚠️ NIE wolno tu wolac `datyFaktury()` bez argumentu „dla domyslnych dat": ta funkcja
   *   RZUCA na pustym terminie (sprawdzone), a rzucalaby juz PO rezerwacji — czyli KAZDA
   *   faktura okresu konczylaby sie okresem zablokowanym w stanie „do wyjasnienia".
   */
  async function wystaw(okresId, klient, termin = null) {
    const okres = pobierzOkres(db, okresId);
    if (!okres) throw bladOperatora('Nie ma takiego okresu rozliczeniowego.');

    // ⚠️ NIE wolno wolac tu `stanFaktury` wprost. Ta funkcja czyta PUSTY `ksef_status`
    // jako „wystawiona" — i dla wiersza w tabeli `faktury` to poprawne, bo tamten wiersz
    // POWSTAJE dopiero przy wystawianiu, wiec samo jego istnienie cos znaczy. Okres jest
    // inny: istnieje od pierwszego zamowienia miesiaca, z pustymi kolumnami faktury.
    // Zmierzone: `stanFaktury({ksef_status: null})` zwraca 'wystawiona', wiec swiezy okres
    // udawalby zafakturowany i panel NIGDY nie wystawilby faktury.
    const stanF = stanFakturyOkresu(okres);
    if (stanF !== 'brak') throw bladOperatora(opisOdmowyFaktury(stanF, okres));

    const wszystkie = zamowieniaOkresu(db, okresId).map((id) => pobierzZamowienie(db, id));

    // Podzial idzie `podzialZamowienOkresu` (wyzej w tym pliku) — TA SAMA funkcja, ktorej
    // uzywa ekran okresu. Uzasadnienie, dlaczego to funkcja, a nie `filter` w dwoch
    // miejscach, stoi nad nia.
    const { zamowienia, anulowane } = podzialZamowienOkresu(wszystkie);

    // ⚠️ DRUGA STRONA BARIERY „TO SAMO ZAMOWIENIE DWIEMA DROGAMI" (recenzja koncowa galezi).
    // Pierwsza siedzi w services/faktura.js i nie wpuszcza zamowienia z okresu na fakture
    // pojedyncza. Ta pilnuje kierunku odwrotnego: okresu, w ktorym ktores zamowienie ma JUZ
    // wlasny wiersz w `faktury`. Kazda z osobna zostawia dziure — pierwsza nie widzi
    // zamowien zafakturowanych ZANIM trafily do okresu (ani wierszy z czasow sprzed tej
    // poprawki), druga nie broni sie przed dopisaniem faktury pojedynczej po zamknieciu
    // miesiaca. Dlatego sa obie.
    //
    // ⚠️ WIERSZ W `faktury` W KAZDYM STANIE, nie tylko „wystawiona": rezerwacja `w_toku`
    // i `do_wyjasnienia` tez znacza „dokument moze istniec w inFakcie". Domyslna odpowiedz
    // na niewiedze jest tu ostrozna, dokladnie jak przy awarii niejednoznacznej nizej.
    //
    // ⚠️ SPRAWDZAMY `zamowienia`, czyli zbior, KTORY NAPRAWDE WCHODZI NA FAKTURE — nie
    // `wszystkie`. Anulowane wypadaja z dokumentu (patrz `podzialZamowienOkresu` wyzej),
    // wiec ich wlasna faktura NICZEGO nie dubluje, a blokada na nich zamknelaby caly miesiac
    // na amen: odpiac zamowienia od okresu panel nie umie, wiec z takiej odmowy nie byloby
    // ZADNEGO wyjscia poza SQL-em na produkcji.
    //
    // Numer zamowienia W KOMUNIKACIE, wzorem `sprawdzSumeOkresu` — bez niego operator dostaje
    // „ktoreś zamowienie ma fakture" na miesiacu o kilkudziesieciu pozycjach.
    const zFaktura = zamowienia.find((z) => z.faktura);
    if (zFaktura) {
      throw bladOperatora(
        `Zamówienie ${zFaktura.numer} ma już własną fakturę`
        + `${zFaktura.faktura.numer ? ` (${zFaktura.faktura.numer})` : ' (wystawianie w toku albo do wyjaśnienia)'}`
        + ', więc faktura zbiorcza obciążyłaby klienta za ten sam towar drugi raz. '
        + 'Faktura za okres NIE została wystawiona — rozstrzygnij najpierw tamten dokument '
        + 'w inFakcie (skasuj go, dopóki nie poszedł wieczorem do KSeF; potem zostaje korekta).',
      );
    }

    // Stawka dokumentu z NIP-u KLIENTA OKRESU — nabywcy faktury zbiorczej. Nabywca z UE
    // dostaje 0% (WDT) na kazdej pozycji; kwoty zamowien sa wtedy kwotami netto, wiec
    // bariera arytmetyczna nizej dziala bez zmian (netto = brutto przy 0%).
    const wdt = czyNipUe(klient?.nip);
    const services = pozycjeOkresu(zamowienia, { stawka: stawkaDokumentu(klient?.nip) });
    // ⚠️ Bariera PRZED rezerwacja i przed jakimkolwiek ruchem w inFakcie: nieudana
    // arytmetyka nie ma prawa zostawic po sobie ani rezerwacji, ani zamknietego okresu.
    // Sprawdza DOKLADNIE te sama liste zamowien, ktora poszla do `pozycjeOkresu` — inaczej
    // domkniecie sum zbiorczych odmawialoby kazdemu okresowi z anulowanym zamowieniem.
    sprawdzSumeOkresu(services, zamowienia);

    // Log WDT idzie do logu KAZDEGO zamowienia okresu — tam czlowiek szuka historii
    // konkretnego zamowienia, dokladnie jak przy wpisie 'faktura-okresu' nizej.
    const dopiszWdt = (akcja, wynik) => {
      for (const z of zamowienia) dopiszLog(db, z.id, { akcja, wynik });
    };

    // Daty licza sie TU, czyli tez PRZED rezerwacja: literowka w polu terminu ma odbic sie
    // od formularza, a nie zostawic zamknietego okresu z wiszaca rezerwacja.
    //
    // ⚠️ BEZ KWOTY (drugi argument `datyFaktury`) — CELOWO. Faktura zbiorcza nie ma wariantu
    // „zaplacone": obejmuje caly miesiac dostaw, ktore bywaja oplacone w roznym stopniu, wiec
    // jedna kwota „zaplacono" nie mialaby tu sensu. Brak argumentu znaczy, ze gdyby ten wariant
    // kiedykolwiek trafil tu z formularza, domena ODMOWI — zamiast wystawic dokument mowiacy
    // klientowi, ze za miesiac juz zaplacil. Ekran okresu tej opcji nie pokazuje (views/okres.ejs).
    const daty = termin ? datyFaktury(termin) : {};

    // Nabywca MUSI zostac rozstrzygniety PRZED rezerwacja: brak client_id to faktura
    // bez nabywcy, a szukanie klienta po rezerwacji zostawialoby wiszacy stan „w_toku"
    // dla bledu, ktory z samym wystawianiem nie ma nic wspolnego.
    //
    // ⚠️ Panel NIE ZAKLADA tu klienta sam (inaczej niz przy fakturze pojedynczej, gdzie
    // nabywca bywa nowy przy kazdym zamowieniu). Klient zbiorczy jest JEDEN i staly, zakladany
    // raz i recznie; automat na pierwszej literowce w NIP-ie zalozylby duplikat, a duplikat
    // w kartotece blokuje potem KAZDE wyszukanie (patrz znajdzKlientaPoNip).
    if (!klient?.nip) {
      throw bladOperatora(
        'Klient zbiorczy nie ma NIP-u w konfiguracji — bez niego panel nie wskaże nabywcy faktury.',
      );
    }
    // WDT: numer nabywcy MUSI byc wazny w VIES (art. 42 ust. 1 pkt 1) — sprawdzenie stoi
    // PRZED rezerwacja i zamknieciem okresu, jak lookup nabywcy nizej: odmowa niczego
    // nie blokuje, a dowod weryfikacji (numer konsultacji) idzie do logu zamowien.
    if (wdt) await sprawdzWdtWVies({ vies, nip: klient.nip, dopisz: dopiszWdt });

    const clientId = await infakt.znajdzKlientaPoNip(klient.nip);
    if (!clientId) {
      throw bladOperatora(
        `W inFakcie nie ma klienta o NIP ${klient.nip} — załóż go tam raz, ręcznie, `
        + 'i ponów wystawienie.',
      );
    }

    // ⚠️ REZERWACJA IDZIE PRZED ZAMKNIECIEM, a nie odwrotnie. Rezerwacja jest warunkowa
    // (db/okresy.js) i to ona rozstrzyga wyscig — kto ja przegral, ma sie odbic ZANIM
    // cokolwiek nadpisze. Przy odwrotnej kolejnosci przegrany zdazyl juz przestemplowac
    // `stan` na „zamkniety" na okresie, ktory zwyciezca zdazyl oznaczyc jako zafakturowany.
    rozpocznijFaktureOkresu(db, okresId);
    zamknijOkres(db, okresId);

    // ⚠️ PONOWNY ODCZYT ZBIORU ZAMOWIEN — DOPIERO TERAZ, GDY DRZWI SA JUZ ZAMKNIETE.
    //
    // `zamowieniaOkresu` wyzej czyta baze PRZED `await infakt.znajdzKlientaPoNip`, a okres
    // zostaje OTWARTY przez cale to okno — wiec `przypiszDoOkresu` (services/okres.js)
    // przyjmuje w nim nowe zamowienie bez mrugniecia. Zmierzone przed ta poprawka: drugi
    // operator zapisuje zamowienie za 40 zl w trakcie wywolania inFaktu, faktura idzie na
    // 100,00 zl, a ekran okresu mowi potem „Razem 140.00 zł" i „NIEDOPŁATA: brakuje 140.00 zł".
    // WYJSCIA Z TEGO NIE MA ZADNEGO: okresu z faktura nie da sie otworzyc (routes/okresy.js),
    // a zamowienia nie da sie odpiac inaczej niz SQL-em na produkcji.
    //
    // Rezerwacja i zamkniecie okresu domykaja okno na przyszlosc, ale nie cofaja tego, co
    // wpadlo w nie wczesniej — dlatego zbior trzeba POROWNAC. Miedzy `rozpocznijFaktureOkresu`
    // a tym odczytem nie ma ANI JEDNEGO `await`, wiec porownanie jest szczelne: cokolwiek
    // widzi ten odczyt, to jest juz ostateczna zawartosc miesiaca.
    //
    // ⚠️ ODMOWA IDZIE PRZED `infakt.wystaw` i ZWALNIA REZERWACJE (`zwolnijFaktureOkresu`),
    // czyli zostawia okres DOKLADNIE takim, jaki byl przed proba. Zablokowany okres bylby tu
    // gorszy od bledu, ktory naprawiamy: dokumentu nie ma, a miesiac nie dalby sie
    // zafakturowac wcale.
    const przedBariera = new Set(wszystkie.map((z) => z.id));
    const poZamknieciu = zamowieniaOkresu(db, okresId);
    const dopisane = poZamknieciu.filter((id) => !przedBariera.has(id));
    const zniknely = [...przedBariera].filter((id) => !poZamknieciu.includes(id));
    if (dopisane.length > 0 || zniknely.length > 0) {
      zwolnijFaktureOkresu(db, okresId);
      // Numery, nie identyfikatory z bazy — czlowiek rozpoznaje zamowienie po `R/2026/007`.
      const numery = (ids) => ids.map((id) => pobierzZamowienie(db, id)?.numer ?? `#${id}`).join(', ');
      const co = dopisane.length > 0
        ? `dopisano zamówienie ${numery(dopisane)}`
        : `zniknęło zamówienie ${numery(zniknely)}`;
      throw bladOperatora(
        `W trakcie wystawiania faktury zmienił się skład okresu (${co}) — panel przerwał, `
        + 'zanim cokolwiek poszło do inFaktu. Faktura za okres NIE została wystawiona i nic '
        + 'się nie zablokowało: odśwież ekran okresu, sprawdź kwotę i wystaw ją jeszcze raz.',
      );
    }

    // NUMER WLASNEJ SERII WDT — po zamknieciu skladu okresu, przed wystawieniem. Miesiac
    // serii idzie za data wystawienia (bez niej: dzis). Rezerwacje, straznik duplikatu
    // i zwalnianie licznika trzyma WSPOLNA galaz (services/wdt-faktury.js); awaria zwalnia
    // tez rezerwacje okresu, bo dokumentu na pewno jeszcze nie ma.
    let seriaWdt = null;
    if (wdt) {
      try {
        seriaWdt = await przygotujSerieWdt({ db, infakt, dzien: daty.invoice_date ?? dzienWarszawa(teraz()) });
      } catch (e) {
        zwolnijFaktureOkresu(db, okresId);
        throw e;
      }
    }

    let odp;
    try {
      odp = await infakt.wystaw({
        client_id: clientId,
        services,
        ...daty,
        // Pola WYLACZNIE dokumentu WDT (domain/wdt.js) — dla klienta krajowego oba
        // rozsypania sa puste i payload zostaje bajt w bajt taki, jaki byl.
        ...polaWdtInfakt(klient.nip, { nipSprzedawcy }),
        ...(seriaWdt ? { number: seriaWdt.numer } : {}),
      });
    } catch (e) {
      // Los numeru serii rozstrzyga wspolna galaz: 4xx zwalnia, niejednoznaczna zostawia
      // zajety z glosnym sladem w logu zamowien okresu.
      seriaWdtPoAwarii({ db, seria: seriaWdt, jednoznaczna: jednoznacznaOdmowa(e), dopisz: dopiszWdt });
      // 4xx = inFakt ODRZUCIL zadanie, dokumentu na pewno nie ma → wolno poprawic i ponowic.
      // Wszystko inne (5xx, zerwane polaczenie) jest NIEJEDNOZNACZNE → blokada do decyzji.
      if (jednoznacznaOdmowa(e)) zwolnijFaktureOkresu(db, okresId);
      else oznaczOkresDoWyjasnienia(db, okresId, String(e?.message ?? e));
      throw e;
    }

    // ⚠️ DWA KSZTALTY ODPOWIEDZI, celowo. Prawdziwy `createInfaktClient().wystaw` oddaje
    // `{ uuid, numer, ksefStatus }` — surowe pola API (`number`, `ksef_data`) przepisuje
    // u siebie. Czytanie tylko jednego z tych ksztaltow zapisywaloby do bazy NULL zamiast
    // numeru faktury, i to PO CICHU: okres bylby zafakturowany dokumentem, ktorego numeru
    // panel nie zna, a czlowiek zobaczylby to dopiero szukajac faktury w inFakcie.
    //
    // `ksef_data` jest puste, dopoki dokument nie pojdzie do KSeF — a panel go tam nigdy sam
    // nie wysyla, wiec NULL jest tu stanem normalnym, nie bledem.
    const uuid = odp?.uuid ?? null;
    const numer = odp?.numer ?? odp?.number ?? null;
    const ksefStatus = odp?.ksefStatus ?? odp?.ksef_data ?? null;

    // ⚠️ ODPOWIEDZ BEZ UUID-a I BEZ NUMERU TO AWARIA NIEJEDNOZNACZNA, NIE SUKCES.
    // `zapytaj` (infakt/client.js) oddaje `null` dla kazdego 2xx, ktorego ciala nie da sie
    // sparsowac jako JSON — puste albo HTML-owe cialo z proxy — a `wystaw` degraduje to do
    // `{uuid: null, ...}`. Zadanie do inFaktu wtedy DOSZLO i dokument MOGL powstac; panel
    // nie zna ani jego uuid-a, ani numeru. Zapisanie tego jako „zafakturowany z pustymi
    // polami" bylo dokladnie tym, co kasowalo blokade drugiego wystawienia — i nawet po
    // naprawie `stanFakturyOkresu` bylby to okres udajacy rozliczony dokumentem, o ktorym
    // panel nie wie NIC. Niewiedza ma isc do czlowieka, tak samo jak zerwane polaczenie.
    if (!uuid && !numer) {
      const opis = 'inFakt odpowiedział bez numeru i bez identyfikatora dokumentu '
        + '(puste albo nieczytelne ciało odpowiedzi) — faktura mogła powstać.';
      oznaczOkresDoWyjasnienia(db, okresId, opis);
      throw bladOperatora(
        `${opis} Sprawdź RĘCZNIE w inFakcie, czy faktura za ten okres istnieje. Jeśli JEST `
        + 'i jeszcze nie poszła do KSeF (wysyłkę robi właściciel ręcznie, wieczorem) — skasuj ją tam. '
        + 'Panel sam z tego stanu NIE WYJDZIE i wystawienia nie ponowi: okres zostaje zablokowany, '
        + 'dopóki ktoś go świadomie nie odblokuje.',
      );
    }

    // ⚠️ LOG PRZED ZAPISEM WIERSZA OKRESU — ten sam wzorzec i ten sam powod co
    // services/faktura.js. Numer faktury jest faktem NIEODWRACALNYM: dokument juz istnieje
    // w inFakcie, ze swoim miejscem w numeracji, a wiersz okresu jest tylko jego odbiciem.
    // Gdyby `zakonczFaktureOkresu` padlo (dysk, blokada WAL), log jest JEDYNYM sladem, z ktorego
    // czlowiek odtworzy numer faktury za caly miesiac — rezerwacja zostaje w bazie i dalej
    // blokuje drugi dokument, ale sama numeru nie niesie.
    //
    // Wpis idzie do logu KAZDEGO zafakturowanego zamowienia, bo tam czlowiek szuka historii
    // konkretnego zamowienia — „na ktorej fakturze to poszlo" jest pytaniem o zamowienie,
    // nie o okres.
    for (const z of zamowienia) {
      dopiszLog(db, z.id, { akcja: 'faktura-okresu', wynik: numer ?? 'OK' });
    }
    // Prawda o numerze jest ODPOWIEDZ inFaktu — rozjazd z seria WDT rozstrzyga wspolna
    // galaz (glosny log do zamowien + zwolnienie licznika); patrz services/wdt-faktury.js.
    seriaWdtPoSukcesie({ db, seria: seriaWdt, numerZwrocony: numer, dopisz: dopiszWdt });
    // Slad po pominietych zamowieniach — w tym samym miejscu i tak samo przed zapisem wiersza.
    // Bez tego wypadniecie z faktury zbiorczej byloby ciche i po miesiacu nie do odtworzenia.
    for (const z of anulowane) {
      dopiszLog(db, z.id, {
        akcja: 'faktura-okresu',
        wynik: `POMINIĘTE (anulowane) — faktura okresu ${numer ?? 'bez numeru'}`,
      });
    }

    return zakonczFaktureOkresu(db, okresId, { uuid, numer, ksefStatus });
  }

  return { wystaw };
}
