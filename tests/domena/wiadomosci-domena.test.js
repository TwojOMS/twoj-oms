import { describe, it, expect } from 'vitest';
import { adresatKlienta } from '../../src/domena/adresat-klienta.js';
import { adresatPotwierdzenia } from '../../src/domena/potwierdzenie-zamowienia.js';
import {
  terminZamowienia, blokPlatnosci, stanPlatnosci, STAN_PLATNOSCI,
} from '../../src/domena/blok-platnosci.js';
import {
  TEMATY, NAZWA_TEMATU, czyWolnoWyslac, stanTematu, ostatnieWgTematow,
} from '../../src/domena/wiadomosci.js';

describe('adresat klienta', () => {
  // ⚠️ Adres zamawiającego to pole `klient.email` (Woo `billing`), NIE `dostawa.email` —
  // `dostawa` (Woo `shipping`) nie niesie e-maila w ogóle, więc `adresOdbiorcy()` (patrz
  // domain/adres-odbiorcy.js) i tak czyta go z `klient`. Ustalone na żywym kodzie po tym,
  // jak fikstura z e-mailem w `dostawa` dawała fałszywie czerwony test (22.08.2026).
  //
  // ⚠️ OBA ADRESY MUSZĄ SIĘ RÓŻNIĆ, inaczej test przechodzi niezależnie od kolejności
  // gałęzi w `adresatKlienta` i nie broni już niczego (fałszywa zieleń, znalezisko z
  // recenzji 22.08.2026). Bez ręcznego nadpisania `adresOdbiorcy(z).email` ZAWSZE równa się
  // `klient.email` (patrz adres-odbiorcy.js:87), więc jedyny sposób na dwa różne adresy w
  // tej funkcji to ręczna poprawka adresu wysyłki w `dostawa_reczna_json` — nie zwykłe pole
  // `dostawa.email`, którego żaden kod produkcyjny nie czyta. Nie „upraszczać" z powrotem do
  // jednego wspólnego adresu w obu blokach.
  it('bierze adres zamawiającego, nie ten z danych do faktury', () => {
    const z = {
      klient: { email: 'ksiegowosc@firma.pl' },
      dostawa_reczna_json: JSON.stringify({ email: 'jan@firma.pl' }),
    };
    expect(adresatKlienta(z)).toBe('jan@firma.pl');
  });

  it('bez adresu zamawiającego schodzi na dane do faktury', () => {
    const z = { klient: { email: null }, klient_reczny_json: JSON.stringify({ email: 'ksiegowosc@firma.pl' }) };
    expect(adresatKlienta(z)).toBe('ksiegowosc@firma.pl');
  });

  it('bez żadnego adresu oddaje null', () => {
    expect(adresatKlienta({ dostawa: {}, klient: {} })).toBeNull();
  });

  // ⚠️ Strażnik re-eksportu: gdyby `adresatPotwierdzenia` przestało być TĄ SAMĄ funkcją,
  // potwierdzenie i pozostałe trzy maile mogłyby pójść na różne adresy tego samego klienta.
  it('adresatPotwierdzenia to ta sama funkcja', () => {
    expect(adresatPotwierdzenia).toBe(adresatKlienta);
  });
});

const zam = (nad = {}) => ({
  numer: 'R/2026/015', utworzone_at: '2026-08-21T09:15:00', kwota_brutto: '990.00',
  metoda_wysylki: 'dpd', pobranie: 0, platnosci: [], pozycje: [
    { zrodlo_id: 1, nazwa: 'Szablon', ilosc: 10, cena_brutto: '99.00', brutto_linii: '990.00' },
  ],
  koszt_dostawy_brutto: '0.00', termin_platnosci: '14', ...nad,
});

describe('termin zamówienia', () => {
  it('liczba dni daje datę liczoną od złożenia', () => {
    expect(terminZamowienia(zam(), '2026-08-22')).toEqual({
      etykieta: 'termin 14 dni', data: '2026-09-04', minal: false,
    });
  });

  // ⚠️ Arytmetyka na NUMERZE DNIA (kalendarz.js), nigdy przez dodawanie milisekund —
  // ostatnia niedziela października ma w Warszawie 25 godzin.
  it('przechodzi przez koniec miesiąca', () => {
    expect(terminZamowienia(zam({ utworzone_at: '2026-10-25T10:00:00', termin_platnosci: '7' }), '2026-10-26').data)
      .toBe('2026-11-01');
  });

  it('rozpoznaje termin, który minął', () => {
    expect(terminZamowienia(zam(), '2026-09-05').minal).toBe(true);
    expect(terminZamowienia(zam(), '2026-09-04').minal).toBe(false);
  });

  it('warianty słowne nie mają daty', () => {
    expect(terminZamowienia(zam({ termin_platnosci: 'przy_odbiorze' }), '2026-08-22'))
      .toEqual({ etykieta: 'płatne przy odbiorze', data: null, minal: false });
    expect(terminZamowienia(zam({ termin_platnosci: 'bez_terminu' }), '2026-08-22').data).toBeNull();
  });

  it('brak ustaleń oddaje null', () => {
    expect(terminZamowienia(zam({ termin_platnosci: null }), '2026-08-22')).toBeNull();
  });

  // ⚠️⚠️ BŁĄD Z RECENZJI (22.08.2026): `String(dzis) > data` porównywało NAPISY, nie daty.
  // `String(null)` to „null", `String(new Date(...))` zaczyna się od dnia tygodnia
  // („Sat Aug…") — a każdy z tych napisów jest LEKSYKALNIE WIĘKSZY od jakiejkolwiek daty ISO
  // („RRRR-MM-DD"), bo zaczyna się literą, nie cyfrą. Efekt: KAŻDY mail fałszywie oskarżał
  // klienta o zwłokę, gdy `dzis` nie było gotowym napisem „RRRR-MM-DD".
  it('dzis niemożliwy do rozpoznania nigdy nie oskarża o zaległość', () => {
    expect(terminZamowienia(zam(), null).minal).toBe(false);
    expect(terminZamowienia(zam(), new Date('2026-09-10')).minal).toBe(false);
  });
});

describe('blok płatności', () => {
  const opcje = { rachunek: '07 1090 1014 0000 0000 0000 0001', odbiorca: 'Lumina Marek Zywiecki', tytul: 'PF/3/08/2026', dzis: '2026-08-22' };

  it('składa komplet danych do przelewu', () => {
    expect(blokPlatnosci(zam(), opcje)).toEqual({
      doZaplaty: '990,00 zł',
      odbiorca: 'Lumina Marek Zywiecki',
      rachunek: '07 1090 1014 0000 0000 0000 0001',
      tytul: 'PF/3/08/2026',
      termin: 'termin 14 dni — do 2026-09-04',
    });
  });

  // ⚠️⚠️ POZOSTAŁO, NIE SUMA ZAMÓWIENIA. Klient, który wpłacił połowę, ma zobaczyć drugą
  // połowę — mail żądający pełnej kwoty po wpłacie częściowej jest błędem o pieniądze.
  it('po wpłacie częściowej pokazuje resztę', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '400.00' }] });
    expect(blokPlatnosci(z, opcje).doZaplaty).toBe('590,00 zł');
  });

  it('zamówienie pokryte nie ma bloku wcale', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    expect(blokPlatnosci(z, opcje)).toBeNull();
  });

  // ⚠️ Pobranie: pieniądze inkasuje kurier, więc numer rachunku byłby zaproszeniem do
  // zapłacenia drugi raz.
  it('pobranie nie ma bloku przelewu', () => {
    expect(blokPlatnosci(zam({ pobranie: 1, kwota_pobrania: '990.00' }), opcje)).toBeNull();
  });

  it('termin, który minął, mówi to wprost', () => {
    expect(blokPlatnosci(zam(), { ...opcje, dzis: '2026-09-10' }).termin).toBe('termin minął 2026-09-04');
  });

  it('bez ustalonego terminu linii terminu nie ma', () => {
    expect(blokPlatnosci(zam({ termin_platnosci: null }), opcje).termin).toBeNull();
  });

  // ⚠️ Bez rachunku blok NIE POWSTAJE. Mail z pustym numerem konta wygląda na kompletny,
  // a klient nie ma gdzie zapłacić — lepiej odmówić wysyłki wyżej (domain/wiadomosci.js).
  it('bez rachunku oddaje null', () => {
    expect(blokPlatnosci(zam(), { ...opcje, rachunek: null })).toBeNull();
  });
});

// ⚠️⚠️ BŁĄD Z RECENZJI (22.08.2026): `blokPlatnosci` oddawał `null` z CZTERECH różnych
// powodów, a `wiadomosc-platnicza.js` czytał tylko `Boolean(platnosc)` — więc np. FAKTURA
// DO ZAMÓWIENIA ZA POBRANIEM mówiła klientowi „Zamówienie jest opłacone", zanim kurier
// cokolwiek zainkasował. `stanPlatnosci` nazywa wszystkie cztery powody z osobna, żeby blok
// przelewu i zdanie zamykające czytały JEDNĄ decyzję, a nie dwa niezależne przybliżenia.
describe('stan płatności', () => {
  const opcje = { rachunek: '07 1090 1014 0000 0000 0000 0001' };

  it('do_zaplaty: jest niedopłata i jest dokąd przelać', () => {
    expect(stanPlatnosci(zam(), opcje)).toBe(STAN_PLATNOSCI.DO_ZAPLATY);
  });

  it('pokryte: wpłaty domykają kwotę', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    expect(stanPlatnosci(z, opcje)).toBe(STAN_PLATNOSCI.POKRYTE);
  });

  // ⚠️ POBRANIE WYGRYWA Z BRAKIEM RACHUNKU (kolejność strażników z recenzji 22.08.2026):
  // pobranie to FAKT o zamówieniu (kurier inkasuje), brak rachunku to nasza usterka
  // konfiguracji — przy obu naraz klientowi należy się zdanie o kurierze, nie o configu.
  it('pobranie: wygrywa nawet bez skonfigurowanego rachunku', () => {
    const z = zam({ pobranie: 1, kwota_pobrania: '990.00' });
    expect(stanPlatnosci(z, { rachunek: null })).toBe(STAN_PLATNOSCI.POBRANIE);
  });

  it('brak_rachunku: jest niedopłata, ale nie ma dokąd przelać', () => {
    expect(stanPlatnosci(zam(), { rachunek: null })).toBe(STAN_PLATNOSCI.BRAK_RACHUNKU);
  });

  // ⚠️ POKRYTE WYGRYWA Z BRAKIEM RACHUNKU: gdy klient już zapłacił, to, czy mamy gdzieś
  // skonfigurowany numer konta, jest bez znaczenia — nikomu nic już nie przelewa.
  it('pokryte wygrywa nawet bez skonfigurowanego rachunku', () => {
    const z = zam({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    expect(stanPlatnosci(z, { rachunek: null })).toBe(STAN_PLATNOSCI.POKRYTE);
  });

  // ⚠️⚠️ CZWARTE, DOTĄD POŁKNIĘTE WYJŚCIE: `saldoWplat` ma gałąź `catch`, gdy wyceny pozycji
  // nie da się policzyć (platnosci.js:97-102) — `grosze()` wtedy rzuca. Wymuszamy ją POZYCJĄ
  // Z PUSTĄ CENĄ; żadnej arytmetyki tu nie liczymy, tylko wywołujemy prawdziwy kod.
  it('blad: saldoWplat nie umie policzyć wyceny pozycji', () => {
    const z = zam({
      pozycje: [{ zrodlo_id: 1, nazwa: 'Zepsuta pozycja', ilosc: 1, cena_brutto: '', brutto_linii: null }],
    });
    expect(stanPlatnosci(z, opcje)).toBe(STAN_PLATNOSCI.BLAD);
  });
});

// ⚠️ E-mail w `klient`, nie w `dostawa` — patrz uwaga przy fiksturze Zadania 4.
const pelne = (nad = {}) => zam({ klient: { email: 'sklep@betamet.pl' }, ...nad });
const kontekst = (nad = {}) => ({
  proforma: { id: 7, numer: 'PF/3/08/2026', kwota_brutto: '990.00', plik_sciezka: '/dane/pf.pdf' },
  faktura: { numer: '42/08/2026', infakt_uuid: 'abc-123' },
  dzis: '2026-08-22', ...nad,
});

describe('tematy wiadomości', () => {
  // PRZ-102.21: piąty temat „Zamówienie wysłane" (ręcznie z karty) — zmiana zachowania, było cztery.
  it('jest ich pięć, w kolejności pracy', () => {
    expect(TEMATY).toEqual(['potwierdzenie', 'proforma', 'faktura', 'przypomnienie', 'wyslane']);
    expect(NAZWA_TEMATU.przypomnienie).toBe('Przypomnienie o płatności');
    expect(NAZWA_TEMATU.wyslane).toBe('Zamówienie wysłane');
  });

  // ⚠️ ASERCJA NA `powod`, NIE TYLKO NA `wolno` (recenzja 22.08.2026): zamiana odmowy na
  // `{ wolno: false, powod: null }` zostawiałaby ten test zielonym, a operator dostałby
  // pusty wiersz zamiast wyjaśnienia — dokładnie to, przed czym ten moduł ma bronić
  // (niezmiennik 4.9).
  it('nieznany temat zawsze odmawia', () => {
    const wynik = czyWolnoWyslac(pelne(), 'cokolwiek', kontekst());
    expect(wynik.wolno).toBe(false);
    expect(wynik.powod).toContain('Nie ma takiego tematu');
  });

  // ⚠️ ANULOWANE GASI WSZYSTKIE CZTERY. Mail o zamówieniu, które właśnie anulowaliśmy,
  // jest gorszy niż brak maila.
  it('anulowane zamówienie gasi każdy temat', () => {
    for (const t of TEMATY) {
      const wynik = czyWolnoWyslac(pelne({ anulowane: 1 }), t, kontekst());
      expect(wynik.wolno, t).toBe(false);
      expect(wynik.powod, t).toContain('anulowane');
    }
  });

  // ⚠️ ASERCJA NA `powod` W PĘTLI (recenzja 22.08.2026) — ten sam powód co wyżej: samo
  // `wolno === false` przechodzi też dla odmowy z pustym powodem.
  it('bez adresu e-mail nie idzie nic', () => {
    for (const t of TEMATY) {
      const wynik = czyWolnoWyslac(zam({ klient: {} }), t, kontekst());
      expect(wynik.wolno, t).toBe(false);
      expect(wynik.powod, t).toContain('adresu e-mail');
    }
  });

  it('proforma wymaga wystawionej proformy z plikiem', () => {
    expect(czyWolnoWyslac(pelne(), 'proforma', kontekst()).wolno).toBe(true);
    expect(czyWolnoWyslac(pelne(), 'proforma', kontekst({ proforma: null })).powod)
      .toContain('Najpierw wystaw proformę');
    expect(czyWolnoWyslac(pelne(), 'proforma', kontekst({ proforma: { numer: 'PF/1', plik_sciezka: null } })).powod)
      .toContain('pliku');
  });

  // ⚠️ PROFORMA UNIEWAŻNIONA NIE MA PRAWA WYJŚĆ (recenzja 22.08.2026, proforma-stan.js:33-34):
  // klient dostałby dokument na STARĄ kwotę i przelałby według niej. `plik_sciezka` zostaje
  // ustawiona celowo — dowodzi, że blokuje WŁAŚNIE `uniewazniona_at`, nie brak pliku.
  it('proforma unieważniona nie idzie, mimo zapisanego pliku', () => {
    const wynik = czyWolnoWyslac(pelne(), 'proforma', kontekst({
      proforma: { numer: 'PF/1', plik_sciezka: '/dane/pf.pdf', uniewazniona_at: '2026-08-22T09:00:00Z' },
    }));
    expect(wynik.wolno).toBe(false);
    expect(wynik.powod).toContain('unieważniona');
  });

  it('faktura wymaga dokumentu w inFakcie', () => {
    expect(czyWolnoWyslac(pelne(), 'faktura', kontekst()).wolno).toBe(true);
    expect(czyWolnoWyslac(pelne(), 'faktura', kontekst({ faktura: null })).powod)
      .toContain('Najpierw wystaw fakturę');
    expect(czyWolnoWyslac(pelne(), 'faktura', kontekst({ faktura: { numer: '42/08/2026', infakt_uuid: null } })).powod)
      .toContain('do końca wystawiona');
    // ⚠️ NUMER WYMAGANY OBOK infakt_uuid (recenzja 22.08.2026, allegro-faktura.js:42 ma tę
    // samą regułę): bez niego `stanTematu` napisałby „bez numeru · PDF z inFaktu".
    expect(czyWolnoWyslac(pelne(), 'faktura', kontekst({ faktura: { numer: null, infakt_uuid: 'abc-123' } })).powod)
      .toContain('do końca wystawiona');
  });

  // ⚠️ Opłacone i pobranie gaszą PRZYPOMNIENIE, ale nie fakturę: fakturę do opłaconego
  // zamówienia wysyła się normalnie, tylko bez żądania pieniędzy.
  it('przypomnienie gaśnie przy opłaconym i przy pobraniu', () => {
    const oplacone = pelne({ platnosci: [{ data: '2026-08-22', kwota: '990.00' }] });
    expect(czyWolnoWyslac(oplacone, 'przypomnienie', kontekst()).powod).toContain('opłacone');
    expect(czyWolnoWyslac(oplacone, 'faktura', kontekst()).wolno).toBe(true);

    const pobranie = pelne({ pobranie: 1, kwota_pobrania: '990.00' });
    expect(czyWolnoWyslac(pobranie, 'przypomnienie', kontekst()).powod).toContain('kurier');
  });

  // ⚠️ TRZECIA DROGA BLOKADY PRZYPOMNIENIA (dopisane po recenzji, 22.08.2026): błąd wyceny
  // pozycji. `saldoWplat` ma gałąź `catch`, gdy wyceny pozycji nie da się policzyć — `grosze()`
  // wtedy rzuca. Bez tego strażnika przypomnienie żądałoby od klienta kwoty, której panel sam
  // nie umie policzyć. Wymuszamy ją POZYCJĄ Z PUSTĄ CENĄ, dokładnie jak test „blad" w bloku
  // „stan płatności" wyżej (platnosci.js:97-102) — żadnej arytmetyki tu nie liczymy, tylko
  // wywołujemy prawdziwy kod.
  it('przypomnienie gaśnie, gdy nie da się policzyć salda', () => {
    const zepsute = pelne({
      pozycje: [{ zrodlo_id: 1, nazwa: 'Zepsuta pozycja', ilosc: 1, cena_brutto: '', brutto_linii: null }],
    });
    const wynik = czyWolnoWyslac(zepsute, 'przypomnienie', kontekst());
    expect(wynik.wolno).toBe(false);
    expect(wynik.powod).toContain('Nie da się policzyć');
  });

  it('przypomnienie wolno wysłać także przed terminem', () => {
    expect(czyWolnoWyslac(pelne(), 'przypomnienie', kontekst({ dzis: '2026-08-22' })).wolno).toBe(true);
  });
});

describe('stan tematu', () => {
  // ⚠️ FIKSTURA W UTC („Z" na końcu), ASERCJA W CZASIE WARSZAWSKIM (recenzja 22.08.2026):
  // `wyslana_at` zapisujemy jako `new Date().toISOString()` w kontenerze z TZ=UTC, a karta
  // czyta wszystkie inne znaczniki przez `fmtDataCzas`/`fmtDataCzasKrotko`, czyli po
  // przeliczeniu na Europe/Warsaw. Sierpień to CEST (UTC+2), więc 12:40 UTC ma wyjść jako
  // 14:40 — asercja na „12:40" betonowałaby błąd (dwie godziny różnicy na tej samej karcie).
  it('mówi, kiedy poszło ostatnio', () => {
    const k = kontekst({ ostatnia: { wyslana_at: '2026-08-21T12:40:00.000Z' } });
    expect(stanTematu(pelne(), 'potwierdzenie', k)).toContain('2026-08-21 14:40');
  });

  it('proforma pokazuje numer i kwotę', () => {
    expect(stanTematu(pelne(), 'proforma', kontekst())).toContain('PF/3/08/2026');
    expect(stanTematu(pelne(), 'proforma', kontekst())).toContain('990,00 zł');
  });

  it('przypomnienie pokazuje termin', () => {
    expect(stanTematu(pelne(), 'przypomnienie', kontekst())).toContain('2026-09-04');
  });

  it('temat zablokowany pokazuje powód', () => {
    expect(stanTematu(pelne(), 'faktura', kontekst({ faktura: null }))).toContain('Najpierw wystaw fakturę');
  });

  // ⚠️ REZERWA `?? 'bez numeru'` USUNIĘTA (sprzątanie po recenzji całości gałęzi, 22.08.2026)
  // jako stan nieosiągalny. Ten test pilnuje POWODU, dla którego wolno ją było usunąć: faktura
  // bez numeru NIGDY nie dochodzi do zdania o stanie, bo wcześniej odmawia `czyWolnoWyslac`.
  // Gdyby ktoś zdjął tamten strażnik, zaczerwieni się tutaj — a nie u klienta w skrzynce.
  it('faktura bez numeru w ogóle nie dochodzi do zdania o stanie — odmawia wcześniej', () => {
    const k = kontekst({ faktura: { infakt_uuid: 'uuid-1', numer: null } });
    expect(czyWolnoWyslac(pelne(), 'faktura', k).wolno).toBe(false);
    expect(stanTematu(pelne(), 'faktura', k)).toContain('nie została do końca wystawiona');
    expect(stanTematu(pelne(), 'faktura', k)).not.toContain('bez numeru');
  });
});

// ⚠️⚠️ JEDYNY HAMULEC PRZED DRUGIM MAILEM DO KLIENTA liczy się z tej funkcji: pasek „Ta
// wiadomość poszła już…" i etykieta „Wyślij ponownie". Do 22.08.2026 odpowiadały na to pytanie
// DWA miejsca (zapytanie `ORDER BY id DESC` w trasie i `filter(…).pop()` w widoku), zgodne ze
// sobą WYŁĄCZNIE przy liście posortowanej rosnąco.
describe('ostatnie wiadomości według tematu', () => {
  const w = (id, temat_id, wyslana_at) => ({ id, temat_id, wyslana_at });

  it('bierze wiersz o NAJWIĘKSZYM id, nie ostatni element listy', () => {
    // Lista celowo posortowana MALEJĄCO — dokładnie ten układ, przy którym `.pop()`
    // wskazywało najstarszy wpis i cicho przestawiało ostrzeżenie na niewłaściwą datę.
    const lista = [
      w(3, 'przypomnienie', '2026-08-22T10:00:00.000Z'),
      w(1, 'przypomnienie', '2026-08-20T10:00:00.000Z'),
    ];
    expect(ostatnieWgTematow(lista).get('przypomnienie').wyslana_at).toBe('2026-08-22T10:00:00.000Z');
  });

  it('rozdziela tematy i milczy o tych, których nie było', () => {
    const mapa = ostatnieWgTematow([
      w(1, 'potwierdzenie', '2026-08-20T10:00:00.000Z'),
      w(2, 'proforma', '2026-08-21T10:00:00.000Z'),
    ]);
    expect(mapa.get('potwierdzenie').id).toBe(1);
    expect(mapa.get('proforma').id).toBe(2);
    expect(mapa.get('faktura')).toBeUndefined();
    expect(mapa.get('przypomnienie')).toBeUndefined();
  });

  // ⚠️ REZERWA ZA STARĄ KOLUMNĘ `potwierdzenie_wyslane_at` nie ma `id` (nie pochodzi
  // z rejestru). Ma przegrywać z każdym wierszem rejestru — rejestr jest nowszy i pełniejszy —
  // ale ma wygrywać z brakiem czegokolwiek, inaczej zamówienie potwierdzone przed powstaniem
  // rejestru traci ostrzeżenie przed drugim mailem.
  it('wiersz bez id przegrywa z rejestrem, ale wygrywa z pustką', () => {
    const rezerwa = { temat_id: 'potwierdzenie', wyslana_at: '2026-08-21T12:40:00.000Z' };
    expect(ostatnieWgTematow([rezerwa]).get('potwierdzenie')).toBe(rezerwa);
    expect(ostatnieWgTematow([rezerwa, w(7, 'potwierdzenie', '2026-08-22T08:00:00.000Z')])
      .get('potwierdzenie').id).toBe(7);
  });

  it('pusta lista i brak listy nie wywracają karty', () => {
    expect(ostatnieWgTematow([]).size).toBe(0);
    expect(ostatnieWgTematow(undefined).size).toBe(0);
  });
});
