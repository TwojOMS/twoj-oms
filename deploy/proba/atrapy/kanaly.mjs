// PRZ-076 — atrapy klientów sklepu Woo i kont Allegro dla piaskownicy oms-proba. Te same nazwy metod co
// src/oms/woo/client.js i src/oms/allegro/client.js (komplet pilnuje tests/instalacja/atrapy-kontrakt.test.js).
// Scalane z usługami modułu kanałów: widzą je magazyn, zamówienia, wysyłka, wiadomości i faktury.
//
// Trzy rodzaje metod:
//   • KATALOG — z scripts/demo-dane-katalog.mjs (to samo, z czego generator zbudował lustro magazynu) plus zmiany
//     zapisane z panelu (tabela atrapa_kanaly_zmiany), więc „Synchronizuj” po zapisie SKU niczego nie cofa;
//   • ODBICIE BAZY — wątki, wiadomości, przesyłki, śledzenie, stan realizacji: atrapa oddaje to, co już jest
//     w bazie demo, więc pollery i czuwacze widzą „bez zmian” i nie nadpisują danych demo;
//     podjazdy (PRZ-160 P4.02): propozycje, zlecenie i jego stan w tabeli atrapa_allegro_podjazdy;
//   • OFERTY E3 (PRZ-160.E3.15) — wystawianie ofert: prawdziwy klient Allegro na surowym serwerze ./allegro-oferty.mjs;
//   • ODMOWA — operacje, których demo nie ma czym udawać (pollery zamówień, załączniki):
//     czytelny błąd 4xx zamiast „not a function”; 4xx, bo usługi zwalniają wtedy rezerwacje jak po odmowie API.
import { randomUUID } from 'node:crypto';
import { setTimeout as odczekaj } from 'node:timers/promises';
import { listaNaZadanie, mapaNaZadanie } from '../../../src/moduly/kanaly/kolekcje-na-zadanie.ts';
import PDFDocument from 'pdfkit';
import { METODY_WZA } from '../../../src/domena/allegro-wysylka.js';
import { stanyKanalowZKolizjami } from '../../../src/domena/kanal-stan.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { KANALY, USTAWIENIA_WOO_DEMO } from '../../../scripts/demo-dane-firma.mjs';
import {
  katalogWoo,
  ofertyAllegro,
  kategoriaAllegroDemo,
  parametryKategoriiAllegroDemo,
} from '../../../scripts/demo-dane-katalog.mjs';
import { wymagajTrybuProby } from './tryb.mjs';
import { createSerwerOfertAllegro, createOfertyAllegro } from './allegro-oferty.mjs';
import { WYMAGANE_UPRAWNIENIA, UPRAWNIENIA_OFERT } from '../../../src/domena/uprawnienia-kanalu.js';
import { wczytajTokeny, zapiszTokeny } from '../../../src/oms/db/tokeny.js';
import { idProduktuWoo, pozycjeCenWoo, statusProduktuWoo } from '../../../src/oms/woo/client.js';
import { bladTylkoOdczyt } from '../../../src/domena/woo-uprawnienia.js';

const SCHEMAT = `
  CREATE TABLE IF NOT EXISTS atrapa_kanaly_zmiany (kanal TEXT NOT NULL, sciezka TEXT NOT NULL, pola_json TEXT NOT NULL,
    PRIMARY KEY (kanal, sciezka));
  CREATE TABLE IF NOT EXISTS atrapa_allegro_faktury (kanal TEXT NOT NULL, zamowienie TEXT NOT NULL, id TEXT PRIMARY KEY,
    dane_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS atrapa_allegro_realizacja (kanal TEXT NOT NULL, zamowienie TEXT NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (kanal, zamowienie));
  CREATE TABLE IF NOT EXISTS atrapa_allegro_przesylki (kanal TEXT NOT NULL, command_id TEXT NOT NULL,
    shipment_id TEXT NOT NULL UNIQUE, dane_json TEXT NOT NULL, PRIMARY KEY (kanal, command_id));
  CREATE TABLE IF NOT EXISTS atrapa_allegro_podjazdy (kanal TEXT NOT NULL, command_id TEXT NOT NULL,
    pickup_id TEXT NOT NULL UNIQUE, dane_json TEXT NOT NULL, PRIMARY KEY (kanal, command_id));`;

export const ODMOWY_WOO = ['pobierzZamowienia', 'pobierzZamowieniaZakresu'];
// PRZ-160.E3.15: metody wystawiania ofert (E3.03) nie są już odmowami — obsługuje je ./allegro-oferty.mjs.
export const ODMOWY_ALLEGRO = ['pobierzZamowienia', 'deklarujZalacznikWiadomosci', 'wgrajZalacznikWiadomosci'];

// Transport zasobu WzA jak w Allegro (pomiar 13.11.2026 dla One; DPD — pomiar 23.09.2026). Usługi spoza
// mapy nie mają podjazdu w piaskownicy (pickupAvailable: false).
const TRANSPORT_WZA = {
  '03f26351-f683-4db2-8895-f2c599280e3c': 'DPD',
  '0d83955a-4297-4169-adef-9790d53b11ff': 'ALLEGRO_ONE_KURIER',
  '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483': 'ALLEGRO_ONE_KURIER',
};
const zTransportem = (p) =>
  TRANSPORT_WZA[p.deliveryMethodId]
    ? { ...p, transport: [TRANSPORT_WZA[p.deliveryMethodId]], pickupAvailable: true }
    : { ...p, pickupAvailable: false };

function odmowa(gdzie, metoda) {
  return async () => {
    throw bladOperatora(
      `Piaskownica: atrapa ${gdzie} nie obsługuje „${metoda}” — ta operacja działa tylko z prawdziwym ` +
        `kontem. Nic nie zostało wysłane.`,
      { status: 400 },
    );
  };
}

function sciezkaProduktu(sciezka) {
  const m = /^products\/(\d+)(?:\/variations\/(\d+))?$/.exec(String(sciezka ?? ''));
  if (!m) throw bladOperatora(`Sklep: niepoprawna ścieżka produktu „${sciezka}”`, { status: 400 });
  return { produkt: m[1], wariant: m[2] ?? null };
}

// PRZ-160.P3b.01: kategorie sklepu poza katalogiem produktów — nazwa z encją HTML (tak oddaje ją WooCommerce)
// i kategoria bez produktów (OMS jej nie dopisuje). Zmyślone.
const KATEGORIE_WOO_DODATKOWE = Object.freeze([
  { id: 9801, name: 'Klosze &amp; abażury', slug: 'klosze-abazury', parent: 0, count: 2 },
  { id: 9802, name: 'Wyprzedaż sezonowa', slug: 'wyprzedaz-sezonowa', parent: 0, count: 0 },
]);

/** Kategorie `GET /products/categories`: te z produktów katalogu (count = liczba produktów) i dodatkowe. */
function kategorieWoo(produkty) {
  const wg = new Map();
  for (const p of produkty) {
    for (const k of p.categories ?? []) {
      const obecna = wg.get(k.id) ?? { id: k.id, name: k.name, slug: k.slug, parent: 0, count: 0 };
      obecna.count += 1;
      wg.set(k.id, obecna);
    }
  }
  return [...wg.values(), ...KATEGORIE_WOO_DODATKOWE.map((k) => ({ ...k }))].sort((a, b) => a.id - b.id);
}

/** Atrapa klienta Woo (createWooClient) jednego sklepu. */
export function createAtrapaWoo({
  db,
  kanal,
  log = (...t) => console.log(...t),
  env = process.env,
  uprawnienia = 'zapis',
}) {
  wymagajTrybuProby(env, 'atrapa sklepu Woo');
  const tylkoOdczyt = uprawnienia === 'odczyt';
  const wolnyKatalog = env.ATRAPA_WOO_WOLNY_KATALOG === 'tak';
  db.exec(SCHEMAT);
  const ślad = (t) => log(`atrapa sklepu ${kanal}: ${t} (piaskownica — nic nie poszło do sklepu)`);
  const zmiany = () =>
    new Map(
      db
        .prepare('SELECT sciezka, pola_json FROM atrapa_kanaly_zmiany WHERE kanal = ?')
        .all(kanal)
        .map((w) => [w.sciezka, JSON.parse(w.pola_json)]),
    );
  const katalog = () => {
    const k = katalogWoo(kanal);
    const z = zmiany();
    const produkty = k.produkty.map((p) => ({ ...p, ...(z.get(`products/${p.id}`) ?? {}) }));
    const warianty = new Map(
      [...k.warianty].map(([id, lista]) => [
        id,
        lista.map((w) => ({ ...w, ...(z.get(`products/${id}/variations/${w.id}`) ?? {}) })),
      ]),
    );
    return { ...k, produkty, warianty };
  };
  const znajdz = (sciezka) => {
    const { produkt, wariant } = sciezkaProduktu(sciezka);
    const k = katalog();
    const p = k.produkty.find((x) => String(x.id) === produkt);
    const w = wariant ? k.warianty.get(produkt)?.find((x) => String(x.id) === wariant) : p;
    if (!p || !w) throw bladOperatora(`Sklep odrzucił zapytanie (404): nie ma ${sciezka}`, { status: 404 });
    return w;
  };
  const zapisz = (sciezka, pola) => {
    const obecny = znajdz(sciezka);
    const poprzednie = zmiany().get(String(sciezka)) ?? {};
    db.prepare(
      `INSERT INTO atrapa_kanaly_zmiany (kanal, sciezka, pola_json) VALUES (?,?,?)
      ON CONFLICT(kanal, sciezka) DO UPDATE SET pola_json = excluded.pola_json`,
    ).run(kanal, String(sciezka), JSON.stringify({ ...poprzednie, ...pola }));
    ślad(`zapisano ${sciezka}: ${Object.keys(pola).join(', ')}`);
    return { ...obecny, ...pola };
  };
  const zapiszStan = (sciezka, stock_quantity) => {
    const wynik = zapisz(sciezka, { stock_quantity });
    const liczba = (zmiany().get('stany/licznik')?.liczba ?? 0) + 1;
    db.prepare(
      `INSERT INTO atrapa_kanaly_zmiany (kanal, sciezka, pola_json) VALUES (?, 'stany/licznik', ?)
      ON CONFLICT(kanal, sciezka) DO UPDATE SET pola_json = excluded.pola_json`,
    ).run(kanal, JSON.stringify({ liczba }));
    return wynik;
  };
  // W3: pomocnicza symulacja zdjęcia/zwrotu stanu. Id wariantu jest globalnie unikalne w Woo.
  const zmienPoZakupie = async (id, n, znak) => {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Niepoprawna ilość zakupu Woo');
    const k = katalog();
    let sciezka = `products/${id}`;
    for (const [rodzic, warianty] of k.warianty) {
      const wariant = warianty.find((w) => String(w.id) === String(id));
      if (wariant) {
        sciezka = wariant.manage_stock === 'parent' ? `products/${rodzic}` : `products/${rodzic}/variations/${id}`;
        break;
      }
    }
    const p = znajdz(sciezka);
    return p.manage_stock === true ? zapiszStan(sciezka, p.stock_quantity + znak * n) : structuredClone(p);
  };
  return {
    ...Object.fromEntries(ODMOWY_WOO.map((m) => [m, odmowa(`sklepu ${kanal}`, m)])),
    sprawdzPolaczenie: async () => ({ ok: true }),
    pobierzMetodyWysylki: async () => [],
    pobierzBramkiPlatnosci: async () => [
      { id: 'cod', tytul: 'Płatność przy odbiorze', nazwaWoo: 'Pobranie', wlaczona: true },
      { id: 'bacs', tytul: 'Przelew bankowy', nazwaWoo: 'Przelew', wlaczona: true },
    ],
    // Jak prawdziwy klient (`status=publish`): szkic w tym odczycie nie przychodzi.
    pobierzWszystkieProdukty: async (naStronie) => {
      const produkty = structuredClone(katalog().produkty.filter((p) => p.status === 'publish'));
      const stron = wolnyKatalog ? Math.max(1, Math.ceil(produkty.length / 10)) : 1;
      for (let strona = 1; strona <= stron; strona += 1) {
        if (wolnyKatalog) await odczekaj(1200);
        naStronie?.({ strona, stron });
      }
      return produkty;
    },
    pobierzWarianty: async (id) => structuredClone(katalog().warianty.get(String(id)) ?? []),
    pobierzKategorieProduktow: async () => kategorieWoo(katalog().produkty),
    // Store API widzi tylko produkty opublikowane, więc szkic nie ma miniatury.
    pobierzMiniatury: async () => {
      const k = katalog();
      const opublikowane = new Set(k.produkty.filter((p) => p.status === 'publish').map((p) => String(p.id)));
      return new Map([...k.miniatury].filter(([id]) => opublikowane.has(String(id))));
    },
    async pobierzProduktyPowiazane(ids) {
      const szukane = new Set(ids.map(idProduktuWoo));
      return structuredClone(katalog().produkty.filter((p) => p.status === 'draft' && szukane.has(String(p.id))));
    },
    ustawienieSklepu: async (id) => USTAWIENIA_WOO_DEMO[id] ?? '',
    pobierzProdukt: async (sciezka) => structuredClone(znajdz(sciezka)),
    pobierzStany: async (ids) =>
      structuredClone(katalog().produkty.filter((p) => ids.map(String).includes(String(p.id)))),
    pobierzStanyWariantow: async (rodzicId, ids) =>
      structuredClone(
        (katalog().warianty.get(String(rodzicId)) ?? []).filter((p) => ids.map(String).includes(String(p.id))),
      ),
    async zapiszStanyHurtem(rodzicId, pozycje) {
      // Cała lista przed pierwszym zapisem, identyczna granica pól jak w kliencie.
      for (const p of pozycje) {
        if (!p || Object.keys(p).some((k) => !['id', 'stock_quantity'].includes(k)))
          throw new Error('Niedozwolone pole zapisu stanu Woo');
        if (!Number.isSafeInteger(p.stock_quantity) || p.stock_quantity < 0)
          throw new Error('Niepoprawna ilość stanu Woo');
      }
      return pozycje.map((p) => {
        try {
          const sciezka = rodzicId === null ? `products/${p.id}` : `products/${rodzicId}/variations/${p.id}`;
          // Jak Woo: gdy cel nie liczy stanu (false/parent), ilość jest pomijana, a zapis i tak „udany”.
          if (znajdz(sciezka).manage_stock === true) zapiszStan(sciezka, p.stock_quantity);
          return { id: p.id, ok: true };
        } catch (e) {
          return { id: p.id, ok: false, blad: e.message };
        }
      });
    },
    // Te same granice co klient (wspólne funkcje), sprawdzone na całej liście przed pierwszym zapisem.
    async zapiszCenyHurtem(rodzicId, pozycje) {
      if (tylkoOdczyt) throw bladTylkoOdczyt();
      const rodzic = rodzicId === null ? null : idProduktuWoo(rodzicId);
      return pozycjeCenWoo(pozycje).map(({ id, regular_price }) => {
        try {
          const sciezka = rodzic === null ? `products/${id}` : `products/${rodzic}/variations/${id}`;
          // Jak Woo: `price` idzie za ceną regularną, chyba że trwa promocja — wtedy zostaje promocyjna.
          const promocja = znajdz(sciezka).sale_price;
          const zapisany = zapisz(sciezka, promocja ? { regular_price } : { regular_price, price: regular_price });
          return { id, ok: true, cena: zapisany.price };
        } catch (e) {
          return { id, ok: false, blad: e.message };
        }
      });
    },
    async ustawStatusProduktu(id, status) {
      if (tylkoOdczyt) throw bladTylkoOdczyt();
      const s = statusProduktuWoo(status);
      return structuredClone(zapisz(`products/${idProduktuWoo(id)}`, { status: s }));
    },
    kup: (id, n) => zmienPoZakupie(id, n, -1),
    oddaj: (id, n) => zmienPoZakupie(id, n, 1),
    async zapiszProdukt(sciezka, pola) {
      return zapisz(sciezka, pola ?? {});
    },
    async dodajNotatke(id, tresc) {
      ślad(`notatka do zamówienia ${id}: ${String(tresc).slice(0, 80)}`);
      return { id: Date.now(), note: tresc, customer_note: false, date_created_gmt: new Date().toISOString() };
    },
    async ustawStatus(id, status) {
      ślad(`status zamówienia ${id} → ${status}`);
      return { id: Number(id), status };
    },
    tylkoOdczyt,
    atrapa: true,
  };
}

/** Atrapa klienta Allegro (createAllegroClient) jednego konta. */
export function createAtrapaAllegro({
  db,
  kanal,
  log = (...t) => console.log(...t),
  env = process.env,
  teraz = () => new Date(),
}) {
  wymagajTrybuProby(env, 'atrapa Allegro');
  db.exec(SCHEMAT);
  const serwerOfert = createSerwerOfertAllegro({ db, kanal, env, teraz });
  const ślad = (t) => log(`atrapa Allegro ${kanal}: ${t} (piaskownica — nic nie poszło do Allegro)`);
  const zamowienie = (zrodloId) =>
    db.prepare('SELECT * FROM zamowienia WHERE sklep = ? AND zrodlo_id = ?').get(kanal, String(zrodloId));
  const metodaDostawy = (id) => {
    const z = zamowienie(id);
    // Za pobraniem: METODY_WZA nie zna DHL z pobraniem, więc kurier DHL i DPD idą wtedy DPD pobranie.
    const nazwa =
      z?.pobranie && ['allegro_dpd', 'allegro_kurier'].includes(z?.metoda_wysylki)
        ? 'Allegro Kurier DPD pobranie (AD)'
        : {
            allegro_dpd: 'Allegro Kurier DPD (AD)',
            allegro_punkt: 'Allegro One Box, One Kurier',
            allegro_kurier: 'Allegro Kurier DHL (AD)',
          }[z?.metoda_wysylki];
    return Object.entries(METODY_WZA).find(([, m]) => m.nazwa === nazwa)?.[0] ?? null;
  };
  const znajdzPrzesylke = (pole, id) => {
    const w = db
      .prepare(`SELECT * FROM atrapa_allegro_przesylki WHERE kanal = ? AND ${pole} = ?`)
      .get(kanal, String(id));
    if (!w) throw bladOperatora('Piaskownica: nie ma takiej przesyłki Allegro.', { status: 404 });
    return w;
  };
  const stanKomendy = (w) => ({ commandId: w.command_id, status: 'SUCCESS', errors: null, shipmentId: w.shipment_id });
  // Zasób WzA: przesyłka nadana w piaskownicy albo paczka WzA zapisana w bazie demo (odbicie bazy).
  const przesylkaWza = (id) => {
    const w = db
      .prepare('SELECT dane_json FROM atrapa_allegro_przesylki WHERE kanal = ? AND shipment_id = ?')
      .get(kanal, String(id));
    if (w) return zTransportem(JSON.parse(w.dane_json));
    const p = db
      .prepare(
        `SELECT p.numer_listu, z.zrodlo_id FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
      WHERE z.sklep = ? AND p.kurier = 'allegro_wza' AND p.id_przesylki_kuriera = ?`,
      )
      .get(kanal, String(id));
    if (!p) throw bladOperatora('Piaskownica: nie ma takiej przesyłki Allegro.', { status: 404 });
    return zTransportem({
      id: String(id),
      carrier: 'ALLEGRO',
      deliveryMethodId: metodaDostawy(p.zrodlo_id),
      labelFormat: 'PDF',
      packages: [{ waybill: p.numer_listu }],
    });
  };
  const podjazd = (pole, id) => {
    const w = db
      .prepare(`SELECT * FROM atrapa_allegro_podjazdy WHERE kanal = ? AND ${pole} = ?`)
      .get(kanal, String(id));
    if (!w) throw bladOperatora('Piaskownica: nie ma takiego podjazdu Allegro.', { status: 404 });
    return { ...w, dane: JSON.parse(w.dane_json) };
  };
  const fakturyZamowienia = (zrodloId) =>
    db
      .prepare('SELECT dane_json FROM atrapa_allegro_faktury WHERE kanal = ? AND zamowienie = ?')
      .all(kanal, String(zrodloId))
      .map((w) => JSON.parse(w.dane_json));
  const zapiszFakture = (zrodloId, wpis) =>
    db
      .prepare(
        `INSERT INTO atrapa_allegro_faktury (kanal, zamowienie, id, dane_json) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET dane_json = excluded.dane_json`,
      )
      .run(kanal, String(zrodloId), wpis.id, JSON.stringify(wpis));

  const nieMa = (co, id) => {
    throw bladOperatora(`Piaskownica: Allegro ${kanal} nie ma ${co} ${id}.`, { status: 404 });
  };
  return {
    ...Object.fromEntries(ODMOWY_ALLEGRO.map((m) => [m, odmowa(`Allegro ${kanal}`, m)])),
    ...createOfertyAllegro({ serwer: serwerOfert }),
    pobierzMojeKonto: async () => ({ id: kanal === 'allegro' ? '100001' : '100002', login: `atrapa-${kanal}` }),
    sprawdzZakresZamowien: async () =>
      Number(db.prepare('SELECT count(*) AS n FROM zamowienia WHERE sklep=?').get(kanal).n),
    pobierzOferty: async () => ofertyAllegro(kanal),
    // PRZ-160.04a — odczyt treści oferty i opisu kategorii (tylko GET); obce id = 404 jak w Allegro.
    // PRZ-160.E3.15: najpierw oferta zapisana w atrapie ofert (wystawiona lub zmieniona z panelu), potem katalog.
    pobierzOferte: async (id) => serwerOfert.oferta(id) ?? nieMa('oferty', id),
    pobierzKategorie: async (id) => kategoriaAllegroDemo(id) ?? nieMa('kategorii', id),
    pobierzParametryKategorii: async (id) => parametryKategoriiAllegroDemo(id) ?? nieMa('kategorii', id),
    pobierzMetodeDostawy: async (id) => metodaDostawy(id),
    async pobierzPropozycjeWysylki(id) {
      const z = zamowienie(id);
      if (!z || !metodaDostawy(id))
        throw bladOperatora('Piaskownica: nieznana usługa dostawy Allegro.', { status: 400 });
      const adres = JSON.parse(z.dostawa_json);
      const klient = JSON.parse(z.klient_json);
      return {
        suggestedInput: {
          deliveryMethodId: null,
          sender: {
            name: 'Pracownia Półcień',
            street: 'Przykładowa 1',
            postalCode: '00-001',
            city: 'Warszawa',
            countryCode: 'PL',
            email: 'nadawca@example.test',
            phone: '+48500100200',
          },
          receiver: {
            name: `${adres.first_name ?? ''} ${adres.last_name ?? ''}`.trim(),
            street: adres.address_1,
            postalCode: adres.postcode,
            city: adres.city,
            countryCode: adres.country ?? 'PL',
            email: klient.email,
            phone: klient.phone,
            ...(z.punkt_odbioru ? { point: z.punkt_odbioru } : {}),
          },
          cashOnDelivery: z.pobranie ? { amount: z.kwota_pobrania, currency: 'PLN' } : null,
        },
        deliveryOptions: [
          {
            packageType: 'PACKAGE',
            limits: {
              dimensions: {
                length: { value: 200, unit: 'CENTIMETER' },
                width: { value: 200, unit: 'CENTIMETER' },
                height: { value: 200, unit: 'CENTIMETER' },
              },
              weight: { value: 31.5, unit: 'KILOGRAMS' },
              cashOnDelivery: { amount: '6000.00', currency: 'PLN' },
            },
          },
        ],
      };
    },
    async utworzPrzesylke({ commandId, input } = {}) {
      if (!commandId) throw new Error('Allegro: brak commandId (klucz idempotencji).');
      if (!input?.deliveryMethodId) throw new Error('Allegro: brak deliveryMethodId.');
      const shipmentId = `atrapa-${randomUUID()}`;
      const p = {
        ...structuredClone(input),
        id: shipmentId,
        carrier: 'ALLEGRO',
        labelFormat: input.labelFormat === 'ZPL' ? 'ZPL' : 'PDF',
        packages: (input.packages?.length ? input.packages : [{}]).map((p, i) => ({
          ...p,
          waybill: `ATRAPA-${shipmentId.slice(7)}-${i + 1}`,
        })),
      };
      const wynik = db
        .prepare(
          `INSERT OR IGNORE INTO atrapa_allegro_przesylki (kanal, command_id, shipment_id, dane_json) VALUES (?,?,?,?)`,
        )
        .run(kanal, String(commandId), shipmentId, JSON.stringify(p));
      const stan = stanKomendy(znajdzPrzesylke('command_id', commandId));
      if (wynik.changes) ślad(`utworzono przesyłkę ${stan.shipmentId}`);
      return stan;
    },
    stanTworzeniaPrzesylki: async (id) => stanKomendy(znajdzPrzesylke('command_id', id)),
    pobierzPrzesylkeWza: async (id) => przesylkaWza(id),
    async pobierzEtykieteWza(ids, format = 'PDF') {
      if (!Array.isArray(ids) || !ids.length) throw new Error('Allegro: brak przesyłek do etykiety.');
      const paczki = ids.map(przesylkaWza);
      if (format === 'ZPL')
        return Buffer.from(
          paczki
            .map((p) => `^XA^FO40,40^A0N,60,60^FDATRAPA^FS^FO40,120^A0N,25,25^FD${p.packages[0].waybill}^FS^XZ`)
            .join('\n'),
        );
      if (format !== 'PDF') throw new Error('Allegro: nieobsługiwany format etykiety.');
      const doc = new PDFDocument({
        size: 'A4',
        autoFirstPage: false,
        compress: false,
        info: { Title: 'Allegro WzA - piaskownica' },
      });
      const czesci = [];
      const wynik = new Promise((resolve, reject) => {
        doc.on('data', (c) => czesci.push(c));
        doc.on('end', () => resolve(Buffer.concat(czesci)));
        doc.on('error', reject);
      });
      for (const p of paczki) {
        doc.addPage().fillColor('#B42318').fontSize(40).text('ATRAPA');
        doc.fillColor('#111111').fontSize(14).text('Allegro WzA - piaskownica');
        for (const paczka of p.packages) doc.moveDown().text(paczka.waybill);
      }
      doc.end();
      ślad(`pobrano etykiety ${ids.join(', ')}`);
      return wynik;
    },

    // PRZ-160 P4.02 — podjazdy w piaskownicy. DPD podaje okno godzin, One puste `pickupTimes` (OMS zleca wtedy samą
    // datę). Adres wraca bez zmian, jak w Allegro przy poprawnym zapytaniu. Nic nie wychodzi poza bazę piaskownicy.
    async pobierzPropozycjePodjazdu({ shipmentIds, readyDate, address } = {}) {
      if (!Array.isArray(shipmentIds) || !shipmentIds.length)
        throw bladOperatora('Piaskownica: brak przesyłek podjazdu.', { status: 400 });
      const proposals = shipmentIds.map((shipmentId) => {
        const p = przesylkaWza(shipmentId);
        return {
          shipmentId,
          pickupTimes: p.transport?.[0] === 'DPD' ? [{ date: readyDate, minTime: '13:00', maxTime: '17:00' }] : [],
        };
      });
      return [{ address: structuredClone(address), proposals }];
    },
    async zlecPodjazd({ commandId, input } = {}) {
      if (!commandId) throw new Error('Allegro: podjazdu nie wolno zlecać bez commandId.');
      if (!input?.shipmentIds?.length || !input?.pickupTime?.date)
        throw bladOperatora('Piaskownica: niepełne zlecenie podjazdu.', { status: 400 });
      const paczki = input.shipmentIds.map(przesylkaWza);
      const pickupId = `atrapa-podjazd-${randomUUID()}`;
      const wynik = db
        .prepare(
          'INSERT OR IGNORE INTO atrapa_allegro_podjazdy (kanal, command_id, pickup_id, dane_json) VALUES (?,?,?,?)',
        )
        .run(
          kanal,
          String(commandId),
          pickupId,
          JSON.stringify({ ...structuredClone(input), pickupCarrier: paczki[0].transport?.[0] ?? null }),
        );
      if (wynik.changes)
        ślad(`przyjęto podjazd ${pickupId} (${input.shipmentIds.length} paczek, ${input.pickupTime.date})`);
      return { commandId, status: 'IN_PROGRESS' };
    },
    async stanZleceniaPodjazdu(commandId) {
      const w = podjazd('command_id', commandId);
      return { commandId: w.command_id, status: 'SUCCESS', pickupId: w.pickup_id, errors: [] };
    },
    async pobierzPodjazd(pickupId) {
      const w = podjazd('pickup_id', pickupId);
      return {
        id: w.pickup_id,
        shipmentIds: w.dane.shipmentIds,
        pickupTime: w.dane.pickupTime,
        address: w.dane.address,
        pickupCarrier: w.dane.pickupCarrier,
        carrierPickupId: `ATRAPA-${w.pickup_id.slice(-8)}`,
      };
    },

    async pobierzPrzesylki(idZamowienia) {
      const z = zamowienie(idZamowienia);
      if (!z) return [];
      return db
        .prepare('SELECT numer_listu, kurier FROM przesylki WHERE zamowienie_id = ? AND numer_listu IS NOT NULL')
        .all(z.id)
        .map((p) => ({
          id: `atrapa-${p.numer_listu}`,
          waybill: p.numer_listu,
          carrierId: p.kurier === 'inpost' ? 'INPOST' : p.kurier === 'dpd' ? 'DPD' : 'ALLEGRO',
        }));
    },
    async pobierzSledzenie(carrierId, waybill) {
      const p = db
        .prepare('SELECT status_kuriera, status_kuriera_at, utworzona_at FROM przesylki WHERE numer_listu = ?')
        .get(String(waybill));
      if (!p) return { waybills: [] };
      const statuses = [{ code: 'PENDING', occurredAt: p.utworzona_at, description: 'Przesyłka utworzona (atrapa)' }];
      if (p.status_kuriera) {
        statuses.push({
          code: /doręczona/i.test(p.status_kuriera) ? 'DELIVERED' : 'IN_TRANSIT',
          occurredAt: p.status_kuriera_at,
          description: p.status_kuriera,
        });
      }
      return { waybills: [{ waybill: String(waybill), carrierId, trackingDetails: { statuses } }] };
    },

    async pobierzStanRealizacji(idZamowienia) {
      const zapisany = db
        .prepare('SELECT status FROM atrapa_allegro_realizacja WHERE kanal = ? AND zamowienie = ?')
        .get(kanal, String(idZamowienia));
      if (zapisany) return zapisany.status;
      const z = zamowienie(idZamowienia);
      if (!z)
        throw bladOperatora(`Allegro odrzuciło zapytanie (404): nie ma zamówienia ${idZamowienia}`, { status: 404 });
      return z.wyslane_at ? 'SENT' : z.w_realizacji_at ? 'PROCESSING' : 'NEW';
    },
    async ustawStatusRealizacji(idZamowienia, status) {
      db.prepare(
        `INSERT INTO atrapa_allegro_realizacja (kanal, zamowienie, status) VALUES (?,?,?)
        ON CONFLICT(kanal, zamowienie) DO UPDATE SET status = excluded.status`,
      ).run(kanal, String(idZamowienia), String(status));
      ślad(`status realizacji ${idZamowienia} → ${status}`);
      return null;
    },

    pobierzFakturyZamowienia: async (idZamowienia) => fakturyZamowienia(idZamowienia),
    async zglosFakture(idZamowienia, { nazwaPliku, numerFaktury } = {}) {
      const wpis = {
        id: randomUUID(),
        invoiceNumber: numerFaktury ?? null,
        file: { name: nazwaPliku ?? null, securityVerification: null },
      };
      zapiszFakture(idZamowienia, wpis);
      ślad(`zgłoszono fakturę ${numerFaktury} do zamówienia ${idZamowienia}`);
      return { id: wpis.id };
    },
    async wyslijPlikFaktury(idZamowienia, invoiceId, bajty) {
      const wpis = fakturyZamowienia(idZamowienia).find((w) => w.id === invoiceId);
      if (!wpis)
        throw bladOperatora(`Allegro odrzuciło plik faktury (404): nie ma zgłoszenia ${invoiceId}`, { status: 404 });
      if (!Buffer.isBuffer(bajty) || bajty.subarray(0, 4).toString() !== '%PDF')
        throw bladOperatora('Allegro odrzuciło plik faktury (422): to nie jest PDF', { status: 422 });
      const nowy = {
        ...wpis,
        file: { ...wpis.file, size: bajty.length, securityVerification: { status: 'ACCEPTED' } },
      };
      zapiszFakture(idZamowienia, nowy);
      ślad(`wgrano PDF faktury ${wpis.invoiceNumber} (${bajty.length} B), weryfikacja ACCEPTED`);
      return nowy;
    },

    async pobierzWatki({ offset = 0 } = {}) {
      const wszystkie = db
        .prepare('SELECT * FROM allegro_watki WHERE kanal = ? ORDER BY last_message_date_time DESC')
        .all(kanal);
      return {
        watki: wszystkie.slice(offset, offset + 20).map((t) => ({
          id: t.thread_id,
          lastMessageDateTime: t.last_message_date_time,
          read: Boolean(t.przeczytany),
          interlocutor: { login: t.interlocutor_login },
        })),
        razem: wszystkie.length,
      };
    },
    async pobierzWiadomosci(threadId, { offset = 0 } = {}) {
      const watek = db
        .prepare('SELECT interlocutor_login FROM allegro_watki WHERE kanal = ? AND thread_id = ?')
        .get(kanal, String(threadId));
      const wiadomosci = db
        .prepare('SELECT * FROM allegro_wiadomosci WHERE kanal = ? AND thread_id = ? ORDER BY utworzona_at DESC')
        .all(kanal, String(threadId))
        .slice(offset, offset + 20)
        .map((m) => ({
          id: m.message_id,
          text: m.tresc,
          createdAt: m.utworzona_at,
          type: 'MESSAGE',
          attachments: [],
          author: {
            login: m.od_kupujacego ? (watek?.interlocutor_login ?? null) : 'pracownia-polcien-demo',
            isInterlocutor: Boolean(m.od_kupujacego),
          },
        }));
      return { wiadomosci };
    },
    async wyslijWiadomosc(threadId, tekst, zalaczniki = []) {
      const tresc = String(tekst ?? '');
      if (tresc.trim() === '') throw new Error('Allegro: pusta wiadomość — nie wysyłam.');
      if (zalaczniki.length)
        throw bladOperatora('Piaskownica: atrapa Allegro nie przyjmuje załączników.', { status: 400 });
      ślad(`wiadomość do wątku ${threadId} (${tresc.length} znaków)`);
      return {
        id: `atrapa-${randomUUID()}`,
        text: tresc,
        createdAt: new Date().toISOString(),
        type: 'MESSAGE',
        attachments: [],
        author: { login: 'pracownia-polcien-demo', isInterlocutor: false },
        thread: { id: String(threadId) },
      };
    },
    pobierzSprawy: async () => ({ sprawy: [], razem: 0 }),
    atrapa: true,
  };
}

/**
 * Komplet atrap kanałów demo: klienci dla `nadpisania` (kanaly.klienciSklepow / kanaly.klienciKanalow) i konfiguracja
 * kanałów taka, jaką moduł kanałów zbudowałby z kluczami (bez nich `config.sklepy` jest pusty, a magazyn odmawia kanałów).
 */
export function zbudujAtrapyKanalow({ db, config, log, env = process.env }) {
  wymagajTrybuProby(env, 'atrapy kanałów');
  const sklepy = KANALY.filter((k) => k.typ === 'woo').map((k) => k.klucz);
  const konta = KANALY.filter((k) => k.typ === 'allegro').map((k) => k.klucz);
  // E3.25: główne konto ma zgodę, Outlet pozwala obejrzeć ekran ponownej zgody.
  // Nie nadpisujemy istniejącego tokenu: zmiana zakresów w bazie jest widoczna od razu w obu ekranach.
  for (const kanal of konta)
    if (!wczytajTokeny(db, kanal)) {
      const scope = [...WYMAGANE_UPRAWNIENIA, ...(kanal === 'allegro-outlet' ? [] : UPRAWNIENIA_OFERT)];
      const payload = Buffer.from(JSON.stringify({ user_name: kanal, scope })).toString('base64url');
      zapiszTokeny(db, kanal, {
        accessToken: `atrapa.${payload}.atrapa`,
        refreshToken: 'ATRAPA-REFRESH',
        wygasaAt: '2099-01-01T00:00:00Z',
        refreshWygasaAt: '2099-02-01T00:00:00Z',
      });
    }
  const klienciSklepow = Object.fromEntries(sklepy.map((kanal) => [kanal, createAtrapaWoo({ db, kanal, log, env })]));
  const klienciKanalow = Object.fromEntries(
    konta.map((kanal) => [kanal, createAtrapaAllegro({ db, kanal, log, env })]),
  );
  const adres = 'https://atrapa.example.invalid';
  const configZAtrapami = {
    ...config,
    sklepy: Object.fromEntries(
      sklepy.map((k) => [
        k,
        {
          baseUrl: adres,
          ck: '',
          cs: '',
          mapowanie: { instancje: {}, poPozycji: [] },
          od: null,
          historia: null,
          atrapa: true,
        },
      ]),
    ),
    kanaly: Object.fromEntries(
      konta.map((k) => [
        k,
        {
          clientId: '',
          clientSecret: '',
          api: adres,
          auth: adres,
          userAgent: 'atrapa/1 (+https://atrapa.example.invalid)',
          od: null,
          atrapa: true,
        },
      ]),
    ),
    braki: Object.fromEntries(Object.keys(config?.braki ?? {}).map((k) => [k, []])),
  };
  return { klienciSklepow, klienciKanalow, config: configZAtrapami };
}

/** Atrapy mają pierwszeństwo dla swoich kont; pozostałe połączenia zostają z modułu.
 * Kolekcje są odczytywane na żądanie, także po dodaniu lub odłączeniu konta w panelu.
 */
export function scalUslugiKanalow(s, atrapy, teraz = () => new Date()) {
  const config = s.config,
    definicje = config.definicje,
    kanaly = config.kanaly;
  const klienci = s.klienciKanalow,
    sklepy = config.sklepy,
    klienciSklepow = s.klienciSklepow;
  const braki = config.braki,
    stany = s.stanyKanalow;
  const klucze = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  config.definicje = listaNaZadanie(() => [
    ...new Map([...definicje, ...atrapy.config.definicje].map((d) => [d.klucz, d])).values(),
  ]);
  config.sklepy = mapaNaZadanie(
    () => klucze(atrapy.config.sklepy, sklepy),
    (k) => atrapy.config.sklepy[k] ?? sklepy[k],
  );
  // config.kanaly = ustawienia Allegro (Integracje, łączność) — klienci innych typów (ERLI) zostają tylko w klienciKanalow (recenzja 12b).
  config.kanaly = mapaNaZadanie(
    () => klucze(atrapy.config.kanaly, kanaly),
    (k) => atrapy.config.kanaly[k] ?? kanaly[k],
  );
  config.braki = mapaNaZadanie(
    () => klucze(atrapy.config.braki, braki),
    (k) => atrapy.config.braki[k] ?? braki[k],
  );
  s.klienciKanalow = mapaNaZadanie(
    () => klucze(atrapy.klienciKanalow, klienci),
    (k) => atrapy.klienciKanalow[k] ?? klienci[k],
  );
  s.klienciSklepow = mapaNaZadanie(
    () => klucze(atrapy.klienciSklepow, klienciSklepow),
    (k) => atrapy.klienciSklepow[k] ?? klienciSklepow[k],
  );
  const stanyAtrapy = stanyKanalowAtrapy({ config: atrapy.config, teraz });
  s.stanyKanalow = () => [
    ...stanyAtrapy(),
    ...stany().filter((stan) => !Object.hasOwn(atrapy.klienciKanalow, stan.kanal)),
  ];
  return s;
}

/**
 * PRZ-083 — stany kanałów Allegro dla ekranu Integracje (i pasów na liście). Prawdziwe biorą się z tokenów, których
 * piaskownica nie ma: ekran mówił „Ten panel nie ma skonfigurowanych kanałów Allegro”, choć demo ma Allegro i Outlet.
 * Każdy kanał na OSOBNYM koncie — wspólne konto panel słusznie uznałby za awarię (domena/kanal-stan.js, kolizja).
 */
export function stanyKanalowAtrapy({ config, teraz = () => new Date() }) {
  const DOBA = 86_400_000;
  return () =>
    stanyKanalowZKolizjami(
      Object.keys(config?.kanaly ?? {}).map((kanal, i) => {
        const zostaloDni = 160 - i * 37;
        return {
          kanal,
          polaczony: true,
          zostaloDni,
          kontoAllegro: `pracownia_polcien_${i + 1}`,
          refreshWygasaAt: new Date(teraz().getTime() + zostaloDni * DOBA).toISOString(),
        };
      }),
    );
}
