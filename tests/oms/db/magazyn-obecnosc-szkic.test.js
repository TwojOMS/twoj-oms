import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  utworzKarte,
  powiazProdukt,
  zapiszProduktSklepowy,
  kartyZKanalami,
  kanalyDostepnosciKart,
} from '../../../src/oms/db/magazyn.js';

// Kupujący szkicu nie widzi, więc szkic Woo nie jest obecnością w kanale — tak samo jak oferta
// Allegro spoza ACTIVE. Wiersz zostaje w lustrze z kartą, ale filtry i kolumna „Kanały” mówią „brak”.
const AT = '2026-11-18T10:00:00.000Z';
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
});

function baza() {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  const karta = (nazwa, produktId, status) => {
    const id = utworzKarte(db, { nazwa });
    const wiersz = zapiszProduktSklepowy(db, {
      kanal: 'polcien',
      produkt_id: produktId,
      wariant_id: '',
      nazwa,
      cena_gr: 15900,
      status_publikacji: status,
      odczytane_at: AT,
    });
    powiazProdukt(db, wiersz, id);
    return id;
  };
  return {
    db,
    opublikowana: karta('Lampa Półcień 40', '501', 'publish'),
    szkic: karta('Lampa Półcień 60', '502', 'draft'),
    // Wiersz sprzed odczytu statusu Woo: brak statusu to dalej obecność.
    bezStatusu: karta('Kinkiet Półcień', '503', null),
  };
}

it('filtr „jest w kanale” nie liczy szkicu', () => {
  const { db, opublikowana, szkic, bezStatusu } = baza();
  const ids = kartyZKanalami(db, { filtry: { kanal: 'polcien' } }).map((k) => k.id);
  expect(ids).toContain(opublikowana);
  expect(ids).toContain(bezStatusu);
  expect(ids).not.toContain(szkic);
});

it('filtr ceny nie liczy ceny szkicu', () => {
  const { db, opublikowana, szkic } = baza();
  const ids = kartyZKanalami(db, { filtry: { cenaOd: 15000 } }).map((k) => k.id);
  expect(ids).toContain(opublikowana);
  expect(ids).not.toContain(szkic);
});

it('„brak w kanale”: karta ze szkicem nie ma komórki kanału ani dostępności', () => {
  const { db, opublikowana, szkic } = baza();
  const karty = new Map(kartyZKanalami(db, {}).map((k) => [k.id, k]));
  expect(karty.get(szkic)).toBeTruthy();
  expect(karty.get(szkic).kanaly.polcien).toBeUndefined();
  expect(karty.get(opublikowana).kanaly.polcien).toBeTruthy();

  const dostepne = kanalyDostepnosciKart(db, [opublikowana, szkic]);
  expect(dostepne).toEqual([{ karta_id: opublikowana, kanal: 'polcien' }]);
});
