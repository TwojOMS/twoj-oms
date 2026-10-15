// Odroczenie kolejnej próby wydruku po nieudanej próbie (kolumna
// `kolejka_druku.nastepna_proba_at`, patrz db/kolejka-druku.js).
//
// Czuwacz (deploy/drukarka/czuwacz-etykiet.ps1) odpytuje panel o etykiety CO 5 SEKUND.
// Bez odroczenia pozycja, której nie da się wydrukować (drukarka zgaszona, otwarta głowica,
// zacięty papier), wracałaby do kolejki NATYCHMIAST i była próbowana w kółko przy każdym
// cyklu, dopisując wpis do logu za każdym razem — w tej infrastrukturze pełny dysk już RAZ
// położył usługę (AdGuard, notatka z 2026-07-19), więc kolejka druku nie może powtórzyć
// tego błędu.
//
// Rośnie WYKŁADNICZO: pierwsza awaria może być przypadkowa (chwila nieuwagi operatora przy
// drukarce), więc odroczenie jest krótkie; kolejne — coraz dłuższe, bo powtarzająca się
// awaria coraz mniej przypomina przypadek.
//
// Sufit 15 minut jest TWARDY i CELOWY, nie tylko „w praktyce nie urośnie wyżej": awaria
// PRZEMIJAJĄCA (zgaszony komputer produkcyjny na noc, otwarta głowica na chwilę) ma się
// SAMA naprawić, gdy sprzęt wróci — panelowi nie wolno poddać się na stałe i odsunąć
// kolejną próbę o godziny, bo wtedy etykieta czekałaby na wydruk dłużej, niż trwa awaria.
export const SUFIT_ODROCZENIA_MS = 15 * 60 * 1000;

// Punkt startowy wykładniczego wzrostu. 15 sekund przy pierwszej awarii jest krótsze niż
// jeden cykl odpytywania czuwacza (5 s) razy trzy — pierwsza nieudana próba nie ma prawa
// czuć się jak długie oczekiwanie, dopiero powtarzające się awarie mają.
const BAZA_ODROCZENIA_MS = 15 * 1000;

/**
 * Odroczenie (w milisekundach) do następnej próby wydruku po `proby` nieudanych próbach
 * pod rząd. `proby` to wartość PO doliczeniu bieżącej awarii (patrz oznaczBladDruku
 * w db/kolejka-druku.js) — pierwsza awaria wywołuje to z `proby = 1`.
 */
export function odroczenieMs(proby) {
  const wykladnik = Math.max(0, Number(proby) - 1);
  const wykladnicze = BAZA_ODROCZENIA_MS * 2 ** wykladnik;
  return Math.min(wykladnicze, SUFIT_ODROCZENIA_MS);
}
