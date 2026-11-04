// PRZ-135.T2 — umowa firmy z kurierem na przesyłki za pobraniem (dziś: InPost).
// Tabela `ustawienia` (jak faktury-dla-kazdego.js), klucz `wysylka.umowa_pobrania.<kurier>`,
// wartości `tak`/`nie`. Bez migracji i bez pamięci podręcznej. Brak wiersza = wyłączone.
//
// ⚠️ PIENIĄDZE: włączenie sprawia, że reguły (kurierzyDoWyboru, metodaNadania, podzielDoNadania)
// dopuszczają paczkomat przy pobraniu na paczce nr 1. Awansować wolno WYŁĄCZNIE kuriera, którego
// adapter umie wysłać kwotę (`pobranie: 'adapter'` w rejestrze) — 'brak' nie umie, a 'umowa'
// ma pobranie na stałe. Rejestr kurierów się tu NIE zmienia; wynik idzie do reguł parametrem.
import { MODULY_KURIEROW } from '../../../domena/moduly-kurierow.ts';

const PREFIKS = 'wysylka.umowa_pobrania.';

const kurierzyZAdapterem = () => Object.values(MODULY_KURIEROW)
  .filter((opis) => opis.umiejetnosci.pobranie === 'adapter')
  .map((opis) => opis.klucz);

/** Klucze kurierów z `pobranie: 'adapter'` i ustawieniem `tak`. Brak bazy albo błąd odczytu = []. */
export function umowyPobraniaFirmy(db) {
  if (!db) return [];
  try {
    const odczyt = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?');
    return kurierzyZAdapterem().filter((klucz) => odczyt.get(`${PREFIKS}${klucz}`)?.wartosc === 'tak');
  } catch {
    return [];
  }
}

/** Upsert `tak`/`nie` (`tak` tylko przy `wlaczone === true` — napis z formularza nie włącza); klucz spoza kurierów z `pobranie: 'adapter'` jest odrzucany wyjątkiem. */
export function zapiszUmowePobrania(db, klucz, wlaczone) {
  if (typeof klucz !== 'string' || !kurierzyZAdapterem().includes(klucz)) {
    throw new Error(`Umowy na pobranie nie ustawia się dla kuriera „${String(klucz)}”.`);
  }
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(`${PREFIKS}${klucz}`, wlaczone === true ? 'tak' : 'nie', new Date().toISOString());
}
