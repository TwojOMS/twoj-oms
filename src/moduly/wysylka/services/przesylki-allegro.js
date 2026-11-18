import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { nastepnaKolejnosc, zarejestrujPrzesylkeReczna } from '../db/przesylki.js';
import { czyKanalAllegro } from '../../../domena/wysylka.js';
import { ZRODLO_NUMERU } from '../../../domena/przesylka-stan.js';

// NUMERY LISTOW PRZESYLEK NADANYCH W PANELU ALLEGRO. Panel ich NIE TWORZY — czyta.
//
// ⚠️ KURIER TO 'allegro', NIGDY 'dpd'. Przesylka wraca z `carrierId: "ALLEGRO"` i numerem
// „AD…", bo paczka nadana w panelu Allegro jedzie na ICH umowie. Zapasowe 'dpd'
// (kurierWpisuRecznego) zniosloby ten numer na tracktrace.dpd.com.pl i kazaloby pytac DPD
// o cudzą przesyłkę.
//
// ⚠️ KURIER WYNIKA Z KANALU, A NIE Z METODY WYSYLKI — i dlatego NIE wolamy tu
// `kurierWpisuRecznego(metodaWysylki(z))`. Tamta funkcja czyta metode, a metoda bywa
// 'nieznana' (Allegro dolozylo usluge, ktorej slownik domena/allegro-dostawa.js jeszcze nie
// zna) i jest EDYTOWALNA z karty; kolumna `sklep` jest trwala. Kluczowanie po metodzie
// wpisaloby wtedy zapasowe 'dpd' pod numer „AD…". `czyKanalAllegro` (domena/wysylka.js) jest
// tym samym predykatem, ktory pilnuje odmowy zmiany metody — jedno zrodlo prawdy o kanale.
//
// ⚠️ ZAPIS IDZIE ISTNIEJACA DROGA (`zarejestrujPrzesylkeReczna`), a nie wlasnym INSERT-em.
// Ta droga niesie komplet siatek tabeli `przesylki`: odmowe, gdy inna paczka wisi w toku,
// indeks unikalny `przesylki_kolejnosc_zywa (zamowienie_id, kolejnosc) WHERE status <> 'blad'`
// oraz znacznik `nadana_recznie`. Ten ostatni jest tu KONIECZNY, a nie ozdobny: bez niego
// kazde zamowienie z Allegro wisialoby na liscie roboczej ze sprawa „brak etykiety" — na
// zawsze i bez wyjscia, bo panel o te paczke z nikim nie rozmawial i zadnego pliku nie
// dostanie (domena/przesylka-stan.js: sprawyPrzesylki).
//
// ⚠️ `wyslane_at` NIE JEST TU USTAWIANE — i to jest decyzja, nie przeoczenie.
// Ręczna rejestracja przesyłki nadanej POZA panelem `wyslane_at` ustawia (reguła: status
// wynika z faktów), bo tam człowiek stwierdza fakt o paczce, która JUŻ JEDZIE. Tutaj
// człowieka nie ma, a wyzwalaczem jest istnienie
// ETYKIETY kupionej w panelu Allegro. Etykieta powstaje PRZY PAKOWANIU, paczka wyjeżdża
// z kurierem — często następnego dnia. Dlatego utworzenie etykiety NIE JEST źródłem
// statusu: zamówienia znikałyby z listy roboczej, leżąc jeszcze na
// stole. Automat ustawiający tu datę wprowadziłby tę usterkę bez człowieka
// w pętli i bez szansy, żeby ktoś ją zauważył. Zamowienie schodzi z listy dopiero wtedy,
// gdy czlowiek powie, ze paczka pojechala — belka statusu na karcie dziala tu jak wszedzie.
// Akcja w logu — JEDNA stala dla uslugi i dla trasy, bo trasa DLAWI powtorzony wpis bledu
// porownaniem z OSTATNIM wpisem TEJ akcji (patrz moduly/zamowienia/karta.js). Dwie kopie napisu
// rozjechalyby ten dlawik PO CICHU: log dalej by rosl, a testy dalej swiecilyby na zielono.
export const AKCJA_LOGU = 'allegro.przesylka';

export function createPrzesylkiAllegro({ db, klienci = {} }) {
  /**
   * Dociaga numery listow JEDNEGO zamowienia i dopisuje te, ktorych panel jeszcze nie zna.
   *
   * Awarii Allegro NIE POLYKAMY (401 po cofnietej zgodzie, 500, timeout): usluga ma
   * powiedziec wolajacemu, ze nie wie. Ciche `catch` zamienialoby awarie calego kanalu
   * w „ta paczka nie ma numeru" — czyli w stan nieodroznialny od normalnego. Odpornosc
   * siedzi u WOLAJACEGO, tak samo jak przy odswiezaniu statusu kuriera na karcie.
   */
  async function odswiez(zamowienieId) {
    const z = pobierzZamowienie(db, zamowienieId);
    // ⚠️ KANAL ROZSTRZYGA PIERWSZY, PRZED MAPA KLIENTOW. Klucze sklepow i kanalow leza
    // w JEDNEJ przestrzeni nazw (kolumna `zamowienia.sklep`), wiec sama obecnosc klucza
    // w mapie nie jest siatka: pomylkowy wpis pod kluczem sklepu kazalby pytac Allegro
    // o zamowienie z WooCommerce i dopisac mu paczke z kurierem 'allegro' — czyli paczke,
    // ktorej nikt nie nadal, do zamowienia, ktore panel POWINIEN nadac sam.
    if (!z || !czyKanalAllegro(z)) return { dopisane: 0 };
    const klient = klienci[z.sklep];
    // Kanal skonfigurowany do odczytu zamowien, ale bez klienta tutaj, to tryb POPRAWNY
    // (ta sama zasada, co przy braku sekcji INPOST_* w moduly/wysylka/kurierzy.ts): panel po prostu
    // nie pyta i nie pokazuje numeru, zamiast wywalac sie na `undefined.pobierzPrzesylki`.
    if (!klient) return { dopisane: 0 };

    const przesylki = await klient.pobierzPrzesylki(z.zrodlo_id);
    let dopisane = 0;
    for (const p of przesylki ?? []) {
      // Napis ZAWSZE — ta sama pulapka, co przy `id` z ShipX (naIdentyfikator w
      // db/przesylki.js): sterownik node:sqlite wiaze liczby zmiennoprzecinkowo, wiec
      // w kolumnie TEXT ladowaloby „6000123456789.0", czyli numer, ktorego nie ma nigdzie.
      const numer = String(p?.waybill ?? '').trim();
      // Allegro tworzy przesylke ZANIM przewoznik przydzieli numer listu (ten sam stan, co
      // `tworzona_u_kuriera` przy InPoscie). Wiersz bez numeru bylby klamstwem — karta
      // pokazalaby paczke, ktorej nie da sie sledzic — wiec taka pozycje PRZEMILCZAMY.
      // Wroci z numerem przy najblizszym odswiezeniu.
      if (!numer) continue;
      // ⚠️ SPRAWDZENIE PO NUMERZE, NIE PO LICZBIE WIERSZY. Ta funkcja zobaczy ten sam numer
      // przy kazdym otwarciu karty, wiec bez tego dokladalaby paczke za paczka. Ale warunek
      // „zamowienie ma juz jakas paczke" byl by rownie zly w druga strone: DRUGI numer listu
      // (zamowienie rozbite na dwie paczki przy pakowaniu) nie pojawilby sie nigdy.
      //
      // ⚠️ TO NIE ZALATWIA DOSYLKI ZA PACZKE ZAGUBIONA — i nie ma prawa udawac, ze zalatwia.
      // Tamten drugi numer powstaje w Allegro DNI po tym, jak czlowiek oznaczyl zamowienie
      // jako wysłane, a wołający (karta) po oznaczeniu wysyłki pyta WYŁĄCZNIE wtedy, gdy
      // zamówienie nie ma jeszcze żadnej paczki (domena/allegro-numery.js).
      // Mechanizm jest wiec gotowy, ale wyzwalacz do niego nie dosiega: dosylki nadanej po
      // oznaczeniu wysylki panel NIE DOCIAGNIE — znane ograniczenie, opisane przy warunku
      // w moduly/zamowienia/karta.js (reguła: status wynika z faktów).
      const juzJest = db
        .prepare('SELECT 1 FROM przesylki WHERE zamowienie_id = ? AND numer_listu = ?')
        .get(zamowienieId, numer);
      if (juzJest) continue;

      // `kolejnosc` liczona TUTAJ i przekazana jawnie — ta sama zasada, co przy nadaniu
      // i przy rejestracji recznej: funkcja zapisu nigdy nie wylicza numeru sama, a indeks
      // unikalny rozstrzyga wyscig.
      // ⚠️ `zrodloNumeru: 'allegro'` JEST TU CAŁA OCHRONA TEGO NUMERU.
      // To ONO — a nie `kurier` i nie `nadana_recznie` — mowi bazie, ze numeru
      // NIKT nie przepisywal z reki, wiec literowki w nim byc nie moze i kasowac go nie wolno
      // (db/przesylki.js: skasujPrzesylkeReczna). `kurier` tego nie rozstrzyga, bo wiersz
      // wpisany Z REKI przy zamowieniu z Allegro tez ma kuriera 'allegro'.
      // ⚠️ `carrierId` Z TEJ SAMEJ ODPOWIEDZI. Bez niego
      // panel nie miałby kogo zapytać o statusy tych paczek, więc `status_kuriera` zostałby
      // NULL na zawsze, a reguła „bez ruchu" liczyłaby wiek od nadania i alarmowała bez końca
      // przy paczkach w rzeczywistości DORĘCZONYCH. Identyfikator MUSI isc stad, a nie ze stalej: zly
      // przewoznik oddaje HTTP 200 z `trackingDetails: null`, nie do odroznienia od paczki
      // swiezo nadanej.
      zarejestrujPrzesylkeReczna(db, zamowienieId, {
        kurier: 'allegro',
        kolejnosc: nastepnaKolejnosc(db, zamowienieId),
        numerListu: numer,
        zrodloNumeru: ZRODLO_NUMERU.ALLEGRO,
        carrierAllegro: String(p?.carrierId ?? '').trim() || null,
      });
      dopiszLog(db, zamowienieId, {
        akcja: AKCJA_LOGU,
        wynik: `numer listu przeczytany z Allegro: ${numer} — panel niczego nie nadał, tylko odnotował fakt`,
      });
      dopisane += 1;
    }
    return { dopisane };
  }

  return { odswiez };
}
