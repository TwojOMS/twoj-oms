import type { Srodowisko } from './kontrakty.ts';
import { poprawnyNip, poprawnyRachunek } from './walidatory.ts';

export type DaneSprzedawcy = { nip: string; rachunek: string; bdo: string | null; bank: string | null };

const oczysc = (v: string) => v.replace(/^PL/i, '').replace(/[\s-]/g, '');

/** Dane sprzedawcy wyłącznie z konfiguracji; brak blokuje start. */
export function wczytajSprzedawce(env: Srodowisko): DaneSprzedawcy {
  const bledy: string[] = [];
  const nipSurowy = env.OMS_SPRZEDAWCA_NIP?.trim() ?? '';
  const rachSurowy = env.OMS_RACHUNEK?.trim() ?? '';
  const nip = oczysc(nipSurowy);
  const rachunek = oczysc(rachSurowy);
  if (!nipSurowy) bledy.push(BRAK_NIP);
  else if (!poprawnyNip(nip)) bledy.push(/^\d{10}$/.test(nip) ? NIP_SUMA : NIP_FORMAT);
  if (!rachSurowy) bledy.push(BRAK_RACHUNKU);
  else if (!poprawnyRachunek(rachunek)) bledy.push(/^\d{26}$/.test(rachunek) ? RACHUNEK_SUMA : RACHUNEK_FORMAT);
  const bdo = env.OMS_SPRZEDAWCA_BDO?.trim() || null;
  if (bdo && !/^\d{9}$/.test(bdo)) bledy.push(BDO_FORMAT);
  if (bledy.length) throw new Error([...bledy, GDZIE_POPRAWIC].join('\n'));
  return { nip, rachunek, bdo, bank: env.OMS_BANK?.trim() || null };
}

// Treści komunikatów startu. Stoją pod funkcją, żeby numery linii odczytów zmiennych (docs/konfiguracja.json) się nie
// przesunęły; funkcja woła je dopiero po załadowaniu modułu. Opisują dokładnie to, co `wczytajSprzedawce` przyjmuje:
// NIP i rachunek — po zdjęciu przedrostka PL, spacji i myślników same cyfry; BDO — 9 cyfr bez żadnego czyszczenia.
// Żaden komunikat nie zawiera wpisanej wartości.
const DOZWOLONE = 'przedrostek PL, spacje i myślniki są dozwolone i pomijane';
const BRAK_NIP = 'Brak wymaganej zmiennej: OMS_SPRZEDAWCA_NIP — wpisz NIP firmy sprzedawcy: 10 cyfr (' + DOZWOLONE + ')';
const NIP_FORMAT = 'OMS_SPRZEDAWCA_NIP: niepoprawny NIP — ' + DOZWOLONE + ', ale reszta musi mieć dokładnie 10 cyfr, bez liter i innych znaków';
const NIP_SUMA = 'OMS_SPRZEDAWCA_NIP: niepoprawny NIP — to 10 cyfr, ale nie zgadza się cyfra kontrolna; sprawdź, czy w numerze nie ma literówki';
const BRAK_RACHUNKU = 'Brak wymaganej zmiennej: OMS_RACHUNEK — wpisz numer rachunku firmy w formacie NRB: 26 cyfr (' + DOZWOLONE + ')';
const RACHUNEK_FORMAT = 'OMS_RACHUNEK: niepoprawny numer rachunku — ' + DOZWOLONE + ', ale reszta musi mieć dokładnie 26 cyfr (NRB), bez liter i innych znaków';
const RACHUNEK_SUMA = 'OMS_RACHUNEK: niepoprawny numer rachunku — to 26 cyfr, ale nie zgadzają się cyfry kontrolne; sprawdź, czy w numerze nie ma literówki';
const BDO_FORMAT = 'OMS_SPRZEDAWCA_BDO: oczekiwano 9 cyfr bez spacji i myślników (numer rejestrowy BDO); jeśli firma nie ma numeru BDO, zostaw zmienną pustą albo usuń jej linię';
const GDZIE_POPRAWIC = 'Popraw w pliku konfiguracji OMS i uruchom OMS od nowa: w instalacji Dockerowej to /opt/oms/config/produkcja.env przy przejściu na pracę, później /opt/oms/config/oms.env (docs/instalacja-docker.md, sekcje 8 i 9); bez Dockera — plik .env.';
