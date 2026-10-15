import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd, zapiszProbeStatusuDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createCzuwaczPrzesylek, OKNO_SLEDZENIA_DNI } from '../../../src/moduly/wysylka/services/czuwacz-przesylek.js';

// CZWARTY ZEGAR — SLEDZENIE PACZEK W DRODZE (audyt 22.08, zgoda właściciela 23.08).
// Raz na godzine odpytuje statusy przesylek NADANYCH z ostatnich 14 dni, ta sama sciezka
// co karta (services/status-kuriera.js): wspolny dlawik godzinowy per paczka, wspolny wybor
// „kogo pytac" (w tym podwykonawca WzA). Po „Wyslane" proces przestaje byc slepy —
// doreczenie, zwrot i paczka bez ruchu wychodza SAME, a nie dopiero gdy klient napisze.

const zmapowane = (nr, nadpisz = {}) => ({
  zrodlo_id: nr, numer: String(nr), klient: { email: 'k@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '50.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z', pozycje: [], ...nadpisz,
});

const TERAZ = () => new Date('2026-08-23T12:00:00Z');
const surowaWzaDpd = JSON.stringify({ carrierTrackingData: { carrierId: 'DPD', carrierWaybill: '1049000000042U' } });

function nadana(db, zamowienieId, kurier, { numer = '123', surowa = '<x/>', utworzona = null } = {}) {
  const p = rozpocznijPrzesylke(db, zamowienieId, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: '/tmp/e.pdf', surowa });
  if (utworzona) db.prepare('UPDATE przesylki SET utworzona_at = ? WHERE id = ?').run(utworzona, p.id);
  return p.id;
}

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('czuwacz przesylek', () => {
  it('odpytuje nadane paczki z okna i zapisuje status; doreczone oraz stare pomija', async () => {
    const id1 = zapiszZamowienie(db, 'pro', zmapowane(1), {});
    nadana(db, id1, 'dpd', { numer: 'SW1' });
    const id2 = zapiszZamowienie(db, 'pro', zmapowane(2), {});
    const pDoreczona = nadana(db, id2, 'dpd', { numer: 'DONE1' });
    zapiszStatusDpd(db, pDoreczona, { opis: 'Przesyłka doręczona', at: '2026-08-21T10:00:00.000' });
    const id3 = zapiszZamowienie(db, 'pro', zmapowane(3), {});
    nadana(db, id3, 'dpd', { numer: 'OLD1', utworzona: '2026-08-01T10:00:00Z' });

    const pytania = [];
    const dpd = { statusPrzesylki: async (n) => { pytania.push(n); return { opis: 'Przyjęcie przesyłki w sortowni', at: '2026-08-23T09:00:00.000' }; } };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd }, teraz: TERAZ });

    const w = await czuwacz.przebieg();
    expect(pytania).toEqual(['SW1']);
    expect(w).toMatchObject({ kandydatow: 1, sprawdzone: 1, bledy: 0 });
    expect(OKNO_SLEDZENIA_DNI).toBe(14);
    const wiersz = db.prepare('SELECT status_kuriera FROM przesylki WHERE numer_listu = ?').get('SW1');
    expect(wiersz.status_kuriera).toBe('Przyjęcie przesyłki w sortowni');
  });

  it('paczka WzA z para przewoznika idzie do podwykonawcy DPD', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(4), {});
    nadana(db, id, 'allegro_wza', { numer: 'AD0XYZ', surowa: surowaWzaDpd });
    const pytania = [];
    const dpd = { statusPrzesylki: async (n) => { pytania.push(n); return { opis: 'Wydana do doręczenia', at: '2026-08-23T08:00:00.000' }; } };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd, allegro_wza: { bezSledzenia: true } }, teraz: TERAZ });

    const w = await czuwacz.przebieg();
    expect(pytania).toEqual(['1049000000042U']);
    expect(w.sprawdzone).toBe(1);
  });

  // ⚠️ REGRESJA Z PRODUKCJI (31.08.2026). Czuwacz wolal `odswiezStatusKuriera` z ATRAPA
  // zamowienia `{ id }` — bez `sklep`. Klient sledzenia kanalu Allegro wybiera KONTO po
  // kanale, wiec dostawal `kanal: null`, nie znajdowal klienta i oddawal `null`. Zapisu
  // nie bylo, bledu nie bylo, znacznik proby ROSL — czyli zegar udawal, ze pyta, przez
  // szesc dni. Trzy paczki wisialy w zakladce jako „bez ruchu", bedac DORECZONYMI.
  // Karta dziala, bo tam leci prawdziwy wiersz zamowienia — i to ukrylo usterke.
  it('paczka kanalu Allegro dostaje KANAL zamowienia, a nie atrape bez `sklep`', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(20), {});
    const pid = nadana(db, id, 'allegro', { numer: 'A005FK03X8' });
    db.prepare('UPDATE przesylki SET carrier_allegro = ? WHERE id = ?').run('ALLEGRO', pid);

    const konteksty = [];
    const allegro = {
      statusPrzesylki: async (n, kontekst) => {
        konteksty.push(kontekst);
        return { opis: 'Przesyłka została doręczona', at: '2026-08-23T09:00:00.000Z', kod: 'DELIVERED' };
      },
    };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { allegro }, teraz: TERAZ });

    const w = await czuwacz.przebieg();
    expect(konteksty).toEqual([{ carrier: 'ALLEGRO', kanal: 'allegro_szkicownia' }]);
    expect(w).toMatchObject({ kandydatow: 1, sprawdzone: 1, bledy: 0 });
    const wiersz = db.prepare('SELECT status_kuriera, status_kuriera_kod FROM przesylki WHERE id = ?').get(pid);
    expect(wiersz.status_kuriera_kod).toBe('DELIVERED');
  });

  it('dlawik godzinowy wspolny z karta: swiezo pytana paczka jest pomijana', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(5), {});
    const pid = nadana(db, id, 'dpd', { numer: 'FRESH1' });
    zapiszProbeStatusuDpd(db, pid, { at: TERAZ().toISOString(), blad: null });
    const pytania = [];
    const dpd = { statusPrzesylki: async (n) => { pytania.push(n); return null; } };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd }, teraz: TERAZ });

    const w = await czuwacz.przebieg();
    expect(pytania).toEqual([]);
    expect(w.pominiete).toBe(1);
  });

  it('blad kuriera nie przerywa przebiegu — nastepne paczki ida dalej, licznik rosnie', async () => {
    const id1 = zapiszZamowienie(db, 'pro', zmapowane(6), {});
    nadana(db, id1, 'dpd', { numer: 'ERR1' });
    const id2 = zapiszZamowienie(db, 'pro', zmapowane(7), {});
    nadana(db, id2, 'dpd', { numer: 'OK1' });
    let pierwsze = true;
    const dpd = {
      statusPrzesylki: async (n) => {
        if (pierwsze) { pierwsze = false; throw new Error('sieć padła'); }
        return { opis: 'Przesyłka odebrana przez Kuriera', at: '2026-08-23T07:00:00.000' };
      },
    };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd }, teraz: TERAZ });
    const w = await czuwacz.przebieg();
    expect(w.bledy).toBe(1);
    expect(w.sprawdzone).toBe(1);
  });

  // ⚠️ KOLEJNOSC JEST TRESCIA TESTU: paczka doreczyla sie DOPIERO W TYM przebiegu (status
  // zapisal ja przed chwila `odswiezStatusKuriera`), a mimo to skan pobran juz ja widzi.
  // Skan przed odpytaniem kurierow rozliczalby ja dopiero za godzine.
  it('po odpytaniu kurierow rozlicza doreczone pobrania, a jego awaria nie psuje sledzenia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(9, { pobranie: 1, kwota_pobrania: '50.00', chce_fakture: 1 }), {});
    nadana(db, id, 'dpd', { numer: 'COD1' });
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'u-cod-1', 'F/9', '2026-08-20T08:00:00.000Z');
    const dpd = { statusPrzesylki: async () => ({ opis: 'Przesyłka doręczona', at: '2026-08-23T09:00:00.000' }) };

    // Klient inFaktu, ktory zawsze odmawia oznaczenia — przebieg ma to zniesc.
    const infakt = {
      pobierzFakture: async (uuid) => ({ uuid, number: 'F/9', invoice_date: '2026-08-20', status: 'sent', left_to_pay: 5000 }),
      oznaczZaplacona: async () => { throw new Error('HTTP 500'); },
    };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd }, infakt, teraz: TERAZ });

    const wynik = await czuwacz.przebieg();
    expect(wynik.sprawdzone).toBe(1);      // sledzenie zadzialalo mimo awarii rozliczania
    expect(wynik.bledy).toBe(0);           // blad rozliczania NIE jest bledem statusu kuriera
    expect(wynik.pobrania).toMatchObject({ kandydatow: 1, zlecone: 0, bledy: 1 });
  });

  // ⚠️ FALSZYWA ZIELEN (recenzja 28.08.2026, D1): test mial tu zamowienie BEZ pobrania
  // i BEZ faktury, wiec „kandydatow: 0" bylo prawda takze po usunieciu straznika `infakt`
  // ze skanu — nie bylo czego zleic niezaleznie od niego. Teraz w bazie lezy PELNY kandydat
  // (pobranie + faktura + doreczona paczka) i cisza znaczy dokladnie to, co ma znaczyc:
  // panel bez klucza inFaktu SLEDZI paczki, a rozliczania po prostu nie robi.
  it('rozliczanie pobran chodzi takze bez klienta inFaktu i nie wywala przebiegu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(20, { pobranie: 1, kwota_pobrania: '50.00', chce_fakture: 1 }), {});
    nadana(db, id, 'dpd', { numer: 'NOINF1' });
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
      .run(id, 'u-noinf-1', 'F/20', '2026-08-20T08:00:00.000Z');
    const dpd = { statusPrzesylki: async () => ({ opis: 'Przesyłka doręczona', at: '2026-08-23T09:00:00.000' }) };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd }, teraz: TERAZ });

    const wynik = await czuwacz.przebieg();
    expect(wynik.sprawdzone).toBe(1);
    expect(wynik.pobrania).toMatchObject({ kandydatow: 0, zlecone: 0, bledy: 0 });
    // Zaden slad w bazie: dokument, ktorego panel nie dotknal, ma zostac otwarty na pozniej.
    expect(db.prepare('SELECT * FROM oznaczenia_zaplaty WHERE uuid = ?').get('u-noinf-1')).toBeUndefined();
  });

  it('straznik „jeden przebieg naraz": rownolegle tykniecie oddaje pominiety', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(8), {});
    nadana(db, id, 'dpd', { numer: 'SLOW1' });
    let odblokuj;
    const dpd = { statusPrzesylki: () => new Promise((res) => { odblokuj = () => res(null); }) };
    const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { dpd }, teraz: TERAZ });
    const pierwszy = czuwacz.przebieg();
    const drugi = await czuwacz.przebieg();
    expect(drugi).toEqual({ pominiety: true });
    odblokuj();
    await pierwszy;
  });
});

// Okablowanie zegara #4: uruchomZegary rejestruje CZTERY interwaly, a przebieg czuwacza
// bije puls (ta sama klasa awarii, co `if (false && czuwaczKsef)` — zegar zbudowany
// i niezarejestrowany wyglada jak spokojna noc).
import { uruchomZegary } from '../../pomoc/zegary-parytetu.ts';
import { createPuls } from '../../../src/core/puls.js';

describe('zegar #4 w uruchomZegary', () => {
  it('rejestruje sie obok trzech pozostalych i bije puls po udanym przebiegu', async () => {
    const zarejestrowane = [];
    const puls = createPuls();
    uruchomZegary({
      poller: { przebieg: async () => ({}) },
      czuwaczKsef: { przebieg: async () => ({}) },
      czuwaczKosztow: { przebieg: async () => ({}) },
      czuwaczPrzesylek: { przebieg: async () => ({ kandydatow: 0, sprawdzone: 0, bledy: 0, pominiete: 0 }) },
      ustawInterwal: (fn, ms) => { zarejestrowane.push({ fn, ms }); return zarejestrowane.length; },
      log: () => {}, puls,
    });
    expect(zarejestrowane.map((z) => z.ms)).toEqual([2 * 60 * 1000, 60 * 60 * 1000, 60 * 60 * 1000, 60 * 60 * 1000]);
    zarejestrowane[3].fn();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(puls.stan().czuwaczPrzesylek?.okAt).toBeTruthy();
  });

  // ⚠️ NIEUDANE ZLECENIE DO inFAKTU NIE MA PRAWA ZGINAC W CISZY: `wynik.bledy` liczy
  // WYLACZNIE statusy kurierskie, wiec bez wlasnej linii jedynym sladem po fakturze, ktora
  // zostala w ksiegowosci jako falszywy dlug, bylby log konkretnego zamowienia.
  it('rozliczanie pobran z bledem albo bez daty zaplaty zostawia slad w logu procesu', async () => {
    const zarejestrowane = [];
    const linie = [];
    uruchomZegary({
      czuwaczPrzesylek: {
        przebieg: async () => ({
          kandydatow: 0, sprawdzone: 0, bledy: 0, pominiete: 0, pobrania: { kandydatow: 2, zlecone: 0, bledy: 1, bezDaty: 1 },
        }),
      },
      ustawInterwal: (fn) => { zarejestrowane.push(fn); return 1; },
      log: (...a) => { linie.push(a.join(' ')); }, puls: createPuls(),
    });
    zarejestrowane[0]();
    await new Promise((r) => { setTimeout(r, 0); });
    const komunikat = linie.find((l) => l.includes('rozliczanie pobrań'));
    expect(komunikat).toMatch(/1 nieudanych zleceń/);
    expect(komunikat).toMatch(/1 bez znanej daty zapłaty/);
  });

  // ⚠️⚠️ OBCIECIE PRZEBIEGU MA BYC SLYCHAC (recenzja poprawkowa 28.08.2026, W6). Sufit skanu
  // jest bezpieczny (idempotentnosc), ale CICHE obciecie wyglada w logu tak samo jak „nie bylo
  // nic do zrobienia" — a to wlasnie roznica miedzy „nic sie nie dzieje" a „zaleglosc rosnie".
  it('obciecie przebiegu sufitem zostawia WLASNA linie w logu procesu', async () => {
    const zarejestrowane = [];
    const linie = [];
    uruchomZegary({
      czuwaczPrzesylek: {
        przebieg: async () => ({
          kandydatow: 0,
          sprawdzone: 0,
          bledy: 0,
          pominiete: 0,
          // Przebieg BEZ ANI JEDNEGO bledu: gdyby linia o suficie wisiala na `bledy`,
          // ten przypadek przeszedlby w ciszy.
          pobrania: {
            kandydatow: 35, obsluzone: 20, ponadSufit: 15, zlecone: 20, pominiete: 0, bezDaty: 0, bledy: 0,
          },
        }),
      },
      ustawInterwal: (fn) => { zarejestrowane.push(fn); return 1; },
      log: (...a) => { linie.push(a.join(' ')); }, puls: createPuls(),
    });
    zarejestrowane[0]();
    await new Promise((r) => { setTimeout(r, 0); });
    const komunikat = linie.find((l) => l.includes('NIE ZMIEŚCIŁO'));
    expect(komunikat).toMatch(/15 dokument/);
  });

  it('pominiety przebieg NIE bije pulsu (zawieszony czuwacz ma sie starzec)', async () => {
    const zarejestrowane = [];
    const puls = createPuls();
    uruchomZegary({
      czuwaczPrzesylek: { przebieg: async () => ({ pominiety: true }) },
      ustawInterwal: (fn) => { zarejestrowane.push(fn); return 1; },
      log: () => {}, puls,
    });
    zarejestrowane[0]();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(puls.stan().czuwaczPrzesylek).toBeUndefined();
  });
});
