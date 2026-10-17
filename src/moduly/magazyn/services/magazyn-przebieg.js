// Przebieg odczytu katalogow uruchamiany PRZYCISKIEM — i stan tego przebiegu.
//
// ⚠️⚠️ POWOD ISTNIENIA: pelny odczyt to setki zadan do WooCommerce plus ~46 do Allegro przy
// limicie 10 s na zadanie. W czasie zycia jednego zadania HTTP to sie NIE MIESCI, a nawet
// gdyby — przegladarka trzymalaby pusta strone przez kilka minut, operator kliknalby drugi
// raz i ruszylby drugi przebieg. Dlatego trasa `POST /magazyn/odswiez` wola `start()`, ktory
// rusza odczyt i WRACA, a ekran pokazuje stan z `stan()`.
//
// ⚠️ STAN ZYJE W PAMIECI PROCESU, BEZ TABELY (rozstrzygniecie wlasciciela). To jeden przycisk
// dla jednego operatora: tabela byla by druga prawda o tym samym, migracja do utrzymania
// i kolejnym miejscem, ktore trzeba by sprzatac po restarcie kontenera. Restart gubi wynik
// ostatniego przebiegu — i tak ma byc: lustro w bazie zostaje, a stan przebiegu opisuje
// wylacznie to, co dzialo sie chwile temu.
import { odswiezMagazyn } from './magazyn-sync.js';

const chwila = () => new Date().toISOString();

// Blad rzucony jako napis (albo `null`) tez musi dac sie przeczytac — ten komunikat laduje
// na ekranie. Ta sama funkcja stoi w magazyn-sync.js i z tego samego powodu.
const opisBledu = (e) => (typeof e?.message === 'string' && e.message ? e.message : String(e));

const STAN_POCZATKOWY = {
  trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null,
};

/**
 * @param {object} p
 * @param {object} p.db
 * @param {Record<string, object>} [p.sklepy] — klienci Woo, zbudowani RAZ w bootstrap.js
 * @param {Record<string, object>} [p.allegro] — mapa kanal → klient (`klienciKanalow`)
 * @param {string[]} [p.kanalySklepow] — jawne klucze sklepów z konfiguracji modułu kanałów
 * @param {string[]} [p.kanalyAllegro] — jawne klucze kont z konfiguracji modułu kanałów
 * @param {typeof odswiezMagazyn} [p.odswiez] — wstrzykiwany wylacznie po to, zeby dalo sie
 *   sprawdzic testem, ze `start` wraca PRZED koncem odczytu
 * @param {(...czesci: unknown[]) => void} [p.log]
 */
export function createMagazynPrzebieg({ db, sklepy = {}, allegro = {}, odswiez = odswiezMagazyn, log, kanalySklepow, kanalyAllegro } = {}) {
  let stan = { ...STAN_POCZATKOWY };

  function start() {
    // ⚠️ STRAZNIK PRZED ZMIANA STANU, nie po niej. Dwa rownolegle przebiegi to dwa razy
    // setki zadan do tego samego sklepu i DWA rozne znaczniki `odczytane_at` — a ten ze
    // starszym stemplem oznaczylby jako zniknięte dokladnie to, co drugi wlasnie zapisal.
    //
    // ⚠️ ODMOWA NIE NIESIE KOMUNIKATU I TO JEST DECYZJA, NIE PRZEOCZENIE. Stal tu napis
    // „Odczyt katalogów już trwa…", ktorego NIKT NIE CZYTAL: trasa przekierowuje na liste,
    // a lista i tak mowi „trwa — nie zamykaj panelu" na podstawie `stan()`. Napis budowany
    // i wyrzucany jest gorszy niz jego brak — nastepna osoba zalozy, ze gdzies sie wyswietla,
    // i oprze na nim komunikat, ktorego uzytkownik nigdy nie zobaczy. Jedyne wejscie w ta
    // galaz to klikniecie ze STAREJ karty przegladarki (przycisk jest `disabled`, gdy przebieg trwa),
    // a po przekierowaniu czlowiek dostaje swiezy ekran z prawda o stanie.
    if (stan.trwa) return { wystartowal: false };

    // Caly stan zaklada sie OD NOWA, a nie doklada do poprzedniego: blad i liczby kanalow
    // z przebiegu sprzed godziny opisywalyby przebieg, ktory wlasnie ruszyl.
    stan = { ...STAN_POCZATKOWY, trwa: true, zaczety_at: chwila() };

    odswiez({
      db,
      sklepy,
      allegro,
      log,
      kanalySklepow,
      kanalyAllegro,
      // Postep jest OZDOBA i tak jest traktowany takze po tamtej stronie (magazyn-sync.js
      // lapie wyjatek z tej funkcji): usterka paska postepu nie ma prawa przerwac odczytu.
      postep: (info) => { stan.postep = info; },
    })
      .then((wynik) => { stan.kanaly = wynik?.kanaly ?? []; })
      // ⚠️ TU LADUJA WYLACZNIE AWARIE CALEGO PRZEBIEGU (np. smiec zamiast chwili) — bledy
      // POJEDYNCZYCH kanalow wracaja w `kanaly[].blad`, bo kanal, ktory padl, nie ma prawa
      // zatrzymac pozostalych trzech. Bez tego `catch` przebieg konczylby sie odrzucona
      // obietnica bez wlasciciela, czyli w najlepszym razie wpisem w logu, a w najgorszym
      // padnieciem procesu — i ekran nie mialby o czym powiedziec.
      .catch((e) => { stan.blad = opisBledu(e); })
      .finally(() => {
        stan.trwa = false;
        stan.skonczony_at = chwila();
        // Postep opisuje przebieg W TRAKCIE. Zostawiony po zakonczeniu twierdzilby, ze
        // odczyt stoi w polowie kanalu — o liczbach przebiegu mowi `kanaly`.
        stan.postep = null;
      });

    return { wystartowal: true };
  }

  // KOPIA, nie sam stan: widok dostaje obraz chwili, a nie uchwyt, ktorym da sie przestawic
  // przebieg. `kanaly` kopiowane osobno, bo rozsypanie obiektu kopiuje wylacznie referencje.
  const stanKopia = () => ({ ...stan, kanaly: [...stan.kanaly] });

  return { start, stan: stanKopia };
}
