import {
  zwrot, zwrotyZamowienia, zarezerwujKorekte, zapiszKorekte, zapiszBladKorekty, odrzucZlecenieKorekty,
} from '../../../oms/db/zwroty.js';
import { opisOdrzuceniaKorekty } from '../../../domena/korekta-status.js';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { paryKorekty } from '../../../domena/korekta-pozycje.js';
import {
  powodOdmowyKorektyDlaFaktury, powodOdmowyWystawieniaKorekty, korektaNieSprawdzona,
} from '../../../domena/zwrot.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { idDokumentuDla, programDokumentu, czyDokumentProgramu } from '../../../domena/dokument-programu.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';
import { gdzieDokument } from '../../../domena/nazwa-programu.js';
import { daneFaktury } from '../../../domena/dane-faktury.js';
import { rodzajKorekty, polaWdtKorekty, nipSprzedawcyDoWdt } from '../../../domena/wdt.js';
import { sprzedawcaZwolniony } from '../../faktury/db/zwolnienie-vat.js';

/**
 * ⚠️ TRESC KOREKTY, KTORA WIDZI NABYWCA I ORGAN — STALA, NIE POLE Z FORMULARZA.
 *
 * Tu jechalo `zwroty.powod`, czyli NOTATKA OPERATORA (formularz pyta po prostu „Powód").
 * „Klientka sie rozmyslila, oddane blikiem 501…" na dokumencie podatkowym jest wyciekiem,
 * ktorego nie da sie cofnac inaczej niz kolejnym dokumentem. Notatka zostaje w panelu —
 * tam jest przydatna i tam nikomu nie szkodzi.
 *
 * Kontrakt niesie neutralny tekst przyczyny (drukowany przez TwojeFaktury).
 * Klient inFaktu dobiera symbol słownika `mistake` / `other`; zwrot trafia jako `other`.
 */
const POWOD_NA_DOKUMENCIE = 'zwrot towaru';
const UWAGI_NA_DOKUMENCIE = 'Zwrot towaru';

// Dzien (YYYY-MM-DD) z ISO-znacznika albo z daty inFaktu. Porownujemy DNIAMI, bo dokument
// inFaktu niesie date dzienna, a `korekta_zlecona_at` jest znacznikiem UTC.
const dzien = (t) => String(t ?? '').slice(0, 10);

/**
 * Usluga wystawienia korekty w inFakcie — spina `paryKorekty` (domain/korekta-pozycje.js),
 * rezerwacje w bazie i klienta inFaktu (`wystawKorekte`).
 *
 * TRZY REGULY, KTORE SA SEDNEM TEJ USLUGI:
 *
 * 1. REZERWACJA PRZED wywolaniem inFaktu (`zarezerwujKorekte`, jeden UPDATE z warunkiem).
 *    Dwuklik, back+resubmit i dwie otwarte karty to znane drogi do drugiego dokumentu,
 *    a duplikat korekty rozwiazuje sie WYLACZNIE trzecim dokumentem — widocznym u organu
 *    podatkowego i u nabywcy.
 *
 * 2. ODMOWA inFaktu (4xx) ZWALNIA rezerwacje i zapisuje blad. ZERWANE POLACZENIE NIE
 *    ZWALNIA. Przy 4xx wiadomo, ze dokument nie powstal. Przy zerwanym polaczeniu nie
 *    wiadomo, czy zlecenie doszlo — zwolnienie rezerwacji otwieraloby droge do duplikatu
 *    u organu. Wtedy rozstrzyga czlowiek, ktory zajrzal do inFaktu.
 *
 * 3. „PRZED" CZYTAMY Z INFAKTU (`infakt.pobierzFakture`), NIE Z ZAMOWIENIA. Faktura mogla
 *    zostac poprawiona recznie w inFakcie — korekta odnoszaca sie do „przed", ktorego
 *    nigdy nie bylo, jest dokumentem NIEPRAWDZIWYM. Rozbieznosc dostaje ODMOWE PRZED
 *    rezerwacja: nieudana proba nie ma prawa zablokowac poprawnej.
 */
// PRZ-118.08: dokument „przed”, korektę i listę korekt daje PROGRAM FAKTUROWY (`{ program }` albo stary `{ infakt }`
// przez `zProgramu`); teksty dla człowieka jego nazwą (dla inFaktu znak w znak jak przed zmianą).
export function createKorekta({ db, program: programPodany = null, infakt = null,
  nipSprzedawcy = /** @type {string | (() => string | null | undefined) | null} */ (null),
}) {
  const program = zProgramu({ program: programPodany, infakt });
  const nazwa = program?.opis.nazwa;
  async function wystaw(zamowienieId, zwrotId) {
    const z = pobierzZamowienie(db, zamowienieId);
    if (!z) throw bladOperatora('Nie ma takiego zamówienia.');
    // ⚠️ Rozbieznosc z briefem: kolumna nazywa sie `infakt_uuid`, nie `uuid`
    // (schema.sql: `faktury.infakt_uuid`) — tak samo czyta ja domain/ksef-doczytanie.js
    // i routes/zamowienia.js. `z.faktura.uuid` bylby zawsze `undefined`.
    // PRZ-121.A04b: faktura INNEGO programu (np. inFaktu przy innym module) = 409 `bezProgramu` TUTAJ — przed
    // odczytem „przed” z programu i przed `zarezerwujKorekte`: odmowa nie ma prawa zablokować zwrotu ani pytać obcy program.
    const uuidFaktury = idDokumentuDla(z.faktura, program);
    if (!uuidFaktury) {
      throw bladOperatora(`To zamówienie nie ma faktury w ${nazwa.miejscownik} — nie ma czego korygować.`);
    }
    const w = zwrot(db, zamowienieId, zwrotId);
    if (!w) throw bladOperatora('Nie ma takiego zwrotu przy tym zamówieniu.');

    // ⚠️⚠️ JEDNA KOREKTA NA FAKTURE — I TO JEST BARIERA PODATKOWA, NIE WYGODA. Regule liczy
    // DOMENA (`powodOdmowyKorektyDlaFaktury`, domain/zwrot.js) i to samo zdanie czyta baza
    // WEWNATRZ transakcji rezerwacji (db/zwroty.js) — tutaj jest odmowa DLA CZLOWIEKA, tam
    // bariera na wyscig. Powod odmowy i jego uzasadnienie stoja przy regule, nie tutaj.
    //
    // ⚠️ ODMOWA PRZED REZERWACJA (i przed dotknieciem inFaktu) — ta sama zasada, co przy
    // rozbieznosci pozycji nizej: nieudana proba nie ma prawa zablokowac poprawnej.
    //
    // ⚠️⚠️ DWIE ODMOWY, NIE JEDNA (K1, recenzja kontrolna 2026-08-15). Ta pierwsza patrzy na
    // INNE zwroty tego zamowienia; druga — na TEN zwrot, bo „Korektę wystawiłem ręcznie"
    // zapisuje numer BEZ rezerwacji i do 2026-08-15 nie zatrzymywal go tu NIKT: panel skladal
    // drugi dokument w inFakcie, a `zapiszKorekte` (COALESCE) nadpisywalo numer reczny nowym.
    const odmowaFaktury = powodOdmowyKorektyDlaFaktury(w, zwrotyZamowienia(db, zamowienieId));
    if (odmowaFaktury) throw bladOperatora(odmowaFaktury);
    const odmowaZwrotu = powodOdmowyWystawieniaKorekty(w);
    if (odmowaZwrotu) throw bladOperatora(odmowaZwrotu);

    // ⚠️ „PRZED" Z INFAKTU, nie z zamowienia — faktura mogla zostac poprawiona recznie.
    const faktura = await program.pobierzFakture(uuidFaktury);
    const { services, blad } = paryKorekty(faktura, w, { nazwaProgramu: nazwa });
    // Odmowa PRZED rezerwacja: nieudana proba nie ma prawa zablokowac poprawnej.
    if (blad) throw bladOperatora(blad);
    const nip = daneFaktury(z).nip;
    const rodzaj = rodzajKorekty(nip, faktura.services, { zwolniona: sprzedawcaZwolniony(db, program?.opis) });
    if (rodzaj === 'niezgodna') {
      throw bladOperatora(`Nabywca ma numer VAT UE, a faktura ${faktura.number} w ${nazwa.miejscownik} nie ma stawki 0% — `
        + `to nie wygląda na WDT. Wystaw korektę ręcznie w ${nazwa.miejscownik}. Korekta NIE została zlecona.`);
    }
    const wdt = rodzaj === 'wdt';
    let polaWdt = {};
    if (wdt) {
      let nipWlasny;
      try {
        nipWlasny = nipSprzedawcyDoWdt(nip, nipSprzedawcy);
      } catch (e) {
        if (!e?.dlaOperatora) throw e;
        throw bladOperatora('Korekta faktury WDT musi nieść NIP sprzedawcy, a w ustawieniach go nie ma. '
          + 'Wpisz NIP firmy w Ustawienia → Firma (/ustawienia/firma) albo OMS_SPRZEDAWCA_NIP w pliku konfiguracji. '
          + 'Korekta NIE została zlecona.');
      }
      polaWdt = polaWdtKorekty(nip, { nipSprzedawcy: nipWlasny, uwagi: UWAGI_NA_DOKUMENCIE });
    }
    // Nabywca ze stanu faktury, bez szukania dzisiejszej kartoteki po NIP-ie. PO odmowie
    // `paryKorekty`: `pobierzFakture` bywa `null` (TwojeFaktury) i to ma byc odmowa, nie TypeError.
    const klient = faktura.client_id
      ? { client_id: faktura.client_id }
      : Object.fromEntries([
        'client_company_name', 'client_first_name', 'client_last_name', 'client_street',
        'client_street_number', 'client_flat_number', 'client_city', 'client_post_code',
        'client_tax_code', 'client_country',
      ].filter((pole) => faktura[pole] != null && String(faktura[pole]).trim() !== '')
        .map((pole) => [pole, faktura[pole]]));

    if (!zarezerwujKorekte(db, zamowienieId, zwrotId)) {
      throw bladOperatora(`Korekta do tego zwrotu została już zlecona — sprawdź ją ${gdzieDokument(program)}.`);
    }
    try {
      const wynik = await program.wystawKorekte({
        ...klient,
        corrected_invoice_number: faktura.number,
        corrected_invoice_date: faktura.invoice_date,
        corrected_invoice_uuid: faktura.uuid ?? uuidFaktury,
        // ⚠️ STALA, nie `w.powod` — patrz `POWOD_NA_DOKUMENCIE` na gorze pliku.
        correction_reason: POWOD_NA_DOKUMENCIE,
        notes: wdt ? polaWdt.notes : UWAGI_NA_DOKUMENCIE,
        services,
        ...(wdt ? { sale_type: polaWdt.sale_type, sales_kind: polaWdt.sales_kind } : {}),
      });
      zapiszKorekte(db, zamowienieId, zwrotId, wynik);
      return wynik;
    } catch (e) {
      // ⚠️ ZWALNIAMY WYLACZNIE PRZY ODMOWIE (4xx). Brak statusu znaczy zerwane polaczenie,
      // czyli „nie wiadomo, czy zlecenie doszlo" — rezerwacja ZOSTAJE i rozstrzyga czlowiek,
      // ktory zajrzal do inFaktu.
      if (e?.status >= 400 && e.status < 500) {
        zapiszBladKorekty(db, zamowienieId, zwrotId, e.message);
      }
      throw e;
    }
  }

  /**
   * Numer korekty pojawia sie DOPIERO po przetworzeniu zlecenia po stronie inFaktu, wiec
   * ekran zwrotu pyta o niego przy otwarciu. Ta sama droga, co przy numerze KSeF
   * (domain/ksef-doczytanie.js).
   *
   * ⚠️ NIE RZUCA NIGDY. Nieosiagalny inFakt nie ma prawa zamknac ekranu zwrotu — operator
   * przychodzi tu takze po to, zeby oznaczyc oddanie pieniedzy.
   *
   * ⚠️⚠️ SAM `corrected_invoice_number` NIE WYSTARCZA I TO BYLA WADA KRYTYCZNA. Do jednej
   * faktury moze istniec korekta, ktora NIE JEST korekta tego zwrotu: przypisana wczesniej
   * DRUGIEMU zwrotowi tego zamowienia albo wystawiona RECZNIE w inFakcie miesiac wczesniej.
   * Zmierzone: zamowienie z faktura `FV 1/08/2026` i dwoma zwrotami (sierpien, wrzesien),
   * w inFakcie JEDNA korekta → oba zwroty dostawaly ten sam numer, `zwrotRozliczony` oddawal
   * `true` dla obu i zamowienie schodzilo z listy roboczej. To zlamanie niezmiennika, na
   * ktorym stoi cala ta sciezka: odczyt mial byc JEDYNYM DOWODEM, ze korekta powstala
   * (`201` z inFaktu nie dowodzi niczego — notatka 2026-08-14-oms-zwroty-pomiar.md),
   * a „potwierdzal" dokument, ktorego nie ma.
   *
   * Dlatego kandydat musi przejsc TRZY sita, a nie jedno:
   *   1. numer korygowanej faktury sie zgadza (jak dotad),
   *   2. numer/uuid dokumentu NIE JEST juz przypisany innemu zwrotowi tego zamowienia,
   *   3. dokument NIE JEST STARSZY niz zlecenie tego zwrotu.
   * Zostaje DOKLADNIE JEDEN kandydat albo nie zapisujemy nic — dwa pasujace dokumenty to
   * niepewnosc, a niepewnosc konczy sie tu cisza, ktora po progu (domain/zwrot.js) i tak
   * zamienia sie w widoczny blad dla czlowieka.
   */
  async function doczytaj(zamowienieId, zwrotId) {
    const w = zwrot(db, zamowienieId, zwrotId);
    if (!w || w.korekta_numer || !w.korekta_zlecona_at) return;
    const z = pobierzZamowienie(db, zamowienieId);
    const numerFaktury = z?.faktura?.numer;
    if (!numerFaktury) return;
    // PRZ-121.A04b (recenzja): faktura INNEGO programu — bez pytania obcego programu. Jego korekta do własnej faktury
    // o tym samym numerze przykleiłaby się do tego zwrotu (sito 1 porównuje sam numer) i rozliczyła go fałszywie.
    if (programDokumentu(z.faktura) !== null && !czyDokumentProgramu(z.faktura, program)) return;
    const wszystkie = zwrotyZamowienia(db, zamowienieId);
    // Sito 2 obowiązuje także dokument wskazany przez status zlecenia.
    const zajete = new Set(wszystkie
      .filter((x) => x.id !== w.id)
      .flatMap((x) => [x.korekta_numer, x.korekta_uuid])
      .filter(Boolean));

    // PRZ-147.02b: STAN ZLECENIA wg referencji — PRZED W3 niżej. Referencja wskazuje dokładnie TEN zwrot, więc
    // zakaz zgadywania przy dwóch otwartych sprawach jej nie dotyczy. Zwalniamy WYŁĄCZNIE przy pewnej odmowie
    // (`odrzucona`); `nieznany`, 404 i błąd sieci (wyjątek) = cisza i dalej droga listy jak dotąd — zwolnienie przy
    // niepewnym stanie mogłoby dać drugą korektę do tej samej faktury.
    let uuidZeStatusu = null;
    if (w.korekta_referencja && typeof program?.statusKorekty === 'function') {
      let status = null;
      try {
        status = await program.statusKorekty(w.korekta_referencja);
      } catch {
        status = null;
      }
      if (status?.stan === 'odrzucona') {
        // `doczytaj` NIE RZUCA (ekran zwrotu go nie łapie): program spoza kontraktu albo błąd bazy = cisza,
        // rezerwacja zostaje jak była.
        try {
          const opis = opisOdrzuceniaKorekty({ nazwaProgramu: nazwa.mianownik, bledy: status.bledy ?? [] });
          // Wpis tylko przy faktycznym zwolnieniu (changes === 1): dwa równoległe wejścia dają jeden wpis,
          // a odpowiedź o starym zleceniu nie zwalnia nowszego (warunek na referencji w SQL).
          if (odrzucZlecenieKorekty(db, zamowienieId, zwrotId, w.korekta_referencja, opis)) {
            dopiszLog(db, zamowienieId, {
              akcja: 'zwrot.korekta.odczyt',
              wynik: `${opis} Rezerwacja korekty zwrotu z ${w.data} (${w.kwota} zł) zwolniona.`,
            });
          }
        } catch {
          // celowo pusto — patrz wyżej
        }
        return;
      }
      if (status?.stan === 'w_toku') return;
      if (status?.stan === 'wystawiona') uuidZeStatusu = status.uuid ?? null;
    }

    // Referencja wskazuje ten zwrot: odczyt uuid rozstrzyga przed W3, bez sita daty.
    if (uuidZeStatusu && typeof program?.pobierzKorekte === 'function') {
      let dokument; let odczytany = false;
      try {
        dokument = await program.pobierzKorekte(uuidZeStatusu);
        odczytany = true;
      } catch {
        // Błąd odczytu: dotychczasowa droga listy z sitami pozostaje zapasem.
      }
      if (odczytany) {
        // Sito 2 na uuid, który zostanie zapisany — także gdy program go w odpowiedzi nie podał.
        const uuid = dokument?.uuid ?? uuidZeStatusu;
        if (dokument?.number && !zajete.has(dokument.number) && !zajete.has(uuid)
          && (!dokument.corrected_invoice_number || dokument.corrected_invoice_number === numerFaktury)) {
          try {
            zapiszKorekte(db, zamowienieId, zwrotId, { uuid, numer: dokument.number });
            dopiszLog(db, zamowienieId, {
              akcja: 'zwrot.korekta.odczyt',
              wynik: `korekta ${dokument.number} odczytana w ${nazwa.miejscownik} po numerze zlecenia `
                + `i przypisana do zwrotu z ${w.data} (${w.kwota} zł).`,
            });
          } catch {
            // NIE RZUCA NIGDY (jak droga listy): błąd bazy nie zamyka ekranu zwrotu; lista nie zgaduje drugi raz.
          }
        }
        return;
      }
    }

    // ⚠️⚠️ WIECEJ NIZ JEDNA OTWARTA SPRAWA KOREKTY = NIE ZGADUJEMY. TO JEST SWIADOMA DECYZJA,
    // A NIE BRAK POMYSLU (W3, recenzja kontrolna 2026-08-15).
    //
    // Sito 2 nizej odrzuca dokumenty ZAJETE przez inny zwrot — ale zwrot, ktory numeru jeszcze
    // NIE MA, niczego nie zajmuje. Zmierzone: zwrot A z wiszaca rezerwacja po zerwanym
    // polaczeniu, zwrot B bez numeru, w inFakcie JEDNA korekta wystawiona RECZNIE do B → numer
    // B ladowal na zwrocie A, `zwrotRozliczony(A)` oddawal `true` i zamowienie schodzilo z listy
    // roboczej. Reczne wystawienie drugiej korekty jest droga, ktora ten modul sam NAZYWA
    // ZALECANA (panel odmawia drugiej korekty swiadomie), wiec to nie jest przypadek teoretyczny.
    //
    // Panel nie ma jak rozstrzygnac, KTORY z dwoch nierozliczonych zwrotow opisuje znaleziony
    // dokument — encja korekty nie niesie ani referencji zadania, ani niczego, co wskazywaloby
    // zwrot. Wiec nie zapisuje NIC i zostawia to czlowiekowi: numer wpisze sam („Korektę
    // wystawiłem ręcznie"), patrzac na dokument w inFakcie. Cisza jest tu tansza niz pomylka —
    // zwrot zostaje NIEROZLICZONY i widoczny na liscie roboczej, a przykleiony cudzy numer
    // znikalby z niej po cichu.
    //
    // „Otwarta sprawa" = zwrot BEZ numeru korekty przy zafakturowanym zamowieniu; kazdy taki
    // zwrot moze jeszcze dostac numer, wiec kazdy jest kandydatem do pomylki.
    //
    // ⚠️⚠️ REGULA MIESZKA W `domain/zwrot.js` (`korektaNieSprawdzona`), NIE TUTAJ (recenzja
    // kontrolna 2026-08-15). Ekran zwrotu (routes/zwroty.js) musi umiec odroznic „pytalismy
    // i korekty nie ma" od „NIE pytalismy, bo sito nas zatrzymalo" — inaczej po progu
    // `korektaPrzepadla` widok twierdzi, ze inFakt odrzucil dokument, ktorego swiadomie nie
    // sprawdzil. Trasa i ta funkcja czytaja TERAZ DOKLADNIE TO SAMO zdanie; dwie kopie tego
    // warunku rozjechalyby sie przy pierwszej zmianie sita.
    if (korektaNieSprawdzona(w, wszystkie)) return;

    // Sito 3: data dokumentu wobec dnia zlecenia. `>=`, nie `>`: korekta powstaje zwykle
    // TEGO SAMEGO DNIA, co zlecenie, a `korekta_zlecona_at` jest w UTC (dzien UTC nigdy nie
    // jest pozniejszy niz warszawski), wiec ostrzejszy warunek odrzucalby poprawne trafienia.
    // ⚠️ SWIADOMA TOLERANCJA: dokument BEZ zadnej daty przechodzi. Pomiar 2026-08-14 wymienia
    // pola encji korekty istotne dla ZAPISU i nie rozstrzyga, ktore pole daty niesie LISTA
    // (`created_at` czy `invoice_date`) — odrzucanie po nieznanym polu wygaszaloby doczytanie
    // dla wszystkich korekt naraz, a to samo w sobie jest awaria. Twardym sitem jest tu 2.
    // DO ROZSTRZYGNIECIA PRZY PIERWSZEJ KOREKCIE POD NADZOREM: jesli lista niesie date,
    // tolerancja ma zniknac i brak daty ma znaczyc odmowe.
    const nieStarsza = (k) => {
      const d = dzien(k?.created_at ?? k?.invoice_date);
      return !d || d >= dzien(w.korekta_zlecona_at);
    };
    try {
      const lista = await program.listaKorekt({});
      // ⚠️ PO `corrected_invoice_number`, NIE po referencji zadania — encja korekty referencji
      // NIE NIESIE (sprawdzone na zywym koncie 2026-08-14).
      const kandydaci = (lista ?? []).filter((k) => k.corrected_invoice_number === numerFaktury
        && !zajete.has(k.number) && !zajete.has(k.uuid) && nieStarsza(k)
        // PRZ-147.02b: status `wystawiona` zna uuid dokumentu — warunek tylko ODEJMUJE kandydatów, nigdy nie dodaje.
        && (!uuidZeStatusu || k.uuid === uuidZeStatusu));
      const znaleziona = kandydaci.length === 1 ? kandydaci[0] : null;
      if (znaleziona) {
        zapiszKorekte(db, zamowienieId, zwrotId, {
          uuid: znaleziona.uuid ?? null, numer: znaleziona.number ?? null,
        });
        // ⚠️ SLAD W LOGU ZAMOWIENIA. To jest zapis NUMERU DOKUMENTU PODATKOWEGO rozliczajacego
        // zwrot — bez wpisu po miesiacu nie da sie odpowiedziec, skad ten numer sie wzial ani
        // kiedy przybyl, a od niego zalezy, czy zwrot liczy sie jako rozliczony. Wpis powstaje
        // WYLACZNIE przy FAKCIE (tak samo jak w services/ksef-doczytanie.js): inaczej historia
        // zamowienia roslaby proporcjonalnie do liczby odslon ekranu.
        //
        // ⚠️ To NIE JEST „Ręcznie (kto): …" — nikt tego nie klikal. Panel przeczytal fakt
        // u inFaktu i tak ma to zapamietac; ksztalt wzorowany na wpisie „dokument jest w KSeF".
        dopiszLog(db, zamowienieId, {
          akcja: 'zwrot.korekta.odczyt',
          wynik: `korekta ${znaleziona.number ?? '(bez numeru)'} znaleziona w ${nazwa.miejscownik} `
            + `i przypisana do zwrotu z ${w.data} (${w.kwota} zł).`,
        });
      }
    } catch {
      // Cisza jest tu zamierzona — patrz docblock.
    }
  }

  return { wystaw, doczytaj };
}
