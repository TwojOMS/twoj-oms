import { describe, it, expect } from 'vitest';
import {
  PODLOGA_ARCHIWUM_SPRZEDAZY, odciskDokumentu, rozstrzygnij, miesiaceDoPrzegladu, rodzajDokumentu,
} from '../../src/domena/archiwum-sprzedazy.js';

const dok = (n = {}) => ({
  uuid: 'u1', number: '12/08/2026', invoice_date: '2026-08-03', sale_date: '2026-08-01',
  gross_price: 29300, client_tax_code: '1234563218', ksef_number: 'KS-1', rodzaj: 'vat', ...n,
});

describe('odcisk dokumentu', () => {
  it('zmiana KAZDEGO z pol z osobna zmienia odcisk', () => {
    const bazowy = odciskDokumentu(dok());
    for (const zmiana of [
      { number: '13/08/2026' }, { invoice_date: '2026-08-04' }, { sale_date: '2026-08-02' },
      { gross_price: 29301 }, { client_tax_code: '1111111111' }, { ksef_number: 'KS-2' },
    ]) {
      expect(odciskDokumentu(dok(zmiana))).not.toBe(bazowy);
    }
  });

  it('pola spoza odcisku (status, paid_date, left_to_pay) NIE zmieniaja go — oplacenie to nie zmiana dokumentu', () => {
    expect(odciskDokumentu(dok({ status: 'paid', paid_date: '2026-09-01', left_to_pay: 0 })))
      .toBe(odciskDokumentu(dok({ status: 'sent', paid_date: null, left_to_pay: 29300 })));
  });

  it('brak ksef_number i null daja ten sam odcisk (inFakt oddaje raz null, raz brak pola)', () => {
    const a = dok(); delete a.ksef_number;
    expect(odciskDokumentu(a)).toBe(odciskDokumentu(dok({ ksef_number: null })));
  });
});

describe('rozstrzygniecie nowy / bez zmian / zmieniony', () => {
  it('bez wiersza w bazie = nowy', () => {
    expect(rozstrzygnij({ dokument: dok(), wiersz: null })).toBe('nowy');
  });
  it('wiersz z tym samym odciskiem = bez zmian', () => {
    expect(rozstrzygnij({ dokument: dok(), wiersz: { odcisk: odciskDokumentu(dok()) } })).toBe('bez_zmian');
  });
  it('wiersz z innym odciskiem = zmieniony', () => {
    expect(rozstrzygnij({ dokument: dok({ gross_price: 1 }), wiersz: { odcisk: odciskDokumentu(dok()) } })).toBe('zmieniony');
  });
});

describe('miesiace do przegladu', () => {
  it('po zrobionej podlodze: biezacy i dwa wstecz', () => {
    expect(miesiaceDoPrzegladu({ dzis: '2026-09-02', podlogaZrobiona: true }))
      .toEqual(['2026-07', '2026-08', '2026-09']);
  });
  it('przelom roku', () => {
    expect(miesiaceDoPrzegladu({ dzis: '2027-01-15', podlogaZrobiona: true }))
      .toEqual(['2026-11', '2026-12', '2027-01']);
  });
  it('bez podlogi: od stycznia 2026 do biezacego', () => {
    expect(miesiaceDoPrzegladu({ dzis: '2026-04-10', podlogaZrobiona: false }))
      .toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });
  it('podloga jest stala 2026-01 i nigdy nie schodzi nizej', () => {
    expect(PODLOGA_ARCHIWUM_SPRZEDAZY).toBe('2026-01');
    expect(miesiaceDoPrzegladu({ dzis: '2026-01-20', podlogaZrobiona: true })).toEqual(['2026-01']);
  });
});

describe('rodzaj dokumentu', () => {
  it('kind correction = korekta, reszta = vat', () => {
    expect(rodzajDokumentu({ kind: 'correction' })).toBe('korekta');
    expect(rodzajDokumentu({ kind: 'vat' })).toBe('vat');
    expect(rodzajDokumentu({ rodzaj: 'korekta' })).toBe('korekta');
  });
});
