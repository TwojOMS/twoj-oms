import { describe, it, expect } from 'vitest';
import {
  znormalizujNip, nipPoprawny, nipDoZapytania, firmaZOdpowiedzi, sformatujKod,
  kopertaZaloguj, kopertaSzukajPoNip, rozpakuj,
} from '../../src/domena/gus.js';

// GUS BIR1.1 — warstwa CZYSTA: normalizacja NIP-u, koperty SOAP, czytanie odpowiedzi.
// Sieć (logowanie, sesja, ponowienie) ma własny plik: tests/oms/gus-client.test.js.

describe('normalizacja NIP-u', () => {
  it('ścina myślniki, spacje i prefiks PL', () => {
    expect(znormalizujNip('676-24-32-557')).toBe('6762432557');
    expect(znormalizujNip(' 676 243 25 57 ')).toBe('6762432557');
    expect(znormalizujNip('PL6762432557')).toBe('6762432557');
    expect(znormalizujNip('pl6762432557')).toBe('6762432557');
  });

  it('pusty i null dają pusty napis, a nie wyjątek', () => {
    expect(znormalizujNip(null)).toBe('');
    expect(znormalizujNip('')).toBe('');
  });
});

describe('suma kontrolna NIP-u', () => {
  // 5252248481 to NIP z publicznego rejestru (użyty w fiksturach demo), 6762432557 również.
  it('przyjmuje poprawne NIP-y', () => {
    expect(nipPoprawny('5252248481')).toBe(true);
    expect(nipPoprawny('6762432557')).toBe(true);
  });

  it('odrzuca literówkę w ostatniej cyfrze', () => {
    expect(nipPoprawny('5252248482')).toBe(false);
  });

  it('odrzuca zły format', () => {
    expect(nipPoprawny('525224848')).toBe(false);
    expect(nipPoprawny('52522484811')).toBe(false);
    expect(nipPoprawny('abcdefghij')).toBe(false);
  });
});

// ⚠️ Kontrola sumy PRZED wyjściem do sieci nie jest ozdobnikiem: GUS na literówkę i na
// nieistniejącą firmę odpowiada TAK SAMO („nie znaleziono"), więc bez niej operator
// szukałby firmy zamiast poprawić cyfrę.
describe('nipDoZapytania', () => {
  it('oddaje same cyfry dla poprawnego NIP-u', () => {
    expect(nipDoZapytania('676-24-32-557')).toBe('6762432557');
  });

  it('pusty NIP → odmowa dla operatora', () => {
    expect(() => nipDoZapytania('')).toThrow(/Podaj NIP/);
  });

  it('zła długość → odmowa mówiąca ILE cyfr jest', () => {
    expect(() => nipDoZapytania('500900007')).toThrow(/dziesięć cyfr, a ma 9/);
  });

  it('zła suma kontrolna → odmowa mówiąca o literówce', () => {
    expect(() => nipDoZapytania('5252248482')).toThrow(/sumę kontrolną/);
  });

  it('odmowy są oznaczone jako komunikat dla operatora', () => {
    try {
      nipDoZapytania('123');
      throw new Error('miało rzucić');
    } catch (e) {
      expect(e.dlaOperatora).toBe(true);
    }
  });
});

describe('kod pocztowy', () => {
  // REGON oddaje kod BEZ myślnika, a panel/Woo/DPD używają postaci z myślnikiem — bez
  // tego każde pobranie z GUS-u oznaczałoby pole jako „zmienione ręcznie".
  it('dokłada myślnik', () => {
    expect(sformatujKod('00650')).toBe('00-650');
  });

  it('kod już z myślnikiem zostaje nietknięty', () => {
    expect(sformatujKod('00-650')).toBe('00-650');
  });

  it('śmieci zostają, jakie były (lepiej pokazać dziwną wartość niż ją zjeść)', () => {
    expect(sformatujKod('brak')).toBe('brak');
    expect(sformatujKod(null)).toBeNull();
  });
});

describe('rozpakowanie odpowiedzi', () => {
  it('radzi sobie z CDATA', () => {
    expect(rozpakuj('<![CDATA[<root><a>1</a></root>]]>')).toBe('<root><a>1</a></root>');
  });

  // ⚠️ Ta sama usługa potrafi oddać jedną albo drugą postać. Obsługa tylko jednej znaczy
  // klienta, który „działa raz na jakiś czas".
  it('radzi sobie z postacią zaescapowaną', () => {
    expect(rozpakuj('&lt;root&gt;&lt;a&gt;1&lt;/a&gt;&lt;/root&gt;')).toBe('<root><a>1</a></root>');
  });
});

const odpowiedzGus = (srodek) => `<root>${srodek}</root>`;

describe('firma z odpowiedzi DaneSzukajPodmioty', () => {
  const pelna = odpowiedzGus(`<dane>
    <Regon>012345678</Regon>
    <Nip>6762432557</Nip>
    <Nazwa>PRACOWNIA WNĘTRZ KROPKA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ</Nazwa>
    <Wojewodztwo>MAŁOPOLSKIE</Wojewodztwo>
    <Miejscowosc>KRAKÓW</Miejscowosc>
    <KodPocztowy>31510</KodPocztowy>
    <Ulica>ul. Leśna</Ulica>
    <NrNieruchomosci>12</NrNieruchomosci>
    <NrLokalu>4</NrLokalu>
    <Typ>P</Typ>
  </dane>`);

  it('czyta nazwę, NIP, REGON i miasto', () => {
    const f = firmaZOdpowiedzi(pelna);
    expect(f.firma).toMatch(/^PRACOWNIA WNĘTRZ KROPKA/);
    expect(f.nip).toBe('6762432557');
    expect(f.regon).toBe('012345678');
    expect(f.miasto).toBe('KRAKÓW');
    expect(f.typ).toBe('P');
  });

  // ⚠️ REGON trzyma ulicę, numer nieruchomości i numer lokalu OSOBNO, a panel ma jedno
  // pole „Ulica". Pominięcie numeru = faktura bez numeru domu.
  it('skleja ulicę z numerem nieruchomości i lokalu', () => {
    expect(firmaZOdpowiedzi(pelna).ulica).toBe('ul. Leśna 12/4');
  });

  it('bez numeru lokalu skleja sam numer nieruchomości', () => {
    const xml = odpowiedzGus('<dane><Nazwa>X</Nazwa><Ulica>ul. Leśna</Ulica><NrNieruchomosci>12</NrNieruchomosci></dane>');
    expect(firmaZOdpowiedzi(xml).ulica).toBe('ul. Leśna 12');
  });

  it('formatuje kod pocztowy z myślnikiem', () => {
    expect(firmaZOdpowiedzi(pelna).kod).toBe('31-510');
  });

  it('radzi sobie z odpowiedzią zaescapowaną, nie tylko z CDATA', () => {
    const zaescapowana = pelna.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(firmaZOdpowiedzi(zaescapowana).firma).toMatch(/^PRACOWNIA/);
  });

  // ⚠️ „Nie znaleziono" to ODPOWIEDŹ, nie awaria — karta musi je odróżnić od padniętej
  // usługi, bo pierwsze znaczy „sprawdź NIP", a drugie „spróbuj za chwilę".
  it('brak firmy → null, a nie wyjątek', () => {
    expect(firmaZOdpowiedzi(odpowiedzGus(''))).toBeNull();
    expect(firmaZOdpowiedzi('')).toBeNull();
  });

  it('ErrorCode w środku bloku <dane> to też „nie znaleziono"', () => {
    const xml = odpowiedzGus('<dane><ErrorCode>4</ErrorCode><ErrorMessagePl>Nie znaleziono podmiotu</ErrorMessagePl></dane>');
    expect(firmaZOdpowiedzi(xml)).toBeNull();
  });

  it('puste pola oddaje jako null, nie jako pusty napis', () => {
    const xml = odpowiedzGus('<dane><Nazwa>X</Nazwa><Ulica></Ulica><Miejscowosc></Miejscowosc></dane>');
    const f = firmaZOdpowiedzi(xml);
    expect(f.ulica).toBeNull();
    expect(f.miasto).toBeNull();
  });
});

describe('koperty SOAP', () => {
  it('logowanie niesie klucz i adres usługi', () => {
    const k = kopertaZaloguj('feda2', 'https://uslugi/test.svc');
    expect(k).toContain('<ns:pKluczUzytkownika>feda2</ns:pKluczUzytkownika>');
    expect(k).toContain('<wsa:To>https://uslugi/test.svc</wsa:To>');
    expect(k).toContain('IUslugaBIRzewnPubl/Zaloguj');
  });

  it('wyszukanie niesie NIP w parametrach', () => {
    const k = kopertaSzukajPoNip('6762432557', 'https://uslugi/test.svc');
    expect(k).toContain('<dat:Nip>6762432557</dat:Nip>');
    expect(k).toContain('IUslugaBIRzewnPubl/DaneSzukajPodmioty');
  });

  // Klucz i NIP idą do XML-a, więc znak `&` w kluczu rozwaliłby kopertę.
  it('escapuje znaki specjalne', () => {
    expect(kopertaZaloguj('a&b<c', 'https://x')).toContain('a&amp;b&lt;c');
  });
});
