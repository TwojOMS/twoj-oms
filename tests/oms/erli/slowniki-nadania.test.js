import { expect, it, vi } from 'vitest';
import { createSlownikiErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';

const metoda = { id: 'nowa', name: 'Nowa metoda', vendor: 'dpd' };
function klient() { return { metodyErli: vi.fn(async () => []), metodyDostawy: vi.fn(async () => [metoda]) }; }
it('nieznany przed odświeżeniem, znany po; dokładnie jedno odświeżenie na przebieg', async () => {
  const k = klient(); k.metodyDostawy.mockResolvedValueOnce([]);
  const s = createSlownikiErli(k);
  await s.przygotuj([]);
  expect(s.rozpoznaj({ typeId: 'nowa' }).droga).toBe('blokada');
  await s.przygotuj([{ delivery: { typeId: 'nowa' } }, { delivery: { typeId: 'inna' } }]);
  expect(s.rozpoznaj({ typeId: 'nowa' })).toEqual({ droga: 'umowa', kurier: 'dpd', metoda });
  expect(k.metodyDostawy).toHaveBeenCalledTimes(2);
  expect(k.metodyErli).toHaveBeenCalledTimes(2);
});
it('trwale nieznany po odświeżeniu zostaje blokadą, bez pętli', async () => {
  const k = klient(), s = createSlownikiErli(k);
  await s.przygotuj([{ delivery: { typeId: 'inna', name: 'Obca' } }]);
  expect(k.metodyErli).toHaveBeenCalledTimes(1);
  expect(s.rozpoznaj({ typeId: 'inna', name: 'Obca' })).toMatchObject({ droga: 'blokada', komunikat: expect.stringContaining('Obca (inna)') });
});
it('nieznana metoda otwarta na karcie czeka na następny przebieg, bez HTTP podczas odczytu', async () => {
  const k = klient(), s = createSlownikiErli(k);
  k.metodyDostawy.mockResolvedValueOnce([]);
  await s.przygotuj([]);
  expect(s.rozpoznaj({ typeId: 'nowa' }).droga).toBe('blokada');
  expect(k.metodyDostawy).toHaveBeenCalledTimes(1);
  await s.przygotuj([]);
  expect(s.rozpoznaj({ typeId: 'nowa' }).droga).toBe('umowa');
  expect(k.metodyDostawy).toHaveBeenCalledTimes(2);
});
it('odświeża raz na dobę, osobno dla każdej instancji kanału', async () => {
  let ms = 0; const k = klient(), s = createSlownikiErli(k, () => new Date(ms));
  expect(s.rozpoznaj({ typeId: 'nowa' })).toBeNull();
  await s.przygotuj([]); await s.przygotuj([{ delivery: { typeId: 'nowa' } }]);
  expect(k.metodyErli).toHaveBeenCalledTimes(1);
  ms = 86400000; await s.przygotuj([]);
  expect(k.metodyErli).toHaveBeenCalledTimes(2);
  expect(createSlownikiErli(klient()).rozpoznaj({ typeId: 'nowa' })).toBeNull();
});
it('HTTP niedostępny zachowuje wcześniej pobrany słownik; nie ujawnia treści błędu', async () => {
  let ms = 0; const k = klient(), s = createSlownikiErli(k, () => new Date(ms));
  await s.przygotuj([]);
  k.metodyErli.mockRejectedValue(new Error('sekret-testowy'));
  ms = 86400000;
  await expect(s.przygotuj([{ delivery: { typeId: 'nowa' } }])).resolves.toBeUndefined();
  expect(s.rozpoznaj({ typeId: 'nowa' })).toEqual({ droga: 'umowa', kurier: 'dpd', metoda });
  expect(JSON.stringify(s.rozpoznaj({ typeId: 'obca' }))).not.toContain('sekret-testowy');
  expect(k.metodyErli).toHaveBeenCalledTimes(2);
});
it('nieznany typeId w paczce zamówień sam wywołuje jedno odświeżenie (bez odczytu karty)', async () => {
  const k = klient(); k.metodyDostawy.mockResolvedValueOnce([]);
  const s = createSlownikiErli(k);
  await s.przygotuj([]);
  await s.przygotuj([{ delivery: { typeId: 'nowa' } }, { delivery: { typeId: 'nowa' } }, { delivery: { typeId: 'inna' } }]);
  expect(k.metodyDostawy).toHaveBeenCalledTimes(2);
  expect(s.rozpoznaj({ typeId: 'nowa' })).toEqual({ droga: 'umowa', kurier: 'dpd', metoda });
});
