import { describe, it, expect } from 'vitest';
import { parsujAdresOdbiorcy } from '../../src/domena/adres-formularza.js';

// Adres odbiorcy TAKI, JAKI PRZYCHODZI Z FORMULARZA ekranu nadania (POST /zamowienia/:id/nadaj)
// — operator mógł poprawić dowolne pole przed zatwierdzeniem (zły kod, brak numeru mieszkania,
// dosyłka pod inny adres). To jest jedyne miejsce, w którym ten adres powstaje PO stronie
// serwera — trasa POST przekazuje go dalej DOKŁADNIE takim, jaki stąd wyjdzie (patrz brief
// „adres-edytowalny": „do DPD leci dokładnie to, co było w formularzu w chwili zatwierdzenia").
const pelny = () => ({
  nazwa: 'Jan Kowalski', company: '', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
  kraj: 'PL', phone: '+48500600700', email: 'j@k.pl',
});

describe('parsujAdresOdbiorcy', () => {
  it('kompletne dane formularza → adres bez błędu', () => {
    const { adres, blad } = parsujAdresOdbiorcy(pelny());
    expect(blad).toBeUndefined();
    expect(adres).toEqual({
      nazwa: 'Jan Kowalski', company: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650',
      miasto: 'Pęki', kraj: 'PL', phone: '+48500600700', email: 'j@k.pl',
    });
  });

  it('operator poprawił ulicę (np. dodał numer mieszkania) — poprawiona wartość wychodzi bez zmian', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), ulica: 'Polna 1/5' });
    expect(adres.ulica).toBe('Polna 1/5');
  });

  it('kod pocztowy z myślnikiem przechodzi BEZ ZMIAN — normalizacja jest wyłącznie w kliencie DPD', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), kod: '00-650' });
    expect(adres.kod).toBe('00-650');
  });

  // Fallback firmy na imię i nazwisko — dokładnie ten sam, co dziś w adresOdbiorcy().
  it('puste pole firmy → imię i nazwisko służy za firmę', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), company: '' });
    expect(adres.company).toBe('Jan Kowalski');
  });

  it('podana firma zostaje firmą, nie jest nadpisywana imieniem', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), company: 'ACME sp. z o.o.' });
    expect(adres.company).toBe('ACME sp. z o.o.');
  });

  // ⚠️ MUTACJA OBOWIĄZKOWA z briefu: usunięcie tej blokady musi zaczerwienić ten test —
  // puste pole wymagane (ulica/kod/miasto) MA ZATRZYMAĆ zatwierdzenie, PRZED dotknięciem DPD,
  // a nie tylko ostrzec jak dawne `brakujacePolaAdresu` w widoku.
  it.each([
    ['ulica', { ...pelny(), ulica: '' }],
    ['kod', { ...pelny(), kod: '' }],
    ['miasto', { ...pelny(), miasto: '' }],
  ])('puste wymagane pole (%s) → blad, BRAK adresu do przekazania dalej', (_pole, dane) => {
    const { adres, blad } = parsujAdresOdbiorcy(dane);
    expect(blad).toBeTruthy();
    expect(adres).toBeUndefined();
  });

  it('puste wymagane pole samo w sobie białe znaki → traktowane jak puste, blad', () => {
    const { blad } = parsujAdresOdbiorcy({ ...pelny(), miasto: '   ' });
    expect(blad).toBeTruthy();
  });

  it('komunikat błędu wymienia WSZYSTKIE brakujące pola naraz, nie tylko pierwsze', () => {
    const { blad } = parsujAdresOdbiorcy({ ...pelny(), ulica: '', kod: '', miasto: '' });
    expect(blad).toMatch(/ulic/i);
    expect(blad).toMatch(/kod/i);
    expect(blad).toMatch(/miast/i);
  });

  // Kraj NIE jest polem edytowalnym operatora (panel obsługuje wyłącznie przesyłki krajowe),
  // ale formularz go NIESIE jako ukryte pole (patrz nadaj.ejs) — musi przejść bez zmian, żeby
  // odmowa dla przesyłek zagranicznych w kurierzy/dpd.js dalej działała.
  it('kraj z formularza przechodzi bez zmian, nawet gdy inny niż PL', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), kraj: 'GB' });
    expect(adres.kraj).toBe('GB');
  });

  it('brak pola kraju w ogóle → domyślnie PL (spójnie z adresOdbiorcy)', () => {
    const bezKraju = { ...pelny() };
    delete bezKraju.kraj;
    const { adres } = parsujAdresOdbiorcy(bezKraju);
    expect(adres.kraj).toBe('PL');
  });

  it('telefon i e-mail puste → null, nie pusty string (spójnie z adresOdbiorcy)', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), phone: '', email: '' });
    expect(adres.phone).toBeNull();
    expect(adres.email).toBeNull();
  });

  it('białe znaki dookoła wartości są przycinane', () => {
    const { adres } = parsujAdresOdbiorcy({ ...pelny(), ulica: '  Polna 1  ', miasto: '  Pęki  ' });
    expect(adres.ulica).toBe('Polna 1');
    expect(adres.miasto).toBe('Pęki');
  });

  it('brak jakichkolwiek danych (pusty obiekt) → błąd o wszystkich trzech polach', () => {
    const { adres, blad } = parsujAdresOdbiorcy({});
    expect(adres).toBeUndefined();
    expect(blad).toBeTruthy();
  });

  it('undefined jako dane → nie wywala wyjątku, zwraca błąd', () => {
    expect(() => parsujAdresOdbiorcy(undefined)).not.toThrow();
    expect(parsujAdresOdbiorcy(undefined).blad).toBeTruthy();
  });
});
