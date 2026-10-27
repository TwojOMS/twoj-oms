import {
  zwrot, zwrotyZamowienia, zarezerwujKorekte, zapiszKorekte, zapiszBladKorekty,
} from '../../../oms/db/zwroty.js';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { paryKorekty } from '../../../domena/korekta-pozycje.js';
import {
  powodOdmowyKorektyDlaFaktury, powodOdmowyWystawieniaKorekty, korektaNieSprawdzona,
} from '../../../domena/zwrot.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { idDokumentuDla, programDokumentu, czyDokumentProgramu } from '../../../domena/dokument-programu.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';

/**
 * ⚠️ TRESC KOREKTY, KTORA WIDZI NABYWCA I ORGAN — STALA, NIE POLE Z FORMULARZA.
 *
 * Tu jechalo `zwroty.powod`, czyli NOTATKA OPERATORA (formularz pyta po prostu „Powód").
 * „Klientka sie rozmyslila, oddane blikiem 501…" na dokumencie podatkowym jest wyciekiem,
 * ktorego nie da sie cofnac inaczej niz kolejnym dokumentem. Notatka zostaje w panelu —
 * tam jest przydatna i tam nikomu nie szkodzi.
 *
 * Slownika dopuszczalnych powodow korekty panel nie ma (encja inFaktu niesie
 * `correction_reason_symbol`, ale jego wartosci nie sa zmierzone — notatka
 * 2026-08-14-oms-zwroty-pomiar.md). Do czasu pomiaru: jedna neutralna tresc, ta sama,
 * ktora stala tu dotad jako domyslna.
 */
const POWOD_NA_DOKUMENCIE = 'zwrot towaru';

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
export function createKorekta({ db, program: programPodany = null, infakt = null }) {
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

    if (!zarezerwujKorekte(db, zamowienieId, zwrotId)) {
      throw bladOperatora(`Korekta do tego zwrotu została już zlecona — sprawdź ją w ${nazwa.miejscownik}.`);
    }
    try {
      const wynik = await program.wystawKorekte({
        corrected_invoice_number: faktura.number,
        corrected_invoice_date: faktura.invoice_date,
        corrected_invoice_uuid: faktura.uuid ?? uuidFaktury,
        // ⚠️ STALA, nie `w.powod` — patrz `POWOD_NA_DOKUMENCIE` na gorze pliku.
        correction_reason: POWOD_NA_DOKUMENCIE,
        services,
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

    // Sito 2: dokumenty, ktore juz maja swojego zwrota przy TYM zamowieniu.
    const zajete = new Set(wszystkie
      .filter((x) => x.id !== w.id)
      .flatMap((x) => [x.korekta_numer, x.korekta_uuid])
      .filter(Boolean));
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
        && !zajete.has(k.number) && !zajete.has(k.uuid) && nieStarsza(k));
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
