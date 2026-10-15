import { describe, it, expect } from 'vitest';
import {
  formularzZwrotu, kwotaZaSztukiGrosze, przygotujKrok2, sumaKwotPozycjiZl,
} from '../../src/domena/zwrot-formularz.js';

// ⚠️ DWIE POZYCJE, W TYM JEDNA Z RABATEM — fikstura z jedna pozycja nie sprawdza NICZEGO
// o czesciowosci ani o rabacie (patrz [[testy-falszywa-zielen]]). „Pies" ma cene jednostkowa
// 35,00 zl przy trzech sztukach, ale sklep policzyl linie na 100,00 zl (rabat 5,00 zl):
// iloczyn 3 × 35,00 = 105,00 zl JEST INNA LICZBA niz wartosc linii i to jest cala pulapka,
// przed ktora broni ten plik.
const zam = (nad = {}) => ({
  id: 7,
  sklep: 'pro',
  kwota_brutto: '317.00',
  koszt_dostawy_brutto: '19.00',
  utworzone_at: '2026-08-01T10:00:00',
  anulowane: 0,
  pozycje: [
    { id: 11, zrodlo: 'sklep', zrodlo_id: 77, nazwa: 'Kot 70x100', ilosc: 2, cena_brutto: '99.00', brutto_linii: '198.00' },
    { id: 12, zrodlo: 'sklep', zrodlo_id: 78, nazwa: 'Pies 50x70', ilosc: 3, cena_brutto: '35.00', brutto_linii: '100.00' },
  ],
  zwroty: [],
  ...nad,
});

const DZIS = '2026-08-14';
const f = (z, opcje = {}) => formularzZwrotu(z, { dzis: DZIS, ...opcje });
const poKluczu = (formularz, klucz) => formularz.pozycje.find((p) => p.klucz === klucz);

describe('podsumowanie zamowienia nad tabela zwrotu', () => {
  it('oddaje cztery liczby: wartosc zamowienia, w tym dostawa, juz zwrocono, zostalo', () => {
    expect(f(zam()).podsumowanie).toEqual({
      zamowienieZl: '317.00', dostawaZl: '19.00', zwroconoZl: '0.00', zostaloZl: '317.00',
    });
  });

  // ⚠️ MIARA TO `kwotaOczekiwanaGrosze` (domain/suma-pozycji.js), A NIE KOLUMNA `kwota_brutto`.
  // Dokladnie ta sama regula, ktorej pilnuje bariera kwoty w `parsujZwrot` — gdyby ekran
  // pokazywal kolumne sklepu, operator widzialby 317,00 zl przy zamowieniu, ktore po dopisanej
  // recznie doplacie jest warte 367,00 zl, a bariera odbijalaby zwrot calosci bez slowa
  // wyjasnienia na ekranie.
  it('wartosc zamowienia liczy kwota OCZEKIWANA, a nie kolumna sklepu `kwota_brutto`', () => {
    const z = zam({
      pozycje: [
        ...zam().pozycje,
        { id: 13, zrodlo: 'reczna', nazwa: 'Dopłata', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' },
      ],
    });
    expect(f(z).podsumowanie.zamowienieZl).toBe('367.00');
    expect(f(z).podsumowanie.zamowienieZl).not.toBe(z.kwota_brutto);
  });

  it('„zostalo do zwrotu" maleje o wczesniejsze zwroty — RAZEM z oddana dostawa', () => {
    const z = zam({
      zwroty: [{
        data: '2026-08-10', kwota: '100.00', kwota_dostawy: '19.00',
        pozycje: [{ klucz_pozycji: 's78', nazwa: 'Pies 50x70', ilosc: 3, kwota: '100.00' }],
      }],
    });
    expect(f(z).podsumowanie.zwroconoZl).toBe('119.00');
    expect(f(z).podsumowanie.zostaloZl).toBe('198.00');
  });
});

describe('proponowane sztuki i kwoty', () => {
  it('proponuje CALA pozostala ilosc kazdej pozycji', () => {
    const formularz = f(zam());
    expect(poKluczu(formularz, 's77')).toMatchObject({ kupiono: 2, doZwrotu: 2, ilosc: 2 });
    expect(poKluczu(formularz, 's78')).toMatchObject({ kupiono: 3, doZwrotu: 3, ilosc: 3 });
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEGO PLIKU. Zwrot CALOSCI ma dac dokladnie `brutto_linii`, bo
  // to ta liczba stoi na fakturze — iloczyn ceny jednostkowej przez sztuki rozjechalby zwrot
  // z zakupem o 5,00 zl przy tej pozycji, a na fakturze KORYGUJACEJ o te same 5,00 zl.
  it('kwota za CALOSC pozycji z rabatem to `brutto_linii`, NIE cena jednostkowa razy sztuki', () => {
    const wiersz = poKluczu(f(zam()), 's78');
    expect(wiersz.kwotaZl).toBe('100.00');
    expect(wiersz.kwotaZl).not.toBe('105.00');
  });

  it('kwota za calosc pozycji BEZ rabatu wychodzi tak samo jak iloczyn — bo linia tak wyglada', () => {
    expect(poKluczu(f(zam()), 's77').kwotaZl).toBe('198.00');
  });

  it('proponowane sztuki i kwoty sa POMNIEJSZONE o wczesniejszy zwrot tej samej pozycji', () => {
    const z = zam({
      zwroty: [{
        data: '2026-08-10', kwota: '33.33', kwota_dostawy: null,
        pozycje: [{ klucz_pozycji: 's78', nazwa: 'Pies 50x70', ilosc: 1, kwota: '33.33' }],
      }],
    });
    const wiersz = poKluczu(f(z), 's78');
    expect(wiersz).toMatchObject({ kupiono: 3, doZwrotu: 2, ilosc: 2 });
    expect(wiersz.kwotaZl).toBe('66.67');
  });

  // ⚠️ DOWOD, ZE ZAOKRAGLENIE NIE GUBI GROSZA. Pierwszy zwrot bierze 1 z 3 sztuk (33,33 zl),
  // drugi bierze RESZTE — i suma obu ma byc rowna `brutto_linii` CO DO GROSZA. Trzy razy
  // po 33,33 zl to 99,99 zl, czyli o grosz mniej niz linia; „reszta" liczona z pozostalej
  // WARTOSCI, a nie z iloczynu, jest jedynym sposobem, zeby ten grosz nie zniknal.
  it('dwa zwroty czesciowe sumuja sie do `brutto_linii` co do grosza', () => {
    const pierwszy = kwotaZaSztukiGrosze(zam().pozycje[1], { sztuki: 1 });
    const drugi = kwotaZaSztukiGrosze(zam().pozycje[1], {
      sztuki: 2, zwroconeSztuki: 1, zwroconeGr: pierwszy,
    });
    expect(pierwszy).toBe(3333);
    expect(drugi).toBe(6667);
    expect(pierwszy + drugi).toBe(10000);
  });

  it('pozycja zwrocona w CALOSCI wczesniej: zero sztuk i nie da sie podniesc', () => {
    const z = zam({
      zwroty: [{
        data: '2026-08-10', kwota: '198.00', kwota_dostawy: null,
        pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 2, kwota: '198.00' }],
      }],
    });
    const wiersz = poKluczu(f(z), 's77');
    expect(wiersz).toMatchObject({ kupiono: 2, doZwrotu: 0, ilosc: 0 });
    expect(wiersz.kwotaZl).toBe('0.00');
  });

  // Czesc pozycji wraca PROPORCJONALNIE do wartosci linii, w groszach i z zaokragleniem —
  // 100,00 zl / 6 szt. to 16,666… zl, czyli 1667 groszy, a nie 1666.
  it('czesc pozycji wraca proporcjonalnie, w groszach, z zaokragleniem', () => {
    const p = { nazwa: 'Sześciopak', ilosc: 6, cena_brutto: '16.67', brutto_linii: '100.00' };
    expect(kwotaZaSztukiGrosze(p, { sztuki: 1 })).toBe(1667);
    expect(kwotaZaSztukiGrosze(p, { sztuki: 3 })).toBe(5000);
    expect(kwotaZaSztukiGrosze(p, { sztuki: 6 })).toBe(10000);
  });

  it('pokazuje cene jednostkowa z zamowienia', () => {
    expect(poKluczu(f(zam()), 's78').cenaJednZl).toBe('35.00');
  });
});

describe('zwrot kosztu dostawy', () => {
  it('proponuje zwrot dostawy z zamowienia — zaznaczony i z wypelniona kwota', () => {
    expect(f(zam()).dostawa).toEqual({
      zaznaczona: true, kwotaZl: '19.00', uwaga: null,
    });
  });

  // ⚠️ Bariera sumy w `parsujZwrot` odbilaby taki zwrot i tak, ale ekran NIE MA PROPONOWAC
  // czegos, co sie nie uda — dostawa oddana W CALOSCI drugi raz nie wraca.
  it('dostawa oddana W CALOSCI we WCZESNIEJSZYM zwrocie nie jest proponowana ponownie', () => {
    const z = zam({
      zwroty: [{ data: '2026-08-10', kwota: '100.00', kwota_dostawy: '19.00', pozycje: [] }],
    });
    expect(f(z).dostawa).toMatchObject({ zaznaczona: false, kwotaZl: '' });
    expect(f(z).dostawa.uwaga).toContain('drugi raz nie wraca');
  });

  // ⚠️⚠️ DROBIAZG M1 (recenzja kontrolna 2026-08-15): EKRAN I BARIERA ROZJECHALY SIE PRZY
  // CZESCIOWYM ZWROCIE DOSTAWY. Ekran pytal „czy zwrocono COKOLWIEK z dostawy" i pisal
  // „Koszt dostawy wrócił już przy wcześniejszym zwrocie — drugi raz nie wraca", a bariera
  // w `parsujZwrot` liczy RESZTE i slusznie pozwala oddac brakujace 10,00 zl z 19,00 zl
  // (test „czesciowy zwrot dostawy zostawia reszte na drugi raz" w zwrot-domena.test.js).
  // Funkcja byla ta sama (`sumaZwroconejDostawyGrosze`), ale REGULA inna — a ekran ma
  // proponowac reszte, nie klamac, ze nic juz nie wroci.
  it('CZESCIOWY zwrot dostawy: ekran proponuje RESZTE, a nie odmawia', () => {
    const z = zam({
      zwroty: [{ data: '2026-08-10', kwota: '100.00', kwota_dostawy: '9.00', pozycje: [] }],
    });
    expect(f(z).dostawa).toMatchObject({
      zaznaczona: true, kwotaZl: '10.00',
    });
  });

  it('przy czesciowym zwrocie dostawy zdanie mowi, ile wrocilo i ile zostalo', () => {
    const z = zam({
      zwroty: [{ data: '2026-08-10', kwota: '100.00', kwota_dostawy: '9.00', pozycje: [] }],
    });
    const { uwaga } = f(z).dostawa;
    expect(uwaga).toContain('9.00');
    expect(uwaga).toContain('10.00');
    // ⚠️ Zdanie, ktore mowilo „drugi raz nie wraca", bylo tu NIEPRAWDA — bariera te 10,00 zl
    // przepuszcza.
    expect(uwaga).not.toContain('drugi raz nie wraca');
  });

  it('zwrot bez dostawy (kwota_dostawy pusta) nie liczy sie jako oddana dostawa', () => {
    const z = zam({
      zwroty: [{ data: '2026-08-10', kwota: '100.00', kwota_dostawy: null, pozycje: [] }],
    });
    expect(f(z).dostawa.kwotaZl).toBe('19.00');
    expect(f(z).dostawa.uwaga).toBeNull();
  });

  it('zamowienie bez kosztu dostawy nie proponuje jej zwrotu', () => {
    expect(f(zam({ koszt_dostawy_brutto: null })).dostawa).toEqual({
      zaznaczona: false, kwotaZl: '', uwaga: null,
    });
  });
});

describe('data i powod', () => {
  it('data domyslnie DZISIEJSZA, powod pusty', () => {
    expect(f(zam())).toMatchObject({ data: DZIS, powod: '' });
  });
});

// ⚠️⚠️ „WSTECZ — POPRAW" Z KROKU 2 NIE MA PRAWA NICZEGO ZGUBIC. Krok 2 odsyla komplet
// wartosci w polach ukrytych, a ten sam formularz musi sie z nich odtworzyc — inaczej
// operator, ktory chce poprawic JEDNA liczbe, traci wszystkie pozostale.
describe('wartosci wpisane przez operatora wygrywaja z propozycja', () => {
  const wpisane = {
    data: '2026-08-12',
    powod: 'uszkodzony w transporcie',
    klucz: ['s77', 's78'],
    nazwa: ['Kot 70x100', 'Pies 50x70'],
    ilosc: ['1', '0'],
    pozycja_kwota: ['99.00', '0.00'],
    kwota_dostawy: '9.50',
    zwroc_dostawe: '1',
  };

  it('oddaje sztuki, kwoty, date i powod tak, jak je wpisano', () => {
    const formularz = f(zam(), { wpisane });
    expect(poKluczu(formularz, 's77')).toMatchObject({ ilosc: 1, kwotaZl: '99.00' });
    expect(poKluczu(formularz, 's78')).toMatchObject({ ilosc: 0, kwotaZl: '0.00' });
    expect(formularz.data).toBe('2026-08-12');
    expect(formularz.powod).toBe('uszkodzony w transporcie');
    expect(formularz.dostawa).toMatchObject({ zaznaczona: true, kwotaZl: '9.50', uwaga: null });
  });

  // Formularz odsyla pozycje w kolejnosci tabeli, ale to nie jest FAKT o zwrocie — dopasowanie
  // po kolejnosci przypisaloby ilosc jednej pozycji do drugiej (ta sama zasada, co przy
  // `wiersze()` w domain/zwrot.js).
  it('dopasowuje wpisane wartosci po KLUCZU pozycji, nie po kolejnosci', () => {
    const odwrocone = {
      ...wpisane,
      klucz: ['s78', 's77'], nazwa: ['Pies 50x70', 'Kot 70x100'],
      ilosc: ['3', '1'], pozycja_kwota: ['100.00', '99.00'],
    };
    const formularz = f(zam(), { wpisane: odwrocone });
    expect(poKluczu(formularz, 's77')).toMatchObject({ ilosc: 1, kwotaZl: '99.00' });
    expect(poKluczu(formularz, 's78')).toMatchObject({ ilosc: 3, kwotaZl: '100.00' });
  });

  it('odznaczona dostawa wraca odznaczona, a pole dostaje z powrotem podpowiedz', () => {
    const bezDostawy = { ...wpisane, zwroc_dostawe: undefined, kwota_dostawy: '' };
    expect(f(zam(), { wpisane: bezDostawy }).dostawa).toMatchObject({
      zaznaczona: false, kwotaZl: '19.00', uwaga: null,
    });
  });

  it('kolejnosc wierszy zostaje ta z zamowienia, nie ta z formularza', () => {
    expect(f(zam(), { wpisane }).pozycje.map((p) => p.klucz)).toEqual(['s77', 's78']);
  });
});

// ⚠️⚠️ KWOTE LACZNA LICZY SERWER — to jest cala tresc przebudowy ekranu. Bariera spojnosci
// w `parsujZwrot` (kwota laczna = suma kwot przy pozycjach) przestaje przez to odrzucac
// operatora i zostaje STRAZNIKIEM: pilnuje, ze miedzy krokiem 1 a zapisem nikt tych dwoch
// liczb nie rozjechal.
describe('suma kwot przy pozycjach (liczy SERWER, nie operator)', () => {
  const cialo = (nad = {}) => ({
    klucz: ['s77', 's78'], nazwa: ['Kot 70x100', 'Pies 50x70'],
    ilosc: ['2', '3'], pozycja_kwota: ['198.00', '100.00'],
    ...nad,
  });

  it('sumuje kwoty wszystkich wracajacych pozycji', () => {
    expect(sumaKwotPozycjiZl(cialo())).toBe('298.00');
  });

  // ⚠️ Pozycja z iloscia 0 NIE WRACA, wiec jej kwota nie ma prawa wejsc do sumy — `parsujZwrot`
  // pomija taki wiersz dokladnie tak samo, a rozjazd miedzy tymi dwoma miejscami odbilby sie
  // od bariery spojnosci przy zapisie.
  it('pomija pozycje, ktore nie wracaja (ilosc 0), mimo wypelnionej kwoty', () => {
    expect(sumaKwotPozycjiZl(cialo({ ilosc: ['2', '0'] }))).toBe('198.00');
  });

  it('przyjmuje przecinek dziesietny — to on stoi na Allegro', () => {
    expect(sumaKwotPozycjiZl(cialo({ pozycja_kwota: ['198,00', '100,50'] }))).toBe('298.50');
  });

  // Grosze, nie floaty: 0,10 + 0,20 na floatach w JS to 0.30000000000000004.
  it('liczy w groszach, nie na floatach', () => {
    expect(sumaKwotPozycjiZl(cialo({ ilosc: ['1', '1'], pozycja_kwota: ['0.10', '0.20'] }))).toBe('0.30');
  });

  it('oddaje null, gdy ktoras kwota nie jest liczba — odmowe wypowie parsujZwrot', () => {
    expect(sumaKwotPozycjiZl(cialo({ pozycja_kwota: ['sto', '100.00'] }))).toBeNull();
  });

  it('oddaje null, gdy tablice formularza maja rozna dlugosc', () => {
    expect(sumaKwotPozycjiZl(cialo({ ilosc: ['2'] }))).toBeNull();
  });
});

// ⚠️⚠️⚠️ WADA KRYTYCZNA Z RECENZJI 2026-08-15: KWOTA NIE PODAZALA ZA ILOSCIA.
//
// Krok 1 wypelnial kwote wartoscia CALEJ pozostalej linii. Operator zmieniał „Wraca (szt.)",
// kwoty nie ruszal (bo i po co — stoi tam wiarygodna liczba, a pod tabela zdanie, ktore do
// niej przekonuje), a panel zapisywal ZWROT 100,00 ZL ZA 1 Z 3 SZTUK zamiast 33,33 zl.
// Przechodzilo WSZYSTKIE bariery, bo suma zgadzala sie sama ze soba.
//
// Skutki byly dwa i oba na zewnatrz panelu: `zwrotyWOkresie` zdejmowalo z przychodu 100,00 zl
// (wprost w podstawie podatku), a `paryKorekty` skladalo korekte mowiaca „z 3 szt. / 100,00 zl
// na 2 szt. / 0,00 zl" — dokument u organu. Do tego kolejnego zwrotu tej pozycji panel sam
// sobie odmawial, bo zostawala mu wartosc 0.
//
// ⚠️ TO BYLA REGRESJA PRZEBUDOWY: wczesniej pola startowaly na zerze i operator wpisywal
// liczbe, ktora sam wybral. Przy rabacie 33,33 zl nie da sie policzyc w glowie, wiec nie bylo
// jak zauwazyc pomylki.
describe('krok 2: kwota PODAZA ZA ILOSCIA', () => {
  // Cialo dokladnie takie, jakie wysyla przegladarka z kroku 1 — RAZEM z ukrytym polem
  // `pozycja_kwota_propozycja`, czyli kwota, KTORA PANEL ZAPROPONOWAL. To ona rozstrzyga,
  // czy operator kwoty dotknal.
  const cialoKroku1 = (nad = {}) => ({
    data: DZIS,
    powod: '',
    klucz: ['s77', 's78'],
    nazwa: ['Kot 70x100', 'Pies 50x70'],
    ilosc: ['2', '3'],
    pozycja_kwota: ['198.00', '100.00'],
    pozycja_kwota_propozycja: ['198.00', '100.00'],
    ...nad,
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEJ NAPRAWY I DLATEGO STOI NA POZYCJI Z RABATEM. Przy pozycji bez
  // rabatu iloczyn ceny przez sztuki daje TE SAMA liczbe, co proporcja z wartosci linii —
  // czyli test niczego nie sprawdza. „Pies 50x70" to 3 szt. po 35,00 zl policzone przez sklep
  // na 100,00 zl: 1 sztuka to 33,33 zl, a nie 35,00 zl i nie 100,00 zl.
  it('zmiana sztuk BEZ dotkniecia kwoty przelicza kwote dla wpisanej liczby sztuk', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '1'] }));
    expect(cialo.pozycja_kwota[1]).toBe('33.33');
    expect(cialo.pozycja_kwota[1]).not.toBe('100.00');
    expect(cialo.pozycja_kwota[1]).not.toBe('35.00');
    // Kwota laczna liczy sie z PRZELICZONYCH pozycji — inaczej krok 2 pokazywalby jedna sume,
    // a zapis niosl druga i bariera spojnosci odbilaby zapis, ktorego operator nie wpisywal.
    expect(cialo.kwota).toBe('33.33');
    // ⚠️ I1 (recenzja kontrolna): przeliczenie NIE JEST CICHE — patrz osobny describe nizej.
    expect(ostrzezenia).toHaveLength(1);
  });

  // Wiersz, ktory NIE WRACA (ilosc 0), zostaje z kwota taka, jaka byla — `parsujZwrot` i tak
  // go pomija, a wyzerowanie jej gubiloby liczbe potrzebna po „Wstecz — popraw".
  it('wiersz z iloscia 0 nie jest przeliczany — jego kwota nie wchodzi do sumy i tak', () => {
    const { cialo } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '1'] }));
    expect(cialo.pozycja_kwota[0]).toBe('198.00');
  });

  // ⚠️ REGULA RABATU ZOSTAJE: zwrot CALEJ pozostalej ilosci to dokladnie `brutto_linii`
  // pomniejszone o to, co juz wrocilo — nigdy iloczyn.
  it('zwrot CALEJ pozostalej ilosci dostaje dokladnie wartosc linii, nie iloczyn', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['2', '3'] }));
    expect(cialo.pozycja_kwota).toEqual(['198.00', '100.00']);
    expect(cialo.kwota).toBe('298.00');
    // ⚠️ Przeliczenie, ktore NICZEGO NIE ZMIENIA, nie ma prawa niczego mowic — inaczej ekran
    // zasypywalby operatora zdaniem przy KAZDYM zwrocie calosci i przestalby byc czytany.
    expect(ostrzezenia).toEqual([]);
  });

  // ⚠️⚠️ DWA ZWROTY CZESCIOWE MUSZA ZEJSC SIE Z LINIA CO DO GROSZA. Trzy razy po 33,33 zl to
  // 99,99 zl — grosza brakuje na fakturze korygujacej. Drugi zwrot bierze RESZTE, bo liczy sie
  // z pozostalej WARTOSCI, a nie z iloczynu.
  it('dwa zwroty czesciowe schodza sie z linia co do grosza — przez KROK 2, nie tylko w arytmetyce', () => {
    const pierwszy = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '1'] })).cialo;
    expect(pierwszy.pozycja_kwota[1]).toBe('33.33');

    const poPierwszym = zam({
      zwroty: [{
        data: '2026-08-10',
        kwota: pierwszy.kwota,
        kwota_dostawy: null,
        pozycje: [{
          klucz_pozycji: 's78', nazwa: 'Pies 50x70', ilosc: 1, kwota: pierwszy.pozycja_kwota[1],
        }],
      }],
    });
    // Krok 1 drugiego zwrotu proponuje 2 szt. za 66,67 zl — a operator schodzi do 1 szt.
    // i kwoty NIE RUSZA. Panel ma policzyc polowe RESZTY (33,34 zl), nie polowe linii.
    const drugi = przygotujKrok2(poPierwszym, cialoKroku1({
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '66.67'],
      pozycja_kwota_propozycja: ['198.00', '66.67'],
    })).cialo;
    expect(drugi.pozycja_kwota[1]).toBe('33.34');

    // A gdy zamiast tego wraca cala reszta — suma obu zwrotow to DOKLADNIE wartosc linii.
    const reszta = przygotujKrok2(poPierwszym, cialoKroku1({
      ilosc: ['0', '2'],
      pozycja_kwota: ['198.00', '66.67'],
      pozycja_kwota_propozycja: ['198.00', '66.67'],
    })).cialo;
    expect(reszta.pozycja_kwota[1]).toBe('66.67');
    expect(Math.round(Number(pierwszy.kwota) * 100) + Math.round(Number(reszta.kwota) * 100))
      .toBe(10000);
  });

  // ⚠️⚠️ CZLOWIEK WYGRYWA (decyzja wlasciciela: „kwotę przepisujesz z Allegro i to ONA jest
  // prawdą") — ale krok 2 MA TO POKAZAC. Ostrzezenie, nie odmowa.
  it('kwota zmieniona RECZNIE wygrywa z przeliczeniem', () => {
    const { cialo } = przygotujKrok2(zam(), cialoKroku1({
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '40.00'],
      pozycja_kwota_propozycja: ['198.00', '100.00'],
    }));
    expect(cialo.pozycja_kwota[1]).toBe('40.00');
    expect(cialo.kwota).toBe('40.00');
  });

  it('reczna kwota rozna od przeliczonej daje OSTRZEZENIE z obiema liczbami', () => {
    const { ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '40.00'],
      pozycja_kwota_propozycja: ['198.00', '100.00'],
    }));
    expect(ostrzezenia).toHaveLength(1);
    expect(ostrzezenia[0]).toContain('Pies 50x70');
    expect(ostrzezenia[0]).toContain('1 z 3');
    expect(ostrzezenia[0]).toContain('40.00');
    expect(ostrzezenia[0]).toContain('33.33');
  });

  // Sytuacja Z RECENZJI, slowo w slowo: „wraca 1 z 3 szt., a wpisana kwota 100,00 zł to
  // wartość całej linii; panel policzyłby 33,33 zł". Po „Wstecz — popraw" pole niesie juz
  // przeliczone 33,33 zl, wiec wpisanie tam z powrotem 100,00 zl jest DECYZJA CZLOWIEKA —
  // i ma zostac, ale nie po cichu.
  it('ostrzezenie nazywa po imieniu kwote rowna CALEJ pozostalej linii', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '100.00'],
      pozycja_kwota_propozycja: ['198.00', '33.33'],
    }));
    expect(cialo.pozycja_kwota[1]).toBe('100.00');
    expect(ostrzezenia[0]).toMatch(/całej pozostałej linii/i);
    expect(ostrzezenia[0]).toContain('33.33');
  });

  it('reczna kwota ZGODNA z przeliczeniem nie ostrzega o niczym', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '33.33'],
      pozycja_kwota_propozycja: ['198.00', '100.00'],
    }));
    expect(cialo.pozycja_kwota[1]).toBe('33.33');
    expect(ostrzezenia).toEqual([]);
  });

  // ⚠️ BEZ POLA PROPOZYCJI PANEL NICZEGO NIE PRZELICZA — i to jest bezpieczna strona pomylki.
  // Recznie sklecony POST (albo formularz z innej wersji panelu) nie ma prawa dostac kwoty
  // PRZEPISANEJ przez panel na podstawie propozycji, ktorej nikomu nie pokazano; ostrzezenie
  // i tak powie, ze liczby sie nie zgadzaja.
  it('bez pola propozycji kwota zostaje taka, jaka przyszla — ale ostrzezenie jest', () => {
    const bezPropozycji = cialoKroku1({ ilosc: ['0', '1'] });
    delete bezPropozycji.pozycja_kwota_propozycja;
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), bezPropozycji);
    expect(cialo.pozycja_kwota[1]).toBe('100.00');
    expect(ostrzezenia).toHaveLength(1);
  });

  // ⚠️ Tablica KROTSZA nie ma prawa „czesciowo pasowac": propozycja pozycji A przypisana do
  // pozycji B kazalaby panelowi przeliczyc kwote, ktorej operator wlasnie bronil. Fikstura ma
  // OBIE ilosci wieksze od zera, bo tylko wtedy pierwszy wiersz w ogole wchodzi w przeliczanie
  // — z iloscia 0 test przechodzilby takze BEZ straznika dlugosci.
  it('propozycja o innej dlugosci niz reszta formularza tez niczego nie przelicza', () => {
    const { cialo } = przygotujKrok2(zam(), cialoKroku1({
      ilosc: ['1', '1'], pozycja_kwota_propozycja: ['198.00'],
    }));
    expect(cialo.pozycja_kwota[0]).toBe('198.00');
    expect(cialo.pozycja_kwota[0]).not.toBe('99.00');
    expect(cialo.pozycja_kwota[1]).toBe('100.00');
  });

  // Reszta ciala idzie dalej BEZ ZMIAN — krok 2 przelicza kwoty pozycji i sume, a nie caly zwrot.
  it('odznaczony checkbox dostawy dalej zeruje kwote dostawy', () => {
    const { cialo } = przygotujKrok2(zam(), cialoKroku1({ kwota_dostawy: '19.00' }));
    expect(cialo.kwota_dostawy).toBe('');
    expect(przygotujKrok2(zam(), cialoKroku1({ kwota_dostawy: '19.00', zwroc_dostawe: '1' })).cialo.kwota_dostawy)
      .toBe('19.00');
  });

  it('formularz o nierownych tablicach idzie dalej nietkniety — odmowe wypowie parsujZwrot', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['1'] }));
    expect(cialo.pozycja_kwota).toEqual(['198.00', '100.00']);
    expect(cialo.kwota).toBe('0');
    expect(ostrzezenia).toEqual([]);
  });
});

// ⚠️⚠️ WADA WAZNA I1 (recenzja kontrolna 2026-08-15): PANEL PRZELICZAL PO CICHU KWOTE, KTORA
// OPERATOR ZOSTAWIL SWIADOMIE.
//
// Rozpoznanie „operator kwoty nie dotknal" to porownanie `propozycja === wpisana` — i da sie
// je oszukac PRZYPADKIEM, w druga strone niz naprawiona wczesniej wada krytyczna. Zmierzone:
// pozycja 3 szt. / `brutto_linii` 100,00 zl (rabat). Allegro oddalo kupujacemu 100,00 zl przy
// zwrocie 1 szt. (gest, wyrownanie kosztu odeslania). Operator ustawia „wraca 1" i ZOSTAWIA
// 100,00 zl, BO TYLE NAPRAWDE WYSZLO — a panel uznaje to za „nietkniete" i zapisuje 33,33 zl.
// Bez slowa. Do podstawy podatku wchodzi 33,33 zamiast 100,00, a korekta jest o 66,67 za mala.
//
// ⚠️ REGULA SIE NIE ZMIENIA: kwota nietknieta NADAL sie przelicza, kwota zmieniona NADAL
// wygrywa. Zmienia sie jedno — przeliczenie przestaje byc CICHE.
describe('I1: przeliczenie kwoty NIETKNIETEJ nie jest ciche', () => {
  const cialoKroku1 = (nad = {}) => ({
    data: DZIS,
    powod: '',
    klucz: ['s77', 's78'],
    nazwa: ['Kot 70x100', 'Pies 50x70'],
    ilosc: ['2', '3'],
    pozycja_kwota: ['198.00', '100.00'],
    pozycja_kwota_propozycja: ['198.00', '100.00'],
    ...nad,
  });

  // Sytuacja ZMIERZONA, slowo w slowo. Panel ma powiedziec, ZE przeliczyl i Z CZEGO NA CO.
  it('kwota zostawiona SWIADOMIE, a przeliczona — zdanie z OBIEMA liczbami', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '1'] }));
    expect(cialo.pozycja_kwota[1]).toBe('33.33');
    expect(ostrzezenia).toHaveLength(1);
    expect(ostrzezenia[0]).toContain('Pies 50x70');
    // OBIE kwoty: ta, ktora stala w polu, i ta, ktora panel wstawil na jej miejsce.
    expect(ostrzezenia[0]).toContain('100.00');
    expect(ostrzezenia[0]).toContain('33.33');
    // I POWOD przeliczenia — bez niego zdanie jest zagadka.
    expect(ostrzezenia[0]).toContain('1 z 3');
  });

  // ⚠️ OSTRZEZENIE, NIE ODMOWA — dokladnie jak przy kwocie zmienionej recznie. Kwota
  // przeliczona zostaje w ciele, a przycisk „Zarejestruj zwrot" na kroku 2 zostaje na miejscu.
  it('to jest OSTRZEZENIE: kwota przeliczona i tak jedzie dalej, razem z suma', () => {
    const { cialo } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '1'] }));
    expect(cialo.pozycja_kwota[1]).toBe('33.33');
    expect(cialo.kwota).toBe('33.33');
  });

  // ⚠️ ZDANIE MA SIE POJAWIAC TYLKO WTEDY, GDY PRZELICZENIE FAKTYCZNIE ZMIENILO LICZBE.
  // Zwrot calosci (najczestszy) przechodzi przez te sama sciezke „nietkniete" i wychodzi z niej
  // z ta sama kwota — ekran ma wtedy milczec, bo zdanie o niczym uczy operatora, zeby zdan
  // nie czytal.
  it('kwota nietknieta i NIEZMIENIONA przez przeliczenie nie generuje zadnego zdania', () => {
    const { cialo, ostrzezenia } = przygotujKrok2(zam(), cialoKroku1());
    expect(cialo.pozycja_kwota).toEqual(['198.00', '100.00']);
    expect(ostrzezenia).toEqual([]);
  });

  // Pozycja BEZ rabatu przy czesciowym zwrocie tez sie przelicza (198,00 → 99,00) i tez ma
  // o tym powiedziec — rabat nie jest warunkiem, jest tylko najbolesniejszym przykladem.
  it('mowi takze przy pozycji bez rabatu, gdy wraca czesc', () => {
    const { ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['1', '0'] }));
    expect(ostrzezenia).toHaveLength(1);
    expect(ostrzezenia[0]).toContain('198.00');
    expect(ostrzezenia[0]).toContain('99.00');
  });

  // Wiersz, ktory NIE WRACA, nie jest przeliczany — wiec i mowic o nim nie ma czego.
  it('wiersz z iloscia 0 nie generuje zdania o przeliczeniu', () => {
    const { ostrzezenia } = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '3'] }));
    expect(ostrzezenia).toEqual([]);
  });

  // ⚠️ Zdanie o PRZELICZENIU i zdanie o kwocie ZMIENIONEJ RECZNIE to dwie rozne rzeczy i maja
  // sie nie mylic: pierwsze mowi „panel zmienil Twoja liczbe", drugie „panel Twojej liczby
  // NIE zmienil, choc policzylby inaczej".
  it('nie myli sie ze zdaniem o kwocie zmienionej recznie', () => {
    const przeliczone = przygotujKrok2(zam(), cialoKroku1({ ilosc: ['0', '1'] })).ostrzezenia[0];
    const reczne = przygotujKrok2(zam(), cialoKroku1({
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '40.00'],
      pozycja_kwota_propozycja: ['198.00', '100.00'],
    })).ostrzezenia[0];
    expect(przeliczone).toMatch(/przeliczy/i);
    expect(reczne).not.toMatch(/przeliczy/i);
    expect(reczne).toMatch(/Zostaje Twoja kwota/i);
  });
});

// ⚠️⚠️ KROK 1 NIESIE PROPOZYCJE W POLU UKRYTYM — bez niej krok 2 nie ma jak odroznic kwoty,
// ktorej operator NIE TKNAL, od kwoty, ktora sam wpisal. To jest cala mechanika naprawy.
describe('propozycja kwoty jako fakt przenoszony na krok 2', () => {
  it('na swiezym ekranie propozycja jest DOKLADNIE tym, co stoi w polu kwoty', () => {
    const formularz = f(zam());
    expect(poKluczu(formularz, 's78')).toMatchObject({ kwotaZl: '100.00', propozycjaZl: '100.00' });
    expect(poKluczu(formularz, 's77')).toMatchObject({ kwotaZl: '198.00', propozycjaZl: '198.00' });
  });

  // ⚠️ Po „Wstecz — popraw" propozycja liczy sie dla POKAZANEJ liczby sztuk, a nie dla calej
  // linii. Inaczej kwota przeliczona przez krok 2 (33,33 zl przy 1 szt.) wygladalaby po
  // powrocie jak „recznie wpisana" i przestalaby podazac za kolejna zmiana ilosci.
  it('po powrocie z kroku 2 propozycja pasuje do pokazanej liczby sztuk', () => {
    const wpisane = {
      klucz: ['s77', 's78'],
      nazwa: ['Kot 70x100', 'Pies 50x70'],
      ilosc: ['0', '1'],
      pozycja_kwota: ['198.00', '33.33'],
    };
    const wiersz = poKluczu(f(zam(), { wpisane }), 's78');
    expect(wiersz).toMatchObject({ ilosc: 1, kwotaZl: '33.33', propozycjaZl: '33.33' });
  });
});

// ⚠️⚠️ WADA WAZNA Z RECENZJI 2026-08-15: PROPOZYCJA BYWALA ODBIJANA PRZEZ WLASNA BARIERE PANELU.
//
// Propozycja sumuje wartosci linii plus dostawe, a bariera mierzy `kwotaOczekiwanaGrosze`. Gdy
// linie i dostawa NIE SUMUJA SIE do kwoty zamowienia (stan, dla ktorego panel ma osobna odmowe
// przy fakturze), zwrot calosci byl odrzucany: kafel mowil „Zostało do zwrotu 317,00 zł", pola
// wypelnialy sie na 317,90 zl, a zapis odbijal sie komunikatem o przekroczeniu. Operator
// dostawal odmowe za liczby, ktorych nie wpisal, i nie mial jak zgadnac, ktora pozycje sciac
// o 90 groszy.
describe('ostrzezenie, gdy propozycja przekracza „Zostalo do zwrotu"', () => {
  // Dokladnie stan zmierzony w recenzji: 198,00 + 100,90 + dostawa 19,00 przy kwocie
  // zamowienia 317,00 zl.
  const zamNiespojne = (nad = {}) => zam({
    kwota_brutto: '317.00',
    pozycje: [
      { id: 11, zrodlo: 'sklep', zrodlo_id: 77, nazwa: 'Kot 70x100', ilosc: 2, cena_brutto: '99.00', brutto_linii: '198.00' },
      { id: 12, zrodlo: 'sklep', zrodlo_id: 78, nazwa: 'Pies 50x70', ilosc: 1, cena_brutto: '100.90', brutto_linii: '100.90' },
    ],
    ...nad,
  });

  it('mowi to WPROST na kroku 1 — z obiema liczbami i z roznica do sciecia', () => {
    const formularz = f(zamNiespojne());
    expect(formularz.podsumowanie.zostaloZl).toBe('317.00');
    expect(formularz.ostrzezenieSumy).toContain('317.90');
    expect(formularz.ostrzezenieSumy).toContain('317.00');
    expect(formularz.ostrzezenieSumy).toContain('0.90');
  });

  it('milczy, gdy zamowienie sumuje sie samo ze soba', () => {
    expect(f(zam()).ostrzezenieSumy).toBeNull();
  });

  // Odznaczona dostawa zdejmuje 19,00 zl z propozycji — i wtedy nie ma juz czego przekraczac.
  it('milczy, gdy dostawa nie wraca i propozycja miesci sie w „Zostalo"', () => {
    const wpisane = {
      klucz: ['s77', 's78'],
      nazwa: ['Kot 70x100', 'Pies 50x70'],
      ilosc: ['2', '1'],
      pozycja_kwota: ['198.00', '100.90'],
    };
    expect(f(zamNiespojne(), { wpisane }).ostrzezenieSumy).toBeNull();
  });

  it('milczy przy zamowieniu bez ani jednej pozycji do zwrotu', () => {
    expect(f(zam({ pozycje: [] })).ostrzezenieSumy).toBeNull();
  });

  // ⚠️⚠️ DROBIAZG M2 (recenzja kontrolna 2026-08-15): ZDANIE MIALO ZASZYTA DIAGNOZE I BYWALO
  // NIEPRAWDZIWE. Komunikat orzekal „To zamówienie nie sumuje się samo ze sobą" TAKZE wtedy,
  // gdy zamowienie sumuje sie doskonale, a rozjazd zrobil WCZESNIEJSZY ZWROT: Allegro oddalo
  // za pozycje 248,00 zl przy wartosci 198,00 zl (gest), wiec zostaje 69,00 zl, a podpowiedzi
  // daja 119,00 zl. Panel oskarzal zamowienie i radzil „zetnij o 50,00 zł kwotę przy którejś
  // pozycji" — czyli dokladnie te liczbe, ktorej nie da sie wytlumaczyc na fakturze
  // korygujacej. Ma mowic, CO NAPRAWDE WIE: ile zostalo i o ile podpowiedz to przekracza.
  describe('komunikat nie zgaduje PRZYCZYNY rozjazdu', () => {
    // Zamowienie sumuje sie samo ze soba CO DO GROSZA (198 + 100 + 19 = 317). Rozjazd robi
    // wylacznie wczesniejszy zwrot oddany „na gest".
    const poHojnymZwrocie = () => zam({
      zwroty: [{
        data: '2026-08-10',
        kwota: '248.00',
        kwota_dostawy: null,
        pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 2, kwota: '248.00' }],
      }],
    });

    it('podaje trzy liczby, ktore panel ZNA: sume podpowiedzi, „zostalo" i nadwyzke', () => {
      const zdanie = f(poHojnymZwrocie()).ostrzezenieSumy;
      expect(zdanie).toContain('119.00');
      expect(zdanie).toContain('69.00');
      expect(zdanie).toContain('50.00');
    });

    it('NIE oskarza zamowienia o to, ze „nie sumuje sie samo ze soba"', () => {
      const zdanie = f(poHojnymZwrocie()).ostrzezenieSumy;
      expect(zdanie).not.toMatch(/nie sumuje się samo ze sobą/i);
      // Tu zamowienie sumuje sie doskonale — zdanie o „pozycjach i dostawie dajacych wiecej
      // niz kwota" byloby po prostu falszywe.
      expect(zdanie).not.toMatch(/dają więcej niż kwota/i);
    });

    // Ta sama tresc rowniez przy zamowieniu, ktore NAPRAWDE sie nie sumuje — bo panel nie ma
    // jak odroznic jednej przyczyny od drugiej i nie ma prawa udawac, ze ma.
    it('to samo zdanie przy zamowieniu, ktore faktycznie sie nie sumuje — bez diagnozy', () => {
      const zdanie = f(zamNiespojne()).ostrzezenieSumy;
      expect(zdanie).not.toMatch(/nie sumuje się samo ze sobą/i);
      expect(zdanie).toContain('0.90');
    });
  });
});

// ⚠️⚠️ PODLOGA ZERA (drobiazg 1 z recenzji). Allegro potrafi oddac WIECEJ, niz warta byla linia
// — po takim zwrocie kafel pokazywal „Zostało do zwrotu −11,00 zł", a pole kwoty `−50.00`.
// Liczba ujemna w polu kwoty zwrotu nie znaczy nic, czego panel umialby zapisac (`parsujZwrot`
// odmawia kwocie ujemnej), wiec ekran nie ma jej proponowac.
describe('podloga zera', () => {
  it('kwota za sztuki nie schodzi ponizej zera, gdy wczesniej oddano wiecej niz wartosc linii', () => {
    const p = { nazwa: 'Kot 70x100', ilosc: 2, cena_brutto: '99.00', brutto_linii: '198.00' };
    expect(kwotaZaSztukiGrosze(p, { sztuki: 1, zwroconeSztuki: 1, zwroconeGr: 24800 })).toBe(0);
    expect(kwotaZaSztukiGrosze(p, { sztuki: 2, zwroconeSztuki: 0, zwroconeGr: 25000 })).toBe(0);
  });

  it('pole kwoty na kroku 1 dostaje 0.00, a nie liczbe ujemna', () => {
    const z = zam({
      zwroty: [{
        data: '2026-08-10',
        kwota: '248.00',
        kwota_dostawy: null,
        pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '248.00' }],
      }],
    });
    const wiersz = poKluczu(f(z), 's77');
    expect(wiersz.kwotaZl).toBe('0.00');
    expect(wiersz.propozycjaZl).toBe('0.00');
  });

  it('kafel „Zostalo do zwrotu" pokazuje 0.00, a nie −11.00', () => {
    const z = zam({
      zwroty: [{ data: '2026-08-10', kwota: '328.00', kwota_dostawy: null, pozycje: [] }],
    });
    expect(f(z).podsumowanie.zostaloZl).toBe('0.00');
    expect(f(z).podsumowanie.zwroconoZl).toBe('328.00');
  });
});

// ⚠️⚠️ DROBIAZG I2 (recenzja kontrolna 2026-08-15): STRAZNIK STAL ZA PLECAMI ODCZYTU CENY.
// `kwotaZaSztukiGrosze` wolala `wartoscPozycjiGrosze(p)` PRZED sprawdzeniem `sztuki <= 0`, wiec
// pozycja bez ceny rzucala nawet wtedy, gdy odpowiedz i tak brzmiala „zero". Warstwa domenowa
// ma NIGDY nie rzucac tam, gdzie umie odpowiedziec — a `parsujZwrot` i tak odmowi takiemu
// zamowieniu zapisu, swoim wlasnym zdaniem po polsku.
describe('pozycja BEZ CENY nie wywraca liczenia tam, gdzie odpowiedz brzmi zero', () => {
  const bezCeny = { nazwa: 'Bez ceny', ilosc: 3, cena_brutto: '', brutto_linii: null };

  it('zero sztuk przy pozycji bez ceny oddaje 0, a nie wyjatek', () => {
    expect(() => kwotaZaSztukiGrosze(bezCeny, { sztuki: 0 })).not.toThrow();
    expect(kwotaZaSztukiGrosze(bezCeny, { sztuki: 0 })).toBe(0);
  });

  it('pozycja zwrocona juz w calosci (brak pozostalych sztuk) tez oddaje 0', () => {
    expect(kwotaZaSztukiGrosze(bezCeny, { sztuki: 1, zwroconeSztuki: 3 })).toBe(0);
  });

  // ⚠️ Gdy sztuki NAPRAWDE wracaja, ceny nie da sie obejsc i wyjatek jest jedyna uczciwa
  // odpowiedzia — lapie go trasa (routes/zwroty.js) i zamienia na zdanie po polsku.
  it('gdy sztuki wracaja, brak ceny dalej rzuca — i to jest poprawne', () => {
    expect(() => kwotaZaSztukiGrosze(bezCeny, { sztuki: 1 })).toThrow(/Brak kwoty/);
  });
});
