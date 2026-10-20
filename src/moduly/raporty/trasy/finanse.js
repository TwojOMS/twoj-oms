import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { kluczOkresu } from '../../../domena/okres-rozliczeniowy.js';
import {
  zakresSkrotu, nazwaOkresu, poprzedniOkres, zakresMiesiaca,
} from '../../../domena/okresy-raportu.js';
import { zl, grosze } from '../../../domena/kwoty.js';
import {
  zapiszDaneMiesiaca, daneMiesiaca, rozjazdZus, miesiaceZDanymi,
} from '../../../oms/db/dane-miesieczne.js';
import { rachunekOkresuAsync as rachunek } from '../../../domena/rachunek-zarzadczy.js';
import { prognozaProgu } from '../../../domena/podatek-skala.js';
import { wylaczoneModuly } from '../../../oms/db/moduly-opcjonalne.js';

// Zakladka FINANSE — rachunek zarzadczy („ile z tego zostaje") i dane reczne miesiaca
// (ZUS, PIT-5, VAT-7). Do 17.08.2026 oba ekrany mieszkaly pod /raporty/zarzadczy
// i /raporty/dane; wyprowadzone na wlasna pozycje menu decyzja właściciela przy przebudowie
// raportow — Raporty zostaja czysta analiza sprzedazy, a „ile zostaje" jest osobna rzecza.
//
// ⚠️ STARE ADRESY DALEJ DZIALAJA (302 nizej): sa w zakladkach przegladarki, w wiki
// i w pamieci miesni. Przekierowanie zachowuje query string, wiec zapisany skrot
// „/raporty/zarzadczy?skrot=ten-kwartal" laduje na tym samym kwartale.
//
// ⚠️ TE TRASY NICZEGO NIE LICZA — caly rachunek sklada `rachunekOkresu`
// (domain/rachunek-zarzadczy.js), dane miesiaca db/dane-miesieczne.js. Tutaj zostaje
// parsowanie zakresu i zamiana odmowy domeny na zdanie dla czlowieka (wzorzec /raporty).

const WZORZEC_DNIA = /^\d{4}-\d{2}-\d{2}$/;
// Miesiac danych recznych — RRRR-MM, ten sam ksztalt, co kolumna `dane_miesieczne.miesiac`.
// ⚠️ NUMER MIESIACA JEST W REGULE, nie tylko liczba cyfr: `\d{2}` przepuszczalo „2026-13"
// i „2026-00", a takiego miesiaca nie ma. Na ekranie danych recznych oznaczaloby to wpis
// skladek do okresu, ktory nie istnieje; przy wyborze miesiaca na /finanse — zakres
// `2026-13-01 → 2026-13-31`, ktory kazde zapytanie o sprzedaz oddaje jako puste, bez bledu.
const WZORZEC_MIESIACA = /^\d{4}-(0[1-9]|1[0-2])$/;

// ⚠️⚠️ RACHUNEK ZARZADCZY MA WLASNA, KROTSZA LISTE SKROTOW — i to nie jest ozdoba.
//
// Brakuje w niej dwoch, ktore na ekranie sprzedazy sa poprawne, a tutaj byly by pulapka:
//   • `poprzedni-rok` — do konca 2026 wskazuje rok SPRZED PODLOGI (2026-01), wiec przycisk
//     prowadzilby wylacznie w odmowe. Przycisk, ktory zawsze konczy sie bledem, uczy
//     operatora ignorowac komunikaty;
//   • `ostatnie-30` — to z definicji zakres URWANY w polowie miesiaca, a koszty, ZUS i PIT-5
//     sa MIESIECZNE. Rachunek odjalby od trzydziestu dni sprzedazy koszty dwoch pelnych
//     miesiecy i pokazal zapasc, ktorej nie bylo. Zakres wpisany recznie takze to potrafi
//     — i wlasnie dlatego ekran stawia wtedy pasek ostrzegawczy (`pelneMiesiace`) — ale
//     GOTOWY PRZYCISK do tego nie jest zaproszeniem, ktore chcemy wysylac.
//
// ⚠️⚠️ LISTA ZMIENIONA 21.08.2026 (zgloszenie właściciela): kwartaly stoja WPROST po numerze
// (Q1–Q4), a nie wzglednie („ten"/„poprzedni"), i znika „Ten miesiac". Powody:
//   • kwartal wskazany numerem odpowiada na pytanie, ktore wlasciciel naprawde zadaje
//     („jak wyszedl Q1"); relatywnymi przyciskami Q1 w sierpniu w ogole nie dalo sie
//     wskazac — trzeba bylo wpisywac obie daty recznie;
//   • `ten-miesiac` na TYM ekranie zaprasza do pomylki, przed ktora ekran broni sie
//     wszedzie indziej: miesiac TRWAJACY ma pelna sprzedaz przy niepelnych kosztach, wiec
//     zysk wychodzi zawyzony (dlatego /finanse otwiera sie na miesiacu POPRZEDNIM).
//
// ⚠️ ZDJETY PRZYCISK TO NIE ZDJETY ADRES: `?skrot=ten-kwartal` i `?skrot=ten-miesiac` dalej
// dzialaja, bo siedza w zakladkach przegladarki, w wiki i w przekierowaniu ze starego
// `/raporty/zarzadczy`. Trasa NIE waliduje `skrot` po tej liscie — robi to `zakresSkrotu`.
const SKROTY_ZARZADCZE = ['poprzedni-miesiac', 'q1', 'q2', 'q3', 'q4', 'ten-rok'];

/**
 * Dzien z parametru albo `null`.
 * ⚠️ Walidacje robi `kluczOkresu`, NIE `new Date`: V8 nie odrzuca dat kalendarzowo
 * niepoprawnych, tylko je cicho przewija — `new Date('2026-02-30')` to 2 marca.
 */
function dzienZParametru(surowa) {
  if (typeof surowa !== 'string' || !WZORZEC_DNIA.test(surowa.trim())) return null;
  try { kluczOkresu(surowa.trim()); } catch { return null; }
  return surowa.trim();
}

// ⚠️ CZAS WARSZAWSKI, nie UTC — ta sama funkcja, co przy /koszty i /raporty. Pierwszego
// dnia miesiaca o 01:30 czasu polskiego `new Date().toISOString()` pokazuje jeszcze miesiac
// POPRZEDNI, wiec ekran otwieralby sie na innym miesiacu, niz mowi kalendarz na scianie.
const dzisiaj = () => dzienWarszawa(new Date().toISOString());

/**
 * Miesiac przesuniety o `o` pozycji, 'RRRR-MM'.
 * ⚠️ `Date.UTC(rok, miesiac - 1 + o, 1)` sam przechodzi przez granice roku — recznego warunku
 * na styczen i grudzien nie ma i nie ma go byc.
 */
function przesunMiesiac(miesiac, o) {
  const d = new Date(Date.UTC(Number(miesiac.slice(0, 4)), Number(miesiac.slice(5, 7)) - 1 + o, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function zarejestrujTrasyFinansow(app, { db, config }) {
  // ——— RACHUNEK ZARZADCZY: „ile z tego zostaje" ————————————————————————————————————
  app.get('/finanse', async (req, reply) => {
    // Jedna podłoga dla całego żądania, także dla okresu porównawczego.
    const PODLOGA = config.podlogaKosztow;
    const rachunekOkresu = (baza, zakres) => rachunek(baza, zakres, {
      regulySprzedazy: config.regulySprzedazy, podlogaKosztow: PODLOGA, definicje: config.definicje,
    });
    const dzien = dzisiaj();
    let zakres;
    // ——— WYBOR MIESIACA ——————————————————————————————————————————————————————————
    // ⚠️ `<input type="month">` to zwykly GET bez ani jednej linii skryptu — przegladarka
    // umie z niego zlozyc wylacznie `?miesiac=RRRR-MM`. Przekladamy to na PRAWDZIWY zakres
    // `od`/`do` przekierowaniem, zeby w pasku adresu stal okres, ktory da sie zapisac
    // w zakladkach i wykleic na czacie (ta sama decyzja, co przy /finanse/dane).
    // ⚠️ Sprawdzenie stoi PRZED galezia `od`/`do`: gdyby przegladarka wyslala oba naraz,
    // wybor miesiaca ma wygrac — to on byl ostatnim ruchem operatora.
    if (req.query.miesiac !== undefined) {
      const miesiac = String(req.query.miesiac).trim();
      // ⚠️ ODMOWA, a nie cichy skok na miesiac biezacy — ta sama zasada, co przy zlej dacie
      // w `od`/`do`. Podstawiony miesiac znaczylby, ze operator patrzy na inny okres,
      // niz wpisal, i wyciaga wnioski o pieniadzach z cudzego miesiaca.
      if (!WZORZEC_MIESIACA.test(miesiac)) {
        return reply.code(400).send('Niepoprawny miesiąc: oczekiwane RRRR-MM (np. 2026-06).');
      }
      const m = zakresMiesiaca(miesiac);
      return reply.redirect(`/finanse?od=${m.od}&do=${m.do}`, 302);
    }
    if (req.query.od || req.query.do) {
      const od = dzienZParametru(req.query.od);
      const doDnia = dzienZParametru(req.query.do);
      // ⚠️ ZLA DATA I ODWROCONY ZAKRES TO BLAD, NIE PUSTY RACHUNEK — przepuszczone dalej
      // oddaja 200 i zerowy wynik, a zera nikt nie kwestionuje.
      if (!od || !doDnia) {
        return reply.code(400).send('Niepoprawna data: parametry od i do muszą być '
          + 'istniejącymi dniami w formacie RRRR-MM-DD.');
      }
      if (od > doDnia) {
        return reply.code(400).send('Niepoprawny zakres: parametr od nie może być późniejszy niż do.');
      }
      zakres = { od, do: doDnia, etykieta: null };
    } else {
      try {
        // ⚠️ POPRZEDNI miesiac, a nie biezacy (inaczej niz na /raporty). Rachunek zarzadczy
        // ma sens dopiero dla miesiaca ZAMKNIETEGO: w trwajacym nie ma jeszcze ani kompletu
        // faktur kosztowych, ani ZUS-u, ani PIT-5 — a niepelne koszty przy pelnej sprzedazy
        // daja zysk wyzszy niz prawdziwy.
        // ⚠️ `doKonca: true` — RACHUNEK ZOSTAJE PRZY PELNYCH OKRESACH. Na ekranie sprzedazy
        // skroty „ten…" koncza sie DZIS; tutaj to samo przyciecie byloby szkodliwe: koszty,
        // ZUS i PIT-5 sa MIESIECZNE, wiec zakres urwany w polowie miesiaca konczy sie
        // paskiem „nie pokrywa sie z pelnymi miesiacami" i rachunek nie liczy nic.
        zakres = zakresSkrotu(req.query.skrot || 'poprzedni-miesiac', dzien, { doKonca: true });
      } catch (e) {
        return reply.code(400).send(komunikatDlaOperatora(e));
      }
    }

    try {
      const rachunek = await rachunekOkresu(db, zakres);

      // ——— DELTY WZGLEDEM OKRESU POPRZEDNIEGO ————————————————————————————————————
      // ⚠️⚠️ PODLOGA `2026-01` OBOWIAZUJE TAKZE OKRES PORONAWCZY, i dlatego sprawdzamy ja
      // ZAWCZASU, zamiast lapac wyjatek z `rachunekOkresu`. Zlapany wyjatek zamienilby sie
      // w ciche zero, a delta „−100%" wobec okresu, ktorego panel nie zna, wyglada dokladnie
      // tak samo wiarygodnie jak policzona naprawde.
      const zakresWczesniej = poprzedniOkres(zakres);
      const wczesniej = zakresWczesniej.od.slice(0, 7) >= PODLOGA
        ? await rachunekOkresu(db, zakresWczesniej)
        : null;
      // ⚠️ BRAK PODSTAWY DAJE `null`, NIE ZERO — ta sama regula, co w `delty`
      // (domain/agregacja-sprzedazy.js). „Zostaje" bywa `null` po obu stronach i wtedy
      // porownania nie ma z czego zrobic.
      const zmiana = (a, b) => (a === null || b === null || !b ? null : ((a - b) / b) * 100);

      // ⚠️ PROGNOZA NIE PATRZY NA POCZATEK ZAKRESU — i to jest celowe, nie przeoczenie.
      // Podstawa podatku liczy sie ZAWSZE narastajaco od stycznia do `zakres.do`
      // (rachunek-zarzadczy.js), wiec dzien, od ktorego operator oglada rachunek, nie ma tu
      // nic do rzeczy: prognoza dotyczy ROKU, nie okresu na ekranie.
      //
      // ⚠️ Stal tu kiedys dodatkowy warunek `rachunek.pelneMiesiace`. Zdjety 17.08.2026 po
      // tescie mutacyjnym: mutacja kasujaca go PRZEZYLA cala suite, bo jedyny warunek, ktory
      // naprawde broni prognozy przed zawyzonym tempem — koniec zakresu w polowie miesiaca —
      // rozstrzyga sama `prognozaProgu`. Podwojny warunek nie chronil przed niczym, a gasil
      // POPRAWNA prognoze dla zakresu zaczynajacego sie w srodku miesiaca.
      const prognoza = prognozaProgu({
        podstawaGrosze: rachunek.podatek.podstawaGrosze,
        doDnia: zakres.do,
      });

      return reply.view('finanse.ejs', {
        title: 'Rachunek zarządczy',
        zakres,
        nazwa: nazwaOkresu(zakres),
        // Wartosc startowa pola `<input type="month">` w pasku filtrow.
        // ⚠️ TYLKO GDY ZAKRES JEST DOKLADNIE PELNYM MIESIACEM. Przy zakresie „kwiecien–
        // czerwiec" podstawiony tam czerwiec (`od.slice(0, 7)`) mowilby, ze ogladamy czerwiec
        // — a pole formularza czyta sie jak podpis okresu, nie jak resztka po poprzednim.
        miesiacWyboru: (() => {
          const m = zakres.od.slice(0, 7);
          const pelny = zakresMiesiaca(m);
          return pelny.od === zakres.od && pelny.do === zakres.do ? m : '';
        })(),
        podloga: PODLOGA,
        skroty: SKROTY_ZARZADCZE.map((klucz) => {
          const s = zakresSkrotu(klucz, dzien, { doKonca: true });
          return {
            klucz,
            etykieta: s.etykieta,
            // ⚠️⚠️ OKRES, KTORY SIE JESZCZE NIE ZACZAL, NIE JEST ODNOSNIKIEM — widok rysuje
            // go wygaszonego, jak miesiac przyszly w pasku na /finanse/dane. Q4 ogladany
            // w sierpniu nie ma ani jednej sprzedazy, ani jednego kosztu i ani jednego wpisu
            // ZUS-u: przycisk prowadzilby WYLACZNIE w „nie wpisano danych za 2026-10,
            // 2026-11, 2026-12", a przycisk zawsze konczacy sie odmowa uczy operatora
            // ignorowac komunikaty (to samo uzasadnienie, co przy braku `poprzedni-rok`).
            przyszly: s.od > dzien,
          };
        }),
        rachunek,
        prognoza,
        delty: {
          przychod: zmiana(rachunek.przychodNettoGrosze, wczesniej?.przychodNettoGrosze ?? null),
          wynik: zmiana(rachunek.wynikGrosze, wczesniej?.wynikGrosze ?? null),
          zostaje: zmiana(rachunek.zostajeGrosze, wczesniej?.zostajeGrosze ?? null),
        },
        // Podpis delty: czlowiek ma widziec, Z CZYM porownuje. Bez okresu porownawczego
        // nie ma czego podpisywac — `null`, nie nazwa okresu, ktorego nie policzylismy.
        nazwaWczesniej: wczesniej ? nazwaOkresu(zakresWczesniej) : null,
        // ⚠️ ZAMIANA GROSZY NA ZLOTOWKI IDZIE Z DOMENY (domain/kwoty.js), a nie z wlasnego
        // dzielenia w szablonie — ta sama decyzja, co przy /raporty.
        zl,
        // PRZ-102.22: wyłączony moduł Koszty (Ustawienia → Moduły) to sam pasek. Arytmetyka bez zmian: koszty już
        // w bazie to fakty i dalej się liczą; nowych panel nie pobierze, więc rachunek przestaje być kompletny.
        kosztyWylaczone: wylaczoneModuly(db).includes('koszty'),
      });
    } catch (e) {
      // ⚠️ Podloga historii kosztow (2026-01) i brak granicy kanalu maja dac ZDANIE DLA
      // CZLOWIEKA, nie piecsetke. Blad techniczny leci dalej, do logu.
      if (!e?.dlaOperatora) throw e;
      // PRZ-102.09: brak podłogi to stan nowej instalacji, nie błąd — ekran z pytaniem zamiast zdania w tekście.
      if (!PODLOGA) return reply.code(400).view('finanse-brak-pokrycia.ejs', {
        title: 'Finanse', admin: req.konto?.admin === true, powrot: req.url,
      });
      return reply.code(400).send(`Nie da się policzyć rachunku: ${komunikatDlaOperatora(e)}`);
    }
  });

  // ——— DANE RECZNE MIESIACA: ZUS, PIT-5, VAT-7 ————————————————————————————————————
  // ⚠️ TE TRZY LICZBY NIE PRZYCHODZA Z ZADNEGO API — inFakt trzyma skladki, KPiR i podatek
  // poza planem taryfowym, wiec wlasciciel wpisuje je recznie, raz na miesiac.
  const ekranDanych = (reply, miesiac) => {
    const dane = daneMiesiaca(db, miesiac);
    // ⚠️ ROZJAZD, SKLADNIKI I PRZELEW LICZONE W JEDNYM MIEJSCU (rozjazdZus), NIE PRZEZ
    // WLASNE SUMOWANIE TRZECH POL TUTAJ (przewodnik OMS, 4.5). `rozjazd = razem - skladniki`,
    // wiec `skladniki = razem - rozjazd`: odtwarzamy je z JUZ POLICZONEJ roznicy.
    //
    // ⚠️ `rozjazdZus`/`grosze()` RZUCAJA przy napisie nie do przeliczenia (np. reczny wpis
    // z przecinkiem) — to BLAD OPERATORA, nie usterka panelu. Ekran ma pokazac miesiac mimo
    // to, tylko bez rozjazdu, zamiast oddac piecsetke na kazdym wejsciu.
    let rozjazd = null;
    let skladnikiGrosze = null;
    let razemGrosze = null;
    try {
      rozjazd = rozjazdZus(dane);
      if (rozjazd !== null) {
        razemGrosze = grosze(dane.zus_razem, 'zus_razem');
        skladnikiGrosze = razemGrosze - rozjazd;
      }
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
    }
    // ——— PASEK MIESIECY ROKU ————————————————————————————————————————————————————
    // ⚠️ Rok OGLADANEGO miesiaca, nie biezacy — wchodzac w grudzien 2025 operator ma
    // widziec pasek 2025, a nie kalendarz roku, w ktorym akurat siedzi zegar.
    const rok = miesiac.slice(0, 4);
    const zDanymi = miesiaceZDanymi(db, rok);
    const biezacy = dzisiaj().slice(0, 7);
    const miesiaceRoku = Array.from({ length: 12 }, (_, i) => {
      const klucz = `${rok}-${String(i + 1).padStart(2, '0')}`;
      return {
        klucz,
        // ⚠️ TRZY STANY, NIE DWA. Miesiac z PRZYSZLOSCI nie jest „zalegly" — skladki za
        // wrzesien nie da sie wpisac w sierpniu, wiec ostrzegawcza barwa przy nim uczylaby
        // operatora ignorowac ostrzezenia (ta sama zasada, co przy skrocie prowadzacym
        // zawsze w odmowe).
        stan: zDanymi.has(klucz) ? 'ok' : (klucz > biezacy ? 'przyszly' : 'brak'),
        aktywny: klucz === miesiac,
      };
    });

    return reply.view('finanse-dane.ejs', {
      title: 'Dane miesiąca',
      miesiac,
      dane,
      rozjazd,
      skladnikiGrosze,
      razemGrosze,
      rok,
      miesiaceRoku,
      // Strzalki przechodza przez granice roku — `Date.UTC(rok, -1, 1)` sam cofa rok,
      // wiec recznego warunku na styczen i grudzien NIE piszemy.
      poprzedniMiesiac: przesunMiesiac(miesiac, -1),
      nastepnyMiesiac: przesunMiesiac(miesiac, 1),
      zl,
    });
  };

  app.get('/finanse/dane', async (req, reply) => {
    const podanyMiesiac = String(req.query.miesiac ?? '');
    // ⚠️ Formularz wyboru miesiaca (`<input type="month">`) jest zwyklym GET-em bez ani
    // jednej linii skryptu — przegladarka umie z niego zlozyc wylacznie zapytanie
    // (`?miesiac=...`), nigdy segment adresu. Poprawny miesiac dostaje wiec PRAWDZIWY
    // adres `/finanse/dane/<miesiac>` przez przekierowanie: bez tego adresu nie daloby
    // sie zapisac w zakladkach ani wykleic na czacie.
    if (WZORZEC_MIESIACA.test(podanyMiesiac)) {
      return reply.redirect(`/finanse/dane/${podanyMiesiac}`, 302);
    }
    return ekranDanych(reply, dzisiaj().slice(0, 7));
  });

  app.get('/finanse/dane/:miesiac', async (req, reply) => {
    // ⚠️ W ADRESIE nieczytelny miesiac ODMAWIA. Podstawienie biezacego znaczyloby, ze
    // operator patrzy na inny miesiac, niz wpisal w pasku — i wpisze skladki do
    // niewlasciwego okresu.
    if (!WZORZEC_MIESIACA.test(req.params.miesiac)) {
      return reply.code(400).send('Niepoprawny miesiąc w adresie (oczekiwane RRRR-MM).');
    }
    return ekranDanych(reply, req.params.miesiac);
  });

  app.post('/finanse/dane', async (req, reply) => {
    const miesiac = String(req.body?.miesiac ?? '');
    if (!WZORZEC_MIESIACA.test(miesiac)) {
      return reply.code(400).send('Niepoprawny miesiąc (oczekiwane RRRR-MM).');
    }
    try {
      // ⚠️ PUSTE POLE ZAPISUJE SIE JAKO BRAK (`null`), nie jako '0.00' — patrz
      // zapiszDaneMiesiaca w db/dane-miesieczne.js. Zero jest zdaniem o faktach
      // („zaliczki nie bylo"), a brak wiersza ma dac ostrzezenie, nie ciche zero.
      zapiszDaneMiesiaca(db, miesiac, req.body ?? {});
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      return reply.code(400).send(komunikatDlaOperatora(e));
    }
    return reply.redirect(`/finanse/dane/${miesiac}`, 302);
  });

  // ——— STARE ADRESY → 302 ——————————————————————————————————————————————————————————
  // Zakladki przegladarki, wiki i pamiec miesni znaja /raporty/zarzadczy i /raporty/dane.
  // ⚠️ QUERY STRING JEDZIE DALEJ — zapisany skrot ma ladowac na tym samym okresie.
  const zQuery = (req, adres) => {
    const i = String(req.raw.url).indexOf('?');
    return i < 0 ? adres : adres + String(req.raw.url).slice(i);
  };
  app.get('/raporty/zarzadczy', async (req, reply) => reply.redirect(zQuery(req, '/finanse'), 302));
  app.get('/raporty/dane', async (req, reply) => reply.redirect(zQuery(req, '/finanse/dane'), 302));
  app.get('/raporty/dane/:miesiac', async (req, reply) => reply.redirect(`/finanse/dane/${req.params.miesiac}`, 302));
}
