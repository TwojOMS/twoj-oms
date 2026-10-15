import { describe, it, expect } from 'vitest';
import { sprawyKarty } from '../../src/domena/sprawy-karty.js';

// Pasek „Do załatwienia" na karcie zamówienia (przebudowa 2026-07-31). Zbiera w JEDNO
// miejsce sprawy dziś rozsypane po całej karcie. Reguła jest CZYSTA — testuje się bez bazy
// i bez HTTP; to jest ten plik. Że trasa jej używa, pilnuje tests/oms/web-karta.test.js.

const zamowienie = (nad = {}) => ({
  numer: '1276', kwota_brutto: '212.90', anulowane: 0,
  pozycje: [{ nazwa: 'STOP', ilosc: 1, cena_brutto: '193.90', brutto_linii: '193.90' }],
  koszt_dostawy_brutto: '19.00',
  platnosci: [{ kwota: '212.90', zrodlo: 'sklep' }],
  przesylki: [], faktura: null,
  ...nad,
});

const kluczeSpraw = (z) => sprawyKarty(z).map((s) => s.klucz);

describe('zamówienie bez problemów', () => {
  it('nie ma ani jednej sprawy', () => {
    expect(sprawyKarty(zamowienie())).toEqual([]);
  });

  // Karta renderuje pasek WYŁĄCZNIE gdy lista jest niepusta — pusty pasek „Do załatwienia — 0"
  // byłby dokładnie tym szumem, którego cała przebudowa ma się pozbyć.
  it('zamówienie zapłacone, wysłane i zafakturowane też jest czyste', () => {
    const z = zamowienie({
      przesylki: [{ kolejnosc: 1, status: 'nadana', numer_listu: 'X', etykieta_sciezka: '/e/1.pdf' }],
      faktura: { ksef_status: 'sent', numer: 'FV/1/2026' },
    });
    expect(sprawyKarty(z)).toEqual([]);
  });
});

describe('sprawy przesyłki', () => {
  it('brak etykiety przy nadanej paczce', () => {
    const z = zamowienie({ przesylki: [{ kolejnosc: 1, status: 'nadana', numer_listu: 'X' }] });
    expect(kluczeSpraw(z)).toContain('przesylka');
    expect(sprawyKarty(z)[0].tekst).toMatch(/brak etykiety/i);
  });

  it('niezsynchronizowany sklep', () => {
    const z = zamowienie({
      przesylki: [{ kolejnosc: 1, status: 'nadana', numer_listu: 'X', etykieta_sciezka: '/e/1.pdf', sync_woo_blad: 'sklep padł' }],
    });
    expect(sprawyKarty(z)[0].tekst).toMatch(/sklep niezsynchronizowany/i);
  });

  // ⚠️ Przy wielu paczkach sprawa MUSI mówić, której paczki dotyczy — inaczej operator
  // nie wie, który list przewozowy sprawdzić. Tę informację niesie już sprawyZamowienia.
  it('przy wielu paczkach sprawa niesie numer paczki', () => {
    const z = zamowienie({
      przesylki: [
        { kolejnosc: 1, status: 'nadana', numer_listu: 'A', etykieta_sciezka: '/e/1.pdf' },
        { kolejnosc: 2, status: 'nadana', numer_listu: 'B' },
      ],
    });
    expect(sprawyKarty(z)[0].tekst).toMatch(/paczka 2/i);
  });
});

describe('sprawy faktury', () => {
  it('faktura do wyjaśnienia jest BLOKADĄ', () => {
    const z = zamowienie({ faktura: { ksef_status: 'do_wyjasnienia', blad_opis: 'fetch failed' } });
    const s = sprawyKarty(z).find((w) => w.klucz === 'faktura');
    expect(s).toBeTruthy();
    expect(s.waga).toBe('blokada');
    expect(s.tekst).toMatch(/fetch failed/);
  });

  it('faktura zawieszona jest blokadą', () => {
    const z = zamowienie({ faktura: { ksef_status: 'w_toku', utworzona_at: '2020-01-01T00:00:00Z' } });
    expect(sprawyKarty(z).find((w) => w.klucz === 'faktura').waga).toBe('blokada');
  });

  it('faktura wystawiona nie jest żadną sprawą', () => {
    const z = zamowienie({ faktura: { ksef_status: 'sent', numer: 'FV/1/2026' } });
    expect(kluczeSpraw(z)).not.toContain('faktura');
  });
});

// ⚠️ „CZEKA NA KSEF" TO STAN, W KTORYM PANEL UTKNALBY NA ZAWSZE (niezmiennik 4.9). Dokument,
// ktorego wlasciciel nigdy nie wysle (pomylka, korekta, urlop), zostawia kupujacego bez faktury,
// a panel milczy — bo z jego punktu widzenia „wszystko czeka". Doba, bo wlasciciel wysyla do
// KSeF w ciagu dnia: 24 h mijaja dopiero wtedy, gdy cos naprawde stanelo.
describe('faktura czekająca na KSeF (Allegro)', () => {
  const GODZINA = 60 * 60 * 1000;
  const WYSTAWIONA = '2026-08-05T10:00:00Z';
  const TERAZ = Date.parse(WYSTAWIONA);

  // ⚠️ `ksef_odczyt: 'ok'` W DOMYSLNEJ FAKTURZE, bo to jest stan, w ktorym sprawa MA prawo sie
  // odezwac: czuwacz zapytal, inFakt ODPOWIEDZIAL, a numeru KSeF tam nie ma. Bez tego dowodu
  // brak numeru nie znaczy nic — patrz testy nizej.
  const allegro = (faktura = {}, nad = {}) => zamowienie({
    sklep: 'allegro_szkicownia',
    chce_fakture: 1,
    faktura: {
      ksef_status: null, numer: 'FV/12/2026', infakt_uuid: 'u1', utworzona_at: WYSTAWIONA,
      ksef_odczyt: 'ok', ...faktura,
    },
    ...nad,
  });

  const klucze = (z, teraz) => sprawyKarty(z, teraz).map((s) => s.klucz);

  it('po dobie bez numeru KSeF jest BLOKADĄ', () => {
    const s = sprawyKarty(allegro(), TERAZ + 25 * GODZINA).find((w) => w.klucz === 'ksef');
    expect(s).toBeTruthy();
    expect(s.waga).toBe('blokada');
    expect(s.tekst).toMatch(/FV\/12\/2026/);
    expect(s.tekst).toMatch(/KSeF/);
    expect(s.kotwica).toBe('#faktura');
  });

  // ⚠️⚠️ SPRAWA MA WSKAZYWAC WYJSCIE, KTORE ISTNIEJE DZISIAJ (recenzja Partii 2, K4).
  //
  // Do 06.08.2026 stalo tu ODWROTNE oczekiwanie — „nie obiecuje przycisku, ktorego w panelu
  // jeszcze nie ma" — i bylo SLUSZNE: wzmianka o wysylce bez numeru KSeF wysylala czlowieka
  // szukac przycisku, ktorego nie bylo, wiec niezmiennik 4.9 byl spelniony wylacznie napisem.
  // Zadanie 11 ten przycisk DOLOZYLO (trasa POST /zamowienia/:id/faktura-allegro-bez-ksef
  // i furtka na karcie), wiec asercja musiala ustapic: teraz milczenie o drugim wyjsciu jest
  // tym samym bledem, tylko odwroconym — sprawa pokazywalaby jedno wyjscie z dwoch istniejacych.
  //
  // Oba wyjscia sa PRAWDZIWE i oba wymagaja czlowieka: wyslac dokument do KSeF w inFakcie
  // ALBO swiadomie wyslac go kupujacemu bez tego numeru.
  it('wskazuje OBA wyjścia, które w panelu naprawdę są', () => {
    const s = sprawyKarty(allegro(), TERAZ + 25 * GODZINA).find((w) => w.klucz === 'ksef');
    expect(s.tekst).toMatch(/do KSeF w inFakcie/);
    expect(s.tekst).toMatch(/bez numeru KSeF/i);
    expect(s.tekst).toMatch(/Allegro/);
  });

  // Wariant „inFakt tego dokumentu juz nie zna" ma ZOSTAC osobny: tam numeru KSeF nikt juz
  // nie przyniesie, a wysylka do Allegro nie jest zadnym wyjsciem — dokumentu nie ma skad wziac
  // (panel nie trzyma kopii PDF-u). Jedynym wyjsciem jest „odnotuj skasowanie".
  it('przy dokumencie nieznanym inFaktowi NIE proponuje wysyłki bez numeru KSeF', () => {
    const s = sprawyKarty(allegro({ ksef_odczyt: 'nieznana' }), TERAZ + 25 * GODZINA)
      .find((w) => w.klucz === 'ksef');
    expect(s.tekst).not.toMatch(/bez numeru KSeF/i);
    // ⚠️ WSKAZANIE PRZENIESIONE NA ZAKLADKE FAKTURY (01.09.2026) — patrz test nizej.
    expect(s.tekst).toMatch(/zakładce Faktury/);
  });

  // Czuwacz WIE, ze dostal 404 — inFakt tego dokumentu nie zna, bo ktos go tam skasowal.
  // Ta wiedza ma zmieniac tresc sprawy, zamiast ladowac wylacznie w logu: wyjsciem jest
  // akcja, ktora ISTNIEJE.
  //
  // ⚠️⚠️ OD 01.09.2026 TA AKCJA STOI NA ZAKLADCE FAKTURY, nie na karcie (prosba właściciela:
  // „na co dzien jest to nieuzywane"). Sprawa odsylajaca do przycisku, ktorego na karcie
  // juz nie ma, byla by gorsza niz brak sprawy — dlatego tekst jest tu ASERCJA, a nie
  // szczegolem: to on jest jedyna instrukcja, jaka operator dostaje.
  it('gdy inFakt dokumentu NIE ZNA, sprawa wskazuje istniejącą akcję — w zakładce Faktury', () => {
    const s = sprawyKarty(allegro({ ksef_odczyt: 'nieznana' }), TERAZ + 25 * GODZINA)
      .find((w) => w.klucz === 'ksef');
    expect(s.waga).toBe('blokada');
    expect(s.tekst).toMatch(/FV\/12\/2026/);
    expect(s.tekst).toMatch(/inFakcie/);
    expect(s.tekst).toMatch(/zakładce Faktury/);
    expect(s.tekst).toMatch(/Faktura skasowana\s+w inFakcie/);
    // Stare wskazanie „na karcie" ma zniknac razem z przyciskiem.
    expect(s.tekst).not.toMatch(/na karcie/);
  });

  // Doba jest progiem „cos stanelo" przy dokumencie, ktory inFakt ZNA. Przy dokumencie,
  // ktorego juz tam nie ma, nie ma na co czekac — zamowienie jest zablokowane od razu.
  it('brak dokumentu w inFakcie jest sprawą OD RAZU, bez czekania doby', () => {
    const k = klucze(allegro({ ksef_odczyt: 'nieznana' }), TERAZ + GODZINA);
    expect(k).toContain('ksef');
  });

  it('przed upływem doby nie jest jeszcze sprawą', () => {
    expect(klucze(allegro(), TERAZ + 23 * GODZINA)).not.toContain('ksef');
  });

  it('faktura z numerem KSeF nie jest sprawą', () => {
    expect(klucze(allegro({ ksef_numer: 'KS-1' }), TERAZ + 25 * GODZINA)).not.toContain('ksef');
  });

  // Wyslanie bez numeru KSeF jest SWIADOMA decyzja czlowieka (Zadanie 11) — po niej kupujacy
  // fakture MA, wiec pasek nie ma o co wolac.
  it('faktura już wysłana do Allegro nie jest sprawą', () => {
    expect(klucze(allegro({ allegro_wyslana_at: '2026-08-05T12:00:00Z' }), TERAZ + 25 * GODZINA))
      .not.toContain('ksef');
  });

  // ⚠️ ZAKRES TEN SAM, CO W CZUWACZU. Faktura ze sklepu, ktorej NIKT nie wyslal z panelu, nie ma
  // dokad pojechac i numeru KSeF nie dostanie nigdy — wiec jego brak nie jest przy niej zadna
  // sprawa. Inaczej pasek meldowalby blokade przy KAZDEJ fakturze sklepowej starszej niz doba,
  // czyli przy wszystkich.
  it('faktura ze sklepu nie jest sprawą, choćby czekała miesiąc', () => {
    const z = allegro({}, { sklep: 'szkicownia' });
    expect(klucze(z, TERAZ + 30 * 24 * GODZINA)).not.toContain('ksef');
  });

  // ⚠️⚠️ ZAKRES POSZERZONY 06.08.2026 (Zadanie 11): dokument, ktorego wysylke do KSeF ZLECIL
  // PANEL, czeka na numer tak samo — takze ze sklepu. `ksef_zlecona_at` to kolumna `zlecona_at`
  // z `wysylki_ksef`, dokladana przy odczycie zamowienia.
  describe('faktura SKLEPOWA, ktorej wysylke do KSeF zlecil panel', () => {
    const sklepowa = (nad = {}) => allegro({ ksef_zlecona_at: '2026-08-05T10:05:00Z', ...nad }, { sklep: 'szkicownia' });

    it('po dobie bez numeru KSeF jest BLOKADĄ', () => {
      const s = sprawyKarty(sklepowa(), TERAZ + 25 * GODZINA).find((w) => w.klucz === 'ksef');
      expect(s).toBeTruthy();
      expect(s.waga).toBe('blokada');
      expect(s.tekst).toMatch(/FV\/12\/2026/);
    });

    // ⚠️⚠️ TRESC MUSI BYC INNA NIZ PRZY ALLEGRO. Przycisku „Wyślij do Allegro BEZ numeru KSeF"
    // na tej karcie NIE MA, a kupujacy na fakture sklepowa u siebie nie czeka — sprawa
    // wskazujaca wyjscie, ktorego nie ma, jest stanem bez wyjscia (niezmiennik 4.9).
    it('NIE proponuje wysyłki do Allegro — tego przycisku tu nie ma', () => {
      const s = sprawyKarty(sklepowa(), TERAZ + 25 * GODZINA).find((w) => w.klucz === 'ksef');
      expect(s.tekst).not.toMatch(/Allegro/);
      expect(s.tekst).toMatch(/inFakcie/);
      // Panel NIGDY nie ponawia zgloszenia sam — duplikatu u organu nie da sie skasowac.
      expect(s.tekst).toMatch(/NIE ponowi/);
    });

    // ⚠️⚠️ ZDANIE MOWI O WYSYLCE, WIEC LICZY CZAS OD WYSYLKI. Do poprawki stala tu data
    // WYSTAWIENIA dokumentu — a przy zakladce miesiecznej wlasciciel wysyla faktury z zeszlego
    // miesiaca, wiec „numeru nie ma od …" zawyzalo czekanie o TYGODNIE i wskazywalo moment,
    // w ktorym panel jeszcze niczego nie zlecil.
    it('podaje moment ZLECENIA wysyłki, a nie datę wystawienia faktury', () => {
      const z = sklepowa({ utworzona_at: '2026-07-01T08:00:00Z', ksef_zlecona_at: '2026-08-05T10:05:00Z' });
      const s = sprawyKarty(z, TERAZ + 25 * GODZINA).find((w) => w.klucz === 'ksef');
      expect(s.tekst).toMatch(/2026-08-05T10:05:00Z/);
      expect(s.tekst).not.toMatch(/2026-07-01T08:00:00Z/);
    });

    // ⚠️⚠️ DOBA LICZY SIE OD WYSYLKI, A NIE OD WYSTAWIENIA DOKUMENTU (recenzja calosci,
    // Finding 2) — i sam tekst sprawy tego NIE PILNOWAL: test wyzej przechodzil takze wtedy,
    // gdy prog mierzyl czas od `utworzona_at`, bo sprawdzal wylacznie brzmienie zdania.
    //
    // AWARIA, KTORA TO ZAMYKA: zakladka „FAKTURY" jest MIESIECZNA, wiec wysylanie dokumentow
    // z zeszlego miesiaca to zwykly tryb pracy. Faktura wystawiona 1 lipca, wyslana 5 sierpnia
    // o 10:05, dostawala CZERWONA BLOKADE („zgloszenie utknelo albo organ je odrzucil") juz
    // przy pierwszym tyknieciu czuwacza — dwie minuty po najzupelniej normalnej wysylce,
    // i tak przy WIEKSZOSCI wysylek. To ta sama asymetria, ktora dla podlogi czuwacza zamknal
    // commit e690379; prog doby zostal wtedy nietkniety.
    it('miesiąc po wystawieniu, dwie minuty po wysyłce — NIE ma blokady', () => {
      const zlecona = '2026-08-05T10:05:00Z';
      const z = sklepowa({ utworzona_at: '2026-07-01T08:00:00Z', ksef_zlecona_at: zlecona });
      expect(klucze(z, Date.parse(zlecona) + 2 * 60 * 1000)).not.toContain('ksef');
    });

    it('25 h po wysyłce, wciąż bez numeru — blokada JEST', () => {
      const zlecona = '2026-08-05T10:05:00Z';
      const z = sklepowa({ utworzona_at: '2026-07-01T08:00:00Z', ksef_zlecona_at: zlecona });
      expect(klucze(z, Date.parse(zlecona) + 25 * GODZINA)).toContain('ksef');
    });

    it('przed upływem doby nie jest jeszcze sprawą', () => {
      expect(klucze(sklepowa(), TERAZ + 23 * GODZINA)).not.toContain('ksef');
      // ⚠️ TAKZE PRZY STARYM DOKUMENCIE: 23 h po WYSYLCE to wciaz nie doba, choc od
      // wystawienia minal miesiac.
      const zlecona = '2026-08-05T10:05:00Z';
      const stary = sklepowa({ utworzona_at: '2026-07-01T08:00:00Z', ksef_zlecona_at: zlecona });
      expect(klucze(stary, Date.parse(zlecona) + 23 * GODZINA)).not.toContain('ksef');
    });

    it('gdy numer KSeF przyszedł, sprawy nie ma', () => {
      expect(klucze(sklepowa({ ksef_numer: 'KS-1' }), TERAZ + 25 * GODZINA)).not.toContain('ksef');
    });
  });

  it('zamówienie, przy którym kupujący faktury nie chciał, nie jest sprawą', () => {
    expect(klucze(allegro({}, { chce_fakture: 0 }), TERAZ + 25 * GODZINA)).not.toContain('ksef');
  });

  // Rezerwacja 'w_toku' ma juz swoja wlasna sprawe ('zawieszona') — druga, o KSeF, mowilaby
  // o dokumencie, ktory jeszcze nie istnieje.
  it('rezerwacja bez dokumentu nie jest sprawą KSeF', () => {
    const z = allegro({ ksef_status: 'w_toku', numer: null });
    expect(klucze(z, TERAZ + 25 * GODZINA)).not.toContain('ksef');
  });

  // ⚠️⚠️ RECENZJA PARTII 2, K1: SPRAWA MOWI O TYM, CZEGO PANEL NIE WIE, ALBO NIE MOWI NIC.
  //
  // „Czeka na KSeF" znaczy: PYTALISMY inFakt, inFakt ODPOWIEDZIAL, numeru KSeF tam nie ma.
  // Sam uplyw doby od wystawienia nie jest zadnym dowodem — przy zdechlym czuwaczu (albo
  // niedostepnym inFakcie) KAZDA allegrowa faktura starsza niz doba zapalalaby BLOKADE
  // „wyslij dokument do KSeF" wlascicielowi, ktory juz go wyslal. To ta sama klasa usterki,
  // ktora Partia 1 zamknela commitem 1cf1554: uzasadnienie kolumny nieprawda.
  it('czuwacz NIGDY nie pytał → nie ma sprawy, choćby minęła doba', () => {
    expect(klucze(allegro({ ksef_odczyt: null, ksef_sprawdzona_at: null }), TERAZ + 25 * GODZINA))
      .not.toContain('ksef');
  });

  it('czuwacz pytał, ale odczyt padł → nie ma sprawy (inFakt milczy, nie właściciel)', () => {
    expect(klucze(allegro({ ksef_odczyt: 'blad' }), TERAZ + 25 * GODZINA)).not.toContain('ksef');
  });

  // ⚠️ W4. inFakt potrafi oddac sukces BEZ pola `number` — wiersz jest wtedy „wystawiony",
  // ale czuwacz o niego NIGDY nie zapyta (wymaga numeru i UUID-a). Pasek pokazywal przy nim
  // blokade z PUSTYM numerem: „Faktura  czeka na KSeF od …".
  it('faktura BEZ numeru dokumentu nie jest sprawą — czuwacz o nią nie zapyta', () => {
    expect(klucze(allegro({ numer: null }), TERAZ + 25 * GODZINA)).not.toContain('ksef');
  });

  it('faktura bez UUID-a w inFakcie nie jest sprawą — nie ma o co zapytać', () => {
    expect(klucze(allegro({ infakt_uuid: null }), TERAZ + 25 * GODZINA)).not.toContain('ksef');
  });

  // ⚠️ W5. Anulowane zamowienie dostawalo po dobie DWIE blokady: poprawna („anulowane po
  // wystawieniu faktury") i falszywa („kupujacy jej jeszcze nie ma", choc nic nie kupil).
  it('zamówienie anulowane ma TYLKO swoją blokadę, bez fałszywej o KSeF', () => {
    const k = klucze(allegro({}, { anulowane: 1 }), TERAZ + 25 * GODZINA);
    expect(k).toContain('anulowane');
    expect(k).not.toContain('ksef');
  });
});

describe('sprawy płatności', () => {
  it('niedopłata', () => {
    const z = zamowienie({ platnosci: [{ kwota: '100.00', zrodlo: 'sklep' }] });
    const s = sprawyKarty(z).find((w) => w.klucz === 'platnosci');
    expect(s.tekst).toMatch(/niedopłata/i);
    expect(s.tekst).toContain('112.90');
  });

  // ⚠️ Nadpłata to pieniądze KLIENTA, które trzeba mu oddać albo rozliczyć — panel jest
  // jedynym miejscem, gdzie ktokolwiek to zobaczy. Pominięcie jej tutaj byłoby cichym
  // schowaniem cudzych pieniędzy.
  it('nadpłata też jest sprawą', () => {
    const z = zamowienie({ platnosci: [{ kwota: '300.00', zrodlo: 'sklep' }] });
    expect(sprawyKarty(z).find((w) => w.klucz === 'platnosci').tekst).toMatch(/nadpłata/i);
  });

  it('kwota pokryta co do grosza nie jest sprawą', () => {
    expect(kluczeSpraw(zamowienie())).not.toContain('platnosci');
  });
});

describe('suma pozycji', () => {
  // Bariera arytmetyczna faktury odmówi z dokładnie tego samego powodu — operator ma to
  // zobaczyć ZANIM kliknie „Wystaw fakturę", a nie w odmowie bez wyjaśnienia.
  it('suma pozycji niezgodna z kwotą oczekiwaną', () => {
    const z = zamowienie({ kwota_brutto: '999.00' });
    const s = sprawyKarty(z).find((w) => w.klucz === 'pozycje');
    expect(s).toBeTruthy();
    expect(s.tekst).toMatch(/nie zgadza/i);
  });
});

describe('anulowanie wymagające uwagi', () => {
  it('anulowane po nadaniu paczki', () => {
    const z = zamowienie({
      anulowane: 1,
      przesylki: [{ kolejnosc: 1, status: 'nadana', numer_listu: 'X', etykieta_sciezka: '/e/1.pdf' }],
    });
    const s = sprawyKarty(z).find((w) => w.klucz === 'anulowane');
    expect(s.waga).toBe('blokada');
    expect(s.tekst).toMatch(/anulowane/i);
  });

  it('anulowane bez paczki i bez faktury nie jest sprawą', () => {
    expect(kluczeSpraw(zamowienie({ anulowane: 1 }))).not.toContain('anulowane');
  });

  // ⚠️ Treści tej sprawy NIC nie pilnowało do 13.09.2026 — dotychczasowy test sprawdzał
  // wyłącznie wagę i to, że tekst zawiera słowo „anulowane". Stąd dwie asercje wprost:
  // jedna na treść, druga na kotwicę, bo to one prowadzą operatora do właściwej sekcji.
  it('anulowane po nadaniu paczki mówi o PACZCE i kotwiczy w przesyłce', () => {
    const s = sprawyKarty(zamowienie({
      anulowane: 1,
      przesylki: [{ kolejnosc: 1, status: 'nadana', numer_listu: 'X', etykieta_sciezka: '/e/1.pdf' }],
    })).find((w) => w.klucz === 'anulowane');
    expect(s.tekst).toContain('nadaniu paczki');
    expect(s.kotwica).toBe('#przesylka');
  });

  it('anulowane po wystawieniu faktury, bez paczki, mówi o FAKTURZE i kotwiczy w fakturze', () => {
    const s = sprawyKarty(zamowienie({
      anulowane: 1, faktura: { ksef_status: 'sent', numer: 'FV/1/2026' },
    })).find((w) => w.klucz === 'anulowane');
    expect(s.tekst).toContain('wystawieniu faktury');
    expect(s.kotwica).toBe('#faktura');
  });

  // ⚠️⚠️ WADA WAŻNA Z RECENZJI 13.09.2026: `anulowaneWymagaUwagi` liczy już tylko paczki
  // NIEUKRYTE (`przesylkaUkryta`), a ten wybór treści został na gołej liczbie wierszy
  // przesyłek. Zamówienie anulowane z JEDYNĄ paczką UKRYTĄ i wiszącą fakturą słusznie
  // zostaje sprawą — ale z powodu FAKTURY. Karta pisała mimo to „anulowane po nadaniu
  // paczki" i kotwiczyła w `#przesylka`: operator trafiał w jedyną rzecz, którą człowiek
  // już zamknął, i mógł nie dojść do dokumentu wymagającego korekty w KSeF.
  it('ukryta paczka nie decyduje o treści — sprawa mówi o fakturze', () => {
    const s = sprawyKarty(zamowienie({
      anulowane: 1,
      przesylki: [{
        kolejnosc: 1, status: 'nadana', numer_listu: '1048123722945U',
        etykieta_sciezka: '/e/1.pdf', ukryta_at: '2026-08-25T10:00:00Z', ukryta_przez: 'adam',
      }],
      faktura: { ksef_status: 'sent', numer: 'FV/1/2026' },
    })).find((w) => w.klucz === 'anulowane');
    expect(s.tekst).toContain('wystawieniu faktury');
    expect(s.tekst).not.toContain('nadaniu paczki');
    expect(s.kotwica).toBe('#faktura');
  });

  // ⚠️ UKRYCIE WYGASA, gdy u kuriera wydarzy się coś PO nim — paczka spisana na straty,
  // która ruszyła, znów jest sprawą. Dlatego predykatem jest `przesylkaUkryta`, a nie goła
  // kolumna `ukryta_at`: reguła po kolumnie uciszyłaby tu paczkę ŻYWĄ i karta znów mówiłaby
  // o czymś innym, niż liczy `anulowaneWymagaUwagi`.
  it('paczka, która ruszyła PO ukryciu, znów decyduje o treści', () => {
    const s = sprawyKarty(zamowienie({
      anulowane: 1,
      przesylki: [{
        kolejnosc: 1, status: 'nadana', numer_listu: '1048123722945U',
        etykieta_sciezka: '/e/1.pdf', ukryta_at: '2026-08-25T10:00:00Z',
        status_kuriera_at: '2026-08-26T08:00:00Z',
      }],
      faktura: { ksef_status: 'sent', numer: 'FV/1/2026' },
    })).find((w) => w.klucz === 'anulowane');
    expect(s.tekst).toContain('nadaniu paczki');
    expect(s.kotwica).toBe('#przesylka');
  });
});

describe('kształt listy', () => {
  it('każda sprawa ma wagę, tekst i kotwicę do sekcji', () => {
    const z = zamowienie({
      faktura: { ksef_status: 'do_wyjasnienia', blad_opis: 'fetch failed' },
      platnosci: [],
    });
    for (const s of sprawyKarty(z)) {
      expect(['blokada', 'uwaga']).toContain(s.waga);
      expect(typeof s.tekst).toBe('string');
      expect(s.tekst.length).toBeGreaterThan(0);
      expect(s.kotwica).toMatch(/^#/);
    }
  });

  // ⚠️ Mutacja: oddanie listy w kolejności DODAWANIA ma zaczerwienić TEN test — i dlatego
  // fikstura jest dobrana tak, że sprawy powstają w kolejności ODWROTNEJ do docelowej:
  // niedopłata (uwaga) liczy się PRZED sumą pozycji (blokada), bo tak stoją sekcje na karcie.
  // Bez sortowania po wadze pierwsza w pasku byłaby uwaga, a blokada pod nią.
  it('blokady stoją przed uwagami, nawet gdy uwaga powstaje pierwsza', () => {
    const z = zamowienie({
      kwota_brutto: '999.00', // suma pozycji się nie zgadza → BLOKADA (liczona jako ostatnia)
      platnosci: [{ kwota: '10.00', zrodlo: 'sklep' }], // niedopłata → UWAGA (liczona wcześniej)
    });
    const sprawy = sprawyKarty(z);
    expect(sprawy.map((s) => s.klucz)).toEqual(['pozycje', 'platnosci']);
    expect(sprawy[0].waga).toBe('blokada');
    expect(sprawy.at(-1).waga).toBe('uwaga');
  });

  it('uszkodzone zamówienie nie wywala paska', () => {
    expect(() => sprawyKarty(null)).not.toThrow();
    expect(sprawyKarty(null)).toEqual([]);
    expect(() => sprawyKarty({})).not.toThrow();
  });
});
