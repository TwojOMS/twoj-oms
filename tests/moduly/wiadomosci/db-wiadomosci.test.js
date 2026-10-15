import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszWiadomosc, wiadomosciZamowienia, ostatniaWiadomosc } from '../../../src/oms/db/wiadomosci.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const wpis = (nad = {}) => ({
  zamowienieId: 1, temat_id: 'proforma', adresat: 'klient@firma.pl',
  temat: 'Proforma PF/3/08/2026 — zamówienie nr R/2026/015',
  zalacznik: 'Proforma_PF_3_08_2026.pdf', kto: 'adam', at: '2026-08-22T10:00:00.000Z', ...nad,
});

describe('rejestr wiadomości', () => {
  it('zapisuje i oddaje wpis', () => {
    zapiszWiadomosc(db, wpis());
    const lista = wiadomosciZamowienia(db, 1);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      zamowienie_id: 1, temat_id: 'proforma', adresat: 'klient@firma.pl',
      zalacznik: 'Proforma_PF_3_08_2026.pdf', wyslana_at: '2026-08-22T10:00:00.000Z', kto: 'adam',
    });
  });

  it('oddaje wpisy rosnąco i tylko tego zamówienia', () => {
    zapiszWiadomosc(db, wpis({ at: '2026-08-22T10:00:00.000Z' }));
    zapiszWiadomosc(db, wpis({ temat_id: 'przypomnienie', at: '2026-08-22T11:00:00.000Z' }));
    zapiszWiadomosc(db, wpis({ zamowienieId: 2, temat_id: 'faktura' }));
    const lista = wiadomosciZamowienia(db, 1);
    expect(lista.map((w) => w.temat_id)).toEqual(['proforma', 'przypomnienie']);
  });

  // ⚠️ NAJNOWSZA, nie pierwsza: wiersz tematu ma pokazać, kiedy mail poszedł OSTATNIO.
  it('ostatnia wiadomość tematu to ta najnowsza', () => {
    zapiszWiadomosc(db, wpis({ temat_id: 'przypomnienie', at: '2026-08-22T10:00:00.000Z' }));
    zapiszWiadomosc(db, wpis({ temat_id: 'przypomnienie', at: '2026-08-25T09:00:00.000Z' }));
    zapiszWiadomosc(db, wpis({ temat_id: 'proforma' }));
    expect(ostatniaWiadomosc(db, 1, 'przypomnienie').wyslana_at).toBe('2026-08-25T09:00:00.000Z');
    expect(ostatniaWiadomosc(db, 1, 'faktura')).toBeUndefined();
  });

  it('załącznik i kto bywają puste', () => {
    zapiszWiadomosc(db, wpis({ temat_id: 'potwierdzenie', zalacznik: null, kto: null }));
    expect(wiadomosciZamowienia(db, 1)[0].zalacznik).toBeNull();
  });
});
