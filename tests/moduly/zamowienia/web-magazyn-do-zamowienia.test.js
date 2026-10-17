import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-21T09:00:00', ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 5001, numer: '5001', klient: { first_name: 'Jan' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00',
  koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-21T09:00:00',
  pozycje: [], ...nad,
});

const produkt = (nad = {}) => ({
  kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', nazwa: 'Lampa stołowa Grzybek',
  sku_sklepu: 'LMP-GRZ-30', cena_gr: 7490, rozmiar_tekst: '30x45', kategorie: [], zdjecia: [],
  adres: 'https://szkicownia.pl/produkt/grzybek', odczytane_at: '2026-08-21T08:00:00', ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const karta = (id, q = '') => app.inject({ method: 'GET', url: `/zamowienia/${id}${q}`, headers: naglowek });
const dodaj = (id, payload) => app.inject({
  method: 'POST', url: `/zamowienia/${id}/pozycje/z-magazynu`, headers: naglowek, payload,
});
const pozycje = (id) => pobierzZamowienie(db, id).pozycje;

describe('karta — dodaj z magazynu', () => {
  it('rzeczywisty hx-include niesie powrót do fragmentu dla obu kontrolek', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const powrot = '/?status=nowe&kanal=pro';
    const body = (await karta(
      id,
      `?edytuj=pozycje&magazyn=grzybek&powrot=${encodeURIComponent(powrot)}`,
    )).body;
    const formularz = body.match(/<form[^>]*id="magazyn-pasek"[^>]*>[\s\S]*?<\/form>/)?.[0];
    expect(formularz).toBeTruthy();

    const wartosc = (nazwa) => {
      const input = formularz.match(new RegExp(`<input[^>]*name="${nazwa}"[^>]*>`))?.[0];
      if (input) return input.match(/value="([^"]*)"/)?.[1]?.replaceAll('&amp;', '&') ?? '';
      const select = formularz.match(new RegExp(`<select[^>]*name="${nazwa}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0];
      return select?.match(/<option value="([^"]*)"[^>]*selected/)?.[1] ?? '';
    };
    const parametryHtmx = (nazwaKontrolki) => {
      const kontrolka = formularz.match(new RegExp(
        `<(?:input|select)[^>]*name="${nazwaKontrolki}"[^>]*hx-get="[^"]+"[^>]*>`,
      ))?.[0];
      const selektor = kontrolka?.match(/hx-include="([^"]+)"/)?.[1] ?? '';
      const nazwyDolaczone = [...selektor.matchAll(/#magazyn-pasek \[name='([^']+)'\]/g)]
        .map((trafienie) => trafienie[1]);
      const wynik = new URLSearchParams({ [nazwaKontrolki]: wartosc(nazwaKontrolki) });
      for (const nazwa of nazwyDolaczone) wynik.set(nazwa, wartosc(nazwa));
      return wynik;
    };

    for (const kontrolka of ['magazyn', 'cennik']) {
      const parametry = parametryHtmx(kontrolka);
      expect(parametry.get('powrot')).toBe(powrot);
      const fragment = await app.inject({
        method: 'GET',
        url: `/zamowienia/${id}/magazyn/wyniki?${parametry.toString()}`,
        headers: naglowek,
      });
      expect(fragment.statusCode).toBe(200);
      expect(fragment.body).toContain('name="powrot" value="/?status=nowe&amp;kanal=pro"');
    }
  });

  it('szuka po fragmencie nazwy i pokazuje cenę z cennika', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const body = (await karta(id, '?edytuj=pozycje&magazyn=grzybek')).body;
    expect(body).toContain('Lampa stołowa Grzybek');
    expect(body).toContain('74.90 zł');
  });

  // ⚠️ Przy telefonie operator wpisuje dwa slowa z pamieci, a nie poczatek nazwy.
  it('szuka po WSZYSTKICH słowach naraz, w dowolnej kolejności', async () => {
    zapiszProduktSklepowy(db, produkt({ nazwa: 'Lampa wisząca Szpulka 50cm', rozmiar_tekst: null }));
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    expect((await karta(id, '?edytuj=pozycje&magazyn=szpulka+50')).body).toContain('Szpulka 50cm');
    expect((await karta(id, '?edytuj=pozycje&magazyn=50+szpulka')).body).toContain('Szpulka 50cm');
    expect((await karta(id, '?edytuj=pozycje&magazyn=szpulka+kot')).body).toContain('Nic nie pasuje');
  });

  it('szuka też po SKU', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    expect((await karta(id, '?edytuj=pozycje&magazyn=LMP-GRZ')).body).toContain('Lampa stołowa Grzybek');
  });

  it('dopisuje pozycję z ceną i wariantem z lustra', async () => {
    zapiszProduktSklepowy(db, produkt({ wariant_id: '28041' }));
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await dodaj(id, {
      kanal: 'szkicownia', produkt_id: '28040', wariant_id: '28041', ilosc: '3', fraza: 'grzybek',
    });
    expect(odp.statusCode).toBe(302);
    const [p] = pozycje(id);
    expect(p).toMatchObject({
      nazwa: 'Lampa stołowa Grzybek 30x45', sku: 'LMP-GRZ-30', ilosc: 3,
      cena_brutto: '74.90', brutto_linii: '224.70', zrodlo: 'reczna', produkt_id: 28040, wariant_id: '28041',
    });
  });

  // ⚠️⚠️ TO JEST TEST O PIENIADZACH. Pole z cena w HTML-u da sie podmienic, wiec trasa ma
  // czytac cene WYLACZNIE z lustra — cena podana w formularzu nie ma prawa nic znaczyc.
  it('cena podana w formularzu jest ignorowana — liczy się cennik', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await dodaj(id, {
      kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '1',
      cena_brutto: '1.00', cena_netto: '0.81', brutto_linii: '1.00',
    });
    expect(pozycje(id)[0].cena_brutto).toBe('74.90');
  });

  // ⚠️ SEDNO ZGLOSZENIA: „ceny domyslne to ceny ze sklepow szkicownia oraz PRO, nie z Allegro".
  it('kanał allegrowy podstawiony w formularzu → odmowa, a nie cena z prowizją', async () => {
    zapiszProduktSklepowy(db, produkt({ kanal: 'allegro_szkicownia', cena_gr: 9900 }));
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await dodaj(id, { kanal: 'allegro_szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '1' });
    // Kanal spoza cennika schodzi do detalu (domena), wiec pozycja wchodzi po cenie SKLEPOWEJ.
    expect(odp.statusCode).toBe(302);
    expect(pozycje(id)[0].cena_brutto).toBe('74.90');
  });

  it('produkt bez ceny w tym cenniku → 400 i nic nie wchodzi do zamówienia', async () => {
    zapiszProduktSklepowy(db, produkt({ cena_gr: null }));
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await dodaj(id, { kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '1' });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/nie ma ceny w cenniku/);
    expect(pozycje(id)).toHaveLength(0);
  });

  // ⚠️ Cena produktu wycofanego ze sklepu to najgorszy rodzaj podpowiedzi: wyglada na prawdziwa.
  it('produkt wycofany ze sklepu nie pokazuje się i nie da się go dodać', async () => {
    zapiszProduktSklepowy(db, produkt());
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-08-20T10:00:00'").run();
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    expect((await karta(id, '?edytuj=pozycje&magazyn=grzybek')).body).toContain('Nic nie pasuje');
    expect((await dodaj(id, { kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '1' })).statusCode).toBe(400);
  });

  it('kwota zamówienia ręcznego rośnie o dopisaną pozycję', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane({ kwota_brutto: '0.00' }), {});
    await dodaj(id, { kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '2' });
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('149.80');
  });

  it('log mówi, z którego cennika wzięta jest cena', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    await dodaj(id, { kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '1' });
    const wpis = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id DESC').get(id);
    expect(wpis.akcja).toBe('pozycja.z-magazynu');
    expect(wpis.wynik).toContain('szkicownia.pl');
  });

  // Wracamy DO WYNIKOW: przy telefonie klient dokłada „i jeszcze ten mniejszy".
  it('po dodaniu wraca na kartę z tą samą frazą i cennikiem', async () => {
    zapiszProduktSklepowy(db, produkt());
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await dodaj(id, { kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '1', fraza: 'grzybek' });
    expect(odp.headers.location).toContain('magazyn=grzybek');
    expect(odp.headers.location).toContain('cennik=szkicownia');
    expect(odp.headers.location).toContain('edytuj=pozycje');
  });

  it('zamówienie z PRO domyślnie szuka w cenniku PRO', async () => {
    zapiszProduktSklepowy(db, produkt({ kanal: 'pro', cena_gr: 6100 }));
    zapiszProduktSklepowy(db, produkt({ cena_gr: 7490 }));
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    const body = (await karta(id, '?edytuj=pozycje&magazyn=grzybek')).body;
    expect(body).toContain('61.00 zł');
    expect(body).not.toContain('74.90 zł');
  });
});

// =====================================================================================
// EKRAN ZAKLADANIA — tam zamowienia jeszcze NIE MA, wiec szukanie i dodawanie oddaja
// formularz z powrotem, a do bazy nie idzie ani jeden zapis.
// =====================================================================================
const nowe = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });
const ileZamowien = () => db.prepare('SELECT COUNT(*) AS ile FROM zamowienia').get().ile;

describe('ekran zakładania — dodaj z magazynu', () => {
  it('szukanie oddaje wyniki i NIE zakłada zamówienia', async () => {
    zapiszProduktSklepowy(db, produkt());
    const odp = await nowe('/zamowienia/nowe/magazyn', { magazyn: 'grzybek', cennik: 'szkicownia', w_firma: 'Jan' });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Lampa stołowa Grzybek');
    expect(ileZamowien()).toBe(0);
  });

  // ⚠️ Operator trzyma sluchawke — szukanie nie ma prawa skasowac tego, co juz wpisal.
  it('szukanie nie gubi wpisanych danych klienta', async () => {
    zapiszProduktSklepowy(db, produkt());
    const odp = await nowe('/zamowienia/nowe/magazyn', { magazyn: 'grzybek', w_firma: 'Grażyna Nowak', w_miasto: 'Pęki' });
    expect(odp.body).toContain('Grażyna Nowak');
    expect(odp.body).toContain('Pęki');
  });

  it('dodanie wstawia produkt do pierwszego wolnego wiersza tabeli pozycji', async () => {
    zapiszProduktSklepowy(db, produkt({ wariant_id: '28041' }));
    const odp = await nowe('/zamowienia/nowe/magazyn/dodaj', {
      magazyn: 'grzybek', cennik: 'szkicownia', wybrany: '0',
      mag_kanal: 'szkicownia', mag_produkt_id: '28040', mag_wariant_id: '28041', mag_ilosc: '2',
    });
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('value="Lampa stołowa Grzybek 30x45"');
    expect(odp.body).toContain('value="74.90"');
    expect(odp.body).toContain('value="28041"');
    expect(ileZamowien()).toBe(0);
  });

  // ⚠️ WYBOR IDZIE PO INDEKSIE po ROWNOLEGLYCH TABLICACH — pomylka o jeden wiersz to inny
  // produkt i inna cena.
  it('bierze ten wiersz wyników, który wskazał przycisk', async () => {
    zapiszProduktSklepowy(db, produkt());
    zapiszProduktSklepowy(db, produkt({ produkt_id: '28050', nazwa: 'Lampa stołowa Dąbek', cena_gr: 5490, sku_sklepu: 'LMP-DAB' }));
    const odp = await nowe('/zamowienia/nowe/magazyn/dodaj', {
      magazyn: 'lampa', wybrany: '1',
      mag_kanal: ['szkicownia', 'szkicownia'],
      mag_produkt_id: ['28040', '28050'],
      mag_wariant_id: ['', ''],
      mag_ilosc: ['1', '4'],
    });
    expect(odp.body).toContain('value="Lampa stołowa Dąbek 30x45"');
    expect(odp.body).toContain('value="54.90"');
    expect(odp.body).toContain('value="4"');
  });

  it('dwie pozycje z magazynu wchodzą do dwóch osobnych wierszy', async () => {
    zapiszProduktSklepowy(db, produkt());
    const pierwsze = await nowe('/zamowienia/nowe/magazyn/dodaj', {
      wybrany: '0', mag_kanal: 'szkicownia', mag_produkt_id: '28040', mag_wariant_id: '', mag_ilosc: '1',
      poz_nazwa: 'Wpisane ręcznie', poz_cena_brutto: '10.00', poz_ilosc: '1', poz_sku: '',
      poz_cena_netto: '', poz_produkt_id: '', poz_wariant_id: '',
    });
    expect(pierwsze.body).toContain('value="Wpisane ręcznie"');
    expect(pierwsze.body).toContain('value="Lampa stołowa Grzybek 30x45"');
  });

  it('produkt bez ceny → 400, formularz wraca z komunikatem i bez pozycji', async () => {
    zapiszProduktSklepowy(db, produkt({ cena_gr: null }));
    const odp = await nowe('/zamowienia/nowe/magazyn/dodaj', {
      wybrany: '0', mag_kanal: 'szkicownia', mag_produkt_id: '28040', mag_wariant_id: '', mag_ilosc: '1',
      w_firma: 'Jan Kowalski',
    });
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/nie ma ceny w cenniku/);
    expect(odp.body).toContain('Jan Kowalski');
  });
});
