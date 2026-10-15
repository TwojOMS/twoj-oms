import { describe, it, expect } from 'vitest';
import {
  czyNipUe, rozbijNipUe, stawkaDokumentu, numerWdt, polaWdtInfakt,
} from '../../src/domena/wdt.js';
import { STAWKA_VAT } from '../../src/domena/vat.js';

// Rozpoznanie WDT idzie po NIP-ie nabywcy DOKUMENTU, w postaci dowolnej (surowej albo
// znormalizowanej) — bo kolumny bazy bywają znormalizowane, a nadpisania ręczne surowe.
describe('czyNipUe', () => {
  it('numer z kodem kraju UE to nabywca unijny — postać znormalizowana i surowa', () => {
    expect(czyNipUe('SK1000000001')).toBe(true);
    expect(czyNipUe('sk 1000-000001')).toBe(true);
    expect(czyNipUe('DE 100 000 004')).toBe(true);
  });

  it('polski numer NIE jest unijny — z prefiksem PL i bez niego', () => {
    expect(czyNipUe('1234563218')).toBe(false);
    expect(czyNipUe('PL1234563218')).toBe(false);
    expect(czyNipUe('PL 123-456-32-18')).toBe(false);
  });

  it('śmieci archiwalne nie udają numeru unijnego', () => {
    // normalizujNip tnie nieznane prefiksy do samych cyfr — dokładnie po to,
    // żeby „brak", „nie dotyczy" albo literówka nie włączyły stawki 0%.
    expect(czyNipUe('XY123456')).toBe(false);
    expect(czyNipUe('brak')).toBe(false);
    expect(czyNipUe('')).toBe(false);
    expect(czyNipUe(null)).toBe(false);
  });
});

describe('rozbijNipUe', () => {
  it('oddaje kraj i numer do zapytania VIES', () => {
    expect(rozbijNipUe('SK1000000001')).toEqual({ kraj: 'SK', numer: '1000000001' });
  });

  it('dla numeru krajowego oddaje null — nie ma czego pytać w VIES', () => {
    expect(rozbijNipUe('1234563218')).toBeNull();
    expect(rozbijNipUe(null)).toBeNull();
  });
});

describe('stawkaDokumentu', () => {
  it('nabywca unijny → stawka 0 (WDT)', () => {
    expect(stawkaDokumentu('SK1000000001')).toBe('0');
  });

  it('nabywca krajowy i brak NIP-u → STAWKA_VAT, dokładnie ta sama stała', () => {
    expect(stawkaDokumentu('1000001106')).toBe(STAWKA_VAT);
    expect(stawkaDokumentu(null)).toBe(STAWKA_VAT);
  });
});

describe('numerWdt', () => {
  it('format serii dokładnie jak w Apilo: WDT/n/MM/RRRR', () => {
    expect(numerWdt(2026, 8, 1)).toBe('WDT/1/08/2026');
    expect(numerWdt(2026, 12, 14)).toBe('WDT/14/12/2026');
  });
});

describe('polaWdtInfakt', () => {
  it('dla nabywcy krajowego oddaje PUSTY obiekt — payload krajowy zostaje bajt w bajt', () => {
    expect(polaWdtInfakt('1000001106', { nipSprzedawcy: '1234563218' })).toEqual({});
  });

  it('dla nabywcy unijnego niesie typ sprzedaży i adnotację z NIP-em sprzedawcy z prefiksem PL', () => {
    const pola = polaWdtInfakt('SK1000000001', { nipSprzedawcy: '1234563218' });
    expect(pola.sale_type).toBe('merchandise');
    expect(pola.sales_kind).toBe('sprzedaz_podstawowa');
    // Art. 106e ust. 1 pkt 24: numer sprzedawcy poprzedzony kodem PL — inFakt sam go
    // nie drukuje, więc dokument niesie go w uwagach.
    expect(pola.notes).toContain('PL1234563218');
    expect(pola.notes).toContain('Wewnątrzwspólnotowa dostawa towarów');
    expect(pola.notes).toContain('0%');
  });

  it('nie dubluje prefiksu, gdy konfiguracja poda NIP już z PL', () => {
    const pola = polaWdtInfakt('SK1000000001', { nipSprzedawcy: 'PL1234563218' });
    expect(pola.notes).toContain('PL1234563218');
    expect(pola.notes).not.toContain('PLPL');
  });
});
