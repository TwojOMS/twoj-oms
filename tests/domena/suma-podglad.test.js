import { describe, it, expect } from 'vitest';
import { parsujPozycjeFormularza } from '../../src/domena/nowe-zamowienie.js';
import { parsujKosztDostawy } from '../../src/domena/koszt-dostawy.js';
import { sumaPozycjiZWysylkaGrosze } from '../../src/domena/suma-pozycji.js';
import { STAWKA_VAT } from '../../src/domena/vat.js';
import { kwotaFormularzaGrosze, liniaGrosze, pustyWiersz } from '../../src/public/suma-podglad.js';

// ⚠️ PO CO TEN PLIK ISTNIEJE (07.08.2026).
//
// Ekran „Nowe zamówienie" liczy kwotę NA ŻYWO, w przeglądarce — decyzja właściciela. Do tego
// dnia widok wprost odmawiał: „liczenie w przeglądarce byłoby DRUGĄ implementacją reguły
// z domain/suma-pozycji.js — dwa miejsca, które prędzej czy później się rozjadą".
//
// Obiekcja była słuszna i nie znika przez to, że funkcja została zamówiona. Ten test jest jej
// spłatą: importuje **DOKŁADNIE TEN PLIK, KTÓRY WYKONUJE PRZEGLĄDARKA**
// (`src/web/public/suma-podglad.js`, ładowany przez `<script type="module">`) i puszcza go
// razem z PRAWDZIWYM parserem serwera po wspólnej tablicy przypadków. Rozjazd którejkolwiek
// strony wywala test, a nie fakturę.
//
// ⚠️ Gdyby ktoś kiedyś przeniósł skrypt z pliku do wnętrza widoku, ten test zacznie pilnować
// KOPII, a nie kodu, który naprawdę jedzie do przeglądarki — i przestanie cokolwiek znaczyć.
// Skrypt ma zostać osobnym plikiem.

const VAT = Number(STAWKA_VAT);

// Formularz przysyła RÓWNOLEGŁE TABLICE (`poz_ilosc[]`, `poz_cena_brutto[]`…). Tu składamy
// je z wierszy, żeby przypadki czytało się jak wiersze tabeli na ekranie.
function cialo(wiersze, kosztDostawy) {
  return {
    poz_nazwa: wiersze.map((w) => w.nazwa ?? ''),
    poz_sku: wiersze.map((w) => w.sku ?? ''),
    poz_ilosc: wiersze.map((w) => w.ilosc ?? ''),
    poz_cena_netto: wiersze.map((w) => w.cena_netto ?? ''),
    poz_cena_brutto: wiersze.map((w) => w.cena_brutto ?? ''),
    koszt_dostawy_brutto: kosztDostawy,
  };
}

/**
 * Kwota WEDŁUG SERWERA — tą samą drogą, którą naprawdę idzie zapis: parser formularza,
 * parser kosztu dostawy, a na końcu ta sama suma, którą czyta bariera arytmetyczna faktury.
 *
 * `null` znaczy „serwer by tego nie przyjął" — i to jest połowa kontraktu, bo podgląd
 * w przeglądarce ma wtedy pokazać myślnik, a nie liczbę mniejszą o pominięty wiersz.
 */
function wedlugSerwera(wiersze, kosztDostawy) {
  try {
    const pozycje = parsujPozycjeFormularza(cialo(wiersze, kosztDostawy));
    const koszt = parsujKosztDostawy(kosztDostawy);
    return sumaPozycjiZWysylkaGrosze({ pozycje, koszt_dostawy_brutto: koszt });
  } catch {
    return null;
  }
}

const wedlugPrzegladarki = (wiersze, kosztDostawy) => kwotaFormularzaGrosze(wiersze, kosztDostawy, VAT);

const zgodne = (wiersze, kosztDostawy) => {
  const serwer = wedlugSerwera(wiersze, kosztDostawy);
  const przegladarka = wedlugPrzegladarki(wiersze, kosztDostawy);
  return { serwer, przegladarka };
};

describe('podgląd kwoty w przeglądarce liczy TO SAMO, co serwer przy zapisie', () => {
  const PRZYPADKI = [
    ['jedna pozycja i dostawa', [{ nazwa: 'Szablon', ilosc: '2', cena_brutto: '100.00' }], '19,00'],
    ['przecinek dziesiętny w cenie', [{ nazwa: 'A', ilosc: '1', cena_brutto: '19,99' }], '0'],
    ['przecinek dziesiętny w dostawie', [{ nazwa: 'A', ilosc: '1', cena_brutto: '10.00' }], '12,90'],
    // Netto to WYGODA WEJŚCIA — serwer przelicza je na brutto tylko przy pustym polu brutto.
    ['samo netto', [{ nazwa: 'A', ilosc: '3', cena_netto: '100' }], '19,00'],
    ['netto z groszami', [{ nazwa: 'A', ilosc: '1', cena_netto: '81,30' }], ''],
    ['netto 0,01 — zaokrąglenie na granicy', [{ nazwa: 'A', ilosc: '7', cena_netto: '0,01' }], ''],
    // ⚠️ Brutto WYGRYWA, gdy podane — inaczej panel liczyłby od netta wpisanego wcześniej.
    ['brutto wygrywa z nettem', [{ nazwa: 'A', ilosc: '1', cena_netto: '1.00', cena_brutto: '5.00' }], ''],
    ['pięć wierszy, cztery puste', [
      { nazwa: 'A', ilosc: '1', cena_brutto: '61.50' }, {}, {}, {}, {},
    ], '19,00'],
    ['same puste wiersze', [{}, {}, {}, {}, {}], ''],
    ['pusty formularz z samą dostawą', [{}], '19,00'],
    ['dużo pozycji', [
      { nazwa: 'A', ilosc: '3', cena_brutto: '33.33' },
      { nazwa: 'B', ilosc: '11', cena_brutto: '9.09' },
      { nazwa: 'C', ilosc: '1', cena_netto: '250,49' },
    ], '23,00'],
    ['dostawa pusta znaczy zero', [{ nazwa: 'A', ilosc: '1', cena_brutto: '10.00' }], ''],
    ['dostawa zero wpisana wprost', [{ nazwa: 'A', ilosc: '1', cena_brutto: '10.00' }], '0,00'],
  ];

  it.each(PRZYPADKI)('%s', (_nazwa, wiersze, koszt) => {
    const { serwer, przegladarka } = zgodne(wiersze, koszt);
    expect(serwer).not.toBeNull();
    expect(przegladarka).toBe(serwer);
  });

  // ⚠️ DRUGA POŁOWA KONTRAKTU: tam, gdzie serwer ODMÓWI, podgląd ma pokazać myślnik.
  // Liczba mniejsza o pominięty wiersz byłaby gorsza niż jej brak — wygląda na prawdziwą.
  const ODMOWY = [
    ['wiersz zaczęty, bez ceny', [{ nazwa: 'Szablon', ilosc: '1' }], '19,00'],
    ['wiersz zaczęty, bez ilości', [{ nazwa: 'Szablon', cena_brutto: '10.00' }], '19,00'],
    ['sama nazwa', [{ nazwa: 'Szablon' }], ''],
    ['ilość ułamkowa', [{ nazwa: 'A', ilosc: '1,5', cena_brutto: '10.00' }], ''],
    ['ilość zero', [{ nazwa: 'A', ilosc: '0', cena_brutto: '10.00' }], ''],
    ['ilość ujemna', [{ nazwa: 'A', ilosc: '-2', cena_brutto: '10.00' }], ''],
    ['cena zero', [{ nazwa: 'A', ilosc: '1', cena_brutto: '0' }], ''],
    ['cena ujemna', [{ nazwa: 'A', ilosc: '1', cena_brutto: '-5.00' }], ''],
    ['cena nieliczbowa', [{ nazwa: 'A', ilosc: '1', cena_brutto: 'dwadzieścia' }], ''],
    ['dostawa ujemna', [{ nazwa: 'A', ilosc: '1', cena_brutto: '10.00' }], '-5,00'],
    ['dostawa nieliczbowa', [{ nazwa: 'A', ilosc: '1', cena_brutto: '10.00' }], 'aaa'],
    ['drugi wiersz niepełny psuje całość', [
      { nazwa: 'A', ilosc: '1', cena_brutto: '10.00' }, { nazwa: 'B' },
    ], ''],
  ];

  it.each(ODMOWY)('odmowa serwera → myślnik w podglądzie: %s', (_nazwa, wiersze, koszt) => {
    const { serwer, przegladarka } = zgodne(wiersze, koszt);
    expect(serwer).toBeNull();
    expect(przegladarka).toBeNull();
  });

  // ⚠️ ZAOKRĄGLENIA NA MASOWYCH DANYCH. Pojedyncze przypadki wybiera człowiek i wybiera te,
  // o których pomyślał; ta pętla przechodzi 2000 kombinacji cen, ilości i kosztów dostawy —
  // czyli dokładnie tam, gdzie rozjeżdżają się dwie implementacje liczące na złotówkach
  // zamiast na całkowitych groszach. Generator jest DETERMINISTYCZNY (własny LCG, nie
  // Math.random), żeby porażka dała się powtórzyć co do przypadku.
  it('2000 losowych formularzy — grosz w grosz', () => {
    let ziarno = 20260807;
    const losowa = () => {
      ziarno = (ziarno * 1103515245 + 12345) % 2147483648;
      return ziarno / 2147483648;
    };
    const kwota = () => (Math.floor(losowa() * 100000) / 100).toFixed(2);

    for (let i = 0; i < 2000; i += 1) {
      const wiersze = [];
      const ile = 1 + Math.floor(losowa() * 5);
      for (let j = 0; j < ile; j += 1) {
        const przezNetto = losowa() < 0.5;
        const cena = kwota().replace('.', losowa() < 0.5 ? ',' : '.');
        wiersze.push({
          nazwa: `poz ${j}`,
          ilosc: String(1 + Math.floor(losowa() * 30)),
          ...(przezNetto ? { cena_netto: cena } : { cena_brutto: cena }),
        });
      }
      const koszt = losowa() < 0.3 ? '' : kwota();
      const { serwer, przegladarka } = zgodne(wiersze, koszt);
      // Wylosowana cena bywa zerem — wtedy OBIE strony mają odmówić, i to też jest wynik.
      expect(przegladarka, `formularz ${i}: ${JSON.stringify(wiersze)} + dostawa "${koszt}"`)
        .toBe(serwer);
    }
  });
});

describe('reguły pojedynczego wiersza', () => {
  it('pusty wiersz to taki, w którym puste są WSZYSTKIE pięć pól', () => {
    expect(pustyWiersz({})).toBe(true);
    expect(pustyWiersz({ nazwa: '', sku: '  ', ilosc: '', cena_netto: '', cena_brutto: '' })).toBe(true);
    // ⚠️ Samo SKU wystarczy, żeby wiersz przestał być pusty — dokładnie jak na serwerze
    // (`pusteWiersz` w domain/nowe-zamowienie.js). Inaczej podgląd pomijałby wiersz, który
    // serwer zaraz odrzuci jako niekompletny.
    expect(pustyWiersz({ sku: 'PRO-1' })).toBe(false);
  });

  it('linia to cena w groszach RAZY ilość, nie odwrotnie zaokrąglona', () => {
    // 3 × 33,33 zł = 99,99 zł — nigdy 100,00 zł liczone od sumy.
    expect(liniaGrosze({ ilosc: '3', cena_brutto: '33.33' }, VAT)).toBe(9999);
  });
});
