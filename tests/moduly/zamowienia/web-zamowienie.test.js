import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from '../../pomoc/pliki-parytetu.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { PROG_ZAWIESZONEGO_NADANIA_MS } from '../../../src/domena/przesylka-stan.js';
import { dodajDoKolejki, oznaczBladDruku, oznaczWydrukowano } from '../../../src/moduly/wysylka/db/kolejka-druku.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { fmtDataCzas } from '../../../src/domena/format-daty.js';
import { STAWKA_VAT } from '../../../src/domena/vat.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-07-29T12:00:00', ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});


// Trasy dotyczace POJEDYNCZEJ paczki niosa jej ID (patrz paczkaZadania w routes/zamowienia.js).
// W tych testach zamowienie ma dokladnie jedna paczke, wiec bierzemy ja z bazy — wpisany na
// sztywno numer ukrywalby fakt, ze adres naprawde wskazuje konkretna przesylke.
const pid = (zamowienieId) => db.prepare('SELECT id FROM przesylki WHERE zamowienie_id = ? ORDER BY id').get(zamowienieId)?.id ?? 0;

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

// Widok szczegolow (zamowienie.ejs) nie mial ani jednego testu HTTP — blad w szablonie
// (np. zla nazwa pola) wywalilby sie dopiero na produkcji, przy pierwszym kliknieciu.
describe('szczegóły zamówienia', () => {
  it('bez uwierzytelnienia oddaje 401', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1401), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}` });
    expect(r.statusCode).toBe(401);
  });

  it('pokazuje numer zamówienia, etykietę statusu i nazwę pozycji', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1401), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1401');
    expect(r.body).toContain('Nowe');
    expect(r.body).toContain('STOP');
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia/999', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('direct link i złośliwy powrót dają bezpieczny link do wiersza na liście', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1498), {});
    const direct = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(direct.body).toContain('<title>Zamówienie 1498</title>');
    expect(direct.body).toContain('<h1 class="belka-numer">Zamówienie 1498</h1>');
    expect(direct.body).toContain(`href="/#zamowienie-${id}"`);
    const zly = await app.inject({
      method: 'GET', url: `/zamowienia/${id}?powrot=${encodeURIComponent('//obcy.example/')}`, headers: naglowek,
    });
    expect(zly.body).toContain(`href="/#zamowienie-${id}"`);
    expect(zly.body).not.toContain('obcy.example');
  });

  it('menu motywu usuwa zly powrot, ale zachowuje otwarta edycje karty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1497), {});
    const r = await app.inject({
      method: 'GET',
      url: `/zamowienia/${id}?powrot=${encodeURIComponent('//obcy.example/')}&edytuj=wysylka`,
      headers: naglowek,
    });
    const od = r.body.indexOf('<form method="post" action="/motyw"');
    const doKonca = r.body.indexOf('</form>', od);
    const menu = r.body.slice(od, doKonca);
    expect(menu).toContain(`name="powrot" value="/zamowienia/${id}?edytuj=wysylka"`);
    expect(menu).not.toContain('obcy.example');
  });

  it('edycja, anulowanie i formularz niosą ten sam kanoniczny powrót', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1499), {});
    const powrot = '/?status=nowe&kanal=pro';
    const karta = await app.inject({
      method: 'GET', url: `/zamowienia/${id}?powrot=${encodeURIComponent(powrot)}`, headers: naglowek,
    });
    expect(karta.body).toContain(
      `href="/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro&amp;edytuj=wysylka"`,
    );
    const edycja = await app.inject({
      method: 'GET',
      url: `/zamowienia/${id}?powrot=${encodeURIComponent(powrot)}&edytuj=wysylka`,
      headers: naglowek,
    });
    expect(edycja.body).toContain(`<input type="hidden" name="powrot" value="${powrot.replaceAll('&', '&amp;')}">`);
    expect(edycja.body).toContain(
      `href="/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro"`,
    );
  });

  it('POST zachowuje powrót w przekierowaniu do karty, a karta wraca do wiersza', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1500), {});
    const powrot = '/?status=nowe&kanal=pro';
    const zapis = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/status`,
      headers: naglowek,
      payload: { status: 'w_realizacji', powrot },
    });
    expect(zapis.statusCode).toBe(302);
    expect(zapis.headers.location).toBe(
      `/zamowienia/${id}?powrot=%2F%3Fstatus%3Dnowe%26kanal%3Dpro`,
    );
    const karta = await app.inject({ method: 'GET', url: zapis.headers.location, headers: naglowek });
    expect(karta.body).toContain(`href="/?status=nowe&amp;kanal=pro#zamowienie-${id}"`);
  });

  it('każdy wyrenderowany formularz karty niesie zweryfikowany powrót', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1501), {});
    const powrot = '/?status=nowe&kanal=pro';
    const karta = await app.inject({
      method: 'GET', url: `/zamowienia/${id}?powrot=${encodeURIComponent(powrot)}`, headers: naglowek,
    });
    const formularze = [...karta.body.matchAll(
      new RegExp(`<form[^>]*action="/zamowienia/${id}[^\"]*"[^>]*>[\\s\\S]*?<\\/form>`, 'g'),
    )].map((trafienie) => trafienie[0]);
    expect(formularze.length).toBeGreaterThan(5);
    for (const formularz of formularze) {
      expect(formularz).toContain('name="powrot" value="/?status=nowe&amp;kanal=pro"');
    }
  });

  it('błąd walidacji nie używa złośliwego powrotu jako przekierowania', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1502), {});
    const zapis = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/status`, headers: naglowek,
      payload: { status: 'nie-istnieje', powrot: '//obcy.example/' },
    });
    expect(zapis.statusCode).toBe(400);
    expect(zapis.headers.location).toBeUndefined();
    expect(zapis.body).not.toContain('obcy.example');
  });

  // C1, druga linia obrony. Pierwsza siedzi w nadaj() — patrz test HTTP nizej.
  it('anulowane zamówienie nie pokazuje przycisku „Nadaj paczkę”', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1402, { anulowane: 1 }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('Nadaj paczkę');
    expect(r.body).toContain('ANULOWANE');
  });

  // Decyzja projektowa: braku oplaty NIE blokujemy (B2B, wysylka na fakture z terminem
  // platnosci), ale ma byc WIDOCZNY — chyba ze wysylka jest za pobraniem, bo wtedy brak
  // wplaty jest z definicji poprawny i ostrzezenie byloby tylko szumem.
  it('nieopłacone zamówienie → ostrzeżenie, ale przycisk nadania zostaje', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1403, { oplacone_at: null }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('NIEOPŁACONE');
    expect(r.body).toContain('Nadaj paczkę');
  });

  // Nadanie jest NIEODWRACALNE (DPD odrzuca ponowną referencję), więc jedno kliknięcie na
  // karcie nie ma prawa strzelić POST-em od razu — musi najpierw zaprowadzić na ekran
  // nadania (GET), gdzie operator widzi adres i wymiary PRZED zatwierdzeniem.
  it('przycisk „Nadaj paczkę” jest linkiem na ekran GET /nadaj, nie formularzem strzelającym POST-em od razu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1408), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`href="/zamowienia/${id}/nadaj"`);
  });

  it('nieopłacone za pobraniem → BEZ ostrzeżenia o braku wpłaty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1404, { oplacone_at: null, metoda_wysylki: 'dpd', pobranie: 1 }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('NIEOPŁACONE');
  });

  // I7: nieudany sync ze sklepem byl calkowicie niewidoczny — trasa oddawala 302
  // (wyglada jak sukces), a tabela `log` nie jest nigdzie renderowana.
  it('nieudany sync ze sklepem → widoczna plakietka przy przesyłce', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1405), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, sync_woo_blad, utworzona_at) VALUES (?, 'dpd', 'nadana', ?, ?, ?)")
      .run(id, '1000000000001U', 'notatka: sklep padł', '2026-07-29T13:00:00');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('SKLEP NIEZSYNCHRONIZOWANY');
    expect(r.body).toContain('sklep padł');
  });

  it('przesyłka „do wyjaśnienia” → widoczne ostrzeżenie i BRAK przycisku nadania', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1406), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, blad_opis, utworzona_at) VALUES (?, 'dpd', 'do_wyjasnienia', ?, ?, ?)")
      .run(id, '1000000000001U', 'DPD nie wystawiło etykiety: NOT_FOUND', '2026-07-29T13:00:00');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('DO WYJAŚNIENIA');
    expect(r.body).toContain('1000000000001U');
    expect(r.body).not.toContain('Nadaj paczkę');
  });

  // I4 (recenzja galezi): odbior osobisty nie ma zadnego kuriera (kurierzy/index.js:
  // DLA_METODY celowo bez wpisu) — nadanie i tak by odmowilo NA KONCU sciezki, ale karta
  // nie ma prawa PODPOWIADAC akcji, ktora zaraz odmowi. „Ekran nadania istnieje po to,
  // zeby NIE klamac" — ta sama zasada dotyczy przycisku, ktory na niego prowadzi.
  it('odbiór osobisty → BRAK przycisku „Nadaj paczkę”, jest wyjaśnienie dlaczego', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1410, { metoda_wysylki: 'odbior_osobisty' }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('Nadaj paczkę');
    expect(r.body).toContain('nie ma czego nadawać');
  });

  // I5 (recenzja galezi): galaz „else" drukowala „DPD” dla kazdej metody poza pobraniem
  // i „nieznana” — w tym dla odbioru osobistego. To jest WLASNIE pole, w ktorym operator
  // sprawdza metode zamowienia.
  //
  // 2026-08-01 pole PRZENIOSLO SIE z belki do „Szczegolow zamowienia" (belka powtarzala
  // fakty z sekcji nizej) i przy okazji przestalo miec wlasny lancuch `if`-ow — nazwa idzie
  // ze slownika w domain/wysylka.js. Test sprawdza wiec to samo, ale w nowym miejscu:
  // gdyby przeprowadzka zgubila nazywanie po imieniu, blad I5 wrocilby niezauwazony.
  it('odbiór osobisty w Szczegółach nazwany po imieniu, nie jako „DPD”', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1411, { metoda_wysylki: 'odbior_osobisty' }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    const i = r.body.indexOf('<span>Metoda wysyłki</span>');
    expect(i, 'karta musi mieć wiersz „Metoda wysyłki”').toBeGreaterThan(-1);
    const pole = r.body.slice(i, r.body.indexOf('</div>', i));
    expect(pole).toContain('Odbiór osobisty');
    expect(pole).not.toContain('DPD');
  });
});

// Zadanie 4: sekcja „Pozycje" — lp/nazwa/SKU/ilość/netto/brutto/suma, wysyłka jako
// OSTATNI wiersz tabeli, suma pod tabelą sprawdzona przeciw kwocie zamówienia.
describe('sekcja „Pozycje”', () => {
  // Zamówienie zgodne co do grosza: 123,00 (pozycje) + 89,90 (wysyłka) = 212,90.
  const zPozycjamiIWysylka = (id, nad = {}) => zmapowane(id, {
    kwota_brutto: '212.90', koszt_dostawy_brutto: '89.90', koszt_dostawy_netto: '73.09',
    pozycje: [{
      nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2,
      cena_brutto: '61.50', cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null,
    }],
    ...nad,
  });

  // ZMIANA ŚWIADOMA (przebudowa karty 2026-07-31): kolumny „Lp." i „SKU" zniknęły z nagłówka.
  // Numer porządkowy nie niesie przy pakowaniu nic, czego nie widać z kolejności wierszy,
  // a SKU stoi teraz POD nazwą pozycji — dalej widoczne, tylko bez własnej kolumny. Ilość
  // przeszła na pierwsze miejsce i jest wyróżniona, bo przy pakowaniu to jedyna liczba,
  // która się liczy. Reszta kolumn zostaje bez zmian.
  // ⚠️ PRZEBUDOWA 2026-08-07: kolumny „Cena netto" JUZ NIE MA — netto stoi drobnym drukiem
  // POD cena brutto. Szesc kolumn nie miescilo sie czytelnie, a netto jest liczba pomocnicza:
  // na fakture i do bariery arytmetycznej idzie BRUTTO. Sama wartosc netto zostaje widoczna
  // (test nizej: „pokazuje netto, brutto i sumę linii pozycji").
  it('pokazuje nagłówki kolumn: Ilość, Nazwa, Cena brutto, Suma — a SKU i netto pod nimi', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1501), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    for (const naglowekKolumny of ['Ilość', 'Nazwa', 'Cena brutto', 'Suma']) {
      expect(r.body).toContain(naglowekKolumny);
    }
    expect(r.body).not.toContain('<th class="liczba">Cena netto</th>');
    expect(r.body).toContain('netto</span>');
    expect(r.body).toContain('PRO-STOP-001');
  });

  it('pokazuje netto, brutto i sumę linii pozycji', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1502), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('50.00');
    expect(r.body).toContain('61.50');
    expect(r.body).toContain('123.00');
  });

  it('dokłada wysyłkę jako wiersz tabeli, z ceną netto i brutto', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1503), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('Wysyłka');
    expect(r.body).toContain('89.90');
    expect(r.body).toContain('73.09');
  });

  // SEDNO ZADANIA: darmowa dostawa dostaje ZERO widoczne na ekranie, nie znika z tabeli.
  it('darmowa dostawa → wiersz „Wysyłka” zostaje, z widocznym zerem', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1504, {
      kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
    }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('Wysyłka');
    expect(r.body).toMatch(/Wysyłka[\s\S]*?0\.00 zł[\s\S]*?0\.00 zł[\s\S]*?0\.00 zł/);
  });

  // Suma przestala byc akapitem POD tabela i jest jej OSTATNIM WIERSZEM (wyrozniony
  // `wiersz-razem`) — liczba, ktora trzeba porownac z wierszami, ma stac w tej samej
  // kolumnie, co one. Szczegolowy dowod na to, ze wiersz jest OSTATNI, siedzi
  // w web-pozycje.test.js.
  it('pokazuje sumę pozycji razem z wysyłką jako ostatni wiersz tabeli', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1505), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    // Caly atrybut, nie sama nazwa klasy — patrz komentarz w web-pozycje.test.js.
    expect(r.body).toContain('<tr class="wiersz-razem">');
    expect(r.body).toContain('Razem');
    expect(r.body).toContain('212.90 zł');
    expect(r.body).not.toContain('Suma pozycji razem z wysyłką');
  });

  it('suma zgodna z kwotą zamówienia → BRAK ostrzeżenia o rozjeździe', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1506), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('NIE ZGADZA SIĘ');
  });

  // SEDNO ZADANIA: rozjazd sumy z kwotą zamówienia musi być widoczny NA KARCIE, z obiema
  // kwotami, zanim operator w ogóle spróbuje wystawić fakturę.
  it('rozjazd sumy z kwotą zamówienia → widoczne ostrzeżenie z obiema kwotami', async () => {
    const id = zapiszZamowienie(db, 'pro', zPozycjamiIWysylka(1507, { kwota_brutto: '999.99' }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('NIE ZGADZA SIĘ');
    expect(r.body).toContain('212.90');
    expect(r.body).toContain('999.99');
  });

  // Zadanie 4 nie dotyka wierszy sprzed dołożenia kolumn netto — mają się dalej renderować
  // (bez netto, nie wywalając karty), co jest dokładnie tym, co robi domyślny fikstura tego
  // pliku (zmapowane() bez pól netto/brutto_linii/koszt_dostawy_*).
  it('zamówienie bez kolumn netto (fikstura sprzed migracji) nie wywraca karty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1508), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Wysyłka');
  });
});

// Finding recenzji Zadania 6 (Important): skrypt przeliczajacy netto/brutto mial wpisana
// wprost stawke VAT (`var VAT = 1.23`) — druga kopia wartosci, ktorej JEDYNYM zrodlem ma
// byc STAWKA_VAT (domain/vat.js). Serwer traktuje przyslane brutto jako wartosc zrodlowa
// i NIE przelicza go z netto — gdyby stawka kiedys sie zmienila, przegladarka policzylaby
// brutto po STAREJ stawce, a serwer przyjalby je bez zastrzezen. Zaden test sprzed tej
// poprawki by tego nie zlapal.
describe('skrypt netto/brutto — stawka VAT z data-vat, nie wpisana w skrypcie', () => {
  // Porownanie idzie z IMPORTOWANA stala STAWKA_VAT, NIE z liczba wpisana tutaj —
  // inaczej ten test sam stalby sie trzecia kopia tej samej wartosci.
  it('formularz „Dodaj pozycję” niesie stawkę w data-vat zgodną ze STAWKA_VAT, a skrypt czyta ją z dokumentu, nie z literału', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1509), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=pozycje`, headers: naglowek });
    expect(r.statusCode).toBe(200);

    // 1. JEDYNE miejsce, z ktorego skrypt ma prawo wziac stawke: atrybut na formularzu,
    // ktorego wartosc serwer wypelnia z STAWKA_VAT (routes/zamowienia.js: renderujKarte).
    const atrybut = r.body.match(/class="nowa-pozycja" data-vat="([^"]*)"/);
    expect(atrybut).not.toBeNull();
    expect(atrybut[1]).toBe(STAWKA_VAT);

    // 2. Skrypt nie ma prawa niesc WLASNEJ, niezaleznej kopii stawki — musi ja odczytac
    // z dokumentu (`dataset.vat`). PRZ-105: skrypt jest plikiem (public/cena-netto.js), wiec
    // sprawdzamy, ze strona go laduje, i czytamy TEN plik — bez liczbowego literalu stawki.
    expect(r.body).toMatch(/<script type="module" src="\/public\/cena-netto\.js[^"]*"><\/script>/);
    const skrypt = readFileSync('src/public/cena-netto.js', 'utf8');
    expect(skrypt).toMatch(/dataset\??\.vat/);
    const kod = skrypt.replace(/\/\/.*$/gmu, '');
    expect(kod).not.toMatch(/\b(23|1\.23|0\.23)\b/);
  });

  // Formularz zbiorczej edycji ma cena_brutto, ale NIE ma cena_netto (patrz komentarz w
  // widoku) — skrypt musi go pominac cicho, ta sama zasada, co przed poprawka.
  it('formularz zbiorczej edycji pozycji (bez pola cena_netto) nie wywraca karty', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1510), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=pozycje`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="cena_brutto"');
  });
});

// I6. POST /nadaj i GET /etykieta to jedyne miejsce, z ktorego czlowiek wyzwala
// nieodwracalne nadanie — i wlasnie tam siedzial C1. Dotad nie mialy ani jednego testu.
describe('trasy nadania i etykiety', () => {
  const NUMER_LISTU = '1000000000001U';
  // Wartosci podane przez wlasciciela (patrz PACZKA_DOMYSLNA w nadanie.js) — trasa POST
  // od Zadania „ekran nadania" WYMAGA jawnej wagi i wymiarow, wiec kazdy test, ktory ma
  // dojsc do prawdziwego wywolania nadaj(), musi je podac.
  //  jest czescia formularza nadania — trasa POST bez niej odmawia.
  // Adres odbiorcy — od Zadania „adres edytowalny" trasa POST wymaga go W FORMULARZU
  // (puste pole wymagane blokuje zatwierdzenie, patrz domain/adres-formularza.js). Testy
  // w tym pliku sprawdzają zachowanie trasy nadania (anulowane, błędy DPD, etykieta), nie
  // samą treść adresu, więc wystarczy dowolny KOMPLETNY adres.
  const PACZKA = {
    waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1', kolejnosc: '1',
    nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
  };
  let katalogEtykiet, dpd, woo;

  function zApp({ anulowane = 0, metoda_wysylki = 'dpd', dpdNadaj } = {}) {
    katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-web-'));
    dpd = { nadaj: dpdNadaj ?? vi.fn().mockResolvedValue({ numerListu: NUMER_LISTU, etykietaPdf: Buffer.from('%PDF-atrapa'), surowa: '<xml/>' }) };
    woo = { dodajNotatke: vi.fn().mockResolvedValue({}), ustawStatus: vi.fn().mockResolvedValue({}) };
    const nadanie = createNadanie({ db, kurierzy: { dpd }, woo, katalogEtykiet });
    const serwer = buildOmsServer({ db, config, poller, nadanie });
    const id = zapiszZamowienie(db, 'pro', zmapowane(1501, { anulowane, metoda_wysylki }), {});
    return { serwer, id, nadanie };
  }

  it('POST /nadaj bez uwierzytelnienia → 401 i DPD nietknięte', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj` });
    expect(r.statusCode).toBe(401);
    expect(dpd.nadaj).not.toHaveBeenCalled();
  });

  it('POST /nadaj nadaje paczkę i przekierowuje na kartę', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(pobierzZamowienie(db, id).przesylki[0].numer_listu).toBe(NUMER_LISTU);
  });

  // Zadanie „adres edytowalny": bez tej karty operator nie miałby jak sprawdzić, dokąd
  // paczka NAPRAWDĘ pojechała, gdy adres w formularzu różnił się od adresu w zamówieniu.
  it('karta zamówienia pokazuje adres FAKTYCZNIE użyty przy nadaniu tej paczki', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, ulica: 'Ulica-Na-Karcie-8821', miasto: 'Miasto-Na-Karcie-8821' },
    });
    const karta = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.statusCode).toBe(200);
    expect(karta.body).toContain('Adres użyty przy nadaniu');
    expect(karta.body).toContain('Ulica-Na-Karcie-8821');
    expect(karta.body).toContain('Miasto-Na-Karcie-8821');
  });

  // Paczki nadane PRZED tym zadaniem mają adres_uzyty = NULL — karta nie ma prawa się na
  // tym wywalić ani pokazywać pustej/zepsutej linijki.
  it('paczka bez zapisanego adresu (sprzed tej zmiany) → karta nie pokazuje linii, nie wywala się', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'nadana', 'X-STARA', 1, '2026-07-29')")
      .run(id);
    const karta = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.statusCode).toBe(200);
    expect(karta.body).not.toContain('Adres użyty przy nadaniu');
  });

  // NAJWAZNIEJSZY test tego pliku: to jest sciezka, ktora klika czlowiek.
  it('POST /nadaj na ANULOWANYM zamówieniu → odmowa i DPD nietknięte', async () => {
    const { serwer, id } = zApp({ anulowane: 1 });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/anulowane/i);
    expect(dpd.nadaj).not.toHaveBeenCalled();
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).przesylki).toEqual([]);
  });

  it('POST /nadaj na nieistniejącym zamówieniu → 404', async () => {
    const { serwer } = zApp();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: '/zamowienia/9999/nadaj', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('POST /nadaj bez skonfigurowanego nadawania → 503', async () => {
    const serwer = buildOmsServer({ db, config, poller });
    await serwer.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(1502), {});
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(503);
  });

  // M2: 400 pokazywalo surowy komunikat systemowy z pelna sciezka serwera.
  it('błąd techniczny → czytelny komunikat na ekranie, szczegóły tylko w logu', async () => {
    const techniczny = new Error("ENOENT: no such file or directory, open 'C:\\srv\\oms\\etykiety\\x.pdf'");
    const { serwer, id } = zApp({ dpdNadaj: vi.fn().mockRejectedValue(techniczny) });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('C:\\srv\\oms');
    expect(r.body).not.toContain('ENOENT');
    expect(r.body).toMatch(/logu/i);
    const wpis = db.prepare("SELECT * FROM log WHERE akcja = 'nadanie.http'").get();
    expect(wpis.wynik).toContain('ENOENT');
  });

  it('błąd napisany dla operatora idzie na ekran w całości', async () => {
    const { serwer, id } = zApp({ metoda_wysylki: 'nieznana' });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.body).toMatch(/nie jest obsługiwana/);
  });

  it('GET /etykieta oddaje PDF z nagłówkiem Content-Disposition', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/przesylki/${pid(id)}/etykieta`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain(`etykieta-${NUMER_LISTU}.pdf`);
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('GET /etykieta bez przesyłki → 404, nie 500', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/przesylki/${pid(id)}/etykieta`, headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  // M3: skasowany plik dawal 500 z pelna sciezka serwera w JSON-ie.
  it('GET /etykieta gdy plik zniknął → 404 z czytelnym komunikatem, bez ścieżki serwera', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    const sciezka = pobierzZamowienie(db, id).przesylki[0].etykieta_sciezka;
    rmSync(sciezka);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/przesylki/${pid(id)}/etykieta`, headers: naglowek });
    expect(r.statusCode).toBe(404);
    expect(r.body).toMatch(/etykiet/i);
    expect(r.body).not.toContain(katalogEtykiet);
  });

  it('GET /etykieta bez uwierzytelnienia → 401', async () => {
    const { serwer, id } = zApp();
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/przesylki/${pid(id)}/etykieta` });
    expect(r.statusCode).toBe(401);
  });
});

// I6. POST /faktura to NAJGROZNIEJSZA trasa w panelu — jedyna, ktora tworzy dokument
// w rejestrze panstwowym, nieusuwalny i poprawiany wylacznie korekta. Nie miala ani
// jednego testu HTTP, podczas gdy znacznie mniej grozne /nadaj mialo komplet.
describe('trasa wystawienia faktury', () => {
  const zFaktura = (nad = {}, atrapy = {}) => {
    const infakt = {
      znajdzKlientaPoNip: atrapy.znajdz ?? vi.fn().mockResolvedValue(7),
      zalozKlienta: atrapy.zaloz ?? vi.fn().mockResolvedValue(555),
      wystaw: atrapy.wystaw ?? vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: 'sent' }),
    };
    const faktura = createFaktura({ db, infakt });
    const serwer = buildOmsServer({ db, config, poller, faktura });
    const id = zapiszZamowienie(db, 'pro', zmapowane(1601, {
      chce_fakture: 1, nip: '1000001201', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', ...nad,
    }), {});
    return { serwer, id, infakt };
  };

  it('POST /faktura bez uwierzytelnienia → 401 i inFakt nietknięty', async () => {
    const { serwer, id, infakt } = zFaktura();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura` });
    expect(r.statusCode).toBe(401);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('POST /faktura wystawia dokument, zapisuje wiersz i przekierowuje na kartę', async () => {
    const { serwer, id, infakt } = zFaktura();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    expect(pobierzZamowienie(db, id).faktura.numer).toBe('FV/1/2026');
  });

  // C2, sciezka, ktora naprawde klika czlowiek.
  it('POST /faktura na ANULOWANYM zamówieniu → odmowa i inFakt nietknięty', async () => {
    const { serwer, id, infakt } = zFaktura({ anulowane: 1 });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/anulowane/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    expect(infakt.znajdzKlientaPoNip).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, id).faktura).toBeNull();
  });

  it('POST /faktura na nieistniejącym zamówieniu → 404', async () => {
    const { serwer } = zFaktura();
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: '/zamowienia/9999/faktura', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('POST /faktura bez skonfigurowanego inFaktu → 503', async () => {
    const serwer = buildOmsServer({ db, config, poller });
    await serwer.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(1602, { chce_fakture: 1 }), {});
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(503);
  });

  // I3: nieudana proba bez sladu w logu to najgorszy mozliwy stan — przycisk zostaje,
  // historia pusta, a dokument mogl juz istniec.
  it('porażka → 400 i wpis w logu zamówienia', async () => {
    const wystaw = vi.fn().mockRejectedValue(
      Object.assign(new Error('inFakt odrzucił fakturę (422): Proszę podać nazwę firmy.'), { dlaOperatora: true, status: 422 }),
    );
    const { serwer, id } = zFaktura({}, { wystaw });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    // Tresc od inFaktu MA dojsc na ekran — bez niej operator nie wie, co poprawic.
    expect(r.body).toMatch(/nazwę firmy/);
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'faktura.http'").get(id);
    expect(wpis.wynik).toContain('nazwę firmy');
  });

  // I4: przed poprawka trasa przepuszczala surowy e.message, wiec przy dwukliku operator
  // dostawal na ekran „UNIQUE constraint failed: faktury.zamowienie_id" — nazwe tabeli
  // i kolumny bazy panelu.
  it('błąd techniczny → czytelny komunikat, szczegóły sterownika tylko w logu', async () => {
    const wystaw = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const { serwer, id } = zFaktura({}, { wystaw });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('Cannot read properties');
    expect(r.body).toMatch(/logu/i);
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'faktura.http'").get(id);
    expect(wpis.wynik).toContain('Cannot read properties');
  });

  it('widok pokazuje przycisk faktury, gdy inFakt działa', async () => {
    const { serwer, id } = zFaktura();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('Wystaw fakturę');
  });

  // ⚠️ ZDANIE „Panel wystawi fakturę w inFakcie, BEZ wysyłki do KSeF — wysyła ją właściciel
  // sam, wieczorem." ZDJĘTE 2026-08-07 na prośbę właściciela (przebudowa sekcji „Faktura").
  // Punkt B pierwotnego briefu żądał go PRZY PRZYCISKU; dziś ten sam fakt niesie PASTYLKA
  // STANU w wierszu dokumentu („jeszcze nie wysłana do KSeF") — czyli tam, gdzie stoi numer,
  // i przez cały czas życia faktury, a nie tylko przez sekundę przed kliknięciem. Pilnuje
  // tego test niżej. Tutaj zostaje kontrola, że zdanie NIE WRÓCIŁO i że formularz jest cały.
  it('formularz wystawienia ma komplet pól i nie powtarza zdania o KSeF', async () => {
    const { serwer, id } = zFaktura();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toMatch(/BEZ wysyłki do KSeF/);
    for (const pole of ['name="termin"', 'name="data_wystawienia"', 'name="data_sprzedazy"']) {
      expect(r.body, `formularz musi mieć ${pole}`).toContain(pole);
    }
    expect(r.body).toContain('Wystaw fakturę');
  });

  // Ta sama zasada, ale PO wystawieniu: karta faktury wystawionej ma dalej mówić, że
  // dokument czeka w inFakcie na wieczorną wysyłkę, a nie sugerować, że już poszedł.
  // ⚠️ ATRAPA BEZ `ksefStatus` — I TO JEST WIERNIEJSZE PRODUKCJI (2026-08-07). Panel wystawia
  // dokument BEZ wysyłki do KSeF (wysyła właściciel, wieczorem), więc `ksef_status` zostaje
  // wtedy PUSTY i karta ma powiedzieć wprost, że dokumentu w KSeF jeszcze nie ma. Poprzednia
  // wersja testu podstawiała `ksefStatus: 'sent'` i sprawdzała zdanie drukowane BEZWARUNKOWO —
  // przechodziła więc także wtedy, gdyby karta o stanie KSeF nie mówiła nic.
  it('po wystawieniu karta mówi, że faktura NIE poszła jeszcze do KSeF', async () => {
    const { serwer, id } = zFaktura({}, { wystaw: vi.fn().mockResolvedValue({ uuid: 'u1', numer: 'FV/1/2026', ksefStatus: null }) });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    // ⚠️ PRZEBUDOWA 2026-08-07: zdanie „wystawiona w inFakcie z panelu, BEZ wysyłki do KSeF"
    // zastąpiła PASTYLKA STANU w wierszu dokumentu. Fakt jest ten sam — panel do KSeF nie
    // wysyła — tylko powiedziany raz, przy numerze, zamiast akapitem obok tabeli.
    expect(r.body).toMatch(/jeszcze nie wysłana do KSeF/);
    expect(r.body).toContain('FV/1/2026');
  });

  // Przycisk prowadzacy prosto w 503 to zaproszenie do klikania w nic.
  it('bez skonfigurowanego inFaktu widok NIE kusi przyciskiem', async () => {
    const serwer = buildOmsServer({ db, config, poller });
    await serwer.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(1603, { chce_fakture: 1 }), {});
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('Wystaw fakturę');
    expect(r.body).toMatch(/inFakt nie jest skonfigurowany/);
  });

  // C2, druga linia obrony (pierwsza siedzi w wystaw()).
  it('anulowane zamówienie nie pokazuje sekcji faktury', async () => {
    const { serwer, id } = zFaktura({ anulowane: 1 });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('Wystaw fakturę');
  });

  it('faktura „do wyjaśnienia” → ostrzeżenie i BRAK przycisku ponowienia', async () => {
    const { serwer, id } = zFaktura();
    await serwer.ready();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, blad_opis, utworzona_at) VALUES (?, 'do_wyjasnienia', ?, ?)")
      .run(id, 'inFakt nieosiągalny: fetch failed', '2026-07-29T13:00:00');
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('DO WYJAŚNIENIA');
    expect(r.body).toContain('fetch failed');
    expect(r.body).not.toContain('Wystaw fakturę');
  });
});

// Ze stanu 'do_wyjasnienia' nie bylo ZADNEGO wyjscia: ani trasy, ani przycisku, ani
// skryptu. Nawet po sprawdzeniu w inFakcie panel nigdy juz nie wystawil faktury do takiego
// zamowienia — zostawala reczna operacja na pliku SQLite.
describe('odblokowanie faktury po sprawdzeniu w inFakcie', () => {
  const DAWNO = '2026-07-29T13:00:00.000Z';
  const wiersz = (id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
  const zamowienie = (nad = {}) => zapiszZamowienie(db, 'pro', zmapowane(1701, { chce_fakture: 1, ...nad }), {});

  const doWyjasnienia = (id) => db
    .prepare("INSERT INTO faktury (zamowienie_id, ksef_status, blad_opis, utworzona_at) VALUES (?, 'do_wyjasnienia', ?, ?)")
    .run(id, 'inFakt nieosiągalny: fetch failed', DAWNO);

  it('POST /faktura/odblokuj bez uwierzytelnienia → 401 i rezerwacja nietknięta', async () => {
    const id = zamowienie();
    doWyjasnienia(id);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/odblokuj` });
    expect(r.statusCode).toBe(401);
    expect(wiersz(id)).toBeDefined();
  });

  it('kasuje rezerwację, zapisuje decyzję człowieka w logu i wraca na kartę', async () => {
    const id = zamowienie();
    doWyjasnienia(id);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/odblokuj`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(wiersz(id)).toBeUndefined();

    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'faktura.odblokowanie'").get(id);
    expect(wpis.wynik).toMatch(/Ręcznie( \(|:)/);
    // Kto i kiedy — bez tego log nie odpowiada na jedyne pytanie, ktore ktos kiedys zada.
    expect(wpis.wynik).toContain('adam');
    expect(wpis.wynik).toContain(DAWNO);
    // Hasla z naglowka Basic w logu byc NIE MOZE.
    expect(wpis.wynik).not.toContain('x:');
  });

  // Cel calej operacji: po odblokowaniu panel ma znowu umiec wystawic fakture.
  it('po odblokowaniu wystawienie z panelu znów działa', async () => {
    const infakt = {
      znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
      zalozKlienta: vi.fn(),
      wystaw: vi.fn().mockResolvedValue({ uuid: 'u9', numer: 'FV/9/2026', ksefStatus: 'sent' }),
    };
    const serwer = buildOmsServer({ db, config, poller, faktura: createFaktura({ db, infakt }) });
    await serwer.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(1702, {
      chce_fakture: 1, nip: '1000001201', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
    }), {});
    doWyjasnienia(id);

    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/odblokuj`, headers: naglowek });
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).faktura.numer).toBe('FV/9/2026');
  });

  // NAJWAZNIEJSZA odmowa tej trasy: odblokowanie wystawionej faktury zdjeloby blokade
  // z dokumentu, ktory NA PEWNO jest w inFakcie, a kolejne klikniecie daloby drugi.
  it('WYSTAWIONEJ faktury nie odblokuje — 400 i wiersz zostaje', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, numer, utworzona_at) VALUES (?, 'sent', 'FV/1/2026', ?)").run(id, DAWNO);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/odblokuj`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/FV\/1\/2026/);
    expect(wiersz(id).numer).toBe('FV/1/2026');
  });

  it('trwającego wystawiania nie odblokuje — 400 i wiersz zostaje', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', ?)").run(id, new Date().toISOString());
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/odblokuj`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(wiersz(id)).toBeDefined();
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/zamowienia/9999/faktura/odblokuj', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  // Odblokowanie nie dotyka inFaktu, wiec panel podniesiony BEZ klucza API tez musi
  // umiec zdjac blokade — inaczej brak konfiguracji zamraza zamowienie na stale.
  it('działa także wtedy, gdy inFakt nie jest skonfigurowany', async () => {
    const serwer = buildOmsServer({ db, config, poller });
    await serwer.ready();
    const id = zamowienie();
    doWyjasnienia(id);
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/odblokuj`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(wiersz(id)).toBeUndefined();
  });

  it('karta pokazuje przycisk odblokowania i ostrzeżenie „najpierw sprawdź w inFakcie”', async () => {
    const id = zamowienie();
    doWyjasnienia(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/zamowienia/${id}/faktura/odblokuj`);
    expect(r.body).toMatch(/NAJPIERW otwórz inFakt/);
    expect(r.body).toMatch(/DRUGĄ fakturą w inFakcie/);
  });

  // Osierocone 'w_toku' po restarcie procesu: karta odpowiadala „odswiez strone za chwile"
  // w nieskonczonosc, bo nic nigdy tego wiersza nie zdejmowalo.
  it('osierocona rezerwacja → karta mówi o zawieszeniu i daje przycisk, zamiast „odśwież za chwilę”', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', ?)").run(id, DAWNO);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('ZAWIESZONA');
    expect(r.body).toContain(`/zamowienia/${id}/faktura/odblokuj`);
    expect(r.body).not.toMatch(/odśwież stronę za chwilę/);
  });

  it('świeża rezerwacja → nadal „odśwież za chwilę”, BEZ przycisku odblokowania', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', ?)").run(id, new Date().toISOString());
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toMatch(/odśwież stronę za chwilę/);
    expect(r.body).not.toContain('/faktura/odblokuj');
  });

  // Ostrzezenie o mozliwym dokumencie w KSeF nie ma prawa zniknac razem z sekcja faktury
  // przy anulowaniu zamowienia — tam wiszacy dokument jest jeszcze grozniejszy.
  it('anulowane zamówienie z wiszącą fakturą nadal pokazuje ostrzeżenie i przycisk', async () => {
    const id = zamowienie({ anulowane: 1 });
    doWyjasnienia(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('DO WYJAŚNIENIA');
    expect(r.body).toContain(`/zamowienia/${id}/faktura/odblokuj`);
    expect(r.body).not.toContain('Wystaw fakturę');
  });
});

// Zdarzenie z 2026-07-30, na produkcji: wlasciciel wystawil prawdziwa fakture przez panel,
// obejrzal ja w inFakcie i skasowal — bo od tego dnia panel wystawia BEZ wysylki do KSeF
// (wysyla ja sam, zbiorczo, wieczorem), wiec niewyslana faktura wolno po prostu skasowac.
// odblokuj CELOWO odmawia dla kazdej faktury WYSTAWIONEJ, wiec bez tej trasy zamowienie
// zostawaloby zablokowane NA ZAWSZE: UNIQUE (zamowienie_id) nie pozwala wystawic drugiej.
describe('faktura skasowana w inFakcie — wyjście dla operatora', () => {
  const wiersz = (id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
  const zamowienie = (nad = {}) => zapiszZamowienie(db, 'pro', zmapowane(1704, { chce_fakture: 1, ...nad }), {});

  // Wystawiona, jeszcze niewyslana do KSeF — DOKLADNIE stan po dzisiejszej zmianie: panel
  // niczego do KSeF sam nie wysyla, wiec `ksef_status` jest pusty od razu po wystawieniu.
  const wystawiona = (id, nad = {}) => db.prepare(
    "INSERT INTO faktury (zamowienie_id, ksef_status, numer, infakt_uuid, utworzona_at) VALUES (?, NULL, 'FV/63/2026', 'uuid-63', ?)",
  ).run(id, '2026-07-30T10:00:00.000Z');

  it('POST /faktura/skasowana bez uwierzytelnienia → 401 i wiersz nietknięty', async () => {
    const id = zamowienie();
    wystawiona(id);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana` });
    expect(r.statusCode).toBe(401);
    expect(wiersz(id)).toBeDefined();
  });

  it('kasuje rezerwację, zapisuje decyzję człowieka z numerem i UUID w logu i wraca na kartę', async () => {
    const id = zamowienie();
    wystawiona(id);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(wiersz(id)).toBeUndefined();

    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'faktura.skasowana'").get(id);
    expect(wpis.wynik).toMatch(/Ręcznie( \(|:)/);
    expect(wpis.wynik).toContain('adam');
    // Bez numeru i UUID skasowanego dokumentu log nie odpowie po miesiacu na pytanie,
    // co sie z ta faktura stalo.
    expect(wpis.wynik).toContain('FV/63/2026');
    expect(wpis.wynik).toContain('uuid-63');
    // Hasla z naglowka Basic w logu byc NIE MOZE.
    expect(wpis.wynik).not.toContain('x:');
  });

  // Panel niczego nie kasuje w inFakcie — decyzja jest CZLOWIEKA, panel tylko ja odnotowuje.
  it('nie woła żadnego API — czysto lokalna operacja na bazie', async () => {
    const id = zamowienie();
    wystawiona(id);
    const serwer = buildOmsServer({ db, config, poller }); // BEZ atrapy inFaktu — nie ma czego wolac
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(wiersz(id)).toBeUndefined();
  });

  // Cel calej operacji: po odnotowaniu skasowania panel ma znowu umiec wystawic fakture.
  it('po odnotowaniu skasowania wystawienie z panelu znów działa', async () => {
    const infakt = {
      znajdzKlientaPoNip: vi.fn().mockResolvedValue(7),
      zalozKlienta: vi.fn(),
      wystaw: vi.fn().mockResolvedValue({ uuid: 'u9', numer: 'FV/9/2026', ksefStatus: null }),
    };
    const serwer = buildOmsServer({ db, config, poller, faktura: createFaktura({ db, infakt }) });
    await serwer.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(1705, {
      chce_fakture: 1, nip: '1000001201', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
    }), {});
    wystawiona(id);

    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).faktura.numer).toBe('FV/9/2026');
  });

  // NAJWAZNIEJSZA odmowa tej trasy: dokument, ktory poszedl juz do KSeF, nie jest do
  // skasowania w inFakcie — tylko do korekty. Pomylka po tej stronie jest juz nieodwracalna.
  it('fakturę wysłaną już do KSeF (niepusty ksef_status) → 400, wiersz zostaje', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, numer, utworzona_at) VALUES (?, 'sent', 'FV/1/2026', ?)").run(id, '2026-07-30T10:00:00.000Z');
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/KSeF/);
    expect(r.body).toMatch(/korygu/);
    expect(wiersz(id).numer).toBe('FV/1/2026');
  });

  it('trwającego wystawiania nie kasuje — 400 i wiersz zostaje', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, utworzona_at) VALUES (?, 'w_toku', ?)").run(id, new Date().toISOString());
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    // Tresc komunikatu, nie tylko sam status 400: `ksef_status` niesie takze wewnetrzny
    // znacznik panelu, wiec sama odmowa moglaby wyjsc z NIEWLASCIWEGO powodu (jakby to byl
    // dokument juz w KSeF), a nie z tego, ze rezerwacja jeszcze nie ma numeru.
    expect(r.body).toMatch(/właśnie trwa/);
    expect(wiersz(id)).toBeDefined();
  });

  it('rezerwacji „do wyjaśnienia” nie kasuje tą trasą — na to jest osobne wyjście („odblokuj”)', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, blad_opis, utworzona_at) VALUES (?, 'do_wyjasnienia', 'fetch failed', ?)").run(id, new Date().toISOString());
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie ma jeszcze numeru dokumentu/);
    expect(wiersz(id)).toBeDefined();
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/zamowienia/9999/faktura/skasowana', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('brak rezerwacji faktury → 400, czytelna odmowa', async () => {
    const id = zamowienie();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/skasowana`, headers: naglowek });
    expect(r.statusCode).toBe(400);
  });

  // Przycisk widoczny WYLACZNIE przy fakturze wystawionej, jeszcze niewyslanej do KSeF —
  // to DRUGA linia obrony (pierwsza siedzi w fakturaSkasowanaWInfakcie), zeby nie kusic
  // operatora akcja, ktora i tak zostanie odrzucona.
  // ⚠️⚠️ ODNOTOWANIE PRZENIESIONE NA ZAKLADKE FAKTURY (01.09.2026, prosba właściciela: „na co
  // dzien jest to nieuzywane — chyba ani razu nie skorzystalem z tego"). Karta ma tego
  // przycisku NIE MIEC, a sama trasa POST zostaje ta sama i dziala (testy wyzej).
  // Gdzie stoi dzis i czego pilnuje: tests/oms/web-faktury-skasowana.test.js.
  it('karta NIE pokazuje już przycisku — akcja mieszka w zakładce Faktury', async () => {
    const id = zamowienie();
    wystawiona(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain(`/zamowienia/${id}/faktura/skasowana`);
    expect(r.body).not.toMatch(/Skasowałem tę fakturę w inFakcie/);
  });

  it('faktura wysłana już do KSeF → BRAK przycisku „skasowana w inFakcie”', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, numer, utworzona_at) VALUES (?, 'sent', 'FV/1/2026', ?)").run(id, '2026-07-30T10:00:00.000Z');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/faktura/skasowana');
  });

  it('faktura „do wyjaśnienia” → BRAK przycisku „skasowana w inFakcie”', async () => {
    const id = zamowienie();
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, blad_opis, utworzona_at) VALUES (?, 'do_wyjasnienia', 'fetch failed', ?)").run(id, '2026-07-29T13:00:00');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/faktura/skasowana');
  });

  it('brak faktury (przycisk „Wystaw fakturę”) → BRAK przycisku „skasowana w inFakcie”', async () => {
    const id = zamowienie();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/faktura/skasowana');
  });

  // ⚠️⚠️ RECENZJA PARTII 2, K3 — DOWÓD Z `ksef_numer`, KTÓREGO KARTA WCZEŚNIEJ NIE WIDZIAŁA.
  //
  // Przy ręcznej wysyłce do KSeF `ksef_status` zostaje PUSTY NA ZAWSZE (panel dostaje tam
  // `ksef_data` z chwili wystawienia, a właściciel wysyła dokument dopiero potem). Dowód
  // zbiera czuwacz i zapisuje do `ksef_numer` — więc karta, patrząc wyłącznie na
  // `ksef_status`, twierdziła „jeszcze nie wysłana" przy dokumencie, który JEST w KSeF,
  // i dalej oferowała jego skasowanie. Odnotowanie skasowania zwalnia zamówienie do
  // ponownego wystawienia, więc do KSeF pojechałby DRUGI dokument.
  it('numer KSeF od czuwacza → BRAK przycisku „skasowana w inFakcie”', async () => {
    const id = zamowienie();
    db.prepare(
      "INSERT INTO faktury (zamowienie_id, ksef_status, numer, ksef_numer, utworzona_at)"
      + " VALUES (?, NULL, 'FV/64/2026', '1234563218-20260804-632857000005-03', ?)",
    ).run(id, '2026-07-30T10:00:00.000Z');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/faktura/skasowana');
  });

  it('karta pokazuje PRAWDZIWY numer KSeF, a nie „jeszcze nie wysłana”', async () => {
    const id = zamowienie();
    db.prepare(
      "INSERT INTO faktury (zamowienie_id, ksef_status, numer, ksef_numer, utworzona_at)"
      + " VALUES (?, NULL, 'FV/64/2026', '1234563218-20260804-632857000005-03', ?)",
    ).run(id, '2026-07-30T10:00:00.000Z');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('1234563218-20260804-632857000005-03');
    expect(r.body).not.toMatch(/jeszcze nie wysłana/);
  });

  // Kontrola odwrotna: dopóki dowodu NIE MA, karta mówi to wprost i przycisk zostaje.
  it('bez ksef_status i bez ksef_numer karta dalej mówi „jeszcze nie wysłana”', async () => {
    const id = zamowienie();
    wystawiona(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toMatch(/jeszcze nie wysłana/);
    // ⚠️ Przycisku odnotowania tu juz nie ma (przeniesiony na /faktury) — ale zdanie o KSeF
    // zostaje, bo mowi o STANIE dokumentu, a nie o akcji.
    expect(r.body).not.toContain(`/zamowienia/${id}/faktura/skasowana`);
  });
});

// I3. Osierocone nadanie ('w_trakcie' po restarcie procesu w trakcie `klient.nadaj`) bylo
// slepym zaulkiem: karta pokazywala przycisk „Nadaj paczke", kazde klikniecie odpowiadalo
// „Nadanie wlasnie trwa", a jedynym wyjsciem byl reczny UPDATE w pliku SQLite.
describe('zawieszone nadanie — wyjście dla operatora', () => {
  const DAWNO = new Date(Date.now() - PROG_ZAWIESZONEGO_NADANIA_MS - 60_000).toISOString();
  const przesylka = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);

  const zZawieszonym = (nad = {}) => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1901, nad), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, utworzona_at) VALUES (?, 'dpd', 'w_trakcie', ?)")
      .run(id, DAWNO);
    return id;
  };

  it('POST /przesylka/odblokuj bez uwierzytelnienia → 401 i wiersz nietknięty', async () => {
    const id = zZawieszonym();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/odblokuj` });
    expect(r.statusCode).toBe(401);
    expect(przesylka(id).status).toBe('w_trakcie');
  });

  it('karta mówi o zawieszeniu, odsyła do panelu DPD i daje formularz — zamiast „właśnie trwa”', async () => {
    const id = zZawieszonym();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('ZAWIESZONE');
    expect(r.body).toMatch(/NAJPIERW otwórz panel DPD/);
    expect(r.body).toContain(`/zamowienia/${id}/przesylki/${pid(id)}/odblokuj`);
    // Przycisk nadania to zaproszenie do klikania w nic: odbije sie od indeksu czesciowego.
    expect(r.body).not.toContain('Nadaj paczkę');
  });

  it('świeże nadanie NIE dostaje formularza odblokowania', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1902), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, utworzona_at) VALUES (?, 'dpd', 'w_trakcie', ?)")
      .run(id, new Date().toISOString());
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/odblokuj');
    expect(r.body).not.toContain('ZAWIESZONE');
  });

  it('bez numeru listu: zwalnia miejsce, zapisuje DECYZJĘ CZŁOWIEKA i wraca na kartę', async () => {
    const id = zZawieszonym();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/odblokuj`, headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(przesylka(id).status).toBe('blad');

    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'przesylka.odblokowanie'").get(id);
    expect(wpis.wynik).toMatch(/Ręcznie( \(|:)/);
    expect(wpis.wynik).toContain('adam');
    expect(wpis.wynik).toMatch(/paczki NIE MA/);
    // Hasla z naglowka Basic w logu byc NIE MOZE.
    expect(wpis.wynik).not.toContain('x:');
  });

  // NAJWAZNIEJSZY test tego bloku i cala roznica wobec faktury: gdy DPD MA juz numer listu,
  // ponowienie wrocilo by z DUPLICATED_PARCEL_SEARCH_KEY, a paczka fizycznie istnieje.
  it('z numerem listu: przesyłka idzie na „do wyjaśnienia”, a nie pod ponowienie', async () => {
    const id = zZawieszonym();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/odblokuj`, headers: naglowek,
      payload: { numer_listu: '1000000000001U' },
    });
    expect(r.statusCode).toBe(302);
    const p = przesylka(id);
    expect(p.status).toBe('do_wyjasnienia');
    expect(p.numer_listu).toBe('1000000000001U');

    // Karta ma teraz mowic o wyjasnieniu, a przycisku nadania nadal nie ma.
    const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.body).toContain('DO WYJAŚNIENIA');
    expect(karta.body).not.toContain('Nadaj paczkę');
  });

  // Cel calej operacji w wariancie (a): po odblokowaniu panel ma znowu umiec nadac.
  it('po odblokowaniu bez numeru nadanie z panelu znów działa', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-odblok-'));
    const dpd = { nadaj: vi.fn().mockResolvedValue({ numerListu: '1000000000001U', etykietaPdf: Buffer.from('%PDF'), surowa: '<xml/>' }) };
    const woo = { dodajNotatke: vi.fn().mockResolvedValue({}), ustawStatus: vi.fn().mockResolvedValue({}) };
    const serwer = buildOmsServer({
      db, config, poller, nadanie: createNadanie({ db, kurierzy: { dpd }, woo, katalogEtykiet: katalog }),
    });
    await serwer.ready();
    const id = zZawieszonym();

    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/odblokuj`, headers: naglowek, payload: {} });
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: {
        waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1', kolejnosc: '1',
        nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
      },
    });
    expect(r.statusCode).toBe(302);
    expect(dpd.nadaj).toHaveBeenCalledTimes(1);
    expect(pobierzZamowienie(db, id).przesylki[0].numer_listu).toBe('1000000000001U');
  });

  it('odblokowanie działa bez skonfigurowanego DPD — brak konfiguracji nie zamraża zamówienia', async () => {
    const id = zZawieszonym();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/odblokuj`, headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(302);
    expect(przesylka(id).status).toBe('blad');
  });

  it('trwającego nadania nie odblokuje — 400 i wiersz zostaje', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1903), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, utworzona_at) VALUES (?, 'dpd', 'w_trakcie', ?)")
      .run(id, new Date().toISOString());
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/odblokuj`, headers: naglowek, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/właśnie trwa/);
    expect(przesylka(id).status).toBe('w_trakcie');
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/zamowienia/9999/przesylki/1/odblokuj', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });
});

// Luka odlozona SWIADOMIE w Zadaniu 10 („przestawienie na `nadana` wymaga UPDATE w SQLite").
// Po dorobieniu wyjscia z zawieszonego nadania byla juz jedyna asymetria.
describe('domknięcie przesyłki „do wyjaśnienia”', () => {
  const przesylka = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
  const zWyjasnieniem = () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1904), {});
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, blad_opis, utworzona_at)'
      + " VALUES (?, 'dpd', 'do_wyjasnienia', '1000000000001U', 'DPD nie wystawiło etykiety: NOT_FOUND', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(id);
    return id;
  };

  it('POST /przesylka/domknij bez uwierzytelnienia → 401 i wiersz nietknięty', async () => {
    const id = zWyjasnieniem();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/domknij` });
    expect(r.statusCode).toBe(401);
    expect(przesylka(id).status).toBe('do_wyjasnienia');
  });

  it('karta daje przycisk domknięcia', async () => {
    const id = zWyjasnieniem();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/zamowienia/${id}/przesylki/${pid(id)}/domknij`);
  });

  it('domyka sprawę, zapisuje decyzję człowieka i zdejmuje zamówienie z listy roboczej', async () => {
    const id = zWyjasnieniem();
    // Etykieta musi byc, inaczej zostaje inna sprawa (I4) i zamowienie slusznie nie schodzi.
    db.prepare("UPDATE przesylki SET etykieta_sciezka = '/e/1.pdf' WHERE zamowienie_id = ?").run(id);

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/domknij`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(przesylka(id).status).toBe('nadana');
    expect(przesylka(id).numer_listu).toBe('1000000000001U');

    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'przesylka.domkniecie'").get(id);
    expect(wpis.wynik).toMatch(/Ręcznie( \(|:)/);
    expect(wpis.wynik).toContain('adam');
    expect(wpis.wynik).toContain('1000000000001U');

    // Od 2026-07-31 „wysłane" to własny fakt: sama nadana paczka nie zdejmuje zamówienia
    // z listy roboczej. Tu chodzi o ZDJĘCIE SPRAWY, więc zamówienie jest już oznaczone jako wysłane.
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-07-29T13:30:00', id);
    const lista = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(lista.body).not.toContain('1904');
  });

  it('przesyłki nadanej nie domknie — 400 i wiersz zostaje', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1905), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, utworzona_at) VALUES (?, 'dpd', 'nadana', 'X1', '2026-07-29')").run(id);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/domknij`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(przesylka(id).status).toBe('nadana');
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/zamowienia/9999/przesylki/1/domknij', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });
});

// Wada z przegladu galezi: sync_woo_blad i „brak etykiety" przy nadanej przesylce wpychaja
// zamowienie na liste robocza, a NIC nie umie ich zdjac. Ten opis odtwarza dokladnie
// zmierzony przebieg z brief-u: do_wyjasnienia -> POST /przesylka/domknij -> zamowienie
// zostaje na liscie z odznaka „brak etykiety" NA ZAWSZE.
describe('sprawa przesyłki załatwiona ręcznie', () => {
  const przesylka = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);
  const zNiezsynchronizowana = () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2001), {});
    db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, sync_woo_blad, utworzona_at)"
      + " VALUES (?, 'dpd', 'nadana', 'X1', '/e/1.pdf', 'notatka: sklep padł', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(id);
    return id;
  };

  it('POST /przesylka/sprawa-zalatwiona bez uwierzytelnienia → 401 i wiersz nietknięty', async () => {
    const id = zNiezsynchronizowana();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/sprawa-zalatwiona` });
    expect(r.statusCode).toBe(401);
    expect(przesylka(id).sync_woo_blad).not.toBeNull();
  });

  it('kasuje sync_woo_blad, zapisuje decyzję człowieka i zdejmuje zamówienie z listy roboczej', async () => {
    const id = zNiezsynchronizowana();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/sprawa-zalatwiona`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${id}`);
    expect(przesylka(id).sync_woo_blad).toBeNull();

    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'przesylka.sprawa-zalatwiona'").get(id);
    expect(wpis.wynik).toMatch(/Ręcznie( \(|:)/);
    expect(wpis.wynik).toContain('adam');
    expect(wpis.wynik).not.toContain('x:');

    // Od 2026-07-31 „wysłane" to własny fakt: sama nadana paczka nie zdejmuje zamówienia
    // z listy roboczej. Tu chodzi o ZDJĘCIE SPRAWY, więc zamówienie jest już oznaczone jako wysłane.
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-07-29T13:30:00', id);
    const lista = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(lista.body).not.toContain('2001');
  });

  // Dokladny scenariusz z przegladu galezi (numery 2002/1000000000001U dobrane tak samo
  // jak w brief-ie): domkniecie przestawia przesylke na 'nadana' bez etykiety, i dopiero
  // TA trasa umie zdjac odznake „brak etykiety".
  it('domyka scenariusz z przeglądu: do_wyjaśnienia → domknij → nadal brak etykiety → załatw ręcznie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2002), {});
    db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, blad_opis, utworzona_at)"
      + " VALUES (?, 'dpd', 'do_wyjasnienia', '1000000000001U', 'DPD nie wystawiło etykiety: NOT_FOUND', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ).run(id);

    await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/domknij`, headers: naglowek });
    expect(przesylka(id).status).toBe('nadana');
    expect(przesylka(id).etykieta_sciezka).toBeNull();
    // Zamowienie MUSI dalej byc na liscie roboczej z odznaka „brak etykiety" — inaczej
    // przyklad z brief-u przestalby cokolwiek dowodzic.
    let lista = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(lista.body).toContain('2002');
    expect(lista.body).toContain('brak etykiety');

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/sprawa-zalatwiona`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(przesylka(id).etykieta_reczna).toBe(1);
    // I dopiero teraz zamowienie schodzi z listy roboczej.
    // Od 2026-07-31 „wysłane" to własny fakt: sama nadana paczka nie zdejmuje zamówienia
    // z listy roboczej. Tu chodzi o ZDJĘCIE SPRAWY, więc zamówienie jest już oznaczone jako wysłane.
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-07-29T13:30:00', id);
    lista = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(lista.body).not.toContain('2002');
  });

  it('bez żadnej sprawy do zdjęcia → 400 i wiersz zostaje', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2003), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, utworzona_at) VALUES (?, 'dpd', 'nadana', 'X1', '/e/1.pdf', '2026-07-29')").run(id);
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${pid(id)}/sprawa-zalatwiona`, headers: naglowek });
    expect(r.statusCode).toBe(400);
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/zamowienia/9999/przesylki/1/sprawa-zalatwiona', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('czysta przesyłka (bez spraw) → karta NIE pokazuje przycisku', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2004), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, utworzona_at) VALUES (?, 'dpd', 'nadana', 'X1', '/e/1.pdf', '2026-07-29')").run(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('/sprawa-zalatwiona');
  });

  it('przesyłka z sync_woo_blad → karta pokazuje przycisk', async () => {
    const id = zNiezsynchronizowana();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/zamowienia/${id}/przesylki/${pid(id)}/sprawa-zalatwiona`);
  });

  it('nadana przesyłka bez etykiety → karta pokazuje przycisk', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2005), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, utworzona_at) VALUES (?, 'dpd', 'nadana', 'X1', '2026-07-29')").run(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/zamowienia/${id}/przesylki/${pid(id)}/sprawa-zalatwiona`);
  });
});

// I5. Anulowanie PO nadaniu i po wystawieniu faktury. Zmierzone przed poprawka: karta
// W OGOLE nie renderowala sekcji „Faktura" (warunek zawieral `!z.anulowane`), wiec panel
// milczal o dokumencie w inFakcie, ktory trzeba recznie zatrzymac przed wieczorna wysylka
// do KSeF (albo skorygowac, gdy juz tam pojechal). Paczka byla w drodze.
describe('anulowanie po nadaniu i po fakturze — karta nie milczy', () => {
  const zAnulowanym = (numer) => zapiszZamowienie(db, 'pro', zmapowane(numer, { anulowane: 1, chce_fakture: 1 }), {});

  it('anulowane z wystawioną fakturą: sekcja „Faktura” się pokazuje razem z numerem', async () => {
    const id = zAnulowanym(2001);
    db.prepare("INSERT INTO faktury (zamowienie_id, ksef_status, numer, utworzona_at) VALUES (?, 'sent', 'FV/7/2026', '2026-07-29T13:00:00')").run(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Faktura');
    expect(r.body).toContain('FV/7/2026');
    expect(r.body).toMatch(/KOREKTĘ/);
    // Sekcja ma INFORMOWAC, nie zapraszac do wystawiania kolejnego dokumentu.
    expect(r.body).not.toContain('Wystaw fakturę');
  });

  it('anulowane z nadaną przesyłką: karta ostrzega, że paczka już istnieje', async () => {
    const id = zAnulowanym(2002);
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, utworzona_at) VALUES (?, 'dpd', 'nadana', '1000000000001U', '/e/1.pdf', '2026-07-29')").run(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toMatch(/przesyłka do tego zamówienia JUŻ ISTNIEJE/i);
    expect(r.body).toContain('1000000000001U');
  });

  // Kontrola negatywna: anulowane zamowienie, do ktorego nic sie nie zdazylo wydarzyc,
  // ma dalej NIE pokazywac sekcji faktury ani ostrzezen o paczce.
  it('anulowane bez przesyłki i faktury nie dorabia ostrzeżeń', async () => {
    const id = zAnulowanym(2003);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('ANULOWANE');
    expect(r.body).not.toMatch(/JUŻ ISTNIEJE/i);
    expect(r.body).not.toMatch(/KOREKTĘ/);
    expect(r.body).not.toContain('Wystaw fakturę');
  });
});

// Zadanie 13: status przesyłki z usługi zdarzeń DPD, odświeżany przy otwarciu karty.
// Najważniejsze wymaganie tego bloku: awaria DPD NIE MA PRAWA wywalić ani zawiesić karty.
describe('status DPD odświeżany przy otwarciu karty', () => {
  const NUMER_LISTU = '1000000000001U';
  const GODZINA_MS = 60 * 60 * 1000;

  function zPrzesylka(nad = {}) {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1801), {});
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, status_kuriera, status_kuriera_at,'
      + " status_kuriera_pobrany_at, utworzona_at) VALUES (?, 'dpd', 'nadana', ?, ?, ?, ?, ?)",
    ).run(
      id, NUMER_LISTU, nad.status_kuriera ?? null, nad.status_kuriera_at ?? null,
      nad.status_kuriera_pobrany_at ?? null, '2026-07-29T13:00:00',
    );
    return id;
  }

  const przesylka = (id) => pobierzZamowienie(db, id).przesylki[0];
  const zDpd = async (id, dpd) => {
    const serwer = buildOmsServer({ db, config, poller, kurierzy: { dpd } });
    await serwer.ready();
    return serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
  };

  // Do fali z dlawikiem GET karty byl czysto ODCZYTOWY. Teraz kazde otwarcie zamowienia
  // z przesylka robi UPDATE, wiec awaria zapisu (pelny dysk, blad I/O, baza tylko do odczytu)
  // moglaby wywalic karte surowym komunikatem sterownika — i to dokladnie wtedy, gdy ktos
  // probuje diagnozowac awarie. Kartoteka ma sie otwierac zawsze.
  it('nieudany zapis znacznika próby NIE wywala karty', async () => {
    const id = zPrzesylka();
    db.exec('ALTER TABLE przesylki DROP COLUMN status_kuriera_pobrany_at');
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'W doręczeniu', at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpd(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('ERR_SQLITE_ERROR');
    expect(r.body).not.toContain('no such column');
  });

  // ===== I1: ZADEN zapis w odswiezaniu nie moze wywalic karty =====
  //
  // Poprzedni test (wyzej) usuwal JEDNA kolumne, wiec cwiczyl wylacznie sciezke, ktora byla
  // juz osloniona — i dlatego przechodzil na kodzie, w ktorym `zapiszStatusDpd` siedzial
  // w `try` (jego wyjatek udawal awarie DPD), a `dopiszLog` stal w `catch`, skad wyjatek
  // szedl prosto do Fastify. Tutaj baza odrzuca KAZDY zapis, dokladnie jak przy pelnym dysku.
  const bazaBezZapisow = () => ({
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a),
        run: () => { throw new Error('SQLITE_FULL: database or disk is full'); },
      };
    },
    exec: (sql) => db.exec(sql),
  });

  const zDpdIBazaBezZapisow = async (id, dpd) => {
    const serwer = buildOmsServer({ db: bazaBezZapisow(), config, poller, kurierzy: { dpd } });
    await serwer.ready();
    return serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
  };

  it('DPD odpowiada, ale baza nie przyjmuje ŻADNEGO zapisu → karta nadal się renderuje', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-22T10:00:00.000' });
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpdIBazaBezZapisow(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('SQLITE_FULL');
    expect(r.body).not.toContain('disk is full');
    // Karta pokazuje stan sprzed proby — nieodswiezony, ale WIDOCZNY.
    expect(r.body).toContain(NUMER_LISTU);
  });

  // Druga sciezka, ta grozniejsza: wyjatek z `dopiszLog` stal w bloku `catch`, wiec nie
  // mial juz czego zlapac. Zmierzone przed poprawka: HTTP 500 z surowym komunikatem sterownika.
  it('DPD pada I baza nie przyjmuje zapisu → karta nadal się renderuje', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-22T10:00:00.000' });
    const dpd = { statusPrzesylki: vi.fn().mockRejectedValue(new Error('DPD nieosiągalne: ECONNREFUSED')) };
    const r = await zDpdIBazaBezZapisow(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('SQLITE_FULL');
    expect(r.body).not.toContain('disk is full');
    expect(r.body).toContain('Nadana');
  });

  // Trzecia sciezka: pusta odpowiedz DPD. Zapisu statusu wtedy nie ma, ale znacznik proby
  // jest — i tez musi byc osloniety.
  it('DPD oddaje null, a baza nie przyjmuje zapisu → karta nadal się renderuje', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue(null) };
    const r = await zDpdIBazaBezZapisow(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('SQLITE_FULL');
  });

  // Nieudany zapis NIE MOZE zostawic karty twierdzacej cos, czego w bazie nie ma: przy
  // nastepnym otwarciu status cofnalby sie do starego i nikt by tego nie zrozumial.
  it('nieudany zapis statusu nie podmienia tego, co widać na karcie', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-22T10:00:00.000' });
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpdIBazaBezZapisow(id, dpd);
    expect(r.body).toContain('Nadana');
    expect(r.body).not.toContain('Doręczona');
    // ...i naprawde nic sie nie zapisalo.
    expect(przesylka(id).status_kuriera).toBe('Nadana');
  });

  // „brak zdarzen" to zdanie o stanie u kuriera. Bez skonfigurowanego DPD nigdy o nie
  // nie zapytalismy, wiec nie wolno go napisac — panel twierdzilby cos, czego nie sprawdzil.
  it('bez skonfigurowanego DPD karta nie twierdzi „brak zdarzeń"', async () => {
    const id = zPrzesylka();
    const serwer = buildOmsServer({ db, config, poller });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(NUMER_LISTU);
    expect(r.body).not.toContain('brak zdarzeń');
  });

  // Zadanie „strona główna", punkt C: znacznik próby (teraz(), UTC) jest teraz PRZELICZANY
  // na czas polski (fmtDataCzas) zamiast pokazywany surowo z dopiskiem „UTC" — po przeliczeniu
  // dopisek stałby się nieprawdą. Wartość jest dynamiczna (zapisywana w chwili żądania),
  // więc liczymy oczekiwany, sformatowany czas z wiersza w bazie PO żądaniu.
  it('znacznik ostatniej próby jest przeliczony na czas polski, BEZ dopisku „UTC"', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Nadana', at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpd(id, dpd);
    const zapisany = przesylka(id).status_kuriera_pobrany_at;
    expect(r.body).toContain(`sprawdzone ${fmtDataCzas(zapisany)}`);
    expect(r.body).not.toMatch(/sprawdzone[^<]*UTC/);
  });

  it('brak znacznika próby → pyta DPD i zapisuje nowy status na karcie', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'W doręczeniu', at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpd(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(dpd.statusPrzesylki).toHaveBeenCalledWith(NUMER_LISTU, expect.any(Object));
    expect(r.body).toContain('W doręczeniu');
    const zapisane = przesylka(id);
    expect(zapisane.status_kuriera).toBe('W doręczeniu');
    expect(zapisane.status_kuriera_at).toBe('2026-07-30T09:00:00.000');
    // Znacznik proby to NASZ czas, nie czas zdarzenia z DPD.
    expect(zapisane.status_kuriera_pobrany_at).not.toBe('2026-07-30T09:00:00.000');
    expect(Date.now() - Date.parse(zapisane.status_kuriera_pobrany_at)).toBeLessThan(GODZINA_MS);
  });

  it('świeża próba (poniżej godziny) → DPD NIE jest pytane ponownie', async () => {
    const swiezo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: swiezo, status_kuriera_pobrany_at: swiezo });
    const dpd = { statusPrzesylki: vi.fn() };
    const r = await zDpd(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
    expect(r.body).toContain('Nadana');
  });

  it('próba starsza niż godzina → DPD jest pytane ponownie', async () => {
    const dawno = new Date(Date.now() - GODZINA_MS - 60_000).toISOString();
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: dawno, status_kuriera_pobrany_at: dawno });
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpd(id, dpd);
    expect(dpd.statusPrzesylki).toHaveBeenCalledWith(NUMER_LISTU, expect.any(Object));
    expect(r.body).toContain('Doręczona');
  });

  // ===== C1: dlawik liczy sie od NASZEJ PROBY, nie od czasu zdarzenia w DPD =====
  //
  // Poprzednia wersja czytala status_kuriera_at (czas zdarzenia u kuriera) i dla paczki
  // doreczonej dawniej niz godzine temu wpadala w PETLE BEZ KONCA: warunek prawdziwy ->
  // zapytanie -> DPD oddaje TO SAMO stare zdarzenie -> zapis tej samej wartosci -> warunek
  // nadal prawdziwy. Stare zamowienia (reklamacje, faktury) oglada sie najczesciej, wiec
  // kazde otwarcie karty placilo pelny roundtrip do DPD.
  //
  // Testy sprawdzajace to podstawialy `status_kuriera_at` sztucznie swiezy, wiec petli nie widzialy.
  it('paczka doręczona 3 dni temu: DPD pytane RAZ, nie przy każdym otwarciu karty', async () => {
    const dawneZdarzenie = '2026-07-27T10:00:00.000';
    const id = zPrzesylka({ status_kuriera: 'Doręczona', status_kuriera_at: dawneZdarzenie });
    // DPD w kolko oddaje to samo stare zdarzenie — bo nic nowego sie nie stalo.
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: dawneZdarzenie }) };

    await zDpd(id, dpd);
    await zDpd(id, dpd);
    await zDpd(id, dpd);

    expect(dpd.statusPrzesylki).toHaveBeenCalledTimes(1);
  });

  // M7: eventTime z DPD nie ma strefy ('2026-07-29T20:07:14.918'), wiec Date.parse czytalby
  // go w strefie hosta (na produkcji TZ=UTC => zdarzenie wyglada na 2 h nowsze). Po C1 czas
  // z DPD nie bierze udzialu w liczeniu progu W OGOLE — ten test to przypieczetowuje:
  // znacznik proby jest swiezy, wiec „przyszly" czas zdarzenia niczego nie zmienia.
  it('czas zdarzenia z DPD (bez strefy) nie ma wpływu na próg odświeżania', async () => {
    const swiezaProba = new Date(Date.now() - 60_000).toISOString();
    const zdarzenieBezStrefy = new Date(Date.now() - 10 * GODZINA_MS).toISOString().replace('Z', '');
    const id = zPrzesylka({
      status_kuriera: 'Nadana', status_kuriera_at: zdarzenieBezStrefy, status_kuriera_pobrany_at: swiezaProba,
    });
    const dpd = { statusPrzesylki: vi.fn() };
    await zDpd(id, dpd);
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
  });

  it('nieudana próba też jest stemplowana — awaria nie znaczy pytania przy każdym otwarciu', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-22T10:00:00.000' });
    const dpd = { statusPrzesylki: vi.fn().mockRejectedValue(new Error('INCORRECT_LOGIN_OR_PASSWORD')) };
    await zDpd(id, dpd);
    await zDpd(id, dpd);
    expect(dpd.statusPrzesylki).toHaveBeenCalledTimes(1);
    expect(przesylka(id).status_kuriera_pobrany_at).not.toBeNull();
  });

  it('pusta odpowiedź (null) też jest stemplowana', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue(null) };
    await zDpd(id, dpd);
    await zDpd(id, dpd);
    expect(dpd.statusPrzesylki).toHaveBeenCalledTimes(1);
    expect(przesylka(id).status_kuriera_pobrany_at).not.toBeNull();
  });

  // ===== I4: trwala awaria odswiezania musi byc WIDOCZNA dla czlowieka =====
  // Tabeli `log` nie renderuje zaden widok (dokladnie dlatego istnieje sync_woo_blad).
  // Bez tego zmiana hasla w DPD dawala karte pokazujaca status sprzed tygodnia JAKO AKTUALNY.
  it('awaria odświeżania jest widoczna na karcie, nie tylko w logu', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-22T10:00:00.000' });
    const dpd = { statusPrzesylki: vi.fn().mockRejectedValue(bladOperatora('DPD odrzuciło żądanie: INCORRECT_LOGIN_OR_PASSWORD')) };
    const r = await zDpd(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('status niedostępny');
    expect(r.body).toContain('ostatnia próba');
    // Stary status nadal widoczny — ale juz nie udaje aktualnego.
    expect(r.body).toContain('Nadana');
  });

  it('udane odświeżenie pokazuje czas sprawdzenia i kasuje poprzedni znacznik awarii', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-22T10:00:00.000' });
    await zDpd(id, { statusPrzesylki: vi.fn().mockRejectedValue(new Error('padło')) });
    expect(przesylka(id).status_kuriera_blad).not.toBeNull();

    // Nastepne otwarcie po wygasnieciu dlawika, tym razem udane.
    db.prepare('UPDATE przesylki SET status_kuriera_pobrany_at = ? WHERE zamowienie_id = ?')
      .run(new Date(Date.now() - GODZINA_MS - 60_000).toISOString(), id);
    const r = await zDpd(id, { statusPrzesylki: vi.fn().mockResolvedValue({ opis: 'Doręczona', at: '2026-07-30T09:00:00.000' }) });

    expect(przesylka(id).status_kuriera_blad).toBeNull();
    expect(r.body).toContain('sprawdzone');
    expect(r.body).not.toContain('status niedostępny');
  });

  // Wymaganie briefu, ktorego brakowalo: brak zdarzen ma byc NAPISANY, a nie objawiac sie
  // zniknieciem kawalka linii.
  it('brak zdarzeń (status_kuriera = null) jest napisany wprost', async () => {
    const id = zPrzesylka();
    const r = await zDpd(id, { statusPrzesylki: vi.fn().mockResolvedValue(null) });
    expect(r.body).toContain('brak zdarzeń');
  });

  // ===== I5: try/catch odpornosci nie ma polykac bledow technicznych =====
  // Polknal juz dwa realne: `dpd.statusPrzesylki is not a function` i blad bindowania
  // node:sqlite. Oba dawaly CICHA, TRWALA awarie przy zielonej suicie.
  it('błąd techniczny jest w logu oznaczony inaczej niż odmowa DPD', async () => {
    const id = zPrzesylka();
    // Regresja programistyczna: klient DPD bez metody.
    const r = await zDpd(id, {});
    expect(r.statusCode).toBe(200);
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'dpd.status'").get(id);
    expect(wpis.wynik).toContain('BŁĄD TECHNICZNY');
    expect(wpis.wynik).toContain('is not a function');
  });

  it('odmowa DPD (błąd operatora) NIE jest oznaczana jako techniczna', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockRejectedValue(bladOperatora('DPD odrzuciło żądanie: NO_DATA')) };
    await zDpd(id, dpd);
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'dpd.status'").get(id);
    expect(wpis.wynik).toContain('NO_DATA');
    expect(wpis.wynik).not.toContain('BŁĄD TECHNICZNY');
  });

  // I3 od strony bazy: zdarzenie bez opisu ma sie ZAPISAC, a nie wywalic bindowania
  // node:sqlite i zginac w try/catch odpornosci.
  it('zdarzenie bez opisu zapisuje się w bazie i nie zostawia błędu technicznego', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue({ opis: null, at: '2026-07-30T09:00:00.000' }) };
    const r = await zDpd(id, dpd);
    expect(r.statusCode).toBe(200);
    expect(przesylka(id).status_kuriera_at).toBe('2026-07-30T09:00:00.000');
    expect(db.prepare("SELECT COUNT(*) c FROM log WHERE zamowienie_id = ? AND akcja = 'dpd.status'").get(id).c).toBe(0);
  });

  it('brak numeru listu → DPD w ogóle nie jest pytane', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1802), {});
    const dpd = { statusPrzesylki: vi.fn() };
    const serwer = buildOmsServer({ db, config, poller, kurierzy: { dpd } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(dpd.statusPrzesylki).not.toHaveBeenCalled();
  });

  // Bez klienta DPD trasa nie ma czego wołać — sprawdzamy nie tylko, że karta się renderuje,
  // ale też że panel NIE próbuje i NIE zostawia fałszywego wpisu „DPD nieosiągalne" w logu
  // przy KAŻDYM otwarciu karty (mutacja: usunięcie strażnika `dpd &&` degraduje się cicho,
  // bo łapie ją ten sam try/catch co prawdziwą awarię sieci — status HTTP sam w sobie tego nie wyłapie).
  it('DPD nieskonfigurowane (brak klienta) → karta renderuje się bez błędu i bez próby zapytania', async () => {
    const id = zPrzesylka();
    // `app` z beforeEach jest zbudowany BEZ dpd — dokładnie sytuacja usługi bez konfiguracji DPD.
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(NUMER_LISTU);
    expect(db.prepare("SELECT COUNT(*) c FROM log WHERE akcja = 'dpd.status'").get().c).toBe(0);
  });

  // NAJWAŻNIEJSZY test tego bloku: awaria DPD (sieć, timeout, zła odpowiedź) nie ma
  // prawa wywalić ani zawiesić karty — ma się wyrenderować ze starym statusem.
  it('DPD nie odpowiada → karta zamówienia nadal się renderuje ze starym statusem', async () => {
    const id = zPrzesylka({ status_kuriera: 'Nadana', status_kuriera_at: '2026-07-29T13:00:00.000' });
    const dpd = { statusPrzesylki: vi.fn().mockRejectedValue(new Error('DPD nieosiągalne: ECONNREFUSED')) };
    const serwer = buildOmsServer({ db, config, poller, kurierzy: { dpd } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    // Stary status zostaje widoczny na ekranie...
    expect(r.body).toContain('Nadana');
    // ...a awaria idzie do logu, nie na ekran jako błąd.
    expect(r.body).not.toContain('ECONNREFUSED');
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'dpd.status'").get(id);
    expect(wpis.wynik).toContain('ECONNREFUSED');
  });

  // Świeżo zarejestrowana przesyłka: brak zdarzeń to nie awaria (statusPrzesylki oddaje
  // null), więc karta ma się wyrenderować normalnie, bez błędu i bez fałszywego statusu.
  it('DPD oddaje null (brak zdarzeń) → karta renderuje się bez błędu', async () => {
    const id = zPrzesylka();
    const dpd = { statusPrzesylki: vi.fn().mockResolvedValue(null) };
    const serwer = buildOmsServer({ db, config, poller, kurierzy: { dpd } });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(pobierzZamowienie(db, id).przesylki[0].status_kuriera).toBeNull();
  });
});

// Zadanie „kolejka druku": przycisk „Pobierz" (rename istniejącego pobrania PDF-a) i
// „Drukuj" (nowy, obok niego) — widoczny WYŁĄCZNIE gdy ZPL istnieje.
describe('karta zamówienia — „Pobierz" i „Drukuj" (kolejka druku)', () => {
  const przesylka = (id, over = {}) => db.prepare(
    "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, etykieta_zpl_sciezka, utworzona_at)"
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, over.kurier ?? 'dpd', over.status ?? 'nadana', over.numer_listu ?? 'X1',
    over.etykieta_sciezka === undefined ? '/e/1.pdf' : over.etykieta_sciezka,
    over.etykieta_zpl_sciezka ?? null, '2026-07-29');

  const przesylkaId = (zamowienieId) => db.prepare('SELECT id FROM przesylki WHERE zamowienie_id = ?').get(zamowienieId).id;

  it('nadana przesyłka BEZ ZPL-a → „Pobierz" jest, „Drukuj" NIE MA', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2101), {});
    przesylka(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('Pobierz');
    expect(r.body).not.toContain('>Drukuj<');
    expect(r.body).not.toContain('Etykieta niezapisana');
  });

  it('WzA z samym ZPL-em pokazuje Drukuj bez fałszywego alarmu o braku etykiety', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(2110), {});
    przesylka(id, { kurier: 'allegro_wza', etykieta_sciezka: null, etykieta_zpl_sciezka: '/e/1.zpl' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`action="/zamowienia/${id}/przesylki/${przesylkaId(id)}/drukuj"`);
    expect(r.body).not.toContain('Etykieta niezapisana');
    const pasekSpraw = r.body.match(/<div class="sprawy">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(pasekSpraw).not.toContain('brak etykiety');
    expect(r.body).not.toContain('Załatwione ręcznie poza panelem');
    const reczne = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${przesylkaId(id)}/sprawa-zalatwiona`, headers: naglowek,
    });
    expect(reczne.statusCode).toBe(400);
    expect(db.prepare('SELECT etykieta_reczna FROM przesylki WHERE id = ?').get(przesylkaId(id)).etykieta_reczna).toBeNull();
  });

  it('WzA bez PDF-u i ZPL-u ostrzega o Allegro, nie o DPD', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(2111), {});
    przesylka(id, { kurier: 'allegro_wza', etykieta_sciezka: null });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Etykieta niezapisana — sprawdź ją w panelu Allegro.');
    expect(r.body).toMatch(/<div class="sprawy">[\s\S]*?brak etykiety/);
    expect(r.body).toContain('Załatwione ręcznie poza panelem');
    expect(r.body).not.toContain('Etykieta niezapisana — pobierz ją z panelu DPD.');
  });

  it('DPD bez PDF-u i ZPL-u zachowuje ostrzeżenie o brakującej etykiecie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2112), {});
    przesylka(id, { etykieta_sciezka: null });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Etykieta niezapisana — pobierz ją z panelu DPD.');
  });

  // Rename z briefu — stara etykieta linku znika.
  it('link pobrania PDF-a NIE nazywa się już „etykieta PDF"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2102), {});
    przesylka(id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('etykieta PDF');
  });

  it('nadana przesyłka Z ZPL-em, bez pozycji w kolejce → „Drukuj" jest widoczny', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2103), {});
    przesylka(id, { etykieta_zpl_sciezka: '/e/1.zpl' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`action="/zamowienia/${id}/przesylki/${przesylkaId(id)}/drukuj"`);
    expect(r.body).toContain('>Drukuj<');
  });

  it('pozycja „oczekuje" bez nieudanych prób → stan „czeka na wydruk", BRAK przycisku Porzuć', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2104), {});
    przesylka(id, { etykieta_zpl_sciezka: '/e/1.zpl' });
    dodajDoKolejki(db, przesylkaId(id));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('czeka na wydruk');
    expect(r.body).not.toContain('Porzuć');
  });

  it('pozycja z nieudanymi próbami → licznik i powód widoczne, jest przycisk „Porzuć"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2105), {});
    przesylka(id, { etykieta_zpl_sciezka: '/e/1.zpl' });
    const w = dodajDoKolejki(db, przesylkaId(id));
    oznaczBladDruku(db, w.id, 'Nie znaleziono drukarki "ZEBRA"');
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toMatch(/1 nieudan/);
    expect(r.body).toContain('Nie znaleziono drukarki');
    expect(r.body).toContain(`action="/zamowienia/${id}/przesylki/${przesylkaId(id)}/drukuj/${w.id}/porzuc"`);
    expect(r.body).toContain('Porzuć');
  });

  it('pozycja wydrukowana → stan „wydrukowano <kiedy>"', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2106), {});
    przesylka(id, { etykieta_zpl_sciezka: '/e/1.zpl' });
    const w = dodajDoKolejki(db, przesylkaId(id));
    oznaczWydrukowano(db, w.id);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toMatch(/wydrukowano/);
    const wiersz = db.prepare('SELECT wydrukowane_at FROM kolejka_druku WHERE id = ?').get(w.id);
    // Zadanie „strona główna", punkt C: znacznik (teraz(), UTC) jest teraz PRZELICZANY
    // na czas polski, nie pokazany surowo.
    expect(r.body).toContain(fmtDataCzas(wiersz.wydrukowane_at));
    // Porzuć ma sens tylko przy pozycji, która jeszcze próbuje — wydrukowana go nie pokazuje.
    expect(r.body).not.toContain('Porzuć');
  });

  it('„Drukuj" jest dalej widoczny mimo istniejącej pozycji „oczekuje" — powtórny wydruk jest dozwolony', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2107), {});
    przesylka(id, { etykieta_zpl_sciezka: '/e/1.zpl' });
    dodajDoKolejki(db, przesylkaId(id));
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`action="/zamowienia/${id}/przesylki/${przesylkaId(id)}/drukuj"`);
  });
});

// ⚠️ ZGLOSZENIE WLASCICIELA 11.08.2026, po pierwszym prawdziwym wydruku etykiety WzA:
// „gdy kliknę pobierz PDF otwiera się w przeglądarce w tej samej karcie co zamówienie.
// lepiej jakby otwierał się w nowej karcie którą sobie zamknę po wydrukowaniu".
//
// Karta zamowienia jest MIEJSCEM PRACY przy pakowaniu — zabranie jej pod podglad PDF-a
// znaczy powrot wstecz po kazdym wydruku. `rel` jest obowiazkowy przy `target="_blank"`:
// bez niego otwarty dokument dostaje `window.opener` do panelu.
describe('etykieta otwiera się w nowej karcie', () => {
  // ⚠️ OBA odnośniki „Pobierz PDF" — etykieta I faktura. Dolegliwość była ta sama, więc
  // poprawka jednego z nich byłaby połowiczna, a test pytający o pierwszy z brzegu
  // przepuściłby drugi.
  it('KAŻDY odnośnik „Pobierz PDF" ma target="_blank" i rel="noopener"', () => {
    const zrodlo = readFileSync('src/oms/web/views/zamowienie.ejs', 'utf8');
    const wystapienia = zrodlo.split('Pobierz PDF').length - 1;
    expect(wystapienia).toBeGreaterThanOrEqual(2);
    for (let i = 0, od = 0; i < wystapienia; i += 1) {
      const gdzie = zrodlo.indexOf('Pobierz PDF', od);
      const tag = zrodlo.slice(0, gdzie).slice(zrodlo.slice(0, gdzie).lastIndexOf('<a '));
      expect(`${i}: ${/target="_blank"/.test(tag) && /rel="noopener/.test(tag) ? 'ok' : tag.slice(0, 120)}`)
        .toBe(`${i}: ok`);
      od = gdzie + 1;
    }
  });

  it('odnośnik etykiety wskazuje właściwą trasę', () => {
    const zrodlo = readFileSync('src/oms/web/views/zamowienie.ejs', 'utf8');
    // Tag `<a>` bezpośrednio poprzedzający napis „Pobierz PDF" — bez zgadywania, jak
    // rozłożone są w nim wstawki EJS i łamania linii.
    const przed = zrodlo.slice(0, zrodlo.indexOf('Pobierz PDF'));
    const odnosnik = przed.slice(przed.lastIndexOf('<a '));
    expect(odnosnik).toContain('/etykieta');
    expect(odnosnik).toMatch(/target="_blank"/);
    expect(odnosnik).toMatch(/rel="noopener/);
  });
});

// ⚠️⚠️ ZGLOSZENIE WLASCICIELA 11.08.2026: „jest jakiś problem z pobieraniem statusów
// z paczek allegro".
//
// Kurier `allegro_wza` kupuje przewoz u Allegro, ale SLEDZENIA przez to API NIE MA — zasob
// przesylki niesie numery, nie zdarzenia. Adapter nie ma wiec `statusPrzesylki`, a karta
// wolala je przy KAZDYM otwarciu i dopisywala „BŁĄD TECHNICZNY" do logu zamowienia.
//
// To ta sama awaria, ktora komentarz w `odswiezStatusKuriera` opisuje jako juz przezyta
// dwa razy (`dpd.statusPrzesylki is not a function`) — tyle ze wywolana brakiem metody,
// a nie zla mapa kurierow. Suita byla zielona, bo zaden test nie otwieral karty paczki
// nadanej kurierem BEZ sledzenia.
// Od 23.08 rozstrzyga to BEHAWIORALNIE domain/sledzenie-przesylki.js (jedna czysta regula
// dla karty i zegara przesylek), a stary test po zrodle odszedl razem z przeprowadzka
// funkcji do services/status-kuriera.js. WzA z para carrierId+carrierWaybill w surowej
// odpowiedzi pytamy PODWYKONAWCE (zmierzone sonda 23.08: kanal zdarzen DPD odpowiada
// takze dla listow kupionych przez Allegro); bez pary — cisza i sprzatniecie osadu,
// dokladnie jak dawna galaz `bezSledzenia`.
describe('kurier bez śledzenia nie zaśmieca logu', () => {
  const surowaZDpd = JSON.stringify({ carrierTrackingData: { carrierId: 'DPD', carrierWaybill: '1049000000001U' } });

  it('karta paczki allegro_wza BEZ pary przewoźnika nie dopisuje błędu przy otwarciu', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(8801), {});
    const p = rozpocznijPrzesylke(db, id, 'allegro_wza');
    zakonczPrzesylke(db, p.id, { numerListu: 'AD0TESTBEZPARY', etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
    const app = buildOmsServer({ db, config, poller, kurierzy: { allegro_wza: { bezSledzenia: true } } });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy.some((w) => /allegro_wza\.status/.test(w.akcja ?? ''))).toBe(false);
  });

  it('karta paczki allegro_wza Z parą pyta podwykonawcę DPD numerem carrierWaybill', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(8802), {});
    const p = rozpocznijPrzesylke(db, id, 'allegro_wza');
    zakonczPrzesylke(db, p.id, { numerListu: 'AD0TESTZPARA', etykietaSciezka: '/tmp/e.pdf', surowa: surowaZDpd });
    const pytania = [];
    const dpd = {
      statusPrzesylki: async (numer) => { pytania.push(numer); return { opis: 'Przesyłka doręczona', at: '2026-08-22T10:00:00.000' }; },
    };
    const app = buildOmsServer({ db, config, poller, kurierzy: { dpd, allegro_wza: { bezSledzenia: true } } });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(pytania).toEqual(['1049000000001U']);
    const wiersz = db.prepare('SELECT status_kuriera FROM przesylki WHERE id = ?').get(p.id);
    expect(wiersz.status_kuriera).toBe('Przesyłka doręczona');
  });
});

// Pastylka ETAPU przesylki na karcie (23.08) — ta sama regula, co zakladka /przesylki
// (domain/etap-przesylki.js): klasa stanu + dni KALENDARZOWE w drodze, surowy opis obok.
describe('pastylka etapu przesyłki na karcie', () => {
  it('paczka w drodze pokazuje etap z dniami, surowy opis zostaje obok', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    try {
      const id = zapiszZamowienie(db, 'pro', zmapowane(8901), {});
      const p = rozpocznijPrzesylke(db, id, 'dpd');
      zakonczPrzesylke(db, p.id, { numerListu: 'ETAP1', etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
      db.prepare('UPDATE przesylki SET utworzona_at = ?, status_kuriera = ?, status_kuriera_at = ? WHERE id = ?')
        .run('2026-08-21T10:00:00.000Z', 'Przesyłka odebrana przez Kuriera', '2026-08-21T12:00:00.000', p.id);
      const app2 = buildOmsServer({ db, config, poller });
      await app2.ready();
      const r = await app2.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
      expect(r.body).toContain('W drodze (2 dni)');
      expect(r.body).toContain('pastylka--etap-w_drodze');
      expect(r.body).toContain('Przesyłka odebrana przez Kuriera');
    } finally { vi.useRealTimers(); }
  });
});
