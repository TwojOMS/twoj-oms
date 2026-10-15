import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, listaZamowien } from '../../src/oms/db/zamowienia.js';
import { createAllegroClient, LIMIT_ZAPYTANIA_OFERTY_MS } from '../../src/oms/allegro/client.js';
import { zdjecieOferty, zdjeciePozycji, adresMiniatury } from '../../src/domena/miniatury.js';
import {
  ofertyDoSprawdzenia, zapiszProbeZdjecia, zdjecieOfertyZBazy, PONOWIENIE_PO_MS,
} from '../../src/oms/db/zdjecia-ofert.js';
import {
  createZdjeciaAllegro, zPobieraniemZdjec, LIMIT_OFERT_NA_PRZEBIEG,
} from '../../src/moduly/kanaly/services/zdjecia-allegro.js';
import { createPoller } from '../../src/moduly/kanaly/services/poller.js';
import { wierszePozycji } from '../../src/domena/tabela-pozycji.js';

// MINIATURY PRODUKTÓW PRZY POZYCJACH Z ALLEGRO.
//
// ⚠️ ANI JEDEN TEST W TYM PLIKU NIE WYCHODZI DO PRAWDZIWEGO ALLEGRO. Klient dostaje
// `fetchImpl` z wstrzyknięcia, a usługa — klienta z `vi.fn()`. Adres API (`https://api.test`)
// jest jawnie fikcyjny; gdyby którekolwiek wywołanie poszło naprawdę, test padłby na DNS-ie,
// a nie przeszedł po cichu.
//
// Zmierzone na żywym koncie 05.08.2026 (i tylko wtedy):
//   * formularz zakupowy zdjęcia NIE NIESIE — `lineItems[].offer` to
//     `{ id, name, external, productSet, hsNumber }`;
//   * `GET /sale/product-offers/{offerId}` → 200, pole `images` to tablica ADRESÓW;
//   * `GET /sale/offers/{offerId}` → 403 „This resource is no longer supported" (WYCOFANE);
//   * wariant rozmiaru siedzi w ŚCIEŻCE: `original` = `s720` → 66 KB, `s150` → 7,9 KB.

const __dir = dirname(fileURLToPath(import.meta.url));
const zrodlo = (...czesci) => readFileSync(join(__dir, '..', '..', 'src', 'oms', ...czesci), 'utf8');

const ORYGINAL = 'https://9.allegroimg.com/original/03e7d6/772bd11044a79ce6967b62cfa489';
const MINIATURA = 'https://9.allegroimg.com/s150/03e7d6/772bd11044a79ce6967b62cfa489';

// ---------------------------------------------------------------------------------
// 1. DOMENA — co zapisujemy i co pokazujemy
// ---------------------------------------------------------------------------------

describe('zdjecieOferty — co zapisujemy z odpowiedzi Allegro', () => {
  it('bierze PIERWSZY adres z `images` (zdjęcie główne)', () => {
    expect(zdjecieOferty({ images: [ORYGINAL, 'https://2.allegroimg.com/original/aa/bb'] }))
      .toBe(ORYGINAL);
  });

  // Oferta bez zdjęcia to stan NORMALNY, a nie awaria — pozycja pokazuje wtedy samą nazwę.
  it('oferta bez zdjęć daje null, nie pusty napis', () => {
    expect(zdjecieOferty({ images: [] })).toBe(null);
    expect(zdjecieOferty({})).toBe(null);
    expect(zdjecieOferty(null)).toBe(null);
  });

  // ⚠️ Kształt inny niż zmierzony (obiekty zamiast napisów, `images` jako obiekt) czytamy
  // jako „brak zdjęcia", a NIE rzucamy — inaczej jedna zmiana po stronie Allegro zabijałaby
  // uzupełnianie dla wszystkich ofert naraz.
  it('kształt inny niż zmierzony czyta się jako brak zdjęcia, a nie jako błąd', () => {
    expect(zdjecieOferty({ images: [{ url: ORYGINAL }] })).toBe(null);
    expect(zdjecieOferty({ images: ORYGINAL })).toBe(null);
    expect(zdjecieOferty({ images: ['   '] })).toBe(null);
  });

  // Adres ląduje wprost w atrybucie `src` naszego HTML-a — ten sam warunek, co przy sklepie.
  it('przepuszcza wyłącznie http(s)', () => {
    expect(zdjecieOferty({ images: ['javascript:alert(1)'] })).toBe(null);
    expect(zdjecieOferty({ images: ['//9.allegroimg.com/original/aa/bb'] })).toBe(null);
  });
});

describe('adresMiniatury — wariant s150 wyprowadzany ze ścieżki Allegro', () => {
  // ⚠️ TO JEST SEDNO NIEZMIENNIKA 4.13c PO STRONIE ALLEGRO: w bazie leży ORYGINAŁ, a rozmiar
  // wylicza dopiero widok. Gdyby do bazy szedł już `s150`, zmiana rozmiaru byłaby migracją
  // danych, po które poller nie wróci.
  it('podmienia segment `original` na `s150`', () => {
    expect(adresMiniatury(ORYGINAL)).toBe(MINIATURA);
  });

  // Poddomena bywa różna: `9.`, `2.`, `5.`, `f.` (zmierzone).
  it('działa dla każdej poddomeny allegroimg', () => {
    expect(adresMiniatury('https://f.allegroimg.com/original/aa/bb')).toBe('https://f.allegroimg.com/s150/aa/bb');
    expect(adresMiniatury('https://2.allegroimg.com/original/aa/bb')).toBe('https://2.allegroimg.com/s150/aa/bb');
  });

  // ⚠️ ADRES O NIEOCZEKIWANYM KSZTAŁCIE NIE MA PRAWA WYWALIĆ RENDEROWANIA. Wraca bez zmian
  // (pokażemy zdjęcie o rozmiar za duże), a nie wyjątkiem w środku pętli po wierszach listy.
  it('adres Allegro bez segmentu `original` zostaje bez zmian', () => {
    expect(adresMiniatury('https://9.allegroimg.com/s720/aa/bb')).toBe('https://9.allegroimg.com/s720/aa/bb');
    expect(adresMiniatury('https://9.allegroimg.com/originals/aa/bb')).toBe('https://9.allegroimg.com/originals/aa/bb');
    expect(adresMiniatury('https://9.allegroimg.com/original')).toBe('https://9.allegroimg.com/original');
  });

  // ⚠️ REGUŁA ALLEGRO NIE MA PRAWA SIĘGNĄĆ PO ADRES ZE SKLEPU — `pro` i `szkicownia` działają
  // i mają zostać nietknięte. Warunek to HOST, nie „adres zawiera /original/".
  it('nie tyka adresów spoza allegroimg.com', () => {
    expect(adresMiniatury('https://pro.szkicownia.pl/wp-content/uploads/original/stop.jpg'))
      .toBe('https://pro.szkicownia.pl/wp-content/uploads/original/stop-150x150.jpg');
    expect(adresMiniatury('https://zle.pl/original/aa/bb')).toBe('https://zle.pl/original/aa/bb');
    // Host, który tylko KOŃCZY się podobnie — nie jest Allegro.
    expect(adresMiniatury('https://zleallegroimg.com/original/aa/bb'))
      .toBe('https://zleallegroimg.com/original/aa/bb');
  });
});

describe('zdjeciePozycji — które źródło wygrywa', () => {
  it('pozycja ze sklepu czyta własną kolumnę', () => {
    expect(zdjeciePozycji({ zdjecie_url: 'https://sklep.test/x.jpg', zdjecie_oferty: null }))
      .toBe('https://sklep.test/x.jpg');
  });

  it('pozycja z Allegro czyta pamięć ofert', () => {
    expect(zdjeciePozycji({ zdjecie_url: null, zdjecie_oferty: ORYGINAL })).toBe(ORYGINAL);
  });

  // ⚠️ PRZY OBU ŹRÓDŁACH WYGRYWA KOLUMNA POZYCJI — prawdą jest to, co przyszło
  // Z ZAMÓWIENIEM. Pamięć ofert mówi o ofercie DZIŚ, a zamówienie o tym, co klient wtedy
  // kupił. Odwrócona kolejność znaczyłaby, że sklep — kanał, który DZIAŁA I SPRZEDAJE —
  // zaczyna czytać adres z cudzej tabeli.
  it('przy OBU źródłach wygrywa kolumna pozycji', () => {
    expect(zdjeciePozycji({ zdjecie_url: 'https://sklep.test/x.jpg', zdjecie_oferty: ORYGINAL }))
      .toBe('https://sklep.test/x.jpg');
  });

  it('brak obu daje null', () => {
    expect(zdjeciePozycji({})).toBe(null);
    expect(zdjeciePozycji(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------------
// 2. KLIENT — którą ścieżką pytamy
// ---------------------------------------------------------------------------------

const tokeny = { waznyToken: async () => 'TOKEN' };
const ustawienia = { api: 'https://api.test', userAgent: 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)' };

function szpiegOferty(cialo = { images: [ORYGINAL] }, { ok = true, status = 200 } = {}) {
  const wywolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wywolania.push({ url, opcje });
    return { ok, status, json: async () => cialo };
  };
  return { wywolania, fetchImpl };
}

describe('klient Allegro — pobranie oferty', () => {
  it('pyta /sale/product-offers/{id} z kompletem nagłówków i twardym limitem czasu', async () => {
    const { wywolania, fetchImpl } = szpiegOferty();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    const oferta = await k.pobierzOferte('17169409755');

    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].url).toBe('https://api.test/sale/product-offers/17169409755');
    expect(wywolania[0].opcje.headers.Authorization).toBe('Bearer TOKEN');
    expect(wywolania[0].opcje.headers.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(wywolania[0].opcje.headers['User-Agent']).toBe(ustawienia.userAgent);
    // Bez własnego sygnału undici czeka na nagłówki 300 000 ms, a serwer panelu stoi
    // z `requestTimeout: 0` — czyli w całym panelu nie ma żadnego ogranicznika.
    expect(wywolania[0].opcje.signal).toBeInstanceOf(AbortSignal);
    expect(oferta.images[0]).toBe(ORYGINAL);
  });

  // ⚠️ `GET /sale/offers/{offerId}` JEST WYCOFANE — 403 „This resource is no longer
  // supported" (zmierzone). Zamiana ścieżki „na krótszą" wyciszyłaby miniatury CICHO, bo
  // brak zdjęcia jest tu stanem normalnym i nikt by tego nie zauważył.
  it('NIE używa wycofanego /sale/offers/', async () => {
    const { wywolania, fetchImpl } = szpiegOferty();
    await createAllegroClient({ ustawienia, tokeny, fetchImpl }).pobierzOferte('1');

    expect(wywolania[0].url).not.toMatch(/\/sale\/offers\//);
    expect(zrodlo('allegro', 'client.js').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n'))
      .not.toMatch(/\/sale\/offers\//);
  });

  it('identyfikator oferty trafia do adresu zakodowany', async () => {
    const { wywolania, fetchImpl } = szpiegOferty();
    await createAllegroClient({ ustawienia, tokeny, fetchImpl }).pobierzOferte('a/../b');

    expect(wywolania[0].url).toBe('https://api.test/sale/product-offers/a%2F..%2Fb');
  });

  it('błąd HTTP wychodzi z klienta jako wyjątek z kodem i ścieżką, bez tokenu', async () => {
    const { fetchImpl } = szpiegOferty({}, { ok: false, status: 403 });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await expect(k.pobierzOferte('99')).rejects.toThrow(/HTTP 403.*product-offers\/99/);
    await expect(k.pobierzOferte('99')).rejects.not.toThrow(/TOKEN/);
  });

  // Limit ma być KRÓTKI, bo jeden przebieg pyta o wiele ofert POD RZĄD — limit mnoży się
  // przez ich liczbę. Najgorszy przypadek musi zmieścić się między tyknięciami zegara (2 min).
  it('najgorszy przypadek uzupełniania mieści się między tyknięciami pollera', () => {
    expect(LIMIT_ZAPYTANIA_OFERTY_MS * LIMIT_OFERT_NA_PRZEBIEG).toBeLessThan(2 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------------
// 3. PAMIĘĆ PODRĘCZNA I USŁUGA
// ---------------------------------------------------------------------------------

const zmapowane = (zrodloId, pozycje) => ({
  zrodlo_id: String(zrodloId), numer: String(zrodloId), klient: { first_name: 'Jan' },
  dostawa: { city: 'Pęki' }, metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 0,
  nip: null, kwota_brutto: '99.00', status_woo: null, oplacone_at: null,
  anulowane: 0, utworzone_at: '2026-08-04T08:00:00',
  pozycje,
});

const pozycjaAllegro = (ofertaId, nazwa = 'Szablon STOP') => ({
  nazwa, sku: null, ilosc: 1, cena_brutto: '99.00', vat: '23',
  zdjecie_url: null, produkt_id: null, oferta_id: ofertaId,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zamowienieAllegro = (ofertaId, { sklep = 'allegro_szkicownia', zrodloId = 'e2a1' } = {}) =>
  zapiszZamowienie(db, sklep, zmapowane(zrodloId, [pozycjaAllegro(ofertaId)]), {});

const klientZ = (odpowiedzi) => ({
  pobierzOferte: vi.fn(async (id) => {
    const o = odpowiedzi[id];
    if (o instanceof Error) throw o;
    return o ?? { images: [] };
  }),
});

describe('pamięć podręczna zdjęć ofert', () => {
  it('pobranie zapisuje adres, a drugie wywołanie NIE IDZIE DO SIECI', async () => {
    zamowienieAllegro('17169409755');
    const klient = klientZ({ 17169409755: { images: [ORYGINAL] } });
    const usluga = createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } });

    expect(await usluga.uzupelnij()).toEqual({ pobrane: 1, bezZdjecia: 0, nieudane: 0 });
    expect(klient.pobierzOferte).toHaveBeenCalledTimes(1);
    expect(zdjecieOfertyZBazy(db, '17169409755').zdjecie_url).toBe(ORYGINAL);

    // ⚠️ TO JEST CAŁY POWÓD ISTNIENIA TABELI: bez niej poller pytałby o to samo 720 razy
    // na dobę, bo pozycje są kasowane i wstawiane co dwie minuty (niezmiennik 4.7).
    expect(await usluga.uzupelnij()).toEqual({ pobrane: 0, bezZdjecia: 0, nieudane: 0 });
    expect(klient.pobierzOferte).toHaveBeenCalledTimes(1);
  });

  // ⚠️ RE-SYNCHRONIZACJA KASUJE I WSTAWIA POZYCJE — adres MUSI to przeżyć.
  it('adres przeżywa ponowną synchronizację zamówienia', async () => {
    const id = zamowienieAllegro('55');
    const klient = klientZ({ 55: { images: [ORYGINAL] } });
    await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } }).uzupelnij();

    // Poller przechodzi drugi raz: DELETE + INSERT pozycji.
    zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1', [pozycjaAllegro('55')]), {});

    expect(pobierzZamowienie(db, id).pozycje[0].zdjecie_url).toBe(ORYGINAL);
    // ...i nie pytamy o nią drugi raz.
    await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } }).uzupelnij();
    expect(klient.pobierzOferte).toHaveBeenCalledTimes(1);
  });

  it('oferta BEZ zdjęcia zapisuje się jako odpowiedź i też nie wraca do kolejki', async () => {
    zamowienieAllegro('77');
    const klient = klientZ({ 77: { images: [] } });
    const usluga = createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } });

    expect(await usluga.uzupelnij()).toEqual({ pobrane: 0, bezZdjecia: 1, nieudane: 0 });
    const w = zdjecieOfertyZBazy(db, '77');
    expect(w.zdjecie_url).toBe(null);
    // ⚠️ Pusty BŁĄD odróżnia „Allegro odpowiedziało, zdjęcia nie ma" od nieudanej próby.
    expect(w.blad).toBe(null);

    await usluga.uzupelnij();
    expect(klient.pobierzOferte).toHaveBeenCalledTimes(1);
  });

  // ⚠️ NIEUDANA PRÓBA MA BYĆ ODRÓŻNIALNA OD „JESZCZE NIE PYTALIŚMY" — inaczej oferta bez
  // zdjęcia (albo skasowana z Allegro) byłaby odpytywana bez końca, co dwie minuty.
  it('błąd zapisuje ślad, NIE RZUCA i nie wraca do kolejki od razu', async () => {
    zamowienieAllegro('403');
    const klient = klientZ({ 403: new Error('Allegro: HTTP 403 przy /sale/product-offers/403') });
    const usluga = createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } });

    expect(await usluga.uzupelnij()).toEqual({ pobrane: 0, bezZdjecia: 0, nieudane: 1 });
    const w = zdjecieOfertyZBazy(db, '403');
    expect(w.zdjecie_url).toBe(null);
    expect(w.blad).toContain('HTTP 403');
    expect(w.sprawdzone_at).toBeTruthy();

    await usluga.uzupelnij();
    expect(klient.pobierzOferte).toHaveBeenCalledTimes(1);
  });

  // ...ale droga powrotna dla awarii PRZEJŚCIOWEJ (timeout, pięćsetka) musi zostać otwarta —
  // inaczej jedno potknięcie zabierałoby zdjęcie tej oferty NA ZAWSZE (niezmiennik 4.9).
  it('nieudana próba wraca do kolejki po odczekaniu', () => {
    zamowienieAllegro('500');
    const dawno = new Date(Date.now() - PONOWIENIE_PO_MS - 1000).toISOString();
    zapiszProbeZdjecia(db, '500', { blad: 'Allegro: HTTP 500', at: dawno });

    expect(ofertyDoSprawdzenia(db, 'allegro_szkicownia', { limit: 10 })).toEqual(['500']);
  });

  it('udana próba NIE wraca do kolejki nawet po latach', () => {
    zamowienieAllegro('600');
    const dawno = new Date(Date.now() - 1000 * PONOWIENIE_PO_MS).toISOString();
    zapiszProbeZdjecia(db, '600', { zdjecieUrl: ORYGINAL, at: dawno });

    expect(ofertyDoSprawdzenia(db, 'allegro_szkicownia', { limit: 10 })).toEqual([]);
  });

  // ⚠️ `GET /sale/product-offers/{id}` oddaje WŁASNĄ ofertę zalogowanego sprzedawcy: pytanie
  // kontem A o ofertę konta B odbiłoby się błędem, który zapisalibyśmy jako fakt o ofercie.
  it('pyta wyłącznie o oferty SWOJEGO kanału', async () => {
    zamowienieAllegro('AAA', { sklep: 'allegro_szkicownia', zrodloId: 'a1' });
    zamowienieAllegro('BBB', { sklep: 'allegro_amarka', zrodloId: 'b1' });

    expect(ofertyDoSprawdzenia(db, 'allegro_szkicownia', { limit: 10 })).toEqual(['AAA']);
    expect(ofertyDoSprawdzenia(db, 'allegro_amarka', { limit: 10 })).toEqual(['BBB']);
  });

  // Pierwszy przebieg po wdrożeniu widzi CAŁE archiwum kanału naraz.
  it('jeden przebieg pyta o najwyżej LIMIT_OFERT_NA_PRZEBIEG ofert', async () => {
    for (let i = 0; i < LIMIT_OFERT_NA_PRZEBIEG + 5; i += 1) {
      zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(`z${i}`, [pozycjaAllegro(`of-${String(i).padStart(3, '0')}`)]), {});
    }
    const klient = klientZ({});
    await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } }).uzupelnij();

    expect(klient.pobierzOferte).toHaveBeenCalledTimes(LIMIT_OFERT_NA_PRZEBIEG);
  });

  // Kanał skonfigurowany do odczytu zamówień, ale bez tej metody u klienta, to tryb POPRAWNY.
  it('klient bez pobierzOferte po prostu nie jest pytany', async () => {
    zamowienieAllegro('1');
    const usluga = createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: { pobierzPrzesylki: vi.fn() } } });

    await expect(usluga.uzupelnij()).resolves.toEqual({ pobrane: 0, bezZdjecia: 0, nieudane: 0 });
  });

  // ⚠️ ZERO ZMIAN DLA SKLEPÓW. Pozycje z WooCommerce mają `oferta_id` puste, więc nie mają
  // prawa trafić do kolejki pytań do Allegro.
  it('pozycje sklepowe nie wchodzą do kolejki', () => {
    zapiszZamowienie(db, 'pro', zmapowane('1281', [{
      nazwa: 'Szablon', sku: 'PRO-1', ilosc: 1, cena_brutto: '10.00', vat: '23',
      zdjecie_url: 'https://pro.szkicownia.pl/x.jpg', produkt_id: 7, oferta_id: null,
    }]), {});

    expect(ofertyDoSprawdzenia(db, 'pro', { limit: 10 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------
// 4. ODCZYT — miniatura na LIŚCIE i na KARCIE
// ---------------------------------------------------------------------------------

describe('miniatura dociera na ekran', () => {
  it('lista zamówień pokazuje adres z pamięci ofert', async () => {
    zamowienieAllegro('900');
    await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klientZ({ 900: { images: [ORYGINAL] } }) } }).uzupelnij();

    const [z] = listaZamowien(db);
    expect(z.pozycje[0].zdjecie_url).toBe(ORYGINAL);
    // ⚠️ W BAZIE ORYGINAŁ, na ekranie wariant — reguła rozmiaru mieszka w widoku (4.13c).
    expect(adresMiniatury(z.pozycje[0].zdjecie_url)).toBe(MINIATURA);
  });

  it('karta zamówienia pokazuje ten sam adres, co lista', async () => {
    const id = zamowienieAllegro('901');
    await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klientZ({ 901: { images: [ORYGINAL] } }) } }).uzupelnij();

    const [w] = wierszePozycji(pobierzZamowienie(db, id));
    expect(w.zdjecie).toBe(ORYGINAL);
    expect(adresMiniatury(w.zdjecie)).toBe(MINIATURA);
  });

  it('oferta jeszcze niesprawdzona to po prostu brak miniatury, nie awaria', () => {
    const id = zamowienieAllegro('902');

    expect(listaZamowien(db)[0].pozycje[0].zdjecie_url).toBe(null);
    expect(wierszePozycji(pobierzZamowienie(db, id))[0].zdjecie).toBe(null);
    expect(adresMiniatury(null)).toBe(null);
  });

  // ⚠️ ZERO ZMIAN W ZACHOWANIU SKLEPÓW — `pro` i `szkicownia` sprzedają i ich miniatury działają.
  it('pozycja sklepowa czyta dalej WŁASNĄ kolumnę', () => {
    zapiszZamowienie(db, 'pro', zmapowane('1281', [{
      nazwa: 'Szablon', sku: 'PRO-1', ilosc: 1, cena_brutto: '10.00', vat: '23',
      zdjecie_url: 'https://pro.szkicownia.pl/wp-content/uploads/2026/07/stop.jpg',
      produkt_id: 7, oferta_id: null,
    }]), {});

    const [z] = listaZamowien(db);
    expect(z.pozycje[0].zdjecie_url).toBe('https://pro.szkicownia.pl/wp-content/uploads/2026/07/stop.jpg');
    expect(adresMiniatury(z.pozycje[0].zdjecie_url))
      .toBe('https://pro.szkicownia.pl/wp-content/uploads/2026/07/stop-150x150.jpg');
  });

  it('pozycja dopisana ręcznie dalej nie ma zdjęcia i nie wywala odczytu', async () => {
    const id = zamowienieAllegro('903');
    db.prepare(
      "INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, zrodlo) VALUES (?,?,?,?,'reczna')",
    ).run(id, 'Dopłata za projekt', 1, '50.00');
    await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klientZ({ 903: { images: [ORYGINAL] } }) } }).uzupelnij();

    const pozycje = pobierzZamowienie(db, id).pozycje;
    expect(pozycje.map((p) => p.zdjecie_url)).toEqual([ORYGINAL, null]);
  });
});

// ---------------------------------------------------------------------------------
// 5. POLLER PRZEŻYWA AWARIĘ POBIERANIA ZDJĘĆ
// ---------------------------------------------------------------------------------

describe('awaria zdjęć nie dotyka pollera', () => {
  const kanalZ = (zamowienia) => ({
    pobierzStrone: vi.fn(async () => ({ zamowienia, stron: 1 })),
    mapuj: (s) => zmapowane(s.id, [pozycjaAllegro(s.oferta)]),
    kursorZ: (s) => s.updatedAt,
    zlozoneZ: (s) => s.boughtAt,
  });

  it('zamówienia zapisują się, a kursor idzie dalej MIMO rzucającego uzupełniania', async () => {
    const poller = createPoller({
      db,
      kanal: kanalZ([{ id: 'x1', oferta: '11', updatedAt: '2026-08-04T10:00:00Z', boughtAt: '2026-08-04T09:00:00Z' }]),
      sklep: 'allegro_szkicownia',
    });
    // Uzupełnianie, które wybucha najgorzej jak potrafi — poza pętlą per oferta.
    const zdjecia = { uzupelnij: vi.fn(async () => { throw new Error('Allegro leży'); }) };

    const wynik = await zPobieraniemZdjec(poller, zdjecia).przebieg();

    expect(wynik).toEqual({ pobrane: 1 });
    expect(zdjecia.uzupelnij).toHaveBeenCalledTimes(1);
    expect(pobierzZamowienie(db, listaZamowien(db)[0].id).zrodlo_id).toBe('x1');
    // ⚠️ KURSOR MUSI IŚĆ DALEJ. Stojący kursor znaczy kanał, który przy następnym tyknięciu
    // czyta tę samą stronę — i tak w kółko, cicho, na zawsze.
    expect(poller.stan().zsynchronizowane_do).toBe('2026-08-04T10:00:00Z');
    expect(poller.stan().ostatni_blad).toBe(null);
  });

  // ⚠️ Wyjątek rzucony w `finally` PODMIENIŁBY błąd przebiegu na swój własny — awaria
  // synchronizacji zamówień zniknęłaby z paska na liście, a w jej miejsce stanęłaby usterka
  // kosmetyczna.
  it('błąd PRZEBIEGU dochodzi do wołającego nietknięty, a zdjęcia i tak się dociągają', async () => {
    const kanal = kanalZ([]);
    kanal.pobierzStrone = vi.fn(async () => { throw new Error('Allegro: HTTP 401 przy /order/checkout-forms'); });
    const poller = createPoller({ db, kanal, sklep: 'allegro_szkicownia' });
    const zdjecia = { uzupelnij: vi.fn(async () => { throw new Error('i to też leży'); }) };

    await expect(zPobieraniemZdjec(poller, zdjecia).przebieg()).rejects.toThrow('HTTP 401');
    expect(zdjecia.uzupelnij).toHaveBeenCalledTimes(1);
    expect(poller.stan().ostatni_blad).toContain('HTTP 401');
  });

  it('opakowany poller oddaje resztę swojego kształtu (stan, stany)', async () => {
    const poller = { przebieg: async () => ({ pobrane: 0 }), stan: () => ({ sklep: 'x' }), stany: () => [] };
    const opakowany = zPobieraniemZdjec(poller, { uzupelnij: async () => {} });

    expect(opakowany.stan()).toEqual({ sklep: 'x' });
    expect(opakowany.stany()).toEqual([]);
  });

  // Jedna oferta o złym kształcie nie ma prawa zabrać miniatur wszystkim pozostałym.
  it('awaria JEDNEJ oferty nie przerywa uzupełniania pozostałych', async () => {
    zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('z1', [pozycjaAllegro('of-1')]), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('z2', [pozycjaAllegro('of-2')]), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('z3', [pozycjaAllegro('of-3')]), {});
    const klient = klientZ({
      'of-1': { images: [ORYGINAL] },
      'of-2': new Error('Allegro: HTTP 500 przy /sale/product-offers/of-2'),
      'of-3': { images: [ORYGINAL] },
    });

    const wynik = await createZdjeciaAllegro({ db, klienci: { allegro_szkicownia: klient } }).uzupelnij();

    expect(wynik).toEqual({ pobrane: 2, bezZdjecia: 0, nieudane: 1 });
    expect(zdjecieOfertyZBazy(db, 'of-3').zdjecie_url).toBe(ORYGINAL);
  });
});
