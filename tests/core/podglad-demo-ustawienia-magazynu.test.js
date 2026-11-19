import { describe, it, expect } from 'vitest';
import { wUstawieniach } from '../../src/core/bezpieczenstwo/podglad-demo.js';

describe('podgląd demo: zakres ustawień', () => {
  it.each([
    '/ustawienia',
    '/ustawienia/firma',
    '/magazyn/ustawienia',
    '/magazyn/ustawienia/parametry/3/usun?x=1',
    '/magazyn/%75stawienia/parametry',
    '/magazyn/%E0%A4%A',
    '/magazyn/cenniki',
    '/magazyn/cenniki/3/usun',
    '/magazyn/%63enniki/nowy',
  ])('adres %s liczy się do ustawień', (adres) => expect(wUstawieniach(adres)).toBe(true));
  it.each(['/magazyn', '/magazyn/producenci', '/magazyn/ustawieniaX', '/magazyn/cennikiX'])(
    'adres %s nie jest ustawieniami',
    (adres) => expect(wUstawieniach(adres)).toBe(false),
  );
});
