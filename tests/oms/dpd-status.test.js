import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDpdClient, LIMIT_ZAPYTANIA_STATUS_MS, LIMIT_NADANIA_MS } from '../../src/oms/kurierzy/dpd.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const nadawca = { nazwa: 'Lumina', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL' };

// KANAL jest CELOWO rozny od FID-u i nie jest podciagiem zadnego innego poswiadczenia.
// W realnej konfiguracji obie wartosci bywaja takie same ('278216') — i wtedy test
// maskowania kanalu NIE GRYZIE, bo kanal maskuje sie „przy okazji" jako FID. Skasowanie
// `channel` z listy w oczysc() przechodzilo wowczas na zielono.
const KANAL = 'KANAL-9001';
const LOGIN = '27821601';
const HASLO = 'SEKRETNE-HASLO';
const FID = '278216';

const zbuduj = (fetchImpl) => createDpdClient({
  url: 'https://dpd/api', infoUrl: 'https://dpd/info', channel: KANAL,
  login: LOGIN, haslo: HASLO, fid: FID, nadawca, fetchImpl,
});

describe('statusPrzesylki', () => {
  it('oddaje opis i czas zdarzenia z prawdziwej odpowiedzi', async () => {
    const c = zbuduj(vi.fn().mockResolvedValue(odp(200, fixture('info-events-ok.xml'))));
    expect(await c.statusPrzesylki('1000000000001U')).toMatchObject({
      opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana',
      at: '2026-07-29T20:07:14.918',
    });
  });

  it('pyta usługę zdarzeń, nie usługi nadań', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp(200, fixture('info-events-ok.xml')));
    await zbuduj(fetchImpl).statusPrzesylki('1000000000001U');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://dpd/info');
    expect(fetchImpl.mock.calls[0][1].body).toContain('getEventsForWaybillV1');
  });

  // PULAPKA: getEventsForCustomer* czyta kolejke WSPOLNA z Apilo i wymaga potwierdzania
  // zdarzen. Uzycie jej moglo by zabrac Apilo zdarzenia, ktorych nigdy nie zobaczy.
  it('nigdy nie sięga po kolejkę zdarzeń całego konta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp(200, fixture('info-events-ok.xml')));
    await zbuduj(fetchImpl).statusPrzesylki('1000000000001U');
    const body = fetchImpl.mock.calls[0][1].body;
    expect(body).not.toContain('getEventsForCustomer');
    expect(body).not.toContain('markEventsAsProcessed');
  });

  // authDataV1 usługi zdarzeń ma channel, NIE masterFid — ta sama nazwa, inna zawartość.
  it('autoryzuje się kanałem, nie Master FID-em', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp(200, fixture('info-events-ok.xml')));
    await zbuduj(fetchImpl).statusPrzesylki('1000000000001U');
    const auth = fetchImpl.mock.calls[0][1].body.match(/<authDataV1>[\s\S]*?<\/authDataV1>/)[0];
    expect(auth).toContain(`<channel>${KANAL}</channel>`);
    expect(auth).not.toContain('masterFid');
  });

  // Karta zamowienia czeka na te odpowiedz SYNCHRONICZNIE przy kazdym otwarciu, a Fastify
  // nie ma limitu trasy. Bez wlasnego sygnalu undici czeka na naglowki 300 000 ms — DPD,
  // ktore przyjmuje polaczenie i milczy, zawiesza karte na piec minut.
  // Ten test ma CZERWIENIC sie po samym skasowaniu `signal:` z wywolania; istniejacy test
  // „DPD nie odpowiada" tego nie pilnuje, bo mockRejectedValue odrzuca natychmiast
  // i sprawdza wylacznie try/catch.
  it('zapytanie o status niesie własny AbortSignal (twardy limit czasu)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp(200, fixture('info-events-ok.xml')));
    await zbuduj(fetchImpl).statusPrzesylki('1000000000001U');
    const { signal } = fetchImpl.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('limit statusu jest krótszy niż domyślne 300 s undici', () => {
    expect(LIMIT_ZAPYTANIA_STATUS_MS).toBeGreaterThan(0);
    expect(LIMIT_ZAPYTANIA_STATUS_MS).toBeLessThan(300_000);
  });

  // ⚠️ DWA TESTY WYZEJ NIE PILNUJA MIEJSCA UZYCIA — jeden sprawdza, ze sygnal to AbortSignal
  // (prawda dla KAZDEGO limitu), drugi ogląda samą stałą (prawda niezaleznie od tego, ktora
  // pojechala do fetcha). Podmiana limitu w soapZdarzen na LIMIT_NADANIA_MS zostawiala oba
  // na zielono, a karta wisialaby minute RAZY liczba paczek zamiast pieciu sekund.
  // `AbortSignal.timeout` w Node 24 jest writable/configurable, wiec da sie je podejrzec;
  // szpieg bez `mockImplementation` zachowuje oryginal, wiec sygnal dalej jest prawdziwy.
  it('zapytanie o status jedzie NA LIMICIE STATUSU, nie na limicie nadania', async () => {
    const szpieg = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi.fn().mockResolvedValue(odp(200, fixture('info-events-ok.xml')));
      await zbuduj(fetchImpl).statusPrzesylki('1000000000001U');
      expect(szpieg).toHaveBeenCalledTimes(1);
      expect(szpieg).toHaveBeenCalledWith(LIMIT_ZAPYTANIA_STATUS_MS);
      expect(szpieg).not.toHaveBeenCalledWith(LIMIT_NADANIA_MS);
    } finally {
      szpieg.mockRestore();
    }
  });

  // Swiezo zarejestrowana przesylka oddaje HTTP 200 z pusta lista. To nie awaria.
  it('brak zdarzeń → null zamiast błędu', async () => {
    const pusto = '<S:Envelope><S:Body><ns2:getEventsForWaybillV1Response><return><confirmId>0</confirmId></return></ns2:getEventsForWaybillV1Response></S:Body></S:Envelope>';
    const c = zbuduj(vi.fn().mockResolvedValue(odp(200, pusto)));
    expect(await c.statusPrzesylki('1000000000001U')).toBeNull();
  });

  it('przy wielu zdarzeniach oddaje NAJNOWSZE, nie pierwsze z brzegu', async () => {
    const wiele = '<return>'
      + '<eventsList><description>Nadana</description><eventTime>2026-07-30T08:00:00.000</eventTime></eventsList>'
      + '<eventsList><description>Doręczona</description><eventTime>2026-07-31T10:00:00.000</eventTime></eventsList>'
      + '<eventsList><description>W doręczeniu</description><eventTime>2026-07-31T06:00:00.000</eventTime></eventsList>'
      + '</return>';
    const c = zbuduj(vi.fn().mockResolvedValue(odp(200, wiele)));
    expect((await c.statusPrzesylki('1000000000001U')).opis).toBe('Doręczona');
  });

  // JAXB po stronie DPD POMIJA pola null calkowicie (puste stringi oddaje jako
  // <country></country>, ale brakujacych elementow nie ma wcale). Poprzednia wersja zbierala
  // wszystkie <description> i wszystkie <eventTime> DWIEMA niezaleznymi listami i parowala
  // je PO INDEKSIE — jedno niekompletne zdarzenie rozjezdzalo tablice.
  describe('niekompletne zdarzenia (JAXB pomija pola null)', () => {
    // Wariant CICHY i grozniejszy: brak <eventTime>. Po indeksie wychodzi opis JEDNEGO
    // zdarzenia z czasem INNEGO — karta pokazuje bzdure, ktorej nikt nie zauwazy.
    it('zdarzenie bez eventTime jest pomijane, a opis nie rozjeżdża się z czasem', async () => {
      const xml = '<return>'
        + '<eventsList><description>Nadana</description><eventTime>2026-07-30T08:00:00.000</eventTime></eventsList>'
        + '<eventsList><description>Zwrot do nadawcy</description></eventsList>'
        + '<eventsList><description>Doręczona</description><eventTime>2026-07-31T10:00:00.000</eventTime></eventsList>'
        + '</return>';
      const c = zbuduj(vi.fn().mockResolvedValue(odp(200, xml)));
      // Parowanie po indeksie dawalo tu { opis: 'Zwrot do nadawcy', at: '2026-07-31T10:00…' }.
      expect(await c.statusPrzesylki('1000000000001U'))
        .toMatchObject({ opis: 'Doręczona', at: '2026-07-31T10:00:00.000' });
    });

    // Wariant HALASLIWY: brak <description>. Po indeksie wychodzil `undefined`, ktorego
    // node:sqlite nie potrafi zbindowac („Provided value cannot be bound") — wyjatek ginal
    // w try/catch odpornosci trasy i status zostawal pusty NA ZAWSZE.
    it('zdarzenie bez description oddaje null (nie undefined) i zachowuje swój czas', async () => {
      const xml = '<return>'
        + '<eventsList><description>Nadana</description><eventTime>2026-07-30T08:00:00.000</eventTime></eventsList>'
        + '<eventsList><eventTime>2026-07-31T10:00:00.000</eventTime></eventsList>'
        + '</return>';
      const c = zbuduj(vi.fn().mockResolvedValue(odp(200, xml)));
      const wynik = await c.statusPrzesylki('1000000000001U');
      expect(wynik.at).toBe('2026-07-31T10:00:00.000');
      // toBeNull, NIE toBeUndefined — undefined jest wlasnie tym, czego baza nie przyjmie.
      expect(wynik.opis).toBeNull();
    });

    it('same zdarzenia bez eventTime → null, jak przy pustej liście', async () => {
      const xml = '<return><eventsList><description>Nadana</description></eventsList></return>';
      const c = zbuduj(vi.fn().mockResolvedValue(odp(200, xml)));
      expect(await c.statusPrzesylki('1000000000001U')).toBeNull();
    });
  });

  // Poswiadczenia wycinamy WSZYSTKIE, nie tylko login. Poprzedni test podawal faultstring,
  // w ktorym hasla, FID-u ani kanalu w ogole nie bylo — `not.toContain(haslo)` nie
  // sprawdzalo wtedy niczego i przechodzilo takze po wykasowaniu ich z listy w oczysc().
  it('błąd usługi nie ujawnia ŻADNEGO poświadczenia (login, hasło, FID, kanał)', async () => {
    const fault = '<soap:Fault><faultstring>'
      + `Auth failed for channel=${KANAL} login=${LOGIN} password=${HASLO} masterFid=${FID}`
      + '</faultstring></soap:Fault>';
    const c = zbuduj(vi.fn().mockResolvedValue(odp(500, fault)));
    const blad = await c.statusPrzesylki('1000000000001U').catch((e) => e);
    expect(blad.message).not.toContain(LOGIN);
    expect(blad.message).not.toContain(HASLO);
    expect(blad.message).not.toContain(FID);
    expect(blad.message).not.toContain(KANAL);
    // ...ale POWOD ma zostac czytelny, inaczej maskowanie zamienia blad w bezuzyteczny szum.
    expect(blad.message).toContain('Auth failed');
    expect(blad.dlaOperatora).toBe(true);
  });

  // Cialo odpowiedzi czytamy w tym samym try co polaczenie: przerwanie po limicie czasu
  // albo reset polaczenia rzuca dopiero przy strumieniu. Poza try szlo to w gore surowe —
  // bez `dlaOperatora` i bez maskowania poswiadczen.
  it('błąd przy czytaniu ciała odpowiedzi też jest błędem operatora i też maskuje hasło', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => { throw new Error(`terminated while reading (password=${HASLO})`); },
    });
    const blad = await zbuduj(fetchImpl).statusPrzesylki('1000000000001U').catch((e) => e);
    expect(blad.dlaOperatora).toBe(true);
    expect(blad.message).toContain('DPD nieosiągalne');
    expect(blad.message).not.toContain(HASLO);
  });
});

// ——— ZDARZENIA-NOTYFIKACJE (zmierzone na produkcji 23.08) ————————————————————————————
// DPD dosyla wpisy „Powiadomienie mail"/„Powiadomienie SMS" — czysta notyfikacja, ktora
// NIE mowi nic o paczce, a bywa NAJNOWSZA w historii. Na 62 nadanych paczkach 24 mialy
// wlasnie ja jako snapshot i doreczone wygladaly na „w drodze". Wybor najnowszego zdarzenia
// pomija notyfikacje — chyba ze w historii nie ma NICZEGO innego (wtedy lepsza notyfikacja
// niz falszywe „brak zdarzen").
describe('statusPrzesylki — zdarzenia-notyfikacje', () => {
  const xmlZdarzen = (zdarzenia) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns:getEventsForWaybillV1Response xmlns:ns="http://events.dpdinfoservices.dpd.com.pl/"><return>${
    zdarzenia.map(([opis, at]) => `<eventsList><description>${opis}</description><eventTime>${at}</eventTime></eventsList>`).join('')
  }</return></ns:getEventsForWaybillV1Response></soap:Body></soap:Envelope>`;

  it('powiadomienie mail NIE przykrywa fizycznego zdarzenia, nawet gdy jest nowsze', async () => {
    const c = zbuduj(vi.fn().mockResolvedValue(odp(200, xmlZdarzen([
      ['Przesyłka doręczona', '2026-08-20T11:00:00.000'],
      ['Powiadomienie mail', '2026-08-20T11:00:05.000'],
    ]))));
    expect(await c.statusPrzesylki('1049X')).toEqual({
      opis: 'Przesyłka doręczona', at: '2026-08-20T11:00:00.000',
      historia: [
        { opis: 'Przesyłka doręczona', at: '2026-08-20T11:00:00.000' },
        { opis: 'Powiadomienie mail', at: '2026-08-20T11:00:05.000' },
      ],
    });
  });

  it('sama notyfikacja w historii wraca jako status (lepsza niz „brak zdarzen")', async () => {
    const c = zbuduj(vi.fn().mockResolvedValue(odp(200, xmlZdarzen([
      ['Powiadomienie mail', '2026-08-20T09:00:00.000'],
    ]))));
    expect(await c.statusPrzesylki('1049X')).toMatchObject({ opis: 'Powiadomienie mail', at: '2026-08-20T09:00:00.000' });
  });

  it('powiadomienie SMS traktowane tak samo jak mail', async () => {
    const c = zbuduj(vi.fn().mockResolvedValue(odp(200, xmlZdarzen([
      ['Wydana do doręczenia', '2026-08-20T08:00:00.000'],
      ['Powiadomienie SMS', '2026-08-20T08:00:03.000'],
    ]))));
    expect((await c.statusPrzesylki('1049X')).opis).toBe('Wydana do doręczenia');
  });
});
