import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createAllegroClient, LIMIT_STRONY, LIMIT_ZAPYTANIA_ZAMOWIEN_MS, LIMIT_ZAPYTANIA_PRZESYLEK_MS,
} from '../../src/oms/allegro/client.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const zrodloKlienta = () => readFileSync(join(__dir, '..', '..', 'src', 'oms', 'allegro', 'client.js'), 'utf8');
const fixtura = JSON.parse(readFileSync(join(__dir, 'fixtures', 'allegro', 'checkout-forms.json'), 'utf8'));

const tokeny = { waznyToken: async () => 'TOKEN' };
// ⚠️ WARTOSC JAWNIE FIKCYJNA — prawdziwy naglowek dopiero powstanie i wejdzie KONFIGURACJA
// (`ALLEGRO_USER_AGENT`), a Allegro trzyma go na bialej liscie. `.invalid` to TLD
// zarezerwowane przez RFC 2606.
const UA = 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)';
const ustawienia = { api: 'https://api.przyklad', userAgent: UA };

// Zbiera KAZDE wywolanie, nie tylko ostatnie — czesc testow sprawdza, ze czegos NIE bylo.
function szpieg(cialo = { checkoutForms: [], totalCount: 0 }) {
  const wywolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wywolania.push({ url, opcje });
    return { ok: true, status: 200, json: async () => cialo };
  };
  return { wywolania, fetchImpl };
}

describe('klient Allegro', () => {
  it('pyta o zamówienia kursorem updatedAt.gte i przelicza liczbę stron z totalCount', async () => {
    let uzytyUrl = null; let uzyteNaglowki = null;
    const fetchImpl = async (url, opcje) => {
      uzytyUrl = url; uzyteNaglowki = opcje.headers;
      return { ok: true, json: async () => ({ checkoutForms: [{ id: 'a' }], totalCount: 130 }) };
    };
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    const wynik = await k.pobierzZamowienia({ od: '2026-07-01', kursor: '2026-08-01T10:00:00Z', strona: 1 });

    expect(uzytyUrl).toContain('updatedAt.gte=2026-08-01T10%3A00%3A00Z');
    expect(uzytyUrl).toContain(`limit=${LIMIT_STRONY}`);
    expect(uzytyUrl).toContain('offset=0');
    expect(uzyteNaglowki.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(uzyteNaglowki.Authorization).toBe('Bearer TOKEN');
    expect(wynik.zamowienia).toHaveLength(1);
    expect(wynik.stron).toBe(Math.ceil(130 / LIMIT_STRONY));
  });

  // Testy wyzej i nizej biora `limit` z eksportu, wiec sama WARTOSC stalej jest dla nich
  // niewidoczna — podniesienie jej przeszloby na zielono, a Allegro odbija `limit > 100`
  // czterysetka na kazde zapytanie, czyli wycisza kanal w calosci.
  it('limit strony mieści się w tym, co Allegro w ogóle przyjmuje', () => {
    expect(LIMIT_STRONY).toBeGreaterThan(0);
    expect(LIMIT_STRONY).toBeLessThanOrEqual(100);
  });

  // ⚠️ Wyslanie OBU filtrow naraz to nie jest „ostroznosc", tylko utrata zamowien: Allegro
  // zlaczylo by je koniunkcja, wiec stare zamowienie, ktore WLASNIE sie zmienilo (oplata,
  // anulowanie, reklamacja), wypadloby z okna przez podloge po dacie ZLOZENIA. Test wyzej
  // sprawdza tylko obecnosc kursora, wiec sam nie zabija tej mutacji.
  it('gdy jest kursor, podłoga po dacie złożenia NIE leci razem z nim', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01', kursor: '2026-08-01T10:00:00Z', strona: 1 });

    expect(wywolania[0].url).not.toContain('boughtAt');
  });

  it('bez kursora pyta od PODŁOGI po dacie zakupu — konto ma 775 zamówień, nie czytamy ich w kółko', async () => {
    let uzytyUrl = null;
    const fetchImpl = async (url) => { uzytyUrl = url; return { ok: true, json: async () => ({ checkoutForms: [], totalCount: 0 }) }; };
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01', kursor: null, strona: 1 });

    expect(uzytyUrl).toContain('lineItems.boughtAt.gte=2026-07-01');
    expect(uzytyUrl).not.toContain('updatedAt.gte');
  });

  // ⚠️ STRONICOWANIE PIERWSZEGO PRZEBIEGU. To jest gałąź, która przy 776 zamówieniach
  // czyta OSIEM stron — czyli jedyne miejsce w kanale, gdzie okno naprawdę ma czas się
  // przesunąć. `lineItems.boughtAt` to data ZŁOŻENIA, czyli klucz NIEZMIENNY: zamówienie
  // wpadające w trakcie przebiegu dopisuje się ZA oknem i nie rusza stron już przeczytanych.
  // Przy domyślnym „najnowsze pierwsze" każde nowe zamówienie przesuwa całą listę o jeden
  // i jedno zamówienie z granicy strony wypada bez śladu.
  it('pierwszy przebieg sortuje po dacie złożenia rosnąco — inaczej stronicowanie gubi zamówienia', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01', kursor: null, strona: 1 });

    expect(decodeURIComponent(wywolania[0].url)).toContain('sort=lineItems.boughtAt');
    // Rosnąco, czyli BEZ minusa. `sort=-lineItems.boughtAt` to znowu „najnowsze pierwsze"
    // i cała stabilność znika, a sam parametr w URL-u wygląda tak samo poprawnie.
    expect(decodeURIComponent(wywolania[0].url)).not.toContain('sort=-');
  });

  // ⚠️ TO NIE JEST NIEDOPATRZENIE, TYLKO DECYZJA. Gałąź kursora zostaje na domyślnym
  // „najnowsze pierwsze". `sort=updatedAt` rosnąco byłoby sortowaniem po polu, po którym
  // JEDNOCZEŚNIE filtrujemy, i zamieniłoby rzadkie duplikaty (nieszkodliwe — zapis jest
  // upsertem po `(sklep, zrodlo_id)`) na rzadkie POMINIĘCIA: rekord z przeczytanego
  // prefiksu, zmodyfikowany w trakcie przebiegu, ucieka na koniec listy, a rekord z granicy
  // strony wpada w obszar już przeczytany i nie wraca NIGDY. Ten test istnieje po to, żeby
  // „uspójnienie" obu gałęzi zaczerwieniło się, zamiast po cichu wprowadzić utratę zamówień.
  it('gałąź kursora NIE ustawia sortowania — po polu filtrowanym rosnąco gubi się zamówienia', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01', kursor: '2026-08-01T10:00:00Z', strona: 1 });

    expect(wywolania[0].url).not.toContain('sort');
  });

  // ⚠️ To jest POSTAC, KTORA NAPRAWDE PRZYCHODZI Z KONFIGURACJI. `parsujDateOd()`
  // (src/oms/config.js) oddaje `RRRR-MM-DDT00:00:00` BEZ strefy, bo tak lubi WooCommerce.
  // Allegro filtruje po polach `format: date-time`, czyli po RFC 3339, gdzie przesuniecie
  // strefy jest OBOWIAZKOWE — wartosc bez `Z` leci na 400 i kanal milczy w calosci.
  it('podłogę z konfiguracji (bez strefy) normalizuje do UTC, bo Allegro wymaga strefy', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01T00:00:00', kursor: null, strona: 1 });

    expect(wywolania[0].url).toContain('lineItems.boughtAt.gte=2026-07-01T00%3A00%3A00Z');
  });

  it('gołą datę RRRR-MM-DD rozwija do północy UTC', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01', kursor: null, strona: 1 });

    expect(wywolania[0].url).toContain('lineItems.boughtAt.gte=2026-07-01T00%3A00%3A00Z');
  });

  // Kursor pochodzi z `updatedAt` Allegro — juz jest w UTC z `Z` i z ulamkiem sekundy.
  // Normalizacja nie ma prawa go „poprawic", bo przesuniety kursor gubi zamowienia.
  it('kursor, który ma już strefę, przechodzi znak w znak', async () => {
    for (const kursor of ['2026-08-04T07:17:35.018Z', '2026-08-04T09:17:35+02:00']) {
      const { wywolania, fetchImpl } = szpieg();
      const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

      await k.pobierzZamowienia({ od: null, kursor, strona: 1 });

      expect(decodeURIComponent(wywolania[0].url)).toContain(`updatedAt.gte=${kursor}`);
    }
  });

  it('data, której nie umie znormalizować, wywala przebieg ZANIM cokolwiek poleci do Allegro', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await expect(k.pobierzZamowienia({ od: '01.07.2026', kursor: null, strona: 1 }))
      .rejects.toThrow(/ISO 8601/);
    expect(wywolania).toHaveLength(0);
  });

  it('200 z ciałem nie-tablicą NIE MOŻE udawać „brak zamówień”', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ checkoutForms: null, totalCount: 0 }) });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await expect(k.pobierzZamowienia({ od: null, kursor: null, strona: 1 })).rejects.toThrow(/nie oddało listy/);
  });

  // Poller robi `do { … } while (strona <= stron)`, wiec `stron: 0` nie wywala przebiegu —
  // i wlasnie dlatego brak `Math.max(1, …)` bylby awaria CICHA. Liczba stron ponizej jedynki
  // nie znaczy nic sensownego przy odpowiedzi, ktora juz przyszla.
  it('pusta strona nie oddaje ZERA stron — minimum to jedna', async () => {
    const { fetchImpl } = szpieg({ checkoutForms: [], totalCount: 0 });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    expect((await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 })).stron).toBe(1);
  });

  it('brak totalCount w odpowiedzi też daje jedną stronę, a nie NaN', async () => {
    const { fetchImpl } = szpieg({ checkoutForms: [{ id: 'a' }] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    expect((await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 })).stron).toBe(1);
  });

  // Test „offset=0" na stronie pierwszej przechodzi rowniez przy `strona * LIMIT_STRONY`
  // z bledna baza — dopiero druga strona pokazuje, czy przesuniecie liczy sie poprawnie.
  it('kolejne strony liczą offset od zera, po pełnym limicie', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: null, kursor: null, strona: 3 });

    expect(wywolania[0].url).toContain(`offset=${2 * LIMIT_STRONY}`);
  });

  it('bez sensownego numeru strony nie wysyła offset=NaN', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await expect(k.pobierzZamowienia({ od: null, kursor: null })).rejects.toThrow(/strona/);
    await expect(k.pobierzZamowienia({ od: null, kursor: null, strona: 0 })).rejects.toThrow(/strona/);
    expect(wywolania).toHaveLength(0);
  });

  it('surowe zamówienia oddaje bez tknięcia — mapowanie to nie jest robota klienta', async () => {
    const { fetchImpl } = szpieg(fixtura);
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    const wynik = await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 });

    expect(wynik.zamowienia).toEqual(fixtura.checkoutForms);
    expect(wynik.stron).toBe(Math.ceil(775 / LIMIT_STRONY));
  });

  it('przesyłki oddają numer i przewoźnika', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ shipments: [{ waybill: 'AD0LK57DLG0756H4H', carrierId: 'ALLEGRO' }] }),
    });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    expect(await k.pobierzPrzesylki('abc')).toEqual([{ waybill: 'AD0LK57DLG0756H4H', carrierId: 'ALLEGRO' }]);
  });

  // Test wyzej nie oglada URL-a ani naglowkow, wiec sciezka przesylek byla w calosci
  // niepokryta — dowolna literowka w niej przechodzila.
  it('przesyłki idą pod właściwą ścieżkę, z identyfikatorem uciekniętym w adresie', async () => {
    const { wywolania, fetchImpl } = szpieg({ shipments: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzPrzesylki('a/b c');

    expect(wywolania[0].url).toBe('https://api.przyklad/order/checkout-forms/a%2Fb%20c/shipments');
    expect(wywolania[0].opcje.headers.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(wywolania[0].opcje.headers.Authorization).toBe('Bearer TOKEN');
  });

  // ⚠️ ŚWIADOMA ASYMETRIA wobec zamowien. Przy zamowieniach „pusta lista" jest nie do
  // odroznienia od zlej konfiguracji CALEGO kanalu, wiec musi wywalic przebieg. Przy
  // przesylkach brak listy to stan NORMALNY (56 z 60 zamowien w rozpoznaniu bylo wyslanych,
  // reszta nie) i kosztuje najwyzej brak linku do sledzenia na jednej karcie.
  it('brak przesyłek to normalny stan, a nie awaria', async () => {
    const { fetchImpl } = szpieg({ shipments: null });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    expect(await k.pobierzPrzesylki('abc')).toEqual([]);
  });

  it('błąd HTTP wywala głośno, ale NIE wypisuje tokenu (niezmiennik 4.10)', async () => {
    const sekret = 'SEKRETNY-ACCESS-TOKEN-9f8e7d';
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: sekret }) });
    const k = createAllegroClient({
      ustawienia,
      tokeny: { waznyToken: async () => sekret },
      fetchImpl,
    });

    const blad = await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 }).catch((e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.message).toContain('401');
    expect(blad.message).not.toContain(sekret);
  });

  // Access token Allegro zyje ~12 h, ale przebieg pollera chodzi po wielu stronach i moze
  // trafic w moment odswiezenia. Token zapamietany raz na cale zycie klienta zamienilby sie
  // w 401 w srodku przebiegu — `waznyToken()` samo pilnuje waznosci, wiec pytamy je zawsze.
  it('token bierze świeżo przy każdym żądaniu, nie zapamiętuje go', async () => {
    let ile = 0;
    const { fetchImpl } = szpieg({ checkoutForms: [], totalCount: 0 });
    const k = createAllegroClient({
      ustawienia,
      tokeny: { waznyToken: async () => { ile += 1; return `T${ile}`; } },
      fetchImpl,
    });

    await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 });
    await k.pobierzZamowienia({ od: null, kursor: null, strona: 2 });

    expect(ile).toBe(2);
  });

  // ⚠️ PLAN A NIE WYSYLA DO ALLEGRO NICZEGO. To jest wymaganie calego etapu, a nie detal
  // implementacji — i bez testu jest tylko komentarzem.
  it('każde żądanie jest GET-em i nie niesie ciała', async () => {
    const { wywolania, fetchImpl } = szpieg({ checkoutForms: [], totalCount: 0, shipments: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 });
    await k.pobierzPrzesylki('abc');

    expect(wywolania).toHaveLength(2);
    for (const { opcje } of wywolania) {
      expect(opcje.method ?? 'GET').toBe('GET');
      expect(opcje.body).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------------------
  // TWARDE LIMITY CZASU (I-1). Klient nie mial ZADNEGO, a undici czeka na naglowki 300 s
  // i serwer panelu stoi z `requestTimeout: 0`. Odkad przesylki dociaga KARTA zamowienia
  // (GET /zamowienia/:id), milczace Allegro znaczylo karte, ktora sie nie otwiera — dla
  // KAZDEGO zamowienia z kanalu bez `wyslane_at`, a jedynym wyjsciem z odpytywania jest
  // belka statusu stojaca na TEJ WLASNIE karcie.
  // -------------------------------------------------------------------------------------

  // Zadanie, ktore nigdy nie odpowiada — dokladnie tak zachowuje sie serwer przyjmujacy
  // polaczenie i milczacy. Konczy sie WYLACZNIE przez sygnal; bez sygnalu wisi na wieki
  // (i wtedy test pada na wlasnym limicie vitest, zamiast przejsc na zielono).
  const wiszacyFetch = (url, opcje = {}) => new Promise((_, odrzuc) => {
    if (!opcje.signal) return;
    opcje.signal.addEventListener('abort', () => odrzuc(opcje.signal.reason));
  });

  // Prawdziwy sygnal, tylko SKROCONY: inaczej test czekalby 30 s realnego czasu (fake
  // timers tu nie pomoga — `AbortSignal.timeout` bierze setTimeout z wewnetrznego modulu
  // Node, nie z globalThis, wiec podmiana zegara vitest go nie dotyka). Zadany limit
  // zapisujemy i sprawdzamy osobno, wiec dowod sklada sie z dwoch czesci: JAKA wartosc
  // poszla do sygnalu ORAZ ze zadziale nie tego sygnalu KONCZY zapytanie bledem.
  const KROTKO_MS = 20;
  async function podMilczacymAllegro(wolanie) {
    const oryginalna = AbortSignal.timeout.bind(AbortSignal);
    const zadaneLimity = [];
    const szpieg = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      zadaneLimity.push(ms);
      return oryginalna(KROTKO_MS);
    });
    try {
      const k = createAllegroClient({ ustawienia, tokeny, fetchImpl: wiszacyFetch });
      const blad = await wolanie(k).then(() => null, (e) => e);
      return { zadaneLimity, blad };
    } finally {
      szpieg.mockRestore();
    }
  }

  it('milczące Allegro KOŃCZY pobieranie zamówień błędem po limicie, zamiast wisieć', async () => {
    const { zadaneLimity, blad } = await podMilczacymAllegro(
      (k) => k.pobierzZamowienia({ od: null, kursor: null, strona: 1 }),
    );

    expect(blad).toBeTruthy();
    // TimeoutError, a nie „cokolwiek poszlo nie tak": rozroznia zerwanie po LIMICIE od
    // np. TypeError-a na brakujacym sygnale.
    expect(blad.name).toBe('TimeoutError');
    expect(zadaneLimity).toEqual([LIMIT_ZAPYTANIA_ZAMOWIEN_MS]);
  });

  // ⚠️ TA SCIEZKA JEST NA TRASIE RENDEROWANIA KARTY — tu limit boli najbardziej.
  it('milczące Allegro KOŃCZY pytanie o przesyłki błędem po limicie, zamiast wisieć', async () => {
    const { zadaneLimity, blad } = await podMilczacymAllegro((k) => k.pobierzPrzesylki('abc'));

    expect(blad).toBeTruthy();
    expect(blad.name).toBe('TimeoutError');
    // Sam fakt „jakis limit byl" nie wystarcza: podmiana na limit pollera zostawilaby
    // czlowieka przed pustym ekranem SZESC RAZY dluzej, a test dalej bylby zielony.
    expect(zadaneLimity).toEqual([LIMIT_ZAPYTANIA_PRZESYLEK_MS]);
    expect(zadaneLimity).not.toContain(LIMIT_ZAPYTANIA_ZAMOWIEN_MS);
  });

  // Testy wyzej biora obie wartosci z eksportu, wiec sama ICH WYSOKOSC jest dla nich
  // niewidoczna — podniesienie limitu karty do 300 s przeszloby na zielono.
  it('limity są krótsze niż domyślne 300 s undici, a karta czeka KRÓCEJ niż poller', () => {
    expect(LIMIT_ZAPYTANIA_PRZESYLEK_MS).toBeGreaterThan(0);
    expect(LIMIT_ZAPYTANIA_ZAMOWIEN_MS).toBeLessThan(300_000);
    // Karta jest ogladana przez CZLOWIEKA, poller chodzi w tle — cierpliwosc rozklada sie
    // odwrotnie niz rozmiar odpowiedzi, i to jest cala decyzja o dwoch stalych.
    expect(LIMIT_ZAPYTANIA_PRZESYLEK_MS).toBeLessThan(LIMIT_ZAPYTANIA_ZAMOWIEN_MS);
  });

  it('każde żądanie niesie WŁASNY, świeży sygnał — wspólny zestarzałby się razem z procesem', async () => {
    const { wywolania, fetchImpl } = szpieg({ checkoutForms: [], totalCount: 0, shipments: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 });
    await k.pobierzPrzesylki('abc');

    for (const { opcje } of wywolania) {
      expect(opcje.signal).toBeInstanceOf(AbortSignal);
      expect(opcje.signal.aborted).toBe(false);
    }
    expect(wywolania[0].opcje.signal).not.toBe(wywolania[1].opcje.signal);
  });

  // ⚠️⚠️ NAGLOWEK ZGODNOSCI. Allegro pisze wprost: „wywolania API bez prawidlowego naglowka
  // User-Agent spowoduja zablokowanie klucza API", a po 30.06.2026 odrzuca je automatycznie.
  // Egzekwowanie idzie stopniowo, wiec kanal potrafi DZIALAC i jednoczesnie byc niezgodny —
  // panel zgodnosci pokazywal „Niezgodny (100% zadan)" przez tydzien normalnej sprzedazy.
  // Awaria jest wiec calkowicie cicha az do chwili, w ktorej zabiera caly kanal.
  //
  // OBIE SCIEZKI ODCZYTU MAJA WLASNA ASERCJE, mimo ze `get()` jest jedno: to, ze dzis
  // wychodza jednym miejscem, jest decyzja implementacji, a nie kontraktem.
  it('zapytanie o ZAMÓWIENIA niesie User-Agent z konfiguracji', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-07-01', kursor: null, strona: 1 });

    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].opcje.headers['User-Agent']).toBe(UA);
    // Ma sie DOLOZYC, a nie wyprzec `Accept`, bez ktorego Allegro oddaje 406 na kazde zadanie.
    expect(wywolania[0].opcje.headers.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(wywolania[0].opcje.headers.Authorization).toBe('Bearer TOKEN');
  });

  it('zapytanie o PRZESYŁKI (ścieżka karty zamówienia) niesie User-Agent z konfiguracji', async () => {
    const { wywolania, fetchImpl } = szpieg({ shipments: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzPrzesylki('abc');

    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].opcje.headers['User-Agent']).toBe(UA);
  });

  // ⚠️ TO JEST TEST NA „STALA W KODZIE". Dwa testy wyzej przeszlyby tak samo, gdyby ktos
  // wpisal naglowek na sztywno w client.js — a Allegro pozwala zmieniac w nim WYLACZNIE
  // numer wersji (naglowek sluzy do umieszczenia aplikacji na bialej liscie). Wersja bedzie
  // rosla, wiec ma sie podnosic linia w `.env.oms`, a nie wydaniem panelu.
  it('wartość pochodzi z ustawień kanału, a nie ze stałej w module', async () => {
    const { wywolania, fetchImpl } = szpieg();
    const inny = { ...ustawienia, userAgent: 'InnaNazwa/9.9.9 (+https://inny.invalid/dok)' };
    const k = createAllegroClient({ ustawienia: inny, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: null, kursor: null, strona: 1 });

    expect(wywolania[0].opcje.headers['User-Agent']).toBe('InnaNazwa/9.9.9 (+https://inny.invalid/dok)');
    expect(wywolania[0].opcje.headers['User-Agent']).not.toBe(UA);
  });

  // ⚠️ TU STAL TEST „modul klienta nie zawiera ANI JEDNEJ metody zapisujacej". USUNIETY
  // 06.08.2026 razem z Zadaniem 3 Planu B: zakaz przestal byc prawdziwy, bo klient
  // zaczal pisac (`PUT …/fulfillment`). Nie zniknal bez zastapienia — jego role przejmuje
  // `describe('biała lista metod zapisujących')` w tests/oms/allegro-client-zapis.test.js,
  // ktora wylicza dozwolone metody i pilnuje, ze `POST …/shipments` nie wchodzi TYLNYMI
  // DRZWIAMI (nadanie paczki z OMS-u = druga, platna przesylka do klienta).
});
