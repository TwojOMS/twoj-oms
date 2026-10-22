// PRZ-108.10 — NIP i BDO firmy z Ustawień: wiersze „nip_firmy” i „bdo_firmy” w tabeli konfiguracja_integracji (migracja
// rdzenia 6, bez nowej migracji). Jawne ustawienia, puste sekrety — NIP i BDO stoją na każdym dokumencie.
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji }
  from './konfiguracja-integracji.js';
import { KLUCZ_NIP_FIRMY, KLUCZ_BDO_FIRMY, rozstrzygnijNipBdoFirmy } from '../../domena/nip-bdo-firmy.js';

export const wczytajZapisNipuFirmy = (db) => wczytajKonfiguracjeIntegracji(db, KLUCZ_NIP_FIRMY);
export const wczytajZapisBdoFirmy = (db) => wczytajKonfiguracjeIntegracji(db, KLUCZ_BDO_FIRMY);

export function zapiszNipFirmy(db, nip, { konto = null, teraz = new Date() } = {}) {
  zapiszKonfiguracjeIntegracji(db, KLUCZ_NIP_FIRMY, { ustawienia: { nip }, sekrety: {} }, { konto, teraz });
}

export function zapiszBdoFirmy(db, bdo, { konto = null, teraz = new Date() } = {}) {
  zapiszKonfiguracjeIntegracji(db, KLUCZ_BDO_FIRMY, { ustawienia: { bdo }, sekrety: {} }, { konto, teraz });
}

export const usunBdoFirmy = (db) => usunKonfiguracjeIntegracji(db, KLUCZ_BDO_FIRMY);

/**
 * Źródło NIP-u i BDO firmy: `biezacy()` czyta przy KAŻDYM wywołaniu — zapis na ekranie działa od następnego dokumentu,
 * faktury WDT, zapytania VIES i przebiegu KSeF, bez restartu. Pole stojące w pliku nie jest czytane z bazy.
 * Bez stanu — każdy moduł może mieć własną instancję (ta sama odpowiedź).
 * @param {{ db: import('node:sqlite').DatabaseSync, zPliku: { nip?: string|null, bdo?: string|null } }} o
 *   — `zPliku` z wczytajSprzedawce(env) (NIP znormalizowany i sprawdzony przy starcie)
 */
export function zrodloNipuIBdoFirmy({ db, zPliku }) {
  const plik = { nip: zPliku?.nip || null, bdo: zPliku?.bdo || null };
  const biezacy = () => rozstrzygnijNipBdoFirmy({ zPliku: plik,
    zapisNip: () => wczytajZapisNipuFirmy(db), zapisBdo: () => wczytajZapisBdoFirmy(db) });
  return { nipWPliku: Boolean(plik.nip), bdoWPliku: Boolean(plik.bdo), zPliku: plik, biezacy };
}
