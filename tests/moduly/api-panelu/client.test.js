import { describe, it, expect } from 'vitest';
import { createOmsClient } from '../../pomoc/klient-oms-frozen.js';

const konfig = { baseUrl: 'http://oms:3001', user: 'adam', pass: 'tajne' };

function atrapa(odpowiedzi) {
  const wywolania = [];
  const fetchImpl = async (url, opcje) => {
    wywolania.push({ url, opcje });
    const o = odpowiedzi.shift();
    if (o instanceof Error) throw o;
    return { status: o.status, ok: o.status < 400, json: async () => o.body };
  };
  return { fetchImpl, wywolania };
}

describe('createOmsClient', () => {
  it('wysyla Basic Auth i Origin rowny adresowi OMS-u', async () => {
    const { fetchImpl, wywolania } = atrapa([{ status: 201, body: { id: 7, numer: 'R/2026/007' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    const wynik = await oms.createFromCard({ kartaId: 'karta-abc' });

    expect(wynik).toEqual({ id: 7, numer: 'R/2026/007', konflikt: false });
    const { url, opcje } = wywolania[0];
    expect(url).toBe('http://oms:3001/api/zamowienia-z-karty');
    expect(opcje.headers.Origin).toBe('http://oms:3001');
    expect(opcje.headers.Authorization).toBe('Basic ' + Buffer.from('adam:tajne').toString('base64'));
  });

  it('409 to NIE blad — oddaje numer istniejacego zamowienia', async () => {
    const { fetchImpl } = atrapa([{ status: 409, body: { id: 7, numer: 'R/2026/007', powod: 'jest' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.createFromCard({ kartaId: 'karta-abc' }))
      .resolves.toEqual({ id: 7, numer: 'R/2026/007', konflikt: true });
  });

  it('401 mowi o konfiguracji, nie o zamowieniu — i NIE cytuje hasla (jawnie ani w base64)', async () => {
    // Dwie odpowiedzi 401 w kolejce — obie asercje musza badac ta sama, prawdziwa
    // galaz 401. Przy jednej odpowiedzi drugie wywolanie dostaje `undefined` z
    // `odpowiedzi.shift()`, atrapa rzuca TypeError, zadanie leci sciezka transportowa
    // ("OMS nieosiagalny…") i test przechodzi, sprawdzajac zupelnie inny blad.
    const { fetchImpl } = atrapa([
      { status: 401, body: null },
      { status: 401, body: null },
    ]);
    const oms = createOmsClient({ ...konfig, fetchImpl });

    await expect(oms.createFromCard({ kartaId: 'karta-abc' })).rejects.toThrow(/odrzucił login/i);

    let blad;
    try {
      await oms.createFromCard({ kartaId: 'karta-abc' });
    } catch (e) {
      blad = e;
    }
    expect(blad).toBeInstanceOf(Error);
    // Haslo nie moze wyciec ani jawnie, ani zakodowane base64 (tak jak w naglowku
    // Authorization) — zakodowany sekret w logu jest tak samo wyciekiem jak jawny.
    const autoryzacjaBase64 = Buffer.from('adam:tajne').toString('base64');
    expect(blad.message).not.toContain('tajne');
    expect(blad.message).not.toContain(autoryzacjaBase64);
  });

  it('OMS nieosiagalny — komunikat mowi wprost, ze to sie NIE stalo', async () => {
    const { fetchImpl } = atrapa([new Error('ECONNREFUSED')]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.createFromCard({ kartaId: 'karta-abc' })).rejects.toThrow(/OMS nieosiągalny/);
  });

  it('odczyt karty bez zamowienia oddaje null, nie wyjatek', async () => {
    const { fetchImpl } = atrapa([{ status: 404, body: { powod: 'brak' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getForCard('karta-x')).resolves.toBeNull();
  });
});

// Odczyt zamowienia po numerze ze SKLEPU — to zastepuje dopasowanie przez Apilo w torze auto.
describe('getByShopOrder', () => {
  it('pyta o numer Z NAZWA SKLEPU — numer sam w sobie nie jest unikalny', async () => {
    // ⚠️ To nie jest ostroznosc na wyrost: szkicownia.pl i PRO numeruja NIEZALEZNIE, wiec
    // zamowienie 28060 moze istniec w obu. Karta podpieta do cudzego zamowienia to ta sama
    // klasa bledu, ktora zlikwidowalo przejscie z dopasowania po adresie e-mail na numer oferty.
    const { fetchImpl, wywolania } = atrapa([{ status: 200, body: {
      id: 41, numer: '28060', sklep: 'szkicownia', oplacone: true, anulowane: false,
      kwotaBrutto: '429.00', indywidualne: true,
    } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    const wynik = await oms.getByShopOrder('28060', 'szkicownia');

    expect(wywolania[0].url).toBe('http://oms:3001/api/zamowienia/po-numerze/28060?sklep=szkicownia');
    expect(wynik).toEqual({
      id: 41, numer: '28060', sklep: 'szkicownia', oplacone: true, anulowane: false,
      kwotaBrutto: '429.00', indywidualne: true,
    });
  });

  it('404 to STAN NORMALNY — zamowienie jeszcze nie doszlo do OMS-u', async () => {
    // Poller chodzi co 10 minut, a OMS zaciaga ze sklepu co 2. Miedzy zlozeniem zamowienia
    // a jego pojawieniem sie w OMS-ie jest okno, w ktorym 404 nie jest awaria.
    const { fetchImpl } = atrapa([{ status: 404, body: { powod: 'nie ma' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    expect(await oms.getByShopOrder('28060', 'szkicownia')).toBeNull();
  });

  it('409 (kilka trafien) RZUCA — nie wolno zgadywac, ktore zamowienie jest wlasciwe', async () => {
    const { fetchImpl } = atrapa([{ status: 409, body: { powod: 'dwa zamowienia o tym numerze' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getByShopOrder('28060', 'szkicownia')).rejects.toThrow(/dwa zamowienia/);
  });

  it('401 mowi o konfiguracji, nie o zamowieniu', async () => {
    const { fetchImpl } = atrapa([{ status: 401, body: {} }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getByShopOrder('28060', 'szkicownia')).rejects.toThrow(/OMS_USER/);
  });

  it('brak nazwy sklepu odrzucamy U SIEBIE, bez pytania OMS-u', async () => {
    const { fetchImpl, wywolania } = atrapa([]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getByShopOrder('28060', '')).rejects.toThrow(/sklep/i);
    expect(wywolania).toHaveLength(0);
  });

  it('numer ze znakami specjalnymi jedzie zakodowany', async () => {
    const { fetchImpl, wywolania } = atrapa([{ status: 200, body: { id: 1, numer: 'R/2026/007' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await oms.getByShopOrder('R/2026/007', 'szkicownia');
    expect(wywolania[0].url).toContain('/po-numerze/R%2F2026%2F007?sklep=szkicownia');
  });
});

/* ============================================================================
   PROFORMA — panel prosi OMS o wystawienie dokumentu i o jego bajty.

   ⚠️ To jedyna operacja panelu, która ZUŻYWA NUMER Z SERII po drugiej stronie i unieważnia
   poprzedni dokument klienta. OMS robi to świadomie (proforma nie jest dokumentem księgowym
   i wolno ją wystawić ponownie), ale to znaczy, że każde wywołanie tej metody jest
   zdarzeniem, nie odczytem — i komunikat błędu musi mówić, CZY dokument powstał.
============================================================================ */

// Atrapa oddająca bajty zamiast JSON-a — PDF nie jest JSON-em i klient nie może go tak czytać.
function atrapaBajtow(odpowiedzi) {
  const wywolania = [];
  const fetchImpl = async (url, opcje) => {
    wywolania.push({ url, opcje });
    const o = odpowiedzi.shift();
    if (o instanceof Error) throw o;
    return {
      status: o.status,
      ok: o.status < 400,
      json: async () => (o.body !== undefined ? o.body : JSON.parse('nie-json')),
      arrayBuffer: async () => (o.bajty ? o.bajty.buffer.slice(o.bajty.byteOffset, o.bajty.byteOffset + o.bajty.byteLength) : new ArrayBuffer(0)),
      headers: { get: () => o.typ ?? null },
    };
  };
  return { fetchImpl, wywolania };
}

describe('wystawProforme', () => {
  it('oddaje numer, identyfikator i adres pliku', async () => {
    const { fetchImpl, wywolania } = atrapa([{ status: 201, body: { id: 12, numer: 'PF/3/08/2026', pdfUrl: '/api/proformy/12/pdf' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.wystawProforme(7)).resolves.toEqual({ id: 12, numer: 'PF/3/08/2026', pdfUrl: '/api/proformy/12/pdf' });
    expect(wywolania[0].url).toBe('http://oms:3001/api/zamowienia/7/proforma');
    expect(wywolania[0].opcje.method).toBe('POST');
    // OMS odrzuca POST bez zgodnego Origin (ochrona CSRF) — panel podaje własne, prawdziwe.
    expect(wywolania[0].opcje.headers.Origin).toBe('http://oms:3001');
  });

  // Odmowa operatorska („zamówienie anulowane", „wyszłaby na 0,00 zł") jest jedyną rzeczą,
  // z której człowiek dowie się, czemu dokument nie powstał — ma dojść w całości.
  it('400 niesie powód z OMS-u w treści komunikatu', async () => {
    const { fetchImpl } = atrapa([{ status: 400, body: { powod: 'To zamówienie jest anulowane.' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.wystawProforme(7)).rejects.toThrow(/anulowane/);
  });

  // 503 to KONFIGURACJA OMS-u, nie awaria zamówienia — i naprawa jest zupełnie inna.
  it('503 mówi wprost, że to brak konfiguracji proform po stronie OMS-u', async () => {
    const { fetchImpl } = atrapa([{ status: 503, body: { powod: 'Proformy nie są skonfigurowane.' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.wystawProforme(7)).rejects.toThrow(/skonfigurowan/i);
  });

  it('401 mówi o loginie panelu, nie o proformie', async () => {
    const { fetchImpl } = atrapa([{ status: 401, body: {} }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.wystawProforme(7)).rejects.toThrow(/OMS_USER|OMS_PASS/);
  });

  // Niepełna odpowiedź jest gorsza od błędu: bez `pdfUrl` panel nie ma czego pobrać, a numer
  // zapisałby na karcie — czyli karta twierdziłaby, że dokument jest, a maila nie da się złożyć.
  it('niepełna odpowiedź (bez pdfUrl) to błąd, nie połowiczny sukces', async () => {
    const { fetchImpl } = atrapa([{ status: 201, body: { id: 12, numer: 'PF/3/08/2026' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.wystawProforme(7)).rejects.toThrow(/komplet|pdfUrl/i);
  });
});

describe('pobierzProformePdf', () => {
  it('oddaje bufor z bajtami dokumentu', async () => {
    const pdf = Buffer.from('%PDF-1.4 PROFORMA');
    const { fetchImpl, wywolania } = atrapaBajtow([{ status: 200, bajty: pdf, typ: 'application/pdf' }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    const bajty = await oms.pobierzProformePdf('/api/proformy/12/pdf');
    expect(Buffer.isBuffer(bajty)).toBe(true);
    expect(bajty.toString()).toContain('PROFORMA');
    expect(wywolania[0].url).toBe('http://oms:3001/api/proformy/12/pdf');
  });

  /* ⚠️⚠️ ADRES Z ODPOWIEDZI SIECIOWEJ NIE JEST ZAUFANY — i to nie jest teoria o złośliwym
     OMS-ie. Wystarczy pomyłka w konfiguracji albo pośrednik po drodze: panel poszedłby pod
     PODANY adres z nagłówkiem `Authorization` niosącym hasło do OMS-u, czyli oddałby je
     obcemu hostowi. Dlatego kształt ścieżki sprawdzamy U SIEBIE, przed wyjściem w sieć —
     ta sama zasada, co przy wymaganiu `sklep` w getByShopOrder. */
  it('odrzuca adres bezwzględny — nie idzie z hasłem panelu pod obcy host', async () => {
    const { fetchImpl, wywolania } = atrapaBajtow([{ status: 200, bajty: Buffer.from('x') }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.pobierzProformePdf('https://zly.example/api/proformy/1/pdf')).rejects.toThrow(/adres|ścieżk/i);
    expect(wywolania).toHaveLength(0);
  });

  it('odrzuca ścieżkę spoza /api/proformy/', async () => {
    const { fetchImpl, wywolania } = atrapaBajtow([{ status: 200, bajty: Buffer.from('x') }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.pobierzProformePdf('/etc/passwd')).rejects.toThrow(/adres|ścieżk/i);
    await expect(oms.pobierzProformePdf('//zly.example/api/proformy/1/pdf')).rejects.toThrow(/adres|ścieżk/i);
    expect(wywolania).toHaveLength(0);
  });

  it('404 mówi, że pliku nie ma — z powodem od OMS-u', async () => {
    const { fetchImpl } = atrapaBajtow([{ status: 404, body: { powod: 'Nie ma takiej proformy.' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.pobierzProformePdf('/api/proformy/99/pdf')).rejects.toThrow(/Nie ma takiej proformy/);
  });

  // Pusty plik to nie jest dokument — lepiej błąd niż mail z załącznikiem na 0 bajtów.
  it('pusta odpowiedź to błąd, nie załącznik na zero bajtów', async () => {
    const { fetchImpl } = atrapaBajtow([{ status: 200, bajty: Buffer.alloc(0) }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.pobierzProformePdf('/api/proformy/12/pdf')).rejects.toThrow(/pust|zero/i);
  });
});

describe('oznaczWRealizacji — akceptacja projektu przesuwa zamowienie w OMS-ie', () => {
  it('POST na wlasciwy adres, z Basic Auth i Origin', async () => {
    const { fetchImpl, wywolania } = atrapa([{ status: 200, body: { id: 77, numer: 'R/2026/041', status: 'w_realizacji' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });

    const wynik = await oms.oznaczWRealizacji(77);

    expect(wynik).toEqual({ zmienione: true, numer: 'R/2026/041', status: 'w_realizacji' });
    const { url, opcje } = wywolania[0];
    expect(url).toBe('http://oms:3001/api/zamowienia/77/w-realizacji');
    expect(opcje.method).toBe('POST');
    expect(opcje.headers.Origin).toBe('http://oms:3001');
    expect(opcje.headers.Authorization).toBe('Basic ' + Buffer.from('adam:tajne').toString('base64'));
  });

  it('⚠️ 409 to ODMOWA, nie awaria — oddaje powod, zamiast rzucac', async () => {
    // OMS odmawia zamowieniu wyslanemu, anulowanemu i ze zwrotem. To nie jest blad
    // transportu: rzucenie tutaj zamienialoby poprawna decyzje drugiej strony w „ERROR"
    // w logu karty, a wolajacy (moveToProduction) i tak idzie dalej — wiec czlowiek
    // dostawalby komunikat o awarii tam, gdzie nic sie nie zepsulo.
    const { fetchImpl } = atrapa([{ status: 409, body: { powod: 'Zamówienie jest już wysłane — status zostaje bez zmian.' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });

    const wynik = await oms.oznaczWRealizacji(77);

    expect(wynik.zmienione).toBe(false);
    expect(wynik.powod).toMatch(/już wysłane/);
  });

  it('409 bez podanego powodu i tak nie udaje sukcesu', async () => {
    const { fetchImpl } = atrapa([{ status: 409, body: {} }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    const wynik = await oms.oznaczWRealizacji(77);
    expect(wynik.zmienione).toBe(false);
    expect(wynik.powod).toBeTruthy();
  });

  it('404 (OMS nie zna zamowienia) to takze odmowa, nie wyjatek', async () => {
    const { fetchImpl } = atrapa([{ status: 404, body: { powod: 'Nie ma takiego zamówienia.' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    const wynik = await oms.oznaczWRealizacji(999);
    expect(wynik).toMatchObject({ zmienione: false });
    expect(wynik.powod).toMatch(/404/);
  });

  it('401 mowi o konfiguracji panelu, nie o zamowieniu', async () => {
    const { fetchImpl } = atrapa([{ status: 401, body: {} }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.oznaczWRealizacji(77)).rejects.toThrow(/OMS_USER|OMS_PASS|login/i);
  });

  it('500 JEST awaria — rzuca z kodem i powodem', async () => {
    // Para do testu 409: gdyby klient „polykal" wszystko, awaria OMS-u wygladalaby
    // w logu karty jak zwykla odmowa i nikt by jej nie naprawil.
    const { fetchImpl } = atrapa([{ status: 500, body: { powod: 'baza tylko do odczytu' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.oznaczWRealizacji(77)).rejects.toThrow(/500|baza tylko do odczytu/);
  });
});

// Odczyt dla pollera wysylki: karta panelu przechodzi na „Wyslane" za faktem z OMS-u.
describe('getStanWysylki', () => {
  it('GET na wlasciwy adres, z Basic Auth i Origin — oddaje fakt i date', async () => {
    const { fetchImpl, wywolania } = atrapa([{ status: 200, body: {
      id: 77, numer: 'R/2026/041', wyslane: true, wyslaneAt: '2026-08-25T10:00:00.000Z', anulowane: false,
    } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });

    const wynik = await oms.getStanWysylki(77);

    expect(wynik).toEqual({ id: 77, numer: 'R/2026/041', wyslane: true, wyslaneAt: '2026-08-25T10:00:00.000Z', anulowane: false });
    const { url, opcje } = wywolania[0];
    expect(url).toBe('http://oms:3001/api/zamowienia/77/stan-wysylki');
    expect(opcje.headers.Origin).toBe('http://oms:3001');
    expect(opcje.headers.Authorization).toBe('Basic ' + Buffer.from('adam:tajne').toString('base64'));
  });

  it('404 (zamowienie skasowane w OMS-ie) oddaje null, nie wyjatek', async () => {
    const { fetchImpl } = atrapa([{ status: 404, body: { powod: 'nie ma' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getStanWysylki(77)).resolves.toBeNull();
  });

  it('401 mowi o konfiguracji panelu, nie o zamowieniu', async () => {
    const { fetchImpl } = atrapa([{ status: 401, body: {} }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getStanWysylki(77)).rejects.toThrow(/OMS_USER|OMS_PASS|login/i);
  });

  it('500 rzuca z kodem i powodem', async () => {
    const { fetchImpl } = atrapa([{ status: 500, body: { powod: 'baza tylko do odczytu' } }]);
    const oms = createOmsClient({ ...konfig, fetchImpl });
    await expect(oms.getStanWysylki(77)).rejects.toThrow(/500|baza tylko do odczytu/);
  });
});
