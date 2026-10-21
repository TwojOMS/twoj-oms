import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pobierzZamowienie, dodajPozycjeReczna, zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { podsumowaniePozycji } from '../../../src/domena/tabela-pozycji.js';
import { adresOdbiorcy } from '../../../src/domena/adres-odbiorcy.js';
import { daneFaktury } from '../../../src/domena/dane-faktury.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

describe('utworzZamowienieReczne', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); });

  it('nadaje numer z własnej serii i oznacza pochodzenie', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const z = pobierzZamowienie(db, id);
    expect(z.sklep).toBe('reczne');
    expect(z.numer).toMatch(/^R\/\d{4}\/\d{3}$/);
  });

  it('drugie zamówienie dostaje kolejny numer', () => {
    const a = pobierzZamowienie(db, utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' }));
    const b = pobierzZamowienie(db, utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' }));
    expect(a.numer).not.toBe(b.numer);
  });

  // ⚠️ Bez tego kazde reczne zamowienie wisialoby z blokada bariery arytmetycznej.
  it('kwota zamówienia idzie za pozycjami i dostawą', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', koszt_dostawy_brutto: '23.00' });
    dodajPozycjeReczna(db, id, { nazwa: 'A', sku: null, ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00' });
    przeliczKwoteRecznego(db, id);
    const z = pobierzZamowienie(db, id);
    expect(z.kwota_brutto).toBe('123.00');
    expect(podsumowaniePozycji(z).zgadzaSie).toBe(true);
  });

  // ⚠️ TO SA PIENIADZE, KTORE INKASUJE KURIER. Ekran zakladania NIE MA pola „kwota pobrania"
  // (decyzja wlasciciela 2026-08-01: „wyjdzie sama po dodaniu produktow") — wiec musi ja
  // wyliczac panel, i to za KAZDYM razem, gdy zmienia sie pozycje albo koszt dostawy.
  // Zapisana raz przy zakladaniu zestarzalaby sie przy pierwszej dopisanej pozycji i kurier
  // zainkasowalby za malo. Tak samo dziala sklep (domain/mapowanie.js: kwota_pobrania = total).
  it('przy pobraniu kwota pobrania idzie za kwotą zamówienia', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', pobranie: 1, koszt_dostawy_brutto: '23.00' });
    dodajPozycjeReczna(db, id, { nazwa: 'A', sku: null, ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00' });
    przeliczKwoteRecznego(db, id);
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBe('123.00');
  });

  it('dopisanie pozycji podnosi kwotę pobrania razem z kwotą zamówienia', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', pobranie: 1 });
    dodajPozycjeReczna(db, id, { nazwa: 'A', sku: null, ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' });
    przeliczKwoteRecznego(db, id);
    dodajPozycjeReczna(db, id, { nazwa: 'B', sku: null, ilosc: 1, cena_brutto: '30.00', brutto_linii: '30.00' });
    przeliczKwoteRecznego(db, id);
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBe('80.00');
  });

  // Bez pobrania kolumna MUSI zostac pusta — niezerowa kwota przy zwyklej wysylce znaczy
  // dla kuriera „zainkasuj", a klient juz zaplacil przelewem (patrz kurierzy/dpd.js: <cod>).
  it('bez pobrania kwota pobrania zostaje pusta', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    dodajPozycjeReczna(db, id, { nazwa: 'A', sku: null, ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' });
    przeliczKwoteRecznego(db, id);
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBeNull();
  });

  // Suma zero to NIE JEST pobranie na 0,00 — DPD wymaga kwoty > 0 i po cichu pomija <cod>,
  // a karta pokazywalaby „za pobraniem" bez ani zlotowki.
  it('zamówienie bez pozycji nie dostaje pobrania na zero', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', pobranie: 1 });
    przeliczKwoteRecznego(db, id);
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBeNull();
  });

  it('poller nie ma jak dotknąć zamówienia ręcznego', () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    // Poller zapisuje po parze (sklep, zrodlo_id) i pyta wylacznie o 'pro'.
    expect(pobierzZamowienie(db, id).sklep).toBe('reczne');
  });

  // C2 (recenzja calej galezi): `zrodlo_id` liczony z SAMEJ pozycji w roku zerowal sie
  // razem z licznikiem serii (nastepnyNumerReczny) — pierwsze zamowienie nowego roku
  // dostawaloby ten sam `zrodlo_id`, co pierwsze zamowienie roku poprzedniego, a
  // `UNIQUE (sklep, zrodlo_id)` w schema.sql nie wie nic o latach. Test przechodzi
  // PRZEZ PRAWDZIWA trase zakladania (utworzZamowienieReczne), nie przez samo
  // zrodloIdReczne() wolane recznie — inaczej mutacja "wroc do samej pozycji" mialaby
  // szanse przezyc na poziomie funkcji domenowej, ktorej test w ogole by nie zauwazyl.
  it('zamówienie założone na przełomie lat NIE zderza się po zrodlo_id (test obowiązkowy)', () => {
    const idA = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', rok: 2026 });
    // Bez poprawki ponizszy INSERT rzucalby: oba lata licza "pierwsze zamowienie" jako
    // pozycje 1, a stara wersja zapisywala ta pozycje wprost jako zrodlo_id.
    expect(() => utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', rok: 2027 })).not.toThrow();
    const idB = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', rok: 2027 });

    const a = pobierzZamowienie(db, idA);
    const b = pobierzZamowienie(db, idB);
    expect(a.numer).toBe('R/2026/001');
    expect(b.numer).toBe('R/2027/002'); // drugie zamowienie 2027 w tym teście
    expect(a.zrodlo_id).not.toBe(b.zrodlo_id);
  });

  // Sama numeracja WIDOCZNA (R/RRRR/NNN) ma sie zerowac z rokiem tak jak dotychczas —
  // to `zrodlo_id` w bazie jest jedynym, co sie zmienilo, nie numer, ktory widzi operator.
  it('numer WIDOCZNY nadal zaczyna się od 001 w nowym roku, mimo zmiany kodowania zrodlo_id', () => {
    utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', rok: 2026 });
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', rok: 2027 });
    expect(pobierzZamowienie(db, id).numer).toBe('R/2027/001');
  });
});

// Formularz zakladania przeszedl 2026-08-01 z „rodzaj + nazwisko" na PELNY ekran: dane do
// wysylki, dane do faktury (z GUS-em), dostawa, platnosc i piec wierszy pozycji — jednym
// zapisem. Ponizsze testy sprawdzaja TRASY, nie sam parser (ten ma wlasny plik
// tests/oms/nowe-zamowienie.test.js): mutacja usuwajaca wywolanie z trasy nie ma jak wpasc
// na testy domenowe.
describe('trasy zakładania zamówienia', () => {
  let db, app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config, poller });
    await app.ready();
  });

  const zaloz = (payload) => app.inject({ method: 'POST', url: '/zamowienia/nowe', headers: naglowek, payload });
  const idZOdpowiedzi = (r) => Number(r.headers.location.split('/').pop());

  // PRZ-103 (21.10.2026, prośba właściciela „zrób 1 wiersz na start”): kolejne dokłada „+ Dodaj wiersz”.
  it('GET pokazuje trzy kolumny karty i jeden wiersz pozycji', async () => {
    const r = await app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Dane do wysyłki');
    expect(r.body).toContain('Dane do faktury');
    expect(r.body).toContain('Szczegóły zamówienia');
    expect(r.body.match(/name="poz_nazwa"/g)).toHaveLength(1);
  });

  it('lista ma odnośnik do zakładania', async () => {
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(r.body).toContain('/zamowienia/nowe');
  });

  // „Wszystkie pola nieobowiazkowe" (decyzja wlasciciela 2026-08-01) — do 2026-08-01 trasa
  // odmawiala bez nazwiska albo firmy. Numer nadany przy telefonie jest wart wiecej niz
  // komplet danych; karta i tak zapali blokade przy nadaniu i przy fakturze.
  it('pusty formularz zakłada zamówienie, nie odmawia', async () => {
    const r = await zaloz({});
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, idZOdpowiedzi(r));
    expect(z.sklep).toBe('reczne');
    expect(z.kwota_brutto).toBe('0.00');
    expect(podsumowaniePozycji(z).zgadzaSie).toBe(true);
  });

  it('zakłada zamówienie z adresem, nabywcą i pozycjami w JEDNYM zapisie', async () => {
    const r = await zaloz({
      w_nazwa: 'Anna Kowalska', w_ulica: 'Krótka 12', w_kod: '32-600', w_miasto: 'Oświęcim',
      w_telefon: '600100200', w_email: 'anna@example.pl',
      f_chce_fakture: 'on', f_firma: 'LUMINA', f_nip: '6762432557',
      f_ulica: 'Przykładowa 5', f_kod: '32-600', f_miasto: 'Oświęcim',
      dostawa: 'dpd', platnosc: 'przelew', koszt_dostawy_brutto: '23,00',
      poz_nazwa: ['Szablon', 'Projekt', '', '', ''],
      poz_sku: ['SZ-1', '', '', '', ''],
      poz_ilosc: ['2', '1', '', '', ''],
      poz_cena_netto: ['', '', '', '', ''],
      poz_cena_brutto: ['80,00', '50.00', '', '', ''],
    });
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, idZOdpowiedzi(r));

    // Adres czytamy TA SAMA funkcja, ktora karmi ekran nadania i klienta DPD.
    expect(adresOdbiorcy(z)).toMatchObject({
      nazwa: 'Anna Kowalska', ulica: 'Krótka 12', kod: '32-600', miasto: 'Oświęcim',
      kraj: 'PL', phone: '600100200', email: 'anna@example.pl',
    });
    expect(daneFaktury(z)).toMatchObject({ firma: 'LUMINA', nip: '6762432557', miasto: 'Oświęcim' });
    expect(z.chce_fakture).toBe(1);
    expect(z.pozycje).toHaveLength(2);
    // 2×80 + 1×50 + 23 dostawy. Bariera arytmetyczna musi sie zgadzac OD RAZU — inaczej
    // faktura bylaby zablokowana od pierwszej sekundy zycia zamowienia.
    expect(z.kwota_brutto).toBe('233.00');
    expect(podsumowaniePozycji(z).zgadzaSie).toBe(true);
  });

  it('kurier z pobraniem zapisuje dpd + flagę pobrania, a kwota pobrania równa się kwocie zamówienia', async () => {
    const r = await zaloz({
      dostawa: 'dpd', platnosc: 'pobranie', koszt_dostawy_brutto: '20',
      poz_nazwa: 'Szablon', poz_sku: '', poz_ilosc: '1', poz_cena_netto: '', poz_cena_brutto: '100.00',
    });
    expect(r.statusCode).toBe(302);
    const z = pobierzZamowienie(db, idZOdpowiedzi(r));
    expect(z.metoda_wysylki).toBe('dpd');
    // ⚠️ TO SA PIENIADZE: pobranie z ekranu zakladania MUSI dojechac do wlasnej kolumny.
    expect(z.pobranie).toBe(1);
    expect(z.metoda_platnosci).toBe('Pobranie');
    expect(z.kwota_pobrania).toBe('120.00');
  });

  it('odbiór osobisty z gotówką zapisuje się bez pobrania', async () => {
    const r = await zaloz({ dostawa: 'odbior_osobisty', platnosc: 'gotowka' });
    const z = pobierzZamowienie(db, idZOdpowiedzi(r));
    expect(z.metoda_wysylki).toBe('odbior_osobisty');
    expect(z.metoda_platnosci).toBe('Gotówka');
    expect(z.kwota_pobrania).toBeNull();
  });

  // ⚠️ Odmowa MUSI byc CALKOWITA i MUSI oddac formularz. Zamowienie z numerem, ale bez
  // pozycji, zostawaloby w bazie na zawsze (nie ma trasy kasujacej), a goly komunikat na
  // pustej stronie kasowalby wszystko, co operator wpisal przy sluchawce.
  it.each([
    ['odbiór osobisty z pobraniem', { dostawa: 'odbior_osobisty', platnosc: 'pobranie' }, /wykluczają się/i],
    ['nieznany sposób dostawy', { dostawa: 'teleport', platnosc: 'przelew' }, /nie znam sposobu dostawy/i],
    ['nieznany rodzaj płatności', { dostawa: 'dpd', platnosc: 'bitcoin' }, /nie znam rodzaju płatności/i],
    ['ujemny koszt dostawy', { koszt_dostawy_brutto: '-5' }, /ujemny/i],
  ])('%s dostaje odmowę i nie zakłada niczego', async (_nazwa, payload, wzorzec) => {
    const przed = db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n;
    const r = await zaloz({ w_nazwa: 'Jan Kowalski', ...payload });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie udało się założyć zamówienia/i);
    expect(r.body).toMatch(wzorzec);
    // Formularz wraca wypelniony — inaczej operator przepisywalby wszystko od nowa.
    expect(r.body).toContain('Jan Kowalski');
    expect(db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n).toBe(przed);
  });

  // Wiersz ZACZETY, ale niedokonczony, nie ma prawa zniknac po cichu — klient zaplacilby
  // za pozycje, ktorej na zamowieniu nie ma.
  it('wiersz pozycji bez ceny wskazuje operatorowi numer wiersza i nie zakłada zamówienia', async () => {
    const przed = db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n;
    const r = await zaloz({
      poz_nazwa: ['', 'Szablon', '', '', ''],
      poz_sku: ['', '', '', '', ''],
      poz_ilosc: ['', '1', '', '', ''],
      poz_cena_netto: ['', '', '', '', ''],
      poz_cena_brutto: ['', '', '', '', ''],
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/wiersz 2/i);
    expect(db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n).toBe(przed);
  });

  it('cena podana samym netto zapisuje się jako brutto', async () => {
    const r = await zaloz({
      poz_nazwa: 'Szablon', poz_sku: '', poz_ilosc: '1',
      poz_cena_netto: '65,04', poz_cena_brutto: '',
    });
    expect(pobierzZamowienie(db, idZOdpowiedzi(r)).pozycje[0].cena_brutto).toBe('80.00');
  });

  // ⚠️ ZAMOWIENIE POL-ZALOZONE. Numeru nie da sie zwolnic (`utworzZamowienieReczne` domyka
  // wlasna transakcje), wiec wyjatek z DALSZYCH krokow zostawia w bazie zamowienie z nadanym
  // numerem i bez pozycji. Operator MUSI ten numer zobaczyc, inaczej zalozy DRUGIE zamowienie
  // z drugim numerem na te sama sprzedaz. Numer niesie sam wyjatek (services/zamowienie-reczne.js),
  // a TA trasa ma go z niego wyjac — testy serwisu tego kawalka nie dotykaja.
  it('błąd PO nadaniu numeru pokazuje operatorowi numer i przypina wpis w dzienniku do zamówienia', async () => {
    // Awaria wymuszona dokladnie POMIEDZY nadaniem numeru a reszta sekwencji: zapis pozycji
    // odmawia na poziomie bazy (to samo, co SQLITE_BUSY albo pelny dysk w polowie zapisu).
    // Danymi z formularza sie tego nie wymusi — parser zamienia kazde pole na tekst.
    db.exec("CREATE TRIGGER pozycje_odmowa BEFORE INSERT ON pozycje BEGIN SELECT RAISE(ABORT, 'dysk pełny'); END");
    const r = await zaloz({
      w_nazwa: 'Jan Kowalski',
      poz_nazwa: 'Szablon', poz_sku: '', poz_ilosc: '1', poz_cena_netto: '', poz_cena_brutto: '100,00',
    });
    expect(r.statusCode).toBe(500);
    expect(r.body).toContain('nr wewnętrzny');

    const z = db.prepare("SELECT id, numer FROM zamowienia WHERE sklep = 'reczne'").get();
    expect(z.numer).toMatch(/^R\/\d{4}\/\d+$/);
    // NUMER TEGO zamowienia, nie jakikolwiek — komunikat ma kierowac operatora na wlasciwa kartę.
    expect(r.body).toContain(`nr wewnętrzny ${z.id}`);
    // Formularz wraca wypelniony, tak samo jak przy odmowie parsowania.
    expect(r.body).toContain('Jan Kowalski');

    // Wpis w dzienniku PRZYPIETY do zamowienia. Z `zamowienie_id = null` slad po awarii
    // lezalby w logu ogolnym, a na karcie pol-zalozonego zamowienia nie byloby po niej nic.
    const wpis = db.prepare("SELECT zamowienie_id, wynik FROM log WHERE akcja = 'zamowienie.reczne'").get();
    expect(wpis.zamowienie_id).toBe(z.id);
    expect(wpis.wynik).toMatch(/^BŁĄD ZAPISU/);
  });

  it('osobny e-mail do faktury nie podmienia e-maila wysyłki', async () => {
    const r = await zaloz({ w_email: 'anna@example.pl', f_email: 'faktury@firma.pl' });
    const z = pobierzZamowienie(db, idZOdpowiedzi(r));
    expect(daneFaktury(z).email).toBe('faktury@firma.pl');
    expect(adresOdbiorcy(z).email).toBe('anna@example.pl');
  });
});

describe('pobranie z GUS przed założeniem zamówienia', () => {
  let db;
  const zbuduj = (gus) => buildOmsServer({ db, config, poller, gus });

  beforeEach(() => { db = openOmsDb(':memory:'); });

  const pytaj = async (app, payload) => {
    await app.ready();
    return app.inject({ method: 'POST', url: '/zamowienia/nowe/gus', headers: naglowek, payload });
  };

  it('wypełnia pola odpowiedzią z REGON-u i NICZEGO nie zapisuje', async () => {
    const app = zbuduj({
      firmaPoNip: async () => ({ firma: 'LUMINA Marek Zywiecki', nip: '6762432557', regon: '123', ulica: 'Przykładowa 5', kod: '32-600', miasto: 'Oświęcim' }),
    });
    const r = await pytaj(app, { f_nip: '6762432557', w_nazwa: 'Anna Kowalska' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('LUMINA Marek Zywiecki');
    // Reszta formularza NIE MOZE zniknac — operator wpisuje ja w trakcie tej samej rozmowy.
    expect(r.body).toContain('Anna Kowalska');
    // ⚠️ Nic nie powstalo: to jest cala roznica miedzy „pobierz" a „zapisz".
    expect(db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n).toBe(0);
  });

  it('nieznany NIP daje komunikat, nie awarię', async () => {
    const app = zbuduj({ firmaPoNip: async () => null });
    const r = await pytaj(app, { f_nip: '6762432557' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/nie zna firmy/i);
  });

  // Awaria GUS-u nie ma prawa wywalic ekranu razem z tym, co operator zdazyl wpisac.
  it('awaria GUS-u nie wywala ekranu i nie gubi wpisanych pól', async () => {
    const app = zbuduj({ firmaPoNip: async () => { throw new Error('ETIMEDOUT'); } });
    const r = await pytaj(app, { f_nip: '6762432557', w_nazwa: 'Anna Kowalska' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/nie udało się zapytać gus/i);
    expect(r.body).toContain('Anna Kowalska');
  });

  // ⚠️ USTALENIE RECENZJI 2026-08-01: „Pobierz z GUS" byl PIERWSZYM przyciskiem typu submit
  // w formularzu, a wlasnie pierwszy w kolejnosci znacznikow jest PRZYCISKIEM DOMYSLNYM —
  // tym, ktory wciska Enter. Operator wpisywal nazwisko, wciskal Enter i zamiast zalozonego
  // zamowienia dostawal ekran z komunikatem GUS-u. Test pilnuje samej KOLEJNOSCI, bo to ona
  // rozstrzyga; zachowania Entera nie da sie sprawdzic bez przegladarki, a ta wlasnosc tak.
  it('pierwszy przycisk formularza zakłada zamówienie, a nie pyta GUS (to on obsługuje Enter)', async () => {
    const app = zbuduj({ firmaPoNip: async () => null });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek });

    const formularz = r.body.slice(r.body.indexOf('<form method="post" action="/zamowienia/nowe"'));
    const pierwszyPrzycisk = formularz.slice(formularz.indexOf('<button'));
    const znacznik = pierwszyPrzycisk.slice(0, pierwszyPrzycisk.indexOf('>') + 1);

    expect(znacznik).not.toContain('formaction');
    expect(pierwszyPrzycisk.slice(0, 200)).toContain('Załóż zamówienie');
    // Przycisk GUS-u MUSI w tym formularzu byc — inaczej test przechodzilby dlatego,
    // ze nie ma z czym konkurowac.
    // ⚠️ Adres niesie KOTWICE (21.08.2026) — bez niej ekran po pobraniu z GUS-u wraca na gore
    // i operator szuka miejsca, w ktorym byl. Patrz tests/oms/nowe-zamowienie-ekran.test.js.
    expect(formularz).toContain('formaction="/zamowienia/nowe/gus#faktura"');
  });

  it('bez skonfigurowanego GUS-u mówi to wprost, zamiast milczeć', async () => {
    const r = await pytaj(zbuduj(null), { f_nip: '6762432557' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/nie jest skonfigurowany/i);
  });
});

// Powiazanie dosylki przeniosło sie 2026-08-01 z ekranu zakladania na KARTE (pole zniknelo
// z formularza na prosbe wlasciciela). Bez tych tras dosylka nie mialaby jak pokazac sie
// przy zamowieniu, ktorego dotyczy — a wtedy reklamacja liczy sie drugi raz jako sprzedaz.
describe('powiązanie dosyłki z karty', () => {
  let db, app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config, poller });
    await app.ready();
  });

  const powiaz = (id, numer) => app.inject({
    method: 'POST', url: `/zamowienia/${id}/dosylka`, headers: naglowek,
    payload: { numer_zrodlowy: numer },
  });

  it('wskazanie numeru widocznego wiąże dosyłkę z zamówieniem pierwotnym', async () => {
    const pierwotneId = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const dosylkaId = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const r = await powiaz(dosylkaId, pobierzZamowienie(db, pierwotneId).numer);
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, dosylkaId).zamowienie_zrodlowe_id).toBe(pierwotneId);
  });

  // Pomylka w numerze MUSI miec droge powrotna — bez niej zlaczylaby dwa obce sobie
  // zamowienia na stale.
  it('puste pole kasuje powiązanie', async () => {
    const pierwotneId = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const dosylkaId = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    await powiaz(dosylkaId, pobierzZamowienie(db, pierwotneId).numer);
    const r = await powiaz(dosylkaId, '');
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, dosylkaId).zamowienie_zrodlowe_id).toBeNull();
  });

  it('karta pokazuje pole z numerem już powiązanego zamówienia', async () => {
    const pierwotneId = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const dosylkaId = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const numer = pobierzZamowienie(db, pierwotneId).numer;
    await powiaz(dosylkaId, numer);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${dosylkaId}?edytuj=szczegoly`, headers: naglowek });
    expect(r.body).toContain(`value="${numer}"`);
  });

  // ⚠️ To samo, co „dosylka do samego siebie", ale w DWOCH krokach (ustalenie recenzji
  // 2026-08-01). Nic sie nie zapetla, ale OBIE karty pokazywalyby to samo zamowienie
  // naraz jako pierwotne i jako dosylke.
  it('powiązania w obie strony nie da się zbudować dwoma zapisami', async () => {
    const a = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const b = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    await powiaz(b, pobierzZamowienie(db, a).numer); // B jest dosyłką do A

    const r = await powiaz(a, pobierzZamowienie(db, b).numer); // A miałoby być dosyłką do B
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/w obie strony/i);
    expect(pobierzZamowienie(db, a).zamowienie_zrodlowe_id).toBeNull();
    expect(pobierzZamowienie(db, b).zamowienie_zrodlowe_id).toBe(a);
  });

  it('nieistniejący numer dostaje czytelną odmowę, nie 500', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const r = await powiaz(id, 'R/2026/999');
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie ma zamówienia o numerze/i);
    expect(pobierzZamowienie(db, id).zamowienie_zrodlowe_id).toBeNull();
  });

  // Zamowienie wskazujace samo siebie bylo by jednoczesnie pierwotnym i dosylka na wlasnej
  // karcie — stan bez sensu, ktory dodatkowo zatruwa raporty.
  it('zamówienie nie może być dosyłką do samego siebie', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const r = await powiaz(id, pobierzZamowienie(db, id).numer);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/samego siebie/i);
    expect(pobierzZamowienie(db, id).zamowienie_zrodlowe_id).toBeNull();
  });

  // ⚠️ Numery sklepowe i numery serii recznej to DWIE ROZNE PRZESTRZENIE bez wspolnego
  // ograniczenia unikalnosci (patrz znajdzZamowieniaPoNumerze) — kolizja jest dzis
  // nieosiagalna, ale symulujemy ja wprost: ma byc odmowa, NIE ciche powiazanie
  // z pierwszym z brzegu.
  it('numer pasujący do dwóch zamówień dostaje odmowę, nie ciche powiązanie', async () => {
    const zmapowane = (zrodloId) => ({
      zrodlo_id: zrodloId, numer: '5555', klient: { email: 'a@b.pl' }, dostawa: { city: 'Pęki' },
      metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
      kwota_brutto: '10.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-07-31T09:00:00', pozycje: [],
    });
    zapiszZamowienie(db, 'pro', zmapowane(9001), {});
    zapiszZamowienie(db, 'pro', zmapowane(9002), {});
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });

    const r = await powiaz(id, '5555');
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/więcej niż jednego zamówienia/i);
    expect(pobierzZamowienie(db, id).zamowienie_zrodlowe_id).toBeNull();
  });
});

// ⚠️ Testy WPROST na trasach HTTP, nie tylko na przeliczKwoteRecznego() wołanej ręcznie:
// mutacja usuwająca wywołanie z trasy (a nie z funkcji) nie ma jak wpaść na testy wyżej,
// bo one same wołają przeliczKwoteRecznego. Bez tego bloku mutacja „usuń wywołanie z trasy"
// przeżyłaby całą suitę.
describe('trasy pozycji przeliczają kwotę zamówienia ręcznego (weryfikacja przez HTTP)', () => {
  let db, app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config, poller });
    await app.ready();
  });

  it('dodanie pozycji przez POST /pozycje podnosi kwotę zamówienia', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/pozycje`, headers: naglowek,
      payload: { nazwa: 'Szablon', ilosc: '2', cena_brutto: '50.00' },
    });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('100.00');
  });

  it('zapis hurtowy przez POST /pozycje/zapisz przelicza kwotę po zmianie ilości', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    dodajPozycjeReczna(db, id, { nazwa: 'Szablon', sku: null, ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' });
    przeliczKwoteRecznego(db, id);
    const klucz = pobierzZamowienie(db, id).pozycje[0].klucz;
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/pozycje/zapisz`, headers: naglowek,
      payload: { klucz: [klucz], nazwa: ['Szablon'], ilosc: ['3'], cena_brutto: ['50.00'] },
    });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('150.00');
  });

  it('usunięcie pozycji przez POST /pozycje/:klucz/usun zmniejsza kwotę zamówienia', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    dodajPozycjeReczna(db, id, { nazwa: 'A', sku: null, ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' });
    dodajPozycjeReczna(db, id, { nazwa: 'B', sku: null, ilosc: 1, cena_brutto: '30.00', brutto_linii: '30.00' });
    przeliczKwoteRecznego(db, id);
    const zPrzed = pobierzZamowienie(db, id);
    expect(zPrzed.kwota_brutto).toBe('80.00');
    const klucz = zPrzed.pozycje[0].klucz;
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/pozycje/${klucz}/usun`, headers: naglowek,
    });
    expect(r.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('30.00');
  });
});

// ⚠️ USTALENIA RECENZJI CALEJ ZMIANY (2026-08-01) — OBA O PIENIADZACH, KTORE INKASUJE KURIER.
// Kwota pobrania ma DWA miejsca: kolumne `kwota_pobrania` (nalezaca do metody z kolumny)
// i kwote w nadpisaniu `wysylka_reczna_json` (nalezaca do metody wlaczonej z karty). Ta
// druga wygrywa przy odczycie. Pomylenie ich gubi pobranie BEZ ANI JEDNEGO BLEDU.
describe('kwota pobrania przy zmianach metody z karty (weryfikacja przez HTTP)', () => {
  let db, app;
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    app = buildOmsServer({ db, config, poller });
    await app.ready();
  });

  const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
  const dopisz = (id, cena) => post(`/zamowienia/${id}/pozycje`, { nazwa: 'Dodatek', ilosc: '1', cena_brutto: cena });

  // Scenariusz z recenzji: pobranie → „Zmień metodę" na dpd bez pobrania → ruch na
  // pozycjach → „Przywróć metodę ze sklepu". Wracamy do pobrania i kwota MUSI tam być.
  // Bez poprawki kolumna była wyzerowana, DPD nie wstawiało <cod>, a paczka jechała
  // jak przedpłacona.
  it('powrót do pobrania po przełączeniu metody NIE gubi kwoty', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd', pobranie: 1 });
    await dopisz(id, '200.00');

    await post(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd' });
    await dopisz(id, '0.01'); // dowolna zmiana pozycji uruchamia przeliczenie
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBeNull(); // efektywnie brak pobrania

    await post(`/zamowienia/${id}/wysylka/przywroc`, {});
    const z = pobierzZamowienie(db, id);
    expect(z.metoda_wysylki).toBe('dpd');
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('200.01');
  });

  // Scenariusz z recenzji: pobranie WLACZONE Z KARTY siedzi w nadpisaniu razem z wlasna
  // kwota, wiec przeliczenie kolumny nic mu nie robilo — kurier inkasowal tyle, ile
  // zamowienie bylo warte PRZED dopisaniem pozycji.
  it('pobranie włączone z karty też nadąża za kwotą zamówienia', async () => {
    const id = utworzZamowienieReczne(db, { metoda_wysylki: 'dpd' });
    await dopisz(id, '100.00');

    await post(`/zamowienia/${id}/wysylka/metoda`, { metoda: 'dpd', pobranie: '1', kwota_pobrania: '100.00' });
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBe('100.00');

    await dopisz(id, '50.00');
    const z = pobierzZamowienie(db, id);
    expect(z.kwota_brutto).toBe('150.00');
    expect(z.kwota_pobrania).toBe('150.00');
  });

  // Zamowienie SKLEPOWE nie ma prawa dostac tego zachowania: tam kwote narzuca sklep,
  // a przeliczKwoteRecznego w ogole nie powinno go tknac.
  it('zamówienia ze sklepu ta reguła nie dotyczy', () => {
    zapiszZamowienie(db, 'pro', {
      zrodlo_id: 7001, numer: '7001', klient: {}, dostawa: {}, metoda_wysylki: 'dpd', pobranie: 1,
      kwota_pobrania: '99.00', chce_fakture: 0, nip: null, kwota_brutto: '99.00',
      status_woo: 'processing', oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-08-01T09:00:00', pozycje: [],
    }, {});
    const id = db.prepare("SELECT id FROM zamowienia WHERE sklep='pro' AND zrodlo_id=7001").get().id;
    przeliczKwoteRecznego(db, id);
    expect(pobierzZamowienie(db, id).kwota_pobrania).toBe('99.00');
  });
});
