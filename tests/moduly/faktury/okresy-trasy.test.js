import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapewnijOkres, pobierzOkres, zamknijOkres } from '../../../src/oms/db/okresy.js';
import { dodajWplateOkresu, wplatyOkresu } from '../../../src/oms/db/platnosci.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

// Ta sama para naglowkow, co w pozostalych testach tras (web-platnosci.test.js): Basic Auth
// panelu i `origin`, bez ktorego ochrona CSRF slusznie odbija kazdy POST.
const naglowek = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost',
};

const KLIENT = {
  klucz: 'zetaklient', nazwa: 'Zetaklient sp. z o.o.', nip: '1000001017',
  rabat_procent: 10, prog_darmowej_dostawy_gr: 30000,
  oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
};
const config = { auth: { user: 'adam', pass: 'x' } };

const infaktUdany = () => ({
  znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
  zalozKlienta: vi.fn(),
  wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'FV/7/2026', ksefStatus: null }),
});

let db;
let okres;
let infakt;
let app;

// ⚠️ ASERCJE O PIENIADZACH CELUJA W BLOK SALDA, A NIE W CALE CIALO ODPOWIEDZI.
// Poprzednia wersja testu zaliczki sprawdzala `body).toMatch(/zaliczk/i)` — a to lapie
// PLACEHOLDER formularza wplaty („uwaga (np. zaliczka za sierpień)"), obecny na KAZDYM
// renderze karty, takze dla okresu bez ani jednej wplaty. Zmutowane: po wylaczeniu galezi
// `stan === 'niezafakturowany'` w okres.ejs karta pokazywala zaliczke jako „NADPŁATA
// 5000.00 zł", a test dalej przechodzil. Blok salda jest jedynym miejscem, w ktorym panel
// te pieniadze NAZYWA — i tylko tam ta asercja cokolwiek znaczy.
const blokSalda = (body) => {
  const m = body.match(/<div class="saldo[^"]*">[\s\S]*?<\/div>/);
  if (!m) throw new Error('Karta okresu nie ma bloku salda — nie ma czego sprawdzać.');
  return m[0];
};

// Wiersz „Razem do zafakturowania" — ostatnia liczba, ktora operator widzi przed
// kliknieciem nieodwracalnym.
const wierszRazem = (body) => {
  const m = body.match(/<tr class="wiersz-razem">[\s\S]*?<\/tr>/);
  if (!m) throw new Error('Karta okresu nie ma wiersza „Razem" — nie ma czego sprawdzać.');
  return m[0];
};

// ⚠️ WIERSZ KONKRETNEGO ZAMOWIENIA, nie cale cialo odpowiedzi: arkusz stylow jedzie
// w <style> ukladu, wiec `body).toMatch(/anulowane/i)` lapie regule `.znacznik--anulowane`
// i przechodzi nawet dla tabeli, w ktorej nic nie jest oznaczone (sprawdzone — przechodzil).
const wierszZamowienia = (body, numer) => {
  const wiersz = body.split('<tr').find((w) => w.includes(`>${numer}<`));
  if (!wiersz) throw new Error(`Tabela nie ma wiersza zamówienia ${numer}.`);
  return wiersz.split('</tr>')[0];
};

// Zamowienie okresu z jedna pozycja — kwota zamowienia rowna wartosci pozycji, zeby bariera
// arytmetyczna faktury (services/faktura-okresu.js) przepuszczala okres bez ceregieli.
function dodajZamowienie({ numer, kwota, okresId = okres.id, anulowane = 0 }) {
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, anulowane, utworzone_at)'
    + " VALUES ('reczne', ?, ?, ?, ?, ?, '2026-07-10T10:00:00.000Z')",
  ).run(Number(String(numer).replace(/\D/g, '')), numer, kwota, okresId, anulowane ? 1 : 0);
  const id = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get(numer).id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'STOP 70x100', 1, ?, ?, 'reczna')",
  ).run(id, kwota, kwota);
  return id;
}

beforeEach(async () => {
  db = openOmsDb();
  // ⚠️ NABYWCA FAKTURY ZBIORCZEJ IDZIE OD 24.08.2026 Z KARTY KLIENTA (`klientOkresu`),
  // a nie z konfiguracji — bez tego wiersza karta okresu nie zna ani nazwy, ani NIP-u.
  dopiszKlientaZbiorczego(db, KLIENT);
  okres = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
  infakt = infaktUdany();
  app = buildOmsServer({ db, config, infakt });
  await app.ready();
});

const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

describe('GET /okresy (lista okresów)', () => {
  it('odpowiada 200 i pokazuje miesiąc oraz klienta', async () => {
    const odp = await get('/okresy');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(/2026/);
    expect(odp.body).toContain('Zetaklient sp. z o.o.');
    expect(odp.body).toContain(`/okresy/${okres.id}`);
  });

  // Ekran bez wejscia to ekran, ktorego nikt nie znajdzie: pasek gorny jest jedyna
  // nawigacja panelu, wiec bez tej ikony trasy /okresy istnialyby wylacznie dla kogos,
  // kto zna adres.
  it('pasek górny prowadzi na listę okresów', async () => {
    const odp = await get('/');
    expect(odp.body).toContain('href="/okresy"');
  });

  it('pusta lista mówi, że jest pusta — a nie wygląda na ekran, który się nie wczytał', async () => {
    const czysta = openOmsDb();
    const pusty = buildOmsServer({ db: czysta, config, infakt });
    await pusty.ready();
    const odp = await pusty.inject({ method: 'GET', url: '/okresy', headers: naglowek });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(/Nie ma jeszcze/);
  });
});

describe('GET /okresy/:id (karta okresu)', () => {
  it('karta nieistniejącego okresu to 404, a nie 500', async () => {
    const odp = await get('/okresy/999');
    expect(odp.statusCode).toBe(404);
  });

  it('pokazuje zamówienia okresu i kwotę faktury liczoną z sumy oczekiwanej', async () => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    dodajZamowienie({ numer: 'R/2026/002', kwota: '58.90' });
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('R/2026/001');
    expect(odp.body).toContain('R/2026/002');
    expect(odp.body).toContain('162.90');
  });

  // ⚠️ Metoda wplaty okresu WYMAGANA (audyt 22.08) — ten sam slownik, co formularz na
  // karcie zamowienia, zeby wyciag uzgadnial sie po jednym jezyku takze przy zbiorczych.
  it('formularz wplaty okresu ma WYMAGANE pole wyboru metody z opcjami slownika', async () => {
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toMatch(/<select name="metoda" required/);
    expect(odp.body).toContain('>Przelew<');
    expect(odp.body).toContain('>BLIK<');
  });

  // ⚠️ SEDNO PUNKTU B RECENZJI: dodatnie saldo PRZED faktura to ZALICZKA, a nie nadplata
  // do zwrotu. Widok czyta `stan`, nie znak liczby. `saldoGr: +500000` przy pustej fakturze
  // to zaliczka, `+499901` po fakturze to nadplata do zwrotu — obie dodatnie, rozni je
  // WYLACZNIE `stan`. Asercje ida w blok salda (patrz `blokSalda` wyzej), bo tylko tam
  // panel te pieniadze nazywa.
  it('wpłata przed fakturą to ZALICZKA, nie „nadpłata do zwrotu”', async () => {
    dodajWplateOkresu(db, okres.id, { kwota: '5000.00', data: '2026-07-05' });
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.statusCode).toBe(200);
    const saldo = blokSalda(odp.body);
    expect(saldo).toContain('5000.00');
    expect(saldo).toMatch(/zaliczka 5000\.00 zł/);
    expect(saldo).toMatch(/faktury za ten miesiąc jeszcze nie ma/);
    expect(saldo).not.toMatch(/NADPŁATA/);
    expect(saldo).not.toMatch(/NIEDOPŁATA/);
    expect(saldo).not.toMatch(/rozliczone co do grosza/);
    expect(odp.body).not.toMatch(/zwrócić klientowi/);
  });

  it('faktura wystawiona bez wpłaty → NIEDOPŁATA i stan faktury z kolumn, nie z salda', async () => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain('FV/7/2026');
    expect(odp.body).toMatch(/NIEDOPŁATA/);
  });

  // ⚠️ PUNKT C RECENZJI: uszkodzona kwota wplaty nie ma prawa wywalic ekranu okresu,
  // ale MA sie pokazac jako blad — nigdy jako ciche „wszystko gra".
  it('uszkodzona kwota wpłaty → karta się otwiera i mówi o błędzie, nie 500', async () => {
    db.prepare(
      'INSERT INTO platnosci_okresu (okres_rozliczeniowy_id, kwota, data, zrodlo, utworzona_at)'
      + " VALUES (?, 'undefined', '2026-07-05', 'reczna', '2026-07-05T10:00:00.000Z')",
    ).run(okres.id);
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.statusCode).toBe(200);
    expect(odp.body).not.toMatch(/Internal Server Error/);
    expect(odp.body).toMatch(/nie da się policzyć/i);
  });
});

// ⚠️ DOMKNIECIE 1 (recenzja Zadania 9, runda 2): karta zaprzeczala sama sobie — sekcja
// „Faktura za okres" pokazywala numer FV, a blok salda ponizej pisal, ze faktury nie ma
// (albo kazal zwracac pieniadze, ktorych nikt nie oddal). Wyzwalaczem NIE jest czlowiek:
// klient dropshippingowy anuluje zamowienia po zamknieciu miesiaca rutynowo, a `anulowane`
// jest faktem sklepu odswiezanym przez poller co dwie minuty (db/zamowienia.js) — liczby
// przestawiaja sie same, juz PO wystawieniu dokumentu. Oba scenariusze nizej odtwarzaja
// dokladnie ta kolejnosc: NAJPIERW faktura (zamowienia aktywne), POTEM anulowanie
// (bezposredni UPDATE, tak jak zrobilby to poller), a nie odwrotnie.
describe('GET /okresy/:id — anulowanie PO wystawieniu faktury nie ma prawa zaprzeczać karcie', () => {
  const anulujPoFakturze = (numer) => db.prepare('UPDATE zamowienia SET anulowane = 1 WHERE numer = ?').run(numer);

  // Wariant (a) z recenzji: faktura wystawiona na 140,00 (oba zamowienia aktywne), klient
  // placi dokladnie 140,00 — rozliczone co do grosza. DOPIERO POTEM jedno z zamowien
  // anuluje sie samo. Suma liczona NA DZIS spada do 100,00, wiec naiwne porownanie
  // (140,00 wplaty kontra 100,00 „dzis") wygladaloby na 40 zl nadplaty do zwrotu —
  // a klient nie ma nic do odzyskania, zaplacil dokladnie tyle, ile wtedy wynosila faktura.
  it('(a) faktura + częściowe anulowanie PO wystawieniu → karta NIE mówi „nadpłata do zwrotu”', async () => {
    dodajZamowienie({ numer: 'R/2026/101', kwota: '100.00' });
    dodajZamowienie({ numer: 'R/2026/102', kwota: '40.00' });
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    dodajWplateOkresu(db, okres.id, { kwota: '140.00', data: '2026-08-01' });

    anulujPoFakturze('R/2026/102');

    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain('FV/7/2026');
    const saldo = blokSalda(odp.body);
    expect(saldo).not.toMatch(/NADPŁATA/);
    expect(odp.body).not.toMatch(/zwrócić klientowi/);
    expect(saldo).toMatch(/do wyjaśnienia/);
  });

  // Wariant (b) z recenzji, wprost zmierzony: faktura wystawiona (1 zamowienie, 104,00),
  // klient wplaca zaliczkowo 100,00. DOPIERO POTEM jedyne zamowienie okresu anuluje sie
  // samo — suma aktywnych spada do zera, a `rozliczenie.stan` klamliwie wraca do
  // „niezafakturowany”. Zmierzone przed poprawka: „zaliczka 100.00 zł — faktury za ten
  // miesiąc jeszcze nie ma” obok numeru FV wyzej na tym samym ekranie.
  it('(b) faktura + wszystkie zamówienia anulowane PO wystawieniu → karta NIE mówi „faktury jeszcze nie ma”', async () => {
    dodajZamowienie({ numer: 'R/2026/201', kwota: '104.00' });
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    dodajWplateOkresu(db, okres.id, { kwota: '100.00', data: '2026-08-01' });

    anulujPoFakturze('R/2026/201');

    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain('FV/7/2026');
    const saldo = blokSalda(odp.body);
    expect(saldo).not.toMatch(/faktury za ten miesiąc jeszcze nie ma/);
    expect(saldo).not.toMatch(/brak faktury/);
    expect(saldo).toMatch(/do wyjaśnienia/);
  });
});

// ⚠️ ZNALEZISKO KRYTYCZNE RECENZJI ZADANIA 9: ekran obiecywal INNA KWOTE, niz szla na
// fakture. `daneOkresu` liczylo z WSZYSTKICH zamowien okresu, a `services/faktura-okresu.js`
// odfiltrowuje anulowane — wiec karta mowila „Razem do zafakturowania 140.00 zł", a do
// inFaktu szlo 100,00. Rozjazd zatruwal wszystko, co z tej liczby wynika: falszywa
// NIEDOPLATE przy zaplacie co do grosza i — najgorsze — CISZE przy nadplacie, czyli
// pieniadze klienta schowane przed jedynym ekranem, na ktorym ktokolwiek je widzi.
//
// Uklad wszystkich scenariuszy jest ten sam: 100,00 aktywne + 40,00 anulowane.
describe('GET /okresy/:id — zamówienie ANULOWANE poza sumą, ale widoczne', () => {
  beforeEach(() => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '100.00' });
    dodajZamowienie({ numer: 'R/2026/002', kwota: '40.00', anulowane: 1 });
  });

  it('„Razem do zafakturowania” = kwota, która NAPRAWDĘ pójdzie na fakturę', async () => {
    const odp = await get(`/okresy/${okres.id}`);
    expect(wierszRazem(odp.body)).toContain('100.00');
    expect(wierszRazem(odp.body)).not.toContain('140.00');

    // Kontrola krzyzowa: ta sama liczba po obu stronach nieodwracalnego kliknięcia.
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const { services } = infakt.wystaw.mock.calls[0][0];
    expect(services.reduce((a, s) => a + s.gross_price, 0)).toBe(10000);
  });

  // Wiersz MA zostac na ekranie — inaczej operator widzi na sklepie zamowienie, ktorego
  // na karcie miesiaca nie ma wcale, i nie ma jak sprawdzic, czemu go nie ma w „Razem".
  it('anulowane zamówienie zostaje w tabeli i jest oznaczone', async () => {
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain('R/2026/001');
    expect(odp.body).toContain('R/2026/002');
    expect(wierszZamowienia(odp.body, 'R/2026/002')).toMatch(/anulowane/i);
    expect(wierszZamowienia(odp.body, 'R/2026/001')).not.toMatch(/anulowane/i);
  });

  it('wpłata równa kwocie faktury → rozliczone, a nie fałszywa NIEDOPŁATA', async () => {
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    dodajWplateOkresu(db, okres.id, { kwota: '100.00', data: '2026-08-01' });
    const saldo = blokSalda((await get(`/okresy/${okres.id}`)).body);
    expect(saldo).toMatch(/rozliczone co do grosza/);
    expect(saldo).not.toMatch(/NIEDOPŁATA/);
  });

  // ⚠️ ZADEN STAN NIE CHOWA PIENIEDZY KLIENTA — ale gdy w okresie jest zamowienie
  // anulowane I faktura juz istnieje, panel NIE MOZE odroznic prawdziwej nadplaty od
  // artefaktu: `rozliczenie.kwotaFakturyZl` liczy sie z aktywnych zamowien NA DZIS, a nie
  // z migawki tego, co poszlo do inFaktu, wiec te same 40 zl znaczylyby „nadplata do
  // zwrotu" zarowno wtedy, gdy zamowienie R/2026/002 bylo anulowane PRZED wystawieniem
  // (tak jak tu — faktura naprawde jest na 100,00, 140,00 to realna naddplata), jak
  // i wtedy, gdy zostalo anulowane PO wystawieniu (naprawde wystawiono na 140,00, a 140,00
  // wplaty to dokladna zaplata). Panel schematu nie rozroznia tych dwoch sytuacji (patrz
  // DOMKNIECIE 1 w web/views/okres.ejs), wiec — zeby nie ryzykowac falszywego „oddaj
  // pieniadze klientowi" w drugim przypadku — obie galezie pokazuja ten sam uczciwy
  // komunikat „do wyjaśnienia", a NIE definitywna „NADPŁATA ... zwrócić klientowi".
  it('faktura + zamówienie anulowane w okresie → „do wyjaśnienia", NIE „NADPŁATA ... zwrócić"', async () => {
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    dodajWplateOkresu(db, okres.id, { kwota: '140.00', data: '2026-08-01' });
    const odp = await get(`/okresy/${okres.id}`);
    const saldo = blokSalda(odp.body);
    expect(saldo).toMatch(/do wyjaśnienia/);
    expect(saldo).not.toMatch(/NADPŁATA/);
    expect(saldo).not.toMatch(/rozliczone co do grosza/);
    expect(odp.body).not.toMatch(/zwrócić klientowi/);
    expect(odp.body).toMatch(/korekty w inFakcie/);
  });

  // Sytuacja BEZ zadnego anulowanego zamowienia w okresie: „dzis" == „przy wystawieniu",
  // wiec nadplata JEST prawdziwa i karta ma prawo kazac ja sprawdzic do zwrotu.
  it('faktura BEZ żadnego anulowanego zamówienia + nadpłata → prawdziwa „NADPŁATA ... zwrócić"', async () => {
    const inny = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 8 });
    db.prepare(
      'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, anulowane, utworzone_at)'
      + " VALUES ('reczne', 501, 'R/2026/501', '100.00', ?, 0, '2026-08-10T10:00:00.000Z')",
    ).run(inny.id);
    const id = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/501').id;
    db.prepare(
      'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
      + " VALUES (?, 'STOP 70x100', 1, '100.00', '100.00', 'reczna')",
    ).run(id);

    await post(`/okresy/${inny.id}/wystaw-fakture`);
    dodajWplateOkresu(db, inny.id, { kwota: '140.00', data: '2026-09-01' });
    const odp = await get(`/okresy/${inny.id}`);
    const saldo = blokSalda(odp.body);
    expect(saldo).toMatch(/NADPŁATA 40\.00 zł/);
    expect(odp.body).toMatch(/zwrócić klientowi/);
  });

  // Lista i karta licza z tego samego zbioru — inaczej operator dostaje trzecia kwote.
  it('lista okresów pokazuje tę samą kwotę co karta', async () => {
    const odp = await get('/okresy');
    expect(odp.body).toContain('100.00');
    expect(odp.body).not.toContain('140.00');
  });
});

// ⚠️ TO JEST EKRAN, NA KTORYM DRUGIE KLIKNIECIE ZNACZY DRUGA FAKTURA — a stan faktury
// nie mial ani jednej asercji. Recenzent podmienil `stanFakturyOkresu(okres)` na naiwne
// `okres.numer ? 'wystawiona' : 'brak'` i wszystkie 26 testow przeszlo.
describe('GET /okresy/:id — stan faktury sterujący przyciskiem wystawienia', () => {
  beforeEach(() => dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' }));

  it('okres bez faktury: przycisk „Wystaw fakturę”, żadnej blokady', async () => {
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain(`/okresy/${okres.id}/wystaw-fakture`);
    expect(odp.body).not.toMatch(/DO WYJAŚNIENIA/);
    expect(odp.body).not.toMatch(/FAKTURA ZAWIESZONA/);
  });

  it('okres zafakturowany: numer faktury i ŻADNEGO przycisku wystawienia', async () => {
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain('FV/7/2026');
    expect(odp.body).not.toContain('/wystaw-fakture');
  });

  // ⚠️ NAJGROZNIEJSZY UKLAD: inFakt oddal uuid, ale BEZ numeru (realne — `zapytaj`
  // degraduje kazde 2xx z nieczytelnym cialem). Kolumna `numer` jest wtedy pusta, wiec
  // stan wnioskowany z samego numeru czytalby zafakturowany okres jako „brak" i panel
  // podstawialby operatorowi przycisk „Wystaw fakturę” pod dokumentem, ktory JUZ istnieje.
  it('zafakturowany BEZ numeru w odpowiedzi dalej blokuje wystawienie', async () => {
    infakt.wystaw.mockResolvedValueOnce({ uuid: 'u-9', numer: null, ksefStatus: null });
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toMatch(/faktura wystawiona/);
    expect(odp.body).not.toContain('/wystaw-fakture');
  });

  it('okres „do wyjaśnienia”: blokada i odblokowanie, a NIE „Wystaw fakturę”', async () => {
    infakt.wystaw.mockRejectedValueOnce(new Error('zerwane połączenie'));
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toMatch(/FAKTURA DO WYJAŚNIENIA/);
    expect(odp.body).toContain(`/okresy/${okres.id}/faktura/odblokuj`);
    expect(odp.body).not.toContain('/wystaw-fakture');
  });

  it('lista okresów też czyta stan faktury, a nie samą kolumnę numeru', async () => {
    infakt.wystaw.mockRejectedValueOnce(new Error('zerwane połączenie'));
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await get('/okresy');
    expect(odp.body).toMatch(/DO WYJAŚNIENIA/);
  });
});

// ⚠️ DOMKNIECIE 3 (recenzja Zadania 9, runda 2): przycisk „Wystaw fakturę" na okresie bez
// ani jednego zamowienia do zafakturowania kusil do klikniecia, o ktorym z gory wiadomo,
// ze sie nie uda (bariera arytmetyczna w services/faktura-okresu.js i tak odmawia —
// zmierzone: `infakt.wystaw` nie jest wolany, wiec bezpiecznie, ale mylaco). Bariera
// zostaje NIETKNIETA — te testy sprawdzaja WYLACZNIE, ze przycisk znika i ekran mowi
// czlowiekowi, dlaczego.
describe('GET /okresy/:id — przycisk „Wystaw fakturę" znika, gdy nie ma czego fakturować', () => {
  it('okres z samymi anulowanymi zamówieniami: bez przycisku, z wyjaśnieniem', async () => {
    dodajZamowienie({ numer: 'R/2026/301', kwota: '104.00', anulowane: 1 });
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).not.toContain('/wystaw-fakture');
    expect(odp.body).toMatch(/Nie ma czego zafakturować/);
    expect(odp.body).toMatch(/wszystkie 1 zamówień tego okresu są anulowane/);
  });

  it('okres bez żadnego zamówienia: bez przycisku, z wyjaśnieniem', async () => {
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).not.toContain('/wystaw-fakture');
    expect(odp.body).toMatch(/Nie ma czego zafakturować/);
    expect(odp.body).toMatch(/ten okres nie ma jeszcze żadnego zamówienia/);
  });

  it('okres z choć jednym aktywnym zamówieniem: przycisk wraca', async () => {
    dodajZamowienie({ numer: 'R/2026/302', kwota: '104.00' });
    dodajZamowienie({ numer: 'R/2026/303', kwota: '40.00', anulowane: 1 });
    const odp = await get(`/okresy/${okres.id}`);
    expect(odp.body).toContain(`/okresy/${okres.id}/wystaw-fakture`);
  });
});

describe('POST /okresy/:id/wystaw-fakture', () => {
  it('woła inFakt i przekierowuje na kartę okresu', async () => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    const odp = await post(`/okresy/${okres.id}/wystaw-fakture`);
    expect(odp.statusCode).toBe(302);
    expect(odp.headers.location).toBe(`/okresy/${okres.id}`);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(pobierzOkres(db, okres.id).numer).toBe('FV/7/2026');
  });

  it('okres bez zamówień — bariera odmawia komunikatem dla człowieka, nie 500', async () => {
    const odp = await post(`/okresy/${okres.id}/wystaw-fakture`);
    expect(odp.statusCode).toBe(400);
    expect(odp.body).not.toMatch(/Internal Server Error/);
    expect(odp.body).toMatch(/pozycji/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('klient spoza konfiguracji → 400 z nazwą klucza', async () => {
    const obcy = zapewnijOkres(db, { klientKlucz: 'nieznany', rok: 2026, miesiac: 7 });
    const odp = await post(`/okresy/${obcy.id}/wystaw-fakture`);
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toContain('nieznany');
  });

  it('bez skonfigurowanego inFaktu → 503, a nie wywrotka', async () => {
    const bezInfaktu = buildOmsServer({ db, config });
    await bezInfaktu.ready();
    const odp = await bezInfaktu.inject({
      method: 'POST', url: `/okresy/${okres.id}/wystaw-fakture`, headers: naglowek,
    });
    expect(odp.statusCode).toBe(503);
  });

  it('nieistniejący okres → 404', async () => {
    expect((await post('/okresy/999/wystaw-fakture')).statusCode).toBe(404);
  });

  // Nieudana proba jest zdarzeniem, po ktorym ktos musi zajrzec do inFaktu — a wtedy
  // pierwszym pytaniem jest „kto to klikał". Odblokowanie loguje sie z nazwiskiem od
  // poczatku; ta sciezka nie miala go wcale.
  it('nieudana próba zostawia w logu operatora, nie samo „BŁĄD”', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    infakt.wystaw.mockRejectedValueOnce(new Error('zerwane połączenie'));
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const wpis = db.prepare(
      "SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'faktura-okresu' ORDER BY id DESC",
    ).get(id);
    expect(wpis.wynik).toMatch(/BŁĄD/);
    expect(wpis.wynik).toContain('adam');
  });
});

describe('POST /okresy/:id/zamknij i /otworz', () => {
  it('zamyka okres, a potem otwiera go z powrotem', async () => {
    expect((await post(`/okresy/${okres.id}/zamknij`)).statusCode).toBe(302);
    expect(pobierzOkres(db, okres.id).stan).toBe(STAN.ZAMKNIETY);

    expect((await post(`/okresy/${okres.id}/otworz`)).statusCode).toBe(302);
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.zamkniety_at).toBeNull();
  });

  it('zamknięcie okresu już zamkniętego → 400, bez przestemplowania daty', async () => {
    zamknijOkres(db, okres.id);
    const przed = pobierzOkres(db, okres.id).zamkniety_at;
    const odp = await post(`/okresy/${okres.id}/zamknij`);
    expect(odp.statusCode).toBe(400);
    expect(pobierzOkres(db, okres.id).zamkniety_at).toBe(przed);
  });

  // ⚠️ Otwarcie zafakturowanego okresu wpusciloby nowe zamowienia do miesiaca, za ktory
  // klient JUZ dostal fakture — i skasowaloby stan `zafakturowany`, czyli blokade drugiego
  // dokumentu. `otworzOkresPonownie` w bazie tego nie pilnuje, wiec pilnuje trasa.
  it('otwarcie ZAFAKTUROWANEGO okresu → 400, faktura zostaje nietknięta', async () => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await post(`/okresy/${okres.id}/otworz`);
    expect(odp.statusCode).toBe(400);
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.ZAFAKTUROWANY);
    expect(po.numer).toBe('FV/7/2026');
  });
});

describe('POST /okresy/:id/faktura/odblokuj', () => {
  it('zdejmuje blokadę „do wyjaśnienia” i otwiera okres', async () => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    infakt.wystaw.mockRejectedValueOnce(new Error('zerwane połączenie'));
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    expect(pobierzOkres(db, okres.id).ksef_status).toBe('do_wyjasnienia');

    const odp = await post(`/okresy/${okres.id}/faktura/odblokuj`);
    expect(odp.statusCode).toBe(302);
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBeNull();
    expect(po.stan).toBe(STAN.OTWARTY);
  });

  it('faktury wystawionej NIE odblokowuje → 400', async () => {
    dodajZamowienie({ numer: 'R/2026/001', kwota: '104.00' });
    await post(`/okresy/${okres.id}/wystaw-fakture`);
    const odp = await post(`/okresy/${okres.id}/faktura/odblokuj`);
    expect(odp.statusCode).toBe(400);
    expect(pobierzOkres(db, okres.id).numer).toBe('FV/7/2026');
  });
});

describe('POST /okresy/:id/wplata', () => {
  // ⚠️ PUNKT D RECENZJI: przecinek dziesietny to jest to, co czlowiek w Polsce wpisuje.
  // Baza przyjmuje wylacznie kropke, wiec kwota MUSI przejsc przez `parsujWplate`.
  it('przyjmuje kwotę z PRZECINKIEM i zapisuje ją znormalizowaną', async () => {
    const odp = await post(`/okresy/${okres.id}/wplata`, { kwota: '500,00', data: '2026-08-01', metoda: 'przelew' });
    expect(odp.statusCode).toBe(302);
    const wplaty = wplatyOkresu(db, okres.id);
    expect(wplaty).toHaveLength(1);
    // ⚠️ Ta sama regula, co przy wplacie do zamowienia: data wsteczna dostaje godzine zero.
    expect(wplaty[0]).toMatchObject({ kwota: '500.00', data: '2026-08-01T00:00:00', metoda: 'przelew' });
  });

  it('pusta data bierze bieżący czas — wpłaty bez daty nie ma jak uporządkować', async () => {
    await post(`/okresy/${okres.id}/wplata`, { kwota: '10.00', metoda: 'przelew' });
    expect(wplatyOkresu(db, okres.id)[0].data).toBeTruthy();
  });

  it('brak kwoty → 400 z czytelną odmową i BEZ zapisu', async () => {
    const odp = await post(`/okresy/${okres.id}/wplata`, { metoda: 'przelew' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/Podaj kwotę wpłaty/);
    expect(wplatyOkresu(db, okres.id)).toHaveLength(0);
  });

  it('kwota zero → 400', async () => {
    const odp = await post(`/okresy/${okres.id}/wplata`, { kwota: '0' });
    expect(odp.statusCode).toBe(400);
    expect(wplatyOkresu(db, okres.id)).toHaveLength(0);
  });

  it('nieistniejący okres → 404', async () => {
    expect((await post('/okresy/999/wplata', { kwota: '10.00' })).statusCode).toBe(404);
  });

  it('bez nagłówka Origin → odmowa CSRF', async () => {
    const odp = await app.inject({
      method: 'POST', url: `/okresy/${okres.id}/wplata`, payload: { kwota: '10.00' },
      headers: { authorization: naglowek.authorization },
    });
    expect(odp.statusCode).toBe(403);
  });
});

describe('POST /okresy/:id/wplata/:platnoscId/usun', () => {
  it('usuwa wpłatę wpisaną pomyłkowo', async () => {
    dodajWplateOkresu(db, okres.id, { kwota: '500.00', data: '2026-08-01' });
    const w = wplatyOkresu(db, okres.id)[0];
    const odp = await post(`/okresy/${okres.id}/wplata/${w.id}/usun`);
    expect(odp.statusCode).toBe(302);
    expect(wplatyOkresu(db, okres.id)).toHaveLength(0);
  });

  // ⚠️ Para (okres, wplata) to ZAKRES WLASNOSCI: wplata z adresu URL nie moze skasowac
  // wplaty nalezacej do innego okresu.
  it('wpłata z INNEGO okresu → 400, cudzy wiersz zostaje', async () => {
    const inny = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 6 });
    dodajWplateOkresu(db, inny.id, { kwota: '500.00', data: '2026-07-01' });
    const cudza = wplatyOkresu(db, inny.id)[0];

    const odp = await post(`/okresy/${okres.id}/wplata/${cudza.id}/usun`);
    expect(odp.statusCode).toBe(400);
    expect(wplatyOkresu(db, inny.id)).toHaveLength(1);
  });
});
