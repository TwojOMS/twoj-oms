import { grosze, zl } from '../../../domena/suma-pozycji.js';
import { dodajWplateReczna, dodajWplateOkresu } from '../../../oms/db/platnosci.js';

// Dostawca OMS: nie zależy od adaptera ani tabel TF. Id dokumentów są tekstem jak w faktury.dokument_id.
const REJESTRY = [
  { rodzaj: 'zamowienie', tabela: 'faktury', klucz: 'zamowienie_id', platnosci: 'platnosci', fk: 'zamowienie_id' },
  { rodzaj: 'okres', tabela: 'okresy_rozliczeniowe', klucz: 'id', platnosci: 'platnosci_okresu', fk: 'okres_rozliczeniowy_id' },
];

/** Wiele dokumentów: jedno zapytanie na rodzaj, również dla powiązań bez wpłat. */
export function wplatyPowiazane(db, dokumentIds = null) {
  const mapa = new Map();
  for (const r of REJESTRY) {
    const filtr = dokumentIds === null ? '' : ' AND f.dokument_id IN (SELECT value FROM json_each(?))';
    const wiersze = db.prepare(`
      SELECT f.dokument_id, f.${r.klucz} AS powiazanie_id, p.id AS wplata_id,
        p.data, p.kwota, p.zrodlo, p.metoda, p.uwaga, p.utworzona_at
      FROM ${r.tabela} f LEFT JOIN ${r.platnosci} p ON p.${r.fk} = f.${r.klucz}
      WHERE f.program = 'twojefaktury' AND f.dokument_id IS NOT NULL${filtr}
      ORDER BY f.dokument_id, COALESCE(p.data, p.utworzona_at), p.id
    `).all(...(dokumentIds === null ? [] : [JSON.stringify(dokumentIds)]));
    for (const w of wiersze) {
      if (!mapa.has(w.dokument_id)) mapa.set(w.dokument_id, { rodzaj: r.rodzaj, id: w.powiazanie_id, wplaty: [], blad: null });
      const wynik = mapa.get(w.dokument_id);
      // Recenzja P36a: dokument przy dwóch zamówieniach/okresach — nie sumujemy cudzych wpłat, saldo wraca do flagi (D7).
      if (wynik.rodzaj !== r.rodzaj || wynik.id !== w.powiazanie_id) {
        wynik.blad = 'Dokument jest powiązany z więcej niż jednym zamówieniem lub okresem.';
        wynik.wplaty = [];
      }
      if (w.wplata_id === null || wynik.blad !== null) continue;
      try {
        const kwotaGr = grosze(w.kwota, 'wpłata powiązana z dokumentem');
        wynik.wplaty.push({ data: w.data, kwotaGr, zrodlo: w.zrodlo, metoda: w.metoda, uwaga: w.uwaga, utworzona_at: w.utworzona_at });
      } catch (e) {
        wynik.blad = e.message;
        wynik.wplaty = [];
      }
    }
  }
  return mapa;
}

/** Wołający waliduje wpłatę regułą faktury; zapis korzysta z istniejących rejestrów OMS. */
export function dopiszWplatePowiazana(db, dokumentId, { kwotaGr, data, uwaga }) {
  const powiazanie = wplatyPowiazane(db, [dokumentId]).get(dokumentId);
  if (!powiazanie) throw new Error('Dokument nie ma powiązania z zamówieniem ani okresem.');
  if (powiazanie.blad !== null) throw new Error(powiazanie.blad);
  if (!Number.isSafeInteger(kwotaGr) || kwotaGr <= 0) throw new Error('Kwota wpłaty musi być dodatnią liczbą groszy.');
  const wplata = { kwota: zl(kwotaGr), data, uwaga };
  return powiazanie.rodzaj === 'zamowienie'
    ? dodajWplateReczna(db, powiazanie.id, wplata)
    : dodajWplateOkresu(db, powiazanie.id, wplata);
}
