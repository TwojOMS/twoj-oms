import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';
import { describe, it, expect } from 'vitest';
import { metodaZId, METODY_ALLEGRO } from '../../src/domena/allegro-dostawa.js';
import {
  METODY_WYSYLKI, ETYKIETY_WYSYLKI, etykietaWysylki, sprawdzZmianeMetody, czyKanalAllegro,
} from '../../src/domena/wysylka.js';
import { METODY_DO_FILTRA, parsujFiltry, filtrujFiltrami } from '../../src/domena/filtry-listy.js';
import { wybierzKuriera, kurierWpisuRecznego } from '../../src/oms/kurierzy/index.js';
import { mapujZamowienieAllegro } from '../../src/domena/allegro-mapowanie.js';
import { linkDoSledzenia } from '../../src/domena/tracking.js';

describe('metody dostawy Allegro', () => {
  it('rozpoznaje po delivery.method.id, nie po nazwie', () => {
    // Nazwa podmieniona CELOWO — gdyby regula czytala nazwe, wynik by sie zmienil.
    expect(metodaZId('03f26351-f683-4db2-8895-f2c599280e3c', 'cokolwiek innego').metoda).toBe('allegro_dpd');
    expect(metodaZId('2488f7b7-5d1c-4d65-b85c-4cbcf253fd93', '').metoda).toBe('allegro_paczkomat');
  });

  it('nieznane id NIE JEST awarią — osiem metod na 60 zamówień znaczy, że słownik nigdy nie będzie pełny', () => {
    const w = metodaZId('nowe-id-ktorego-nie-znamy', 'Allegro Kurier Jutro');
    expect(w.metoda).toBe('allegro_inne');
    expect(w.etykieta).toBe('Allegro Kurier Jutro');
  });

  it('nieznane id BEZ nazwy dostaje etykietę zastępczą, nie pustkę', () => {
    expect(metodaZId('x', null).etykieta).toBe('Allegro — inna metoda');
  });

  it('każda metoda allegrowa jest znana panelowi', () => {
    for (const m of METODY_ALLEGRO) expect(METODY_WYSYLKI).toContain(m);
  });

  // ⚠️ ZAWIERANIE W OBIE STRONY, a nie tylko `METODY_ALLEGRO ⊆ METODY_WYSYLKI` (test wyżej).
  // Szósta metoda dopisana do METODY_WYSYLKI i zapomniana w METODY_ALLEGRO wymknęłaby się
  // NARAZ trzem strażnikom, bo każdy z nich iteruje po METODY_ALLEGRO: temu od DLA_METODY,
  // temu od etykiet i temu od filtrów. Panel nazwałby ją, pokazał w filtrach — i nikt nie
  // sprawdziłby, czy da się ją nadać.
  it('zbiory są RÓWNE — żadna metoda „allegro_*” nie może istnieć poza METODY_ALLEGRO', () => {
    const zListyPanelu = METODY_WYSYLKI.filter((m) => m.startsWith('allegro_'));
    for (const m of zListyPanelu) expect(METODY_ALLEGRO).toContain(m);
    expect([...zListyPanelu].sort()).toEqual([...METODY_ALLEGRO].sort());
  });

  // ⚠️ 11.08.2026: `allegro_dpd` MA JUŻ WPIS i prowadzi do kuriera `allegro_wza`, który kupuje
  // przewóz NA UMOWIE ALLEGRO. Pozostałe metody allegrowe wpisu DALEJ nie mają i brak jest
  // mechanizmem odmowy — paczkomat i Kurier24 z Allegro to usługi o `owner: CLIENT`, czyli
  // NASZA umowa InPostu, więc nadanie ich tą drogą byłoby drugim, płatnym przewozem.
  // ⚠️⚠️ 18.09.2026: BARIERA PRZESUNIETA, NIE ZDJETA. Do tego dnia brak wpisu w `DLA_METODY`
  // odmawial WSZYSTKIEGO poza `allegro_dpd`. Teraz `allegro_punkt`, `allegro_kurier`
  // i `allegro_inne` prowadza do adaptera WzA, a prawdziwa odmowa stoi nizej i pyta
  // o KONKRETNY identyfikator uslugi z zywego odczytu (`METODY_WZA`). Powod zmiany:
  // ORLEN, DHL i One Box maja w katalogu Allegro `owner: ALLEGRO`, czyli przewoz kupujemy
  // u Allegro — tak samo jak przy DPD.
  //
  // ⛔ `allegro_paczkomat` ZOSTAJE BEZ WPISU i to jest ta czesc bariery, ktora sie NIE ruszyla:
  // uslugi InPostu maja `owner: CLIENT`, czyli NASZA umowe, wiec nadanie ich „przez Allegro"
  // byloby drugim, platnym przewozem do klienta, ktory swoj ma juz oplacony.
  it('paczkomat z Allegro DALEJ nie ma wpisu w DLA_METODY — to cudza umowa', () => {
    expect(() => wybierzKuriera('allegro_paczkomat', { dpd: {}, inpost: {} })).toThrow(/nie jest obsługiwana/);
  });

  it('metody punktowe i kurierskie prowadzą do WzA, a nie do naszego kuriera', () => {
    for (const m of ['allegro_punkt', 'allegro_kurier', 'allegro_inne']) {
      expect(wybierzKuriera(m, { dpd: {}, allegro_wza: { znacznik: 1 } }))
        .toMatchObject({ nazwa: 'allegro_wza' });
    }
  });

  it('allegro_dpd prowadzi do allegro_wza, a NIE do naszego DPD', () => {
    expect(wybierzKuriera('allegro_dpd', { dpd: {}, allegro_wza: { znacznik: 1 } }))
      .toMatchObject({ nazwa: 'allegro_wza' });
  });

  // ⚠️ CALY SLOWNIK, a nie dwa wpisy. Test z planu sprawdzal DWA z osmiu identyfikatorow,
  // wiec literowka w pozostalych szesciu — jeden znak w UUID-zie — przechodzila niezauwazona
  // i konczyla sie metoda `allegro_inne` tam, gdzie znamy prawdziwa nazwe. Tabela ponizej
  // jest PRZEPISANA Z POMIARU (notatka 2026-08-04-allegro-rozpoznanie.md, sekcja 4), razem
  // z liczebnoscia — po to, zeby dalo sie ja porownac ze zrodlem bez czytania kodu.
  const ZMIERZONE = [
    ['03f26351-f683-4db2-8895-f2c599280e3c', 42, 'Allegro Kurier DPD (AD)', 'allegro_dpd'],
    ['2488f7b7-5d1c-4d65-b85c-4cbcf253fd93', 6, 'Allegro Paczkomaty InPost', 'allegro_paczkomat'],
    ['13f26351-26fb-48d4-b5dd-f2c599280e3c', 4, 'Allegro Kurier DPD pobranie (AD)', 'allegro_dpd'],
    ['0560b75e-88c3-4b79-bcf7-62331a20b5b2', 3, 'Allegro Odbiór w Punkcie DHL (AD)', 'allegro_punkt'],
    ['09164667-daa5-42dc-8087-33d7485790ac', 2, 'Allegro Automat ORLEN Paczka', 'allegro_punkt'],
    ['0d83955a-4297-4169-adef-9790d53b11ff', 1, 'Allegro One Kurier - dostawa jutro', 'allegro_kurier'],
    ['0fe5b4af-9f09-443d-9d49-62331a20b5b2', 1, 'Allegro Automat DHL BOX 24/7 (AD)', 'allegro_punkt'],
    ['0b9bed2c-0bc1-4e1f-9694-29bb39ebb483', 1, 'Allegro One Box, One Kurier', 'allegro_punkt'],
    // ⚠️ DOPISANE 27.08.2026, PO ZAMÓWIENIU, KTÓREGO PANEL NIE UMIAŁ NADAĆ (zam. 1233).
    // Pobraniowy wariant paczkomatu ma WŁASNY identyfikator, a słownik znał tylko ten bez
    // pobrania (`2488f7b7-…`) — zamówienie wpadało więc do `allegro_inne`, panel żądał
    // wskazania kuriera i przy pobraniu na paczce nr 1 zostawiał do wyboru SAM DPD.
    // Czyli jedyne, co dało się kliknąć, to kurier pod adres domowy, przy dostawie
    // opłaconej jako paczkomat.
    //
    // ⚠️ ZMIERZONE, NIE PRZEPISANE: `GET /shipment-management/delivery-services` na koncie
    // `allegro_szkicownia` oddaje dla tego id `owner: CLIENT` i `credentialsId: null`, czyli
    // Allegro tej etykiety NIE SPRZEDAJE — paczka jedzie na NASZEJ umowie InPostu, tak samo
    // jak wariant bez pobrania. Dlatego `allegro_paczkomat`, a nie wpis do `METODY_WZA`.
    ['b20ef9e1-faa2-4f25-9032-adbea23e5cb9', 1, 'Allegro Paczkomaty InPost pobranie', 'allegro_paczkomat'],
  ];

  it.each(ZMIERZONE)('%s (%i zamówień, „%s") → %s', (id, _ile, nazwa, oczekiwana) => {
    // Nazwa przekazana CELOWO ta prawdziwa: gdyby slownik jej uzywal, test by tego nie wykryl,
    // wiec drugie wywolanie idzie z nazwa-smieciem i musi dac ten sam wynik.
    expect(metodaZId(id, nazwa).metoda).toBe(oczekiwana);
    expect(metodaZId(id, 'ZUPELNIE INNA NAZWA').metoda).toBe(oczekiwana);
  });

  it('etykieta znanego id NIE jest surową nazwą od Allegro — słownik ma swoje brzmienie', () => {
    // Wpis w slowniku jest po to, zeby panel mowil o tej samej dostawie zawsze tak samo.
    expect(metodaZId('2488f7b7-5d1c-4d65-b85c-4cbcf253fd93', 'Allegro Paczkomaty InPost').etykieta)
      .toBe('Allegro Paczkomat InPost');
  });

  // ⚠️ NIEZMIENNIK, KTORY PSUJE SIE PRZY DOPISYWANIU WIERSZA DO SLOWNIKA: nowy identyfikator
  // z metoda spoza METODY_WYSYLKI przeszedlby przez mapowanie i wyladowal w kolumnie
  // `metoda_wysylki` jako wartosc, ktorej nie zna ani filtr listy, ani `sprawdzZmianeMetody`,
  // ani walidacja konfiguracji sklepow. Nie da sie tego sprawdzic patrzac wylacznie na
  // METODY_ALLEGRO — trzeba przepuscic KAZDY znany identyfikator przez funkcje.
  it('żaden wpis słownika nie produkuje metody spoza METODY_ALLEGRO', () => {
    for (const [id] of ZMIERZONE) {
      expect(METODY_ALLEGRO).toContain(metodaZId(id, 'x').metoda);
    }
  });

  it('brak id (undefined/null) też oddaje komplet {metoda, etykieta}, a nie undefined', () => {
    // Wywolujacy (`mapujZamowienieAllegro`) robi `?? {}` na wyniku, wiec zwrocenie undefined
    // NIE wywalilo by mapowania — po cichu wpisalo by `nieznana` i nikt by tego nie zobaczyl.
    expect(metodaZId(undefined, undefined)).toEqual({ metoda: 'allegro_inne', etykieta: 'Allegro — inna metoda' });
    expect(metodaZId(null, '   ')).toEqual({ metoda: 'allegro_inne', etykieta: 'Allegro — inna metoda' });
  });

  it('nie daje się nabrać na klucze z prototypu Object („toString", „constructor")', () => {
    // Slownik jest zwyklym obiektem, wiec `ZNANE['constructor']` istnieje i nie jest tablica.
    expect(metodaZId('constructor', 'Allegro Cos').metoda).toBe('allegro_inne');
    expect(metodaZId('toString', null).etykieta).toBe('Allegro — inna metoda');
  });
});

// ⚠️ TE TESTY SA POWODEM, DLA KTOREGO METODY W OGOLE TRAFIAJA DO `METODY_WYSYLKI`. Panel
// nie nadaje tych paczek — ma je NAZWAC i umiec po nich zawezic liste. Bez wpisu w
// ETYKIETY_WYSYLKI kolumna „Dostawa" i pole wyboru w filtrach pokazuja surowy klucz
// (`etykietaWysylki` i widok listy robia `?? metoda`), czyli usterka wygladajaca na dzialanie.
describe('metody Allegro w widokach panelu', () => {
  it('każda metoda allegrowa ma etykietę dla człowieka — żaden surowy klucz nie wychodzi na ekran', () => {
    for (const m of METODY_ALLEGRO) {
      expect(ETYKIETY_WYSYLKI[m]).toBeTruthy();
      expect(etykietaWysylki(m, false)).not.toBe(m);
      expect(etykietaWysylki(m, false)).toMatch(/^Allegro/);
    }
  });

  it('etykiety brzmią tak, jak prosił właściciel („Allegro DPD, Allegro Paczkomat, Allegro Orlen")', () => {
    expect(etykietaWysylki('allegro_dpd', false)).toBe('Allegro Kurier DPD');
    expect(etykietaWysylki('allegro_paczkomat', false)).toBe('Allegro Paczkomat InPost');
    expect(etykietaWysylki('allegro_punkt', false)).toBe('Allegro punkt / automat');
    expect(etykietaWysylki('allegro_kurier', false)).toBe('Allegro One Kurier');
    expect(etykietaWysylki('allegro_inne', false)).toBe('Allegro — inna metoda');
  });

  it('pobranie doklejane jest tak samo, jak przy dostawach sklepowych', () => {
    expect(etykietaWysylki('allegro_dpd', true)).toBe('Allegro Kurier DPD (pobranie)');
  });

  it('metody allegrowe są na liście filtra, a filtr po nich naprawdę zawęża listę', () => {
    for (const m of METODY_ALLEGRO) expect(METODY_DO_FILTRA).toContain(m);

    // Adres `/?wysylka=allegro_paczkomat` ma przejsc przez `parsujFiltry` (wartosc spoza
    // METODY_DO_FILTRA spada do null, czyli „bez filtra" — i lista pokazalaby WSZYSTKO).
    const filtry = parsujFiltry({ wysylka: 'allegro_paczkomat' }, definicjeKanalowHistoryczne);
    expect(filtry.wysylka).toBe('allegro_paczkomat');

    const lista = [
      { id: 1, numer: 'A', metoda_wysylki: 'allegro_paczkomat' },
      { id: 2, numer: 'B', metoda_wysylki: 'allegro_dpd' },
      { id: 3, numer: 'C', metoda_wysylki: 'dpd' },
    ];
    expect(filtrujFiltrami(lista, filtry).map((z) => z.numer)).toEqual(['A']);
  });
});

// ⚠️ KONTRAKT Z `domain/allegro-mapowanie.js`. Tamten modul wola `metodaZId` jako WSTRZYKNIETA
// zaleznosc i robi `const { metoda } = metodaZId(...) ?? {}` — czyli zmiana ksztaltu wyniku
// (napis zamiast obiektu, inna nazwa klucza) NIE WYWALA NICZEGO, tylko po cichu wpisuje
// `nieznana` do kolumny `metoda_wysylki`. Testy tamtego modulu podaja wlasna atrape, wiec
// zgodnosci obu stron nie pilnowal dotad NIKT. Pilnuje jej ten opis.
describe('kontrakt: mapowanie Allegro × słownik metod', () => {
  const kwota = (a) => ({ amount: a, currency: 'PLN' });
  const surowe = (metodaId, nazwa = 'Allegro Kurier DPD (AD)') => ({
    id: 'e2a1-…',
    status: 'READY_FOR_PROCESSING',
    payment: { type: 'ONLINE', paidAmount: kwota('90.00') },
    delivery: { method: { id: metodaId, name: nazwa }, cost: kwota('0.00'), address: { street: 'Ul. 1', city: 'Pęki', zipCode: '00-650' } },
    lineItems: [{ id: 'li-1', offer: { name: 'Szablon' }, quantity: 2, price: kwota('45.00'), tax: { rate: '23.00' } }],
    surcharges: [],
    summary: { totalToPay: kwota('90.00') },
  });

  it('prawdziwy słownik (nie atrapa) wpisuje metodę do modelu zamówienia', () => {
    const z = mapujZamowienieAllegro(surowe('2488f7b7-5d1c-4d65-b85c-4cbcf253fd93'), { metodaZId });
    expect(z.metoda_wysylki).toBe('allegro_paczkomat');
  });

  it('nieznane id NIE zamienia się w „nieznana" — to ma być allegro_inne', () => {
    // „nieznana" znaczy w panelu „metoda DO WYJASNIENIA, popraw ja na karcie". Dla kanalu,
    // w ktorym niepoznane id jest przypadkiem NORMALNYM, byloby to zaproszenie do roboty,
    // ktorej nie ma — i zamowienie wpadaloby w powod „nieznana metoda" w nadaniu hurtem.
    const z = mapujZamowienieAllegro(surowe('id-ktorego-nie-ma', 'Allegro Kurier Jutro'), { metodaZId });
    expect(z.metoda_wysylki).toBe('allegro_inne');
  });

  it('metoda wpisana do modelu zawsze jest wartością, którą panel zna', () => {
    for (const id of ['03f26351-f683-4db2-8895-f2c599280e3c', 'zupelnie-nowe-id', '']) {
      expect(METODY_WYSYLKI).toContain(mapujZamowienieAllegro(surowe(id), { metodaZId }).metoda_wysylki);
    }
  });
});

// ⚠️⚠️ DRUGA POLOWA ODMOWY NADANIA, I TA STOI NA WEJSCIU. `podzielDoNadania` pilnuje nadania
// hurtem, ale robi to na wartosci EFEKTYWNEJ — a wartosc efektywna ustawia wlasnie ten
// formularz. Bez bramki TUTAJ odmowa jest kluczowana czyms, co operator zmienia jednym
// kliknieciem: przestawia zamowienie z Allegro na „dpd" i panel nadaje mu DRUGA, platna
// paczke do klienta, ktory dostal juz swoja z Allegro.
//
// Dyskryminatorem jest KANAL (`sklep`), bo `sklep` jest trwaly — ustawia go poller kanalu,
// a metoda jest z definicji edytowalna.
describe('sprawdzZmianeMetody — kanał Allegro nie da się przestawić na dostawę panelu', () => {
  const zAllegro = { id: 1, sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' };
  const zeSklepu = { id: 2, sklep: 'szkicownia', metoda_wysylki: 'dpd' };

  it.each(['dpd', 'inpost_paczkomat', 'odbior_osobisty'])('odmawia przestawienia na „%s”', (metoda) => {
    const { nadpisanie, blad } = sprawdzZmianeMetody(metoda, false, '', '', zAllegro);
    expect(nadpisanie).toBeNull();
    expect(blad).toMatch(/nadajesz w Allegro/);
  });

  // Powod ma nazywac PRAWDZIWA przyczyne. „Metoda nie jest obslugiwana" byloby nieprawda
  // (panel te metode nadaje na okraglo), a czlowiek probowalby ja naprawiac.
  it('powód jest czytelny i mówi, gdzie tę paczkę się nadaje', () => {
    const { blad } = sprawdzZmianeMetody('dpd', false, '', '', zAllegro);
    expect(blad).toMatch(/Allegro/);
    expect(blad).not.toMatch(/nie jest obsługiwana/);
  });

  // Odmowa kanalowa stoi PRZED bramka na kwote pobrania: inaczej operator dostalby
  // komunikat o kwocie, poprawil ja i sprobowal jeszcze raz — czyli robote do wykonania
  // przy zamowieniu, ktorego panel nie nada nigdy.
  it('odmowa kanałowa wyprzedza pytanie o kwotę pobrania', () => {
    const { blad } = sprawdzZmianeMetody('dpd', true, '', '', zAllegro);
    expect(blad).toMatch(/nadajesz w Allegro/);
    expect(blad).not.toMatch(/kwoty pobrania/);
  });

  // Poprawka W OBREBIE kanalu ma dzialac — to jedyna reczna zmiana metody, ktora przy
  // Allegro ma sens (np. `allegro_inne` z nowej uslugi na wlasciwa nazwe).
  it('poprawka w obrębie metod Allegro przechodzi', () => {
    const { nadpisanie, blad } = sprawdzZmianeMetody('allegro_paczkomat', false, '', '', zAllegro);
    expect(blad).toBeNull();
    expect(nadpisanie).toEqual({ metoda: 'allegro_paczkomat', pobranie: 0 });
  });

  it('zamówienia ze sklepu bramka nie dotyczy — DPD dalej wolno ustawić', () => {
    expect(sprawdzZmianeMetody('dpd', false, '', '', zeSklepu).blad).toBeNull();
  });

  it('wywołanie bez zamówienia (czterema argumentami) zachowuje się jak dotąd', () => {
    expect(sprawdzZmianeMetody('dpd', false, '').blad).toBeNull();
    expect(sprawdzZmianeMetody('dpd', false, '', '', null).blad).toBeNull();
  });

  // Klucz sklepu zaczynajacy sie od „allegro" bez podkreslnika NIE JEST kanalem Allegro —
  // ta sama pulapka, co przy metodach w masowe.js.
  it('klucz sklepu „allegrowy” nie jest kanałem Allegro', () => {
    expect(czyKanalAllegro({ sklep: 'allegrowy' })).toBe(false);
    expect(sprawdzZmianeMetody('dpd', false, '', '', { sklep: 'allegrowy' }).blad).toBeNull();
  });

  it('czyKanalAllegro rozpoznaje oba konta i nie wywraca się na braku danych', () => {
    expect(czyKanalAllegro({ sklep: 'allegro_szkicownia' })).toBe(true);
    expect(czyKanalAllegro({ sklep: 'allegro_amarka' })).toBe(true);
    expect(czyKanalAllegro({})).toBe(false);
    expect(czyKanalAllegro(null)).toBe(false);
    expect(czyKanalAllegro(undefined)).toBe(false);
  });
});

// ⚠️ WPIS RECZNY ≠ NADANIE. `kurierWpisuRecznego` sluzy WYLACZNIE odnotowaniu faktu
// o paczce, ktora juz jedzie (trasa /przesylki/reczna) — i to jest jedyna droga, ktora
// zamowienie z Allegro w ogole przejdzie. Zapasowe 'dpd' znaczylo tu, ze numer listu
// z Allegro („AD…") linkuje na tracktrace.dpd.com.pl, a petla odswiezania pyta DPD o CUDZA
// przesylke — usterka naprawiona 04.08.2026 przy paczkomatach, jeden do jednego.
describe('kurier wpisu ręcznego dla kanału Allegro', () => {
  it('każda metoda allegrowa daje kuriera „allegro”, a nie zapasowe „dpd”', () => {
    for (const m of METODY_ALLEGRO) expect(kurierWpisuRecznego(m)).toBe('allegro');
  });

  // ⚠️ HISTORIA TEGO TESTU, zeby nikt nie „naprawial" go w kolko: Zadanie 9 przestawilo go
  // na `toMatch(/allegro\.pl/)`, bo dopisalo wzorzec `allegro` do domain/tracking.js — a
  // recenzja ten wzorzec ZDJELA, bo adresu nikt nie otworzyl w przegladarce. Pilnowana regula
  // przez caly czas byla TA SAMA i zostaje: numer „AD…" nie ma prawa trafic do DPD.
  //
  // Dzis `linkDoSledzenia('allegro', …)` oddaje `null` i to jest odpowiedz POPRAWNA — ikona
  // przesylki spada wtedy na karte zamowienia (lista-ikony.js), czyli na link, ktory na pewno
  // dziala. Gdy adres Allegro zostanie ZMIERZONY, ta asercja zmieni sie swiadomie.
  it('numer z Allegro NIE prowadzi do śledzenia DPD', () => {
    const kurier = kurierWpisuRecznego('allegro_dpd');
    expect(linkDoSledzenia(kurier, 'AD123456789')).toBeNull();
    // Kontrola sensu: ten sam numer podany jako 'dpd' MUSI trafiac do DPD — inaczej asercja
    // wyzej przechodzilaby dlatego, ze funkcja nie dziala w ogole.
    expect(linkDoSledzenia('dpd', 'AD123456789')).toMatch(/tracktrace\.dpd\.com\.pl/);
  });

  // ⚠️ TO NIE JEST WPIS W `DLA_METODY` i nie wolno, zeby sie nim stalo: tamta mapa steruje
  // NADAWANIEM, a brak w niej metod Allegro jest mechanizmem odmowy.
  // ⚠️ `allegro` (kurier wpisu ręcznego) to CO INNEGO niż `allegro_wza` (kurier kupujący
  // przewóz). Pierwszy znaczy „nadał to ktoś inny, nie pytamy nikogo", drugi „kupiliśmy my".
  // Sama obecność pierwszego w mapie NIE MA prawa niczego nadać.
  it('mimo kuriera wpisu ręcznego nadanie z panelu dalej odmawia', () => {
    // Paczkomat allegrowy: brak wpisu w DLA_METODY, czyli odmowa kategoryczna.
    expect(() => wybierzKuriera('allegro_paczkomat', { dpd: {}, inpost: {}, allegro: {} }))
      .toThrow(/nie jest obsługiwana/);
    // Reszta metod allegrowych: obecność kuriera WPISU RĘCZNEGO (`allegro`) nadal niczego
    // nie nadaje — potrzebny jest skonfigurowany `allegro_wza`, czyli kurier KUPUJĄCY przewóz.
    for (const m of METODY_ALLEGRO.filter((x) => x !== 'allegro_paczkomat')) {
      expect(() => wybierzKuriera(m, { dpd: {}, inpost: {}, allegro: {} }))
        .toThrow(/allegro_wza nie jest skonfigurowany/);
    }
  });

  it('metody sklepowe i nieznana zachowują się dokładnie jak dotąd', () => {
    expect(kurierWpisuRecznego('dpd')).toBe('dpd');
    expect(kurierWpisuRecznego('inpost_paczkomat')).toBe('inpost');
    expect(kurierWpisuRecznego('nieznana')).toBe('dpd');
    expect(kurierWpisuRecznego(undefined)).toBe('dpd');
    // Nazwa zaczynajaca sie od „allegro" bez podkreslnika to nie kanal Allegro.
    expect(kurierWpisuRecznego('allegrowa_dostawa')).toBe('dpd');
  });
});
