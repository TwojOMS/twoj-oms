import { describe, it, expect } from 'vitest';
import { normalizuj, polaSzukania, pasujeDoSzukania, filtrujSzukaniem } from '../../src/domena/szukanie.js';

// Wyszukiwarka nad tabelą zamówień (zadanie „strona główna", 2026-07-31). Reguła jest
// CZYSTA — testuje się bez bazy i bez HTTP; ten plik pilnuje samej reguły, a
// tests/oms/web-szukanie.test.js tego, że trasa jej faktycznie używa.

const zamowienie = (nad = {}) => ({
  numer: '1276',
  sklep: 'pro',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'jan@example.pl', phone: '+48 500 900 010', company: null },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Lipowa 12', postcode: '00-650', city: 'Pęki', country: 'PL' },
  pozycje: [{ nazwa: 'Szablon STOP', sku: 'PRO-STOP-001', ilosc: 1 }],
  przesylki: [],
  faktura: null,
  ...nad,
});

describe('normalizuj', () => {
  it('sprowadza do małych liter, ścina spacje i składa polskie znaki do ASCII', () => {
    expect(normalizuj('  Pęki   Łódź ')).toBe('peki lodz');
    expect(normalizuj('ŻÓŁW')).toBe('zolw');
  });

  it('null i undefined dają pusty napis, a nie wyjątek', () => {
    expect(normalizuj(null)).toBe('');
    expect(normalizuj(undefined)).toBe('');
  });
});

describe('pola do szukania', () => {
  it('obejmują numer, klienta, adres, pozycje i numer listu przewozowego', () => {
    const pola = polaSzukania(zamowienie({
      przesylki: [{ numer_listu: '1000000000001U' }],
    })).join(' | ');
    expect(pola).toContain('1276');
    expect(pola).toContain('Kowalski');
    expect(pola).toContain('jan@example.pl');
    expect(pola).toContain('Pęki');
    expect(pola).toContain('Szablon STOP');
    expect(pola).toContain('PRO-STOP-001');
    expect(pola).toContain('1000000000001U');
  });

  it('puste pola nie wchodzą na listę (nie da się ich znaleźć pustą frazą)', () => {
    expect(polaSzukania(zamowienie({ klient: null, dostawa: {}, pozycje: [] })).every((p) => String(p).trim() !== ''))
      .toBe(true);
  });

  // ⚠️ Mutacja: czytanie surowego bloku `dostawa` zamiast adresOdbiorcy ma zaczerwienić TEN
  // test. Operator poprawia dane klienta na karcie i MUSI móc znaleźć zamówienie po tym, co
  // widzi na ekranie — inaczej szuka po wartości, której panel nigdzie nie pokazuje.
  it('używają danych EFEKTYWNYCH: ręczna poprawka nazwiska jest do wyszukania, stara już nie', () => {
    // Nabywcą na fakturze jest FIRMA, więc nazwisko ze sklepu występuje w tym zamówieniu
    // wyłącznie w adresie wysyłki — i tylko dzięki temu widać, że poprawka faktycznie
    // przykryła wartość ze sklepu, a nie po prostu doszła obok niej.
    const z = zamowienie({
      klient: { company: 'ACME sp. z o.o.', email: 'biuro@acme.pl' },
      dostawa_reczna_json: JSON.stringify({ nazwa: 'Anna Nowak' }),
    });
    expect(pasujeDoSzukania(z, 'Nowak')).toBe(true);
    expect(pasujeDoSzukania(z, 'Kowalski')).toBe(false);
  });
});

describe('dopasowanie frazy', () => {
  it('znajduje po fragmencie numeru zamówienia', () => {
    expect(pasujeDoSzukania(zamowienie(), '127')).toBe(true);
  });

  it('nie zważa na wielkość liter ani na polskie znaki', () => {
    expect(pasujeDoSzukania(zamowienie(), 'kowalski')).toBe(true);
    expect(pasujeDoSzukania(zamowienie(), 'peki')).toBe(true);
    expect(pasujeDoSzukania(zamowienie(), 'PĘKI')).toBe(true);
  });

  // ⚠️ Mutacja: `some` zamiast `every` ma zaczerwienić TEN test. Przy „albo" im dokładniej
  // ktoś opisze, czego szuka, tym więcej dostanie wyników — czyli wyszukiwarka działa
  // dokładnie odwrotnie, niż człowiek zakłada.
  it('KAŻDE słowo frazy musi trafić — nie wystarczy jedno', () => {
    expect(pasujeDoSzukania(zamowienie(), 'kowalski peki')).toBe(true);
    expect(pasujeDoSzukania(zamowienie(), 'kowalski gdansk')).toBe(false);
  });

  it('pusta fraza pasuje do wszystkiego (lista zostaje nietknięta)', () => {
    expect(pasujeDoSzukania(zamowienie(), '')).toBe(true);
    expect(pasujeDoSzukania(zamowienie(), '   ')).toBe(true);
  });

  it('fraza, której nigdzie nie ma, nie pasuje', () => {
    expect(pasujeDoSzukania(zamowienie(), 'zzz')).toBe(false);
  });

  it('zamówienie bez klienta i bez pozycji nie wywala wyszukiwarki', () => {
    const z = zamowienie({ klient: null, dostawa: {}, pozycje: [], przesylki: [] });
    expect(pasujeDoSzukania(z, 'kowalski')).toBe(false);
    expect(pasujeDoSzukania(z, '1276')).toBe(true);
  });
});

describe('fraza zapisana jak liczba (NIP, telefon, list przewozowy)', () => {
  it('NIP z myślnikami znajduje zamówienie z NIP-em bez myślników', () => {
    const z = zamowienie({ klient: { company: 'ACME', nip: null }, nip: '6762432556' });
    // NIP siedzi w danych faktury (domain/dane-faktury.js czyta go z zamówienia).
    expect(polaSzukania(z)).toContain('6762432556');
    expect(pasujeDoSzukania(z, '676-24-32-556')).toBe(true);
  });

  it('telefon wpisany bez spacji znajduje zapisany ze spacjami i prefiksem', () => {
    expect(pasujeDoSzukania(zamowienie(), '500900010')).toBe(true);
  });

  // Sama fraza tekstowa dalej działa jak zwykłe „zawiera" — „32" znajdzie kod 00-650 i to
  // jest w porządku. Chodzi WYŁĄCZNIE o drogę cyfrową, która ignoruje separatory: dla
  // dwóch cyfr trafiałaby w środek każdej dłuższej liczby w zamówieniu.
  it('fraza krótsza niż trzy cyfry nie idzie drogą cyfrową', () => {
    // „5-0" nie występuje jako tekst w żadnym polu; po zignorowaniu myślnika („50") siedzi
    // w środku kodu 00-650. Bez progu to zamówienie wyskoczyłoby na taką frazę.
    expect(pasujeDoSzukania(zamowienie(), '5-0')).toBe(false);
    // Trzy cyfry to już świadome szukanie — i tą samą drogą trafiają.
    expect(pasujeDoSzukania(zamowienie(), '65-0')).toBe(true);
  });

  it('kod pocztowy z myślnikiem i bez trafia tak samo', () => {
    expect(pasujeDoSzukania(zamowienie(), '00-650')).toBe(true);
    expect(pasujeDoSzukania(zamowienie(), '00650')).toBe(true);
  });

  // ⚠️ Mutacja: sklejenie wszystkich cyfr zamówienia w JEDEN ciąg ma zaczerwienić TEN test —
  // fraza przeskakiwałaby wtedy granicę pól i trafiała w połowę jednej liczby plus połowę
  // drugiej, czyli w zamówienie, które z niczym się nie zgadza.
  it('fraza cyfrowa nie przeskakuje granicy dwóch pól', () => {
    const z = zamowienie({ numer: '1276', klient: { phone: '500100200', email: null } });
    expect(pasujeDoSzukania(z, '1276')).toBe(true);
    expect(pasujeDoSzukania(z, '500100200')).toBe(true);
    // Ogon numeru (276) sklejony z początkiem telefonu (500) — istnieje tylko po sklejeniu.
    expect(pasujeDoSzukania(z, '276500')).toBe(false);
  });
});

describe('filtrujSzukaniem', () => {
  it('pusta fraza oddaje dokładnie tę samą listę', () => {
    const lista = [zamowienie({ numer: '1' }), zamowienie({ numer: '2' })];
    expect(filtrujSzukaniem(lista, '  ')).toBe(lista);
  });

  it('zostawia wyłącznie pasujące zamówienia', () => {
    const lista = [
      zamowienie({ numer: '1275' }),
      zamowienie({ numer: '1276', klient: { first_name: 'Anna', last_name: 'Nowak', email: null } }),
    ];
    expect(filtrujSzukaniem(lista, 'nowak').map((z) => z.numer)).toEqual(['1276']);
  });
});
