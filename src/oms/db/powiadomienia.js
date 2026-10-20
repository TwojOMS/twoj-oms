import { sprawdzUkryteTypy, ukrytePrzezWszystkich } from '../../domena/powiadomienia.js';

const maId = id => Number.isInteger(id) && id > 0;
const kluczKonta = id => `powiadomienia.ukryte.${id}`;

export function ukryteTypyKonta(db, id) {
  if (!maId(id)) return [];
  const zapis = db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(kluczKonta(id));
  if (!zapis) return [];
  // Uszkodzony zapis pokazuje wszystkie ostrzeżenia, zamiast zabierać stronę zamówień.
  try { return sprawdzUkryteTypy(JSON.parse(zapis.wartosc)); } catch { return []; }
}

export function zapiszUkryteTypy(db, id, typy) {
  if (!maId(id)) throw new Error('Konto serwisowe nie ma osobistych ustawień powiadomień.');
  const poprawne = sprawdzUkryteTypy(typy);
  db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
    ON CONFLICT(klucz) DO UPDATE SET wartosc=excluded.wartosc, zmienione_at=excluded.zmienione_at`)
    .run(kluczKonta(id), JSON.stringify(poprawne), new Date().toISOString());
}

export function rodzajeNiewidoczneDlaFirmy(db) {
  const konta = db.prepare('SELECT id FROM konta WHERE czynne = 1').all();
  return ukrytePrzezWszystkich(konta.map(k => ukryteTypyKonta(db, k.id)));
}
