import { describe, it, expect } from 'vitest';
import { podepnij } from '../../src/public/nowa-karta-ceny.js';
import * as ceny from '../../src/domena/cena-sprzedazy.js';

// Formularz „Nowy produkt” liczy ceny na żywo modułem domeny, który serwer podaje pod
// /public/domena/. Tu skrypt dostaje ten sam moduł, którym serwer zapisuje cenę, i na atrapach
// elementów (repo nie ma biblioteki DOM) sprawdzamy, że pola pokazują to, co zostanie zapisane.

function strona({ zakup = '', netto = '', brutto = '', vat = '' } = {}) {
  const el = (wartosci) => {
    const obsluga = {};
    return {
      ...wartosci,
      disabled: false,
      hidden: false,
      textContent: '',
      addEventListener: (typ, fn) => {
        obsluga[typ] = fn;
      },
      wyslij(typ, wartosc) {
        if (wartosc !== undefined) this.value = wartosc;
        obsluga[typ]?.({ target: this });
      },
    };
  };
  const pola = {
    'nowa-zakup': el({ value: zakup }),
    'nowa-netto': el({ value: netto }),
    'nowa-cena': el({ value: brutto }),
    'nowa-vat': el({ value: vat }),
    'nowa-netto-pomoc': el({}),
    'nowa-marza': el({}),
  };
  const dokument = {
    querySelector: (s) => (s === 'form[data-ceny]' ? { dataset: { ceny: '/public/domena/cena-sprzedazy.js' } } : null),
    getElementById: (id) => pola[id] ?? null,
  };
  podepnij(dokument, ceny);
  return {
    zakup: pola['nowa-zakup'],
    netto: pola['nowa-netto'],
    brutto: pola['nowa-cena'],
    vat: pola['nowa-vat'],
    pomoc: pola['nowa-netto-pomoc'],
    marza: pola['nowa-marza'],
  };
}

describe('nowa-karta-ceny — przeliczanie na żywo', () => {
  it('wpisane netto pokazuje brutto, które zapisze serwer (także połówka grosza)', () => {
    const przypadki = [
      ['10,00', '23'],
      ['10,005', '23'],
      ['0,50', '23'],
      ['99,99', '8'],
      ['0,10', '5'],
      ['1234,56', '0'],
      ['2.675', '23'],
    ];
    for (const [netto, vat] of przypadki) {
      const s = strona({ vat });
      s.netto.wyslij('input', netto);
      const zapis = ceny.cenaSprzedazyZFormularza({ netto, brutto: '', stawka: vat });
      expect(s.brutto.value).toBe((zapis.cena_gr / 100).toFixed(2).replace('.', ','));
      expect(ceny.cenaSprzedazyZFormularza({ brutto: s.brutto.value, stawka: vat }).cena_gr).toBe(zapis.cena_gr);
    }
  });

  it('wpisane brutto pokazuje netto i nie zmienia samego brutto', () => {
    const s = strona({ vat: '23' });
    s.brutto.wyslij('input', '28,90');
    expect(s.netto.value).toBe('23,50');
    expect(s.brutto.value).toBe('28,90');
  });

  it('zmiana VAT przelicza od pola wpisanego ostatnio', () => {
    const s = strona({ vat: '23' });
    s.netto.wyslij('input', '10,00');
    s.vat.wyslij('change', '8');
    expect(s.brutto.value).toBe('10,80');
    s.brutto.wyslij('input', '12,30');
    s.vat.wyslij('change', '23');
    expect(s.netto.value).toBe('10,00');
    expect(s.brutto.value).toBe('12,30');
  });

  it('bez VAT pole netto jest nieaktywne i pokazuje podpowiedź', () => {
    const s = strona({ brutto: '12,30' });
    expect(s.netto.disabled).toBe(true);
    expect(s.pomoc.hidden).toBe(false);
    s.vat.wyslij('change', '23');
    expect(s.netto.disabled).toBe(false);
    expect(s.pomoc.hidden).toBe(true);
    expect(s.netto.value).toBe('10,00');
    s.vat.wyslij('change', '');
    expect(s.netto.disabled).toBe(true);
    expect(s.pomoc.hidden).toBe(false);
  });

  it('po powrocie formularza z błędem liczy od tego, co było wpisane', () => {
    const s = strona({ netto: '10,00', vat: '23' });
    expect(s.brutto.value).toBe('12,30');
  });

  it('pokazuje marżę z ceny zakupu i ceny netto, tylko jako podgląd', () => {
    const s = strona({ vat: '23' });
    s.zakup.wyslij('input', '7,50');
    expect(s.marza.textContent).toBe('');
    s.brutto.wyslij('input', '12,30');
    expect(s.marza.textContent).toBe('Marża: 2,50 zł netto (25,0%)');
    s.vat.wyslij('change', '');
    expect(s.marza.textContent).toBe('');
  });
});
