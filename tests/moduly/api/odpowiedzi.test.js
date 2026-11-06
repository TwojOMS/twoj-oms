import { describe, expect, it } from 'vitest';
import { blad, czytajStronicowanie, strona } from '../../../src/moduly/api/odpowiedzi.js';

describe('odpowiedzi API v1', () => {
  it('wysyła błąd z kodem HTTP i polskim powodem', () => {
    const reply = { code(status) { this.status = status; return this; }, send(body) { this.body = body; return this; } };
    expect(blad(reply, 403, 'brak_zakresu', 'Brak zakresu.')).toBe(reply);
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ kod: 'brak_zakresu', powod: 'Brak zakresu.' });
  });
  it('czyta domyślne i jawne stronicowanie', () => {
    expect(czytajStronicowanie({})).toEqual({ po: 0, ile: 100 });
    expect(czytajStronicowanie({ po: '30', ile: '200' })).toEqual({ po: 30, ile: 200 });
    expect(czytajStronicowanie({ ile: '1' })).toEqual({ po: 0, ile: 1 });
  });
  it.each(['201', '0', 'x', '-1', '1.5', '', 'Infinity', '1e2', ' 5', ['1', '2']])( 'odrzuca ile=%s błędem 400', ile => {
    expect(() => czytajStronicowanie({ ile })).toThrow(expect.objectContaining({
      statusCode: 400, kod: 'stronicowanie', message: expect.any(String),
    }));
  });
  it.each(['abc', '-5', '1.5', '', '1e3', ['1', '2'], '9007199254740992'])( 'odrzuca po=%s błędem 400', po => {
    expect(() => czytajStronicowanie({ po })).toThrow(expect.objectContaining({
      statusCode: 400, kod: 'stronicowanie', message: expect.stringContaining('po'),
    }));
  });
  it('pełna strona wskazuje ostatnie id, niepełna kończy listę', () => {
    const pozycje = [{ id: 4 }, { id: 9 }, { id: 30 }];
    expect(strona(pozycje, 3)).toEqual({ pozycje, nastepny: 30 });
    expect(strona(pozycje, 5)).toEqual({ pozycje, nastepny: null });
    expect(strona([], 3)).toEqual({ pozycje: [], nastepny: null });
  });
});
