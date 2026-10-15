import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszWeryfikacjeAllegro } from '../../../src/moduly/faktury/db/faktury.js';
import {
  createCzuwaczKsef, LIMIT_WERYFIKACJI, PODLOGA_DNI, NAJDLUZSZY_PRZEBIEG_MS,
} from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import { ODSTEP_CZUWACZA_MS } from '../../pomoc/serwer-parytetu.ts';
import {
  weryfikacjaNierozstrzygnieta, WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL,
} from '../../../src/domena/allegro-faktura.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';

// Weryfikacja pliku po stronie Allegro (Plan B, Zadanie 10).
//
// ⚠️⚠️ WYSLANIE NIE JEST KONCEM OPERACJI. Allegro sprawdza plik antywirusem:
// WAITING → ACCEPTED albo REJECTED. `REJECTED` znaczy, ze kupujacy faktury NIE MA,
// a panel bez tej wiedzy twierdzilby, ze ma.
//
// ⚠️ ZRODLO STANU JEST DZIS NIEPEWNE I TO JEST ZMIERZONE (notatka 2026-08-05, §2):
// `GET .../invoices` oddaje 400 na kazde nasze zamowienie, wiec klient zwraca pusta liste.
// Pierwszym zrodlem prawdy jest odpowiedz na `PUT .../file` (Zadanie 9), a odpytywanie
// nizej jest PROBA: przy pustej liscie nic nie nadpisuje i przebieg idzie dalej.

const GODZINA = 60 * 60 * 1000;
const DZIEN = 24 * GODZINA;

// ⚠️ DATY LICZONE OD DZISIAJ, nigdy wpisane na sztywno. Petla weryfikacji ma PODLOGE po dacie
// wyslania, wiec data z kalendarza zamienilaby kazdy test zakresu w bombe zegarowa: przeszedlby
// dzisiaj, a wywalil sie po miesiacu, bez ani jednej zmiany w kodzie. Ta sama zasada, co
// w tests/oms/czuwacz-ksef.test.js.
const przedGodzinami = (h) => new Date(Date.now() - h * GODZINA).toISOString();
const przedDniami = (d) => new Date(Date.now() - d * DZIEN).toISOString();

let licznik = 0;

function zFaktura(db, {
  sklep = 'allegro_szkicownia', invoiceId = 'INV-1', weryfikacja = 'WAITING',
  wyslanaAt = przedGodzinami(1), ksefNumer = 'KS-1', numer = 'FV/12/2026',
} = {}) {
  licznik += 1;
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: `${sklep}-${licznik}`,
    numer: String(3000 + licznik),
    klient: { first_name: 'Jan', last_name: 'Kowalski' },
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 1,
    nip: null,
    kwota_brutto: '100.00',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    utworzone_at: '2026-08-05T09:00:00',
    pozycje: [],
  }, {});
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, allegro_invoice_id,'
    + ' allegro_wyslana_at, allegro_weryfikacja, utworzona_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, `u${licznik}`, numer, ksefNumer, invoiceId, wyslanaAt, weryfikacja, przedGodzinami(2));
  return id;
}

const fakturaZ = (db, id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
const logZ = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
// Petla weryfikacji pyta Allegro identyfikatorem ZAMOWIENIA W ALLEGRO (`zrodlo_id`), a nie
// naszym `id` — testy zakresu porownuja wiec to, co naprawde poszlo do klienta.
const zrodloZ = (db, id) => db.prepare('SELECT zrodlo_id FROM zamowienia WHERE id = ?').get(id).zrodlo_id;

// inFakt nie ma tu nic do roboty: kazda faktura w tych testach ma juz numer KSeF, wiec wypada
// z pierwszej petli czuwacza. Atrapa rzuca, gdyby ktos jednak o nia zapytal — cichy przelot
// przez pierwsza petle ukrylby blad w zakresie zapytania.
const infaktNieruszany = {
  pobierzFakture: async () => { throw new Error('pierwsza pętla nie ma tu o co pytać'); },
};

// Atrapa kanalu liczaca pytania. `pobierzFakturyZamowienia` oddaje LISTE wpisow faktur
// zgloszonych przy zamowieniu — dokladnie tak jak klient (allegro/client.js).
function kanal(odpowiedz = []) {
  const pytania = [];
  return {
    pytania,
    klienci: {
      allegro_szkicownia: {
        pobierzFakturyZamowienia: async (zrodloId) => {
          pytania.push(zrodloId);
          return typeof odpowiedz === 'function' ? odpowiedz(zrodloId) : odpowiedz;
        },
      },
    },
  };
}

const wpis = (id, status) => ({ id, file: { securityVerification: { status } } });

describe('czuwacz — weryfikacja pliku faktury w Allegro', () => {
  it('WAITING → ACCEPTED zostaje zapisane', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const k = kanal([wpis('INV-1', 'ACCEPTED')]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('ACCEPTED');
    db.close();
  });

  // ⚠️ DWA MOZLIWE KSZTALTY ODPOWIEDZI (dokumentacja Allegro jest sprzeczna) — czyta je
  // `statusWeryfikacji`. Czytanie jednego miejsca znaczyloby 50% szans, ze panel NIGDY nie
  // zobaczy odrzucenia pliku.
  it('czyta status także z najwyższego poziomu wpisu, nie tylko z `file`', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const k = kanal([{ id: 'INV-1', securityVerification: { status: 'ACCEPTED' } }]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('ACCEPTED');
    db.close();
  });

  it('rozstrzygnięcie zostawia ślad w logu zamówienia', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const k = kanal([wpis('INV-1', 'REJECTED')]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    const wpisy = logZ(db, id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].akcja).toBe('faktura-allegro');
    expect(wpisy[0].wynik).toMatch(/REJECTED/);
    db.close();
  });

  // ⚠️ WAITING NIE JEST ROZSTRZYGNIECIEM — wpis do logu przy kazdym przebiegu daloby
  // 24 identyczne wiersze na dobe, a prawdziwa historia dokumentu utonelaby w nich w tydzien.
  it('powtórzone WAITING nie zasypuje logu karty', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const k = kanal([wpis('INV-1', 'WAITING')]);
    const czuwacz = createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci });

    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(logZ(db, id)).toEqual([]);
    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('WAITING');
    db.close();
  });

  // ⚠️⚠️ ACCEPTED I REJECTED SA KONCOWE. Odpytywanie ich w kolko to setki wywolan miesiecznie
  // bez ani jednej nowej informacji — dokladnie ta klasa kosztu, ktora recenzja Partii 2
  // zamknela podloga w pierwszej petli.
  it('faktura już ACCEPTED nie jest odpytywana ponownie', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { weryfikacja: 'ACCEPTED' });
    const k = kanal([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toEqual([]);
    db.close();
  });

  it('faktura już REJECTED też nie jest odpytywana ponownie', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { weryfikacja: 'REJECTED' });
    const k = kanal([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toEqual([]);
    db.close();
  });

  it('faktura jeszcze NIEWYSŁANA do Allegro nie jest odpytywana', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { wyslanaAt: null, invoiceId: null, weryfikacja: null });
    const k = kanal([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toEqual([]);
    db.close();
  });

  // ⚠️⚠️ BRAK NASZEJ FAKTURY NA LISCIE NIE ZNACZY „NIE MA". Zasob oddaje dzis 400, wiec klient
  // zwraca PUSTA LISTE — nadpisanie tym czegokolwiek skasowaloby jedyna wiedze, jaka panel ma
  // (zapisana z odpowiedzi na `PUT .../file`). To ta sama klasa usterki, ktora recenzja
  // Partii 2 nazwala „kolumna write-only", tylko odwrocona.
  it('brak naszej faktury na liście Allegro NIE KASUJE tego, co wiemy', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const k = kanal([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toHaveLength(1);
    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('WAITING');
    expect(logZ(db, id)).toEqual([]);
    db.close();
  });

  // Lista niepusta, ale NASZEGO wpisu w niej nie ma (Allegro przyjmuje do 10 faktur na
  // zamowienie) — to tez jest „nie wiem", a nie „nie ma".
  it('cudzy wpis na liście nie przykrywa naszego stanu', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const k = kanal([wpis('INV-CUDZE', 'REJECTED')]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('WAITING');
    db.close();
  });

  it('czuwacz bez kanałów robi tylko krok KSeF i nie wywala się', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await expect(createCzuwaczKsef({ db, infakt: infaktNieruszany }).przebieg()).resolves.toBeTruthy();

    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('WAITING');
    db.close();
  });

  it('faktura z kanału, którego panel nie zna, jest pomijana — reszta idzie dalej', async () => {
    const db = openOmsDb(':memory:');
    const obcy = zFaktura(db, { sklep: 'allegro_amarka', invoiceId: 'INV-OBCY' });
    const nasz = zFaktura(db, { invoiceId: 'INV-1' });
    const k = kanal([wpis('INV-1', 'ACCEPTED')]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(fakturaZ(db, obcy).allegro_weryfikacja).toBe('WAITING');
    expect(fakturaZ(db, nasz).allegro_weryfikacja).toBe('ACCEPTED');
    db.close();
  });

  // ⚠️ IZOLACJA NA FAKTURE, NIE NA PRZEBIEG — ta sama regula, co w pierwszej petli.
  it('awaria odczytu jednej faktury nie zatrzymuje pozostałych i ląduje w logu karty', async () => {
    const db = openOmsDb(':memory:');
    const pierwszy = zFaktura(db, { invoiceId: 'INV-PADA' });
    const drugi = zFaktura(db, { invoiceId: 'INV-1' });
    const pada = zrodloZ(db, pierwszy);
    const klienci = {
      allegro_szkicownia: {
        pobierzFakturyZamowienia: async (zrodloId) => {
          if (zrodloId === pada) throw new Error('Allegro nieosiągalne: ECONNRESET');
          return [wpis('INV-1', 'ACCEPTED')];
        },
      },
    };

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: klienci }).przebieg();

    expect(fakturaZ(db, drugi).allegro_weryfikacja).toBe('ACCEPTED');
    expect(fakturaZ(db, pierwszy).allegro_weryfikacja).toBe('WAITING');
    const wpisy = logZ(db, pierwszy);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].wynik).toMatch(/ECONNRESET/);
    db.close();
  });

  it('ten sam błąd co godzinę nie zasypuje logu karty', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const klienci = {
      allegro_szkicownia: {
        pobierzFakturyZamowienia: async () => { throw new Error('Allegro nieosiągalne: ECONNRESET'); },
      },
    };
    const czuwacz = createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: klienci });

    await czuwacz.przebieg();
    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(logZ(db, id)).toHaveLength(1);
    db.close();
  });
});

// ⚠️⚠️ TA SAMA USTERKA, KTORA RECENZJA PARTII 2 ZAMKNELA W PIERWSZEJ PETLI (W1), tylko gorsza:
// zasob oddaje DZIS 400, wiec KAZDA wyslana faktura zostaje w stanie WAITING NA ZAWSZE.
// Bez podlogi i bez sufitu zapytanie rosloby liniowo razem z archiwum wysylek i nigdy nie malalo.
describe('czuwacz — pętla weryfikacji jest OGRANICZONA', () => {
  it('nie pyta o fakturę wysłaną dawniej niż podłoga — po tym czasie rozstrzyga człowiek', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { wyslanaAt: przedDniami(PODLOGA_DNI + 1) });
    const k = kanal([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toEqual([]);
    db.close();
  });

  it('fakturę wysłaną o dzień świeżej niż podłoga dalej sprawdza', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { wyslanaAt: przedDniami(PODLOGA_DNI - 1) });
    const k = kanal([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toHaveLength(1);
    db.close();
  });

  // ⚠️⚠️ DWIE PETLE W JEDNYM PRZEBIEGU MUSZA SIE ZMIESCIC MIEDZY TYKNIECIAMI ZEGARA. Straznik
  // „jeden przebieg naraz" nie kolejkuje — on POMIJA, wiec przebieg dluzszy niz godzina znaczy
  // czuwacza chodzacego co dwie godziny, bez ani jednego bledu i bez sladu. Ta arytmetyka jest
  // policzona z prawdziwych stalych obu klientow (60 s inFakt × 50 + 5 s Allegro × 50 = 54 min
  // 10 s), a bootstrap.js odmawia startu panelu, gdy przestanie sie zgadzac.
  it('najgorszy przebieg OBU pętli mieści się między tyknięciami zegara czuwacza', () => {
    expect(NAJDLUZSZY_PRZEBIEG_MS).toBeLessThan(ODSTEP_CZUWACZA_MS);
  });

  it('jeden przebieg bierze najwyżej LIMIT_WERYFIKACJI faktur', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i <= LIMIT_WERYFIKACJI; i += 1) zFaktura(db);
    // ⚠️ ODPOWIEDŹ MUSI BYĆ NIEPUSTA i to NIE jest kosmetyka (spec 2026-08-28): pusta lista
    // jest sygnałem „zasób faktur Allegro nie odpowiada" i po `PROG_PUSTYCH` otwiera
    // bezpiecznik, który ucina przebieg do jednego pytania na dobę. Ten test sprawdza SUFIT
    // `LIMIT_WERYFIKACJI`, a nie bezpiecznik, więc kanał musi udawać żywy. Wpis jest CUDZY
    // (inne `id` niż nasze `INV-1`), więc niczego nie nadpisuje i wiersze zostają w kolejce —
    // dokładnie jak przy dzisiejszym 400, tylko bez otwierania bezpiecznika.
    const k = kanal([wpis('INV-CUDZA', 'ACCEPTED')]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toHaveLength(LIMIT_WERYFIKACJI);
    db.close();
  });

  it('reszta czeka na następny przebieg, od najdawniej wysłanej', async () => {
    const db = openOmsDb(':memory:');
    const stara = zFaktura(db, { wyslanaAt: przedDniami(5) });
    zFaktura(db, { wyslanaAt: przedGodzinami(1) });
    const k = kanal([]);

    await createCzuwaczKsef({
      db, infakt: infaktNieruszany, klienciKanalow: k.klienci, limitWeryfikacji: 1,
    }).przebieg();

    expect(k.pytania).toEqual([zrodloZ(db, stara)]);
    db.close();
  });

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ W6 (recenzja Partii 3): DRUGA PETLA GLODZILA NAJNOWSZE FAKTURY.
  // `ORDER BY allegro_wyslana_at LIMIT 50` zakladalo, ze obsluzone wiersze WYPADAJA ze zbioru.
  // DZIS NIE WYPADAJA: `GET .../invoices` oddaje 400, wiec status zostaje `WAITING`, a wiersz
  // siedzi w zapytaniu az do podlogi — 30 dni. Przy wiecej niz 50 wyslanych fakturach czuwacz
  // pytal w kolko o TE SAME najstarsze 50, a nowsze NIE BYLY PYTANE ANI RAZU.
  // ---------------------------------------------------------------------------------
  it('drugi przebieg pyta o NOWSZE faktury, a nie w kółko o te same najstarsze', async () => {
    const db = openOmsDb(':memory:');
    const najstarsza = zFaktura(db, { wyslanaAt: przedDniami(5) });
    const nowsza = zFaktura(db, { wyslanaAt: przedDniami(4) });
    // Pusta lista = dzisiejsze 400. Status ZOSTAJE `WAITING`, wiec oba wiersze nadal
    // kwalifikuja sie do pytania — i to jest cale sedno usterki.
    const k = kanal([]);
    const czuwacz = createCzuwaczKsef({
      db, infakt: infaktNieruszany, klienciKanalow: k.klienci, limitWeryfikacji: 1,
    });

    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(k.pytania).toEqual([zrodloZ(db, najstarsza), zrodloZ(db, nowsza)]);
    db.close();
  });

  // Po objechaniu wszystkich czuwacz WRACA do najdawniej pytanej — kolejka jest CYKLICZNA,
  // a nie jednorazowa. Bez tego faktura zapytana raz nie zostalaby zapytana nigdy wiecej,
  // czyli `WAITING` stalby sie stanem, ktorego nikt juz nie rozstrzygnie.
  it('po objechaniu wszystkich wraca do najdawniej pytanej', async () => {
    const db = openOmsDb(':memory:');
    const a = zFaktura(db, { wyslanaAt: przedDniami(5) });
    const b = zFaktura(db, { wyslanaAt: przedDniami(4) });
    const k = kanal([]);
    const czuwacz = createCzuwaczKsef({
      db, infakt: infaktNieruszany, klienciKanalow: k.klienci, limitWeryfikacji: 1,
    });

    await czuwacz.przebieg();
    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(k.pytania).toEqual([zrodloZ(db, a), zrodloZ(db, b), zrodloZ(db, a)]);
    db.close();
  });

  // ⚠️ NIEUDANY ODCZYT TEZ JEST PYTANIEM. Gdyby data zapisywala sie wylacznie po sukcesie,
  // faktura z trwale padajacym kanalem zostawalaby na czele kolejki NA ZAWSZE i glodzila
  // wszystkie pozostale — czyli dokladnie ta sama usterka, tylko weza brama.
  it('faktura, przy której odczyt PADŁ, nie blokuje kolejki', async () => {
    const db = openOmsDb(':memory:');
    const pechowa = zFaktura(db, { wyslanaAt: przedDniami(5) });
    const zdrowa = zFaktura(db, { wyslanaAt: przedDniami(4) });
    const pytania = [];
    const klienci = {
      allegro_szkicownia: {
        pobierzFakturyZamowienia: async (zrodloId) => {
          pytania.push(zrodloId);
          if (zrodloId === zrodloZ(db, pechowa)) throw new Error('kanał padł');
          return [];
        },
      },
    };
    const czuwacz = createCzuwaczKsef({
      db, infakt: infaktNieruszany, klienciKanalow: klienci, limitWeryfikacji: 1,
    });

    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(pytania).toEqual([zrodloZ(db, pechowa), zrodloZ(db, zdrowa)]);
    db.close();
  });

  // ⚠️ KANAL, KTOREGO PANEL NIE ZNA (klucz zniknal z konfiguracji), TEZ NIE MA PRAWA
  // ZATKAC KOLEJKI. Wiersz i tak wchodzi do zbioru wynikowego i zjada slot z `LIMIT`,
  // wiec bez odnotowania „czuwacz sie tym zajal" glodzilby wszystkich za soba.
  it('faktura z nieznanego kanału nie zatyka kolejki na zawsze', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'allegro_znikniety', wyslanaAt: przedDniami(5) });
    const zdrowa = zFaktura(db, { wyslanaAt: przedDniami(4) });
    const k = kanal([]);
    const czuwacz = createCzuwaczKsef({
      db, infakt: infaktNieruszany, klienciKanalow: k.klienci, limitWeryfikacji: 1,
    });

    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(k.pytania).toEqual([zrodloZ(db, zdrowa)]);
    db.close();
  });

  // ⚠️⚠️ STRAZNIK „JEDEN PRZEBIEG NARAZ" (recenzja Partii 2, W2) OBEJMUJE OBIE PETLE. Druga
  // petla dokladana do przebiegu przedluza go — a `setInterval` tyka co godzine niezaleznie
  // od tego, czy poprzedni sie skonczyl. Bez tego przebiegi pietrza sie i wala rownolegle
  // w Allegro.
  it('drugi przebieg nie wchodzi na trwającą pętlę weryfikacji', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { invoiceId: 'INV-1' });
    zFaktura(db, { invoiceId: 'INV-2' });
    let zwolnij;
    const brama = new Promise((r) => { zwolnij = r; });
    const pytania = [];
    const klienci = {
      allegro_szkicownia: {
        pobierzFakturyZamowienia: async (zrodloId) => {
          pytania.push(zrodloId);
          await brama;
          return [];
        },
      },
    };
    const czuwacz = createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: klienci });

    const pierwszy = czuwacz.przebieg();
    const drugi = await czuwacz.przebieg();

    expect(drugi.pominiety).toBe(true);
    expect(pytania).toHaveLength(1);
    zwolnij();
    await pierwszy;
    db.close();
  });
});

// ⚠️⚠️ REJECTED ZNACZY, ZE KUPUJACY FAKTURY NIE MA — a panel bez tej sprawy twierdzilby,
// ze ma (kolumna `allegro_wyslana_at` jest wypelniona). To musi byc BLOKADA na pasku.
describe('pasek „Do załatwienia" — weryfikacja pliku w Allegro', () => {
  const sprawa = (db, id, teraz = Date.now()) => sprawyKarty(pobierzZamowienie(db, id), teraz)
    .find((s) => s.klucz === 'faktura-allegro');

  it('REJECTED wchodzi na pasek jako BLOKADA i mówi, że kupujący faktury nie ma', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { weryfikacja: 'REJECTED' });

    const s = sprawa(db, id);

    expect(s.waga).toBe('blokada');
    expect(s.tekst).toMatch(/kupując/i);
    expect(s.tekst).toMatch(/FV\/12\/2026/);
    db.close();
  });

  it('ACCEPTED nie jest żadną sprawą', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { weryfikacja: 'ACCEPTED', wyslanaAt: przedDniami(9) });

    expect(sprawa(db, id)).toBeUndefined();
    db.close();
  });

  it('WAITING świeższy niż doba nie jest żadną sprawą', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { wyslanaAt: przedGodzinami(23) });

    expect(sprawa(db, id)).toBeUndefined();
    db.close();
  });

  // ⚠️⚠️ WYCISZONE 06.08.2026, PO PIERWSZEJ PRAWDZIWEJ FAKTURZE — i to jest zmiana wobec
  // Zadania 10, ktore kazalo tu zapalac UWAGE po dobie.
  //
  // Zadanie 10 stalo na hipotezie z notatki 2026-08-05 §2.2: „400 znaczy, ze zamowienie nie ma
  // ANI JEDNEJ faktury" — czyli ze zasob ozyje, gdy faktura sie pojawi, i `WAITING` bedzie
  // stanem PRZEJSCIOWYM. Pomiar z 06.08.2026 te hipoteze OBALIL: `GET .../invoices` oddaje 400
  // takze na zamowieniu, ktore fakture JUZ MA. Zasob jest dla nas niedostepny, wiec
  // `allegro_weryfikacja` NIGDY nie wyjdzie z `WAITING`.
  //
  // Skutek dla paska bylby wiec dokladnie taki, przed jakim ostrzegal komentarz przy tej
  // sprawie: uwaga zapalalaby sie przy KAZDEJ wyslanej fakturze i na zawsze — czyli
  // wylaczalaby pasek jako narzedzie. Decyzja wlasciciela: wyciszyc.
  it('WAITING po dobie NIE zapala już nic na pasku', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { wyslanaAt: przedGodzinami(25) });

    expect(sprawa(db, id)).toBeUndefined();
    db.close();
  });

  it('WAITING po tygodniu też nie zapala nic na pasku', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { wyslanaAt: przedDniami(7) });

    expect(sprawa(db, id)).toBeUndefined();
    db.close();
  });

  // Status, ktorego nie znamy, przychodzi TA SAMA droga (odpowiedz na `PUT`, albo odczyt,
  // ktory nie dziala) — wiec milknie razem z `WAITING`.
  it('status spoza ACCEPTED/REJECTED po dobie też nie zapala nic na pasku', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { weryfikacja: 'PENDING_SOMETHING', wyslanaAt: przedGodzinami(25) });

    expect(sprawa(db, id)).toBeUndefined();
    db.close();
  });

  // ⚠️⚠️ WYCISZENIE NIE OBEJMUJE `REJECTED` — to jest zupelnie inna sprawa i przychodzi
  // INNA DROGA: z odpowiedzi na `PUT .../file`, a nie z zepsutego odczytu. REJECTED znaczy,
  // ze kupujacy faktury NIE MA, i musi zostac BLOKADA (przypadek wyzej).
  it('REJECTED po dobie DALEJ jest blokadą — wyciszenie go nie dotyczy', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { weryfikacja: 'REJECTED', wyslanaAt: przedDniami(7) });

    expect(sprawa(db, id).waga).toBe('blokada');
    db.close();
  });

  it('faktura niewysłana do Allegro nie ma tu żadnej sprawy', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { wyslanaAt: null, invoiceId: null, weryfikacja: null });

    expect(sprawa(db, id)).toBeUndefined();
    db.close();
  });
});

describe('zapiszWeryfikacjeAllegro', () => {
  // ⚠️ PUSTY STATUS NIE PISZE. „Nie wiem" nie ma prawa nadpisac tego, co wiemy.
  it('pusty status NIE nadpisuje zapisanego stanu', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { weryfikacja: 'ACCEPTED' });
    const fakturaId = fakturaZ(db, id).id;

    zapiszWeryfikacjeAllegro(db, fakturaId, null);
    zapiszWeryfikacjeAllegro(db, fakturaId, '');

    expect(fakturaZ(db, id).allegro_weryfikacja).toBe('ACCEPTED');
    db.close();
  });
});

// ⚠️⚠️ JEDNA REGULA W DWOCH POSTACIACH — dokladnie ten sam wzorzec, co przy „fakturze czekajacej
// na KSeF" (domain/ksef-oczekiwanie.js) i z tego samego powodu: zapytanie czuwacza i pasek spraw
// MUSZA rozumiec „weryfikacja nierozstrzygnieta" identycznie. Dwie kopie rozjezdzaja sie przy
// pierwszej zmianie reguly — a rozjazd tutaj znaczy albo setki wywolan bez odbiorcy, albo
// milczenie panelu przy dokumencie, ktorego kupujacy nie dostal.
describe('warunek SQL i predykat domeny odpowiadają IDENTYCZNIE', () => {
  it('na całym zestawie granicznych przypadków', () => {
    const db = openOmsDb(':memory:');
    const przypadki = [
      {},
      { weryfikacja: 'ACCEPTED' },
      { weryfikacja: 'REJECTED' },
      { weryfikacja: null },
      { weryfikacja: 'PENDING_SOMETHING' },
      { weryfikacja: 'accepted' },
      { wyslanaAt: null },
      { invoiceId: null },
      { wyslanaAt: null, invoiceId: null, weryfikacja: null },
    ];
    const idy = przypadki.map((p) => zFaktura(db, p));

    const zeSqla = new Set(db.prepare(`
      SELECT f.zamowienie_id
      FROM faktury f
      JOIN zamowienia z ON z.id = f.zamowienie_id
      WHERE ${WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL}
    `).all().map((w) => w.zamowienie_id));

    const zPredykatu = new Set(idy.filter((id) => weryfikacjaNierozstrzygnieta(fakturaZ(db, id))));

    expect([...zeSqla].sort()).toEqual([...zPredykatu].sort());
    // Zestaw ma zawierac CHOC JEDEN przypadek pozytywny — inaczej dwie puste odpowiedzi
    // bylyby zgodne i test nie dowodzilby niczego.
    expect(zPredykatu.size).toBeGreaterThan(0);
    db.close();
  });

  it('predykat nie rzuca dla braku faktury i śmieci', () => {
    expect(weryfikacjaNierozstrzygnieta(null)).toBe(false);
    expect(weryfikacjaNierozstrzygnieta(undefined)).toBe(false);
    expect(weryfikacjaNierozstrzygnieta({})).toBe(false);
  });
});
