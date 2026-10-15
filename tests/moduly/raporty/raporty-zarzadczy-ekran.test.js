import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';
import { zapiszDaneMiesiaca } from '../../../src/oms/db/dane-miesieczne.js';
import { zapiszKoszt } from '../../../src/oms/db/koszty.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
let db;

beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Z KANALY, nie recznie: lista urosla z 9 do 12 po pomiarze i kanal bez granicy
  // PRZERYWA raport, wiec recznie wyliczona lista rozjechalaby sie przy nastepnej zmianie.
  for (const k of KANALY) {
    ustawGranice(db, k, '2026-07-02', 'test', null);
  }
  zapiszHistorie(db, {
    apiloId: 'S1', platformAccountId: 9, dzien: '2026-06-10',
    utworzoneAt: '2026-06-10T10:00:00.000Z', brutto: '12300.00', tagi: [], status: 15,
    paymentStatus: 2, klientEmail: 'k@klient.pl', pozycje: [],
  });
});

// ⚠️ `dataTrwalegoZapisu`, `waluta`, `rodzaj` i `numerDokumentu` sa NOT NULL, a `zapiszKoszt`
// idzie przez `INSERT OR IGNORE` — fikstura bez ktoregokolwiek z nich NIE ZAPISZE SIE I NIE
// RZUCI (ta sama pulapka, co w rachunek-zarzadczy.test.js).
const koszt = (numer, dzien, netto, nip = '5252674798') => zapiszKoszt(db, {
  ksefNumber: numer, numerDokumentu: numer, sprzedawcaNip: nip, sprzedawcaNazwa: 'X',
  dataWystawienia: dzien, dataTrwalegoZapisu: `${dzien}T12:00:00Z`,
  netto, vat: '0.00', brutto: netto, waluta: 'PLN', rodzaj: 'VAT', maZalacznik: 0,
});

const wejdz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};

// Sama TRESC strony, bez arkusza stylow — ten niesie wlasne nazwy klas i slowa, wiec
// szukanie po calym dokumencie mierzyloby CSS, a nie ekran (ta sama sztuczka, co
// w raporty-ekran.test.js).
const tresc = (odp) => odp.body.slice(odp.body.indexOf('<div class="tresc">'));

describe('ekran zarzadczy', () => {
  it('pokazuje rachunek za miesiac', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', pit5: '779.00' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('10 000,00');
    expect(odp.body).toContain('2 821,06');
    expect(odp.body).toContain('779,00');
  });

  // ⚠️ MIESIAC MUSI BYC SPOZA `wgrajDaneStartowe` (db/dane-miesieczne.js): ta migracja wgrywa
  // 2026-01…2026-06 z zus.csv przy KAZDYM otwarciu bazy, takze ':memory:'. Test pisany na
  // czerwcu nie sprawdzalby wiec niczego — wiersz tam JEST i zawsze bedzie, wiec sciezka
  // „brak danych" nigdy by sie nie wykonala. Lipiec jest pierwszym niewgranym.
  it('BRAK ZUS: raport powstaje, ale mowi o tym wprost i nie pokazuje „zostaje"', async () => {
    const odp = await wejdz('/finanse?od=2026-07-01&do=2026-07-31');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(/2026-07/);
    expect(tresc(odp)).toMatch(/Nie wpisano danych za/);
    // Odnosnik prowadzi WPROST do ekranu, na ktorym te dane sie wpisuje.
    expect(odp.body).toContain('href="/finanse/dane/2026-07"');
    // ⚠️ „ZOSTAJE" NIE MA PRAWA POKAZAC LICZBY. Wynik pomniejszony o nieznany ZUS wyglada
    // dokladnie tak samo wiarygodnie jak policzony naprawde.
    expect(tresc(odp)).toMatch(/ZOSTAJE[\s\S]{0,400}?nie da się policzyć/);
    // ⚠️⚠️ ...i tak samo NIE MA PRAWA pokazac „− 0,00 zł" przy ZUS-ie i PIT-5. Zero czyta
    // sie jako „składki nie było" — czyli zdanie o faktach, ktorych panel nie zna.
    expect(tresc(odp)).toMatch(/ZUS[\s\S]{0,200}?nie wpisano/);
    expect(tresc(odp)).toMatch(/PIT-5[\s\S]{0,200}?nie wpisano/);
  });

  it('OKRES SPRZED PODLOGI odmawia czytelnie, a nie rysuje zysku bez kosztow', async () => {
    const odp = await wejdz('/finanse?od=2025-06-01&do=2025-06-30');
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toContain('2026-01');
  });

  // ⚠️⚠️ ZDANIE STALE — stoi ZAWSZE, nie warunkowo. Pelna ksiegowosc prowadzi biuro rachunkowe
  // instancji i jego liczby sa wiazace (PRZ-073: bez nazwy biura — ekran widzi kazdy klient).
  it('zdanie „to nie jest wynik ksiegowy" stoi na ekranie ZAWSZE', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06' });
    const pelny = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(pelny.body).toMatch(/To nie jest wynik księgowy/);
    expect(pelny.body).toContain('Wiążące są liczby Twojego biura rachunkowego');
    // ...takze na miesiacu bez ani jednej danej i bez sprzedazy
    const pusty = await wejdz('/finanse?od=2026-07-01&do=2026-07-31');
    expect(pusty.body).toMatch(/To nie jest wynik księgowy/);
  });

  // ⚠️⚠️ VAT POZA RACHUNKIEM. Mylenie go z zyskiem jest klasycznym bledem — to pieniadz
  // przechodni, a nie zarobek.
  it('VAT stoi w OSOBNEJ karcie, a nie w rachunku', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', vat7: '1617.00' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(odp)).toContain('pieniądz przechodni, nie zysk');
    // Kwota VAT-u stoi POZA tabela rachunku — miedzy „ZOSTAJE" a nia nie ma juz zadnego
    // wiersza tabeli.
    const t = tresc(odp);
    const rachunekDo = t.indexOf('ZOSTAJE');
    expect(t.slice(0, rachunekDo)).not.toContain('1 617,00');
    expect(t).toContain('1 617,00');
  });

  // ⚠️⚠️ PROG POKRYCIA 95%: rozbicie policzone z jednej trzeciej wydatkow dalby prog
  // rentownosci, w ktory dalo by sie uwierzyc — a bylby zmysleniem.
  it('POKRYCIE PONIZEJ 95% gasi kategorie i wskazniki, a zdanie mowi ile procent', async () => {
    koszt('K1', '2026-06-05', '500.00');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirKoszty: '4245.83' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(odp)).toMatch(/pokrywają 11,8% kwoty z KPiR/);
    expect(tresc(odp)).not.toContain('Próg rentowności');
    expect(tresc(odp)).not.toContain('Na co poszły pieniądze');
  });

  it('POKRYCIE POWYZEJ 95% wpuszcza kategorie, prog i wskazniki', async () => {
    koszt('K1', '2026-06-05', '2881.04');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirKoszty: '2881.04' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(odp)).toContain('Na co poszły pieniądze');
    expect(tresc(odp)).toContain('Prowizje sprzedażowe');
    expect(tresc(odp)).toContain('Próg rentowności');
    expect(tresc(odp)).toContain('Koszt obsługi zamówienia');
    // ⚠️ Podpis przy prowizji Allegro — faktura dotyczy miesiaca POPRZEDNIEGO.
    expect(tresc(odp)).toMatch(/faktura dotyczy miesiąca poprzedniego/);
  });

  // ⚠️⚠️ DWIE LICZBY OBOK SIEBIE, NIGDY ZSUMOWANE. Sprzedaz po dniu zamowienia i przychod
  // z KPiR (po dacie faktury) to dwa ujecia tego samego — dodane do siebie daja kwote,
  // ktorej nie ma.
  it('roznica przychodu pokazuje obie liczby i nazwana roznice, nie sume', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirPrzychod: '9500.00' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('10 000,00');       // panel
    expect(odp.body).toContain('9 500,00');        // KPiR
    expect(odp.body).toContain('500,00');          // roznica, nazwana
    expect(odp.body).not.toContain('19 500,00');   // NIGDY zsumowane
    // Roznica ma byc NAZWANA, a nie zostawiona czytelnikowi do odjecia w glowie. Po
    // przebudowie 17.08 nazywa ja pas („Rozjazd…" powyzej 5%, „Różnica…" ponizej) zamiast
    // naglowka tabeli — test pilnuje wiec ZNACZENIA, nie tamtego `<th>`.
    expect(tresc(odp)).toMatch(/różnic|rozjazd/i);
    // 5,26% > 5 — ma stac ostrzezenie. ⚠️ Szukamy w TRESCI, nie w calym dokumencie:
    // arkusz stylow w naglowku niesie wlasny komentarz ze slowem „Rozjazd" i test
    // przechodzilby (albo nie) z zupelnie innego powodu niz badany.
    expect(tresc(odp)).toMatch(/rozjazd/i);
  });

  it('roznica przychodu ponizej 5% NIE straszy', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirPrzychod: '9900.00' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(odp)).toContain('9 900,00');
    expect(tresc(odp)).not.toMatch(/rozjazd/i);
  });

  it('podatek jest opisany jako SZACUNEK i pokazuje odleglosc od progu 32%', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', zusSpoleczne: '1788.29' });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(odp)).toContain('SZACUNEK');
    expect(tresc(odp)).toMatch(/do progu 32%/i);
  });

  // Sekcja „miesiac po miesiacu" od DWOCH miesiecy wzwyz — przy jednym nie ma czego porownywac.
  it('miesiac po miesiacu rysuje sie od dwoch miesiecy i ma wiersz Razem', async () => {
    const jeden = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(jeden)).not.toContain('Miesiąc po miesiącu');
    const dwa = await wejdz('/finanse?od=2026-05-01&do=2026-06-30');
    expect(tresc(dwa)).toContain('Miesiąc po miesiącu');
    expect(tresc(dwa)).toContain('Razem');
    expect(tresc(dwa)).toContain('slupek-wypelnienie');
  });

  // ⚠️⚠️ ZMIERZONE NA PRAWDZIWYM EKRANIE (13.08): `width: 100,0%` jest deklaracja
  // NIEPOPRAWNA — przegladarka wyrzuca ja w calosci, wiec slupek ZNIKA, a liczba obok
  // zostaje i wszystko wyglada poprawnie.
  it('szerokość słupka jest liczbą CSS-a (kropka), nie polskim zapisem', async () => {
    const odp = await wejdz('/finanse?od=2026-05-01&do=2026-06-30');
    expect(odp.body).toMatch(/style="width: \d+\.\d%"/);
    expect(tresc(odp)).not.toMatch(/style="width:[^"]*,/);
  });

  // ⚠️ POLA IDA DO `.pola`, NIGDY DO `.rzad`: tamta klasa nie styluje listy rozwijanej
  // w ogole i zweza pola do 6 rem — pole daty wyglada wtedy jak z innej aplikacji.
  // ⚠️⚠️ POLA DAT MAJA MIEC WLASNE STYLOWANIE, a nie odziedziczone po klasach od czego
  // innego — i to jest cala tresc tego testu. Do 17.08.2026 pilnowal on obecnosci `.pola`,
  // bo tak wygladal wtedy formularz; po przebudowie doslowne trzymanie sie tamtego napisu
  // BYLO SZKODLIWE: `.pola` to `flex-direction: column`, wiec kompaktowy pasek zakresu
  // rozjezdzal sie na trzy wiersze i zjadal gore ekranu — dokladnie to, co przebudowa
  // miala naprawic. Test pilnuje wiec ZNACZENIA: pola stoja w `.zakres-data`, nigdy
  // w `.rzad` (ta klasa nie styluje listy rozwijanej w ogole i zweza pola do 6 rem).
  it('pola dat stoja na .zakres-data, nie na .rzad ani .pola', async () => {
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toMatch(/<label class="zakres-data">[\s\S]{0,120}?<input type="date"/);
    expect(odp.body).not.toMatch(/<form[^>]*class="[^"]*\b(rzad|pola)\b/);
  });

  it('ma przycisk „Drukuj"', async () => {
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(odp.body).toContain('window.print()');
  });

  // ⚠️ ANI JEDNEGO KOLORU WPISANEGO WPROST — paleta ma wariant jasny i ciemny, wiec wartosc
  // wpisana w widoku zadzialalaby w jasnym i po cichu zniknela w ciemnym.
  it('widok nie wpisuje kolorow wprost', async () => {
    const odp = await wejdz('/finanse?od=2026-05-01&do=2026-06-30');
    expect(tresc(odp)).not.toMatch(/style="[^"]*(color|background)/i);
  });

  // ⚠️⚠️ ZAKRES URWANY W POLOWIE MIESIACA: sprzedaz liczy sie co do dnia, ale koszty, ZUS
  // i PIT-5 sa MIESIECZNE — rachunek za 5–20 czerwca odejmuje od szesnastu dni sprzedazy
  // koszty CALEGO czerwca i wychodzi zapasc, ktorej nie bylo.
  it('ZAKRES NIEPELNYCH MIESIECY jest oznaczony ostrzezeniem', async () => {
    const pelny = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(tresc(pelny)).not.toMatch(/nie pokrywa się z pełnymi miesiącami/);
    const urwany = await wejdz('/finanse?od=2026-06-05&do=2026-06-20');
    expect(urwany.statusCode).toBe(200);
    expect(tresc(urwany)).toMatch(/nie pokrywa się z pełnymi miesiącami/);
  });

  it('ZLA DATA i ODWROCONY ZAKRES odmawiaja, a nie rysuja pustego rachunku', async () => {
    expect((await wejdz('/finanse?od=2026-13-45&do=2026-06-30')).statusCode).toBe(400);
    expect((await wejdz('/finanse?od=2026-06-30&do=2026-06-01')).statusCode).toBe(400);
    expect((await wejdz('/finanse?od=2026-02-30&do=2026-03-31')).statusCode).toBe(400);
  });

  it('nieznany skrot odmawia zdaniem, nie piecsetka', async () => {
    const odp = await wejdz('/finanse?skrot=od-swieta');
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/skr[oó]t/i);
  });

  // ⚠️ Brak granicy kanalu ma dac ZDANIE DLA CZLOWIEKA, nie piecsetke — tak samo jak /raporty.
  it('BRAK GRANICY KANALU daje czytelna odmowe, nie piecsetke', async () => {
    db.prepare("DELETE FROM granice_historii WHERE kanal = 'SZKICOWNIA_PL'").run();
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toContain('SZKICOWNIA_PL');
  });

  it('bez parametrow otwiera POPRZEDNI miesiac', async () => {
    const odp = await wejdz('/finanse');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Poprzedni miesiąc');
  });
});

// ——— PRZEBUDOWA 17.08.2026 —————————————————————————————————————————————————————————
// KPI z delta, kaskada zamiast tabeli, kategorie bez kolumny typu, prognoza progu.
describe('przebudowany ekran finansow', () => {
  // Duza sprzedaz w marcu — podstawa podatku rosnie na tyle, ze prognoza roku mija prog.
  const duzaSprzedaz = () => zapiszHistorie(db, {
    apiloId: 'S2', platformAccountId: 9, dzien: '2026-03-10',
    utworzoneAt: '2026-03-10T10:00:00.000Z', brutto: '123000.00', tagi: [], status: 15,
    paymentStatus: 2, klientEmail: 'k2@klient.pl', pozycje: [],
  });

  it('KPI stoja NA GORZE, przed kaskada — po nie czlowiek tu przychodzi', async () => {
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    const t = tresc(odp);
    expect(t).toContain('Przychód netto');
    expect(t).toContain('ZOSTAJE');
    // Kafle KPI wyprzedzaja kaskade — kolejnosc na ekranie jest trescia, nie ozdoba.
    expect(t.indexOf('kafelki--cztery')).toBeGreaterThan(-1);
    expect(t.indexOf('kafelki--cztery')).toBeLessThan(t.indexOf('kaskada-wiersz'));
  });

  it('KPI maja delte wzgledem okresu POPRZEDNIEGO, z podpisem z czym porownuja', async () => {
    zapiszHistorie(db, {
      apiloId: 'S3', platformAccountId: 9, dzien: '2026-05-10',
      utworzoneAt: '2026-05-10T10:00:00.000Z', brutto: '6150.00', tagi: [], status: 15,
      paymentStatus: 2, klientEmail: 'k3@klient.pl', pozycje: [],
    });
    const odp = await wejdz('/finanse?od=2026-06-01&do=2026-06-30');
    const t = tresc(odp);
    // Czerwiec 10 000 netto wobec maja 5 000 netto → +100%.
    expect(t).toMatch(/kafel-delta[^>]*>[\s↑]*100,0%/);
    expect(t).toContain('vs 2026-05');
  });

  // ⚠️⚠️ PODLOGA 2026-01 OBOWIAZUJE TAKZE OKRES PORONAWCZY. Rachunek za grudzien 2025 nie
  // istnieje (kosztow sprzed KSeF panel nie zna), wiec delta nie ma podstawy — i ma to
  // POWIEDZIEC. Policzona z zera pokazalaby „↑ ∞" albo spadek o 100% i wygladalaby jak fakt.
  it('OKRES POPRZEDNI SPRZED PODLOGI nie daje delty, tylko „brak porównania"', async () => {
    const odp = await wejdz('/finanse?od=2026-01-01&do=2026-01-31');
    expect(odp.statusCode).toBe(200);
    // ⚠️⚠️ SZUKAMY W SAMYCH KAFLACH, a nie w tresci strony. Zwykłe `toContain('brak
    // porównania')` przechodzilo TAKZE z podmieniona regula delty — bo ta sama fraza stoi
    // w akapicie metodologii („wtedy zamiast liczby stoi «brak porównania»"). Test mierzyl
    // wiec wlasny opis zamiast zachowania (mutacja `zmiana → 0` przezyla go 17.08.2026).
    const delty = [...tresc(odp).matchAll(/<span class="kafel-delta[^"]*">([\s\S]{0,60}?)<\/span>/g)]
      .map((m) => m[1].replace(/\s+/g, ' ').trim());
    expect(delty.length).toBeGreaterThanOrEqual(3);
    // Trzy pierwsze kafle (przychod, wynik, zostaje) nie maja z czym sie porownac.
    expect(delty.slice(0, 3).every((d) => d.includes('brak porównania'))).toBe(true);
    // ⚠️ ZERO JEST ZDANIEM O FAKTACH („bez zmian") i nie ma prawa tu stanac.
    expect(delty.slice(0, 3).some((d) => /%/.test(d))).toBe(false);
    expect(tresc(odp)).not.toContain('vs 2025-12');
  });

  it('kaskada rysuje przychod, koszty, wynik i zostaje na WSPOLNEJ skali', async () => {
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', pit5: '779.00' });
    koszt('K9', '2026-06-05', '4000.00');
    const t = tresc(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(t).toContain('kaskada-czesc');
    // Przychod zajmuje CALY tor — to jest skala, wzgledem ktorej mierzy sie reszta.
    expect(t).toMatch(/kaskada-czesc[^"]*"[^>]*width: 100\.0%/);
    // ⚠️ Szerokosci z KROPKA — `width: 60,0%` jest deklaracja niepoprawna i slupek znika.
    expect(t).not.toMatch(/style="[^"]*width:[^"]*,/);
  });

  // ⚠️⚠️ MIESIAC NA MINUSIE NIE MOZE MIEC BLOKU „ZOSTAJE". Ujemnej szerokosci nie ma,
  // a jakakolwiek narysowana klamalaby, ze cos zostalo.
  it('WYNIK UJEMNY nie rysuje bloku i mowi wprost, ze miesiac jest na minusie', async () => {
    koszt('K8', '2026-06-05', '90000.00');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06' });
    const t = tresc(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(t).toMatch(/na minusie/i);
    // ⚠️⚠️ KAZDA liczba geometrii kaskady MUSI zostac w torze [0, 100]. Sprawdzanie samego
    // „width: -" bylo za slabe (mutacja zdejmujaca przyciecie przezyla je 17.08.2026):
    // przy ujemnym wyniku psuje sie najpierw `left`, a szerokosc wychodzi DODATNIA
    // i wieksza od stu — pasek wyjezdza poza tor i miesiac na minusie wyglada jak dobry.
    const liczby = [...t.matchAll(/class="kaskada-czesc[^"]*"\s*style="left: ([-\d.]+)%; width: ([-\d.]+)%"/g)]
      .flatMap((m) => [Number(m[1]), Number(m[2])]);
    expect(liczby.length).toBeGreaterThan(0);
    expect(liczby.every((n) => n >= 0 && n <= 100)).toBe(true);
  });

  // Kolumna typu (staly/zmienny) zniknela z listy na zyczenie — ale PODZIAL zostaje w tle,
  // bo z niego licza sie prog rentownosci i marza po kosztach zmiennych.
  it('kategorie NIE MAJA kolumny typu, a wskazniki dalej sie licza', async () => {
    koszt('K1', '2026-06-05', '2881.04');
    zapiszDaneMiesiaca(db, '2026-06', { zusRazem: '2821.06', kpirKoszty: '2881.04' });
    const t = tresc(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(t).toContain('Na co poszły pieniądze');
    expect(t).not.toMatch(/<span class="znacznik">(zmienny|stały|drobne)<\/span>/);
    expect(t).toContain('Marża po kosztach zmiennych');
    expect(t).toContain('Próg rentowności');
  });

  it('PROGNOZA mowi, w ktorym miesiacu padnie prog i ile to kosztuje', async () => {
    duzaSprzedaz();
    const t = tresc(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(t).toMatch(/przy dzisiejszym tempie/i);
    // Podstawa ok. 99,6 tys. przez 6 miesiecy → rok ok. 199 tys., prog pada w sierpniu.
    expect(t).toMatch(/sierpni/i);
    expect(t).toContain('postep-prognoza');
  });

  // ⚠️ „Nie przekroczysz" to ZDANIE O FAKTACH i ma paść. Milczenie czyta sie jak brak
  // prognozy w ogole, a wtedy nikt nie wie, czy panel liczyl, czy nie.
  it('PROGNOZA MOWI TAKZE, gdy progu przy tym tempie NIE BEDZIE', async () => {
    const t = tresc(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(t).toMatch(/przy dzisiejszym tempie/i);
    expect(t).toMatch(/nie przekroczysz/i);
    // ⚠️ ...ale kreskowanego odcinka na pasku NIE MA — prognoza, ktora nie siega progu,
    // nie ma czego dorysowac, a odcinek do konca toru sugerowalby przekroczenie.
    expect(t).not.toContain('postep-prognoza');
  });

  it('PROGNOZY NIE MA przy zakresie urwanym w polowie miesiaca — tempo byloby zawyzone', async () => {
    duzaSprzedaz();
    const t = tresc(await wejdz('/finanse?od=2026-06-01&do=2026-06-20'));
    expect(t).not.toMatch(/przy dzisiejszym tempie/i);
  });
});

// ⚠️⚠️ OKABLOWANIE OPCJI `doKonca` — bariera, ktora zyje MIEDZY domena a trasa.
// 17.08.2026 skroty „ten…" przestaly siegac konca okresu, zeby ekran SPRZEDAZY nie zestawial
// 17 dni sierpnia z 31 dniami lipca (pokazywal „↓ 59,8%"). Rachunek zarzadczy ma zostac przy
// PELNYCH okresach — jego koszty, ZUS i PIT-5 sa miesieczne. Gdyby trasa zapomniala podac
// opcji, testy samej domeny dalej swiecilyby na zielono, a rachunek zaczalby odmawiac
// („zakres nie pokrywa sie z pelnymi miesiacami") przy kazdym skrocie „ten…".
describe('rachunek zarzadczy trzyma sie PELNYCH okresow', () => {
  // ⚠️ MIESIAC LICZONY Z ZEGARA, nie wpisany na sztywno. Do 17.08.2026 oba testy podawaly
  // dekoracyjne `?dzien=2026-08-17` (trasa TEGO PARAMETRU NIE CZYTA) i sprawdzaly zapis
  // „2026-08-01"/„2026-08-31" — przechodzily wylacznie dlatego, ze akurat byl sierpien,
  // a pierwszego wrzesnia zaczelyby padac bez zadnej zmiany w kodzie.
  const dzisiaj = new Date();
  const rok = dzisiaj.getFullYear();
  const mies = String(dzisiaj.getMonth() + 1).padStart(2, '0');
  const ostatni = new Date(rok, dzisiaj.getMonth() + 1, 0).getDate();

  const tenMiesiac = async () => {
    const app = buildOmsServer({ db, config });
    await app.ready();
    const odp = await app.inject({
      method: 'GET', url: '/finanse?skrot=ten-miesiac', headers: naglowek,
    });
    await app.close();
    return odp;
  };

  it('skrót „ten miesiąc” obejmuje CAŁY miesiąc, nie tylko do dziś', async () => {
    const odp = await tenMiesiac();
    expect(odp.statusCode).toBe(200);
    const tresc = odp.body.split('</style>').pop();
    expect(tresc).toContain(`${rok}-${mies}-01`);
    expect(tresc).toContain(`${rok}-${mies}-${ostatni}`);
  });

  it('nie stawia paska „nie pokrywa się z pełnymi miesiącami” dla skrótu „ten miesiąc”', async () => {
    const odp = await tenMiesiac();
    expect(odp.body.split('</style>').pop()).not.toContain('nie pokrywa się z pełnymi miesiącami');
  });
});

// ——— STARE ADRESY (sprzed wyprowadzenia Finansow, 17.08.2026) ————————————————————————
// Zakladki przegladarki i wiki znaja /raporty/zarzadczy i /raporty/dane — maja dalej
// trafiac we wlasciwy ekran, z zachowanym query stringiem (zapisany skrot laduje na
// tym samym okresie).
describe('przekierowania ze starych adresow', () => {
  const wejdzSurowo = async (url) => {
    const app = buildOmsServer({ db, config });
    await app.ready();
    const odp = await app.inject({ method: 'GET', url, headers: naglowek });
    await app.close();
    return odp;
  };

  it('/raporty/zarzadczy przekierowuje na /finanse z query stringiem', async () => {
    const odp = await wejdzSurowo('/raporty/zarzadczy?skrot=ten-kwartal');
    expect(odp.statusCode).toBe(302);
    expect(odp.headers.location).toBe('/finanse?skrot=ten-kwartal');
  });

  it('/raporty/zarzadczy bez query przekierowuje na golo /finanse', async () => {
    const odp = await wejdzSurowo('/raporty/zarzadczy');
    expect(odp.statusCode).toBe(302);
    expect(odp.headers.location).toBe('/finanse');
  });

  it('/raporty/dane/<miesiac> przekierowuje na /finanse/dane/<miesiac>', async () => {
    const odp = await wejdzSurowo('/raporty/dane/2026-07');
    expect(odp.statusCode).toBe(302);
    expect(odp.headers.location).toBe('/finanse/dane/2026-07');
  });
});

// ——— PASEK FILTROW (21.08.2026, zgloszenie właściciela) ————————————————————————————————
// Zamiast „Ten miesiac · Poprzedni miesiac · Ten kwartal · Poprzedni kwartal · Ten rok"
// ma stac „Poprzedni miesiac · Q1 · Q2 · Q3 · Q4 · Ten rok" plus WYBOR MIESIACA i wybor
// zakresu dat. Powod: przy rachunku zarzadczym wlasciciel wskazuje okres WPROST — zeby
// zobaczyc Q1 w sierpniu trzeba bylo wpisywac obie daty recznie.
describe('pasek filtrow rachunku zarzadczego', () => {
  const paskiem = (odp) => tresc(odp).split('<details class="metodologia"')[0];

  // ⚠️ ETYKIETY, NIE ADRESY: kwartal, ktory sie jeszcze nie zaczal, stoi na pasku jako
  // NAPIS bez `href` (nizej osobny test) — asercja na `skrot=q4` przechodzilaby wiec
  // wylacznie w czwartym kwartale roku i padala przez pozostale dziewiec miesiecy.
  it('ma skroty: Poprzedni miesiąc, Q1–Q4, Ten rok — w tej kolejności', async () => {
    const pasek = paskiem(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(pasek).toContain('/finanse?skrot=poprzedni-miesiac');
    expect(pasek).toContain('/finanse?skrot=ten-rok');
    const etykiety = [...pasek.matchAll(/>(Poprzedni miesiąc|Q[1-4]|Ten rok)</g)].map((m) => m[1]);
    expect(etykiety).toEqual(['Poprzedni miesiąc', 'Q1', 'Q2', 'Q3', 'Q4', 'Ten rok']);
  });

  // ⚠️ „Ten miesiac" NA TYM EKRANIE byl zaproszeniem do pomylki: rachunek miesiaca
  // TRWAJACEGO pokazuje pelna sprzedaz przy niepelnych kosztach i zysk wychodzi zawyzony
  // (dlatego ekran otwiera sie na miesiacu POPRZEDNIM). Znika z paska.
  it('NIE proponuje juz „Ten miesiąc" ani przycisków kwartału względnego', async () => {
    const pasek = paskiem(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(pasek).not.toContain('skrot=ten-miesiac');
    expect(pasek).not.toContain('skrot=ten-kwartal');
    expect(pasek).not.toContain('skrot=poprzedni-kwartal');
  });

  // ⚠️⚠️ ZDJETY PRZYCISK TO NIE ZDJETY ADRES. `?skrot=ten-kwartal` siedzi w zakladkach
  // przegladarki, w wiki i w przekierowaniu ze starego `/raporty/zarzadczy` — odmowa 400
  // zrobilaby z dzialajacego linku slepy zaulek.
  it('stare skróty DALEJ działają pod adresem, choć nie mają przycisku', async () => {
    for (const s of ['ten-miesiac', 'ten-kwartal', 'poprzedni-kwartal']) {
      expect((await wejdz(`/finanse?skrot=${s}`)).statusCode).toBe(200);
    }
  });

  // ⚠️⚠️ KWARTAL, KTORY SIE NIE ZACZAL, JEST WYGASZONY I NIE JEST ODNOSNIKIEM — ta sama
  // regula i ta sama barwa, co przy pasku miesiecy na /finanse/dane. Przycisk prowadzacy
  // zawsze w pusty rachunek („nie wpisano danych za 2026-10, 2026-11, 2026-12") uczy
  // operatora ignorowac komunikaty.
  it('kwartał PRZYSZŁY jest wygaszony i NIE jest odnośnikiem', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-21T09:00:00.000Z'));
      const pasek = paskiem(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
      // Q1–Q3 sie zaczely — sa adresami.
      for (const q of ['q1', 'q2', 'q3']) expect(pasek).toContain(`href="/finanse?skrot=${q}"`);
      // Q4 jeszcze nie — jest napisem, nie odnosnikiem.
      expect(pasek).not.toContain('href="/finanse?skrot=q4"');
      expect(pasek).toMatch(/class="[^"]*btn--przyszly[^"]*"[^>]*>Q4</);
    } finally { vi.useRealTimers(); }
  });

  it('w GRUDNIU wszystkie cztery kwartały są klikalne', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-12-05T09:00:00.000Z'));
      const pasek = paskiem(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
      for (const q of ['q1', 'q2', 'q3', 'q4']) expect(pasek).toContain(`href="/finanse?skrot=${q}"`);
      expect(pasek).not.toContain('btn--przyszly');
    } finally { vi.useRealTimers(); }
  });

  // ——— WYBOR MIESIACA ————————————————————————————————————————————————————————
  // ⚠️ `<input type="month">` to zwykly GET bez ani jednej linii skryptu — przegladarka
  // umie z niego zlozyc wylacznie `?miesiac=RRRR-MM`. Trasa przeklada to na PRAWDZIWY
  // zakres `od`/`do`, zeby adres dalo sie zapisac w zakladkach i wykleic na czacie
  // (ta sama decyzja, co przy /finanse/dane).
  it('wybór miesiąca przekłada się na PEŁNY zakres miesiąca', async () => {
    const odp = await wejdz('/finanse?miesiac=2026-06');
    expect(odp.statusCode).toBe(302);
    expect(odp.headers.location).toBe('/finanse?od=2026-06-01&do=2026-06-30');
  });

  it('luty roku PRZESTĘPNEGO kończy się 29 lutego', async () => {
    const odp = await wejdz('/finanse?miesiac=2028-02');
    expect(odp.headers.location).toBe('/finanse?od=2028-02-01&do=2028-02-29');
  });

  // ⚠️ Ta sama zasada, co przy zlej dacie w `od`/`do`: ODMOWA, a nie cichy skok na miesiac
  // biezacy. Podstawiony miesiac znaczylby, ze operator patrzy na inny okres, niz wpisal.
  it('niepoprawny miesiąc ODMAWIA, a nie podstawia bieżącego', async () => {
    for (const m of ['2026-13', 'czerwiec', '2026-6', '2026-06-01']) {
      const odp = await wejdz(`/finanse?miesiac=${encodeURIComponent(m)}`);
      expect(odp.statusCode).toBe(400);
      expect(odp.body).toMatch(/miesi[ąa]c/i);
    }
  });

  it('pole miesiąca pokazuje OGLĄDANY miesiąc, gdy zakres jest pełnym miesiącem', async () => {
    const pasek = paskiem(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(pasek).toMatch(/<input[^>]*type="month"[^>]*value="2026-06"/);
  });

  // ⚠️ Zakres, ktory NIE JEST pelnym miesiacem, zostawia pole PUSTE. Podstawiony tam
  // czerwiec przy zakresie „kwiecien–czerwiec" mowilby, ze ogladamy czerwiec.
  it('pole miesiąca jest PUSTE, gdy zakres nie jest pełnym miesiącem', async () => {
    const pasek = paskiem(await wejdz('/finanse?od=2026-04-01&do=2026-06-30'));
    expect(pasek).toMatch(/<input[^>]*type="month"[^>]*value=""/);
  });

  it('wybór zakresu dat został na miejscu', async () => {
    const pasek = paskiem(await wejdz('/finanse?od=2026-06-01&do=2026-06-30'));
    expect(pasek).toContain('name="od"');
    expect(pasek).toContain('name="do"');
    expect(pasek).toContain('window.print()');
  });
});

// ——— MARGINESY PASKA FILTROW (21.08.2026, zgloszenie właściciela: „nie ma marginesów") ————
// ⚠️ PO CO TO TUTAJ: `.panel--zakres` NIE MA w srodku `.panel-cialo` (jedyna klasa w tym
// arkuszu, ktora niesie wysciolke panelu) — tresc paska filtrow stala wiec DOKLADNIE na
// ramce, w odroznieniu od kazdego innego panelu na ekranie. Zmierzone w przegladarce:
// wysciolka „0px 0px 9.6px", dziecko przy samej krawedzi. Cala suita byla na to slepa, bo
// rozstrzyga o tym WYLACZNIE arkusz stylow (ta sama choroba, co przy ukladzie karty —
// tests/oms/karta-uklad-css.test.js).
describe('pasek filtrów ma wyściółkę, a nie zero', () => {
  const arkusz = async () => (await wejdz('/finanse?od=2026-06-01&do=2026-06-30')).body;

  it('arkusz niesie POZIOMĄ wyściółkę dla .panel--zakres', async () => {
    const regula = /\.panel--zakres\s*\{([^}]*)\}/.exec(await arkusz());
    expect(regula).not.toBeNull();
    // `padding: <pion> <poziom>` — poziom musi byc rozny od zera; sam `padding-bottom`
    // (stan sprzed poprawki) tego warunku nie spelnia.
    const wysciolka = /padding:\s*([^;]+);/.exec(regula[1]);
    expect(wysciolka).not.toBeNull();
    const czesci = wysciolka[1].trim().split(/\s+/);
    expect(czesci.length).toBeGreaterThan(1);
    expect(czesci[1]).not.toMatch(/^0(\D|$)/);
  });

  // ⚠️ SAMA KLASA W HTML-u NIE WYGASZA NICZEGO. Test wyzej („kwartał PRZYSZŁY jest
  // wygaszony") sprawdza, ze widok WSTAWIA `btn--przyszly` — gdyby regula wypadla z arkusza,
  // Q4 wygladalby jak zwykly przycisk i tamten test dalej swiecilby na zielono.
  it('arkusz naprawdę wygasza .btn--przyszly', async () => {
    const regula = /\.btn--przyszly\s*\{([^}]*)\}/.exec(await arkusz());
    expect(regula).not.toBeNull();
    const krycie = /opacity:\s*([\d.]+)/.exec(regula[1]);
    expect(krycie).not.toBeNull();
    expect(Number(krycie[1])).toBeLessThan(1);
  });

  // ⚠️ Ten sam pasek stoi na /raporty i na /finanse/dane — poprawka ma dzialac na wszystkich
  // trzech, bo klasa jest jedna. Gdyby ktos „naprawil" to wysciolka wpisana w widok finansow,
  // dwa pozostale ekrany zostalyby przy zerze i nikt by tego nie zobaczyl.
  it('ta sama reguła obowiązuje na /raporty i /finanse/dane', async () => {
    for (const adres of ['/raporty?od=2026-06-01&do=2026-06-30', '/finanse/dane/2026-06']) {
      const odp = await wejdz(adres);
      expect(odp.statusCode).toBe(200);
      expect(odp.body).toMatch(/\.panel--zakres\s*\{[^}]*padding:\s*[^;0][^;]*;/);
    }
  });
});
