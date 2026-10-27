import { czyPoraPobrania } from '../../../domena/pora-pobrania.js';
import { miesiaceDoPrzegladu } from '../../../domena/archiwum-sprzedazy.js';
import { zakresMiesiaca } from '../../../domena/lista-faktur.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import {
  wierszeMiesiaca, stanArchiwumSprzedazy, odnotujUdanyPrzebiegArchiwum, zapiszBladArchiwum,
} from '../db/archiwum-sprzedazy.js';
import { zarchiwizujDokument, oznaczSkasowanyDokument } from './archiwum-sprzedazy.js';
// Wylacznie stale — straznik czasu przebiegu nizej liczy sie z PRAWDZIWYCH limitow klienta,
// a nie z liczb przepisanych do komentarza (ta sama zasada, co w services/czuwacz-kosztow.js).
import { LIMIT_ZADANIA_MS, NAJDLUZSZA_LISTA_MS } from '../../../oms/infakt/client.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';

// Nocny czuwacz archiwum sprzedazy (spec 2026-09-02, Czesc B). Zegar godzinowy (bootstrap.js,
// `uruchomZegary`), praca w JEDNYM oknie na dobe: 4:00 czasu Warszawy — godzine PO czuwaczu
// kosztow (3:00), zeby dwa nocne przebiegi nie szly rownolegle. Przycisk na /faktury wola
// `przebieg({ wymuszony: true })` o kazdej porze.
//
// ⚠️ SIOSTRZANY MODUL: services/czuwacz-kosztow.js (KSeF) — ta sama konstrukcja: straznik
// „trwa", pora, budzet CZASU zamiast sufitu sztuk, licznik bledow z rzedu. Roznica: tutaj
// nie ma kursora — kazdej nocy przeglada sie PELNE listy ostatnich trzech miesiecy, bo inFakt
// nie ma `updated_at` i tylko pelna lista pozwala wykryc poprawiona albo skasowana fakture.
export const GODZINA_ARCHIWUM_SPRZEDAZY = 4;

// ⚠️ BUDZET CZASU, A NIE SUFIT SZTUK — ta sama lekcja, co w czuwaczu kosztow i przy
// wystawianiu faktur hurtem: jedno pobranie PDF-u to jedno zadanie HTTP do inFaktu plus zapis
// na NAS przez SMB, a przy pierwszym przebiegu (od stycznia) idzie ich kilkaset. Sufit sztuk
// nie mowi NIC o tym, ile przebieg potrwa, gdy inFakt albo dysk odpowiadaja wolno. Zaleglosc
// nie przepada: kolejka jest STANEM (odcisk w `archiwum_sprzedazy`), wiec reszta wraca sama
// nastepnej nocy — a podloga zostaje NIEZROBIONA, wiec nastepny przebieg znowu idzie od
// stycznia, a nie od trzech ostatnich miesiecy.
export const BUDZET_ARCHIWUM_SPRZEDAZY_MS = 10 * 60 * 1000;

// ⚠️⚠️ NAJGORSZY MOZLIWY CZAS JEDNEGO PRZEBIEGU — LICZONY, A NIE OPISANY W KOMENTARZU
// (recenzja calej galezi). `bootstrap.js` odmawia startu panelu, gdy ta liczba nie miesci sie
// miedzy tyknieciami zegara czuwaczy, wiec podniesienie ktorejkolwiek ze skladowych bez
// policzenia skutku ma POLOZYC PANEL PRZY STARCIE, a nie po cichu rozjechac nocny zegar.
// Ta sama regula, co przy `NAJDLUZSZY_PRZEBIEG_MS` (czuwacz-ksef.js) i `NAJDLUZSZY_PRZEBIEG_
// KOSZTOW_MS` (czuwacz-kosztow.js).
//
// Trzy skladniki, kazdy z modulu, ktory go naprawde narzuca:
//   • BUDZET CZASU tego czuwacza — bramka stoi PRZED pobraniem dokumentu ORAZ przed listami
//     kolejnego miesiaca, wiec ogranicza CALA petle miesiecy, nie tylko pobierania;
//   • JEDNA LISTA MIESIACA (`NAJDLUZSZA_LISTA_MS`, infakt/client.js) — ta, ktora zdazyla
//     wystartowac tuz przed granica budzetu. Faktury i korekty ida rownolegle (`Promise.all`),
//     wiec liczy sie DLUZSZA z nich, a nie suma;
//   • JEDNO POBRANIE DOKUMENTU (`LIMIT_ZADANIA_MS`) — z tego samego powodu: budzet sprawdza
//     sie PRZED pobraniem, nie w jego trakcie.
//
// ⚠️ SUMA JEST SUFITEM HOJNYM, I TO JEST CELOWE: ostatnie dwa skladniki wykluczaja sie
// w praktyce (po przekroczonym budzecie na listach petla dokumentow od razu odbija), ale
// straznik ma zawyzac, a nie zanizac.
//
// ⚠️ BEZ BRAMKI BUDZETU PRZED LISTAMI TA LICZBA BYLABY FIKCJA. Do recenzji calej galezi budzet
// pilnowal WYLACZNIE petli po dokumentach, wiec przebieg z pustymi miesiacami pobieral listy
// wszystkich miesiecy od podlogi (a tych przybywa z kazdym miesiacem kalendarza) i „najgorszy
// przypadek" rosl bez zadnej granicy — dokladnie ten rodzaj arytmetyki, ktora wyglada
// na straznika i nie strzeze niczego.
export const NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS = BUDZET_ARCHIWUM_SPRZEDAZY_MS
  + NAJDLUZSZA_LISTA_MS + LIMIT_ZADANIA_MS;

// PRZ-118.05: te same trzy składniki z limitów WYBRANEGO programu (`opis.limity`): jedna lista miesiąca
// = `najdluzszaListaMs`, jedno pobranie dokumentu = `zadanieMs`. Strażnik startu w moduly/faktury/modul.ts.
export function najdluzszyPrzebiegArchiwumSprzedazyMs(limity) {
  return BUDZET_ARCHIWUM_SPRZEDAZY_MS + limity.najdluzszaListaMs + limity.zadanieMs;
}

// ⚠️ HAMULEC NA MARTWE ZRODLO (wzorzec `LIMIT_KOLEJNYCH_BLEDOW_ARCHIWUM`, czuwacz-kosztow.js).
// inFakt nieosiagalny albo NAS odmontowany znaczy, ze KAZDY nastepny dokument odbije sie tak
// samo — bez licznika przebieg waliby w martwe zrodlo tyle razy, ile jest dokumentow w trzech
// miesiacach. Licznik liczy bledy Z RZEDU i zeruje sie po kazdym udanym dokumencie, bo jedna
// faktura, ktorej inFakt nie oddaje, nie ma prawa zablokowac calego archiwum na zawsze.
export const LIMIT_KOLEJNYCH_BLEDOW = 3;

// ⚠️ POWODY POMINIECIA SA STALYMI, A NIE NAPISAMI U WOLAJACEGO — bootstrap loguje TYLKO jeden
// z nich. „Nie ta pora" zdarza sie 23 razy na dobe i jest stanem poprawnym; wpis o nim przy
// kazdym tyknieciu utopilby prawdziwa awarie.
export const POWOD_TRWA = 'poprzedni przebieg jeszcze trwa';
export const POWOD_NIE_TA_PORA = 'nie ta pora';

// PRZ-118.07: listy i PDF-y czyta PROGRAM FAKTUROWY (`{ program }` albo stary `{ infakt }` przez `zProgramu`). Budżet
// przebiegu z `opis.limity` programu liczy `najdluzszyPrzebiegArchiwumSprzedazyMs(limity)` wyżej — strażnik startu w modul.ts.
export function createCzuwaczArchiwumSprzedazy({
  db, program: programPodany = null, infakt = null, katalogArchiwum, teraz = () => new Date(), log = console.error,
  // Wstrzykiwalne wylacznie dla testow — ta sama zasada, co przy `archiwizuj` w czuwaczu kosztow.
  archiwizuj = zarchiwizujDokument, oznaczSkasowany = oznaczSkasowanyDokument,
}) {
  const program = zProgramu({ program: programPodany, infakt });
  // ⚠️ JEDEN PRZEBIEG NARAZ. Zegar tyka niezaleznie od tego, czy poprzedni przebieg sie
  // skonczyl, a przycisk „Odswiez teraz" wcisniety w trakcie nocnego przebiegu dawalby dwa
  // przeglady tych samych miesiecy, piszace rownolegle te same pliki. Zwalniana w `finally`:
  // blokada zostawiona po bledzie wyciszylaby czuwacza na zawsze, bez ani jednego sladu.
  let trwa = false;

  async function przebieg({ wymuszony = false } = {}) {
    if (trwa) return { pominiety: true, powod: POWOD_TRWA };
    if (!wymuszony && !czyPoraPobrania(teraz(), GODZINA_ARCHIWUM_SPRZEDAZY)) {
      return { pominiety: true, powod: POWOD_NIE_TA_PORA };
    }
    trwa = true;
    const wynik = {
      miesiecy: 0, pobranych: 0, adoptowanych: 0, nadpisanych: 0, bezZmian: 0, skasowanych: 0, niedokonczone: false,
    };
    const koniecBudzetu = teraz().getTime() + BUDZET_ARCHIWUM_SPRZEDAZY_MS;
    const bledy = [];
    let bledyZRzedu = 0;
    try {
      // Podloga zrobiona = pierwszy pelny przeglad od stycznia 2026 doszedl do konca. Dopoki
      // nie jest, kazdy przebieg zaczyna od stycznia (domain/archiwum-sprzedazy.js).
      const podlogaZrobiona = Boolean(stanArchiwumSprzedazy(db)?.podloga_zrobiona_at);
      // ⚠️ DZIEN WARSZAWSKI, NIE UTC. Kontener chodzi z TZ=UTC — o 00:xx czasu Warszawy
      // (latem UTC+2) jest jeszcze POPRZEDNI dzien wg UTC. Okno „ostatnie trzy miesiace"
      // liczone od UTC ucielaby biezacy miesiac wlasnie w tych minutach po polnocy, kiedy
      // czuwacz naprawde startuje (godzina 4 czasu Warszawy).
      const miesiace = miesiaceDoPrzegladu({ dzis: dzienWarszawa(teraz().toISOString()), podlogaZrobiona });

      for (const miesiac of miesiace) {
        if (wynik.niedokonczone) break;
        // ⚠️⚠️ BUDZET OBEJMUJE TEZ POBIERANIE LIST, A NIE TYLKO POBIERANIA DOKUMENTOW.
        // Bramka nizej (w petli po dokumentach) NIE WYSTARCZA: przy miesiacach bez ani jednego
        // dokumentu petla wewnetrzna sie nie zakreci, wiec budzet nie bylby sprawdzony ANI RAZU,
        // a pierwszy przebieg od podlogi ciagnie listy WSZYSTKICH miesiecy — kazda do jedenastu
        // sekwencyjnych rund po 60 s (infakt/client.js, `NAJDLUZSZA_LISTA_MS`), i tych miesiecy
        // przybywa z kazdym miesiacem kalendarza. Bez tej bramki `NAJDLUZSZY_PRZEBIEG_ARCHIWUM_
        // SPRZEDAZY_MS` bylby liczba bez pokrycia, a straznik w bootstrap.js — straznikiem
        // niczego. Zaleglosc nie przepada: podloga zostaje niezrobiona, reszta jedzie nastepnej nocy.
        if (teraz().getTime() >= koniecBudzetu) {
          log('Archiwum sprzedazy: budzet czasu wyczerpany przed miesiacem ' + miesiac
            + ' — reszta pojedzie nastepnej nocy.');
          wynik.niedokonczone = true;
          break;
        }
        // ⚠️ `invoice_date`, A NIE `sale_date`. Archiwum jest ukladane po dacie WYSTAWIENIA —
        // tak samo, jak katalogi lezace juz na NAS-ie i tak samo, jak `wierszeMiesiaca` szuka
        // wierszy do porownania. Filtr po innym polu rozjechalby te dwie listy: dokument
        // z bazy nie znalazlby sie na liscie miesiaca i zostalby uznany za SKASOWANY.
        const zakres = { ...zakresMiesiaca(miesiac), pole: 'invoice_date' };
        let dokumenty;
        try {
          const [faktury, korekty] = await Promise.all([program.listaFaktur(zakres), program.listaKorekt(zakres)]);
          dokumenty = [...faktury, ...korekty];
        } catch (e) {
          // ⚠️⚠️ MIESIAC BEZ PELNEJ LISTY NIE ROZSTRZYGA O NICZYM — zwlaszcza o skasowaniach.
          // Czkawka inFaktu na jednym zapytaniu oznaczylaby inaczej CALY miesiac faktur jako
          // skasowane: pliki przemianowane na SKASOWANA_, wiersze z `skasowana_at`, a papier
          // moze juz lezy w biurze. Miesiac jest wiec POMIJANY w calosci i wroci nastepna noca.
          bledy.push(`${miesiac}: ${e.message}`);
          continue;
        }
        wynik.miesiecy += 1;
        const widziane = new Set();
        for (const dokument of dokumenty) {
          // Budzet sprawdza sie PRZED pobraniem, nie w jego trakcie — jeden dokument, ktory
          // wystartowal tuz przed granica, przebieg dokancza.
          if (teraz().getTime() >= koniecBudzetu) {
            log('Archiwum sprzedazy: budzet czasu wyczerpany — reszta pojedzie nastepnej nocy. '
              + 'Dokumenty sa w inFakcie, brakuje tylko plikow w archiwum.');
            wynik.niedokonczone = true;
            break;
          }
          widziane.add(dokument.uuid);
          try {
            const w = await archiwizuj({ db, program, dokument, katalogBazowy: katalogArchiwum, teraz, log });
            if (w.stan === 'pobrany') wynik.pobranych += 1;
            else if (w.stan === 'adoptowany') wynik.adoptowanych += 1;
            else if (w.stan === 'nadpisany') wynik.nadpisanych += 1;
            else if (w.stan === 'bez_zmian') wynik.bezZmian += 1;
            // Nieudany ZAPIS na dysk (`zarchiwizujDokument` zjada go sam i tylko loguje) liczy
            // sie do tego samego licznika, co blad pobrania: padniety NAS odbije tak samo
            // kazdy nastepny dokument, a kazda taka proba kosztuje jedno pobranie z inFaktu.
            //
            // ⚠️ I TO JEST TEZ BLAD PRZEBIEGU, NIE TYLKO WPIS W LOGU. Bez `bledy.push` ponizej
            // przebieg z jedna nieudana probka zapisu konczylby sie w galezi „sukces" —
            // `ostatnie_udane_at` klamaloby, ze dokument lezy na dysku, mimo ze go tam nie ma.
            if (w.stan === 'blad_zapisu') {
              bledyZRzedu += 1;
              bledy.push(`${dokument.number}: zapis na dysk nieudany`);
            } else {
              bledyZRzedu = 0;
            }
          } catch (e) {
            bledyZRzedu += 1;
            bledy.push(`${dokument.number}: ${e.message}`);
          }
          if (bledyZRzedu >= LIMIT_KOLEJNYCH_BLEDOW) {
            log(`Archiwum sprzedazy: ${bledyZRzedu} bledy z rzedu — przebieg przerwany `
              + '(inFakt albo dysk niedostepne).');
            wynik.niedokonczone = true;
            break;
          }
        }
        // ⚠️⚠️ PRZERWANY MIESIAC NIE ROZSTRZYGA O SKASOWANIACH — z dokladnie tego samego
        // powodu, co miesiac z bledem listy wyzej. Po wyczerpaniu budzetu albo po limicie
        // bledow `widziane` zawiera tylko OGON tego, co panel zdazyl obejsc, wiec reszta
        // miesiaca wygladalaby stad jak zniknieta z inFaktu.
        if (wynik.niedokonczone) break;
        // Skasowane: wiersz w bazie z data wystawienia w tym miesiacu, ktorego PELNA lista
        // (bez bledu, bez przerwania) nie zawiera.
        for (const wiersz of wierszeMiesiaca(db, miesiac)) {
          if (widziane.has(wiersz.uuid)) continue;
          // ⚠️ JEDEN NIEUDANY ZAPIS NIE MA PRAWA ZATRZYMAC RESZTY MIESIACA. Przemianowanie
          // pliku na SKASOWANA_ moze sie nie udac (plik otwarty przez program na komputerze
          // ksiegowej przez SMB) dla jednego dokumentu — pozostale skasowania sa od siebie
          // niezalezne i nie ma powodu, zeby jeden zajety plik zablokowal ich oznaczenie.
          try {
            await oznaczSkasowany({ db, wiersz, katalogBazowy: katalogArchiwum, teraz, log });
            wynik.skasowanych += 1;
          } catch (e) {
            bledy.push(`${wiersz.numer}: oznaczenie skasowanej nieudane (${e.message})`);
          }
        }
      }

      const chwila = teraz().toISOString();
      // ⚠️ BLAD NIE GASI SIE SAM I NIE UDAJE SUKCESU. `odnotujUdanyPrzebiegArchiwum` czysci
      // `ostatni_blad` i stawia `ostatnie_udane_at`, wiec przebieg, ktory pominal miesiac,
      // NIE MA prawa go zawolac: ekran mowilby „pobrano teraz", a jednego miesiaca nikt nigdy
      // nie przeczytal. Podloga tez ustawia sie WYLACZNIE po przebiegu doprowadzonym do konca.
      //
      // ⚠️⚠️ PRZERWANY PRZEBIEG (budzet albo seria bledow) BEZ ZADNEGO POJEDYNCZEGO BLEDU
      // TO DALEJ NIE SUKCES. Bez tej galezi przebieg, ktory zdazyl pobrac trzy dokumenty
      // udanie i wyczerpal budzet na czwartym, wpadalby do `odnotujUdanyPrzebiegArchiwum`
      // (bo `bledy` jest puste) i ekran pokazywalby „pobrano teraz", mimo ze reszta miesiaca
      // czeka na nastepna noc. Tresc jest napisem dla operatora (nie stala programu), bo to
      // jedyne miejsce, gdzie ten komunikat trafia na ekran.
      if (bledy.length) {
        zapiszBladArchiwum(db, bledy.slice(0, 5).join(' | '), chwila);
      } else if (wynik.niedokonczone) {
        zapiszBladArchiwum(
          db,
          'przebieg niedokończony — reszta następnej nocy (budżet czasu albo seria błędów)',
          chwila,
        );
      } else {
        odnotujUdanyPrzebiegArchiwum(db, { chwila, podlogaZrobiona: true });
      }
      return wynik;
    } catch (e) {
      zapiszBladArchiwum(db, e.message, teraz().toISOString());
      throw e;
    } finally {
      trwa = false;
    }
  }

  return { przebieg };
}
