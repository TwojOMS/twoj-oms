import { describe, it, expect } from 'vitest';
import { kuponyZeSurowych, kuponyZWiersza } from '../../src/domena/kupony.js';

// Kupony rabatowe ze sklepu (kampania WRZESIEN30, 2026-08-25). Woo oddaje je w
// `coupon_lines`: kod + rabat netto (`discount`) + VAT od rabatu (`discount_tax`).
// Panel pokazuje rabat BRUTTO (netto + VAT), bo wszystkie kwoty na karcie sa brutto —
// rabat w innej skali niz kwota zamowienia obok bylby liczba, ktorej nie da sie
// z niczym zestawic. Dane zgodne z prawdziwym zamowieniem 28224 (wrzesien30:
// 47.29 + 10.88 = 58.17 przy kwocie 150.72).

describe('kuponyZeSurowych', () => {
  it('sklada kod i rabat brutto (netto + VAT) z linii kuponu — zamówienie 28224', () => {
    const surowe = { coupon_lines: [{ code: 'wrzesien30', discount: '47.29', discount_tax: '10.88' }] };
    expect(kuponyZeSurowych(surowe)).toEqual([{ kod: 'wrzesien30', rabat: '58.17' }]);
  });

  it('przenosi każdą linię osobno przy dwóch kuponach', () => {
    const surowe = {
      coupon_lines: [
        { code: 'aaa', discount: '10.00', discount_tax: '2.30' },
        { code: 'bbb', discount: '5.00', discount_tax: '1.15' },
      ],
    };
    expect(kuponyZeSurowych(surowe)).toEqual([
      { kod: 'aaa', rabat: '12.30' },
      { kod: 'bbb', rabat: '6.15' },
    ]);
  });

  // Zamowienie 28196 z produkcji: kod „bombadura" naliczyl 0 zl. Kupon ISTNIEJE i ma byc
  // widoczny — klient go wpisal, a „nic nie dal" to informacja, nie brak informacji.
  it('kupon z zerowym rabatem zostaje (produkcyjne zamówienie 28196)', () => {
    const surowe = { coupon_lines: [{ code: 'bombadura', discount: '0', discount_tax: '0' }] };
    expect(kuponyZeSurowych(surowe)).toEqual([{ kod: 'bombadura', rabat: '0.00' }]);
  });

  // Allegro i atrapy w testach nie maja pola coupon_lines wcale.
  it('brak pola coupon_lines → pusta lista', () => {
    expect(kuponyZeSurowych({ id: 1 })).toEqual([]);
  });

  it('pusta tablica coupon_lines → pusta lista', () => {
    expect(kuponyZeSurowych({ coupon_lines: [] })).toEqual([]);
  });

  it('null / nie-obiekt → pusta lista', () => {
    expect(kuponyZeSurowych(null)).toEqual([]);
    expect(kuponyZeSurowych('x')).toEqual([]);
  });

  // Linia bez kodu nie ma czego pokazac — kupon to przede wszystkim KOD.
  it('linia bez kodu jest pomijana, reszta zostaje', () => {
    const surowe = {
      coupon_lines: [
        { discount: '10.00', discount_tax: '2.30' },
        { code: '', discount: '1.00', discount_tax: '0' },
        { code: 'ok', discount: '2.00', discount_tax: '0.46' },
      ],
    };
    expect(kuponyZeSurowych(surowe)).toEqual([{ kod: 'ok', rabat: '2.46' }]);
  });

  // Starsze Woo / inne wtyczki potrafia oddac liczby zamiast napisow.
  it('rabat liczbowy zamiast napisu tez się liczy', () => {
    const surowe = { coupon_lines: [{ code: 'x', discount: 47.29, discount_tax: 10.88 }] };
    expect(kuponyZeSurowych(surowe)).toEqual([{ kod: 'x', rabat: '58.17' }]);
  });

  // Kod zostaje DOKLADNIE taki, jaki zapisal sklep — panel pokazuje prawde sklepu,
  // a porownania (kampania) normalizuja sobie same.
  it('nie zmienia wielkości liter kodu', () => {
    const surowe = { coupon_lines: [{ code: 'WRZESIEN30', discount: '1.00', discount_tax: '0' }] };
    expect(kuponyZeSurowych(surowe)[0].kod).toBe('WRZESIEN30');
  });
});

describe('kuponyZWiersza', () => {
  it('parsuje kolumnę kupony_json', () => {
    expect(kuponyZWiersza('[{"kod":"wrzesien30","rabat":"58.17"}]'))
      .toEqual([{ kod: 'wrzesien30', rabat: '58.17' }]);
  });

  it('NULL (zamówienie bez kuponów) → pusta lista', () => {
    expect(kuponyZWiersza(null)).toEqual([]);
    expect(kuponyZWiersza(undefined)).toEqual([]);
  });

  // Uszkodzony JSON jednego wiersza nie ma prawa wywalic LISTY zamowien — ta sama zasada,
  // co przy kazdym odczycie kolumn *_json w tym module.
  it('uszkodzony JSON → pusta lista, bez wyjątku', () => {
    expect(kuponyZWiersza('{zepsute')).toEqual([]);
  });

  it('JSON niebędący tablicą → pusta lista', () => {
    expect(kuponyZWiersza('{"kod":"x"}')).toEqual([]);
  });
});
