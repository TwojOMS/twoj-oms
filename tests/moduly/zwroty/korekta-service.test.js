import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  dodajZwrot, zwrot, zarezerwujKorekte, zapiszKorekte, zapiszRecznyNumerKorekty,
} from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';

// ⚠️ Rozbieznosc z briefem: fikstura ponizej dostala `sku` i `vat` — brief ich nie mial,
// a `pozycje.sku`/`pozycje.vat` sa w schemacie kolumnami BEZ `COALESCE` w zapiszPozycje
// (db/zamowienia.js), wiec `undefined` odbija sie od SQLite. Ta sama poprawka, co w
// tests/oms/zwroty-db.test.js i tests/oms/web-zwroty.test.js.
const zmapowane = () => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1234563218',
  kwota_brutto: '217.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-01T10:00:00',
  pozycje: [{
    zrodlo_id: 77, nazwa: 'Kot 70x100', sku: 'PRO-KOT-001', ilosc: 2, cena_brutto: '99.00',
    brutto_linii: '198.00', vat: null,
  }],
});

const FAKTURA = {
  number: 'FV 1/08/2026', invoice_date: '2026-08-01', uuid: 'uuid-fv',
  services: [{ name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23' }],
};

let db;
let id;
let zwrotId;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Rozbieznosc z briefem: `zapiszZamowienie` oddaje LICZBOWE `id` wprost (db/zamowienia.js),
  // nie obiekt `{ id }` — ta sama pulapka, co w tests/oms/zwroty-db.test.js i web-zwroty.test.js.
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
  // ⚠️ Rozbieznosc z briefem: kolumna nazywa sie `infakt_uuid`, nie `uuid` (schema.sql).
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
  ).run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
  zwrotId = dodajZwrot(db, id, {
    data: '2026-08-14', kwota: '99.00',
    pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
  }).id;
});

describe('wystawienie korekty', () => {
  it('zapisuje referencje i NIE obiecuje numeru, ktorego nie dostal', async () => {
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
      wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-1', uuid: null, numer: null }),
    };
    await createKorekta({ db, infakt }).wystaw(id, zwrotId);
    const w = zwrot(db, id, zwrotId);
    expect(w.korekta_referencja).toBe('REF-1');
    expect(w.korekta_numer).toBeNull();
    expect(w.korekta_zlecona_at).not.toBeNull();
  });

  it('REZERWACJA POWSTAJE PRZED wywolaniem — druga proba odbija sie od bazy', async () => {
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
      wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-1', uuid: null, numer: null }),
    };
    const usluga = createKorekta({ db, infakt });
    await usluga.wystaw(id, zwrotId);
    await expect(usluga.wystaw(id, zwrotId)).rejects.toMatchObject({ dlaOperatora: true });
    expect(infakt.wystawKorekte).toHaveBeenCalledTimes(1);
  });

  it('ODMOWA inFaktu ZWALNIA rezerwacje i zapisuje blad', async () => {
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
      wystawKorekte: vi.fn().mockRejectedValue(
        Object.assign(new Error('inFakt odrzucił: correction_reason'), { dlaOperatora: true, status: 422 }),
      ),
    };
    await expect(createKorekta({ db, infakt }).wystaw(id, zwrotId)).rejects.toThrow(/correction_reason/);
    const w = zwrot(db, id, zwrotId);
    expect(w.korekta_zlecona_at).toBeNull();
    expect(w.korekta_blad).toMatch(/correction_reason/);
  });

  it('ZERWANE POLACZENIE NIE zwalnia rezerwacji — nie wiadomo, czy zlecenie doszlo', async () => {
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
      wystawKorekte: vi.fn().mockRejectedValue(new Error('socket hang up')),
    };
    await expect(createKorekta({ db, infakt }).wystaw(id, zwrotId)).rejects.toThrow();
    expect(zwrot(db, id, zwrotId).korekta_zlecona_at).not.toBeNull();
  });

  it('rozbieznosc pozycji faktury i zwrotu ODMAWIA i nie dotyka inFaktu', async () => {
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue({ ...FAKTURA, services: [{ name: 'Sowa', quantity: 1, gross_price: 5000, tax_symbol: '23' }] }),
      wystawKorekte: vi.fn(),
    };
    await expect(createKorekta({ db, infakt }).wystaw(id, zwrotId)).rejects.toThrow(/Kot 70x100/);
    expect(infakt.wystawKorekte).not.toHaveBeenCalled();
  });

  // I7: „Powod" z formularza to NOTATKA OPERATORA, a `correction_reason` to tresc dokumentu
  // widocznego u nabywcy i u organu. „Klientka sie rozmyslila, oddane blikiem" na korekcie
  // jest wyciekiem, ktorego nie da sie cofnac — na dokument idzie stala, neutralna tresc.
  it('na dokument idzie NEUTRALNA tresc, notatka operatora zostaje w panelu', async () => {
    const notatka = 'klientka się rozmyśliła, oddane blikiem 0501234567';
    // Pierwszy zwrot z `beforeEach` musi zniknac, inaczej odbije sie od bariery „jedna
    // korekta na fakture" (nizej) zamiast dojsc do inFaktu.
    // ⚠️ KASUJEMY GO PRZED DOPISANIEM NOWEGO (poprawka I6, 2026-08-15): zwrot ponizej ma te
    // sama date, kwote i te same pozycje, co tamten — rozni sie WYLACZNIE notatka, ktora
    // tozsamosci zwrotu nie tworzy. `dodajZwrot` odmawia teraz takiego dubletu jako powtornego
    // wyslania formularza, wiec kolejnosc tych dwoch linii przestala byc obojetna.
    db.prepare('DELETE FROM zwroty WHERE id = ?').run(zwrotId);
    const wId = dodajZwrot(db, id, {
      data: '2026-08-14', kwota: '99.00', powod: notatka,
      pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
    }).id;
    const infakt = {
      pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
      wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-1', uuid: null, numer: null }),
    };
    await createKorekta({ db, infakt }).wystaw(id, wId);
    const payload = infakt.wystawKorekte.mock.calls[0][0];
    expect(payload.correction_reason).toBe('zwrot towaru');
    expect(JSON.stringify(payload)).not.toMatch(/rozmyśliła|blikiem|0501234567/);
    // Notatka NIE ZNIKA — zostaje tam, gdzie jest przydatna: w panelu.
    expect(zwrot(db, id, wId).powod).toBe(notatka);
  });
});

/**
 * C1a: DRUGA KOREKTA DO TEJ SAMEJ FAKTURY.
 *
 * Specyfikacja dopuszcza wiele zwrotow do jednego zamowienia wprost, a `pobierzFakture`
 * czyta zawsze FAKTURE PIERWOTNA — wiec dla drugiego zwrotu czesciowego panel zlozylby
 * dokument mowiacy „z 2 szt. na 1 szt." wtedy, gdy pierwsza korekta juz to zdjela. To jest
 * korekta in minus policzona u organu DWA RAZY. Drugiej pary przed/po panel dzis nie umie
 * zlozyc, wiec odmawia — PRZED rezerwacja i przed dotknieciem inFaktu.
 */
describe('druga korekta do TEJ SAMEJ faktury', () => {
  const infaktSprawny = () => ({
    pobierzFakture: vi.fn().mockResolvedValue(FAKTURA),
    wystawKorekte: vi.fn().mockResolvedValue({ referencja: 'REF-2', uuid: null, numer: null }),
  });
  const drugiZwrot = () => dodajZwrot(db, id, {
    data: '2026-09-02', kwota: '99.00',
    pozycje: [{ klucz_pozycji: 's77', nazwa: 'Kot 70x100', ilosc: 1, kwota: '99.00' }],
  }).id;

  it('ODMAWIA, gdy inny zwrot tej faktury ma juz NUMER korekty', async () => {
    zarezerwujKorekte(db, id, zwrotId);
    zapiszKorekte(db, id, zwrotId, { numer: '1/KOR/08/2026', uuid: 'uuid-kor' });
    const drugi = drugiZwrot();
    const infakt = infaktSprawny();

    await expect(createKorekta({ db, infakt }).wystaw(id, drugi))
      .rejects.toMatchObject({ dlaOperatora: true });
    await expect(createKorekta({ db, infakt }).wystaw(id, drugi)).rejects.toThrow(/ręcznie/);
    expect(infakt.wystawKorekte).not.toHaveBeenCalled();
    expect(infakt.pobierzFakture).not.toHaveBeenCalled();
    // ODMOWA PRZED REZERWACJA — nieudana proba nie ma prawa zablokowac niczego.
    expect(zwrot(db, id, drugi).korekta_zlecona_at).toBeNull();
  });

  it('ODMAWIA takze wtedy, gdy tamta korekta jest dopiero ZLECONA (bez numeru)', async () => {
    zarezerwujKorekte(db, id, zwrotId);
    const drugi = drugiZwrot();
    const infakt = infaktSprawny();
    await expect(createKorekta({ db, infakt }).wystaw(id, drugi)).rejects.toMatchObject({ dlaOperatora: true });
    expect(infakt.wystawKorekte).not.toHaveBeenCalled();
  });

  // Strazujemy tez DRUGA strone: bariera nie ma prawa zamurowac zamowienia, w ktorym
  // pierwsza proba ODBILA SIE od inFaktu (4xx zwalnia rezerwacje — services/korekta.js).
  it('NIE odmawia, gdy tamta rezerwacja zostala zwolniona po odmowie inFaktu', async () => {
    db.prepare('UPDATE zwroty SET korekta_blad = ? WHERE id = ?').run('inFakt odrzucił: 422', zwrotId);
    const drugi = drugiZwrot();
    const infakt = infaktSprawny();
    await createKorekta({ db, infakt }).wystaw(id, drugi);
    expect(infakt.wystawKorekte).toHaveBeenCalledTimes(1);
  });
});

/**
 * C1b: DOCZYTANIE NUMERU NIE MA PRAWA PRZYKLEIC CUDZEGO DOKUMENTU.
 *
 * Dopasowanie po samym `corrected_invoice_number` oddawalo TEN SAM numer obu zwrotom do
 * jednej faktury — a `zwrotRozliczony` uznawal wtedy oba za rozliczone i zamowienie schodzilo
 * z listy roboczej. Odczyt mial byc JEDYNYM DOWODEM, ze korekta powstala (201 z inFaktu nie
 * dowodzi niczego — notatka 2026-08-14), a „potwierdzal" dokument, ktorego nie ma.
 */
describe('doczytanie numeru korekty — cudzy dokument', () => {
  const KOREKTA_A = {
    uuid: 'uuid-kor-a', number: '1/KOR/08/2026', corrected_invoice_number: 'FV 1/08/2026',
    invoice_date: '2026-08-14',
  };
  let drugi;
  // ⚠️ KOLEJNOSC FIKSTURY JEST ISTOTNA (poprawka po K1/W4, 2026-08-15). Stan „jeden zwrot ma
  // korekte, drugi ma zlecona" jest w produkcji osiagalny WYLACZNIE w tej kolejnosci: najpierw
  // zlecenie dla B (wtedy nikt jeszcze korekty nie ma), potem numer dla A wpisany RECZNIE —
  // bo reczny numer odnotowuje dokument powstaly POZA panelem i jest droga ZALECANA przy
  // drugiej korekcie do tej samej faktury. Odwrotna kolejnosc odbija sie dzis od bariery
  // „jedna korekta na fakture" wewnatrz rezerwacji, i tak ma byc.
  beforeEach(() => {
    // Zwrot B: wrzesniowy, korekta zlecona przez panel, numeru jeszcze nie ma.
    drugi = dodajZwrot(db, id, { data: '2026-09-02', kwota: '99.00', pozycje: [] }).id;
    zarezerwujKorekte(db, id, drugi, '2026-09-02T09:00:00Z');
    // Zwrot A: korekta wystawiona RECZNIE w inFakcie i odnotowana w panelu.
    zapiszRecznyNumerKorekty(db, id, zwrotId, KOREKTA_A.number);
    zapiszKorekte(db, id, zwrotId, { uuid: KOREKTA_A.uuid });
  });

  it('NIE przypisuje drugiemu zwrotowi numeru, ktory ma juz pierwszy', async () => {
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([KOREKTA_A]) };
    await createKorekta({ db, infakt }).doczytaj(id, drugi);
    const b = zwrot(db, id, drugi);
    expect(b.korekta_numer).toBeNull();
    expect(b.korekta_uuid).toBeNull();
    // ...i nie rusza tez pierwszego.
    expect(zwrot(db, id, zwrotId).korekta_numer).toBe('1/KOR/08/2026');
  });

  it('NIE przypisuje korekty STARSZEJ niz zlecenie — np. wystawionej recznie miesiac wczesniej', async () => {
    const recznaZLipca = {
      uuid: 'uuid-reczna', number: '1/KOR/07/2026', corrected_invoice_number: 'FV 1/08/2026',
      invoice_date: '2026-07-10',
    };
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([recznaZLipca]) };
    await createKorekta({ db, infakt }).doczytaj(id, drugi);
    expect(zwrot(db, id, drugi).korekta_numer).toBeNull();
  });

  it('przypisuje korekte NOWSZA niz zlecenie i jeszcze nieprzypisana', async () => {
    const wrzesniowa = {
      uuid: 'uuid-kor-b', number: '2/KOR/09/2026', corrected_invoice_number: 'FV 1/08/2026',
      invoice_date: '2026-09-02',
    };
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([KOREKTA_A, wrzesniowa]) };
    await createKorekta({ db, infakt }).doczytaj(id, drugi);
    expect(zwrot(db, id, drugi).korekta_numer).toBe('2/KOR/09/2026');
    expect(zwrot(db, id, drugi).korekta_uuid).toBe('uuid-kor-b');
  });

  it('DWA pasujace dokumenty to niepewnosc — nie zapisuje zadnego', async () => {
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([
      { uuid: 'uuid-x', number: '2/KOR/09/2026', corrected_invoice_number: 'FV 1/08/2026', invoice_date: '2026-09-02' },
      { uuid: 'uuid-y', number: '3/KOR/09/2026', corrected_invoice_number: 'FV 1/08/2026', invoice_date: '2026-09-02' },
    ]) };
    await createKorekta({ db, infakt }).doczytaj(id, drugi);
    expect(zwrot(db, id, drugi).korekta_numer).toBeNull();
  });

  // Doczytanie zapisuje NUMER DOKUMENTU PODATKOWEGO rozliczajacego zwrot — bez wpisu w logu
  // po miesiacu nie da sie odpowiedziec, skad ten numer sie wzial i kiedy przybyl. Wzorem
  // `services/ksef-doczytanie.js`, ktory pisze slad przy FAKCIE (nie przy kazdej odslonie).
  it('zapisany numer zostawia SLAD W LOGU — i tylko przy fakcie, nie przy kazdym zajrzeniu', async () => {
    const wrzesniowa = {
      uuid: 'uuid-kor-b', number: '2/KOR/09/2026', corrected_invoice_number: 'FV 1/08/2026',
      invoice_date: '2026-09-02',
    };
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([KOREKTA_A, wrzesniowa]) };
    const usluga = createKorekta({ db, infakt });
    await usluga.doczytaj(id, drugi);
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
    const oKorekcie = wpisy.filter((x) => x.wynik.includes('2/KOR/09/2026'));
    expect(oKorekcie).toHaveLength(1);
    expect(oKorekcie[0].akcja).toMatch(/korekta/);
    // Drugie wejscie na ekran juz nic nie dopisuje — numer jest, doczytanie nawet nie pyta.
    await usluga.doczytaj(id, drugi);
    expect(db.prepare('SELECT COUNT(*) AS n FROM log WHERE zamowienie_id = ?').get(id).n)
      .toBe(wpisy.length);
  });
});

/**
 * ⚠️⚠️ W3 (recenzja kontrolna 2026-08-15): RESZTKA PO C1 — DOCZYTANIE DALEJ POTRAFILO
 * PRZYKLEIC CUDZY DOKUMENT.
 *
 * Zmierzone: zwrot A ma WISZACA rezerwacje po zerwanym polaczeniu; czlowiek wystawia korekte
 * do zwrotu B RECZNIE w inFakcie i numeru jeszcze nie wpisal. Wejscie na ekran odpala
 * `doczytaj` dla A, jedyny kandydat przechodzi sito „numer niezajety przez inny zwrot"
 * (B numeru NIE MA, wiec niczego nie zajmuje) i sito daty → numer korekty B ląduje na
 * zwrocie A, `zwrotRozliczony(A)` = true i zamowienie schodzi z listy roboczej.
 *
 * To nie jest sciezka teoretyczna: reczne wystawienie drugiej korekty jest droga, ktora sam
 * modul NAZYWA ZALECANA (panel odmawia drugiej korekty swiadomie).
 */
describe('W3: doczytanie NIE ZGADUJE, gdy otwartych spraw korekty jest wiecej niz jedna', () => {
  const KOREKTA_B = {
    uuid: 'uuid-kor-b', number: '5/KOR/09/2026', corrected_invoice_number: 'FV 1/08/2026',
    invoice_date: '2026-09-02',
  };

  it('nie przypisuje niczego zwrotowi A, gdy zwrot B tez czeka na swoja korekte', async () => {
    // A: rezerwacja po zerwanym polaczeniu (numeru nie ma).
    zarezerwujKorekte(db, id, zwrotId, '2026-09-01T09:00:00Z');
    // B: zwrot bez rezerwacji i bez numeru — jego korekta powstala RECZNIE w inFakcie.
    const drugi = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] }).id;
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([KOREKTA_B]) };

    await createKorekta({ db, infakt }).doczytaj(id, zwrotId);
    expect(zwrot(db, id, zwrotId).korekta_numer).toBeNull();
    expect(zwrot(db, id, drugi).korekta_numer).toBeNull();
    // Nie pytamy nawet inFaktu — decyzja zapada z samego stanu zamowienia.
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
  });

  it('gdy otwarta sprawa jest DOKLADNIE JEDNA, doczytanie dziala jak dotad', async () => {
    zarezerwujKorekte(db, id, zwrotId, '2026-09-01T09:00:00Z');
    // Drugi zwrot ma juz SWOJ numer — jego sprawa jest zamknieta i nie zaciemnia dopasowania.
    const drugi = dodajZwrot(db, id, { data: '2026-09-02', kwota: '50.00', pozycje: [] }).id;
    zapiszRecznyNumerKorekty(db, id, drugi, '4/KOR/09/2026');
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([KOREKTA_B]) };

    await createKorekta({ db, infakt }).doczytaj(id, zwrotId);
    expect(zwrot(db, id, zwrotId).korekta_numer).toBe('5/KOR/09/2026');
  });
});

/**
 * ⚠️⚠️ K1 (recenzja kontrolna 2026-08-15): RECZNIE WPISANY NUMER NIE BLOKOWAL WYSTAWIENIA.
 *
 * Bariera „jedna korekta na fakture" patrzyla wylacznie na INNE zwroty (`x.id !== w.id`), a
 * „Korektę wystawiłem ręcznie" NIE USTAWIA rezerwacji — dla TEGO SAMEGO zwrotu nie bylo wiec
 * zadnej bariery. Zmierzone: zwrot z numerem `9/KOR/08/2026` i pusta rezerwacja przechodzil
 * wszystkie sita, `wystawKorekte` szlo do inFaktu, a `zapiszKorekte` (COALESCE) NADPISYWALO
 * numer reczny numerem nowego dokumentu — pierwszy znikal z bazy bez sladu.
 *
 * Droga przez UI: druga otwarta karta albo back+resubmit sprzed wpisania numeru.
 */
describe('K1: reczny numer korekty blokuje wystawienie przez panel', () => {
  it('ODMAWIA czytelnie i NIE dotyka inFaktu', async () => {
    zapiszRecznyNumerKorekty(db, id, zwrotId, '9/KOR/08/2026');
    const infakt = { pobierzFakture: vi.fn(), wystawKorekte: vi.fn() };

    await expect(createKorekta({ db, infakt }).wystaw(id, zwrotId))
      .rejects.toMatchObject({ dlaOperatora: true });
    await expect(createKorekta({ db, infakt }).wystaw(id, zwrotId))
      .rejects.toThrow(/9\/KOR\/08\/2026/);
    expect(infakt.wystawKorekte).not.toHaveBeenCalled();
    expect(infakt.pobierzFakture).not.toHaveBeenCalled();
    // Numer reczny ZOSTAJE nietkniety — to on jest dokumentem rozliczajacym ten zwrot.
    expect(zwrot(db, id, zwrotId).korekta_numer).toBe('9/KOR/08/2026');
    expect(zwrot(db, id, zwrotId).korekta_zlecona_at).toBeNull();
  });
});
