import PDFDocument from 'pdfkit';
import { createErliClient } from '../../../src/oms/erli/client.js';
import { wymagajTrybuProby } from './tryb.mjs';
import { PRODUKTY, FIRMY_B2B } from '../../../scripts/demo-dane-firma.mjs';

const BAZA = 'https://sklep.polcien.example';

/** Odmowa przed fetch; komunikat celowo nie zawiera URL ani nagłówków. */
export function strzezErliProby({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return async (adres, init) => {
    const host = new URL(adres instanceof Request ? adres.url : String(adres)).hostname.toLowerCase().replace(/\.$/, '');
    if (['erli.pl', 'erli.dev'].some(d => host === d || host.endsWith(`.${d}`))) {
      throw Object.assign(new Error('Tryb próby: połączenie z API ERLI zablokowane — użyj atrapy Półcień.'),
        { name: 'OdmowaHosta', code: 'OMS_PROBA_ERLI' });
    }
    return fetchImpl(adres, init);
  };
}

/** Host adresu z konfiguracji wskazuje kanał; stan jest rozdzielony kluczem kanału. */
export function transportErliPiaskownicy({ baza, env, log, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  wymagajTrybuProby(env, 'transport ERLI');
  const atrapy = new Map();
  // Tylko oficjalne API sandboxa z własnym kluczem może wyjść do sieci.
  // Klucz atrapy zachowuje demo bez sieci także na oficjalnych adresach.
  const konfigurator = async (adres, init = {}) => {
    const url = new URL(String(adres));
    const bazaApi = ['https://erli.pl/svc/shop-api', 'https://sandbox.erli.dev/svc/shop-api'].find(b => url.href.startsWith(b + '/'));
    if (!bazaApi) return null;
    const authorization = new Headers(init.headers).get('Authorization');
    if (authorization && authorization !== 'Bearer atrapa-polcien') {
      if (bazaApi === 'https://sandbox.erli.dev/svc/shop-api') return fetchImpl(adres, { ...init, redirect: 'error' });
      return surowaOdpowiedzErli({ message: 'OMS_PROBA_ERLI_PRODUKCJA' }, 403);
    }
    const db = baza();
    const zapis = db.prepare("SELECT integracja, ustawienia_json, sekrety_json FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").all().find(w => {
      try { return JSON.parse(w.ustawienia_json).adresApi === bazaApi && authorization === 'Bearer ' + JSON.parse(w.sekrety_json).kluczApi; } catch { return false; }
    });
    if (!zapis || authorization !== 'Bearer atrapa-polcien') return surowaOdpowiedzErli({}, 401);
    const kanal = zapis.integracja.slice(5);
    const id = 'konfigurator:' + kanal;
    if (!atrapy.has(id)) atrapy.set(id, createAtrapaErli({ db, kanal, env, log, tryb: bazaApi.includes('sandbox') ? 'sandbox' : 'produkcja' }));
    return atrapy.get(id).fetchImpl(BAZA + url.href.slice(bazaApi.length), init);
  };
  const pozostale =
  strzezErliProby({ fetchImpl: async (adres, init) => {
    const url = new URL(adres instanceof Request ? adres.url : String(adres));
    if (url.hostname.endsWith('.polcien.example')) {
      const db = baza();
      const konfiguracje = db.prepare("SELECT integracja, ustawienia_json FROM konfiguracja_integracji WHERE integracja LIKE 'erli:%'").all();
      const zapis = konfiguracje.find(w => {
        try { return new URL(JSON.parse(w.ustawienia_json).adresApi).origin === url.origin; } catch { return false; }
      });
      if (!zapis) throw new Error('Atrapa ERLI: brak konfiguracji kanału dla tego adresu.');
      const kanal = zapis.integracja.slice(5);
      if (!atrapy.has(kanal)) atrapy.set(kanal, createAtrapaErli({ db, kanal, env, log, demoZmiany: true }));
      return atrapy.get(kanal).fetchImpl(new URL(url.pathname + url.search, BAZA).href, init);
    }
    return globalThis.fetch(adres, init);
  } });
  return async (adres, init) => await konfigurator(adres, init) ?? pozostale(adres, init);
}
// Jawna lista: nowa metoda klienta wymaga świadomego dodania obsługi i testu kontraktu.
const METODY = ['mojSklep', 'zmianyZamowien', 'oznaczPrzeczytane', 'inboxSzukaj', 'inboxOznacz',
  'pobierzProdukt', 'szukajZamowien', 'pobierzZamowienie', 'ustawStatusSprzedawcy',
  'utworzPaczkiZewnetrzne', 'edytujPaczkeZewnetrzna', 'usunPaczkeZewnetrzna', 'metodyDostawy',
  'metodyErli', 'cennikiDostaw', 'cennikiDostawSzczegoly', 'punktyNadania', 'utworzPaczki',
  'szukajPaczek', 'anulujPaczke', 'protokolyOdbioru', 'pobierzEtykiete'];

const METODY_ERLI = [
  { id: 'erliPaczkomat', groupId: 'erliPaczkomat', name: 'Paczkomat ERLI', operator: 'INPOST', cod: false },
  { id: 'erliKurier24InPost10kg', groupId: 'erliKurier24InPost', name: 'Kurier ERLI', operator: 'INPOST', cod: true },
].map(m => ({ ...m, minDimensions: { width: 1, height: 1, length: 1, weight: 10 },
  maxDimensions: { width: 400, height: 400, length: 600, weight: 10000 } }));
const DOSTAWY = [
  ...METODY_ERLI.map(m => ({ id: m.id, name: m.name, cod: m.cod, vendor: 'inpost', targetMarket: 'pl' })),
  ...[['dpd', 'dpd', 'Kurier DPD'], ['paczkomat', 'inpost', 'Paczkomat InPost'], ['odbiorOsobisty', 'selfPickup', 'Odbiór osobisty'],
    ['dostawaPrzezSprzedajacego', 'ownTransport', 'Dostawa przez sprzedającego']]
    .map(([id, vendor, name]) => ({ id, name, cod: false, vendor, targetMarket: 'pl' })),
];

/** Surowy JSON API (bez normalizacji), do karmienia fetchImpl w testach kontraktu. */
export function surowaOdpowiedzErli(dane, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(dane), { status,
    headers: { 'Content-Type': 'application/json', ...headers } });
}

function pasuje(dane, filtr) {
  if (!filtr) return true;
  const { field, operator, value } = filtr;
  if (operator === 'and') return value.every(f => pasuje(dane, f));
  if (operator === 'or') return value.some(f => pasuje(dane, f));
  const x = dane[field];
  switch (operator) {
    case '=': return x === value;
    case '!=': return x !== value;
    case '>': return x > value;
    case '>=': return x >= value;
    case '<': return x < value;
    case '<=': return x <= value;
    case 'in': return value.includes(x);
    case 'nin': return !value.includes(x);
    default: throw new Error('Atrapa ERLI: nieobsługiwany filtr.');
  }
}

function pdf(tytul) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false }); const czesci = [];
    doc.on('data', b => czesci.push(b)); doc.on('end', () => resolve(Buffer.concat(czesci))); doc.on('error', reject);
    doc.fillColor('red').fontSize(36).text('ATRAPA'); doc.fillColor('black').fontSize(14).text(tytul); doc.end();
  });
}

function zamowieniaStartowe(data) {
  const adres = { firstName: 'Ada', lastName: 'Przykladowa', address: 'Zmyslona 1', street: 'Zmyslona',
    buildingNumber: '1', city: 'Warszawa', country: 'pl', zip: '00-001', phone: '500100200' };
  return Array.from({ length: 16 }, (_, i) => ({
    id: `PC-ERLI-${String(i + 1).padStart(4, '0')}`, status: i === 5 ? 'pending' : 'purchased',
    user: { ...(i !== 8 ? { email: `kupujacy${i + 1}@polcien.example` } : {}), deliveryAddress: { ...adres, ...(i === 9 ? { country: 'de', city: 'Berlin', zip: '10000' } : {}) },
      ...(i === 4 ? { invoiceAddress: { type: 'company', address: 'Zmyslona 1', street: 'Zmyslona', buildingNumber: '1',
        city: 'Warszawa', country: 'pl', zip: '00-001', companyName: FIRMY_B2B[0].nazwa, nip: FIRMY_B2B[0].nip } } : {}) },
    items: [{ id: i + 1, externalId: `PC-OF-${i + 1}`, sku: PRODUKTY[i].sku, quantity: 1, unitPrice: PRODUKTY[i].cena_gr, name: PRODUKTY[i].nazwa,
      slug: 'dekoracja-polcien', taxRate: 'TAX_23', ...(i < 4 ? { dispatchTime: { period: 2, unit: 'day' } } : {}) }],
    delivery: { name: i === 2 ? 'Paczkomat ERLI' : i === 11 ? 'Paczkomat InPost — umowa firmy' : i === 10 ? 'Dostawa nieznana' : 'Kurier DPD — umowa firmy', typeId: i === 2 ? 'erliPaczkomat' : i === 11 ? 'paczkomat' : i === 10 ? 'nieznanaMetoda' : 'dpd', price: 1000, cod: i === 1,
      ...([2, 11].includes(i) ? { pickupPlace: { externalId: 'PC001', provider: 'inpost', name: 'Punkt Półcień' } } : {}) },
    totalPrice: PRODUKTY[i].cena_gr + 1000, currency: i === 9 ? 'EUR' : 'PLN', market: i === 9 ? 'de' : 'pl', sellerStatus: 'created', created: data, updated: data,
    ...(i !== 1 ? { payment: { id: 1000001 + i, status: i === 5 ? 'PENDING' : 'COMPLETED' } } : {}),
    ...(i !== 5 ? { purchasedAt: data } : {}), cursor: `${Math.floor(Date.parse(data) / 1000)};${i + 1}x1000`,
    ...(i === 7 ? { returns: [{ items: [{ index: 0, quantity: 1 }], reason: 'resign',
      comment: 'Wybieram inny wzór', created: data,
      bankAccount: { number: '00000000000000000000000000', name: 'Kupujący testowy' } }] } : {}),
  }));
}

/** Stan wyłącznie w atrapa_erli_*; transport nigdy nie wychodzi z procesu. */
export function createAtrapaErli({ db, kanal, env = process.env, log = () => {}, teraz = () => new Date(), tryb = 'produkcja', demoZmiany = false }) {
  wymagajTrybuProby(env, 'atrapa ERLI');
  if (!['produkcja', 'sandbox'].includes(tryb)) throw new Error('Atrapa ERLI: nieznany tryb.');
  db.exec(`CREATE TABLE IF NOT EXISTS atrapa_erli_stan (
    kanal TEXT NOT NULL, rodzaj TEXT NOT NULL, id TEXT NOT NULL, dane_json TEXT NOT NULL,
    PRIMARY KEY (kanal, rodzaj, id));
    CREATE TABLE IF NOT EXISTS atrapa_erli_statusy (
    kanal TEXT NOT NULL, order_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (kanal, order_id));`);
  const data = () => new Date(teraz()).toISOString();
  const zapisz = (rodzaj, id, dane) => db.prepare(`INSERT INTO atrapa_erli_stan VALUES (?,?,?,?)
    ON CONFLICT(kanal,rodzaj,id) DO UPDATE SET dane_json=excluded.dane_json`).run(kanal, rodzaj, String(id), JSON.stringify(dane));
  const lista = rodzaj => db.prepare('SELECT dane_json FROM atrapa_erli_stan WHERE kanal=? AND rodzaj=? ORDER BY rowid').all(kanal, rodzaj).map(w => JSON.parse(w.dane_json));
  const jeden = (rodzaj, id) => {
    const w = db.prepare('SELECT dane_json FROM atrapa_erli_stan WHERE kanal=? AND rodzaj=? AND id=?').get(kanal, rodzaj, String(id));
    return w ? JSON.parse(w.dane_json) : null;
  };
  const usun = (rodzaj, id) => db.prepare('DELETE FROM atrapa_erli_stan WHERE kanal=? AND rodzaj=? AND id=?').run(kanal, rodzaj, String(id));
  if (!jeden('meta', 'start')) transakcja(zasiej);
  function transakcja(fn) {
    db.exec('SAVEPOINT atrapa_erli_seed');
    try { fn(); db.exec('RELEASE atrapa_erli_seed'); }
    catch (e) { db.exec('ROLLBACK TO atrapa_erli_seed'); db.exec('RELEASE atrapa_erli_seed'); throw e; }
  }
  function zasiej() {
    const czas = new Date(new Date(teraz()).getTime() - 2 * 3600000).toISOString();
    for (const [i, z] of zamowieniaStartowe(czas).entries()) {
      zapisz('zamowienie', z.id, z);
      const id = String(i + 1).padStart(24, '0');
      zapisz('zdarzenie', id, { id, shopId: 1000001, created: czas, read: false,
        type: i === 5 ? 'orderStatusChanged' : 'orderCreated', payload: z });
    }
    zapisz('meta', 'start', true);
  }
  function kolejneZmiany() {
    if (!demoZmiany || jeden('meta', 'zmiany') || lista('zdarzenie').some(z => !z.read)) return;
    const czas = data();
    for (const [i, numer] of [7, 8, 9].entries()) {
      const z = jeden('zamowienie', `PC-ERLI-${String(numer).padStart(4, '0')}`);
      z.updated = czas;
      if (numer === 9) z.user.email = 'kupujacy9@polcien.example';
      else z.status = numer === 7 ? 'cancelled' : 'returned';
      if (numer === 8) z.returns = [{ items: [{ index: 0, quantity: 1 }], reason: 'resign', created: czas }];
      zapisz('zamowienie', z.id, z);
      const id = String(17 + i).padStart(24, '0');
      zapisz('zdarzenie', id, { id, shopId: 1000001, created: czas, read: false,
        type: 'orderStatusChanged', payload: z });
    }
    zapisz('meta', 'zmiany', true);
  }
  const widok = z => {
    const wynik = structuredClone(z);
    if (tryb === 'sandbox') { delete wynik.market; wynik.items.forEach(p => { delete p.dispatchTime; }); }
    return wynik;
  };
  const urlPdf = id => `${BAZA}/etykiety/${id}.pdf`;
  let ile429 = 0;
  const ok = surowaOdpowiedzErli;
  const brak = () => ok({}, 404);
  async function fetchImpl(url, init = {}) {
    if (ile429 > 0) { ile429--; return ok({}, 429, { 'Retry-After': '5' }); }
    const u = new URL(url); const p = decodeURIComponent(u.pathname); const metoda = init.method ?? 'GET';
    const body = init.body === undefined ? {} : JSON.parse(init.body);
    const slownik = (lista, pola) => lista.filter(w => pola.every(pole => !u.searchParams.has(pole) || String(w[pole]) === u.searchParams.get(pole)));
    if (u.origin !== BAZA) return brak();
    if (p === '/me') return ok({ id: 1000001, name: 'pracownia-polcien', active: true, externalMatchingPolicy: 'enabled', scopes: ['order', 'product:read'], markets: ['pl'] });
    if (p.startsWith('/orders/changes/') && tryb === 'sandbox') return brak();
    if (['/orders/changes/_search', '/inbox/_search'].includes(p)) return ok(lista('zdarzenie')
      .filter(z => !z.read && (!body.types || body.types.includes(z.type)) && pasuje(z, body.filter)).slice(0, 500)
      .map(z => ({ ...z, payload: widok(z.payload) })));
    if (['/orders/changes/mark-read', '/inbox/mark-read'].includes(p)) {
      let oznaczone = 0;
      for (const z of lista('zdarzenie')) if (!z.read && (body.ids?.includes(z.id) || (body.lastMessageId && z.id <= body.lastMessageId))) { zapisz('zdarzenie', z.id, { ...z, read: true }); oznaczone++; }
      transakcja(kolejneZmiany);
      return ok(oznaczone); // specyfikacja: 200 z liczbą oznaczonych wiadomości
    }
    if (p === '/orders/_search') {
      const { sortField = 'updated', after, limit = 50, order = 'ASC' } = body.pagination ?? {};
      const kierunek = order === 'DESC' ? -1 : 1;
      let z = lista('zamowienie').filter(z => pasuje(z, body.filter)).sort((a, b) => kierunek * (a[sortField].localeCompare(b[sortField]) || a.id.localeCompare(b.id)));
      if (after) { const i = z.findIndex(w => w.cursor === after); z = i >= 0 ? z.slice(i + 1) : z.filter(w => kierunek * w[sortField].localeCompare(after) > 0); }
      return ok(z.slice(0, Math.min(limit, 200)).map(widok));
    }
    const status = /^\/orders\/(.+)\/status$/.exec(p);
    if (status) {
      if (!jeden('zamowienie', status[1])) return brak();
      db.prepare(`INSERT INTO atrapa_erli_statusy VALUES (?,?,?) ON CONFLICT(kanal,order_id) DO UPDATE SET status=excluded.status`).run(kanal, status[1], body.status);
      log('Atrapa ERLI: zapisano status sprzedawcy.'); return ok(undefined, 204);
    }
    if (p.startsWith('/orders/')) { const z = jeden('zamowienie', p.slice(8)); return z ? ok(widok(z)) : brak(); }
    if (p.startsWith('/products/')) {
      const item = lista('zamowienie').flatMap(z => z.items).find(i => i.externalId === p.slice(10));
      if (!item) return brak();
      return ok({ externalId: item.externalId, name: item.name, externalAttributes: [], externalCategories: [], images: [], files: [],
        price: 2500, stock: 10, status: 'active', ...(item.externalId !== 'PC-OF-6' ? { dispatchTime: { period: 2, unit: 'day' } } : {}),
        attributes: [], categories: [], marketplaceId: item.id, slug: item.slug, buyableProblems: [], frozen: {}, created: data(), currency: 'PLN' });
    }
    if (p === '/shipping/external' || p === '/shipping/parcels/') {
      const external = p === '/shipping/external';
      return ok(body.map(d => {
        const id = (jeden('meta', 'licznik') ?? 0) + 1; zapisz('meta', 'licznik', id);
        const czas = data(); const paczka = { id, orderId: d.orderId, type: external ? 'external' : 'internal',
          status: external ? (d.status ?? 'preparing') : 'preparing', createdAt: czas, updatedAt: czas,
          ...(external ? { shipping: { vendor: d.vendor }, ...(d.trackingNumber ? { trackingNumber: d.trackingNumber } : {}) }
            : { dimensions: d.dimensions, shipping: { ...d.shipping, registeredAt: czas } }) };
        zapisz('paczka', id, { paczka, odczyty: 0 }); return paczka;
      }));
    }
    if (p === '/shipping/parcels/_search') return ok(lista('paczka').filter(w => w.paczka.type === 'internal' && pasuje(w.paczka, body.filter)).map(w => {
      w.odczyty++;
      if (w.odczyty >= 2 && w.paczka.status !== 'canceled') { w.paczka.shipping.waybills = [urlPdf(w.paczka.id)]; w.paczka.trackingNumber = `PC${String(w.paczka.id).padStart(22, '0')}`; w.paczka.status = 'readyToSend'; }
      zapisz('paczka', w.paczka.id, w); return w.paczka;
    }));
    const paczkaId = /^\/shipping\/(external|parcels)\/(\d+)$/.exec(p);
    if (paczkaId) {
      const w = jeden('paczka', paczkaId[2]); if (!w || w.paczka.type !== (paczkaId[1] === 'external' ? 'external' : 'internal')) return brak();
      if (metoda === 'DELETE') {
        if (paczkaId[1] === 'external') usun('paczka', paczkaId[2]);
        else { w.paczka.status = 'canceled'; delete w.paczka.shipping.waybills; w.paczka.updatedAt = data(); zapisz('paczka', paczkaId[2], w); return ok(w.paczka); } // 200 z Parcel
        return ok(undefined, 204);
      }
      w.paczka = { ...w.paczka, shipping: { vendor: body.vendor }, trackingNumber: body.trackingNumber, status: body.status ?? w.paczka.status, updatedAt: data() };
      zapisz('paczka', paczkaId[2], w); return ok(w.paczka);
    }
    if (p === '/shipping/pickupProtocols') {
      const ids = (u.searchParams.get('parcelIds') ?? '').split(',');
      if (!ids.length || ids.some(id => !jeden('paczka', id))) return brak();
      return ok({ url: `${BAZA}/protokoly/${ids.join(',')}.pdf` });
    }
    const etykieta = /^\/etykiety\/(\d+)\.pdf$/.exec(p);
    if (etykieta) {
      const w = jeden('paczka', etykieta[1]);
      if (w?.paczka.status === 'canceled' || !w?.paczka.shipping.waybills?.includes(url)) return brak();
      return new Response(await pdf('Etykieta paczki testowej'), { headers: { 'Content-Type': 'application/pdf' } });
    }
    if (p.startsWith('/protokoly/')) return new Response(await pdf('Protokol testowy'), { headers: { 'Content-Type': 'application/pdf' } });
    if (p === '/dictionaries/shippingMethods') return ok(slownik(METODY_ERLI, ['id', 'groupId', 'operator', 'cod']));
    if (p === '/dictionaries/deliveryMethods') return ok(slownik(DOSTAWY, ['id', 'vendor', 'cod']));
    const cennik = { id: 1, name: 'Dostawy Półcień' };
    if (p === '/delivery/priceLists') return ok([cennik]);
    if (p === '/delivery/priceListsDetails') return ok([{ ...cennik, createdAt: data(), prices: DOSTAWY.map(m => ({ deliveryMethod: { id: m.id }, basePrice: 1000, nextItemPrice: 0,
      limit: m.id === 'erliPaczkomat' ? ['A', 'B', 'C'].map(dimension => ({ dimension, limit: 1 })) : 1 })) }]);
    if (p === '/shipping/postingPoints') return ok(u.searchParams.has('groupId') && !METODY_ERLI.some(m => m.groupId === u.searchParams.get('groupId')) ? []
      : slownik([{ id: 1, name: 'Pracownia Półcień', companyName: 'Pracownia Półcień', phone: '500100200', email: 'nadania@polcien.example',
        street: 'Zmyslona', buildingNumber: '1', zip: '00-001', city: 'Warszawa', isDefault: true, type: 'address' }], ['id', 'isDefault']));
    return brak();
  }
  const klient = createErliClient({ adresApi: BAZA, kluczApi: 'atrapa-polcien', fetchImpl });
  return { ...Object.fromEntries(METODY.map(m => [m, klient[m]])), atrapa: true,
    fetchImpl,
    wymus429(n = 1) { if (!Number.isInteger(n) || n < 0) throw new Error('Podaj liczbę odpowiedzi 429.'); ile429 = n; } };
}
