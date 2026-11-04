// PRZ-149.04 (C8): Magazyn → Synchronizuj przy sklepie „Odczyt”. Zapis SKU/wymiarów NIE idzie do sklepu
// (ani nawet odczyt przed zapisem) — każda zmiana wraca z jawnym komunikatem, nie z „zapisano”.
import { describe, it, expect, vi } from 'vitest';
import { wyslijDoSklepow } from '../../../src/moduly/magazyn/services/magazyn-zapis.js';
import { TYLKO_ODCZYT } from '../../../src/domena/woo-uprawnienia.js';

const zmiana = (nad = {}) => ({ kanal: 'pro', sciezka: 'products/900', pola: { sku: 'PC-LAMPA-01' }, ...nad });
const klient = (nad = {}) => ({
  pobierzProdukt: vi.fn().mockResolvedValue({ sku: '' }),
  zapiszProdukt: vi.fn().mockResolvedValue({}),
  ustawienieSklepu: vi.fn().mockResolvedValue('cm'),
  ...nad,
});

describe('PRZ-149.04: zapis do sklepu „Odczyt” z Magazynu', () => {
  it('nie woła sklepu i oddaje komunikat przy każdej zmianie', async () => {
    const pro = klient({ tylkoOdczyt: true });
    const wyniki = await wyslijDoSklepow({ sklepy: { pro }, zmiany: [zmiana(), zmiana({ sciezka: 'products/901' })] });
    expect(pro.zapiszProdukt).not.toHaveBeenCalled();
    expect(pro.pobierzProdukt).not.toHaveBeenCalled();
    expect(wyniki.map((w) => [w.ok, w.blad])).toEqual([[false, TYLKO_ODCZYT], [false, TYLKO_ODCZYT]]);
  });

  it('sklep „Zapis/odczyt” zapisuje jak dotąd', async () => {
    const pro = klient();
    const wyniki = await wyslijDoSklepow({ sklepy: { pro }, zmiany: [zmiana()] });
    expect(pro.zapiszProdukt).toHaveBeenCalledWith('products/900', { sku: 'PC-LAMPA-01' });
    expect(wyniki[0].ok).toBe(true);
  });
});
