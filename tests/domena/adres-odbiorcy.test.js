import { describe, it, expect } from 'vitest';
import {
  adresOdbiorcy, adresZeSklepu, polaReczneAdresu, brakujacePolaAdresu,
} from '../../src/domena/adres-odbiorcy.js';

const zamowienie = (nad = {}) => ({
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', company: '', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  klient: { phone: '+48500600700', email: 'j@k.pl' },
  ...nad,
});

describe('adresOdbiorcy', () => {
  it('składa imię i nazwisko z pól shipping', () => {
    expect(adresOdbiorcy(zamowienie()).nazwa).toBe('Jan Kowalski');
  });

  // ⚠️ ZMIENIONE 2026-08-05. Dawniej ta funkcja podstawiała tu imię i nazwisko (DPD wymaga
  // niepustego <company>) — i przez to karta oraz ekran nadania pokazywały nazwisko w polu
  // „Firma" przy każdym zamówieniu od osoby prywatnej. Fallback zjechał na GRANICĘ:
  // kurierzy/dpd.js (`a.company ?? a.nazwa`) i domain/adres-formularza.js. Że etykieta DPD
  // dalej dostaje niepuste <company> — na obu ścieżkach, także hurtem — pilnuje
  // tests/oms/adres-firma-fallback.test.js.
  // NULL, nie '': `??` w dpd.js pustego stringa NIE łapie.
  it('bez firmy — pole firmy zostaje PUSTE (null), nie imię i nazwisko', () => {
    expect(adresOdbiorcy(zamowienie()).company).toBeNull();
  });

  it('z firmą — firma zostaje firmą, nie jest nadpisywana imieniem', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, company: 'ACME sp. z o.o.' } });
    expect(adresOdbiorcy(z).company).toBe('ACME sp. z o.o.');
  });

  it('przenosi ulicę, kod i miasto bez zmian', () => {
    const a = adresOdbiorcy(zamowienie());
    expect(a.ulica).toBe('Polna 1');
    expect(a.kod).toBe('00-650');
    expect(a.miasto).toBe('Pęki');
  });

  it('telefon i e-mail pochodzą z bloku klient (billing), nie z dostawy', () => {
    const a = adresOdbiorcy(zamowienie());
    expect(a.phone).toBe('+48500600700');
    expect(a.email).toBe('j@k.pl');
  });

  it.each([
    ['', 'pusty string'],
    ['pl', 'małe litery'],
    [' PL', 'spacje wokół wielkich liter'],
  ])('country=%j (%s) → normalizowany do PL', (country) => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, country } });
    expect(adresOdbiorcy(z).kraj).toBe('PL');
  });

  it('kraj zagraniczny zostaje znormalizowany (trim + uppercase), ale nie zamieniony na PL', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, country: ' gb ' } });
    expect(adresOdbiorcy(z).kraj).toBe('GB');
  });

  it('całkowicie pusty blok dostawa/klient nie wywala wyjątku', () => {
    expect(() => adresOdbiorcy({})).not.toThrow();
    const a = adresOdbiorcy({});
    expect(a.nazwa).toBe('');
    expect(a.ulica).toBeNull();
    expect(a.kraj).toBe('PL');
  });

  it('brak samego zamówienia (null/undefined) nie wywala wyjątku', () => {
    expect(() => adresOdbiorcy(null)).not.toThrow();
    expect(() => adresOdbiorcy(undefined)).not.toThrow();
  });

  it('puste pola adresu (ulica/kod/miasto) → null, nie pusty string', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, address_1: '', postcode: '', city: '' } });
    const a = adresOdbiorcy(z);
    expect(a.ulica).toBeNull();
    expect(a.kod).toBeNull();
    expect(a.miasto).toBeNull();
  });
});

// Sklep na pro.szkicownia.pl rozbija adres na address_1 (ulica) i address_2 (numer budynku).
// Zamowienia z briefu: 1267 (numer w address_1, address_2 puste), 1275 (address_1='Lipowa',
// address_2='91' — panel gubil numer), 1276 (jak 1267). Panel MUSI sklejac oba pola w JEDNEJ
// funkcji, z ktorej korzysta karta, ekran nadania i klient DPD (patrz PRZEWODNIK 4.7).
describe('adresOdbiorcy — sklejanie address_1 i address_2', () => {
  it('zamówienie 1275: address_1="Lipowa" + address_2="91" → ulica "Lipowa 91"', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, address_1: 'Lipowa', address_2: '91' } });
    expect(adresOdbiorcy(z).ulica).toBe('Lipowa 91');
  });

  it('zamówienie 1267/1276: numer już w address_1, address_2 puste → bez zmian, bez spacji na końcu', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, address_1: '3 maja 22', address_2: '' } });
    expect(adresOdbiorcy(z).ulica).toBe('3 maja 22');
  });

  it('address_2 nieustawione w ogóle (brak klucza) → jak dziś, sam address_1', () => {
    const { address_2, ...dostawa } = { ...zamowienie().dostawa, address_1: 'Polna 1' };
    const z = zamowienie({ dostawa });
    expect(adresOdbiorcy(z).ulica).toBe('Polna 1');
  });

  it('adresZeSklepu (baza porównania i przywracania) też oddaje sklejoną ulicę', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, address_1: 'Lipowa', address_2: '91' } });
    expect(adresZeSklepu(z).ulica).toBe('Lipowa 91');
  });

  it('ręczna poprawka ulicy wygrywa nad sklejeniem ze sklepu', () => {
    const z = zamowienie({
      dostawa: { ...zamowienie().dostawa, address_1: 'Lipowa', address_2: '91' },
      dostawa_reczna_json: JSON.stringify({ ulica: 'Inna 5' }),
    });
    expect(adresOdbiorcy(z).ulica).toBe('Inna 5');
  });

  it('adres z niepustym address_2, bez ręcznej poprawki, NIE jest oznaczony jako zmieniony ręcznie', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, address_1: 'Lipowa', address_2: '91' } });
    expect(polaReczneAdresu(z)).toEqual([]);
  });
});

describe('brakujacePolaAdresu', () => {
  it('kompletny adres → pusta lista', () => {
    expect(brakujacePolaAdresu(adresOdbiorcy(zamowienie()))).toEqual([]);
  });

  // Dokładnie ten scenariusz z briefu: zamówienie założone w adminie sklepu potrafi mieć
  // całkowicie pusty blok `shipping`.
  it('pusty blok shipping → wszystkie trzy wymagane pola zgłoszone jako brakujące', () => {
    const brakujace = brakujacePolaAdresu(adresOdbiorcy({ dostawa: {}, klient: {} }));
    expect(brakujace).toEqual(['ulica', 'kod', 'miasto']);
  });

  it('brakuje tylko kodu pocztowego → zgłoszony tylko on', () => {
    const z = zamowienie({ dostawa: { ...zamowienie().dostawa, postcode: '' } });
    expect(brakujacePolaAdresu(adresOdbiorcy(z))).toEqual(['kod']);
  });
});
