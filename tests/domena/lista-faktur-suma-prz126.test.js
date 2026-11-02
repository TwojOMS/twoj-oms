import { describe, it, expect } from 'vitest';
import { sumaListy, filtrujDokumenty } from '../../src/domena/lista-faktur.js';
import { zlozPaczke } from '../../src/domena/paczka-dla-biura.js';

const dok = (rodzaj, gross_price, net_price, reszta = {}) => ({
  rodzaj, gross_price, net_price, tax_price: gross_price - net_price,
  invoice_date: '2026-10-12', sale_date: '2026-10-12', ...reszta,
});
const lista = [dok('vat', 13400, 10895), dok('vat', 17700, 14391), dok('korekta', -8400, -6830)];

describe('suma i filtry listy faktur P36e', () => {
  it('sumuje różnice korekt ze znakiem w całkowitych groszach, zgodnie z paczką', () => {
    expect(sumaListy(lista)).toEqual({ PLN: { nettoGr: 18456, bruttoGr: 22700 }, ile: 3, niepelne: false });
    const paczka = zlozPaczke({ miesiac: '2026-10', faktury: lista.filter(d => d.rodzaj === 'vat'), korekty: lista.filter(d => d.rodzaj === 'korekta') });
    expect(sumaListy(lista).PLN.bruttoGr).toBe(paczka.sumy.sprzedaz.PLN.bruttoGr);
  });

  it('pomija parę zamiany, zostawia nową, oddziela EUR i sygnalizuje brak kwoty', () => {
    const zamiana = [dok('vat', 10000, 8130, { zastapiona_przez: 'nowa' }),
      dok('korekta', -10000, -8130, { zastepujaca: true }), dok('vat', 10000, 8130)];
    expect(sumaListy(zamiana)).toEqual({ PLN: { nettoGr: 8130, bruttoGr: 10000 }, ile: 3, niepelne: false });
    // D9: przy filtrze typu para zamiany rozjechałaby się (stara 10000 bez swojej korekty) — dlatego zawsze poza sumą.
    expect(sumaListy(filtrujDokumenty(zamiana, { typ: 'vat' })))
      .toEqual({ PLN: { nettoGr: 8130, bruttoGr: 10000 }, ile: 2, niepelne: false });
    expect(sumaListy(filtrujDokumenty(zamiana, { typ: 'korekta' }))).toEqual({ ile: 1, niepelne: false });
    expect(sumaListy([...lista, ...zamiana, dok('vat', undefined, 800), dok('vat', 123, 100, { currency: ' eur ' })]))
      .toEqual({ PLN: { nettoGr: 26586, bruttoGr: 32700 }, EUR: { nettoGr: 100, bruttoGr: 123 }, ile: 8, niepelne: true });
    expect(sumaListy([dok('vat', 100, 80, { tax_price: null })]).niepelne).toBe(true);
  });

  it('filtruje typ i płatność po regule listy, bez korekt i zastąpionych', () => {
    const dokumenty = [dok('vat', 100, 80, { status: 'paid', left_to_pay: 100 }),
      dok('vat', 100, 80, { left_to_pay: 0 }), dok('vat', 100, 80, { left_to_pay: 10 }),
      dok('vat', 100, 80), dok('korekta', -100, -80), dok('vat', 100, 80, { zastapiona_przez: 'x' })];
    expect(filtrujDokumenty(dokumenty, { typ: 'korekta' })).toEqual([dokumenty[4]]);
    expect(filtrujDokumenty(dokumenty, { platnosc: 'niezaplacona' })).toEqual(dokumenty.slice(2, 4));
    expect(filtrujDokumenty(dokumenty, { platnosc: 'zaplacona' })).toEqual(dokumenty.slice(0, 2));
    expect(filtrujDokumenty(dokumenty, { typ: 'xyz', platnosc: 'xyz' })).toEqual(dokumenty);
  });
});
