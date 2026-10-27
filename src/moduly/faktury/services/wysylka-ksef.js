import { coWolnoWyslac, powodJuzZlecona } from '../../../domena/wysylka-ksef.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { zamowieniaOkresu } from '../../../oms/db/okresy.js';
import { zajmijWysylkeKsef, zwolnijWysylkeKsef } from '../db/wysylki-ksef.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { czyWysylacKonsumenckie } from '../db/ksef-konsumenckie.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';
import { idDokumentuDla, czyDokumentProgramu } from '../../../domena/dokument-programu.js';
import { dokumentyPoIdentyfikatorach } from '../db/faktury.js';

// Sufit długości serialiazowanej odpowiedzi trzymanej w logu — pilnuje, żeby jeden gruby
// ładunek (dokumenty okresu wysyłane partią) nie rozdął wpisu na kartach WSZYSTKICH zamówień
// tego okresu (`zapiszSlad` dokleja tę samą treść do każdego z nich).
const LIMIT_ZAPISU_ODPOWIEDZI = 2000;
const BEZ_NAZWY = Object.freeze({
  mianownik: 'program fakturowy', dopelniacz: 'programu fakturowego', miejscownik: 'programie fakturowym',
  narzednik: 'programem fakturowym',
});

// ⚠️⚠️ FINDING A1 (recenzja całości). Wysyłka do KSeF jest NIEODWRACALNA, więc kształtu
// odpowiedzi `send.json` nie da się zaobserwować inaczej niż PRAWDZIWYM zgłoszeniem — nie ma
// próbnego telefonu. Jeśli ten zapis nie powstanie przy PIERWSZEJ nadzorowanej wysyłce, jedyną
// drogą, żeby ją jeszcze raz zobaczyć, jest wysłanie KOLEJNEGO prawdziwego dokumentu do organu.
//
// ⚠️ NIGDY NIE RZUCA. Krąg (JSON.stringify na cyklicznej strukturze) albo ogromny ładunek nie
// mają prawa zamienić udanej, nieodwracalnej wysyłki w wyjątek — to jest zapis O NIEJ, nie
// WARUNEK jej powodzenia.
function bezpiecznaTrescOdpowiedzi(dane) {
  let tekst;
  try {
    tekst = JSON.stringify(dane);
  } catch {
    return '(odpowiedzi nie dało się zserializować — patrz JSON.stringify)';
  }
  if (tekst == null) return 'brak treści';
  return tekst.length > LIMIT_ZAPISU_ODPOWIEDZI
    ? `${tekst.slice(0, LIMIT_ZAPISU_ODPOWIEDZI)}…(ucięto, razem ${tekst.length} znaków)`
    : tekst;
}

// ⚠️⚠️ JEDYNA DROGA DO WYSŁANIA DOKUMENTU DO KSeF. Wywoływana WYŁĄCZNIE z trasy zatwierdzenia,
// nigdy z pollera i nigdy z czuwacza.
//
// `log` jest wstrzykiwalny WYŁĄCZNIE po to, żeby dało się sprawdzić testem to, co inaczej
// ląduje w `console.error` kontenera — ten sam wzorzec, co `log` w `bootstrap.js`
// (`uruchomZegary`). Dotyczy WYŁĄCZNIE dokumentu bez zamówienia i bez okresu: taki dokument
// nie ma gdzie zapisać śladu w bazie (patrz `zapiszSlad` niżej), a odpowiedź nieodwracalnej
// wysyłki i tak nie ma prawa przepaść bez śladu.
//
// PRZ-118.07: wysyła PROGRAM FAKTUROWY (`{ program }` albo stary `{ infakt }` przez `zProgramu`) — jego zdolność
// `wyslijDoKsef`. Program bez niej: `niedostepna` niesie zdanie dla człowieka (trasy podglądu i zatwierdzenia
// oraz automat KSeF pokazują je zamiast ekranu wysyłki), a `wyslij` odmawia nim, zanim cokolwiek zarezerwuje.
// Strażnik tests/core/straznik-wysylki-ksef-prz118.test.js: w tym pliku nazwa metody pada dokładnie raz — w wywołaniu.
export function createWysylkaKsef({
  db, program: programPodany = null, infakt = null, fakturyWidok, log = console.error,
}) {
  const program = zProgramu({ program: programPodany, infakt });
  // Bez programu (usługa złożona w teście bez `infakt`) zdania mówią ogólnie — nazwy nie ma skąd wziąć.
  const nazwa = program?.opis?.nazwa ?? BEZ_NAZWY;
  const niedostepna = program && !program.opis?.zdolnosci?.includes('wyslijDoKsef')
    ? `${nazwa.mianownik} nie wysyła do KSeF z OMS-u — panel nie ma jak zlecić mu wysyłki, `
      + `więc dokumenty wyślesz do KSeF bezpośrednio w ${nazwa.miejscownik}.`
    : null;
  // Zbiór liczony ZA KAŻDYM RAZEM od nowa, z listy pobranej na świeżo. Podgląd i zatwierdzenie
  // liczą go OSOBNO — przepisanie wyniku podglądu byłoby dokładnie tą pomyłką, przed którą
  // broni się nadanie masowe (przewodnik 4.13a): między jednym ekranem a drugim właściciel
  // mógł wysłać dokument ręcznie w inFakcie, a drugie zgłoszenie byłoby duplikatem u organu.
  //
  // ⚠️ `dokumenty` WRACAJĄ RAZEM Z WYNIKIEM, i to nie jest wygoda. `coWolnoWyslac` jest REGUŁĄ,
  // więc oddaje wyłącznie `{ uuid, numer }` — nabywcy ani kwoty tam nie ma i być nie powinno.
  // Ekran podglądu musi je pokazać, a wolno mu je wziąć TYLKO z tego samego pobrania, na
  // którym zapadła decyzja: drugie zapytanie do inFaktu dla samego wyświetlenia mogłoby
  // oddać inną listę i operator zatwierdzałby kwoty innego dokumentu, niż widzi.
  async function przelicz({ uuids, miesiac, pole }) {
    const dokumenty = await fakturyWidok.dokumenty({ miesiac, pole });
    const { doWyslania, pominiete } = coWolnoWyslac(uuids, dokumenty, czyWysylacKonsumenckie(db), nazwa);
    return { ...odsiejInnyProgram(doWyslania, pominiete), dokumenty };
  }

  // PRZ-121.04a: dokument, który OMS zna (wiersz faktury zamówienia albo okresu), a który leży w innym programie niż
  // moduł faktur OMS-u — odmowa `idDokumentuDla` jako POMINIĘTY Z POWODEM, PRZED rezerwacją w `wysylki_ksef`
  // i PRZED siecią. Liczona tu, w `przelicz`, więc podgląd mówi to samo, co zrobi zatwierdzenie. Identyfikator bez
  // wiersza w bazie (dokument wystawiony poza OMS-em) przechodzi jak dawniej. Ten sam identyfikator w kilku wierszach
  // (dwa programy nadały np. „123”): rozstrzyga wiersz modułu faktur, jeśli jest — lista pochodzi z TEGO programu.
  function odsiejInnyProgram(doWyslania, pominiete) {
    const znane = dokumentyPoIdentyfikatorach(db, doWyslania.map((d) => d.uuid));
    const zostaja = [];
    const odmowione = [];
    for (const d of doWyslania) {
      const wiersze = znane.get(String(d.uuid)) ?? [];
      const wiersz = wiersze.find((w) => czyDokumentProgramu(w, program)) ?? wiersze[0] ?? null;
      try {
        idDokumentuDla(wiersz, program);
        zostaja.push(d);
      } catch (e) {
        if (!e?.bezProgramu) throw e;
        odmowione.push({ numer: d.numer, powod: e.message });
      }
    }
    return { doWyslania: zostaja, pominiete: [...pominiete, ...odmowione] };
  }

  const podglad = (args) => przelicz(args);

  // Ślad przy ZAMÓWIENIU — karta jest jedynym miejscem, w którym człowiek szuka historii
  // dokumentu. Faktura wystawiona poza panelem nie ma zamówienia i po prostu nie ma gdzie
  // tego zapisać; brak miejsca na log NIE MOŻE wywalić wysyłki, która u organu już się
  // zdarzyła (albo właśnie się zdarza).
  //
  // ⚠️⚠️ DWA ŚWIATY, NIE JEDEN. Faktura ZBIORCZA klienta dropshippingowego nie ma zamówienia —
  // ma OKRES (`d.okres`, patrz services/faktury-widok.js), jest rodzaju 'vat' i nie ma numeru
  // KSeF, czyli jest w pełni wysyłalna. Sam warunek na `d.zamowienie` puszczał CAŁY pieniądz
  // B2B do organu nie zostawiając ani jednego śladu w panelu. Wpis idzie do logu KAŻDEGO
  // zamówienia okresu — bo tam człowiek szuka historii — dokładnie tak samo, jak przy
  // wystawianiu faktury okresu (routes/okresy.js).
  function zapiszSlad(doWyslania, dokumenty, zdanie) {
    for (const d of doWyslania) {
      const dokument = dokumenty.find((x) => x?.uuid === d.uuid);
      if (!dokument) continue;
      const wpis = { akcja: 'ksef', wynik: zdanie(d) };
      if (dokument.zamowienie) dopiszLog(db, dokument.zamowienie.id, wpis);
      if (dokument.okres) {
        for (const id of zamowieniaOkresu(db, dokument.okres.id)) dopiszLog(db, id, wpis);
      }
    }
  }

  // ⚠️⚠️ FINDING A1 — SUROWA ODPOWIEDŹ inFAKTU DO LOGU, PO UDANEJ WYSYŁCE. `zapiszSlad` wyżej
  // pisze wyłącznie zdanie „zlecono, czeka na numer" PRZED wywołaniem; treść tego, co inFakt
  // NAPRAWDĘ oddał, do tej pory nie trafiała nigdzie — grep łapał ją wyłącznie w komentarzach.
  // Ta funkcja dokłada DRUGI wpis, tym razem PO odpowiedzi, niosący ją serializowaną i przyciętą.
  //
  // ⚠️ `przyjete` LECI RAZEM Z TREŚCIĄ — to jedyne miejsce, które go dziś czyta (ekran wyniku
  // renderuje długość tego, co panel WYSŁAŁ, nie tego, co inFakt PRZYJĄŁ, patrz `ksef-wynik.ejs`).
  // Dwie nieczytane wartości na nieodwracalnej ścieżce to o jedną za dużo.
  //
  // ⚠️ DOKUMENT BEZ ZAMÓWIENIA I BEZ OKRESU nie ma gdzie zapisać śladu w bazie (jak w
  // `zapiszSlad` wyżej) — ale odpowiedzi nieodwracalnej wysyłki nie wolno cicho zgubić, więc
  // idzie chociaż przez `log` (domyślnie `console.error`), żeby wylądować w wyjściu kontenera.
  function zapiszOdpowiedzInfaktu(d, dokumenty, odpowiedz, kto) {
    const tresc = bezpiecznaTrescOdpowiedzi(odpowiedz);
    const dokument = dokumenty.find((x) => x?.uuid === d.uuid);
    const wpis = {
      akcja: 'ksef',
      wynik: `(${kto}) ${nazwa.mianownik} odpowiedział na zgłoszenie (${d.numer}). Treść odpowiedzi: ${tresc}`,
    };
    if (dokument?.zamowienie) { dopiszLog(db, dokument.zamowienie.id, wpis); return; }
    if (dokument?.okres) {
      for (const id of zamowieniaOkresu(db, dokument.okres.id)) dopiszLog(db, id, wpis);
      return;
    }
    log('ksef: dokument bez zamówienia i bez okresu —', wpis.wynik);
  }

  // ⚠️⚠️ REZERWACJA PRZED WYWOŁANIEM, NIE PO NIM (przewodnik 4.2) — i to jest JEDYNA bariera
  // przed drugim zgłoszeniem tego samego dokumentu u organu. `coWolnoWyslac` odsiewa po
  // `ksef_number`, a inFakt nadaje go dopiero po ~70 sekundach, więc świeżo pobrana lista jest
  // ŚLEPA na wysyłkę zleconą przed chwilą z tego samego panelu. Zatwierdzenie jest zwykłym
  // formularzem, JavaScriptu nie ma i przekierowania celowo też nie — dwuklik, back+resubmit
  // i dwie karty podglądu to normalne drogi do drugiego, NIEODWRACALNEGO zgłoszenia.
  //
  // ⚠️ ODBITY DOKUMENT WRACA JAKO POMINIĘTY, Z POWODEM. Cicho wypadający dokument wyglądałby
  // jak wysłany (albo jak nieistniejący) — a człowiek ma dostać zdanie mówiące, gdzie sprawdzić.
  // ⚠️⚠️ PETLA MUSI BYC CHRONIONA, INACZEJ WRACA DOKLADNIE TEN SAM SLEPY ZAULEK, KTORY
  // NAPRAWIA `wyslij` NIZEJ — tylko o pietro wczesniej. Bez ochrony: awaria zapisu na
  // DRUGIM dokumencie zostawialaby PIERWSZY zajety NA ZAWSZE, mimo ze do inFaktu nie
  // poszlo NIC — nic nie wyslano, a rezerwacja i tak by trwala (niezmiennik 4.9). Ta sama
  // granica jak przy „TU DO inFAKTU NIE POSZLO JESZCZE NIC" nizej w `wyslij`: zwalniamy,
  // co zdazylismy zajac w TEJ partii, i rzucamy dalej.
  function zarezerwuj(doWyslania) {
    const zlecone = [];
    const odbite = [];
    try {
      for (const d of doWyslania) {
        const { zajete, wiersz } = zajmijWysylkeKsef(db, d.uuid, { numer: d.numer });
        if (zajete) {
          zlecone.push(d);
          continue;
        }
        // ⚠️ ZDANIE PRZYCHODZI ZE WSPÓLNEJ REGUŁY (domain/wysylka-ksef.js). Ten sam stan opisuje
        // teraz TAKŻE odsiew przed ekranem podglądu, a dwie kopie tego samego zdania rozjechałyby
        // się przy pierwszej zmianie — człowiek dostawałby dwa różne opisy w odstępie jednego
        // kliknięcia. Przy okazji znika stempel-doklejka: wariant bez `zlecona_at` (baza oddała
        // odmowę, ale wiersza nie umiała już pokazać) dokładał drugi odstęp przed myślnikiem.
        odbite.push({ numer: d.numer, powod: powodJuzZlecona(wiersz?.zlecona_at) });
      }
    } catch (e) {
      // ⚠️ TU DO inFAKTU TEZ NIE POSZLO JESZCZE NIC — zajmowanie jest krokiem PRZED
      // wywolaniem `wyslijDokumentDoKsef`, wiec zostawiona czesciowa rezerwacja zamykalaby te
      // dokumenty NA ZAWSZE za probe, ktora nigdy nawet nie dotarla do inFaktu.
      try {
        zwolnij(zlecone);
      } catch {
        // ⚠️ CELOWO PUSTE, jak analogiczny catch nizej w `wyslij`: baza padla na tyle, ze
        // nie przyjmuje nawet kasowania rezerwacji, ale to wciaz awaria SPRZED wywolania.
      }
      throw e;
    }
    return { zlecone, odbite };
  }

  // ⚠️⚠️ ZDJĘCIE REZERWACJI TYLKO TAM, GDZIE PANEL WIE, ŻE DOKUMENT DO ORGANU NIE POSZEDŁ
  // (pełne uzasadnienie przy `zwolnijWysylkeKsef` w db/wysylki-ksef.js). Zwolnienie NIE JEST
  // ponowieniem: niczego nie woła i niczego nie planuje — otwiera wyłącznie drogę CZŁOWIEKOWI,
  // który poprawi dane i zatwierdzi wysyłkę jeszcze raz.
  function zwolnij(lista) {
    for (const d of lista) zwolnijWysylkeKsef(db, d.uuid);
  }

  // Awaria JEDNOZNACZNA = inFakt ODPOWIEDZIAŁ i ODMÓWIŁ (4xx: walidacja, odrzucony dokument).
  // Dokumentu u organu na pewno NIE MA. Wszystko inne — zerwane połączenie, timeout, 5xx
  // po wysłaniu żądania — jest NIEJEDNOZNACZNE i domyślną odpowiedzią na niewiedzę musi być
  // ostrożność. Ta sama funkcja i ten sam próg, co `jednoznacznaOdmowa` w services/faktura.js;
  // `status` przynosi tu `bladOperatora` z infakt/client.js.
  const jednoznacznaOdmowa = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;

  async function wyslij(args, kto = 'operator') {
    // Program bez zdolności: odmowa PRZED listą i rezerwacją — nic nie zajęte, nic nie poszło.
    if (niedostepna) throw bladOperatora(niedostepna);
    const { doWyslania, pominiete, dokumenty } = await przelicz(args);
    // ⚠️ REZERWACJA IDZIE PRZED WSZYSTKIM INNYM — także przed zapisem śladu. Wpis w logu jest
    // dowodem próby, ale niczego nie blokuje: blokuje wyłącznie wiersz w `wysylki_ksef`.
    const { zlecone, odbite } = zarezerwuj(doWyslania);
    const pominieteRazem = [...pominiete, ...odbite];
    // Pusty zbiór NIE dotyka inFaktu — nie ma czego wysłać, a `wyslijDokumentDoKsef` na pustej
    // liście i tak odmawia. Ekran wyniku wypisze same pominięte, razem z powodami.
    if (!zlecone.length) {
      return { wyslane: [], pominiete: pominieteRazem, niepewne: [], przyjete: null, blad: null };
    }

    // ⚠️⚠️ ŚLAD POWSTAJE PRZED WYWOŁANIEM, NIE PO NIM — i to jest cały powód, dla którego
    // ta pętla stoi tutaj, a nie niżej. Timeout na `send.json` znaczy „NIE WIADOMO", a nie
    // „nie poszło" (docblock `wyslijDokumentDoKsef` w infakt/client.js): w chwili zerwanego
    // połączenia dokumenty mogą już być NIEODWRACALNIE w KSeF. Gdyby wpis powstawał dopiero
    // po udanej odpowiedzi, karta zamówienia — jedyne miejsce, w którym człowiek szuka tej
    // historii — nie niosłaby ani śladu, że cokolwiek w ogóle próbowano wysłać.
    //
    // ⚠️ WPIS NIESIE NAZWĘ OPERATORA. Pierwszym pytaniem po zerwanej próbie jest „kto to klikał
    // i o której" — od tego zależy, kogo zapytać, czy zajrzał już do inFaktu. Panelu używają
    // dwie osoby, więc wpis bez nazwy zostawiał to pytanie bez odpowiedzi (ta sama zasada, co
    // w routes/okresy.js przy fakturze zbiorczej).
    try {
      zapiszSlad(zlecone, dokumenty, (d) => `(${kto}) zlecono wysyłkę do KSeF z panelu (${d.numer}) — czeka na numer KSeF`);
    } catch (e) {
      // ⚠️⚠️ TU DO inFAKTU NIE POSZŁO JESZCZE NIC — i to jest cała różnica wobec awarii niżej.
      // Wywołania nawet nie zaczęliśmy, więc rezerwacja nie chroni przed niczym, a zostawiona
      // zamykałaby te dokumenty NA ZAWSZE: ekran mówiłby prawdę („nic nie poszło"), a panel
      // i tak odmawiałby kolejnej próby — stan bez wyjścia (niezmiennik 4.9). Zwalniamy
      // i rzucamy dalej: trasa pokaże komunikat awarii, zgodnie z prawdą bez ani jednego
      // dokumentu „nie wiadomo".
      try {
        zwolnij(zlecone);
      } catch {
        // ⚠️ CELOWO PUSTE. Baza padła na tyle, że nie przyjmuje ani wpisu do logu, ani kasowania
        // rezerwacji — ale to wciąż awaria SPRZED wysyłki i człowiek ma zobaczyć JEJ powód,
        // a nie wyjątek z próby sprzątania po niej.
      }
      throw e;
    }

    // ⚠️⚠️ PETLA PER DOKUMENT — TO NIE JEST OPTYMALIZACJA, TYLKO KSZTALT ZASOBU (07.08.2026).
    // Do tego dnia szlo stad JEDNO wywolanie wsadowe z lista uuidow. Taki zasob w inFakcie
    // NIE ISTNIEJE (patrz docblock `wyslijDokumentDoKsef` w infakt/client.js) i kazda wysylka
    // konczyla sie 404 — zgloszenie wlasciciela „wysylka FV do KSeF nie dziala".
    //
    // ⚠️⚠️ NAJWAZNIEJSZY SKUTEK: „WSZYSTKO ALBO NIC" PRZESTALO OBOWIAZYWAC. Kazdy dokument
    // idzie osobnym zadaniem, wiec CZESCIOWY SUKCES jest przypadkiem NORMALNYM. Stara sciezka
    // odmowy zwalniala rezerwacje CALEJ partii na jednym 4xx — przy wysylce per dokument
    // byloby to zwolnienie dokumentow, ktore WLASNIE POSZLY do organu, czyli otwarcie drogi
    // do duplikatu. Zwalniamy WYLACZNIE ten dokument, ktory dostal jednoznaczna odmowe.
    //
    // ⚠️ AWARIA JEDNEGO NIE PRZERYWA POZOSTALYCH — ta sama zasada, co przy nadaniu zbiorczym
    // (przewodnik 4.13a): operator zaznaczyl N dokumentow i ma dostac odpowiedz o KAZDYM.
    // Przerwanie petli na pierwszym bledzie zostawialoby reszte zarezerwowana, nietknieta
    // i bez ani jednego zdania na ekranie.
    //
    // ⚠️ ZADNEGO PONOWIENIA, ANI TU, ANI NIGDZIE WYZEJ. Ponowione zgloszenie po niejednoznacznym
    // timeoucie to duplikat u organu, ktorego nie da sie skasowac — zostaje wylacznie korekta.
    const wyslane = [];
    const niepewne = [];
    const odrzucone = [];
    let blad = null;

    for (const d of zlecone) {
      let odpowiedz;
      try {
        odpowiedz = await program.wyslijDokumentDoKsef(d.uuid);
      } catch (e) {
        // ⚠️⚠️ DWIE AWARIE, DWA SKUTKI DLA REZERWACJI — dokladnie ta sama granica, ktora przy
        // wystawianiu faktury rysuja `zwolnijFakture` i `oznaczFaktureDoWyjasnienia`.
        //
        // JEDNOZNACZNA (4xx): inFakt odpowiedzial i ODMOWIL, wiec dokumentu u organu NA PEWNO
        // NIE MA. Rezerwacja nie chroni juz przed niczym, a zostawiona zamykalaby dokument NA
        // ZAWSZE (niezmiennik 4.9). ZWALNIAMY — ale TYLKO TEN JEDEN.
        //
        // ⚠️⚠️ NIEJEDNOZNACZNA (zerwane polaczenie, timeout, 5xx): REZERWACJI NIE ZWALNIAMY
        // I TO JEST SWIADOME. Taka awaria NIE JEST dowodem, ze zlecenie nie doszlo.
        const odmowa = jednoznacznaOdmowa(e);
        let opis = komunikatDlaOperatora(e);
        if (odmowa) {
          try {
            zwolnij([d]);
          } catch (eZwolnienia) {
            opis += ` ⚠️ Nie udało się zdjąć rezerwacji tego dokumentu (${komunikatDlaOperatora(eZwolnienia)}) `
              + `— panel odmówi kolejnej wysyłki, mimo że ${nazwa.mianownik} tego zgłoszenia nie przyjął.`;
          }
        }
        // ⚠️ PADAJACY ZAPIS SLADU NIE MA PRAWA ZABRAC WYNIKU CALEJ PARTII. Wyjatek z `dopiszLog`
        // wychodzil stad do trasy, a ta renderowala „Nic nie poszlo do KSeF" — zdanie STANOWCZE
        // o wywolaniu, ktore moglo juz wyladowac u organu.
        try {
          zapiszSlad([d], dokumenty, () => (odmowa
            ? `(${kto}) ${nazwa.mianownik} ODRZUCIŁ wysyłkę do KSeF (${d.numer}) — dokument NIE poszedł do organu: `
              + `${opis} Popraw dane i zatwierdź wysyłkę jeszcze raz — panel sam NIE ponawia.`
            : `(${kto}) wysyłka do KSeF (${d.numer}) — NIE WIADOMO, czy dokument poszedł: `
              + `${opis} Sprawdź w ${nazwa.miejscownik}, zanim wyślesz ponownie — panel sam NIE ponawia.`));
        } catch (eLogu) {
          opis += ` ⚠️ Nie udało się dopisać śladu tej próby do logu zamówienia (${komunikatDlaOperatora(eLogu)}) `
            + `— w panelu nie ma po niej historii, więc sprawdź w ${nazwa.miejscownik} tym pilniej.`;
        }
        // ⚠️ ODRZUCONY DOKUMENT NIE JEST „NIEPEWNY". `niepewne` to kategoria, ktora ekran
        // opisuje zdaniem „mogly juz trafic do KSeF nieodwracalnie" — po odmowie inFaktu
        // byloby to nieprawda i odstraszaloby od ponowienia, ktore jest tu poprawnym krokiem.
        if (odmowa) {
          odrzucone.push({
            numer: d.numer,
            powod: `${nazwa.mianownik} odrzucił to zgłoszenie — ten dokument NIE poszedł do KSeF. ${opis} `
              + `Popraw dane w ${nazwa.miejscownik} i zatwierdź wysyłkę jeszcze raz; panel sam nie ponawia.`,
          });
        } else {
          niepewne.push(d);
        }
        // ⚠️ PIERWSZY BLAD TRAFIA NA EKRAN, KOLEJNE JUZ NIE — pelna lista i tak stoi nizej,
        // rozbita na „nie wiadomo" i „pominiete z powodem". Sklejanie wszystkich komunikatow
        // w jeden akapit zamienialoby ekran w sciane tekstu dokladnie tam, gdzie trzeba
        // przeczytac ze zrozumieniem.
        blad = blad ?? opis;
        continue;
      }

      wyslane.push(d);
      // ⚠️⚠️ FINDING A1 — I TU JEST JEDYNA SZANSA ZAPISAC KSZTALT ODPOWIEDZI. Wysylka jest
      // nieodwracalna, wiec `send.json` NIE DA SIE zaobserwowac drugi raz bez wyslania
      // KOLEJNEGO prawdziwego dokumentu do organu.
      // ⚠️ AWARIA TEGO ZAPISU NIE MA PRAWA ZABRAC UDANEJ WYSYLKI — dokument POSZEDL.
      try {
        zapiszOdpowiedzInfaktu(d, dokumenty, odpowiedz, kto);
      } catch {
        // ⚠️⚠️ NIE JEST PUSTY, w odroznieniu od pozostalych catchow dookola logu w tym pliku.
        // Tamte gubia ZDANIE, ktore da sie odtworzyc; ten gubilby JEDYNA obserwacje ksztaltu
        // odpowiedzi inFaktu, a tej nie da sie powtorzyc inaczej niz wysylajac organowi
        // kolejny prawdziwy dokument.
        log(`ksef: nie udało się zapisać odpowiedzi ${nazwa.dopelniacz} w logu —`, bezpiecznaTrescOdpowiedzi(odpowiedz));
      }
    }

    // ⚠️ `przyjete` to LICZBA PANELU — ILE DOKUMENTOW PANEL WYSLAL I DOSTAL ODPOWIEDZ — a nie
    // potwierdzenie organu ani nawet inFaktu. Oddajemy ja WIERNIE, bez podrasowania do
    // `zlecone.length`: przy czesciowym sukcesie te dwie liczby MAJA sie roznic.
    return {
      wyslane,
      pominiete: [...pominieteRazem, ...odrzucone],
      niepewne,
      przyjete: wyslane.length,
      blad,
    };
  }

  // `nazwaProgramu` — dla automatu KSeF (zdanie „… odłączony”) bez drugiego źródła programu.
  return { podglad, wyslij, niedostepna, nazwaProgramu: nazwa };
}
