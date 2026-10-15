import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
let db;
let kolejny = 0;

const wstaw = (d = {}) => {
  kolejny += 1;
  const w = {
    sklep: 'szkicownia', zrodlo_id: kolejny, numer: `N${kolejny}`,
    metoda_wysylki: 'dpd', metoda_wysylki_nazwa: null, pobranie: 0, b2b: 0, indywidualne: 0,
    metoda_platnosci: 'BLIK', kwota_brutto: '100.00',
    klient_json: JSON.stringify({ email: 'k@klient.pl' }), oplacone_at: '2026-08-13T06:00:00Z',
    wyslane_at: '2026-08-13T14:00:00Z', anulowane: 0, utworzone_at: '2026-08-13T06:00:00Z', ...d,
  };
  db.prepare(`INSERT INTO zamowienia
    (sklep, zrodlo_id, numer, metoda_wysylki, metoda_wysylki_nazwa, pobranie, b2b, indywidualne,
     metoda_platnosci, kwota_brutto, klient_json, oplacone_at, wyslane_at, anulowane, utworzone_at)
    VALUES (@sklep,@zrodlo_id,@numer,@metoda_wysylki,@metoda_wysylki_nazwa,@pobranie,@b2b,
            @indywidualne,@metoda_platnosci,@kwota_brutto,@klient_json,@oplacone_at,
            @wyslane_at,@anulowane,@utworzone_at)`).run(w);
  // ⚠️ WPŁATA NA LIŚCIE, NIE TYLKO KOLUMNA — dopisane 13.09.2026 przy poprawce krytycznej.
  // Zakładka czyta teraz `oplacone_at` EFEKTYWNE (wyliczone z tabeli `platnosci`, tak samo
  // jak lista zamówień), a nie surową kolumnę. Poller naprawdę dopisuje taki wiersz przy
  // każdej synchronizacji (`zsynchronizujWplateSklepu` w db/platnosci.js), więc fikstura
  // z samą kolumną opisywała stan NIEOSIĄGALNY na produkcji — zamówienie, które panel uważa
  // za nieopłacone, mimo że sklep zapisał datę zapłaty.
  if (w.oplacone_at) {
    const { id } = db.prepare('SELECT id FROM zamowienia WHERE zrodlo_id = ?').get(w.zrodlo_id);
    db.prepare(
      'INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at)'
      + " VALUES (?,?,?,?,NULL,'sklep',?)",
    ).run(id, w.kwota_brutto, w.oplacone_at, w.metoda_platnosci, w.oplacone_at);
  }
};

beforeEach(() => { db = openOmsDb(':memory:'); kolejny = 0; });

const wejdz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};

const SIERPIEN = '/statystyki?od=2026-08-01&do=2026-08-31';

describe('ekran /statystyki', () => {
  it('odpowiada 200 i niesie trzy nagłówki sekcji', async () => {
    wstaw();
    const odp = await wejdz(SIERPIEN);
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Rozkład przewoźników');
    expect(odp.body).toContain('Terminowość wysyłki');
    expect(odp.body).toContain('Metody płatności');
  });

  // ⚠️⚠️ UKŁAD SEKCJI TO KONWENCJA DOMU, KTÓREJ NIC NIE PILNOWAŁO. Pierwsza wersja ekranu
  // wstawiała `h2` i tabelę wprost w `section.panel` — a ta klasa ma w layoucie
  // `padding: 0`, więc nagłówki i wiersze tabeli dotykały ramki panelu (zgłoszone przez
  // właściciela 13.09.2026: „w polach nie ma marginesów"). Suita była wtedy w pełni zielona:
  // ekran odpowiadał 200 i niósł wszystkie liczby. Padding daje `div.panel-cialo`,
  // a kapitaliki nagłówka `div.panel-glowa` — i to jest jedyne miejsce, w którym da się
  // to sprawdzić bez przeglądarki.
  it('każda sekcja ma głowę i ciało panelu — inaczej treść dotyka ramki', async () => {
    wstaw();
    const odp = await wejdz(SIERPIEN);
    const sekcje = odp.body.split('<section class="panel">').slice(1);
    // Trzy sekcje treści; pas zakresu ma własną klasę `panel--zakres`, więc tu nie wpada.
    expect(sekcje).toHaveLength(3);
    for (const s of sekcje) {
      const cialo = s.slice(0, s.indexOf('</section>'));
      expect(cialo).toContain('<div class="panel-glowa">');
      expect(cialo).toContain('<div class="panel-cialo">');
      // Tabela MUSI stać w ciele, nie przed nim — inaczej padding jej nie obejmuje.
      expect(cialo.indexOf('<div class="panel-cialo">')).toBeLessThan(cialo.indexOf('<table'));
    }
  });

  // ⚠️ ASERCJA CELUJE W WIERSZ TABELI, NIE W GOŁE SŁOWO. Gołe „Kurier DPD" trafiłoby też
  // w listę opcji filtra albo w blok <style> layoutu, który jedzie na KAŻDEJ stronie panelu.
  it('nazwa usługi stoi w wierszu tabeli razem z liczbą', async () => {
    wstaw(); wstaw();
    wstaw({ metoda_wysylki: 'inpost_paczkomat' });
    const odp = await wejdz(SIERPIEN);
    expect(odp.body).toContain('<td>Kurier DPD</td>');
    expect(odp.body).toMatch(/<td>Kurier DPD<\/td>\s*<td[^>]*>2<\/td>/);
    expect(odp.body).toContain('<td>InPost Paczkomat</td>');
  });

  it('pokazuje oba procenty terminowości', async () => {
    wstaw();                                        // tego samego dnia
    wstaw({ wyslane_at: '2026-08-18T07:00:00Z' });   // po terminie
    const odp = await wejdz(SIERPIEN);
    expect(odp.body).toContain('50,0%');
  });

  // ⚠️⚠️ DZIURA Z RECENZJI (task-8): widok podmieniony na literał w każdym z tych trzech
  // wyrażeń (`termin.wylaczenia.niewyslane/przedWplata/bezStartu`) przechodził całą suitę
  // na zielono — nic nie dowodziło, że reguła policzona w domenie (statystyki-wysylki.js)
  // DOJEŻDŻA na ekran. Trzy RÓŻNE, niezerowe liczby (1/2/3) są celowe: gdyby widok pomylił
  // wyłączenia miejscami (np. wypisał `przedWplata` tam, gdzie ma stać `bezStartu`), test
  // z trzema jednakowymi liczbami by tego nie złapał.
  it('trzy wyłączenia terminowości są widoczne na ekranie z właściwymi liczbami', async () => {
    wstaw({ wyslane_at: null });                                            // 1 × niewysłane
    wstaw({ oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-12T14:00:00Z' });
    wstaw({ oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-12T14:00:00Z' });
    // ⚠️ wysłane PRZED wpłatą: wyslane_at wcześniejszy niż oplacone_at (2 sztuki powyżej).
    wstaw({ oplacone_at: null, wyslane_at: '2026-08-13T14:00:00Z' });
    wstaw({ oplacone_at: null, wyslane_at: '2026-08-13T14:00:00Z' });
    wstaw({ oplacone_at: null, wyslane_at: '2026-08-13T14:00:00Z' });
    // ⚠️ bez daty startu zegara: wyslane_at jest, oplacone_at brak (3 sztuki powyżej).
    const odp = await wejdz(SIERPIEN);
    // Asercja celuje w akapit wyłączeń, nie w całą stronę.
    const start = odp.body.indexOf('Poza procentami:');
    const koniec = odp.body.indexOf('</section>', start);
    const akapit = odp.body.slice(start, koniec);
    expect(akapit).toContain('<strong>1</strong> jeszcze');
    expect(akapit).toContain('<strong>2</strong> wysłanych przed');
    expect(akapit).toContain('<strong>3</strong> bez daty startu zegara.');
  });

  it('zamówienia Allegro mają własny wiersz poza procentami płatności', async () => {
    wstaw();
    wstaw({ sklep: 'allegro_szkicownia', metoda_platnosci: 'Allegro (płatność online)' });
    const odp = await wejdz(SIERPIEN);
    expect(odp.body).toMatch(/Allegro nie mówi/);
    expect(odp.body).toContain('<td>BLIK</td>');
  });

  // ⚠️⚠️ DZIURA Z RECENZJI (task-8): widok podmieniony na literał w `platnosci.allegroBezInformacji`
  // przechodził całą suitę na zielono — licznik zamówień Allegro POZA procentami nie miał
  // żadnego strażnika. Liczba 4 jest CELOWA: przy tym zestawie danych żadna inna liczba na
  // ekranie nie wynosi 4 (zamówień jest 5, mianownik płatności bez Allegro to 1), więc gdyby
  // literał w widoku nie zgadzał się z danymi, ta konkretna asercja by to złapała.
  it('licznik zamówień Allegro poza procentami jest widoczny z właściwą liczbą', async () => {
    wstaw();
    wstaw({ sklep: 'allegro_szkicownia', metoda_platnosci: 'Allegro (płatność online)' });
    wstaw({ sklep: 'allegro_szkicownia', metoda_platnosci: 'Allegro (płatność online)' });
    wstaw({ sklep: 'allegro_szkicownia', metoda_platnosci: 'Allegro (płatność online)' });
    wstaw({ sklep: 'allegro_szkicownia', metoda_platnosci: 'Allegro (płatność online)' });
    const odp = await wejdz(SIERPIEN);
    expect(odp.body).toContain('<strong>4</strong> zamówień tego kanału stoi poza');
  });

  // ⚠️ Zła data to BŁĄD, nie pusty ekran. 200 z zerami nikt nie kwestionuje.
  it('zły zakres daje komunikat, nie zerowy raport', async () => {
    const odp = await wejdz('/statystyki?od=2026-02-30&do=2026-03-01');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(/Niepoprawna data/);
    expect(odp.body).not.toContain('Rozkład przewoźników');
  });

  // ⚠️ ODWRÓCONY zakres (od > do) to TEN SAM rodzaj błędu, nie osobny przypadek, który
  // wolno przepuścić dalej. `zakresZZapytania` (okresy-raportu.js) już to obsługuje
  // poprawnie — ale bez testu nic tego nie pilnowało: regres cofnąłby ekran do 200
  // z pustymi tabelami, a puste zero nie wygląda jak błąd, tylko jak brak zamówień.
  it('odwrócony zakres daje komunikat, nie pusty ekran z tabelami', async () => {
    const odp = await wejdz('/statystyki?od=2026-08-31&do=2026-08-01');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(/Niepoprawny zakres/);
    expect(odp.body).not.toContain('Rozkład przewoźników');
  });

  it('pusty zakres daje wiersz pustki, nie zerową tabelę bez wyjaśnienia', async () => {
    const odp = await wejdz('/statystyki?od=2026-08-01&do=2026-08-31');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(/W tym zakresie nie ma zamówień/);
  });

  // ⚠️ colspan pustki i sumy musi zgadzać się z liczbą kolumn (3). Rozjechany wiersz widać
  // WYŁĄCZNIE w pustym zakresie, więc przeżyłby każdy normalny dowód.
  it('wiersz pustki ma colspan równy liczbie kolumn', async () => {
    const odp = await wejdz('/statystyki?od=2026-08-01&do=2026-08-31');
    expect(odp.body).toMatch(/colspan="3"[^>]*>\s*W tym zakresie nie ma zamówień/);
    expect(odp.body).not.toMatch(/colspan="[124567890]"/);
  });

  // ⚠️ ODSTĘPSTWO OD BRIEFU (task-8, opisane w raporcie): asercja zawężona do kafli KPI.
  // Z JEDNYM zamówieniem w okresie „Rozkład przewoźników" i „Metody płatności" legalnie
  // pokazują „100,0%" (jedyna usługa/metoda ma 100% udziału) — a „100,0%" KOŃCZY SIĘ
  // ciągiem „0,0%", więc `not.toContain('0,0%')` na całym ciele padałoby przez CUDZY,
  // poprawny wynik, nie przez błąd w kaflach terminowości, które faktycznie sprawdza ten
  // test. Zawężenie do znacznika `<div class="kafelki kafelki--cztery">` (a NIE do golego
  // „kafelki--cztery" — ten sam ciąg stoi WCZEŚNIEJ w regule CSS layoutu, wiec slice od
  // niego zaczynalby sie w <style>, nie w kaflach) mierzy dokladnie to, co test ma mierzyc:
  // kafle KPI, gdzie stoi „W terminie"/„Tego samego dnia".
  //
  // ⚠️ PO POPRAWCE STOPKI (task-8, punkt 3): stopki `<tfoot>` już nie piszą literału
  // „100,0%" (patrz statystyki.ejs) — SPRAWDZONE, że kolizja mimo to NIE ZNIKA. Przy tym
  // samym, jednym zamówieniu „Rozkład przewoźników" i „Metody płatności" nadal pokazują
  // „100,0%" we WŁASNYM wierszu pozycji (jedyna usługa/metoda ma 100% udziału — to
  // prawdziwa, poprawna liczba, niezależna od stopki), więc zawężenie do kafli KPI
  // zostaje: rozszerzenie na całe ciało dalej padałoby przez ten sam CUDZY wynik.
  it('zero wysłanych daje „—", nie „0,0%"', async () => {
    wstaw({ wyslane_at: null });
    const odp = await wejdz(SIERPIEN);
    const start = odp.body.indexOf('<div class="kafelki kafelki--cztery">');
    const koniec = odp.body.indexOf('<section class="panel">', start);
    const kafle = odp.body.slice(start, koniec);
    expect(kafle).toContain('—');
    expect(kafle).not.toContain('0,0%');
  });

  // ⚠️ Zakres sprzed 3.07.2026 nie ma danych o wysyłce w ŻADNYM źródle — historia
  // (10 878 wierszy) niesie tylko dzień, kwotę i status.
  it('zakres sprzed uruchomienia OMS-u dostaje pasek zastrzeżenia', async () => {
    wstaw();
    const odp = await wejdz('/statystyki?od=2026-01-01&do=2026-08-31');
    expect(odp.body).toMatch(/od 3\.07\.2026/);
  });

  it('zakres w pełni po 3.07.2026 paska NIE dostaje', async () => {
    wstaw();
    const odp = await wejdz(SIERPIEN);
    expect(odp.body).not.toMatch(/od 3\.07\.2026/);
  });

  it('domyślny adres bez parametrów też odpowiada 200', async () => {
    const odp = await wejdz('/statystyki');
    expect(odp.statusCode).toBe(200);
  });

  // ⚠️ ODSTĘPSTWO OD BRIEFU (task-8, opisane w raporcie): regex z briefu zakładał `class`
  // i `href` w JEDNYM znaczniku (`[^>]*` nie przechodzi przez `>`). Boczne menu
  // (layout-oms.ejs) znaczy aktywną pozycję klasą na `<li>`, a adres stoi w `<a>` DZIECKA —
  // dokładnie tak samo, jak sprawdza ustalona konwencja w `kolumna-boczna.test.js`
  // (`class="aktywna"[\s\S]{0,120}<etykieta>`). Wzorzec z briefu nie znalazłby dopasowania
  // na ŻADNYM ekranie panelu, nie tylko na tym.
  it('boczne menu zaznacza STATYSTYKI na tym ekranie', async () => {
    const odp = await wejdz(SIERPIEN);
    const menu = odp.body.match(/<nav class="oms-menu" aria-label="Główna">[\s\S]*?<\/nav>/)?.[0];
    expect(menu).toBeDefined();
    expect(menu).toMatch(/<a href="\/statystyki" aria-current="page">[\s\S]*?<span>Statystyki<\/span><\/a>/);
  });
});
