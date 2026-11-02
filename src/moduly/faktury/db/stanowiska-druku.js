// PRZ-126.C05a: zgłoszenia komputerów z drukarką faktur — bez migracji, w tabeli `ustawienia` (jak ksef-konsumenckie.js).
// Wartość: JSON { "<stanowisko>": "<ISO>" }, najwyżej 20 wpisów; reguły w src/domena/druk-faktur.js.
import { czyZapisac, dopisz } from '../../../domena/druk-faktur.js';

const KLUCZ = 'druk.faktury.stanowiska';

export function zgloszenia(db) {
  const wartosc = db?.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc;
  if (!wartosc) return {};
  try {
    const mapa = JSON.parse(wartosc);
    return mapa && typeof mapa === 'object' && !Array.isArray(mapa) ? mapa : {};
  } catch {
    return {};
  }
}

/** Zapisuje zgłoszenie z dławieniem (raz na 60 s na stanowisko). @returns {boolean} czy zapisano */
export function zapiszZgloszenie(db, stanowisko, teraz) {
  const mapa = zgloszenia(db);
  if (!czyZapisac(mapa, stanowisko, teraz)) return false;
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
    .run(KLUCZ, JSON.stringify(dopisz(mapa, stanowisko, teraz)), teraz.toISOString());
  return true;
}
