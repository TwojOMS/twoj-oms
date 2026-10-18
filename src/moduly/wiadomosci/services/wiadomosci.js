import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { proformyZamowienia } from '../../faktury/db/proformy.js';
import { zapiszWiadomosc } from '../../../oms/db/wiadomosci.js';
import { aktualnaProforma } from '../../../domena/proforma-stan.js';
import { czyWolnoWyslac, NAZWA_TEMATU } from '../../../domena/wiadomosci.js';
import { modelWiadomosci, jakoTekstWiadomosci, TEMAT_MAILA } from '../../../domena/wiadomosc-platnicza.js';
import { trescPotwierdzenia } from '../../../domena/potwierdzenie-zamowienia.js';
import { renderWiadomoscHtml } from '../../../core/poczta/wiadomosc-html.js';
import { renderPotwierdzenieHtml } from '../../../core/poczta/potwierdzenie-html.js';
import { adresatKlienta } from '../../../domena/adresat-klienta.js';
import { bezpiecznaNazwa } from '../../../domena/pliki.js';
import { bladOperatora } from '../../../domena/bledy.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { oprawaMaila, tekstZeStopka } from '../oprawa.js';
// WDT (spec 2026-08-26): mail „Faktura" dla zamowienia z nabywca unijnym dostaje DRUGI
// zalacznik — „Potwierdzenie wywozu towarow" (art. 42 ust. 4), skladane na swiezo z tych
// samych danych, co przycisk na karcie (routes/zamowienia.js). Regula rozpoznania jest
// TA SAMA, ktora wybiera stawke faktury (domain/wdt.js).
import { czyNipUe } from '../../../domena/wdt.js';
import { daneFaktury } from '../../../domena/dane-faktury.js';
import { adresSprzedawcy } from '../../../domena/adres-sprzedawcy.js';
import { modelOswiadczenia } from '../../../domena/oswiadczenie-wywozu.js';
import { zbudujOswiadczenieWywozuPdf } from '../../faktury/pdf/oswiadczenie-wywozu-pdf.js';

// WYSYŁKA WIADOMOŚCI DO KLIENTA Z KARTY ZAMÓWIENIA (22.08.2026).
//
// ⚠️ USŁUGA NIE DECYDUJE, CZY WYSŁAĆ — decyduje człowiek, klikając na ekranie PODGLĄDU.
// Czy wolno, rozstrzyga domena (`domain/wiadomosci.js`) i to ona odmawia z powodem.
//
// ⚠️⚠️ MAILA NIE DA SIĘ COFNĄĆ. Stąd kształt: trasa GET pokazuje podgląd, POST wysyła,
// a ślad zostaje w DWÓCH miejscach — w rejestrze (`wiadomosci`) i w logu karty.
//
// ⚠️ POTWIERDZENIE PRZYJĘCIA ZAMÓWIENIA IDZIE STARĄ USŁUGĄ (`services/potwierdzenie.js`),
// a nie drugą kopią tamtej ścieżki. Ta usługa wyłącznie DELEGUJE — inaczej ten sam mail
// miałby dwie drogi wysyłki, dwa miejsca zapisu `potwierdzenie_wyslane_at` i dwa zestawy
// pułapek do utrzymania.

export function createWiadomosci({
  db, mailer, potwierdzenie = null, proforma = null, infakt = null, config = {},
  teraz = () => new Date().toISOString(),
}) {
  // Rachunek i odbiorca przelewu pochodzą z jawnej konfiguracji faktur/nadawcy.
  // config.sprzedawca to tożsamość prawna rdzenia; podpis i oprawa poczty są osobną marką.
  const oprawa = oprawaMaila(config.oprawaPoczty);
  const rachunek = config.proforma?.rachunek ?? null;
  // PRZ-093.08: nazwa odbiorcy z TEGO SAMEGO źródła adresu firmy co proforma (plik DPD_NADAWCA_* wygrywa, potem
  // Ustawienia → Firma), czytana przy każdym mailu — liczona raz przy starcie i tylko z pliku dawała pusty
  // „Odbiorca: ” firmie z adresem wpisanym w panelu. Skład bez `config.adresFirmy` czyta config.nadawca jak dotąd.
  const odbiorcaPrzelewu = () => (typeof config.adresFirmy === 'function'
    ? config.adresFirmy()?.nazwa : config.nadawca?.nazwa) ?? '';

  /**
   * Fakty, od których zależą blokady i stany tematów.
   *
   * ⚠️ JEDNO MIEJSCE, z którego korzystają: widok karty, ekran wyboru, podgląd i wysyłka.
   * Gdyby każde liczyło je u siebie, ekran mógłby pokazać temat dostępny, a wysyłka odmówić.
   */
  function kontekst(id) {
    const z = pobierzZamowienie(db, id);
    if (!z) throw bladOperatora(`Nie ma zamówienia ${id}`);
    return {
      z,
      proforma: aktualnaProforma(proformyZamowienia(db, id)),
      faktura: z.faktura ?? null,
      dzis: dzienWarszawa(teraz()),
    };
  }

  /** Nazwa pliku załącznika — ukośniki numeru dokumentu zamienia `bezpiecznaNazwa`. */
  const nazwaPliku = (przedrostek, numer) => `${przedrostek}_${bezpiecznaNazwa(numer)}.pdf`;

  /**
   * Treść i załącznik gotowe do pokazania albo do wysłania.
   *
   * ⚠️ TA SAMA FUNKCJA ZASILA PODGLĄD I WYSYŁKĘ. Drugi, „podglądowy" składacz treści
   * rozjechałby się z prawdziwym mailem przy pierwszej poprawce — a cała wartość ekranu
   * podglądu polega na tym, że pokazuje DOKŁADNIE to, co pójdzie.
   */
  async function zloz(id, temat_id) {
    const k = kontekst(id);
    const zg = czyWolnoWyslac(k.z, temat_id, k);
    if (!zg.wolno) throw bladOperatora(zg.powod);

    if (temat_id === 'potwierdzenie') {
      const mail = trescPotwierdzenia(k.z, { podpis: oprawa.podpis });
      return { do: mail.do, temat: mail.temat, tekst: tekstZeStopka(mail.tekst, oprawa.footer),
        html: renderPotwierdzenieHtml(mail.model, oprawa), zalaczniki: [] };
    }

    // Dokument, którego numer trafia w TYTUŁ PRZELEWU. Reguła (zatwierdzona makieta i oba
    // komentarze przy `modelWiadomosci` w wiadomosc-platnicza.js): proforma → faktura → numer
    // zamówienia. Przy proformie i fakturze dokument jest oczywisty; przy przypomnieniu klient
    // ma przed sobą TEN dokument, na który ma przelać — najpierw proforma, a BEZ NIEJ faktura
    // (typowa ścieżka B2B: faktura z terminem 14 dni, proformy nigdy nie było). Dopiero bez
    // obu zostaje numer zamówienia — to już liczy `modelWiadomosci`
    // (`tytul = dokument?.numer ?? z?.numer ?? ''`).
    //
    // ⚠️⚠️ ZNALEZISKO RECENZJI CAŁOŚCI GAŁĘZI (22.08.2026, styk usługi i domeny): usługa dotąd
    // realizowała WYŁĄCZNIE „proforma → numer zamówienia" — faktura tu nigdy nie trafiała,
    // mimo że komentarz o `zdanieDokumentu` kilkadziesiąt linii niżej w wiadomosc-platnicza.js
    // już zakładał, że `dokument` przy przypomnieniu bywa numerem FAKTURY. Skutek na produkcji:
    // faktura prosiła o przelew z tytułem FV/…, przypomnienie trzy dni później — z tytułem
    // NUMERU ZAMÓWIENIA, więc księgowość nie dopasowywała wpłaty do żadnego dokumentu.
    const dokument = temat_id === 'faktura' ? k.faktura
      : temat_id === 'przypomnienie' ? (k.proforma ?? k.faktura)
      : k.proforma;

    // ⚠️ ZAŁĄCZNIKI SKŁADAMY PRZED MODELEM, bo zdanie „W załączeniu proforma …" ma opisywać
    // FAKT (co naprawdę jedzie z mailem), a nie temat wiadomości. Odwrotna kolejność dawała
    // maila mówiącego o proformie, której w kopercie nie ma — albo nazywającego fakturę
    // proformą.
    const zalaczniki = [];
    let zalacznikProformy = null;
    if (temat_id === 'proforma') {
      // ⚠️ STRAŻNIK WSTRZYKNIĘTEJ USŁUGI (recenzja całości gałęzi, 22.08.2026). `proforma`
      // ma domyślnie `null` i panel bez skonfigurowanego katalogu proform składa się bez niej.
      // Bez tego wiersza operator dostawał `TypeError` opakowany w „Wiadomość NIE została
      // wysłana: Cannot read properties of null" — komunikat, z którego nie wynika ani co
      // jest zepsute, ani gdzie to naprawić (niezmiennik 4.9: odmowa ma mieć POWÓD).
      if (!proforma) {
        throw bladOperatora('Panel nie ma usługi proform — PDF-u do załącznika nie ma skąd wziąć.');
      }
      const { bajty, numer } = proforma.pdf(k.proforma.id);
      zalaczniki.push({ filename: nazwaPliku('Proforma', numer), content: bajty });
    } else if (temat_id === 'faktura') {
      // ⚠️ TEN SAM STRAŻNIK, DRUGA USŁUGA. Panel z pocztą, BEZ `INFAKT_*`, ale ze starą
      // fakturą w bazie pokazuje temat „Faktura" jako dostępny (bariera domeny pyta
      // o `infakt_uuid` i numer, czyli o WIERSZ, a nie o klienta inFaktu) — i dopiero tu
      // wychodziło, że pobrać PDF-u nie ma czym.
      if (!infakt) {
        throw bladOperatora('Panel nie ma połączenia z inFaktem — PDF-u faktury nie ma skąd pobrać.');
      }
      // ⚠️ NA ŚWIEŻO Z INFAKTU, nie z kopii: dopiero tam dokument ma numer KSeF w pierwszej
      // linii. Ta sama droga, co przy wysyłce faktury na konto kupującego w Allegro.
      const bajty = await infakt.pobierzPdf(k.faktura.infakt_uuid);
      zalaczniki.push({ filename: nazwaPliku('Faktura', k.faktura.numer), content: bajty });
      // WDT: do koperty dochodzi „Potwierdzenie wywozu towarów" do podpisu przez nabywcę.
      // Awaria składania NIE jest cicha i NIE wysyła faktury bez dokumentu wywozu:
      // odmowa z powodem (np. brak adresu sprzedawcy w konfiguracji) idzie tą samą drogą,
      // co każda nieudana kompozycja — do operatora i do logu (`nieudane-zlozenie`).
      // Zdanie w treści maila zapala FAKT z koperty (`zalacznikWywozu` niżej), nie temat.
      if (czyNipUe(daneFaktury(k.z).nip)) {
        const oswiadczenie = zbudujOswiadczenieWywozuPdf(modelOswiadczenia(k.z, {
          sprzedawca: { ...adresSprzedawcy(config), nip: config?.proforma?.nip ?? null },
          dzis: k.dzis,
        }));
        zalaczniki.push({ filename: nazwaPliku('Potwierdzenie_wywozu', k.faktura.numer), content: oswiadczenie });
      }
    } else if (k.proforma?.plik_sciezka && proforma) {
      // PRZYPOMNIENIE dokłada aktualną proformę, gdy taka jest — klient dostaje razem
      // z prośbą dokument, na który ma przelać. Gdy proformy nie ma, mail idzie bez załącznika
      // i BEZ zdania o nim.
      // ⚠️ Faktury do przypomnienia NIE dokładamy: klient dostał ją już własnym mailem,
      // a drugi egzemplarz tego samego dokumentu księgowego tylko myli.
      const { bajty, numer } = proforma.pdf(k.proforma.id);
      zalaczniki.push({ filename: nazwaPliku('Proforma', numer), content: bajty });
      zalacznikProformy = numer;
    }

    const model = modelWiadomosci(k.z, {
      temat_id, dokument, zalacznikProformy,
      // FAKT Z KOPERTY: zdanie o potwierdzeniu wywozu zapala się wyłącznie wtedy, gdy
      // dokument NAPRAWDĘ jedzie w załączniku — ta sama zasada, co `zalacznikProformy`.
      zalacznikWywozu: zalaczniki.some((a) => a.filename.startsWith('Potwierdzenie_wywozu')),
      // ⚠️ FAKT Z KOPERTY, NIE WNIOSEK Z TEMATU: zdanie zamykające przy braku rachunku i przy
      // błędzie wyceny odsyła klienta „na dokument w załączniku" — i ma je mówić WYŁĄCZNIE
      // wtedy, gdy ten dokument naprawdę jedzie. Ta sama zasada, co przy `zalacznikProformy`
      // linijkę wyżej, i ten sam powód: przypomnienie bez proformy nie ma żadnego załącznika.
      zalaczonyDokument: zalaczniki.length > 0,
      rachunek, odbiorca: odbiorcaPrzelewu(), dzis: k.dzis, podpis: oprawa.podpis,
    });

    return {
      // ⚠️ ADRES Z JEDNEJ REGUŁY DOMENY (`adresatKlienta`), nigdy z pola czytanego tutaj —
      // inaczej potwierdzenie poszłoby do zamawiającego, a faktura do księgowości.
      do: adresatKlienta(k.z),
      temat: (TEMAT_MAILA[temat_id])(k.z, dokument),
      tekst: tekstZeStopka(jakoTekstWiadomosci(model), oprawa.footer),
      html: renderWiadomoscHtml(model, oprawa),
      zalaczniki,
      model,
      z: k.z,
    };
  }

  async function podglad(id, temat_id) {
    const w = await zloz(id, temat_id);
    return {
      do: w.do, temat: w.temat, tekst: w.tekst, html: w.html,
      zalacznik: w.zalaczniki[0]?.filename ?? null,
    };
  }

  async function wyslij(id, temat_id, { ktoKlikal = 'operator' } = {}) {
    // ⚠️⚠️ ŚLAD TAKŻE WTEDY, GDY NIE BYŁO CZEGO WYSŁAĆ (recenzja całości gałęzi, 22.08.2026 —
    // najpoważniejsza z odłożonych). Do tej pory `try/catch` obejmował WYŁĄCZNIE `sendMail`,
    // a złożenie treści stało poza nim: padnięty inFakt, zniknięty plik proformy i odmowa
    // domeny oddawały operatorowi 400 i ZERO śladu na karcie. „Kliknąłem, coś mrugnęło, karta
    // pusta" jest dokładnie tym stanem, którego reszta tego modułu unika.
    //
    // ⚠️ OSOBNA AKCJA, NIE `wiadomosc.blad`: tamten wpis mówi „BŁĄD wysyłki … do <adres>",
    // czyli opisuje maila, którego PRÓBOWANO wysłać. Tutaj nie próbowano niczego — nie ma
    // nawet adresata (`w.do` jeszcze nie istnieje) — i log nie ma prawa twierdzić inaczej.
    const odnotujNieudaneZlozenie = (blad) => dopiszLog(db, id, {
      akcja: 'wiadomosc.nieudane-zlozenie',
      wynik: `NIE UDAŁO SIĘ PRZYGOTOWAĆ wiadomości „${NAZWA_TEMATU[temat_id] ?? temat_id}" `
        + `(${ktoKlikal}): ${blad.message} — nic nie poszło do klienta.`,
    });

    // ⚠️ POTWIERDZENIE: CZYSTA DELEGACJA do starej usługi — ona wysyła, stempluje
    // `potwierdzenie_wyslane_at` I dopisuje wpis do rejestru (patrz Krok 4).
    //
    // ⚠️⚠️ NIE WOLNO TU DOPISAĆ WŁASNEGO `zapiszWiadomosc`. Rejestr wypełnia TA JEDNA
    // usługa, która faktycznie wysyła — zapis w obu miejscach dałby DWA wpisy na jednego
    // maila, czyli kartę twierdzącą, że klient dostał potwierdzenie dwa razy. (Do 22.08.2026
    // powodem były DWIE drogi wyjścia — osobna trasa `/potwierdzenie` i sekcja Wiadomości.
    // Tamta trasa zniknęła, ale zasada zostaje: zapisuje ten, kto wysyła.)
    if (temat_id === 'potwierdzenie') {
      // ⚠️ TRZECI STRAŻNIK WSTRZYKNIĘTEJ USŁUGI. `potwierdzenie` ma domyślnie `null`, a ekran
      // wyboru pokazuje ten temat jako dostępny (bariera domeny pyta o zamówienie, nie o to,
      // czy usługa jest podpięta) — bez tego wiersza klik kończył się `TypeError` w miejsce
      // zdania po polsku.
      if (!potwierdzenie) {
        const blad = bladOperatora('Panel nie ma usługi potwierdzeń — tego maila nie ma czym wysłać.');
        odnotujNieudaneZlozenie(blad);
        throw blad;
      }
      const wynik = await potwierdzenie.wyslij(id, { ktoKlikal });
      return { do: wynik.do, temat: wynik.temat, kiedy: wynik.kiedy ?? teraz() };
    }

    let w;
    try {
      w = await zloz(id, temat_id);
    } catch (blad) {
      // ⚠️⚠️ NAZWA ZMIENNEJ INNA NIŻ W `catch` NIŻEJ I TO NIE JEST PRZYPADEK. Mutacja
      // „połkniący throw" (scripts/mutacje-wiadomosci.mjs) szuka w tym pliku JEDNEJ linii
      // z rzuceniem wyjątku o nazwie „e" i podmienia PIERWSZE jej wystąpienie. Drugie takie
      // samo zdanie tutaj przestawiłoby mutację na niewłaściwą linię, a mutacja mierząca nie
      // to, co opisuje, jest gorsza niż jej brak — skrypt wykrywa BRAK wzorca, ale nie
      // wykryje trafienia w niewłaściwe miejsce.
      //
      // ⚠️ Z TEGO SAMEGO POWODU ten komentarz nie cytuje tamtej linii dosłownie: cytat
      // (z wcięciem i średnikiem) sam stałby się pierwszym wystąpieniem wzorca i mutacja
      // zakomentowałaby KOMENTARZ. Sprawdzone — dokładnie tak przeżyła raz, 22.08.2026.
      odnotujNieudaneZlozenie(blad);
      throw blad;
    }

    try {
      await mailer.sendMail({
        to: w.do, subject: w.temat, text: w.tekst, html: w.html,
        attachments: w.zalaczniki.length ? w.zalaczniki : undefined,
      });
    } catch (e) {
      // ⚠️⚠️ NIEUDANA WYSYŁKA NIE MA PRAWA ZOSTAWIĆ ŚLADU „wysłano". Odwrotna kolejność
      // (zapisz, potem wyślij) dawałaby kartę twierdzącą, że klient dostał maila, którego
      // nigdy nie było.
      dopiszLog(db, id, {
        akcja: 'wiadomosc.blad',
        wynik: `BŁĄD wysyłki „${NAZWA_TEMATU[temat_id]}" do ${w.do} (${ktoKlikal}): ${e.message}`,
      });
      throw e;
    }

    const kiedy = teraz();
    zapiszWiadomosc(db, {
      zamowienieId: id, temat_id, adresat: w.do, temat: w.temat,
      zalacznik: w.zalaczniki[0]?.filename ?? null, kto: ktoKlikal, at: kiedy,
    });
    dopiszLog(db, id, {
      akcja: 'wiadomosc.wyslana',
      // Adresat, temat i załącznik TAK, treść NIE — log karty czyta się na głos przy reklamacji.
      wynik: `DECYZJA CZŁOWIEKA (${ktoKlikal}): „${NAZWA_TEMATU[temat_id]}" wysłane na ${w.do}`
        + (w.zalaczniki[0] ? ` z załącznikiem ${w.zalaczniki[0].filename}` : ' bez załącznika') + '.',
    });
    return { do: w.do, temat: w.temat, kiedy };
  }

  // ⚠️ `ostatnia` ZDJĘTE Z TEJ LISTY (22.08.2026, sprzątanie po recenzji całości gałęzi).
  // Jedyny czytelnik — sekcja „Wiadomości" na karcie — pytał o to CZTERY RAZY na render
  // (raz na temat), a odpowiedź stoi w liście wysłanych, którą trasa i tak pobiera. Liczy ją
  // teraz `ostatnieWgTematow` (domain/wiadomosci.js), jednym przebiegiem i jedną regułą.
  return { kontekst, podglad, wyslij };
}
