import { groszeZCeny } from '../../../domena/allegro-oferta.js';
import { cenaDlaKanalu, cenyBruttoSklepu, kwotaDziesietna, roznicaBp } from '../../../domena/cena-kanalu.js';
import { MODUL_ALLEGRO } from '../../../domena/modul-allegro.ts';
import { MODUL_ERLI } from '../../../domena/modul-erli.ts';
import { MODUL_WOO } from '../../../domena/modul-woo.ts';
import { modulKanalu } from '../../../domena/moduly-kanalow.ts';
import { groszeZKwoty } from '../../../domena/kwota.js';
import { nazwaWariantuWoo } from '../../../domena/nazwa-wariantu-woo.js';
import { czyTylkoOdczyt } from '../../../domena/woo-uprawnienia.js';
import { cenyReczneKart } from '../../../oms/db/ceny-kanalow.js';
import { DOMYSLNE_USTAWIENIA_OFERT, ustawieniaOfertKonta } from '../../../oms/db/oferty-kanalow.ts';
import { progPotwierdzeniaWooBp } from '../../kanaly/trasy-woo.ts';
import { cenaWymagaPotwierdzenia } from './oferty-wspolne.js';
import { zamrozonePola } from './petla-ofert.js';

const TYLKO_ODCZYT = 'klucz tylko do odczytu — pominięte';
const BEZ_STEROWANIA = 'cena prowadzona w Allegro — włącz Steruj ceną';
const ZARZADZANA = 'zmieni się samo przy przebiegu pętli';
const BRAK_ODCZYTU = 'nie udało się odczytać ceny w kanale — pominięte';
const WSTRZYMANE = 'oferty wstrzymane — pominięte';
const NIEZARZADZANA_ERLI = 'oferta ERLI nieobjęta zarządzaniem — pominięte';
export const LIMIT_KART = 200;
const LIMIT_ODCZYTOW = 4;

const adresHttp = (adres) => (typeof adres === 'string' && /^https?:\/\//i.test(adres.trim()) ? adres.trim() : null);
const cenaDodatnia = (grosze) => (Number.isSafeInteger(grosze) && grosze > 0 ? grosze : null);

function groszeWoo(kwota) {
  try {
    return groszeZKwoty(kwota === '' ? null : kwota, 'cena Woo');
  } catch {
    return null;
  }
}

function dataPromocji(dataGmt, lokalna, domyslna) {
  if (dataGmt) return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/u.test(dataGmt) ? dataGmt : dataGmt + 'Z');
  return lokalna ? Date.parse(lokalna) : domyslna;
}

function uwagiWoo(produkt, teraz) {
  const cena = groszeWoo(produkt.sale_price);
  if (cena === null) return [];
  const od = dataPromocji(produkt.date_on_sale_from_gmt, produkt.date_on_sale_from, -Infinity);
  const doKiedy = dataPromocji(produkt.date_on_sale_to_gmt, produkt.date_on_sale_to, Infinity);
  return od <= teraz && teraz < doKiedy ? [`trwa promocja ${kwotaDziesietna(cena).replace('.', ',')} zł`] : [];
}

async function blokadaWoo(klient) {
  if (!klient) return BRAK_ODCZYTU;
  if (czyTylkoOdczyt(klient)) return TYLKO_ODCZYT;
  try {
    const liczyPodatki = await klient.ustawienieSklepu('woocommerce_calc_taxes', 'general');
    const cenyBrutto =
      liczyPodatki === 'no' ? null : await klient.ustawienieSklepu('woocommerce_prices_include_tax', 'tax');
    return cenyBruttoSklepu(liczyPodatki, cenyBrutto) ? null : 'sklep liczy ceny netto — pominięte';
  } catch {
    return 'nie udało się potwierdzić ustawień podatku w sklepie — pominięte';
  }
}

const wedlugId = (wiersze) => new Map(wiersze.map((w) => [String(w.id), w]));

async function odczytajWoo(odczyt) {
  try {
    return wedlugId(await odczyt());
  } catch {
    return new Map();
  }
}

async function porownajWoo(klient, pozycje, teraz, pokaz, blokujPromocjeWoo) {
  const blokada = await blokadaWoo(klient);
  if (blokada) {
    for (const p of pozycje) pokaz(p, { blokada });
    return;
  }
  // Status publikacji wariantu zależy od rodzica. Razem z prostymi produktami czytamy go w jednej liście ID.
  const grupy = Map.groupBy(pozycje, (p) => p.produkt_id);
  const produkty = await odczytajWoo(() => klient.pobierzStany([...grupy.keys()]));
  for (const [rodzicId, grupa] of grupy) {
    const produkt = produkty.get(rodzicId);
    const statusRodzica = produkt?.status;
    if (produkt && (!statusRodzica || statusRodzica === 'draft')) continue;
    const idsWariantow = grupa.filter((p) => p.wariant_id).map((p) => p.wariant_id);
    const warianty =
      statusRodzica === 'publish' && produkt.type === 'variable' && idsWariantow.length
        ? await odczytajWoo(() => klient.pobierzStanyWariantow(rodzicId, idsWariantow))
        : new Map();
    for (const p of grupa) {
      if (!p.wariant_id && produkt?.type === 'variable') continue;
      const odczyt = p.wariant_id ? warianty.get(p.wariant_id) : produkt;
      const status = statusRodzica === 'publish' ? odczyt?.status : statusRodzica;
      if (status === 'draft') continue;
      if (status && status !== 'publish') {
        pokaz(p, { blokada: `status w sklepie: ${status} — pominięte` });
        continue;
      }
      const staraGr = cenaDodatnia(groszeWoo(odczyt?.regular_price));
      const uwagi = odczyt ? uwagiWoo(odczyt, teraz) : [];
      pokaz(p, {
        staraGr,
        nazwa: p.wariant_id ? nazwaWariantuWoo(produkt?.name, odczyt?.name, p.nazwa) : odczyt?.name || p.nazwa,
        adres: adresHttp(odczyt?.permalink) ?? adresHttp(p.adres),
        uwagi: blokujPromocjeWoo && uwagi.length ? [] : uwagi,
        blokada:
          (blokujPromocjeWoo && uwagi[0] ? `${uwagi[0]} — pominięte` : null) ||
          (staraGr === null ? BRAK_ODCZYTU : null),
      });
    }
  }
}

async function odczytAllegro(klient, id) {
  try {
    const oferta = await klient.pobierzOferte(id);
    return {
      staraGr: cenaDodatnia(groszeZCeny(oferta?.sellingMode?.price, id)),
      nazwa: oferta?.name,
      uwagi: oferta?.publication?.status === 'ENDED' ? ['oferta zakończona'] : [],
    };
  } catch {
    return { staraGr: null };
  }
}

const tylkoOdczytKlienta = (klient) =>
  typeof klient?.tylkoOdczyt === 'function' ? klient.tylkoOdczyt() : klient?.tylkoOdczyt === true;

// Odczyty po jednej ofercie idą najwyżej po kilka naraz; wyniki wracają w kolejności pozycji.
async function odczytajPoKilka(pozycje, odczytaj) {
  const odczyty = new Array(pozycje.length);
  const kolejka = pozycje.entries();
  await Promise.all(
    Array.from({ length: Math.min(LIMIT_ODCZYTOW, pozycje.length) }, async () => {
      for (const [i, p] of kolejka) odczyty[i] = await odczytaj(p);
    }),
  );
  return odczyty;
}

async function porownajAllegro(klient, pozycje, ustawienia, pokaz) {
  const tylkoOdczyt = tylkoOdczytKlienta(klient);
  const odczyty = await odczytajPoKilka(pozycje, async (p) => {
    const zarzadzana = p.tryb === 'zarzadzana';
    const moznaSterowac = p.tryb === 'obserwowana' && p.cena_z_oms === 1;
    let blokada = null;
    if (zarzadzana) blokada = ZARZADZANA;
    else if (!moznaSterowac) blokada = BEZ_STEROWANIA;
    else if (!ustawienia.czynne) blokada = WSTRZYMANE;
    else if (tylkoOdczyt) blokada = TYLKO_ODCZYT;

    // Szkic zarządzany może mieć jeszcze znacznik z OMS zamiast identyfikatora oferty.
    const id = p.produkt_id;
    const adres = /^\d+$/u.test(id) ? `https://allegro.pl/oferta/${id}` : null;
    const odczyt = klient && adres && (!blokada || zarzadzana) ? await odczytAllegro(klient, id) : {};
    return { ...odczyt, adres, blokada: blokada ?? (odczyt.staraGr == null ? BRAK_ODCZYTU : null) };
  });
  pozycje.forEach((p, i) => pokaz(p, odczyty[i]));
}

async function odczytErli(klient, id) {
  try {
    const produkt = await klient.pobierzProdukt(id);
    if (!produkt) return { staraGr: null };
    const zamrozone = zamrozonePola(produkt.frozen);
    let blokada = null;
    // Te same blokady co w pętli ofert: zarchiwizowanego produktu ani zamrożonej ceny OMS nie zmienia.
    if (produkt.archived === true) blokada = 'produkt zarchiwizowany w ERLI — pominięte';
    else if (zamrozone.includes('*') || zamrozone.includes('price'))
      blokada = 'cena zablokowana w ERLI ręczną zmianą — pominięte';
    return { staraGr: cenaDodatnia(produkt.price), nazwa: produkt.name, blokada };
  } catch {
    return { staraGr: null };
  }
}

// Cenę w ERLI zmienia ta sama droga co pętla ofert zarządzanych, więc oferta obserwowana zostaje poza zapisem
// (widoczna w podglądzie z powodem, bez odczytu z ERLI) — także gdy ma flagę ceny z OMS-u.
async function porownajErli(klient, pozycje, ustawienia, pokaz) {
  const tylkoOdczyt = tylkoOdczytKlienta(klient);
  const odczyty = await odczytajPoKilka(pozycje, async (p) => {
    let blokada = null;
    if (p.tryb !== 'zarzadzana') blokada = NIEZARZADZANA_ERLI;
    else if (!ustawienia.czynne) blokada = WSTRZYMANE;
    else if (tylkoOdczyt) blokada = TYLKO_ODCZYT;
    if (blokada) return { blokada };
    const odczyt = klient ? await odczytErli(klient, p.produkt_id) : { staraGr: null };
    return { ...odczyt, blokada: odczyt.blokada ?? (odczyt.staraGr == null ? BRAK_ODCZYTU : null) };
  });
  pozycje.forEach((p, i) => pokaz(p, odczyty[i]));
}

const KARTA_BEZ_OFERTY = 'karta bez oferty w kanałach z wysyłką cen';

const celOferty = (p) => `oferta:${p.produkt_id}`;

// Jak podgląd czyta ceny danego typu kanału. O tym, czy konto w ogóle bierze udział, decyduje umiejętność
// modułu `cenyZOms` — typ bez wpisu tutaj nie ma odczytu cen, więc jest pomijany mimo deklaracji.
const CENY_KANALU = {
  [MODUL_WOO.typ]: {
    progBp: progPotwierdzeniaWooBp,
    pozycje: (lustro) => lustro.filter((p) => p.status_publikacji !== 'draft'),
    cel: (p) => (p.wariant_id ? `wariant:${p.produkt_id}/${p.wariant_id}` : `produkt:${p.produkt_id}`),
    porownaj: (klient, pozycje, { chwila, blokujPromocjeWoo }, pokaz) =>
      porownajWoo(klient, pozycje, chwila, pokaz, blokujPromocjeWoo),
  },
  [MODUL_ALLEGRO.typ]: {
    progBp: (ustawienia) => ustawienia.progPotwierdzeniaBp,
    pozycje: (lustro, rejestr) => {
      const zRejestru = new Set(rejestr.map((p) => p.produkt_id));
      return [...rejestr, ...lustro.filter((p) => !p.wariant_id && !zRejestru.has(p.produkt_id))];
    },
    cel: celOferty,
    porownaj: (klient, pozycje, { ustawienia }, pokaz) => porownajAllegro(klient, pozycje, ustawienia, pokaz),
  },
  [MODUL_ERLI.typ]: {
    progBp: (ustawienia) => ustawienia.progPotwierdzeniaBp,
    // ERLI nie ma lustra produktów — oferty konta są tylko w rejestrze.
    pozycje: (_lustro, rejestr) => rejestr,
    cel: celOferty,
    porownaj: (klient, pozycje, { ustawienia }, pokaz) => porownajErli(klient, pozycje, ustawienia, pokaz),
  },
};

function danePodgladu(db, ids) {
  const wybor = JSON.stringify(ids);
  const karty = db.prepare(
    'SELECT id, nazwa, cena_gr FROM karty_produktow WHERE id IN (SELECT value FROM json_each(?))',
  );
  const lustro = db.prepare(
    `SELECT karta_id, kanal, produkt_id, wariant_id, nazwa, adres, status_publikacji
     FROM produkty_sklepowe WHERE zniknal_at IS NULL AND karta_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
  );
  const tabele = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('oferty_kanalow', 'oferty_ustawienia_kont')")
      .all()
      .map((w) => w.name),
  );
  const rejestr = tabele.has('oferty_kanalow')
    ? db
        .prepare(
          `SELECT o.*, p.nazwa, o.id_zewnetrzne AS produkt_id
         FROM oferty_kanalow o
         LEFT JOIN produkty_sklepowe p ON p.kanal = o.kanal AND p.produkt_id = o.id_zewnetrzne AND p.wariant_id = ''
         WHERE o.karta_id IN (SELECT value FROM json_each(?)) ORDER BY o.id`,
        )
        .all(wybor)
    : [];
  return {
    karty: wedlugId(karty.all(wybor)),
    lustro: Map.groupBy(lustro.all(wybor), (p) => p.kanal),
    rejestr: Map.groupBy(rejestr, (p) => p.kanal),
    reczne: cenyReczneKart(db, ids),
    ustawienia: (klucz) =>
      tabele.has('oferty_ustawienia_kont') ? ustawieniaOfertKonta(db, klucz) : DOMYSLNE_USTAWIENIA_OFERT,
  };
}

/**
 * Podgląd różnic cen dla kont obsługujących ceny z OMS-u. `klienci` to mapa kluczy kont na klientów.
 * `wiersze` to wyłącznie oferty, które można wysłać — z nich liczy się podpis podglądu. Oferty z blokadą
 * i karty bez oferty idą do `pominieteWiersze`, oferty z ceną już równą docelowej do `bezZmianWiersze`;
 * obie listy służą tylko do wyświetlenia, a liczniki to ich długości. Zatwierdzenie woła tę samą funkcję,
 * więc podział na listy jest w obu miejscach taki sam.
 */
export async function podgladCen(
  db,
  kartaIds,
  { definicje, klienci, teraz = () => new Date(), blokujPromocjeWoo = false },
) {
  const ids = [...new Set(kartaIds.map(Number))];
  if (ids.length > LIMIT_KART) throw new Error('zaznacz najwyżej 200 kart');
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Niepoprawny identyfikator karty');
  const wynik = { wiersze: [], bezZmian: 0, pominiete: 0, bezZmianWiersze: [], pominieteWiersze: [] };
  if (!ids.length) return wynik;
  const chwila = typeof teraz === 'function' ? teraz() : teraz;
  const dane = danePodgladu(db, ids);
  const kartyZOfertami = new Set();

  for (const { klucz, typ, etykieta } of definicje) {
    if (!Object.hasOwn(CENY_KANALU, typ) || modulKanalu(typ).umiejetnosci.cenyZOms !== true) continue;
    const kanal = CENY_KANALU[typ];
    const ustawienia = dane.ustawienia(klucz);
    const progBp = kanal.progBp(ustawienia);
    const pozycje = kanal.pozycje(dane.lustro.get(klucz) ?? [], dane.rejestr.get(klucz) ?? []);
    const pokaz = (p, { staraGr = null, blokada, uwagi = [], nazwa = p.nazwa, adres = adresHttp(p.adres) }) => {
      const kartaId = p.karta_id;
      kartyZOfertami.add(kartaId);
      const karta = dane.karty.get(String(kartaId));
      const { grosze: nowaGr, zrodlo } = cenaDlaKanalu({
        kartaGr: karta?.cena_gr,
        narzutBp: ustawienia.narzutBp,
        recznaGr: dane.reczne.get(kartaId)?.get(klucz),
      });
      const cel = kanal.cel(p);
      if (staraGr !== null && staraGr === nowaGr) {
        wynik.bezZmianWiersze.push({
          kartaId,
          kanal: klucz,
          etykietaKanalu: etykieta ?? klucz,
          cel,
          nazwa: nazwa || karta?.nazwa,
          adres,
          staraGr,
        });
        return;
      }
      const pomin = nowaGr === null && (!blokada || blokada === BRAK_ODCZYTU) ? 'karta bez ceny' : blokada;
      const duzaZmiana = !pomin && cenaWymagaPotwierdzenia(staraGr, nowaGr, progBp);
      (pomin ? wynik.pominieteWiersze : wynik.wiersze).push({
        kartaId,
        kanal: klucz,
        etykietaKanalu: etykieta ?? klucz,
        cel,
        nazwa: nazwa || karta?.nazwa,
        adres,
        staraGr,
        nowaGr,
        zrodlo,
        narzutBp: ustawienia.narzutBp,
        roznicaBp: roznicaBp(staraGr, nowaGr),
        uwagi: [...uwagi, ...(pomin ? [pomin] : []), ...(duzaZmiana ? [`duża zmiana > ${progBp / 100}%`] : [])],
        doWyboru: !pomin,
        zaznaczony: !pomin && !duzaZmiana,
        ...(pomin ? { powod: pomin } : {}),
      });
    };

    if (pozycje.length) await kanal.porownaj(klienci[klucz], pozycje, { chwila, ustawienia, blokujPromocjeWoo }, pokaz);
  }
  for (const kartaId of ids.filter((id) => !kartyZOfertami.has(id))) {
    wynik.pominieteWiersze.push({
      kartaId,
      nazwa: dane.karty.get(String(kartaId))?.nazwa ?? `Karta ${kartaId}`,
      adres: `/magazyn/${kartaId}#sprzedaz-kanalow`,
      uwagi: [KARTA_BEZ_OFERTY],
      powod: KARTA_BEZ_OFERTY,
      doWyboru: false,
      zaznaczony: false,
    });
  }
  wynik.bezZmian = wynik.bezZmianWiersze.length;
  wynik.pominiete = wynik.pominieteWiersze.length;
  return wynik;
}
