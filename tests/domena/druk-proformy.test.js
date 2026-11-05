import { describe, it, expect } from 'vitest';
import { czyWolnoDrukowacProforme, rozpoznajPozycjeDruku, idPozycjiProformy } from '../../src/domena/druk-proformy.js';

// PRZ-152.G10a — druk proformy. Decyzja właściciela 05.11: „proforma nie musi być rozliczona ani aktualna.
// usuń te opcje. po prostu jest proforma.” — drukujemy każdą proformę, która nie jest unieważniona.

const proforma = (nad = {}) => ({ id: 1, numer: 'PF/1/11/2026', uniewazniona_at: null, ...nad });

describe('czyWolnoDrukowacProforme', () => {
  it('ważna proforma — wolno', () => {
    expect(czyWolnoDrukowacProforme(proforma())).toEqual({ wolno: true, powod: null });
  });

  it('starsza ważna proforma (nie aktualna) — też wolno', () => {
    expect(czyWolnoDrukowacProforme(proforma({ id: 1, numer: 'PF/1/11/2026' }))).toEqual({ wolno: true, powod: null });
  });

  it('unieważniona — odmowa z tekstem z planu, znak w znak', () => {
    expect(czyWolnoDrukowacProforme(proforma({ uniewazniona_at: '2026-11-04T10:00:00.000Z' }))).toEqual({
      wolno: false,
      powod: 'Proforma PF/1/11/2026 jest unieważniona — nie drukujemy dokumentu, który nie obowiązuje.',
    });
  });
});

describe('id pozycji druku: faktura bez przedrostka, proforma z „p”', () => {
  it('idPozycjiProformy(12) → "p12"', () => {
    expect(idPozycjiProformy(12)).toBe('p12');
  });

  it('„p12” → proforma 12', () => {
    expect(rozpoznajPozycjeDruku('p12')).toEqual({ rodzaj: 'proforma', id: 12 });
  });

  it('id bez przedrostka liczy się dokładnie jak dziś (Number)', () => {
    expect(rozpoznajPozycjeDruku('12')).toEqual({ rodzaj: 'faktura', id: 12 });
    expect(rozpoznajPozycjeDruku('abc')).toEqual({ rodzaj: 'faktura', id: Number.NaN });
    expect(rozpoznajPozycjeDruku('12abc')).toEqual({ rodzaj: 'faktura', id: Number.NaN });
  });

  it('zniekształcone id proformy → null', () => {
    for (const napis of ['p', 'px', 'p0', 'p01', 'p1x', 'p-1', 'p1.5']) {
      expect(rozpoznajPozycjeDruku(napis), napis).toBeNull();
    }
  });
});
