import {
  describe, it, expect, vi,
} from 'vitest';
import { createKsefClient, NAJWIECEJ_PYTAN } from '../../src/oms/ksef/client.js';
import { zaszyfrujToken } from '../../src/oms/ksef/szyfrowanie.js';
import { certyfikatTestowy } from './_ksef-pomocniki.js';

// Podglad wywolan `zaszyfrujToken` BEZ podmiany zachowania: fabryka deleguje do oryginalu,
// wiec pozostale testy (dlugosc szyfrogramu, brak tokena w ciele) sprawdzaja prawdziwe
// szyfrowanie. To jedyny sposob, zeby zobaczyc, JAKI timestamp poszedl do srodka —
// OAEP jest randomizowane, wiec z zewnatrz kazdy szyfrogram wyglada tak samo.
vi.mock('../../src/oms/ksef/szyfrowanie.js', async (importOriginal) => {
  const oryginal = await importOriginal();
  return { ...oryginal, zaszyfrujToken: vi.fn(oryginal.zaszyfrujToken) };
});

function atrapa(odpowiedzi) {
  const wywolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wywolania.push({
      url,
      metoda: opcje.method ?? 'GET',
      naglowki: opcje.headers ?? {},
      cialo: opcje.body ?? null,
      sygnal: opcje.signal ?? null,
    });
    const klucz = Object.keys(odpowiedzi).find((k) => url.includes(k));
    // ⚠️ JAWNA ODMOWA NA NIEZNANY ADRES. Wczesniej atrapa siegala po `.status` po `undefined`
    // i wywalala sie TypeError-em w srodku `fetchImpl` — a `zapytaj` polyka kazdy wyjatek
    // z fetcha jako „KSeF nieosiagalny". Zla sciezka w implementacji udawalaby wiec awarie
    // sieci. Ten rzut ma w tresci nazwe atrapy, zeby bylo widac, ze to problem testu.
    if (klucz === undefined) throw new Error(`atrapa testowa: nieznany URL ${url}`);
    const dane = odpowiedzi[klucz];
    return {
      ok: true, status: dane.status ?? 200, json: async () => dane.body, text: async () => '',
    };
  };
  return { fetchImpl, wywolania };
}

// `expect(...).rejects` na obietnicy, ktora sie SPELNI, jest bledem testu — a `.catch(fn)`
// z asercja w srodku przechodzi wtedy PUSTO (funkcja nigdy nie leci). Ta pomocnicza oddaje
// zlapany blad albo sama wywala test.
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

const bazowe = {
  'security/public-key-certificates': { body: [{ certificate: certyfikatTestowy() }] },
  'auth/challenge': { body: { challenge: '2026-CR-1', timestampMs: 1752236636015 } },
  'auth/ksef-token': {
    status: 202,
    body: {
      referenceNumber: 'REF-1',
      authenticationToken: { token: 'OP-TOK', validUntil: '2026-08-12T23:00:00Z' },
    },
  },
  'auth/REF-1': { body: { status: { code: 200, description: 'OK' } } },
  'auth/token/redeem': {
    body: {
      accessToken: { token: 'ACC', validUntil: '2026-08-12T21:00:00Z' },
      refreshToken: { token: 'REF', validUntil: '2026-09-12T21:00:00Z' },
    },
  },
};

describe('klient KSeF — uwierzytelnienie', () => {
  it('przechodzi challenge → ksef-token → status → redeem i oddaje pare tokenow', async () => {
    const { fetchImpl, wywolania } = atrapa(bazowe);
    const klient = createKsefClient({ token: 'T', nip: '1000001193', fetchImpl });
    const wynik = await klient.zaloguj();

    expect(wynik).toEqual({
      accessToken: 'ACC',
      accessDo: '2026-08-12T21:00:00Z',
      refreshToken: 'REF',
      refreshDo: '2026-09-12T21:00:00Z',
    });
    expect(wywolania.map((w) => w.url.split('/v2/')[1])).toEqual([
      'security/public-key-certificates', 'auth/challenge', 'auth/ksef-token',
      'auth/REF-1', 'auth/token/redeem',
    ]);
  });

  it('kazde zadanie niesie naglowek problem-details', async () => {
    const { fetchImpl, wywolania } = atrapa(bazowe);
    await createKsefClient({ token: 'T', nip: '1000001193', fetchImpl }).zaloguj();
    for (const w of wywolania) expect(w.naglowki['X-Error-Format']).toBe('problem-details');
  });

  // Limit czasu jest NARZUCONY, a nie domyslny — zwis na ktorymkolwiek z pieciu zadan
  // zostawilby uwierzytelnianie wiszace bez konca, a przy `redeem` jeszcze bez odpowiedzi
  // na pytanie, czy jednorazowa para zostala juz wydana.
  it('kazde zadanie ma wlasny, twardy limit czasu', async () => {
    const { fetchImpl, wywolania } = atrapa(bazowe);
    await createKsefClient({ token: 'T', nip: '1000001193', fetchImpl }).zaloguj();
    expect(wywolania).toHaveLength(5);
    for (const w of wywolania) expect(w.sygnal).toBeInstanceOf(AbortSignal);
    // Wlasny sygnal na kazde zadanie — wspolny starzalby sie razem z procesem.
    expect(new Set(wywolania.map((w) => w.sygnal)).size).toBe(5);
  });

  it('status i redeem ida na TOKEN OPERACJI, nie na token KSeF', async () => {
    const { fetchImpl, wywolania } = atrapa(bazowe);
    await createKsefClient({ token: 'T', nip: '1000001193', fetchImpl }).zaloguj();
    const stan = wywolania.find((w) => w.url.endsWith('/auth/REF-1'));
    const redeem = wywolania.find((w) => w.url.includes('token/redeem'));
    expect(stan.naglowki.Authorization).toBe('Bearer OP-TOK');
    expect(redeem.naglowki.Authorization).toBe('Bearer OP-TOK');
  });

  it('komunikat bledu NIE niesie tokena (niezmiennik 4.10)', async () => {
    const fetchImpl = async () => ({
      ok: false, status: 401, json: async () => ({ detail: 'Nieprawidlowy token' }), text: async () => '',
    });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF odmówił przy pobieraniu kluczy MF: HTTP 401');
    expect(e.message).toContain('Nieprawidlowy token');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    // Zdanie napisane dla czlowieka ma do niego dojsc, a nie zamienic sie w „blad techniczny".
    expect(e.dlaOperatora).toBe(true);
    // Status niesiemy dalej tak samo, jak klient inFaktu — kolejne zadanie (czuwacz) rozroznia
    // po nim odmowe JEDNOZNACZNA (4xx) od „nie wiadomo, sprobuj pozniej".
    expect(e.status).toBe(401);
  });

  // Ponizsze przypadki wychodza poza brief — sa tu, bo dotykaja dwoch rzeczy, ktorych brief
  // nie pokrywa, a ktore kosztuja najwiecej, gdy sie zepsuja: petli odpytywania o stan
  // (jedyne miejsce, ktore moze zapetlic panel) i jednorazowego `redeem`.

  it('czeka, dopoki stan mowi „w toku", i dopiero potem odbiera tokeny', async () => {
    let ile = 0;
    const odpowiedzi = {
      ...bazowe,
      'auth/REF-1': { body: { status: { code: 100, description: 'W toku' } } },
    };
    const { fetchImpl, wywolania } = atrapa(odpowiedzi);
    const opoznienia = [];
    const klient = createKsefClient({
      token: 'T',
      nip: '1000001193',
      fetchImpl: async (url, opcje) => {
        if (url.endsWith('/auth/REF-1')) {
          ile += 1;
          if (ile >= 3) odpowiedzi['auth/REF-1'] = bazowe['auth/REF-1'];
        }
        return fetchImpl(url, opcje);
      },
      spij: async (ms) => { opoznienia.push(ms); },
    });
    const wynik = await klient.zaloguj();

    expect(ile).toBe(3);
    expect(opoznienia).toEqual([2000, 2000]);
    expect(wynik.accessToken).toBe('ACC');
    // `redeem` dziala TYLKO RAZ — ma poleciec dokladnie jeden raz, po ostatnim pytaniu o stan.
    expect(wywolania.filter((w) => w.url.includes('token/redeem'))).toHaveLength(1);
  });

  it('gdy stan do konca mowi „w toku", ODMAWIA zamiast palic jednorazowy redeem', async () => {
    const { fetchImpl, wywolania } = atrapa({
      ...bazowe,
      'auth/REF-1': { body: { status: { code: 100, description: 'W toku' } } },
    });
    const opoznienia = [];
    const klient = createKsefClient({
      token: 'SEKRET-TOKEN-123',
      nip: '1000001193',
      fetchImpl,
      spij: async (ms) => { opoznienia.push(ms); },
    });

    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF nie potwierdził uwierzytelnienia');
    expect(e.message).toContain('Odbioru tokenów nie próbowano');
    expect(e.message).toContain('W toku');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
    // Komunikat ma nie klamac o czasie: 30 pytan po 60 s limitu to nie „60 s", tylko minuty.
    expect(e.message).not.toContain('(60 s)');
    expect(e.message).toMatch(/\d+ min/);
    expect(wywolania.filter((w) => w.url.includes('token/redeem'))).toHaveLength(0);
    expect(wywolania.filter((w) => w.url.endsWith('/auth/REF-1'))).toHaveLength(NAJWIECEJ_PYTAN);
    // Po OSTATNIM pytaniu nie ma juz na co czekac — przerwa przed odmowa to czysta strata.
    expect(opoznienia).toHaveLength(NAJWIECEJ_PYTAN - 1);
  });

  // ⚠️ NAJDROZSZY PRZYPADEK CALEGO MODULU. Straznik odmowy MUSI bronic takze przypadku
  // „nie wiadomo": pusta tresc, nie-JSON albo `{}` to legalnie `null`/brak `status` z `zapytaj`,
  // a wtedy petla konczy sie po pierwszym pytaniu. Gdyby po niej isc po tokeny, klient
  // spalilby jednorazowy `redeem` na uwierzytelnieniu, o ktorym NIC nie wiadomo.
  it('gdy stan jest NIEZNANY (pusta odpowiedz), ODMAWIA zamiast palic redeem', async () => {
    const { fetchImpl, wywolania } = atrapa({ ...bazowe, 'auth/REF-1': { body: null } });
    const klient = createKsefClient({
      token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl, spij: async () => {},
    });

    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF nie podał stanu uwierzytelnienia');
    expect(e.message).toContain('Odbioru tokenów nie próbowano');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
    expect(wywolania.filter((w) => w.url.includes('token/redeem'))).toHaveLength(0);
  });

  it('gdy stan przychodzi bez pola status, ODMAWIA zamiast palic redeem', async () => {
    const { fetchImpl, wywolania } = atrapa({ ...bazowe, 'auth/REF-1': { body: {} } });
    const klient = createKsefClient({
      token: 'T', nip: '1000001193', fetchImpl, spij: async () => {},
    });

    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF nie podał stanu uwierzytelnienia');
    expect(wywolania.filter((w) => w.url.includes('token/redeem'))).toHaveLength(0);
  });

  // ⚠️ TIMESTAMP POCHODZI Z CHALLENGE-A — to jedyne wiazace ograniczenie tej sekwencji,
  // ktore psuje sie CICHO: podmiana na `Date.now()` nie zmienia niczego w WYGLADZIE
  // szyfrogramu (OAEP jest randomizowane), a MF odrzuca uwierzytelnienie.
  it('szyfruje token timestampem Z CHALLENGE-A, a nie biezacym czasem', async () => {
    zaszyfrujToken.mockClear();
    const { fetchImpl } = atrapa({
      ...bazowe,
      'auth/challenge': { body: { challenge: '2026-CR-9', timestampMs: 1699999999123 } },
    });
    await createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl }).zaloguj();

    expect(zaszyfrujToken).toHaveBeenCalledTimes(1);
    const argumenty = zaszyfrujToken.mock.calls[0][0];
    expect(argumenty.timestampMs).toBe(1699999999123);
    expect(argumenty.token).toBe('SEKRET-TOKEN-123');
  });

  it('odswiez() idzie refresh tokenem i oddaje sam access token', async () => {
    const { fetchImpl, wywolania } = atrapa({
      'auth/token/refresh': {
        body: { accessToken: { token: 'ACC-2', validUntil: '2026-08-13T09:00:00Z' } },
      },
    });
    const klient = createKsefClient({ token: 'T', nip: '1000001193', fetchImpl });
    const wynik = await klient.odswiez('REF-TOKEN');

    expect(wynik).toEqual({ accessToken: 'ACC-2', accessDo: '2026-08-13T09:00:00Z' });
    expect(wywolania).toHaveLength(1);
    expect(wywolania[0].metoda).toBe('POST');
    expect(wywolania[0].naglowki.Authorization).toBe('Bearer REF-TOKEN');
    expect(wywolania[0].naglowki['X-Error-Format']).toBe('problem-details');
  });

  it('zerwane polaczenie to osobny komunikat i tez bez poswiadczen', async () => {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF nieosiągalny przy pobieraniu kluczy MF: ECONNRESET');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
  });

  it('NIP i challenge jada w ciele, a token KSeF wylacznie zaszyfrowany', async () => {
    const { fetchImpl, wywolania } = atrapa(bazowe);
    await createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl }).zaloguj();
    const init = wywolania.find((w) => w.url.includes('auth/ksef-token'));
    const cialo = JSON.parse(init.cialo);

    expect(cialo.challenge).toBe('2026-CR-1');
    expect(cialo.contextIdentifier).toEqual({ type: 'Nip', value: '1000001193' });
    expect(init.cialo).not.toContain('SEKRET-TOKEN-123');
    expect(typeof cialo.encryptedToken).toBe('string');
    expect(cialo.encryptedToken.length).toBeGreaterThan(100);
  });
});

// Odpowiedz o niespodziewanym KSZTALCIE to nie to samo, co odmowa serwera: HTTP jest 200,
// wiec `zapytaj` przepuszcza tresc dalej, a dopiero odczyt pola wywala TypeError-em
// („Cannot read properties of undefined"). Przy `redeem` to najgorszy moment z mozliwych —
// jednorazowy odbior wlasnie sie spalil, a wolajacy nie dowiaduje sie ani co sie stalo,
// ani ze zasobu nie ma juz po co probowac.
describe('klient KSeF — odpowiedzi o niespodziewanym ksztalcie', () => {
  it('pusta lista certyfikatow to czytelna odmowa, nie TypeError', async () => {
    const { fetchImpl, wywolania } = atrapa({ ...bazowe, 'security/public-key-certificates': { body: [] } });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF nie oddał certyfikatu klucza publicznego');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
    // Sekwencja nawet sie nie zaczela — poza pierwszym zadaniem nic nie poleci.
    expect(wywolania).toHaveLength(1);
  });

  it('odpowiedz uwierzytelnienia bez tokena operacji to czytelna odmowa', async () => {
    const { fetchImpl, wywolania } = atrapa({
      ...bazowe,
      'auth/ksef-token': { status: 202, body: { referenceNumber: 'REF-1' } },
    });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF nie oddał kompletu danych uwierzytelnienia');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
    expect(wywolania.filter((w) => w.url.includes('token/redeem'))).toHaveLength(0);
  });

  it('odpowiedz uwierzytelnienia bez numeru referencyjnego to czytelna odmowa', async () => {
    const { fetchImpl, wywolania } = atrapa({
      ...bazowe,
      'auth/ksef-token': {
        status: 202,
        body: { authenticationToken: { token: 'OP-TOK', validUntil: '2026-08-12T23:00:00Z' } },
      },
    });
    const e = await zlapBlad(createKsefClient({ token: 'T', nip: '1000001193', fetchImpl }).zaloguj());

    expect(e.message).toContain('KSeF nie oddał kompletu danych uwierzytelnienia');
    // Bez numeru referencyjnego adres stanu bylby `/auth/undefined` — takie zadanie nie leci.
    expect(wywolania.filter((w) => w.url.includes('/auth/undefined'))).toHaveLength(0);
  });

  it('niepelna para tokenow mowi WPROST, ze jednorazowy odbior zostal zuzyty', async () => {
    const { fetchImpl } = atrapa({
      ...bazowe,
      'auth/token/redeem': { body: { accessToken: { validUntil: '2026-08-12T21:00:00Z' } } },
    });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).toContain('KSeF oddał niekompletną parę tokenów');
    // ⚠️ To jest cala wartosc tego straznika: wolajacy ma wiedziec, ze zasob JUZ sie spalil.
    expect(e.message).toContain('od nowa');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
  });

  it('brak refresh tokena w parze tez jest odmowa, nie polowicznym wynikiem', async () => {
    const { fetchImpl } = atrapa({
      ...bazowe,
      'auth/token/redeem': { body: { accessToken: { token: 'ACC', validUntil: '2026-08-12T21:00:00Z' } } },
    });
    const e = await zlapBlad(createKsefClient({ token: 'T', nip: '1000001193', fetchImpl }).zaloguj());

    expect(e.message).toContain('KSeF oddał niekompletną parę tokenów');
  });

  it('odswiez() bez access tokena w odpowiedzi to czytelna odmowa', async () => {
    const { fetchImpl } = atrapa({ 'auth/token/refresh': { body: {} } });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.odswiez('REF-TOKEN'));

    expect(e.message).toContain('KSeF nie oddał nowego access tokena');
    expect(e.message).not.toContain('REF-TOKEN');
    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
  });

  // ⚠️ PIATY ODCZYT TEJ SAMEJ KLASY, POMINIETY W POPRZEDNIEJ RUNDZIE. Straznik ksztaltu stoi
  // przy certyfikatach, przy odpowiedzi ksef-token i przy parze tokenow z redeem — ale challenge
  // z kroku 2 wchodzil do `init.cialo` bez zadnej kontroli. Puste `null` wywala TypeError-em BEZ
  // znacznika `dlaOperatora` (panel pokazalby „blad techniczny panelu"), a `{}` jest gorsze:
  // zadanie do MF WYCHODZI, z `encryptedToken` zaszyfrowanym z ladunku `TOKEN|undefined`.
  it('brak challenge w odpowiedzi /auth/challenge (null) to czytelna odmowa, nie TypeError', async () => {
    const { fetchImpl, wywolania } = atrapa({ ...bazowe, 'auth/challenge': { body: null } });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
    // Sekwencja stanela na challenge — dalej (ksef-token, stan, redeem) nic nie polecialo.
    expect(wywolania.filter((w) => w.url.includes('ksef-token'))).toHaveLength(0);
    expect(wywolania.filter((w) => w.url.includes('token/redeem'))).toHaveLength(0);
  });

  it('challenge bez timestampMs ({}) to czytelna odmowa, nie zadanie z niepelnym ladunkiem', async () => {
    const { fetchImpl, wywolania } = atrapa({ ...bazowe, 'auth/challenge': { body: {} } });
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-123', nip: '1000001193', fetchImpl });
    const e = await zlapBlad(klient.zaloguj());

    expect(e.message).not.toContain('SEKRET-TOKEN-123');
    expect(e.dlaOperatora).toBe(true);
    // Bez straznika zadanie do ksef-token by POLECIALO, z encryptedToken z ladunku TOKEN|undefined.
    expect(wywolania.filter((w) => w.url.includes('ksef-token'))).toHaveLength(0);
  });
});
