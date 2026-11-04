import { describe, expect, it } from 'vitest';
import { kluczeKanalu } from '../../src/integracje/klucze.js';

describe('klucze kanału z modułu', () => {
  it('zachowuje nazwy i kolejność sekretów', () => {
    expect(kluczeKanalu('allegro', 'RYNEK').kluczeIntegracji).toEqual(['RYNEK_CLIENT_ID', 'RYNEK_CLIENT_SECRET']);
    expect(kluczeKanalu('woo', 'SKLEP').kluczeIntegracji).toEqual(['SKLEP_CK', 'SKLEP_CS']);
  });
  it('zachowuje błędy i kolejność walidacji', () => {
    expect(() => kluczeKanalu('shoper', 'SKLEP')).toThrow('Nieznany typ kanału');
    expect(() => kluczeKanalu('shoper', '../plik')).toThrow('Nieprawidłowy prefiks kanału');
  });
});
