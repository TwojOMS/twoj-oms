// PRZ-083: proces potomny panelu demo — następna baza na DEMO_DZIS w katalogu `nastepna/` obok OMS_DB_PATH.
// Uruchamia go wyłącznie baza.mjs (przygotujWTle). Kod wyjścia 0 = gotowa.json zapisany.
import fs from 'node:fs';
import { przygotujNastepna } from './baza.mjs';

try {
  const baza = process.env.OMS_DB_PATH;
  const dzis = process.env.DEMO_DZIS;
  if (!baza || !/^\d{4}-\d{2}-\d{2}$/.test(dzis ?? '')) throw new Error('nastepna.mjs: wymaga OMS_DB_PATH i DEMO_DZIS (RRRR-MM-DD)');
  // DEMO_KONTO_ADMINA tylko dla testów; w kontenerze montowany plik.
  const kontoAdmina = JSON.parse(fs.readFileSync(process.env.DEMO_KONTO_ADMINA || '/konfiguracja/konto.json', 'utf8'));
  const t0 = Date.now();
  const wynik = await przygotujNastepna({ baza, dzis, env: process.env, kontoAdmina });
  // Szczyt pamięci procesu potomnego: chodzi obok panelu w limicie kontenera 512 MB (compose.yaml).
  const mb = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(`demo: następna baza na ${dzis} gotowa w ${Date.now() - t0} ms — ${wynik.zamowienia} zamówień, szczyt pamięci ${mb} MB`);
} catch (e) {
  console.error(`demo: następna baza nie powstała — ${e?.stack ?? e}`);
  process.exitCode = 1;
}
