import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { zakresMiesiaca } from '../../../domena/lista-faktur.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { odciskDokumentu } from '../../../domena/archiwum-sprzedazy.js';
import { zlozPaczke } from '../../../domena/paczka-dla-biura.js';
import { wierszArchiwum } from '../../faktury/db/archiwum-sprzedazy.js';
import { kosztyOtrzymaneWMiesiacu, odrzuconeWMiesiacu } from '../../../oms/db/koszty.js';
import { zbudujZestawieniePdf } from '../pdf/zestawienie-dla-biura-pdf.js';
import { zCzekaniemNa429 } from '../../../oms/ksef/limit.js';

// Paczka dla biura rachunkowego (spec 2026-09-02, Czesc D): scalony PDF miesiaca — zestawienie
// czesci i jej dokumenty. Ten modul jest wylacznie SPINACZEM: skad wziac bajty, w jakiej
// kolejnosci je poskladac i kiedy odmowic. Co ma stanac w zestawieniu, liczy domena
// (`zlozPaczke`), a jak to wyglada — `pdf/`.
//
// ⚠️⚠️ DWA PLIKI, NIE JEDEN — DECYZJA WLASCICIELA Z 2026-09-02 WIECZOREM („podzial — dwa
// pliki do pobrania, jeden kosztowy, drugi przychodowy"). `zbuduj(miesiac, czesc)` sklada
// ZA KAZDYM RAZEM JEDEN plik: `sprzedaz` (zestawienie sprzedazy + faktury + korekty) albo
// `koszty` (zestawienie kosztow + faktury kosztowe). Powod jest po stronie biura: sprzedaz
// i koszty ida do dwoch roznych rejestrow VAT i wedruja w biurze osobno, wiec jeden wspolny
// plik trzeba bylo najpierw rozciac.
//
// ⚠️ KAZDA CZESC SIEGA WYLACZNIE PO SWOJE ZRODLO: plik sprzedazowy pyta inFakt i NIE dotyka
// KSeF, plik kosztowy czyta baze i archiwum/KSeF, a inFaktu nie pyta o nic. Pobranie „na
// wszelki wypadek" kosztowaloby minute czekania czlowieka i sztucznie zblizalo do limitu
// 16/min KSeF — za dane, ktore i tak nie weszlyby do skladanego pliku.
//
// ⚠️⚠️ WSZYSTKO ALBO NIC — DECYZJA WLASCICIELA, NIE OSTROZNOSC. Jedno niepowodzenie
// (nieodebrany PDF z inFaktu, koszt bez pliku i bez KSeF, plik, ktorego nie da sie wczytac)
// przerywa CALOSC odmowa z NUMEREM dokumentu i nie zostawia zadnego pliku. Paczka „prawie
// kompletna" jest gorsza niz brak paczki: ksiegowa nie ma jak zauwazyc, ze brakuje w niej
// jednej faktury — zestawienie i tak ja wymienia, a strony sie zgadzaja z numeracja stopki.
// Numer dokumentu w komunikacie jest po to, zeby czlowiek wiedzial, CO poprawic, zanim
// nacisnie „Pobierz" drugi raz.

/**
 * Bajty z archiwum na NAS-ie albo `null`, gdy katalogu/sciezki nie ma lub plik zniknal.
 *
 * ⚠️ BRAK PLIKU NIE JEST TU BLEDEM — jest odpowiedzia „nie mam, wez z sieci". Archiwum jest
 * DODATKIEM (kopia na NAS-ie), a zrodlem prawdy zostaje inFakt/KSeF; odmowa w tym miejscu
 * kladlaby paczke za kazdym razem, gdy ktos przeniesie katalog albo gdy archiwum jest jeszcze
 * wylaczone.
 */
// ⚠️ BRAK PLIKU (`existsSync` = false) i BLAD ODCZYTU ISTNIEJACEGO PLIKU to DWA ROZNE
// zdarzenia, mimo ze oba moga wygladac na „nie da sie wziac z dysku". Brak pliku jest
// odpowiedzia „nie mam, wez z sieci" (patrz komentarz przy `bajtySprzedazy`). Blad odczytu
// (SMB odcieta w polowie, `EBUSY`, `EACCES`) NIE JEST tym samym: plik jest, wiec to NIE jest
// sygnal „wez z sieci" — to jest awaria wspolnego zasobu (NAS-u), o ktorej operator MUSI
// wiedziec, bo inaczej dostanie pozornie dzialajaca paczke zbudowana z sieci akurat wtedy,
// gdy dysk archiwum jest w zlym stanie. Dlatego blad z `czytajPlik` NIE jest tu chwytany —
// leci dalej do wywolujacego, ktory zna numer dokumentu i zamienia go na `bladOperatora`.
const czytaj = (katalog, sciezka, czytajPlik) => {
  if (!katalog || !sciezka) return null;
  const pelna = join(katalog, sciezka);
  return existsSync(pelna) ? czytajPlik(pelna) : null;
};

/**
 * Czesci paczki — jednoczesnie nazwy plikow do pobrania i klucze w domenie/`pdf/`.
 *
 * ⚠️ NAZWY BEZ POLSKICH ZNAKOW, bo ida do NAZWY PLIKU (`paczka-dla-biura-2026-08-sprzedaz.pdf`)
 * i do adresu (`?czesc=sprzedaz`). Ta sama para kluczy siedzi w `KOLUMNY`/`TYTUL`
 * w pdf/zestawienie-dla-biura-pdf.js i w `zlozPaczke` — zmiana tutaj wymaga zmiany tam.
 */
export const CZESCI = ['sprzedaz', 'koszty'];

// Pobieranie porcjami po `ile` naraz. inFakt znosi kilka rownoleglych zadan, ale caly miesiac
// naraz (setki faktur) to zaproszenie do 429 i do wyczerpania gniazd — a przy okazji do
// kolejnosci wynikow zaleznej od sieci. `Promise.all` na porcji zachowuje kolejnosc wejscia,
// wiec strony paczki ida dokladnie tak, jak wiersze zestawienia.
async function porcjami(elementy, ile, fn) {
  const wyniki = [];
  for (let i = 0; i < elementy.length; i += ile) {
    // eslint-disable-next-line no-await-in-loop
    wyniki.push(...await Promise.all(elementy.slice(i, i + ile).map(fn)));
  }
  return wyniki;
}

export function createPaczkaDlaBiura({
  db, infakt, wizualizacjaKosztu = null, katalogSprzedazy = null, katalogKosztow = null,
  teraz = () => new Date(), rownolegle = 4, spij = undefined, log = console.error,
  czytajPlik = readFileSync, zbudujZestawienie = zbudujZestawieniePdf,
}) {
  // ⚠️ ZERO (albo cokolwiek nie-dodatniego) w `rownolegle` wywracaloby `porcjami` w
  // NIESKONCZONA PETLE: krok `i += ile` z `ile === 0` nigdy nie przesuwa `i` dalej niz
  // dlugosc listy, wiec pierwsza porcja (pusta) powtarzalaby sie w kolko. Klamrowanie do
  // minimum 1 tutaj, RAZ, jest tansze niz pilnowanie tego w kazdym miejscu wywolania.
  const rownoleglePaczki = Math.max(1, Number(rownolegle) || 1);
  /**
   * ⚠️ Z DYSKU TYLKO WTEDY, GDY PLIK NA PEWNO JEST TYM DOKUMENTEM. Trzy warunki naraz:
   * wiersz archiwum istnieje, NIE jest oznaczony jako skasowany w inFakcie i jego `odcisk`
   * zgadza sie z odciskiem dokumentu, ktory inFakt oddal przed chwila. Zabraknie
   * ktoregokolwiek — bierzemy bajty z sieci. Powod: inFakt pozwala poprawiac fakture, dopoki
   * nie poszla do KSeF, a `updated_at` w API NIE ISTNIEJE (pomiar 2026-09-02) — bez
   * porownania odcisku biuro dostaloby wersje sprzed poprawki, wygladajaca na aktualna.
   */
  async function bajtySprzedazy(dok) {
    const wiersz = wierszArchiwum(db, dok.uuid);
    if (wiersz && !wiersz.skasowana_at && wiersz.odcisk === odciskDokumentu(dok)) {
      let z;
      try {
        z = czytaj(katalogSprzedazy, wiersz.sciezka_pdf, czytajPlik);
      } catch (e) {
        // Plik ISTNIEJE (inaczej `czytaj` oddalaby `null` bez wolania `czytajPlik`), ale nie
        // da sie go przeczytac — awaria wspolnego zasobu (NAS-u), a nie „nie mam, wez z sieci".
        throw bladOperatora(`Nie udało się przygotować paczki: nie da się odczytać pliku dokumentu ${dok.number} z archiwum (${e.message}).`);
      }
      if (z) return z;
    }
    try {
      return dok.rodzaj === 'korekta'
        ? await infakt.pobierzPdfKorekty(dok.uuid)
        : await infakt.pobierzPdf(dok.uuid);
    } catch (e) {
      throw bladOperatora(`Nie udało się przygotować paczki: brak dokumentu ${dok.number} (${e.message}).`);
    }
  }

  /**
   * Koszt: najpierw plik z archiwum (`sciezka_pdf`), potem wizualizacja z KSeF.
   *
   * ⚠️⚠️ POBRANIE Z KSeF IDZIE PRZEZ `zCzekaniemNa429` (ksef/limit.js). KSeF przepuszcza
   * 16 zadan na minute (liczba zmierzona na produkcji), a paczka miesiaca potrafi miec kilkadziesiat
   * kosztow — bez tej obwolutki 17. dokument wywracalby CALA paczke zdaniem „KSeF odmowil",
   * czyli regula „wszystko albo nic" zamienialaby prosbe o chwile przerwy w utrate calego wydruku.
   * `doKiedy: Infinity`, bo tutaj czeka CZLOWIEK przy przegladarce (trasa ma `requestTimeout: 0`),
   * a nie nocny przebieg z budzetem; sufit na pojedyncze czekanie siedzi w `limit.js`.
   *
   * ⚠️ ZNANA CENA: `wizualizacjaKosztu.pdf` bierze token z sesji KSeF W SRODKU, wiec ponowienie
   * po 429 powtarza takze `sesja.accessToken()`. Sesja token trzyma (pelne logowanie najwyzej
   * raz w zyciu procesu), wiec w praktyce jest to jedno dodatkowe siegniecie do pamieci —
   * ale gdyby 429 przyszedl z samej sekwencji logowania, ponowienie odbije sie od zuzytego
   * `redeem`. Rozdzielenie wymaga wystawienia tokenu z `wizualizacja-kosztu.js`; do tego czasu
   * granica jest tutaj i jest swiadoma.
   */
  async function bajtyKosztu(k) {
    let z;
    try {
      z = czytaj(katalogKosztow, k.sciezka_pdf, czytajPlik);
    } catch (e) {
      throw bladOperatora(`Nie udało się przygotować paczki: nie da się odczytać pliku dokumentu ${k.numer_dokumentu} z archiwum (${e.message}).`);
    }
    if (z) return z;
    if (!wizualizacjaKosztu) {
      throw bladOperatora(
        `Nie udało się przygotować paczki: dokument ${k.numer_dokumentu} nie jest zarchiwizowany, `
        + 'a panel nie ma podpiętego KSeF, żeby go pobrać.',
      );
    }
    try {
      const wynik = await zCzekaniemNa429(
        () => wizualizacjaKosztu.pdf(k.ksef_number),
        { spij, teraz, doKiedy: Infinity, log },
      );
      return wynik.bajty;
    } catch (e) {
      throw bladOperatora(`Nie udało się przygotować paczki: brak dokumentu ${k.numer_dokumentu} (${e.message}).`);
    }
  }

  /**
   * ⚠️ ZEPSUTE BAJTY TO ODMOWA Z NUMEREM, A NIE 500 NA EKRANIE. Bez tlumaczenia blad
   * techniczny pdf-lib trafialby do operatora jako „błąd techniczny panelu" — czyli bez
   * jednej informacji, ktora jest tu potrzebna: KTORY dokument trzeba pobrac recznie.
   *
   * ⚠️⚠️ `PDFDocument.load` NIE WYSTARCZA JAKO SPRAWDZENIE — I TO JEST ZMIERZONE, NIE
   * DOMYSLONE (test „bajty, ktorych pdf-lib nie wczyta"). Bufor `'%PDF-1.4 zepsute'` przechodzi
   * przez `load` BEZ BLEDU (parser widzi naglowek i oddaje dokument bez katalogu) i wywraca sie
   * dopiero przy scalaniu — `TypeError: Cannot read properties of undefined (reading 'Pages')`,
   * czyli daleko od dokumentu, ktory to spowodowal, i bez jego numeru. Dlatego drzewo stron
   * dotykamy TUTAJ, w tej samej klamrze `try`, w ktorej znamy numer.
   *
   * ⚠️ SPRAWDZENIA „ZERO STRON" TU NIE MA CELOWO: pdf-lib dla dokumentu bez stron oddaje
   * `getPageIndices() === [0]` (zmierzone na 1.17), wiec takiego warunku nie da sie ani
   * wywolac, ani przetestowac — byloby to martwe `if` udajace zabezpieczenie.
   */
  async function wczytaj(bajty, numer) {
    try {
      // `ignoreEncryption`: inFakt potrafi oddac PDF z pustym haslem wlasciciela (sam zakaz
      // edycji). Bez tej flagi pdf-lib odmawia scalenia dokumentu, ktory kazda przegladarka
      // otwiera bez pytania.
      const doc = await PDFDocument.load(bajty, { ignoreEncryption: true });
      doc.getPageIndices();
      return doc;
    } catch (e) {
      throw bladOperatora(`Nie udało się przygotować paczki: plik dokumentu ${numer} nie daje się wczytać jako PDF (${e.message}).`);
    }
  }

  /**
   * Strony czesci SPRZEDAZOWEJ: faktury i korekty w kolejnosci wierszy zestawienia.
   */
  async function stronySprzedazy(paczka, faktury, korekty) {
    // Wiersze zestawienia (z domeny) niosa tylko `uuid`/`klucz` — surowe dokumenty trzymamy
    // w mapach, zeby strony szly DOKLADNIE w kolejnosci wierszy zestawienia. Odwrotnie
    // (iteracja po surowych listach) rozjechalaby wydruk z numeracja „lp." przy pierwszej
    // korekcie, bo domena sortuje po numerze i dokleja korekty na koniec.
    const dokSprzedazy = [
      ...faktury.map((d) => ({ ...d, rodzaj: 'vat' })),
      ...korekty.map((d) => ({ ...d, rodzaj: 'korekta' })),
    ];
    // ⚠️ MAPA BUDOWANA Z WARTOWNIKIEM NA DUPLIKAT KLUCZA. `new Map(...)` po cichu zostawilaby
    // TYLKO OSTATNI wpis pod danym `uuid` — gdyby inFakt kiedys oddal fakture i korekte
    // o tym samym `uuid` (bug po ich stronie, ale niewykluczony), obie pozycje zestawienia
    // pobralyby bajty TEGO SAMEGO dokumentu: jedna z nich dostalaby cudzy PDF pod swoim
    // numerem, a nic by o tym nie powiedzialo. Lepsza odmowa z numerem niz papier, ktory
    // wyglada poprawnie i nim nie jest.
    const poUuid = new Map();
    for (const d of dokSprzedazy) {
      if (poUuid.has(d.uuid)) {
        throw bladOperatora(`Nie udało się przygotować paczki: dokument ${d.number} ma zduplikowany identyfikator (uuid) z innym dokumentem tego miesiąca — sprawdź w inFakcie.`);
      }
      poUuid.set(d.uuid, d);
    }
    return porcjami(
      paczka.sprzedaz,
      rownoleglePaczki,
      async (w) => {
        const dok = poUuid.get(w.uuid);
        // Wartownik na wypadek niespojnosci z domena (`zlozPaczke`) — wiersz zestawienia bez
        // dopasowania w surowej liscie. Nie powinno sie zdarzyc, ale gdyby sie zdarzylo, ma
        // to byc odmowa z numerem, a nie prosba o bajty `undefined.uuid`.
        if (!dok) throw bladOperatora(`Nie udało się przygotować paczki: brak danych dokumentu ${w.numer} (niespójność wewnętrzna zestawienia).`);
        return wczytaj(await bajtySprzedazy(dok), w.numer);
      },
    );
  }

  /** Strony czesci KOSZTOWEJ: faktury zakupowe w kolejnosci wierszy zestawienia. */
  async function stronyKosztow(paczka, koszty) {
    const kosztyPoKluczu = new Map(koszty.map((k) => [k.ksef_number, k]));
    const kosztyPdf = [];
    for (const w of paczka.koszty) {
      // Wiersz bez pliku to koszt wpisany RECZNIE (papier, zagranica, paragon) — w KSeF go
      // nie ma i nigdy nie bedzie, wiec strony w paczce miec nie moze. Zestawienie mowi
      // o nim wprost („dołącz oryginał"), a pytanie KSeF-u o taki numer skonczyloby sie
      // odmowa, ktora wywrocilaby cala paczke.
      if (!w.maPlik) continue;
      const k = kosztyPoKluczu.get(w.klucz);
      if (!k) throw bladOperatora(`Nie udało się przygotować paczki: brak danych kosztu ${w.numer} (niespójność wewnętrzna zestawienia).`);
      // ⚠️ SEKWENCYJNIE, mimo ze sprzedaz idzie po cztery: koszty jada przez WSPOLNA sesje
      // KSeF (ta sama, ktorej uzywa nocny czuwacz) i wspolny limit 16/min. Rownolegle zadania
      // wyscigowaly by sie o odswiezenie tokenu i naganialy 429 zamiast go unikac.
      // eslint-disable-next-line no-await-in-loop
      kosztyPdf.push(await wczytaj(await bajtyKosztu(k), w.numer));
    }
    return kosztyPdf;
  }

  /**
   * Jednostronicowe (albo wielostronicowe przy długim miesiącu) zestawienie przychodów.
   *
   * ⚠️ W przeciwieństwie do paczki nie ma tu ani jednego dokumentu źródłowego: operator
   * pobiera wyłącznie listę sprzedaży i korekt z jej sumami. Nie wolno wołać `stronySprzedazy`,
   * bo to dociągałoby faktury PDF, których ten ekran świadomie już nie dołącza.
   */
  async function zbudujZestawieniePrzychodow(miesiac) {
    const zakres = zakresMiesiaca(miesiac);
    if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);

    const faktury = await infakt.listaFaktur({ ...zakres, pole: 'sale_date' });
    const korekty = await infakt.listaKorekt({ ...zakres, pole: 'invoice_date' });
    const paczka = zlozPaczke({ miesiac, faktury, korekty, koszty: [], kwarantanna: 0 });
    const wygenerowano = teraz().toISOString();
    const liczbaDokumentow = paczka.sprzedaz.length;
    const tytul = 'Zestawienie przychodów';
    const zestaw = (liczbaStron) => zbudujZestawienie({
      paczka, czesc: 'sprzedaz', wygenerowano, liczbaStron, liczbaDokumentow, tytul,
    });
    const proba = await PDFDocument.load(await zestaw(0));
    const stron = proba.getPageCount();
    const wynik = await PDFDocument.load(await zestaw(stron));

    if (stron !== wynik.getPageCount()) {
      throw bladOperatora(`Nie udało się przygotować zestawienia: liczba stron w stopce (${stron}) nie zgadza się z plikiem (${wynik.getPageCount()}).`);
    }
    return {
      bajty: Buffer.from(await wynik.save()),
      nazwa: `zestawienie-przychodow-${miesiac}.pdf`,
      dokumentow: liczbaDokumentow,
      stron,
    };
  }

  /**
   * JEDEN plik paczki: `czesc` = 'sprzedaz' albo 'koszty' (patrz naglowek modulu — dwa pliki
   * to decyzja wlasciciela z 2026-09-02 wieczorem, a nie szczegol implementacji).
   */
  async function zbuduj(miesiac, czesc) {
    const zakres = zakresMiesiaca(miesiac);
    if (!zakres) throw bladOperatora(`„${miesiac ?? ''}" to nie jest miesiąc w formacie RRRR-MM.`);
    // ⚠️ NIEZNANA CZESC ODMAWIA, a nie wraca do domyslnej. Domyslna („niech bedzie sprzedaz")
    // oddawalaby ksiegowej plik z INNYMI dokumentami, niz zamowila — a paczka sprzedazowa
    // wyglada dokladnie tak samo jak kosztowa, dopoki sie jej nie otworzy. Ta sama zasada,
    // co przy miesiacu wyzej.
    if (!CZESCI.includes(czesc)) {
      throw bladOperatora(`„${czesc ?? ''}" to nie jest część paczki — panel składa dwa pliki: ${CZESCI.join(', ')}.`);
    }
    const sprzedazowa = czesc === 'sprzedaz';

    // ⚠️ DWA ROZNE POLA DATY, I TO NIE JEST NIEKONSEKWENCJA: sprzedaz bierzemy po DACIE
    // SPRZEDAZY (to ona wyznacza okres VAT — art. 19a ustawy o VAT), a korekty po dacie
    // WYSTAWIENIA (korekta „in minus" rozlicza sie w okresie wystawienia — art. 29a ust. 13).
    // Sekwencyjnie, nie `Promise.all`: przy odmowie z inFaktu drugie zadanie i tak byloby
    // bezuzyteczne, a kolejnosc wolan jest sprawdzalna w tescie.
    const faktury = sprzedazowa ? await infakt.listaFaktur({ ...zakres, pole: 'sale_date' }) : [];
    const korekty = sprzedazowa ? await infakt.listaKorekt({ ...zakres, pole: 'invoice_date' }) : [];
    const koszty = sprzedazowa ? [] : kosztyOtrzymaneWMiesiacu(db, miesiac);
    // ⚠️ DOMENA DOSTAJE PUSTE LISTY TEJ CZESCI, KTOREJ W PLIKU NIE MA — i to jest swiadome.
    // `zlozPaczke` potrzebuje `faktury`/`korekty` do ZLOZENIA ODNOSNIKA korekty do faktury
    // pierwotnej („korekta do <numer>"), wiec plik sprzedazowy dostaje obie listy naprawde;
    // plik kosztowy nie ma zadnej korekty do opisania, wiec puste listy niczego mu nie zabieraja.
    //
    // ⚠️ KWARANTANNA (dokumenty KOSZTOWE, ktorych panel nie umial zapisac) liczy sie WYLACZNIE
    // do pliku kosztowego. Ostrzezenie o niej jest zdaniem „ten rejestr NIE jest calym
    // miesiacem" — postawione nad zestawieniem sprzedazy mowiloby o brakach w dokumentach,
    // ktorych ten plik w ogole nie niesie.
    const paczka = zlozPaczke({
      miesiac,
      faktury,
      korekty,
      koszty,
      kwarantanna: sprzedazowa ? 0 : odrzuconeWMiesiacu(db, miesiac),
    });

    const dokumentyPdf = sprzedazowa
      ? await stronySprzedazy(paczka, faktury, korekty)
      : await stronyKosztow(paczka, koszty);

    const stronDok = dokumentyPdf.reduce((s, d) => s + d.getPageCount(), 0);
    const wygenerowano = teraz().toISOString();
    const liczbaDokumentow = paczka[czesc].length;

    // ⚠️⚠️ DWA PRZEBIEGI ZESTAWIENIA, BO STOPKA NIESIE LICZBE STRON CALEGO PLIKU — a tej nie da
    // sie znac, zanim zestawienie powstanie (samo ma strony). Przebieg pierwszy jest wylacznie
    // POMIAREM (idzie do kosza), drugi rysuje juz z prawdziwa liczba. Bez tego stopka klamalaby
    // o kompletnosci wydruku, czyli o jedynej rzeczy, do ktorej ksiegowej sluzy.
    // Zalozenie: liczba stron zestawienia nie zalezy od tej liczby (to jeden krotki napis
    // w stopce), wiec drugi przebieg ma tyle samo stron, co pomiarowy.
    //
    // ⚠️ LICZBA STRON JEST LICZBA STRON TEGO PLIKU, nie obu razem: ksiegowa liczy kartki
    // wydruku, ktory trzyma w rece, a nie sume dwoch osobnych pobran.
    const zestaw = (liczbaStron) => zbudujZestawienie({
      paczka, czesc, wygenerowano, liczbaStron, liczbaDokumentow,
    });
    const proba = await PDFDocument.load(await zestaw(0));
    const stron = stronDok + proba.getPageCount();
    const zestawienie = await PDFDocument.load(await zestaw(stron));

    // Kolejnosc stron: zestawienie → dokumenty tej czesci. Grupa dokumentow stoi ZA swoim
    // zestawieniem, zeby dalo sie isc po wydruku od spisu do papieru, a nie odwrotnie.
    const wynik = await PDFDocument.create();
    for (const src of [zestawienie, ...dokumentyPdf]) {
      // eslint-disable-next-line no-await-in-loop
      const strony = await wynik.copyPages(src, src.getPageIndices());
      for (const s of strony) wynik.addPage(s);
    }
    wynik.setTitle(`Paczka dla biura ${miesiac} — ${czesc}`);
    // ⚠️ STRAZNIK NA KONIEC: `stron` (napis w stopce KAZDEJ strony zestawienia) MUSI zgadzac
    // sie z faktyczna liczba stron scalonego pliku. Zalozenie o dwoch przebiegach ("Do
    // rozstrzygniecia" w raporcie Task 11, pkt 3) jest zalozeniem, nie dowodem — gdyby kiedys
    // przestalo trzymac (np. zestawienie na krawedzi strony zmienia liczbe stron miedzy
    // przebiegami), stopka klamalaby o kompletnosci wydruku PO CICHU. Lepsza odmowa tutaj niz
    // ksiegowa liczaca strony wydruku przeciw stopce, ktora sie nie zgadza.
    if (stron !== wynik.getPageCount()) {
      throw bladOperatora(`Nie udało się przygotować paczki: liczba stron w stopce (${stron}) nie zgadza się z plikiem (${wynik.getPageCount()}).`);
    }
    return {
      bajty: Buffer.from(await wynik.save()),
      nazwa: `paczka-dla-biura-${miesiac}-${czesc}.pdf`,
      czesc,
      dokumentow: liczbaDokumentow,
      stron,
    };
  }

  return { zbuduj, zbudujZestawieniePrzychodow };
}
