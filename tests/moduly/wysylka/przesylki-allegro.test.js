import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { sprawyPrzesylki } from '../../../src/domena/przesylka-stan.js';
import { createPrzesylkiAllegro } from '../../../src/moduly/wysylka/services/przesylki-allegro.js';
import { skasujPrzesylkeReczna } from '../../../src/moduly/wysylka/db/przesylki.js';

// ⚠️ CO TA USLUGA ROBI, A CZEGO NIE.
//
// Paczke zamowienia z Allegro nadaje SPRZEDAWCA W PANELU ALLEGRO, na umowie Allegro.
// Panel jej NIE NADAJE i nie ma nadawac (brak wpisu w `DLA_METODY`, kurierzy/index.js).
// Ta usluga wylacznie ODNOTOWUJE fakt o paczce, ktora juz ma numer listu — dokladnie tak
// samo, jak reczna rejestracja przesylki nadanej poza panelem, i TA SAMA droga zapisu
// (`zarejestrujPrzesylkeReczna`), zeby obie przechodzily przez te same siatki.

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

const zamowienie = (sklep = 'allegro_szkicownia', nad = {}) => zapiszZamowienie(db, sklep, zmapowane('e2a1', nad), {});

const klientZ = (przesylki) => ({ pobierzPrzesylki: vi.fn().mockResolvedValue(przesylki) });
const usluga = (klienci) => createPrzesylkiAllegro({ db, klienci });

const wiersze = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ? ORDER BY kolejnosc').all(id);
const log = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);

describe('numery listów z Allegro', () => {
  it('dopisuje przesyłkę z kurierem ALLEGRO, nie z domyślnym DPD', async () => {
    const id = zamowienie();
    const u = usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD0LK57DLG0756H4H', carrierId: 'ALLEGRO' }]) });

    expect(await u.odswiez(id)).toEqual({ dopisane: 1 });

    const [p] = wiersze(id);
    expect(p.numer_listu).toBe('AD0LK57DLG0756H4H');
    // ⚠️ Zapasowe 'dpd' zniosloby numer Allegro na tracktrace.dpd.com.pl.
    expect(p.kurier).toBe('allegro');
    expect(p.status).toBe('nadana');
    expect(p.kolejnosc).toBe(1);
  });

  // ⚠️ NAJWAZNIEJSZY WARIANT POPRZEDNIEGO TESTU, i sam poprzedni go NIE LAPIE.
  // `kurierWpisuRecznego` czyta METODE WYSYLKI, a metoda bywa 'nieznana' (Allegro dolozylo
  // usluge, ktorej slownik jeszcze nie zna — allegro-dostawa.js). Kod kluczujacy kuriera po
  // metodzie wpisalby wtedy zapasowe 'dpd' i numer „AD…" poszedlby do DPD. Kurier tej paczki
  // wynika z KANALU (kolumna `sklep`), a kanal jest trwaly — metoda jest edytowalna z karty.
  it('kurier to allegro TAKZE przy metodzie, ktorej panel nie zna', async () => {
    const id = zamowienie('allegro_szkicownia', { metoda_wysylki: 'nieznana' });
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1', carrierId: 'ALLEGRO' }]) }).odswiez(id);
    expect(wiersze(id)[0].kurier).toBe('allegro');
  });

  // ⚠️⚠️ I-1 (recenzja calej galezi): TO POLE JEST CALA OCHRONA TEGO NUMERU. `kurier` jej nie
  // udzwignie, bo wiersz WPISANY Z REKI przy zamowieniu z Allegro tez ma kuriera 'allegro'
  // (kurierzy/index.js) — a jego kasowanie musi byc DOZWOLONE, bo literowka jest tam mozliwa.
  // Bez `zrodlo_numeru = 'allegro'` odmowa w db/przesylki.js nie ma po czym rozpoznac numeru,
  // ktorego panel nie odzyska: karta pyta Allegro tylko dopoki zamowienie nie ma `wyslane_at`.
  it('numer odczytany z API dostaje zrodlo_numeru „allegro" — to ono, a nie kurier, go chroni', async () => {
    const id = zamowienie();
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1', carrierId: 'ALLEGRO' }]) }).odswiez(id);
    expect(wiersze(id)[0].zrodlo_numeru).toBe('allegro');
    expect(() => skasujPrzesylkeReczna(db, wiersze(id)[0].id)).toThrow(/Allegro/);
  });

  it('POWTORZENIE nie tworzy drugiego wiersza — usługa bywa wołana wielokrotnie', async () => {
    const id = zamowienie();
    const u = usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1', carrierId: 'ALLEGRO' }]) });

    expect(await u.odswiez(id)).toEqual({ dopisane: 1 });
    expect(await u.odswiez(id)).toEqual({ dopisane: 0 });
    expect(await u.odswiez(id)).toEqual({ dopisane: 0 });

    expect(wiersze(id)).toHaveLength(1);
    // Jeden wpis w logu, nie trzy: log ma niesc FAKTY, a nie slad kazdego odpytania.
    expect(log(id).filter((w) => w.akcja === 'allegro.przesylka')).toHaveLength(1);
  });

  it('brak przesyłek u Allegro NIE JEST błędem — paczka mogła jeszcze nie wyjechać', async () => {
    const id = zamowienie();
    await expect(usluga({ allegro_szkicownia: klientZ([]) }).odswiez(id)).resolves.toEqual({ dopisane: 0 });
    expect(wiersze(id)).toHaveLength(0);
  });

  // ⚠️ Allegro tworzy przesylke ZANIM przewoznik przydzieli numer listu — dokladnie ten sam
  // stan, co `tworzona_u_kuriera` przy InPoscie. Wiersz bez numeru bylby klamstwem (karta
  // pokazalaby paczke, ktorej nie da sie sledzic), a `zarejestrujPrzesylkeReczna` i tak
  // odmawia — wiec musimy takie pozycje PRZEMILCZEC, nie wywalic sie na nich.
  it('przesyłka BEZ numeru listu jest pomijana, a nie zapisywana ani rzucana', async () => {
    const id = zamowienie();
    const u = usluga({
      allegro_szkicownia: klientZ([{ waybill: null, carrierId: 'ALLEGRO' }, { waybill: '   ', carrierId: 'ALLEGRO' }]),
    });
    await expect(u.odswiez(id)).resolves.toEqual({ dopisane: 0 });
    expect(wiersze(id)).toHaveLength(0);
  });

  // Ta sama pulapka, co przy `id` z ShipX (naIdentyfikator w db/przesylki.js): sterownik
  // node:sqlite wiaze liczby jako zmiennoprzecinkowe, wiec w kolumnie TEXT ladowaloby „123.0".
  it('numer przysłany LICZBĄ zapisuje się jako napis, bez ogona „.0"', async () => {
    const id = zamowienie();
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 6000123456789, carrierId: 'ALLEGRO' }]) }).odswiez(id);
    expect(wiersze(id)[0].numer_listu).toBe('6000123456789');
  });

  // ⚠️ ZAMOWIENIE ROZBITE NA DWIE PACZKI. Sprawdzenie „czy zamowienie ma juz jakas paczke"
  // pominoloby druga na zawsze; sprawdzamy po NUMERZE, a numer kolejny liczymy z bazy
  // (nastepnaKolejnosc), wiec druga paczka nie odbija sie od indeksu `przesylki_kolejnosc_zywa`.
  //
  // ⚠️ TO NIE JEST TEST NA DOSYLKE za paczke ZAGUBIONA i nie wolno go tak czytac. Dosylka
  // powstaje w Allegro dni po tym, jak czlowiek oznaczyl zamowienie jako wyslane, a karta
  // pyta WYLACZNIE dopoki `wyslane_at` jest puste — panel jej wiec NIE DOCIAGNIE (znane
  // ograniczenie, PRZEWODNIK.md 4.1). Tu mierzymy sam MECHANIZM dopisania drugiej paczki,
  // ktory dziala dla numeru oddanego przed oznaczeniem wysylki.
  it('DRUGI numer listu dopisuje się jako paczka nr 2', async () => {
    const id = zamowienie();
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1' }]) }).odswiez(id);
    const wynik = await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1' }, { waybill: 'AD2' }]) }).odswiez(id);

    expect(wynik).toEqual({ dopisane: 1 });
    expect(wiersze(id).map((p) => [p.kolejnosc, p.numer_listu])).toEqual([[1, 'AD1'], [2, 'AD2']]);
  });

  it('TEN SAM numer dwa razy w JEDNEJ odpowiedzi daje jeden wiersz', async () => {
    const id = zamowienie();
    const wynik = await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1' }, { waybill: 'AD1' }]) }).odswiez(id);
    expect(wynik).toEqual({ dopisane: 1 });
    expect(wiersze(id)).toHaveLength(1);
  });

  // ⚠️ ROZSTRZYGA KANAL (kolumna `sklep`), NIE OBECNOSC KLUCZA W MAPIE KLIENTOW.
  // Klucz sklepu i klucz kanalu leza w JEDNEJ przestrzeni nazw (`zamowienia.sklep`), wiec
  // sama mapa nie jest siatka: pomylkowy wpis pod kluczem sklepu kazalby panelowi pytac
  // Allegro o zamowienie z WooCommerce i dopisac mu paczke z kurierem 'allegro' — czyli
  // paczke, ktorej nikt nie nadal, do zamowienia, ktore panel POWINIEN nadac sam.
  it('zamówienie SPOZA kanału Allegro nie jest w ogóle odpytywane', async () => {
    const id = zapiszZamowienie(db, 'szkicownia', zmapowane('e2a1', { metoda_wysylki: 'dpd' }), {});
    const klient = klientZ([{ waybill: 'AD1' }]);

    await expect(usluga({ szkicownia: klient }).odswiez(id)).resolves.toEqual({ dopisane: 0 });

    expect(klient.pobierzPrzesylki).not.toHaveBeenCalled();
    expect(wiersze(id)).toHaveLength(0);
  });

  it('kanał bez skonfigurowanego klienta i nieistniejące zamówienie oddają zero', async () => {
    const id = zamowienie();
    await expect(usluga({}).odswiez(id)).resolves.toEqual({ dopisane: 0 });
    await expect(usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1' }]) }).odswiez(999999))
      .resolves.toEqual({ dopisane: 0 });
  });

  it('pyta Allegro o identyfikator ZE ZRODLA, a nie o nasze id wiersza', async () => {
    const id = zamowienie();
    const klient = klientZ([]);
    await usluga({ allegro_szkicownia: klient }).odswiez(id);
    expect(klient.pobierzPrzesylki).toHaveBeenCalledWith('e2a1');
  });

  // ⚠️ DECYZJA: paczka z Allegro NIE USTAWIA `wyslane_at` (niezmiennik 4.1).
  //
  // 4.1 mowi, ze reczna rejestracja przesylki nadanej poza panelem `wyslane_at` USTAWIA —
  // ale uzasadnia to tym, ze „czlowiek stwierdza fakt o paczce, ktora JUZ JEDZIE". Tutaj
  // czlowieka nie ma: wyzwalaczem jest istnienie ETYKIETY kupionej w panelu Allegro, a
  // etykieta powstaje PRZY PAKOWANIU — paczka wyjezdza z kurierem, czesto nastepnego dnia.
  // To DOKLADNIE ten fakt, ktory 31.07.2026 przestal byc zrodlem statusu na prosbe
  // wlasciciela („po utworzeniu etykiety nie zmieniaj statusu na wyslane"), bo zamowienia
  // znikaly z listy roboczej, lezac jeszcze na stole. Zamowienie schodzi z listy dopiero,
  // gdy czlowiek powie, ze paczka pojechala — belka statusu na karcie dziala tu jak wszedzie.
  it('NIE ustawia wyslane_at — status zostaje przy człowieku', async () => {
    const id = zamowienie();
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1' }]) }).odswiez(id);
    expect(pobierzZamowienie(db, id).wyslane_at).toBeNull();
  });

  // ⚠️ Bez `nadana_recznie` kazde zamowienie z Allegro wisialoby na liscie roboczej ze sprawa
  // „brak etykiety" — NA ZAWSZE i BEZ WYJSCIA, bo panel o te paczke nigdy z nikim nie
  // rozmawial i zadnego pliku nie dostanie (patrz sprawyPrzesylki w domain/przesylka-stan.js).
  it('wiersz jest oznaczony jako nadany poza panelem i nie robi sprawy „brak etykiety"', async () => {
    const id = zamowienie();
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD1' }]) }).odswiez(id);
    const [p] = wiersze(id);
    expect(p.nadana_recznie).toBe(1);
    expect(p.etykieta_sciezka).toBeNull();
    expect(sprawyPrzesylki(p)).toEqual([]);
  });

  it('zapisuje w logu, że numer PRZYSZEDŁ z Allegro, a panel niczego nie nadał', async () => {
    const id = zamowienie();
    await usluga({ allegro_szkicownia: klientZ([{ waybill: 'AD0LK57DLG0756H4H' }]) }).odswiez(id);
    const wpis = log(id).find((w) => w.akcja === 'allegro.przesylka');
    expect(wpis.wynik).toContain('AD0LK57DLG0756H4H');
    expect(wpis.wynik).toMatch(/nada/i);
  });

  // Awaria Allegro (401 po wygasnieciu zgody, 500, timeout) NIE JEST tu polykana: usluga ma
  // powiedziec wolajacemu, ze nie wie. Odpornosc siedzi u WOLAJACEGO (karta zamowienia
  // renderuje sie mimo awarii), dokladnie tak samo jak przy odswiezaniu statusu kuriera —
  // ciche `catch` tutaj zamienialoby awarie kanalu w „ta paczka nie ma numeru".
  it('awaria Allegro leci w górę, a nie udaje braku przesyłek', async () => {
    const id = zamowienie();
    const klient = { pobierzPrzesylki: vi.fn().mockRejectedValue(new Error('Allegro: HTTP 401 przy /shipments')) };
    await expect(usluga({ allegro_szkicownia: klient }).odswiez(id)).rejects.toThrow(/HTTP 401/);
    expect(wiersze(id)).toHaveLength(0);
  });
});

// ——— IDENTYFIKATOR PRZEWOZNIKA (25.08.2026) ————————————————————————————————————————
// `carrierId` przychodzil w tej samej odpowiedzi od poczatku i byl WYRZUCANY — czytalismy
// z niej sam `waybill`. Bez niego panel nie mial kogo zapytac o statusy tych paczek, wiec
// `status_kuriera` zostawal NULL na zawsze, a regula „bez ruchu" liczyla wiek od nadania
// i alarmowala bez konca. Szesc paczek wisialo tak w zakladce, bedac DORECZONYMI.
//
// ⚠️ TEN OPIS POWSTAL PO MUTACJI, KTORA PRZEZYLA. Skasowanie `carrierAllegro` z wywolania
// zapisu nie wywalalo zadnego testu — czyli caly kanal moglby wrocic do slepoty po cichu.
describe('identyfikator przewoźnika z Allegro', () => {
  it('zapisuje carrierId razem z numerem listu', async () => {
    const id = zamowienie();
    const u = usluga({ allegro_szkicownia: klientZ([{ waybill: 'A005DUH6H5', carrierId: 'ALLEGRO' }]) });

    expect(await u.odswiez(id)).toEqual({ dopisane: 1 });

    const [p] = wiersze(id);
    expect(p.carrier_allegro).toBe('ALLEGRO');
  });

  // ⚠️ NULL, A NIE PUSTY NAPIS ANI STALA. `sledzeniePrzesylki` odmawia pytania przy pustej
  // kolumnie — i to jest cala ochrona przed pytaniem ZLEGO przewoznika, ktory oddaje
  // HTTP 200 z `trackingDetails: null`, czyli odpowiedz nie do odroznienia od „brak zdarzen".
  it('brak carrierId w odpowiedzi zapisuje NULL, nie zgadywana stala', async () => {
    const id = zamowienie();
    const u = usluga({ allegro_szkicownia: klientZ([{ waybill: 'A005DUH6H5' }]) });

    await u.odswiez(id);

    const [p] = wiersze(id);
    expect(p.carrier_allegro).toBe(null);
  });

  it('przewoźnik inny niż ALLEGRO idzie do bazy dokładnie taki, jaki przyszedł', async () => {
    const id = zamowienie();
    const u = usluga({ allegro_szkicownia: klientZ([{ waybill: 'A005DUH6H5', carrierId: 'INPOST' }]) });

    await u.odswiez(id);

    expect(wiersze(id)[0].carrier_allegro).toBe('INPOST');
  });
});
