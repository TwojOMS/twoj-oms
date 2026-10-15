import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture, zwolnijFakture, oznaczFaktureDoWyjasnienia } from '../db/faktury.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { daneFaktury } from '../../../domena/dane-faktury.js';
// „Komu wolno wystawic fakture" liczy sie W DOMENIE (domain/faktura-odmowa.js) — JEDNA
// regula dla wystawiania z karty i dla wystawiania hurtem. Druga kopia rozjechalaby sie
// przy pierwszej zmianie i tryb masowy zaczalby przepuszczac to, czego karta odmawia.
import { powodOdmowyFaktury, powodOdmowyZaplaconej } from '../../../domena/faktura-odmowa.js';
// pozycje() i sprawdzSume() wyjete do domain/pozycje-faktury.js (pod nazwami pozycjeDokumentu
// i sprawdzSumeDokumentu): to CZYSTE funkcje argumentu `z`, ktore musza liczyc DOKLADNIE tak
// samo dla faktury VAT i dla przyszlej proformy — druga kopia arytmetyki rozjechalaby sie
// przy pierwszej zmianie i klamalaby o kwocie, ktora klient ma zaplacic.
import { pozycjeDokumentu, sprawdzSumeDokumentu } from '../../../domena/pozycje-faktury.js';
// TA SAMA miara, ktora sprawdza bariera arytmetyczna (sprawdzSumeDokumentu) — wariant
// „zaplacone" ma napisac na dokumencie DOKLADNIE te kwote, ktora zostala sprawdzona,
// a nie policzona drugi raz z innego pola.
import { kwotaOczekiwanaGrosze, zl } from '../../../domena/suma-pozycji.js';
// `dataPokryciaWplat` — data wplaty, ktora domknela kwote zamowienia. To jest cala tresc
// wyliczanego `oplacone_at` na karcie, wiec log faktury i karta nie moga powiedziec czegos
// innego o tym samym zamowieniu. (Sama suma wplat nie jest juz czytana TUTAJ: bariera
// „zaplacone" pyta o nia domain/faktura-odmowa.js, tym samym `sumaWplatGrosze`.)
import { dataPokryciaWplat } from '../../../domena/platnosci.js';
// Dzien kalendarzowy liczony TA SAMA funkcja, co data sprzedazy (domain/data-sprzedazy.js)
// i data drukowana na karcie. Kontener chodzi z TZ=UTC, wiec `slice(0, 10)` po naszym
// znaczniku wplaty potrafiloby cofnac dobe.
import { dzienWarszawa } from '../../../domena/format-daty.js';
// Termin platnosci i data wystawienia licza sie W DOMENIE (domain/termin-platnosci.js),
// bez ani jednej daty policzonej tutaj: to sklep B2B, wiec termin jest elementem umowy
// z klientem, a nie kosmetyka dokumentu — a dokumentu w inFakcie sie nie edytuje, tylko
// kasuje i wystawia od nowa.
import { datyFaktury, czyZaplacone } from '../../../domena/termin-platnosci.js';
// Sposob zaplaty na dokumencie. Osobno od `datyFaktury`, bo NIE jest wyborem operatora
// w formularzu, tylko faktem o zamowieniu (pobranie albo nie) — patrz domain/sposob-platnosci.js.
import { sposobPlatnosciFaktury } from '../../../domena/sposob-platnosci.js';
// WDT (spec 2026-08-26): rozpoznanie po NIP-ie nabywcy i pola payloadu — z domeny;
// VIES i seria numeracji — ze WSPOLNEJ galezi obu drog wystawiania (services/wdt-faktury.js),
// zeby karta i okres nie mialy dwoch kopii tej samej reguly. Sama stawka 0% na pozycjach
// liczy sie juz w pozycjeDokumentu.
import { czyNipUe, rozbijNipUe, polaWdtInfakt } from '../../../domena/wdt.js';
import {
  sprawdzWdtWVies, przygotujSerieWdt, seriaWdtPoAwarii, seriaWdtPoSukcesie,
} from './wdt-faktury.js';

/**
 * Data zapłaty do OZNACZENIA faktury w inFakcie — PÓŹNIEJSZA z dwóch dat.
 *
 * ⚠️ Dokumentacja zasobu `/paid.json` stawia jeden warunek: `paid_date` „nie wcześniejsza niż
 * data wystawienia". Zamówienie opłacone w sklepie 1.08 i zafakturowane 6.08 dałoby datę
 * wcześniejszą, czyli odmowę — i status, który miał się naprawić, zostałby zły. Dlatego
 * `Math.max` z dwóch, a nie sama data wpłaty.
 *
 * Wybór ŹRÓDŁA daty wpłaty: `dataPokryciaWplat`, czyli data tej konkretnej wpłaty, która
 * PRZEKROCZYŁA kwotę zamówienia — a nie „ostatnia wpłata z listy". To jest chwila, od której
 * zamówienie jest opłacone (i dokładnie to, co panel pokazuje na karcie jako `oplacone_at`,
 * a `domain/data-sprzedazy.js` bierze za dzień powstania obowiązku podatkowego). Wpłata
 * dopisana PÓŹNIEJ jest nadpłatą — to sprawa salda zamowienia, nie data zapłaty tej faktury.
 * Przy jednej wpłacie na całość obie miary dają to samo.
 *
 * ⚠️ Próg pokrycia to `kwotaOczekiwanaGrosze` (kwota ze sklepu PLUS pozycje dopisane ręcznie) —
 * TA SAMA, którą sprawdziła bariera „zapłacone wymaga prawdziwych wpłat" i która poleciała
 * na dokument jako `paid_price`. `dataPokryciaWplat` bierze próg w ZŁOTÓWKACH (taki ma
 * kontrakt), stąd `zl(...)` — identycznie jak `bezpiecznaDataPokrycia` w db/zamowienia.js.
 *
 * Brak daty wpłaty (uszkodzona wartość — `dzienWarszawa` oddaje wtedy pusty string) NIE jest
 * powodem do odmowy: to krok PO nieodwracalnym, więc spadamy na datę wystawienia, która jest
 * zawsze poprawna i zawsze spełnia warunek.
 *
 * Porównanie LEKSYKOGRAFICZNE na `RRRR-MM-DD`: w tym formacie porządek napisów JEST porządkiem
 * kalendarza, a `new Date('2026-10-25')` czyta napis jako UTC i potrafi cofnąć się o dobę.
 */
function dataZaplatyDoOznaczenia(z, invoiceDate) {
  const dzienZaplaty = dzienWarszawa(dataPokryciaWplat(z.platnosci, zl(kwotaOczekiwanaGrosze(z))));
  return dzienZaplaty > invoiceDate ? dzienZaplaty : invoiceDate;
}

/**
 * @param vies opcjonalna usluga VIES (services/vies.js). Brak = kazde sprawdzenie WDT
 *   konczy sie 'niedostepny' (wystawiamy z ostrzezeniem w logu) — panel bez sieci VIES
 *   ma dalej fakturowac, a nie stanac.
 * @param nipSprzedawcy NIP wlasny na adnotacje WDT (art. 106e ust. 1 pkt 24 — prefiks PL).
 *   Domyslna wartosc produkcyjna jak w config.proforma.nip i z tego samego powodu: dana
 *   jawna, ktorej brak nie moze skonczyc sie dokumentem bez wymaganego elementu.
 * @param teraz zegar — wylacznie do wyboru miesiaca serii WDT, gdy operator nie podal
 *   daty wystawienia. Wstrzykiwany jak w services/wiadomosci.js.
 */
export function createFaktura({
  db, infakt, vies = null, nipSprzedawcy, teraz = () => new Date().toISOString(),
}) {
  // Awaria JEDNOZNACZNA = inFakt odpowiedzial i odrzucil (4xx). Dokumentu na pewno nie ma,
  // wiec wolno zwolnic miejsce pod ponowienie. Wszystko inne — zerwane polaczenie, 5xx,
  // blad techniczny naszego kodu w trakcie wywolania — jest NIEJEDNOZNACZNE i traktujemy je
  // jak "dokument mogl powstac". Domyslna odpowiedz na niewiedze musi byc ostrozna.
  //
  // UWAGA: to pytanie ma sens WYLACZNIE dla wyjatku z `infakt.wystaw`. Rozstrzyganie nim
  // awarii z wczesniejszych krokow (patrz podzial faz w `wystaw`) blokowalo zamowienia
  // na stale za bledy, przy ktorych o dokument nikt jeszcze nie poprosil.
  const jednoznacznaOdmowa = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;

  function zwolnij(f, zamowienieId, e) {
    zwolnijFakture(db, f.id);
    dopiszLog(db, zamowienieId, { akcja: 'faktura', wynik: `BŁĄD: ${e.message}` });
  }

  // Log WDT idzie do logu TEGO zamowienia — okres pisze ta sama regula do wszystkich
  // swoich zamowien (patrz services/wdt-faktury.js, sekcja o `dopisz`).
  const dopiszWdt = (zamowienieId) => (akcja, wynik) => dopiszLog(db, zamowienieId, { akcja, wynik });

  /**
   * @param zamowienieId numer zamowienia w bazie panelu
   * @param termin OPCJONALNY wybor operatora: `{ dataWystawienia, termin }` z formularza.
   *   Brak argumentu = zachowanie sprzed tej zmiany, czyli ZADNYCH dat w payloadzie i termin
   *   z ustawien konta inFakt. To celowe: wystawianie z innych miejsc (i wszystkie dotychczasowe
   *   wywolania) ma dzialac dokladnie tak jak dotad, bez cichego dokladania dat do dokumentu.
   */
  async function wystaw(zamowienieId, termin = null) {
    const z = pobierzZamowienie(db, zamowienieId);

    // Odmowy LOKALNE stoja PRZED rezerwacja i przed czymkolwiek w sieci — komplet razem
    // z „nie ma takiego zamowienia", bo `powodOdmowyFaktury` odpowiada tez na brak wiersza.
    // Sama regula (i cale jej uzasadnienie) siedzi w domain/faktura-odmowa.js: tu zostaje
    // WYLACZNIE moment, w ktorym o nia pytamy.
    const odmowa = powodOdmowyFaktury(z);
    if (odmowa) throw bladOperatora(odmowa);

    // Cala arytmetyka PRZED rezerwacja: to sprawdzenia czysto lokalne, wiec nie ma powodu
    // zajmowac nimi miejsca w tabeli ani zostawiac sierot do sprzatania.
    const services = pozycjeDokumentu(z);
    sprawdzSumeDokumentu(services, z);

    // ⚠️ DRUGA BARIERA, O PIENIADZE — „ZAPLACONE" WYMAGA PRAWDZIWYCH WPLAT. Sama regula
    // (i jej uzasadnienie) siedzi w domain/faktura-odmowa.js razem z reszta odmow.
    //
    // Odmowa stoi PRZED rezerwacja, jak reszta odmow lokalnych: zly wybor w formularzu ma
    // odbic sie od formularza, a nie zostawic w tabeli sierote blokujaca fakture.
    if (termin && czyZaplacone(termin.termin)) {
      const odmowaZaplaty = powodOdmowyZaplaconej(z);
      if (odmowaZaplaty) throw bladOperatora(odmowaZaplaty);
    }
    // Daty licza sie TU, czyli tez PRZED rezerwacja: literowka w polu terminu ma odbic sie
    // od formularza, a nie zostawic w tabeli sierote blokujaca fakture do konca swiata.
    // Bez argumentu wychodzi pusty obiekt i payload jest bajt w bajt taki, jak byl.
    //
    // Kwota idzie DRUGIM argumentem i jest potrzebna wylacznie wariantowi „zaplacone"
    // (`paid_price` w groszach). Liczymy ja `kwotaOczekiwanaGrosze` — czyli TA SAMA
    // funkcja, ktora chwile wyzej sprawdzila `sprawdzSumeDokumentu`; `z.kwota_brutto`
    // rozjechaloby sie z dokumentem przy kazdej pozycji dopisanej recznie.
    const daty = termin ? datyFaktury(termin, kwotaOczekiwanaGrosze(z)) : {};

    // Dane nabywcy licza sie RAZ, przed rezerwacja (funkcja czysta) — uzywa ich faza
    // przygotowania (kartoteka) i galaz WDT. Rozpoznanie WDT idzie po TYM SAMYM numerze,
    // ktory pojdzie do kartoteki i na dokument, wiec reczna poprawka NIP-u na karcie
    // zmienia stawke razem z nabywca, nigdy osobno (por. domain/pozycje-faktury.js).
    const d = daneFaktury(z);
    const wdt = czyNipUe(d.nip);

    // REZERWACJA. Od tej linii druga proba odbija sie od bazy, a nie od naszej uwaznosci.
    const f = rozpocznijFakture(db, zamowienieId);

    // FAZA PRZYGOTOWANIA (kroki 1-2). Nic tutaj NIE MOZE stworzyc dokumentu: GET po NIP-ie
    // niczego nie wystawia, POST /clients.json zaklada wpis w kartotece, a nasze wlasne
    // odmowy nie ida nawet do sieci. Dlatego kazda awaria tej fazy — bez wzgledu na to, czy
    // niesie `status` — zwalnia rezerwacje. Poprzednia wersja rozstrzygala JEDNYM `catch`
    // po `e.status`, wiec duplikat NIP-u w kartotece (blad czysto lokalny, bez statusu),
    // zerwana siec na GET-cie i 500 z zakladania klienta blokowaly zamowienie na stale
    // komunikatem o dokumencie, o ktory nigdy nie poproszono.
    let clientId;
    try {
      // Nabywca musi ISTNIEC w kartotece — faktura wskazuje go id, nie danymi.
      // Bez NIP-u nie szukamy: dopasowanie po nazwie podpieloby fakture pod CUDZY wpis,
      // a tego (w odroznieniu od duplikatu) nie da sie cofnac.
      //
      // ⚠️ Dane nabywcy czytamy `daneFaktury(z)` (policzone przed rezerwacja), czyli TAK
      // SAMO jak karta zamowienia — NIGDY wprost z `z.klient`/`z.nip`. Operator poprawia
      // je na karcie, bo klient podal zle (albo napisal, ze chce zmienic); czytanie tu
      // prosto ze sklepu robiloby z tej edycji edycje POZORNA: panel pokazywalby poprawione
      // dane, a do inFaktu poszlyby stare — i to na dokumencie, ktorego juz nie da sie
      // tak po prostu zmienic.
      //
      // WDT: numer nabywcy MUSI byc wazny w VIES (art. 42 ust. 1 pkt 1) — bez tego 0%
      // to zanizony VAT nalezny. Odmowa leci z fazy przygotowania, wiec zwalnia rezerwacje.
      if (wdt) await sprawdzWdtWVies({ vies, nip: d.nip, dopisz: dopiszWdt(zamowienieId) });
      clientId = d.nip ? await infakt.znajdzKlientaPoNip(d.nip) : null;
      if (!clientId) {
        clientId = await infakt.zalozKlienta({
          // company_name jest WYMAGANE takze dla osoby prywatnej (422 "Prosze podac nazwe firmy").
          // Fallback na imie i nazwisko robi juz daneFaktury(); tu zostaje ostatnia deska.
          company_name: d.firma || 'Nabywca',
          // NIP musi trafic do kartoteki, inaczej `q[nip_eq]` nigdy tego wpisu nie znajdzie
          // i kazde kolejne zamowienie tego klienta zalozy nastepny duplikat.
          nip: d.nip || null,
          // Adres jednym stringiem — sprawdzone, street_number moze zostac puste.
          // Zgadywanie numeru z tekstu psuloby "Aleja 1 Maja 5" czesciej niz cokolwiek naprawialo.
          street: d.ulica,
          postal_code: d.kod,
          city: d.miasto,
          // Przy WDT kraj wpisu bierze sie Z PREFIKSU numeru (SK…), nie z `d.kraj`:
          // zamowienie reczne nie ma pola kraju i oddaje domyslne 'PL', a wpis kartoteki
          // z krajem PL polozylby fakture unijnego nabywcy na walidacji inFaktu.
          country: wdt ? rozbijNipUe(d.nip).kraj : d.kraj,
          email: d.email,
        });
      }
      if (!clientId) throw bladOperatora('inFakt nie oddał identyfikatora nabywcy.');
    } catch (e) {
      zwolnij(f, zamowienieId, e);
      throw e;
    }

    // NUMER WLASNEJ SERII WDT — po rozstrzygnieciu nabywcy, przed wystawieniem. Miesiac
    // serii idzie za DATA WYSTAWIENIA (operator moze antydatowac dokument), a bez niej za
    // dniem dzisiejszym. Rezerwacje, straznik duplikatu i zwalnianie licznika trzyma
    // WSPOLNA galaz (services/wdt-faktury.js); awaria zwalnia tez rezerwacje faktury,
    // bo dokumentu na pewno jeszcze nie ma.
    let seriaWdt = null;
    if (wdt) {
      try {
        seriaWdt = await przygotujSerieWdt({ db, infakt, dzien: daty.invoice_date ?? dzienWarszawa(teraz()) });
      } catch (e) {
        zwolnij(f, zamowienieId, e);
        throw e;
      }
    }

    // FAZA WYSTAWIENIA (krok 3). JEDYNE miejsce, w ktorym moze powstac dokument — i dlatego
    // jedyne, ktoremu wolno zostawic blokade. inFakt liczy VAT sam, podajemy brutto w groszach.
    let w;
    try {
      // BEZ send_to_ksef. Wystawienie faktury SAMO Z SIEBIE nigdy jej nie wysyla do KSeF —
      // ani tu, ani nigdzie indziej w tej funkcji. Wysylka to OSOBNA, SWIADOMA decyzja
      // czlowieka: operator zatwierdza ja recznie na zakladce faktur, po ekranie podgladu
      // (POST /faktury/ksef/wyslij, services/wysylka-ksef.js), a panel zglasza ja do
      // inFaktu przez `wyslijDokumentDoKsef` w infakt/client.js. Wczesniej ten parametr byl
      // ustawiany na twardo, wiec KAZDA faktura z panelu leciala do KSeF automatycznie,
      // mimo ze nikt o to nie prosil.
      // `...daty` to `invoice_date` i (poza wariantem „bez terminu") `payment_date`. Rozsypane
      // NA KONCU celowo: gdy operator terminu nie podal, obiekt jest pusty i nie dokladamy do
      // dokumentu ani jednego pola, ktorego tam wczesniej nie bylo.
      //
      // ⚠️ `...sposobPlatnosciFaktury(z)` TA SAMA ZASADA: pusty obiekt dla wszystkiego poza
      // pobraniem, wiec payload faktury przedplaconej zostaje bajt w bajt taki, jaki byl.
      // Przy pobraniu doklada `payment_method: 'delivery'` — bez tego kazda faktura
      // pobraniowa wychodzila z domyslnym „przelewem" z ustawien konta inFakt i mowila
      // klientowi „zaplac przelewem" za cos, co zaplaci kurierowi (zgloszenie wlasciciela
      // 07.08.2026, faktura 18/08/2026). Powod, dla ktorego to NIE jest czesc `datyFaktury`:
      // sposob zaplaty nie jest data i nie wynika z wyboru operatora w formularzu, tylko
      // z FAKTU o zamowieniu — patrz domain/sposob-platnosci.js.
      w = await infakt.wystaw({
        client_id: clientId, services, ...daty, ...sposobPlatnosciFaktury(z),
        // Pola WYLACZNIE dokumentu WDT (domain/wdt.js) — dla nabywcy krajowego oba
        // rozsypania sa puste i payload zostaje bajt w bajt taki, jaki byl.
        ...polaWdtInfakt(d.nip, { nipSprzedawcy }),
        ...(seriaWdt ? { number: seriaWdt.numer } : {}),
      });
    } catch (e) {
      // Los numeru serii rozstrzyga wspolna galaz: 4xx zwalnia, niejednoznaczna zostawia
      // zajety z gloszym sladem w logu (dziura w serii to fakt do wyjasnienia).
      seriaWdtPoAwarii({ db, seria: seriaWdt, jednoznaczna: jednoznacznaOdmowa(e), dopisz: dopiszWdt(zamowienieId) });
      if (jednoznacznaOdmowa(e)) {
        zwolnij(f, zamowienieId, e);
      } else {
        oznaczFaktureDoWyjasnienia(db, f.id, e.message);
        dopiszLog(db, zamowienieId, { akcja: 'faktura', wynik: `DO WYJAŚNIENIA: ${e.message}` });
      }
      throw e;
    }

    // Log PRZED zapisem wiersza, celowo. Numer faktury jest faktem nieodwracalnym —
    // dokument juz istnieje w inFakcie, ze swoim miejscem w numeracji, niezaleznie od
    // tego, czy dotarl juz do KSeF — a wiersz w naszej bazie tylko jego odbiciem. Gdyby
    // zapis padl (dysk, blokada WAL), to log jest jedynym sladem, z ktorego czlowiek
    // odtworzy co sie stalo. Rezerwacja zostaje w bazie i dalej blokuje drugi dokument.
    dopiszLog(db, zamowienieId, { akcja: 'faktura', wynik: w.numer ?? 'OK' });
    // Prawda o numerze jest ODPOWIEDZ inFaktu — rozjazd z seria WDT rozstrzyga wspolna
    // galaz (glosny log + zwolnienie licznika); patrz services/wdt-faktury.js.
    seriaWdtPoSukcesie({ db, seria: seriaWdt, numerZwrocony: w.numer, dopisz: dopiszWdt(zamowienieId) });
    zakonczFakture(db, f.id, w);

    // ⚠️ KROK PO NIEODWRACALNYM — I DLATEGO NIE MA PRAWA NICZEGO ZEPSUĆ.
    //
    // Usterka, którą to naprawia (zgłoszenie właściciela 06.08.2026, potwierdzone odczytem
    // 60 ostatnich faktur z żywego konta): nasze dokumenty mają `paid_price` i `left_to_pay: 0`,
    // czyli DLA KLIENTA drukują „Zapłacono: 158,00 / Pozostało: 0,00" — a mimo to leżą
    // w inFakcie ze statusem `sent`, bo ten status przestawia się dopiero na `paid_date`,
    // którego panel nie wysyłał. Skutkiem jest lista należności, na której właściciel widzi
    // jako niezapłacone faktury dawno zapłacone. Luka jest OD POCZĄTKU i dotyczy WSZYSTKICH
    // kanałów (te same objawy mają dokumenty z Apilo).
    //
    // ⚠️ AWARIA TEGO WYWOŁANIA JEST NIESZKODLIWA I MUSI TAKA ZOSTAĆ. W tej linii dokument
    // w inFakcie JUŻ ISTNIEJE, ma numer, ma miejsce w numeracji i ma zapisany wiersz
    // w naszej bazie. Rzucenie stąd wywaliłoby operatorowi operację, która SIĘ UDAŁA,
    // i zostawiło rezerwację w stanie, którego nikt nie zdejmie. Jedynym skutkiem
    // nieudanego oznaczenia jest STATUS W inFAKCIE — czyli dokładnie dzisiejszy stan rzeczy.
    // Dlatego: łapiemy WSZYSTKO (nie tylko `bladOperatora` — także TypeError z naszego kodu
    // i złą ścieżkę, gdyby dokumentacja kłamała), zapisujemy do logu zamówienia i jedziemy dalej.
    //
    // ⚠️ TYLKO wariant „zapłacone". Faktura z terminem płatności MA zostać nieopłacona — to jest
    // PRAWDA o niej, a nie usterka; oznaczenie jej zrobiłoby z listy należności fikcję.
    // Rozpoznanie wariantu przez `czyZaplacone` (razem z aliasem `oplacone`), tak samo jak
    // robi to bariera o pieniądze wyżej i `datyFaktury` — nigdy przez `termin === 'zaplacone'`.
    // Że pieniądze NAPRAWDĘ są, sprawdziła już tamta bariera.
    if (termin && czyZaplacone(termin.termin)) await zlecOznaczenieZaplaty(z, w, daty.invoice_date, zamowienieId);

    return w;
  }

  /**
   * Zlecenie oznaczenia wystawionej faktury jako opłaconej. NIGDY NIE RZUCA.
   *
   * ⚠️ `201` z inFaktu znaczy „PRZYJĘTO ZLECENIE", nie „oznaczono" — operacja jest po ich
   * stronie asynchroniczna. Log mówi więc „zlecono", a nie „oznaczono": panel nie ma prawa
   * twierdzić, że status się zmienił, skoro tego nie sprawdza.
   *
   * Komunikat awarii jest DŁUGI celowo. Log zamówienia jest JEDYNYM miejscem, z którego
   * właściciel się o tym dowie (na ekranie nic się nie stanie — i tak ma być), więc musi
   * powiedzieć wszystko naraz: że faktura JEST wystawiona, że dokument dla klienta jest
   * poprawny, co dokładnie odpowiedział inFakt i co z tym zrobić ręcznie.
   */
  async function zlecOznaczenieZaplaty(z, w, invoiceDate, zamowienieId) {
    let wynik;
    try {
      const paidDate = dataZaplatyDoOznaczenia(z, invoiceDate);
      await infakt.oznaczZaplacona(w.uuid, { paidDate });
      wynik = `Zlecono w inFakcie oznaczenie faktury ${w.numer ?? '(bez numeru)'} jako opłaconej `
        + `(data zapłaty ${paidDate}). inFakt przetwarza to zadanie w tle.`;
    } catch (e) {
      wynik = `UWAGA: faktura ${w.numer ?? '(bez numeru)'} została WYSTAWIONA i dokument dla klienta `
        + 'jest poprawny („Zapłacono", pozostało 0,00), ale nie udało się zlecić oznaczenia jej '
        + 'jako opłaconej — w inFakcie zostanie na liście jako NIEOPŁACONA. Przestaw jej status '
        + `ręcznie w inFakcie. Faktura jest w porządku, poprawy wymaga tylko status. Powód: ${e.message}`;
    }
    // Nawet zapis do logu nie ma prawa wywalić kroku po nieodwracalnym: gdyby padł (dysk,
    // blokada WAL), faktura i tak jest wystawiona i zapisana, a operator ma zobaczyć sukces.
    try {
      dopiszLog(db, zamowienieId, { akcja: 'faktura', wynik });
    } catch { /* celowo puste — patrz wyżej */ }
  }

  /**
   * PDF wystawionej faktury — do wydruku i na dysk.
   *
   * Panel NIE TRZYMA kopii dokumentu i to jest świadome: jedyną prawdą o fakturze jest
   * inFakt (numeracja, korekty, KSeF). Plik w naszym katalogu zestarzałby się po pierwszej
   * korekcie, a operator drukowałby nieaktualny dokument nie wiedząc o tym. Pobieramy więc
   * za każdym razem na świeżo — inaczej niż etykietę DPD, która jest niezmienna od chwili
   * nadania i dlatego leży na dysku.
   *
   * Odmowy są ROZRÓŻNIONE, bo znaczą co innego dla człowieka: brak faktury w ogóle to nie
   * to samo, co faktura zawieszona w połowie wystawiania (`w_toku`/`do_wyjaśnienia`),
   * której dokumentu w inFakcie może jeszcze nie być.
   */
  async function pdf(zamowienieId) {
    // Fakture czytamy przez `pobierzZamowienie` — tak samo jak karta, wiec przycisk i trasa
    // patrza na DOKLADNIE ten sam wiersz (zLinii dokleja `faktura` do zamowienia).
    const f = pobierzZamowienie(db, zamowienieId)?.faktura;
    if (!f) throw bladOperatora('To zamówienie nie ma jeszcze faktury.');
    if (!f.infakt_uuid) {
      throw bladOperatora('Faktura nie została do końca wystawiona — panel nie zna jej numeru w inFakcie.');
    }
    const bajty = await infakt.pobierzPdf(f.infakt_uuid);
    return { bajty, numer: f.numer ?? null };
  }

  return { wystaw, pdf };
}
