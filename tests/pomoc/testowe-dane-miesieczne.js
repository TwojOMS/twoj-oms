import { openOmsDb as otworzProdukcja } from '../../src/oms/db/db.ts';
import { wgrajDaneStartowe as importProdukcja } from '../../src/oms/db/dane-miesieczne.js';
import { kategoriaDlaNip, przypnijKategorie } from '../../src/oms/db/kategorie-kosztow.js';
export * from '../../src/oms/db/dane-miesieczne.js';
// Wiersze frozen są wyłącznie fixture testów. Produkt startuje z pustą tabelą.
const STARTOWE = [
  ['2026-01','1432.08','314.96','127.49','2088.92','0.00','1197.00','6945.93','1677.32','231.10','składniki dają 1874,53 — rozjazd 214,39 do sprawdzenia'],
  ['2026-02','1788.29','330.85','138.47','2257.61','0.00','1228.00','6994.31','1680.14','101.60',null],
  ['2026-03','1788.29','432.54','138.47','2359.30','0.00','2759.00','16419.90','4245.83','162.30','koszty = wydatki 2464,54 + zakup towarów 1781,29 (kol. 12)'],
  ['2026-04','1788.29','432.54','138.47','2359.30','0.00','1549.00','11743.38','5034.71','163.90',null],
  ['2026-05','1788.29','442.83','138.47','2369.59','287.00','2699.00','13994.48','2269.55','358.30',null],
  ['2026-06','1788.29','894.30','138.47','2821.06','779.00','1617.00','11164.67','2881.04','0.00',null],
];
export const wgrajDaneStartowe = db => importProdukcja(db, { nazwaMigracji: 'dane-miesieczne/zus-csv-2026-h1', wiersze: STARTOWE });
export function openOmsDb(...args) {
  const db = otworzProdukcja(...args);
  try {
    wgrajDaneStartowe(db);
    // Frozen rachunek używa jawnej fixture przypisania dostawcy, neutralny produkt jej nie wgrywa.
    if(!kategoriaDlaNip(db,'5252674798'))przypnijKategorie(db,'5252674798','Prowizje sprzedażowe','zmienny');
    return db;
  } catch(e) { db.close(); throw e; }
}
