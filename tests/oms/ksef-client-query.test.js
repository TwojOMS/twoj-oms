import { describe, it, expect } from 'vitest';
import { createKsefClient, ROZMIAR_STRONY } from '../../src/oms/ksef/client.js';

// `expect(...).rejects` na obietnicy, ktora sie SPELNI, jest bledem testu — a `.catch(fn)`
// z asercja w srodku przechodzi wtedy PUSTO (funkcja nigdy nie leci). Ta sama pomocnicza,
// co w ksef-client-auth.test.js (kazdy plik testowy trzyma wlasna kopie).
async function zlapBlad(obietnica) {
  let zlapany = null;
  try {
    await obietnica;
  } catch (e) {
    zlapany = e;
  }
  if (!zlapany) throw new Error('oczekiwano odmowy, a wywołanie zakończyło się powodzeniem');
  return zlapany;
}

describe('klient KSeF — metadane faktur', () => {
  it('pyta o NABYWCE, po dacie trwalego zapisu, rosnaco i pelna strona', async () => {
    let zapisane = null;
    const fetchImpl = async (url, opcje) => {
      zapisane = { url, cialo: JSON.parse(opcje.body) };
      return { ok: true, status: 200, json: async () => ({ invoices: [], hasMore: false, isTruncated: false }) };
    };
    const klient = createKsefClient({ token: 'T', nip: '1000001193', fetchImpl });
    await klient.pobierzMetadane({ accessToken: 'ACC', from: '2026-05-01T00:00:00Z', to: '2026-06-01T00:00:00Z', pageOffset: 2 });

    expect(zapisane.cialo.subjectType).toBe('Subject2');
    expect(zapisane.cialo.dateRange.dateType).toBe('PermanentStorage');
    expect(zapisane.url).toContain('sortOrder=Asc');
    expect(zapisane.url).toContain('pageOffset=2');
    expect(zapisane.url).toContain(`pageSize=${ROZMIAR_STRONY}`);
  });

  it('⚠️ rozmiar strony to 250, nigdy domyslne 10', () => {
    expect(ROZMIAR_STRONY).toBe(250);
  });

  it('oddaje faktury i oba znaczniki kontynuacji', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ invoices: [{ ksefNumber: 'K1' }], hasMore: true, isTruncated: true }) });
    const wynik = await createKsefClient({ token: 'T', nip: '1', fetchImpl })
      .pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b', pageOffset: 0 });
    expect(wynik).toEqual({
      faktury: [{ ksefNumber: 'K1' }], hasMore: true, isTruncated: true, koniecNiepewny: false,
    });
  });

  it('accessToken idzie jako bearer, a zadanie niesie naglowek problem-details', async () => {
    let widziane = null;
    const fetchImpl = async (url, opcje) => {
      widziane = opcje.headers;
      return { ok: true, status: 200, json: async () => ({ invoices: [], hasMore: false, isTruncated: false }) };
    };
    await createKsefClient({ token: 'T', nip: '1', fetchImpl })
      .pobierzMetadane({ accessToken: 'ACC-XYZ', from: 'a', to: 'b' });

    expect(widziane.Authorization).toBe('Bearer ACC-XYZ');
    expect(widziane['X-Error-Format']).toBe('problem-details');
  });

  // ⚠️ STRAZNIK KSZTALTU JEST TERAZ ASYMETRYCZNY, CELOWO. Tablica `invoices` zostaje
  // wymaganiem twardym (brak tablicy faktur to jedyny przypadek nie do odroznienia od
  // pustego wyniku), ALE `hasMore`/`isTruncated` juz NIE. `hasMore: false` to normalny stan
  // koncowy kazdego nocnego przebiegu, a wiele API pomija pole, ktore nie ma zastosowania
  // (`isTruncated` przy `hasMore: false`) — tego nie zmierzono jeszcze na zywym KSeF
  // (Zadanie 0), wiec dzis nie zaostrzamy kontraktu ponad to, co wiadomo.
  it('odpowiedz bez tablicy invoices to czytelna odmowa, nie cichy pusty komplet', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b' }));

    expect(e.message).toContain('KSeF nie oddał poprawnej listy faktur');
    expect(e.dlaOperatora).toBe(true);
  });

  // ⚠️⚠️ DEGRADACJA ZOSTAJE, ALE PRZESTAJE BYĆ NIEWIDOCZNA (recenzja, W3). Zejście brakującego
  // `hasMore` do `false` jest świadome, ale kończy okno pobrania DOKŁADNIE tak samo, jak
  // prawdziwy koniec danych — a jeśli KSeF pomija to pole na stronie MAJĄCEJ następniki, ogon
  // okna nie zostaje przeczytany nigdy, bo kursor przeskakuje go razem z ostatnim oknem.
  // Klient jest jedynym miejscem, które wie, że wartość została zgadnięta, więc to on nazywa
  // skutek; decyzję podejmuje czuwacz (services/czuwacz-kosztow.js).
  //
  // ⚠️ NIEPEWNOŚĆ WYMAGA PEŁNEJ STRONY. Strona krótsza niż `ROZMIAR_STRONY` następnika mieć
  // nie może, więc pusta odpowiedź BEZ `hasMore` — czyli zwyczajna noc bez nowych faktur —
  // jest końcem PEWNYM. Inaczej ostrzeżenie zapalałoby się co noc i przestałoby cokolwiek
  // znaczyć, przykrywając następną, prawdziwą awarię pobierania.
  it('odpowiedz z pusta tablica invoices i BEZ hasMore/isTruncated to zero faktur i koniec PEWNY', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ invoices: [] }) });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const wynik = await klient.pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b' });

    expect(wynik).toEqual({
      faktury: [], hasMore: false, isTruncated: false, koniecNiepewny: false,
    });
  });

  it('⚠️ PELNA strona BEZ hasMore to koniec NIEPEWNY — moze miec nastepnik, ktorego nikt nie zapowiedzial', async () => {
    const pelna = Array.from({ length: ROZMIAR_STRONY }, (_, i) => ({ ksefNumber: `K${i}` }));
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ invoices: pelna }) });
    const wynik = await createKsefClient({ token: 'T', nip: '1', fetchImpl })
      .pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b' });

    expect(wynik.koniecNiepewny).toBe(true);
  });

  it('jawne hasMore: false konczy PEWNIE takze na pelnej stronie — to zdanie KSeF-u, nie nasz domysl', async () => {
    const pelna = Array.from({ length: ROZMIAR_STRONY }, (_, i) => ({ ksefNumber: `K${i}` }));
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ invoices: pelna, hasMore: false }) });
    const wynik = await createKsefClient({ token: 'T', nip: '1', fetchImpl })
      .pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b' });

    expect(wynik.koniecNiepewny).toBe(false);
  });

  // ⚠️ ELEMENT LISTY, KTÓRY NIE JEST DOKUMENTEM (recenzja, D3). Bez tego strażnika `naWiersz`
  // wywala się na nim gołym `TypeError`-em BEZ znacznika `dlaOperatora`, więc kwarantanna go
  // nie przyjmuje, przebieg pada, kursor stoi — i tak co noc, z komunikatem „błąd techniczny
  // panelu", z którego nie wynika nic. Kształt CAŁEJ odpowiedzi jest faktem o odpowiedzi,
  // a nie o jednym dokumencie, więc mieszka tu, obok strażnika tablicy `invoices`.
  it.each([[null], [42], ['K1'], [['K1']]])(
    '⚠️ element listy faktur, ktory nie jest dokumentem (%p), to czytelna odmowa — nie goly TypeError',
    async (zly) => {
      const fetchImpl = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ invoices: [{ ksefNumber: 'K1' }, zly], hasMore: false, isTruncated: false }),
      });
      const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
      const e = await zlapBlad(klient.pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b' }));

      expect(e.message).toMatch(/pozycj/i);
      expect(e.dlaOperatora).toBe(true);
    },
  );

  it('pusta odpowiedz (null) to czytelna odmowa, nie TypeError', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => null });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzMetadane({ accessToken: 'ACC', from: 'a', to: 'b' }));

    expect(e.message).toContain('KSeF nie oddał poprawnej listy faktur');
    expect(e.dlaOperatora).toBe(true);
  });
});

describe('klient KSeF — pobranie XML dokumentu (archiwum)', () => {
  it('GET z bearer i naglowkiem problem-details, oddaje SUROWY TEKST, nie JSON', async () => {
    let widziane = null;
    const fetchImpl = async (url, opcje) => {
      widziane = { url, opcje };
      return {
        ok: true,
        status: 200,
        text: async () => '<Faktura>tresc</Faktura>',
        // ⚠️ CELOWO BRAK `json` — gdyby `pobierzXml` przypadkiem jechal przez `zapytaj`
        // (ktora parsuje KAZDA odpowiedz jako JSON), ten test wywalilby sie TypeError-em
        // zamiast po cichu zwrocic `null` i zgubic tresc dokumentu.
      };
    };
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const xml = await klient.pobierzXml({ accessToken: 'ACC-XML', ksefNumber: '1000001193-20260605-0100AB-CD' });

    expect(xml).toBe('<Faktura>tresc</Faktura>');
    expect(widziane.url).toContain('/invoices/ksef/1000001193-20260605-0100AB-CD');
    expect(widziane.opcje.method).toBe('GET');
    expect(widziane.opcje.headers.Authorization).toBe('Bearer ACC-XML');
    expect(widziane.opcje.headers['X-Error-Format']).toBe('problem-details');
  });

  it('koduje numer KSeF w adresie (ukosniki i inne znaki specjalne w URL)', async () => {
    let widzianyUrl = null;
    const fetchImpl = async (url) => { widzianyUrl = url; return { ok: true, status: 200, text: async () => 'x' }; };
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    await klient.pobierzXml({ accessToken: 'ACC', ksefNumber: 'A/B C' });

    expect(widzianyUrl).toContain(encodeURIComponent('A/B C'));
    expect(widzianyUrl).not.toContain('A/B C');
  });

  it('HTTP odmowa to czytelna odmowa z numerem dokumentu i statusem, nie goly wyjatek', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ detail: 'Nie znaleziono' }) });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzXml({ accessToken: 'ACC', ksefNumber: 'K-1' }));

    expect(e.message).toContain('K-1');
    expect(e.message).toContain('404');
    expect(e.dlaOperatora).toBe(true);
  });

  it('⚠️ HTTP 200 z pusta trescia to czytelna odmowa — inaczej archiwum dostalby pusty plik', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzXml({ accessToken: 'ACC', ksefNumber: 'K-1' }));

    expect(e.message).toContain('K-1');
    expect(e.dlaOperatora).toBe(true);
  });

  // ⚠️⚠️ HTTP 429 TO PROSBA O PRZERWE, A NIE AWARIA ZRODLA. Zmierzone na produkcji 2026-09-02:
  // po 16 XML-ach pobranych w ~20 s KSeF odbijal kazde kolejne zadanie zdaniem „Przekroczono
  // limit 16 zadan na minute. Sprobuj ponownie po 54 sekundach", a trzy takie odmowy z rzedu
  // przerywaly archiwizacje jako „martwe zrodlo". Zeby wolajacy mogl POCZEKAC zamiast sie
  // poddac, blad musi niesc DWIE rzeczy: status i liczbe sekund. Bez nich `zCzekaniemNa429`
  // (ksef/limit.js) ma tylko tresc zdania — a na tresci zdania nie wolno budowac logiki.
  it('⚠️ HTTP 429 niesie status i liczbe sekund do ponowienia (z tresci odmowy)', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      // Atrapa BEZ naglowkow — dokladnie tak odpowiadal KSeF na produkcji.
      text: async () => JSON.stringify({
        detail: 'Przekroczono limit 16 żądań na minutę. Spróbuj ponownie po 54 sekundach.',
      }),
    });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzXml({ accessToken: 'ACC', ksefNumber: 'K-1' }));

    expect(e.status).toBe(429);
    expect(e.retryAfterS).toBe(54);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('K-1');
  });

  it('naglowek Retry-After ma pierwszenstwo przed trescia odmowy', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) },
      text: async () => JSON.stringify({ detail: 'Spróbuj ponownie po 54 sekundach.' }),
    });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzXml({ accessToken: 'ACC', ksefNumber: 'K-1' }));

    expect(e.retryAfterS).toBe(30);
  });

  // Odmowa, ktora NIE jest limitem, nie ma prawa dostac czasu ponowienia — inaczej
  // `zCzekaniemNa429` czekaloby minute na kazdym 404, ktory nigdy sie nie naprawi.
  it('odmowa spoza limitu nie niesie czasu ponowienia', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ detail: 'Nie znaleziono' }) });
    const klient = createKsefClient({ token: 'T', nip: '1', fetchImpl });
    const e = await zlapBlad(klient.pobierzXml({ accessToken: 'ACC', ksefNumber: 'K-1' }));

    expect(e.status).toBe(404);
    expect(e.retryAfterS ?? null).toBeNull();
  });
});
