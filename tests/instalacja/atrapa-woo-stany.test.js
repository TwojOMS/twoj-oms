import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAtrapaWoo } from '../../deploy/proba/atrapy/kanaly.mjs';
import { KANALY } from '../../scripts/demo-dane-firma.mjs';

const kanal = KANALY.find((k) => k.typ === 'woo').klucz;
function przygotuj() {
  const db = new DatabaseSync(':memory:');
  return { db, woo: createAtrapaWoo({ db, kanal, env: { OMS_TRYB: 'proba' }, log: () => {} }) };
}

describe('E4.04 — atrapa stanów Woo', () => {
  it('katalog ma true, produkt false i wariant parent; odczyt zawęża identyfikatory', async () => {
    const { db, woo } = przygotuj();
    try {
      const produkty = await woo.pobierzWszystkieProdukty();
      expect(produkty.some((p) => p.manage_stock === true)).toBe(true);
      expect(produkty.some((p) => p.manage_stock === false)).toBe(true);
      const rodzic = produkty.find((p) => p.type === 'variable');
      const warianty = await woo.pobierzWarianty(rodzic.id);
      expect(warianty.some((p) => p.manage_stock === 'parent')).toBe(true);
      expect(await woo.pobierzStany([produkty[0].id, 999999])).toEqual([produkty[0]]);
      expect(await woo.pobierzStanyWariantow(rodzic.id, [warianty[0].id])).toEqual([warianty[0]]);
    } finally {
      db.close();
    }
  });

  it('zapisuje tylko ilość, liczy zapisy, oddaje błędy per pozycja i zachowuje stan między klientami', async () => {
    const { db, woo } = przygotuj();
    try {
      const produkt = (await woo.pobierzWszystkieProdukty()).find((p) => p.manage_stock === true);
      expect(
        await woo.zapiszStanyHurtem(null, [
          { id: produkt.id, stock_quantity: 19 },
          { id: 999999, stock_quantity: 2 },
        ]),
      ).toEqual([
        { id: produkt.id, ok: true },
        { id: 999999, ok: false, blad: expect.any(String) },
      ]);
      const drugi = createAtrapaWoo({ db, kanal, env: { OMS_TRYB: 'proba' }, log: () => {} });
      expect(await drugi.pobierzStany([produkt.id])).toEqual([{ ...produkt, stock_quantity: 19 }]);
      expect(
        JSON.parse(
          db.prepare("SELECT pola_json FROM atrapa_kanaly_zmiany WHERE kanal=? AND sciezka='stany/licznik'").get(kanal)
            .pola_json,
        ),
      ).toEqual({ liczba: 1 });
      await expect(
        woo.zapiszStanyHurtem(null, [{ id: produkt.id, stock_quantity: 1, manage_stock: false }]),
      ).rejects.toThrow(/pole/i);
      expect((await woo.pobierzStany([produkt.id]))[0].stock_quantity).toBe(19);
    } finally {
      db.close();
    }
  });

  it('wariant zapisuje osobno; kup/oddaj zdejmują i przywracają, false nie zmienia ilości, parent korzysta z rodzica', async () => {
    const { db, woo } = przygotuj();
    try {
      const produkty = await woo.pobierzWszystkieProdukty();
      const rodzic = produkty.find((p) => p.type === 'variable');
      const warianty = await woo.pobierzWarianty(rodzic.id);
      const wariant = warianty.find((p) => p.manage_stock === true);
      const parent = warianty.find((p) => p.manage_stock === 'parent');
      expect(await woo.zapiszStanyHurtem(rodzic.id, [{ id: wariant.id, stock_quantity: 10 }])).toEqual([
        { id: wariant.id, ok: true },
      ]);
      await woo.kup(wariant.id, 3);
      expect((await woo.pobierzStanyWariantow(rodzic.id, [wariant.id]))[0].stock_quantity).toBe(7);
      await woo.oddaj(wariant.id, 3);
      expect((await woo.pobierzStanyWariantow(rodzic.id, [wariant.id]))[0].stock_quantity).toBe(10);
      const bezStanow = produkty.find((p) => p.manage_stock === false);
      await woo.kup(bezStanow.id, 3);
      await woo.oddaj(bezStanow.id, 3);
      expect((await woo.pobierzStany([bezStanow.id]))[0]).toEqual(bezStanow);
      await woo.zapiszStanyHurtem(null, [{ id: rodzic.id, stock_quantity: 8 }]);
      await woo.kup(parent.id, 2);
      expect((await woo.pobierzStany([rodzic.id]))[0].stock_quantity).toBe(6);
      await woo.oddaj(parent.id, 2);
      expect((await woo.pobierzStany([rodzic.id]))[0].stock_quantity).toBe(8);
      await expect(woo.kup(wariant.id, -2)).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it('zapis do celu bez liczenia stanu (false, parent) jest „udany”, ale ilości nie zmienia — jak Woo', async () => {
    const { db, woo } = przygotuj();
    try {
      const produkty = await woo.pobierzWszystkieProdukty();
      const bezStanow = produkty.find((p) => p.manage_stock === false);
      const rodzic = produkty.find((p) => p.type === 'variable');
      const parent = (await woo.pobierzWarianty(rodzic.id)).find((p) => p.manage_stock === 'parent');
      expect(await woo.zapiszStanyHurtem(null, [{ id: bezStanow.id, stock_quantity: 5 }])).toEqual([
        { id: bezStanow.id, ok: true },
      ]);
      expect(await woo.zapiszStanyHurtem(rodzic.id, [{ id: parent.id, stock_quantity: 5 }])).toEqual([
        { id: parent.id, ok: true },
      ]);
      expect((await woo.pobierzStany([bezStanow.id]))[0]).toEqual(bezStanow);
      expect((await woo.pobierzStanyWariantow(rodzic.id, [parent.id]))[0]).toEqual(parent);
    } finally {
      db.close();
    }
  });
});
