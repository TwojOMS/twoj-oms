import { describe, it, expect, vi } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const odp = (cialo, naglowki = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (n) => naglowki[n.toLowerCase()] ?? null },
  json: async () => cialo,
  text: async () => JSON.stringify(cialo),
});

const klient = (fetchImpl) =>
  createWooClient({ baseUrl: 'https://pro.test', ck: 'ck_a', cs: 'cs_b', fetchImpl });

// Atrapa sklepu o wielu stronach: cialo zalezy od numeru strony z zadania, wiec test
// widzi rowniez to, czego klient NIE dopisal do zadania o strone 5.
const sklepNaStron = (stron, cialo = (nr) => [{ id: nr }], naglowki = {}) =>
  vi.fn().mockImplementation((url) => Promise.resolve(
    odp(cialo(Number(new URL(url).searchParams.get('page'))),
      { 'x-wp-totalpages': String(stron), ...naglowki }),
  ));

// Parametry KAZDEGO zadania. Asercja po `calls[0]` przepuszcza klienta, ktory dokleja
// filtry tylko do pierwszej strony — a wtedy strony 2-7 leca z domyslnym status=any.
const parametryWywolan = (fetchImpl) =>
  fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams);

describe('pobierzWszystkieProdukty', () => {
  it('idzie po stronach do końca, wg X-WP-TotalPages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odp([{ id: 1 }], { 'x-wp-totalpages': '2' }))
      .mockResolvedValueOnce(odp([{ id: 2 }], { 'x-wp-totalpages': '2' }));
    const wszystkie = await klient(fetchImpl).pobierzWszystkieProdukty();
    expect(wszystkie.map((p) => p.id)).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Sama liczba wywolan nie wystarcza: klient, ktory dwa razy pobralby strone 1,
  // przeszedlby tamten test i po cichu zgubil polowe katalogu.
  it('kolejne żądania niosą kolejne numery stron', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odp([{ id: 1 }], { 'x-wp-totalpages': '3' }))
      .mockResolvedValueOnce(odp([{ id: 2 }], { 'x-wp-totalpages': '3' }))
      .mockResolvedValueOnce(odp([{ id: 3 }], { 'x-wp-totalpages': '3' }));
    await klient(fetchImpl).pobierzWszystkieProdukty();
    const strony = fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get('page'));
    expect(strony).toEqual(['1', '2', '3']);
  });

  // ⚠️ Bez status=publish REST v3 oddaje `any`. Zmierzone 2026-08-06: szkicownia.pl ma 890
  // produktow, z czego 222 to SZKICE — w duzej czesci produkty techniczne przeniesione na PRO
  // i zostawione na B2C jako nieopublikowane. Magazyn zalozylby ~222 wzory-duchy.
  // KAZDE zadanie, nie tylko pierwsze. Klient filtrujacy tylko strone 1 sciagnalby
  // szkice na stronach 2-7 i zameldowal sukces — nikt by tego nie zauwazyl az do
  // generatora SKU. 7 stron to zmierzony rozmiar szkicownia.pl.
  it('każda strona — nie tylko pierwsza — pyta wyłącznie o produkty opublikowane', async () => {
    const fetchImpl = sklepNaStron(7);
    await klient(fetchImpl).pobierzWszystkieProdukty();
    expect(parametryWywolan(fetchImpl).map((p) => p.get('status'))).toEqual(Array(7).fill('publish'));
  });

  it('każda strona bierze po 100 pozycji i sortuje stabilnie po id', async () => {
    const fetchImpl = sklepNaStron(7);
    await klient(fetchImpl).pobierzWszystkieProdukty();
    const p = parametryWywolan(fetchImpl);
    expect(p).toHaveLength(7);
    expect(p.map((x) => x.get('per_page'))).toEqual(Array(7).fill('100'));
    expect(p.map((x) => x.get('orderby'))).toEqual(Array(7).fill('id'));
    expect(p.map((x) => x.get('order'))).toEqual(Array(7).fill('asc'));
  });

  it('każda strona strzela w /products, nie w inny zasób', async () => {
    const fetchImpl = sklepNaStron(7);
    await klient(fetchImpl).pobierzWszystkieProdukty();
    const adresy = fetchImpl.mock.calls.map(([url]) => url);
    expect(adresy).toHaveLength(7);
    for (const url of adresy) expect(url).toContain('/wp-json/wc/v3/products?');
  });

  // Kategoria glowna (_yoast_wpseo_primary_product_cat) i short_description sa zrodlem
  // opisu wzoru — mapowanie, ktore odsiewa pola produktu, uciela by je po cichu.
  it('oddaje produkt w całości, z meta_data i short_description', async () => {
    const produkt = {
      id: 944,
      name: 'Szablon EV',
      sku: 'PRO-EV-118',
      short_description: '<p>Opis skrócony</p>',
      type: 'variable',
      meta_data: [{ id: 7, key: '_yoast_wpseo_primary_product_cat', value: '31' }],
    };
    const fetchImpl = vi.fn().mockResolvedValue(odp([produkt], { 'x-wp-totalpages': '1' }));
    const [wynik] = await klient(fetchImpl).pobierzWszystkieProdukty();
    expect(wynik).toEqual(produkt);
  });

  // ⚠️ Bez tego jeden sklep z absurdalnym X-WP-TotalPages zapetlilby odczyt — ta sama rodzina
  // bledu, co poller bez kursora, ktory sciagnal archiwum sklepu i sam sie zwielokrotnil.
  it('ma twardą granicę stron i nie kręci się w nieskończoność', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp([{ id: 1 }], { 'x-wp-totalpages': '9999' }));
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).rejects.toThrow(/stron/i);
  });

  it('komunikat granicy mówi, ile stron zgłosił sklep', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp([{ id: 1 }], { 'x-wp-totalpages': '9999' }));
    const err = await klient(fetchImpl).pobierzWszystkieProdukty().catch((e) => e);
    expect(err.message).toContain('9999');
  });

  // Granica ma chronic przed absurdem, a nie ucinac prawdziwy sklep: 7 stron szkicownia.pl
  // ma przejsc w calosci.
  it('sklep o rozsądnej liczbie stron przechodzi w całości', async () => {
    const fetchImpl = vi.fn().mockImplementation((url) =>
      Promise.resolve(odp([{ id: Number(new URL(url).searchParams.get('page')) }], { 'x-wp-totalpages': '7' })));
    const wszystkie = await klient(fetchImpl).pobierzWszystkieProdukty();
    expect(wszystkie.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('200 z ciałem nie-tablicą to błąd, nie „brak produktów”', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ code: 'rest_no_route' }, { 'x-wp-totalpages': '1' }));
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).rejects.toThrow(/niespodziewan/i);
  });

  it('brak nagłówka stron → jedna strona', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp([{ id: 1 }]));
    const wszystkie = await klient(fetchImpl).pobierzWszystkieProdukty();
    expect(wszystkie).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('pobierzWarianty', () => {
  it('pyta o warianty konkretnego produktu', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odp([{ id: 1091, sku: 'PRO-EV-118' }], { 'x-wp-totalpages': '1' }),
    );
    const w = await klient(fetchImpl).pobierzWarianty('944');
    expect(fetchImpl.mock.calls[0][0]).toContain('/products/944/variations');
    expect(w[0].sku).toBe('PRO-EV-118');
  });

  it('chodzi po stronach wariantów tak samo jak po produktach', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odp([{ id: 1 }], { 'x-wp-totalpages': '2' }))
      .mockResolvedValueOnce(odp([{ id: 2 }], { 'x-wp-totalpages': '2' }));
    const w = await klient(fetchImpl).pobierzWarianty('944');
    expect(w.map((x) => x.id)).toEqual([1, 2]);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('page')).toBe('2');
  });

  it('200 z ciałem nie-tablicą to błąd, nie „brak wariantów”', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ code: 'rest_no_route' }, { 'x-wp-totalpages': '1' }));
    await expect(klient(fetchImpl).pobierzWarianty('944')).rejects.toThrow(/niespodziewan/i);
  });

  it('ma tę samą twardą granicę stron', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp([{ id: 1 }], { 'x-wp-totalpages': '9999' }));
    await expect(klient(fetchImpl).pobierzWarianty('944')).rejects.toThrow(/stron/i);
  });

  it('każda strona wariantów trzyma ścieżkę produktu i te same parametry', async () => {
    const fetchImpl = sklepNaStron(3);
    await klient(fetchImpl).pobierzWarianty('944');
    const adresy = fetchImpl.mock.calls.map(([url]) => url);
    expect(adresy).toHaveLength(3);
    for (const url of adresy) expect(url).toContain('/products/944/variations?');
    expect(parametryWywolan(fetchImpl).map((p) => p.get('per_page'))).toEqual(['100', '100', '100']);
  });

  // Wspolna petla znaczy wspolna kontrola kompletnosci — takze dla wariantow.
  it('ucięty odczyt wariantów też jest wykrywany', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odp([{ id: 1 }], { 'x-wp-totalpages': '1', 'x-wp-total': '40' }),
    );
    await expect(klient(fetchImpl).pobierzWarianty('944')).rejects.toThrow(/40/);
  });
});

// ⚠️ Gdy proxy zje naglowki X-WP-* albo sklep odda je tylko na pierwszej stronie, `stron`
// spada do 1 i odczyt konczy sie na 100 produktach MELDUJAC SUKCES. Zadanie 7 oznaczyloby
// wtedy ~568 pozycji jako zniknal_at (Global Constraint zabrania kasowania), a uciety
// odczyt jest nieodrozninalny od "sklep stracil polowe katalogu".
describe('kontrola kompletności odczytu (X-WP-Total)', () => {
  it('zebranie mniej pozycji, niż zapowiedział sklep, to błąd', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odp([{ id: 1 }, { id: 2 }], { 'x-wp-totalpages': '1', 'x-wp-total': '668' }),
    );
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).rejects.toThrow(/668/);
  });

  it('komunikat podaje obie liczby: ile zapowiedziano i ile zebrano', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odp([{ id: 1 }, { id: 2 }], { 'x-wp-totalpages': '1', 'x-wp-total': '668' }),
    );
    const err = await klient(fetchImpl).pobierzWszystkieProdukty().catch((e) => e);
    expect(err.message).toContain('668');
    expect(err.message).toContain('2');
  });

  it('tyle samo, ile zapowiedziano → przechodzi', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odp([{ id: 1 }, { id: 2 }], { 'x-wp-totalpages': '1', 'x-wp-total': '2' }),
    );
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).resolves.toHaveLength(2);
  });

  // Produkt dodany w trakcie odczytu dokłada się na końcu (orderby=id&order=asc)
  // i zwiększa liczbę. To normalne, nie awaria.
  it('więcej niż zapowiedziano → przechodzi bez słowa', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odp([{ id: 1 }, { id: 2 }, { id: 3 }], { 'x-wp-totalpages': '1', 'x-wp-total': '2' }),
    );
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).resolves.toHaveLength(3);
  });

  // ⚠️ NAJWAZNIEJSZY test tej kontroli: jedyny, w ktorym ma ona PRZEJSC przy wielu stronach.
  // Bez niego straznik przeniesiony do wnetrza petli (a nie usuniety!) przechodzil cala suite
  // na zielono, a na prawdziwym sklepie wywalal sie po stronie 1 — bo wtedy zebrane 100 zawsze
  // jest mniejsze od zapowiedzianych 668. Magazyn nie wczytalby ANI JEDNEGO produktu.
  // 6 x 100 + 68 = 668 to zmierzony rozmiar szkicownia.pl (7 stron).
  it('siedem stron zapowiedzianych jako 668 pozycji przechodzi w całości', async () => {
    const naStronie = (nr) => (nr === 7 ? 68 : 100);
    const fetchImpl = sklepNaStron(
      7,
      (nr) => Array.from({ length: naStronie(nr) }, (_, i) => ({ id: (nr - 1) * 100 + i + 1 })),
      { 'x-wp-total': '668' },
    );
    const wszystkie = await klient(fetchImpl).pobierzWszystkieProdukty();
    expect(wszystkie).toHaveLength(668);
    expect(wszystkie.at(-1).id).toBe(668);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  // Sklep, ktory naglowka nie wystawia, ma dzialac — nie zmyslamy oczekiwanej liczby.
  it('brak X-WP-Total → kontrola pominięta, odczyt przechodzi', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp([{ id: 1 }], { 'x-wp-totalpages': '1' }));
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).resolves.toHaveLength(1);
  });

  // Oczekiwana liczba pochodzi z PIERWSZEJ strony. Klient czytajacy ja z ostatniej
  // straciłby ja dokladnie w tym scenariuszu, przed ktorym kontrola ma bronic:
  // gdy naglowki przestaja przychodzic w trakcie odczytu.
  it('oczekiwaną liczbę bierze z pierwszej strony, nie z ostatniej', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odp([{ id: 1 }], { 'x-wp-totalpages': '2', 'x-wp-total': '250' }))
      .mockResolvedValueOnce(odp([{ id: 2 }], { 'x-wp-totalpages': '2' }));
    await expect(klient(fetchImpl).pobierzWszystkieProdukty()).rejects.toThrow(/250/);
  });
});

describe('ustawienieSklepu', () => {
  it('oddaje wartość ustawienia, nie cały obiekt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ id: 'woocommerce_dimension_unit', value: 'cm' }));
    expect(await klient(fetchImpl).ustawienieSklepu('woocommerce_dimension_unit')).toBe('cm');
  });

  it('pyta o ustawienie w grupie products', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ id: 'woocommerce_dimension_unit', value: 'mm' }));
    await klient(fetchImpl).ustawienieSklepu('woocommerce_dimension_unit');
    expect(fetchImpl.mock.calls[0][0]).toContain('/settings/products/woocommerce_dimension_unit');
  });

  // ⚠️ Ciche `undefined` zamiast jednostki konczy sie szablonem 70 mm zamiast 70 cm
  // wyslanym do sklepu — cicho i za pieniadze. Ten sam plik dwadziescia linii wyzej
  // mowi: lepiej glosno wywalic przebieg, niz cicho udawac.
  it('200 bez pola value → błąd, nie ciche undefined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ id: 'woocommerce_dimension_unit' }));
    await expect(klient(fetchImpl).ustawienieSklepu('woocommerce_dimension_unit')).rejects.toThrow();
  });

  it('value, które nie jest napisem → błąd mówiący czego oczekiwano i co przyszło', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ id: 'woocommerce_dimension_unit', value: ['cm'] }));
    const err = await klient(fetchImpl).ustawienieSklepu('woocommerce_dimension_unit').catch((e) => e);
    expect(err.message).toContain('woocommerce_dimension_unit');
    expect(err.message).toMatch(/napis/i);
    expect(err.message).toContain('cm');
  });

  it('ciało, które w ogóle nie jest obiektem ustawienia → błąd', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp([{ id: 'woocommerce_dimension_unit', value: 'cm' }]));
    await expect(klient(fetchImpl).ustawienieSklepu('woocommerce_dimension_unit')).rejects.toThrow(/napis/i);
  });

  it('pusty napis jest poprawną wartością, nie błędem', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odp({ id: 'woocommerce_price_thousand_sep', value: '' }));
    expect(await klient(fetchImpl).ustawienieSklepu('woocommerce_price_thousand_sep')).toBe('');
  });
});
