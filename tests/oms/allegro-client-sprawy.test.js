import { describe, it, expect } from 'vitest';
import { createAllegroClient, LIMIT_STRONY_SPRAW } from '../../src/oms/allegro/client.js';

// DYSKUSJE I REKLAMACJE — `GET /sale/issues`.
//
// ⚠️ RUSZTOWANIE NA DWA MIESIACE. `/sale/disputes` Allegro usunelo 07.01.2026, a od 28.10.2026
// te sprawy wchodza do Centrum wiadomosci jako watki POST_PURCHASE_ISSUE i maja byc obslugiwane
// WYLACZNIE przez /messaging. Gdy to nastapi, ta metoda ma zniknac, a nie zostac „na wszelki
// wypadek".

const tokeny = { waznyToken: async () => 'TOKEN' };
const ustawienia = { api: 'https://api.przyklad', userAgent: 'Panel/0.0.0 (+https://przyklad.invalid)' };

function szpieg(cialo) {
  const wywolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wywolania.push({ url, opcje });
    return { ok: true, status: 200, json: async () => cialo };
  };
  return { wywolania, fetchImpl };
}

describe('klient Allegro — dyskusje i reklamacje', () => {
  it('pyta o sprawy z limitem i offsetem, metodą GET', async () => {
    const { wywolania, fetchImpl } = szpieg({ issues: [{ id: 'd1' }], totalCount: 1 });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    const wynik = await k.pobierzSprawy({ offset: 100 });

    expect(wywolania[0].url).toContain('/sale/issues');
    expect(wywolania[0].url).toContain(`limit=${LIMIT_STRONY_SPRAW}`);
    expect(wywolania[0].url).toContain('offset=100');
    expect(wywolania[0].opcje.method).toBe('GET');
    expect(wywolania[0].opcje.headers['User-Agent']).toBe(ustawienia.userAgent);
    expect(wynik.sprawy).toEqual([{ id: 'd1' }]);
    expect(wynik.razem).toBe(1);
  });

  // ⚠️ `/sale/issues` pozwala na limit do 100, a `/messaging/threads` tylko do 20. To DWA
  // rozne zasoby i dwa rozne sufity — sklejenie ich w jedna stala urwaloby strone spraw.
  it('sufit strony spraw to 100, a nie 20 jak przy wątkach', () => {
    expect(LIMIT_STRONY_SPRAW).toBe(100);
  });

  it('brak totalCount daje razem = null, a nie 0', async () => {
    const { fetchImpl } = szpieg({ issues: [{ id: 'd1' }] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    expect((await k.pobierzSprawy({ offset: 0 })).razem).toBe(null);
  });

  it('odpowiedź bez listy spraw daje pustą tablicę, nie wywala przebiegu', async () => {
    const { fetchImpl } = szpieg({});
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    expect((await k.pobierzSprawy({ offset: 0 })).sprawy).toEqual([]);
  });

  it('błąd HTTP niesie kod i ścieżkę, a NIGDY tokenu', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    await expect(k.pobierzSprawy({ offset: 0 })).rejects.toThrow(/HTTP 403 przy \/sale\/issues/);
    await expect(k.pobierzSprawy({ offset: 0 })).rejects.not.toThrow(/TOKEN/);
  });
});

// ⚠️⚠️ ZMIERZONE NA PRODUKCJI 28.08.2026, PO WDROZENIU: `/sale/issues` odbijalo KAZDE
// wywolanie kodem HTTP 406, na obu kanalach. To nie byl brak uprawnienia (zakres
// `allegro:api:disputes` byl nadany) ani brak spraw — to byl ZLY NAGLOWEK `Accept`.
//
// Sonda na zywym tokenie, trzy warianty:
//     application/vnd.allegro.public.v1+json  ->  406
//     application/vnd.allegro.beta.v1+json    ->  200
//     application/json                        ->  406
//
// `/sale/issues` jest zasobem w wersji BETA i przyjmuje WYLACZNIE swoj typ. Reszta klienta
// chodzi na `public.v1` i ma tak zostac — to jeden zasob z wyjatkiem, nie zmiana domyslnej.
//
// ⚠️ USTERKA BYLA BEZOBJAWOWA. Przebieg lapie wyjatek na kanal i oddaje go w `bledy`, a pusta
// tabela `allegro_sprawy` wyglada dokladnie tak samo, gdy odczyt dziala i nie ma spraw, jak
// wtedy, gdy odczyt nie dziala w ogole. Wlasciciel potwierdzil „dyskusji teraz nie ma
// otwartych" — i to zdanie ZAMKNELOBY sprawe, gdyby nie osobna sonda na kod odpowiedzi.
// Cisza w danych nie jest dowodem, ze cokolwiek dziala.
//
// ⚠️ Stary test sprawdzal `User-Agent`, a `Accept` PUSCIL. Dlatego usterka przeszla przez
// zielona suite az na produkcje.
describe('klient Allegro — sprawy chodzą na typie BETA', () => {
  it('wysyła Accept: application/vnd.allegro.beta.v1+json', async () => {
    const { wywolania, fetchImpl } = szpieg({ issues: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzSprawy({ offset: 0 });

    expect(wywolania[0].opcje.headers.Accept).toBe('application/vnd.allegro.beta.v1+json');
  });

  it('reszta klienta zostaje na typie PUBLIC — to wyjątek jednego zasobu, nie nowa domyślna', async () => {
    const { wywolania, fetchImpl } = szpieg({ checkoutForms: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    await k.pobierzZamowienia({ od: '2026-08-01T00:00:00.000Z', strona: 1 });

    expect(wywolania[0].opcje.headers.Accept).toBe('application/vnd.allegro.public.v1+json');
  });
});
