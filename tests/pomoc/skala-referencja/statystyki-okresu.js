// Referencja PRZ-094.13 z 9ccdd75, przed optymalizacją.
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { anulowaneEfektywnie } from '../../../src/domena/status-reczny.js';
import { czyTestowe } from '../../../src/domena/sprzedaz-okresu.js';
import { listaZamowien } from '../../../src/oms/db/zamowienia.js';

const bezpiecznyJson = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };

export function zamowieniaOkresu(db, { od, do: doDnia }, reguly = {}) {
  const wybrane = [];
  for (const w of listaZamowien(db)) {
    if (anulowaneEfektywnie(w)) continue;
    const dzien = dzienWarszawa(w.utworzone_at);
    if (!dzien || dzien < od || dzien > doDnia) continue;
    const klient = { ...bezpiecznyJson(w.klient_json), ...bezpiecznyJson(w.klient_reczny_json) };
    const nazwa = `${klient.first_name ?? ''} ${klient.last_name ?? ''} ${klient.company ?? ''}`;
    if (czyTestowe(klient.email, nazwa, reguly)) continue;
    wybrane.push({ ...w, dzien });
  }
  return wybrane;
}

export function pierwszyDzienZamowien(db) {
  let pierwszy = null;
  for (const { utworzone_at: utworzone } of db.prepare('SELECT utworzone_at FROM zamowienia').all()) {
    const dzien = dzienWarszawa(utworzone);
    if (dzien && (pierwszy === null || dzien < pierwszy)) pierwszy = dzien;
  }
  return pierwszy;
}
