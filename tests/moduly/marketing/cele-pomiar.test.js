import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozCel, dopiszZdarzenie } from '../../../src/oms/db/cele.js';
import { zmierz, progCelu } from '../../../src/moduly/marketing/uslugi/cele-pomiar.js';

// ⚠️ `vi.spyOn` NIE dziala na eksportach ESM (namespace jest zamrozony), wiec podmiana idzie
// przez `vi.mock` + `vi.hoisted`. `stan.podmiana` pozwala kazdemu testowi wstawic SZTUCZNY
// miernik — bez tego stany `nieswiezy` i `nieznany` byly nietestowalne az do Etapu 2,
// bo Etap 1 nie ma ani jednego automatu.
const stan = vi.hoisted(() => ({ podmiana: null }));
vi.mock('../../../src/domena/mierniki-celow.js', async (importOriginal) => {
  const org = await importOriginal();
  return { ...org, miernik: (k) => (stan.podmiana === null ? org.miernik(k) : stan.podmiana) };
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); stan.podmiana = null; });

const OKRES = { od: '2026-09-07', do: '2026-09-13' };
const nowy = (n = {}) => zalozCel(db, {
  nazwa: 'X', kontoId: null, rytm: 'tydzien', celIle: 5,
  miernik: 'reczny', odDnia: null, doDnia: null, ...n,
});

describe('zmierz — miernik reczny', () => {
  it('sumuje zdarzenia i oddaje dzien ostatniego jako zrodloAt', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 2, kontoId: null });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-11', ile: 1, kontoId: null });
    expect(zmierz(db, { id, miernik: 'reczny' }, OKRES))
      .toEqual({ ile: 3, zrodloAt: '2026-09-11' });
  });

  it('brak zdarzen to ile 0 — UCZCIWE ZERO, nie null', () => {
    // Reczny nie moze byc „nieznany": czlowiek albo klikal, albo nie. Null oznaczalby
    // awarie zrodla, a zrodlem jest tu tabela, ktora zawsze odpowiada.
    expect(zmierz(db, { id: nowy(), miernik: 'reczny' }, OKRES))
      .toEqual({ ile: 0, zrodloAt: null });
  });

  it('liczy TYLKO w podanym okresie', () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: '2026-08-01', ile: 9, kontoId: null });
    expect(zmierz(db, { id, miernik: 'reczny' }, OKRES).ile).toBe(0);
  });
});

describe('zmierz — fail-closed na nieznanym mierniku', () => {
  it('klucz spoza rejestru oddaje null, a NIE sume zdarzen', () => {
    // ⚠️ Podstawienie recznego byloby najgorsza z opcji: cel pokazalby zero (bo automat
    // zdarzen nie pisze) i wygladal na ZANIEDBANY zamiast na ZEPSUTY. Roznica jest istotna,
    // bo pierwsze to zarzut wobec czlowieka, a drugie wobec miernika.
    const id = nowy({ miernik: 'wzory-sklep' });
    dopiszZdarzenie(db, { celId: id, dzien: '2026-09-08', ile: 2, kontoId: null });
    expect(zmierz(db, { id, miernik: 'wzory-sklep' }, OKRES)).toBe(null);
  });
});

describe('zmierz — automat (sztuczny, bo Etap 1 nie ma zadnego)', () => {
  it('wola policz i oddaje jego wynik', () => {
    stan.podmiana = {
      etykieta: 'Sztuczny', progSwiezosciH: 36,
      policz: () => ({ ile: 4, zrodloAt: '2026-09-13T08:00:00Z' }),
    };
    expect(zmierz(db, { id: nowy(), miernik: 'sztuczny' }, OKRES))
      .toEqual({ ile: 4, zrodloAt: '2026-09-13T08:00:00Z' });
  });

  it('przekazuje mierzacemu BAZE i OKRES', () => {
    const widziane = [];
    stan.podmiana = {
      etykieta: 'Sztuczny', progSwiezosciH: null,
      policz: (bazaWejscie, okresWejscie) => { widziane.push(okresWejscie); return { ile: 1, zrodloAt: null }; },
    };
    zmierz(db, { id: nowy(), miernik: 'sztuczny' }, OKRES);
    expect(widziane).toEqual([OKRES]);
  });

  it('RZUCAJACY policz daje null, nie wywala calej strony', () => {
    // ⚠️ Jeden zepsuty miernik nie moze zabrac właścicielowi calego ekranu. Kafel ma pokazac
    // „nie wiem", a pozostale kafle maja sie wyrenderowac.
    stan.podmiana = {
      etykieta: 'Sztuczny', progSwiezosciH: 36,
      policz: () => { throw new Error('lustro nieodswiezone'); },
    };
    expect(zmierz(db, { id: nowy(), miernik: 'sztuczny' }, OKRES)).toBe(null);
  });

  it('policz oddajacy smiec (bez `ile`) daje null', () => {
    stan.podmiana = { etykieta: 'Sztuczny', progSwiezosciH: 36, policz: () => ({ zrodloAt: 'x' }) };
    expect(zmierz(db, { id: nowy(), miernik: 'sztuczny' }, OKRES)).toBe(null);
  });

  it('policz oddajacy null daje null', () => {
    stan.podmiana = { etykieta: 'Sztuczny', progSwiezosciH: 36, policz: () => null };
    expect(zmierz(db, { id: nowy(), miernik: 'sztuczny' }, OKRES)).toBe(null);
  });

  it('brak zrodloAt w wyniku normalizuje sie do null, nie undefined', () => {
    // `undefined` przeszloby przez `postepCelu` inaczej niz `null` przy porownaniach ===.
    stan.podmiana = { etykieta: 'Sztuczny', progSwiezosciH: null, policz: () => ({ ile: 2 }) };
    expect(zmierz(db, { id: nowy(), miernik: 'sztuczny' }, OKRES))
      .toEqual({ ile: 2, zrodloAt: null });
  });
});

describe('progCelu', () => {
  it('oddaje prog z rejestru', () => {
    expect(progCelu({ miernik: 'reczny' })).toBe(null);
  });

  it('oddaje prog sztucznego automatu', () => {
    stan.podmiana = { etykieta: 'Sztuczny', progSwiezosciH: 36, policz: () => null };
    expect(progCelu({ miernik: 'sztuczny' })).toBe(36);
  });

  it('nieznany miernik ma prog null — stan rozstrzyga i tak pomiar null', () => {
    expect(progCelu({ miernik: 'nie-ma' })).toBe(null);
  });
});
