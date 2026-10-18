import { zapiszZamowienie } from '../../../oms/db/zamowienia.js';

// `od` — data, od ktorej panel w ogole zaglada do sklepu przy PIERWSZYM przebiegu.
// Bez niej sklep bez zapisanego kursora oznacza „przeczytaj cala historie": sklep A
// ma kilka tysiecy zamowien z wielu lat, wiec pierwszy przebieg to setki stron REST-a, ktore nie
// zdazyly sie skonczyc miedzy dwoma tykniernami zegara — i kazde kolejne tykniecie
// startowalo NASTEPNY przebieg od strony pierwszej. Panel jest lista roboca, a nie
// archiwum: zamowienia sprzed lat maja inna konfiguracje wysylki (instance_id „kurier"
// zamiast liczby), wiec wpadaja jako „nieznana metoda" i tylko zasmiecaja liste.
//
// ⚠️⚠️ `od` JEST TEZ TRWALA PODLOGA NA DATE ZLOZENIA, nie tylko oknem pierwszego przebiegu.
// Pierwsza wersja (01.08.2026) zawezala wylacznie pierwsze zapytanie i to NIE WYSTARCZYLO:
// tego samego dnia o 13:30 sklep DOTKNAL MASOWO calego archiwum (zamowienia z 2019, 2020
// i 2024 dostaly `date_modified_gmt` w tej samej sekundzie), wiec poller — poprawnie, bo
// byly zmodyfikowane po kursorze — wciagnal 500 zamowien sprzed lat. Filtr po dacie
// MODYFIKACJI nie da sie na tym oprzec: sklep moze dotknac czegokolwiek, kiedykolwiek.
// Podloga idzie po dacie ZLOZENIA, ktora sie nie zmienia.
//
// ⚠️ Poller NIE WIE, z czym rozmawia (Etap 4). Kanal — WooCommerce, Allegro, cokolwiek —
// przychodzi jako `kanal` i to ON zna ksztalt surowego zamowienia: ktore pole jest data
// modyfikacji, ktore data zlozenia i jak zamienic je na wiersz. Reguly ponizej (podloga,
// jeden przebieg naraz, kursor za najpozniejsza PRZETWORZONA modyfikacja) zostaja przez to
// JEDNE dla wszystkich kanalow. Druga ich kopia rozjechalaby sie po cichu, a pierwsza
// wersja tych regul wciagnela kilka tysiecy zamowien naraz.
export function createPoller({ db, kanal, sklep, od = null }) {
  // Zamowienie starsze niz `od` pomijamy przy ZAPISIE, ale kursor i tak przesuwamy —
  // inaczej przy kazdym przebiegu czytalibysmy je od nowa w kolko.
  const zeStarego = (surowe) => {
    if (!od) return false;
    const zlozone = kanal.zlozoneZ(surowe);
    return Boolean(zlozone) && zlozone < od;
  };

  // ⚠️ JEDEN PRZEBIEG NARAZ. setInterval tyka co 2 minuty niezaleznie od tego, czy
  // poprzedni przebieg sie skonczyl. Przy sklepie z dluga historia znaczylo to kilka
  // rownoleglych przebiegow czytajacych to samo od poczatku — obciazenie sklepu rosnace
  // z kazda minuta, i ani jeden zapisany kursor, bo zaden przebieg nie dobiegal konca.
  let wTrakcie = false;
  function stan() {
    return db.prepare('SELECT * FROM stan_pollera WHERE sklep = ?').get(sklep)
      ?? { sklep, zsynchronizowane_do: null, ostatni_przebieg_at: null, ostatni_blad: null };
  }

  // ⚠️ `rodzaj` ROZSTRZYGA, CZY BLAD BEDZIE DLAWIONY — i to na OBU progach naraz
  // (domain/zdrowie.js: ekran po `PROB_BLEDU_NA_EKRAN` probach, telefon po
  // `PROG_BLEDU_POLLERA_S`). Nie jest wiec etykieta opisowa, tylko decyzja:
  //   'awaria'     — rzut przebiegu (siec, timeout, dysk). Ponowienie za dwie minuty MOZE
  //                  pomoc, wiec alarm czeka, az blad zacznie TRWAC.
  //   'pominiecie' — zamowienie odrzucone przez mapowanie. Ponowienie nie pomoze nigdy
  //                  (dane u zrodla sie nie zmienia), a kursor juz przez nie przeskoczyl —
  //                  alarm musi pojsc OD RAZU, bo blad zgasnie przy najblizszym czystym
  //                  przebiegu i drugiej okazji nie bedzie.
  function zapiszStan({ kursor, blad, rodzaj = null }) {
    // ⚠️ POCZATEK SERII, NIE CZAS OSTATNIEJ WPADKI — i na tym polega cala wartosc tej
    // kolumny. Gdyby kazdy nieudany przebieg zapisywal tu `teraz`, blad bylby wiecznie
    // swiezy, czyli wiecznie dlawiony: sklep lezacy od godziny nie obudzilby NIKOGO,
    // dokladnie odwrotnie do zamiaru tej zmiany. Znacznik przesuwa sie wylacznie wtedy,
    // gdy poprzedni stan bledu NIE MIAL — czyli gdy seria naprawde sie zaczyna.
    const teraz = new Date().toISOString();
    // JEDEN odczyt na zapis — poprzedni stan niesie i poczatek serii, i jej licznik.
    const poprzedni = blad ? stan() : null;
    // ⚠️ LICZNIK NIEUDANYCH PRZEBIEGOW Z RZEDU. Rosnie przy KAZDEJ wpadce i wraca do zera
    // (NULL) przy pierwszym udanym przebiegu, bo „z rzedu" znaczy nieprzerwanie. To ON,
    // a nie `ostatni_blad_od_at`, rozstrzyga o komunikacie na ekranie (domain/zdrowie.js):
    // czas potrafi plynac bez ani jednej proby, liczba prob nie potrafi.
    // ⚠️ Nieparsowalna albo ujemna wartosc w kolumnie (obcy zapis, reczny UPDATE) liczymy
    // jak zero — licznik ma rosnac, a nie cofac sie w nieskonczonosc.
    const poprzednieProby = Number(poprzedni?.ostatni_blad_prob);
    const proby = blad
      ? (Number.isFinite(poprzednieProby) && poprzednieProby > 0 ? poprzednieProby : 0) + 1
      : null;
    db.prepare(`
      INSERT INTO stan_pollera (sklep, zsynchronizowane_do, ostatni_przebieg_at, ostatni_blad, ostatni_blad_od_at, ostatni_blad_rodzaj, ostatni_blad_prob)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(sklep) DO UPDATE SET
        zsynchronizowane_do = excluded.zsynchronizowane_do,
        ostatni_przebieg_at = excluded.ostatni_przebieg_at,
        ostatni_blad = excluded.ostatni_blad,
        ostatni_blad_od_at = excluded.ostatni_blad_od_at,
        ostatni_blad_rodzaj = excluded.ostatni_blad_rodzaj,
        ostatni_blad_prob = excluded.ostatni_blad_prob
    `).run(sklep, kursor, teraz, blad, blad ? (poprzedni?.ostatni_blad_od_at ?? teraz) : null, blad ? rodzaj : null, proby);
  }

  // ⚠️⚠️ IZOLACJA PER ZAMOWIENIE — CALA TRESC TEJ FUNKCJI I POWOD, DLA KTOREGO ISTNIEJE.
  //
  // Do 04.08.2026 rzut z `kanal.mapuj` leial przez petle prosto do `catch` przebiegu: kursor
  // zostawal na POPRZEDNIEJ wartosci i szedl dalej w gore. Nastepne tykniecie czytalo TE SAMA
  // strone, mapowanie rzucalo na TYM SAMYM zamowieniu — i kanal stal NA ZAWSZE, cicho, bo
  // panel dziala, a nowe zamowienia po prostu przestaja przychodzic. Jedynym wyjsciem byl
  // reczny UPDATE na `stan_pollera`, czyli wprost naruszenie niezmiennika 4.9
  // (docs/oms/PRZEWODNIK.md: panel nie moze wchodzic w stan, z ktorego nie umie wyjsc).
  // Wyzwalaczem jest KAZDA odmowa mapowania kanalu Allegro (domain/allegro-mapowanie.js:
  // nieparsowalna kwota zamowienia, pobranie na 0 zl, nieparsowalna cena pozycji) — czyli
  // JEDNO zamowienie o zlym ksztalcie zabijalo caly kanal.
  //
  // ⚠️ IZOLUJEMY WYLACZNIE MAPOWANIE, NIE ZAPIS. To nie jest oszczednosc, tylko granica
  // miedzy dwiema roznymi klasami awarii:
  //   * `kanal.mapuj` rzuca DETERMINISTYCZNIE i O JEDNO ZAMOWIENIE — ponowienie nigdy nie
  //     pomoze, bo dane u zrodla sie nie zmienia. Takie zamowienie ma zostac pominiete
  //     z zapisanym POWODEM, a kanal ma isc dalej.
  //   * `zapiszZamowienie` rzuca SYSTEMOWO (pelny dysk, SQLITE_FULL, baza tylko do odczytu,
  //     blad I/O) i dotyczy WSZYSTKICH zamowien naraz. Polkniety tutaj razem z przesunieciem
  //     kursora znaczylby zamowienia zgubione NA ZAWSZE — przy pelnym dysku CALY przebieg
  //     „udalby sie" bez ani jednego wiersza w bazie. Dlatego zapis zostaje POZA `try`:
  //     jego wyjatek dalej wychodzi z petli, kursor zostaje na poprzedniej wartosci
  //     i zamowienia wroca przy nastepnym przebiegu (zapis jest idempotentny).
  //
  // ⚠️ SKLEPOM TO NIC NIE ZMIENIA: `domain/mapowanie.js` (WooCommerce) nie rzuca NIGDY, wiec
  // dla `sklep_b` i `sklep_a` ta galaz nie uruchamia sie ani razu i przebieg wyglada jak dotad.
  //
  // Powod pominiecia bierzemy Z KOMUNIKATU BLEDU, a nie z zawartosci zamowienia — poller
  // NIE WIE, z czym rozmawia (patrz komentarz nad createPoller), wiec siegniecie po
  // `surowe.id` byloby tu wiedza o ksztalcie kanalu. Komunikaty mapowania Allegro i tak
  // niosa identyfikator zamowienia, bo pisane sa dla czlowieka.
  const powodPominiecia = (e) => (e?.message ? String(e.message) : String(e));

  // Zdanie dla paska na liscie zamowien (bootstrap.js: `stan()` oddaje stan pollera
  // z NIEPUSTYM bledem). Pominiete zamowienie MUSI byc widoczne: kursor przez nie
  // przeskakuje, wiec samo z siebie juz NIE WROCI — wroci dopiero, gdy zrodlo je zmodyfikuje.
  const opisPominietych = (powody) => `Pominięto ${powody.length} zamówien${powody.length === 1 ? 'ie' : 'ia'}`
    + ` (kursor przesunięty, same z siebie nie wrócą): ${powody.join(' | ')}`;

  async function przebieg() {
    if (wTrakcie) return { pobrane: 0, pominiety: true };
    wTrakcie = true;
    const poprzedni = stan().zsynchronizowane_do;
    let kursor = poprzedni;
    let pobrane = 0;
    let pominiete = 0;
    const powody = [];
    try {
      let strona = 1;
      let stron = 1;
      do {
        // ⚠️ DWA OSOBNE ARGUMENTY, I TO NIE JEST KOSMETYKA.
        //   `kursor` — ZAPISANY kursor pollera, czyli znacznik NAJPOZNIEJSZEJ przetworzonej
        //              MODYFIKACJI z poprzedniego udanego przebiegu. Jest `null`, dopoki
        //              pollera dla tego sklepu jeszcze nie bylo. `null` znaczy „nic nie
        //              wiem o tym, co juz przeczytalem" — i musi doleciec do adaptera JAKO
        //              null, a nie podmienione po cichu na `od`.
        //   `od`     — TRWALA PODLOGA PO DACIE ZLOZENIA (patrz komentarz nad createPoller).
        //              Obowiazuje w KAZDYM przebiegu, nie tylko pierwszym, bo sklep potrafi
        //              masowo dotknac archiwum i wtedy filtr po dacie modyfikacji wciaga
        //              zamowienia sprzed lat (01.08.2026: 500 sztuk z 2019, 2020 i 2024).
        // Nie skladamy ich tutaj w jedna wartosc, bo adapter, ktory WYBIERA miedzy nimi,
        // musi widziec PRAWDZIWY BRAK KURSORA. Allegro pyta albo po dacie modyfikacji, albo
        // po dacie zlozenia — gdyby dostawalo `kursor` juz podmieniony na `od`, na pustym
        // stanie zawsze trafialoby w galaz „mam kursor" i pytalo o WSZYSTKO zmodyfikowane
        // od daty startowej, czyli o cale archiwum. Woo sklada je sam: `kursor ?? od`.
        const { zamowienia, stron: ile } = await kanal.pobierzStrone({ od, kursor: poprzedni, strona });
        stron = ile;
        for (const surowe of zamowienia) {
          if (!zeStarego(surowe)) {
            // Mapowanie W IZOLACJI (patrz komentarz przy `powodPominiecia`): odmowa dotyczy
            // TEGO zamowienia i tylko jego. `null` znaczy „nie ma czego zapisac", a nie
            // „zamowienie puste" — pusty model nie ma tu jak powstac.
            let model = null;
            try {
              model = kanal.mapuj(surowe);
            } catch (e) {
              powody.push(powodPominiecia(e));
            }
            // ⚠️ ZAPIS POZA `try` — jego awaria jest systemowa i MA przerwac przebieg
            // (kursor zostaje, zamowienia wroca). Patrz komentarz wyzej.
            if (model) {
              zapiszZamowienie(db, sklep, model, surowe);
              pobrane += 1;
            }
          } else {
            pominiete += 1;
          }
          // Kursor idzie za NAJPOZNIEJSZA przetworzona modyfikacja, nie za czasem zegara —
          // inaczej zamowienie zmienione w trakcie przebiegu wypadloby z nastepnego okna.
          // UWAGA: bierzemy date_modified_gmt, NIE date_modified (czas lokalny sklepu).
          // Przy przejsciu na czas zimowy czas lokalny cofa sie o godzine wzgledem GMT —
          // kursor zapisany z date_modified zostalby godzine "przed" i zamowienia
          // zmodyfikowane po zmianie czasu nigdy wiecej by sie nie zmiescily w oknie.
          // (Ktore to pole — rozstrzyga adapter kanalu w `kursorZ`.)
          const znacznik = kanal.kursorZ(surowe);
          if (znacznik && (!kursor || znacznik > kursor)) kursor = znacznik;
        }
        strona += 1;
      } while (strona <= stron);
    } catch (e) {
      // Kursor zostaje na poprzedniej wartosci: lepiej pobrac te same zamowienia
      // drugi raz (zapis jest idempotentny) niz zgubic je na zawsze.
      zapiszStan({ kursor: poprzedni, blad: e.message, rodzaj: 'awaria' });
      throw e;
    } finally {
      // `finally`, nie koniec bloku `try`: przebieg zakonczony bledem MUSI zwolnic
      // blokade, inaczej jedna awaria sklepu wycisza pollera na zawsze — cicho,
      // bo panel dalej dziala i nikt nie patrzy na date ostatniego przebiegu.
      wTrakcie = false;
    }
    // ⚠️ POMINIECIE JEST BLEDEM PRZEBIEGU, mimo ze przebieg sie UDAL — i to jest cala
    // roznica wobec pominiecia po podlodze (`pominieteStare`), ktore jest stanem NORMALNYM
    // i milczy. Zamowienie odrzucone przez mapowanie to zamowienie, ktorego w panelu NIE MA
    // i ktore samo nie wroci; jedyne miejsce, w ktorym czlowiek moze sie o tym dowiedziec,
    // to pasek na liscie (bootstrap.js: `stan()` wybiera pollera z niepustym bledem).
    // Bez tego zapisu izolacja zamienialaby awarie glosna na CICHA — a to gorzej niz stojacy
    // kanal, bo stojacy kanal chociaz widac po braku nowych zamowien.
    zapiszStan({
      kursor,
      blad: powody.length ? opisPominietych(powody) : null,
      rodzaj: powody.length ? 'pominiecie' : null,
    });
    return {
      pobrane,
      ...(pominiete ? { pominieteStare: pominiete } : {}),
      ...(powody.length ? { pominieteBledem: powody.length } : {}),
    };
  }

  return { przebieg, stan };
}
