import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ⚠️ O CO TU CHODZI (Zadanie 9, landmina spoza planu).
//
// Do tej pory karta zamowienia odswiezala status PETLA PO WSZYSTKICH przesylkach, wolajac
// `dpd.statusPrzesylki(p.numer_listu)` — BEZ SPRAWDZENIA, CZYJ TO KURIER. Odkad panel nadaje
// paczkomaty, numer InPostu szedlby wiec do DPD: kazde otwarcie karty pytaloby niewlasciwego
// kuriera, dostawalo odmowe i pokazywalo „status niedostepny" zamiast prawdziwego statusu.
// Karty by to nie wywalilo (odswiezanie jest odporne z zalozenia) i wlasnie dlatego jest
// grozne — awaria wygladalaby jak zwykla awaria sieci u kuriera.
//
// Usluge wybiera sie po `przesylki.kurier`, a BRAK klienta danego kuriera jest trybem
// POPRAWNYM (panel bez sekcji InPost ma wstawac i obslugiwac reszte).

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-07-29T12:00:00', ostatni_blad: null }) };

const NUMER_DPD = '1000000000001U';
const NUMER_INPOST = '520000123456789012345678';

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

function zPaczka(zrodloId, { kurier, numerListu, kolejnosc = 1 }) {
  const id = zapiszZamowienie(db, 'pro', zmapowane(zrodloId), {});
  db.prepare(
    'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)'
    + " VALUES (?, ?, 'nadana', ?, ?, '2026-07-29T13:00:00')",
  ).run(id, kurier, numerListu, kolejnosc);
  return id;
}

const otworzKarte = async (id, kurierzy) => {
  const serwer = buildOmsServer({ db, config, poller, kurierzy });
  await serwer.ready();
  return serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
};

const atrapa = (opis) => ({ statusPrzesylki: vi.fn().mockResolvedValue({ opis, at: '2026-07-30T09:00:00.000+02:00' }) });
const przesylki = (id) => pobierzZamowienie(db, id).przesylki;
const wpisyLogu = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);

describe('odświeżanie statusu pyta kuriera TEJ przesyłki', () => {
  // ⚠️ MUTACJA 2. Powrot do dzisiejszego stanu (zawsze `kurierzy.dpd`) musi ten test wywalic.
  it('paczkomat pyta InPost, a DPD nie jest w ogóle wołane', async () => {
    const id = zPaczka(2101, { kurier: 'inpost', numerListu: NUMER_INPOST });
    const dpd = atrapa('Doręczona przez DPD');
    const inpost = atrapa('Gotowa do odbioru w paczkomacie');

    const r = await otworzKarte(id, { dpd, inpost });

    expect(r.statusCode).toBe(200);
    expect(inpost.statusPrzesylki).toHaveBeenCalledWith(NUMER_INPOST, expect.any(Object));
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
    expect(przesylki(id)[0].status_kuriera).toBe('Gotowa do odbioru w paczkomacie');
    expect(r.body).toContain('Gotowa do odbioru w paczkomacie');
  });

  // Druga strona tej samej monety: paczka DPD nie ma prawa trafic do InPostu.
  it('paczka DPD pyta DPD, a InPost nie jest w ogóle wołany', async () => {
    const id = zPaczka(2102, { kurier: 'dpd', numerListu: NUMER_DPD });
    const dpd = atrapa('W doręczeniu');
    const inpost = atrapa('Gotowa do odbioru w paczkomacie');

    await otworzKarte(id, { dpd, inpost });

    expect(dpd.statusPrzesylki).toHaveBeenCalledWith(NUMER_DPD, expect.any(Object));
    expect(inpost.statusPrzesylki).not.toHaveBeenCalled();
    expect(przesylki(id)[0].status_kuriera).toBe('W doręczeniu');
  });

  // Dwie paczki, dwaj kurierzy, jedno zamowienie (dosylka paczkomatowa za zgubiona paczke
  // DPD to normalna sytuacja). Kazda musi pojsc do SWOJEGO kuriera i ze SWOIM numerem —
  // wybor „raz na zamowienie" pomylilby jedna z nich.
  it('dwie paczki różnych kurierów idą każda do swojego', async () => {
    const id = zPaczka(2103, { kurier: 'dpd', numerListu: NUMER_DPD, kolejnosc: 1 });
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)'
      + " VALUES (?, 'inpost', 'nadana', ?, 2, '2026-07-29T13:30:00')",
    ).run(id, NUMER_INPOST);

    const dpd = atrapa('W doręczeniu');
    const inpost = atrapa('Gotowa do odbioru w paczkomacie');
    await otworzKarte(id, { dpd, inpost });

    expect(dpd.statusPrzesylki).toHaveBeenCalledTimes(1);
    expect(dpd.statusPrzesylki).toHaveBeenCalledWith(NUMER_DPD, expect.any(Object));
    expect(inpost.statusPrzesylki).toHaveBeenCalledTimes(1);
    expect(inpost.statusPrzesylki).toHaveBeenCalledWith(NUMER_INPOST, expect.any(Object));

    const p = przesylki(id);
    expect(p.find((x) => x.kolejnosc === 1).status_kuriera).toBe('W doręczeniu');
    expect(p.find((x) => x.kolejnosc === 2).status_kuriera).toBe('Gotowa do odbioru w paczkomacie');
  });

  // ⚠️ BRAK KLIENTA DANEGO KURIERA TO TRYB POPRAWNY, NIE AWARIA (ta sama zasada, co
  // w bootstrap.js: panel bez sekcji INPOST_* ma wstawac i obslugiwac reszte). Paczkomat
  // ma wtedy po prostu nie byc odpytywany — i nie zostawiac falszywego wpisu w logu
  // przy KAZDYM otwarciu karty.
  it('paczkomat bez skonfigurowanego InPostu: karta wstaje, zero prób i zero błędu', async () => {
    const id = zPaczka(2104, { kurier: 'inpost', numerListu: NUMER_INPOST });
    const dpd = atrapa('Doręczona przez DPD');

    const r = await otworzKarte(id, { dpd });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(NUMER_INPOST);
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
    expect(wpisyLogu(id)).toHaveLength(0);
    // Panel niczego nie sprawdzil, wiec nie ma prawa twierdzic ANI „brak zdarzen",
    // ANI „status niedostepny".
    expect(r.body).not.toContain('brak zdarzeń');
    expect(r.body).not.toContain('status niedostępny');
    expect(przesylki(id)[0].status_kuriera_pobrany_at).toBeNull();
  });

  // Panel z samym InPostem (bez DPD) musi dzialac tak samo — mapa kurierow nie zaklada,
  // ze DPD jest zawsze.
  it('sam InPost, bez DPD: paczkomat jest odpytywany normalnie', async () => {
    const id = zPaczka(2105, { kurier: 'inpost', numerListu: NUMER_INPOST });
    const inpost = atrapa('Odebrana przez klienta');

    const r = await otworzKarte(id, { inpost });

    expect(inpost.statusPrzesylki).toHaveBeenCalledWith(NUMER_INPOST, expect.any(Object));
    expect(r.body).toContain('Odebrana przez klienta');
  });

  // Awaria InPostu ma sie zachowac DOKLADNIE tak, jak awaria DPD: karta sie renderuje,
  // powod idzie do logu i na kolumne bledu, a na ekranie widac „status niedostepny
  // (ostatnia proba …)". Zadnej drugiej implementacji tego samego.
  it('awaria InPostu nie wywala karty i pokazuje „status niedostępny"', async () => {
    const id = zPaczka(2106, { kurier: 'inpost', numerListu: NUMER_INPOST });
    const inpost = { statusPrzesylki: vi.fn().mockRejectedValue(new Error('InPost nieosiągalny: ECONNREFUSED')) };

    const r = await otworzKarte(id, { inpost });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('status niedostępny');
    expect(r.body).toContain('ostatnia próba');
    expect(r.body).not.toContain('ECONNREFUSED');
    expect(przesylki(id)[0].status_kuriera_blad).toContain('ECONNREFUSED');
    // ⚠️ ...ale odznaka sprawy NIE MA PRAWA mowic „DPD" o paczce, ktora nigdy do DPD nie
    // pojechala. Napis byl zaszyty na sztywno od Zadania 10, kiedy kurier byl jeden.
    expect(r.body).not.toContain('status DPD niedostępny');
    expect(r.body).toContain('status u kuriera niedostępny');
  });

  // Log ma mowic, KTORY kurier odmowil — inaczej przy dwoch kurierach wpis „…status" nie
  // pozwala odroznic awarii DPD od awarii InPostu jednym spojrzeniem.
  it('wpis w logu nazywa kuriera, który odmówił', async () => {
    const id = zPaczka(2107, { kurier: 'inpost', numerListu: NUMER_INPOST });
    const inpost = { statusPrzesylki: vi.fn().mockRejectedValue(new Error('403 Forbidden')) };

    await otworzKarte(id, { inpost });

    const wpis = wpisyLogu(id).find((w) => w.akcja === 'inpost.status');
    expect(wpis).toBeTruthy();
    expect(wpis.wynik).toContain('403 Forbidden');
    expect(wpisyLogu(id).some((w) => w.akcja === 'dpd.status')).toBe(false);
  });

  // Dlawik godzinowy zostaje PER PACZKA (kolumna status_kuriera_pobrany_at siedzi w wierszu
  // przesylki), wiec przeniesienie go na zamowienie zabraloby swiezo nadanej paczce nr 2
  // pierwsze odpytanie.
  it('dławik godzinowy działa osobno dla każdej paczki, także przy dwóch kurierach', async () => {
    const swiezo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const id = zPaczka(2108, { kurier: 'dpd', numerListu: NUMER_DPD, kolejnosc: 1 });
    db.prepare('UPDATE przesylki SET status_kuriera_pobrany_at = ? WHERE zamowienie_id = ?').run(swiezo, id);
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)'
      + " VALUES (?, 'inpost', 'nadana', ?, 2, '2026-07-29T13:30:00')",
    ).run(id, NUMER_INPOST);

    const dpd = atrapa('W doręczeniu');
    const inpost = atrapa('Gotowa do odbioru w paczkomacie');
    await otworzKarte(id, { dpd, inpost });

    // Paczka DPD sprawdzona przed chwila — nie pytamy ponownie.
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
    // ...a swiezo nadany paczkomat pytamy, bo to JEGO wiersz decyduje.
    expect(inpost.statusPrzesylki).toHaveBeenCalledWith(NUMER_INPOST, expect.any(Object));
  });

  // Link do sledzenia na karcie tez idzie po kurierze przesylki.
  it('numer paczkomatu jest klikalny i prowadzi do śledzenia InPostu', async () => {
    const id = zPaczka(2109, { kurier: 'inpost', numerListu: NUMER_INPOST });
    const r = await otworzKarte(id, { inpost: atrapa('Gotowa do odbioru w paczkomacie') });
    expect(r.body).toContain(`https://inpost.pl/sledzenie-przesylek?number=${NUMER_INPOST}`);
    expect(r.body).not.toContain('tracktrace.dpd.com.pl');
  });

  // Kurier, ktorego panel nie zna (wiersz z przyszlej integracji albo z importu) nie ma
  // kogo zapytac — i to tez ma byc cisza, a nie wybor „domyslnego" kuriera. Kolumna
  // `przesylki.kurier` jest NOT NULL, wiec pusty wiersz nie istnieje; nieznana nazwa istniec
  // moze i wlasnie ona jest tu przypadkiem brzegowym.
  it('nieznany kurier nie jest przypisywany do żadnego domyślnego', async () => {
    const id = zPaczka(2110, { kurier: 'gls', numerListu: 'X-OBCY-KURIER' });

    const dpd = atrapa('W doręczeniu');
    const inpost = atrapa('Gotowa do odbioru');
    const r = await otworzKarte(id, { dpd, inpost });

    expect(r.statusCode).toBe(200);
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
    expect(inpost.statusPrzesylki).not.toHaveBeenCalled();
  });
});

// ——— KOD ZDARZENIA W BAZIE (25.08.2026) ————————————————————————————————————————————
// Allegro jako jedyny kurier oddaje wartosc MASZYNOWA (`code`) obok opisu, ktory jest
// TLUMACZENIEM. Etap liczy sie z wiersza przy KAZDYM renderowaniu, wiec kod musi PRZETRWAC
// ZAPIS — inaczej klasyfikacja spada z powrotem na tekst, ktory Allegro zmieni bez pytania.
//
// ⚠️ TEN TEST POWSTAL PO MUTACJI, KTORA PRZEZYLA: zapis okrojony do `{ opis, at }` nie
// wywalal niczego w calej suicie, a etap po cichu wracalby do dopasowania po opisie.
describe('kod zdarzenia przezywa zapis', () => {
  const zPaczkaAllegro = (zrodloId) => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(zrodloId), {});
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, carrier_allegro, utworzona_at)'
      + " VALUES (?, 'allegro', 'nadana', 'A005DUH6H5', 1, 'ALLEGRO', '2026-07-29T13:00:00')",
    ).run(id);
    return id;
  };

  it('odswiezenie zapisuje kod obok opisu i czasu', async () => {
    const id = zPaczkaAllegro(7301);
    const allegro = {
      statusPrzesylki: vi.fn().mockResolvedValue({
        opis: 'Przesyłka została doręczona', at: '2026-08-21T04:50:56.734Z', kod: 'DELIVERED',
      }),
    };

    await otworzKarte(id, { allegro });

    const w = db.prepare("SELECT * FROM przesylki WHERE numer_listu = 'A005DUH6H5'").get();
    expect(w.status_kuriera_kod).toBe('DELIVERED');
    expect(w.status_kuriera).toBe('Przesyłka została doręczona');
  });

  // ⚠️ KOD ZAPISYWANY TAKZE JAKO NULL. DPD i InPost kodow nie oddaja; zapis warunkowy
  // („pisz kod tylko, gdy jest") zostawilby STARY kod przy NOWYM opisie — paczka, ktora raz
  // oddala DELIVERED, wisialaby jako doreczona mimo zdarzenia mowiacego co innego.
  it('kurier bez kodu CZYSCI stary kod, zamiast go zostawic', async () => {
    const id = zPaczkaAllegro(7302);
    db.prepare("UPDATE przesylki SET status_kuriera_kod = 'DELIVERED' WHERE zamowienie_id = ?").run(id);
    const allegro = {
      statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Przesyłka odebrana przez Kuriera', at: '2026-08-22T09:00:00.000Z' }),
    };

    await otworzKarte(id, { allegro });

    const w = db.prepare("SELECT * FROM przesylki WHERE numer_listu = 'A005DUH6H5'").get();
    expect(w.status_kuriera_kod).toBe(null);
  });
});
