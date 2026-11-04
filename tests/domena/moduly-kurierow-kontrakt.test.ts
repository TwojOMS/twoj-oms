import { describe, expect, it } from 'vitest';
import type { OpisKuriera, OpisPrzewoznika } from '../../src/core/kontrakty.ts';
import { MODULY_KURIEROW, modulKuriera, kurierDlaMetody, metodyKurierow,
  METODA_DOMYSLNA, KURIER_DOMYSLNY, sprawdzOpisyKurierow } from '../../src/domena/moduly-kurierow.ts';
import { OPISY_PRZEWOZNIKOW } from '../../src/domena/przewoznicy.ts';

const kopia = (): Record<string, OpisKuriera> => Object.fromEntries(
  Object.entries(MODULY_KURIEROW).map(([k, v]) => [k, {
    ...v, metody: v.metody.map(m => ({ ...m })), przewoznicy: [...v.przewoznicy],
    piaskownica: { ...v.piaskownica }, konfigurator: { ...v.konfigurator },
  }]),
);

describe('strażnik opisów kurierów — D5', () => {
  it.each<[string, (r: Record<string, OpisKuriera>) => void, RegExp]>([
    ['klucz rejestru', r => { r.DPD = r.dpd!; delete r.dpd; }, /DPD:.*klucz/],
    ['klucz opisu', r => { r.dpd!.klucz = 'DPD'; }, /dpd:.*klucz/],
    ['zgodność klucza z rejestrem', r => { r.dpd!.klucz = 'inny'; }, /dpd:.*klucz/],
    ['klucz metody', r => { r.dpd!.metody = [{ ...r.dpd!.metody[0]!, klucz: 'DPD!' }]; }, /dpd:.*metody/],
    ['powtórzona metoda', r => { r.inpost!.metody = r.dpd!.metody; }, /inpost:.*metody.*dpd/],
    ['powtórzona metoda jednego kuriera', r => { r.dpd!.metody = [...r.dpd!.metody, ...r.dpd!.metody]; }, /dpd:.*metody/],
    ['Allegro na własnej umowie', r => { r.dpd!.metody = [{ ...r.dpd!.metody[0]!, klucz: 'allegro_test' }]; }, /dpd:.*metody.*umowa/],
    ['zwykła metoda na umowie platformy', r => { r.allegro_wza!.metody = [{ ...r.dpd!.metody[0]!, klucz: 'inna' }]; }, /allegro_wza:.*metody.*umowa/],
    ['brak atrapy', r => { r.dpd!.piaskownica.atrapa = '  '; }, /dpd:.*piaskownica.atrapa/],
    ['brak konfiguratora', r => { r.inpost!.konfigurator.sciezka = ''; }, /inpost:.*konfigurator.sciezka/],
    ['klucz przewoźnika', r => { r.dpd!.przewoznicy = ['DPD']; }, /dpd:.*przewoznicy.*DPD/],
    ['nieznany przewoźnik', r => { r.dpd!.przewoznicy = ['nieznany']; }, /dpd:.*przewoznicy.*nieznany/],
    ['właściwość prototypu jako przewoźnik', r => { r.dpd!.przewoznicy = ['constructor']; }, /dpd:.*przewoznicy.*constructor/],
  ])('%s', (_nazwa, zepsuj, blad) => {
    const r = kopia(); zepsuj(r);
    expect(() => sprawdzOpisyKurierow(r)).toThrow(blad);
  });

  it('sprawdza także klucz i tożsamość wpisu w rejestrze przewoźników', () => {
    for (const [klucz, opis] of [['DPD', { ...OPISY_PRZEWOZNIKOW.dpd }],
      ['dpd', { ...OPISY_PRZEWOZNIKOW.dpd, klucz: 'inny' }]] as const) {
      const przewoznicy: Record<string, OpisPrzewoznika> = { ...OPISY_PRZEWOZNIKOW, [klucz]: opis };
      expect(() => sprawdzOpisyKurierow(MODULY_KURIEROW, przewoznicy)).toThrow(/dpd:.*przewoznicy.*klucz/i);
    }
  });
  // D5.3: zgodność z metodami adapterów sprawdza dopiero kontrakt składania w zmianie 04b.
  it('przyjmuje rejestr produkcyjny oraz kuriera tylko do śledzenia bez atrapy', () => {
    expect(() => sprawdzOpisyKurierow(MODULY_KURIEROW)).not.toThrow();
    const r = kopia(); r.allegro!.piaskownica.atrapa = ''; r.allegro!.konfigurator.sciezka = '';
    expect(() => sprawdzOpisyKurierow(r)).not.toThrow();
  });
});

describe('dane zachowują dzisiejsze tablice (PRZ-135.01)', () => {
  it.each([
    ['dpd', 'dpd'], ['inpost_paczkomat', 'inpost'], ['odbior_osobisty', null],
    ['allegro_dpd', 'allegro_wza'], ['allegro_paczkomat', null],
    ['allegro_punkt', 'allegro_wza'], ['allegro_kurier', 'allegro_wza'], ['allegro_inne', 'allegro_wza'],
  ])('%s → %s', (metoda, kurier) => { expect(kurierDlaMetody(metoda)).toBe(kurier); });

  it('umiejętności: pobranie, asynchroniczność, śledzenie i ZPL', () => {
    expect(Object.fromEntries(Object.entries(MODULY_KURIEROW).map(([k, v]) => [k, v.umiejetnosci])))
      .toEqual({
        dpd: { pobranie: 'umowa', pobranieNaDosylce: true, nadanieAsynchroniczne: false, sledzenie: 'wlasne', etykieta: { zpl: true, zplPrzyNadaniu: true } },
        inpost: { pobranie: 'adapter', pobranieNaDosylce: true, nadanieAsynchroniczne: true, sledzenie: 'wlasne', etykieta: { zpl: true, zplPrzyNadaniu: true } },
        allegro_wza: { pobranie: 'umowa', pobranieNaDosylce: false, nadanieAsynchroniczne: true, sledzenie: 'przez_przewoznika', etykieta: { zpl: true, zplPrzyNadaniu: false } },
        allegro: { pobranie: 'brak', pobranieNaDosylce: false, nadanieAsynchroniczne: false, sledzenie: 'wlasne', etykieta: { zpl: false, zplPrzyNadaniu: false } },
      });
  });
  it('kolejność metod, wybór i wartości domyślne', () => {
    expect(metodyKurierow().map(m => m.klucz)).toEqual(['dpd', 'inpost_paczkomat', 'allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne']);
    expect(metodyKurierow().filter(m => m.etykietaWyboru).map(m => [m.klucz, m.etykietaWyboru]))
      .toEqual([['dpd', 'DPD — nasza umowa'], ['inpost_paczkomat', 'Paczkomat InPost — nasza umowa']]);
    expect(METODA_DOMYSLNA).toBe('dpd'); expect(KURIER_DOMYSLNY).toBe('dpd');
    expect(modulKuriera('dpd')).toBe(MODULY_KURIEROW.dpd);
    for (const k of ['constructor', '__proto__', 'nieznany', null]) expect(() => modulKuriera(k)).toThrow();
    for (const m of ['constructor', '__proto__', 'nieznana', '', null]) expect(kurierDlaMetody(m)).toBeNull();
  });
});
