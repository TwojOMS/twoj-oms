import { ZAPLACONE } from '../../../domena/termin-platnosci.js';
import { proponowanaDataSprzedazy } from '../../../domena/data-sprzedazy.js';
import { wariantFakturyHurtem } from '../../../domena/masowe.js';

/**
 * Ile czasu wolno zajac calej partii, zanim petla przestanie ZACZYNAC nowe faktury.
 *
 * ⚠️ SPROSTOWANIE 12.08.2026. Stalo tu, ze „limit pojedynczego zadania HTTP do panelu to
 * 60 s" i ze budzet ma zdazyc przed nim. TO BYLA NIEPRAWDA i caly budzet czasu stal na niej
 * przez trzy zadania:
 *
 *  - `web/server.js` ustawia `requestTimeout: 0` — czyli BRAK limitu — i robi to JAWNIE,
 *    z komentarzem tlumaczacym dlaczego: nadanie do paczkomatu trwa okolo 150 s w jednym
 *    zadaniu i ma prawo trwac. Panel nie ma wiec kurka, przed ktorym trzeba by zdazyc.
 *  - 60 s w tym module to `LIMIT_ZADANIA_MS` w infakt/client.js — limit WYCHODZACY, na
 *    POJEDYNCZE wywolanie do inFaktu. Z zadaniem przychodzacym do panelu nie ma zwiazku.
 *  - `PROG_ZAWIESZONEJ_FAKTURY_MS`, na ktory powolywal sie spec, mowi wylacznie „trzy
 *    zadania HTTP do inFaktu" i o zadnym limicie panelu nie wspomina.
 *  - W repo nie ma odwrotnego proxy — kontener jest wystawiony wprost na LAN, wiec nie ma
 *    tez limitu narzuconego z zewnatrz.
 *
 * Skutek tamtej pomylki byl konkretny: przy trzech wywolaniach do inFaktu na fakture partia
 * 25 zamowien przekraczala 45 s i RUTYNOWO dzielila sie na dwie-trzy rundy „nietknietych" —
 * w funkcji, o ktora wlasciciel poprosil slowami „chcialbym wystawic kilka fv na raz".
 *
 * ⚠️ MECHANIZM BUDZETU MIMO TO ZOSTAJE, tylko z INNEGO POWODU niz wpisany pierwotnie. Nie
 * chodzi o to, zeby zdazyc przed limitem, ktorego nie ma, tylko o to, zeby CZLOWIEK PATRZACY
 * W EKRAN dostal wynik w rozsadnym czasie — z lista tego, co powstalo, i tego, czego partia
 * nie dotknela — zamiast nieokreslonego czekania i urwanego zadania. Budzet chroni operatora,
 * nie serwer.
 *
 * ⚠️ SKAD 150 s: tyle modul JUZ akceptuje w jednym zadaniu przy nadaniu do paczkomatu (patrz
 * komentarz przy `requestTimeout` w web/server.js). Skoro tamta operacja ma prawo tyle trwac,
 * to partia faktur tez — a operator ma wtedy realna szanse zmiescic komplet zaznaczenia
 * w jednej rundzie, zamiast powtarzac ja trzy razy.
 *
 * ⚠️ Dlaczego nie sufit liczby wyliczony z pomiaru: taki sufit zaklada, ze jutro inFakt
 * odpowiada tak szybko jak dzis. Partia mieszczaca sie we wtorek urwalaby sie w srode.
 * Budzet mierzy to, co naprawde grozi — uplyw czasu — zamiast korelatu.
 */
export const BUDZET_HURTU_MS = 150_000;

/**
 * @param teraz zegar — funkcja oddajaca BIEZACY znacznik czasu w ms (`Date.now()`).
 *   Zwykly zegar, bez drugiego dna; moment poczatku partii jest osobnym argumentem
 *   `wystawWiele` i to tam stoi wyjasnienie, dlaczego akurat tak.
 */
export function createFakturaHurtem({ faktura, teraz = () => Date.now() }) {
  /**
   * @param zamowienia wiersze listy, JUZ przepuszczone przez `podzielDoFaktury`
   *   (domain/masowe.js) i ustawione od najstarszego. Ta funkcja NICZEGO nie odsiewa —
   *   podzial jest domenowy i pokazal go czlowiekowi ekran podgladu. Druga kopia tamtej
   *   reguly rozjechalaby sie z ekranem, ktory operator zatwierdzil.
   *
   * Wystawiamy PO KOLEI, jedno po drugim (`await` w petli, nigdy `Promise.all`): numery
   * faktur sa kolejne, wiec rownolegle wywolania daly by numeracje w przypadkowej
   * kolejnosci wzgledem chronologii zamowien.
   *
   * @param start znacznik czasu, OD KTOREGO liczy sie budzet. Trasa ma podac moment
   *   PRZYJSCIA ZADANIA, a nie chwile wejscia w petle: budzet mierzy CZEKANIE CZLOWIEKA,
   *   a czlowiek czeka takze przez te sekundy, w ktorych trasa wczytywala liste i liczyla
   *   podzial. (Do 12.08.2026 stalo tu, ze liczy sie stamtad „60 s kurka HTTP" — panel nie
   *   ma kurka na zadanie przychodzace, patrz sprostowanie przy `BUDZET_HURTU_MS` wyzej.)
   *
   *   ⚠️ DLACZEGO OSOBNY ARGUMENT, A NIE SPRYTNY ZEGAR: kuszace jest kazac wstrzykiwac
   *   `teraz`, ktory sam oddaje uplyw od poczatku zadania. Wtedy jednak trasa podajaca
   *   zwykly zegar — czyli to, co kazdy odruchowo napisze, patrzac na nazwe `teraz` —
   *   dostaje epoke uniksowa jako „uplyw", uznaje budzet za wyczerpany i wystawia JEDNA
   *   fakture zamiast dwudziestu, po cichu i bez bledu. Tutaj pomylka trasy (zapomniany
   *   `start`) daje partie liczona od wejscia w petle, czyli co najwyzej odrobine za dluga.
   *   ZAPOMNIENIE MA BYC TANIE, a tryb awarii konczacy sie liczba wygladajaca normalnie
   *   jest w tym module najgorszym z mozliwych.
   *
   *   ⚠️ Dlatego `Number.isFinite`, a NIE domyslna wartosc parametru: ta podstawia sie
   *   wylacznie dla `undefined`, czyli broni tylko jednej z trzech prawdopodobnych pomylek
   *   trasy. `start: null` dawalby `teraz() - null`, czyli pelna epoke uniksowa — budzet
   *   wyczerpany od razu i JEDNA faktura zamiast dwudziestu, po cichu. `start` jako napis
   *   z formularza albo z bazy dawalby `NaN`, a `NaN > BUDZET` to `false` — budzet nie
   *   zadzialalby NIGDY, czyli zabezpieczenie znikaloby bez sladu. Kazda z tych trzech
   *   pomylek ma spasc do „liczymy od wejscia w petle".
   */
  async function wystawWiele(zamowienia, { start } = {}) {
    const lista = zamowienia ?? [];
    const poczatek = Number.isFinite(start) ? start : teraz();
    const wystawione = [];
    const bledy = [];
    const nietkniete = [];

    for (let i = 0; i < lista.length; i += 1) {
      const z = lista[i];
      // Pierwsza probe podejmujemy ZAWSZE (`i > 0`): partia, ktora nie zrobila nic, jest
      // gorsza niz partia niepelna — czlowiek nie wie, czy to awaria, czy jego blad.
      if (i > 0 && teraz() - poczatek > BUDZET_HURTU_MS) {
        // Reszta wraca JAWNIE jako nietkniete, a nie znika z wyniku: ekran ma powiedziec,
        // ktorych zamowien partia nie dotknela, zeby operator wiedzial, co powtorzyc.
        for (const reszta of lista.slice(i)) nietkniete.push({ id: reszta.id, numer: reszta.numer });
        break;
      }
      try {
        // ⚠️ `dataSprzedazy` LICZONA TU, bo przy hurcie nie ma formularza, a pominiecie pola
        // daje w inFakcie `sale_date = invoice_date`. Hurt dotyczy zamowien oplaconych albo
        // za pobraniem (patrz `podzielDoFaktury`); dla zaplaty przed wydaniem obowiazek
        // podatkowy powstaje w dniu zaplaty (art. 19a ust. 8), przy pobraniu — w dniu wydania.
        // Bez tego pola bledna bylaby KAZDA faktura z tej drogi. Regula siedzi w domenie.
        //
        // PRZ-070 (14.10.2026): wariant z TEJ SAMEJ reguly, ktora podzial pokazal na podgladzie
        // („zaplacone" albo „przy odbiorze"). Zamowienie bez prawa do faktury hurtem (`powod`)
        // dostaje dawny wariant „zaplacone" — i `wystaw()` odmowi samo, jak dotad.
        const wariant = wariantFakturyHurtem(z);
        const w = await faktura.wystaw(z.id, {
          termin: wariant.termin ?? ZAPLACONE,
          dataSprzedazy: wariant.dataSprzedazy ?? proponowanaDataSprzedazy(z)?.data ?? null,
        });
        wystawione.push({ id: z.id, numer: z.numer, numerFaktury: w?.numer ?? null });
      } catch (e) {
        // Jedna faktura, ktorej nie da sie wystawic, NIE PRZERYWA partii — ta sama zasada,
        // co przy pozostalych akcjach masowych modulu (domain/masowe.js). Powod idzie na
        // ekran w calosci: komunikaty `bladOperatora` sa pisane do czlowieka, nie do logu.
        bledy.push({ id: z.id, numer: z.numer, powod: e?.message ?? 'Nieznany błąd.' });
      }
    }
    return { wystawione, bledy, nietkniete };
  }

  return { wystawWiele };
}
