// PRZ-102.20 — rachunek firmy z Ustawień: wiersz „rachunek_firmy” w tabeli konfiguracja_integracji (migracja rdzenia 6,
// bez nowej migracji). Jawne ustawienia, puste sekrety — rachunek stoi w każdym mailu o płatności.
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji }
  from './konfiguracja-integracji.js';
import { KLUCZ_RACHUNKU_FIRMY, rozstrzygnijRachunekFirmy, rachunekWPliku } from '../../domena/rachunek-firmy.js';

export const wczytajZapisRachunkuFirmy = (db) => wczytajKonfiguracjeIntegracji(db, KLUCZ_RACHUNKU_FIRMY);

export function zapiszRachunekFirmy(db, ustawienia, { konto = null, teraz = new Date() } = {}) {
  zapiszKonfiguracjeIntegracji(db, KLUCZ_RACHUNKU_FIRMY, { ustawienia, sekrety: {} }, { konto, teraz });
}

export const usunRachunekFirmy = (db) => usunKonfiguracjeIntegracji(db, KLUCZ_RACHUNKU_FIRMY);

/**
 * Źródło rachunku firmy (usługa rdzenia `rachunekFirmy`): `biezacy()` czyta przy KAŻDYM wywołaniu — zapis na ekranie
 * działa od następnego maila, proformy i paczki WzA, bez restartu. Gdy rachunek stoi w pliku, baza nie jest czytana.
 * @param {{ db: import('node:sqlite').DatabaseSync, zPliku: { rachunek: string|null, bank: string|null } }} o
 *   — `zPliku` z wczytajSprzedawce(env) (rachunek już znormalizowany i sprawdzony przy starcie)
 */
export function zrodloRachunkuFirmy({ db, zPliku }) {
  const plik = { rachunek: zPliku?.rachunek ?? null, bank: zPliku?.bank ?? null };
  const biezacy = () => rozstrzygnijRachunekFirmy({ zPliku: plik, zapis: () => wczytajZapisRachunkuFirmy(db) });
  return { wPliku: rachunekWPliku(plik), zPliku: plik, biezacy };
}
