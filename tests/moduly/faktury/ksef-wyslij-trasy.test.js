// tests/oms/ksef-wyslij-trasy.test.js
//
// ⚠️⚠️ TO JEST JEDYNA NIEODWRACALNA OPERACJA W CALYM MODULE FAKTUR. Dokumentu wyslanego do
// KSeF nie da sie skasowac — zostaje wylacznie korekta, widoczna u organu. Do tego dnia
// wlasciciel wysylal recznie w inFakcie WLASNIE PO TO, zeby pomylke dalo sie jeszcze
// skasowac. Kazdy test nizej pilnuje jednej z dwoch rzeczy: albo tego, ze panel nie wysle
// niczego, czego czlowiek swiadomie nie zatwierdzil, albo tego, ze po wysylce czlowiek
// ZAWSZE ma jak sie dowiedziec, co sie stalo.
//
// Dwie warstwy, dwa `describe`: usluga (co naprawde leci do inFaktu i co zostaje w logu)
// oraz trasa z ekranem wyniku (co widzi czlowiek).
import { describe, it, expect } from 'vitest';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { createInfaktClient } from '../../../src/oms/infakt/client.js';

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}`, origin: 'http://localhost' };

// ⚠️ `pobierzLog` z brudnopisu zadania NIE ISTNIEJE w `db/zamowienia.js` (sa tam `dopiszLog`
// i `ostatniWpisLogu`). Log czytamy wprost z bazy, tak samo jak kazdy inny test w tym repo.
const logZ = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
const wpisyKsef = (db, id) => logZ(db, id).filter((w) => w.akcja === 'ksef').map((w) => w.wynik);

let licznik = 0;

// Zamowienie z wystawiona faktura — bez niego nie ma gdzie zapisac sladu wysylki.
function zamowienieZFaktura(db, { uuid = 'u1', numer = '1/08/2026' } = {}) {
  licznik += 1;
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${licznik}`,
    numer: String(3000 + licznik),
    klient: { first_name: 'Jan', last_name: 'Kowalski' },
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 1,
    nip: null,
    kwota_brutto: '123.00',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    pozycje: [],
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid, numer, ksefStatus: null });
  return id;
}

// Dokument w ksztalcie, w jakim oddaje go `services/faktury-widok.js`.
//
// ⚠️ `client_tax_code` JEST CZESCIA KSZTALTU: od 28.08.2026 dokument bez NIP-u nabywcy jest
// konsumencki i bariera (domain/wysylka-ksef.js) go nie przepuszcza. Fikstura bez tego pola
// odbijalaby sie od reguly przy KAZDYM tescie wysylki w tym pliku.
const dokument = (nadpisz = {}) => ({
  uuid: 'u1', number: '1/08/2026', rodzaj: 'vat', ksef_number: null, kwotaZl: '123.00',
  client_company_name: 'Firma X', client_tax_code: '1234563218',
  invoice_date: '2026-08-06', zamowienie: null, ...nadpisz,
});

// ⚠️⚠️ ODMOWA SPRZED WYWOLANIA MUSI BYC JEDNOZNACZNA. `wyslijDokumentDoKsef` odmawia pustej/bialej
// listy PRZED jakimkolwiek zadaniem HTTP — do inFaktu prowizorycznie NIC nie poszlo, wiec to
// jest odmowa NAJBARDZIEJ jednoznaczna z mozliwych. Reguła zwolnienia rezerwacji
// (`jednoznacznaOdmowa` w services/wysylka-ksef.js) rozpoznaje jednoznacznosc WYLACZNIE po
// statusie 4xx — bez tagu ta odmowa wygladalaby jak zerwane polaczenie i trzymalaby
// rezerwacje NA ZAWSZE za wywolanie, ktore nigdy nie opuscilo panelu.
describe('odmowa pustego identyfikatora w wyslijDokumentDoKsef jest oznaczona jako JEDNOZNACZNA', () => {
  it('rzuca błąd ze statusem 4xx, mimo że żadne żądanie HTTP nie poszło', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: async () => { throw new Error('nie wolno wołać sieci'); } });

    // ⚠️ Argumentem jest teraz JEDEN identyfikator, nie lista (07.08.2026) — sam `null`
    // i same spacje muszą odbić się TAK SAMO, bo wklejone do ścieżki dałyby adres, który
    // niczego nie znaczy, i zapytanie o cudzy (albo żaden) dokument.
    for (const uuid of [undefined, null, '', '   ', '\n']) {
      let zlapany = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        await c.wyslijDokumentDoKsef(uuid);
      } catch (e) {
        zlapany = e;
      }
      expect(zlapany).not.toBeNull();
      expect(zlapany.status).toBeGreaterThanOrEqual(400);
      expect(zlapany.status).toBeLessThan(500);
    }
  });
});

describe('usługa wysyłki do KSeF — wyslij()', () => {
  it('wysyła zaznaczone i zostawia ślad w logu właściwego zamówienia', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const obcyId = zamowienieZFaktura(db, { uuid: 'u9', numer: '9/08/2026' });
    const wyslane = [];
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return {}; } },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });

    const w = await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(wyslane).toEqual(['u1']);
    expect(w.wyslane).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    expect(w.blad).toBeNull();
    // Slad niesie NUMER DOKUMENTU — po nim czlowiek odnajduje fakture w inFakcie.
    expect(wpisyKsef(db, id).join('\n')).toMatch(/1\/08\/2026/);
    // ⚠️ Log NA WLASCIWYM zamowieniu, a nie „gdziekolwiek w bazie": drugie zamowienie
    // z wlasna faktura nie moze dostac ani jednego wpisu z tej wysylki.
    expect(wpisyKsef(db, obcyId)).toEqual([]);
  });

  // ⚠️⚠️ SLAD POWSTAJE PRZED WYWOLANIEM, NIE PO NIM. Timeout na tym zasobie znaczy
  // „nie wiadomo", a nie „nie poszlo" (docblock `wyslijDokumentDoKsef` w infakt/client.js) —
  // dokumenty moga juz byc NIEODWRACALNIE w KSeF. Gdyby wpis powstawal dopiero po
  // udanej odpowiedzi, karta zamowienia nie niosłaby ANI SLADU, ze cokolwiek probowano.
  it('zapisuje ślad w logu ZANIM zawoła inFakt', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let logWTrakcieWywolania = null;
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => {
          logWTrakcieWywolania = wpisyKsef(db, id);
          return { przyjete: 1 };
        },
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });

    await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(logWTrakcieWywolania).toHaveLength(1);
    expect(logWTrakcieWywolania[0]).toMatch(/1\/08\/2026/);
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEGO ZADANIA. Miedzy ekranem podgladu a zatwierdzeniem wlasciciel
  // mogl wyslac dokument recznie w inFakcie z drugiej karty. Zbior PRZEPISANY z podgladu
  // zglosilby go do organu drugi raz.
  it('przelicza zbiór PONOWNIE — dokument, który w międzyczasie trafił do KSeF, NIE leci', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let wolane = false;
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { wolane = true; return {}; } },
      fakturyWidok: {
        dokumenty: async () => [dokument({ ksef_number: 'JUZ-W-KSEF', zamowienie: { id, numer: '3001' } })],
      },
    });

    const w = await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(wolane).toBe(false);
    expect(w.wyslane).toEqual([]);
    expect(w.pominiete[0].powod).toMatch(/jest już w KSeF/i);
    // Nic nie poszlo, wiec w logu nie ma prawa stanac zdanie o wysylce.
    expect(wpisyKsef(db, id)).toEqual([]);
  });

  it('do inFaktu jadą WYŁĄCZNIE dopuszczone uuidy — korekta i obcy identyfikator zostają', async () => {
    const db = openOmsDb(':memory:');
    const wyslane = [];
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return {}; } },
      fakturyWidok: {
        dokumenty: async () => [
          dokument(),
          dokument({ uuid: 'k1', number: 'KOR/1/08/2026', rodzaj: 'korekta' }),
        ],
      },
    });

    const w = await u.wyslij({ uuids: ['u1', 'k1', 'obcy'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(wyslane).toEqual(['u1']);
    expect(w.pominiete.map((p) => p.numer)).toEqual(['KOR/1/08/2026', '(id obcy)']);
  });

  it('pusty zbiór nie woła inFaktu ani razu', async () => {
    const db = openOmsDb(':memory:');
    let wolane = false;
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { wolane = true; return {}; } },
      fakturyWidok: { dokumenty: async () => [dokument()] },
    });

    const w = await u.wyslij({ uuids: [], miesiac: '2026-08', pole: 'invoice_date' });

    expect(wolane).toBe(false);
    expect(w.wyslane).toEqual([]);
  });

  // ⚠️⚠️ AWARIA WYWOLANIA NIE ZNACZY „NIE POSZLO". Usluga NIE RZUCA, bo ekran wyniku musi
  // pokazac i pominiete, i te dokumenty, o ktorych NIE WIADOMO. Ponowienia nie ma i byc
  // nie moze: ponowione zgloszenie po niejednoznacznym timeoucie to duplikat u organu.
  it('gdy inFakt rzuci — oddaje pominięte, oznacza dokumenty jako niepewne i dopisuje to do logu', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let prob = 0;
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => {
          prob += 1;
          throw bladOperatora('inFakt nie odpowiedział w wyznaczonym czasie.');
        },
      },
      fakturyWidok: {
        dokumenty: async () => [
          dokument({ zamowienie: { id, numer: '3001' } }),
          dokument({ uuid: 'k1', number: 'KOR/1/08/2026', rodzaj: 'korekta' }),
        ],
      },
    });

    const w = await u.wyslij({ uuids: ['u1', 'k1'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(prob).toBe(1); // ⚠️ ANI JEDNEGO PONOWIENIA.
    expect(w.wyslane).toEqual([]);
    expect(w.niepewne).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    expect(w.pominiete.map((p) => p.numer)).toEqual(['KOR/1/08/2026']);
    expect(w.blad).toMatch(/inFakt nie odpowiedział/);
    const slad = wpisyKsef(db, id);
    expect(slad).toHaveLength(2);
    expect(slad[1]).toMatch(/nie wiadomo/i);
    // ⚠️ NASTEPNY KROK DLA CZLOWIEKA, a nie sama nazwa systemu. Poprzednie `/inFak/i`
    // przechodzilo na WKLEJONEJ tresci bledu („inFakt nie odpowiedzial…") i nie sprawdzalo
    // NICZEGO z tego, co ten wpis ma naprawde niesc.
    expect(slad[1]).toMatch(/Sprawdź w inFakcie/);
    expect(slad[1]).toMatch(/panel sam NIE ponawia/);
  });

  // Faktura wystawiona poza panelem nie ma zamowienia — brak miejsca na log NIE MOZE
  // wywalic wysylki, ktora u organu juz sie zdarzyla.
  it('dokument bez zamówienia wysyła się bez wpisu w logu i bez wyjątku', async () => {
    const db = openOmsDb(':memory:');
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => ({}) },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: null })] },
    });

    const w = await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(w.wyslane).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM log WHERE akcja = 'ksef'").get().n).toBe(0);
  });

  // ⚠️ `przyjete` to LICZBA PANELU, nie potwierdzenie organu: klient liczy uuidy, ktore sam
  // wlozyl do ciala zadania po przycieciu i odsianiu duplikatow. Usluga oddaje ja WIERNIE,
  // zeby ekran mogl ja zestawic z tym, co panel zglosil.
  // ⚠️⚠️ CZĘŚCIOWY SUKCES JEST PRZYPADKIEM NORMALNYM (od 07.08.2026). Każdy dokument idzie
  // OSOBNYM żądaniem — zasobu wsadowego w inFakcie nie ma — więc jedna odmowa nie mówi nic
  // o pozostałych. Do tego dnia panel zakładał „wszystko albo nic" i na pierwszym 4xx
  // zwalniał rezerwacje CAŁEJ partii; przy wysyłce per dokument byłoby to zwolnienie
  // dokumentów, które WŁAŚNIE POSZŁY do organu, czyli otwarcie drogi do duplikatu.
  it('jedna odmowa nie zatrzymuje pozostałych — reszta idzie, a licznik mówi prawdę', async () => {
    const db = openOmsDb(':memory:');
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async (uuid) => {
          if (uuid === 'u2') throw bladOperatora('inFakt odrzucił ten dokument.', { status: 422 });
          return {};
        },
      },
      fakturyWidok: {
        dokumenty: async () => [
          dokument(),
          dokument({ uuid: 'u2', number: '2/08/2026' }),
          dokument({ uuid: 'u3', number: '3/08/2026' }),
        ],
      },
    });

    const w = await u.wyslij({ uuids: ['u1', 'u2', 'u3'], miesiac: '2026-08', pole: 'invoice_date' });

    // Odmowa na środku NIE przerywa pętli — trzeci dokument ma pojechać.
    expect(w.wyslane.map((d) => d.uuid)).toEqual(['u1', 'u3']);
    expect(w.przyjete).toBe(2);
    expect(w.pominiete.map((x) => x.numer)).toContain('2/08/2026');
    expect(w.niepewne).toEqual([]);
  });

  // ⚠️⚠️ ZWALNIAMY REZERWACJĘ WYŁĄCZNIE ODRZUCONEGO. Zwolnienie całej partii otwierałoby
  // ponowną wysyłkę dokumentów, które u organu JUŻ SĄ — a duplikatu nie da się skasować.
  it('odmowa zwalnia rezerwację TYLKO odrzuconego dokumentu, nie całej partii', async () => {
    const db = openOmsDb(':memory:');
    const wolania = [];
    // ⚠️ Licznik odmow STOI OSOBNO od listy wywolan — pierwsza wersja tego testu liczyla je
    // z `wolania`, ktore miedzy zatwierdzeniami jest czyszczone, wiec drugie podejscie
    // dostawalo odmowe po raz drugi i test „udowadnial" cos, czego nie sprawdzal.
    let odmowy = 0;
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async (uuid) => {
          wolania.push(uuid);
          if (uuid === 'u2' && odmowy === 0) {
            odmowy += 1;
            throw bladOperatora('inFakt odrzucił ten dokument.', { status: 422 });
          }
          return {};
        },
      },
      fakturyWidok: {
        dokumenty: async () => [dokument(), dokument({ uuid: 'u2', number: '2/08/2026' })],
      },
    });

    await u.wyslij({ uuids: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' });
    wolania.length = 0;
    // Drugie zatwierdzenie: `u1` POSZEDŁ i ma zostać odbity rezerwacją, `u2` był odrzucony
    // i wolno go zgłosić ponownie po poprawieniu danych.
    const druga = await u.wyslij({ uuids: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(wolania).toEqual(['u2']);
    expect(druga.wyslane.map((d) => d.uuid)).toEqual(['u2']);
    expect(druga.pominiete.map((x) => x.numer)).toContain('1/08/2026');
  });

  // Niejednoznaczna awaria (timeout, 5xx) NIE zwalnia rezerwacji — dokument mógł już być
  // u organu. Sprawdzane per dokument, żeby jeden timeout nie zamykał sprawnych sąsiadów.
  it('timeout na jednym dokumencie nie rusza rezerwacji pozostałych', async () => {
    const db = openOmsDb(':memory:');
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async (uuid) => {
          if (uuid === 'u1') throw bladOperatora('inFakt nie odpowiedział w wyznaczonym czasie.');
          return {};
        },
      },
      fakturyWidok: {
        dokumenty: async () => [dokument(), dokument({ uuid: 'u2', number: '2/08/2026' })],
      },
    });

    const w = await u.wyslij({ uuids: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' });

    expect(w.niepewne.map((d) => d.uuid)).toEqual(['u1']);
    expect(w.wyslane.map((d) => d.uuid)).toEqual(['u2']);
    expect(w.przyjete).toBe(1);
    // Pierwszy komunikat trafia na ekran; pełna lista i tak stoi w „nie wiadomo".
    expect(w.blad).toMatch(/nie odpowiedział/i);
  });

  // ⚠️⚠️ FINDING A1 (recenzja całości). Wysyłka jest nieodwracalna, więc kształtu odpowiedzi
  // `send.json` NIE DA SIĘ zaobserwować inaczej niż prawdziwym zgłoszeniem. Jeśli pierwsza
  // nadzorowana wysyłka nie zostawi jej w logu, jedyną drogą, żeby ją jeszcze raz zobaczyć,
  // jest wysłanie KOLEJNEGO prawdziwego dokumentu do organu — a to jest cena, której nie da
  // się cofnąć. Ten test pilnuje, żeby treść odpowiedzi naprawdę lądowała w logu zamówienia.
  it('surowa odpowiedź inFaktu trafia do logu zamówienia po udanej wysyłce', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => (
          { przyjete: 1, odpowiedzInfaktu: { request_id: 'ZNACZNIK-TESTOWY-123' } }
        ),
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });

    await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    const slad = wpisyKsef(db, id);
    expect(slad.some((w) => w.includes('ZNACZNIK-TESTOWY-123'))).toBe(true);
  });

  // ⚠️ AWARIA ZAPISU TEGO ŚLADU NIE MA PRAWA ZAMIENIĆ UDANEJ WYSYŁKI W BŁĄD — dokument POSZEDŁ
  // do organu, a to, że panel nie zdążył tego zanotować, jest osobną, mniejszą awarią.
  it('gdy zapis surowej odpowiedzi po sukcesie padnie, wysyłka i tak liczy się jako udana', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => {
          // Log znika DOKŁADNIE po odpowiedzi inFaktu, zanim panel zdąży dopisać ślad o niej.
          db.exec('DROP TABLE log');
          return { przyjete: 1, odpowiedzInfaktu: { ok: true } };
        },
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });

    const w = await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    expect(w.wyslane).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    expect(w.blad).toBeNull();
  });

  // ⚠️ Faktura bez zamówienia i bez okresu NIE MA GDZIE zapisać śladu w bazie — ale odpowiedź
  // nieodwracalnej wysyłki nie ma prawa przepaść bez śladu: ma trafić chociaż do loggera
  // zapytania, żeby wylądować w wyjściu kontenera.
  it('dokument bez zamówienia i bez okresu — po sukcesie ślad trafia do przekazanego loggera', async () => {
    const db = openOmsDb(':memory:');
    const wpisy = [];
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => ({ odpowiedzInfaktu: { marker: 'BEZ-ZAMOWIENIA-456' } }),
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: null })] },
      log: (...args) => wpisy.push(args.join(' ')),
    });

    await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    expect(wpisy.some((w) => w.includes('BEZ-ZAMOWIENIA-456'))).toBe(true);
    // Log w bazie zostaje pusty — dokładnie jak dotąd (brak zamówienia = brak miejsca w bazie).
    expect(db.prepare("SELECT COUNT(*) AS n FROM log WHERE akcja = 'ksef'").get().n).toBe(0);
  });
});

// ——— rezerwacja PRZED wywolaniem ————————————————————————————————————————
//
// ⚠️⚠️ NAJWAZNIEJSZA GRUPA W TYM PLIKU. `ksef_number` na swiezo pobranej liscie NIE JEST
// zabezpieczeniem przed drugim zatwierdzeniem: inFakt nadaje ten numer dopiero po ~70 s
// (docblock `wyslijDokumentDoKsef`), wiec przeliczenie zbioru jest SLEPE na wysylke, ktora panel
// wlasnie zlecil. Przycisk jest zwyklym formularzem, panel nie ma JavaScriptu i CELOWO nie
// przekierowuje — dwuklik, back+resubmit i dwie karty podgladu to normalne drogi do drugiej,
// NIEODWRACALNEJ wysylki. Barierą jest tabela `wysylki_ksef` (przewodnik 4.2).
const wysylkiKsef = (db) => db.prepare('SELECT * FROM wysylki_ksef ORDER BY uuid').all();

describe('rezerwacja wysyłki do KSeF', () => {
  it('drugie zatwierdzenie tego samego zaznaczenia NIE woła inFaktu po raz drugi', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let wolan = 0;
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { wolan += 1; return {}; } },
      // ⚠️ `ksef_number` zostaje NULL-em takze przy DRUGIM przeliczeniu — dokladnie tak
      // wyglada prawdziwa lista przez pierwsze ~70 sekund po przyjeciu zlecenia.
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });
    const arg = { uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' };

    const pierwsza = await u.wyslij(arg, 'adam');
    const druga = await u.wyslij(arg, 'adam');

    expect(wolan).toBe(1);
    expect(pierwsza.wyslane).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    expect(druga.wyslane).toEqual([]);
    // Odbity dokument ma wrocic jako POMINIETY, z powodem mowiacym, gdzie sprawdzic.
    expect(druga.pominiete).toHaveLength(1);
    expect(druga.pominiete[0].numer).toBe('1/08/2026');
    expect(druga.pominiete[0].powod).toMatch(/panel już zlecił/i);
    expect(druga.pominiete[0].powod).toMatch(/inFakcie/);
    expect(wysylkiKsef(db)).toHaveLength(1);
  });

  // ⚠️⚠️ REZERWACJA JEST TRWALA, NIE DZIERZAWA. Zerwane polaczenie NIE JEST dowodem, ze
  // zlecenie nie doszlo — dokumenty moga juz byc NIEODWRACALNIE w KSeF. Zwolnienie wpisu
  // po bledzie otwieraloby droge do duplikatu u organu, wiec wpis ZOSTAJE.
  it('rezerwacja po nieudanym wywołaniu NIE jest zwalniana', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let wolan = 0;
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => {
          wolan += 1;
          throw bladOperatora('inFakt nie odpowiedział w wyznaczonym czasie.');
        },
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });
    const arg = { uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' };

    const w = await u.wyslij(arg, 'adam');
    expect(w.niepewne).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    // Wiersz rezerwacji ZOSTAJE — to on odbije nastepne klikniecie.
    expect(wysylkiKsef(db).map((r) => r.uuid)).toEqual(['u1']);

    const druga = await u.wyslij(arg, 'adam');
    expect(wolan).toBe(1);
    expect(druga.wyslane).toEqual([]);
    expect(druga.pominiete[0].powod).toMatch(/panel już zlecił/i);
  });

  // ⚠️⚠️ AWARIA JEDNOZNACZNA — inFakt ODPOWIEDZIAL i ODMOWIL (4xx). Dokumentu na pewno NIE MA
  // u organu, wiec rezerwacja nie chroni juz przed niczym, a zostawiona zamykalaby dokument
  // NA ZAWSZE: panel odmawialby wysylki, ktorej organ nigdy nie dostal, a jedynym wyjsciem
  // bylaby reczna wysylka w inFakcie (niezmiennik 4.9). Ta sama granica, co `zwolnijFakture`
  // / `oznaczFaktureDoWyjasnienia` w db/faktury.js.
  it('odmowa inFaktu (4xx) ZWALNIA rezerwację — po poprawieniu danych da się wysłać ponownie', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let wolan = 0;
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => {
          wolan += 1;
          if (wolan === 1) {
            throw bladOperatora('inFakt odrzucił wysyłkę do KSeF (422): Proszę podać nazwę firmy.', { status: 422 });
          }
          return { przyjete: 1 };
        },
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });
    const arg = { uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' };

    const pierwsza = await u.wyslij(arg, 'adam');

    // ⚠️ ODMOWA TO NIE „NIE WIADOMO". Dokument u organu NIE JEST, wiec nie ma prawa stanac
    // w kategorii, ktora ekran opisuje zdaniem „mogly juz trafic do KSeF nieodwracalnie".
    expect(pierwsza.wyslane).toEqual([]);
    expect(pierwsza.niepewne).toEqual([]);
    expect(pierwsza.blad).toMatch(/odrzucił/);
    expect(pierwsza.pominiete.map((p) => p.numer)).toEqual(['1/08/2026']);
    expect(pierwsza.pominiete[0].powod).toMatch(/nie poszedł do KSeF/i);
    // Wiersz rezerwacji ZDJETY — to on odbijalby nastepne klikniecie.
    expect(wysylkiKsef(db)).toEqual([]);
    // Slad mowi wprost, ze dokument NIE poszedl — i ze ponawia CZLOWIEK, nie panel.
    const slad = wpisyKsef(db, id);
    expect(slad).toHaveLength(2);
    expect(slad[1]).toMatch(/NIE poszedł/);
    expect(slad[1]).toMatch(/panel sam NIE ponawia/);

    // ⚠️ PONAWIA CZLOWIEK, drugim zatwierdzeniem — panel sam z siebie nie wolal inFaktu
    // ani razu wiecej (`wolan` bylby wtedy 2 juz po pierwszym `wyslij`).
    const druga = await u.wyslij(arg, 'adam');

    expect(wolan).toBe(2);
    expect(druga.wyslane).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    expect(wysylkiKsef(db).map((r) => r.uuid)).toEqual(['u1']);
  });

  // ⚠️⚠️ DRUGA STRONA TEJ SAMEJ GRANICY, I TO ONA JEST GROZNIEJSZA. 5xx PADA PO WYSLANIU
  // ZADANIA — zlecenie moglo zostac przyjete, wiec status w odpowiedzi NIE CZYNI awarii
  // jednoznaczna. Naiwna poprawka „jest `status`, to zwalniamy" otwieralaby droge
  // do duplikatu u organu.
  it('5xx i zerwane połączenie NIE zwalniają rezerwacji — drugie zatwierdzenie nie woła inFaktu', async () => {
    for (const awaria of [
      bladOperatora('inFakt odrzucił wysyłkę do KSeF (503): usługa niedostępna.', { status: 503 }),
      bladOperatora('inFakt nieosiągalny: The operation was aborted due to timeout'),
    ]) {
      const db = openOmsDb(':memory:');
      const id = zamowienieZFaktura(db);
      let wolan = 0;
      const u = createWysylkaKsef({
        db,
        infakt: { wyslijDokumentDoKsef: async () => { wolan += 1; throw awaria; } },
        fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
      });
      const arg = { uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' };

      const pierwsza = await u.wyslij(arg, 'adam');
      expect(pierwsza.niepewne).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
      expect(wysylkiKsef(db).map((r) => r.uuid)).toEqual(['u1']);

      const druga = await u.wyslij(arg, 'adam');
      expect(wolan).toBe(1);
      expect(druga.wyslane).toEqual([]);
      expect(druga.pominiete).toHaveLength(1);
      expect(druga.pominiete[0].numer).toBe('1/08/2026');
      expect(druga.pominiete[0].powod).toMatch(/panel już zlecił/i);
      expect(druga.pominiete[0].powod).toMatch(/inFakcie/);
    }
  });

  // ⚠️⚠️ AWARIA SPRZED WYWOLANIA. Zapis sladu idzie PRZED `wyslijDokumentDoKsef`, wiec jego padniecie
  // znaczy, ze do inFaktu NIE POSZLO NIC — a rezerwacja zostawala i zamykala te dokumenty
  // na zawsze: ekran mowil prawde („nic nie poszlo"), a panel i tak odmawial ponowienia.
  it('padający zapis śladu PRZED wywołaniem zwalnia rezerwacje — nic nie poszło, więc da się ponowić', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    let wolan = 0;
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { wolan += 1; return {}; } },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });
    const arg = { uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' };

    // Zapis do logu pada — tak samo, jak przy pelnym dysku czy blokadzie WAL.
    db.exec("CREATE TRIGGER log_padnij BEFORE INSERT ON log BEGIN SELECT RAISE(ABORT, 'log niedostępny'); END");
    await expect(u.wyslij(arg, 'adam')).rejects.toThrow();

    expect(wolan).toBe(0); // do inFaktu nie poszlo NIC
    expect(wysylkiKsef(db)).toEqual([]); // ...wiec rezerwacja nie ma czego chronic

    db.exec('DROP TRIGGER log_padnij');
    const druga = await u.wyslij(arg, 'adam');

    expect(wolan).toBe(1);
    expect(druga.wyslane).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
  });

  // ⚠️⚠️ TEN SAM SLEPY ZAULEK, TYLKO JEDNO PIETRO NIZEJ. Petla zajmowania w `zarezerwuj`
  // wolala `zajmijWysylkeKsef` bez ZADNEJ ochrony — awaria zapisu na DRUGIM dokumencie
  // zostawiala PIERWSZY zajety NA ZAWSZE, mimo ze do inFaktu nie poszlo NIC. Dokladnie ten
  // sam ksztalt, co przy padajacym zapisie sladu w `wyslij` (test wyzej) — tylko o pietro
  // wczesniej, PRZED nim.
  it('zarezerwuj: awaria w połowie zajmowania zwalnia to, co zdążyło się zająć — nic nie leci, drugi raz da się spróbować', async () => {
    const db = openOmsDb(':memory:');
    const id1 = zamowienieZFaktura(db, { uuid: 'u1', numer: '1/08/2026' });
    const id2 = zamowienieZFaktura(db, { uuid: 'u2', numer: '2/08/2026' });
    let wolane = false;
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { wolane = true; return {}; } },
      fakturyWidok: {
        dokumenty: async () => [
          dokument({ zamowienie: { id: id1, numer: '3001' } }),
          dokument({ uuid: 'u2', number: '2/08/2026', zamowienie: { id: id2, numer: '3002' } }),
        ],
      },
    });
    // Zapis DRUGIEGO wiersza rezerwacji pada — tak, jakby padla baza w polowie petli
    // zajmowania (pierwszy INSERT przechodzi, kazdy kolejny juz nie).
    db.exec(`
      CREATE TRIGGER zajmij_padnij BEFORE INSERT ON wysylki_ksef
      WHEN (SELECT COUNT(*) FROM wysylki_ksef) >= 1
      BEGIN SELECT RAISE(ABORT, 'awaria zapisu rezerwacji'); END
    `);

    await expect(u.wyslij({ uuids: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' })).rejects.toThrow();

    expect(wolane).toBe(false); // do inFaktu nie poszlo NIC
    expect(wysylkiKsef(db)).toEqual([]); // ...wiec pierwszy zajety wiersz nie ma prawa zostac

    db.exec('DROP TRIGGER zajmij_padnij');
    const druga = await u.wyslij({ uuids: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    expect(wolane).toBe(true);
    expect(druga.wyslane).toHaveLength(2);
  });

  it('rezerwacja nie blokuje INNYCH dokumentów z tego samego zaznaczenia', async () => {
    const db = openOmsDb(':memory:');
    const wyslane = [];
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async (uuid) => { wyslane.push(uuid); return {}; } },
      fakturyWidok: {
        dokumenty: async () => [dokument(), dokument({ uuid: 'u2', number: '2/08/2026' })],
      },
    });

    await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');
    // ⚠️ Atrapa AKUMULUJE wywolania (od 07.08 kazdy dokument idzie osobnym zadaniem), wiec
    // po pierwszej wysylce lista niesie juz `u1` — czyscimy ja, zeby test mowil o DRUGIM
    // zatwierdzeniu, a nie o sumie obu.
    wyslane.length = 0;
    const druga = await u.wyslij({ uuids: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    expect(wyslane).toEqual(['u2']);
    expect(druga.wyslane).toEqual([{ uuid: 'u2', numer: '2/08/2026' }]);
    expect(druga.pominiete.map((p) => p.numer)).toEqual(['1/08/2026']);
  });
});

// ——— slad: faktura zbiorcza okresu i nazwa operatora ————————————————————

describe('ślad wysyłki do KSeF', () => {
  // ⚠️⚠️ FAKTURA ZBIORCZA B2B NIE MA ZAMOWIENIA — ma OKRES (services/faktury-widok.js).
  // Bez tej galezi caly pieniadz dropshippingowy jechal do KSeF nie zostawiajac ani jednego
  // sladu w panelu. Wpis idzie do logu KAZDEGO zamowienia okresu, bo tam czlowiek szuka
  // historii — dokladnie tak samo, jak przy wystawieniu faktury okresu (routes/okresy.js).
  it('dokument okresu zostawia ślad w logu KAŻDEGO zamówienia tego okresu', async () => {
    const db = openOmsDb(':memory:');
    const okres = zapewnijOkres(db, { klientKlucz: 'dropship', rok: 2026, miesiac: 8 });
    const a = zamowienieZFaktura(db, { uuid: 'x1', numer: 'X/1' });
    const b = zamowienieZFaktura(db, { uuid: 'x2', numer: 'X/2' });
    const obcy = zamowienieZFaktura(db, { uuid: 'x3', numer: 'X/3' });
    db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = ? WHERE id IN (?, ?)').run(okres.id, a, b);

    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => ({}) },
      fakturyWidok: {
        dokumenty: async () => [dokument({ zamowienie: null, okres: { id: okres.id, klient: 'dropship', rok: 2026, miesiac: 8 } })],
      },
    });

    const w = await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    expect(w.wyslane).toHaveLength(1);
    expect(wpisyKsef(db, a).join('\n')).toMatch(/1\/08\/2026/);
    expect(wpisyKsef(db, b).join('\n')).toMatch(/1\/08\/2026/);
    expect(wpisyKsef(db, obcy)).toEqual([]);
  });

  it('nieudana wysyłka dokumentu okresu też zostawia ślad w każdym zamówieniu', async () => {
    const db = openOmsDb(':memory:');
    const okres = zapewnijOkres(db, { klientKlucz: 'dropship', rok: 2026, miesiac: 8 });
    const a = zamowienieZFaktura(db, { uuid: 'x1', numer: 'X/1' });
    db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = ? WHERE id = ?').run(okres.id, a);

    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { throw bladOperatora('inFakt nie odpowiedział w wyznaczonym czasie.'); } },
      fakturyWidok: {
        dokumenty: async () => [dokument({ zamowienie: null, okres: { id: okres.id, klient: 'dropship', rok: 2026, miesiac: 8 } })],
      },
    });

    await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    const slad = wpisyKsef(db, a);
    expect(slad).toHaveLength(2);
    expect(slad[1]).toMatch(/nie wiadomo/i);
  });

  // ⚠️ „Kto to klikal i o ktorej" jest PIERWSZYM pytaniem po zerwanej probie — od tego
  // zalezy, kogo zapytac, czy zajrzal juz do inFaktu (ta sama zasada, co w routes/okresy.js).
  it('ślad niesie nazwę operatora — i przy zleceniu, i przy „nie wiadomo"', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const u = createWysylkaKsef({
      db,
      infakt: { wyslijDokumentDoKsef: async () => { throw bladOperatora('inFakt nie odpowiedział.'); } },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });

    await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'ewa');

    const slad = wpisyKsef(db, id);
    expect(slad).toHaveLength(2);
    expect(slad[0]).toMatch(/ewa/);
    expect(slad[1]).toMatch(/ewa/);
  });

  // ⚠️⚠️ PADAJACY ZAPIS DO LOGU NIE MA PRAWA ZAMIENIC „NIE WIADOMO" W „NIE POSZLO". Wyjatek
  // z `dopiszLog` wychodzil z uslugi do trasy, a ta renderowala „Nic nie poszlo do KSeF" —
  // zdanie STANOWCZE o wywolaniu, ktore moglo juz wyladowac u organu.
  it('gdy zapis śladu porażki padnie, wynik „nie wiadomo" i tak dociera na ekran', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const u = createWysylkaKsef({
      db,
      infakt: {
        wyslijDokumentDoKsef: async () => {
          // Log znika DOKLADNIE miedzy wpisem „zlecono" a wpisem „nie wiadomo".
          db.exec('DROP TABLE log');
          throw bladOperatora('inFakt nie odpowiedział w wyznaczonym czasie.');
        },
      },
      fakturyWidok: { dokumenty: async () => [dokument({ zamowienie: { id, numer: '3001' } })] },
    });

    const w = await u.wyslij({ uuids: ['u1'], miesiac: '2026-08', pole: 'invoice_date' }, 'adam');

    expect(w.niepewne).toEqual([{ uuid: 'u1', numer: '1/08/2026' }]);
    expect(w.wyslane).toEqual([]);
    expect(w.blad).toMatch(/inFakt nie odpowiedział/);
    // Awaria logu DOKLADA sie do komunikatu, a nie zastepuje wyniku.
    expect(w.blad).toMatch(/logu/i);
  });
});

// ——— trasa i ekran wyniku ———————————————————————————————————————————————

function serwer(wyslij) {
  return buildOmsServer({
    db: openOmsDb(':memory:'),
    config: { auth: { user: 't', pass: 'h' } },
    fakturyWidok: { dokumenty: async () => [], nieoplacone: async () => [], proformy: () => [] },
    wysylkaKsef: { podglad: async () => ({ doWyslania: [], pominiete: [], dokumenty: [] }), wyslij },
  });
}

const wyslijZadanie = (app, payload, naglowki = AUTH) => app.inject({
  method: 'POST', url: '/faktury/ksef/wyslij', headers: naglowki, payload,
});

describe('POST /faktury/ksef/wyslij', () => {
  // ⚠️⚠️ ZADNEGO PRZEKIEROWANIA. Ekran wyniku jest JEDYNYM potwierdzeniem operacji, ktorej
  // nie da sie ani powtorzyc, ani cofnac (ta sama zasada, co przy nadaniu masowym).
  it('nie przekierowuje — oddaje ekran wyniku', async () => {
    const app = serwer(async () => ({
      wyslane: [{ uuid: 'u1', numer: '1/08/2026' }], pominiete: [], niepewne: [], przyjete: 1, blad: null,
    }));
    const r = await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(r.statusCode).toBe(200);
    expect(r.headers.location).toBeUndefined();
  });

  // ⚠️⚠️ „WYSLANO" NIE ZNACZY „JEST W KSeF". Zmierzone 70 sekund miedzy przyjeciem zlecenia
  // a nadaniem numeru — panel w tej chwili NIE WIE, czy organ dokument przyjal.
  it('mówi „wysłano — czeka na numer KSeF" i nie obiecuje, że dokument JEST w KSeF', async () => {
    const app = serwer(async () => ({
      wyslane: [{ uuid: 'u1', numer: '1/08/2026' }], pominiete: [], niepewne: [], przyjete: 1, blad: null,
    }));
    const r = await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(r.body).toContain('1/08/2026');
    expect(r.body).toMatch(/czeka na numer KSeF/);
    expect(r.body).not.toMatch(/jest w KSeF/);
  });

  it('przekazuje usłudze zaznaczenie, miesiąc i pole daty', async () => {
    let widziane = null;
    const app = serwer(async (a) => {
      widziane = a;
      return { wyslane: [], pominiete: [], niepewne: [], przyjete: null, blad: null };
    });
    await wyslijZadanie(app, { uuid: ['u1', 'u2'], miesiac: '2026-07', pole: 'sale_date' });
    expect(widziane).toEqual({ uuids: ['u1', 'u2'], miesiac: '2026-07', pole: 'sale_date' });
  });

  // Jeden zaznaczony checkbox przychodzi z Fastify jako NAPIS, nie tablica.
  it('pojedyncze zaznaczenie dojeżdża jako tablica jednoelementowa', async () => {
    let widziane = null;
    const app = serwer(async (a) => {
      widziane = a;
      return { wyslane: [], pominiete: [], niepewne: [], przyjete: null, blad: null };
    });
    await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(widziane.uuids).toEqual(['u1']);
  });

  it('wypisuje pominięte RAZEM Z POWODEM', async () => {
    const app = serwer(async () => ({
      wyslane: [],
      pominiete: [{ numer: 'KOR/1/08/2026', powod: 'Korekty wysyła się w inFakcie — panel ich nie wysyła.' }],
      niepewne: [], przyjete: null, blad: null,
    }));
    const r = await wyslijZadanie(app, { uuid: 'k1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(r.body).toContain('KOR/1/08/2026');
    expect(r.body).toMatch(/Korekty wysyła się w inFakcie/);
  });

  // ⚠️⚠️ AWARIA WYWOLANIA TO „NIE WIADOMO", A NIE „NIE POSZLO" — i ekran ma to powiedziec
  // wprost, razem z nastepnym krokiem dla czlowieka.
  it('gdy wysyłka padła, ekran mówi „nie wiadomo" i odsyła do inFaktu, a nie do ponowienia', async () => {
    const app = serwer(async () => ({
      wyslane: [], pominiete: [], niepewne: [{ uuid: 'u1', numer: '1/08/2026' }], przyjete: 0,
      blad: 'inFakt nie odpowiedział w wyznaczonym czasie.',
    }));
    const r = await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/inFakt nie odpowiedział w wyznaczonym czasie/);
    expect(r.body).toMatch(/nie wiadomo/i);
    expect(r.body).toContain('1/08/2026');
    expect(r.body).not.toMatch(/czeka na numer KSeF/);
    // ⚠️⚠️ ZERWANE POLACZENIE TO NIE „NIC NIE POSZLO". Dokumenty moga juz byc w KSeF —
    // zdanie o pustej wysylce popchneloby czlowieka do ponowienia, czyli do duplikatu.
    // (Zdanie „nie znaczy, że nic nie poszło" na tym ekranie STOI i ma stać — dlatego
    // sprawdzamy dokładnie ten nagłówek, który obwieszczałby pustą wysyłkę.)
    expect(r.body).not.toContain('Nic nie poszło do KSeF');
  });

  // ⚠️ Trasa MUSI podac usludze, kto klikal — inaczej slad w logu nie odpowiada na pierwsze
  // pytanie po zerwanej probie (ta sama zasada, co przy fakturze okresu w routes/okresy.js).
  it('podaje usłudze nazwę operatora, który kliknął', async () => {
    let kto = null;
    const app = serwer(async (_a, ktoKlikal) => {
      kto = ktoKlikal;
      return { wyslane: [], pominiete: [], niepewne: [], przyjete: null, blad: null };
    });
    await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(kto).toBe('t');
  });

  // ⚠️⚠️ EKRAN NIE UDAJE ZESTAWIENIA, KTOREGO PANEL NIE UMIE ZROBIC (recenzja calosci,
  // Finding 3). Stały tu dwa ostrzezenia — „liczby sie rozjezdzaja" i „panel nie dostal liczby
  // przyjetych" — a ZADNE nie moglo sie zapalic: `wyslijDokumentDoKsef` wyrzucalo tresc odpowiedzi
  // i oddawalo `przyjete` = dlugosc tego, co SAMO wyslalo. Liczba byla wiec zawsze rowna
  // zgloszonej i nigdy nie byla `null`; testy zadawaly kliencie ksztalt, ktorego nie umial
  // wyprodukowac, wiec przechodzily bez wzgledu na implementacje.
  //
  // Ten test pilnuje teraz czegos odwrotnego i prawdziwego: ekran NIE MA prawa wygladac na
  // sprawdzony. Zadnego „przyjal N", zadnego zestawienia — ani przy liczbie zgodnej, ani przy
  // rozjechanej, ani przy jej braku.
  it('nie udaje zestawienia liczb, których nikt nie sprawdził', async () => {
    for (const przyjete of [1, 2, null]) {
      const app = serwer(async () => ({
        wyslane: [{ uuid: 'u1', numer: '1/08/2026' }, { uuid: 'u2', numer: '2/08/2026' }],
        pominiete: [], niepewne: [], przyjete, blad: null,
      }));
      const r = await wyslijZadanie(app, { uuid: ['u1', 'u2'], miesiac: '2026-08', pole: 'invoice_date' });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toMatch(/rozjeżdżaj/i);
      expect(r.body).not.toMatch(/przyjął/i);
      expect(r.body).not.toMatch(/nie dostał liczby/i);
      // ...ale liczba WYSLANYCH przez panel dalej stoi, razem z zastrzezeniem, ze to jest
      // wylacznie wlasny rachunek panelu.
      expect(r.body).toMatch(/Wysłano — czeka na numer KSeF — 2/);
      expect(r.body).toMatch(/panel wysłał|własny rachunek panelu/i);
    }
  });

  // Nieznany miesiac / nieznane pole daty odbija sie w uslugowej bramce `faktury-widok`.
  // Ekran ma o tym POWIEDZIEC, a nie oddac 500 ani udawac, ze cos poszlo.
  it('wyjątek z usługi kończy się ekranem z komunikatem, a nie pięćsetką', async () => {
    const app = serwer(async () => { throw bladOperatora('Nieznany miesiąc rozliczeniowy.'); });
    const r = await wyslijZadanie(app, { uuid: 'u1', miesiac: 'byle-co', pole: 'invoice_date' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/Nieznany miesiąc rozliczeniowy/);
    expect(r.body).not.toMatch(/czeka na numer KSeF/);
    // Awaria SPRZED wysylki — tu wolno powiedziec wprost, ze nic nie poszlo.
    expect(r.body).toMatch(/Nic nie poszło do KSeF/);
  });

  // Powrot ma oddac operatora tam, skad przyszedl — na TEN miesiac i TO pole daty.
  it('odnośnik powrotny niesie miesiąc i pole daty, na które operator patrzył', async () => {
    const app = serwer(async () => ({
      wyslane: [{ uuid: 'u1', numer: '1/08/2026' }], pominiete: [], niepewne: [], przyjete: 1, blad: null,
    }));
    const r = await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-07', pole: 'sale_date' });
    // `&` w atrybucie HTML jest ESCAPOWANE przez EJS (`&amp;`) — sprawdzamy to, co naprawdę
    // wychodzi do przeglądarki, a nie to, co wygodniej byłoby napisać w teście.
    expect(r.body).toContain('href="/faktury?miesiac=2026-07&amp;pole=sale_date"');
  });

  it('POST bez nagłówka Origin odbija się od ochrony CSRF', async () => {
    let wolane = 0;
    const app = serwer(async () => {
      wolane += 1;
      return { wyslane: [], pominiete: [], niepewne: [], przyjete: null, blad: null };
    });
    const r = await wyslijZadanie(app, { uuid: 'u1' }, { authorization: AUTH.authorization });
    expect(r.statusCode).toBe(403);
    expect(wolane).toBe(0);
  });

  it('panel bez usługi wysyłki odmawia czytelnie zamiast wywalać się na 500', async () => {
    const app = buildOmsServer({ db: openOmsDb(':memory:'), config: { auth: { user: 't', pass: 'h' } } });
    const r = await wyslijZadanie(app, { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/inFakt/i);
  });
});
