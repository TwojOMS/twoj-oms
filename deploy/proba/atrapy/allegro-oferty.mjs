// PRZ-160.E3.15 — atrapa wystawiania ofert Allegro dla piaskownicy i demo. To SUROWY serwer HTTP (fetchImpl):
// za nim chodzi PRAWDZIWY createAllegroClient, więc kształty żądań i odpowiedzi pilnuje ten sam kod co na produkcji
// (wzór: atrapa inFaktu). Stan w bazie piaskownicy (atrapa_allegro_oferty / _operacje / _zdjecia), reset demo kasuje
// ją razem z plikiem bazy. Kształty z pomiarów sandboxa P12–P18 (tests/fixtures/allegro/e3-pomiar-*.json);
// `tax-settings` i błąd duplikatu nie były mierzone — kształt z dokumentacji, oznaczony niżej.
// Umowne nazwy kart w demo: „[błąd]” = szkic z validation.errors, „[duplikat]” = aktywacja odrzucona 422.
// Nic stąd nie łączy się z Allegro: host `*.atrapa.invalid` nie istnieje, fetchImpl nie woła sieci.
import { createHash, randomUUID } from 'node:crypto';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { KANALY } from '../../../scripts/demo-dane-firma.mjs';
import {
  ofertyAllegro,
  ofertyAllegroDemoE3,
  ofertaAllegroPelna,
  produktyAllegroDemoPoEan,
  eanDemo,
} from '../../../scripts/demo-dane-katalog.mjs';
import { wymagajTrybuProby } from './tryb.mjs';

export const API_ATRAPY_ALLEGRO = 'https://api.atrapa.invalid';
const UPLOAD_ATRAPY = 'https://upload.atrapa.invalid';
const ADRES_ZDJEC = 'https://atrapa.invalid/z/';

/** Metody klienta Allegro z etapu 3, które atrapa obsługuje (dawniej odmowy E3.03). */
export const METODY_OFERT_ALLEGRO = [
  'dopasujKategorie',
  'edytujOferte',
  'komendaCeny',
  'komendaIlosci',
  'komendaPublikacji',
  'ofertyKonta',
  'ofertyPoSygnaturze',
  'oplatyOferty',
  'pobierzCenniki',
  'pobierzGwarancje',
  'pobierzOsobyOdpowiedzialne',
  'pobierzProducentow',
  'pobierzReklamacje',
  'pobierzZwroty',
  'podgladOplat',
  'stanOperacji',
  'szukajProduktow',
  'ustawieniaPodatku',
  'utworzOferte',
  'wgrajZdjecie',
  'wynikKomendy',
];

export const SCHEMAT_OFERT_ALLEGRO = `
  CREATE TABLE IF NOT EXISTS atrapa_allegro_oferty (kanal TEXT NOT NULL, id TEXT NOT NULL, dane_json TEXT NOT NULL,
    PRIMARY KEY (kanal, id));
  CREATE TABLE IF NOT EXISTS atrapa_allegro_operacje (kanal TEXT NOT NULL, rodzaj TEXT NOT NULL, id TEXT NOT NULL,
    oferta_id TEXT, odczyty INTEGER NOT NULL DEFAULT 0, tresc_json TEXT NOT NULL, wynik_json TEXT,
    PRIMARY KEY (kanal, rodzaj, id));
  CREATE TABLE IF NOT EXISTS atrapa_allegro_zdjecia (kanal TEXT NOT NULL, sha TEXT NOT NULL, adres TEXT NOT NULL,
    wygasa_at TEXT NOT NULL, PRIMARY KEY (kanal, sha));`;

const MAKS_ZDJEC_OFERTY = 16;
const MAKS_BAJTOW_ZDJECIA = 26214400; // P14: granica ≈ 25 MiB
const WAZNOSC_ZDJECIA_MS = 6 * 3600 * 1000;
const PARAMETRY_NOWEGO_PRODUKTU = [
  ['248811', 'Marka'],
  ['225693', 'EAN (GTIN)'],
];

// Błąd walidacji z pomiaru P17 (konto firma bez warunków oferty).
const BLAD_WARUNKOW = {
  code: 'ConstraintViolationException.AfterSalesServiceConditionsRequiredByCompany',
  message: 'Offer Terms (for returns and complaints) are required for Business Accounts.',
  details: null,
  path: 'null',
  userMessage: 'Warunki oferty (zwroty, reklamacje) są wymagane dla kont firma.',
  metadata: {},
};
// Niezmierzone (walidacja duplikatu w sandboxie jest asynchroniczna) — treść z dokumentacji Allegro.
const BLAD_DUPLIKATU = {
  code: 'ConstraintViolationException.DuplicatedOffer',
  message: 'Offer is a duplicate of another offer.',
  details: null,
  path: 'publication.status',
  metadata: {},
  userMessage:
    'Oferta to duplikat: nie można publikować więcej niż dwóch ofert tego samego przedmiotu w stanie Nowy ' +
    'w tej samej podkategorii.',
};

const SLOWNIKI = {
  '/sale/shipping-rates': {
    shippingRates: [{ id: 'atrapa-cennik-standard', name: 'Standard', marketplaces: [{ id: 'allegro-pl' }] }],
  },
  '/after-sales-service-conditions/return-policies': {
    returnPolicies: [{ id: 'atrapa-zwroty-30', name: '30 dni', seller: { id: 'atrapa' } }],
  },
  '/after-sales-service-conditions/implied-warranties': {
    impliedWarranties: [{ id: 'atrapa-rekojmia', name: 'Rękojmia', seller: { id: 'atrapa' } }],
  },
  '/after-sales-service-conditions/warranties': { warranties: [] },
  '/sale/responsible-producers': {
    responsibleProducers: [
      {
        id: 'atrapa-producent-polcien',
        name: 'Pracownia Półcień sp. z o.o.',
        producerData: {
          tradeName: 'Pracownia Półcień sp. z o.o.',
          address: { countryCode: 'PL', street: 'ul. Przykładowa 1', postalCode: '00-001', city: 'Warszawa' },
          contact: { email: 'producent@example.test', phoneNumber: '+48500100200' },
        },
      },
    ],
  },
  '/sale/responsible-persons': {
    responsiblePersons: [
      {
        id: 'atrapa-osoba-polcien',
        name: 'Osoba odpowiedzialna (przykład)',
        personalData: {
          name: 'Pracownia Półcień sp. z o.o.',
          address: { countryCode: 'PL', street: 'ul. Przykładowa 1', postalCode: '00-001', city: 'Warszawa' },
          contact: { email: 'bezpieczenstwo@example.test' },
        },
      },
    ],
  },
  // Dwie podpowiedzi z drzewa lamp demo: liść 257 i jego rodzic 256 (nie-liść).
  '/sale/matching-categories': {
    matchingCategories: [
      {
        id: '257',
        name: 'Lampy',
        parentCategory: { id: '256', name: 'Oświetlenie', parentCategory: { id: '5', name: 'Dom i Ogród' } },
      },
      { id: '256', name: 'Oświetlenie', parentCategory: { id: '5', name: 'Dom i Ogród' } },
    ],
  },
  // ⚠️ Niezmierzone (P13 nie objął tax-settings) — kształt z dokumentacji, stawki 23/8/5 i zwolnienie.
  '/sale/tax-settings': {
    subjects: ['GOODS'],
    rates: [{ countryCode: 'PL', values: [{ value: '23.00' }, { value: '8.00' }, { value: '5.00' }] }],
    exemptions: [{ value: 'zw', countryCode: 'PL', name: 'Zwolnione z VAT' }],
  },
};

const ZASOBY_KOMEND = {
  'offer-quantity-change-commands': 'ilosc',
  'offer-price-change-commands': 'cena',
  'offer-publication-commands': 'publikacja',
};

const obiekt = (w) => w !== null && typeof w === 'object' && !Array.isArray(w);
function scal(cel, zmiany) {
  const wynik = { ...cel };
  for (const [k, v] of Object.entries(zmiany)) wynik[k] = obiekt(v) && obiekt(cel?.[k]) ? scal(cel[k], v) : v;
  return wynik;
}
const json = (status, cialo, naglowki = {}) =>
  new Response(cialo === null ? null : JSON.stringify(cialo), {
    status,
    headers: { 'Content-Type': 'application/vnd.allegro.public.v1+json', ...naglowki },
  });
const bledy = (status, lista) => json(status, { errors: lista });
const blad = (status, code, message, userMessage = message, path = null, metadata = {}) =>
  bledy(status, [{ code, message, details: null, path, userMessage, metadata }]);

/** Surowy serwer HTTP ofert Allegro jednego konta. */
export function createSerwerOfertAllegro({ db, kanal, env, teraz = () => new Date() }) {
  wymagajTrybuProby(env, 'atrapa ofert Allegro');
  db.exec(SCHEMAT_OFERT_ALLEGRO);
  const nrKonta = Math.max(
    0,
    KANALY.findIndex((k) => k.klucz === kanal),
  );
  const iso = () => teraz().toISOString();

  const zTabeli = (id) => {
    const w = db
      .prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? AND id = ?')
      .get(kanal, String(id));
    return w ? JSON.parse(w.dane_json) : null;
  };
  const oferta = (id) => zTabeli(id) ?? ofertaAllegroPelna(kanal, id);
  const zapisz = (o) =>
    db
      .prepare(
        `INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?,?,?)
    ON CONFLICT(kanal, id) DO UPDATE SET dane_json = excluded.dane_json`,
      )
      .run(kanal, String(o.id), JSON.stringify(o));
  const bledyWalidacji = (o) => (String(o.name ?? '').includes('[błąd]') ? [BLAD_WARUNKOW] : []);
  const duplikat = (o) => String(o.name ?? '').includes('[duplikat]');
  // Stan 0 na aktywnej ofercie kończy ją (Allegro: oferta bez sztuk = zakończona).
  const poStanie = (o) =>
    o.stock?.available === 0 && o.publication?.status === 'ACTIVE'
      ? { ...o, publication: { ...o.publication, status: 'ENDED' } }
      : o;
  const adresOferty = (id) => `${API_ATRAPY_ALLEGRO}/sale/product-offers/${id}`;
  const odmowaAktywacji = (o) => (duplikat(o) ? [BLAD_DUPLIKATU] : bledyWalidacji(o));

  function nowaOperacja(ofertaId, status) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO atrapa_allegro_operacje (kanal, rodzaj, id, oferta_id, odczyty, tresc_json) VALUES (?, 'oferta', ?, ?, 0, ?)`,
    ).run(kanal, id, String(ofertaId), JSON.stringify({ status }));
    return json(202, null, { Location: `${adresOferty(ofertaId)}/operations/${id}`, 'Retry-After': '1' });
  }

  function utworz(cialo) {
    if (!obiekt(cialo)) return blad(400, 'InvalidBody', 'Body must be an object.');
    if (String(cialo.external?.id ?? '').length > 100)
      return blad(
        422,
        'ConstraintViolationException.MaxLength',
        'Signature must not be longer than 100 characters.',
        'Sygnatura nie może mieć więcej niż 100 znaków.',
        'external',
      );
    if ((cialo.images ?? []).length > MAKS_ZDJEC_OFERTY)
      return blad(
        422,
        'GallerySizeException',
        `You can add up to ${MAKS_ZDJEC_OFERTY} images.`,
        `You can add up to ${MAKS_ZDJEC_OFERTY} images.`,
        'images',
      );
    const produkt = cialo.productSet?.[0]?.product ?? {};
    const parametry = Array.isArray(produkt.parameters) ? produkt.parameters : [];
    const wartosc = (id) => parametry.find((p) => String(p?.id) === id);
    if (!produkt.id) {
      const ma = (p) =>
        (Array.isArray(p?.values) && p.values.length > 0) || (Array.isArray(p?.valuesIds) && p.valuesIds.length > 0);
      const braki = PARAMETRY_NOWEGO_PRODUKTU.filter(([id]) => !ma(wartosc(id)));
      if (braki.length) {
        const nazwy = braki.map(([, n]) => n).join(', ');
        return blad(
          422,
          'ProductValidationException',
          `Cannot create a product without all required parameters: [${nazwy}]`,
          `Nie można stworzyć produktu bez podania poprawnych wartości wszystkich parametrów wymaganych: [${nazwy}]`,
          'productSet[0].product.parameters',
          {
            missingParameterNames: nazwy,
            missingParameterIds: braki.map(([id]) => id).join(', '),
            categoryId: String(cialo.category?.id ?? produkt.category?.id ?? ''),
          },
        );
      }
    } else {
      const ean = wartosc('225693')?.values?.[0];
      const nr = /^00000000-0000-4000-8000-(\d{12})$/.exec(String(produkt.id));
      const znany = nr && produktyAllegroDemoPoEan(eanDemo(Number(nr[1]))).some((p) => p.id === produkt.id);
      if (znany && ean != null && String(ean) !== eanDemo(Number(nr[1])))
        return blad(
          422,
          'PARAMETER_MISMATCH',
          'Parameter value differs from the value in the product.',
          'Wartość parametru EAN (GTIN) różni się od wartości w produkcie z katalogu.',
          'productSet[0].product.parameters',
          { productId: produkt.id, parameterId: '225693' },
        );
    }
    const chceAktywnej = cialo.publication?.status === 'ACTIVE';
    const { publication: _p, ...reszta } = cialo;
    const at = iso();
    const ile = db.prepare('SELECT count(*) AS n FROM atrapa_allegro_oferty WHERE kanal = ?').get(kanal).n;
    const id = String(18000000000 + nrKonta * 1000000 + ile + 1);
    const nowa = { ...reszta, id, publication: { status: 'INACTIVE' }, createdAt: at, updatedAt: at };
    nowa.validation = { errors: bledyWalidacji(nowa), warnings: [], validatedAt: at };
    if (chceAktywnej) {
      const odmowa = odmowaAktywacji(nowa);
      if (odmowa.length) return bledy(422, odmowa);
    }
    zapisz(nowa);
    if (chceAktywnej) {
      const r = nowaOperacja(id, 'ACTIVE');
      return json(202, nowa, Object.fromEntries(r.headers));
    }
    return json(201, nowa, { Location: adresOferty(id) });
  }

  function edytuj(id, zmiany) {
    const o = oferta(id);
    if (!o) return blad(404, 'NotFoundException', 'Offer not found.', 'Nie znaleziono oferty.');
    if (!obiekt(zmiany)) return blad(400, 'InvalidBody', 'Body must be an object.');
    const docelowy = zmiany.publication?.status;
    const { publication: _p, ...reszta } = zmiany;
    const at = iso();
    let po = { ...scal(o, reszta), updatedAt: at };
    po.validation = { errors: bledyWalidacji(po), warnings: [], validatedAt: at };
    if (docelowy === 'ACTIVE') {
      const odmowa = odmowaAktywacji(po);
      if (odmowa.length) return bledy(422, odmowa);
    }
    if (!docelowy) po = poStanie(po);
    zapisz(po);
    return docelowy ? nowaOperacja(id, docelowy) : json(200, po);
  }

  function operacja(ofertaId, id) {
    const w = db
      .prepare(
        `SELECT * FROM atrapa_allegro_operacje WHERE kanal = ? AND rodzaj = 'oferta' AND id = ? AND oferta_id = ?`,
      )
      .get(kanal, id, ofertaId);
    if (!w) return blad(404, 'NotFoundException', 'Operation not found.', 'Nie znaleziono operacji.');
    const odczyty = w.odczyty + 1;
    db.prepare(`UPDATE atrapa_allegro_operacje SET odczyty = ? WHERE kanal = ? AND rodzaj = 'oferta' AND id = ?`).run(
      odczyty,
      kanal,
      id,
    );
    if (odczyty < 2)
      return json(202, null, { Location: `${adresOferty(ofertaId)}/operations/${id}`, 'Retry-After': '1' });
    let wynik = w.wynik_json ? JSON.parse(w.wynik_json) : null;
    if (!wynik) {
      const { status } = JSON.parse(w.tresc_json);
      const o = oferta(ofertaId);
      if (status === 'ENDED' && o.publication?.status === 'INACTIVE') {
        wynik = {
          status: 422,
          cialo: {
            errors: [
              {
                code: 'PublicationValidationException.IllegalChangeInactiveOffer',
                message: 'You cannot end an inactive offer. Inactive offers can be removed.',
                details: null,
                path: 'publication.status',
                userMessage: 'You cannot end an inactive offer. Inactive offers can be removed.',
                metadata: {},
              },
            ],
          },
        };
      } else {
        zapisz({ ...o, publication: { ...o.publication, status }, updatedAt: iso() });
        wynik = { status: 303 };
      }
      db.prepare(
        `UPDATE atrapa_allegro_operacje SET wynik_json = ? WHERE kanal = ? AND rodzaj = 'oferta' AND id = ?`,
      ).run(JSON.stringify(wynik), kanal, id);
    }
    return wynik.status === 303
      ? json(303, null, { Location: adresOferty(ofertaId) })
      : json(wynik.status, wynik.cialo);
  }

  function komenda(rodzaj, id, cialo) {
    const tresc = JSON.stringify(cialo);
    const w = db
      .prepare('SELECT tresc_json, wynik_json FROM atrapa_allegro_operacje WHERE kanal = ? AND rodzaj = ? AND id = ?')
      .get(kanal, rodzaj, id);
    if (w) {
      if (w.tresc_json !== tresc)
        return blad(
          409,
          'COMMAND_ALREADY_REGISTERED_WITH_DIFFERENT_CONTENT',
          'Command with the given id but with different content is already registered.',
          undefined,
          '',
        );
      return json(201, JSON.parse(w.wynik_json).odpowiedz);
    }
    const ids = (cialo?.offerCriteria ?? []).flatMap((k) => k?.offers ?? []).map((o) => String(o?.id));
    const tasks = ids.map((ofertaId) => {
      const o = oferta(ofertaId);
      if (!o)
        return {
          offer: { id: ofertaId },
          status: 'FAIL',
          message: 'Oferta nie istnieje albo nie należy do tego konta.',
        };
      const at = iso();
      if (rodzaj === 'publikacja') {
        if (cialo.publication.action === 'ACTIVATE' && !(o.stock?.available > 0))
          return { offer: { id: ofertaId }, status: 'FAIL', message: 'Brak dostępnych sztuk.' };
        zapisz({
          ...o,
          publication: { ...o.publication, status: cialo.publication.action === 'END' ? 'ENDED' : 'ACTIVE' },
          updatedAt: at,
        });
      } else if (rodzaj === 'ilosc')
        zapisz(poStanie({ ...o, stock: { ...o.stock, available: cialo.modification.value }, updatedAt: at }));
      else zapisz({ ...o, sellingMode: { ...o.sellingMode, price: { ...cialo.modification.price } }, updatedAt: at });
      return { offer: { id: ofertaId }, status: 'SUCCESS', message: null };
    });
    const at = iso();
    const sukces = tasks.filter((t) => t.status === 'SUCCESS').length;
    const odpowiedz = {
      id,
      createdAt: at,
      completedAt: at,
      taskCount: { total: tasks.length, success: sukces, failed: tasks.length - sukces },
    };
    db.prepare(
      'INSERT INTO atrapa_allegro_operacje (kanal, rodzaj, id, oferta_id, odczyty, tresc_json, wynik_json) VALUES (?,?,?,NULL,0,?,?)',
    ).run(kanal, rodzaj, id, tresc, JSON.stringify({ odpowiedz, tasks }));
    return json(201, odpowiedz);
  }

  function zadaniaKomendy(rodzaj, id) {
    const w = db
      .prepare('SELECT wynik_json FROM atrapa_allegro_operacje WHERE kanal = ? AND rodzaj = ? AND id = ?')
      .get(kanal, rodzaj, id);
    if (!w) return blad(404, 'NotFoundException', 'Command not found.', 'Nie znaleziono komendy.');
    return json(200, { tasks: JSON.parse(w.wynik_json).tasks });
  }

  // Lista `/sale/offers`: katalog demo + oferty E3 demo, nadpisane i uzupełnione tym, co zapisano w atrapie.
  function listaOfert(q) {
    const doListy = (o) => ({
      id: o.id,
      name: o.name,
      external: o.external ?? null,
      sellingMode: o.sellingMode ?? null,
      stock: o.stock ?? null,
      publication: o.publication ?? null,
      category: o.category ?? null,
      primaryImage: o.images?.[0] ? { url: typeof o.images[0] === 'string' ? o.images[0] : o.images[0].url } : null,
    });
    const zapisane = db
      .prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? ORDER BY rowid')
      .all(kanal)
      .map((w) => JSON.parse(w.dane_json));
    const poId = new Map(zapisane.map((o) => [String(o.id), o]));
    const baza = [...ofertyAllegro(kanal), ...ofertyAllegroDemoE3(kanal)];
    const znane = new Set(baza.map((o) => o.id));
    let lista = [
      ...baza.map((o) => (poId.has(o.id) ? doListy(poId.get(o.id)) : o)),
      ...zapisane.filter((o) => !znane.has(String(o.id))).map(doListy),
    ];
    const sygnatura = q.get('external.id');
    if (sygnatura !== null) lista = lista.filter((o) => o.external?.id === sygnatura);
    const offset = Number(q.get('offset') ?? 0) || 0;
    const limit = Number(q.get('limit') ?? 20) || 20;
    return json(200, {
      offers: lista.slice(offset, offset + limit),
      count: Math.min(limit, Math.max(0, lista.length - offset)),
      totalCount: lista.length,
    });
  }

  function zdjecie(bajty) {
    if (!(bajty instanceof Uint8Array) || bajty.length === 0) return blad(400, 'EmptyBody', 'Empty image.');
    if (bajty.length > MAKS_BAJTOW_ZDJECIA)
      return blad(413, 'PayloadTooLarge', 'Payload Too Large', 'Payload too large.');
    const sha = createHash('sha256').update(bajty).digest('hex');
    const location = `${ADRES_ZDJEC}${sha}`;
    const expiresAt = new Date(teraz().getTime() + WAZNOSC_ZDJECIA_MS).toISOString();
    db.prepare(
      `INSERT INTO atrapa_allegro_zdjecia (kanal, sha, adres, wygasa_at) VALUES (?,?,?,?)
      ON CONFLICT(kanal, sha) DO UPDATE SET wygasa_at = excluded.wygasa_at`,
    ).run(kanal, sha, location, expiresAt);
    return json(201, { location, expiresAt });
  }

  function oplaty(cialo) {
    const cena = Number(cialo?.offer?.sellingMode?.price?.amount ?? 0);
    const prowizja = (Math.round(Math.round(cena * 100) / 10) / 100).toFixed(2);
    return json(200, {
      commissions: [
        {
          name: 'Prowizja od sprzedaży',
          type: 'commissionFee',
          fee: { amount: prowizja, currency: 'PLN', tax: 'GROSS' },
        },
      ],
      quotes: [{ name: 'Opłata za wystawienie', type: 'listingFee', fee: { amount: '0.00', currency: 'PLN' } }],
    });
  }

  async function fetchImpl(adres, init = {}) {
    const u = new URL(adres);
    const metoda = String(init.method ?? 'GET').toUpperCase();
    const naglowki = new Headers(init.headers ?? {});
    if (!/^Bearer \S+/.test(naglowki.get('Authorization') ?? '')) return blad(401, 'UNAUTHORIZED', 'Unauthorized.');
    const sciezka = u.pathname;
    const cialo = () => {
      try {
        return init.body == null
          ? null
          : JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
      } catch {
        return undefined;
      }
    };
    if (u.origin === UPLOAD_ATRAPY) {
      return metoda === 'POST' && sciezka === '/sale/images'
        ? zdjecie(init.body)
        : blad(404, 'NotFoundException', 'Not found.');
    }
    if (u.origin !== API_ATRAPY_ALLEGRO) return blad(404, 'NotFoundException', 'Not found.');
    let m;
    if (metoda === 'POST' && sciezka === '/sale/product-offers') return utworz(cialo());
    if ((m = /^\/sale\/product-offers\/([^/]+)$/.exec(sciezka))) {
      const id = decodeURIComponent(m[1]);
      if (metoda === 'GET') {
        const o = oferta(id);
        return o ? json(200, o) : blad(404, 'NotFoundException', 'Offer not found.', 'Nie znaleziono oferty.');
      }
      if (metoda === 'PATCH') return edytuj(id, cialo());
    }
    if (metoda === 'GET' && (m = /^\/sale\/product-offers\/([^/]+)\/operations\/([^/]+)$/.exec(sciezka)))
      return operacja(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (
      (m =
        /^\/sale\/(offer-quantity-change-commands|offer-price-change-commands|offer-publication-commands)\/([^/]+)(\/tasks)?$/.exec(
          sciezka,
        ))
    ) {
      const rodzaj = ZASOBY_KOMEND[m[1]];
      const id = decodeURIComponent(m[2]);
      if (metoda === 'PUT' && !m[3]) return komenda(rodzaj, id, cialo());
      if (metoda === 'GET' && m[3]) return zadaniaKomendy(rodzaj, id);
    }
    if (metoda === 'GET' && sciezka === '/sale/offers') return listaOfert(u.searchParams);
    if (metoda === 'GET' && sciezka === '/sale/products')
      return json(200, { products: produktyAllegroDemoPoEan(u.searchParams.get('phrase') ?? '') });
    if (metoda === 'POST' && sciezka === '/pricing/offer-fee-preview') return oplaty(cialo());
    if (metoda === 'GET' && sciezka === '/pricing/offer-quotes') {
      const id = u.searchParams.get('offer.id') ?? '';
      return json(200, {
        quotes: [
          { name: 'Opłata za wystawienie', type: 'LISTING', fee: { amount: '0.00', currency: 'PLN' }, offer: { id } },
        ],
      });
    }
    if (metoda === 'GET' && Object.hasOwn(SLOWNIKI, sciezka)) return json(200, SLOWNIKI[sciezka]);
    return blad(404, 'NotFoundException', 'Not found.');
  }

  // PRZ-160.E4.16: symulacja zakupu i anulowania na Allegro (symulator deploy/proba/zakup.mjs). Allegro kończy ofertę
  // bez sztuk (ATRAPA_ALLEGRO_KONCZY, domyślnie tak) i oddaje sztuki z anulowanego zakupu (ATRAPA_ALLEGRO_ODDAJE).
  const tak = (nazwa) =>
    String(env?.[nazwa] ?? 'tak')
      .trim()
      .toLowerCase() !== 'nie';
  function poZakupie(id, n, znak) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Atrapa Allegro: niepoprawna ilość zakupu.');
    const o = oferta(id);
    if (!o) throw new Error(`Atrapa Allegro: nie ma oferty ${id}.`);
    if (znak > 0 && !tak('ATRAPA_ALLEGRO_ODDAJE')) return structuredClone(o);
    const po = {
      ...o,
      stock: { ...o.stock, available: Math.max(0, (o.stock?.available ?? 0) + znak * n) },
      updatedAt: iso(),
    };
    const wynik = znak < 0 && tak('ATRAPA_ALLEGRO_KONCZY') ? poStanie(po) : po;
    zapisz(wynik);
    return structuredClone(wynik);
  }

  return {
    fetchImpl,
    api: API_ATRAPY_ALLEGRO,
    oferta,
    kup: (id, n) => poZakupie(id, n, -1),
    oddaj: (id, n) => poZakupie(id, n, 1),
  };
}

/** Metody ofert dla atrapy kanału: prawdziwy klient Allegro na surowym serwerze atrapy. */
export function createOfertyAllegro({ serwer, db, kanal, env, teraz } = {}) {
  const s = serwer ?? createSerwerOfertAllegro({ db, kanal, env, teraz });
  const klient = createAllegroClient({
    ustawienia: { api: s.api, userAgent: 'atrapa/1 (+https://atrapa.example.invalid)' },
    tokeny: { waznyToken: async () => 'atrapa' },
    fetchImpl: s.fetchImpl,
  });
  return Object.fromEntries(METODY_OFERT_ALLEGRO.map((m) => [m, klient[m]]));
}
