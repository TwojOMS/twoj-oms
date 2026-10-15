import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszWatek, zapiszWiadomosci, dowody } from '../../../src/oms/db/allegro-watki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ZAKLADKA /wiadomosci — lista watkow Centrum wiadomosci Allegro z obu kont.
//
// ⚠️ EKRAN CZYTA WYLACZNIE LUSTRO i nigdy nie dzwoni do Allegro (ta sama zasada, co przy
// /kampania). Jedyne wyjscie na zewnatrz to POST odpowiedzi — i tylko za potwierdzeniem.
//
// Wzorzec z tests/oms/web-przesylki.test.js: `buildOmsServer` wprost, KAZDE zadanie
// z naglowkiem Basic Auth.
// ⚠️ `origin` JEST OBOWIAZKOWY przy POST — OMS ma ochrone CSRF sprawdzajaca zgodnosc `Origin`
// z `Host` i odrzuca 403 KAZDE zadanie zapisujace bez tego naglowka. Bez niego test odpowiedzi
// wyglada na „trasa nie dziala", a naprawde nie doszedl nawet do trasy.
const AUTH = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

let db; let app; let wyslane;
const wejdz = (opcje) => app.inject({ ...opcje, headers: AUTH });

const watek = (nadpisz = {}) => ({
  kanal: 'allegro_szkicownia', threadId: 't1', interlocutorLogin: 'kupujacy_jan',
  lastMessageDateTime: '2026-08-28T20:00:00Z', typ: 'COMMON', przeczytany: 0,
  ostatniaOdKupujacego: 1, ostatniaTresc: 'Czy jest większy rozmiar?',
  pobranyAt: '2026-08-28T20:01:00Z', ...nadpisz,
});

function serwer(wyslijImpl) {
  return buildOmsServer({
    db,
    config: CONFIG,
    klienciWiadomosci: {
      allegro_szkicownia: {
        wyslijWiadomosc: wyslijImpl ?? (async (id, tekst) => { wyslane.push({ id, tekst }); return { id: 'm1' }; }),
      },
    },
  });
}

beforeEach(() => {
  db = openOmsDb(':memory:');
  wyslane = [];
  app = serwer();
  zapiszWatek(db, watek());
});

describe('zakładka /wiadomosci', () => {
  it('lista pokazuje wątek, login kupującego i stan „czeka na ciebie"', async () => {
    const r = await wejdz({ method: 'GET', url: '/wiadomosci' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('kupujacy_jan');
    expect(r.body).toContain('Czy jest większy rozmiar?');
    expect(r.body).toMatch(/czeka na ciebie/i);
  });

  it('karta wątku pokazuje CAŁĄ korespondencję z lustra, nie samą ostatnią linijkę', async () => {
    zapiszWiadomosci(db, 'allegro_szkicownia', 't1', [
      { id: 'm1', text: 'Czy jest większy rozmiar?', createdAt: '2026-08-28T20:00:00Z', author: { isInterlocutor: true } },
      { id: 'm2', text: 'Robimy na wymiar.', createdAt: '2026-08-28T20:10:00Z', author: { isInterlocutor: false } },
    ]);
    const r = await wejdz({ method: 'GET', url: '/wiadomosci/allegro_szkicownia/t1' });
    expect(r.body).toContain('Czy jest większy rozmiar?');
    expect(r.body).toContain('Robimy na wymiar.');
  });

  // ⚠️ Allegro oddaje `text` z encjami HTML (`&Oacute;`, `&oacute;`, `&quot;`) — pomiar na
  // kopii produkcji 14.10.2026. Bez rozwiniecia szablon ucieka `&` drugi raz i na ekranie
  // stoi dosłownie „&amp;Oacute;" zamiast „Ó" (zgloszenie wlasciciela PRZ-074).
  it('„Ó/ó" z encji Allegro widać jako litery na liście i w karcie wątku', async () => {
    zapiszWatek(db, watek({ ostatniaTresc: 'DZI&Oacute;BEK kr&oacute;tki' }));
    zapiszWiadomosci(db, 'allegro_szkicownia', 't1', [
      { id: 'm1', text: 'Kt&oacute;ry &quot;DZI&Oacute;BEK&quot;?', createdAt: '2026-08-28T20:00:00Z', author: { isInterlocutor: true } },
    ]);
    const lista = await wejdz({ method: 'GET', url: '/wiadomosci' });
    expect(lista.body).toContain('DZIÓBEK krótki');
    expect(lista.body).not.toContain('acute;');
    const karta = await wejdz({ method: 'GET', url: '/wiadomosci/allegro_szkicownia/t1' });
    expect(karta.body).toContain('Który &#34;DZIÓBEK&#34;?');
    expect(karta.body).not.toContain('acute;');
  });

  it('wątek sporny ma znacznik i NIE MA pola odpowiedzi', async () => {
    zapiszWatek(db, watek({ threadId: 'spor', typ: 'POST_PURCHASE_ISSUE', ostatniaTresc: 'reklamacja' }));
    const r = await wejdz({ method: 'GET', url: '/wiadomosci/allegro_szkicownia/spor' });
    expect(r.body).toMatch(/problem z zakupem/i);
    expect(r.body).not.toContain('name="tresc"');
  });

  it('odpowiedź z panelu wysyła i zapisuje dowód „reczna"', async () => {
    const r = await wejdz({
      method: 'POST',
      url: '/wiadomosci/allegro_szkicownia/t1/odpowiedz',
      payload: { tresc: 'Dzień dobry, tak — robimy na wymiar.', potwierdzam: 'tak' },
    });
    expect([200, 302]).toContain(r.statusCode);
    expect(wyslane).toHaveLength(1);
    const [d] = dowody(db, 'allegro_szkicownia', 't1');
    expect(d.rodzaj).toBe('reczna');
    expect(d.wyslany_at).toBeTruthy();
  });

  it('BEZ potwierdzenia nic nie wychodzi', async () => {
    const r = await wejdz({
      method: 'POST', url: '/wiadomosci/allegro_szkicownia/t1/odpowiedz', payload: { tresc: 'cokolwiek' },
    });
    expect(wyslane).toEqual([]);
    expect(r.statusCode).toBe(400);
    expect(dowody(db, 'allegro_szkicownia', 't1')).toHaveLength(0);
  });

  it('odmawia odpowiedzi w wątku spornym, nawet gdy ktoś trafi adresem', async () => {
    zapiszWatek(db, watek({ threadId: 'spor', typ: 'POST_PURCHASE_ISSUE' }));
    const r = await wejdz({
      method: 'POST', url: '/wiadomosci/allegro_szkicownia/spor/odpowiedz',
      payload: { tresc: 'cos', potwierdzam: 'tak' },
    });
    expect(wyslane).toEqual([]);
    expect(r.statusCode).toBe(400);
  });

  it('nieudana wysyłka zostawia błąd i NIE udaje sukcesu', async () => {
    app = serwer(async () => { throw new Error('Allegro: HTTP 500 przy /messaging'); });
    const r = await wejdz({
      method: 'POST', url: '/wiadomosci/allegro_szkicownia/t1/odpowiedz',
      payload: { tresc: 'cos', potwierdzam: 'tak' },
    });
    expect(r.body).toContain('HTTP 500');
    expect(dowody(db, 'allegro_szkicownia', 't1')[0].blad).toContain('HTTP 500');
    expect(dowody(db, 'allegro_szkicownia', 't1')[0].wyslany_at).toBe(null);
  });

  it('nieznany wątek daje 404, a nie pusty ekran', async () => {
    const r = await wejdz({ method: 'GET', url: '/wiadomosci/allegro_szkicownia/nie-ma' });
    expect(r.statusCode).toBe(404);
  });

  it('panel BEZ kanałów Allegro otwiera zakładkę zamiast się wywalić', async () => {
    // ⚠️ Brak kanalow to stan POPRAWNY (panel bez zmiennych ALLEGRO_*), nie awaria.
    app = buildOmsServer({ db, config: CONFIG });
    const r = await wejdz({ method: 'GET', url: '/wiadomosci' });
    expect(r.statusCode).toBe(200);
  });
});

// ⚠️⚠️ RECZNE „ZALATWIONE" — prosba wlasciciela z 29.08.2026: „sa stare wiadomosci gdzie
// klient napisal na koniec «Dziekuje» - temat zamkniety". Panel nie ma jak odroznic
// podziekowania od pytania, wiec te jedna rzecz musi mu powiedziec czlowiek.
//
// ⚠️ TO NIE JEST NADPISANIE WYLICZONEGO STANU, tylko KOLEJNY FAKT z data. Zapisujemy date
// ostatniej wiadomosci Z CHWILI KLIKNIECIA, wiec nowa wiadomosc kupujacego otwiera watek
// z powrotem SAMA. Przelacznik bez daty uciszalby go na zawsze.
describe('POST /wiadomosci/:kanal/:threadId/zalatwione', () => {
  it('gasi wątek w kolejce, choć ostatni pisał kupujący', async () => {
    zapiszWatek(db, watek());
    app = serwer();

    const przed = await wejdz({ method: 'GET', url: '/wiadomosci' });
    expect(przed.body).toContain('czeka na ciebie');

    const odp = await wejdz({ method: 'POST', url: '/wiadomosci/allegro_szkicownia/t1/zalatwione' });
    expect(odp.statusCode).toBe(302);

    const po = await wejdz({ method: 'GET', url: '/wiadomosci' });
    expect(po.body).not.toContain('czeka na ciebie');
  });

  it('⚠️ NIE wysyła niczego do Allegro — to zmiana WYLACZNIE u nas', async () => {
    zapiszWatek(db, watek());
    app = serwer();

    await wejdz({ method: 'POST', url: '/wiadomosci/allegro_szkicownia/t1/zalatwione' });

    // Kupujacy nie ma prawa dostac wiadomosci dlatego, ze ktos posprzatal sobie kolejke.
    expect(wyslane).toEqual([]);
    expect(dowody(db, 'allegro_szkicownia', 't1')).toEqual([]);
  });

  it('nieznany wątek daje 404, a nie ciche przekierowanie', async () => {
    app = serwer();
    const odp = await wejdz({ method: 'POST', url: '/wiadomosci/allegro_szkicownia/nie_ma/zalatwione' });
    expect(odp.statusCode).toBe(404);
  });

  it('wątek BEZ daty ostatniej wiadomości nie da się zamknąć — nie ma czego zakotwiczyć', async () => {
    // Bez daty zamkniecie nie mialoby zakresu, wiec albo uciszaloby watek na zawsze,
    // albo nie robiloby nic. Odmowa jest uczciwsza niz jedno i drugie.
    zapiszWatek(db, watek({ lastMessageDateTime: null }));
    app = serwer();

    const odp = await wejdz({ method: 'POST', url: '/wiadomosci/allegro_szkicownia/t1/zalatwione' });
    expect(odp.statusCode).toBe(409);
  });

  it('karta wątku POKAZUJE przycisk, gdy wątek czeka', async () => {
    zapiszWatek(db, watek());
    app = serwer();

    const odp = await wejdz({ method: 'GET', url: '/wiadomosci/allegro_szkicownia/t1' });
    expect(odp.body).toContain('/wiadomosci/allegro_szkicownia/t1/zalatwione');
    expect(odp.body).toContain('Załatwione');
  });

  it('karta NIE pokazuje przycisku, gdy ruch i tak jest po stronie kupującego', async () => {
    // Nie ma po co zamykac watku, w ktorym to MY pisalismy ostatni — przycisk bez skutku
    // uczy, ze przyciski w tym panelu bywaja ozdoba.
    zapiszWatek(db, watek({ ostatniaOdKupujacego: 0 }));
    app = serwer();

    const odp = await wejdz({ method: 'GET', url: '/wiadomosci/allegro_szkicownia/t1' });
    expect(odp.body).not.toContain('/zalatwione');
  });
});
