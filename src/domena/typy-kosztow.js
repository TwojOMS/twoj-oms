// ⚠️ JEDNA LISTA TYPOW KOSZTU NA CALY PANEL — 'zmienny' | 'staly' | 'drobne'.
//
// Ta sama lista stoi w trzech miejscach obiegu: w `CHECK`-u tabel kategorii i slownika firm
// (schema.sql) oraz w bramce formularza kategorii (web/routes/koszty.js). Dwie kopie tej listy
// w kodzie rozjechalyby sie przy pierwszym dolozeniu typu — a objawem byloby okno, w ktorym
// typ przechodzi przez formularz i odbija sie od bazy surowym „CHECK constraint failed".
//
// ⚠️ Formularz kosztu SPOZA KSeF o typ nie pyta i pytac nie ma (4.36, uproszczenie do trzech
// pol): typ niesie kategoria, a kategorie niesie wybrana firma (db/firmy-reczne.js).
//
// ⚠️ WARTOSCI SA MASZYNOWE I DLATEGO BEZ DIAKRYTYKOW ('staly', nie 'stały'): gdyby ten sam
// typ trafial do bazy w dwoch zapisach, rozpadlby sie na DWIE grupy przy liczeniu progu
// rentownosci — po cichu, bo obie wygladaja poprawnie na ekranie. Napis dla czlowieka
// („stały") powstaje dopiero w widoku.
export const TYPY_KOSZTU = ['zmienny', 'staly', 'drobne'];
