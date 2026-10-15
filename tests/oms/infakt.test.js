import { describe, it, expect, vi } from 'vitest';
import { createInfaktClient, LIMIT_ZADANIA_MS } from '../../src/oms/infakt/client.js';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../src/domena/faktura-stan.js';

const odp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

function klient(...odpowiedzi) {
  const fetchImpl = vi.fn();
  odpowiedzi.forEach((o) => fetchImpl.mockResolvedValueOnce(o));
  return { c: createInfaktClient({ apiKey: 'SEKRET', fetchImpl }), fetchImpl };
}

// Bez twardego limitu zadania "rezerwacja starsza od progu" moglaby oznaczac wywolanie,
// ktore NADAL ZYJE (undici czeka na naglowki 300 000 ms = dokladnie tyle, ile prog).
// Operator odblokowalby wtedy zamowienie w trakcie zywego wystawiania, a drugie
// klikniecie dalo by DWA dokumenty w KSeF. Te dwa testy pilnuja, ze to niemozliwe.
describe('limit żądania kontra próg zawieszonej faktury', () => {
  it('limit pojedynczego żądania jest KRÓTSZY niż próg uznania rezerwacji za osieroconą', () => {
    expect(LIMIT_ZADANIA_MS).toBeLessThan(PROG_ZAWIESZONEJ_FAKTURY_MS);
  });

  it('każde żądanie do inFaktu niesie własny AbortSignal z tym limitem', async () => {
    const { c, fetchImpl } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await c.wystaw({ services: [] });
    const { signal } = fetchImpl.mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  // Przerwane po limicie zadanie jest NIEJEDNOZNACZNE — dokument mogl powstac po stronie
  // inFaktu, mimo ze odpowiedzi nie zobaczylismy. Brak `status` to sygnal dla uslugi,
  // zeby zablokowac ponowienie zamiast wystawic drugi dokument.
  it('przerwanie po limicie jest awarią niejednoznaczną, bez statusu', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const c = createInfaktClient({ apiKey: 'SEKRET', fetchImpl });
    const blad = await c.wystaw({}).catch((e) => e);
    expect(blad.status).toBeUndefined();
    expect(blad.message).not.toContain('SEKRET');
  });
});

describe('createInfaktClient.znajdzKlientaPoNip', () => {
  // PULAPKA: zwykle ?q=<nip> oddaje pustke BEZ bledu, czyli wyglada jak "klienta nie ma"
  // i kazaloby zakladac duplikat przy kazdej fakturze.
  it('szuka przez q[nip_eq], nie przez zwykłe q', async () => {
    const { c, fetchImpl } = klient(odp(200, { entities: [{ id: 7 }], metainfo: { total_count: 1 } }));
    await c.znajdzKlientaPoNip('1000001201');
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain('q%5Bnip_eq%5D=1000001201');
  });

  it('oddaje id, gdy klient jest w kartotece', async () => {
    const { c } = klient(odp(200, { entities: [{ id: 7 }], metainfo: { total_count: 1 } }));
    expect(await c.znajdzKlientaPoNip('1000001201')).toBe(7);
  });

  it('oddaje null, gdy kartoteka go nie ma', async () => {
    const { c } = klient(odp(200, { entities: [], metainfo: { total_count: 0 } }));
    expect(await c.znajdzKlientaPoNip('1000001201')).toBeNull();
  });

  // Kartoteka ma ~275 wpisow zakladanych latami, wiec duplikat po NIP-ie jest realny.
  // Branie entities[0] wybieraloby nabywce faktury LOSOWO (kolejnosc ustala inFakt),
  // a zly nabywca na dokumencie w KSeF to korekta, nie poprawka.
  it('więcej niż jedno trafienie → odmowa, a nie losowy wybór nabywcy', async () => {
    const { c } = klient(odp(200, { entities: [{ id: 7 }, { id: 9 }], metainfo: { total_count: 2 } }));
    await expect(c.znajdzKlientaPoNip('1000001201')).rejects.toThrow(/2 wpisów/);
  });

  // total_count wygrywa z dlugoscia entities: przy paginacji strona moze miec 1 wpis,
  // a duplikaty i tak istniec.
  it('duplikat widoczny tylko w total_count też blokuje', async () => {
    const { c } = klient(odp(200, { entities: [{ id: 7 }], metainfo: { total_count: 3 } }));
    await expect(c.znajdzKlientaPoNip('1000001201')).rejects.toThrow(/3 wpisów/);
  });
});

describe('createInfaktClient.zalozKlienta', () => {
  it('oddaje id nowego wpisu', async () => {
    const { c, fetchImpl } = klient(odp(201, { id: 99, company_name: 'ACME' }));
    expect(await c.zalozKlienta({ company_name: 'ACME' })).toBe(99);
    expect(fetchImpl.mock.calls[0][0]).toContain('/v3/clients.json');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  // Prawdziwy format bledu inFaktu: `error` to zawsze ten sam ogolnik,
  // cala tresc jest w mapie `errors`.
  it('błąd niesie treść z errors, nie ogólnik z error', async () => {
    const { c } = klient(odp(422, {
      error: 'Wadliwy zasób. Popraw błędy i spróbuj ponownie.',
      errors: { company_name: ['Proszę podać nazwę firmy.'] },
    }));
    await expect(c.zalozKlienta({})).rejects.toThrow(/Proszę podać nazwę firmy/);
  });
});

describe('createInfaktClient.wystaw', () => {
  it('strzela POST-em z kluczem w nagłówku', async () => {
    const { c, fetchImpl } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await c.wystaw({ services: [] });
    expect(fetchImpl.mock.calls[0][0]).toContain('/v3/invoices.json');
    expect(fetchImpl.mock.calls[0][1].headers['X-inFakt-ApiKey']).toBe('SEKRET');
  });

  // Dokumentacja API pokazuje kopertę `{"invoice": {...}}`. Płaskie pola i kopertowane
  // dawały dotąd identyczny błąd walidacji (nierozstrzygnięta wątpliwość) — ten test
  // pilnuje, żeby żądanie faktycznie było zakopertowane, nie zgadywane na ślepo.
  it('zawija żądanie w kopertę { invoice: ... }', async () => {
    const { c, fetchImpl } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await c.wystaw({ client_id: 7, services: [] });
    const cialo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cialo).toEqual({ invoice: { client_id: 7, services: [] } });
  });

  // Daty terminu płatności (`invoice_date`, `payment_date` — nazwy z dokumentacji API v3)
  // mają dojść do inFaktu WEWNĄTRZ koperty, obok pozycji. Klient ich nie zna z nazwy i nie
  // ma znać: przepuszcza payload w całości, a co w nim jest, rozstrzyga domena.
  it('przepuszcza daty terminu płatności do koperty { invoice: ... }', async () => {
    const { c, fetchImpl } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await c.wystaw({
      client_id: 7, services: [], invoice_date: '2026-08-03', payment_date: '2026-08-17',
    });
    const cialo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cialo.invoice.invoice_date).toBe('2026-08-03');
    expect(cialo.invoice.payment_date).toBe('2026-08-17');
  });

  // Wariant „bez terminu": brak `payment_date` w payloadzie ma znaczyć brak `payment_date`
  // w żądaniu — klient nie ma prawa dopisać tu daty od siebie ani przemycić `undefined`.
  it('bez daty płatności w payloadzie żądanie też jej nie ma', async () => {
    const { c, fetchImpl } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await c.wystaw({ client_id: 7, services: [], invoice_date: '2026-08-03' });
    const cialo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cialo.invoice).toEqual({ client_id: 7, services: [], invoice_date: '2026-08-03' });
    expect(cialo.invoice).not.toHaveProperty('payment_date');
  });

  // `wystaw()` MA NIE żądać wysyłki do KSeF w żadnej formie — właściciel robi to sam,
  // ręcznie, wieczorem (patrz faktura.test.js na poziomie usługi). Tu pilnujemy tego samego
  // na poziomie klienta: żądanie nie ma prawa nieść `send_to_ksef`, choćby usługa je podała.
  it('nie dokłada send_to_ksef do żądania, nawet gdy nie ma go w payloadzie', async () => {
    const { c, fetchImpl } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await c.wystaw({ client_id: 7, services: [] });
    const cialo = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(cialo.invoice).not.toHaveProperty('send_to_ksef');
  });

  // Dokumentacja: `ksef_data` (NIE `ksef_status`, którego to API w ogóle nie zwraca) jest
  // PUSTE, dopóki dokument nie pójdzie do KSeF — a panel nigdy sam nie wysyła. Świeżo
  // wystawiona faktura ma więc dostać puste `ksefStatus`, i to jest oczekiwany, normalny wynik.
  it('oddaje uuid, numer i to, co przyszło w ksef_data (puste — dokument jeszcze nie poszedł)', async () => {
    const { c } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026', ksef_data: null }));
    expect(await c.wystaw({})).toEqual({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: null });
  });

  // Brak pola w odpowiedzi ma być traktowany tak samo jak jawny null — panel niczego
  // na tym polu nie sprawdza ani nie blokuje.
  it('brak pola ksef_data w odpowiedzi NIE jest błędem', async () => {
    const { c } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026' }));
    await expect(c.wystaw({})).resolves.toEqual({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: null });
  });

  // Gdyby inFakt kiedyś oddał tu coś niepustego (np. po ręcznej wysyłce tego samego dnia),
  // panel ma to zapisać wiernie, a nie ignorować.
  it('zapisuje ksef_data wiernie, gdy inFakt coś w nim odda', async () => {
    const { c } = klient(odp(201, { uuid: 'u1', number: 'FV/1/2026', ksef_data: 'wyslano' }));
    expect(await c.wystaw({})).toEqual({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'wyslano' });
  });

  it('błąd niesie powód, ale nie klucz API', async () => {
    const { c } = klient(odp(422, { errors: { client_id: ['Proszę wybrać klienta'] } }));
    const p = c.wystaw({});
    await expect(p).rejects.toThrow(/Proszę wybrać klienta/);
    await expect(p).rejects.not.toThrow(/SEKRET/);
  });

  it('odpowiedź bez treści JSON nie wywraca klienta', async () => {
    const { c } = klient({ status: 500, ok: false, json: async () => { throw new Error('nie JSON'); } });
    await expect(c.wystaw({})).rejects.toThrow(/500/);
  });
});

// ⚠️ TO JEST KROK PO NIEODWRACALNYM — dokument w chwili tego wywolania JUZ ISTNIEJE
// i ma swoje miejsce w numeracji. Klient ma tu jedno zadanie: strzelic pod wlasciwy adres
// i uczciwie powiedziec, co odpowiedzialo. Decyzja „awaria niczego nie psuje" nalezy do
// USLUGI (services/faktura.js) i tam jest sprawdzana.
describe('createInfaktClient.oznaczZaplacona', () => {
  it('strzela POST-em pod /v3/async/invoices/{uuid}/paid.json z kluczem w nagłówku', async () => {
    const { c, fetchImpl } = klient(odp(201, { invoice_task_reference_number: 'ref-1', processing_code: 100 }));
    await c.oznaczZaplacona('u1', { paidDate: '2026-08-06' });
    expect(fetchImpl.mock.calls[0][0]).toContain('/v3/async/invoices/u1/paid.json');
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
    expect(fetchImpl.mock.calls[0][1].headers['X-inFakt-ApiKey']).toBe('SEKRET');
  });

  // Bez `paid_date` inFakt przestawia status, ale data zaplaty na dokumencie jest jego
  // wlasnym domyslem — a to my wiemy, kiedy klient naprawde zaplacil.
  it('niesie paid_date w ciele żądania', async () => {
    const { c, fetchImpl } = klient(odp(201, {}));
    await c.oznaczZaplacona('u1', { paidDate: '2026-08-06' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ paid_date: '2026-08-06' });
  });

  // Brak daty ma znaczyc BRAK POLA, nigdy `paid_date: undefined` ani `null` — pole daty
  // na dokumencie ksiegowym albo niesie prawde, albo nie jedzie wcale.
  it('bez paidDate ciało NIE ma pola paid_date', async () => {
    const { c, fetchImpl } = klient(odp(201, {}));
    await c.oznaczZaplacona('u1');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({});
  });

  // uuid jedzie do SCIEZKI, wiec musi byc zakodowany — tak samo jak w pobierzPdf.
  it('koduje uuid w adresie', async () => {
    const { c, fetchImpl } = klient(odp(201, {}));
    await c.oznaczZaplacona('a/b', { paidDate: '2026-08-06' });
    expect(fetchImpl.mock.calls[0][0]).toContain('/v3/async/invoices/a%2Fb/paid.json');
  });

  // Bez uuid nie ma czego oznaczac — odmowa MA odbic sie lokalnie, bez strzalu w siec pod
  // adres `/v3/async/invoices/null/paid.json`, ktory trafilby w CUDZY dokument albo w nic.
  it('bez uuid nie strzela do sieci wcale', async () => {
    const { c, fetchImpl } = klient(odp(201, {}));
    await expect(c.oznaczZaplacona(null, { paidDate: '2026-08-06' })).rejects.toThrow(/numeru dokumentu/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ⚠️ 201 ZNACZY „PRZYJETO ZLECENIE", NIE „ZROBIONE" — operacja jest ASYNCHRONICZNA.
  // Oddajemy referencje zadania i ani slowa wiecej; niczego tu nie odpytujemy w petli.
  it('oddaje referencję zadania — bo 201 to przyjęcie zlecenia, nie jego wykonanie', async () => {
    const { c } = klient(odp(201, { invoice_task_reference_number: 'ref-1', processing_code: 100 }));
    expect(await c.oznaczZaplacona('u1', { paidDate: '2026-08-06' })).toEqual({ referencja: 'ref-1' });
  });

  // ⚠️ `zapytaj` parsuje odpowiedz jako JSON i na pustym ciele oddaje `null` (bez rzucania).
  // Gdyby inFakt oddal 201 bez tresci, oznaczenie i tak zostalo ZLECONE — brak referencji
  // nie jest awaria i nie ma prawa wywrocic kroku po nieodwracalnym.
  it('201 z pustym ciałem NIE jest błędem — sama referencja jest pusta', async () => {
    const { c } = klient({ status: 201, ok: true, json: async () => { throw new Error('nie JSON'); } });
    await expect(c.oznaczZaplacona('u1')).resolves.toEqual({ referencja: null });
  });

  // ⚠️ SCIEZKA STOI NA DOKUMENTACJI, a inFakt oddaje 404 zarowno na trase nieistniejaca,
  // jak i na zla metode. Gdyby dokumentacja klamala, blad ma NIESC STATUS (usluga po nim
  // rozpoznaje jednoznaczna odmowe) i powod — ale nigdy klucza API.
  it('404 (np. zła ścieżka) niesie status i powód, bez klucza API', async () => {
    const { c } = klient(odp(404, { error: 'Not Found' }));
    const blad = await c.oznaczZaplacona('u1', { paidDate: '2026-08-06' }).catch((e) => e);
    expect(blad.status).toBe(404);
    expect(blad.message).toMatch(/404/);
    expect(blad.message).not.toContain('SEKRET');
  });

  it('błąd walidacji niesie treść z errors, nie ogólnik z error', async () => {
    const { c } = klient(odp(422, {
      error: 'Wadliwy zasób. Popraw błędy i spróbuj ponownie.',
      errors: { paid_date: ['nie może być wcześniejsza niż data wystawienia'] },
    }));
    await expect(c.oznaczZaplacona('u1', { paidDate: '2026-08-01' }))
      .rejects.toThrow(/wcześniejsza niż data wystawienia/);
  });
});
