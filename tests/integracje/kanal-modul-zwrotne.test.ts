import { describe, expect, it, vi } from 'vitest';
import { MODULY_KANALOW } from '../../src/domena/moduly-kanalow.ts';
import { sprawdzZapisZwrotny, zwrotneAllegro, zwrotneSklepu, zwrotneZamowienia } from '../../src/integracje/kanal-modul.ts';

describe('kontrakt zapisu zwrotnego', () => {
  it('odrzuca wyslane bez ustawStatus', () => {
    expect(() => sprawdzZapisZwrotny(MODULY_KANALOW.woo, {})).toThrow(/woo.*statusZwrotny.*ustawStatus/);
  });
  it('odrzuca brak z ustawStatus', () => {
    const opis = { ...MODULY_KANALOW.woo, umiejetnosci: { ...MODULY_KANALOW.woo.umiejetnosci, statusZwrotny: 'brak' as const } };
    expect(() => sprawdzZapisZwrotny(opis, { ustawStatus: vi.fn() })).toThrow(/woo.*statusZwrotny.*ustawStatus/);
    expect(() => sprawdzZapisZwrotny(opis, {})).not.toThrow();
  });
  it.each(['woo', 'allegro'] as const)('przyjmuje poprawny zapis %s bez wywołania klienta', (typ) => {
    const ustawStatus = vi.fn();
    expect(() => sprawdzZapisZwrotny(MODULY_KANALOW[typ], { ustawStatus })).not.toThrow();
    expect(ustawStatus).not.toHaveBeenCalled();
  });
  it('adaptery zachowują argumenty, kontekst i wynik klienta', async () => {
    const klient = {
      wynik: { ok: true },
      ustawStatus: vi.fn(async function (this: { wynik: object }, _id: string, _status: string) { return this.wynik; }),
      ustawStatusRealizacji: vi.fn(async function (this: { wynik: object }, _id: string, _status: string) { return this.wynik; }),
    };
    expect(await zwrotneAllegro(klient).ustawStatus!('1000001', 'SENT')).toBe(klient.wynik);
    expect(await zwrotneSklepu(klient).ustawStatus!('1000001', 'completed')).toBe(klient.wynik);
    expect(klient.ustawStatusRealizacji.mock.calls).toEqual([['1000001', 'SENT']]);
    expect(klient.ustawStatus.mock.calls).toEqual([['1000001', 'completed']]);
  });
  it('wybiera adapter po module zamówienia', async () => {
    const klient = { ustawStatus: vi.fn(), ustawStatusRealizacji: vi.fn() };
    await zwrotneZamowienia({ sklep: 'allegro_polcien' }, klient).ustawStatus!('1000001', 'SENT');
    await zwrotneZamowienia({ sklep: 'polcien' }, klient).ustawStatus!('1000001', 'completed');
    expect(klient.ustawStatusRealizacji).toHaveBeenCalledTimes(1);
    expect(klient.ustawStatus).toHaveBeenCalledTimes(1);
  });
});
