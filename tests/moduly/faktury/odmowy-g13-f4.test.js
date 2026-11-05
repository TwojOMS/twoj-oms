import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapewnijOkres, pobierzOkres, zamknijOkres } from '../../../src/oms/db/okresy.js';
import { dodajWplateOkresu, wplatyOkresu } from '../../../src/oms/db/platnosci.js';
import { GDZIE_KLUCZ_INFAKTU } from '../../../src/domena/konfiguracja-infakt.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

// PRZ-152.G13f4: odmowy okresów rozliczeniowych (src/moduly/faktury/trasy/okresy.js) w układzie OMS.
// Status i tekst odmowy bez zmian — zmienia się tylko opakowanie (strona z paskiem uwagi i powrotem
// na ekran okresu; gdy okresu nie ma — na listę okresów). Każda odmowa nic nie zapisuje.
const naglowek = {
  authorization: 'Basic ' + Buffer.from('operator:x').toString('base64'),
  origin: 'http://localhost',
};
const config = { auth: { user: 'operator', pass: 'x' } };
const KLIENT = {
  klucz: 'polcien', nazwa: 'Pracownia Półcień sp. z o.o.', nip: '1234500011',
  rabat_procent: 10, prog_darmowej_dostawy_gr: 30000, oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
};
const TECHNICZNY = 'błąd techniczny panelu — szczegóły w logu zamówienia.';

// Ten sam zestaw znaków, który EJS zamienia w `<%= %>`.
const esc = (s) => s.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&#34;' })[c]);

let db, app, okres, infakt;

beforeEach(async () => {
  // Żadna odmowa nie ma prawa sięgnąć sieci (inFakt) — fetch rzuca.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('test: sieć zablokowana'); }));
  db = openOmsDb(':memory:');
  dopiszKlientaZbiorczego(db, KLIENT);
  okres = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 7 });
  infakt = {
    znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
    zalozKlienta: vi.fn(),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'FV/7/2026', ksefStatus: null }),
  };
  app = buildOmsServer({ db, config, infakt });
  await app.ready();
});
afterEach(async () => { await app?.close(); db?.close(); vi.unstubAllGlobals(); app = db = null; });

const post = (url, payload, serwer = app) => serwer.inject({ method: 'POST', url, headers: naglowek, payload });

function dodajZamowienie(numer, kwota = '104.00') {
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', ?, ?, ?, ?, '2026-07-10T10:00:00.000Z')",
  ).run(Number(numer.replace(/\D/g, '')), numer, kwota, okres.id);
  const id = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get(numer).id;
  db.prepare(
    "INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo) VALUES (?, 'Szablon A4', 1, ?, ?, 'reczna')",
  ).run(id, kwota, kwota);
  return id;
}

// Stan pieniędzy okresu i jego zamówień — do porównania przed i po odmowie.
const stanBazy = () => JSON.stringify({
  okresy: db.prepare('SELECT * FROM okresy_rozliczeniowe ORDER BY id').all(),
  wplaty: db.prepare('SELECT * FROM platnosci_okresu ORDER BY id').all(),
  zamowienia: db.prepare('SELECT id, okres_rozliczeniowy_id, zmienione_at FROM zamowienia ORDER BY id').all(),
});

function oczekujOdmowy(r, { status, tekst, tytul, wroc, napisWroc }) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${esc(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${esc(tytul)}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">${napisWroc}</a>`);
}
const naOkres = (tytul, tekst, status = 400) => ({
  status, tekst, tytul, wroc: `/okresy/${encodeURIComponent(okres.id)}`, napisWroc: 'Wróć do okresu',
});

describe('okres nie istnieje (404) → powrót na listę okresów', () => {
  const brak = {
    status: 404, tekst: 'Nie ma takiego okresu rozliczeniowego.', tytul: 'Nie ma takiego okresu',
    wroc: '/okresy', napisWroc: 'Wróć do listy okresów',
  };
  it('GET /okresy/999', async () => {
    oczekujOdmowy(await app.inject({ method: 'GET', url: '/okresy/999', headers: naglowek }), brak);
  });
  it('POST /okresy/999/wplata — nic nie zapisuje', async () => {
    const przed = stanBazy();
    oczekujOdmowy(await post('/okresy/999/wplata', { kwota: '10.00', metoda: 'przelew' }), brak);
    expect(stanBazy()).toBe(przed);
  });
});

describe('POST /okresy/:id/wystaw-fakture', () => {
  it('bez programu fakturowego → 503', async () => {
    const bez = buildOmsServer({ db, config });
    await bez.ready();
    try {
      oczekujOdmowy(await post(`/okresy/${okres.id}/wystaw-fakture`, undefined, bez), naOkres(
        'Nie udało się wystawić faktury za okres',
        `inFakt nie jest skonfigurowany — faktury z panelu nie wystawisz. ${GDZIE_KLUCZ_INFAKTU}`, 503,
      ));
    } finally { await bez.close(); }
  });

  it('klient okresu spoza kartoteki → 400 z kluczem', async () => {
    okres = zapewnijOkres(db, { klientKlucz: 'nieznany', rok: 2026, miesiac: 7 });
    oczekujOdmowy(await post(`/okresy/${okres.id}/wystaw-fakture`), naOkres(
      'Nie udało się wystawić faktury za okres',
      'Okres należy do klienta „nieznany", którego nie ma w konfiguracji '
      + '(OMS_KLIENCI_ZBIORCZY) — bez NIP-u panel nie wskaże nabywcy faktury.',
    ));
  });

  it('program fakturowy rzuca → 400, faktury w bazie brak', async () => {
    dodajZamowienie('R/2026/001');
    infakt.wystaw.mockRejectedValueOnce(new Error('zerwane połączenie'));
    oczekujOdmowy(await post(`/okresy/${okres.id}/wystaw-fakture`), naOkres(
      'Nie udało się wystawić faktury za okres', `Nie udało się wystawić faktury za okres: ${TECHNICZNY}`,
    ));
    expect(pobierzOkres(db, okres.id).numer).toBeNull();
  });
});

describe('POST /okresy/:id/faktura/odblokuj', () => {
  it('okres bez zablokowanej faktury → 400, nic się nie zmienia', async () => {
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/faktura/odblokuj`), naOkres(
      'Nie udało się odblokować faktury okresu',
      'Nie udało się odblokować faktury okresu: Ten okres nie ma zablokowanej faktury — nie ma czego odblokowywać.',
    ));
    expect(stanBazy()).toBe(przed);
  });
});

describe('POST /okresy/:id/zamknij i /otworz', () => {
  it('zamknięcie okresu już zamkniętego → 400', async () => {
    zamknijOkres(db, okres.id);
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/zamknij`), naOkres(
      'Nie udało się zamknąć okresu', 'Ten okres nie jest otwarty (stan: zamkniety) — nie ma czego zamykać.',
    ));
    expect(stanBazy()).toBe(przed);
  });

  it('otwarcie okresu otwartego → 400', async () => {
    oczekujOdmowy(await post(`/okresy/${okres.id}/otworz`), naOkres(
      'Nie udało się otworzyć okresu', 'Ten okres jest już otwarty — nie ma czego otwierać.',
    ));
  });

  it('otwarcie okresu z fakturą → 400, faktura nietknięta', async () => {
    dodajZamowienie('R/2026/001');
    expect((await post(`/okresy/${okres.id}/wystaw-fakture`)).statusCode).toBe(302);
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/otworz`), naOkres(
      'Nie udało się otworzyć okresu',
      'Ten okres ma fakturę (stan: wystawiona) — FV/7/2026, '
      + 'więc panel go nie otworzy: nowe zamówienia wypadłyby poza dokument, który klient '
      + 'już dostał. Jeśli faktura się nie udała i wiesz, że w inFakcie jej NIE MA — użyj '
      + '„Sprawdziłem w inFakcie — faktury nie ma, odblokuj". Jeśli jest, zostaje korekta.',
    ));
    expect(stanBazy()).toBe(przed);
  });
});

describe('POST /okresy/:id/wplata', () => {
  it('brak kwoty → 400, BEZ zapisu wpłaty', async () => {
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/wplata`, { metoda: 'przelew' }), naOkres(
      'Nie udało się dopisać wpłaty', 'Podaj kwotę wpłaty — bez niej nie ma czego dopisać.',
    ));
    expect(stanBazy()).toBe(przed);
    expect(wplatyOkresu(db, okres.id)).toHaveLength(0);
  });

  it('baza odmawia zapisu → 400 z komunikatem technicznym, BEZ zapisu', async () => {
    db.exec("CREATE TRIGGER test_blokada BEFORE INSERT ON platnosci_okresu BEGIN SELECT RAISE(ABORT, 'test'); END");
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/wplata`, { kwota: '50,00', metoda: 'przelew' }), naOkres(
      'Nie udało się dopisać wpłaty', TECHNICZNY,
    ));
    expect(stanBazy()).toBe(przed);
  });
});

describe('POST /okresy/:id/wplata/:platnoscId/usun', () => {
  it('wpłata z innego okresu → 400, cudza wpłata zostaje', async () => {
    const inny = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 6 });
    dodajWplateOkresu(db, inny.id, { kwota: '500.00', data: '2026-07-01', metoda: 'przelew' });
    const cudza = wplatyOkresu(db, inny.id)[0];
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/wplata/${cudza.id}/usun`), naOkres(
      'Nie udało się usunąć wpłaty', 'Nie ma takiej wpłaty przy tym okresie rozliczeniowym.',
    ));
    expect(stanBazy()).toBe(przed);
  });
});

describe('POST /okresy/:id/zamowienia/:zamId/odepnij', () => {
  it('okres z fakturą → 400, zamówienie zostaje w okresie', async () => {
    const zamId = dodajZamowienie('R/2026/001');
    expect((await post(`/okresy/${okres.id}/wystaw-fakture`)).statusCode).toBe(302);
    const przed = stanBazy();
    oczekujOdmowy(await post(`/okresy/${okres.id}/zamowienia/${zamId}/odepnij`), naOkres(
      'Nie udało się odpiąć zamówienia',
      'Za ten okres jest już faktura — dokument opiewa na tę listę zamówień, '
      + 'więc odpięcie zmieniłoby jego podstawę. To sprawa dla korekty w inFakcie, nie dla panelu.',
    ));
    expect(stanBazy()).toBe(przed);
  });

  it('zamówienie spoza okresu → 400', async () => {
    oczekujOdmowy(await post(`/okresy/${okres.id}/zamowienia/9999/odepnij`), naOkres(
      'Nie udało się odpiąć zamówienia', 'To zamówienie nie należy do tego okresu rozliczeniowego.',
    ));
  });
});
