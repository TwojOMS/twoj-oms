import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszNumerKsef } from '../../../src/moduly/faktury/db/faktury.js';
import { createCzuwaczKsef, LIMIT_PRZEBIEGU, PODLOGA_DNI } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';

// Czuwacz KSeF (Plan B, Zadanie 7). Panel do KSeF NIGDY nie wysyla — wlasciciel robi to sam,
// recznie, w ciagu dnia. Ten przebieg WYLACZNIE PYTA inFakt, czy juz wyslal, bo do Allegro ma
// pojsc dokument, ktory numer KSeF juz niesie.
//
// Zakres pytania jest ciasny CELOWO: faktura ze sklepu nie ma dokad pojechac, wiec pytanie o nia
// byloby setkami wywolan miesiecznie bez ani jednego odbiorcy. Testy nizej pilnuja kazdej
// z czterech granic tego zakresu osobno.

let licznik = 0;

// ⚠️ `utworzonaAt` LICZONE OD DZISIAJ, nie wpisane na sztywno. Czuwacz ma PODLOGE po dacie
// wystawienia (30 dni), wiec data wpisana na sztywno zamienilaby kazdy test zakresu w bombe
// zegarowa: przeszedlby dzisiaj, a wywalil sie po miesiacu, bez zadnej zmiany w kodzie.
const DZIEN = 24 * 60 * 60 * 1000;
const przedDniami = (dni) => new Date(Date.now() - dni * DZIEN).toISOString();

function zFaktura(db, {
  sklep = 'allegro_szkicownia', chceFakture = 1, uuid = null, numer = 'FV/12/2026', ksefNumer = null,
  anulowane = 0, utworzonaAt = przedDniami(1),
} = {}) {
  licznik += 1;
  const klucz = uuid ?? `u${licznik}`;
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: `${sklep}-${klucz}`,
    numer: String(1300 + licznik),
    klient: { first_name: 'Jan', last_name: 'Kowalski' },
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: chceFakture,
    nip: null,
    kwota_brutto: '100.00',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane,
    utworzone_at: '2026-08-05T09:00:00',
    pozycje: [],
  }, {});
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, utworzona_at) VALUES (?,?,?,?,?)',
  ).run(id, klucz, numer, ksefNumer, utworzonaAt);
  return id;
}

const fakturaZ = (db, id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
const logZ = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);

// Atrapa liczaca pytania — sluzy WYLACZNIE testom zakresu: tam dowodem jest to, ze do inFaktu
// nie poszlo ANI JEDNO wywolanie, a nie to, co wrocilo.
function liczacaAtrapa(odpowiedz = { numer: null, ksefNumer: null }) {
  const pytania = [];
  return { pytania, pobierzFakture: async (uuid) => { pytania.push(uuid); return odpowiedz; } };
}

describe('czuwacz KSeF — odczyt numeru', () => {
  it('zapisuje numer KSeF, gdy inFakt go już ma', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const czuwacz = createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer: 'KS-1' }) },
    });

    const wynik = await czuwacz.przebieg();

    expect(wynik).toEqual({ sprawdzone: 1, znalezione: 1 });
    const f = fakturaZ(db, id);
    expect(f.ksef_numer).toBe('KS-1');
    expect(f.ksef_sprawdzona_at).not.toBeNull();
    db.close();
  });

  // ⚠️ `ksef_sprawdzona_at` odroznia „nie pytalismy" od „pytalismy, dokumentu tam jeszcze nie ma".
  // Bez niego panel nie ma jak stwierdzic, ze cokolwiek dziala.
  it('brak numeru zapisuje CZAS SPRAWDZENIA, a numeru nie', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    const wynik = await createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer: null }) },
    }).przebieg();

    expect(wynik).toEqual({ sprawdzone: 1, znalezione: 0 });
    const f = fakturaZ(db, id);
    expect(f.ksef_numer).toBeNull();
    expect(f.ksef_sprawdzona_at).not.toBeNull();
    db.close();
  });

  it('znalezienie numeru zostawia ślad w logu zamówienia', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer: 'KS-7' }) },
    }).przebieg();

    const wpisy = logZ(db, id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].akcja).toBe('ksef');
    expect(wpisy[0].wynik).toMatch(/KS-7/);
    db.close();
  });
});

describe('czuwacz KSeF — zakres pytania', () => {
  it('NIE pyta o fakturę, która numer KSeF już ma', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { ksefNumer: 'KS-STARY' });
    const infakt = liczacaAtrapa();

    const wynik = await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    expect(wynik.sprawdzone).toBe(0);
    db.close();
  });

  // ⚠️ ZAKRES: czuwacz istnieje po to, zeby wyslac fakture do ALLEGRO. Pytanie o faktury ze
  // sklepow byloby setkami wywolan miesiecznie bez ani jednego odbiorcy.
  it('nie rusza faktur ze sklepów', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'szkicownia' });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  // ⚠️ PODKRESLNIK W `LIKE` JEST ZNAKIEM WIELOZNACZNYM. Bez `ESCAPE` wzorzec `allegro_%` lapie
  // TAKZE `allegrowy` — czyli „prefiks allegro_" przestaje byc prefiksem, a staje sie wzorcem.
  // Ta sama pulapka, przed ktora ostrzega `czyKanalAllegro` (domain/wysylka.js).
  it('sklep o kluczu „allegrowy" NIE jest kanałem Allegro', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'allegrowy' });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  // ⚠️ `LIKE` w SQLite jest DLA ASCII NIEWRAZLIWE NA WIELKOSC LITER, a `czyKanalAllegro` —
  // wrazliwe. Rozstrzyga PREDYKAT DOMENY (Global Constraints planu: „rozpoznanie kanalu
  // wylacznie predykatem czyKanalAllegro"), a SQL jest wylacznie zawezeniem odczytu.
  it('rozpoznanie kanału rozstrzyga predykat domeny, nie sam SQL', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'ALLEGRO_SZKICOWNIA' });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  it('nie rusza faktur, o które kupujący nie prosił', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { chceFakture: 0 });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  // ⚠️ W5. Zamowienie ANULOWANE po wystawieniu faktury ma juz swoja wlasna blokade na karcie.
  // Numer KSeF nie zmieni tu niczego: do Allegro i tak nie pojedzie faktura zamowienia, ktorego
  // nikt nie kupil — a pytanie o nia zostawaloby w przebiegu co godzine, na zawsze.
  it('nie pyta o zamówienie ANULOWANE', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { anulowane: 1 });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  it('nie pyta o zamówienie anulowane RĘCZNIE', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    db.prepare('UPDATE zamowienia SET anulowane_recznie = 1 WHERE id = ?').run(id);
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  // Rezerwacja bez numeru dokumentu to jeszcze NIE JEST faktura — pytanie o nia to pytanie
  // o dokument, ktory w inFakcie moze w ogole nie powstac (patrz stanFaktury: 'w_toku').
  it('nie pyta o rezerwację bez numeru dokumentu', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { numer: null });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });
});

describe('czuwacz KSeF — odporność', () => {
  // ⚠️ AWARIA JEDNEJ FAKTURY NIE ZATRZYMUJE POZOSTALYCH — ta sama regula, co przy pollerach
  // (bootstrap.js). Jedna faktura skasowana w inFakcie oddaje 404 i bez tej izolacji
  // zatrzymywalaby czuwacza dla wszystkich pozostalych: co godzine, na zawsze, a jedynym
  // sladem bylby `console.error` w kontenerze.
  it('awaria jednej faktury nie zatrzymuje przebiegu', async () => {
    const db = openOmsDb(':memory:');
    const pierwszy = zFaktura(db, { uuid: 'a' });
    const drugi = zFaktura(db, { uuid: 'b' });
    const czuwacz = createCzuwaczKsef({
      db,
      infakt: {
        pobierzFakture: async (uuid) => {
          if (uuid === 'a') throw new Error('inFakt odrzucił odczyt faktury (404): nie znaleziono');
          return { numer: 'FV/13/2026', ksefNumer: 'KS-B' };
        },
      },
    });

    const wynik = await czuwacz.przebieg();

    expect(wynik).toEqual({ sprawdzone: 2, znalezione: 1 });
    expect(fakturaZ(db, drugi).ksef_numer).toBe('KS-B');
    expect(fakturaZ(db, pierwszy).ksef_numer).toBeNull();
    db.close();
  });

  // Blad ma trafic DO KARTY, nie tylko na konsole kontenera — karta jest jedynym miejscem,
  // w ktorym czlowiek szuka historii tego dokumentu.
  // ⚠️⚠️ RECENZJA PARTII 2, W6. `ksef_sprawdzona_at` jest zapisem FAKTU „pytaliśmy",
  // niezależnego od tego, co inFakt odpowiedział. Do tej pory zapis siedział WEWNĄTRZ `try`,
  // więc faktura z wiecznym 404 zostawała z `ksef_sprawdzona_at = NULL` na zawsze — nie do
  // odróżnienia od „nigdy nie pytaliśmy", czyli od zdechłego czuwacza.
  //
  // `ksef_odczyt` niesie DRUGĄ połowę tej wiedzy: czy odpowiedź w ogóle padła. Sprawa na
  // karcie („czeka na KSeF") stoi na niej, a nie na samym czasie — bo niedostępny inFakt
  // nie jest dowodem na to, że właściciel dokumentu nie wysłał.
  it('nieudany odczyt też zapisuje CZAS SPRAWDZENIA — i odnotowuje, że odpowiedzi nie było', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => { throw new Error('inFakt nieosiągalny: ECONNRESET'); } },
    }).przebieg();

    const f = fakturaZ(db, id);
    expect(f.ksef_sprawdzona_at).not.toBeNull();
    expect(f.ksef_odczyt).toBe('blad');
    db.close();
  });

  // ⚠️⚠️ RECENZJA PARTII 2, K4. 404 to NIE JEST „nie wiemy" — to jest wiedza: inFakt tego
  // dokumentu NIE ZNA (ktoś go tam skasował). Do tej pory ta wiedza lądowała wyłącznie w logu,
  // a sprawa na karcie dalej wskazywała wyjście, którego nie ma. Teraz zmienia treść sprawy.
  it('404 z inFaktu odnotowuje, że dokumentu tam NIE MA — inaczej niż zwykła awaria', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await createCzuwaczKsef({
      db,
      infakt: {
        pobierzFakture: async () => {
          throw Object.assign(new Error('inFakt odrzucił odczyt faktury (404): nie znaleziono'), { status: 404 });
        },
      },
    }).przebieg();

    expect(fakturaZ(db, id).ksef_odczyt).toBe('nieznana');
    db.close();
  });

  it('odmowa inna niż 404 (np. 500) zostaje zwykłą awarią — nie wiemy nic', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await createCzuwaczKsef({
      db,
      infakt: {
        pobierzFakture: async () => {
          throw Object.assign(new Error('inFakt odrzucił odczyt faktury (500): bez szczegółów'), { status: 500 });
        },
      },
    }).przebieg();

    expect(fakturaZ(db, id).ksef_odczyt).toBe('blad');
    db.close();
  });

  it('udany odczyt odnotowuje, że inFakt ODPOWIEDZIAŁ', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer: null }) },
    }).przebieg();

    expect(fakturaZ(db, id).ksef_odczyt).toBe('ok');
    db.close();
  });

  // Odpowiedź, która wróciła PO awarii, kasuje ślad awarii — inaczej jedno ECONNRESET
  // wyciszałoby sprawę na karcie na zawsze.
  it('udany odczyt po awarii zdejmuje ślad awarii', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    let padnij = true;
    const czuwacz = createCzuwaczKsef({
      db,
      infakt: {
        pobierzFakture: async () => {
          if (padnij) throw new Error('inFakt nieosiągalny: ECONNRESET');
          return { numer: 'FV/12/2026', ksefNumer: null };
        },
      },
    });

    await czuwacz.przebieg();
    padnij = false;
    await czuwacz.przebieg();

    expect(fakturaZ(db, id).ksef_odczyt).toBe('ok');
    db.close();
  });

  it('awaria ląduje w logu zamówienia, a nie tylko w konsoli', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);

    await createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => { throw new Error('inFakt nieosiągalny: ECONNRESET'); } },
    }).przebieg();

    const wpisy = logZ(db, id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].akcja).toBe('ksef');
    expect(wpisy[0].wynik).toMatch(/ECONNRESET/);
    db.close();
  });

  // ⚠️ Faktura skasowana w inFakcie oddaje 404, a jej wiersz ZOSTAJE w zapytaniu na zawsze
  // (numer KSeF nigdy sie nie pojawi). Bez dlawienia karta dostaje 24 identyczne wpisy na dobe
  // i prawdziwa historia dokumentu tonie w nich w tydzien.
  it('ten sam błąd co godzinę nie zasypuje logu karty', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    const czuwacz = createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => { throw new Error('inFakt odrzucił odczyt faktury (404): nie znaleziono'); } },
    });

    await czuwacz.przebieg();
    await czuwacz.przebieg();
    await czuwacz.przebieg();

    expect(logZ(db, id)).toHaveLength(1);
    db.close();
  });

  it('NOWY błąd dopisuje się mimo dławienia', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db);
    let komunikat = 'inFakt nieosiągalny: ECONNRESET';
    const czuwacz = createCzuwaczKsef({
      db,
      infakt: { pobierzFakture: async () => { throw new Error(komunikat); } },
    });

    await czuwacz.przebieg();
    komunikat = 'inFakt odrzucił odczyt faktury (404): nie znaleziono';
    await czuwacz.przebieg();

    expect(logZ(db, id)).toHaveLength(2);
    db.close();
  });

  it('pusta lista to poprawny przebieg (typowa noc), a nie awaria', async () => {
    const db = openOmsDb(':memory:');
    const infakt = liczacaAtrapa();

    await expect(createCzuwaczKsef({ db, infakt }).przebieg())
      .resolves.toEqual({ sprawdzone: 0, znalezione: 0 });
    expect(infakt.pytania).toEqual([]);
    db.close();
  });
});

// ⚠️⚠️ RECENZJA PARTII 2, W1: ZAPYTANIE CZUWACZA ROSLO LINIOWO I NIGDY NIE MALALO.
// Wiersz, ktory numeru KSeF NIGDY nie dostanie (pomylka, korekta, urlop, dokument skasowany
// w inFakcie), zostawal w zapytaniu NA ZAWSZE: 24 wywolania na dobe, 8760 rocznie, per wiersz.
// Recenzent policzyl: przy dwoch takich wierszach miesiecznie po roku ~576 bezuzytecznych
// wywolan na dobe, po trzech latach ~1730.
describe('czuwacz KSeF — przebieg jest OGRANICZONY', () => {
  it('nie pyta o fakturę starszą niż podłoga — po tym czasie rozstrzyga człowiek', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { utworzonaAt: przedDniami(PODLOGA_DNI + 1) });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toEqual([]);
    db.close();
  });

  it('fakturę sprzed dnia mniej niż podłoga dalej sprawdza', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { utworzonaAt: przedDniami(PODLOGA_DNI - 1) });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toHaveLength(1);
    db.close();
  });

  // Przebieg jest SEKWENCYJNY, a limit zadania inFaktu to 60 s — bez `LIMIT` jeden przebieg
  // przy dluzszej awarii przekraczalby godzine i wchodzil na nastepny.
  it('jeden przebieg bierze najwyżej LIMIT_PRZEBIEGU faktur', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i <= LIMIT_PRZEBIEGU; i += 1) zFaktura(db);
    const infakt = liczacaAtrapa();

    const wynik = await createCzuwaczKsef({ db, infakt }).przebieg();

    expect(infakt.pytania).toHaveLength(LIMIT_PRZEBIEGU);
    expect(wynik.sprawdzone).toBe(LIMIT_PRZEBIEGU);
    db.close();
  });

  // Reszta nie przepada: nastepny przebieg (za godzine) bierze ja normalnie. Porzadek jest
  // od NAJSTARSZEJ, bo to o nie upomina sie pasek spraw na karcie.
  it('reszta czeka na następny przebieg, od najstarszej', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { uuid: 'stara', utworzonaAt: przedDniami(5) });
    zFaktura(db, { uuid: 'nowa', utworzonaAt: przedDniami(1) });
    const infakt = liczacaAtrapa();

    await createCzuwaczKsef({ db, infakt, limit: 1 }).przebieg();

    expect(infakt.pytania).toEqual(['stara']);
    db.close();
  });
});

// ⚠️⚠️ RECENZJA PARTII 2, W2. Czuwacz przejal z pollera izolacje bledu, ale NIE strażnika
// „jeden przebieg naraz" (poller.js: `let wTrakcie`). Limit zadania inFaktu to 60 s, a petla
// jest sekwencyjna — przy dluzszej awarii przebieg przekracza godzine, `setInterval` odpala
// nastepny i przebiegi PIETRZA SIE: po dobie 24 rownolegle petle. `.catch` w src/oms.js tego
// nie zatrzyma, bo przebieg wcale nie odrzuca.
describe('czuwacz KSeF — jeden przebieg naraz', () => {
  it('drugi przebieg nie wchodzi na trwający', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { uuid: 'a' });
    zFaktura(db, { uuid: 'b' });
    let zwolnij;
    const brama = new Promise((r) => { zwolnij = r; });
    const pytania = [];
    const czuwacz = createCzuwaczKsef({
      db,
      infakt: {
        pobierzFakture: async (uuid) => {
          pytania.push(uuid);
          await brama;
          return { numer: 'FV/12/2026', ksefNumer: null };
        },
      },
    });

    const pierwszy = czuwacz.przebieg();
    const drugi = await czuwacz.przebieg();

    expect(drugi.pominiety).toBe(true);
    expect(drugi.sprawdzone).toBe(0);
    // Drugi przebieg NIE dolozyl ani jednego pytania do inFaktu.
    expect(pytania).toEqual(['a']);
    zwolnij();
    await pierwszy;
    db.close();
  });

  // ⚠️ BLOKADA ZWALNIANA W `finally`. Zostawiona po bledzie wyciszylaby czuwacza NA ZAWSZE —
  // ta sama pulapka jest opisana przy pollerze.
  it('blokada zwalnia się po awarii przebiegu', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { uuid: 'a' });
    let padnij = true;
    const kruchaBaza = {
      prepare: (sql) => {
        if (padnij) { padnij = false; throw new Error('baza padła'); }
        return db.prepare(sql);
      },
    };
    const czuwacz = createCzuwaczKsef({
      db: kruchaBaza,
      infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer: 'KS-1' }) },
    });

    await expect(czuwacz.przebieg()).rejects.toThrow(/baza padła/);
    const drugi = await czuwacz.przebieg();

    expect(drugi).toEqual({ sprawdzone: 1, znalezione: 1 });
    db.close();
  });
});

describe('zapiszNumerKsef', () => {
  // COALESCE, a nie zwykle przypisanie: przebieg, ktory numeru nie dostal, nie ma prawa
  // SKASOWAC numeru zapisanego wczesniej. Numer KSeF jest dowodem, ze dokument juz tam jest —
  // a to jest warunek wyslania faktury do Allegro (Zadanie 9).
  it('brak numeru NIE kasuje numeru zapisanego wcześniej', () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { ksefNumer: 'KS-1' });
    const fakturaId = fakturaZ(db, id).id;

    zapiszNumerKsef(db, fakturaId, { ksefNumer: null, sprawdzonaAt: '2026-08-06T11:00:00Z' });

    const f = fakturaZ(db, id);
    expect(f.ksef_numer).toBe('KS-1');
    expect(f.ksef_sprawdzona_at).toBe('2026-08-06T11:00:00Z');
    db.close();
  });
});

// ——— PARTIA 4: AUTOMAT WYSYŁKI FAKTURY DO ALLEGRO (2026-08-07) ——————————————————————
//
// Prośba właściciela po pierwszej ręcznej wysyłce: „trzeba to rzeczywiście wrzucić na automat".
// Do tej pory czuwacz TYLKO zapisywał numer KSeF, a PDF do kupującego szedł przyciskiem.
//
// ⚠️⚠️ TO JEST NAJBARDZIEJ NIEODWRACALNA OPERACJA W CAŁYM PANELU wykonywana BEZ CZŁOWIEKA:
// dokument ląduje na koncie kupującego i panel nie ma czym go stamtąd zabrać. Dlatego automat
// NIE MA własnej bramki — pyta DOKŁADNIE tę samą funkcję, co przycisk (`wolnoWyslacDoAllegro`),
// i idzie DOKŁADNIE tą samą usługą. Druga, luźniejsza reguła po stronie czuwacza byłaby
// dziurą, której nikt by nie zobaczył, bo przycisk dalej zachowywałby się poprawnie.
describe('automat: faktura do Allegro po pojawieniu się numeru KSeF', () => {
  const atrapaWysylki = (nad = {}) => {
    const wolania = [];
    return {
      wolania,
      usluga: {
        wyslij: async (id, opcje) => {
          wolania.push({ id, opcje });
          if (nad.rzuca) throw nad.rzuca;
          return { invoiceId: 'inv-1', weryfikacja: 'WAITING' };
        },
      },
    };
  };

  const czuwaczZ = (db, { fakturaAllegro, ksefNumer = 'KS-1' }) => createCzuwaczKsef({
    db,
    infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer }) },
    fakturaAllegro,
  });

  it('numer KSeF się pojawił → panel sam wysyła fakturę do Allegro', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    const { wolania, usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(wolania).toHaveLength(1);
    expect(wolania[0].id).toBe(id);
  });

  // ⚠️ FURTKA „BEZ NUMERU KSeF" ZOSTAJE WYŁĄCZNIE RĘCZNA. Automat wysyłający dokument bez
  // numeru KSeF odbierałby właścicielowi decyzję, której nie da się cofnąć.
  it('automat NIGDY nie używa furtki „bez numeru KSeF”', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    const { wolania, usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(wolania[0].opcje?.bezKsef).toBeFalsy();
  });

  it('bez numeru KSeF nie wysyła nic — nie ma czego dosyłać', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    const { wolania, usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga, ksefNumer: null }).przebieg();
    expect(wolania).toEqual([]);
  });

  // Faktura sklepowa też przechodzi przez czuwacza (zakres poszerzono 06.08) — i NIE MA
  // dokąd jej wysyłać. Bramka to rozstrzyga, ale sprawdzamy na poziomie czuwacza.
  it('faktura ZE SKLEPU nie jedzie do Allegro', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'szkicownia', chceFakture: 1 });
    const { wolania, usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(wolania).toEqual([]);
  });

  // ⚠️ Decyzja właściciela z Planu B: faktura idzie TYLKO na żądanie kupującego
  // (`invoice.required`). Dokument wysłany komuś, kto o niego nie prosił, jest tak samo
  // nieodwracalny jak każdy inny.
  it('kupujący nie prosił o fakturę → automat milczy', async () => {
    const db = openOmsDb(':memory:');
    zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 0 });
    const { wolania, usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(wolania).toEqual([]);
  });

  // ⚠️ AWARIA WYSYŁKI NIE MA PRAWA ZATRZYMAĆ CZUWACZA — ani dla tej faktury, ani dla
  // pozostałych. Numer KSeF jest już zapisany i to jest fakt niezależny od losu pliku.
  // ⚠️ AWARIA MUSI ZOSTAC ZLAPANA TU, A NIE WPASC DO ZEWNETRZNEGO `catch` PETLI. Tamten
  // opisuje NIEUDANY ODCZYT z inFaktu — zapisalby `ksef_odczyt: 'blad'` i wpis „BŁĄD odczytu",
  // czyli PRZECIWIENSTWO prawdy: numer KSeF odczytalismy poprawnie, nie udala sie dopiero
  // wysylka pliku. Pierwsza wersja tego testu szukala samej TRESCI bledu i przechodzila
  // w obu wariantach — czyli nie sprawdzala niczego.
  it('awaria wysyłki nie kładzie przebiegu i NIE udaje nieudanego odczytu KSeF', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    const { usluga } = atrapaWysylki({ rzuca: new Error('Allegro nie odpowiedziało') });
    const wynik = await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(wynik.znalezione).toBe(1);
    expect(fakturaZ(db, id).ksef_numer).toBe('KS-1');
    // Odczyt z inFaktu SIE UDAL — kolumna nie ma prawa mowic inaczej.
    expect(fakturaZ(db, id).ksef_odczyt).not.toBe('blad');
    const wpisy = logZ(db, id);
    expect(wpisy.some((w) => w.akcja === 'faktura-allegro' && /AUTOMAT.*Allegro nie odpowiedziało/s.test(w.wynik))).toBe(true);
    expect(wpisy.some((w) => /BŁĄD odczytu/.test(w.wynik))).toBe(false);
  });

  // Log ma rozdzielać decyzję człowieka od działania automatu — po miesiącu trzeba umieć
  // odpowiedzieć, kto wysłał dokument kupującemu.
  it('wysyłka automatem zostawia ślad mówiący, że to AUTOMAT', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    const { usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(logZ(db, id).some((w) => /AUTOMAT/i.test(w.wynik))).toBe(true);
  });

  // ⚠️ DOKUMENT WYSLANY WCZESNIEJ FURTKA „bez numeru KSeF" NIE MA POJECHAC DRUGI RAZ.
  //
  // ⚠️ TEN TEST PILNUJE ZAKRESU ZAPYTANIA, A NIE BRAMKI W AUTOMACIE — i warto wiedziec, ze
  // to zapytanie jest tu jedyna dzialajaca ochrona: `WSPOLNE_SQL` (domain/ksef-oczekiwanie.js)
  // niesie `f.allegro_wyslana_at IS NULL`, wiec taki wiersz w ogole nie wchodzi do petli.
  // Zmierzone mutacja: usuniecie bramki `wolnoWyslacDoAllegro` z automatu NIE psuje ani
  // jednego testu — bo kazdy przypadek, ktorego ona broni (faktura sklepowa, brak zadania
  // faktury, dokument juz wyslany), jest juz odsiany w SQL-u. Bramka ZOSTAJE jako druga
  // siatka: gdyby zakres zapytania kiedys sie poszerzyl, to ona zatrzyma dokument.
  it('dokument wysłany wcześniej BEZ numeru KSeF nie jedzie do kupującego drugi raz', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    db.prepare("UPDATE faktury SET allegro_wyslana_at = '2026-08-06T20:00:00', allegro_invoice_id = 'inv-9' WHERE zamowienie_id = ?")
      .run(id);
    const { wolania, usluga } = atrapaWysylki();
    await czuwaczZ(db, { fakturaAllegro: usluga }).przebieg();
    expect(wolania).toEqual([]);
  });

  // Panel bez podpiętego kanału Allegro (albo bez inFaktu) ma działać jak dotąd.
  it('bez podpiętej usługi wysyłki czuwacz działa jak dotąd', async () => {
    const db = openOmsDb(':memory:');
    const id = zFaktura(db, { sklep: 'allegro_szkicownia', chceFakture: 1 });
    const wynik = await createCzuwaczKsef({
      db, infakt: { pobierzFakture: async () => ({ numer: 'FV/12/2026', ksefNumer: 'KS-1' }) },
    }).przebieg();
    expect(wynik.znalezione).toBe(1);
    expect(fakturaZ(db, id).ksef_numer).toBe('KS-1');
  });
});
