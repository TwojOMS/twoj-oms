import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  historiaCenZakupu,
  cenaZakupuNa,
  cenyZakupuNa,
  zapiszCeneZakupu,
  usunWpisCenyZakupu,
} from '../../../src/oms/db/ceny-zakupu.js';
import { cenaObowiazujaca } from '../../../src/domena/cena-zakupu.js';

const UTWORZONO = '2026-11-01T08:00:00.000Z';
const nowaKarta = (db, sku) => utworzKarte(db, { sku, nazwa: `Lampa Kopuła ${sku}` }, { at: UTWORZONO });
const KARTA = { kto: 'magazynier', zrodlo: 'karta', at: '2026-11-18T10:00:00.000Z' };
const wiersze = (db) =>
  db
    .prepare('SELECT karta_id, cena_netto_gr, obowiazuje_od, kto, zrodlo, wpisano_at FROM ceny_zakupu_kart ORDER BY id')
    .all()
    .map((w) => ({ ...w }));

describe('zapiszCeneZakupu', () => {
  it('ten sam dzień zastępuje kwotę, inny dzień dopisuje wpis', () => {
    const db = openOmsDb(':memory:');
    try {
      const k = nowaKarta(db, 'PP-1');
      zapiszCeneZakupu(db, k, { gr: 1230, od: '2026-11-05' }, KARTA);
      zapiszCeneZakupu(
        db,
        k,
        { gr: 1250, od: '2026-11-05' },
        { kto: 'szef', zrodlo: 'hurt', at: '2026-11-18T11:00:00.000Z' },
      );
      expect(wiersze(db)).toEqual([
        {
          karta_id: k,
          cena_netto_gr: 1250,
          obowiazuje_od: '2026-11-05',
          kto: 'szef',
          zrodlo: 'hurt',
          wpisano_at: '2026-11-18T11:00:00.000Z',
        },
      ]);

      zapiszCeneZakupu(db, k, { gr: 1310, od: '2026-12-01' }, KARTA);
      expect(wiersze(db).map((w) => [w.obowiazuje_od, w.cena_netto_gr])).toEqual([
        ['2026-11-05', 1250],
        ['2026-12-01', 1310],
      ]);
    } finally {
      db.close();
    }
  });

  it('nie rusza zmieniony_at karty — cena zakupu nie wychodzi do API, klienci API nie mają pobierać karty od nowa', () => {
    const db = openOmsDb(':memory:');
    try {
      const k = nowaKarta(db, 'PP-2');
      zapiszCeneZakupu(db, k, { gr: 1230, od: '2026-11-05' }, KARTA);
      zapiszCeneZakupu(db, k, { gr: 1250, od: '2026-11-05' }, KARTA);
      usunWpisCenyZakupu(db, k, historiaCenZakupu(db, k)[0].id);
      expect(db.prepare('SELECT zmieniony_at FROM karty_produktow WHERE id = ?').get(k).zmieniony_at).toBe(UTWORZONO);
    } finally {
      db.close();
    }
  });

  it('kwota spoza zasad bazy (ułamek, ujemna) i nieznane źródło → wyjątek, nic nie zapisane', () => {
    const db = openOmsDb(':memory:');
    try {
      const k = nowaKarta(db, 'PP-3');
      expect(() => zapiszCeneZakupu(db, k, { gr: 12.3, od: '2026-11-05' }, KARTA)).toThrow();
      expect(() => zapiszCeneZakupu(db, k, { gr: -1, od: '2026-11-05' }, KARTA)).toThrow();
      expect(() => zapiszCeneZakupu(db, k, { gr: 1230, od: '2026-11-05' }, { ...KARTA, zrodlo: 'import' })).toThrow();
      expect(wiersze(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('historiaCenZakupu', () => {
  it('wpisy jednej karty rosnąco po dacie „od”, z kim i skąd', () => {
    const db = openOmsDb(':memory:');
    try {
      const a = nowaKarta(db, 'PP-4');
      const b = nowaKarta(db, 'PP-5');
      zapiszCeneZakupu(db, a, { gr: 1310, od: '2026-12-01' }, KARTA);
      zapiszCeneZakupu(db, a, { gr: 1100, od: '2026-10-01' }, { ...KARTA, zrodlo: 'hurt', kto: null });
      zapiszCeneZakupu(db, b, { gr: 999, od: '2026-11-01' }, KARTA);
      const h = historiaCenZakupu(db, a);
      expect(h.map((w) => [w.obowiazuje_od, w.cena_netto_gr, w.kto, w.zrodlo])).toEqual([
        ['2026-10-01', 1100, null, 'hurt'],
        ['2026-12-01', 1310, 'magazynier', 'karta'],
      ]);
      expect(h.every((w) => Number.isInteger(w.id) && w.karta_id === a && w.wpisano_at === KARTA.at)).toBe(true);
      expect(historiaCenZakupu(db, 999999)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('cenaZakupuNa i cenyZakupuNa liczą tak samo jak reguła domeny', () => {
  it('trzy karty, wpisy wstecz, dziś i w przyszłości — zgodność na każdy dzień', () => {
    const db = openOmsDb(':memory:');
    try {
      const a = nowaKarta(db, 'PP-6');
      const b = nowaKarta(db, 'PP-7');
      const c = nowaKarta(db, 'PP-8');
      const bezCeny = nowaKarta(db, 'PP-9');
      const zapisz = (k, gr, od) => zapiszCeneZakupu(db, k, { gr, od }, KARTA);
      zapisz(a, 1100, '2026-10-01');
      zapisz(a, 1230, '2026-11-18');
      zapisz(a, 1310, '2026-12-01');
      zapisz(b, 0, '2020-01-01');
      zapisz(c, 4500, '2099-01-01');

      const dni = ['2019-12-31', '2020-01-01', '2026-09-30', '2026-10-01', '2026-11-17', '2026-11-18', '2026-11-30'];
      for (const dzien of [...dni, '2026-12-01', '2098-12-31', '2099-01-01']) {
        const naRaz = cenyZakupuNa(db, dzien);
        for (const k of [a, b, c, bezCeny]) {
          const oczekiwana = cenaObowiazujaca(historiaCenZakupu(db, k), dzien);
          const jedna = cenaZakupuNa(db, k, dzien);
          expect(jedna, `karta ${k}, dzień ${dzien}`).toEqual(
            oczekiwana && { cena_netto_gr: oczekiwana.cena_netto_gr, obowiazuje_od: oczekiwana.obowiazuje_od },
          );
          expect(naRaz.get(k), `karta ${k}, dzień ${dzien}`).toBe(oczekiwana?.cena_netto_gr);
        }
        expect([...naRaz.keys()].every((k) => [a, b, c].includes(k))).toBe(true);
      }

      // Kotwice wprost — gdyby reguła domeny i zapytanie zepsuły się tak samo.
      expect(cenaZakupuNa(db, a, '2026-11-18')).toEqual({ cena_netto_gr: 1230, obowiazuje_od: '2026-11-18' });
      expect(cenaZakupuNa(db, a, '2026-11-17')).toEqual({ cena_netto_gr: 1100, obowiazuje_od: '2026-10-01' });
      expect(cenaZakupuNa(db, c, '2026-11-18')).toBe(null);
      expect(cenyZakupuNa(db, '2026-11-18')).toEqual(
        new Map([
          [a, 1230],
          [b, 0],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('wyszukanie ceny na dzień idzie po indeksie (karta_id, obowiazuje_od), nie po całej tabeli', () => {
    const db = openOmsDb(':memory:');
    try {
      // Plan liczony dla zapytań, które funkcje naprawdę wysyłają — nie dla kopii SQL w teście.
      const wyslane = [];
      const prepare = db.prepare.bind(db);
      db.prepare = (sql) => {
        wyslane.push(sql);
        return prepare(sql);
      };
      cenaZakupuNa(db, 1, '2026-11-18');
      cenyZakupuNa(db, '2026-11-18');
      db.prepare = prepare;
      const zapytania = wyslane.filter((sql) => /ceny_zakupu_kart/.test(sql));
      expect(zapytania).toHaveLength(2);
      for (const sql of zapytania) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(sql.includes(':karta') ? { karta: 1, dzien: '2026-11-18' } : { dzien: '2026-11-18' })
          .map((w) => w.detail);
        expect(plan.join(' | ')).toMatch(/SEARCH \S+ USING (COVERING )?INDEX \S+ \(karta_id=\? AND obowiazuje_od<\?\)/);
        expect(plan.filter((d) => /^SCAN ceny_zakupu_kart$/.test(d))).toEqual([]);
      }
    } finally {
      db.close();
    }
  });
});

describe('usunWpisCenyZakupu', () => {
  it('usuwa wpis swojej karty; numer wpisu cudzej karty nie usuwa niczego', () => {
    const db = openOmsDb(':memory:');
    try {
      const a = nowaKarta(db, 'PP-10');
      const b = nowaKarta(db, 'PP-11');
      zapiszCeneZakupu(db, a, { gr: 1230, od: '2026-11-05' }, KARTA);
      const wpisA = historiaCenZakupu(db, a)[0].id;

      expect(usunWpisCenyZakupu(db, b, wpisA)).toBe(0);
      expect(historiaCenZakupu(db, a)).toHaveLength(1);
      expect(usunWpisCenyZakupu(db, a, 999999)).toBe(0);

      expect(usunWpisCenyZakupu(db, a, wpisA)).toBe(1);
      expect(historiaCenZakupu(db, a)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
