// PRZ-119.05 — Fakturownia w rejestrze kluczy integracji: token albo domena w .env próby = odmowa startu
// (rejestr działa także wtedy, gdy moduł faktur nie poda swoich kluczy). Wartości zmyślone, nie trafiają do komunikatu.
import { describe, it, expect } from 'vitest';
import { sprawdzTrybProby } from '../../src/core/tryb.ts';
import { integracje } from '../../src/integracje/klucze.js';

describe('PRZ-119.05 tryb próby a Fakturownia', () => {
  it('rejestr deklaruje token i domenę Fakturowni', () => {
    expect(integracje.fakturownia.kluczeIntegracji).toEqual(['FAKTUROWNIA_API_TOKEN', 'FAKTUROWNIA_DOMENA']);
  });

  it('proba.env z tokenem i domeną Fakturowni → odmowa startu, bez wartości w komunikacie', () => {
    const start = () => sprawdzTrybProby({ OMS_TRYB: 'proba', FAKTUROWNIA_API_TOKEN: 'zmyslony-token-polcien', FAKTUROWNIA_DOMENA: 'pracownia-polcien' }, []);
    expect(start).toThrow(/FAKTUROWNIA_API_TOKEN[\s\S]*FAKTUROWNIA_DOMENA/);
    expect(start).not.toThrow(/zmyslony-token-polcien|pracownia-polcien/);
  });

  it('każda z dwóch zmiennych osobno też blokuje; produkcja przechodzi', () => {
    expect(() => sprawdzTrybProby({ OMS_TRYB: 'proba', FAKTUROWNIA_API_TOKEN: 'x' }, [])).toThrow('FAKTUROWNIA_API_TOKEN');
    expect(() => sprawdzTrybProby({ OMS_TRYB: 'proba', FAKTUROWNIA_DOMENA: 'pracownia-polcien' }, [])).toThrow('FAKTUROWNIA_DOMENA');
    expect(() => sprawdzTrybProby({ FAKTUROWNIA_API_TOKEN: 'x', FAKTUROWNIA_DOMENA: 'pracownia-polcien' }, [])).not.toThrow();
  });
});
