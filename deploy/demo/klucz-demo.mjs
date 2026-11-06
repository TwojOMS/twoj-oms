// PRZ-153.E9: publiczny klucz API demo (demo.twojoms.pl) — wyłącznie zakresy odczytu.
// Jawny z założenia, jak konto gościa demo/demo (GOSC w konfiguracja.mjs): stoi w docs/api/README.md, żeby każdy
// mógł wywołać API na zmyślonych danych „Pracowni Półcień”. Nie jest sekretem i nie otwiera żadnego zapisu.
// Baza demo powstaje od nowa co godzinę, więc klucz wstawia zalozBazeDemo (baza.mjs) przy każdej budowie bazy.
import { ZAKRESY_API, skrotKlucza } from '../../src/domena/klucze-api.js';

export const KLUCZ_DEMO = Object.freeze({
  nazwa: 'Klucz publiczny demo (tylko odczyt)',
  prefiks: 'demodemo',
  klucz: 'toms_demodemo_tylko-odczyt_demo-twojoms_Pracownia-Polcien',
  // Tylko `*:odczyt`. Bez `druk` (kolejki druku zapisują „wydrukowano”) i bez żadnego `*:zapis`.
  zakresy: Object.freeze(ZAKRESY_API.filter((zakres) => zakres.endsWith(':odczyt'))),
});

/** Wstawia klucz demo do świeżej bazy demo (tabela `klucze_api` z migracji 0010). */
export function zalozKluczDemo(db, { teraz = new Date() } = {}) {
  db.prepare(`INSERT INTO klucze_api (nazwa, prefiks, skrot, zakresy, utworzyl_konto_id, utworzony_at, wygasa_at)
    VALUES (?, ?, ?, ?, NULL, ?, NULL)`).run(KLUCZ_DEMO.nazwa, KLUCZ_DEMO.prefiks, skrotKlucza(KLUCZ_DEMO.klucz),
    JSON.stringify(KLUCZ_DEMO.zakresy), teraz.toISOString());
}
