import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createInpostClient,
  LIMIT_ZADANIA_MS,
  LIMIT_ZAPYTANIA_STATUS_MS,
  LIMIT_ODPYTYWANIA_MS,
  ODSTEP_ODPYTYWANIA_MS,
} from '../../src/oms/kurierzy/inpost.js';
import { PROG_ZAWIESZONEGO_NADANIA_MS } from '../../src/domena/przesylka-stan.js';
import { adresOdbiorcy } from '../../src/domena/adres-odbiorcy.js';

// ⚠️ ANI JEDNO WYWOLANIE NIE IDZIE DO PRAWDZIWEGO INPOSTU. Kazda utworzona przesylka jest
// nieodwracalna i platna, wiec caly ten plik rozmawia wylacznie z atrapa `fetch`.
// Ksztalty odpowiedzi sa ODWZOROWANE z rozpoznania na zywym koncie
// (docs/superpowers/notatki/2026-08-01-inpost-shipx-rozpoznanie.md, 44 prawdziwe przesylki),
// a token jest wymyslony.

const TOKEN = 'eyJTESTOWY.TOKEN-INPOST.SEKRET-KTORY-NIE-MA-PRAWA-WYCIEC';
const ORGANIZACJA = 13235;
const URL_API = 'https://shipx.test/v1';

// ⚠️ TELEFON I E-MAIL NADAWCY SA CZESCIA FIKSTURY OD 05.08.2026. InPost odrzuca nadawce
// bez nich (`sender: email: required, phone: required`) — a fikstura bez tych pol opisywala
// nadawce, ktory NIGDY nie moglby nadac prawdziwej paczki. Dlatego cala suita byla zielona,
// podczas gdy produkcja odmawiala pierwszego nadania do paczkomatu (zam. 28173). Nie usuwac.
const nadawca = { nazwa: 'Lumina Marek Zywiecki', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '338451234', email: 'sklep@szkicownia.pl' };

// Zamowienie 28045 z rozpoznania: telefon w Woo ma prefiks '+48', a w przesylce InPostu
// leza gole dziewiec cyfr. Paczkomat SLN06M to jeden z trzech kodow zmierzonych na koncie.
const zamowienie = {
  numer: '28045',
  kwota_pobrania: null,
  punkt_odbioru: 'SLN06M',
  punkt_odbioru_opis: 'Przy myjni bezdotykowej',
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  klient: { email: 'j@k.pl', phone: '+48500900008' },
};

// Dla InPostu paczka to WAGA + GABARYT (szablon skrytki), nigdy trzy wymiary.
const paczka = { waga: 1.2, gabaryt: 'A' };

const PRZESYLKA_BEZ_NUMERU = {
  id: 9993331,
  status: 'created',
  service: 'inpost_locker_standard',
  tracking_number: null,
  custom_attributes: { target_point: 'SLN06M', sending_method: 'any_point' },
};
const NUMER = '520000123456789012345678';
const PRZESYLKA_Z_NUMEREM = { ...PRZESYLKA_BEZ_NUMERU, status: 'confirmed', tracking_number: NUMER };

// Zmierzone sygnatury: PDF zaczyna sie od '%PDF', ZPL od '^XA' (natywny jezyk Zebry GK420t).
const PDF = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n';
const ZPL = '^XA^FO50,50^FDInPost^FS^XZ';

const json = (status, cialo) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof cialo === 'string' ? cialo : JSON.stringify(cialo)),
});

const bin = (status, tresc) => ({
  status,
  ok: status >= 200 && status < 300,
  arrayBuffer: async () => {
    const b = Buffer.from(tresc, 'latin1');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
});

function klient(odpowiedzi = [], override = {}) {
  const fetchImpl = vi.fn();
  odpowiedzi.forEach((o) => fetchImpl.mockResolvedValueOnce(o));
  return {
    c: createInpostClient({ url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca, fetchImpl, ...override }),
    fetchImpl,
  };
}

// Sciezka szczesliwa BEZ odpytywania: POST od razu z numerem, potem dwie etykiety.
const OK = () => [json(201, PRZESYLKA_Z_NUMEREM), bin(200, PDF), bin(200, ZPL)];

const cialoPost = (fetchImpl) => JSON.parse(fetchImpl.mock.calls[0][1].body);

afterEach(() => {
  vi.useRealTimers();
});

describe('createInpostClient.nadaj — kształt żądania z rozpoznania', () => {
  it('woła POST /organizations/{org}/shipments z tokenem w nagłówku', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const [adres, opcje] = fetchImpl.mock.calls[0];
    expect(adres).toBe(`${URL_API}/organizations/${ORGANIZACJA}/shipments`);
    expect(opcje.method).toBe('POST');
    expect(opcje.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('wysyła usługę, sposób nadania i kod paczkomatu tak, jak leżą w prawdziwych przesyłkach', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const body = cialoPost(fetchImpl);
    expect(body.service).toBe('inpost_locker_standard');
    // 44/44 przesylek na koncie ma `any_point` — wlasciciel nadaje w automacie.
    expect(body.sending_method).toBe('any_point');
    expect(body.custom_attributes).toMatchObject({ target_point: 'SLN06M', sending_method: 'any_point' });
    expect(body.reference).toBe('28045');
  });

  it('paczka jedzie jako SZABLON skrytki i waga w kg, bez wymiarów', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(cialoPost(fetchImpl).parcels).toEqual([{ template: 'small', weight: { amount: 1.2, unit: 'kg' } }]);
  });

  // Gabaryt to jedyne, co panel mowi InPostowi o rozmiarze — pomylka znaczy paczke,
  // ktorej automat nie przyjmie.
  it.each([
    ['A', 'small'],
    ['B', 'medium'],
    ['C', 'large'],
  ])('gabaryt %s → szablon %s', async (gabaryt, template) => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka: { ...paczka, gabaryt } });
    expect(cialoPost(fetchImpl).parcels[0].template).toBe(template);
  });

  it.each([
    ['nieznany gabaryt D', 'D'],
    ['pusty gabaryt', ''],
    ['brak gabarytu', undefined],
  ])('%s → błąd operatora, NIGDY cicha domyślka i żadnego wywołania', async (_opis, gabaryt) => {
    const { c, fetchImpl } = klient(OK());
    await expect(c.nadaj({ zamowienie, paczka: { ...paczka, gabaryt } })).rejects.toThrow(/gabaryt/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('waga nie do odczytania → błąd operatora, nie paczka o wadze NaN', async () => {
    const { c, fetchImpl } = klient(OK());
    await expect(c.nadaj({ zamowienie, paczka: { ...paczka, waga: '1,2 kg' } })).rejects.toThrow(/wag/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // PULAPKA POTWIERDZONA NA ZYWYM KONCIE: Woo oddaje '+48500900008', a InPost przyjmuje
  // dokladnie dziewiec cyfr. To ta sama rodzina co kod pocztowy w DPD, gdzie odrzucenie
  // bylo CICHE.
  it('telefon odbiorcy jedzie jako dziewięć cyfr, bez prefiksu +48', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(cialoPost(fetchImpl).receiver.phone).toBe('500900008');
  });

  it('telefonu nie da się sprowadzić do dziewięciu cyfr → odmowa przed wywołaniem API', async () => {
    const { c, fetchImpl } = klient(OK());
    const zle = { ...zamowienie, klient: { ...zamowienie.klient, phone: '12-34' } };
    await expect(c.nadaj({ zamowienie: zle, paczka })).rejects.toThrow(/telefon/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('imię i nazwisko odbiorcy rozbite na dwa pola, e-mail przekazany', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(cialoPost(fetchImpl).receiver).toMatchObject({ first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl' });
  });

  // adresOdbiorcy() podstawia pod `company` imie i nazwisko, gdy klient firmy nie podal
  // (fallback wymuszony przez DPD). Powtorzenie tego samego napisu w polu firmy smieciloby etykiete.
  it('gdy „firma” to tylko fallback z imienia i nazwiska, nie wysyłamy jej jako company_name', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(cialoPost(fetchImpl).receiver.company_name).toBeUndefined();
  });

  it('prawdziwa firma odbiorcy jedzie jako company_name', async () => {
    const { c, fetchImpl } = klient(OK());
    const adres = { ...adresOdbiorcy(zamowienie), company: 'Gammatech Sp. z o.o.' };
    await c.nadaj({ zamowienie, paczka, adres });
    expect(cialoPost(fetchImpl).receiver.company_name).toBe('Gammatech Sp. z o.o.');
  });

  // ⚠️ ADRES NADAWCY: konfiguracja ma ulice jako JEDEN napis, a ShipX rozbija adres na
  // `street` i `building_number`. Numeru domu NIE ZGADUJEMY z tekstu (ta sama decyzja co
  // w services/faktura.js) — caly napis idzie w `line1`.
  it('adres nadawcy jedzie w całości w line1, bez zgadywania numeru domu', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const { sender } = cialoPost(fetchImpl);
    expect(sender.company_name).toBe('Lumina Marek Zywiecki');
    expect(sender.address).toEqual({ line1: 'ul. 1 Maja 5', city: 'Pęki', post_code: '00-650', country_code: 'PL' });
    expect(sender.address.street).toBeUndefined();
    expect(sender.address.building_number).toBeUndefined();
  });

  it('adres odbiorcy PRZEKAZANY jawnie wygrywa z wyliczonym z zamówienia (edycja pozorna)', async () => {
    const { c, fetchImpl } = klient(OK());
    expect(adresOdbiorcy(zamowienie).nazwa).toBe('Jan Kowalski');
    const poprawiony = { ...adresOdbiorcy(zamowienie), nazwa: 'Adam Poprawiony' };
    await c.nadaj({ zamowienie, paczka, adres: poprawiony });
    expect(cialoPost(fetchImpl).receiver).toMatchObject({ first_name: 'Adam', last_name: 'Poprawiony' });
  });

  it('kraj inny niż PL → odmowa przed wywołaniem API', async () => {
    const { c, fetchImpl } = klient(OK());
    const adres = { ...adresOdbiorcy(zamowienie), kraj: 'DE' };
    await expect(c.nadaj({ zamowienie, paczka, adres })).rejects.toThrow(/zagraniczne/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Kod paczkomatu to ADRES przesylki. Bez niego nie ma dokad jej nadac.
  it('zamówienie bez kodu paczkomatu → błąd operatora, żadnej przesyłki u kuriera', async () => {
    const { c, fetchImpl } = klient(OK());
    await expect(c.nadaj({ zamowienie: { ...zamowienie, punkt_odbioru: null }, paczka }))
      .rejects.toThrow(/paczkomat/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('kod paczkomatu przekazany jawnie wygrywa i jest normalizowany do wielkich liter', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka, punktOdbioru: ' wro10b ' });
    expect(cialoPost(fetchImpl).custom_attributes.target_point).toBe('WRO10B');
  });

  it('paczka nr 2 dostaje własną referencję z sufiksem', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka, kolejnosc: 2 });
    expect(cialoPost(fetchImpl).reference).toBe('28045/2');
  });

  // ⚠️ INPOST_URL moze miec koncowy ukosnik — konfiguracja go NIE obcina (inaczej niz SHOP_*_URL).
  it('URL z końcowym ukośnikiem nie daje podwójnego ukośnika w ścieżce', async () => {
    const { c, fetchImpl } = klient(OK(), { url: `${URL_API}/` });
    await c.nadaj({ zamowienie, paczka });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${URL_API}/organizations/${ORGANIZACJA}/shipments`);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${URL_API}/shipments/${PRZESYLKA_Z_NUMEREM.id}/label?format=pdf`);
  });

  // Druga polowa pary z inpost-status.test.js: tam status MUSI jechac na 5 s, tu nadanie
  // MUSI jechac na 30 s. Bez tego testu podmiana limitu w drugą stronę (nadanie na limicie
  // statusu) przerywalaby etykiete po pieciu sekundach — przesylka u kuriera juz by istniala,
  // a operator dostawalby awarie zamiast PDF-a.
  it('nadanie i obie etykiety jadą na LIMICIE NADANIA, nie na krótkim limicie statusu', async () => {
    const szpieg = vi.spyOn(AbortSignal, 'timeout');
    try {
      const { c } = klient(OK());
      await c.nadaj({ zamowienie, paczka });
      // POST + etykieta PDF + etykieta ZPL.
      expect(szpieg).toHaveBeenCalledTimes(3);
      expect(szpieg.mock.calls.map(([ms]) => ms)).toEqual([LIMIT_ZADANIA_MS, LIMIT_ZADANIA_MS, LIMIT_ZADANIA_MS]);
      expect(szpieg).not.toHaveBeenCalledWith(LIMIT_ZAPYTANIA_STATUS_MS);
    } finally {
      szpieg.mockRestore();
    }
  });
});

// ⚠️ MUTACJA OBOWIAZKOWA (a): „cod wysylany zawsze" musi zaczerwienic pierwszy z tych testow.
// `cod: { amount: null }` to NIE jest „brak pobrania", tylko zepsute zadanie.
describe('createInpostClient.nadaj — pobranie', () => {
  it('bez pobrania klucza `cod` W OGÓLE NIE MA w żądaniu', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    const body = cialoPost(fetchImpl);
    expect(body).not.toHaveProperty('cod');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty('cod');
  });

  // ⚠️ FIKSTURA MUSI ODESLAC POBRANIE (poprawione 27.08.2026). Do tego dnia stalo tu `OK()`,
  // czyli odpowiedz BEZ pola `cod` — ksztalt, ktorego prawdziwy ShipX przy pobraniu nigdy nie
  // oddaje. Test byl zielony, bo panel ogladal wylacznie WYSLANE ciało i nie pytal, co wrocilo.
  it('za pobraniem wysyła kwotę i walutę', async () => {
    const { c, fetchImpl } = klient([
      json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: 212.9, currency: 'PLN' } }),
      bin(200, PDF), bin(200, ZPL),
    ]);
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '212.90' }, paczka });
    expect(cialoPost(fetchImpl).cod).toEqual({ amount: 212.9, currency: 'PLN' });
  });

  // '0.00' jest truthy jako STRING — sprawdzenie samej prawdziwosci wyslaloby pobranie
  // na zero zlotych.
  it('kwota „0.00” to nie jest realne pobranie — bez klucza `cod`', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '0.00' }, paczka });
    expect(cialoPost(fetchImpl)).not.toHaveProperty('cod');
  });

  it('kwota nie do odczytania → rzuca, zamiast po cichu wysłać paczkę jako przedpłaconą', async () => {
    const { c, fetchImpl } = klient(OK());
    await expect(c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '212,90' }, paczka }))
      .rejects.toThrow(/pobrani/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Kwota nalezy do ZAMOWIENIA, nie do paczki: powtorzona na paczce nr 2 znaczy, ze klient
  // zaplaci ja DRUGI RAZ.
  it('paczka nr 2 nie niesie pobrania', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie: { ...zamowienie, kwota_pobrania: '212.90' }, paczka, kolejnosc: 2 });
    expect(cialoPost(fetchImpl)).not.toHaveProperty('cod');
  });
});

// ⚠️⚠️ POBRANIE MA WRÓCIĆ Z INPOSTU, A NIE TYLKO DO NIEGO POJECHAĆ (27.08.2026, zam. 1233).
//
// Do tego dnia panel sprawdzał WYŁĄCZNIE, co WYSŁAŁ — testy wyżej oglądają ciało żądania
// i na tym kończą. To wystarczało, dopóki pobranie jeździło samym DPD. Pierwsze allegrowe
// zamówienie na paczkomat ZA POBRANIEM odsłoniło dziurę: umowa z InPostem na przesyłki
// pobraniowe jest NIEPOTWIERDZONA (rozpoznanie 01.08.2026 — 0 przesyłek z `cod` na 49,
// a lista usług organizacji nie ma wariantu pobraniowego).
//
// Tryb awarii, przed którym stoi ten blok, jest CICHY i najdroższy z możliwych: InPost
// przyjmuje przesyłkę, ignoruje pobranie, oddaje numer listu i etykietę. Panel melduje
// „nadane", operator wrzuca paczkę do automatu, klient odbiera ją NIC NIE PŁACĄC — i nikt
// się o tym nie dowiaduje, bo po drodze nie było ani jednego błędu.
//
// Zmierzony kształt: przesyłka BEZ pobrania niesie `cod: { amount: null, currency: null }`
// (rozpoznanie, 44 przesyłki) — czyli pole ISTNIEJE zawsze i `null` w nim jest odpowiedzią
// „pobrania nie ma", a nie brakiem danych.
describe('createInpostClient.nadaj — pobranie MUSI wrócić z InPostu', () => {
  const zPobraniem = { ...zamowienie, kwota_pobrania: '41.29' };

  it('odmawia GŁOŚNO, gdy InPost oddał przesyłkę bez pobrania, o które prosiliśmy', async () => {
    const { c } = klient([json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: null, currency: null } }), bin(200, PDF), bin(200, ZPL)]);
    await expect(c.nadaj({ zamowienie: zPobraniem, paczka })).rejects.toThrow(/pobrani/i);
  });

  // ⚠️ PRZESYLKA JUZ ISTNIEJE, WIEC IDENTYFIKATOR JEST CENNIEJSZY NIZ KOMUNIKAT. Bez niego
  // nie da sie jej ANULOWAC — a anulowanie jest jedyna reakcja na tak zakonczone nadanie.
  it('wyjątek niesie shipmentId, bo tylko z nim da się tę przesyłkę anulować', async () => {
    const { c } = klient([json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: null, currency: null } }), bin(200, PDF), bin(200, ZPL)]);
    await expect(c.nadaj({ zamowienie: zPobraniem, paczka }))
      .rejects.toMatchObject({ shipmentId: PRZESYLKA_Z_NUMEREM.id });
  });

  it('odmawia też, gdy InPost W OGÓLE nie odesłał pola `cod`', async () => {
    // Brak klucza to nie to samo co `null`, ale prowadzi do tej samej paczki bez inkasa.
    const { c } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, PDF), bin(200, ZPL)]);
    await expect(c.nadaj({ zamowienie: zPobraniem, paczka })).rejects.toThrow(/pobrani/i);
  });

  // Kwota rozjechana to nie „drobiazg do poprawienia na karcie" — to inna suma inkasowana
  // od klienta niż ta, której zażądało zamówienie.
  it('odmawia, gdy InPost oddał INNĄ kwotę niż wysłana', async () => {
    const { c } = klient([json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: 4.129, currency: 'PLN' } }), bin(200, PDF), bin(200, ZPL)]);
    await expect(c.nadaj({ zamowienie: zPobraniem, paczka })).rejects.toThrow(/pobrani/i);
  });

  // ⚠️ ZGODNA KWOTA MA PRZEJSC BEZ SZMERU — inaczej straznik zablokowalby KAZDE pobranie
  // i wyszlo by to dopiero przy pierwszej prawdziwej paczce. Grosze porownujemy po
  // zaokragleniu do setnych: 41.29 z JSON-a nie musi byc bit w bit tym, co wyslalismy.
  it('zgodna kwota przechodzi — przesyłka nadana, numer listu oddany', async () => {
    const { c } = klient([
      json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: 41.29, currency: 'PLN' } }),
      bin(200, PDF), bin(200, ZPL),
    ]);
    await expect(c.nadaj({ zamowienie: zPobraniem, paczka }))
      .resolves.toMatchObject({ numerListu: NUMER });
  });

  // ⚠️ TO JEST POWÓD, DLA KTÓREGO PORÓWNANIE IDZIE PO GROSZACH, A NIE PO LICZBACH.
  // Kwota wraca z JSON-a jako `double`, więc nie musi być bit w bit tym, co wysłaliśmy:
  // 41.29 potrafi wrócić jako 41.290000000000003. Porównanie surowych liczb odrzuciłoby
  // taką przesyłkę jako „rozjechane pobranie" i kazało operatorowi anulować przesyłkę,
  // z którą wszystko jest w porządku — czyli strażnik pieniędzy zacząłby blokować
  // POPRAWNE nadania. Zaokrąglenie do setnych jest tu treścią, nie kosmetyką.
  it('szum zmiennoprzecinkowy (41.290000000000003) to TA SAMA kwota, nie rozjazd', async () => {
    const { c } = klient([
      json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: 41.290000000000003, currency: 'PLN' } }),
      bin(200, PDF), bin(200, ZPL),
    ]);
    await expect(c.nadaj({ zamowienie: zPobraniem, paczka }))
      .resolves.toMatchObject({ numerListu: NUMER });
  });

  // Bez pobrania niczego nie sprawdzamy — `cod: { amount: null }` w odpowiedzi jest wtedy
  // normalnym kształtem przesyłki przedpłaconej, a nie usterką.
  it('bez pobrania odpowiedź z pustym `cod` NIE jest błędem', async () => {
    const { c } = klient([
      json(201, { ...PRZESYLKA_Z_NUMEREM, cod: { amount: null, currency: null } }),
      bin(200, PDF), bin(200, ZPL),
    ]);
    await expect(c.nadaj({ zamowienie, paczka })).resolves.toMatchObject({ numerListu: NUMER });
  });
});

// ⚠️ TWORZENIE PRZESYLKI JEST PRAWDOPODOBNIE ASYNCHRONICZNE (wlasciciel mierzy w Apilo
// „kilkanascie sekund"). Kod musi dzialac w OBU wariantach, a okno odpytywania jest TWARDE.
describe('createInpostClient.nadaj — numer nadawany asynchronicznie', () => {
  it('numer w odpowiedzi POST → żadnego odpytywania, od razu etykiety', async () => {
    const { c, fetchImpl } = klient(OK());
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.numerListu).toBe(NUMER);
    expect(w.wTrakcieTworzenia).toBe(false);
    expect(fetchImpl.mock.calls).toHaveLength(3);
    expect(fetchImpl.mock.calls[1][0]).toContain('/label?format=pdf');
  });

  it('brak numeru w POST → odpytuje GET /shipments/{id} co sekundę, aż numer się pojawi', async () => {
    vi.useFakeTimers();
    const { c, fetchImpl } = klient([
      json(201, PRZESYLKA_BEZ_NUMERU),
      json(200, PRZESYLKA_BEZ_NUMERU),
      json(200, PRZESYLKA_BEZ_NUMERU),
      json(200, PRZESYLKA_Z_NUMEREM),
      bin(200, PDF),
      bin(200, ZPL),
    ]);
    const p = c.nadaj({ zamowienie, paczka });
    await vi.advanceTimersByTimeAsync(5 * ODSTEP_ODPYTYWANIA_MS);
    const w = await p;
    expect(w.numerListu).toBe(NUMER);
    expect(w.shipmentId).toBe(PRZESYLKA_BEZ_NUMERU.id);
    expect(w.wTrakcieTworzenia).toBe(false);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${URL_API}/shipments/${PRZESYLKA_BEZ_NUMERU.id}`);
    // POST + trzy odpytania + dwie etykiety.
    expect(fetchImpl.mock.calls).toHaveLength(6);
  });

  // ⚠️ MUTACJA OBOWIAZKOWA (b): odpytywanie bez limitu MUSI zaczerwienic ten test —
  // zadanie HTTP operatora nie ma prawa wisiec w nieskonczonosc.
  it('limit odpytywania jest TWARDY — po 30 s oddaje wynik, nie czeka dalej', async () => {
    vi.useFakeTimers();
    const { c, fetchImpl } = klient([json(201, PRZESYLKA_BEZ_NUMERU)]);
    fetchImpl.mockResolvedValue(json(200, PRZESYLKA_BEZ_NUMERU));

    let skonczone = false;
    const p = c.nadaj({ zamowienie, paczka }).then((w) => { skonczone = true; return w; });
    await vi.advanceTimersByTimeAsync(LIMIT_ODPYTYWANIA_MS + 5000);

    expect(skonczone).toBe(true);
    const w = await p;
    expect(w.numerListu).toBeNull();
    expect(w.wTrakcieTworzenia).toBe(true);
    // Liczba odpytan ograniczona odstepem, a nie „tak szybko, jak sie da": POST + 30 GET-ow.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1 + LIMIT_ODPYTYWANIA_MS / ODSTEP_ODPYTYWANIA_MS);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(10);
  });

  // ⚠️ MUTACJA OBOWIAZKOWA (c): zgubiony `shipmentId` przy wyczerpanym oknie = przesylka,
  // ktorej panel nigdy nie dokonczy ani nie odnajdzie. To ta sama lekcja co „numer listu
  // jest cenniejszy niz PDF" przy DPD.
  it('wyczerpany limit NIE jest błędem, ale MUSI nieść shipment_id', async () => {
    vi.useFakeTimers();
    const { c, fetchImpl } = klient([json(201, PRZESYLKA_BEZ_NUMERU)]);
    fetchImpl.mockResolvedValue(json(200, PRZESYLKA_BEZ_NUMERU));
    const p = c.nadaj({ zamowienie, paczka });
    await vi.advanceTimersByTimeAsync(LIMIT_ODPYTYWANIA_MS + 5000);
    const w = await p;
    expect(w.shipmentId).toBe(PRZESYLKA_BEZ_NUMERU.id);
    expect(w.wTrakcieTworzenia).toBe(true);
    // Etykiet nie ma po co szukac — bez numeru jeszcze nie istnieja.
    expect(w.etykietaPdf).toBeNull();
    expect(w.etykietaZpl).toBeNull();
  });

  it('błąd odpytywania też niesie shipment_id — przesyłka u kuriera już istnieje', async () => {
    vi.useFakeTimers();
    const { c } = klient([
      json(201, PRZESYLKA_BEZ_NUMERU),
      json(500, { error: 'internal_error', message: 'Something went wrong' }),
    ]);
    const p = c.nadaj({ zamowienie, paczka }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(2 * ODSTEP_ODPYTYWANIA_MS);
    const blad = await p;
    expect(blad.shipmentId).toBe(PRZESYLKA_BEZ_NUMERU.id);
    expect(blad.message).toMatch(/Something went wrong/);
  });

  // Zadanie 6 wola to samo pod przyciskiem „Sprawdz ponownie".
  it('sprawdzPrzesylke dobiera numer i etykiety do istniejącej przesyłki', async () => {
    vi.useFakeTimers();
    const { c, fetchImpl } = klient([json(200, PRZESYLKA_Z_NUMEREM), bin(200, PDF), bin(200, ZPL)]);
    const p = c.sprawdzPrzesylke(PRZESYLKA_BEZ_NUMERU.id);
    await vi.advanceTimersByTimeAsync(2 * ODSTEP_ODPYTYWANIA_MS);
    const w = await p;
    expect(w.numerListu).toBe(NUMER);
    expect(w.shipmentId).toBe(PRZESYLKA_BEZ_NUMERU.id);
    expect(Buffer.isBuffer(w.etykietaZpl)).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${URL_API}/shipments/${PRZESYLKA_BEZ_NUMERU.id}`);
  });
});

// ⚠️ MUTACJA OBOWIAZKOWA (d): zamiana sygnatury na sprawdzanie statusu HTTP musi
// zaczerwienic te grupe. Przy inFakcie serwer oddawal 200 z czyms, co nie bylo dokumentem.
describe('createInpostClient — etykieta weryfikowana SYGNATURĄ, nie statusem HTTP', () => {
  it('PDF zaczyna się od %PDF, ZPL od ^XA — oba pobrane przy nadaniu', async () => {
    const { c, fetchImpl } = klient(OK());
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.etykietaPdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(w.etykietaZpl.toString()).toContain('^XA');
    expect(fetchImpl.mock.calls[2][0]).toContain('format=zpl');
  });

  it('HTTP 200 z JSON-em zamiast etykiety → błąd, nie zapisany śmieć', async () => {
    const { c } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, '{"error":"not_ready"}')]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toMatch(/etykiet/i);
    expect(blad.message).toMatch(/not_ready/);
  });

  it('HTTP 200 z pustą odpowiedzią → błąd, nie pusty plik na dysku', async () => {
    const { c } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, '')]);
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/etykiet/i);
  });

  // Druga strona tej samej zasady: liczy sie ZAWARTOSC. Poprawny ZPL pod nietypowym statusem
  // jest etykieta — a kod odpowiedzi sam w sobie nie rozstrzyga niczego.
  it('poprawny ZPL pod nietypowym statusem HTTP jest przyjmowany', async () => {
    const { c } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, PDF), bin(500, ZPL)]);
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.etykietaZpl.toString()).toContain('^XA');
    expect(w.zplBladOpis).toBeNull();
  });

  it('nieznany format etykiety → błąd operatora', async () => {
    const { c, fetchImpl } = klient([]);
    await expect(c.pobierzEtykiete(1, 'epl')).rejects.toThrow(/format/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Ta sama asymetria co przy DPD: PDF jest krytyczny, ZPL nie — w chwili jego pobierania
// przesylka u kuriera JUZ ISTNIEJE, wiec awaria drukarki nie ma prawa wywalic nadania.
describe('createInpostClient.nadaj — awarie po utworzeniu przesyłki', () => {
  it('awaria ZPL → nadanie się udaje, powód zapisany', async () => {
    const { c, fetchImpl } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, PDF)]);
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.numerListu).toBe(NUMER);
    expect(w.etykietaZpl).toBeNull();
    expect(w.zplBladOpis).toMatch(/ECONNRESET/);
  });

  it('awaria PDF → wyjątek, ale niesie numer I shipment_id', async () => {
    const { c, fetchImpl } = klient([json(201, PRZESYLKA_Z_NUMEREM)]);
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.numerListu).toBe(NUMER);
    expect(blad.shipmentId).toBe(PRZESYLKA_Z_NUMEREM.id);
    expect(blad.surowa).toContain(NUMER);
  });

  it('POST 200 bez identyfikatora → błąd z surową odpowiedzią, bo to jedyny ślad', async () => {
    const { c } = klient([json(200, { status: 'created' })]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toMatch(/identyfikator/i);
    expect(blad.surowa).toContain('created');
  });

  it('HTTP 400 z details → komunikat niesie powód odmowy, nie samo „400”', async () => {
    const odmowa = {
      status: 400,
      error: 'validation_failed',
      message: 'Validation failed',
      details: { receiver: { phone: ['is invalid'] } },
    };
    const { c } = klient([json(400, odmowa)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).toMatch(/Validation failed/);
    expect(blad.message).toMatch(/phone: is invalid/);
    expect(blad.surowa).toContain('validation_failed');
  });

  it('odpowiedź, która nie jest JSON-em (proxy) → komunikat z treścią, nie wyjątek parsera', async () => {
    const { c } = klient([json(502, '<html>Bad Gateway</html>')]);
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/Bad Gateway/);
  });

  it('sieć nieosiągalna → czytelny błąd operatora', async () => {
    const { c, fetchImpl } = klient([]);
    fetchImpl.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/nieosiągalny/i);
  });
});

// ⚠️ MUTACJA OBOWIAZKOWA (e): usuniecie maskowania musi zaczerwienic KAZDY z tych testow.
// W DPD usuniecie maskowania PRZEZYLO mutacje i wyszlo dopiero w recenzji — bo test
// sprawdzal '.toContain("<")' zamiast nieobecnosci sekretu.
describe('createInpostClient — token nigdy nie wycieka', () => {
  it('komunikat awarii sieci nie niesie tokenu', async () => {
    const { c, fetchImpl } = klient([]);
    fetchImpl.mockRejectedValueOnce(new Error(`fetch failed (authorization: Bearer ${TOKEN})`));
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).not.toContain(TOKEN);
    expect(blad.message).toContain('***');
  });

  it('błąd ShipX odbijający nagłówek nie przenosi tokenu do komunikatu ani do surowej', async () => {
    const echo = { status: 401, error: 'unauthorized', message: `Invalid token: ${TOKEN}` };
    const { c } = klient([json(401, echo)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).not.toContain(TOKEN);
    expect(blad.message).toContain('***');
    expect(blad.surowa).not.toContain(TOKEN);
    expect(blad.surowa).toContain('***');
  });

  it('surowa odpowiedź zapisywana w bazie nie niesie tokenu', async () => {
    const zEchem = { ...PRZESYLKA_Z_NUMEREM, debug: `Bearer ${TOKEN}` };
    const { c } = klient([json(201, zEchem), bin(200, PDF), bin(200, ZPL)]);
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.surowa).toContain('tracking_number');
    expect(w.surowa).not.toContain(TOKEN);
    expect(w.surowa).toContain('***');
  });

  it('powód awarii ZPL (trafia do logu zamówienia) też jest oczyszczony', async () => {
    const { c, fetchImpl } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, PDF)]);
    fetchImpl.mockRejectedValueOnce(new Error(`TLS error for Bearer ${TOKEN}`));
    const w = await c.nadaj({ zamowienie, paczka });
    expect(w.zplBladOpis).not.toContain(TOKEN);
    expect(w.zplBladOpis).toContain('***');
  });

  it('treść odpowiedzi etykiety wpisana do komunikatu też jest oczyszczona', async () => {
    const { c } = klient([json(201, PRZESYLKA_Z_NUMEREM), bin(200, `{"error":"bad token ${TOKEN}"}`)]);
    const blad = await c.nadaj({ zamowienie, paczka }).catch((e) => e);
    expect(blad.message).not.toContain(TOKEN);
    expect(blad.message).toContain('***');
  });
});

describe('createInpostClient — walidacja konfiguracji', () => {
  const pelna = { url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca, fetchImpl: vi.fn() };

  // ⚠️ `config.nadawca` jest NULL-em, gdy panel wstal bez sekcji DPD. Klient InPostu ma wtedy
  // ODMOWIC, a nie nadac przesylke bez nadawcy.
  it('brak nadawcy → czytelny błąd już przy tworzeniu klienta', () => {
    expect(() => createInpostClient({ ...pelna, nadawca: null })).toThrow(/nadawca/i);
  });

  it('nadawca z PUSTYMI polami → błąd wskazujący pola, a nie cicha zgoda', () => {
    const pusty = { nazwa: 'Lumina', ulica: '', kod: '', miasto: '' };
    expect(() => createInpostClient({ ...pelna, nadawca: pusty }))
      .toThrow(/nadawca\.ulica.*nadawca\.kod.*nadawca\.miasto/);
  });

  it.each(['token', 'organizacja', 'url'])('brak %s → czytelny błąd przy tworzeniu klienta', (klucz) => {
    expect(() => createInpostClient({ ...pelna, [klucz]: undefined })).toThrow(new RegExp(klucz));
  });

  it('telefon nadawcy nie do odczytania → błąd konfiguracji przy starcie, nie przy paczce', () => {
    expect(() => createInpostClient({ ...pelna, nadawca: { ...nadawca, phone: '12-34' } }))
      .toThrow(/NADAWCA_TELEFON/);
  });

  it('poprawny telefon nadawcy jedzie jako dziewięć cyfr', async () => {
    const { c, fetchImpl } = klient(OK(), { nadawca: { ...nadawca, phone: '+48 33 845 00 00' } });
    await c.nadaj({ zamowienie, paczka });
    expect(cialoPost(fetchImpl).sender.phone).toBe('338450000');
  });

  it('kompletna konfiguracja → tworzy klienta bez wyjątku', () => {
    expect(() => createInpostClient(pelna)).not.toThrow();
  });
});

describe('createInpostClient — twarde limity czasu', () => {
  it('każde żądanie niesie własny sygnał przerwania', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    for (const [, opcje] of fetchImpl.mock.calls) {
      expect(opcje.signal).toBeInstanceOf(AbortSignal);
      expect(opcje.signal.aborted).toBe(false);
    }
    expect(fetchImpl.mock.calls[0][1].signal).not.toBe(fetchImpl.mock.calls[1][1].signal);
  });

  it('limit żądania jest krótszy niż domyślne czekanie undici (300 s)', () => {
    expect(LIMIT_ZADANIA_MS).toBeGreaterThan(0);
    expect(LIMIT_ZADANIA_MS).toBeLessThan(300_000);
  });

  // NIEZMIENNIK jak przy DPD: „przesylka starsza od progu" MUSI znaczyc „nic juz nie leci",
  // inaczej odblokowanie osieroconego wiersza da druga paczke.
  it('najdłuższe możliwe nadanie (z oknem odpytywania) jest KRÓTSZE niż próg zawieszonego nadania', () => {
    expect(LIMIT_ODPYTYWANIA_MS + 4 * LIMIT_ZADANIA_MS).toBeLessThan(PROG_ZAWIESZONEGO_NADANIA_MS);
  });

  // Samo porownanie stalych nie odroznia „relacja zachodzi" od „relacja jest WYMUSZONA".
  it('moduł ma strażnika wymuszającego tę relację przy wczytaniu', () => {
    const zrodlo = readFileSync(fileURLToPath(new URL('../../src/oms/kurierzy/inpost.js', import.meta.url)), 'utf8');
    expect(zrodlo).toMatch(/if\s*\(\s*NAJDLUZSZE_NADANIE_MS\s*>=\s*PROG_ZAWIESZONEGO_NADANIA_MS\s*\)/);
    expect(zrodlo).toMatch(/throw new Error\(/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// NADAWCA: e-mail i telefon — WYMAGANE PRZEZ InPost, NIEWYMAGANE PRZEZ DPD.
//
// ⚠️ TO JEST USTERKA Z PIERWSZEGO PRAWDZIWEGO NADANIA DO PACZKOMATU (05.08.2026,
// zam. 28173). Zywe API oddalo:
//   „There are some validation errors. … sender: email: required, phone: required"
// Adres nadawcy powstal pod DPD, ktore ani maila, ani telefonu nie wymaga — wiec pola
// `email` w ogole nie bylo w konfiguracji, a `phone` jechalo WARUNKOWO. Wszystkie
// dotychczasowe testy przechodzily, bo fikstura `nadawca` wyzej TEZ ich nie ma: atrapa
// nie moze odrzucic czegos, czego prawdziwy serwer wymaga. To ta sama lekcja, co przy
// fakturze w lipcu — „integracja przetestowana na atrapach nie jest przetestowana".
//
// ⚠️ ODMOWA, A NIE UBICIE USLUGI (decyzja wlasciciela 05.08). Brak tych pol NIE MOZE
// przewrocic panelu przy starcie: DPD dziala bez nich, a panel obsluguje wszystkie
// zamowienia. Dlatego `createInpostClient` wstaje, a odmawia dopiero `nadaj()` — glosno
// i z nazwa brakujacej zmiennej srodowiskowej.
// ═══════════════════════════════════════════════════════════════════════════════════
describe('createInpostClient — e-mail i telefon nadawcy (usterka 05.08.2026)', () => {
  const pelnyNadawca = { ...nadawca, phone: '338451234', email: 'sklep@szkicownia.pl' };

  it('sender w żądaniu niesie e-mail i telefon nadawcy', async () => {
    const { c, fetchImpl } = klient(OK(), { nadawca: pelnyNadawca });
    await c.nadaj({ zamowienie, paczka });
    const { sender } = cialoPost(fetchImpl);
    expect(sender.email).toBe('sklep@szkicownia.pl');
    expect(sender.phone).toBe('338451234');
  });

  it('BRAK telefonu → odmowa PRZED wywołaniem InPostu, z nazwą zmiennej', async () => {
    const { c, fetchImpl } = klient(OK(), { nadawca: { ...pelnyNadawca, phone: '' } });
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/DPD_NADAWCA_TELEFON/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('BRAK e-maila → odmowa PRZED wywołaniem InPostu, z nazwą zmiennej', async () => {
    const { c, fetchImpl } = klient(OK(), { nadawca: { ...pelnyNadawca, email: '' } });
    await expect(c.nadaj({ zamowienie, paczka })).rejects.toThrow(/DPD_NADAWCA_EMAIL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Sedno decyzji z 05.08: brak konfiguracji paczkomatowej nie ma prawa polozyc panelu.
  it('brak obu pól NIE przeszkadza usłudze wstać — DPD ma działać dalej', () => {
    expect(() => createInpostClient({
      url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, fetchImpl: vi.fn(),
      nadawca: { ...nadawca, phone: '', email: '' },
    })).not.toThrow();
  });

  // Telefon nadawcy przechodzi TA SAMA normalizacje, co telefon odbiorcy: InPost chce
  // dziewieciu cyfr, a w konfiguracji numer bywa zapisany „po ludzku".
  it('telefon nadawcy jest normalizowany do dziewięciu cyfr', async () => {
    const { c, fetchImpl } = klient(OK(), { nadawca: { ...pelnyNadawca, phone: '+48 33 845 12 34' } });
    await c.nadaj({ zamowienie, paczka });
    expect(cialoPost(fetchImpl).sender.phone).toBe('338451234');
  });
});
