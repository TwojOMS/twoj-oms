import { describe, it, expect } from 'vitest';
import { createInfaktClient } from '../../src/oms/infakt/client.js';

const odp = (dane, ok = true, status = 200) => async () => ({ ok, status, json: async () => dane });

describe('inFakt: numer KSeF pojedynczej faktury', () => {
  it('oddaje numer KSeF, gdy dokument już tam jest', async () => {
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp({ number: '12/08/2026', ksef_number: '1234563218-20260804-632857000005-03' }) });
    // ⚠️ Od Zadania 8 `pobierzFakture` niesie DALEJ pola surowe z API (`number`,
    // `invoice_date`, `uuid`, `services`) — services/korekta.js ich potrzebuje do zbudowania
    // korekty. `toMatchObject`, nie `toEqual`: ten test pilnuje wyłącznie pary numer/KSeF,
    // reszta kształtu ma własne testy przy korekcie.
    expect(await k.pobierzFakture('uuid-1')).toMatchObject({ numer: '12/08/2026', ksefNumer: '1234563218-20260804-632857000005-03' });
  });

  // ⚠️ Pusty string i null MUSZĄ dać ten sam wynik: czuwacz odróżnia „jest numer" od „nie ma"
  // po `null`, a `''` przeszłoby przez każdy warunek `!= null` i wpisało pustkę jako sukces —
  // czyli faktura pojechałaby do Allegro BEZ numeru KSeF, choć panel twierdziłby, że z nim.
  it('pusty numer to NULL, nie pusty string', async () => {
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp({ number: '13/08/2026', ksef_number: '' }) });
    expect((await k.pobierzFakture('uuid-2')).ksefNumer).toBeNull();
    const k2 = createInfaktClient({ apiKey: 'X', fetchImpl: odp({ number: '14/08/2026' }) });
    expect((await k2.pobierzFakture('uuid-3')).ksefNumer).toBeNull();
  });

  // ⚠️ Zadanie 8: services/korekta.js buduje korekte z TEGO odczytu, nie z zamowienia —
  // faktura mogla zostac poprawiona recznie w inFakcie. Bez tych pol korekta zawsze
  // odmawialaby ("Faktura z inFaktu nie ma ani jednej pozycji"), bo `paryKorekty` czyta
  // `faktura.services`.
  it('niesie dalej pola surowe potrzebne do zlozenia korekty (number, invoice_date, uuid, services)', async () => {
    const dane = {
      number: '12/08/2026', invoice_date: '2026-08-01', uuid: 'uuid-1',
      services: [{ name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23' }],
    };
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp(dane) });
    const wynik = await k.pobierzFakture('uuid-1');
    expect(wynik.number).toBe('12/08/2026');
    expect(wynik.invoice_date).toBe('2026-08-01');
    expect(wynik.uuid).toBe('uuid-1');
    expect(wynik.services).toEqual(dane.services);
  });

  // ⚠️⚠️ PRZYPIĘCIE KSZTAŁTU NA WEJŚCIU ŚCIEŻKI PIENIĘDZY (recenzja poprawkowa 28.08.2026, W2).
  // Usunięcie `status` i `left_to_pay` z `pobierzFakture` dawało CAŁĄ SUITĘ ZIELONĄ (zmierzone:
  // 9759/9759), a zmieniało zachowanie tak, że czuwacz pobrań przestawał rozpoznawać dokumenty
  // JUŻ OPŁACONE i wysyłał `POST /paid.json` do każdego doręczonego pobrania — także tych
  // rozliczonych ręcznie przez właściciela. Powód fałszywej zieleni: wszystkie testy skanu
  // wstrzykują własną atrapę `infakt`, a jedyny test kształtu klienta używał `toMatchObject`
  // na podzbiorze pól (test wyżej), więc BRAKU pola nie zauważał.
  //
  // Dlatego oba pola są tu sprawdzane WPROST, z prawdziwymi wartościami z pomiaru 28.08.2026
  // (`18/08/2026`: `delivery` I `paid`, `left_to_pay` NIEZEROWE mimo zapłaty — oznaczenie
  // zapłaty w inFakcie tego pola nie zeruje).
  it('niesie status i left_to_pay — na nich stoi rozpoznanie zapłaty w skanie pobrań', async () => {
    const dane = {
      number: '18/08/2026', invoice_date: '2026-08-10', uuid: 'uuid-cod',
      status: 'paid', left_to_pay: 22089, payment_method: 'delivery',
    };
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp(dane) });
    const wynik = await k.pobierzFakture('uuid-cod');
    expect(wynik.status).toBe('paid');
    expect(wynik.left_to_pay).toBe(22089);
  });

  // Dokument bez tych pól ma dać `null`, a nie `undefined`: `stanZaplaty`
  // (domain/lista-faktur.js) odróżnia „inFakt podał kwotę 0" od „nie podał nic", a `undefined`
  // przechodzące przez `??` gdziekolwiek dalej zamieniłoby brak danych w cichą zgodę.
  it('brak statusu i kwoty w odpowiedzi daje null, nie undefined', async () => {
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp({ number: '12/08/2026' }) });
    const wynik = await k.pobierzFakture('uuid-1');
    expect(wynik.status).toBeNull();
    expect(wynik.left_to_pay).toBeNull();
  });

  // Brak `services` w odpowiedzi (np. blad odczytu czesciowego) ma dac PUSTA LISTE, nie
  // `undefined` — `paryKorekty` czyta `faktura?.services ?? []` i tak, ale usluga korekty
  // ma dostac ksztalt jednoznaczny, a nie polegac na fallbacku w dwoch miejscach naraz.
  it('brak services w odpowiedzi daje pusta liste, nie undefined', async () => {
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp({ number: '12/08/2026' }) });
    expect((await k.pobierzFakture('uuid-1')).services).toEqual([]);
  });

  it('pyta o właściwy zasób', async () => {
    const wolania = [];
    const k = createInfaktClient({
      apiKey: 'X',
      fetchImpl: async (url) => { wolania.push(url); return { ok: true, status: 200, json: async () => ({}) }; },
    });
    await k.pobierzFakture('uuid-4');
    expect(wolania[0]).toBe('https://api.infakt.pl/api/v3/invoices/uuid-4.json');
  });

  it('błąd inFaktu niesie status dalej', async () => {
    const k = createInfaktClient({ apiKey: 'X', fetchImpl: odp({ error: 'nie ma' }, false, 404) });
    await expect(k.pobierzFakture('uuid-5')).rejects.toMatchObject({ status: 404 });
  });
});

const json = (dane, status = 200) => ({ ok: status < 400, status, json: async () => dane });

describe('KSeF w kliencie inFaktu', () => {
  // ⚠️ TU STAL TEST `statusKsef` — metody, ktorej NIKT nigdy nie zawolal. Usunieta razem
  // z metoda 06.08.2026 (recenzja calosci, M1); uzasadnienie stoi w komentarzu w miejscu,
  // z ktorego zniknela (src/oms/infakt/client.js, przy `pobierzFakture`).

  // ⚠️⚠️ WYSYLKA JEST PER DOKUMENT — SPROSTOWANIE Z 07.08.2026. Do tego dnia testy tutaj
  // opisywaly wywolanie WSADOWE (`/v3/ksef2/documents/send.json` z `{uuids: [...]}`) i byly
  // ZIELONE, bo caly ich swiat to atrapa `fetch`: zgadzaly sie same ze soba, a nie z API.
  // Zasob wsadowy NIE ISTNIEJE — kazda prawdziwa wysylka konczyla sie 404 („wysylka FV do
  // KSeF nie dziala", zgloszenie wlasciciela). Zmierzone sonda na zywym API, wylacznie
  // zmyslonymi identyfikatorami:
  //   POST /v3/ksef/documents/{uuid}/send.json    → 410 „API KSeF 1.0 zostalo wylaczone"
  //   POST /v3/ksef2/documents/send.json          → 404 z ROUTERA (HTML)
  //   POST /v3/ksef2/documents/{uuid}/send.json   → 404 JSON-owy = TRASA ISTNIEJE
  //   GET  /v3/ksef2/documents/{uuid}/status.json → 404 JSON-owy = trasa istnieje
  // Literowka w KTORYMKOLWIEK segmencie i kazda inna metoda HTTP daja 404 z routera.
  //
  // ⚠️ LEKCJA, KTORA ZOSTAJE: atrapa `fetch` nie odrzuci tego, czego wymaga prawdziwy serwer.
  // Ta sama rodzina bledu co fikstura nadawcy bez telefonu i e-maila przy pierwszym
  // paczkomacie (05.08) — suita byla zielona, a nadanie odbilo sie od InPostu.
  it('wysyłka idzie na ksef2, PO JEDNYM dokumencie, z uuid w ŚCIEŻCE', async () => {
    let adres = null; let metoda = null; let cialo = 'NIE-BYLO-POLA';
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async (u, o) => {
      adres = u; metoda = o.method; cialo = o.body; return json({}, 201);
    } });
    await c.wyslijDokumentDoKsef('uuid-abc');
    expect(adres).toBe('https://api.infakt.pl/api/v3/ksef2/documents/uuid-abc/send.json');
    expect(metoda).toBe('POST');
    // ⚠️ BEZ CIALA. Zmierzone: POST bez ladunku dochodzi do handlera (zmyslony uuid oddaje
    // JSON-owe „nie znaleziono", a nie 400 o brakujacym ciele). Pusta koperta bylaby
    // zgadywaniem ksztaltu, ktorego nikt nie potrzebuje.
    expect(cialo).toBeUndefined();
  });

  it('identyfikator jest kodowany do adresu, a nie wklejany surowo', async () => {
    let adres = null;
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async (u) => { adres = u; return json({}, 201); } });
    await c.wyslijDokumentDoKsef('a/b?c');
    expect(adres).toContain('/documents/a%2Fb%3Fc/send.json');
  });

  // ⚠️ Odmowa PRZED zadaniem HTTP dostaje `status: 400` CELOWO — regula zwolnienia rezerwacji
  // rozpoznaje jednoznacznosc po 4xx, a to jest odmowa najbardziej jednoznaczna z mozliwych:
  // do inFaktu nie poszlo NIC. Bez tego tagu wygladalaby jak zerwane polaczenie i trzymalaby
  // rezerwacje NA ZAWSZE za wywolanie, ktore nigdy nie opuscilo panelu.
  it('pusty identyfikator to odmowa PRZED żądaniem, ze statusem 4xx', async () => {
    let wolano = false;
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async () => { wolano = true; return json({}, 201); } });
    await expect(c.wyslijDokumentDoKsef()).rejects.toMatchObject({ status: 400 });
    await expect(c.wyslijDokumentDoKsef('')).rejects.toThrow(/nie ma czego wysłać/i);
    await expect(c.wyslijDokumentDoKsef('   ')).rejects.toThrow(/nie ma czego wysłać/i);
    expect(wolano).toBe(false);
  });

  // ⚠️ KSZTALTU ODPOWIEDZI NIKT NIE WIDZIAL (zasob nieodwracalny, probnego telefonu nie bylo),
  // wiec oddajemy ja SUROWA. Pierwsza nadzorowana wysylka pokaze, co tam naprawde przychodzi.
  it('oddaje surową odpowiedź inFaktu, bez interpretacji', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async () => json({ status: 'ok', accepted: 7 }, 201) });
    expect(await c.wyslijDokumentDoKsef('u1')).toEqual({ odpowiedzInfaktu: { status: 'ok', accepted: 7 } });
  });

  it('pusta odpowiedź to null, nie wyjątek', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async () => json(null, 201) });
    expect((await c.wyslijDokumentDoKsef('u1')).odpowiedzInfaktu).toBeNull();
  });

  it('odmowa inFaktu niesie status dalej — po nim regułą jest zwolnienie rezerwacji', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async () => json({ error: 'Integracja nieaktywna' }, 422) });
    await expect(c.wyslijDokumentDoKsef('u1')).rejects.toThrow(/Integracja nieaktywna/);
    await expect(c.wyslijDokumentDoKsef('u1')).rejects.toMatchObject({ status: 422 });
  });
});
