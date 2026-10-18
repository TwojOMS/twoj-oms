// PRZ-093.08 — adres firmy z Ustawień: wiersz „firma” w tabeli konfiguracja_integracji (migracja rdzenia 6,
// bez nowej migracji). Jawne ustawienia, puste sekrety — adres firmy nie jest poświadczeniem.
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji }
  from './konfiguracja-integracji.js';
import { KLUCZ_ADRESU_FIRMY, rozstrzygnijAdresFirmy } from '../../domena/adres-firmy.js';
import { adresWPliku } from '../../core/adres-firmy.ts';

export const wczytajZapisAdresuFirmy = (db) => wczytajKonfiguracjeIntegracji(db, KLUCZ_ADRESU_FIRMY);

export function zapiszAdresFirmy(db, ustawienia, { konto = null, teraz = new Date() } = {}) {
  zapiszKonfiguracjeIntegracji(db, KLUCZ_ADRESU_FIRMY, { ustawienia, sekrety: {} }, { konto, teraz });
}

export const usunAdresFirmy = (db) => usunKonfiguracjeIntegracji(db, KLUCZ_ADRESU_FIRMY);

/**
 * Źródło adresu firmy dla modułu: `biezacy()` czyta przy KAŻDYM wywołaniu (zmiana na ekranie działa od następnego
 * dokumentu i następnej paczki, bez restartu). Gdy adres stoi w pliku, baza nie jest nawet czytana.
 * @param {{ db: import('node:sqlite').DatabaseSync, zPliku: object }} o — `zPliku` z adresFirmyZEnv(env)
 */
export function zrodloAdresuFirmy({ db, zPliku }) {
  const wPliku = adresWPliku(zPliku);
  const biezacy = () => rozstrzygnijAdresFirmy({ wPliku, zPliku, zapis: () => wczytajZapisAdresuFirmy(db) });
  return { wPliku, zPliku, biezacy, adres: () => biezacy().adres };
}
