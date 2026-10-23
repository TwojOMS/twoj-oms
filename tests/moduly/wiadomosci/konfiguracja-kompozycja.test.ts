import { describe, it, expect, vi, beforeAll, afterAll, type MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { konfiguracjaWiadomosci } from '../../../src/moduly/wiadomosci/konfiguracja.ts';
import { ODSTEP_POLLERA_WIADOMOSCI_MS, ODSTEP_CZUWACZA_FORMULKI_MS } from '../../../src/moduly/wiadomosci/zegary.ts';
import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';

// PRZ-029: kontrakty konfiguracji i kompozycji wiadomości na RZECZYWISTYM domyślnym bootstrapie.
// Atrapą jest wyłącznie SMTP (`createMailer`), a `fetch` odrzuca. Wszystkie pozostałe fabryki
// są prawdziwe — śledzenie fabryk przez vi.mock ma test źródłowy `okablowanie-wiadomosci`,
// tutaj sprawdzamy OBIEKTY usług, które bootstrap naprawdę wystawił.

const smtp = vi.hoisted(() => ({ wywolania: [] as any[], mailery: [] as any[] }));
vi.mock('../../../src/core/poczta/smtp.js', () => ({
  createMailer: (o: any) => {
    const mailer = { wyslane: [] as any[], sendMail: async (m: any) => { mailer.wyslane.push(m); return { messageId: 'atrapa' }; } };
    smtp.wywolania.push(o); smtp.mailery.push(mailer);
    return mailer;
  },
}));

const baza = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const poczta = { SMTP_HOST: 'smtp.fikcja.test', SMTP_USER: 'nadawca@fikcja.test', SMTP_PASS: 'Haslo-Fikcyjne-7Q' };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}`, origin: 'http://localhost' };
const FIRMY = /szkicownia|lumina|zywiecki/i;

type Oms = Awaited<ReturnType<typeof zbudujOms>>;
const zbuduj = async (env: Record<string, string>, log?: (...tekst: string[]) => void) => zbudujOms({ env, log });
const zamknij = async (a?: Oms) => { try { if (a) await a.app.close(); } finally { a?.db.close(); } };
const fikcyjneZamowienie = (a: Oms) => {
  const id = utworzZamowienieReczne(a.db, { klient: { email: 'klient@fikcja.test' },
    dostawa: { first_name: 'Anna', last_name: 'Testowa', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Testowo' },
    metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', utworzone_at: '2026-10-01T09:00:00.000Z' });
  dodajPozycjeReczna(a.db, id, { nazwa: 'Produkt fikcyjny', sku: 'FIK-1', ilosc: 2, cena_brutto: '10.00', brutto_linii: '20.00' });
  przeliczKwoteRecznego(a.db, id);
  return id;
};

let transport: MockInstance<typeof fetch>;
beforeAll(() => { transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona')); });
afterAll(() => {
  // Żaden przebieg tego pliku nie ma prawa dotknąć sieci.
  expect(transport).not.toHaveBeenCalled();
  transport.mockRestore();
});

describe('konfiguracjaWiadomosci — czysta funkcja kontraktu SMTP', () => {
  it('bez żadnego klucza SMTP/MAIL_FROM poczta jest jawnie wyłączona (null)', () => {
    expect(konfiguracjaWiadomosci({})).toEqual({ poczta: null });
  });

  it('rozpoczęta konfiguracja odmawia i nazywa brakujące KLUCZE, nigdy wartości', () => {
    const bledy = [
      { SMTP_PASS: 'Haslo-Fikcyjne-7Q' },
      { SMTP_HOST: 'smtp.fikcja.test', SMTP_USER: 'nadawca@fikcja.test', SMTP_PASS: '   ' },
      { MAIL_FROM: 'Sklep <sklep@fikcja.test>' },
    ].map((env) => { try { konfiguracjaWiadomosci(env); return 'brak odmowy'; } catch (e) { return (e as Error).message; } });
    expect(bledy).toEqual([
      'Brak wymaganej konfiguracji poczty: SMTP_HOST, SMTP_USER',
      'Brak wymaganej konfiguracji poczty: SMTP_PASS',
      'Brak wymaganej konfiguracji poczty: SMTP_HOST, SMTP_USER, SMTP_PASS',
    ]);
    expect(bledy.join('\n')).not.toMatch(/Haslo-Fikcyjne|fikcja\.test/);
  });

  it('port: domyślnie 465, jawny w zakresie 1–65535, poza nim odmowa', () => {
    expect(konfiguracjaWiadomosci(poczta).poczta?.smtp.port).toBe(465);
    expect([1, 587, 65535].map((p) => konfiguracjaWiadomosci({ ...poczta, SMTP_PORT: String(p) }).poczta?.smtp.port))
      .toEqual([1, 587, 65535]);
    const odmowy = ['0', '65536', '46.5', 'abc', ''].map((p) => {
      try { konfiguracjaWiadomosci({ ...poczta, SMTP_PORT: p }); return 'przyjęty'; } catch (e) { return (e as Error).message; }
    });
    expect(new Set(odmowy)).toEqual(new Set(['SMTP_PORT musi być liczbą całkowitą od 1 do 65535.']));
  });

  it('MAIL_FROM: brak → SMTP_USER; „Nazwa <adres>” przyjęte; HTML/CRLF w nadawcy odrzucone bez echa wartości', () => {
    expect(konfiguracjaWiadomosci({ ...poczta, SMTP_USER: '  nadawca@fikcja.test  ' }).poczta)
      .toEqual({ smtp: { host: 'smtp.fikcja.test', port: 465, user: '  nadawca@fikcja.test  ', pass: 'Haslo-Fikcyjne-7Q' }, mailFrom: 'nadawca@fikcja.test' });
    expect(konfiguracjaWiadomosci({ ...poczta, MAIL_FROM: 'Sklep Fikcja <sklep@fikcja.test>' }).poczta?.mailFrom)
      .toBe('Sklep Fikcja <sklep@fikcja.test>');
    const wstrzykniecia = [
      { MAIL_FROM: '<script>alert(1)</script> <sklep@fikcja.test>' },
      { MAIL_FROM: 'sklep@fikcja.test\r\nBcc: obcy@fikcja.test' },
      { MAIL_FROM: '<img src=x onerror=1>@fikcja.test' },
      { SMTP_USER: 'login-bez-malpy' },
    ].map((nad) => { try { konfiguracjaWiadomosci({ ...poczta, ...nad }); return 'przyjęty'; } catch (e) { return (e as Error).message; } });
    expect(new Set(wstrzykniecia)).toEqual(new Set(['MAIL_FROM (domyślnie SMTP_USER) musi zawierać poprawny adres nadawcy.']));
  });
});

describe('domyślny bootstrap BEZ SMTP', () => {
  let a: Oms | undefined;
  beforeAll(async () => { smtp.wywolania.length = 0; a = await zbuduj(baza); });
  afterAll(() => zamknij(a));

  // PRZ-108.02: usługi powstają zawsze (poczta z Ustawień może dojść po starcie — bez restartu). Mailerem jest
  // pośrednik ustawień, który bez zapisu nie jest gotowy; `wiadomosci.gotowe()` = false. Fabryki SMTP nikt nie woła.
  it('bez poczty: mailer to niegotowy pośrednik Ustawień, wiadomości mówią gotowe() = false, fabryka SMTP nie została wywołana', () => {
    const u = (n: string) => a!.usluga<any>('wiadomosci', n);
    expect({ zUstawien: u('mailer')?.zUstawien, mailerGotowy: u('mailer')?.gotowy(), potwierdzenie: typeof u('potwierdzenie')?.wyslij,
      wiadomosciGotowe: u('wiadomosci')?.gotowe(), smtp: smtp.wywolania.length })
      .toEqual({ zUstawien: true, mailerGotowy: false, potwierdzenie: 'function', wiadomosciGotowe: false, smtp: 0 });
  });

  it('brak SMTP nie robi martwego pollera ani czuwacza — oba zegary stoją z realnymi usługami', () => {
    const zegary = Object.fromEntries(a!.zegary.map((z) => [z.nazwa, z.odstepMs]));
    expect({ poller: zegary.pollerWiadomosci, czuwacz: zegary.czuwaczFormulki,
      przebiegPollera: typeof a!.usluga<any>('wiadomosci', 'pollerWiadomosci').przebieg,
      przebiegCzuwacza: typeof a!.usluga<any>('wiadomosci', 'czuwaczFormulki').przebieg })
      .toEqual({ poller: 300000, czuwacz: 120000, przebiegPollera: 'function', przebiegCzuwacza: 'function' });
  });

  it('wysyłka z karty mówi wprost 503, zamiast udawać wysłanie', async () => {
    const id = fikcyjneZamowienie(a!);
    const r = await a!.app.inject({ method: 'POST', url: `/zamowienia/${id}/wiadomosc/potwierdzenie`, headers });
    // PRZ-109.06: to nadal odmowa 503, ale formularz wraca ekranem panelu z drogą na kartę.
    expect(r.statusCode).toBe(503);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Poczta nie jest skonfigurowana — wiadomości panel nie wyśle.');
    expect(r.body).toContain('class="oms-sidebar');
    expect(r.body).toContain(`href="/zamowienia/${id}#wiadomosci">Wróć do zamówienia</a>`);
  });
});

describe('domyślny bootstrap z rozpoczętą/niepoprawną konfiguracją SMTP', () => {
  it('start odmawia, nazywa klucz i nie wypisuje sekretu ani adresu', async () => {
    const proby = [
      { ...baza, SMTP_PASS: 'Haslo-Fikcyjne-7Q' },
      { ...baza, ...poczta, SMTP_PORT: '70000' },
      { ...baza, ...poczta, MAIL_FROM: '<b>Sklep</b> <sklep@fikcja.test>' },
    ];
    const wyniki: string[] = [];
    for (const env of proby) {
      let a: Oms | undefined;
      try { a = await zbuduj(env); wyniki.push('wystartował'); } catch (e) { wyniki.push((e as Error).message); } finally { await zamknij(a); }
    }
    expect(wyniki.map((w) => w.split('\n')[0])).toEqual(Array(3).fill('OMS nie wystartuje — konfiguracja:'));
    expect(wyniki.map((w) => /SMTP_HOST|SMTP_PORT|MAIL_FROM/.exec(w)?.[0])).toEqual(['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM']);
    expect(wyniki.join('\n')).not.toMatch(/Haslo-Fikcyjne|fikcja\.test|<b>/);
  });
});

describe('domyślny bootstrap Z SMTP — tożsamość rzeczywistych usług', () => {
  let a: Oms | undefined;
  beforeAll(async () => { smtp.wywolania.length = 0; smtp.mailery.length = 0; a = await zbuduj({ ...baza, ...poczta, SMTP_PORT: '587' }); });
  afterAll(() => zamknij(a));
  const u = <T = any>(n: string) => a!.usluga<T>('wiadomosci', n);

  it('SMTP zbudowane dokładnie raz, z konfiguracją z env, i to ten sam mailer, który wystawia moduł', () => {
    expect(smtp.wywolania).toEqual([{ smtp: { host: 'smtp.fikcja.test', port: 587, user: 'nadawca@fikcja.test', pass: 'Haslo-Fikcyjne-7Q' }, mailFrom: 'nadawca@fikcja.test' }]);
    expect(u('mailer')).toBe(smtp.mailery[0]);
  });

  it('jedna mapa klientów: wiadomości wystawiają DOKŁADNIE mapę kanałów', () => {
    expect(u('klienciWiadomosci')).toBe(a!.usluga('kanaly', 'klienciKanalow'));
  });

  it('wiadomości delegują potwierdzenie do TEJ instancji potwierdzenia, którą wystawia moduł', async () => {
    const id = fikcyjneZamowienie(a!);
    const wyslij = vi.spyOn(u('potwierdzenie'), 'wyslij');
    try {
      const r = await a!.app.inject({ method: 'POST', url: `/zamowienia/${id}/wiadomosc/potwierdzenie`, headers });
      expect({ status: r.statusCode, delegacje: wyslij.mock.calls.length, maile: smtp.mailery[0].wyslane.length })
        .toEqual({ status: 302, delegacje: 1, maile: 1 });
    } finally { wyslij.mockRestore(); }
  });

  it('sprzedawca rdzenia trafia do konfiguracji wiadomości jako ten sam obiekt, wyłącznie z env', () => {
    const config = u<any>('config');
    expect(config.sprzedawca).toBe(a!.usluga('rdzen', 'sprzedawca'));
    expect(config.sprzedawca).toEqual({ nip: '1234563218', rachunek: '34109010140000000000000000', bdo: null, bank: null });
  });

  it('konfiguracja wiadomości nie zasiewa danych żadnej firmy', () => {
    expect(JSON.stringify(u('config'))).not.toMatch(FIRMY);
  });
});

describe('zegary wiadomości — prawdziwe otoczki z bootstrapu', () => {
  let a: Oms | undefined;
  const log: string[][] = [];
  beforeAll(async () => { a = await zbuduj(baza, (...tekst) => log.push(tekst)); });
  afterAll(() => zamknij(a));
  const zegar = (n: string) => a!.zegary.find((z) => z.nazwa === n)!;

  it('odstępy są zamrożone: poller 300000 ms, czuwacz 120000 ms, te same co w manifeście', () => {
    expect({ stalePollera: ODSTEP_POLLERA_WIADOMOSCI_MS, staleCzuwacza: ODSTEP_CZUWACZA_FORMULKI_MS,
      poller: zegar('pollerWiadomosci').odstepMs, czuwacz: zegar('czuwaczFormulki').odstepMs })
      .toEqual({ stalePollera: 300000, staleCzuwacza: 120000, poller: 300000, czuwacz: 120000 });
  });

  it('błąd przebiegu jest łapany i logowany jednym wpisem, zegar nie rzuca', async () => {
    log.length = 0;
    const p = vi.spyOn(uslugaW(a!,'pollerWiadomosci'), 'przebieg').mockRejectedValue(new Error('awaria fikcyjna P'));
    const c = vi.spyOn(uslugaW(a!,'czuwaczFormulki'), 'przebieg').mockRejectedValue(new Error('awaria fikcyjna C'));
    try {
      await expect(zegar('pollerWiadomosci').przebieg()).resolves.toBeUndefined();
      await expect(zegar('czuwaczFormulki').przebieg()).resolves.toBeUndefined();
      expect(log).toEqual([['poller wiadomości:', 'awaria fikcyjna P'], ['autoresponder:', 'awaria fikcyjna C']]);
    } finally { p.mockRestore(); c.mockRestore(); }
  });

  it('wstrzymany autoresponder zostawia ślad, zwykły przebieg nie', async () => {
    log.length = 0;
    const c = vi.spyOn(uslugaW(a!,'czuwaczFormulki'), 'przebieg');
    try {
      c.mockResolvedValueOnce({ wstrzymany: false }).mockResolvedValueOnce({ wstrzymany: true });
      await zegar('czuwaczFormulki').przebieg();
      await zegar('czuwaczFormulki').przebieg();
      expect({ przebiegi: c.mock.calls.length, log })
        .toEqual({ przebiegi: 2, log: [['autoresponder WSTRZYMANY: próg formułek na godzinę przekroczony.']] });
    } finally { c.mockRestore(); }
  });
});

function uslugaW(a: Oms, n: string) { return a.usluga<any>('wiadomosci', n); }
