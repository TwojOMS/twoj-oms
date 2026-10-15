import { describe, it, expect } from 'vitest';
import {
  ikonaPlatnosci, ikonaPrzesylki, ikonaChceFaktury, ikonaFaktury, odznakaSyncStatusu,
} from '../../src/domena/lista-ikony.js';

// Cztery ikony wiersza listy (Zadanie „strona główna", punkt C). Testowane w izolacji,
// bez sieci i bez bazy — ta sama zasada, co reszta `domain/` (przewodnik OMS, sekcja 3).

describe('ikonaPlatnosci', () => {
  // ⚠️ SEDNO reguły: pobranie WYGRYWA nad opłacone/nieopłacone. Przy wysyłce za pobraniem
  // brak wpłaty jest stanem NORMALNYM — karta zamówienia (zamowienie.ejs) z tego samego
  // powodu nie ostrzega wtedy o braku wpłaty. Ikona ma się z tym zgadzać.
  it('pobranie wygrywa nad brakiem wpłaty — stan "pobranie", nie "nieoplacone"', () => {
    const z = { metoda_wysylki: 'dpd', pobranie: 1, oplacone_at: null };
    expect(ikonaPlatnosci(z).stan).toBe('pobranie');
  });

  it('pobranie wygrywa nawet gdy zamówienie JEST opłacone (przedpłata + pobranie w danych sklepu)', () => {
    const z = { metoda_wysylki: 'dpd', pobranie: 1, oplacone_at: '2026-07-30T09:00:00' };
    expect(ikonaPlatnosci(z).stan).toBe('pobranie');
  });

  // ⚠️ Pobranie RĘCZNE (włączone z karty) leży w nadpisaniu, nie w kolumnie — a ikona ma
  // mówić to samo, co karta. Gdyby czytała samą kolumnę, lista pokazywałaby „nieopłacone"
  // przy zamówieniu, przy którym kurier ma zainkasować pieniądze.
  it('pobranie włączone ręcznie z karty też wygrywa', () => {
    const z = {
      metoda_wysylki: 'dpd', pobranie: 0, oplacone_at: null,
      wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '246.00' }),
    };
    expect(ikonaPlatnosci(z).stan).toBe('pobranie');
  });

  it('zwykła wysyłka, opłacone → stan "oplacone"', () => {
    const z = { metoda_wysylki: 'dpd', oplacone_at: '2026-07-30T09:00:00' };
    expect(ikonaPlatnosci(z).stan).toBe('oplacone');
  });

  it('zwykła wysyłka, nieopłacone → stan "nieoplacone"', () => {
    const z = { metoda_wysylki: 'dpd', oplacone_at: null };
    expect(ikonaPlatnosci(z).stan).toBe('nieoplacone');
  });

  // Opis ikony to tekst DLA CZLOWIEKA, dokladnie tak samo jak komorka tabeli. Surowy
  // znacznik ISO w UTC pokazywalby w dymku inna godzine niz reszta panelu — latem o dwie.
  it('data w opisie jest sformatowana i przeliczona na czas polski, nie surowa', () => {
    const z = { metoda_wysylki: 'dpd', oplacone_at: '2026-07-30T18:11:48.883Z' };
    const { opis } = ikonaPlatnosci(z);
    expect(opis).toContain('2026-07-30 20:11:48');
    expect(opis).not.toContain('T18:11:48');
    expect(opis).not.toContain('Z)');
  });

  // Data ze sklepu przychodzi BEZ oznaczenia strefy i jest juz czasem lokalnym —
  // doliczenie jej przesuniecia zrobiloby z 9:00 godzine 11:00.
  it('data bez strefy nie jest przesuwana', () => {
    const z = { metoda_wysylki: 'dpd', oplacone_at: '2026-07-30T09:00:00' };
    expect(ikonaPlatnosci(z).opis).toContain('2026-07-30 09:00:00');
  });

  // Opis MUSI istnieć i musi rozróżniać stany — sam kolor nie może nieść znaczenia
  // (brief zadania, punkt C).
  it('każdy stan ma własny, niepusty opis tekstowy', () => {
    const opisy = new Set([
      ikonaPlatnosci({ metoda_wysylki: 'dpd', pobranie: 1, oplacone_at: null }).opis,
      ikonaPlatnosci({ metoda_wysylki: 'dpd', oplacone_at: '2026-07-30' }).opis,
      ikonaPlatnosci({ metoda_wysylki: 'dpd', oplacone_at: null }).opis,
    ]);
    expect(opisy.size).toBe(3);
    for (const opis of opisy) expect(opis).toBeTruthy();
  });
});

describe('ikonaPrzesylki', () => {
  it('brak paczek → stan "brak", bez linku', () => {
    const ikona = ikonaPrzesylki({ id: 1, przesylki: [] });
    expect(ikona.stan).toBe('brak');
    expect(ikona.href).toBeNull();
  });

  // Sam wiersz w `przesylki` NIE wystarczy — DPD mogło jeszcze nie oddać numeru
  // (stan 'w_trakcie'/'zawieszona'). Liczy się KONKRETNIE `numer_listu`.
  it('paczka bez numeru listu liczy się jak brak', () => {
    const ikona = ikonaPrzesylki({ id: 1, przesylki: [{ numer_listu: null, kurier: 'dpd' }] });
    expect(ikona.stan).toBe('brak');
  });

  it('jedna paczka z numerem → stan "nadana", link ze WSPÓLNEJ funkcji linkDoSledzenia', () => {
    const ikona = ikonaPrzesylki({ id: 1, przesylki: [{ numer_listu: '1000000000001U', kurier: 'dpd' }] });
    expect(ikona.stan).toBe('nadana');
    expect(ikona.href).toBe('https://tracktrace.dpd.com.pl/parcelDetails?p1=1000000000001U');
  });

  // Kilka paczek naraz: nie da się wybrać "której" z poziomu listy — link ma prowadzić
  // do karty zamówienia, NIE do śledzenia pierwszej z brzegu.
  it('kilka paczek z numerem → link prowadzi do karty zamówienia, nie do śledzenia', () => {
    const ikona = ikonaPrzesylki({
      id: 42,
      przesylki: [
        { numer_listu: '1000000000001U', kurier: 'dpd' },
        { numer_listu: '1048069488027U', kurier: 'dpd' },
      ],
    });
    expect(ikona.stan).toBe('nadana');
    expect(ikona.href).toBe('/zamowienia/42');
  });

  // `zewnetrzny` rzadzi otwieraniem w nowej karcie (widok dokleja target=_blank). Reguly
  // pilnujemy TUTAJ, bo widok nie ma prawa zgadywac jej z ksztaltu adresu.
  it('śledzenie u kuriera jest ZEWNĘTRZNE — ma się otworzyć w nowej karcie', () => {
    const ikona = ikonaPrzesylki({ id: 1, przesylki: [{ numer_listu: '1000000000001U', kurier: 'dpd' }] });
    expect(ikona.zewnetrzny).toBe(true);
  });

  it('link do własnej karty zamówienia NIE jest zewnętrzny (kilka paczek)', () => {
    const ikona = ikonaPrzesylki({
      id: 42,
      przesylki: [
        { numer_listu: '1000000000001U', kurier: 'dpd' },
        { numer_listu: '1048069488027U', kurier: 'dpd' },
      ],
    });
    expect(ikona.zewnetrzny).toBe(false);
  });

  // Paczkomat ma od Zadania 9 wlasny wzorzec sledzenia, wiec ikona prowadzi na strone
  // InPostu — tak samo, jak przy DPD.
  it('paczkomat → link do śledzenia InPostu, w nowej karcie', () => {
    const ikona = ikonaPrzesylki({ id: 8, przesylki: [{ numer_listu: '520000123456789012345678', kurier: 'inpost' }] });
    expect(ikona.href).toBe('https://inpost.pl/sledzenie-przesylek?number=520000123456789012345678');
    expect(ikona.zewnetrzny).toBe(true);
  });

  // Kurier, dla ktorego nie znamy wzorca sledzenia (linkDoSledzenia oddaje null), spada
  // na karte zamowienia — i wtedy nowa karta byłaby błędem, mimo ze paczka jest jedna.
  // ⚠️ Przykladem byl tu 'inpost', dopoki nie dostal wlasnego wzorca (Zadanie 9). Regula
  // sie nie zmienila, zmienil sie kurier, na ktorym ja sprawdzamy.
  it('nieznany kurier → link do karty i BEZ nowej karty', () => {
    const ikona = ikonaPrzesylki({ id: 7, przesylki: [{ numer_listu: 'X1', kurier: 'gls' }] });
    expect(ikona.href).toBe('/zamowienia/7');
    expect(ikona.zewnetrzny).toBe(false);
  });

  // ⚠️⚠️ TU WIDAC, CO NAPRAWDE KOSZTUJE WZORZEC SLEDZENIA — i dlatego kurier 'allegro' go
  // NIE MA (recenzja Zadania 9). Bez wzorca ikona paczki z Allegro prowadzi do KARTY
  // ZAMOWIENIA: link, ktory na pewno dziala, w tej samej zakladce. Wzorzec — dopoki adres
  // nie jest zmierzony w przegladarce, a sciezka `moje-allegro/zakupy/…` jest po stronie
  // KUPUJACEGO, nie sprzedajacego — zamienilby go na adres niesprawdzony, otwierany w NOWEJ
  // zakladce, czyli na regres: operator traci pewny link i traci liste spod reki.
  // Dopisanie wzorca zaczerwieni ten test razem z bramka w tests/oms/tracking.test.js.
  it('paczka z Allegro → link do karty zamówienia, bez nowej karty (adres śledzenia niezmierzony)', () => {
    const ikona = ikonaPrzesylki({ id: 91, przesylki: [{ numer_listu: 'AD0LK57DLG0756H4H', kurier: 'allegro' }] });
    expect(ikona.stan).toBe('nadana');
    expect(ikona.href).toBe('/zamowienia/91');
    expect(ikona.zewnetrzny).toBe(false);
    // Numer listu ma byc dalej WIDOCZNY dla operatora — brak linku nie znaczy „brak paczki".
    expect(ikona.opis).toContain('AD0LK57DLG0756H4H');
  });
});

describe('ikonaChceFaktury', () => {
  it('sklep wnioskuje chęć faktury z NIP-u → stan "tak"', () => {
    expect(ikonaChceFaktury({ chce_fakture: 1, chce_fakture_reczne: null }).stan).toBe('tak');
  });

  it('brak chęci faktury ze sklepu → stan "nie"', () => {
    expect(ikonaChceFaktury({ chce_fakture: 0, chce_fakture_reczne: null }).stan).toBe('nie');
  });

  // ⚠️ Ręczny przełącznik MUSI wygrywać — to jest cała treść `chceFakture()`
  // (domain/dane-faktury.js) i ikona ma czytać DOKŁADNIE tę funkcję, nie kolumnę.
  it('ręczny przełącznik na "nie" wygrywa mimo chęci wynikającej z NIP-u sklepowego', () => {
    expect(ikonaChceFaktury({ chce_fakture: 1, chce_fakture_reczne: 0 }).stan).toBe('nie');
  });

  it('ręczny przełącznik na "tak" wygrywa mimo braku chęci ze sklepu', () => {
    expect(ikonaChceFaktury({ chce_fakture: 0, chce_fakture_reczne: 1 }).stan).toBe('tak');
  });
});

describe('ikonaFaktury', () => {
  it('brak rezerwacji → stan "brak"', () => {
    expect(ikonaFaktury({ faktura: null }).stan).toBe('brak');
  });

  it('faktura wystawiona → stan "wystawiona", numer w opisie', () => {
    const ikona = ikonaFaktury({ faktura: { ksef_status: 'sent', numer: 'FV/1/2026' } });
    expect(ikona.stan).toBe('wystawiona');
    expect(ikona.opis).toContain('FV/1/2026');
  });

  // Trzy stany pośrednie NIE mogą chować się pod "brak" — to sprawy wymagające człowieka,
  // dokładnie jak na liście roboczej (domain/status.js → doZrobienia).
  it('faktura "do_wyjasnienia" → stan i opis zawierający dosłownie "do wyjaśnienia"', () => {
    const ikona = ikonaFaktury({ faktura: { ksef_status: 'do_wyjasnienia' } });
    expect(ikona.stan).toBe('do_wyjasnienia');
    expect(ikona.opis).toMatch(/faktura do wyjaśnienia/i);
  });

  it('faktura "zawieszona" ma własny, odróżnialny opis', () => {
    const ikona = ikonaFaktury({ faktura: { ksef_status: 'w_toku', utworzona_at: '2000-01-01T00:00:00Z' } });
    expect(ikona.stan).toBe('zawieszona');
    expect(ikona.opis).toMatch(/zawieszona/i);
  });

  it('faktura "w_toku" (świeża rezerwacja) ma własny opis, różny od "wystawiona"', () => {
    const ikona = ikonaFaktury({ faktura: { ksef_status: 'w_toku', utworzona_at: new Date().toISOString() } });
    expect(ikona.stan).toBe('w_toku');
    expect(ikona.opis).not.toContain('wystawiona');
  });
});

// ⚠️ K1 (recenzja Partii 1 Planu B). Ślad po nieudanym odesłaniu statusu CAŁEGO zamówienia
// trzyma je od tej pory na liście roboczej (domain/status.js → doZrobienia), więc musi mieć
// na tej liście WIDOCZNY powód — inaczej zamówienie wraca i nie wiadomo po co. Odznakę liczy
// domena, tak samo jak sprawy przesyłki (sprawyZamowienia): widok niczego nie zgaduje.
//
// Brzmienie ma być TO SAMO, co na pasku karty (domain/sprawy-karty.js): „do Allegro" przy
// kanale, „do sklepu" przy sklepie. Odwrotnie wysyłałoby człowieka szukać usterki
// w WooCommerce, gdzie tego zamówienia po prostu NIE MA.
describe('odznakaSyncStatusu', () => {
  it('bez śladu nie ma odznaki', () => {
    expect(odznakaSyncStatusu({ sklep: 'szkicownia', sync_woo_blad: null })).toBeNull();
  });

  it('zamówienie sklepowe ze śladem mówi o sklepie', () => {
    expect(odznakaSyncStatusu({ sklep: 'szkicownia', sync_woo_blad: 'HTTP 503' }))
      .toBe('status nie dojechał do sklepu');
  });

  it('zamówienie z kanału mówi o Allegro, nie o sklepie', () => {
    const odznaka = odznakaSyncStatusu({ sklep: 'allegro_szkicownia', sync_woo_blad: 'HTTP 503' });
    expect(odznaka).toBe('status nie dojechał do Allegro');
    expect(odznaka).not.toMatch(/sklep/i);
  });
});
