import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, oznaczWyslane } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createPrzesylkiAllegro } from '../../../src/moduly/wysylka/services/przesylki-allegro.js';
import { zarejestrujPrzesylkeReczna } from '../../../src/moduly/wysylka/db/przesylki.js';

// ⚠️ KTO WOLA `odswiez` (decyzja Zadania 11).
//
// Usluga sama z siebie niczego nie pokazuje — bez wolajacego numery listow z Allegro nie
// pojawilyby sie w panelu w ogole. Wolajacym jest OTWARCIE KARTY ZAMOWIENIA, a nie poller:
//
//  - poller chodzi co 2 minuty po WSZYSTKICH zamowieniach, a Allegro oddaje przesylki
//    WYLACZNIE per zamowienie (`GET /order/checkout-forms/{id}/shipments`) — nie ma zapytania
//    zbiorczego. Odpytywanie w kazdym przebiegu to liczba otwartych zamowien razy 720 na dobe,
//    czyli ~14 000 zadan dziennie po informacje, ktora zmienia sie raz w zyciu paczki;
//  - karta juz dzis odswieza status kuriera przy otwarciu (odswiezStatusKuriera), z dlawikiem
//    godzinowym. Ta sciezka jest tym samym wzorcem: koszt ograniczony UWAGA CZLOWIEKA,
//    a nie zegarem, i zero ruchu w tle do uslugi, ktorej nie kontrolujemy.
//
// Warunek zatrzymania jest wlasnoscia zamowienia, a nie nowa kolumna — regula stoi
// w domain/allegro-numery.js (`wartoPytacAllegroONumery`):
//   • zamowienie BEZ `wyslane_at` pytamy zawsze, jak dotad (wisi na liscie roboczej);
//   • zamowienie WYSLANE pytamy tylko, gdy nie ma ANI JEDNEJ paczki i minelo mniej niz
//     30 dni od wyslania.
//
// ⚠️⚠️ DO 25.08.2026 STAL TU SAM WARUNEK `!wyslane_at` I GUBIL NUMERY PIERWSZYCH PACZEK.
// Zmierzone na produkcji: 22 zamowienia Allegro oznaczone jako wyslane nie mialy w panelu
// ani jednej przesylki, mimo ze numery po stronie Allegro byly. Wzorcowy przypadek to
// zamowienie 1207 — przesylka powstala w Allegro o 09:11:40, czlowiek oznaczyl wysylke
// o 09:12. Dwadziescia sekund. Ograniczenie bylo opisane WASKO, jako sprawa dosylek,
// i przez to nikt nie zobaczyl, ze zjada takze przypadek zwykly.
//
// ⚠️ CENA TEGO WARUNKU, wprost i NADAL AKTUALNA: DOSYLKA nadana w Allegro PO oznaczeniu
// wysylki nie zostanie dociagnieta, jesli pierwsza paczka jest juz zapisana. Dosylka jest
// reakcja na paczke ZAGUBIONA, czyli powstaje dni po tym, jak czlowiek przestawil status.
// Zamkneliismy dziure, ktora gubila numer JEDYNEJ paczki — nie te, ktora gubi DRUGA;
// objecie dosylek wymaga wlasnego dlawika w nowej kolumnie.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-04T12:00:00', ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: String(id), numer: String(id), klient: { first_name: 'Jan', email: 'j@k.pl' },
  dostawa: { city: 'Pęki' }, metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 0,
  nip: null, kwota_brutto: '99.00', status_woo: null, oplacone_at: '2026-08-04T09:00:00',
  anulowane: 0, utworzone_at: '2026-08-04T08:00:00',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 1, cena_brutto: '99.00', vat: null }],
  ...nad,
});

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

const klientZ = (przesylki) => ({ pobierzPrzesylki: vi.fn().mockResolvedValue(przesylki) });

const otworzKarte = async (id, { klienci = {}, ...reszta } = {}) => {
  const serwer = buildOmsServer({
    db, config, poller, przesylkiAllegro: createPrzesylkiAllegro({ db, klienci }), ...reszta,
  });
  await serwer.ready();
  return serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
};

const przesylki = (id) => pobierzZamowienie(db, id).przesylki;
const log = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);

// Kroki rozsuniete o GODZINE ZEGARA — po dlawiku I-3 (nizej) trzy odslony pod rzad to jedno
// zapytanie do Allegro, wiec testy mierzace COKOLWIEK INNEGO niz sam dlawik musza odczekac.
// Przesuwamy zegar, a nie czekamy naprawde: znacznik proby to czas wpisu do logu (`teraz()`
// w db/zamowienia.js), wiec `vi.setSystemTime` w zupelnosci wystarczy.
// ⚠️ `toFake: ['Date']` — podmieniamy WYLACZNIE zegar. Pelne fake timery zatrzymalyby takze
// `setTimeout`, na ktorym stoi Fastify, i `inject` nigdy by nie wrocil.
const zGodzinami = async (kroki) => {
  const start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (const [i, krok] of kroki.entries()) {
      vi.setSystemTime(new Date(start + i * 2 * 60 * 60 * 1000));
      await krok();
    }
  } finally {
    vi.useRealTimers();
  }
};

describe('karta zamówienia dociąga numer listu z Allegro', () => {
  it('numer z Allegro trafia do bazy i JEST WIDOCZNY na karcie', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    const odp = await otworzKarte(id, {
      klienci: { allegro_szkicownia: klientZ([{ waybill: 'AD0LK57DLG0756H4H', carrierId: 'ALLEGRO' }]) },
    });

    expect(odp.statusCode).toBe(200);
    // ⚠️ SAM WIERSZ W BAZIE NIE WYSTARCZA. Karta renderuje sie z obiektu wczytanego PRZED
    // odswiezeniem, wiec zapis bez ponownego odczytu dawalby numer w bazie i pusta sekcje
    // paczek na ekranie — az do nastepnego odswiezenia strony. Cel zadania brzmi „widoczne
    // w panelu", a nie „zapisane w panelu".
    expect(odp.body).toContain('AD0LK57DLG0756H4H');
    expect(przesylki(id)).toMatchObject([{ kurier: 'allegro', numer_listu: 'AD0LK57DLG0756H4H' }]);
  });

  it('zamówienie ze SKLEPU nie powoduje żadnego zapytania do Allegro', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane('4321', { metoda_wysylki: 'dpd' }), {});
    const klient = klientZ([{ waybill: 'AD1' }]);

    const odp = await otworzKarte(id, { klienci: { pro: klient, allegro_szkicownia: klient } });

    expect(odp.statusCode).toBe(200);
    expect(klient.pobierzPrzesylki).not.toHaveBeenCalled();
    expect(przesylki(id)).toHaveLength(0);
  });

  // ⚠️ DRUGA SIATKA, MIERZONA OSOBNO. Test wyzej przechodzi takze bez warunku w trasie — bo
  // odmowe powtarza sama usluga (czyKanalAllegro w services/przesylki-allegro.js). Obie maja
  // istniec: usluga odmawia, bo klucze sklepow i kanalow leza w jednej przestrzeni nazw
  // (`zamowienia.sklep`), a trasa nie wola jej wcale, bo KAZDE otwarcie KAZDEJ karty w panelu
  // przechodzi tedy — takze karty zamowien recznych i sklepowych, ktorych to w ogole nie
  // dotyczy. Bez tego pomiaru zdjecie warunku z trasy przeszloby na zielono.
  it('trasa nie woła usługi Allegro dla zamówienia spoza kanału', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane('4321', { metoda_wysylki: 'dpd' }), {});
    const przesylkiAllegro = { odswiez: vi.fn().mockResolvedValue({ dopisane: 0 }) };

    const serwer = buildOmsServer({ db, config, poller, przesylkiAllegro });
    await serwer.ready();
    const odp = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });

    expect(odp.statusCode).toBe(200);
    expect(przesylkiAllegro.odswiez).not.toHaveBeenCalled();
  });

  // ⚠️ Warunek zatrzymania. Bez niego kazde otwarcie karty ZAMKNIETEGO zamowienia (reklamacja,
  // faktura, sprawdzenie sprzed miesiaca) szloby do Allegro po informacje, ktora dawno jest
  // w bazie — dokladnie ta petla, ktora przy statusie DPD kosztowala zapytanie na kazde
  // otwarcie karty (patrz zapiszProbeStatusuDpd).
  //
  // ⚠️⚠️ OD 25.08.2026 SAMO `wyslane_at` JUZ NIE WYSTARCZA jako warunek zatrzymania — i to
  // nie jest poluzowanie, tylko naprawa. Tamten warunek gubil numer PIERWSZEJ paczki, gdy
  // operator oznaczal wysylke szybciej, niz panel zdazyl zajrzec: przy zamowieniu 1207
  // dzielilo je DWADZIESCIA SEKUND, a na produkcji zebraly sie 22 zamowienia Allegro
  // bez ani jednej przesylki, mimo ze numery po stronie Allegro byly.
  // Regula stoi teraz w domain/allegro-numery.js; te trzy testy pilnuja OBU jej stron.
  it('zamówienie WYSŁANE, które MA już paczkę, nie jest odpytywane', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    zarejestrujPrzesylkeReczna(db, id, { kurier: 'allegro', kolejnosc: 1, numerListu: 'AD1' });
    oznaczWyslane(db, id);
    const klient = klientZ([{ waybill: 'AD1' }]);

    await otworzKarte(id, { klienci: { allegro_szkicownia: klient } });

    expect(klient.pobierzPrzesylki).not.toHaveBeenCalled();
  });

  // ⚠️ ARCHIWUM ZOSTAJE CICHE. Zamowienie sprzed ponad 30 dni nie pyta nawet bez paczki —
  // bo numer, ktorego Allegro nie oddalo przez miesiac, nie pojawi sie juz nigdy, a karty
  // stare oglada sie NAJCZESCIEJ (reklamacje, faktury).
  it('zamówienie WYSŁANE dawno i bez paczki też nie jest odpytywane', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a3'), {});
    oznaczWyslane(db, id);
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 45 * 86400_000).toISOString(), id);
    const klient = klientZ([{ waybill: 'AD3' }]);

    await otworzKarte(id, { klienci: { allegro_szkicownia: klient } });

    expect(klient.pobierzPrzesylki).not.toHaveBeenCalled();
  });

  // ⚠️⚠️ TO JEST ZALATANA DZIURA. Zamowienie oznaczone jako wyslane, ale BEZ ani jednej
  // paczki, to stan, w ktorym panel nie ma numeru i nie ma go skad wziac inaczej.
  it('zamówienie WYSŁANE świeżo i BEZ paczki jest odpytywane — numer dojeżdża', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a2'), {});
    oznaczWyslane(db, id);
    const klient = klientZ([{ waybill: 'A005FK03X8', carrierId: 'ALLEGRO' }]);

    await otworzKarte(id, { klienci: { allegro_szkicownia: klient } });

    expect(klient.pobierzPrzesylki).toHaveBeenCalled();
    const [p] = przesylki(id);
    expect(p.numer_listu).toBe('A005FK03X8');
    expect(p.carrier_allegro).toBe('ALLEGRO');
  });

  // ⚠️ ODPORNOSC LEZY TUTAJ, a nie w usludze. Awaria Allegro (401 po cofnietej zgodzie,
  // 500, timeout) NIE MOZE wywalic karty — ta sama zasada, co przy odswiezaniu statusu
  // kuriera. Karta ma sie wyrenderowac, a awaria ma zostac WIDOCZNA w logu.
  it('awaria Allegro NIE wywala karty, a ślad idzie do logu', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    const klient = { pobierzPrzesylki: vi.fn().mockRejectedValue(new Error('Allegro: HTTP 401 przy /shipments')) };

    const odp = await otworzKarte(id, { klienci: { allegro_szkicownia: klient } });

    expect(odp.statusCode).toBe(200);
    expect(log(id).some((w) => w.akcja === 'allegro.przesylka' && /401/.test(w.wynik))).toBe(true);
  });

  // ⚠️ I-2: LOG MA ROSNAC OD FAKTOW, NIE OD ODSLON. Po cofnietej zgodzie (401) awaria trwa,
  // a operator otwiera te sama karte raz za razem — kazde otwarcie dopisywalo IDENTYCZNY
  // wiersz „BŁĄD", czyli zasypywalo historie zamowienia dokladnie w chwili, w ktorej ktos
  // probuje ja czytac przy diagnozie. Dlawik: porownanie z OSTATNIM wpisem tej akcji.
  it('ten sam błąd Allegro NIE dopisuje się do logu przy każdej kolejnej odsłonie karty', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    const klient = { pobierzPrzesylki: vi.fn().mockRejectedValue(new Error('Allegro: HTTP 401 przy /shipments')) };
    const klienci = { allegro_szkicownia: klient };

    // Godzina miedzy odslonami — inaczej pytanie zdlawiloby samo odpytywanie (I-3 nizej)
    // i test nie mierzylby juz dlawika WPISU DO LOGU, tylko dlawik zapytan.
    await zGodzinami([
      () => otworzKarte(id, { klienci }),
      () => otworzKarte(id, { klienci }),
      () => otworzKarte(id, { klienci }),
    ]);

    // Pytamy DALEJ przy kolejnych otwarciach (po odczekaniu godziny) — dlawik wpisu dotyczy
    // LOGU, a nie odpytywania: awaria potrafi minac miedzy odslonami i numer ma sie wtedy
    // pojawic od razu.
    expect(klient.pobierzPrzesylki).toHaveBeenCalledTimes(3);
    expect(log(id).filter((w) => w.akcja === 'allegro.przesylka')).toHaveLength(1);
  });

  // Dlawik nie moze byc „zapisz raz i zamilcz": INNY blad to INNY fakt (401 po cofnietej
  // zgodzie i 500 po stronie Allegro wymagaja czego innego), wiec musi trafic do logu.
  it('INNY błąd Allegro dopisuje się mimo dławika', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    const klient = {
      pobierzPrzesylki: vi.fn()
        .mockRejectedValueOnce(new Error('Allegro: HTTP 401 przy /shipments'))
        .mockRejectedValueOnce(new Error('Allegro: HTTP 401 przy /shipments'))
        .mockRejectedValueOnce(new Error('Allegro: HTTP 500 przy /shipments')),
    };
    const klienci = { allegro_szkicownia: klient };

    await zGodzinami([
      () => otworzKarte(id, { klienci }),
      () => otworzKarte(id, { klienci }),
      () => otworzKarte(id, { klienci }),
    ]);

    const wpisy = log(id).filter((w) => w.akcja === 'allegro.przesylka');
    expect(wpisy).toHaveLength(2);
    expect(wpisy.map((w) => w.wynik).join('|')).toMatch(/401[\s\S]*500/);
  });

  // ⚠️⚠️ I-3 (recenzja calej galezi): DLAWIK CZESTOTLIWOSCI ODPYTYWANIA.
  //
  // `wyslane_at` ogranicza CZAS ZYCIA odpytywania („dopoki zamowienie wisi na liscie
  // roboczej"), ale nie ogranicza jego TEMPA — a to sa dwie rozne rzeczy. Kazde renderowanie
  // karty niewyslanego zamowienia z Allegro bylo JEDNYM zadaniem `GET .../shipments`, wiec
  // dwadziescia razy F5 znaczylo dwadziescia zadan do uslugi, ktorej nie kontrolujemy, po
  // informacje zmieniajaca sie RAZ w zyciu paczki. Odpowiednik przy kurierach dostal dlawik
  // godzinowy juz w Zadaniu 13, po dokladnie takiej samej petli.
  describe('dławik godzinowy odpytywania Allegro (I-3)', () => {
    // ⚠️ WŁASNY LIMIT CZASU, bo ten przypadek robi DWADZIEŚCIA pełnych odsłon karty —
    // dwadzieścia żądań przez `app.inject`, każde z renderem. Domyślne 5 s vitesta to
    // budżet na przypadek, a nie wymaganie wydajnościowe, i pod obciążeniem maszyny
    // ten przypadek się w nim nie mieści.
    //
    // Zmierzone 11.08.2026: przy jednym przebiegu suity zielone (113 s), przy CZTERECH
    // równoległych czerwone we WSZYSTKICH czterech — czyli nie jest to test losowy,
    // tylko PROGOWY. Objawiało się to jako „suita raz na kilka przebiegów pokazuje
    // 5781/1 failed", a to najgorszy możliwy rodzaj czerwieni: uczy ponawiać przebieg
    // zamiast czytać, przez co pierwsza PRAWDZIWA regresja też zostanie ponowiona.
    //
    // Liczba 20 zostaje, bo to ona niesie sens testu („dwadzieścia razy F5"). Rośnie
    // wyłącznie budżet czasu — zachowanie sprawdzane jest bez zmian.
    it('dwadzieścia odsłon tej samej karty to JEDNO zapytanie do Allegro', { timeout: 30_000 }, async () => {
      const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
      const klient = klientZ([]);
      const klienci = { allegro_szkicownia: klient };

      for (let i = 0; i < 20; i += 1) await otworzKarte(id, { klienci });

      expect(klient.pobierzPrzesylki).toHaveBeenCalledTimes(1);
    });

    // ⚠️ PUSTA ODPOWIEDZ TEZ MUSI DLAWIC — i to jest tu przypadek NAJCZESTSZY, nie brzegowy:
    // zamowienie czeka na spakowanie, wiec Allegro dlugo nie ma zadnej przesylki. Dlawik
    // oparty o zapis wiersza przesylki albo o wpis bledu nie objalby wlasnie tej sciezki.
    it('znacznik próby powstaje TAKŻE gdy Allegro nie ma żadnej przesyłki', async () => {
      const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
      await otworzKarte(id, { klienci: { allegro_szkicownia: klientZ([]) } });
      expect(log(id).filter((w) => w.akcja === 'allegro.przesylka.proba')).toHaveLength(1);
      expect(przesylki(id)).toHaveLength(0);
    });

    // …i gdy odpytywanie PADLO. Inaczej dlawik nie objalby dokladnie tego przypadku, w ktorym
    // boli najbardziej: przy awarii kanalu kazde otwarcie karty szloby do Allegro na nowo.
    it('awaria Allegro też zużywa próbę — kolejne odsłony nie pytają', async () => {
      const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
      const klient = { pobierzPrzesylki: vi.fn().mockRejectedValue(new Error('Allegro: HTTP 401 przy /shipments')) };
      const klienci = { allegro_szkicownia: klient };

      await otworzKarte(id, { klienci });
      await otworzKarte(id, { klienci });
      await otworzKarte(id, { klienci });

      expect(klient.pobierzPrzesylki).toHaveBeenCalledTimes(1);
    });

    // Dlawik ma OPOZNIAC, a nie ZABRANIAC: po godzinie karta pyta znowu, bo numer listu
    // pojawia sie w Allegro dopiero przy pakowaniu i musi dojsc do panelu tego samego dnia.
    it('po godzinie karta pyta znowu', async () => {
      const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
      const klient = klientZ([]);
      const klienci = { allegro_szkicownia: klient };

      await zGodzinami([
        () => otworzKarte(id, { klienci }),
        () => otworzKarte(id, { klienci }),
      ]);

      expect(klient.pobierzPrzesylki).toHaveBeenCalledTimes(2);
    });

    // Dlawik jest PER ZAMOWIENIE (wpis w logu wisi przy zamowieniu), wiec swiezo otwarta
    // karta drugiego zamowienia nie dziedziczy „pytane przed chwila" po pierwszej.
    it('dławik jednego zamówienia nie zamyka ust drugiemu', async () => {
      const pierwsze = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
      const drugie = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a2'), {});
      const klient = klientZ([]);
      const klienci = { allegro_szkicownia: klient };

      await otworzKarte(pierwsze, { klienci });
      await otworzKarte(drugie, { klienci });

      expect(klient.pobierzPrzesylki).toHaveBeenCalledTimes(2);
      expect(klient.pobierzPrzesylki.mock.calls.map((c) => c[0])).toEqual(['e2a1', 'e2a2']);
    });
  });

  // Panel bez zmiennych ALLEGRO_* (uslugi po prostu nie ma) ma wstawac i dzialac dokladnie
  // tak jak dotad — ta sama zasada, co przy braku sekcji INPOST_*.
  it('bez usługi Allegro karta wstaje normalnie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane('4321', { metoda_wysylki: 'dpd' }), {});
    const serwer = buildOmsServer({ db, config, poller });
    await serwer.ready();
    const odp = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(odp.statusCode).toBe(200);
  });

  // ⚠️ Paczka z Allegro NIE jest „zarejestrowana recznie" — nikt jej recznie nie wpisywal,
  // a przycisk „Skasuj przesylke zarejestrowana recznie" przy niej klamie: skasowany wiersz
  // wroci przy najblizszym otwarciu karty. Wiersz niesie `nadana_recznie` z powodu
  // technicznego (brak etykiety NIE jest przy nim sprawa do zalatwienia), wiec widok musi
  // rozroznic te dwa przypadki po `kurier`.
  it('karta nie proponuje kasowania paczki przyszłej z Allegro', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    const odp = await otworzKarte(id, { klienci: { allegro_szkicownia: klientZ([{ waybill: 'AD1' }]) } });

    expect(odp.body).not.toContain('skasuj-reczna');
    expect(odp.body).toContain('nadana w Allegro');
  });

  // ⚠️⚠️ I-1 (recenzja calej galezi), strona widoku. Numer WPISANY Z REKI przy zamowieniu
  // z Allegro ma kuriera 'allegro' (kurierzy/index.js: kurierWpisuRecznego) — czyli po starym
  // warunku widok pisal przy nim „przeczytany z konta" i CHOWAL przycisk kasowania. Literowka
  // zostawala wtedy na zawsze: rejestracja reczna ustawia `wyslane_at`, wiec prawdziwy numer
  // juz sie nie dociagnie. Rozstrzyga ZRODLO NUMERU, nie kurier.
  it('karta PROPONUJE kasowanie numeru WPISANEGO Z RĘKI, choć kurier to „allegro"', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane('e2a1'), {});
    // Dokladnie to, co robi trasa POST /zamowienia/:id/przesylki/reczna przy tym kanale.
    zarejestrujPrzesylkeReczna(db, id, { kurier: 'allegro', kolejnosc: 1, numerListu: 'AD-LITEROWKA' });
    oznaczWyslane(db, id);

    const odp = await otworzKarte(id, { klienci: { allegro_szkicownia: klientZ([]) } });

    expect(odp.body).toContain('skasuj-reczna');
    // …i opis nie klamie o tym, skad wzial sie numer.
    expect(odp.body).toContain('zarejestrowana ręcznie');
    expect(odp.body).not.toContain('przeczytany z konta');
  });
});
