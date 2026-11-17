// Klient Allegro: zapis i słowniki ofert. Kształty żądań i odpowiedzi na przykładach
// z dokumentacji (tests/fixtures/allegro/e3-dok-*.json); żadnej sieci — tylko szpieg `fetchImpl`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAllegroClient, LIMIT_STRONY_OFERT } from '../../src/oms/allegro/client.js';

const dok = (nazwa) => JSON.parse(readFileSync(new URL(`../fixtures/allegro/e3-dok-${nazwa}.json`, import.meta.url), 'utf8'));
const OFERTA = dok('oferta');
const SL = dok('slowniki');

const ustawienia = { api: 'https://api.allegro.pl.allegrosandbox.pl', userAgent: 'OMS-polcien/1.0.0 (+https://polcien.example.test/oms/)' };
const tokeny = { waznyToken: async () => 'TOKEN-TAJNY' };

const odp = ({ status = 200, cialo = {}, naglowki = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => naglowki[Object.keys(naglowki).find((k) => k.toLowerCase() === n.toLowerCase())] ?? null },
  json: async () => { if (cialo === null) throw new SyntaxError('puste — brak ciała'); return cialo; },
});

function klient(odpowiadaj) {
  const wolania = [];
  const fetchImpl = async (url, opcje) => {
    wolania.push({ url, opcje });
    return typeof odpowiadaj === 'function' ? odpowiadaj(url, opcje, wolania.length) : (odpowiadaj ?? odp());
  };
  return { k: createAllegroClient({ ustawienia, tokeny, fetchImpl }), wolania };
}
const sciezka = (url) => { const u = new URL(url); return u.pathname; };
const zapytanie = (url) => new URL(url).searchParams;

describe('utworzOferte / edytujOferte', () => {
  it('POST /sale/product-offers z ciałem z dokumentacji, wersjonowanym typem i limitem czasu', async () => {
    const { k, wolania } = klient(odp({ status: 201, cialo: OFERTA.odpowiedz201 }));
    const w = await k.utworzOferte(OFERTA.zadanie);
    expect(wolania).toHaveLength(1);
    expect(wolania[0].opcje.method).toBe('POST');
    expect(wolania[0].url).toBe('https://api.allegro.pl.allegrosandbox.pl/sale/product-offers');
    expect(JSON.parse(wolania[0].opcje.body)).toEqual(OFERTA.zadanie);
    expect(wolania[0].opcje.headers['Content-Type']).toBe('application/vnd.allegro.public.v1+json');
    expect(wolania[0].opcje.signal).toBeInstanceOf(AbortSignal);
    expect(w).toEqual({ status: 201, ofertaId: '17000000000101', operacja: null, retryAfterS: null, dane: OFERTA.odpowiedz201 });
  });

  it('202 daje ofertaId i adres operacji z nagłówka location oraz retry-after', async () => {
    const { naglowki, cialo } = OFERTA.odpowiedz202;
    const { k } = klient(odp({ status: 202, cialo, naglowki }));
    const w = await k.utworzOferte(OFERTA.zadanie);
    expect(w.status).toBe(202);
    expect(w.ofertaId).toBe('17000000000102');
    expect(w.operacja).toBe(naglowki.location);
    expect(w.retryAfterS).toBe(5);
  });

  it('202 bez ciała: ofertaId wyczytany z adresu operacji', async () => {
    const { k } = klient(odp({ status: 202, cialo: null, naglowki: OFERTA.odpowiedz202.naglowki }));
    const w = await k.utworzOferte(OFERTA.zadanie);
    expect(w.ofertaId).toBe('17000000000102');
    expect(w.dane).toBeNull();
  });

  it('błąd HTTP idzie przez bladHttp — z kodem i bez tokenu w komunikacie', async () => {
    const { k } = klient(odp({ status: 422, cialo: { errors: [{ code: 'PARAMETER_MISMATCH', message: 'zły TOKEN-TAJNY' }] } }));
    const e = await k.utworzOferte(OFERTA.zadanie).catch((x) => x);
    expect(e.status).toBe(422);
    expect(e.message).toContain('HTTP 422 przy /sale/product-offers');
    expect(e.message).not.toContain('TOKEN-TAJNY');
  });

  it('bez ciała-obiektu odmawia przed siecią', async () => {
    const { k, wolania } = klient();
    await expect(k.utworzOferte(null)).rejects.toThrow();
    expect(wolania).toHaveLength(0);
  });

  it('edytujOferte: PATCH /sale/product-offers/{id}, 202 z operacją', async () => {
    const { k, wolania } = klient(odp({ status: 202, cialo: null, naglowki: OFERTA.odpowiedz202.naglowki }));
    const w = await k.edytujOferte('17000000000102', { publication: { status: 'ACTIVE' } });
    expect(wolania[0].opcje.method).toBe('PATCH');
    expect(sciezka(wolania[0].url)).toBe('/sale/product-offers/17000000000102');
    expect(JSON.parse(wolania[0].opcje.body)).toEqual({ publication: { status: 'ACTIVE' } });
    expect(w).toMatchObject({ status: 202, ofertaId: '17000000000102', operacja: OFERTA.odpowiedz202.naglowki.location });
  });
});

describe('stanOperacji', () => {
  const adres = OFERTA.odpowiedz202.naglowki.location;

  it('202 = w toku; GET z redirect:manual', async () => {
    const { k, wolania } = klient(odp({ status: 202, cialo: null, naglowki: { 'retry-after': '5' } }));
    const w = await k.stanOperacji(adres);
    expect(wolania[0].opcje.method).toBe('GET');
    expect(wolania[0].opcje.redirect).toBe('manual');
    expect(sciezka(wolania[0].url)).toBe(adres);
    expect(w).toMatchObject({ status: 202, wToku: true, gotowe: false, retryAfterS: 5 });
  });

  it('303 nie rzuca: gotowe + location oferty', async () => {
    const { k } = klient(odp({ status: 303, cialo: null, naglowki: OFERTA.operacja303.naglowki }));
    const w = await k.stanOperacji(adres);
    expect(w).toMatchObject({ status: 303, wToku: false, gotowe: true, location: '/sale/product-offers/17000000000102' });
  });

  it('przyjmuje pełny adres na tym samym hoście; obcego hosta i obcej ścieżki nie dotyka (token)', async () => {
    const { k, wolania } = klient(odp({ status: 202 }));
    await k.stanOperacji(`${ustawienia.api}${adres}`);
    expect(sciezka(wolania[0].url)).toBe(adres);
    await expect(k.stanOperacji(`https://zly.example.test${adres}`)).rejects.toThrow();
    await expect(k.stanOperacji('/order/checkout-forms/1')).rejects.toThrow();
    expect(wolania).toHaveLength(1);
  });

  it('inny kod niż 2xx/3xx rzuca przez bladHttp', async () => {
    const { k } = klient(odp({ status: 404, cialo: {} }));
    await expect(k.stanOperacji(adres)).rejects.toMatchObject({ status: 404 });
  });
});

describe('ofertyPoSygnaturze', () => {
  // Pętla ofert decyduje na tym wyniku
  // o ponownym POST (D31), więc lista niefiltrowana albo wielostronicowa to „nie wiadomo” (błąd), nie zero.
  it('pyta z external.id; filtr zignorowany (obce sygnatury) → błąd „nie wiadomo”, nie odfiltrowana lista', async () => {
    const { k, wolania } = klient(odp({ cialo: OFERTA.listaFiltrZignorowany }));
    await expect(k.ofertyPoSygnaturze('oms-LMP-WIS-001')).rejects.toThrow(/nie wiadomo/);
    expect(sciezka(wolania[0].url)).toBe('/sale/offers');
    expect(zapytanie(wolania[0].url).get('external.id')).toBe('oms-LMP-WIS-001');
  });

  it('lista przefiltrowana → oferty; więcej niż jedna strona → błąd „nie wiadomo”', async () => {
    const nasza = { id: '17000000000101', name: 'Lampa', external: { id: 'oms-LMP-WIS-001' } };
    const { k } = klient(odp({ cialo: { offers: [nasza], count: 1, totalCount: 1 } }));
    expect((await k.ofertyPoSygnaturze('oms-LMP-WIS-001')).map((o) => o.id)).toEqual(['17000000000101']);
    const { k: k2 } = klient(odp({ cialo: { offers: [nasza], count: 1, totalCount: 21 } }));
    await expect(k2.ofertyPoSygnaturze('oms-LMP-WIS-001')).rejects.toThrow(/nie wiadomo/);
  });

  it('błąd HTTP niesie kody i metadata z errors (PARAMETER_MISMATCH), bez tokenu', async () => {
    const { k } = klient(odp({ status: 422, cialo: { errors: [{ code: 'PARAMETER_MISMATCH', message: 'Wartość różni się od produktu',
      metadata: { productId: 'prod-77', parameterId: '224017', echo: 'Bearer TOKEN-TAJNY', zagniezdzone: { a: 1 } } }] } }));
    const e = await k.utworzOferte(OFERTA.zadanie).catch((b) => b);
    expect(e.status).toBe(422);
    expect(e.bledy).toEqual([{ kod: 'PARAMETER_MISMATCH', metadata: { productId: 'prod-77', parameterId: '224017', echo: '[ukryto]' } }]);
    expect(JSON.stringify(e.bledy)).not.toContain('TOKEN-TAJNY');
  });

  it('pusta sygnatura — odmowa przed siecią; lista nie-tablica — błąd', async () => {
    const { k, wolania } = klient(odp({ cialo: {} }));
    await expect(k.ofertyPoSygnaturze('')).rejects.toThrow();
    expect(wolania).toHaveLength(0);
    await expect(k.ofertyPoSygnaturze('oms-1')).rejects.toThrow();
  });
});

describe('ofertyKonta', () => {
  const strona = (n, od, total) => ({ offers: Array.from({ length: n }, (_, i) => ({ id: String(od + i) })), totalCount: total });

  // E3.30 (P19): strona 1000 — testy liczą od stałej, żeby sprawdzały stronicowanie, nie jedną liczbę.
  const L = LIMIT_STRONY_OFERT;

  it('strona = LIMIT_STRONY_OFERT (1000), offset rośnie o stronę', async () => {
    expect(L).toBe(1000);
    const { k, wolania } = klient((url) => {
      const off = Number(zapytanie(url).get('offset'));
      return odp({ cialo: strona(off < 2 * L ? L : 5, off, 2 * L + 5) });
    });
    const w = await k.ofertyKonta();
    expect(wolania.map((x) => zapytanie(x.url).get('limit'))).toEqual([String(L), String(L), String(L)]);
    expect(wolania.map((x) => zapytanie(x.url).get('offset'))).toEqual(['0', String(L), String(2 * L)]);
    expect(w.oferty).toHaveLength(2 * L + 5);
    expect(w.razem).toBe(2 * L + 5);
  });

  it('katalog 417 ofert (P19) → jedno zapytanie na przebieg', async () => {
    const { k, wolania } = klient((url) => odp({ cialo: strona(417, Number(zapytanie(url).get('offset')), 417) }));
    const w = await k.ofertyKonta();
    expect(wolania).toHaveLength(1);
    expect(w.oferty).toHaveLength(417);
  });

  it('totalCount 225 stron → czyta 225 stron (sufit nie jest stały 200)', async () => {
    const { k, wolania } = klient((url) => odp({ cialo: strona(L, Number(zapytanie(url).get('offset')), 225 * L) }));
    const w = await k.ofertyKonta();
    expect(wolania).toHaveLength(225);
    expect(w.oferty).toHaveLength(225 * L);
  });

  it('absurdalny totalCount: zatrzymuje się na stronie niepełnej (i głośno mówi o braku)', async () => {
    const { k, wolania } = klient((url) => {
      const off = Number(zapytanie(url).get('offset'));
      return odp({ cialo: strona(off < 2 * L ? L : 3, off, 1e12) });
    });
    await expect(k.ofertyKonta()).rejects.toThrow(/urwał/);
    expect(wolania).toHaveLength(3);
  });

  it('pełne strony bez końca: sufit z totalCount (+1), nie pętla', async () => {
    const { k, wolania } = klient((url) => odp({ cialo: strona(L, Number(zapytanie(url).get('offset')), L + 10) }));
    // Allegro zapowiada L + 10, a oddaje pełne strony — kończymy po zebraniu zapowiedzianej liczby.
    const w = await k.ofertyKonta();
    expect(wolania.length).toBeLessThanOrEqual(3);
    expect(w.oferty.length).toBeGreaterThanOrEqual(L + 10);
  });

  it('offset startowy z argumentu', async () => {
    const { k, wolania } = klient(odp({ cialo: strona(2, 40, 42) }));
    const w = await k.ofertyKonta({ offset: 40 });
    expect(zapytanie(wolania[0].url).get('offset')).toBe('40');
    expect(w.oferty).toHaveLength(2);
  });
});

describe('produkty i zdjęcia', () => {
  it('szukajProduktow(ean) → GET /sale/products?phrase=EAN&mode=GTIN', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.produkty }));
    const w = await k.szukajProduktow('5909990000014');
    expect(sciezka(wolania[0].url)).toBe('/sale/products');
    expect(zapytanie(wolania[0].url).get('phrase')).toBe('5909990000014');
    expect(zapytanie(wolania[0].url).get('mode')).toBe('GTIN');
    expect(w).toEqual(SL.produkty.products);
  });

  it('szukajProduktow wysyła Accept-Language: pl-PL (dowód 2a: bez niego fetch daje „*” i Allegro odpowiada 422)', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.produkty }));
    await k.szukajProduktow('5909990000014');
    expect(wolania[0].opcje.headers['Accept-Language']).toBe('pl-PL');
  });

  it('wgrajZdjecie: host upload.<środowisko>, bajty i typ, ai → isAiCoCreated=true', async () => {
    const { k, wolania } = klient(odp({ status: 201, cialo: SL.zdjecie }));
    const bajty = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const w = await k.wgrajZdjecie(bajty, 'image/jpeg', { ai: 1 });
    const u = new URL(wolania[0].url);
    expect(u.host).toBe('upload.allegro.pl.allegrosandbox.pl');
    expect(u.pathname).toBe('/sale/images');
    expect(u.searchParams.get('isAiCoCreated')).toBe('true');
    expect(wolania[0].opcje.method).toBe('POST');
    expect(wolania[0].opcje.headers['Content-Type']).toBe('image/jpeg');
    expect(wolania[0].opcje.body).toBe(bajty);
    expect(w).toEqual({ location: SL.zdjecie.location, expiresAt: SL.zdjecie.expiresAt });
  });

  it('wgrajZdjecie z ai: 0 nie ma isAiCoCreated w adresie', async () => {
    const { k, wolania } = klient(odp({ status: 201, cialo: SL.zdjecie }));
    await k.wgrajZdjecie(Buffer.from([1, 2, 3]), 'image/png', { ai: 0 });
    await k.wgrajZdjecie(Buffer.from([1, 2, 3]), 'image/webp');
    for (const w of wolania) {
      expect(w.url).not.toContain('isAiCoCreated');
      expect(new URL(w.url).search).toBe('');
    }
  });

  it('wgrajZdjecie odmawia przed siecią: zły typ, puste bajty', async () => {
    const { k, wolania } = klient(odp({ status: 201, cialo: SL.zdjecie }));
    await expect(k.wgrajZdjecie(Buffer.from([1]), 'image/gif')).rejects.toThrow();
    await expect(k.wgrajZdjecie(Buffer.alloc(0), 'image/png')).rejects.toThrow();
    expect(wolania).toHaveLength(0);
  });

  it('wgrajZdjecie: host API bez „api.” → odmowa (bez zgadywania hosta)', async () => {
    const wolania = [];
    const k = createAllegroClient({ ustawienia: { ...ustawienia, api: 'https://allegro.example.test' }, tokeny,
      fetchImpl: async (url) => { wolania.push(url); return odp(); } });
    await expect(k.wgrajZdjecie(Buffer.from([1]), 'image/png')).rejects.toThrow();
    expect(wolania).toHaveLength(0);
  });
});

describe('komendy ilości i ceny', () => {
  const POZ = [{ ofertaId: '17000000000101', ilosc: 4 }, { ofertaId: '17000000000103', ilosc: 4 }];

  it('komendaIlosci → PUT /sale/offer-quantity-change-commands/{commandId}, ciało z dokumentacji', async () => {
    const { k, wolania } = klient(odp({ status: 201, cialo: { id: 'c1' } }));
    await k.komendaIlosci('0b1c2d3e-0000-4000-8000-0000000000aa', POZ);
    expect(wolania[0].opcje.method).toBe('PUT');
    expect(sciezka(wolania[0].url)).toBe('/sale/offer-quantity-change-commands/0b1c2d3e-0000-4000-8000-0000000000aa');
    expect(JSON.parse(wolania[0].opcje.body)).toEqual(SL.komendaIlosci);
  });

  it('komendaCeny → PUT /sale/offer-price-change-commands/{commandId}, cena jako "zł.gr" PLN', async () => {
    const { k, wolania } = klient(odp({ status: 201, cialo: { id: 'c2' } }));
    await k.komendaCeny('0b1c2d3e-0000-4000-8000-0000000000bb', [{ ofertaId: '17000000000101', cena: '189.90' }]);
    expect(wolania[0].opcje.method).toBe('PUT');
    expect(sciezka(wolania[0].url)).toBe('/sale/offer-price-change-commands/0b1c2d3e-0000-4000-8000-0000000000bb');
    expect(JSON.parse(wolania[0].opcje.body)).toEqual(SL.komendaCeny);
  });

  it('odmowy przed siecią: brak commandId, puste pozycje, różne wartości w jednej komendzie, zła cena, >1000', async () => {
    const { k, wolania } = klient(odp({ status: 201 }));
    await expect(k.komendaIlosci('', POZ)).rejects.toThrow(/commandId/);
    await expect(k.komendaIlosci('c', [])).rejects.toThrow();
    await expect(k.komendaIlosci('c', [{ ofertaId: '1', ilosc: 1 }, { ofertaId: '2', ilosc: 2 }])).rejects.toThrow();
    await expect(k.komendaIlosci('c', [{ ofertaId: '1', ilosc: -1 }])).rejects.toThrow();
    await expect(k.komendaCeny('c', [{ ofertaId: '1', cena: 18990 }])).rejects.toThrow();
    await expect(k.komendaCeny('c', [{ ofertaId: '1', cena: '189.9' }])).rejects.toThrow();
    const duzo = Array.from({ length: 1001 }, (_, i) => ({ ofertaId: String(i), ilosc: 1 }));
    await expect(k.komendaIlosci('c', duzo)).rejects.toThrow();
    expect(wolania).toHaveLength(0);
  });

  it('wynikKomendy(rodzaj, commandId) → GET …/{commandId}/tasks', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.zadaniaKomendy }));
    expect(await k.wynikKomendy('ilosc', 'c1')).toEqual(SL.zadaniaKomendy.tasks);
    expect(await k.wynikKomendy('cena', 'c2')).toEqual(SL.zadaniaKomendy.tasks);
    expect(wolania.map((w) => [w.opcje.method, sciezka(w.url)])).toEqual([
      ['GET', '/sale/offer-quantity-change-commands/c1/tasks'],
      ['GET', '/sale/offer-price-change-commands/c2/tasks'],
    ]);
    await expect(k.wynikKomendy('opis', 'c3')).rejects.toThrow();
    expect(wolania).toHaveLength(2);
  });
});

describe('słowniki konta i opłaty', () => {
  const PRZYPADKI = [
    ['pobierzCenniki', [], '/sale/shipping-rates', 'cenniki', 'shippingRates'],
    ['pobierzZwroty', [], '/after-sales-service-conditions/return-policies', 'zwroty', 'returnPolicies'],
    ['pobierzReklamacje', [], '/after-sales-service-conditions/implied-warranties', 'reklamacje', 'impliedWarranties'],
    ['pobierzGwarancje', [], '/after-sales-service-conditions/warranties', 'gwarancje', 'warranties'],
    ['pobierzProducentow', [], '/sale/responsible-producers', 'producenci', 'responsibleProducers'],
    ['pobierzOsobyOdpowiedzialne', [], '/sale/responsible-persons', 'osoby', 'responsiblePersons'],
    ['dopasujKategorie', ['Lampy wiszące'], '/sale/matching-categories', 'kategorie', 'matchingCategories'],
  ];
  for (const [metoda, argumenty, sc, klucz, pole] of PRZYPADKI) {
    it(`${metoda} → GET ${sc}, oddaje listę ${pole}; brak listy = błąd`, async () => {
      const { k, wolania } = klient(odp({ cialo: SL[klucz] }));
      expect(await k[metoda](...argumenty)).toEqual(SL[klucz][pole]);
      expect(wolania[0].opcje.method).toBe('GET');
      expect(sciezka(wolania[0].url)).toBe(sc);
      const zly = klient(odp({ cialo: {} }));
      await expect(zly.k[metoda](...argumenty)).rejects.toThrow();
    });
  }

  it('dopasujKategorie wysyła name=', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.kategorie }));
    await k.dopasujKategorie('Lampy wiszące');
    expect(zapytanie(wolania[0].url).get('name')).toBe('Lampy wiszące');
  });

  it('ustawieniaPodatku(kategoria) → GET /sale/tax-settings?category.id=', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.podatek }));
    expect(await k.ustawieniaPodatku('257689')).toEqual(SL.podatek);
    expect(sciezka(wolania[0].url)).toBe('/sale/tax-settings');
    expect(zapytanie(wolania[0].url).get('category.id')).toBe('257689');
  });

  it('podgladOplat(oferta) → POST /pricing/offer-fee-preview z {offer}', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.podgladOplat }));
    expect(await k.podgladOplat(OFERTA.zadanie)).toEqual(SL.podgladOplat);
    expect(wolania[0].opcje.method).toBe('POST');
    expect(sciezka(wolania[0].url)).toBe('/pricing/offer-fee-preview');
    expect(JSON.parse(wolania[0].opcje.body)).toEqual({ offer: { publication: {}, parameters: [], ...OFERTA.zadanie } });
  });

  it('podgladOplat bez publication/parameters dosyła puste (sandbox: bez nich 422)', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.podgladOplat }));
    const oferta = { category: { id: '257' }, sellingMode: { format: 'BUY_NOW', price: { amount: '49.00', currency: 'PLN' } } };
    await k.podgladOplat(oferta);
    expect(JSON.parse(wolania[0].opcje.body)).toEqual({ offer: { ...oferta, publication: {}, parameters: [] } });
    const wlasne = { ...oferta, publication: { duration: 'PT240H' }, parameters: [{ id: '11323', values: ['Nowy'] }] };
    await k.podgladOplat(wlasne);
    expect(JSON.parse(wolania[1].opcje.body)).toEqual({ offer: wlasne });
  });

  it('oplatyOferty(ofertaId) → GET /pricing/offer-quotes?offer.id=', async () => {
    const { k, wolania } = klient(odp({ cialo: SL.oplatyOferty }));
    expect(await k.oplatyOferty('17000000000101')).toEqual(SL.oplatyOferty);
    expect(sciezka(wolania[0].url)).toBe('/pricing/offer-quotes');
    expect(zapytanie(wolania[0].url).get('offer.id')).toBe('17000000000101');
  });

  it('każde nowe wywołanie ma limit czasu (signal) i User-Agent', async () => {
    const { k, wolania } = klient(odp({ cialo: { ...SL.cenniki, ...SL.zwroty, ...SL.reklamacje, ...SL.gwarancje, ...SL.producenci,
      ...SL.osoby, ...SL.kategorie, ...SL.produkty, offers: [], totalCount: 0, tasks: [] } }));
    await k.pobierzCenniki(); await k.pobierzZwroty(); await k.pobierzReklamacje(); await k.pobierzGwarancje();
    await k.pobierzProducentow(); await k.pobierzOsobyOdpowiedzialne(); await k.ustawieniaPodatku('1');
    await k.dopasujKategorie('x'); await k.podgladOplat({}); await k.oplatyOferty('1'); await k.szukajProduktow('5909990000014');
    await k.ofertyKonta(); await k.ofertyPoSygnaturze('x'); await k.wynikKomendy('ilosc', 'c');
    for (const w of wolania) {
      expect(w.opcje.signal).toBeInstanceOf(AbortSignal);
      expect(w.opcje.headers['User-Agent']).toBe(ustawienia.userAgent);
    }
  });
});
