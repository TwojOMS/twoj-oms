import { describe, it, expect, vi } from 'vitest';
import {
  createInpostClient,
  LIMIT_ZADANIA_MS,
  LIMIT_ZAPYTANIA_STATUS_MS,
} from '../../src/oms/kurierzy/inpost.js';

// ⚠️ ANI JEDNO WYWOLANIE NIE IDZIE DO PRAWDZIWEGO INPOSTU — caly plik rozmawia z atrapa
// `fetch`. Ksztalty odpowiedzi sa odwzorowane z rozpoznania na zywym koncie
// (docs/superpowers/notatki/2026-08-01-inpost-shipx-rozpoznanie.md, sekcja „Stany przesylki”),
// a token jest wymyslony.

const TOKEN = 'eyJTESTOWY.TOKEN-INPOST.SEKRET-KTORY-NIE-MA-PRAWA-WYCIEC';
const ORGANIZACJA = 13235;
const URL_API = 'https://shipx.test/v1';
const NUMER = '520000123456789012345678';

const nadawca = { nazwa: 'Lumina', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '338451234', email: 'sklep@szkicownia.pl' };

const json = (status, cialo) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof cialo === 'string' ? cialo : JSON.stringify(cialo)),
});

function klient(odpowiedz) {
  const fetchImpl = vi.fn().mockResolvedValue(odpowiedz);
  return {
    c: createInpostClient({ url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca, fetchImpl }),
    fetchImpl,
  };
}

// Ksztalt z rozpoznania: `status` na wierzchu + lista `tracking_details`, kazdy wpis ze
// stanem i znacznikiem czasu.
const sledzenie = (status, szczegoly) => ({
  tracking_number: NUMER,
  status,
  tracking_details: szczegoly,
});

describe('createInpostClient.statusPrzesylki — kontrakt wspólny z DPD', () => {
  it('pyta usługę śledzenia pod numerem przesyłki, z tokenem w nagłówku', async () => {
    const { c, fetchImpl } = klient(json(200, sledzenie('confirmed', [
      { status: 'confirmed', datetime: '2026-07-30T09:00:00.000+02:00' },
    ])));
    await c.statusPrzesylki(NUMER);
    const [adres, opcje] = fetchImpl.mock.calls[0];
    expect(adres).toBe(`${URL_API}/tracking/${NUMER}`);
    expect(opcje.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  // Ten sam kontrakt co dpd.statusPrzesylki: { opis, at } NAJNOWSZEGO zdarzenia.
  it('oddaje opis po polsku i czas najnowszego zdarzenia', async () => {
    const { c } = klient(json(200, sledzenie('delivered', [
      { status: 'confirmed', datetime: '2026-07-28T10:00:00.000+02:00' },
      { status: 'delivered', datetime: '2026-07-30T18:20:00.000+02:00' },
      { status: 'ready_to_pickup', datetime: '2026-07-29T14:00:00.000+02:00' },
    ])));
    expect(await c.statusPrzesylki(NUMER)).toEqual({
      opis: 'Odebrana przez klienta',
      at: '2026-07-30T18:20:00.000+02:00',
    });
  });

  // Najnowsze wybieramy PO CZASIE, a nie po kolejnosci w dokumencie — InPost nie obiecuje
  // sortowania listy, a odwrotna kolejnosc (najnowsze na gorze) jest w API rownie czesta.
  it('przy odwróconej kolejności listy nadal oddaje najnowsze zdarzenie', async () => {
    const { c } = klient(json(200, sledzenie('ready_to_pickup', [
      { status: 'ready_to_pickup', datetime: '2026-07-30T12:00:00.000+02:00' },
      { status: 'sent_from_source_branch', datetime: '2026-07-29T20:00:00.000+02:00' },
      { status: 'confirmed', datetime: '2026-07-28T08:00:00.000+02:00' },
    ])));
    expect((await c.statusPrzesylki(NUMER)).opis).toBe('Gotowa do odbioru w paczkomacie');
  });

  // Stany wymienione w planie + te widziane w `tracking_details` na zywym koncie.
  it.each([
    ['confirmed', 'Przesyłka zarejestrowana'],
    ['adopted_at_source_branch', 'Przyjęta w oddziale nadawczym'],
    ['sent_from_source_branch', 'Wysłana z oddziału nadawczego'],
    ['ready_to_pickup', 'Gotowa do odbioru w paczkomacie'],
    ['delivered', 'Odebrana przez klienta'],
    ['returned_to_sender', 'Zwrócona do nadawcy'],
  ])('stan %s ma opis dla człowieka: %s', async (stan, opis) => {
    const { c } = klient(json(200, sledzenie(stan, [{ status: stan, datetime: '2026-07-30T09:00:00.000+02:00' }])));
    expect((await c.statusPrzesylki(NUMER)).opis).toBe(opis);
  });

  // ⚠️ MUTACJA 3. InPost dolozy kiedys stan, ktorego dzis nie ma w slowniku. Taki stan NIE
  // MOZE ani zniknac (karta pokazywalaby wtedy „zdarzenie bez opisu" i nikt by sie nie
  // dowiedzial, ze cos sie stalo), ani udawac innego — bo „Odebrana przez klienta" przy
  // paczce, ktora wlasnie poszla na zwrot, to klamstwo, na ktorym operator oprze decyzje.
  it('nieznany stan pokazuje się WPROST, razem z surowym kodem', async () => {
    const { c } = klient(json(200, sledzenie('avizo', [
      { status: 'confirmed', datetime: '2026-07-28T10:00:00.000+02:00' },
      { status: 'oversized_parcel_at_branch', datetime: '2026-07-31T11:00:00.000+02:00' },
    ])));
    const wynik = await c.statusPrzesylki(NUMER);
    expect(wynik.at).toBe('2026-07-31T11:00:00.000+02:00');
    // Surowy kod MUSI byc widoczny — to jedyne, po czym czlowiek pozna, o co chodzi.
    expect(wynik.opis).toContain('oversized_parcel_at_branch');
    // ...i nie wolno mu udawac zadnego ze znanych opisow.
    expect(wynik.opis).not.toContain('Odebrana');
    expect(wynik.opis).not.toContain('Gotowa do odbioru');
    expect(wynik.opis).not.toContain('Zarejestrowana');
  });

  // Swiezo utworzona przesylka nie ma jeszcze historii. To NIE jest awaria — panel ma
  // pokazac „brak zdarzen", a nie blad (dokladnie jak przy DPD).
  it('brak zdarzeń → null zamiast błędu', async () => {
    const { c } = klient(json(200, sledzenie('created', [])));
    expect(await c.statusPrzesylki(NUMER)).toBeNull();
  });

  it('brak samego klucza tracking_details → null, nie wyjątek', async () => {
    const { c } = klient(json(200, { tracking_number: NUMER, status: 'created' }));
    expect(await c.statusPrzesylki(NUMER)).toBeNull();
  });

  // Zdarzenie bez czasu odrzucamy: nie da sie go porownac z innymi ani powiedziec
  // operatorowi „kiedy". Ta sama swiadoma asymetria co w dpd.js.
  it('zdarzenie bez znacznika czasu nie rozjeżdża opisu z czasem', async () => {
    const { c } = klient(json(200, sledzenie('delivered', [
      { status: 'confirmed', datetime: '2026-07-28T10:00:00.000+02:00' },
      { status: 'returned_to_sender' },
      { status: 'delivered', datetime: '2026-07-30T18:20:00.000+02:00' },
    ])));
    expect(await c.statusPrzesylki(NUMER)).toEqual({
      opis: 'Odebrana przez klienta',
      at: '2026-07-30T18:20:00.000+02:00',
    });
  });

  // ⚠️ NAJWAZNIEJSZE ROZROZNIENIE TEGO PLIKU, a do 2026-08-04 go tu NIE BYLO: „nie rozumiem
  // zdarzen" nie moze wygladac jak „nie ma zdarzen".
  //
  // Nazwa pola ze znacznikiem czasu jest ZGADNIETA (POLA_CZASU w inpost.js) — rozpoznanie
  // ShipX jej nie podaje. Gdyby zgadywanie bylo chybione, KAZDA paczkomatowa paczka
  // pokazywalaby „brak zdarzen" NA ZAWSZE, znacznik proby zapisywalby sie bez bledu i nikt
  // nigdy by sie nie dowiedzial, ze sledzenie w ogole nie dziala — wygladaloby to identycznie
  // jak przesylka nadana przed chwila. To jest sygnal POMIAROWY na pierwsze prawdziwe
  // nadanie, wiec ma byc widoczny na karcie jako awaria, a nie milczec.
  it('InPost oddał zdarzenia, ale ŻADNE nie ma czasu → odmowa operatorska, nie „brak zdarzeń"', async () => {
    const { c } = klient(json(200, sledzenie('confirmed', [{ status: 'confirmed' }])));
    const blad = await c.statusPrzesylki(NUMER).catch((e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.dlaOperatora).toBe(true);
    // Komunikat ma powiedziec WPROST, co panel zobaczyl i czego w tym nie znalazl — inaczej
    // czytajacy uzna to za zwykla awarie sieci i przegapi jedyna okazje do poprawki.
    expect(blad.message).toContain('zdarzenia');
    expect(blad.message).toMatch(/znacznik/i);
  });

  // ...ale rozroznienie dziala w OBIE strony: lista naprawde pusta to nadal NIE awaria.
  it('lista zdarzeń pusta (świeża przesyłka) dalej daje null, nie błąd', async () => {
    const { c } = klient(json(200, sledzenie('confirmed', [])));
    expect(await c.statusPrzesylki(NUMER)).toBeNull();
  });

  // Zdarzenie bez stanu ZOSTAJE (czas sam w sobie jest informacja), ale opis jest `null`,
  // a NIE `undefined` — node:sqlite nie potrafi zbindowac undefined („Provided value cannot
  // be bound"), a ten blad ginal juz raz w try/catch odpornosci karty.
  it('zdarzenie bez stanu oddaje opis null (nie undefined) i zachowuje swój czas', async () => {
    const { c } = klient(json(200, sledzenie('confirmed', [
      { datetime: '2026-07-30T09:00:00.000+02:00' },
    ])));
    const wynik = await c.statusPrzesylki(NUMER);
    expect(wynik.at).toBe('2026-07-30T09:00:00.000+02:00');
    expect(wynik.opis).toBeNull();
    expect(Object.hasOwn(wynik, 'opis')).toBe(true);
  });

  // Czas porownujemy PO PARSOWANIU, nie tekstowo: InPost oddaje znaczniki z przesunieciem
  // strefy, wiec '2026-07-30T23:30:00+02:00' jest WCZESNIEJSZE niz '2026-07-31T00:30:00+03:00'
  // mimo ze tekstowo wyglada odwrotnie... i odwrotnie: porownanie tekstowe myli sie tam,
  // gdzie przesuniecia sie roznia.
  it('czas porównuje po wartości, a nie po tekście (przesunięcia stref)', async () => {
    const { c } = klient(json(200, sledzenie('delivered', [
      // 22:30 UTC — PÓŹNIEJSZE, choć tekstowo mniejsze.
      { status: 'delivered', datetime: '2026-07-31T00:30:00.000+02:00' },
      // 21:35 UTC — WCZEŚNIEJSZE, choć tekstowo większe.
      { status: 'ready_to_pickup', datetime: '2026-07-30T23:35:00.000+02:00' },
    ])));
    expect((await c.statusPrzesylki(NUMER)).opis).toBe('Odebrana przez klienta');
  });
});

describe('createInpostClient.statusPrzesylki — HTTP 200 nie znaczy sukces', () => {
  // Ta zasada jest w tym module juz w kilku miejscach (etykieta sprawdzana sygnatura,
  // nadanie sprawdzane po `id`). Tutaj: odpowiedz musi WYGLADAC jak sledzenie przesylki.
  it('200 z HTML-em od proxy to błąd, a nie „brak zdarzeń"', async () => {
    const { c } = klient(json(200, '<html><body>502 Bad Gateway</body></html>'));
    const blad = await c.statusPrzesylki(NUMER).catch((e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toMatch(/status/i);
  });

  it('200 z JSON-em bez śladu przesyłki to też błąd', async () => {
    const { c } = klient(json(200, { cokolwiek: true }));
    await expect(c.statusPrzesylki(NUMER)).rejects.toThrow();
  });

  it('404 (nieznany numer) jest błędem operatora z czytelnym powodem', async () => {
    const { c } = klient(json(404, { status: 404, error: 'resource_not_found', message: 'Nie znaleziono przesyłki' }));
    const blad = await c.statusPrzesylki(NUMER).catch((e) => e);
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toContain('Nie znaleziono przesyłki');
  });

  it('nieosiągalny InPost to błąd operatora, nie surowy wyjątek sterownika', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const c = createInpostClient({ url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca, fetchImpl });
    const blad = await c.statusPrzesylki(NUMER).catch((e) => e);
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toContain('ECONNREFUSED');
  });

  // ⚠️ TOKEN TO SEKRET, a komunikat bledu trafia do bazy i do logu zamowienia.
  it('błąd nie ujawnia tokenu', async () => {
    const { c } = klient(json(500, `Bearer ${TOKEN} rejected by upstream`));
    const blad = await c.statusPrzesylki(NUMER).catch((e) => e);
    expect(blad.message).not.toContain(TOKEN);
    expect(blad.message).toContain('rejected by upstream');
  });

  // Karta zamowienia czeka na te odpowiedz SYNCHRONICZNIE przy kazdym otwarciu — dokladnie
  // ten sam powod, dla ktorego dpd.js ma osobny LIMIT_ZAPYTANIA_STATUS_MS. Limit nadania
  // (30 s) na tej sciezce zawiesilby karte na pol minuty RAZY liczba paczek.
  it('zapytanie o status niesie własny AbortSignal', async () => {
    const { c, fetchImpl } = klient(json(200, sledzenie('confirmed', [
      { status: 'confirmed', datetime: '2026-07-30T09:00:00.000+02:00' },
    ])));
    await c.statusPrzesylki(NUMER);
    const { signal } = fetchImpl.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('limit statusu jest KRÓTSZY niż limit nadania i niż domyślne 300 s undici', () => {
    expect(LIMIT_ZAPYTANIA_STATUS_MS).toBeGreaterThan(0);
    expect(LIMIT_ZAPYTANIA_STATUS_MS).toBeLessThan(LIMIT_ZADANIA_MS);
    expect(LIMIT_ZAPYTANIA_STATUS_MS).toBeLessThan(300_000);
  });

  // ⚠️ DWA TESTY WYZEJ NIE PILNUJA MIEJSCA UZYCIA. Jeden sprawdza, ze sygnal to AbortSignal
  // i nie jest przerwany (prawda dla KAZDEGO limitu), drugi porownuje dwie stale ZE SOBA
  // (prawda niezaleznie od tego, ktora pojechala do fetcha). Podmiana trzeciego argumentu
  // `wywolaj(...)` w statusPrzesylki na LIMIT_ZADANIA_MS zostawiala caly plik na zielono,
  // a karta wisialaby 30 s RAZY liczba paczek zamiast 5 s.
  //
  // `AbortSignal.timeout` w Node 24 jest `writable: true, configurable: true`, wiec da sie
  // je podejrzec szpiegiem — a szpieg bez `mockImplementation` zachowuje oryginal, wiec
  // sygnal dalej jest prawdziwy.
  it('zapytanie o status jedzie NA LIMICIE STATUSU, nie na limicie nadania', async () => {
    const szpieg = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { c } = klient(json(200, sledzenie('confirmed', [
        { status: 'confirmed', datetime: '2026-07-30T09:00:00.000+02:00' },
      ])));
      await c.statusPrzesylki(NUMER);
      expect(szpieg).toHaveBeenCalledTimes(1);
      expect(szpieg).toHaveBeenCalledWith(LIMIT_ZAPYTANIA_STATUS_MS);
      expect(szpieg).not.toHaveBeenCalledWith(LIMIT_ZADANIA_MS);
    } finally {
      szpieg.mockRestore();
    }
  });

  // Numer idzie do SCIEZKI, wiec musi byc zakodowany. Fikstura NUMER to same cyfry, wiec
  // skasowanie encodeURIComponent nie ruszalo zadnego testu — a zalozenie o cudzym formacie
  // numeru jest wlasnie zalozeniem. `domain/tracking.js` ma na to swoj test, klient nie mial.
  it('numer ze znakiem specjalnym jest zakodowany w ścieżce, nie pyta o inny zasób', async () => {
    const { c, fetchImpl } = klient(json(200, sledzenie('confirmed', [
      { status: 'confirmed', datetime: '2026-07-30T09:00:00.000+02:00' },
    ])));
    await c.statusPrzesylki('520000/123?456');
    const [adres] = fetchImpl.mock.calls[0];
    expect(adres).toBe(`${URL_API}/tracking/520000%2F123%3F456`);
    expect(adres).not.toContain('?456');
  });
});
