import { describe, it, expect } from 'vitest';
import { adresOdbiorcy, adresZeSklepu, polaReczneAdresu } from '../../src/domena/adres-odbiorcy.js';

// Zgłoszenie właściciela z prawdziwego zamówienia 1277 (2026-07-31): „pole z nazwą firmy
// w danych wysyłki źle się pobiera".
//
// Co pokazała baza: WooCommerce wypełnił `shipping` imieniem, adresem i telefonem, ale
// `shipping.company` ZOSTAWIŁ PUSTE, mimo że klient podał firmę przy płatności
// (`billing.company` = „Gammatech Spółka Sp. z o.o. Sp. K"). Panel pokazywał wtedy jako
// „Firma" IMIĘ I NAZWISKO — ostateczny fallback dla DPD, który wymaga niepustego pola —
// czyli paczka do firmy jechała bez jej nazwy na etykiecie.

const zamowienie = (nad = {}) => ({
  dostawa: {
    first_name: 'Maria', last_name: 'Wiśniewska', company: '',
    address_1: 'Polna 38', address_2: '', postcode: '01-234', city: 'Dolnowo', country: 'PL',
  },
  klient: {
    first_name: 'Maria', last_name: 'Wiśniewska', company: 'Gammatech Spółka Sp. z o.o. Sp. K',
    address_1: 'Polna 38', address_2: '', postcode: '01-234', city: 'Dolnowo',
    email: 'biuro@example.pl', phone: '500900006',
  },
  ...nad,
});

describe('firma na etykiecie, gdy sklep zostawił shipping.company puste', () => {
  it('bierze firmę z bloku płatności, a nie imię i nazwisko', () => {
    expect(adresOdbiorcy(zamowienie()).company).toBe('Gammatech Spółka Sp. z o.o. Sp. K');
  });

  it('firma WPISANA w bloku wysyłki wygrywa z firmą z płatności', () => {
    const z = zamowienie({
      dostawa: { ...zamowienie().dostawa, company: 'Magazyn Dolnowo sp. z o.o.' },
    });
    expect(adresOdbiorcy(z).company).toBe('Magazyn Dolnowo sp. z o.o.');
  });

  // ⚠️ TO JEST GRANICA, KTÓREJ NIE WOLNO PRZEKROCZYĆ: paczka bywa wysyłana pod adres montażu,
  // a faktura idzie na siedzibę. Nazwa firmy z płatności na etykiecie jadącej GDZIE INDZIEJ
  // byłaby błędem, którego nikt by nie zauważył — bo etykieta wygląda wtedy poprawnie.
  it('przy INNYM adresie wysyłki firmy z płatności NIE bierze', () => {
    const z = zamowienie({
      dostawa: {
        first_name: 'Jan', last_name: 'Nowak', company: '',
        address_1: 'Budowlana 7', postcode: '00-001', city: 'Warszawa', country: 'PL',
      },
    });
    // ⚠️ ZMIENIONE 2026-08-05: pole zostaje PUSTE. Dawniej wchodził tu ostateczny fallback
    // na imię i nazwisko (DPD wymaga niepustego <company>), ale siedział we wspólnym źródle
    // dla karty, ekranu nadania i kuriera — i wychodził operatorowi na ekran. Dziś fallback
    // stoi na granicy kuriera (kurierzy/dpd.js) i formularza (domain/adres-formularza.js);
    // pilnuje go tests/oms/adres-firma-fallback.test.js.
    expect(adresOdbiorcy(z).company).toBeNull();
  });

  it('bez firmy w obu blokach pole firmy zostaje PUSTE (fallback stoi na granicy kuriera)', () => {
    const z = zamowienie({ klient: { ...zamowienie().klient, company: '' } });
    expect(adresOdbiorcy(z).company).toBeNull();
  });

  // Drobne różnice zapisu (wielkość liter, spacje, myślnik w kodzie) to ten sam adres —
  // klient wpisuje te same dane dwa razy i nie robi tego znak w znak.
  it('różnice w zapisie adresu nie psują dopasowania', () => {
    const z = zamowienie({
      dostawa: {
        ...zamowienie().dostawa,
        address_1: 'polna  38', postcode: '01234', city: 'DOLNOWO',
      },
    });
    expect(adresOdbiorcy(z).company).toBe('Gammatech Spółka Sp. z o.o. Sp. K');
  });

  // Numer budynku bywa OSOBNYM polem (address_2) — porównanie musi to znieść, inaczej
  // ten sam adres zapisany na dwa sposoby wyglądałby na dwa różne.
  it('numer w address_2 po jednej stronie, w address_1 po drugiej — dalej ten sam adres', () => {
    const z = zamowienie({
      dostawa: { ...zamowienie().dostawa, address_1: 'Polna', address_2: '38' },
    });
    expect(adresOdbiorcy(z).company).toBe('Gammatech Spółka Sp. z o.o. Sp. K');
  });
});

describe('co się przez to NIE zmienia', () => {
  // Oznaczenie „zmienione ręcznie" liczy się z RÓŻNICY wobec sklepu, więc firma podstawiona
  // z bloku płatności NIE MOŻE udawać ręcznej poprawki operatora.
  it('firma z płatności nie jest oznaczana jako „zmienione ręcznie”', () => {
    expect(polaReczneAdresu(zamowienie())).not.toContain('company');
  });

  it('adresZeSklepu widzi tę samą firmę — to dalej dana ze SKLEPU, nie nasza', () => {
    expect(adresZeSklepu(zamowienie()).company).toBe('Gammatech Spółka Sp. z o.o. Sp. K');
  });

  it('ręczna poprawka firmy dalej wygrywa ze wszystkim', () => {
    const z = zamowienie({ dostawa_reczna_json: JSON.stringify({ company: 'Inna Firma sp. z o.o.' }) });
    expect(adresOdbiorcy(z).company).toBe('Inna Firma sp. z o.o.');
    expect(polaReczneAdresu(z)).toContain('company');
  });

  it('reszta adresu zostaje nietknięta', () => {
    const a = adresOdbiorcy(zamowienie());
    expect(a.nazwa).toBe('Maria Wiśniewska');
    expect(a.ulica).toBe('Polna 38');
    expect(a.kod).toBe('01-234');
    expect(a.miasto).toBe('Dolnowo');
  });
});
