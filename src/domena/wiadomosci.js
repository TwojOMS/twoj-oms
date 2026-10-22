import { adresatKlienta } from './adresat-klienta.js';
import { czyWolnoWyslacPotwierdzenie } from './potwierdzenie-zamowienia.js';
import { saldoWplat } from './platnosci.js';
import { czyPobranie } from './wysylka.js';
import { terminZamowienia } from './blok-platnosci.js';
import { zlotowki } from './kwoty.js';
import { fmtDataCzasKrotko } from './format-daty.js';
import { powodBrakuPaczki, numeryPaczek } from './wiadomosc-wyslane.js';

// TEMATY WIADOMOŚCI DO KLIENTA — jedyne miejsce rozstrzygające „czy wolno wysłać" (22.08.2026).
//
// ⚠️ ODMOWA MA MIEĆ POWÓD, nie być samym brakiem przycisku (niezmiennik 4.9 przewodnika OMS).
// Brak przycisku bez wyjaśnienia jest stanem, z którego operator sam nie wychodzi: albo
// grzebie w bazie, albo wysyła maila ręcznie poza panelem — i panel przestaje o nim wiedzieć.
//
// ⚠️ WIDOK, TRASA I USŁUGA PYTAJĄ TĘ SAMĄ FUNKCJĘ. Druga kopia warunku po stronie widoku
// znaczyłaby przycisk, który się pokazuje, a po kliknięciu odmawia — albo, groźniej, odwrotnie.

// PRZ-102.21: `wyslane` — „Zamówienie wysłane", ręcznie z karty; PRZ-108.08: także regułą z Ustawienia → Automatyzacje.
export const TEMATY = Object.freeze(['potwierdzenie', 'proforma', 'faktura', 'przypomnienie', 'wyslane']);

export const NAZWA_TEMATU = Object.freeze({
  potwierdzenie: 'Potwierdzenie przyjęcia zamówienia',
  proforma: 'Proforma',
  faktura: 'Faktura',
  przypomnienie: 'Przypomnienie o płatności',
  wyslane: 'Zamówienie wysłane',
});

const odmowa = (powod) => ({ wolno: false, powod });

// ⚠️ ZAMROŻONE (recenzja 22.08.2026): to jeden, WSPÓLNY obiekt zwracany przez referencję
// trzem konsumentom (widok, trasa podglądu, usługa wysyłki). Bez `Object.freeze` jedno
// przypadkowe `zg.powod = …` u któregoś z nich zatruwałoby odpowiedź dla wszystkich
// pozostałych — a taki błąd nie krzyczy, tylko cicho psuje kolejne odczyty w tym samym procesie.
const zgoda = Object.freeze({ wolno: true, powod: null });

// ⚠️ `zlotowki` IMPORTOWANE Z `kwoty.js`, NIE PRZEPISANE TUTAJ (poprawka 22.08.2026,
// recenzja Zadania 6). Trzecia prywatna kopia tej samej funkcji — po jednej usuniętej
// wcześniej z `potwierdzenie-zamowienia.js` i `blok-platnosci.js` — dokładnie to, przed
// czym ostrzega komentarz w `kwoty.js`. Kanoniczna wersja ma dodatkowo strażnik pustki
// (`'' → '—'`, nie `' zł'` bez liczby) — patrz `stanTematu` niżej, które teraz go dziedziczy.

/**
 * Czy wolno wysłać dany temat — i dlaczego nie, gdy nie wolno.
 *
 * `kontekst`: `{ proforma, faktura, dzis }` — aktualna proforma (wiersz z bazy albo `null`),
 * faktura zamówienia (`z.faktura` albo `null`), dzień odniesienia.
 *
 * ⚠️ WARUNKI WSPÓLNE IDĄ PIERWSZE i dotyczą wszystkich tematów. „Anulowane" bije
 * wszystko: potwierdzenie przyjęcia zamówienia, którego nie ma, proforma do niego, faktura
 * i przypomnienie o zapłacie za nie — każdy z tych maili byłby wtedy nieprawdą.
 */
export function czyWolnoWyslac(z, temat_id, kontekst = {}) {
  if (!TEMATY.includes(temat_id)) return odmowa('Nie ma takiego tematu wiadomości.');
  if (z?.anulowane) return odmowa('Zamówienie jest anulowane — wiadomości do klienta nie wysyłamy.');
  if (!adresatKlienta(z)) {
    return odmowa('To zamówienie nie ma adresu e-mail. Dopisz go w danych do wysyłki albo w danych do faktury.');
  }

  if (temat_id === 'potwierdzenie') {
    // ⚠️ DELEGACJA, NIE KOPIA: potwierdzenie ma własną, starszą regułę (m.in. „bez pozycji
    // nie ma czego potwierdzać") i to ona ma dalej rozstrzygać. Przepisanie jej tutaj
    // dałoby dwie reguły na jeden mail, rozjeżdżające się przy pierwszej poprawce.
    return czyWolnoWyslacPotwierdzenie(z);
  }

  if (temat_id === 'proforma') {
    if (!kontekst.proforma) {
      return odmowa('To zamówienie nie ma aktualnej proformy. Najpierw wystaw proformę — sekcja Faktura wyżej.');
    }
    // ⚠️ UNIEWAŻNIONA NIE MA PRAWA WYJŚĆ (recenzja 22.08.2026, proforma-stan.js:33-34):
    // klient dostałby mailem dokument na STARĄ kwotę i przelałby według niej. Bramka ma się
    // bronić SAMA — dziś chroni nas to, że wołający podaje `kontekst.proforma` przez
    // `aktualnaProforma` (która unieważnione odsiewa), ale to jest jedyne miejsce
    // rozstrzygające „czy wolno wysłać" i nie ma prawa polegać na tym, że każdy przyszły
    // wołający zrobi to samo.
    if (kontekst.proforma.uniewazniona_at) {
      return odmowa(`Proforma ${kontekst.proforma.numer} została unieważniona — wystaw nową i wyślij ją.`);
    }
    if (!kontekst.proforma.plik_sciezka) {
      return odmowa(`Proforma ${kontekst.proforma.numer} nie ma zapisanego pliku — wystaw ją jeszcze raz.`);
    }
    return zgoda;
  }

  if (temat_id === 'faktura') {
    if (!kontekst.faktura) {
      return odmowa('To zamówienie nie ma faktury. Najpierw wystaw fakturę — sekcja Faktura wyżej.');
    }
    // ⚠️ NUMER WYMAGANY OBOK infakt_uuid (recenzja 22.08.2026, ta sama reguła co
    // allegro-faktura.js:42): bez numeru klient nie połączy dokumentu z naszą księgowością,
    // a `stanTematu` napisałby „bez numeru · PDF z inFaktu" — mail, który nie umie się
    // nazwać, jest gorszy niż brak przycisku.
    if (!kontekst.faktura.infakt_uuid || !kontekst.faktura.numer) {
      return odmowa('Faktura nie została do końca wystawiona w inFakcie — PDF-u nie ma jeszcze skąd pobrać.');
    }
    return zgoda;
  }

  if (temat_id === 'przypomnienie') {
    // ⚠️ Sędzią jest SALDO WPŁAT, nie kolumna `oplacone_at`: zamówienie z wpłatą częściową ma
    // `oplacone_at` puste, a przypomnieć trzeba o RESZCIE — i taką kwotę mail pokaże.
    if (czyPobranie(z)) {
      return odmowa('To zamówienie jest za pobraniem — pieniądze inkasuje kurier przy doręczeniu.');
    }
    const saldo = saldoWplat(z);
    if (saldo.stan === 'blad') return odmowa(`Nie da się policzyć, ile brakuje: ${saldo.blad}`);
    if (saldo.stan !== 'niedoplata') return odmowa('Zamówienie jest opłacone — nie ma o czym przypominać.');
    return zgoda;
  }

  if (temat_id === 'wyslane') {
    // Mail twierdzi „zostało wysłane" i podaje numer listu — bez paczki z numerem byłby nieprawdą.
    const powod = powodBrakuPaczki(z);
    return powod ? odmowa(powod) : zgoda;
  }

  // ⚠️ WARTOWNIK, NIE MARTWY KOD (recenzja 22.08.2026). `TEMATY.includes` na samej górze
  // funkcji już odrzuca każdy temat spoza czwórki — ale PRZYPOMNIENIE do dziś było wyjściem
  // DOMYŚLNYM funkcji, nie jawnym warunkiem. Piąty temat dopisany kiedyś do `TEMATY` bez
  // własnej gałęzi tutaj odziedziczyłby po cichu regułę przypomnienia i wyszedłby na świat
  // z `wolno: true`, choć nikt go dla niego nie napisał. Ten sam błąd naprawiono już
  // w sąsiednim module (`wiadomosc-platnicza.js:75-82`) — tam RZUCA, tu ODMAWIA, bo to
  // funkcja pytana o zgodę, nie składająca treść.
  return odmowa('Nie ma takiego tematu wiadomości.');
}

/**
 * Czy wolno wysłać SZABLON WŁASNY (PRZ-101.03) — jedyny warunek: jest adres e-mail.
 *
 * ⚠️ ANULOWANE NIE BLOKUJE, i to świadomie: szablon własny pisze operator i bywa nim właśnie „Anulowanie
 * zamówienia" albo „Brak towaru". Zakaz z `czyWolnoWyslac` chroni cztery maile, których treść twierdzi coś
 * o zamówieniu (przyjęte, do zapłaty) — szablon własny twierdzi to, co napisał człowiek, a podgląd przed wysyłką
 * zostaje.
 */
export function czyWolnoWyslacWlasny(z) {
  if (!adresatKlienta(z)) {
    return odmowa('To zamówienie nie ma adresu e-mail. Dopisz go w danych do wysyłki albo w danych do faktury.');
  }
  return zgoda;
}

/**
 * Najnowsza wiadomość KAŻDEGO tematu — policzona RAZ, z jednej listy (mapa `temat_id` → wiersz).
 *
 * ⚠️⚠️ ROZSTRZYGA NAJWIĘKSZE `id`, A NIE KOLEJNOŚĆ W LIŚCIE (sprzątanie po recenzji całości
 * gałęzi, 22.08.2026). Do tej daty odpowiedź na to samo pytanie liczyły DWA miejsca: trasa
 * (zapytaniem `ORDER BY id DESC LIMIT 1` na temat) i widok karty (`…filter(…).pop()` po
 * liście wysłanych). Dawały ten sam wynik WYŁĄCZNIE dlatego, że lista jest posortowana
 * rosnąco — przestawienie jej na „najnowsze u góry" (naturalne przy dłuższej historii)
 * przesunęłoby po cichu ostrzeżenie „Ta wiadomość poszła już…" i etykietę „Wyślij ponownie"
 * na NAJSTARSZY wpis. Bez błędu, bez czerwieni w suicie — a jest to jedyny hamulec przed
 * wysłaniem klientowi drugiego maila, którego nie da się cofnąć.
 *
 * ⚠️ WIERSZ BEZ `id` PRZEGRYWA z każdym wierszem rejestru. Taki bywa dokładnie jeden:
 * rezerwa złożona ze starej kolumny `zamowienia.potwierdzenie_wyslane_at` (mail wysłany
 * przed powstaniem rejestru), a rejestr ma nad nią pierwszeństwo.
 */
export function ostatnieWgTematow(lista) {
  const wynik = new Map();
  for (const w of lista ?? []) {
    const dotad = wynik.get(w.temat_id);
    if (!dotad || (w.id ?? -Infinity) > (dotad.id ?? -Infinity)) wynik.set(w.temat_id, w);
  }
  return wynik;
}

/**
 * Zdanie przy temacie na ekranie wyboru — stan, nie instrukcja.
 *
 * Temat zablokowany oddaje POWÓD odmowy (widok wygasza taki wiersz i nie robi z niego
 * odnośnika). Temat dostępny mówi to, co operator musi wiedzieć PRZED kliknięciem:
 * co pojedzie w załączniku, na jaką kwotę i ile zostało do terminu.
 */
export function stanTematu(z, temat_id, kontekst = {}) {
  const zg = czyWolnoWyslac(z, temat_id, kontekst);
  if (!zg.wolno) return zg.powod;

  // ⚠️ `fmtDataCzasKrotko`, NIE WŁASNE CIĘCIE NAPISU (recenzja 22.08.2026). `wyslana_at`
  // zapisujemy jako `new Date().toISOString()` w kontenerze z TZ=UTC — samo `slice(0, 16)`
  // obcina strefę BEZ przeliczenia i pokazuje operatorowi czas o 2 godziny wcześniejszy
  // (latem) niż naprawdę. Reszta karty czyta znaczniki przez ten sam formater (precedens
  // importu `format-daty` w module domenowym: `potwierdzenie-zamowienia.js:8`) — druga skala
  // czasu w tym samym wierszu zachęcałaby operatora do wysłania maila drugi raz.
  const ostatnio = kontekst.ostatnia?.wyslana_at
    ? `wysłane ${fmtDataCzasKrotko(kontekst.ostatnia.wyslana_at)} — pójdzie ponownie`
    : null;

  if (temat_id === 'potwierdzenie') return ostatnio ?? 'jeszcze nie wysłane';

  if (temat_id === 'proforma') {
    const p = kontekst.proforma;
    return [`${p.numer} na ${zlotowki(p.kwota_brutto)} · PDF w załączniku`, ostatnio].filter(Boolean).join(' · ');
  }

  if (temat_id === 'faktura') {
    // ⚠️ BEZ REZERWY `?? 'bez numeru'` — I TO NIE JEST PRZEOCZENIE (sprzątanie po recenzji
    // całości gałęzi, 22.08.2026). Ten stan jest NIEOSIĄGALNY: `czyWolnoWyslac` kilkadziesiąt
    // linii wyżej odmawia przy pustym `kontekst.faktura.numer`, a `stanTematu` wraca powodem
    // odmowy, zanim tu dojdzie. Rezerwa opisywała więc stan, którego nie da się wywołać —
    // i zarazem zapowiadała operatorowi maila „bez numeru", którego wysłać nie wolno. Gdyby
    // kiedyś zniknął tamten strażnik, ma tu wyjść puste miejsce w napisie, a nie cicha
    // podmiana na zdanie brzmiące jak stan dopuszczalny.
    return [`${kontekst.faktura.numer} · PDF z inFaktu`, ostatnio].filter(Boolean).join(' · ');
  }

  if (temat_id === 'wyslane') return [numeryPaczek(z), ostatnio].filter(Boolean).join(' · ');

  const saldo = saldoWplat(z);
  const termin = terminZamowienia(z, kontekst.dzis);
  const oTerminie = termin?.data
    ? (termin.minal ? `termin minął ${termin.data}` : `termin mija ${termin.data}`)
    : null;
  return [`brakuje ${zlotowki(saldo.roznicaZl)}`, oTerminie, ostatnio].filter(Boolean).join(' — ');
}
