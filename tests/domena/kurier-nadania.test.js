import { describe, it, expect } from 'vitest';
import {
  wymagaWyboruKuriera, kurierzyDoWyboru, metodaNadania, nadanieDaZpl,
} from '../../src/domena/kurier-nadania.js';

// ZGŁOSZENIE WŁAŚCICIELA 2026-08-07 (zam. 1120 i 1126): do zamówienia z Allegro trzeba
// dosłać paczkę WŁASNYM kurierem — DPD albo paczkomatem. Panel tego nie potrafił, a karta
// mimo to pokazywała „Nadaj paczkę" i ekran nadania wypełniał komplet pól: odmowa padała
// dopiero z `wybierzKuriera`, po zapakowaniu paczki.

const zam = (o = {}) => ({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd', pobranie: 0, ...o });

describe('kiedy panel musi zapytać o kuriera', () => {
  // ⚠️ PACZKOMAT WYPADL Z TEJ LISTY 07.08.2026 (druga fala) — Allegro etykiety paczkomatowej
  // nie sprzedaje, wiec nie ma czego dublowac i pytanie byloby klikaniem bez tresci. Ma to
  // swoj wlasny blok testow na koncu pliku.
  it('zamówienie z Allegro — tak, dla metod, których panel nie umie nadać', () => {
    expect(wymagaWyboruKuriera(zam({ metoda_wysylki: 'allegro_dpd' }))).toBe(true);
    expect(wymagaWyboruKuriera(zam({ metoda_wysylki: 'allegro_punkt' }))).toBe(true);
    expect(wymagaWyboruKuriera(zam({ metoda_wysylki: 'allegro_kurier' }))).toBe(true);
    expect(wymagaWyboruKuriera(zam({ metoda_wysylki: 'allegro_inne' }))).toBe(true);
  });

  it('zamówienie ze sklepu — nie, nic się dla niego nie zmienia', () => {
    expect(wymagaWyboruKuriera({ sklep: 'pro', metoda_wysylki: 'dpd' })).toBe(false);
    expect(wymagaWyboruKuriera({ sklep: 'szkicownia', metoda_wysylki: 'inpost_paczkomat' })).toBe(false);
    expect(wymagaWyboruKuriera({ sklep: 'reczne', metoda_wysylki: 'odbior_osobisty' })).toBe(false);
  });
});

describe('kogo wolno wskazać', () => {
  // ⚠️ 11.08.2026: przy `allegro_dpd` lista zaczyna się od drogi domyślnej („Wysyłam
  // z Allegro"), a nasi kurierzy są dalej — jako odstępstwo (dosyłka), nie jako norma.
  it('przy allegro_dpd: najpierw WzA, potem nasi kurierzy', () => {
    expect(kurierzyDoWyboru(zam()).map((k) => k.klucz)).toEqual(['wza', 'dpd', 'inpost_paczkomat']);
  });

  it('przy metodzie bez drogi domyślnej: sami nasi kurierzy, jak dotąd', () => {
    expect(kurierzyDoWyboru(zam({ metoda_wysylki: 'allegro_metoda_z_przyszlosci' })).map((k) => k.klucz))
      .toEqual(['dpd', 'inpost_paczkomat']);
  });

  // ⚠️ PIENIĄDZE. Pobranie paczkomatowe jest zbudowane, ale UMOWA Z INPOSTEM NA NIE NIE
  // ZOSTAŁA POTWIERDZONA — wszystkie 44 przesyłki konta mają `cod` puste, a lista usług
  // organizacji nie ma wariantu pobraniowego. Paczka pojechałaby bez inkasa i bez błędu.
  // ⚠️ 11.08.2026: przy pobraniu doszło „Wysyłam z Allegro". Ograniczenie chroniło przed
  // PACZKOMATEM bez inkasa (umowa z InPostem na pobranie NIEPOTWIERDZONA), a nie przed
  // Allegro — tam inkaso jest częścią usługi (limit 6000 zł, zmierzone na zam. #1148).
  // Paczkomat DALEJ odpada i to jest treść tej bariery.
  it('przy pobraniu na paczce nr 1: WzA i DPD, NIGDY paczkomat', () => {
    const lista = kurierzyDoWyboru(zam({ pobranie: 1 }), 1).map((k) => k.klucz);
    expect(lista).toEqual(['wza', 'dpd']);
    expect(lista).not.toContain('inpost_paczkomat');
  });

  // Na paczce N > 1 pobranie i tak NIE JEDZIE (niezmiennik 4.4), więc ograniczanie wyboru
  // byłoby blokadą bez powodu — a dosyłka do zamówienia pobraniowego to najzwyklejszy
  // przypadek użycia tego ekranu.
  it('przy dosyłce do zamówienia pobraniowego wybór jest pełny', () => {
    expect(kurierzyDoWyboru(zam({ pobranie: 1 }), 2).map((k) => k.klucz))
      .toEqual(['wza', 'dpd', 'inpost_paczkomat']);
  });

  // ⚠️⚠️ PIENIĄDZE, I TO JEST NAJWAŻNIEJSZY TEST TEJ ZMIANY (04.09.2026). Od chwili, gdy
  // operator może kazać pobraniu pojechać na paczce N > 1 (zamiennik wyrzuconej etykiety),
  // zdanie „na paczce N > 1 pobranie i tak nie jedzie" PRZESTAJE być prawdziwe — a to ono
  // uzasadniało pełny wybór kuriera powyżej. Bez tej bariery powstaje droga: zamiennik za
  // pobraniem przez paczkomat → InPost nie inkasuje NIC → towar oddany za darmo, bez ani
  // jednego błędu po drodze. Dyskryminatorem jest więc „czy pobranie jedzie na TEJ paczce",
  // a nie sam numer paczki.
  it('gdy pobranie jedzie na paczce nr 2: WzA i DPD, NIGDY paczkomat', () => {
    const lista = kurierzyDoWyboru(zam({ pobranie: 1 }), 2, { pobranieNaTejPaczce: true }).map((k) => k.klucz);
    expect(lista).toEqual(['wza', 'dpd']);
    expect(lista).not.toContain('inpost_paczkomat');
  });

  // Zamówienie przedpłacone nie ma czego inkasować — jawna decyzja niczego tu nie zmienia
  // i wybór zostaje pełny. Inaczej zaznaczenie pola w formularzu odcinałoby paczkomat
  // zamówieniu, które pobrania w ogóle nie ma.
  it('przedpłata: decyzja o pobraniu na tej paczce nie zawęża wyboru', () => {
    expect(kurierzyDoWyboru(zam({ pobranie: 0 }), 2, { pobranieNaTejPaczce: true }).map((k) => k.klucz))
      .toEqual(['wza', 'dpd', 'inpost_paczkomat']);
  });
});

describe('metoda, którą panel naprawdę nada', () => {
  it('wskazanie DPD daje metodę dpd', () => {
    expect(metodaNadania(zam(), 'dpd')).toMatchObject({ metoda: 'dpd', wskazanyRecznie: true });
  });

  it('wskazanie paczkomatu daje metodę inpost_paczkomat', () => {
    expect(metodaNadania(zam({ metoda_wysylki: 'allegro_paczkomat' }), 'inpost_paczkomat'))
      .toMatchObject({ metoda: 'inpost_paczkomat' });
  });

  // ⚠️ BARIERA. Bez wskazania panel nadal odmawia — zmiana polega na tym, ŻE DA SIĘ
  // wskazać, a nie na tym, że przestaje pytać.
  // ⚠️ 11.08.2026: dla `allegro_dpd` brak wskazania przestał być odmową — jest drogą domyślną
  // („Wysyłam z Allegro"). Odmowa ZOSTAJE dla metod, których panel nadal nie umie nadać, i to
  // ona jest tu sprawdzana, żeby zmiana nie rozlała się na całą rodzinę `allegro_*`.
  it('brak wskazania to ODMOWA tam, gdzie panel nie ma drogi domyślnej', () => {
    const r = metodaNadania({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_metoda_z_przyszlosci' }, undefined);
    expect(r.metoda).toBeUndefined();
    expect(r.blad).toMatch(/wskaż kuriera/i);
  });

  it('brak wskazania przy allegro_dpd prowadzi do „Wysyłam z Allegro", nie do odmowy', () => {
    const r = metodaNadania({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' }, undefined);
    expect(r.metoda).toBe('allegro_dpd');
    expect(r.blad).toBeUndefined();
  });

  // ⚠️ FURTKA NA DOSYŁKĘ ZOSTAJE — i to jest powód, dla którego `allegro_dpd` NIE trafił do
  // `NADAJEMY_SAMI` (tamta mapa IGNORUJE wskazanie człowieka). Zamiennik za zgubioną paczkę
  // dalej da się nadać naszą umową, świadomym wskazaniem na ekranie nadania.
  it('wskazanie NASZEGO kuriera przy allegro_dpd dalej działa — dosyłka', () => {
    const r = metodaNadania({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' }, 'dpd');
    expect(r).toMatchObject({ metoda: 'dpd', wskazanyRecznie: true });
  });

  it('wskazanie kuriera, którego panel nie zna, to odmowa', () => {
    expect(metodaNadania(zam(), 'poczta').blad).toMatch(/Nie umiem nadać/);
    expect(metodaNadania(zam(), 'allegro_dpd').blad).toMatch(/Nie umiem nadać/);
  });

  // ⚠️ NAJWAŻNIEJSZY TEST OCHRONNY W TYM PLIKU. Gdyby wybór działał wszędzie, jedno pole
  // formularza zamieniałoby sklepowe zamówienie ZA POBRANIEM w przesyłkę paczkomatową bez
  // inkasa — omijając tablicę dostaw (domain/mapowanie-wysylki.js), która istnieje właśnie
  // po to, żeby tego pilnować.
  it('dla zamówienia SPOZA Allegro wybór jest IGNOROWANY, nie honorowany', () => {
    const sklepowe = { sklep: 'szkicownia', metoda_wysylki: 'dpd', pobranie: 1 };
    expect(metodaNadania(sklepowe, 'inpost_paczkomat')).toEqual({ metoda: 'dpd' });
    expect(metodaNadania(sklepowe, 'dpd')).toEqual({ metoda: 'dpd' });
  });

  it('odbiór osobisty zostaje odbiorem osobistym — dalej nie ma go czym nadać', () => {
    expect(metodaNadania({ sklep: 'reczne', metoda_wysylki: 'odbior_osobisty' }, 'dpd'))
      .toEqual({ metoda: 'odbior_osobisty' });
  });

  // Paczkomat przy pobraniu na paczce nr 1 odbija się od listy dozwolonych, a nie
  // przechodzi „bo operator tak kliknął".
  it('paczkomat przy pobraniu na paczce nr 1 to odmowa', () => {
    const r = metodaNadania(zam({ pobranie: 1 }), 'inpost_paczkomat', { kolejnosc: 1 });
    expect(r.metoda).toBeUndefined();
    expect(r.blad).toMatch(/Nie umiem nadać/);
  });
});

// ——— PACZKOMAT Z ALLEGRO NADAJE OMS (2026-08-07, druga fala) ————————————————————————
//
// Właściciel, wprost: „Paczka paczkomat allegro nadawana ma być przez OMS. Tak jest teraz
// w Apilo. Nie da się jej nadać przez allegro."
//
// ⚠️ TO NIE JEST ZDJĘCIE BARIERY, TYLKO JEJ ZAWĘŻENIE DO MIEJSCA, W KTÓRYM COŚ ZNACZY.
// Bariera istnieje po to, żeby panel nie nadał DRUGIEJ, PŁATNEJ paczki do klienta, który
// swoją już dostał — a ryzyko drugiej paczki bierze się stąd, że Allegro potrafi sprzedać
// etykietę na tę samą przesyłkę. Przy paczkomacie Allegro etykiety NIE SPRZEDAJE, więc
// pierwszej paczki z tamtej strony po prostu nie ma i nie ma czego dublować. Przy
// `allegro_dpd` etykieta istnieje i tam pytanie o kuriera ZOSTAJE.
describe('paczkomat z Allegro idzie naszym InPostem, bez pytania', () => {
  const paczkomat = { sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_paczkomat', pobranie: 0 };

  it('nie wymaga wskazania kuriera', () => {
    expect(wymagaWyboruKuriera(paczkomat)).toBe(false);
  });

  it('nadaje się metodą inpost_paczkomat, bez żadnego wyboru', () => {
    expect(metodaNadania(paczkomat, undefined)).toMatchObject({ metoda: 'inpost_paczkomat' });
    expect(metodaNadania(paczkomat, '')).toMatchObject({ metoda: 'inpost_paczkomat' });
  });

  // ⚠️ `allegro_dpd` DALEJ jest „do wyboru" (`wymagaWyboruKuriera === true`) — i to nie jest
  // sprzeczność z drogą domyślną. Ta funkcja odpowiada na pytanie „czy człowiekowi wolno tu
  // wskazać kuriera", a nie „czy musi". Wolno, bo dosyłka naszą umową zostaje możliwa;
  // przy BRAKU wskazania idzie „Wysyłam z Allegro" (test wyżej). Gdyby ta funkcja oddała
  // `false`, ekran nadania przestałby w ogóle pokazywać wybór — i furtka zniknęłaby po cichu.
  it('allegro_dpd dalej POZWALA wskazać kuriera, choć już go nie wymaga', () => {
    expect(wymagaWyboruKuriera({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' })).toBe(true);
    expect(metodaNadania({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' }, undefined).blad)
      .toBeUndefined();
  });

  // ⚠️ 18.09.2026: „panel nie umie ich nadać" PRZESTAŁO być prawdą — `allegro_punkt`,
  // `allegro_kurier` i `allegro_inne` mają drogę domyślną („Wysyłam z Allegro") i osiem
  // usług w `METODY_WZA`. Ten test dalej ma sens, ale mierzy co innego: te metody NADAL
  // przechodzą przez pytanie o kuriera, bo nie siedzą w `NADAJEMY_SAMI` — czyli furtka
  // na dosyłkę NASZĄ umową (zamiennik za zgubioną) zostaje otwarta. Różnica wobec stanu
  // sprzed zmiany jest w tym, co dzieje się przy BRAKU wskazania: dotąd odmowa, teraz WzA.
  it('allegro_punkt i allegro_inne DALEJ przechodzą przez pytanie o kuriera', () => {
    expect(wymagaWyboruKuriera({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_punkt' })).toBe(true);
    expect(wymagaWyboruKuriera({ sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_inne' })).toBe(true);
  });

  // ⚠️ Skoro wyboru nie ma, to i nadpisanie go nie ma prawa nic zmienić — inaczej wracałaby
  // furtką ta sama dziura, przed którą broni `metodaNadania` przy zamówieniach sklepowych.
  it('wskazanie DPD przy paczkomacie z Allegro jest IGNOROWANE', () => {
    expect(metodaNadania(paczkomat, 'dpd')).toMatchObject({ metoda: 'inpost_paczkomat' });
  });

  // ⚠️⚠️ PACZKOMAT ALLEGROWY ZA POBRANIEM — DECYZJA WŁAŚCICIELA 27.08.2026 (zam. 1233).
  //
  // `kurierzyDoWyboru` zostawia przy pobraniu na paczce nr 1 sam DPD, bo umowa z InPostem na
  // pobranie była NIEPOTWIERDZONA (rozpoznanie 01.08: 0 przesyłek z `cod` na 49). Ta metoda
  // tamtego strażnika NIE KONSULTUJE — `NADAJEMY_SAMI` prowadzi wprost do `inpost_paczkomat`
  // i tak ma być, ale niech to będzie NAPISANE, a nie wywnioskowane z braku testu.
  //
  // Co rozstrzygnęło: `GET /shipment-management/delivery-services` oddaje dla tej usługi
  // `cashOnDelivery: {limit: 5000, currency: PLN, paymentType: MONEY_TRANSFER}`, czyli
  // gotówkę inkasuje INPOST i przelewa nam na konto — inaczej niż przy DPD przez Allegro
  // (`WALLET_TRANSFER`, inkasuje Allegro). Pobranie MUSI więc wejść jako `cod` na przesyłce
  // ShipX, na naszej umowie, a nie przez „Wysyłam z Allegro" (`credentialsId: null`).
  //
  // ⚠️ REALNE ZABEZPIECZENIE PRZENIOSŁO SIĘ DO KLIENTA SHIPX: `kurierzy/inpost.js` sprawdza,
  // czy InPost ODDAŁ pobranie, którego zażądaliśmy. Cicho pominięte pobranie to towar oddany
  // za darmo — i to jest jedyne miejsce, w którym da się to wyłapać.
  it('paczkomat z Allegro ZA POBRANIEM też idzie naszym InPostem, bez pytania o kuriera', () => {
    const zPobraniem = { ...paczkomat, pobranie: 1, kwota_pobrania: '41.29' };
    expect(wymagaWyboruKuriera(zPobraniem)).toBe(false);
    expect(metodaNadania(zPobraniem, undefined)).toMatchObject({ metoda: 'inpost_paczkomat' });
  });
});

// ⚠️⚠️ REGUŁA NIEDOSTĘPNA Z EKRANU NIE ISTNIEJE (11.08.2026, po pierwszej próbie nadania).
//
// `WZA_DOMYSLNIE` sprawiło, że BRAK wskazania prowadzi do „Wysyłam z Allegro" — ale ekran
// nadania każe wybrać pozycję Z LISTY, a lista znała wyłącznie naszych kurierów. Jedyne, co
// dało się kliknąć, to nadanie NASZĄ umową: drugi płatny przewóz do klienta, który ma już
// opłaconą dostawę. Testy domeny świeciły na zielono, bo pytały o `metodaNadania(z, undefined)`
// — czyli o stan, którego ekran nie umiał wyprodukować.
describe('droga domyślna musi być NA LIŚCIE WYBORU, nie tylko w regule', () => {
  const allegroDpd = { sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' };

  it('lista wyboru dla allegro_dpd zawiera „Wysyłam z Allegro" i to ONO jest pierwsze', () => {
    const lista = kurierzyDoWyboru(allegroDpd);
    expect(lista[0].klucz).toBe('wza');
    expect(lista[0].etykieta).toMatch(/Wysyłam z Allegro/);
    expect(lista.map((k) => k.klucz)).toContain('dpd');
  });

  it('wskazanie „wza" znaczy DOKŁADNIE to samo, co brak wskazania', () => {
    expect(metodaNadania(allegroDpd, 'wza')).toEqual(metodaNadania(allegroDpd, undefined));
    expect(metodaNadania(allegroDpd, 'wza').metoda).toBe('allegro_dpd');
    // ⚠️ To NIE jest „wskazanie ręczne" — człowiek wybrał drogę właściwą, a nie odstępstwo.
    // Wpis do logu „nadane NASZĄ umową" przy tym wyborze byłby po prostu nieprawdą.
    expect(metodaNadania(allegroDpd, 'wza').wskazanyRecznie).toBeUndefined();
  });

  it('metody bez drogi domyślnej listy nie dostają — odmowa zostaje', () => {
    const punkt = { sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_metoda_z_przyszlosci' };
    expect(kurierzyDoWyboru(punkt).map((k) => k.klucz)).not.toContain('wza');
    expect(metodaNadania(punkt, 'wza').blad).toMatch(/Nie umiem nadać/);
  });

  // Pobranie przez WzA jeszcze nie wchodzi (Partia 2) — lista ma go wtedy NIE proponować,
  // bo panel i tak by odmówił, a przycisk prowadzący prosto w odmowę jest gorszy niż brak.
  it('przy pobraniu na pierwszej paczce WzA JEST, a paczkomatu nie', () => {
    expect(kurierzyDoWyboru({ ...allegroDpd, pobranie: 1 }, 1).map((k) => k.klucz)).toEqual(['wza', 'dpd']);
  });
});

// ——— CZY Z NADANIA BĘDZIE ZPL (zgłoszenie właściciela 2026-09-01: „Nadaj i drukuj nie działa") ———
// Kolejka druku na Zebrze przyjmuje WYŁĄCZNIE ZPL. Wysyłka z Allegro (WzA) oddaje etykietę
// wyłącznie jako PDF — zmierzone 10.08.2026 (notatki/2026-08-10-allegro-wysylka-rozpoznanie.md:
// „Etykieta wraca jako binarny PDF"; `labelFormat: "PDF"` w podpowiedzi Allegro). „Nadaj
// i drukuj" przy tej drodze nadawał paczkę i po cichu pisał do logu „BRAK ZPL — nie dodano
// do kolejki": z punktu widzenia operatora przycisk NIE DZIAŁAŁ.
describe('nadanieDaZpl — czy jest co wstawić do kolejki druku', () => {
  it('nasza umowa DPD i paczkomat InPost dają ZPL', () => {
    expect(nadanieDaZpl('dpd')).toBe(true);
    expect(nadanieDaZpl('inpost_paczkomat')).toBe(true);
  });

  it('WzA może zamówić ZPL po świadomym kliknięciu „Nadaj i drukuj”', () => {
    // `metodaNadania` oddaje przy WzA metodę zamówienia, a nie klucz „wza" — pilnujemy
    // DOKŁADNIE tej wartości, która trafia do widoku jako `metodaUzyta`.
    const zAllegro = { sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd' };
    expect(metodaNadania(zAllegro, 'wza').metoda).toBe('allegro_dpd');
    expect(nadanieDaZpl('allegro_dpd')).toBe(true);
    expect(nadanieDaZpl('allegro_punkt')).toBe(true);
    expect(nadanieDaZpl('allegro_kurier')).toBe(true);
    expect(nadanieDaZpl('allegro_inne')).toBe(true);
    expect(nadanieDaZpl('allegro_paczkomat')).toBe(false);
  });

  // ⚠️ BIAŁA LISTA, nie „wszystko oprócz Allegro": kurier dołożony jutro nie ma prawa
  // odziedziczyć przycisku „Nadaj i drukuj" po cichu, tylko dlatego, że nie nazywa się
  // „allegro". Nieznana metoda ma dawać `false`, tak samo jak brak metody.
  it('metoda nieznana i pusta nie dają ZPL-a', () => {
    expect(nadanieDaZpl('poczta')).toBe(false);
    expect(nadanieDaZpl(null)).toBe(false);
    expect(nadanieDaZpl(undefined)).toBe(false);
  });
});
