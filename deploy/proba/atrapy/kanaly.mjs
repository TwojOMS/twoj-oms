// PRZ-076 — atrapy klientów sklepu Woo i kont Allegro dla piaskownicy oms-proba. Te same nazwy metod co
// src/oms/woo/client.js i src/oms/allegro/client.js (komplet pilnuje tests/instalacja/atrapy-kontrakt.test.js).
// Wchodzą globalnie (`nadpisania` w zbudujAplikacje): widzą je magazyn, zamówienia, wysyłka, wiadomości i faktury.
//
// Trzy rodzaje metod:
//   • KATALOG — z scripts/demo-dane-katalog.mjs (to samo, z czego generator zbudował lustro magazynu) plus zmiany
//     zapisane z panelu (tabela atrapa_kanaly_zmiany), więc „Synchronizuj” po zapisie SKU niczego nie cofa;
//   • ODBICIE BAZY — wątki, wiadomości, przesyłki, śledzenie, stan realizacji: atrapa oddaje to, co już jest
//     w bazie demo, więc pollery i czuwacze widzą „bez zmian” i nie nadpisują danych demo;
//   • ODMOWA — operacje, których demo nie ma czym udawać (pollery zamówień, nadanie WzA, podjazdy, załączniki):
//     czytelny błąd 4xx zamiast „not a function”; 4xx, bo usługi zwalniają wtedy rezerwacje jak po odmowie API.
import { randomUUID } from 'node:crypto';
import { stanyKanalowZKolizjami } from '../../../src/domena/kanal-stan.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { KANALY } from '../../../scripts/demo-dane-firma.mjs';
import { katalogWoo, ofertyAllegro } from '../../../scripts/demo-dane-katalog.mjs';
import { wymagajTrybuProby } from './tryb.mjs';

const SCHEMAT = `
  CREATE TABLE IF NOT EXISTS atrapa_kanaly_zmiany (kanal TEXT NOT NULL, sciezka TEXT NOT NULL, pola_json TEXT NOT NULL,
    PRIMARY KEY (kanal, sciezka));
  CREATE TABLE IF NOT EXISTS atrapa_allegro_faktury (kanal TEXT NOT NULL, zamowienie TEXT NOT NULL, id TEXT PRIMARY KEY,
    dane_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS atrapa_allegro_realizacja (kanal TEXT NOT NULL, zamowienie TEXT NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (kanal, zamowienie));`;

export const ODMOWY_WOO = ['pobierzZamowienia', 'pobierzZamowieniaZakresu'];
export const ODMOWY_ALLEGRO = ['pobierzZamowienia', 'pobierzOferte', 'pobierzPropozycjeWysylki', 'utworzPrzesylke',
  'stanTworzeniaPrzesylki', 'pobierzPrzesylkeWza', 'pobierzEtykieteWza', 'pobierzPropozycjePodjazdu', 'zlecPodjazd',
  'stanZleceniaPodjazdu', 'pobierzPodjazd', 'deklarujZalacznikWiadomosci', 'wgrajZalacznikWiadomosci'];

function odmowa(gdzie, metoda) {
  return async () => {
    throw bladOperatora(`Piaskownica: atrapa ${gdzie} nie obsługuje „${metoda}” — ta operacja działa tylko z prawdziwym `
      + `kontem. Nic nie zostało wysłane.`, { status: 400 });
  };
}

function sciezkaProduktu(sciezka) {
  const m = /^products\/(\d+)(?:\/variations\/(\d+))?$/.exec(String(sciezka ?? ''));
  if (!m) throw bladOperatora(`Sklep: niepoprawna ścieżka produktu „${sciezka}”`, { status: 400 });
  return { produkt: m[1], wariant: m[2] ?? null };
}

/** Atrapa klienta Woo (createWooClient) jednego sklepu. */
export function createAtrapaWoo({ db, kanal, log = (...t) => console.log(...t), env = process.env }) {
  wymagajTrybuProby(env, 'atrapa sklepu Woo');
  db.exec(SCHEMAT);
  const ślad = (t) => log(`atrapa sklepu ${kanal}: ${t} (piaskownica — nic nie poszło do sklepu)`);
  const zmiany = () => new Map(db.prepare('SELECT sciezka, pola_json FROM atrapa_kanaly_zmiany WHERE kanal = ?').all(kanal)
    .map((w) => [w.sciezka, JSON.parse(w.pola_json)]));
  const katalog = () => {
    const k = katalogWoo(kanal);
    const z = zmiany();
    const produkty = k.produkty.map((p) => ({ ...p, ...(z.get(`products/${p.id}`) ?? {}) }));
    const warianty = new Map([...k.warianty].map(([id, lista]) => [id, lista.map((w) => ({ ...w, ...(z.get(`products/${id}/variations/${w.id}`) ?? {}) }))]));
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
  return {
    ...Object.fromEntries(ODMOWY_WOO.map((m) => [m, odmowa(`sklepu ${kanal}`, m)])),
    pobierzWszystkieProdukty: async () => structuredClone(katalog().produkty),
    pobierzWarianty: async (id) => structuredClone(katalog().warianty.get(String(id)) ?? []),
    pobierzMiniatury: async () => new Map(katalog().miniatury),
    ustawienieSklepu: async (id) => ({ woocommerce_dimension_unit: 'cm', woocommerce_weight_unit: 'kg' })[id] ?? '',
    pobierzProdukt: async (sciezka) => structuredClone(znajdz(sciezka)),
    async zapiszProdukt(sciezka, pola) {
      const obecny = znajdz(sciezka);
      const poprzednie = zmiany().get(String(sciezka)) ?? {};
      db.prepare(`INSERT INTO atrapa_kanaly_zmiany (kanal, sciezka, pola_json) VALUES (?,?,?)
        ON CONFLICT(kanal, sciezka) DO UPDATE SET pola_json = excluded.pola_json`).run(kanal, String(sciezka), JSON.stringify({ ...poprzednie, ...(pola ?? {}) }));
      ślad(`zapisano ${sciezka}: ${Object.keys(pola ?? {}).join(', ')}`);
      return { ...obecny, ...(pola ?? {}) };
    },
    async dodajNotatke(id, tresc) {
      ślad(`notatka do zamówienia ${id}: ${String(tresc).slice(0, 80)}`);
      return { id: Date.now(), note: tresc, customer_note: false, date_created_gmt: new Date().toISOString() };
    },
    async ustawStatus(id, status) {
      ślad(`status zamówienia ${id} → ${status}`);
      return { id: Number(id), status };
    },
    atrapa: true,
  };
}

/** Atrapa klienta Allegro (createAllegroClient) jednego konta. */
export function createAtrapaAllegro({ db, kanal, log = (...t) => console.log(...t), env = process.env }) {
  wymagajTrybuProby(env, 'atrapa Allegro');
  db.exec(SCHEMAT);
  const ślad = (t) => log(`atrapa Allegro ${kanal}: ${t} (piaskownica — nic nie poszło do Allegro)`);
  const zamowienie = (zrodloId) => db.prepare('SELECT * FROM zamowienia WHERE sklep = ? AND zrodlo_id = ?').get(kanal, String(zrodloId));
  const fakturyZamowienia = (zrodloId) => db.prepare('SELECT dane_json FROM atrapa_allegro_faktury WHERE kanal = ? AND zamowienie = ?')
    .all(kanal, String(zrodloId)).map((w) => JSON.parse(w.dane_json));
  const zapiszFakture = (zrodloId, wpis) => db.prepare(`INSERT INTO atrapa_allegro_faktury (kanal, zamowienie, id, dane_json) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET dane_json = excluded.dane_json`).run(kanal, String(zrodloId), wpis.id, JSON.stringify(wpis));

  return {
    ...Object.fromEntries(ODMOWY_ALLEGRO.map((m) => [m, odmowa(`Allegro ${kanal}`, m)])),
    pobierzOferty: async () => ofertyAllegro(kanal),
    // Metoda dostawy nieznana (null) zamiast odmowy: kurier WzA pyta o nią przy budowie ekranu nadania.
    pobierzMetodeDostawy: async () => null,

    async pobierzPrzesylki(idZamowienia) {
      const z = zamowienie(idZamowienia);
      if (!z) return [];
      return db.prepare("SELECT numer_listu, kurier FROM przesylki WHERE zamowienie_id = ? AND numer_listu IS NOT NULL").all(z.id)
        .map((p) => ({ id: `atrapa-${p.numer_listu}`, waybill: p.numer_listu, carrierId: p.kurier === 'inpost' ? 'INPOST' : p.kurier === 'dpd' ? 'DPD' : 'ALLEGRO' }));
    },
    async pobierzSledzenie(carrierId, waybill) {
      const p = db.prepare('SELECT status_kuriera, status_kuriera_at, utworzona_at FROM przesylki WHERE numer_listu = ?').get(String(waybill));
      if (!p) return { waybills: [] };
      const statuses = [{ code: 'PENDING', occurredAt: p.utworzona_at, description: 'Przesyłka utworzona (atrapa)' }];
      if (p.status_kuriera) {
        statuses.push({ code: /doręczona/i.test(p.status_kuriera) ? 'DELIVERED' : 'IN_TRANSIT', occurredAt: p.status_kuriera_at, description: p.status_kuriera });
      }
      return { waybills: [{ waybill: String(waybill), carrierId, trackingDetails: { statuses } }] };
    },

    async pobierzStanRealizacji(idZamowienia) {
      const zapisany = db.prepare('SELECT status FROM atrapa_allegro_realizacja WHERE kanal = ? AND zamowienie = ?').get(kanal, String(idZamowienia));
      if (zapisany) return zapisany.status;
      const z = zamowienie(idZamowienia);
      if (!z) throw bladOperatora(`Allegro odrzuciło zapytanie (404): nie ma zamówienia ${idZamowienia}`, { status: 404 });
      return z.wyslane_at ? 'SENT' : z.w_realizacji_at ? 'PROCESSING' : 'NEW';
    },
    async ustawStatusRealizacji(idZamowienia, status) {
      db.prepare(`INSERT INTO atrapa_allegro_realizacja (kanal, zamowienie, status) VALUES (?,?,?)
        ON CONFLICT(kanal, zamowienie) DO UPDATE SET status = excluded.status`).run(kanal, String(idZamowienia), String(status));
      ślad(`status realizacji ${idZamowienia} → ${status}`);
      return null;
    },

    pobierzFakturyZamowienia: async (idZamowienia) => fakturyZamowienia(idZamowienia),
    async zglosFakture(idZamowienia, { nazwaPliku, numerFaktury } = {}) {
      const wpis = { id: randomUUID(), invoiceNumber: numerFaktury ?? null, file: { name: nazwaPliku ?? null, securityVerification: null } };
      zapiszFakture(idZamowienia, wpis);
      ślad(`zgłoszono fakturę ${numerFaktury} do zamówienia ${idZamowienia}`);
      return { id: wpis.id };
    },
    async wyslijPlikFaktury(idZamowienia, invoiceId, bajty) {
      const wpis = fakturyZamowienia(idZamowienia).find((w) => w.id === invoiceId);
      if (!wpis) throw bladOperatora(`Allegro odrzuciło plik faktury (404): nie ma zgłoszenia ${invoiceId}`, { status: 404 });
      if (!Buffer.isBuffer(bajty) || bajty.subarray(0, 4).toString() !== '%PDF') throw bladOperatora('Allegro odrzuciło plik faktury (422): to nie jest PDF', { status: 422 });
      const nowy = { ...wpis, file: { ...wpis.file, size: bajty.length, securityVerification: { status: 'ACCEPTED' } } };
      zapiszFakture(idZamowienia, nowy);
      ślad(`wgrano PDF faktury ${wpis.invoiceNumber} (${bajty.length} B), weryfikacja ACCEPTED`);
      return nowy;
    },

    async pobierzWatki({ offset = 0 } = {}) {
      const wszystkie = db.prepare('SELECT * FROM allegro_watki WHERE kanal = ? ORDER BY last_message_date_time DESC').all(kanal);
      return {
        watki: wszystkie.slice(offset, offset + 20).map((t) => ({ id: t.thread_id, lastMessageDateTime: t.last_message_date_time,
          read: Boolean(t.przeczytany), interlocutor: { login: t.interlocutor_login } })),
        razem: wszystkie.length,
      };
    },
    async pobierzWiadomosci(threadId, { offset = 0 } = {}) {
      const watek = db.prepare('SELECT interlocutor_login FROM allegro_watki WHERE kanal = ? AND thread_id = ?').get(kanal, String(threadId));
      const wiadomosci = db.prepare('SELECT * FROM allegro_wiadomosci WHERE kanal = ? AND thread_id = ? ORDER BY utworzona_at DESC')
        .all(kanal, String(threadId)).slice(offset, offset + 20)
        .map((m) => ({ id: m.message_id, text: m.tresc, createdAt: m.utworzona_at, type: 'MESSAGE', attachments: [],
          author: { login: m.od_kupujacego ? watek?.interlocutor_login ?? null : 'pracownia-polcien-demo', isInterlocutor: Boolean(m.od_kupujacego) } }));
      return { wiadomosci };
    },
    async wyslijWiadomosc(threadId, tekst, zalaczniki = []) {
      const tresc = String(tekst ?? '');
      if (tresc.trim() === '') throw new Error('Allegro: pusta wiadomość — nie wysyłam.');
      if (zalaczniki.length) throw bladOperatora('Piaskownica: atrapa Allegro nie przyjmuje załączników.', { status: 400 });
      ślad(`wiadomość do wątku ${threadId} (${tresc.length} znaków)`);
      return { id: `atrapa-${randomUUID()}`, text: tresc, createdAt: new Date().toISOString(), type: 'MESSAGE', attachments: [],
        author: { login: 'pracownia-polcien-demo', isInterlocutor: false }, thread: { id: String(threadId) } };
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
  const klienciSklepow = Object.fromEntries(sklepy.map((kanal) => [kanal, createAtrapaWoo({ db, kanal, log, env })]));
  const klienciKanalow = Object.fromEntries(konta.map((kanal) => [kanal, createAtrapaAllegro({ db, kanal, log, env })]));
  const adres = 'https://atrapa.example.invalid';
  const configZAtrapami = {
    ...config,
    sklepy: Object.fromEntries(sklepy.map((k) => [k, { baseUrl: adres, ck: '', cs: '', mapowanie: { instancje: {}, poPozycji: [] }, od: null, historia: null, atrapa: true }])),
    kanaly: Object.fromEntries(konta.map((k) => [k, { clientId: '', clientSecret: '', api: adres, auth: adres, userAgent: 'atrapa/1 (+https://atrapa.example.invalid)', od: null, atrapa: true }])),
    braki: Object.fromEntries(Object.keys(config?.braki ?? {}).map((k) => [k, []])),
  };
  return { klienciSklepow, klienciKanalow, config: configZAtrapami };
}

/**
 * PRZ-083 — stany kanałów Allegro dla ekranu Integracje (i pasów na liście). Prawdziwe biorą się z tokenów, których
 * piaskownica nie ma: ekran mówił „Ten panel nie ma skonfigurowanych kanałów Allegro”, choć demo ma Allegro i Outlet.
 * Każdy kanał na OSOBNYM koncie — wspólne konto panel słusznie uznałby za awarię (domena/kanal-stan.js, kolizja).
 */
export function stanyKanalowAtrapy({ config, teraz = () => new Date() }) {
  const DOBA = 86_400_000;
  return () => stanyKanalowZKolizjami(Object.keys(config?.kanaly ?? {}).map((kanal, i) => {
    const zostaloDni = 160 - i * 37;
    return { kanal, polaczony: true, zostaloDni, kontoAllegro: `pracownia_polcien_${i + 1}`,
      refreshWygasaAt: new Date(teraz().getTime() + zostaloDni * DOBA).toISOString() };
  }));
}
