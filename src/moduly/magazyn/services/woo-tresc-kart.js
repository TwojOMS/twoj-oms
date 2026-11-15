import { importMozeZapisac, polePuste } from '../../../domena/zrodla-pol.js';
import { kolejnoscZrodel } from './kolejnosc-zrodel.js';

// Wołane w synchronicznej transakcji odczytu katalogu, po zapisie lustra.
// Nie tworzy kart ani nie pobiera zdjęć. Treść pochodzi z już odczytanej odpowiedzi Woo.
export function zapiszTrescWoo(db, produkt, idLustra, at) {
  const tresc = produkt.tresc_woo;
  if (!tresc) return;
  const powiazanie = db.prepare('SELECT karta_id FROM produkty_sklepowe WHERE id = ?').get(idLustra);
  if (!powiazanie?.karta_id) return;
  const id = powiazanie.karta_id;
  const karta = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
  if (!karta) return;
  const zrodlo = `woo:${produkt.kanal}`;
  const zrodla = new Map(db.prepare('SELECT * FROM karty_zrodla_pol WHERE karta_id = ?').all(id).map(w => [w.pole, w]));
  const kolejnosc = kolejnoscZrodel(db);
  const wolno = (pole, wartosc) => importMozeZapisac(pole, wartosc, zrodla.get(pole), zrodlo, kolejnosc);
  const oznacz = pole => db.prepare(`INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
    VALUES (?, ?, ?, 0, ?) ON CONFLICT (karta_id, pole) DO UPDATE SET
    zrodlo = excluded.zrodlo, reczne = 0, zmieniono_at = excluded.zmieniono_at`).run(id, pole, zrodlo, at);

  const pola = Object.fromEntries(['opis_sekcje_json', 'ean', 'cena_gr', 'grupa_wariantow']
    .filter(pole => Object.hasOwn(tresc.pola, pole)).map(pole => [pole, tresc.pola[pole]]));
  for (const [pole, wartosc] of Object.entries(pola)) {
    if (polePuste(pole, wartosc) || !wolno(pole, karta[pole])) continue;
    // Identyczna wartość też przechodzi pod ochronę wyższego źródła.
    if (zrodla.get(pole)?.zrodlo !== zrodlo) oznacz(pole);
    if ((pole === 'cena_gr' ? Number(wartosc) : String(wartosc)) === karta[pole]) continue;
    db.prepare(`UPDATE karty_produktow SET ${pole} = ?, zmieniony_at = ? WHERE id = ?`).run(wartosc, at, id);
    oznacz(pole);
  }
  const zdjecia = db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(id);
  const odnosniki = zdjecia.filter(z => z.plik === null && z.zrodlo === zrodlo).map(z => z.adres_zrodlowy);
  if (tresc.zdjecia.length && wolno('zdjecia', zdjecia)
      && (zrodla.get('zdjecia')?.zrodlo !== zrodlo || JSON.stringify(odnosniki) !== JSON.stringify(tresc.zdjecia))) {
    if (zrodla.get('zdjecia')?.zrodlo !== zrodlo) {
      // Przejęcie galerii usuwa wiersze poprzedniego importu, nigdy pliki na dysku.
      db.prepare('DELETE FROM zdjecia_kart WHERE karta_id = ? AND zrodlo <> ?').run(id, zrodlo);
    }
    db.prepare('DELETE FROM zdjecia_kart WHERE karta_id = ? AND plik IS NULL AND zrodlo = ?').run(id, zrodlo);
    const dodaj = db.prepare(`INSERT INTO zdjecia_kart
      (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at, ai, ai_reczne, wyslane_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    tresc.zdjecia.forEach((adres, i) => {
      const stare = zdjecia.find(z => z.adres_zrodlowy === adres);
      dodaj.run(id, i, zrodlo, adres, at, stare?.ai_reczne === 1 || stare?.wyslane_at ? stare.ai : 0,
        stare?.ai_reczne ?? 0, stare?.wyslane_at ?? null);
    });
    oznacz('zdjecia');
  }
  // To dane źródłowej oferty, niezależne od pól treści wspólnej karty.
  const kategoria = tresc.kategoria;
  const sciezka = kategoria && db.prepare('SELECT sciezka_json FROM kanaly_kategorie WHERE polaczenie = ? AND kategoria_id = ?')
    .get(produkt.kanal, String(kategoria.id));
  db.prepare(`INSERT INTO karty_dane_kanalu (karta_id, typ_kanalu, polaczenie, oferta_id, produkt_id,
    kategoria_id, kategoria_sciezka_json, pobrano_at) VALUES (?, 'sklep', ?, ?, ?, ?, ?, ?)
    ON CONFLICT (karta_id, typ_kanalu) DO UPDATE SET polaczenie = excluded.polaczenie,
    oferta_id = excluded.oferta_id, produkt_id = excluded.produkt_id, kategoria_id = excluded.kategoria_id,
    kategoria_sciezka_json = excluded.kategoria_sciezka_json, pobrano_at = excluded.pobrano_at`)
    .run(id, produkt.kanal, String(produkt.wariant_id || produkt.produkt_id), String(produkt.produkt_id),
      kategoria ? String(kategoria.id) : null,
      sciezka?.sciezka_json ?? (kategoria ? JSON.stringify([kategoria.name]) : null), at);
}
