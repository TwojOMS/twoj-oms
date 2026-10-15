import { describe, it, expect } from 'vitest';
import { createDpdClient, createInpostClient, createAllegroWzaClient, createWooAdapter, createAllegroAdapter } from '../../src/integracje/fabryki.ts';

// Ten plik jest także wejściem tsc. Rzeczywisty konsument wykrywa wejście
// typu never, którego samo satisfies na wyniku fabryki nie wykryje.
describe('fabryki mają używalne typy wejścia', () => {
  it('przyjmuje konfigurację trzech kurierów bez rzutowania', () => {
    const nadawca = { nazwa: 'Test', ulica: 'Testowa 1', kod: '00-001', miasto: 'Test', kraj: 'PL', phone: '+48500100200', email: 'test@przyklad.invalid' };
    const dpd = createDpdClient({ url: 'https://przyklad.invalid', login: 'test', haslo: 'test', fid: '1', infoUrl: 'https://przyklad.invalid/info', channel: '1', nadawca });
    const inpost = createInpostClient({ url: 'https://przyklad.invalid', token: 'test', organizacja: 1, nadawca, paczkomatNadawczy: null });
    const wza = createAllegroWzaClient({ allegroDla: () => null, metodaZywa: async () => null, pobranieNadawca: { nazwa: 'Test', rachunek: 'test' } });
    expect(typeof dpd.nadaj).toBe('function');
    expect(typeof inpost.nadaj).toBe('function');
    expect(typeof wza.nadaj).toBe('function');
  });
  it('przyjmuje konfigurację dwóch adapterów bez rzutowania', async () => {
    const woo = createWooAdapter({ woo: { pobierzZamowienia: async () => ({ zamowienia: [], stron: 0 }) }, mapowanie: {} });
    const allegro = createAllegroAdapter({ klient: { pobierzZamowienia: async () => ({ zamowienia: [], stron: 0 }) } });
    expect(await woo.pobierzStrone({ kursor: null, od: null, strona: 1 })).toEqual({ zamowienia: [], stron: 0 });
    expect(await allegro.pobierzStrone({ kursor: null, od: null, strona: 1 })).toEqual({ zamowienia: [], stron: 0 });
  });
});
