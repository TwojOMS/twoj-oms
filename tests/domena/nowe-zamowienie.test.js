import { describe, it, expect } from 'vitest';
import {
  DOSTAWY, PLATNOSCI, metodaWysylkiZWyboru, parsujNoweZamowienie,
} from '../../src/domena/nowe-zamowienie.js';
import { METODY_WYSYLKI } from '../../src/domena/wysylka.js';
import { adresOdbiorcy } from '../../src/domena/adres-odbiorcy.js';
import { daneFaktury } from '../../src/domena/dane-faktury.js';

// ⚠️ PARA, NIE JEDNA WARTOSC (2026-08-01): ekran od poczatku pytal o dostawe i platnosc
// osobno, a funkcja sklejala odpowiedzi w jedna nazwe. Teraz obie decyzje jada dalej
// w tej postaci, w jakiej zostaly podjete — `{ metoda, pobranie }`.
describe('metodaWysylkiZWyboru — dostawa i płatność jako DWIE niezależne wartości', () => {
  it('kurier z przelewem to zwykłe dpd, bez pobrania', () => {
    expect(metodaWysylkiZWyboru('dpd', 'przelew')).toEqual({ metoda: 'dpd', pobranie: 0 });
  });

  it('kurier z pobraniem daje dpd z włączonym pobraniem', () => {
    expect(metodaWysylkiZWyboru('dpd', 'pobranie')).toEqual({ metoda: 'dpd', pobranie: 1 });
  });

  it('odbiór osobisty z gotówką zostaje odbiorem osobistym', () => {
    expect(metodaWysylkiZWyboru('odbior_osobisty', 'gotowka')).toEqual({ metoda: 'odbior_osobisty', pobranie: 0 });
  });

  // ⚠️ To jedyna sprzeczna para: pobranie inkasuje KURIER, a przy odbiorze osobistym
  // kuriera nie ma. Ciche przepuszczenie zapisaloby zamowienie, ktorego nikt nigdy nie
  // zainkasuje — pieniadze znikaja bez ani jednego ostrzezenia.
  it('odbiór osobisty z pobraniem to odmowa, nie ciche złożenie w jedną metodę', () => {
    expect(() => metodaWysylkiZWyboru('odbior_osobisty', 'pobranie')).toThrow(/wykluczają się/i);
  });

  it.each([
    ['nieznana dostawa', 'teleport', 'przelew'],
    ['nieznana płatność', 'dpd', 'bitcoin'],
  ])('%s dostaje odmowę', (_nazwa, dostawa, platnosc) => {
    expect(() => metodaWysylkiZWyboru(dostawa, platnosc)).toThrow();
  });

  // Bramka na CALY iloczyn wyborow interfejsu: kazda para, ktora ekran potrafi wyslac,
  // musi dac metode Z BIALEJ LISTY albo jawna odmowe. Inaczej dolozenie czwartej platnosci
  // wpisaloby do kolumny `metoda_wysylki` wartosc, ktorej nie zna ani wybierzKuriera,
  // ani wyliczStatus, ani karta.
  it('żadna para z ekranu nie produkuje metody spoza METODY_WYSYLKI', () => {
    for (const dostawa of Object.keys(DOSTAWY)) {
      for (const platnosc of Object.keys(PLATNOSCI)) {
        let para = null;
        try { para = metodaWysylkiZWyboru(dostawa, platnosc); } catch { continue; }
        expect(METODY_WYSYLKI).toContain(para.metoda);
        // ...a pobranie ma byc 0/1, nie czymkolwiek — to wprost jedzie do kolumny.
        expect([0, 1]).toContain(para.pobranie);
      }
    }
  });
});

describe('parsujNoweZamowienie — pola', () => {
  // „Wszystkie pola nieobowiazkowe" (decyzja wlasciciela 2026-08-01): numer nadany przy
  // telefonie jest wart wiecej niz komplet danych, a karta i tak zapali ostrzezenia przy
  // nadaniu i fakturze. Pusty formularz MUSI przejsc.
  it('pusty formularz przechodzi i nie wymaga ani jednego pola', () => {
    const d = parsujNoweZamowienie({});
    expect(d.pozycje).toEqual([]);
    expect(d.metoda_wysylki).toBe('dpd');
    expect(d.metoda_platnosci).toBe('Przelew');
    expect(d.koszt_dostawy_brutto).toBe('0.00');
    expect(d.chce_fakture).toBe(0);
  });

  it('dane wysyłki trafiają w blok, który czyta adres odbiorcy', () => {
    const d = parsujNoweZamowienie({
      w_nazwa: 'Anna Maria Kowalska', w_firma: 'Pracownia Kropka',
      w_ulica: 'Krótka 12/3', w_kod: '32-600', w_miasto: 'Oświęcim',
      w_telefon: '600100200', w_email: 'anna@example.pl',
    });
    // Czytamy TA SAMA funkcja, ktora karmi ekran nadania i klienta DPD — nie samym
    // ksztaltem JSON-a. Zapis do niewlasciwego pola bloku przeszedlby porownanie kluczy,
    // ale zniknalby na etykiecie paczki.
    const adres = adresOdbiorcy({ dostawa: d.dostawa, klient: d.klient });
    expect(adres.nazwa).toBe('Anna Maria Kowalska');
    expect(adres.company).toBe('Pracownia Kropka');
    expect(adres.ulica).toBe('Krótka 12/3');
    expect(adres.kod).toBe('32-600');
    expect(adres.miasto).toBe('Oświęcim');
    expect(adres.kraj).toBe('PL');
    expect(adres.phone).toBe('600100200');
    expect(adres.email).toBe('anna@example.pl');
  });

  it('dane do faktury trafiają w blok, który czyta nabywcę', () => {
    const d = parsujNoweZamowienie({
      w_nazwa: 'Jan Nowak',
      f_chce_fakture: 'on', f_firma: 'LUMINA', f_nip: '5492447066',
      f_ulica: 'Przykładowa 5', f_kod: '32-600', f_miasto: 'Oświęcim',
    });
    const nabywca = daneFaktury({ klient: d.klient, nip: d.nip });
    expect(nabywca.firma).toBe('LUMINA');
    expect(nabywca.nip).toBe('5492447066');
    expect(nabywca.ulica).toBe('Przykładowa 5');
    expect(nabywca.kod).toBe('32-600');
    expect(nabywca.miasto).toBe('Oświęcim');
    expect(d.chce_fakture).toBe(1);
  });

  // Adres wysylki i adres nabywcy to DWA osobne komplety (paczka pod adres montazu,
  // faktura na siedzibe) — ta sama zasada, co na karcie.
  it('adres do faktury nie podmienia adresu wysyłki', () => {
    const d = parsujNoweZamowienie({
      w_nazwa: 'Jan Nowak', w_ulica: 'Budowlana 1', w_kod: '31-000', w_miasto: 'Kraków',
      f_firma: 'LUMINA', f_ulica: 'Przykładowa 5', f_kod: '32-600', f_miasto: 'Oświęcim',
    });
    expect(adresOdbiorcy({ dostawa: d.dostawa, klient: d.klient }).miasto).toBe('Kraków');
    expect(daneFaktury({ klient: d.klient, nip: d.nip }).miasto).toBe('Oświęcim');
  });

  // E-mail do faktury i e-mail do wysylki maja W BAZIE jedno miejsce (blok `klient`),
  // wiec rozny adres do faktury musi pojsc jako nadpisanie — inaczej cicho podmienilby
  // adres, pod ktory idzie powiadomienie o paczce (albo odwrotnie).
  it('inny e-mail do faktury zapisuje się jako nadpisanie, nie podmienia e-maila wysyłki', () => {
    const d = parsujNoweZamowienie({ w_email: 'anna@example.pl', f_email: 'faktury@firma.pl' });
    expect(d.nadpisaniaFaktury).toEqual({ email: 'faktury@firma.pl' });
    expect(daneFaktury({ klient: d.klient, klient_reczny_json: JSON.stringify(d.nadpisaniaFaktury) }).email)
      .toBe('faktury@firma.pl');
    expect(adresOdbiorcy({ dostawa: d.dostawa, klient: d.klient }).email).toBe('anna@example.pl');
  });

  it('ten sam e-mail w obu polach nie produkuje żadnego nadpisania', () => {
    const d = parsujNoweZamowienie({ w_email: 'anna@example.pl', f_email: 'anna@example.pl' });
    expect(d.nadpisaniaFaktury).toBeNull();
  });

  it('pusty e-mail do faktury nie produkuje nadpisania', () => {
    expect(parsujNoweZamowienie({ w_email: 'anna@example.pl' }).nadpisaniaFaktury).toBeNull();
  });

  it('koszt dostawy z przecinkiem idzie tą samą drogą, co reszta kwot panelu', () => {
    expect(parsujNoweZamowienie({ koszt_dostawy_brutto: '23,50' }).koszt_dostawy_brutto).toBe('23.50');
  });

  it('ujemny koszt dostawy to odmowa', () => {
    expect(() => parsujNoweZamowienie({ koszt_dostawy_brutto: '-5' })).toThrow();
  });
});

describe('parsujNoweZamowienie — pozycje z pięciu wierszy', () => {
  it('czyta wypełnione wiersze i pomija puste', () => {
    const d = parsujNoweZamowienie({
      poz_nazwa: ['Szablon', '', 'Projekt', '', ''],
      poz_sku: ['SZ-1', '', '', '', ''],
      poz_ilosc: ['2', '', '1', '', ''],
      poz_cena_netto: ['', '', '', '', ''],
      poz_cena_brutto: ['80,00', '', '50.00', '', ''],
    });
    expect(d.pozycje).toHaveLength(2);
    expect(d.pozycje[0]).toMatchObject({ nazwa: 'Szablon', sku: 'SZ-1', ilosc: 2, cena_brutto: '80.00', brutto_linii: '160.00' });
    expect(d.pozycje[1]).toMatchObject({ nazwa: 'Projekt', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' });
  });

  // Netto to WYGODA WEJSCIA — przechowywana wartoscia zostaje brutto (domain/vat.js).
  it('wiersz z samym netto dostaje policzone brutto', () => {
    const d = parsujNoweZamowienie({
      poz_nazwa: ['Szablon'], poz_sku: [''], poz_ilosc: ['1'],
      poz_cena_netto: ['65,04'], poz_cena_brutto: [''],
    });
    expect(d.pozycje[0].cena_brutto).toBe('80.00');
  });

  // ⚠️ Wiersz zaczety, ale niedokonczony, NIE MOZE zniknac po cichu: operator wpisal nazwe
  // przy telefonie i musi sie dowiedziec, ze ceny brakuje — inaczej zamowienie zapisze sie
  // bez pozycji, za ktora klient ma zaplacic.
  it('wiersz z nazwą, ale bez ceny to odmowa ze wskazaniem numeru wiersza', () => {
    expect(() => parsujNoweZamowienie({
      poz_nazwa: ['', 'Szablon'], poz_sku: ['', ''], poz_ilosc: ['', '1'],
      poz_cena_netto: ['', ''], poz_cena_brutto: ['', ''],
    })).toThrow(/wiersz 2/i);
  });

  it('wiersz z ceną, ale bez nazwy to odmowa', () => {
    expect(() => parsujNoweZamowienie({
      poz_nazwa: [''], poz_sku: [''], poz_ilosc: ['1'],
      poz_cena_netto: [''], poz_cena_brutto: ['80.00'],
    })).toThrow(/wiersz 1/i);
  });

  it('same puste wiersze dają zamówienie bez pozycji, nie odmowę', () => {
    const d = parsujNoweZamowienie({
      poz_nazwa: ['', ''], poz_sku: ['', ''], poz_ilosc: ['', ''],
      poz_cena_netto: ['', ''], poz_cena_brutto: ['', ''],
    });
    expect(d.pozycje).toEqual([]);
  });

  // Pojedynczy wiersz przychodzi z przegladarki jako SAM NAPIS, nie tablica jednoelementowa.
  it('pojedynczy wiersz podany bez tablicy też się czyta', () => {
    const d = parsujNoweZamowienie({
      poz_nazwa: 'Szablon', poz_sku: '', poz_ilosc: '3',
      poz_cena_netto: '', poz_cena_brutto: '10.00',
    });
    expect(d.pozycje).toHaveLength(1);
    expect(d.pozycje[0].brutto_linii).toBe('30.00');
  });
});
