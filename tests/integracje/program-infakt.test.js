// PRZ-118.02 — adapter inFaktu za kontraktem ProgramFakturowy (src/integracje/programy/infakt.ts).
// Pilnuje trzech rzeczy, na których stoją zmiany 05–09:
//   1) każdy z czterech obiektów „inFakt” (prawdziwy klient, atrapa piaskownicy, pośrednik z Ustawień, odmowa próby)
//      po owinięciu jest pełnym programem i ma tę samą listę metod;
//   2) zdolność jest obecna ⇔ owijany obiekt ma metodę (mocki w testach bez `oznaczZaplacona` = program bez zdolności);
//   3) adapter jest przezroczysty: te same argumenty, ten sam wynik, ten sam błąd (z dołożonym `bezProgramu`),
//      a `przygotujNabywce` buduje DOKŁADNIE ten wpis kartoteki, który dziś buduje services/faktura.js.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  createInfaktClient, METODY_INFAKTU, LIMIT_ZADANIA_MS, NAJDLUZSZA_LISTA_MS, STRONA_INFAKTU, SUFIT_STRON, ROWNOLEGLE_STRON,
} from '../../src/oms/infakt/client.js';
import { createAtrapaInfaktu } from '../../deploy/proba/atrapy/infakt.mjs';
import { infaktZUstawien, odmowaInfaktuWProbie } from '../../src/moduly/faktury/infakt-ustawien.ts';
import { ADRES_INFAKT, EKRAN_INFAKTU } from '../../src/domena/konfiguracja-infakt.js';
import { bladOperatora } from '../../src/domena/bledy.js';
import { programInfakt } from '../../src/integracje/programy/infakt.ts';
import { sprawdzProgramFakturowy } from '../../src/integracje/program-fakturowy.ts';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const metody = (o) => Object.keys(o).filter((k) => typeof o[k] === 'function').sort();
const WSZYSTKIE_ZDOLNOSCI = ['nieoplacone', 'numeracjaWlasna', 'oznaczZaplacona', 'wyslijDoKsef'];
const METODY_PROGRAMU = [
  'iluMaNumer', 'listaFaktur', 'listaKorekt', 'listaNieoplaconych', 'oznaczZaplacona', 'pobierzFakture', 'pobierzPdf',
  'pobierzPdfKorekty', 'przygotujNabywce', 'sprawdzPolaczenie', 'wyslijDokumentDoKsef', 'wystaw', 'wystawKorekte',
];
// metoda klienta ↔ zdolność, którą jej obecność daje (plan PRZ-118, „Kontrakt — 14 metod klienta”)
const ZDOLNOSC_METODY = {
  listaNieoplaconych: 'nieoplacone', oznaczZaplacona: 'oznaczZaplacona', wyslijDokumentDoKsef: 'wyslijDoKsef', iluMaNumer: 'numeracjaWlasna',
};

const bezSieci = async () => { throw new Error('sieć wyłączona w teście'); };
const klientPrawdziwy = () => createInfaktClient({ apiKey: 'syntetyczny-klucz-testowy', fetchImpl: bezSieci });
const atrapa = () => createAtrapaInfaktu({ db: new DatabaseSync(':memory:'), env: { OMS_TRYB: 'proba' }, log: () => {} });
const posrednik = () => infaktZUstawien({ wczytaj: () => null, fabryka: () => { throw new Error('bez zapisu fabryka nie rusza'); } });
/** Atrapa w stylu testów usług: 14 metod-szpiegów (vi.fn), każda oddaje obietnicę. */
const mock = (bez = []) => Object.fromEntries(METODY_INFAKTU.filter((m) => !bez.includes(m)).map((m) => [m, vi.fn(async () => null)]));

describe('owinięty inFakt przechodzi kontrakt', () => {
  it('(1) prawdziwy klient: przechodzi sprawdzProgramFakturowy, zdolności — wszystkie cztery', () => {
    const p = programInfakt(klientPrawdziwy());
    expect(sprawdzProgramFakturowy(p)).toBe(p);
    expect([...p.opis.zdolnosci].sort()).toEqual(WSZYSTKIE_ZDOLNOSCI);
  });

  it('opis inFaktu: odmiana nazwy, VAT wierszami, bez wysyłki przy wystawieniu, limity z eksportów klienta', () => {
    const { opis } = programInfakt(klientPrawdziwy());
    expect(opis).toEqual({
      id: 'infakt',
      nazwa: { mianownik: 'inFakt', dopelniacz: 'inFaktu', miejscownik: 'inFakcie', narzednik: 'inFaktem' },
      regulaVat: 'wierszami',
      zdolnosci: expect.any(Array),
      wystawienieWysylaDoKsef: false,
      limity: {
        zadanieMs: LIMIT_ZADANIA_MS, najdluzszaListaMs: NAJDLUZSZA_LISTA_MS, stronaListy: STRONA_INFAKTU,
        sufitStron: SUFIT_STRON, rownolegleStron: ROWNOLEGLE_STRON,
      },
      adres: ADRES_INFAKT,
      ekran: EKRAN_INFAKTU,
    });
    expect(Object.isFrozen(opis)).toBe(true);
    expect(Object.isFrozen(opis.zdolnosci)).toBe(true);
    expect(Object.isFrozen(opis.limity)).toBe(true);
    expect(Object.isFrozen(opis.nazwa)).toBe(true);
  });

  it('opis przyjmuje nazwę, adres i ekran z wywołania (reszta zostaje inFaktu)', () => {
    const nazwa = { mianownik: 'inFakt (próba)', dopelniacz: 'inFaktu (próba)', miejscownik: 'inFakcie (próba)', narzednik: 'inFaktem (próba)' };
    const { opis } = programInfakt(klientPrawdziwy(), { nazwa, adres: 'http://127.0.0.1:9/api', ekran: '/inny' });
    expect(opis.nazwa).toEqual(nazwa);
    expect(opis.adres).toBe('http://127.0.0.1:9/api');
    expect(opis.ekran).toBe('/inny');
    expect(opis.id).toBe('infakt');
  });

  it('(2) atrapa piaskownicy, pośrednik z Ustawień i odmowa próby — każdy owinięty przechodzi z czterema zdolnościami', () => {
    for (const obiekt of [atrapa(), posrednik(), odmowaInfaktuWProbie()]) {
      const p = programInfakt(obiekt);
      expect(sprawdzProgramFakturowy(p)).toBe(p);
      expect([...p.opis.zdolnosci].sort()).toEqual(WSZYSTKIE_ZDOLNOSCI);
    }
  });

  it('(02.3) owinięta atrapa = owinięty klient na tej samej liście metod (także pośrednik i odmowa próby)', () => {
    const wzor = metody(programInfakt(klientPrawdziwy()));
    expect(wzor).toEqual(METODY_PROGRAMU);
    expect(metody(programInfakt(atrapa()))).toEqual(wzor);
    expect(metody(programInfakt(posrednik()))).toEqual(wzor);
    expect(metody(programInfakt(odmowaInfaktuWProbie()))).toEqual(wzor);
    // wnętrze adaptera (kartoteka) i dodatki atrapy nie wystają na kontrakt
    const p = programInfakt(atrapa());
    for (const k of ['znajdzKlientaPoNip', 'zalozKlienta', 'surowaEncja', 'atrapa']) expect(p).not.toHaveProperty(k);
  });
});

describe('zdolność obecna ⇔ metoda istnieje', () => {
  it('(3) atrapa bez wyslijDokumentDoKsef → program bez zdolności wyslijDoKsef i bez metody; kontrakt przechodzi', () => {
    const p = programInfakt(mock(['wyslijDokumentDoKsef']));
    expect(p.opis.zdolnosci).not.toContain('wyslijDoKsef');
    expect(p).not.toHaveProperty('wyslijDokumentDoKsef');
    expect(p.wyslijDokumentDoKsef).toBeUndefined();
    expect(sprawdzProgramFakturowy(p)).toBe(p);
  });

  it('(3) to samo dla każdej z czterech metod opcjonalnych — pozostałe zdolności zostają', () => {
    for (const [metoda, zdolnosc] of Object.entries(ZDOLNOSC_METODY)) {
      const p = programInfakt(mock([metoda]));
      expect(p).not.toHaveProperty(metoda);
      expect([...p.opis.zdolnosci].sort()).toEqual(WSZYSTKIE_ZDOLNOSCI.filter((z) => z !== zdolnosc));
      expect(sprawdzProgramFakturowy(p)).toBe(p);
    }
  });

  it('obecność liczy się w chwili owijania; wywołanie idzie do metody obiektu w chwili wywołania', async () => {
    const klient = mock(['oznaczZaplacona']);
    const p = programInfakt(klient);
    klient.oznaczZaplacona = vi.fn(async () => null);
    expect(p).not.toHaveProperty('oznaczZaplacona');
    expect(p.opis.zdolnosci).not.toContain('oznaczZaplacona');
    // podmiana metody po owinięciu (szpieg dopięty później) — program woła nową
    const nowa = vi.fn(async () => 'nowy wynik');
    klient.listaKorekt = nowa;
    expect(await p.listaKorekt({ od: '2026-10-01' })).toBe('nowy wynik');
    expect(nowa).toHaveBeenCalledWith({ od: '2026-10-01' });
  });

  it('obiekt bez metody obowiązkowej → program bez niej, kontrakt odmawia z nazwą metody', () => {
    const p = programInfakt(mock(['listaKorekt']));
    expect(p).not.toHaveProperty('listaKorekt');
    expect(() => sprawdzProgramFakturowy(p)).toThrow(/listaKorekt/);
  });

  it('owinięcie programu oddaje ten sam program (alias `infakt` = program nie dostaje drugiej warstwy)', () => {
    const p = programInfakt(klientPrawdziwy());
    expect(programInfakt(p)).toBe(p);
  });
});

describe('(9) przygotujNabywce — wpis kartoteki jak services/faktura.js', () => {
  const firma = {
    firma: 'Pracownia Półcień', nip: '1234563218', ulica: 'Lampowa 3', kod: '00-950', miasto: 'Warszawa', kraj: 'PL',
    email: 'biuro@polcien.invalid',
  };

  it('nabywca w kartotece → { client_id } bez zakładania', async () => {
    const k = mock();
    k.znajdzKlientaPoNip.mockResolvedValue(41);
    const p = programInfakt(k);
    expect(await p.przygotujNabywce(firma, { zalozGdyBrak: true })).toStrictEqual({ client_id: 41 });
    expect(k.znajdzKlientaPoNip.mock.calls).toEqual([['1234563218']]);
    expect(k.zalozKlienta).not.toHaveBeenCalled();
  });

  it('brak w kartotece + zalozGdyBrak: true → zalozKlienta z dokładnie tym obiektem, który buduje faktura.js', async () => {
    const k = mock();
    k.zalozKlienta.mockResolvedValue(77);
    const p = programInfakt(k);
    expect(await p.przygotujNabywce(firma, { zalozGdyBrak: true })).toStrictEqual({ client_id: 77 });
    expect(k.znajdzKlientaPoNip.mock.calls).toEqual([['1234563218']]);
    expect(k.zalozKlienta.mock.calls).toHaveLength(1);
    expect(k.zalozKlienta.mock.calls[0]).toStrictEqual([{
      company_name: 'Pracownia Półcień', nip: '1234563218', street: 'Lampowa 3', postal_code: '00-950', city: 'Warszawa',
      country: 'PL', email: 'biuro@polcien.invalid',
    }]);
    expect(Object.keys(k.zalozKlienta.mock.calls[0][0]))
      .toEqual(['company_name', 'nip', 'street', 'postal_code', 'city', 'country', 'email']);
  });

  it('osoba prywatna bez firmy i bez NIP-u → bez wyszukiwania, company_name „Nabywca”, nip null', async () => {
    const k = mock();
    k.zalozKlienta.mockResolvedValue(78);
    const p = programInfakt(k);
    const osoba = { firma: null, nip: null, ulica: 'Kloszowa 7/2', kod: '30-001', miasto: 'Kraków', kraj: 'PL', email: null };
    expect(await p.przygotujNabywce(osoba, { zalozGdyBrak: true })).toStrictEqual({ client_id: 78 });
    expect(k.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(k.zalozKlienta.mock.calls[0]).toStrictEqual([{
      company_name: 'Nabywca', nip: null, street: 'Kloszowa 7/2', postal_code: '30-001', city: 'Kraków', country: 'PL', email: null,
    }]);
  });

  it('pusta firma ("") i pusty NIP ("") — ta sama prawdziwość co faktura.js: „Nabywca”, nip null, bez wyszukiwania', async () => {
    const k = mock();
    k.zalozKlienta.mockResolvedValue(79);
    const p = programInfakt(k);
    await p.przygotujNabywce({ ...firma, firma: '', nip: '' }, { zalozGdyBrak: true });
    expect(k.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(k.zalozKlienta.mock.calls[0][0]).toMatchObject({ company_name: 'Nabywca', nip: null });
  });

  it('WDT → country z prefiksu numeru, nie z pola kraj (zamówienie ręczne oddaje „PL”)', async () => {
    const k = mock();
    k.zalozKlienta.mockResolvedValue(80);
    const p = programInfakt(k);
    const unijny = { firma: 'Lampen Halbschatten GmbH', nip: 'DE123456789', ulica: 'Lampenweg 1', kod: '10115', miasto: 'Berlin', kraj: 'PL', email: 'einkauf@halbschatten.invalid' };
    await p.przygotujNabywce(unijny, { zalozGdyBrak: true });
    expect(k.znajdzKlientaPoNip.mock.calls).toEqual([['DE123456789']]);
    expect(k.zalozKlienta.mock.calls[0]).toStrictEqual([{
      company_name: 'Lampen Halbschatten GmbH', nip: 'DE123456789', street: 'Lampenweg 1', postal_code: '10115', city: 'Berlin',
      country: 'DE', email: 'einkauf@halbschatten.invalid',
    }]);
  });

  it('zalozGdyBrak: false (faktura okresu) → null bez zakładania; znaleziony → { client_id }', async () => {
    const k = mock();
    const p = programInfakt(k);
    expect(await p.przygotujNabywce({ nip: '1234563218' }, { zalozGdyBrak: false })).toBeNull();
    expect(k.znajdzKlientaPoNip.mock.calls).toEqual([['1234563218']]);
    expect(k.zalozKlienta).not.toHaveBeenCalled();
    k.znajdzKlientaPoNip.mockResolvedValue(55);
    expect(await p.przygotujNabywce({ nip: '1234563218' }, { zalozGdyBrak: false })).toStrictEqual({ client_id: 55 });
    expect(k.zalozKlienta).not.toHaveBeenCalled();
  });

  it('bez opcji — nie zakłada (bezpieczny domysł)', async () => {
    const k = mock();
    expect(await programInfakt(k).przygotujNabywce({ nip: '1234563218' })).toBeNull();
    expect(k.zalozKlienta).not.toHaveBeenCalled();
  });

  it('kartoteka nie oddała identyfikatora → null (komunikat odmowy zostaje w usłudze)', async () => {
    const k = mock();
    k.zalozKlienta.mockResolvedValue(null);
    expect(await programInfakt(k).przygotujNabywce(firma, { zalozGdyBrak: true })).toBeNull();
  });

  it('błąd kartoteki wychodzi bez zmian (ten sam obiekt)', async () => {
    const k = mock();
    const blad = bladOperatora('W kartotece inFaktu są 2 wpisy z tym NIP-em.');
    k.znajdzKlientaPoNip.mockRejectedValue(blad);
    await expect(programInfakt(k).przygotujNabywce(firma, { zalozGdyBrak: true })).rejects.toBe(blad);
    expect(k.zalozKlienta).not.toHaveBeenCalled();
  });

  it('na prawdziwej atrapie: zakłada raz, drugi raz znajduje ten sam wpis', async () => {
    const p = programInfakt(atrapa());
    const pierwszy = await p.przygotujNabywce(firma, { zalozGdyBrak: true });
    expect(pierwszy).toEqual({ client_id: expect.any(Number) });
    expect(await p.przygotujNabywce(firma, { zalozGdyBrak: false })).toEqual(pierwszy);
  });
});

describe('(11) adapter przezroczysty — argumenty, wynik, błąd', () => {
  it('te same argumenty (tożsamość) i ten sam wynik: Buffer z PDF, tablica z listy', async () => {
    const k = mock();
    const pdf = Buffer.from('%PDF-1.4 lampa');
    const lista = [{ uuid: 'u-1', number: 'FV 1/10/2026' }];
    const ladunek = { client_id: 41, services: [{ name: 'Lampa wisząca Półcień', quantity: 1, gross_price: 34900, tax_symbol: '23' }] };
    const zakres = { od: '2026-10-01', do: '2026-10-31' };
    const opcje = { sufitStron: 3 };
    k.pobierzPdf.mockResolvedValue(pdf);
    k.listaFaktur.mockResolvedValue(lista);
    const wynikWystawienia = { uuid: 'u-2', numer: 'FV 2/10/2026' };
    k.wystaw.mockResolvedValue(wynikWystawienia);
    const p = programInfakt(k);

    expect(await p.pobierzPdf('u-1', 'original')).toBe(pdf);
    expect(k.pobierzPdf.mock.calls).toEqual([['u-1', 'original']]);
    expect(await p.listaFaktur(zakres, opcje)).toBe(lista);
    expect(k.listaFaktur.mock.calls[0][0]).toBe(zakres);
    expect(k.listaFaktur.mock.calls[0][1]).toBe(opcje);
    expect(await p.wystaw(ladunek)).toBe(wynikWystawienia);
    expect(k.wystaw.mock.calls[0][0]).toBe(ladunek);
    // ani jednego argumentu więcej — `infakt.wystaw.mock.calls` w testach usług dalej znaczy to samo
    expect(k.wystaw.mock.calls[0]).toHaveLength(1);
    await p.pobierzPdfKorekty('u-3');
    expect(k.pobierzPdfKorekty.mock.calls[0]).toEqual(['u-3']);
  });

  it('każda metoda kontraktu woła swoją metodę klienta z tymi samymi argumentami', async () => {
    const k = mock();
    const p = programInfakt(k);
    for (const m of METODY_PROGRAMU.filter((x) => x !== 'przygotujNabywce')) {
      const arg = { m };
      // eslint-disable-next-line no-await-in-loop
      await p[m](arg, 2);
      expect(k[m].mock.calls).toEqual([[arg, 2]]);
      expect(k[m].mock.calls[0][0]).toBe(arg);
    }
  });

  it('błąd bez zmian: ten sam obiekt, status i dlaOperatora; bez bezInfaktu — bez bezProgramu', async () => {
    const k = mock();
    const blad = bladOperatora('inFakt odrzucił dokument: brak nazwy pozycji.', { status: 422 });
    k.wystaw.mockRejectedValue(blad);
    const p = programInfakt(k);
    const zlapany = await p.wystaw({}).catch((e) => e);
    expect(zlapany).toBe(blad);
    expect(zlapany.status).toBe(422);
    expect(zlapany.dlaOperatora).toBe(true);
    expect(zlapany.message).toBe('inFakt odrzucił dokument: brak nazwy pozycji.');
    expect(zlapany).not.toHaveProperty('bezProgramu');
  });

  it('błąd bez statusu (zerwane połączenie) zostaje bez statusu', async () => {
    const k = mock();
    const blad = new Error('fetch failed');
    k.wyslijDokumentDoKsef.mockRejectedValue(blad);
    const zlapany = await programInfakt(k).wyslijDokumentDoKsef('u-1').catch((e) => e);
    expect(zlapany).toBe(blad);
    expect(zlapany).not.toHaveProperty('status');
    expect(zlapany).not.toHaveProperty('bezProgramu');
  });

  it('bezInfaktu → dokłada bezProgramu (oba pola), ten sam obiekt błędu', async () => {
    const k = mock();
    const blad = bladOperatora('inFakt nie jest skonfigurowany.', { status: 400, bezInfaktu: true });
    k.pobierzFakture.mockRejectedValue(blad);
    const zlapany = await programInfakt(k).pobierzFakture('u-1').catch((e) => e);
    expect(zlapany).toBe(blad);
    expect(zlapany).toMatchObject({ status: 400, dlaOperatora: true, bezInfaktu: true, bezProgramu: true });
  });

  it('odmowa próby i pośrednik bez zapisu: odmowa z bezInfaktu i bezProgramu, status 400', async () => {
    for (const obiekt of [odmowaInfaktuWProbie(), posrednik()]) {
      const p = programInfakt(obiekt);
      // eslint-disable-next-line no-await-in-loop
      const e = await p.pobierzFakture('u-1').catch((x) => x);
      expect(e).toMatchObject({ status: 400, dlaOperatora: true, bezInfaktu: true, bezProgramu: true });
      // eslint-disable-next-line no-await-in-loop
      const n = await p.przygotujNabywce({ nip: '1234563218' }, { zalozGdyBrak: true }).catch((x) => x);
      expect(n).toMatchObject({ status: 400, bezInfaktu: true, bezProgramu: true });
    }
  });
});
