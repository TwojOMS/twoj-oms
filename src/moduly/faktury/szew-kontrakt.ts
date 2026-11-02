// PRZ-122.ZGODA-TFc: kontrakt szwu TwojeFaktury (plik WSPÓLNY — zostaje w kopii bez modułu TwojeFaktury).
// Cały kod TF wchodzi do OMS-u jednym plikiem rejestracji `szew-twojefaktury.ts`, ładowanym w `wczytaj-szew.ts`.
// Brak szwu = `null`: moduł faktur składa się bez programu wbudowanego, tras, migracji i usług TF.
// Nowe trasy i usługi TF rejestruje się WYŁĄCZNIE w szwie (plan PRZ-122, ZGODA-TF decyzja 4).
import type { ModulOms } from '../../core/kontrakty.ts';

type Funkcja = (...a: any[]) => any;

export type SzewTwojeFaktury = Readonly<{
  /** Moduł `twojefaktury` (po `faktury` w `src/moduly/lista.ts`): migracje 1–3 schematu `tf_*`, nic poza tym. */
  modul: ModulOms;
  /** Para `OMS_PROBA_KSEF_TEST_*` — wartości czyta `wczytajFaktury`, szew tylko je sprawdza. */
  wczytajKsefTestProby: Funkcja;
  /** Źródło KSeF sprzedaży i połączenie wysyłki (`{ ksefSprzedazy, polaczenieKsef, atrapaWysylki }`). */
  zlozKsef: Funkcja;
  programTwojeFaktury: Funkcja;
  edycjaTwojeFaktury: Funkcja;
  createRozstrzyganieKsef: Funkcja;
  createAutomatKsefWbudowany: Funkcja;
  /** Funkcje TF dla plików wspólnych (automat KSeF, koszty, zamówienia, reset demo) — zawsze z bezpiecznym brakiem. */
  wpisTwojeFaktury: object;
  plikiKsefDokumentu: Funkcja;
  niepewneKsefPonadDobe: Funkcja;
  nastepnyNumerDemo: Funkcja;
  /** Trasy TF: ekran faktury i serie (tylko przy programie wbudowanym), Wysyłka do KSeF (zawsze, gdy jest szew). */
  zarejestrujTrasy: (app: any, o: { db: any, teraz: () => Date, edycja: any, sprzedawca: Funkcja, ksefSprzedazy: any }) => void;
}>;
