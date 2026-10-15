import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createWooClient } from '../../../src/oms/woo/client.js';
import { utworzWzor, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { wyslijDoSklepow } from '../../../src/moduly/magazyn/services/magazyn-zapis.js';

// ZAPIS SKU I WYMIAROW DO SKLEPOW — jedyne miejsce w panelu, ktore PISZE do sklepu,
// ktory sprzedaje. Pomylka tutaj nie jest literowka na ekranie: SKU jest tozsamoscia
// produktu, a zapisu NIE DA SIE COFNAC z panelu.
//
// ⚠️⚠️ PIEC RZECZY, KTORYCH TA SUITA PILNUJE:
//   (1) ZAKAZ NADPISANIA NIEPUSTEGO SKU SPRAWDZANY NA ZYWO, TUZ PRZED ZAPISEM — nie z lustra.
//       Lustro jest swieze wylacznie na moment ostatniego klikniecia „Odczytaj katalogi";
//   (2) IZOLACJA AWARII PER PRODUKT — jeden produkt, ktory odmowi, nie zatrzymuje reszty;
//   (3) ZESTAW LICZONY PONOWNIE przy zatwierdzeniu, ze stanu biezacego, nie z formularza;
//   (4) SCIEZKA ROZSTRZYGA RODZIC vs WARIANT — zapis na rodzica jest w Woo cichy;
//   (5) po zapisie ZOSTAJE LISTA WYNIKOW, bez przekierowania: jest jedynym swiadectwem
//       operacji, ktorej nie da sie cofnac klknieciem.

const Z = (nad = {}) => ({
  kanal: 'pro', sciezka: 'products/900', pola: { sku: 'A-1' }, opis: '…',
  produkt_id: '900', wariant_id: '', nazwa: 'Tabliczka', wzor_id: 1, ...nad,
});

/** Klient sklepu: produkt bez numeru, zapis sie udaje. */
const klientO = (nad = {}) => ({
  pobierzProdukt: vi.fn().mockResolvedValue({ sku: '', dimensions: {} }),
  zapiszProdukt: vi.fn().mockResolvedValue({}),
  ustawienieSklepu: vi.fn().mockResolvedValue('cm'),
  ...nad,
});

describe('wyslijDoSklepow', () => {
  it('wysyła każdą zmianę na jej ścieżkę', async () => {
    const pro = klientO();
    await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z(), Z({ sciezka: 'products/901' })] });
    expect(pro.zapiszProdukt.mock.calls.map((c) => c[0])).toEqual(['products/900', 'products/901']);
  });

  it('wysyła DOKŁADNIE te pola, które policzyła reguła — nic więcej', async () => {
    const pro = klientO();
    const pola = { sku: 'A-1', dimensions: { length: '100', width: '70' } };
    await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z({ pola })] });
    expect(pro.zapiszProdukt.mock.calls[0][1]).toEqual(pola);
  });

  // ⚠️ Awaria jednej pozycji nie przerywa reszty — ta sama zasada, co przy nadaniu zbiorczym.
  // Przy tysiacu produktow przerwanie w polowie zostawia rejestr rozjechany ze sklepem
  // i nie wiadomo, w ktorym miejscu.
  it('awaria jednej zmiany nie przerywa pozostałych', async () => {
    const pro = klientO({
      zapiszProdukt: vi.fn()
        .mockRejectedValueOnce(new Error('duplikat SKU'))
        .mockResolvedValueOnce({}),
    });
    const w = await wyslijDoSklepow({
      sklepy: { pro }, zmiany: [Z(), Z({ sciezka: 'products/901' })],
    });
    expect(w[0].ok).toBe(false);
    expect(w[0].blad).toMatch(/duplikat/);
    expect(w[1].ok).toBe(true);
  });

  it('kanał bez skonfigurowanego sklepu odmawia, zamiast pomijać po cichu', async () => {
    const w = await wyslijDoSklepow({ sklepy: {}, zmiany: [Z()] });
    expect(w[0].ok).toBe(false);
    expect(w[0].blad).toMatch(/kanał|sklep/i);
  });

  it('kanał o nazwie „constructor" nie znajduje klienta w prototypie', async () => {
    const w = await wyslijDoSklepow({ sklepy: {}, zmiany: [Z({ kanal: 'constructor' })] });
    expect(w[0].ok).toBe(false);
  });

  it('pusta lista zmian nie woła sklepu ani razu', async () => {
    const pro = klientO();
    await wyslijDoSklepow({ sklepy: { pro }, zmiany: [] });
    expect(pro.zapiszProdukt).not.toHaveBeenCalled();
    expect(pro.pobierzProdukt).not.toHaveBeenCalled();
  });

  it('wynik niesie zmianę, żeby ekran wiedział, o czym mówi', async () => {
    const zmiana = Z();
    const [w] = await wyslijDoSklepow({ sklepy: { pro: klientO() }, zmiany: [zmiana] });
    expect(w.zmiana).toBe(zmiana);
  });
});

describe('wyslijDoSklepow — bariera na stanie ŻYWYM', () => {
  // ⚠️⚠️ ROZSTRZYGNIECIE KONTROLERA I NAJWAZNIEJSZY TEST TEJ SUITY. Scenariusz: lustro
  // z poniedzialku pokazuje puste SKU, we wtorek ktos wpisuje numer w WooCommerce, w srode
  // zapis widzi w lustrze pustke i NADPISUJE TOZSAMOSC PRODUKTU. Lustro chodzi z przycisku,
  // wiec bywa tygodniami nieaktualne — jedynym swiezym zrodlem jest sam sklep.
  it('odczytuje produkt ze sklepu TUŻ PRZED zapisem', async () => {
    const pro = klientO();
    await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z()] });
    expect(pro.pobierzProdukt).toHaveBeenCalledWith('products/900');
    // Kolejnosc jest tresc: odczyt PRZED zapisem, nie po nim.
    expect(pro.pobierzProdukt.mock.invocationCallOrder[0])
      .toBeLessThan(pro.zapiszProdukt.mock.invocationCallOrder[0]);
  });

  it('produkt, który w międzyczasie dostał numer w sklepie, NIE jest nadpisywany', async () => {
    const pro = klientO({ pobierzProdukt: vi.fn().mockResolvedValue({ sku: 'PD10' }) });
    const [w] = await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z()] });
    expect(pro.zapiszProdukt).not.toHaveBeenCalled();
    expect(w.ok).toBe(false);
    expect(w.blad).toMatch(/PD10/);
  });

  // MILCZENIE tej samej bariery — inaczej nie dalo by sie zapisac niczego.
  it('produkt z pustym numerem w sklepie jest zapisywany', async () => {
    const pro = klientO({ pobierzProdukt: vi.fn().mockResolvedValue({ sku: '' }) });
    const [w] = await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z()] });
    expect(w.ok).toBe(true);
    expect(pro.zapiszProdukt).toHaveBeenCalled();
  });

  it('produkt z TYM SAMYM numerem w sklepie jest zapisywany (jadą wymiary)', async () => {
    const pro = klientO({ pobierzProdukt: vi.fn().mockResolvedValue({ sku: 'A-1' }) });
    const [w] = await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z()] });
    expect(w.ok).toBe(true);
  });

  // ⚠️ Zmiana, ktora numeru NIE NIESIE (same wymiary), nie ma czego nadpisac — numer
  // w sklepie nie jest dla niej przeszkoda.
  it('zmiana bez numeru nie jest wstrzymywana numerem w sklepie', async () => {
    const pro = klientO({ pobierzProdukt: vi.fn().mockResolvedValue({ sku: 'PD10' }) });
    const [w] = await wyslijDoSklepow({
      sklepy: { pro }, zmiany: [Z({ pola: { dimensions: { length: '100', width: '70' } } })],
    });
    expect(w.ok).toBe(true);
  });

  // ⚠️ FAIL CLOSED. Nie da sie sprawdzic bariery — nie ma zapisu. Odwrotna decyzja kasuje
  // cala te ochrone dokladnie w chwili, w ktorej sklep zachowuje sie dziwnie.
  it('nieudany odczyt stanu ODMAWIA zapisu, zamiast pisać w ciemno', async () => {
    const pro = klientO({ pobierzProdukt: vi.fn().mockRejectedValue(new Error('502 od sklepu')) });
    const [w] = await wyslijDoSklepow({ sklepy: { pro }, zmiany: [Z()] });
    expect(pro.zapiszProdukt).not.toHaveBeenCalled();
    expect(w.ok).toBe(false);
    expect(w.blad).toMatch(/502 od sklepu/);
  });

  it('wstrzymanie jednej pozycji nie zatrzymuje pozostałych', async () => {
    const pro = klientO({
      pobierzProdukt: vi.fn()
        .mockResolvedValueOnce({ sku: 'PD10' })
        .mockResolvedValueOnce({ sku: '' }),
    });
    const w = await wyslijDoSklepow({
      sklepy: { pro }, zmiany: [Z(), Z({ sciezka: 'products/901' })],
    });
    expect(w.map((x) => x.ok)).toEqual([false, true]);
    expect(pro.zapiszProdukt.mock.calls.map((c) => c[0])).toEqual(['products/901']);
  });
});

// ⚠️⚠️ WooCommerce PRZYJMIE `sku` na RODZICU produktu wariantowego, odpowie 200 i numer
// nie pojawi sie na wariancie — czyli tam, gdzie go szukamy i gdzie zyje cena. Ten test
// nie sprawdza naszej funkcji formatujacej sciezke (to robi zapis-do-sklepu.test.js),
// tylko PRZYPINA skutek: atrapa zachowuje sie jak sklep i po zapisie numer ma stac
// na WARIANCIE.
describe('rodzic vs wariant — atrapa zachowująca się jak WooCommerce', () => {
  function atrapaSklepuWoo() {
    const stan = {
      'products/944': { sku: '' },
      'products/944/variations/1091': { sku: '' },
    };
    return {
      stan,
      pobierzProdukt: vi.fn(async (sciezka) => ({ ...stan[sciezka] })),
      // Woo NIE ODMAWIA zapisu sku na rodzicu produktu wariantowego — i to jest cala
      // tresc tej atrapy.
      zapiszProdukt: vi.fn(async (sciezka, pola) => {
        stan[sciezka] = { ...stan[sciezka], ...pola };
        return stan[sciezka];
      }),
    };
  }

  it('numer wariantu ląduje na WARIANCIE, a rodzic zostaje pusty', async () => {
    const pro = atrapaSklepuWoo();
    await wyslijDoSklepow({
      sklepy: { pro },
      zmiany: [Z({ sciezka: 'products/944/variations/1091', pola: { sku: 'PRO-EV-118' } })],
    });
    expect(pro.stan['products/944/variations/1091'].sku).toBe('PRO-EV-118');
    expect(pro.stan['products/944'].sku).toBe('');
  });
});

// ================================================================================
// BARIERA NIE MA PRAWA ZAWIESC OTWARCIE (recenzja 2026-08-12, Critical)
// ================================================================================
//
// ⚠️⚠️ ZNALEZISKO: „nieudany odczyt = odmowa" bylo prawda WYLACZNIE dla odczytow, ktore
// RZUCAJA. Odpowiedz 200 z cialem, ktorego nie rozumiemy, przechodzila przez `strzal` jako
// `dane = null`, wiec `wSklepie?.sku` bylo `undefined`, a regula czytala to jako „produkt
// nie ma numeru" — i PUT szedl, nadpisujac tozsamosc produktu, ktory ja MA.
//
// ⚠️⚠️ DLACZEGO TO BYLO CRITICAL, A NIE „do poprawy przy okazji": ekran pokazywal wtedy
// „poszło", dokladnie tak samo jak przy zapisie udanym. Operator nie mial po czym poznac,
// ze wlasnie nadpisal numer. A pierwsze uruchomienie to moment, w ktorym ktos zwykle grzebie
// przy sklepie — czyli najbardziej prawdopodobny moment na tryb konserwacji albo challenge
// WAF-a, ktore oddaja HTML z kodem 200.
//
// ⚠️ ODMOWA MA WYNIKAC Z POZYTYWNEGO ROZPOZNANIA PRODUKTU, a nie z braku pola.
//
// ⚠️ KAZDY Z TYCH TESTOW SPRAWDZA PRZECHWYCONY `PUT` — czy w ogole poleciał — a nie tresc
// komunikatu. Komunikat moze pochodzic skadinad (to ta klasa bledu, ktora zlapala juz
// `toThrow(/cena/)` spelnione przez „no such column").
describe('bariera na stanie żywym wobec odpowiedzi, której nie rozumiemy', () => {
  const ZMIANA = {
    kanal: 'pro',
    sciezka: 'products/900',
    pola: { sku: 'STE-ZAKAZY-001', dimensions: { length: '70', width: '100' } },
    opis: '…',
    produkt_id: '900',
    wariant_id: '',
    nazwa: 'Zakazy',
    wzor_id: 1,
  };

  /** Sklep, ktory na ODCZYT oddaje `jakJson`, a kazde inne zadanie przyjmuje. */
  function sklepZOdczytem(jakJson) {
    const zadania = [];
    const fetchImpl = vi.fn(async (adres, opcje = {}) => {
      const metoda = opcje.method ?? 'GET';
      zadania.push({ adres, metoda, body: opcje.body });
      return {
        ok: true,
        status: 200,
        json: metoda === 'GET' ? jakJson : async () => ({ id: 900 }),
        headers: { get: () => null },
      };
    });
    const klient = createWooClient({
      baseUrl: 'https://pro.example', ck: 'ck', cs: 'cs', fetchImpl,
    });
    return { klient, puty: () => zadania.filter((z) => z.metoda === 'PUT') };
  }

  // Ksztalty, ktore PRZED naprawa przepuszczaly zapis. Kazdy osobno — nie jeden
  // „reprezentatywny": kazdy z nich ma inna droge dojscia do tego samego skutku.
  const KSZTALTY_NIEZROZUMIALE = [
    // WAF, tryb konserwacji, strona logowania hostingu — HTML z kodem 200.
    ['ciało nie-JSON', async () => { throw new SyntaxError('Unexpected token < in JSON'); }],
    ['JSON bez klucza sku', async () => ({ id: 900 })],
    ['JSON = null', async () => null],
    ['JSON = tablica', async () => [{ id: 900, sku: 'PRO-NIEUPOWAZN-168' }]],
    // Zmiana ksztaltu API albo wtyczka opakowujaca odpowiedz.
    ['sku zagnieżdżone', async () => ({ product: { id: 900, sku: 'PRO-NIEUPOWAZN-168' } })],
    // `null` w polu numeru: dla `String(null ?? '')` to pustka, czyli „produkt bez numeru".
    ['sku = null', async () => ({ id: 900, sku: null })],
    // Odpowiedz o INNYM produkcie (przekierowanie, cache, pomylka wtyczki) — sprawdzalibysmy
    // barierę na cudzym wierszu.
    ['inny produkt niż ten, o który pytaliśmy', async () => ({ id: 7, sku: '' })],
  ];

  it.each(KSZTALTY_NIEZROZUMIALE)('%s → ANI JEDNEGO PUT-a', async (_opis, jakJson) => {
    const { klient, puty } = sklepZOdczytem(jakJson);
    const [w] = await wyslijDoSklepow({ sklepy: { pro: klient }, zmiany: [ZMIANA] });
    expect(puty()).toEqual([]);
    expect(w.ok).toBe(false);
  });

  // ⚠️ MILCZENIE BARIERY. Bez tej pary „naprawa" polegajaca na odmowie ZAWSZE przeszlaby
  // wszystkie testy wyzej — i zabilaby cala funkcje.
  it('produkt rozpoznany, z PUSTYM numerem, dostaje PUT z dokładnie naszymi polami', async () => {
    const { klient, puty } = sklepZOdczytem(async () => ({ id: 900, sku: '' }));
    const [w] = await wyslijDoSklepow({ sklepy: { pro: klient }, zmiany: [ZMIANA] });
    expect(w.ok).toBe(true);
    expect(puty()).toHaveLength(1);
    expect(JSON.parse(puty()[0].body)).toEqual(ZMIANA.pola);
  });

  it('produkt rozpoznany, z CUDZYM numerem, nie dostaje PUT-a', async () => {
    const { klient, puty } = sklepZOdczytem(async () => ({ id: 900, sku: 'PRO-NIEUPOWAZN-168' }));
    const [w] = await wyslijDoSklepow({ sklepy: { pro: klient }, zmiany: [ZMIANA] });
    expect(puty()).toEqual([]);
    expect(w.ok).toBe(false);
  });

  it('wariant rozpoznajemy po JEGO identyfikatorze, nie po identyfikatorze rodzica', async () => {
    const { klient, puty } = sklepZOdczytem(async () => ({ id: 1091, sku: '' }));
    const [w] = await wyslijDoSklepow({
      sklepy: { pro: klient },
      zmiany: [{ ...ZMIANA, sciezka: 'products/944/variations/1091' }],
    });
    expect(w.ok).toBe(true);
    expect(puty()).toHaveLength(1);
  });

  it('identyfikator RODZICA w odpowiedzi na pytanie o wariant nie jest rozpoznaniem', async () => {
    const { klient, puty } = sklepZOdczytem(async () => ({ id: 944, sku: '' }));
    await wyslijDoSklepow({
      sklepy: { pro: klient },
      zmiany: [{ ...ZMIANA, sciezka: 'products/944/variations/1091' }],
    });
    expect(puty()).toEqual([]);
  });
});

// ================================================================================
// KLIENT WooCommerce (woo/client.js)
// ================================================================================

describe('klient Woo: zapiszProdukt i pobierzProdukt', () => {
  const odpowiedz = (dane, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => dane,
    headers: { get: () => null },
  });

  const klientZ = (fetchImpl) => createWooClient({
    baseUrl: 'https://pro.example', ck: 'ck', cs: 'cs', fetchImpl,
  });

  it('zapis idzie metodą PUT pod adres produktu', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ id: 900 }));
    await klientZ(fetchImpl).zapiszProdukt('products/900', { sku: 'A-1' });
    const [adres, opcje] = fetchImpl.mock.calls[0];
    expect(adres).toBe('https://pro.example/wp-json/wc/v3/products/900');
    expect(opcje.method).toBe('PUT');
    expect(JSON.parse(opcje.body)).toEqual({ sku: 'A-1' });
  });

  it('zapis wariantu idzie pod adres wariantu', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ id: 1091 }));
    await klientZ(fetchImpl).zapiszProdukt('products/944/variations/1091', { sku: 'A-1' });
    expect(fetchImpl.mock.calls[0][0])
      .toBe('https://pro.example/wp-json/wc/v3/products/944/variations/1091');
  });

  it('odczyt idzie metodą GET i oddaje dane produktu', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ id: 900, sku: 'PD10' }));
    const dane = await klientZ(fetchImpl).pobierzProdukt('products/900');
    expect(fetchImpl.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(dane.sku).toBe('PD10');
  });

  // ⚠️ TRESC BLEDU SKLEPU JEST INFORMACJA, nie szumem: „duplikat SKU" mowi, co zrobic dalej.
  it('błąd sklepu wraca z treścią', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odpowiedz({ message: 'Nieprawidłowy lub zduplikowany SKU.' }, 400),
    );
    await expect(klientZ(fetchImpl).zapiszProdukt('products/900', { sku: 'A-1' }))
      .rejects.toThrow(/zduplikowany SKU/);
  });

  // ⚠️⚠️ SCIEZKA JEST SKLADANA W ADRES HTTP, a `produkt_id` jest kolumna TEKSTOWA (bo Allegro).
  // Smiec w niej zamienilby `products/{id}` w zupelnie inny zasob REST-a — a metoda jest PUT.
  it('ścieżka spoza wzorca produktu/wariantu ODMAWIA, zanim cokolwiek poleci', async () => {
    const fetchImpl = vi.fn();
    await expect(klientZ(fetchImpl).zapiszProdukt('products/900/../orders/5', { sku: 'A-1' }))
      .rejects.toThrow(/ścieżk/i);
    await expect(klientZ(fetchImpl).pobierzProdukt('orders/5')).rejects.toThrow(/ścieżk/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('poprawna ścieżka nie jest odrzucana', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ id: 900 }));
    await expect(klientZ(fetchImpl).zapiszProdukt('products/900', { sku: 'A-1' }))
      .resolves.toBeDefined();
  });

  // ⚠️ DIAGNOZA JEST CZESCIA ODPOWIEDZI. Trzy powody odmowy to trzy rozne awarie sklepu
  // i operator ma po komunikacie poznac, z ktora ma do czynienia: „200 z HTML-em" (WAF,
  // tryb konserwacji) to co innego niz „zmienil sie ksztalt API", a to co innego niz
  // „sklep oddal cudzy produkt". Same testy bariery stoja wyzej i sprawdzaja PUT-a,
  // nie komunikat.
  it('odczyt: odpowiedź, która nie jest obiektem, mówi wprost, że to nie produkt', async () => {
    const nieJson = {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    };
    await expect(klientZ(vi.fn().mockResolvedValue(nieJson)).pobierzProdukt('products/900'))
      .rejects.toThrow(/nie jest obiektem/i);
    await expect(klientZ(vi.fn().mockResolvedValue(odpowiedz([{ id: 900, sku: '' }])))
      .pobierzProdukt('products/900')).rejects.toThrow(/nie jest obiektem/i);
  });

  it('odczyt: brak pola sku mówi, że to NIE jest „produkt bez numeru"', async () => {
    await expect(klientZ(vi.fn().mockResolvedValue(odpowiedz({ id: 900 })))
      .pobierzProdukt('products/900')).rejects.toThrow(/sku/i);
  });

  it('odczyt: cudzy identyfikator mówi, o co pytaliśmy i co przyszło', async () => {
    await expect(klientZ(vi.fn().mockResolvedValue(odpowiedz({ id: 7, sku: '' })))
      .pobierzProdukt('products/900')).rejects.toThrow(/„7".*„900"|„900".*„7"/);
  });

  it('odczyt: rozpoznany produkt wraca w całości', async () => {
    const dane = await klientZ(vi.fn().mockResolvedValue(odpowiedz({ id: 900, sku: 'PD10' })))
      .pobierzProdukt('products/900');
    expect(dane).toMatchObject({ id: 900, sku: 'PD10' });
  });
});

// ================================================================================
// EKRAN WYSYLKI (web/routes/magazyn.js)
// ================================================================================

const config = { auth: { user: 'adam', pass: 'x' } };
const auth = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const STAN_PUSTY = {
  trwa: false, zaczety_at: null, skonczony_at: null, postep: null, kanaly: [], blad: null,
};

let db;
let sklepy;

const serwer = (nad = {}) => buildOmsServer({
  db, config, magazyn: { start: vi.fn(), stan: () => STAN_PUSTY }, sklepy, ...nad,
});

beforeEach(() => {
  db = openOmsDb(':memory:');
  sklepy = { pro: klientO(), szkicownia: klientO() };
});

const wzorO = (nazwa, reszta = {}) => utworzWzor(db, { nazwa, ...reszta });

function produktO(wzorId, {
  kanal = 'pro', produkt_id = '900', wariant_id = '', sku = null, nazwa = 'Tabliczka',
} = {}) {
  const id = zapiszProduktSklepowy(db, {
    kanal, produkt_id, wariant_id, nazwa, sku_sklepu: sku,
    odczytane_at: '2026-08-12T10:00:00.000Z',
  });
  if (wzorId) powiazProdukt(db, id, wzorId);
  return id;
}

const lustro = (id) => db.prepare('SELECT * FROM produkty_sklepowe WHERE id = ?').get(id);

const wyslij = (app, payload, naglowki = auth) => app.inject({
  method: 'POST', url: '/magazyn/zapisz-do-sklepow', headers: naglowki, payload,
});

function sekcja(body, id) {
  const trafienie = new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie nie ma sekcji „${id}"`);
  return trafienie[0];
}

describe('POST /magazyn/zapisz-do-sklepow', () => {
  // ⚠️⚠️ NAJWAZNIEJSZY TEST W TYM ZADANIU. Podglad i zapis licza zmiany OSOBNO — dokladnie
  // jak nadanie zbiorcze, gdzie podzial jest przeliczany przy zatwierdzeniu, a nie
  // przepisany z ekranu podgladu.
  it('zapis liczy zmiany PONOWNIE, nie bierze ich z formularza', async () => {
    const id = wzorO('Ewakuacja', { sku: 'STARE-Z-EKRANU' });
    produktO(id);
    const app = serwer();
    await app.inject({
      method: 'POST', url: '/magazyn/podglad-zapisu', headers: auth, payload: { zaznaczone: String(id) },
    });
    db.prepare('UPDATE wzory SET sku = ? WHERE id = ?').run('NOWE-PO-ZMIANIE', id);
    await wyslij(app, { zaznaczone: String(id) });
    expect(sklepy.pro.zapiszProdukt.mock.calls[0][1].sku).toBe('NOWE-PO-ZMIANIE');
  });

  it('bez tokenu CSRF odmawia i nie woła sklepu', async () => {
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    produktO(id);
    const r = await wyslij(serwer(), { zaznaczone: String(id) }, { authorization: auth.authorization });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(sklepy.pro.zapiszProdukt).not.toHaveBeenCalled();
  });

  it('puste zaznaczenie odmawia i nie woła sklepu', async () => {
    const r = await wyslij(serwer(), {});
    expect(r.statusCode).toBe(400);
    expect(sklepy.pro.zapiszProdukt).not.toHaveBeenCalled();
  });

  it('bez podpiętego sklepu zakładka odmawia', async () => {
    const r = await wyslij(serwer({ magazyn: null }), { zaznaczone: '1' });
    expect(r.statusCode).toBe(503);
  });

  // ⚠️ Po zapisie NIGDY nie przekierowujemy — lista „poszło / nie poszło" jest jedynym
  // swiadectwem operacji, ktorej nie da sie cofnac klknieciem.
  it('po zapisie zostaje lista wyników, bez przekierowania', async () => {
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    produktO(id);
    const r = await wyslij(serwer(), { zaznaczone: String(id) });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/poszło|nie poszło|błąd/i);
  });

  it('awaria jednego produktu nie zatrzymuje drugiego, a ekran mówi o obu', async () => {
    sklepy.pro = klientO({
      zapiszProdukt: vi.fn()
        .mockRejectedValueOnce(new Error('duplikat SKU'))
        .mockResolvedValueOnce({}),
    });
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    produktO(id, { produkt_id: '900' });
    produktO(id, { produkt_id: '901' });
    const r = await wyslij(serwer(), { zaznaczone: String(id) });
    const s = sekcja(r.body, 'zapis-zmiany');
    expect(s).toContain('duplikat SKU');
    expect(s).toContain('products/901');
  });

  // ⚠️ LUSTRO DOGANIA SKLEP TYLKO DLA TEGO, CO NAPRAWDE POSZLO. Bez tego kolejny podglad
  // pokazywalby te sama zmiane jeszcze raz i zapraszal do drugiego zapisu.
  it('po udanym zapisie numer stoi też w lustrze', async () => {
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    const produkt = produktO(id);
    await wyslij(serwer(), { zaznaczone: String(id) });
    expect(lustro(produkt).sku_sklepu).toBe('A-1');
  });

  it('po NIEUDANYM zapisie lustro zostaje nietknięte', async () => {
    sklepy.pro = klientO({ zapiszProdukt: vi.fn().mockRejectedValue(new Error('duplikat SKU')) });
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    const produkt = produktO(id);
    await wyslij(serwer(), { zaznaczone: String(id) });
    expect(lustro(produkt).sku_sklepu).toBeNull();
  });

  // ⚠️ ODSWIEZENIE LUSTRA DOTYKA WYLACZNIE KOLUMNY NUMERU. Gdyby szlo przez upsert lustra,
  // skasowaloby powiazanie wzoru (`wzor_id`) — cala reczna prace wlasciciela.
  it('odświeżenie lustra nie zrywa powiązania z wzorem', async () => {
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    const produkt = produktO(id, { nazwa: 'Tabliczka ewakuacyjna' });
    await wyslij(serwer(), { zaznaczone: String(id) });
    expect(lustro(produkt).wzor_id).toBe(id);
    expect(lustro(produkt).nazwa).toBe('Tabliczka ewakuacyjna');
  });

  // ⚠️ ZMIANA BEZ NUMERU (same wymiary) nie ma czym przestawic lustra — i nie ma prawa
  // wpisac tam pustki.
  it('zapis samych wymiarów nie rusza numeru w lustrze', async () => {
    const id = wzorO('Ewakuacja', { szerokosc_mm: 700, wysokosc_mm: 1000 });
    const produkt = produktO(id, { sku: 'PD10' });
    await wyslij(serwer(), { zaznaczone: String(id) });
    expect(lustro(produkt).sku_sklepu).toBe('PD10');
  });

  it('produkt wstrzymany przez cudzy numer nie jest w ogóle wysyłany', async () => {
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    produktO(id, { sku: 'PD10' });
    const r = await wyslij(serwer(), { zaznaczone: String(id) });
    expect(sklepy.pro.zapiszProdukt).not.toHaveBeenCalled();
    expect(sekcja(r.body, 'zapis-wstrzymane')).toContain('PD10');
  });

  it('do Allegro nie idzie ani jedno żądanie', async () => {
    const id = wzorO('Ewakuacja', { sku: 'A-1' });
    produktO(id, { kanal: 'allegro_szkicownia', produkt_id: '9000000001' });
    await wyslij(serwer(), { zaznaczone: String(id) });
    expect(sklepy.pro.zapiszProdukt).not.toHaveBeenCalled();
    expect(sklepy.szkicownia.zapiszProdukt).not.toHaveBeenCalled();
  });
});
