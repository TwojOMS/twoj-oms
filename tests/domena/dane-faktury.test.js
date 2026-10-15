import { describe, it, expect } from 'vitest';
import {
  daneFaktury, daneFakturyZeSklepu, polaReczneFaktury,
} from '../../src/domena/dane-faktury.js';

const zamowienie = (nad = {}) => ({
  klient: {
    first_name: 'Jan', last_name: 'Kowalski', company: 'ACME sp. z o.o.', email: 'j@k.pl',
    address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL',
  },
  nip: '1000001201',
  ...nad,
});

describe('daneFaktury — dane podstawowe', () => {
  it('firma i NIP pochodzą ze sklepu', () => {
    const d = daneFaktury(zamowienie());
    expect(d.firma).toBe('ACME sp. z o.o.');
    expect(d.nip).toBe('1000001201');
  });

  it('przenosi kod i miasto bez zmian', () => {
    const d = daneFaktury(zamowienie());
    expect(d.kod).toBe('00-650');
    expect(d.miasto).toBe('Pęki');
  });
});

// Sklep na pro.szkicownia.pl rozbija adres na address_1 (ulica) i address_2 (numer budynku) —
// dokładnie tak samo jak w bloku `shipping` (patrz adres-odbiorcy.test.js). Zamówienie 1275
// z briefu miało billing.address_1="Lipowa", billing.address_2="91": faktura wychodziłaby
// bez numeru budynku nabywcy.
describe('daneFaktury — sklejanie address_1 i address_2', () => {
  it('zamówienie 1275: billing.address_1="Lipowa" + address_2="91" → ulica "Lipowa 91"', () => {
    const z = zamowienie({ klient: { ...zamowienie().klient, address_1: 'Lipowa', address_2: '91' } });
    expect(daneFaktury(z).ulica).toBe('Lipowa 91');
  });

  it('zamówienie 1276: billing.address_2="912" (numer inny niż w shipping) → sklejone osobno od dostawy', () => {
    const z = zamowienie({ klient: { ...zamowienie().klient, address_1: 'Lipowa', address_2: '912' } });
    expect(daneFaktury(z).ulica).toBe('Lipowa 912');
  });

  it('numer już w address_1, address_2 puste → bez zmian, bez spacji na końcu (zamówienie 1267)', () => {
    const z = zamowienie({ klient: { ...zamowienie().klient, address_1: '3 maja 22', address_2: '' } });
    expect(daneFaktury(z).ulica).toBe('3 maja 22');
  });

  it('address_2 nieustawione w ogóle (brak klucza) → jak dziś, sam address_1', () => {
    const { address_2, ...klient } = { ...zamowienie().klient, address_1: 'Polna 1' };
    const z = zamowienie({ klient });
    expect(daneFaktury(z).ulica).toBe('Polna 1');
  });

  it('daneFakturyZeSklepu (baza porównania i przywracania) też oddaje sklejoną ulicę', () => {
    const z = zamowienie({ klient: { ...zamowienie().klient, address_1: 'Lipowa', address_2: '91' } });
    expect(daneFakturyZeSklepu(z).ulica).toBe('Lipowa 91');
  });

  it('ręczna poprawka ulicy wygrywa nad sklejeniem ze sklepu', () => {
    const z = zamowienie({
      klient: { ...zamowienie().klient, address_1: 'Lipowa', address_2: '91' },
      klient_reczny_json: JSON.stringify({ ulica: 'Inna 5' }),
    });
    expect(daneFaktury(z).ulica).toBe('Inna 5');
  });

  it('adres z niepustym address_2, bez ręcznej poprawki, NIE jest oznaczony jako zmieniony ręcznie', () => {
    const z = zamowienie({ klient: { ...zamowienie().klient, address_1: 'Lipowa', address_2: '91' } });
    expect(polaReczneFaktury(z)).toEqual([]);
  });
});
