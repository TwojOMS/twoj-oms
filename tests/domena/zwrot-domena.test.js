import { describe, it, expect } from 'vitest';
import {
  parsujZwrot, zwrotRozliczony, powodOdmowyUsunieciaZwrotu, sumaZwrotowGrosze, korektaPrzepadla,
  czyTenSamZwrot, powodOdmowyOdblokowaniaKorekty, parsujNumerKorekty,
  wiecejNizJedenOtwartySprawaKorekty, korektaNieSprawdzona, powodOdmowyRejestracjiZwrotu,
} from '../../src/domena/zwrot.js';

// Zamowienie z DWIEMA pozycjami — jednopozycyjna fikstura nie sprawdza niczego
// o czesciowosci (patrz [[testy-falszywa-zielen]]: fikstura wymaga wlasnego straznika).
const zam = (nad = {}) => ({
  id: 7, kwota_brutto: '317.90', utworzone_at: '2026-08-01T10:00:00', anulowane: 0,
  koszt_dostawy_brutto: '19.00',
  pozycje: [
    { id: 11, zrodlo: 'sklep', zrodlo_id: 77, nazwa: 'Kot 70x100', ilosc: 2, brutto_linii: '198.00' },
    { id: 12, zrodlo: 'sklep', zrodlo_id: 78, nazwa: 'Pies 50x70', ilosc: 1, brutto_linii: '100.90' },
  ],
  zwroty: [],
  ...nad,
});

const cialo = (nad = {}) => ({
  data: '2026-08-14', kwota: '99.00', kwota_dostawy: '', powod: 'nie pasuje',
  klucz: ['s77', 's78'], ilosc: ['1', '0'], nazwa: ['Kot 70x100', 'Pies 50x70'],
  pozycja_kwota: ['99.00', '0'],
  ...nad,
});

const DZIS = '2026-08-14';

describe('parsowanie zwrotu', () => {
  it('bierze wylacznie pozycje z iloscia wieksza od zera', () => {
    const { zwrot, blad } = parsujZwrot(zam(), cialo(), { dzis: DZIS });
    expect(blad).toBeNull();
    expect(zwrot.pozycje).toEqual([
      { klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' },
    ]);
    expect(zwrot.kwota).toBe('99.00');
  });

  // ⚠️ `pozycja_kwota` MUSI byc zgodna z naglowkowa `kwota` (dopisane przy naprawie bariery
  // spojnosci, 2026-08-15) — inaczej ten test lapalby TA NOWA bariere zamiast bariery
  // "przekracza kwote zamowienia", ktora ma izolowac.
  it('odmawia, gdy suma zwrotow przekroczylaby kwote zamowienia', () => {
    const { blad } = parsujZwrot(zam(), cialo({ kwota: '31033', pozycja_kwota: ['31033', '0'] }), { dzis: DZIS });
    expect(blad).toMatch(/przekracza/i);
  });

  it('liczy WCZESNIEJSZE zwroty przy barierze kwoty', () => {
    const z = zam({ zwroty: [{ kwota: '300.00', kwota_dostawy: null, pozycje: [] }] });
    const { blad } = parsujZwrot(z, cialo({ kwota: '99.00' }), { dzis: DZIS });
    expect(blad).toMatch(/przekracza/i);
  });

  it('odmawia zwrotu wiekszej liczby sztuk, niz kupiono — z uwzglednieniem poprzednich zwrotow', () => {
    const z = zam({
      zwroty: [{ kwota: '99.00', pozycje: [{ klucz_pozycji: 's77', ilosc: 1, kwota: '99.00', nazwa: 'Kot 70x100' }] }],
    });
    const { blad } = parsujZwrot(z, cialo({ ilosc: ['2', '0'] }), { dzis: DZIS });
    expect(blad).toMatch(/sztuk/i);
  });

  // M1: komunikat MA BYC PO LUDZKU. Do 2026-08-15 stalo tu „Zwrot musi obejmować ani jednej
  // pozycji mniej niż jedną — albo zwrot samej dostawy." — zdanie niegramatyczne, a jest to
  // JEDYNY komunikat, jaki operator dostaje w tej sytuacji. Test pilnuje TRESCI, nie tylko
  // faktu odmowy: sama odmowa byla i wczesniej.
  it('odmawia zwrotu bez pozycji i bez kwoty dostawy — komunikatem, ktory da sie przeczytac', () => {
    const { blad } = parsujZwrot(zam(), cialo({ ilosc: ['0', '0'] }), { dzis: DZIS });
    expect(blad).toMatch(/co najmniej jedną pozycję/i);
    expect(blad).not.toMatch(/ani jednej pozycji mniej niż jedną/);
  });

  it('przyjmuje zwrot SAMEJ dostawy, bez pozycji', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ ilosc: ['0', '0'], kwota: '0', kwota_dostawy: '19.00' }), { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(zwrot.pozycje).toEqual([]);
    expect(zwrot.kwotaDostawy).toBe('19.00');
  });

  it('odmawia daty z przyszlosci i daty sprzed zamowienia', () => {
    expect(parsujZwrot(zam(), cialo({ data: '2026-08-15' }), { dzis: DZIS }).blad).toMatch(/przyszł/i);
    expect(parsujZwrot(zam(), cialo({ data: '2026-07-31' }), { dzis: DZIS }).blad).toMatch(/przed zamówieniem/i);
  });

  it('odmawia zwrotu do zamowienia anulowanego', () => {
    expect(parsujZwrot(zam({ anulowane: 1 }), cialo(), { dzis: DZIS }).blad).toMatch(/anulowan/i);
  });

  it('odmawia kwoty niebedacej liczba, zamiast zapisac napis', () => {
    expect(parsujZwrot(zam(), cialo({ kwota: 'sto' }), { dzis: DZIS }).blad).toMatch(/liczb/i);
  });

  // ⚠️ STRAŻNIK LUKI Z ZADANIA 1: `db/zwroty.js` (dodajZwrot) bindował `String(kwota)` —
  // surowy input z formularza, bez przejścia przez grosze()/zl(). Dokładnie ten sam błąd,
  // który komentarz w db/platnosci.js (dodajWplateOkresu) opisuje jako "zatruwa miesiąc
  // NA ZAWSZE": `String(true)` albo `String(' 99.50 ')` trafiały do bazy JAKO SĄ, a kolejny
  // odczyt (grosze()) albo się rozjeżdżał, albo po prostu przepuszczał śmieć. `parsujZwrot`
  // ma być JEDYNĄ barierą — `dodajZwrot` zapisuje bez pytania — więc to TU musi być pewność,
  // że każda kwota na wyjściu jest wynikiem zl(grosze(...)), nigdy odbitką surowego body.
  // ⚠️ `pozycja_kwota` dopasowana do naglowkowej kwoty (bariera spojnosci, 2026-08-15) — ten
  // test ma izolowac konwersje typu, nie zderzac sie z NOWA barierą.
  it('kwota jako wartosc logiczna (true) trafia do wyniku przez grosze()/zl(), nie jako surowy "true"', () => {
    const { zwrot, blad } = parsujZwrot(zam(), cialo({ kwota: true, pozycja_kwota: ['1.00', '0'] }), { dzis: DZIS });
    expect(blad).toBeNull();
    // grosze(true) === 100 (Number(true) = 1 zl), a NIE String(true) = "true" — luka z Zadania 1
    // zapisywałaby literalny napis "true", ktorego zaden pozniejszy grosze() juz nie sparsuje.
    expect(zwrot.kwota).toBe('1.00');
    expect(zwrot.kwota).not.toBe('true');
  });

  it('kwota z bialymi znakami dookola wychodzi PRZYCIETA/KANONICZNA, nie jako surowy napis formularza', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ kwota: '  99.50  ', pozycja_kwota: ['99.50', '0'] }), { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(zwrot.kwota).toBe('99.50');
    expect(zwrot.kwota).not.toBe('  99.50  ');
  });

  it('kwota dostawy tez wychodzi przez grosze()/zl(), nie jako surowy napis formularza', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ ilosc: ['0', '0'], kwota: '0', kwota_dostawy: '  19.00  ' }), { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(zwrot.kwotaDostawy).toBe('19.00');
    expect(zwrot.kwotaDostawy).not.toBe('  19.00  ');
  });

  it('kwota pozycji tez wychodzi przez grosze()/zl(), nie jako surowy napis formularza', () => {
    const { zwrot, blad } = parsujZwrot(zam(), cialo({ pozycja_kwota: ['  99.00  ', '0'] }), { dzis: DZIS });
    expect(blad).toBeNull();
    expect(zwrot.pozycje[0].kwota).toBe('99.00');
    expect(zwrot.pozycje[0].kwota).not.toBe('  99.00  ');
  });

  // ⚠️ STRAZNIK z wiersze(): tablice formularza (klucz[]/ilosc[]/nazwa[]/pozycja_kwota[])
  // musza miec ROWNA dlugosc. Gdyby ktoras byla krotsza, ilosc jednej pozycji przypisalaby
  // sie do innej — panel zwrocilby NIE TEN towar. Bez tego straznika ten test przechodzi
  // (zwracany zostaje towar z przesunieta iloscia zamiast odmowy).
  it('odmawia calego zapisu, gdy tablice formularza maja rozne dlugosci', () => {
    const { zwrot, blad } = parsujZwrot(zam(), cialo({ ilosc: ['1'] }), { dzis: DZIS });
    expect(blad).toMatch(/niekompletny/i);
    expect(zwrot).toBeNull();
  });

  // ⚠️ BARIERA KWOTY z parsujZwrot: `kwotaGr === 0 && dostawaGr === 0`. Zadna inna fikstura
  // jej nie izoluje — przypadki bez pozycji i bez dostawy odbijaja sie wczesniej od bariery
  // "musi byc pozycja albo dostawa". Tu jest pozycja (ilosc 1), wiec ta wczesniejsza bariera
  // NIE zadziala — dopiero ta linia ma odmowic, bo naglowkowa kwota zwrotu to '0'.
  //
  // ⚠️ Fikstura ma TERAZ takze `pozycja_kwota: ['0', '0']` (dopisane przy naprawie bariery
  // spojnosci, 2026-08-15): domyslne `cialo()` niesie pozycje na 99.00, ktore z naglowkowa
  // kwota '0' rozjezdzalyby sie tez o NOWA bariere spojnosci — a ten test ma izolowac
  // WYLACZNIE bariere "kwota i dostawa zerowe", nie obie naraz.
  it('odmawia zwrotu z pozycja, gdy kwota i dostawa sa zerowe', () => {
    const { blad } = parsujZwrot(zam(), cialo({ kwota: '0', pozycja_kwota: ['0', '0'] }), { dzis: DZIS });
    expect(blad).toMatch(/kwota zwrotu musi być większa od zera/i);
  });
});

// ⚠️⚠️ WADA Z RECENZJI (znalezisko przeoczone przy poprzedniej fali napraw, 2026-08-15):
// `parsujZwrot` NIE SPRAWDZAŁ ŻADNEJ relacji między `kwota` (kwota łączna zwrotu za pozycje)
// a sumą kwot wpisanych przy poszczególnych pozycjach (`pozycja_kwota`) — obie liczby operator
// wpisuje RĘCZNIE, niezależnie od siebie, i pomyłka jest naturalna, nie egzotyczna (formularz
// świadomie nie ma podglądu sumy — zero JavaScriptu na tym ekranie).
//
// Zmierzone: ciało z `kwota: '79.00'` i jedną pozycją na `99.00` przechodziło BEZ SŁOWA.
// Skutek: `zwrotyWOkresie` (raport, agregacja-sprzedazy.js) czyta `zwroty.kwota` i zdejmuje
// z przychodu 79,00 zł, a `paryKorekty` (korekta-pozycje.js) składa dokument korekty w inFakcie
// z `zwroty_pozycje.kwota`, czyli na 99,00 zł. Rozjazd między KPiR a rejestrem VAT, niewidoczny
// na żadnym ekranie panelu.
//
// ⚠️⚠️ ZMIANA ROLI, NIE ZNIESIENIE (przebudowa ekranu na dwa kroki, 2026-08-15). Kwoty łącznej
// operator już NIE WPISUJE — liczy ją serwer (`przygotujKrok2` w domain/zwrot-formularz.js),
// więc ta bariera przestała kogokolwiek odrzucać przy normalnej pracy. ZOSTAJE jako STRAŻNIK
// i to jest świadoma decyzja: między krokiem 2 a zapisem obie liczby jadą w POLACH UKRYTYCH,
// a `POST /zamowienia/:id/zwrot` przyjmuje ciało od kogokolwiek — druga otwarta karta,
// back+resubmit, ręcznie sklecony POST. Bariera bez ekranu, który ją wywołuje, wygląda
// identycznie jak bariera usunięta; dlatego te testy zostają, a mutacja #17 pilnuje, żeby
// ktoś nie „posprzątał" jej jako martwej.
describe('bariera SPÓJNOŚCI: kwota łączna musi zgadzać się z sumą kwot przy pozycjach', () => {
  it('odmawia, gdy kwota łączna rozjeżdża się z sumą kwot przy pozycjach — komunikat podaje obie liczby i różnicę', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ kwota: '79.00', pozycja_kwota: ['99.00', '0'] }), { dzis: DZIS },
    );
    expect(zwrot).toBeNull();
    expect(blad).toContain('79.00');
    expect(blad).toContain('99.00');
    expect(blad).toContain('20.00');
    expect(blad).toMatch(/nie zgadza się/i);
  });

  // ⚠️ KWOTA ZOSTAJE EDYTOWALNA (decyzja właściciela: „kwotę przepisujesz z Allegro i to ONA
  // jest prawdą"). Bariera nie narzuca arytmetyki — pilnuje wyłącznie spójności: gdy operator
  // POPRAWI kwoty przy pozycjach tak, żeby suma zgodziła się z nagłówkową kwotą z Allegro,
  // zwrot przechodzi bez przeszkód.
  it('kwota pozostaje edytowalna — po poprawieniu kwot przy pozycjach zwrot przechodzi', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ kwota: '79.00', pozycja_kwota: ['79.00', '0'] }), { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(zwrot.kwota).toBe('79.00');
  });

  // ⚠️ ZWROT SAMEJ DOSTAWY NIE MA PRAWA SIĘ O TĘ BARIERĘ ODBIĆ. Brak pozycji + `kwota` zero +
  // `kwota_dostawy` niezerowa to poprawny, częsty przypadek (klient zatrzymuje towar, oddaje
  // tylko przesyłkę) — osobny test, żeby żadna przyszła zmiana bariery spójności nie zamknęła
  // tej drogi po cichu.
  it('zwrot SAMEJ dostawy (bez pozycji) nadal przechodzi — bariera spójności go nie blokuje', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ ilosc: ['0', '0'], kwota: '0', kwota_dostawy: '19.00' }), { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(zwrot.pozycje).toEqual([]);
    expect(zwrot.kwotaDostawy).toBe('19.00');
  });

  // ⚠️ ARYTMETYKA WYŁĄCZNIE W GROSZACH. Na floatach `0.10 + 0.20 === 0.30` jest w JS
  // FAŁSZEM (0.30000000000000004) — ten test łapie implementację, która porównywałaby sumę
  // na liczbach zmiennoprzecinkowych zamiast na groszach z `grosze()`.
  it('porównanie liczone w groszach — 0,10 zł + 0,20 zł zgadza się DOKŁADNIE z 0,30 zł', () => {
    const z = zam({
      pozycje: [
        { id: 31, zrodlo: 'sklep', zrodlo_id: 201, nazwa: 'A', ilosc: 1, brutto_linii: '0.10' },
        { id: 32, zrodlo: 'sklep', zrodlo_id: 202, nazwa: 'B', ilosc: 1, brutto_linii: '0.20' },
      ],
    });
    const { zwrot, blad } = parsujZwrot(z, {
      data: '2026-08-14', kwota: '0.30', kwota_dostawy: '',
      klucz: ['s201', 's202'], ilosc: ['1', '1'], nazwa: ['A', 'B'], pozycja_kwota: ['0.10', '0.20'],
    }, { dzis: DZIS });
    expect(blad).toBeNull();
    expect(zwrot.kwota).toBe('0.30');
  });
});

// ⚠️⚠️ I3 (recenzja 2026-08-15): BARIERA KWOTY CZYTALA `kwota_brutto`, czyli DRUGA definicje
// „kwoty zamowienia". Panel ma na to JEDNA funkcje — `kwotaOczekiwanaGrosze`
// (domain/suma-pozycji.js) — i komentarz w domain/pozycje-faktury.js opisuje wprost, dlaczego
// porownanie z sama kolumna „kazaloby barierze odmawiac KAZDEMU zamowieniu z dopisana pozycja".
// Bez tej fikstury zaden test tego nie lapie: zamowienie `zam()` wyzej nie ma pozycji recznych,
// wiec obie definicje daja tam DOKLADNIE te sama liczbe.
const zamZDopisanaPozycja = (nad = {}) => ({
  id: 8, kwota_brutto: '100.00', utworzone_at: '2026-08-01T10:00:00', anulowane: 0,
  koszt_dostawy_brutto: '0.00',
  pozycje: [
    { id: 21, zrodlo: 'sklep', zrodlo_id: 90, nazwa: 'Kot 70x100', ilosc: 1, brutto_linii: '100.00' },
    // Pozycja DOPISANA W PANELU (doplata) — dla sklepu warta ZERO, wiec `kwota_brutto`
    // o niej nic nie wie, a faktura jest juz na 150,00 zl.
    { id: 22, zrodlo: 'reczna', nazwa: 'Dopłata za projekt', ilosc: 1, brutto_linii: '50.00' },
  ],
  zwroty: [],
  ...nad,
});

describe('bariera kwoty czyta kwote OCZEKIWANA, nie sama kolumne kwota_brutto', () => {
  it('zamowienie 100 zl + dopisana pozycja 50 zl: klient oddaje wszystko i zwrot 150,00 PRZECHODZI', () => {
    const { zwrot, blad } = parsujZwrot(zamZDopisanaPozycja(), {
      data: '2026-08-14', kwota: '150.00', kwota_dostawy: '',
      klucz: ['s90', 'r22'], ilosc: ['1', '1'],
      nazwa: ['Kot 70x100', 'Dopłata za projekt'], pozycja_kwota: ['100.00', '50.00'],
    }, { dzis: DZIS });
    expect(blad).toBeNull();
    expect(zwrot.kwota).toBe('150.00');
  });

  // ⚠️ `pozycja_kwota` przesunieta o ten sam grosz co naglowkowa kwota (bariera spojnosci,
  // 2026-08-15) — inaczej ten test zlapalby NOWA barierę zamiast bariery "przekracza", ktora
  // ma izolowac.
  it('bariera NADAL odmawia powyzej kwoty oczekiwanej — nie zostala po prostu wylaczona', () => {
    const { blad } = parsujZwrot(zamZDopisanaPozycja(), {
      data: '2026-08-14', kwota: '150.01', kwota_dostawy: '',
      klucz: ['s90', 'r22'], ilosc: ['1', '1'],
      nazwa: ['Kot 70x100', 'Dopłata za projekt'], pozycja_kwota: ['100.01', '50.00'],
    }, { dzis: DZIS });
    expect(blad).toMatch(/przekracza/i);
    // Komunikat ma podac kwote OCZEKIWANA (150,00), a nie sklepowa (100,00) — inaczej
    // operator czytalby liczbe, ktorej nigdzie indziej w panelu nie widzi.
    expect(blad).toContain('150.00');
  });
});

// ⚠️⚠️ SUFIT ZWROTU DOSTAWY (drobiazg 4 z recenzji 2026-08-15). `kwota_dostawy` nie miala
// ZADNEGO ogranicznika od gory: recznie sklecony POST zapisywal zwrot dostawy 139,00 zl przy
// dostawie 19,00 zl. Bariera laczna („suma zwrotów przekracza kwotę zamówienia") tego nie
// lapie, bo kwota zamowienia jest duzo wieksza — a `paryKorekty` (domain/korekta-pozycje.js)
// odmawia potem dokumentu na kwote, ktorej w zamowieniu nie ma, i zwrot zostaje NIEROZLICZALNY.
describe('sufit zwrotu dostawy', () => {
  const samaDostawa = (nad = {}) => cialo({ ilosc: ['0', '0'], kwota: '0', ...nad });

  it('odmawia zwrotu dostawy wyzszego niz koszt dostawy zamowienia', () => {
    const { zwrot, blad } = parsujZwrot(zam(), samaDostawa({ kwota_dostawy: '139.00' }), { dzis: DZIS });
    expect(zwrot).toBeNull();
    expect(blad).toMatch(/dostaw/i);
    expect(blad).toContain('139.00');
    expect(blad).toContain('19.00');
  });

  it('zwrot dokladnie calego kosztu dostawy przechodzi', () => {
    const { blad } = parsujZwrot(zam(), samaDostawa({ kwota_dostawy: '19.00' }), { dzis: DZIS });
    expect(blad).toBeNull();
  });

  // Sufit jest POMNIEJSZONY o to, co juz wrocilo — inaczej dostawe dalo by sie oddac dwa razy
  // po 19,00 zl i dopiero bariera laczna (przy duzym zamowieniu: nigdy) by to zauwazyla.
  it('sufit maleje o dostawe oddana we WCZESNIEJSZYM zwrocie', () => {
    const z = zam({ zwroty: [{ kwota: '0.00', kwota_dostawy: '19.00', pozycje: [] }] });
    const { blad } = parsujZwrot(z, samaDostawa({ kwota_dostawy: '19.00' }), { dzis: DZIS });
    expect(blad).toMatch(/dostaw/i);
    expect(blad).toContain('0.00');
  });

  it('czesciowy zwrot dostawy zostawia reszte na drugi raz', () => {
    const z = zam({ zwroty: [{ kwota: '0.00', kwota_dostawy: '9.00', pozycje: [] }] });
    expect(parsujZwrot(z, samaDostawa({ kwota_dostawy: '10.00' }), { dzis: DZIS }).blad).toBeNull();
    expect(parsujZwrot(z, samaDostawa({ kwota_dostawy: '10.01' }), { dzis: DZIS }).blad).toMatch(/dostaw/i);
  });

  // Zamowienie z darmowa dostawa: kazdy zwrot dostawy jest tu zwrotem czegos, czego klient
  // nie zaplacil.
  it('zamowienie bez kosztu dostawy nie daje zwrocic dostawy w ogole', () => {
    const z = zam({ koszt_dostawy_brutto: null });
    expect(parsujZwrot(z, samaDostawa({ kwota_dostawy: '19.00' }), { dzis: DZIS }).blad).toMatch(/dostaw/i);
  });
});

// ⚠️ ODMOWA DLA CALEGO ZAMOWIENIA MA JEDNEGO AUTORA (drobiazg 2 z recenzji 2026-08-15). Do tego
// dnia zdanie o anulowanym zamowieniu zylo WYLACZNIE wewnatrz `parsujZwrot`, wiec ekran nowego
// zwrotu rysowal pelny, wypelniony formularz i odmawial dopiero PO kliknieciu „Zarejestruj
// zwrot". Regula stoi teraz osobno i czytaja ja OBA miejsca — ekran (krok 1) i zapis.
describe('powod odmowy rejestracji zwrotu (regula dla calego zamowienia)', () => {
  it('anulowane zamowienie — jedno zdanie, to samo dla ekranu i dla zapisu', () => {
    expect(powodOdmowyRejestracjiZwrotu(zam({ anulowane: 1 }))).toMatch(/anulowan/i);
    expect(powodOdmowyRejestracjiZwrotu(zam({ anulowane_recznie: 1 }))).toMatch(/anulowan/i);
    expect(powodOdmowyRejestracjiZwrotu(zam())).toBeNull();
  });

  it('to DOKLADNIE ten sam komunikat, ktory oddaje parsujZwrot', () => {
    const z = zam({ anulowane: 1 });
    expect(parsujZwrot(z, cialo(), { dzis: DZIS }).blad).toBe(powodOdmowyRejestracjiZwrotu(z));
  });
});

// ⚠️ I4 (recenzja 2026-08-15): to jest ekran, na ktorym operator PRZEPISUJE KWOTE Z ALLEGRO,
// a tam kwota stoi Z PRZECINKIEM. `parsujWplate` (domain/platnosci.js) normalizuje przecinek
// z komentarzem, ze „odrzucanie go tutaj byloby niespojnoscia w obrebie jednego panelu";
// tak samo robi koszt reczny i dane miesieczne. Zmierzone przed poprawka: `kwota: '310,33'`
// → „Kwota nie jest liczbą".
describe('przecinek dziesietny — ta sama normalizacja, co przy wplacie', () => {
  it('kwota zwrotu z przecinkiem zapisuje sie jako 310.33, a nie odbija sie o „nie jest liczbą”', () => {
    const { zwrot, blad } = parsujZwrot(zam(), cialo({ kwota: '310,33', pozycja_kwota: ['310,33', '0'] }), { dzis: DZIS });
    expect(blad).toBeNull();
    expect(zwrot.kwota).toBe('310.33');
    expect(zwrot.pozycje[0].kwota).toBe('310.33');
  });

  it('kwota dostawy z przecinkiem tez przechodzi', () => {
    const { zwrot, blad } = parsujZwrot(
      zam(), cialo({ ilosc: ['0', '0'], kwota: '0', kwota_dostawy: '19,00' }), { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(zwrot.kwotaDostawy).toBe('19.00');
  });

  it('napis dalej jest odmawiany — normalizacja nie zamienila bariery w przepuszczalnik', () => {
    expect(parsujZwrot(zam(), cialo({ kwota: 'sto,pięć' }), { dzis: DZIS }).blad).toMatch(/liczb/i);
  });

  // ⚠️ WIELE PRZECINKOW W JEDNEJ KWOCIE MA BYC ODMOWA, NIE CICHYM ZAOKRAGLENIEM. Normalizacja
  // zamienia przecinek na kropke `replace`-em (pierwsze wystapienie) — pilnujemy WYNIKU, nie
  // sposobu: „1,2,3" ma sie odbic o `grosze()`, a nie zapisac jako 1,20 zl albo 12,30 zl.
  //
  // ⚠️ SZCZEROSC O SILE TEGO TESTU (weryfikacja mutacyjna, 2026-08-15): mutant
  // `replace` → `replaceAll` PRZEZYWA i przezyje takze ten test — bo obie postaci daja
  // wynik nieliczbowy („1.2,3" i „1.2.3" to dla `Number()` tak samo `NaN`), wiec zaden
  // przypadek testowy ich nie rozroznia. To jest mutant ROWNOWAZNY, a nie luka w barierze.
  // Test przypina ZACHOWANIE (odmowa), zeby przyszla zmiana normalizacji — np. na taka,
  // ktora wycina przecinki jako separatory tysiecy — nie przepuscila tej kwoty po cichu.
  it('kwota z KILKOMA przecinkami jest odmawiana, a nie po cichu obcinana', () => {
    expect(parsujZwrot(zam(), cialo({ kwota: '1,2,3' }), { dzis: DZIS }).blad).toMatch(/liczb/i);
    expect(parsujZwrot(zam(), cialo({ pozycja_kwota: ['1,2,3', '0'] }), { dzis: DZIS }).blad).toMatch(/liczb/i);
    expect(parsujZwrot(
      zam(), cialo({ ilosc: ['0', '0'], kwota: '0', kwota_dostawy: '1,2,3' }), { dzis: DZIS },
    ).blad).toMatch(/liczb/i);
  });
});

// ⚠️ I6 (recenzja 2026-08-15): tozsamosc zwrotu — po niej `dodajZwrot` poznaje POWTORNE
// WYSLANIE tego samego formularza (back+resubmit, dwuklik, dwie karty). Regula mieszka
// w domenie, bo baza nie liczy regul; baza tylko jej UZYWA wewnatrz transakcji.
describe('tozsamosc zwrotu (obrona przed powtornym wyslaniem)', () => {
  const a = () => ({
    data: '2026-08-14', kwota: '99.00', kwota_dostawy: null,
    pozycje: [{ klucz_pozycji: 's77', ilosc: 1 }],
  });

  it('ten sam dzien, ta sama kwota i ten sam zestaw pozycji to TEN SAM zwrot', () => {
    expect(czyTenSamZwrot(a(), a())).toBe(true);
  });

  it('rozpoznaje ksztalt Z FORMULARZA (kwotaDostawy) i ksztalt Z BAZY (kwota_dostawy) jako ten sam', () => {
    const zFormularza = { data: '2026-08-14', kwota: '99.00', kwotaDostawy: '19.00', pozycje: [{ klucz_pozycji: 's77', ilosc: 1 }] };
    const zBazy = { data: '2026-08-14', kwota: '99.00', kwota_dostawy: '19.00', pozycje: [{ klucz_pozycji: 's77', ilosc: 1 }] };
    expect(czyTenSamZwrot(zFormularza, zBazy)).toBe(true);
  });

  it('inna data, inna kwota, inna dostawa albo inny zestaw pozycji to INNY zwrot', () => {
    expect(czyTenSamZwrot(a(), { ...a(), data: '2026-08-15' })).toBe(false);
    expect(czyTenSamZwrot(a(), { ...a(), kwota: '99.01' })).toBe(false);
    expect(czyTenSamZwrot(a(), { ...a(), kwota_dostawy: '19.00' })).toBe(false);
    expect(czyTenSamZwrot(a(), { ...a(), pozycje: [{ klucz_pozycji: 's77', ilosc: 2 }] })).toBe(false);
    expect(czyTenSamZwrot(a(), { ...a(), pozycje: [{ klucz_pozycji: 's78', ilosc: 1 }] })).toBe(false);
  });

  it('kolejnosc pozycji nie robi z tego samego zwrotu dwoch roznych', () => {
    const dwie = (p) => ({ data: '2026-08-14', kwota: '99.00', pozycje: p });
    expect(czyTenSamZwrot(
      dwie([{ klucz_pozycji: 's77', ilosc: 1 }, { klucz_pozycji: 's78', ilosc: 1 }]),
      dwie([{ klucz_pozycji: 's78', ilosc: 1 }, { klucz_pozycji: 's77', ilosc: 1 }]),
    )).toBe(true);
  });
});

describe('rozliczenie zwrotu', () => {
  it('zwrot bez faktury jest rozliczony samym oddaniem pieniedzy', () => {
    const w = { pieniadze_oddane_at: '2026-08-15T09:00:00Z', korekta_numer: null };
    expect(zwrotRozliczony({ faktura: null }, w)).toBe(true);
  });

  it('zwrot przy fakturze wymaga TAKZE korekty', () => {
    const w = { pieniadze_oddane_at: '2026-08-15T09:00:00Z', korekta_numer: null };
    expect(zwrotRozliczony({ faktura: { numer: 'FV 1/08/2026' } }, w)).toBe(false);
    expect(zwrotRozliczony({ faktura: { numer: 'FV 1/08/2026' } }, { ...w, korekta_numer: 'KOR 1/08/2026' })).toBe(true);
  });

  it('nierozliczony zostaje nierozliczony bez oddanych pieniedzy, nawet z korekta', () => {
    expect(zwrotRozliczony({ faktura: null }, { pieniadze_oddane_at: null, korekta_numer: 'KOR 1' })).toBe(false);
  });
});

describe('kasowanie zwrotu', () => {
  it('wolno skasowac zwrot swiezy', () => {
    expect(powodOdmowyUsunieciaZwrotu({ pieniadze_oddane_at: null, korekta_zlecona_at: null })).toBeNull();
  });
  it('nie wolno po oddaniu pieniedzy ani po zleceniu korekty', () => {
    expect(powodOdmowyUsunieciaZwrotu({ pieniadze_oddane_at: '2026-08-15T09:00:00Z' })).toMatch(/pieniądze/i);
    expect(powodOdmowyUsunieciaZwrotu({ korekta_zlecona_at: '2026-08-15T09:00:00Z' })).toMatch(/korekt/i);
  });

  // ⚠️ LUKA OTWARTA PRZEZ RECZNY NUMER KOREKTY (C2, 2026-08-15). Do tego dnia niezmiennik
  // „numer korekty istnieje TYLKO tam, gdzie istnieje `korekta_zlecona_at`" trzymal sie sam
  // (numer zapisywala wylacznie sciezka przez rezerwacje). „Korektę wystawiłem ręcznie"
  // zapisuje numer BEZ rezerwacji — bez tego warunku taki zwrot dalej dalby sie skasowac,
  // a w inFakcie zostalaby korekta bez podstawy.
  it('nie wolno skasowac zwrotu z ZAPISANYM numerem korekty, nawet bez rezerwacji', () => {
    expect(powodOdmowyUsunieciaZwrotu({ korekta_zlecona_at: null, korekta_numer: 'KOR 1/08/2026' }))
      .toMatch(/korekt/i);
  });
});

// ⚠️⚠️ C2 (recenzja 2026-08-15): ZLECENIE KOREKTY, KTORE PRZEPADLO, BYLO STANEM BEZ WYJSCIA.
// `201` z inFaktu nie dowodzi, ze tresc byla poprawna (pomiar 2026-08-14) — po progu ekran
// pisal „zlecenie zostało odrzucone" i na tym sie konczylo: przycisku „Wystaw korektę" juz
// nie bylo, kasowania zwrotu odmawial `powodOdmowyUsunieciaZwrotu`, a zwrot zostawal
// NIEROZLICZONY NA ZAWSZE. Panel nie ma prawa wchodzic w stan, z ktorego nie umie wyjsc
// (przewodnik OMS, 4.9) — to sa reguly obu wyjsc.
describe('odblokowanie przepadlej rezerwacji korekty', () => {
  const T = '2026-08-14T12:00:00.000Z';

  it('wolno odblokowac rezerwacje, ktora PRZEPADLA', () => {
    expect(powodOdmowyOdblokowaniaKorekty({ korekta_zlecona_at: '2026-08-14T11:30:00.000Z' }, { teraz: T }))
      .toBeNull();
  });

  // ⚠️ NAJWAZNIEJSZA ODMOWA: swieza rezerwacja NIE JEST przepadnieta. Zwolnienie jej otwiera
  // droge do DRUGIEJ korekty do tej samej faktury, a duplikat rozwiazuje sie wylacznie
  // TRZECIM dokumentem — widocznym u organu i u nabywcy.
  it('odmawia rezerwacji SWIEZEJ — ponizej progu', () => {
    expect(powodOdmowyOdblokowaniaKorekty({ korekta_zlecona_at: '2026-08-14T11:55:00.000Z' }, { teraz: T }))
      .toMatch(/nie minęło|jeszcze/i);
  });

  it('odmawia, gdy korekta MA numer — dokument istnieje, nie ma czego odblokowywac', () => {
    expect(powodOdmowyOdblokowaniaKorekty(
      { korekta_zlecona_at: '2026-08-14T09:00:00.000Z', korekta_numer: '1/KOR/08/2026' }, { teraz: T },
    )).toMatch(/numer|istnieje/i);
  });

  it('odmawia, gdy zadnej rezerwacji nie ma', () => {
    expect(powodOdmowyOdblokowaniaKorekty({ korekta_zlecona_at: null }, { teraz: T }))
      .toMatch(/nie ma czego/i);
  });
});

describe('reczny numer korekty („Korektę wystawiłem ręcznie")', () => {
  it('przycina numer i oddaje go do zapisu', () => {
    expect(parsujNumerKorekty({ korekta_numer: null }, '  1/KOR/08/2026  '))
      .toEqual({ numer: '1/KOR/08/2026', blad: null });
  });

  it('odmawia pustego numeru — bez numeru nie ma czego odnotowac', () => {
    expect(parsujNumerKorekty({ korekta_numer: null }, '   ').blad).toMatch(/numer/i);
    expect(parsujNumerKorekty({ korekta_numer: null }, undefined).numer).toBeNull();
  });

  it('odmawia nadpisania numeru, ktory juz jest — drugi numer znaczylby drugi dokument', () => {
    const { blad } = parsujNumerKorekty({ korekta_numer: 'KOR 1/08/2026' }, 'KOR 2/08/2026');
    expect(blad).toMatch(/KOR 1\/08\/2026/);
  });

  // ⚠️⚠️ K2 (recenzja kontrolna 2026-08-15): TA DROGA OBCHODZILA PROG, KTOREGO PILNUJE
  // ODBLOKOWANIE. Zmierzone: rezerwacja sprzed minuty (prog 15 minut niewyczerpany), POST
  // `/korekta/reczna` → 302 i numer zapisany, a `korekta_zlecona_at` ZOSTAJE. Gdy zlecenie
  // panelu jeszcze sie przetwarza, a czlowiek w miedzyczasie wystawi korekte recznie, powstaja
  // DWA dokumenty do jednej faktury — `doczytaj` juz tego nie zauwazy (wychodzi na
  // `korekta_numer`), `odblokuj` odmowi, a zwrot zamelduje sie jako rozliczony.
  //
  // To jest TA SAMA decyzja i ta sama waga, co odblokowanie rezerwacji — wiec ma miec TO SAMO
  // ZDANIE, liczone w JEDNYM miejscu. Test porownuje komunikaty wprost, zeby druga kopia reguly
  // nie mogla powstac po cichu.
  const T_TOK = '2026-08-14T12:00:00.000Z';

  it('odmawia przy REZERWACJI W TOKU — dokladnie tym samym zdaniem, co odblokowanie', () => {
    const w = { korekta_zlecona_at: '2026-08-14T11:55:00.000Z', korekta_numer: null };
    const { numer, blad } = parsujNumerKorekty(w, '9/KOR/08/2026', { teraz: T_TOK });
    expect(numer).toBeNull();
    expect(blad).toMatch(/nie minęło/i);
    expect(blad).toBe(powodOdmowyOdblokowaniaKorekty(w, { teraz: T_TOK }));
  });

  // Po progu droga reczna MUSI byc otwarta — to jest jedyne wyjscie ze zlecenia, ktore
  // przepadlo, przy fakturze skorygowanej poza panelem.
  it('po progu (rezerwacja PRZEPADLA) reczny numer przechodzi — to jedyne wyjscie', () => {
    const w = { korekta_zlecona_at: '2026-08-14T11:30:00.000Z', korekta_numer: null };
    expect(parsujNumerKorekty(w, '9/KOR/08/2026', { teraz: T_TOK }))
      .toEqual({ numer: '9/KOR/08/2026', blad: null });
  });

  it('bez zadnej rezerwacji przechodzi jak dotad — korekta wystawiona recznie od poczatku', () => {
    expect(parsujNumerKorekty({ korekta_zlecona_at: null }, '9/KOR/08/2026', { teraz: T_TOK }).blad)
      .toBeNull();
  });
});

describe('suma zwrotow', () => {
  it('sumuje pozycje i dostawe w groszach', () => {
    expect(sumaZwrotowGrosze([
      { kwota: '99.00', kwota_dostawy: '19.00' },
      { kwota: '10.90', kwota_dostawy: null },
    ])).toBe(12890);
  });
});

describe('zlecenie korekty, ktore przepadlo', () => {
  const T = '2026-08-14T12:00:00.000Z';
  it('swieze zlecenie bez numeru NIE jest przepadniete', () => {
    expect(korektaPrzepadla({ korekta_zlecona_at: '2026-08-14T11:55:00.000Z' }, { teraz: T })).toBe(false);
  });
  it('po progu bez numeru — przepadlo', () => {
    expect(korektaPrzepadla({ korekta_zlecona_at: '2026-08-14T11:30:00.000Z' }, { teraz: T })).toBe(true);
  });
  it('zlecenie Z NUMEREM nigdy nie jest przepadniete', () => {
    expect(korektaPrzepadla(
      { korekta_zlecona_at: '2026-08-14T09:00:00.000Z', korekta_numer: '1/KOR/08/2026' }, { teraz: T },
    )).toBe(false);
  });
  it('zwrot bez zleconej korekty nigdy nie jest przepadniety', () => {
    expect(korektaPrzepadla({ korekta_zlecona_at: null }, { teraz: T })).toBe(false);
  });
  it('dokladnie na progu (15 minut) jeszcze NIE jest przepadniete — prog jest ostry ">"', () => {
    expect(korektaPrzepadla({ korekta_zlecona_at: '2026-08-14T11:45:00.000Z' }, { teraz: T })).toBe(false);
  });
});

/**
 * ⚠️⚠️ WARUNEK Z RECENZJI 2026-08-15: EKRAN NIE MA PRAWA ORZEKAC O DOKUMENCIE, KTOREGO
 * SWIADOMIE NIE SPRAWDZIL. `doczytaj` (services/korekta.js) wychodzi PRZED zapytaniem do
 * inFaktu, gdy zamowienie ma wiecej niz jeden zwrot z otwarta sprawa korekty (sito W3) — to
 * jest SWIADOMA DECYZJA i ma zostac. Ale widok czytal WYLACZNIE `korektaPrzepadla` (proba
 * czasu) i przy przekroczonym progu pisal „inFakt nie wystawił dokumentu — zlecenie zostało
 * odrzucone" — zdanie o fakcie, ktorego panel nie zna, bo nigdy nie zapytal.
 *
 * `korektaNieSprawdzona` daje widokowi (przez trase) odpowiedz na pytanie „czy `doczytaj`
 * w ogole zapytal inFakt o TEN zwrot" — TA SAMA regula, ktorej uzywa `doczytaj` sam u siebie
 * (Zadanie: services/korekta.js ma wywolywac te funkcje, nie trzymac drugiej kopii warunku).
 */
describe('korektaNieSprawdzona — czy `doczytaj` swiadomie NIE ZAPYTAL inFaktu o ten zwrot', () => {
  it('wiecejNizJedenOtwartySprawaKorekty: zero albo jedna otwarta sprawa to NIE „wiecej niz jedna"', () => {
    expect(wiecejNizJedenOtwartySprawaKorekty([])).toBe(false);
    expect(wiecejNizJedenOtwartySprawaKorekty([{ korekta_numer: null }])).toBe(false);
    // Zwroty Z numerem maja sprawe ZAMKNIETA — nie licza sie do sita.
    expect(wiecejNizJedenOtwartySprawaKorekty([
      { korekta_numer: '1/KOR/08/2026' }, { korekta_numer: null },
    ])).toBe(false);
  });

  it('wiecejNizJedenOtwartySprawaKorekty: dwa zwroty BEZ numeru to „wiecej niz jedna"', () => {
    expect(wiecejNizJedenOtwartySprawaKorekty([
      { korekta_numer: null }, { korekta_numer: null },
    ])).toBe(true);
  });

  it('zwrot bez zleconej korekty — nie ma czego nie sprawdzic', () => {
    expect(korektaNieSprawdzona({ korekta_zlecona_at: null }, [])).toBe(false);
  });

  it('zwrot Z NUMEREM — sprawa juz zamknieta, nie ma czego nie sprawdzic', () => {
    const w = { id: 1, korekta_zlecona_at: '2026-08-14T09:00:00Z', korekta_numer: '1/KOR/08/2026' };
    expect(korektaNieSprawdzona(w, [w])).toBe(false);
  });

  it('DOKLADNIE JEDNA otwarta sprawa — `doczytaj` PYTA, wiec to NIE jest „nie pytalismy"', () => {
    const w = { id: 1, korekta_zlecona_at: '2026-08-14T09:00:00Z', korekta_numer: null };
    const inny = { id: 2, korekta_zlecona_at: null, korekta_numer: '4/KOR/09/2026' };
    expect(korektaNieSprawdzona(w, [w, inny])).toBe(false);
  });

  it('DWIE otwarte sprawy — `doczytaj` NIE PYTA, to jest „nie pytalismy"', () => {
    const w = { id: 1, korekta_zlecona_at: '2026-08-14T09:00:00Z', korekta_numer: null };
    const inny = { id: 2, korekta_zlecona_at: null, korekta_numer: null };
    expect(korektaNieSprawdzona(w, [w, inny])).toBe(true);
  });
});
