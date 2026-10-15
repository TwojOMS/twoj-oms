// ⚠️ DRUGI I TRZECI ZAPIS DO ALLEGRO (Plan B, Zadanie 8) — metadane faktury i sam plik PDF.
// Białą listę metod zapisujących pilnuje `tests/oms/allegro-client-zapis.test.js`; tu jest
// zachowanie tych trzech wywołań: POST metadanych, PUT pliku i pomocniczy GET listy faktur.
import { describe, it, expect } from 'vitest';
import {
  createAllegroClient,
  MAKS_ROZMIAR_FAKTURY_B,
  LIMIT_WYSYLKI_FAKTURY_MS,
} from '../../src/oms/allegro/client.js';

const ustawienia = { api: 'https://api.allegro.pl', userAgent: 'OMS-szkicownia/1.0.0 (+https://szkicownia.pl/oms/)' };
const tokeny = { waznyToken: async () => 'TOKEN' };
const pdf = (bajtow = 100) => Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(bajtow)]);

function klient(odpowiedz = { ok: true, status: 200, json: async () => ({ id: 'INV-1' }) }) {
  const wolania = [];
  return {
    k: createAllegroClient({
      ustawienia,
      tokeny,
      fetchImpl: async (url, o) => { wolania.push({ url, o }); return odpowiedz; },
    }),
    wolania,
  };
}

describe('klient Allegro — faktura', () => {
  it('zgłasza fakturę POST-em z nazwą pliku i numerem', async () => {
    const { k, wolania } = klient();
    const wynik = await k.zglosFakture('CF-1', { nazwaPliku: 'FV-12-08-2026.pdf', numerFaktury: '12/08/2026' });
    expect(wolania).toHaveLength(1);
    expect(wolania[0].url).toBe('https://api.allegro.pl/order/checkout-forms/CF-1/invoices');
    expect(wolania[0].o.method).toBe('POST');
    expect(JSON.parse(wolania[0].o.body)).toEqual({ file: { name: 'FV-12-08-2026.pdf' }, invoiceNumber: '12/08/2026' });
    expect(wynik.id).toBe('INV-1');
  });

  // ⚠️ `invoiceNumber` PODAJEMY ZAWSZE (spec §8.4 pkt 4). Bez niego kupujący nie połączy
  // dokumentu z naszą księgowością, a pole jest w API opcjonalne — czyli nikt nam tego
  // nie przypomni. Osobny test, bo to decyzja, a nie szczegół serializacji.
  it('numer faktury nie może wyjść pusty', async () => {
    const { k, wolania } = klient();
    await expect(k.zglosFakture('CF-1', { nazwaPliku: 'x.pdf', numerFaktury: '' })).rejects.toThrow(/numer/i);
    await expect(k.zglosFakture('CF-1', { nazwaPliku: 'x.pdf' })).rejects.toThrow(/numer/i);
    await expect(k.zglosFakture('CF-1', { numerFaktury: '1/2026' })).rejects.toThrow(/nazw/i);
    expect(wolania).toHaveLength(0);
  });

  it('identyfikator zamówienia idzie zakodowany, nie sklejony', async () => {
    const { k, wolania } = klient();
    await k.zglosFakture('a/b?c', { nazwaPliku: 'x.pdf', numerFaktury: '1/2026' });
    expect(wolania[0].url).toBe('https://api.allegro.pl/order/checkout-forms/a%2Fb%3Fc/invoices');
  });

  // ⚠️ Bez identyfikatora z odpowiedzi nie ma jak dosłać pliku ANI jak rozpoznać, że POST już
  // był — a Allegro przyjmuje do 10 faktur na zamówienie, więc ponowienie narosłoby duplikatami
  // u kupującego. Pusta odpowiedź musi być głośna.
  it('odpowiedź bez identyfikatora jest błędem, nie ciszą', async () => {
    const { k } = klient({ ok: true, status: 200, json: async () => ({}) });
    await expect(k.zglosFakture('CF-1', { nazwaPliku: 'x.pdf', numerFaktury: '1/2026' })).rejects.toThrow(/identyfikator/i);
  });

  // 204 z pustym ciałem `wyslijJson` sprowadza do `null` — to samo ma być głośne, bo `null?.id`
  // jest `undefined` i cichy `return null` przepuściłby „zgłoszenie", którego nie ma.
  it('puste ciało odpowiedzi też jest błędem', async () => {
    const { k } = klient({ ok: true, status: 204, json: async () => { throw new SyntaxError('puste ciało'); } });
    await expect(k.zglosFakture('CF-1', { nazwaPliku: 'x.pdf', numerFaktury: '1/2026' })).rejects.toThrow(/identyfikator/i);
  });

  it('błąd HTTP przy zgłoszeniu nie wynosi tokenu ani ciała odpowiedzi', async () => {
    const { k } = klient({ ok: false, status: 422, json: async () => ({ errors: [{ message: 'TOKEN' }] }) });
    await expect(k.zglosFakture('CF-1', { nazwaPliku: 'x.pdf', numerFaktury: '1/2026' })).rejects.toThrow(
      /Allegro: HTTP 422 przy \/order\/checkout-forms\/CF-1\/invoices/,
    );
    await expect(k.zglosFakture('CF-1', { nazwaPliku: 'x.pdf', numerFaktury: '1/2026' })).rejects.not.toThrow(/Bearer/);
  });

  it('wysyła plik PUT-em z Content-Type application/pdf', async () => {
    const { k, wolania } = klient({ ok: true, status: 200, json: async () => ({ file: { securityVerification: { status: 'WAITING' } } }) });
    const odp = await k.wyslijPlikFaktury('CF-1', 'INV-1', pdf());
    expect(wolania[0].url).toBe('https://api.allegro.pl/order/checkout-forms/CF-1/invoices/INV-1/file');
    expect(wolania[0].o.method).toBe('PUT');
    expect(wolania[0].o.headers['Content-Type']).toBe('application/pdf');
    expect(wolania[0].o.headers['User-Agent']).toBe(ustawienia.userAgent);
    expect(wolania[0].o.headers.Authorization).toBe('Bearer TOKEN');
    expect(odp).toEqual({ file: { securityVerification: { status: 'WAITING' } } });
  });

  // ⚠️ Content-Type ma być `application/pdf`, ale Accept dalej wersjonowany — odpowiedź na ten
  // PUT niesie stan weryfikacji pliku (Zadanie 10) i przychodzi JSON-em Allegro.
  it('Accept zostaje wersjonowany, a plik idzie ciałem bez zmian', async () => {
    const bajty = pdf(50);
    const { k, wolania } = klient();
    await k.wyslijPlikFaktury('CF-1', 'INV-1', bajty);
    expect(wolania[0].o.headers.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(wolania[0].o.body).toBe(bajty);
  });

  // Ten sam wzorzec co przy statusie: wartość musi iść z konfiguracji kanału, bo Allegro
  // trzyma `User-Agent` na białej liście i grozi zablokowaniem klucza za jego brak.
  it('User-Agent wysyłki pliku pochodzi z ustawień, a nie ze stałej w module', async () => {
    const wolania = [];
    const inny = { ...ustawienia, userAgent: 'InnaNazwa/9.9.9 (+https://inny.invalid/dok)' };
    const k = createAllegroClient({
      ustawienia: inny,
      tokeny,
      fetchImpl: async (url, o) => { wolania.push({ url, o }); return { ok: true, status: 200, json: async () => ({}) }; },
    });
    await k.wyslijPlikFaktury('CF-1', 'INV-1', pdf());
    expect(wolania[0].o.headers['User-Agent']).toBe('InnaNazwa/9.9.9 (+https://inny.invalid/dok)');
    expect(wolania[0].o.headers['User-Agent']).not.toBe(ustawienia.userAgent);
  });

  it('identyfikator faktury też idzie zakodowany', async () => {
    const { k, wolania } = klient();
    await k.wyslijPlikFaktury('CF-1', 'a/b c', pdf());
    expect(wolania[0].url).toBe('https://api.allegro.pl/order/checkout-forms/CF-1/invoices/a%2Fb%20c/file');
  });

  it('odmawia pliku, który nie jest PDF-em — zanim cokolwiek poleci', async () => {
    const { k, wolania } = klient();
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', Buffer.from('<html>'))).rejects.toThrow(/PDF/);
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', null)).rejects.toThrow(/PDF/);
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', '%PDF-1.4')).rejects.toThrow(/PDF/);
    expect(wolania).toHaveLength(0);
  });

  it('odmawia pliku ponad limit', async () => {
    const { k, wolania } = klient();
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', pdf(MAKS_ROZMIAR_FAKTURY_B))).rejects.toThrow(/MB/);
    expect(wolania).toHaveLength(0);
  });

  // Granica: plik DOKŁADNIE na limicie ma przejść. Odmowa „od limitu w górę" ucinałaby
  // dokument, który Allegro przyjmuje.
  it('plik dokładnie na limicie przechodzi', async () => {
    const { k, wolania } = klient();
    const rowno = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(MAKS_ROZMIAR_FAKTURY_B - 4)]);
    expect(rowno.length).toBe(MAKS_ROZMIAR_FAKTURY_B);
    await k.wyslijPlikFaktury('CF-1', 'INV-1', rowno);
    expect(wolania).toHaveLength(1);
  });

  it('błąd HTTP przy wysyłce pliku nie wynosi tokenu ani ciała odpowiedzi', async () => {
    const { k } = klient({ ok: false, status: 500, json: async () => ({ token: 'TOKEN' }) });
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', pdf())).rejects.toThrow(
      /Allegro: HTTP 500 przy \/order\/checkout-forms\/CF-1\/invoices\/INV-1\/file/,
    );
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', pdf())).rejects.not.toThrow(/Bearer/);
  });

  it('204 bez ciała po wysyłce pliku NIE JEST awarią', async () => {
    const { k } = klient({ ok: true, status: 204, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
    await expect(k.wyslijPlikFaktury('CF-1', 'INV-1', pdf())).resolves.toBeNull();
  });

  it('czyta listę faktur zamówienia', async () => {
    const { k, wolania } = klient({ ok: true, status: 200, json: async () => ({ invoices: [{ id: 'INV-9', invoiceNumber: '9/2026' }] }) });
    const lista = await k.pobierzFakturyZamowienia('CF-1');
    expect(wolania[0].url).toBe('https://api.allegro.pl/order/checkout-forms/CF-1/invoices');
    expect(wolania[0].o.method).toBe('GET');
    expect(lista).toEqual([{ id: 'INV-9', invoiceNumber: '9/2026' }]);
  });

  it('200 bez tablicy faktur daje pustą listę', async () => {
    const { k } = klient({ ok: true, status: 200, json: async () => ({ invoices: null }) });
    await expect(k.pobierzFakturyZamowienia('CF-1')).resolves.toEqual([]);
  });

  // ⚠️ POMIAR Z 05.08.2026: ten zasób oddaje dziś 400 na każde nasze zamówienie, z przyczyn
  // leżących po stronie Allegro (notatka `2026-08-05-allegro-zapis-rozpoznanie.md` §2).
  // Odczyt jest pomocniczy, więc jego niedziałanie nie ma prawa wywalić wysyłki faktury.
  it('400 czyta jak pustą listę, a nie jak awarię', async () => {
    const { k } = klient({ ok: false, status: 400, json: async () => ({ errors: [{ code: 'ERROR' }] }) });
    await expect(k.pobierzFakturyZamowienia('CF-1')).resolves.toEqual([]);
  });

  // ⚠️ ...ale cisza przy 401/403 znaczyłaby „nie ma faktur" tam, gdzie prawda brzmi „nie wiem" —
  // a na tej odpowiedzi stoi (pomocniczo) ochrona przed drugim dokumentem u kupującego.
  it('403 rzuca — „nie wiem" to nie to samo co „nie ma"', async () => {
    const { k } = klient({ ok: false, status: 403, json: async () => ({}) });
    await expect(k.pobierzFakturyZamowienia('CF-1')).rejects.toThrow(/403/);
  });

  it('401 też rzuca', async () => {
    const { k } = klient({ ok: false, status: 401, json: async () => ({}) });
    await expect(k.pobierzFakturyZamowienia('CF-1')).rejects.toThrow(/401/);
  });

  // Zerwana sieć (albo limit czasu) NIE jest 400 i nie ma prawa udawać pustej listy —
  // ułaskawienie dotyczy dokładnie jednego, ZMIERZONEGO kodu odpowiedzi.
  it('zerwana sieć rzuca, a nie oddaje pustej listy', async () => {
    const k = createAllegroClient({
      ustawienia,
      tokeny,
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    await expect(k.pobierzFakturyZamowienia('CF-1')).rejects.toThrow(/fetch failed/);
  });

  it('limit wysyłki faktury jest dłuższy niż limity ścieżek z człowiekiem przy ekranie', () => {
    expect(LIMIT_WYSYLKI_FAKTURY_MS).toBe(30 * 1000);
    expect(MAKS_ROZMIAR_FAKTURY_B).toBe(2 * 1024 * 1024);
  });

  // ⚠️ TO JEST DRUGA KOPIA białej listy — pierwsza stoi w `allegro-client-zapis.test.js`.
  // Kopia zostaje CELOWO, mimo że dubluje tamtą: wyszła 11.08.2026 przy Zadaniu 2 planu WzA,
  // gdy pierwsza była już poprawiona, a pełna suita mimo to się zaczerwieniła. Właśnie po to
  // ta lista jest w dwóch miejscach — żeby podniesienie bariery w jednym pliku nie wyglądało
  // na komplet. Kto tu dopisuje metodę, ma poprawić OBIE i przeczytać uzasadnienie w tamtej.
  // ⚠️ LISTA SCALONA 11.08.2026 z DWÓCH gałęzi: czternaście z planu WzA plus `pobierzOferty`
  // z magazynu (Zadanie 6, ODCZYT `GET /sale/offers`) = SZESNAŚCIE (16. to `pobierzSledzenie`, historia zdarzeń przewozu, 25.08.2026).
  // Sama ta para konfliktów
  // jest dowodem, że druga kopia zarabia na swoje utrzymanie: rozstrzygnięcie „po swojemu"
  // w jednym pliku zostawiłoby drugi z listą, która milczy o połowie metod.
  // Podjazdy (22.09): trzy odczyty i jedno nieodwracalne zlecenie, z osobnym
  // kontraktem i blokadą w tests/oms/allegro-podjazdy-klient.test.js.
  it('biała lista metod obejmuje teraz DOKŁADNIE dwadzieścia sześć', () => {
    const { k } = klient();
    expect(Object.keys(k).sort()).toEqual([
      'deklarujZalacznikWiadomosci',
      'pobierzEtykieteWza', 'pobierzFakturyZamowienia', 'pobierzMetodeDostawy', 'pobierzOferte',
      'pobierzOferty', 'pobierzPodjazd', 'pobierzPropozycjePodjazdu', 'pobierzPropozycjeWysylki',
      // ⚠️ `pobierzWatki` i `pobierzWiadomosci` — Centrum wiadomości (spec 2026-08-28),
      // wyłącznie odczyt (`GET /messaging/threads…`).
      // `pobierzSprawy` (28.08.2026) tylko CZYTA `GET /sale/issues` — bariera zapisu bez zmian.
      'pobierzPrzesylkeWza', 'pobierzPrzesylki', 'pobierzSledzenie', 'pobierzSprawy',
      'pobierzStanRealizacji',
      'pobierzWatki', 'pobierzWiadomosci', 'pobierzZamowienia',
      'stanTworzeniaPrzesylki', 'stanZleceniaPodjazdu',
      // Centrum wiadomosci (spec 2026-08-28): `wyslijWiadomosc` PISZE i jest
      // NIEODWRACALNE — nie wydaje pieniedzy, ale po drugiej stronie jest czlowiek,
      // ktory dostaje powiadomienie. Bariera zapisu nizej rosnie razem z nia.
      'ustawStatusRealizacji', 'utworzPrzesylke', 'wgrajZalacznikWiadomosci', 'wyslijPlikFaktury',
      'wyslijWiadomosc', 'zglosFakture', 'zlecPodjazd',
    ]);
  });
});
