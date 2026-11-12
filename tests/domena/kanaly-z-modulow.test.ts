import { describe, expect, it } from 'vitest';
import { RODZAJE_KANALOW, rodzajKanalu } from '../../src/domena/kanaly.js';
import { odznakaSyncStatusu } from '../../src/domena/lista-ikony.js';

describe('nazwy i komunikaty kanałów', () => {
  it('zachowuje katalog plakietek', () => {
    expect(RODZAJE_KANALOW).toEqual({
      allegro: { klucz: 'allegro', nazwa: 'Allegro', znak: 'a' },
      erli: { klucz: 'erli', nazwa: 'ERLI', znak: 'e' },
      woo: { klucz: 'woo', nazwa: 'WooCommerce', znak: 'W' },
    });
    expect(Object.isFrozen(RODZAJE_KANALOW)).toBe(true);
    expect(Object.keys(RODZAJE_KANALOW)).toEqual(['allegro', 'erli', 'woo']);
    expect(Object.values(RODZAJE_KANALOW).every(Object.isFrozen)).toBe(true);
  });

  it('rozpoznaje typ z definicji, a brak i nieznany typ pomija', () => {
    const definicje = [
      { klucz: 'allegro_polcien', typ: 'allegro', etykieta: 'Pracownia Półcień' },
      { klucz: 'polcien_test', typ: 'woo', etykieta: 'Pracownia Półcień' },
      { klucz: 'inny', typ: 'nieznany' },
    ];
    expect(rodzajKanalu('allegro_polcien', definicje)).toEqual({ klucz: 'allegro', nazwa: 'Allegro', znak: 'a' });
    expect(rodzajKanalu('polcien_test', definicje)).toEqual({ klucz: 'woo', nazwa: 'WooCommerce', znak: 'W' });
    expect(rodzajKanalu('inny', definicje)).toBeNull();
    expect(rodzajKanalu('brak', definicje)).toBeNull();
    expect(rodzajKanalu('polcien_test', undefined)).toBeNull();
  });

  it('zachowuje dosłowne komunikaty synchronizacji', () => {
    expect(odznakaSyncStatusu({ sklep: 'allegro_polcien', sync_woo_blad: 'błąd' })).toBe('status nie dojechał do Allegro');
    expect(odznakaSyncStatusu({ sklep: 'polcien_test', sync_woo_blad: 'błąd' })).toBe('status nie dojechał do sklepu');
    expect(odznakaSyncStatusu({ sklep: 'polcien_test' })).toBeNull();
  });
});
