import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import {
  zapiszProforme, pobierzProforme, uniewaznijPoprzednie, zapiszSciezkePliku, usunProforme,
} from '../db/proformy.js';
import { czyWolnoWystawic } from '../../../domena/proforma-stan.js';
import { pozycjeDokumentu, sprawdzSumeDokumentu } from '../../../domena/pozycje-faktury.js';
import { podsumowanieVat } from '../../../domena/podsumowanie-vat.js';
import { kwotaSlownie } from '../../../domena/kwota-slownie.js';
import { daneFaktury } from '../../../domena/dane-faktury.js';
import { zbudujProformePdf } from '../pdf/proforma-pdf.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { adresSprzedawcy } from '../../../domena/adres-sprzedawcy.js';
import { bezpiecznaNazwa } from '../../../domena/pliki.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { zl } from '../../../domena/suma-pozycji.js';

// Wystawienie faktury proforma: spiecie modulow domenowych, bazy i generatora PDF w JEDNA
// operacje. Ten plik nie liczy niczego sam — cala arytmetyka, format numeru i uklad dokumentu
// mieszkaja pietro nizej. Jego jedynym zadaniem jest KOLEJNOSC FAZ, bo to ona rozstrzyga,
// co zostaje w bazie i u klienta, gdy ktoras faza padnie.
//
// ⚠️ PROFORMA NIE JEST DOKUMENTEM KSIEGOWYM: nie idzie do inFaktu, nie idzie do KSeF i wolno
// ja wystawic ponownie. Cala roznica wobec services/faktura.js wynika z tego jednego zdania —
// tam nieodwracalny dokument powstawal u kogos innego i nasz wiersz byl tylko jego odbiciem,
// tutaj dokument powstaje U NAS i jest nim plik PDF.

/**
 * KOLEJNOSC FAZ — sedno tego modulu. Wypracowana na tych samych awariach, co podzial faz
 * w services/faktura.js:
 *
 *  1. odmowy lokalne (`czyWolnoWystawic`, adres sprzedawcy, KATALOG NA PLIKI),
 *  2. BARIERA ARYTMETYCZNA (`pozycjeDokumentu` + `sprawdzSumeDokumentu`),
 *  3. arytmetyka dokumentu (podsumowanie VAT, kwota slownie),
 *  4. nadanie numeru i zapis wiersza (`zapiszProforme` — SAMA jest transakcja),
 *  5. PDF i zapis pliku na dysk,
 *  6. uniewaznienie poprzednich proform,
 *  7. podpiecie sciezki pliku i log.
 *
 * ⚠️ FAZA 2 PRZED FAZA 4, bo NIEUDANA PROFORMA NIE MA PRAWA ZUZYC NUMERU Z SERII. Kazda
 * proba, ktora zostawi po sobie wiersz, przesuwa licznik miesiaca na trwale — a dziury
 * w numeracji nikt pol roku pozniej nie wyjasni. Odmowy licza sie wiec ZANIM cokolwiek
 * trafi do tabeli; jedyna faza, ktora moze paść juz po nadaniu numeru (zapis pliku, faza 5),
 * sprzata po sobie sama.
 *
 * ⚠️ FAZA 6 PO FAZIE 5, bo NIEUDANA PROFORMA NIE MA PRAWA UNIEWAZNIC POPRZEDNIEJ, WAZNEJ.
 * Uniewaznienie „na zapas", przed powstaniem pliku, zostawialoby klienta bez ANI JEDNEGO
 * obowiazujacego dokumentu — mimo ze niczego nowego mu nie wyslano, bo nowego nie ma.
 * Dopiero istniejacy plik znaczy „jest czym zastapic".
 */
export function createProforma({
  db,
  config,
  // Wstrzykiwane WYLACZNIE po to, zeby dalo sie zajrzec do danych dokumentu bez czytania
  // bajtow PDF-a, i zeby numer nie zalezal od kalendarza maszyny (numer niesie miesiac i rok).
  budujPdf = zbudujProformePdf,
  teraz = () => new Date(),
}) {
  const ustawienia = config?.proforma;
  if (!ustawienia?.katalog) {
    throw new Error('Brak OMS_PROFORMY_KATALOG — proformy nie mialyby gdzie lezec.');
  }
  // ⚠️ BUDOWA USLUGI NIE DOTYKA DYSKU — i to jest decyzja, nie przeoczenie. Katalog zakladal
  // sie tutaj (jak katalog etykiet w services/nadanie.js) do chwili, w ktorej okazalo sie,
  // co to znaczy w produkcji: kontener chodzi z `read_only: true` (deploy/nas/compose.yaml),
  // wiec przy zle ustawionej sciezce `mkdirSync` konczy sie EROFS, `zbudujOms` rzuca, a
  // `restart: unless-stopped` zamienia to w PETLE RESTARTOW — panel przestaje przyjmowac
  // zamowienia, nadawac paczki i wystawiac faktury przez katalog na dokument pomocniczy.
  // Awaria jednej funkcji ma kosztowac jedna funkcje: proforma odmawia CZYTELNIE, w chwili
  // wystawienia (`zapewnijKatalog` nizej), a reszta panelu chodzi dalej.
  //
  // Argument, dla ktorego katalog powstawal wczesniej, zostaje w mocy i jest spelniony
  // inaczej: `zapewnijKatalog` stoi w FAZIE 1, czyli PRZED nadaniem numeru — odkrycie braku
  // katalogu po `zapiszProforme` zuzyloby numer z serii na dokument, ktorego nie ma gdzie
  // zapisac.
  function zapewnijKatalog() {
    try {
      mkdirSync(ustawienia.katalog, { recursive: true });
    } catch (e) {
      throw bladOperatora(
        `Katalog na proformy (${ustawienia.katalog}) jest nie do założenia: ${e.code ?? e.message}. `
        + 'Proforma NIE została wystawiona i żaden numer z serii nie przepadł. '
        + 'Sprawdź OMS_PROFORMY_KATALOG — musi wskazywać na zapisywalny wolumen.',
      );
    }
  }

  // Sprzedawca to NAZWA I ADRES FIRMY z `config.nadawca` — TEN SAM obiekt, ktorym jada paczki
  // (patrz config.js). Osobnego zestawu zmiennych na ten adres tu nie ma i byc nie moze:
  // w lipcu 2026 istnial drugi, nieprefiksowany zestaw `NADAWCA_*` z pustymi domyslnymi
  // wartosciami i PRZESLANIAL nim adres zwalidowany — kazda paczka jechala z pusta ulica,
  // calkowicie po cichu. NIP dokladamy z konfiguracji, bo kurierowi nie byl do niczego
  // potrzebny, a na dokumencie dla klienta jest obowiazkowy.
  function daneSprzedawcy() {
    return { ...adresSprzedawcy(config), nip: ustawienia.nip };
  }

  // ⚠️ Dane nabywcy WYLACZNIE przez `daneFaktury(z)` — nigdy wprost z `z.klient`/`z.nip`.
  // Ta sama zasada, co w services/faktura.js: operator poprawia je na karcie, bo klient podal
  // zle albo napisal, ze chce zmienic. Czytanie prosto ze sklepu robiloby z tej edycji edycje
  // POZORNA — panel pokazywalby poprawione dane, a do klienta jechalby dokument ze starymi.
  function daneNabywcy(z) {
    const d = daneFaktury(z);
    return {
      nazwa: d.firma, ulica: d.ulica, kod: d.kod, miasto: d.miasto, kraj: d.kraj, nip: d.nip,
    };
  }

  /**
   * Wystawienie proformy. SYNCHRONICZNIE — nic tu nie rozmawia z siecia: dokument powstaje
   * w calosci u nas (`zbudujProformePdf` sklada bajty w jednym przebiegu), a baza i dysk sa
   * synchroniczne. Owijanie tego w obietnice zarazaloby asynchronicznoscia kazda trase po
   * drodze, nie dajac w zamian niczego.
   *
   * Zwraca ZAPISANY wiersz proformy (z numerem, id i sciezka pliku).
   */
  function wystaw(zamowienieId) {
    const z = pobierzZamowienie(db, zamowienieId);

    // ── FAZA 1: odmowy lokalne ────────────────────────────────────────────────
    // Nic z tego nie dotyka bazy, wiec odmowa nie zostawia po sobie ani wiersza,
    // ani zuzytego numeru.
    const { wolno, powod } = czyWolnoWystawic(z);
    if (!wolno) throw bladOperatora(powod);
    const sprzedawca = daneSprzedawcy();
    const nabywca = daneNabywcy(z);
    // Katalog na pliki JESZCZE TU, w fazie odmow: nieudane zalozenie katalogu nie zostawia
    // ani wiersza, ani zuzytego numeru — tak samo jak kazda inna odmowa lokalna.
    zapewnijKatalog();

    // ── FAZA 2: bariera arytmetyczna, PRZED nadaniem numeru ───────────────────
    // TE SAME funkcje, ktore licza fakture VAT (domain/pozycje-faktury.js). Druga kopia
    // arytmetyki rozjechalaby sie przy pierwszej zmianie i klamalaby o kwocie, ktora klient
    // ma przelac — a na proformie ta kwota jest calym sensem dokumentu.
    const pozycje = pozycjeDokumentu(z);
    sprawdzSumeDokumentu(pozycje, z);

    // ── FAZA 3: arytmetyka dokumentu ──────────────────────────────────────────
    // „Do zaplaty" bierzemy z WIERSZA SUMY podsumowania VAT, a nie z osobnego dodawania
    // pozycji: kwota dużym drukiem ma zgadzac sie co do grosza z tabela, ktora stoi nad nia.
    const wierszeVat = podsumowanieVat(pozycje);
    const doZaplatyGr = wierszeVat.at(-1).bruttoGr;

    // ── FAZA 4: numer i wiersz w bazie ────────────────────────────────────────
    // ⚠️ `zapiszProforme` SAMA jest transakcja (BEGIN IMMEDIATE obejmujace odczyt licznika
    // i INSERT), wiec ani nie liczymy numeru wczesniej, ani nie owijamy jej wlasna transakcja
    // — SQLite nie ma transakcji zagniezdzonych, a wyscig o numer jest juz tam zalatwiony.
    //
    // Rok i miesiac podajemy WPROST, z tego samego znacznika czasu, co data na dokumencie:
    // dwa niezalezne odczyty zegara daly by na przelomie miesiaca numer z jednego miesiaca
    // przy dacie wystawienia z drugiego.
    //
    // ⚠️ DZIEN LICZYMY W CZASIE WARSZAWSKIM, `dzienWarszawa` — TA SAMA funkcja, ktora drukuje
    // daty na karcie (domain/format-daty.js) i ktora liczy „dzisiaj" fakturze VAT
    // (domain/termin-platnosci.js). Kontener chodzi z TZ=UTC, wiec gole `getFullYear()`/
    // `getMonth()`/`getDate()` miedzy polnoca a druga w nocy oddawaly DZIEN POPRZEDNI:
    // dokument z wczorajsza data, a na przelomie miesiaca numer z WYCZERPANEJ juz serii
    // poprzedniego miesiaca — podczas gdy karta pokazywala przy nim miesiac nastepny.
    //
    // Jeden odczyt zegara, jak dotad: `stempel` idzie i do `utworzona_at` (jako pelen znacznik
    // z chwila), i — po przeliczeniu na Warszawe — do numeru oraz daty wystawienia.
    const stempel = teraz();
    const dataWystawienia = dzienWarszawa(stempel.toISOString());
    const [rok, miesiac] = dataWystawienia.split('-').map(Number);
    const p = zapiszProforme(db, z.id, {
      kwotaBrutto: zl(doZaplatyGr),
      rok,
      miesiac,
      utworzonaAt: stempel.toISOString(),
    });

    // ── FAZA 5: dokument i plik ───────────────────────────────────────────────
    // Nazwa pliku niesie numer zamowienia i numer dokumentu, oba przez `bezpiecznaNazwa`:
    // numer proformy ma ukosniki („PF/1/08/2026"), ktore wyprowadzilyby zapis poza katalog,
    // a sciezka trafia potem do bazy i jest serwowana przez trase pobrania.
    const sciezka = join(ustawienia.katalog, `${bezpiecznaNazwa(z.numer)}-${bezpiecznaNazwa(p.numer)}.pdf`);
    try {
      writeFileSync(sciezka, budujPdf({
        numer: p.numer,
        dataWystawienia,
        sprzedawca,
        nabywca,
        pozycje,
        podsumowanieVat: wierszeVat,
        doZaplatyGr,
        slownie: kwotaSlownie(doZaplatyGr),
        rachunek: ustawienia.rachunek,
        bank: ustawienia.bank,
      }));
    } catch (e) {
      // ⚠️ WIERSZ KASUJEMY, i to jest decyzja, nie skrot. Wybor byl miedzy skasowaniem
      // a oznaczeniem go jako uniewazniony — i rozstrzyga go pytanie „czy ten dokument
      // gdziekolwiek istnieje?". Nie istnieje: PDF nie powstal, wiec ZERO bajtow na dysku
      // i zero maili u klienta. Wiersz zostawiony w tabeli klamalby operatorowi na karcie
      // („jest proforma PF/2/08/2026"), a przycisk „Pobierz PDF" nie mialby czego pobrac —
      // czyli panel pokazywalby dokument, ktorego nikt nigdy nie widzial.
      //
      // To jest DOKLADNIE ODWROTNIE niz przy fakturze VAT (services/faktura.js), gdzie wiersz
      // zostaje nawet przy niepewnej awarii: tam dokument powstawal w inFakcie, poza nami,
      // wiec „nie wiem, czy istnieje" znaczylo „zakladaj, ze istnieje". Tutaj wiemy na pewno.
      //
      // Skasowanie ODDAJE NUMER DO PULI, gdy byl to numer NAJWYZSZY (`nastepnyNumer` liczy
      // MAX z istniejacych wierszy) — i tak ma byc: skoro nikt nigdy nie zobaczyl dokumentu
      // o tym numerze, kolejna proba moze go uzyc bez ryzyka. Gdy w miedzyczasie inne
      // zamowienie wzielo numer wyzszy, po tej probie zostaje w serii DZIURA — swiadoma cena
      // za to, ze karta nie pokazuje dokumentu, ktorego klient nigdy nie dostal (patrz
      // `usunProforme` w db/proformy.js). Odwrotnie niz przy proformie UNIEWAZNIONEJ —
      // tamten wiersz zostaje, bo klient ma tamten PDF. Slad po nieudanej probie zostaje
      // w logu nizej.
      usunProforme(db, p.id);
      dopiszLog(db, z.id, {
        akcja: 'proforma',
        wynik: `BŁĄD zapisu pliku (numer ${p.numer} przepadł): ${e.message}`,
      });
      throw bladOperatora(
        `Nie udało się zapisać pliku proformy: ${e.message}. Proforma NIE została wystawiona `
        + '— żaden dokument nie powstał, a poprzednia proforma (jeśli była) dalej obowiązuje. '
        + 'Spróbuj ponownie, gdy zapis na dysk znów będzie działał.',
      );
    }

    // ── FAZA 6: uniewaznienie poprzednich ─────────────────────────────────────
    // Dopiero TERAZ, gdy dokument realnie lezy na dysku. Dwie wazne proformy naraz to klient
    // placacy wedlug starej kwoty, wiec uniewaznienie jest automatyczne — ale ani chwili
    // wczesniej, niz istnieje to, co ma zastapic poprzednia.
    //
    // Stempel czasu bierzemy Z NOWEJ PROFORMY: poprzednia przestala obowiazywac dokladnie
    // w chwili wystawienia tej, a nie w chwili drugiego odczytu zegara.
    uniewaznijPoprzednie(db, z.id, p.id, { teraz: p.utworzona_at });

    // ── FAZA 7: sciezka pliku i log ───────────────────────────────────────────
    zapiszSciezkePliku(db, p.id, sciezka);
    dopiszLog(db, z.id, { akcja: 'proforma', wynik: p.numer });
    return { ...p, plik_sciezka: sciezka };
  }

  /**
   * Bajty wystawionej proformy — do pobrania z karty.
   *
   * Czytamy Z DYSKU, a nie generujemy ponownie, i to jest istotne: klient dostal KONKRETNY
   * plik, a zamowienie zyje dalej (operator dopisuje pozycje, poprawia adres). Ponowna
   * generacja oddawalaby dokument o tym samym numerze, ale innej tresci niz ten, ktory
   * klient ma przed soba — czyli dokladnie to, przed czym broni migawka kwoty w bazie.
   * Inaczej niz faktura VAT, ktorej PDF pobiera sie z inFaktu na swiezo, bo tam prawda
   * o dokumencie zyje po tamtej stronie.
   */
  function pdf(proformaId) {
    const p = pobierzProforme(db, proformaId);
    if (!p) throw bladOperatora('Nie ma takiej proformy.');
    if (!p.plik_sciezka) {
      throw bladOperatora(
        `Proforma ${p.numer} nie ma zapisanego pliku — wystaw ją ponownie (dostanie kolejny numer).`,
      );
    }
    try {
      return { bajty: readFileSync(p.plik_sciezka), numer: p.numer };
    } catch (e) {
      // Sciezka w bazie jest, pliku nie ma (skasowany, odmontowany wolumen). Komunikat mowi
      // czlowiekowi, co ma zrobic — bo sam plik nie wroci.
      throw bladOperatora(
        `Pliku proformy ${p.numer} nie ma na dysku (${e.code ?? e.message}). `
        + 'Wystaw proformę ponownie — dostanie kolejny numer.',
      );
    }
  }

  return { wystaw, pdf };
}
