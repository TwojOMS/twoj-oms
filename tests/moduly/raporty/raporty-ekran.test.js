import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
let db;

// Zamowienie historyczne o podanym dniu i kwocie — reszta pol jest zawsze taka sama,
// bo w tych testach chodzi o EKRAN, a nie o klasyfikacje (ta ma wlasne testy).
const zamowienie = (apiloId, dzien, brutto, dodatki = {}) => zapiszHistorie(db, {
  apiloId, platformAccountId: 9, numer: `WO-${apiloId}`, dzien,
  utworzoneAt: `${dzien}T10:00:00.000Z`, brutto, tagi: [], status: 15,
  paymentStatus: 2, klientEmail: 'k@klient.pl', faktura: 0,
  pozycje: [{ nazwa: 'Szablon Hamptons', ilosc: 1, bruttoLinii: brutto, typ: 1 }],
  ...dodatki,
});

beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Z KANALY, nie recznie: lista urosla z 9 do 12 po pomiarze i kanal bez granicy
  // PRZERYWA raport, wiec recznie wyliczona lista rozjechalaby sie przy nastepnej zmianie.
  for (const k of KANALY) {
    ustawGranice(db, k, '2026-07-02', 'test', null);
  }
  zapiszHistorie(db, {
    apiloId: 'H1', platformAccountId: 9, numer: 'WO1', dzien: '2026-06-10',
    utworzoneAt: '2026-06-10T10:00:00.000Z', brutto: '246.00', tagi: [], status: 15,
    paymentStatus: 2, klientEmail: 'k@klient.pl', faktura: 0,
    pozycje: [{ nazwa: 'Szablon Hamptons', ilosc: 1, bruttoLinii: '246.00', typ: 1 }],
  });
});

const wejdz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};

describe('ekran /raporty', () => {
  it('domyslnie pokazuje biezacy miesiac i odpowiada 200', async () => {
    const odp = await wejdz('/raporty');
    expect(odp.statusCode).toBe(200);
  });

  it('pokazuje sprzedaz i produkt za wskazany okres', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('246,00');
    expect(odp.body).toContain('Szablon Hamptons');
  });

  it('skrot ustawia zakres', async () => {
    const odp = await wejdz('/raporty?skrot=poprzedni-rok');
    expect(odp.statusCode).toBe(200);
  });

  // ⚠️ Etykiety skrotow przychodza Z DOMENY (`zakresSkrotu`), a nie z drugiej listy napisow
  // w widoku. Gdyby sie rozjechaly, ZADEN przycisk nie bylby zaznaczony jako biezacy —
  // ekran wygladalby poprawnie i po cichu przestal mowic, ktory okres oglada operator.
  it('bieżący skrót jest na ekranie zaznaczony', async () => {
    const odp = await wejdz('/raporty?skrot=poprzedni-rok');
    // ⚠️ Sama tresc strony, BEZ arkusza stylow — ten niesie wlasne `.btn--glowny`
    // (regula i jej `:hover`) i liczenie po calym dokumencie mierzyloby CSS, nie ekran.
    const tresc = odp.body.slice(odp.body.indexOf('<div class="tresc">')).replace(/\s+/g, ' ');
    expect(tresc).toContain('href="/raporty?skrot=ten-miesiac"');
    const przycisk = tresc.match(/<a class="([^"]*)" href="\/raporty\?skrot=poprzedni-rok">/);
    expect(przycisk?.[1]).toContain('btn--glowny');
    // ...i tylko on jeden spośród ośmiu skrótów (drugie trafienie to „Pokaż zakres")
    expect(tresc.match(/btn--glowny/g)).toHaveLength(2);
  });

  // ——— SKROT „DZISIAJ" (31.08.2026, prosba właściciela) ————————————————————————————————
  // ⚠️ ZAKRES SPRAWDZAMY W POLACH FORMULARZA, a nie po nazwie skrotu w adresie: pola
  // niosa daty JUZ ROZWINIETE przez domene, wiec test lapie takze taki blad, po ktorym
  // przycisk odpowiada 200 i pokazuje CALY MIESIAC.
  it('skrót „Dzisiaj" daje zakres jednego dnia', async () => {
    const odp = await wejdz('/raporty?skrot=dzisiaj');
    expect(odp.statusCode).toBe(200);
    const od = /name="od" value="(\d{4}-\d{2}-\d{2})"/.exec(odp.body)?.[1];
    const doDnia = /name="do" value="(\d{4}-\d{2}-\d{2})"/.exec(odp.body)?.[1];
    expect(od).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doDnia).toBe(od);
    // Naglowek ma nazwac ten dzien RAZ, a nie „dzien – dzien" (nazwaOkresu w domenie).
    expect(odp.body).toContain(`sprzedaż w okresie <strong>${od}</strong>`);
  });

  it('„Dzisiaj" stoi w pasku skrótów jako pierwszy odnośnik', async () => {
    const tresc = (await wejdz('/raporty')).body;
    const pasek = tresc.slice(tresc.indexOf('<div class="pola-w-rzedzie">'));
    expect(pasek.indexOf('skrot=dzisiaj')).toBeGreaterThan(-1);
    expect(pasek.indexOf('skrot=dzisiaj')).toBeLessThan(pasek.indexOf('skrot=ten-miesiac'));
    expect(pasek).toContain('>Dzisiaj</a>');
  });

  it('ZLA DATA ODMAWIA, a nie pokazuje pustego raportu — zera nikt nie kwestionuje', async () => {
    const odp = await wejdz('/raporty?od=2026-13-45&do=2026-06-30');
    expect(odp.statusCode).toBe(400);
  });

  it('ODWROCONY ZAKRES tez odmawia', async () => {
    const odp = await wejdz('/raporty?od=2026-06-30&do=2026-06-01');
    expect(odp.statusCode).toBe(400);
  });

  it('BRAK GRANICY KANALU daje czytelna odmowe, nie piecsetke', async () => {
    db.prepare("DELETE FROM granice_historii WHERE kanal = 'SZKICOWNIA_PL'").run();
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toContain('SZKICOWNIA_PL');
  });

  // ⚠️ DATA KALENDARZOWO NIEPOPRAWNA, ale w dobrym FORMACIE — wzorzec `\d{4}-\d{2}-\d{2}`
  // ja przepuszcza, a `new Date('2026-02-30')` cicho przewinie na 2 marca. Odmowe robi
  // dopiero `kluczOkresu` i wlasnie o to chodzi w tym tescie.
  it('31 LUTEGO ODMAWIA, zamiast po cichu przewinac sie na marzec', async () => {
    const odp = await wejdz('/raporty?od=2026-02-30&do=2026-03-31');
    expect(odp.statusCode).toBe(400);
  });

  it('nieznany skrot odmawia zdaniem, nie piecsetka', async () => {
    const odp = await wejdz('/raporty?skrot=od-swieta');
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/skr[oó]t/i);
  });

  // ⚠️ NAZWA KANALU NA EKRANIE JEST DLA CZLOWIEKA. Identyfikator z bazy („SZKICOWNIA_PL")
  // czyta sie jak zrzut z konsoli i nie mowi wlascicielowi nic ponad to, co juz wie.
  it('kanaly maja nazwy czytelne, nie identyfikatory z bazy', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('Szkicownia.pl');
    expect(odp.body).not.toContain('SZKICOWNIA_PL');
  });

  // ⚠️⚠️ ZERO ZNACZY „BEZ ZMIAN" i jest zdaniem o faktach. Przy pustym okresie poprzednim
  // zadnego faktu nie ma, wiec ma stac MYSLNIK — „0%" byloby zmyslonym zdaniem.
  it('delta bez podstawy to myślnik, a nie „0%"', async () => {
    // maj jest pusty, wiec czerwiec nie ma sie do czego porownac
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    // ⚠️ Cztery kafelki KPI, cztery delty — pojedyncze trafienie przepusciloby ekran,
    // na ktorym trzy z nich pokazuja zmyslone zero.
    expect(odp.body.match(/brak porównania/g)).toHaveLength(4);
    // ⚠️ REGULARNE, a nie `toContain('0,0%')`: tamto lapie sie na PODCIAG „100,0%"
    // i przechodzi (albo nie) z zupelnie innego powodu niz badany.
    expect(odp.body).not.toMatch(/[↑↓=]\s*0,0%/);
  });

  // ⚠️ ZMIERZONE: `width: 100,0%` jest deklaracja NIEPOPRAWNA — przegladarka wyrzuca ja
  // w calosci, wiec slupek znika, a liczba obok zostaje i wszystko wyglada poprawnie.
  it('szerokość słupka jest liczbą CSS-a (kropka), nie polskim zapisem', async () => {
    const odp = await wejdz('/raporty?od=2026-05-01&do=2026-06-30');
    expect(odp.body).toMatch(/style="width: \d+\.\d%"/);
    expect(odp.body).not.toMatch(/style="width:[^"]*,/);
  });

  // ⚠️ Slupek ma `min-width: 2px` (zmierzone na prawdziwych danych: kanal z 0,03% udzialu
  // wychodzil na 0 px i wygladal jak brak sprzedazy). Przy sprzedazy ZEROWEJ wypelnienia
  // nie ma byc w ogole — inaczej ten sam prog mowilby, ze cos sie sprzedalo.
  it('miesiąc bez sprzedaży ma pusty tor, bez wypełnienia', async () => {
    const odp = await wejdz('/raporty?od=2026-05-01&do=2026-06-30');
    const wiersze = odp.body.split('<div class="slupek">').slice(1);
    const maj = wiersze.find((w) => w.includes('2026-05'));
    const czerwiec = wiersze.find((w) => w.includes('2026-06'));
    expect(maj).not.toContain('slupek-wypelnienie');
    expect(czerwiec).toContain('slupek-wypelnienie');
  });

  it('delta z podstawa pokazuje kierunek i wartosc', async () => {
    zamowienie('H0', '2026-05-10', '123.00');
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('100,0%');
    expect(odp.body).toContain('↑');
  });

  // ⚠️ Delta rok do roku (druga linijka w kaflu, od 17.08.2026 zamiast osobnej tabeli)
  // przy okresie, ktorego w bazie NIE MA, pokazalaby zero — czyli zapasc sprzedazy o 100%,
  // ktorej nigdy nie bylo. Bez historii linijka ma NIE ISTNIEC.
  it('delta rok do roku milczy, gdy historia nie siega tamtego okresu', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).not.toContain('kafel-delta--rok');
  });

  it('delta rok do roku pokazuje sie w kaflach, gdy tamten okres jest w bazie', async () => {
    zamowienie('H-2025', '2025-06-10', '123.00');
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    // Cztery kafle KPI, cztery delty r/r — kazda z podpisem nazwy tamtego okresu.
    expect(odp.body.match(/kafel-delta--rok/g)).toHaveLength(4);
    expect(odp.body).toContain('2025-06');
    // Sprzedaz 246 vs 123 rok wczesniej — delta ma kierunek i wartosc.
    expect(odp.body).toContain('100,0%');
  });

  // Sezonowosc od DWOCH miesiecy wzwyz — przy jednym nie ma czego porownywac.
  it('sezonowosc rysuje sie od dwoch miesiecy, nie przy jednym', async () => {
    const jeden = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(jeden.body).not.toContain('Sezonowość');
    const dwa = await wejdz('/raporty?od=2026-05-01&do=2026-06-30');
    expect(dwa.body).toContain('Sezonowość');
  });

  // Pas ostrzezen wyjacy przy dobrych danych przestaje cokolwiek znaczyc.
  it('pas ostrzezen milczy, gdy nie ma o czym mowic', async () => {
    const pusty = await wejdz('/raporty?od=2026-05-01&do=2026-05-31');
    expect(pusty.body).not.toContain('Zanim uwierzysz');
    // czerwiec ma zamowienie z historii bez ani jednego tagu — ostrzezenie MA sie pokazac
    const zUwaga = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(zUwaga.body).toContain('Zanim uwierzysz');
    expect(zUwaga.body).toMatch(/nie ma żadnego tagu/);
  });

  // ⚠️ Pola dat stoja w `.zakres-data` (regula z box-sizing w layoucie) — bez niej pole
  // daty (domyslnie content-box) wystaje poza komorke o wysciolke. NIGDY `.rzad`: tamta
  // klasa zweza pola do 6 rem i pole wyglada jak z innej aplikacji.
  it('formularz zakresu stoi na .zakres-formularz, pola dat w .zakres-data', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('class="zakres-formularz"');
    expect(odp.body.match(/class="zakres-data"/g)).toHaveLength(2);
    expect(odp.body).not.toMatch(/<form[^>]*class="[^"]*\brzad\b/);
  });

  // Podzial faktura/paragon i nowi/powracajacy to DWIE karty obok siebie — brief, punkt 6.
  it('pokazuje podzial faktura/paragon i klientow', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('Paragon');
    expect(odp.body).toContain('Nowi');
    expect(odp.body).toContain('Powracający');
  });
});

// ——— PASKI UDZIALU FAKTURA / PARAGON (prosba właściciela 17.08.2026, ze zrzutem) ———————————
// Sucha lista („Faktura: 10 zamowien · 782,01 zl") nie pokazywala PROPORCJI — a to jest
// jedyne pytanie, ktore sie tu zadaje. Dwa paski: po liczbie zamowien i po wartosci.
describe('sekcja „Faktura czy paragon" — paski proporcji', () => {
  // ⚠️ WYCINAMY SEKCJE, nie cale cialo: arkusz stylow jedzie w <style> ukladu, wiec
  // `body).toMatch(/udzial/)` lapie regule CSS i przechodzi przy pustym ekranie.
  const sekcja = (body) => {
    const i = body.indexOf('Faktura czy paragon');
    if (i < 0) throw new Error('Ekran nie ma sekcji „Faktura czy paragon”.');
    return body.slice(i, body.indexOf('</section>', i));
  };

  // ⚠️ MAJ, I TO Z DWOCH POWODOW NARAZ. Granica importu stoi w tym pliku na 2026-07-02,
  // wiec zamowienia PO niej nie licza sie z historii (pierwsza wersja brala 10–12 lipca
  // i sekcja slusznie mowila „nie ma zadnego zamowienia"). A czerwiec ma juz zamowienie
  // z `beforeEach` (12 300 zl), ktore rozjezdzaloby procenty liczone w tych testach.
  // Fikstura musi opisywac okres, w ktorym stoi DOKLADNIE to, co test twierdzi.
  const pokaz = async (od = '2026-05-01', doDnia = '2026-05-31') => {
    const app = buildOmsServer({ db, config });
    await app.ready();
    return (await app.inject({
      method: 'GET', url: `/raporty?od=${od}&do=${doDnia}`, headers: naglowek,
    })).body;
  };

  it('pokazuje oba paski: po liczbie zamowien i po wartosci', async () => {
    zamowienie('F1', '2026-05-10', '1000.00', { faktura: 1 });
    zamowienie('P1', '2026-05-11', '3000.00');

    const s = sekcja(await pokaz());

    expect(s).toMatch(/wg liczby zamówień/i);
    expect(s).toMatch(/wg wartości/i);
  });

  it('kazda czesc paska niesie nazwe, liczbe i procent', async () => {
    zamowienie('F1', '2026-05-10', '1000.00', { faktura: 1 });
    zamowienie('P1', '2026-05-11', '1000.00');
    zamowienie('P2', '2026-05-12', '2000.00');

    const s = sekcja(await pokaz());

    // 1 z 3 zamowien = 33%, wartosc 1000 z 4000 = 25%.
    expect(s).toMatch(/Faktura VAT[\s\S]{0,80}33%/);
    expect(s).toMatch(/Paragon[\s\S]{0,80}67%/);
    expect(s).toMatch(/25%/);
    expect(s).toMatch(/75%/);
  });

  // ⚠️ SZEROKOSC PASKA MUSI ZGADZAC SIE Z NAPISEM W JEGO SRODKU. Mutacja podmieniajaca
  // szerokosc na stala przechodziła, dopoki test sprawdzal sam tekst.
  it('szerokosc czesci odpowiada policzonemu procentowi', async () => {
    zamowienie('F1', '2026-05-10', '1000.00', { faktura: 1 });
    zamowienie('P1', '2026-05-11', '1000.00');
    zamowienie('P2', '2026-05-12', '1000.00');

    const s = sekcja(await pokaz());

    expect(s).toMatch(/style="width: 33\.0%"/);
    expect(s).toMatch(/style="width: 67\.0%"/);
  });

  // ⚠️ PUSTY OKRES: zamiast paska „0% / 0%", ktory wyglada na zmierzony fakt, ekran mowi wprost,
  // ze nie bylo czego mierzyc.
  it('okres bez zamowien nie rysuje paska, tylko mowi ze nie ma danych', async () => {
    const s = sekcja(await pokaz('2026-04-01', '2026-04-30'));

    expect(s).not.toMatch(/style="width:/);
    expect(s).toMatch(/nie ma (jeszcze )?żadnego zamówienia|brak zamówień/i);
  });
});


// ——— PRZEBIEG SPRZEDAZY: „SPRZEDAZ DZIEN PO DNIU" (przebudowa 17.08.2026) ———————————————
describe('wykres „Sprzedaż dzień po dniu"', () => {
  it('rysuje slupek dla dnia ze sprzedaza i pusty tor dla dnia bez niej', async () => {
    const odp = await wejdz('/raporty?od=2026-06-09&do=2026-06-11');
    const sekcja = odp.body.slice(odp.body.indexOf('Sprzedaż dzień po dniu'));
    const dni = sekcja.split('<div class="dzien"').slice(1);
    expect(dni).toHaveLength(3);
    // 10 czerwca ma sprzedaz 246 zl — slupek z wysokoscia; 9 i 11 czerwca pusty tor.
    expect(dni[1]).toMatch(/style="height: 100\.0%"/);
    expect(dni[0]).not.toContain('dzien-slupek');
    expect(dni[2]).not.toContain('dzien-slupek');
  });

  // Okienko :hover (2026-08-28): kazda kolumna niesie karte z data, kwota i liczba
  // zamowien — czysty CSS, zero JS (wyjatek JS ma wylacznie /kampania).
  it('każda kolumna niesie okienko z datą, kwotą i liczbą zamówień', async () => {
    const odp = await wejdz('/raporty?od=2026-06-09&do=2026-06-11');
    const sekcja = odp.body.slice(odp.body.indexOf('Sprzedaż dzień po dniu'));
    const dni = sekcja.split('<div class="dzien"').slice(1);
    expect(dni[1]).toContain('class="dzien-okienko"');
    expect(dni[1]).toContain('246,00 zł');
    expect(dni[1]).toMatch(/okienko-data[^<]*<\/div>/);
    // Dzien BEZ sprzedazy tez ma okienko — zero jest informacja, nie brakiem karty.
    expect(dni[0]).toContain('class="dzien-okienko"');
    expect(dni[0]).toContain('0,00 zł');
  });

  it('podpis dnia niesie date, dzien tygodnia i kwote (aria-label), a najwyzszy slupek kwote wprost', async () => {
    const odp = await wejdz('/raporty?od=2026-06-09&do=2026-06-11');
    // aria-label zamiast title (2026-08-28): wizualnie podpis niesie okienko :hover,
    // a natywny dymek dublowalby je z opoznieniem; czytnik ekranu czyta aria-label.
    expect(odp.body).toMatch(/aria-label="10 czerwca \(śr\)[^"]*246,00 zł/);
    // ⚠️ Po </style>: arkusz niesie regule `.dzien-kwota` i liczenie po calym dokumencie
    // mierzyloby CSS, nie ekran.
    expect(odp.body.split('</style>').pop().match(/dzien-kwota/g)).toHaveLength(1);
  });

  // ⚠️ Prog 62 dni: dluzszy zakres przechodzi na slupki TYGODNIOWE — 90 dziennych kresek
  // na szerokosci karty to szum, nie wykres. Slupki tygodni uzywaja TYCH SAMYCH klas co
  // dzienne (geometria identyczna), wiec rozroznia je naglowek sekcji i LICZBA slupkow.
  it('zakres dluzszy niz 62 dni pokazuje tygodnie, nie dni', async () => {
    const odp = await wejdz('/raporty?od=2026-04-01&do=2026-06-30');
    expect(odp.body).toContain('tydzień po tygodniu');
    // Q2 2026 to 91 dni, ale tylko 14 tygodni — liczba slupkow zdradza, co narysowano.
    expect(odp.body.match(/<div class="dzien"/g).length).toBeLessThan(20);
  });

  it('62 dni to jeszcze slupki dzienne', async () => {
    const odp = await wejdz('/raporty?od=2026-05-01&do=2026-07-01');
    expect(odp.body).toContain('<div class="dzien"');
  });

  // ⚠️ JEDEN SLUPEK TO NIE WYKRES (31.08.2026, razem ze skrotem „Dzisiaj"). Przy zakresie
  // jednodniowym slupek liczy sie wzgledem samego siebie, wiec ZAWSZE ma 100% wysokosci
  // i wypelnia cala szerokosc karty — czarny prostokat, ktory nie mowi nic ponad kafel KPI
  // stojacy nad nim, a wyglada na usterke rysowania. Sekcja ma wtedy nie powstawac.
  // ⚠️ SLUPKI LICZYMY PO `</style>`: arkusz w naglowku niesie w komentarzu DOKLADNIE ten
  // sam napis (ostrzezenie przy `.dzien-okienko`, ktore zakazuje ruszania klasy kolumny),
  // wiec liczenie po calym dokumencie mierzyloby CSS, a nie ekran.
  const ekran = (body) => body.split('</style>').pop();

  it('zakres jednego dnia nie rysuje wykresu przebiegu', async () => {
    const odp = await wejdz('/raporty?od=2026-06-10&do=2026-06-10');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).not.toContain('Sprzedaż dzień po dniu');
    expect(ekran(odp.body)).not.toContain('<div class="dzien"');
    // ...ale sprzedaz tego dnia zostaje na ekranie, w kaflach i w kanalach.
    expect(odp.body).toContain('246,00');
  });

  it('dwa dni to juz wykres', async () => {
    const odp = await wejdz('/raporty?od=2026-06-09&do=2026-06-10');
    expect(odp.body).toContain('Sprzedaż dzień po dniu');
    expect(ekran(odp.body).match(/<div class="dzien"/g)).toHaveLength(2);
  });
});

// ——— KANALY ZE ZMIANA WZGLEDEM POPRZEDNIEGO OKRESU ———————————————————————————————————
describe('kanaly — delta wzgledem poprzedniego okresu', () => {
  const sekcja = (body) => {
    const i = body.indexOf('Skąd przyszła sprzedaż');
    return body.slice(i, body.indexOf('</section>', i));
  };

  it('kanal obecny w obu okresach ma zmiane z kierunkiem', async () => {
    zamowienie('H0', '2026-05-10', '123.00');
    const s = sekcja((await wejdz('/raporty?od=2026-06-01&do=2026-06-30')).body);
    expect(s).toMatch(/kafel-delta--wzrost[^<]*↑ 100,0%/);
  });

  // ⚠️ BRAK PODSTAWY TO MYSLNIK — kanal nieobecny w poprzednim okresie nie ma sie do czego
  // porownac, a zmyslone zero wygladaloby jak zmierzony zastoj.
  it('kanal bez poprzednika ma myslnik, nie zero', async () => {
    const s = sekcja((await wejdz('/raporty?od=2026-06-01&do=2026-06-30')).body);
    expect(s).not.toMatch(/[↑↓] 0,0%/);
    expect(s).toMatch(/kanal-wiersz/);
    expect(s).toContain('—');
  });

  // ——— OKIENKO :hover NA SLUPKU KANALU (31.08.2026, prosba właściciela) ————————————————————
  // Ta sama karta, co przy wykresie dnia (28.08.2026): czysty CSS, zero JS. Okienko stoi
  // PRZED nazwa kanalu w drzewie, wiec wycinek „od okienka do nazwy" to dokladnie jego tresc
  // — i test mierzy kolejnosc razem z zawartoscia.
  const okienko = (s) => s.slice(s.indexOf('class="kanal-okienko"'), s.indexOf('class="kanal-nazwa"'));

  it('okienko kanału niesie kwotę, liczbę zamówień, udział i średnie zamówienie', async () => {
    const s = sekcja((await wejdz('/raporty?od=2026-06-01&do=2026-06-30')).body);
    expect(s).toContain('class="kanal-okienko"');
    const karta = okienko(s);
    expect(karta).toContain('Szkicownia.pl');
    expect(karta).toContain('246,00 zł');
    expect(karta).toContain('1 zamówienie');
    expect(karta).toContain('100,0%');
    // ⚠️ SREDNIE ZAMOWIENIE MIESZKALO DOTAD W `title` wiersza i bylo jedyna liczba, ktorej
    // ekran nie pokazywal wprost — okienko ma je PRZEJAC, a nie zgubic przy przeprowadzce.
    expect(karta).toContain('średnie zamówienie 246,00 zł');
  });

  // ⚠️⚠️ KAZDY WIERSZ NIESIE SWOJE WLASNE LICZBY, A ZADNA Z NICH NIE JEST LICZBA CALEGO
  // OKRESU. Test z jednym kanalem tego NIE POKAZUJE: przy jednej pozycji srednia kanalu,
  // liczba jego zamowien i jego kwota rownaja sie KPI raportu — karta podstawiajaca
  // cokolwiek z gory ekranu wygladalaby wtedy poprawnie (zmierzone: taka mutacja przezyla).
  // Dwa kanaly o ROZNEJ liczbie zamowien rozdzielaja wszystkie te liczby:
  // Szkicownia.pl 300,00 / 2 zam. / śr. 150,00 · Ręczne 100,00 / 1 zam. / śr. 100,00,
  // a caly okres — 400,00 / 3 zam. / śr. 133,33. Zadna para sie nie powtarza.
  it('okienko ma KAŻDY wiersz kanału i niesie liczby TEGO kanału', async () => {
    zamowienie('K2', '2026-06-12', '100.00', { platformAccountId: 21 });
    zamowienie('K3', '2026-06-13', '54.00');
    const s = sekcja((await wejdz('/raporty?od=2026-06-01&do=2026-06-30')).body);
    const wiersze = s.split('class="kanal-wiersz"').slice(1);
    expect(wiersze).toHaveLength(2);
    expect(s.match(/class="kanal-okienko"/g)).toHaveLength(2);

    const [pierwszy, drugi] = wiersze.map(okienko);
    expect(pierwszy).toContain('Szkicownia.pl');
    expect(pierwszy).toContain('300,00 zł');
    expect(pierwszy).toContain('2 zamówienia');
    expect(pierwszy).toContain('75,0%');
    expect(pierwszy).toContain('średnie zamówienie 150,00 zł');

    expect(drugi).toContain('Ręczne');
    expect(drugi).toContain('100,00 zł');
    expect(drugi).toContain('1 zamówienie');
    expect(drugi).toContain('25,0%');
    expect(drugi).toContain('średnie zamówienie 100,00 zł');
  });

  // ⚠️ NATYWNY `title` MA ZNIKNAC RAZEM Z POJAWIENIEM SIE OKIENKA — przegladarka rysuje go
  // z opoznieniem i w innym miejscu, wiec ten sam fakt migalby na ekranie dwa razy (ta sama
  // decyzja, co przy wykresie dnia). Czytnik ekranu dostaje caly podpis w `aria-label`.
  it('wiersz kanału nie ma już natywnego dymka, tylko aria-label', async () => {
    const s = sekcja((await wejdz('/raporty?od=2026-06-01&do=2026-06-30')).body);
    expect(s).not.toMatch(/<div class="kanal-wiersz"[^>]*\stitle=/);
    expect(s).toMatch(/aria-label="[^"]*Szkicownia\.pl[^"]*246,00 zł/);
  });
});

// ——— ARKUSZ, KTORY TE KARTE POKAZUJE ————————————————————————————————————————————————
// ⚠️ PO CO TO TUTAJ: sam znacznik `.kanal-okienko` w HTML-u NIE POKAZUJE NICZEGO. Karta jest
// domyslnie NIEWIDOCZNA (opacity 0, visibility hidden) i o calym jej istnieniu rozstrzyga
// arkusz — gdyby regula `:hover` z niego wypadla, wszystkie testy wyzej dalej swiecilyby
// na zielono, a na ekranie nie byloby nic (ta sama choroba, co przy wysciolce paska filtrow
// na /finanse i przy ukladzie karty zamowienia).
describe('arkusz naprawdę pokazuje kartę kanału', () => {
  const arkusz = async () => (await wejdz('/raporty?od=2026-06-01&do=2026-06-30')).body;

  it('karta odsłania się na :hover wiersza', async () => {
    const regula = /\.kanal-wiersz:hover \.kanal-okienko\s*\{([^}]*)\}/.exec(await arkusz());
    expect(regula).not.toBeNull();
    expect(regula[1]).toMatch(/opacity:\s*1/);
    expect(regula[1]).toMatch(/visibility:\s*visible/);
  });

  // ⚠️ BEZ `position: relative` NA WIERSZU karta kotwiczy sie do dalekiego przodka i lada
  // gdzie — w HTML-u wyglada identycznie.
  it('wiersz jest kotwicą pozycjonowania karty', async () => {
    // ⚠️ WSZYSTKIE reguly konczace sie na `.kanal-wiersz {`, nie pierwsza z brzegu: wiersz
    // dziedziczy siatke po wspolnym selektorze z naglowkiem kolumn i to on stoi w arkuszu
    // wyzej. Wystarczy, ze pozycjonowanie niesie ktorakolwiek z nich.
    const reguly = [...(await arkusz()).matchAll(/\.kanal-wiersz\s*\{([^}]*)\}/g)];
    expect(reguly.length).toBeGreaterThan(0);
    expect(reguly.some((r) => /position:\s*relative/.test(r[1]))).toBe(true);
  });

  // ⚠️ `.panel` ma `overflow: hidden`, wiec karta OSTATNIEGO wiersza zostalaby scieta dolna
  // krawedzia sekcji — pod nim nie ma juz wiersza, ktory by ja pomiescil. Zdejmuje to
  // dopiero `panel--dymki`, a klasa i regula musza istniec OBIE.
  it('sekcja kanałów pozwala karcie wyjść poza panel', async () => {
    const body = await arkusz();
    const przed = body.slice(0, body.indexOf('Skąd przyszła sprzedaż'));
    // Najblizszy PRZED naglowkiem znacznik sekcji — to on ma nosic klase.
    expect(przed.slice(przed.lastIndexOf('<section'))).toMatch(/^<section class="[^"]*panel--dymki/);
    const regula = /\.panel--dymki\s*\{([^}]*)\}/.exec(body);
    expect(regula).not.toBeNull();
    expect(regula[1]).toMatch(/overflow:\s*visible/);
  });
});

// ——— KONCENTRACJA TOP 10 ————————————————————————————————————————————————————————————
describe('koncentracja produktow', () => {
  it('pod lista produktow stoi udzial top 10 w sprzedazy okresu', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toMatch(/odpowiada za[^%]*100,0%/);
  });

  it('pusty okres nie pokazuje koncentracji (null, nie „0%")', async () => {
    const odp = await wejdz('/raporty?od=2026-05-01&do=2026-05-31');
    expect(odp.body).not.toContain('odpowiada za');
  });
});

// ——— OSTRZEZENIA ZWINIETE W <details> ————————————————————————————————————————————————
describe('pas ostrzezen — zwiniety', () => {
  // ⚠️ WYCINAMY TRESC PO </style> — arkusz niesie regule `.ostrzezenia-zwijane`, wiec
  // liczenie po calym dokumencie mierzyloby CSS, nie ekran (ta sama zasada, co przy
  // testach rachunku na /finanse).
  const tresc = (body) => body.split('</style>').pop();

  it('ostrzezenia stoja w <details> z liczba zastrzezen w naglowku', async () => {
    const odp = await wejdz('/raporty?od=2026-06-01&do=2026-06-30');
    expect(tresc(odp.body)).toContain('class="ostrzezenia-zwijane"');
    expect(tresc(odp.body)).toMatch(/Zanim uwierzysz w te liczby<\/strong>[\s\S]{0,40}zastrzeżeni/);
  });

  it('bez ostrzezen nie ma nawet zwinietego paska', async () => {
    const odp = await wejdz('/raporty?od=2026-05-01&do=2026-05-31');
    expect(tresc(odp.body)).not.toContain('ostrzezenia-zwijane');
  });

  // ——— ZASTRZEZENIA DO CALEJ EPOKI ———————————————————————————————————————————————
  // ⚠️ Osobny pas od tego wyzej i CELOWO NIEZWIJANY: tamten mowi o danych okresu, ten
  // o tym, czego archiwum nie wie o epoce sprzed importu z Apilo.
  it('okres siegajacy przed ere Apilo NIESIE zastrzezenie i NIE jest zwiniety', async () => {
    zamowienie('WOO1', '2016-03-01', '100.00', { zrodlo: 'woo:szkicownia', apiloId: 'woo:szkicownia:1' });
    const odp = await wejdz('/raporty?od=2016-01-01&do=2016-12-31');
    // ⚠️⚠️ ASERCJA CELUJE W `class="…"`, NIE W GOLA NAZWE KLASY. Gola nazwa trafia w blok
    // <style> layoutu (jest tam regula `.pasek-uwaga--epoka p`) i przechodzi ZAWSZE — takze
    // wtedy, gdy pas w ogole sie nie renderuje. Zlapane wlasnie tym testem przy pisaniu.
    expect(tresc(odp.body)).toMatch(/class="[^"]*pasek-uwaga--epoka/);
    expect(tresc(odp.body)).toMatch(/wyłącznie sprzedaż sklepu szkicownia\.pl/);
    // Pas ma byc widoczny bez rozwijania — czyli <div>, nie <details> jak pas ostrzezen.
    expect(tresc(odp.body)).toMatch(/<div class="pasek-uwaga pasek-uwaga--epoka"/);
  });

  // ⚠️ Okno startuje DOKLADNIE w dniu najstarszego wiersza z Apilo (H1 z beforeEach, 06-10).
  // Wczesniejszy start — nawet o dzien — siega przed ere Apilo i pas MA sie wtedy pokazac.
  it('okres w calosci po granicy nie niesie zastrzezenia do epoki', async () => {
    const odp = await wejdz('/raporty?od=2026-06-10&do=2026-06-30');
    expect(tresc(odp.body)).not.toMatch(/class="[^"]*pasek-uwaga--epoka/);
  });
});

// ——— SZEROKOSC UKLADU (FHD) ——————————————————————————————————————————————————————————
describe('szerokosc ukladu', () => {
  it('wspólna rama ma stały sufit, a bloki raportu zachowują węższy limit treści', async () => {
    const odp = await wejdz('/raporty');
    expect(odp.body).toMatch(/\.rama-oms \{[^}]*max-width: 1900px[^}]*margin: 0 auto/);
    expect(odp.body).toMatch(/\.kolumna-glowna > [^{]*\{[^}]*max-width: 1222px/);
  });
});
