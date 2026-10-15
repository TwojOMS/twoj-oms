import { describe, it, expect } from 'vitest';
import { createAllegroSledzenieClient } from '../../src/oms/kurierzy/allegro.js';

// KLIENT SLEDZENIA KANALU ALLEGRO (25.08.2026).
//
// Do 25.08 wiersz z `kurier = 'allegro'` nie mial klienta w mapie i bylo to udokumentowane
// jako stan poprawny („panel o te paczke nikogo nie pyta, bo nadal jej nie my" —
// kurierzy/index.js). Sonda na zywym API tego dnia pokazala, ze zalozenie bylo za szerokie:
// `GET /order/carriers/{carrierId}/tracking?waybill=` oddaje PELNA historie takze dla
// przesylek nadanych POZA panelem (Allegro Punkt, Allegro One). Szesc paczek wiszacych
// wtedy w „bez ruchu" bylo w rzeczywistosci DORECZONYCH.
//
// KONTRAKT IDENTYCZNY JAK `dpd.statusPrzesylki` / `inpost.statusPrzesylki`: `{ opis, at }`
// najnowszego zdarzenia albo `null`. Roznica jest jedna i jawna — dokladamy `kod`, bo
// Allegro jako jedyny oddaje wartosc MASZYNOWA, a opis jest tlumaczeniem.

const zdarzenie = (occurredAt, code, description) => ({ occurredAt, code, description });

function szpieg(cialo, { ok = true, status = 200 } = {}) {
  const wywolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wywolania.push({ url, opcje });
    return { ok, status, json: async () => cialo, text: async () => JSON.stringify(cialo) };
  };
  return { wywolania, fetchImpl };
}

const KANAL = 'allegro_szkicownia';

const klientZ = (cialo, opcje) => {
  const s = szpieg(cialo, opcje);
  const konta = {
    [KANAL]: {
      pobierzSledzenie: async (carrierId, waybill) => {
        s.wywolania.push({ carrierId, waybill, kanal: KANAL });
        return cialo;
      },
    },
  };
  return {
    ...s,
    klient: createAllegroSledzenieClient({ allegroDla: (kanal) => konta[kanal] ?? null }),
  };
};

describe('klient sledzenia Allegro', () => {
  it('oddaje NAJNOWSZE zdarzenie z opisem, czasem i kodem', async () => {
    const { klient } = klientZ({
      waybills: [{
        waybill: 'A005DUH6H5',
        trackingDetails: {
          statuses: [
            zdarzenie('2026-08-18T09:14:06.705Z', 'PENDING', 'Przesyłka przygotowana przez nadawcę'),
            zdarzenie('2026-08-21T04:50:56.734Z', 'DELIVERED', 'Przesyłka została doręczona'),
          ],
        },
      }],
    });

    const w = await klient.statusPrzesylki('A005DUH6H5', { carrier: 'ALLEGRO', kanal: KANAL });

    expect(w).toEqual({
      opis: 'Przesyłka została doręczona',
      at: '2026-08-21T04:50:56.734Z',
      kod: 'DELIVERED',
      historia: [
        zdarzenie('2026-08-18T09:14:06.705Z', 'PENDING', 'Przesyłka przygotowana przez nadawcę'),
        zdarzenie('2026-08-21T04:50:56.734Z', 'DELIVERED', 'Przesyłka została doręczona'),
      ],
    });
  });

  // ⚠️ Kolejnosc w tablicy NIE JEST gwarancja chronologii. Sonda 25.08 pokazala pary zdarzen
  // z IDENTYCZNYM `occurredAt` („Dispatched from sorting center" i „accepted at the sorting
  // center" o 00:48:01) — czyli Allegro sortuje po czyms innym niz sam czas. Branie ostatniego
  // elementu dzialaloby na zmierzonych danych i przekłamywalo przy pierwszej zmianie kolejnosci.
  it('najnowsze liczy sie po occurredAt, nie po pozycji w tablicy', async () => {
    const { klient } = klientZ({
      waybills: [{
        waybill: 'X',
        trackingDetails: {
          statuses: [
            zdarzenie('2026-08-21T04:50:00.000Z', 'DELIVERED', 'Przesyłka została doręczona'),
            zdarzenie('2026-08-18T09:14:00.000Z', 'PENDING', 'Przesyłka przygotowana przez nadawcę'),
          ],
        },
      }],
    });

    const w = await klient.statusPrzesylki('X', { carrier: 'ALLEGRO', kanal: KANAL });

    expect(w.kod).toBe('DELIVERED');
    expect(w.at).toBe('2026-08-21T04:50:00.000Z');
  });

  // ⚠️⚠️ TO NIE JEST AWARIA. Zmierzone 25.08 na wszystkich 74 identyfikatorach z
  // `GET /order/carriers`: zly przewoznik oddaje HTTP 200 z `trackingDetails: null`, a nie
  // blad. Gdyby to udawalo awarie, kazdy przebieg czuwacza dopisywalby „status niedostepny"
  // przy paczce, ktorej dany przewoznik po prostu nie zna — i odznaka wisialaby wiecznie.
  it('trackingDetails = null oddaje null, a NIE blad', async () => {
    const { klient } = klientZ({ waybills: [{ waybill: 'X', trackingDetails: null }] });
    await expect(klient.statusPrzesylki('X', { carrier: 'DPD', kanal: KANAL })).resolves.toBe(null);
  });

  it('pusta historia i brak numeru w odpowiedzi tez oddaja null', async () => {
    const pusta = klientZ({ waybills: [{ waybill: 'X', trackingDetails: { statuses: [] } }] });
    await expect(pusta.klient.statusPrzesylki('X', { carrier: 'ALLEGRO', kanal: KANAL })).resolves.toBe(null);

    const obcy = klientZ({ waybills: [{ waybill: 'INNY', trackingDetails: { statuses: [zdarzenie('2026-08-21T04:50:00.000Z', 'DELIVERED', 'd')] } }] });
    await expect(obcy.klient.statusPrzesylki('X', { carrier: 'ALLEGRO', kanal: KANAL })).resolves.toBe(null);
  });

  // ⚠️ BEZ `carrier` NIE PYTAMY. Podstawienie stalej 'ALLEGRO' dzialaloby na dzisiejszych
  // danych (wszystkie zmierzone paczki maja wlasnie ten identyfikator) i cicho pytaloby
  // zlego przewoznika, gdy Allegro odda inny — a wtedy odpowiedzia jest `trackingDetails:
  // null`, czyli „brak zdarzen", nieodroznialne od paczki swiezo nadanej.
  it('brak carrierId to odmowa pytania, nie zgadywanie', async () => {
    const { klient, wywolania } = klientZ({ waybills: [] });
    // ⚠️ KANAL MUSI BYC POPRAWNY, inaczej ten test niczego nie mierzy. Pierwsza wersja
    // wolala `statusPrzesylki('X', {})` — bez carrierId ORAZ bez kanalu — wiec przechodzila
    // TAKZE ze skasowanym warunkiem na carrier: zatrzymywal ja dopiero guard na kanale.
    // Mutacja („klient pyta bez przewoznika") PRZEZYLA i pokazala to wprost.
    await expect(klient.statusPrzesylki('X', { kanal: KANAL })).resolves.toBe(null);
    await expect(klient.statusPrzesylki('X', { carrier: '  ', kanal: KANAL })).resolves.toBe(null);
    await expect(klient.statusPrzesylki('X')).resolves.toBe(null);
    expect(wywolania).toHaveLength(0);
  });

  it('pyta dokladnie tym carrierId i numerem, ktore dostal', async () => {
    const { klient, wywolania } = klientZ({ waybills: [{ waybill: 'AD0X', trackingDetails: null }] });
    await klient.statusPrzesylki('AD0X', { carrier: 'ALLEGRO', kanal: KANAL });
    expect(wywolania).toEqual([{ carrierId: 'ALLEGRO', waybill: 'AD0X', kanal: KANAL }]);
  });

  // ⚠️⚠️ KONTO WYBIERA KANAL ZAMOWIENIA, NIE „PIERWSZE Z BRZEGU". Kanaly to OSOBNE konta
  // Allegro (dzis `allegro_szkicownia` i `allegro_amarka`), a zasob sledzenia widzi
  // wylacznie przesylki wlasnego konta. Pierwsza wersja tej zmiany brala
  // `Object.values(klienciKanalow)[0]` — dzialaloby dla jednego kanalu i MILCZALO dla
  // drugiego, a milczenie ma tu ksztalt `trackingDetails: null`, czyli jest nieodroznialne
  // od paczki swiezo nadanej. Zadna lampka by sie nie zapalila.
  it('kanal bez podpietego konta to null — i zadnego pytania nie idzie', async () => {
    const { klient, wywolania } = klientZ({ waybills: [] });
    await expect(klient.statusPrzesylki('X', { carrier: 'ALLEGRO', kanal: 'allegro_amarka' })).resolves.toBe(null);
    expect(wywolania).toHaveLength(0);
  });

  // ⚠️⚠️ TA ASERCJA BYLA WCZESNIEJ ODWROTNA — i to ona przepuscila usterke z 31.08.2026.
  // Plik zapisywal „brak kanalu → null" jako zachowanie POPRAWNE, wiec gdy czuwacz
  // przesylek zaczal wolac klienta z atrapa zamowienia `{ id }` (bez `sklep`), suita
  // byla zielona, a zegar przez szesc dni „pytal" o trzy DORECZONE paczki wiszace
  // w zakladce jako „bez ruchu": zapisu nie bylo, bledu nie bylo, znacznik proby rosl.
  //
  // Kanal PODANY, ale nieznany, zostaje cichym `null` (kanal odlaczony — stan poprawny).
  // Kanalu NIE PODANO znaczy „wolajacy nie wie, o ktore konto pytac", czyli usterka
  // po NASZEJ stronie — a te maja padac glosno, nie milczec.
  it('brak kanalu RZUCA — cichy null uciszalby wlasna usterke wolajacego', async () => {
    const { klient, wywolania } = klientZ({ waybills: [] });
    await expect(klient.statusPrzesylki('X', { carrier: 'ALLEGRO' })).rejects.toThrow(/BEZ KANAŁU/);
    await expect(klient.statusPrzesylki('X', { carrier: 'ALLEGRO', kanal: null })).rejects.toThrow(/BEZ KANAŁU/);
    expect(wywolania).toHaveLength(0);
  });

  // ⚠️ FLAGI `bezSledzenia` TU BYC NIE MOZE — i to jest cala roznica wobec allegro-wza.js.
  // Ten klient sledzenie MA. Gdyby flaga sie tu zabłąkała, `sledzeniePrzesylki` oddawaloby
  // `null` i caly kanal zamilkłby po cichu, dokladnie tak jak przed ta zmiana.
  it('nie deklaruje braku sledzenia', () => {
    const { klient } = klientZ({ waybills: [] });
    expect(klient.bezSledzenia).toBeFalsy();
  });
});
