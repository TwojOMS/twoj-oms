import { describe, expect, it } from 'vitest';
import { definicjeKanalow, konfiguracjaKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';

const definicje = [{ klucz: 'demo', typ: 'woo' as const, prefiks: 'DEMO' }];
const env = { DEMO_URL: 'https://example.test/', DEMO_CK: 'test', DEMO_CS: 'test', DEMO_OD: '2026-01-01' };
const sekret = 'SYNTHETIC_SECRET_JSON';
function komunikat(f: () => unknown) {
  try { f(); } catch (e) { return (e as Error).message; }
  throw new Error('Oczekiwano odmowy konfiguracji');
}

describe('błędy JSON konfiguracji kanałów bez wartości wejściowej', () => {
  it('wadliwy OMS_KANALY oddaje wyłącznie nazwę i ogólny powód', () => {
    const m = komunikat(() => definicjeKanalow({ OMS_KANALY: `${sekret}{` }));
    expect(m).toBe('OMS_KANALY: niepoprawny JSON');
    expect(m).not.toContain(sekret);
  });
  it('wadliwe wymagane mapowanie oddaje wyłącznie nazwę i ogólny powód', () => {
    const m = komunikat(() => konfiguracjaKanalow(definicje, { ...env, DEMO_MAPOWANIE: `${sekret}{` }));
    expect(m).toBe('DEMO_MAPOWANIE: niepoprawny JSON');
    expect(m).not.toContain(sekret);
  });
  it('null definicji, mapowania i pozycji odmawia nazwanym błędem konfiguracji', () => {
    expect(komunikat(() => definicjeKanalow({ OMS_KANALY: '[null]' }))).toBe('OMS_KANALY: błędna albo powtórzona definicja');
    for (const DEMO_MAPOWANIE of ['null', '[]', '{"instancje":{},"poPozycji":[null]}', '{"instancje":{"a":null},"poPozycji":[]}']) {
      expect(komunikat(() => konfiguracjaKanalow(definicje, { ...env, DEMO_MAPOWANIE }))).toMatch(/^DEMO_MAPOWANIE: (oczekiwano instancje i poPozycji|niedozwolona metoda sklepu)$/);
    }
  });
  it('zachowuje wcześniej akceptowaną pustą tablicę instancje', () => {
    const mapowanie = { instancje: [], poPozycji: [] };
    expect(konfiguracjaKanalow(definicje, { ...env, DEMO_MAPOWANIE: JSON.stringify(mapowanie) }).sklepy.demo.mapowanie).toEqual(mapowanie);
  });
  it('odmawia tablic klucza lub prefiksu, które przez coercion omijają unikalność', () => {
    const zObejściem = [
      { klucz: ['polnoc'], typ: 'woo', prefiks: ['SHARED'] },
      { klucz: ['poludnie'], typ: 'woo', prefiks: ['SHARED'] },
    ];
    expect(() => definicjeKanalow({ OMS_KANALY: JSON.stringify(zObejściem) })).toThrow('OMS_KANALY: błędna albo powtórzona definicja');
    for (const wpis of [
      { klucz: ['demo'], typ: 'woo', prefiks: 'DEMO' },
      { klucz: 'demo', typ: 'woo', prefiks: ['DEMO'] },
      { klucz: 'demo', typ: ['woo'], prefiks: 'DEMO' },
    ]) expect(() => definicjeKanalow({ OMS_KANALY: JSON.stringify([wpis]) })).toThrow('OMS_KANALY: błędna albo powtórzona definicja');
  });
  it('poprawne definicje i mapowanie zachowują wynik oraz dotychczasowe domyślne wartości', () => {
    expect(definicjeKanalow({ OMS_KANALY: JSON.stringify(definicje) })).toEqual(definicje);
    const mapowanie = { instancje: {}, poPozycji: [] };
    expect(konfiguracjaKanalow(definicje, { ...env, DEMO_MAPOWANIE: JSON.stringify(mapowanie) })).toEqual({
      sklepy: { demo: { baseUrl: 'https://example.test', ck: 'test', cs: 'test', mapowanie, od: '2026-01-01T00:00:00', historia: null } },
      kanaly: {}, odstepMs: 120000, definicje,
    });
  });
});
