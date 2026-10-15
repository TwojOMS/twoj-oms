import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createWooAdapter } from '../../src/oms/woo/adapter.js';
import { createPoller } from '../../src/moduly/kanaly/services/poller.js';
import { listaZamowien } from '../../src/oms/db/zamowienia.js';

// Od Etapu 2 mapowanie to CALA tablica dostaw sklepu (instancje + reguly zapasowe
// po pozycji), a nie sama mapa instancji — patrz domain/mapowanie-wysylki.js.
// Instancja 2 to ten sam kurier za pobraniem — od 2026-08-01 pobranie jest FLAGA obok
// metody, a nie osobna nazwa metody (domain/mapowanie-wysylki.js).
const mapa = {
  instancje: { 1: { metoda: 'dpd' }, 2: { metoda: 'dpd', pobranie: true }, 3: { metoda: 'dpd' } },
  poPozycji: [],
};
// date_modified_gmt to pole, ktorym faktycznie steruje kursor pollera (patrz poller.js) —
// date_modified (czas lokalny sklepu) trzymamy tylko dla realizmu fixture'a, tak jak
// prawdziwe Woo zwraca oba pola naraz.
const zam = (id, modifiedGmt, modifiedLokalny = modifiedGmt) => ({
  id, number: String(id), status: 'processing', total: '10.00',
  date_created: '2026-07-29T10:00:00', date_modified: modifiedLokalny, date_modified_gmt: modifiedGmt,
  billing: {}, shipping: {}, shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
  line_items: [], meta_data: [],
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('poller', () => {
  it('zapisuje pobrane zamówienia i przesuwa kursor na najnowszą modyfikację', async () => {
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zam(1, '2026-07-29T10:00:00'), zam(2, '2026-07-29T11:00:00')], stron: 1 }) };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    expect(await p.przebieg()).toEqual({ pobrane: 2 });
    expect(listaZamowien(db)).toHaveLength(2);
    expect(p.stan().zsynchronizowane_do).toBe('2026-07-29T11:00:00');
  });

  // Symulacja przejscia na czas zimowy: date_modified (lokalny) jest GODZINE ZA date_modified_gmt.
  // Gdyby kursor szedl za polem lokalnym, zapisalby sie na '2026-10-25T01:30:00' — czyli
  // O GODZINE WCZESNIEJ niz prawdziwy czas modyfikacji w GMT, i kolejne zamowienia
  // zmodyfikowane pomiedzy tymi dwiema wartosciami zostalyby zgubione na zawsze.
  it('kursor idzie za date_modified_gmt, nie za lokalnym date_modified (DST)', async () => {
    const zamowienie = zam(1, '2026-10-25T02:30:00', '2026-10-25T01:30:00');
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zamowienie], stron: 1 }) };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await p.przebieg();
    expect(p.stan().zsynchronizowane_do).toBe('2026-10-25T02:30:00');
  });

  it('drugi przebieg pyta od zapisanego kursora', async () => {
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 1 }) };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await p.przebieg();
    await p.przebieg();
    expect(woo.pobierzZamowienia).toHaveBeenLastCalledWith({ modifiedAfter: '2026-07-29T10:00:00', page: 1 });
  });

  it('przechodzi przez wszystkie strony', async () => {
    const woo = {
      pobierzZamowienia: vi.fn()
        .mockResolvedValueOnce({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 2 })
        .mockResolvedValueOnce({ zamowienia: [zam(2, '2026-07-29T11:00:00')], stron: 2 }),
    };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    expect(await p.przebieg()).toEqual({ pobrane: 2 });
  });

  // Kursor przesuniety mimo bledu = zamowienia z drugiej strony przepadaja na zawsze.
  it('błąd w połowie NIE przesuwa kursora', async () => {
    const woo = {
      pobierzZamowienia: vi.fn()
        .mockResolvedValueOnce({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 2 })
        .mockRejectedValueOnce(new Error('sklep padł')),
    };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await expect(p.przebieg()).rejects.toThrow(/sklep padł/);
    expect(p.stan().zsynchronizowane_do).toBeNull();
    expect(p.stan().ostatni_blad).toMatch(/sklep padł/);
  });

  // To jest test, ktory faktycznie pilnuje ochrony kursora: startujemy z NIEZEROWYM
  // kursorem (nie z null jak w tescie wyzej), pierwsza strona drugiego przebiegu
  // przesuwa lokalna zmienna kursor do przodu, a druga strona pada. Jesli catch
  // kiedykolwiek zacznie zapisywac przesuniety `kursor` zamiast `poprzedni`,
  // ponizsza asercja to wykryje — w przeciwienstwie do testu z kursorem null.
  it('błąd w połowie NIE przesuwa niezerowego kursora (nawet gdy strona 1 go już przesunęła)', async () => {
    const wooPierwszy = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 1 }) };
    const p1 = createPoller({ db, kanal: createWooAdapter({ woo: wooPierwszy, mapowanie: mapa }), sklep: 'pro' });
    expect(await p1.przebieg()).toEqual({ pobrane: 1 });
    expect(p1.stan().zsynchronizowane_do).toBe('2026-07-29T10:00:00');

    const wooDrugi = {
      pobierzZamowienia: vi.fn()
        // strona 1: zamowienie z pozniejsza data niz zapisany kursor — lokalny `kursor` sie przesuwa
        .mockResolvedValueOnce({ zamowienia: [zam(2, '2026-07-29T12:00:00')], stron: 2 })
        .mockRejectedValueOnce(new Error('sklep padł w połowie')),
    };
    const p2 = createPoller({ db, kanal: createWooAdapter({ woo: wooDrugi, mapowanie: mapa }), sklep: 'pro' });
    await expect(p2.przebieg()).rejects.toThrow(/sklep padł w połowie/);

    // Kluczowa asercja: kursor musi zostac przy WARTOSCI SPRZED przebiegu,
    // a nie przy dacie z zamowienia ze strony 1 ani przy null.
    expect(p2.stan().zsynchronizowane_do).toBe('2026-07-29T10:00:00');
    expect(p2.stan().ostatni_blad).toMatch(/sklep padł w połowie/);
  });

  // ⚠️ 8866 zamowien na szkicownia.pl = 178 stron REST-a. Pierwszy przebieg nie zdazyl sie
  // skonczyc miedzy dwoma tykniernami setInterval(2 min), wiec kazde kolejne tykniecie
  // startowalo NASTEPNY przebieg od strony pierwszej — obciazenie sklepu rosnace z minuty
  // na minute i ani jeden zapisany kursor, bo zaden przebieg nie dobiegal konca.
  describe('jeden przebieg naraz', () => {
    it('drugie wywołanie w trakcie pierwszego nie rusza sklepu', async () => {
      let zwolnij;
      const woo = { pobierzZamowienia: vi.fn(() => new Promise((r) => { zwolnij = () => r({ zamowienia: [], stron: 1 }); })) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });

      const pierwszy = p.przebieg();
      expect(await p.przebieg()).toEqual({ pobrane: 0, pominiety: true });
      expect(woo.pobierzZamowienia).toHaveBeenCalledTimes(1);

      zwolnij();
      await pierwszy;
    });

    // Blokada zostawiona po bledzie wyciszylaby pollera NA ZAWSZE: panel dziala,
    // zamowienia przestaja przychodzic i nigdzie nie ma o tym slowa.
    it('przebieg zakończony błędem zwalnia blokadę', async () => {
      const woo = {
        pobierzZamowienia: vi.fn()
          .mockRejectedValueOnce(new Error('sklep padł'))
          .mockResolvedValueOnce({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 1 }),
      };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
      await expect(p.przebieg()).rejects.toThrow(/sklep padł/);
      expect(await p.przebieg()).toEqual({ pobrane: 1 });
    });
  });

  describe('data startowa `od`', () => {
    it('pierwszy przebieg pyta od podanej daty, a nie od początku istnienia sklepu', async () => {
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'szkicownia', od: '2026-07-01T00:00:00' });
      await p.przebieg();
      expect(woo.pobierzZamowienia).toHaveBeenCalledWith({ modifiedAfter: '2026-07-01T00:00:00', page: 1 });
    });

    // ⚠️ Gdyby `od` wygrywalo z kursorem, kazdy przebieg cofalby okno do lipca i panel
    // czytalby te same zamowienia w kolko — a przy sklepie z historia nigdy by nie doszedl
    // do nowych.
    it('zapisany kursor wygrywa z datą startową', async () => {
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'szkicownia', od: '2026-07-01T00:00:00' });
      await p.przebieg();
      await p.przebieg();
      expect(woo.pobierzZamowienia).toHaveBeenLastCalledWith({ modifiedAfter: '2026-07-29T10:00:00', page: 1 });
    });

    it('bez daty startowej pyta o wszystko — tak dziala PRO', async () => {
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
      await p.przebieg();
      expect(woo.pobierzZamowienia).toHaveBeenCalledWith({ modifiedAfter: null, page: 1 });
    });

    // ⚠️⚠️ NAJWAZNIEJSZY TEST TEJ SEKCJI. 01.08.2026 o 13:30 sklep szkicownia.pl dotknal
    // MASOWO calego archiwum — zamowienia z 2019, 2020 i 2024 dostaly `date_modified_gmt`
    // w tej samej sekundzie. Poller, ktory zawezal tylko PIERWSZE zapytanie, wciagnal wtedy
    // 500 zamowien sprzed lat, bo byly zmodyfikowane po kursorze. Data zlozenia sie nie
    // zmienia, wiec podloga idzie po NIEJ i obowiazuje w KAZDYM przebiegu.
    it('zamówienie ZŁOŻONE przed datą startową nie wchodzi, choćby sklep dotknął go dziś', async () => {
      const stare = { ...zam(9, '2026-08-01T13:30:18'), date_created_gmt: '2019-05-24T08:07:07' };
      const nowe = { ...zam(10, '2026-08-01T13:30:19'), date_created_gmt: '2026-07-15T10:00:00' };
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [stare, nowe], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'szkicownia', od: '2026-07-01T00:00:00' });

      expect(await p.przebieg()).toEqual({ pobrane: 1, pominieteStare: 1 });
      expect(listaZamowien(db).map((z) => z.numer)).toEqual(['10']);
    });

    // Kursor MUSI przeskoczyc pominiete zamowienie, inaczej kazdy nastepny przebieg czytalby
    // to samo archiwum od nowa — pomijanie przy zapisie nie zdejmuje ruchu ze sklepu.
    it('pominięte zamówienie i tak przesuwa kursor', async () => {
      const stare = { ...zam(9, '2026-08-01T13:30:18'), date_created_gmt: '2019-05-24T08:07:07' };
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [stare], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'szkicownia', od: '2026-07-01T00:00:00' });
      await p.przebieg();
      expect(p.stan().zsynchronizowane_do).toBe('2026-08-01T13:30:18');
    });

    // Sklep bez daty startowej (PRO) nie ma podlogi i ma jej NIE MIEC — tam archiwum
    // to siedem zamowien.
    it('bez daty startowej stare zamówienia wchodzą normalnie', async () => {
      const stare = { ...zam(9, '2026-08-01T13:30:18'), date_created_gmt: '2019-05-24T08:07:07' };
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [stare], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
      expect(await p.przebieg()).toEqual({ pobrane: 1 });
    });

    // Data startowa NIE MOZE wyladowac w kolumnie kursora: przebieg, ktory nic nie pobral,
    // ma zostac przy „jeszcze nic", zeby nastepny znow zajrzal od tej samej daty.
    it('pusty przebieg nie zapisuje daty startowej jako kursora', async () => {
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'szkicownia', od: '2026-07-01T00:00:00' });
      await p.przebieg();
      expect(p.stan().zsynchronizowane_do).toBeNull();
    });
  });

  // ⚠️⚠️ C-2 (recenzja calej galezi): JEDNO ZAMOWIENIE O ZLYM KSZTALCIE NIE MA PRAWA ZABIC
  // KANALU — a do 04.08.2026 zabijalo go NA STALE i PO CICHU.
  //
  // `mapujZamowienieAllegro` rzuca przy nieparsowalnej kwocie zamowienia, przy pobraniu na
  // 0 zl i (od poprawki M-1) przy nieparsowalnej cenie pozycji. Wolane bylo TUTAJ, wewnatrz
  // petli po zamowieniach, bez zadnej izolacji: rzut wychodzil z petli do `catch`, ktory
  // zapisywal POPRZEDNI kursor i rzucal dalej. Nastepne tykniecie czytalo TE SAMA strone,
  // trafialo na TO SAMO zamowienie i rzucalo znowu — kanal stal na zawsze, a jedynym wyjsciem
  // byl reczny UPDATE na `stan_pollera` (niezmiennik 4.9 wprost).
  //
  // Kanal jest tu ATRAPA, a nie adapterem Woo: reguly pollera sa JEDNE dla wszystkich kanalow
  // (patrz komentarz nad createPoller), a `domain/mapowanie.js` nie rzuca nigdy, wiec na Woo
  // tej sciezki nie da sie w ogole uruchomic.
  describe('izolacja per zamówienie (C-2)', () => {
    // Najprostszy kanal spelniajacy kontrakt: `mapuj` rzuca dla zamowien z `zle: true`.
    const kanalAtrapa = (strony) => {
      const pobierzStrone = vi.fn(async ({ strona }) => strony[strona - 1]);
      return {
        pobierzStrone,
        kursorZ: (s) => s?.updatedAt ?? null,
        zlozoneZ: (s) => s?.boughtAt ?? null,
        mapuj: (s) => {
          if (s.zle) throw new Error(`Zamówienie za pobraniem bez kwoty do pobrania: ${s.id}.`);
          return {
            zrodlo_id: s.id, numer: String(s.id), klient: {}, dostawa: {}, metoda_wysylki: 'allegro_dpd',
            kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '10.00', status_woo: null,
            oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-04T08:00:00', pozycje: [],
          };
        },
      };
    };
    const zamAllegro = (id, updatedAt, nad = {}) => ({ id, updatedAt, boughtAt: '2026-08-03T09:00:00.000Z', ...nad });

    it('złe zamówienie NIE zatrzymuje przebiegu — pozostałe z tej samej strony wchodzą do bazy', async () => {
      const kanal = kanalAtrapa([{
        zamowienia: [
          zamAllegro('ALG-1', '2026-08-04T10:00:00.000Z'),
          zamAllegro('ALG-ZLE', '2026-08-04T11:00:00.000Z', { zle: true }),
          zamAllegro('ALG-2', '2026-08-04T12:00:00.000Z'),
        ],
        stron: 1,
      }]);
      const p = createPoller({ db, kanal, sklep: 'allegro_szkicownia' });

      // Przebieg KONCZY SIE NORMALNIE (nie rzuca) i mowi, ile pominal.
      expect(await p.przebieg()).toEqual({ pobrane: 2, pominieteBledem: 1 });
      expect(listaZamowien(db).map((z) => z.numer).sort()).toEqual(['ALG-1', 'ALG-2']);
    });

    // ⚠️ KURSOR MUSI PRZESKOCZYC ZLE ZAMOWIENIE. Zostawiony przed nim znaczy dokladnie te sama
    // wieczna petle, co przed poprawka — tyle ze bez wyjatku, wiec jeszcze ciszej.
    it('kursor przesuwa się PONAD złe zamówienie, więc następny przebieg idzie dalej', async () => {
      const kanal = kanalAtrapa([{
        zamowienia: [zamAllegro('ALG-ZLE', '2026-08-04T11:00:00.000Z', { zle: true })],
        stron: 1,
      }]);
      const p = createPoller({ db, kanal, sklep: 'allegro_szkicownia' });
      await p.przebieg();
      expect(p.stan().zsynchronizowane_do).toBe('2026-08-04T11:00:00.000Z');
    });

    // ⚠️ POMINIECIE MA BYC WIDOCZNE. Zamowienia nie ma w panelu, kursor przez nie przeskoczyl,
    // wiec samo z siebie NIE WROCI — bez zapisanego powodu izolacja zamienialaby awarie
    // glosna na cicha. Pasek na liscie czyta wlasnie `ostatni_blad` (bootstrap.js: `stan()`
    // oddaje pollera z niepustym bledem).
    it('powód pominięcia trafia do stanu pollera, razem z identyfikatorem zamówienia', async () => {
      const kanal = kanalAtrapa([{
        zamowienia: [zamAllegro('ALG-ZLE', '2026-08-04T11:00:00.000Z', { zle: true })],
        stron: 1,
      }]);
      const p = createPoller({ db, kanal, sklep: 'allegro_szkicownia' });
      await p.przebieg();
      expect(p.stan().ostatni_blad).toMatch(/Pominięto 1 zamówienie/);
      expect(p.stan().ostatni_blad).toContain('ALG-ZLE');
    });

    it('kolejna strona jest czytana mimo złego zamówienia na pierwszej', async () => {
      const kanal = kanalAtrapa([
        { zamowienia: [zamAllegro('ALG-ZLE', '2026-08-04T10:00:00.000Z', { zle: true })], stron: 2 },
        { zamowienia: [zamAllegro('ALG-2', '2026-08-04T12:00:00.000Z')], stron: 2 },
      ]);
      const p = createPoller({ db, kanal, sklep: 'allegro_szkicownia' });
      expect(await p.przebieg()).toEqual({ pobrane: 1, pominieteBledem: 1 });
      expect(kanal.pobierzStrone).toHaveBeenCalledTimes(2);
    });

    // ⚠️⚠️ GRANICA IZOLACJI: AWARIA ZAPISU MA DALEJ PRZERYWAC PRZEBIEG. Blad bazy (pelny dysk,
    // SQLITE_FULL, baza tylko do odczytu) dotyczy WSZYSTKICH zamowien naraz i mija sam.
    // Polkniety razem z przesunieciem kursora znaczylby zamowienia zgubione NA ZAWSZE — caly
    // przebieg „udalby sie" bez ani jednego wiersza w bazie. Dlatego zapis stoi POZA izolacja.
    it('awaria ZAPISU dalej przerywa przebieg i NIE przesuwa kursora', async () => {
      // ⚠️ Awaria WYLACZNIE na tabeli `zamowienia`, a nie cala baza tylko do odczytu — i to
      // jest tu istotne, a nie wygodne: przy bazie odmawiajacej WSZYSTKIEGO padalby takze
      // `zapiszStan`, wiec przebieg rzucalby tak czy tak i test niczego by nie rozroznial
      // (zmierzone mutacja: izolacja rozciagnieta na zapis PRZEZYLA taki test). Tutaj stan
      // pollera zapisuje sie normalnie, wiec jedyna rzecza, ktora moze przerwac przebieg,
      // jest wyjatek z `zapiszZamowienie`.
      const awariaZapisu = {
        exec: (...a) => db.exec(...a),
        prepare: (sql) => {
          const stmt = db.prepare(sql);
          if (!/INTO zamowienia|UPDATE zamowienia/.test(sql)) return stmt;
          return {
            run: () => { throw new Error('SQLITE_FULL: database or disk is full'); },
            get: (...a) => stmt.get(...a),
            all: (...a) => stmt.all(...a),
          };
        },
      };
      const kanal = kanalAtrapa([{ zamowienia: [zamAllegro('ALG-1', '2026-08-04T10:00:00.000Z')], stron: 1 }]);
      const p = createPoller({ db: awariaZapisu, kanal, sklep: 'allegro_szkicownia' });

      await expect(p.przebieg()).rejects.toThrow(/SQLITE_FULL/);
      // Kursor zostaje: zamowienie ma wrocic przy nastepnym przebiegu, a nie przepasc.
      expect(p.stan().zsynchronizowane_do).toBeNull();
      // …a w stanie jest awaria bazy, a nie „pominieto zamowienie" — to sa dwie rozne rzeczy
      // i mylenie ich znaczyloby, ze pelny dysk wyglada jak zamowienie o zlym ksztalcie.
      expect(p.stan().ostatni_blad).toMatch(/SQLITE_FULL/);
      expect(p.stan().ostatni_blad).not.toMatch(/Pominięto/);
    });

    // ⚠️ SKLEPY MAJA SIE NIE ZMIENIC. `domain/mapowanie.js` nie rzuca nigdy, wiec gdy nic nie
    // rzuca, przebieg musi wygladac DOKLADNIE jak przed poprawka — takze w tym, co zwraca
    // (`pominieteBledem` nie ma prawa sie pojawic) i w tym, ze `ostatni_blad` sie zeruje.
    it('gdy nic nie rzuca, przebieg wygląda dokładnie jak przed poprawką', async () => {
      const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [zam(1, '2026-07-29T10:00:00')], stron: 1 }) };
      const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
      expect(await p.przebieg()).toEqual({ pobrane: 1 });
      expect(p.stan().ostatni_blad).toBeNull();
    });
  });

  it('zapisuje czas ostatniego przebiegu', async () => {
    const woo = { pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [], stron: 1 }) };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await p.przebieg();
    expect(p.stan().ostatni_przebieg_at).toBeTruthy();
  });

  it('udany przebieg czyści poprzedni błąd', async () => {
    const woo = {
      pobierzZamowienia: vi.fn()
        .mockRejectedValueOnce(new Error('padło'))
        .mockResolvedValueOnce({ zamowienia: [], stron: 1 }),
    };
    const p = createPoller({ db, kanal: createWooAdapter({ woo, mapowanie: mapa }), sklep: 'pro' });
    await expect(p.przebieg()).rejects.toThrow();
    await p.przebieg();
    expect(p.stan().ostatni_blad).toBeNull();
  });
});
