import { wyczyscBladStatusuBezSledzenia, wyczyscBladStatusu } from './db/przesylki.js';
import { sledzeniePrzesylki } from '../../domena/sledzenie-przesylki.js';

// Idempotentne porządkowanie osadu przy starcie — zamrożony bootstrap 5b9cd765.
// Paczek WZA nie czyścimy hurtowo, gdy istnieje któraś rzeczywista droga śledzenia.
export function sprzatnijOsadStatusu(db, kurierzy, log) {
  // PRZ-092: DPD bez kanału DPD Info (`bezSledzenia`) nie jest drogą śledzenia paczek WzA.
  const dpdSledzi = Boolean(kurierzy.dpd && !kurierzy.dpd.bezSledzenia);
  const bezSledzenia = Object.entries(kurierzy)
    .filter(([nazwa, k]) => k?.bezSledzenia && !(nazwa === 'allegro_wza' && (dpdSledzi || kurierzy.allegro)))
    .map(([nazwa]) => nazwa);
  const posprzatane = wyczyscBladStatusuBezSledzenia(db, bezSledzenia);
  if (posprzatane) log(`status kuriera: skasowano ${posprzatane} niepotrzebnych bledow `
    + `u kurierow bez sledzenia (${bezSledzenia.join(', ')}).`);
  if (kurierzy.allegro_wza && (dpdSledzi || kurierzy.allegro)) {
    const zOsadem = db.prepare(
      "SELECT * FROM przesylki WHERE kurier = 'allegro_wza' AND status_kuriera_blad IS NOT NULL",
    ).all().filter((p) => !sledzeniePrzesylki(p, kurierzy));
    for (const p of zOsadem) wyczyscBladStatusu(db, p.id);
    if (zOsadem.length) log(`status kuriera: skasowano ${zOsadem.length} niepotrzebnych bledow `
      + 'paczek WzA bez dostepnego sledzenia.');
  }
}
