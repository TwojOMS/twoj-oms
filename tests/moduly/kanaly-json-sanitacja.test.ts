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
  it('wadliwy OMS_KANALY oddaje nazwę i powód, ale nie przepisuje wartości z wejścia', () => {
    const m = komunikat(() => definicjeKanalow({ OMS_KANALY: `${sekret}{` }));
    expect(m).toContain('OMS_KANALY: niepoprawny JSON');
    expect(m).toContain('zaczynać się od znaku [');
    expect(m).not.toContain(sekret);
    // Parser V8 cytuje fragment wejścia w „Unexpected token” — komunikat OMS-u nie może go powtórzyć.
    expect(m).not.toContain('SYNTHETIC');
  });
  it('niepoprawny JSON wskazuje numer znaku (od 1), a pusty tekst mówi, co wpisać (PRZ-093.04)', () => {
    const tekst = '[{"klucz":"a","typ":"woo","prefiks":"A",}]';
    const m = komunikat(() => definicjeKanalow({ OMS_KANALY: tekst }));
    expect(m).toContain(`błąd w znaku nr ${tekst.indexOf('}') + 1}`);
    expect(m).toContain('docs/instalacja-docker.md, sekcja 9');
    expect(m).toContain('"klucz":"woo_sklep"');
    expect(komunikat(() => definicjeKanalow({ OMS_KANALY: '' }))).toContain('wartość jest pusta — wpisz []');
    expect(komunikat(() => definicjeKanalow({ OMS_KANALY: '[{"klucz":"a"' }))).toContain('brakuje zamknięcia');
  });
  it('definicja nie jest listą: mówi, czego oczekiwano', () => {
    expect(komunikat(() => definicjeKanalow({ OMS_KANALY: '{"klucz":"a"}' }))).toMatch(/oczekiwano listy kanałów w nawiasach \[ \].*sekcja 9/);
  });
  describe('błąd pozycji wskazuje numer (od 1), klucz kanału i pole (PRZ-093.04)', () => {
    const ok = { klucz: 'woo_a', typ: 'woo', prefiks: 'WOO_A' };
    const blad = (...pozycje: unknown[]) => komunikat(() => definicjeKanalow({ OMS_KANALY: JSON.stringify(pozycje) }));
    it('zły typ w drugiej pozycji', () => {
      const m = blad(ok, { klucz: 'b', typ: 'sklep', prefiks: 'B' });
      expect(m).toContain('pozycja 2 (klucz „b”)');
      expect(m).toContain('pole „typ”');
      expect(m).toContain('„woo” albo „allegro”');
      expect(m).not.toContain('pozycja 1');
    });
    it('zły prefiks i zły klucz', () => {
      expect(blad(ok, { klucz: 'b', typ: 'woo', prefiks: 'małe' })).toMatch(/pozycja 2 \(klucz „b”\): pole „prefiks”.*wielkich liter/);
      expect(blad({ klucz: 'Wielkie', typ: 'woo', prefiks: 'A' })).toMatch(/pozycja 1: pole „klucz”.*małych liter/);
    });
    it('powtórzony klucz i prefiks wskazują, którą wcześniejszą pozycję powtarzają', () => {
      const m = blad(ok, { klucz: 'woo_b', typ: 'woo', prefiks: 'WOO_B' }, { klucz: 'woo_a', typ: 'woo', prefiks: 'WOO_C' });
      expect(m).toContain('pozycja 3 (klucz „woo_a”)');
      expect(m).toContain('pole „klucz” powtarza pozycję 1');
      const p = blad(ok, { klucz: 'woo_b', typ: 'woo', prefiks: 'WOO_A' });
      expect(p).toContain('pozycja 2');
      expect(p).toContain('pole „prefiks” (WOO_A) powtarza pozycję 1');
    });
    it('pozycja nie będąca obiektem, nazwy zastrzeżone, etykieta i raport', () => {
      expect(blad(ok, 'tekst')).toMatch(/pozycja 2 nie jest obiektem/);
      expect(blad({ klucz: 'reczne', typ: 'woo', prefiks: 'R' })).toMatch(/pozycja 1 \(klucz „reczne”\): pole „klucz” ma nazwę zastrzeżoną/);
      expect(blad({ ...ok, etykieta: '  ' })).toMatch(/pozycja 1 \(klucz „woo_a”\): pole „etykieta”/);
      expect(blad({ ...ok, raport: 'B2B' })).toMatch(/pole „raport” \(B2B\) to nazwa zastrzeżona/);
      expect(blad({ ...ok, raport: 'RAP' }, { klucz: 'woo_b', typ: 'woo', prefiks: 'WOO_B', raport: 'RAP' })).toMatch(/pozycja 2.*pole „raport” \(RAP\) powtarza pozycję 1/);
    });
    it('wartość niedozwolona w kluczu nie trafia do komunikatu', () => {
      const m = blad({ klucz: sekret, typ: 'woo', prefiks: 'A' });
      expect(m).toContain('pozycja 1: pole „klucz”');
      expect(m).not.toContain(sekret);
    });
  });
  it('wadliwe wymagane mapowanie oddaje wyłącznie nazwę i ogólny powód', () => {
    const m = komunikat(() => konfiguracjaKanalow(definicje, { ...env, DEMO_MAPOWANIE: `${sekret}{` }));
    expect(m).toBe('DEMO_MAPOWANIE: niepoprawny JSON');
    expect(m).not.toContain(sekret);
  });
  it('null definicji, mapowania i pozycji odmawia nazwanym błędem konfiguracji', () => {
    expect(komunikat(() => definicjeKanalow({ OMS_KANALY: '[null]' }))).toMatch(/^OMS_KANALY: pozycja 1 nie jest obiektem/);
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
    expect(() => definicjeKanalow({ OMS_KANALY: JSON.stringify(zObejściem) })).toThrow(/^OMS_KANALY: pozycja 1: pole „klucz”/);
    for (const wpis of [
      { klucz: ['demo'], typ: 'woo', prefiks: 'DEMO' },
      { klucz: 'demo', typ: 'woo', prefiks: ['DEMO'] },
      { klucz: 'demo', typ: ['woo'], prefiks: 'DEMO' },
    ]) expect(() => definicjeKanalow({ OMS_KANALY: JSON.stringify([wpis]) })).toThrow(/^OMS_KANALY: pozycja 1.*: pole „(klucz|typ|prefiks)”/);
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
