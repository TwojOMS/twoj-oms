import { describe, it, expect } from 'vitest';
import { createVies } from '../../src/oms/services/vies.js';

// Kształt odpowiedzi VIES zmierzony 26.08.2026 na żywym API dla SK1000000001.
const ODPOWIEDZ_WAZNA = {
  isValid: true,
  requestDate: '2026-08-26T16:25:44.909Z',
  userError: 'VALID',
  name: 'ALFATREND s.r.o.',
  address: '1. mája 1\n02901 Žilina\nSlovensko',
  requestIdentifier: 'WAPIAAAAY123456',
};

function fakeFetch(odpowiedz, { status = 200, rzuca = false } = {}) {
  const wywolania = [];
  const f = async (url) => {
    wywolania.push(String(url));
    if (rzuca) throw new Error('sieć padła');
    return { ok: status < 400, status, json: async () => odpowiedz };
  };
  f.wywolania = wywolania;
  return f;
}

describe('createVies().sprawdz', () => {
  it('ważny numer: oddaje wynik, nazwę, adres i numer konsultacji', async () => {
    const fetchImpl = fakeFetch(ODPOWIEDZ_WAZNA);
    const vies = createVies({ fetchImpl, nipSprzedawcy: '1234563218' });
    const w = await vies.sprawdz('SK1000000001');
    expect(w.wynik).toBe('wazny');
    expect(w.nazwa).toBe('ALFATREND s.r.o.');
    expect(w.numerKonsultacji).toBe('WAPIAAAAY123456');
    expect(w.dataZapytania).toBe('2026-08-26T16:25:44.909Z');
  });

  it('pyta właściwy adres, z identyfikacją pytającego (numer konsultacji jest dowodem)', async () => {
    const fetchImpl = fakeFetch(ODPOWIEDZ_WAZNA);
    await createVies({ fetchImpl, nipSprzedawcy: '1234563218' }).sprawdz('SK1000000001');
    expect(fetchImpl.wywolania[0]).toBe(
      'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/SK/vat/1000000001'
      + '?requesterMemberStateCode=PL&requesterNumber=1234563218',
    );
  });

  it('isValid false = numer NIEWAŻNY — to jedyna droga do odmowy stawki 0%', async () => {
    const fetchImpl = fakeFetch({ ...ODPOWIEDZ_WAZNA, isValid: false, userError: 'INVALID', name: '---' });
    const w = await createVies({ fetchImpl, nipSprzedawcy: '1234563218' }).sprawdz('SK1000000001');
    expect(w.wynik).toBe('niewazny');
  });

  // VIES bywa niedostępny per państwo członkowskie — wtedy `isValid` też jest false,
  // ale to NIE znaczy „numer nieważny". Rozstrzyga `userError`.
  it('userError MS_UNAVAILABLE przy isValid false → niedostępny, NIE nieważny', async () => {
    const fetchImpl = fakeFetch({ isValid: false, userError: 'MS_UNAVAILABLE', name: '---' });
    const w = await createVies({ fetchImpl, nipSprzedawcy: '1234563218' }).sprawdz('SK1000000001');
    expect(w.wynik).toBe('niedostepny');
  });

  it('padnięta sieć i HTTP 5xx → niedostępny, nigdy wyjątek', async () => {
    const zSiecia = createVies({ fetchImpl: fakeFetch(null, { rzuca: true }), nipSprzedawcy: '1234563218' });
    expect((await zSiecia.sprawdz('SK1000000001')).wynik).toBe('niedostepny');
    const z500 = createVies({ fetchImpl: fakeFetch({}, { status: 500 }), nipSprzedawcy: '1234563218' });
    expect((await z500.sprawdz('SK1000000001')).wynik).toBe('niedostepny');
  });

  it('numer krajowy → niedostępny bez ani jednego zapytania (nie ma czego pytać)', async () => {
    const fetchImpl = fakeFetch(ODPOWIEDZ_WAZNA);
    const w = await createVies({ fetchImpl, nipSprzedawcy: '1234563218' }).sprawdz('1000001106');
    expect(w.wynik).toBe('niedostepny');
    expect(fetchImpl.wywolania).toHaveLength(0);
  });
});
