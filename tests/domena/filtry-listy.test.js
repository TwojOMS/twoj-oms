import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
import { describe, it, expect } from 'vitest';
import { dzienWarszawa } from '../../src/domena/format-daty.js';
import {
  parsujFiltry, pasujeDoFiltrow, filtrujFiltrami, saJakiesFiltry, adresZFiltrami,
  bezpiecznyPowrotNaListe, kanalyDoFiltra,
} from '../../src/domena/filtry-listy.js';
import { adresKanalu } from '../../src/domena/kanaly.js';

// Filtry nad tabelą zamówień (zakres dat + metoda wysyłki + metoda płatności).
// Cała reguła siedzi w warstwie czystej, tak samo jak wyszukiwanie — trasa dostaje
// gotową, przefiltrowaną tablicę.

const zam = (nad = {}) => ({
  numer: '1281',
  utworzone_at: '2026-07-15T12:00:00',
  metoda_wysylki: 'dpd',
  metoda_platnosci: 'Przelew tradycyjny',
  ...nad,
});

describe('dzienWarszawa — dzień kalendarzowy TEJ SAMEJ skali, co data w wierszu', () => {
  it('wartość ze sklepu (bez strefy) bierze wprost, bez arytmetyki', () => {
    expect(dzienWarszawa('2026-07-31T20:58:39')).toBe('2026-07-31');
  });

  // ⚠️ To jest cały powód istnienia tej funkcji. `utworzone_at` zamówienia RĘCZNEGO
  // powstaje przez teraz() = toISOString(), czyli UTC. 31.07 o 23:30 w Warszawie to
  // 21:30 UTC TEGO SAMEGO dnia, ale 01.08 o 01:30 w Warszawie to 23:30 UTC dnia
  // POPRZEDNIEGO — czyli filtr „od 1 sierpnia" gubiłby zamówienie, które na liście
  // widnieje jako sierpniowe.
  it('nasz znacznik (UTC) przelicza na Warszawę, tak jak robi to kolumna z datą', () => {
    expect(dzienWarszawa('2026-07-31T23:30:00.000Z')).toBe('2026-08-01');
  });

  it('pustą i nieparsowalną wartość oddaje jako pusty string', () => {
    expect(dzienWarszawa(null)).toBe('');
    expect(dzienWarszawa('bzdura')).toBe('');
  });
});

describe('parsujFiltry', () => {
  it('czyta zakres dat, sposób dostawy i metodę płatności z adresu', () => {
    const f = parsujFiltry({
      od: '2026-07-01', do: '2026-07-31', wysylka: 'dpd', platnosc: 'Za pobraniem',
    }, definicjeKanalowHistoryczne);
    expect(f).toEqual({
      od: '2026-07-01', do: '2026-07-31', wysylka: 'dpd', platnosc: 'Za pobraniem', kanal: null,
    });
  });

  it('brak parametrów daje komplet pustych filtrów', () => {
    expect(parsujFiltry({}, definicjeKanalowHistoryczne)).toEqual({
      od: null, do: null, wysylka: null, platnosc: null, kanal: null,
    });
  });

  // ⚠️ Pobranie od 2026-08-01 nie jest sposobem dostawy (rozdzielenie dostawy i pobrania),
  // a filtr pobrania sam zniknal 2026-08-04 (patrz komentarz nad parsujFiltry w
  // domain/filtry-listy.js). Stara wartosc `wysylka=dpd_pobranie` przestala wiec cokolwiek
  // znaczyc i ma wypasc, a nie oddac pusta liste bez wyjasnienia.
  it('stara wartość „dpd_pobranie" nie jest już sposobem dostawy', () => {
    expect(parsujFiltry({ wysylka: 'dpd_pobranie' }, definicjeKanalowHistoryczne).wysylka).toBe(null);
  });

  // ⚠️ Filtr pobrania usuniety na prosbe wlasciciela (2026-08-04) — jego miejsce zajal
  // filtr kanalu sprzedazy. Stara wartosc w adresie (zakladka, wklejony link) ma zostac
  // ZIGNOROWANA, a nie oddac pusta liste bez slowa wyjasnienia.
  it('stary parametr „pobranie" nie jest już filtrem', () => {
    expect(parsujFiltry({ pobranie: 'tak' }, definicjeKanalowHistoryczne)).toEqual({
      od: null, do: null, wysylka: null, platnosc: null, kanal: null,
    });
    expect(saJakiesFiltry(parsujFiltry({ pobranie: 'tak' }, definicjeKanalowHistoryczne))).toBe(false);
  });

  it('adres nie niesie już parametru pobrania', () => {
    expect(adresZFiltrami({ wysylka: 'dpd', pobranie: 'tak' }, {})).toBe('/?wysylka=dpd');
  });

  // Data w innym formacie to literówka w adresie, a nie życzenie „pokaż wszystko od
  // zawsze" — ale ciche przepuszczenie jej dalej dawałoby porównania napisów, w których
  // „01.07.2026" jest większe od każdej daty ISO, czyli PUSTĄ listę bez wyjaśnienia.
  it('odrzuca datę w formacie innym niż RRRR-MM-DD', () => {
    expect(parsujFiltry({ od: '01.07.2026' }, definicjeKanalowHistoryczne).od).toBe(null);
    expect(parsujFiltry({ od: '2026-13-01' }, definicjeKanalowHistoryczne).od).toBe(null);
  });

  it('odrzuca metodę wysyłki spoza listy, którą panel umie obsłużyć', () => {
    expect(parsujFiltry({ wysylka: 'inpost' }, definicjeKanalowHistoryczne).wysylka).toBe(null);
    expect(parsujFiltry({ wysylka: 'nieznana' }, definicjeKanalowHistoryczne).wysylka).toBe('nieznana');
    expect(parsujFiltry({ wysylka: 'odbior_osobisty' }, definicjeKanalowHistoryczne).wysylka).toBe('odbior_osobisty');
  });

  // Powtórzony klucz (?od=a&od=b) Fastify oddaje jako tablicę — ta sama ochrona,
  // co przy `?szukaj` i `?edytuj`.
  it('odrzuca wartość, która nie jest napisem', () => {
    expect(parsujFiltry({ od: ['2026-07-01', '2026-07-02'] }, definicjeKanalowHistoryczne).od).toBe(null);
  });
});

describe('pasujeDoFiltrow', () => {
  it('bez filtrów przepuszcza wszystko', () => {
    expect(pasujeDoFiltrow(zam(), parsujFiltry({}, definicjeKanalowHistoryczne))).toBe(true);
  });

  it('zakres dat obejmuje OBA końce', () => {
    const f = parsujFiltry({ od: '2026-07-15', do: '2026-07-15' }, definicjeKanalowHistoryczne);
    expect(pasujeDoFiltrow(zam({ utworzone_at: '2026-07-15T00:00:01' }), f)).toBe(true);
    expect(pasujeDoFiltrow(zam({ utworzone_at: '2026-07-15T23:59:59' }), f)).toBe(true);
    expect(pasujeDoFiltrow(zam({ utworzone_at: '2026-07-14T23:59:59' }), f)).toBe(false);
    expect(pasujeDoFiltrow(zam({ utworzone_at: '2026-07-16T00:00:01' }), f)).toBe(false);
  });

  it('sam koniec zakresu działa bez początku i odwrotnie', () => {
    expect(pasujeDoFiltrow(zam(), parsujFiltry({ do: '2026-07-31' }, definicjeKanalowHistoryczne))).toBe(true);
    expect(pasujeDoFiltrow(zam(), parsujFiltry({ od: '2026-08-01' }, definicjeKanalowHistoryczne))).toBe(false);
  });

  // Zamówienie bez daty nie ma prawa udawać, że mieści się w każdym zakresie — inaczej
  // wynik filtrowania po lipcu zawierałby wiersze, o których nie wiadomo, kiedy powstały.
  it('zamówienie bez daty wypada z każdego zakresu', () => {
    expect(pasujeDoFiltrow(zam({ utworzone_at: null }), parsujFiltry({ od: '2026-07-01' }, definicjeKanalowHistoryczne))).toBe(false);
    expect(pasujeDoFiltrow(zam({ utworzone_at: null }), parsujFiltry({}, definicjeKanalowHistoryczne))).toBe(true);
  });

  it('filtruje po sposobie dostawy', () => {
    const f = parsujFiltry({ wysylka: 'odbior_osobisty' }, definicjeKanalowHistoryczne);
    expect(pasujeDoFiltrow(zam({ metoda_wysylki: 'odbior_osobisty' }), f)).toBe(true);
    expect(pasujeDoFiltrow(zam({ metoda_wysylki: 'dpd' }), f)).toBe(false);
  });

  // ⚠️ Metoda EFEKTYWNA, czyli po ręcznych korektach — ta sama zasada, co przy wyszukiwarce
  // i ekranie nadania. Zamówienie przełączone ręcznie na inny sposób dostawy MUSI się
  // znaleźć pod tym, co panel pokazuje na ekranie, a nie pod tym, co przysłał sklep.
  it('metodę bierze po ręcznej korekcie, nie ze sklepu', () => {
    const z = zam({
      metoda_wysylki: 'odbior_osobisty', metoda_wysylki_sklep: 'dpd',
      wysylka_reczna_json: JSON.stringify({ metoda: 'odbior_osobisty' }),
    });
    expect(pasujeDoFiltrow(z, parsujFiltry({ wysylka: 'odbior_osobisty' }, definicjeKanalowHistoryczne))).toBe(true);
    expect(pasujeDoFiltrow(z, parsujFiltry({ wysylka: 'dpd' }, definicjeKanalowHistoryczne))).toBe(false);
  });

  it('filtruje po metodzie płatności ze sklepu', () => {
    const f = parsujFiltry({ platnosc: 'Za pobraniem' }, definicjeKanalowHistoryczne);
    expect(pasujeDoFiltrow(zam({ metoda_platnosci: 'Za pobraniem' }), f)).toBe(true);
    expect(pasujeDoFiltrow(zam({ metoda_platnosci: 'Przelew tradycyjny' }), f)).toBe(false);
    expect(pasujeDoFiltrow(zam({ metoda_platnosci: null }), f)).toBe(false);
  });

  it('filtry łączą się warunkiem I, nie LUB', () => {
    const f = parsujFiltry({ od: '2026-07-01', do: '2026-07-31', wysylka: 'dpd', platnosc: 'Przelew tradycyjny' }, definicjeKanalowHistoryczne);
    expect(pasujeDoFiltrow(zam(), f)).toBe(true);
    expect(pasujeDoFiltrow(zam({ metoda_platnosci: 'Za pobraniem' }), f)).toBe(false);
    expect(pasujeDoFiltrow(zam({ utworzone_at: '2026-06-30T12:00:00' }), f)).toBe(false);
  });
});

describe('filtr kanału sprzedaży', () => {
  const zamKanal = (nad = {}) => zam({ sklep: 'szkicownia', indywidualne: 0, ...nad });

  it('czyta kanał z adresu', () => {
    expect(parsujFiltry({ kanal: 'pro' }, definicjeKanalowHistoryczne).kanal).toBe('pro');
  });

  it('kanał spoza listy spada do null, jak każda nieznana wartość', () => {
    expect(parsujFiltry({ kanal: 'allegro' }, definicjeKanalowHistoryczne).kanal).toBe(null);
  });

  it('zawęża do wskazanego sklepu', () => {
    expect(pasujeDoFiltrow(zamKanal({ sklep: 'pro' }), { kanal: 'pro' })).toBe(true);
    expect(pasujeDoFiltrow(zamKanal({ sklep: 'szkicownia' }), { kanal: 'pro' })).toBe(false);
  });

  it('„indywidualne" zawęża do znacznika, nie do sklepu', () => {
    expect(pasujeDoFiltrow(zamKanal({ indywidualne: 1 }), { kanal: 'indywidualne' })).toBe(true);
    expect(pasujeDoFiltrow(zamKanal({ indywidualne: 0 }), { kanal: 'indywidualne' })).toBe(false);
  });

  // ⚠️ TEST, KTORY MUSI GRYZC. Zamowienie indywidualne JEST zamowieniem szkicownia.pl —
  // stamtad przyszlo i tam ma numer. Wykluczenie go z ?kanal=szkicownia znaczyloby, ze dwa
  // filtry trzeba zsumowac, zeby zobaczyc wszystko z jednego sklepu.
  it('„szkicownia" obejmuje TAKŻE zamówienia indywidualne', () => {
    expect(pasujeDoFiltrow(zamKanal({ indywidualne: 1 }), { kanal: 'szkicownia' })).toBe(true);
  });

  it('kanał liczy się do „czy są jakieś filtry" i jedzie w adresie', () => {
    expect(saJakiesFiltry(parsujFiltry({ kanal: 'reczne' }, definicjeKanalowHistoryczne))).toBe(true);
    expect(adresZFiltrami({ kanal: 'reczne' }, {})).toBe('/?kanal=reczne');
  });

  // ⚠️ Lista pozycji filtra jest ZAMKNIETA, inaczej niz przy metodach platnosci (te ida
  // Z BAZY). `indywidualne` nie jest wartoscia kolumny `sklep`, wiec w liscie z bazy nie
  // moglaby sie w ogole znalezc.
  it('pozycje filtra to zamknięta lista kanałów, razem z „indywidualne" i Allegro', () => {
    expect(kanalyDoFiltra(definicjeKanalowHistoryczne).map((k) => k.klucz)).toEqual([
      'pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka', 'reczne', 'indywidualne',
    ]);
  });

  // ⚠️ Luka znaleziona przy Zadaniu 8 (raport .superpowers/sdd/allegro/zadanie-8-raport.md):
  // kolumna listy nazywala kanaly Allegro poprawnie przez adresKanalu, ale filtr (pole
  // wyboru nad tabela i `?kanal=` w adresie) je odrzucal, bo `KANALY_DO_FILTRA` byla
  // zamknieta lista bez tych dwoch kluczy. Test dowodzi, ze `?kanal=allegro_szkicownia`
  // JEST przyjmowany i faktycznie zaweza liste — nie jest cicho ignorowany.
  it('kanały Allegro są przyjmowane przez filtr i zawężają listę', () => {
    expect(parsujFiltry({ kanal: 'allegro_szkicownia' }, definicjeKanalowHistoryczne).kanal).toBe('allegro_szkicownia');
    expect(parsujFiltry({ kanal: 'allegro_amarka' }, definicjeKanalowHistoryczne).kanal).toBe('allegro_amarka');
    expect(pasujeDoFiltrow(zamKanal({ sklep: 'allegro_szkicownia' }), { kanal: 'allegro_szkicownia' })).toBe(true);
    expect(pasujeDoFiltrow(zamKanal({ sklep: 'allegro_amarka' }), { kanal: 'allegro_szkicownia' })).toBe(false);
  });

  // ⚠️ Etykiety sklada `adresKanalu` — TA SAMA funkcja, ktora opisuje kanal w kolumnie
  // „Kanal sprzedazy". Druga mapa etykiet rozjechalaby sie przy pierwszej zmianie nazwy
  // i pole wyboru nazywaloby to samo inaczej niz wiersz tabeli.
  it('etykiety pozycji bierze z adresKanalu, nie z własnej mapy', () => {
    expect(kanalyDoFiltra(definicjeKanalowHistoryczne)).toEqual(
      ['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka', 'reczne', 'indywidualne'].map((k) => ({ klucz: k, etykieta: adresKanalu(k, definicjeKanalowHistoryczne) })),
    );
    expect(kanalyDoFiltra(definicjeKanalowHistoryczne)[0]).toEqual({ klucz: 'pro', etykieta: 'pro.szkicownia.pl' });
  });
});

describe('filtrujFiltrami', () => {
  it('zostawia pasujące, resztę usuwa', () => {
    const lista = [zam({ numer: 'A' }), zam({ numer: 'B', metoda_wysylki: 'odbior_osobisty' })];
    const wynik = filtrujFiltrami(lista, parsujFiltry({ wysylka: 'dpd' }, definicjeKanalowHistoryczne));
    expect(wynik.map((z) => z.numer)).toEqual(['A']);
  });

  it('komplet pustych filtrów oddaje tę samą tablicę, bez kopiowania', () => {
    const lista = [zam()];
    expect(filtrujFiltrami(lista, parsujFiltry({}, definicjeKanalowHistoryczne))).toBe(lista);
  });
});

describe('saJakiesFiltry', () => {
  it('rozpoznaje, czy cokolwiek jest ustawione', () => {
    expect(saJakiesFiltry(parsujFiltry({}, definicjeKanalowHistoryczne))).toBe(false);
    expect(saJakiesFiltry(parsujFiltry({ wysylka: 'dpd' }, definicjeKanalowHistoryczne))).toBe(true);
  });
});

describe('adresZFiltrami', () => {
  it('składa adres zachowujący pozostałe filtry, frazę i zakładkę statusu', () => {
    const f = parsujFiltry({ od: '2026-07-01', wysylka: 'dpd' }, definicjeKanalowHistoryczne);
    expect(adresZFiltrami(f, { szukaj: 'kolorit', status: 'nowe' }))
      .toBe('/?status=nowe&szukaj=kolorit&od=2026-07-01&wysylka=dpd');
  });

  it('pominięcie jednego filtra daje adres bez niego — to jest „×" przy chipie', () => {
    const f = parsujFiltry({ od: '2026-07-01', do: '2026-07-31', wysylka: 'dpd' }, definicjeKanalowHistoryczne);
    expect(adresZFiltrami({ ...f, od: null, do: null }, {})).toBe('/?wysylka=dpd');
  });

  it('brak czegokolwiek daje goły adres listy', () => {
    expect(adresZFiltrami(parsujFiltry({}, definicjeKanalowHistoryczne), {})).toBe('/');
  });

  // Nazwa metody płatności jest tekstem ze sklepu („Płatność przy odbiorze (pobranie)") —
  // wklejona do adresu bez kodowania rozpadłaby się na spacjach i nawiasach.
  it('koduje wartości, które trafiają do adresu', () => {
    expect(adresZFiltrami(parsujFiltry({ platnosc: 'Za pobraniem' }, definicjeKanalowHistoryczne), {}))
      .toBe('/?platnosc=Za%20pobraniem');
  });
});

// ⚠️ BARIERA ADRESU POWROTU. Adres wraca ukrytym polem formularza, czyli JEST DANYMI OD
// UŻYTKOWNIKA — bez białej listy pasek akcji masowych byłby otwartym przekierowaniem
// (`powrot=//obcy.host` w spreparowanym odnośniku odsyła operatora na cudzy serwer,
// a `Location` nie pyta o zdanie). Ta sama zasada, co przy `wroc` na karcie wzoru (4.67)
// i przy `powrot` po odnotowaniu skasowanej faktury.
describe('bezpiecznyPowrotNaListe', () => {
  it('przepuszcza gołą listę i listę z zapytaniem', () => {
    expect(bezpiecznyPowrotNaListe('/', definicjeKanalowHistoryczne)).toBe('/');
    expect(bezpiecznyPowrotNaListe('/?status=w_realizacji&wysylka=dpd', definicjeKanalowHistoryczne))
      .toBe('/?status=w_realizacji&wysylka=dpd');
  });

  // Biała lista jest WĄSKA celowo: adres powrotu z paska akcji masowych zawsze prowadzi
  // na listę zamówień. Wszystko inne — inny ekran panelu, obcy host, protokół — znaczy,
  // że wartość nie pochodzi z naszego formularza, więc zostaje goła lista.
  it('odrzuca wszystko, co nie jest listą zamówień — zostaje goła lista', () => {
    for (const zly of [
      '//obcy.example.com/', 'https://obcy.example.com/', 'javascript:alert(1)',
      '/zamowienia/7', '/faktury?miesiac=2026-09', '/\\obcy.example.com',
      '', ' ', null, undefined, 7, {},
    ]) {
      expect(bezpiecznyPowrotNaListe(zly, definicjeKanalowHistoryczne)).toBe('/');
    }
  });

  it('kanonizuje dozwolone filtry, odrzuca chwilowe zaznaczenie i obce parametry', () => {
    expect(bezpiecznyPowrotNaListe(
      '/?zaznacz=1&kanal=pro&status=nowe&szukaj=Jan%20Kowalski&obcy=sekret&od=2026-07-01', definicjeKanalowHistoryczne,
    )).toBe('/?status=nowe&szukaj=Jan%20Kowalski&od=2026-07-01&kanal=pro');
  });

  it('odrzuca powtórzone parametry zamiast wybierać jedną z wartości', () => {
    expect(bezpiecznyPowrotNaListe('/?status=nowe&status=wyslane', definicjeKanalowHistoryczne)).toBe('/');
    expect(bezpiecznyPowrotNaListe('/?szukaj=a&szukaj=b', definicjeKanalowHistoryczne)).toBe('/');
  });
});
