import { wstawOferte, ofertaPoIdZewnetrznym, zmienOferte, ofertaPoId } from '../../../oms/db/oferty-kanalow.ts';
import { propozycjePrzejecia, transakcjaOfert } from './przejecie-ofert-erli.js';
import { zamrozonePola } from './petla-ofert.js';
import { STATUSY_WOO_BEZ_ROZCHODU } from '../../../domena/stany-magazynowe.js';
import { migawkaStanow } from '../../../oms/db/stany-magazynowe.js';

// Ten sam odczyt co pętla ERLI: `true` = wszystko zamrożone, obiekt = klucze z prawdziwą wartością.
export const zamrozonyStock = z => { const l = zamrozonePola(z); return l.includes('*') || l.includes('stock'); };

// Zmierzone na API: `isFulfillment` boolean na elemencie LISTY /sale/offers; szczegóły oferty go nie mają.
// `features` nie występuje — zostaje jako tolerancja. Bez żadnego pola liczba = null (brak odczytu, nie 0).
export function policzFulfillment(oferty) {
  const flaga = o => o?.isFulfillment ?? o?.features?.isFulfillment;
  if (!oferty.some(o => typeof flaga(o) === 'boolean')) return { liczba: null, ids: new Set() };
  const ids = new Set(oferty.filter(o => flaga(o) === true).map(o => String(o.id)));
  return { liczba: ids.size, ids };
}

// Skutek objęcia dla jednej oferty Allegro: wznowienie, zakończenie przy 0, fulfillment.
export function skutekObjecia(typ, o, ilosc, fulfillmentIds = new Set()) {
  if (typ !== 'allegro') return '';
  if (fulfillmentIds.has(String(o.idZewnetrzne))) return 'Fulfillment — ilość niezmienialna.';
  if (o.odczytStatus === 'ENDED' && ilosc > 0) return 'Zostanie wznowiona (możliwa opłata).';
  if (o.odczytStatus === 'ACTIVE' && ilosc === 0) return 'Zostanie zakończona.';
  return '';
}

// Pozycje ERLI od granicy, które po przejęciu zaczną zdejmować stan karty.
export function roznicaStanuErli(db, kanal, wiersze) {
  const przejmowane = wiersze.filter(w => w.kartaId && ['active', 'inactive'].includes(w.stan));
  if (!przejmowane.length) return [];
  const migawka = migawkaStanow(db);
  if (!migawka.wlaczone) return [];
  const sumy = new Map(db.prepare(`SELECT p.oferta_id, SUM(p.ilosc) AS suma FROM pozycje p JOIN zamowienia z ON z.id = p.zamowienie_id
    WHERE z.sklep = ? AND julianday(z.utworzone_at) >= julianday(?) AND z.pozycje_reczne_json IS NULL
      AND COALESCE(z.anulowane, 0) = 0 AND COALESCE(z.anulowane_recznie, 0) = 0
      AND COALESCE(z.status_woo, '') NOT IN (SELECT value FROM json_each(?))
      AND p.ilosc > 0 AND p.oferta_id IN (SELECT value FROM json_each(?)) GROUP BY p.oferta_id`)
    .all(kanal, migawka.granica, JSON.stringify(STATUSY_WOO_BEZ_ROZCHODU), JSON.stringify(przejmowane.map(w => String(w.idZewnetrzne))))
    .map(r => [r.oferta_id, Number(r.suma)]));
  const poKartach = new Map();
  for (const w of przejmowane) {
    const ile = sumy.get(String(w.idZewnetrzne)) ?? 0;
    if (ile > 0) poKartach.set(Number(w.kartaId), (poKartach.get(Number(w.kartaId)) ?? 0) + ile);
  }
  return [...poKartach].map(([kartaId, ile]) => {
    const przed = migawka.stany.get(kartaId)?.stan ?? 0;
    return { kartaId, przed, po: przed - ile };
  });
}

// Lustro nie przechowuje backorders ani isFulfillment. Odczyt dodatkowy tylko na żądanie podglądu.
export async function odczytajOstrzezenia(db, konto, { sklepy = {}, kontaAllegro = () => [] }) {
  if (konto.typ === 'allegro') {
    const klient = kontaAllegro().find(k => k.klucz === konto.klucz)?.klient;
    if (!klient?.pobierzOferty) return { fulfillment: null, fulfillmentIds: new Set(), backorders: null };
    const oferty = await klient.pobierzOferty();
    if (!Array.isArray(oferty)) throw new Error('Niepoprawna lista Allegro.');
    const { liczba, ids } = policzFulfillment(oferty);
    return { fulfillment: liczba, fulfillmentIds: ids, backorders: null };
  }
  if (konto.typ === 'woo') {
    const klient = sklepy[konto.klucz];
    if (!klient?.pobierzStany || !klient?.pobierzStanyWariantow) return { fulfillment: null, fulfillmentIds: new Set(), backorders: null };
    const wiersze = db.prepare('SELECT produkt_id, wariant_id FROM produkty_sklepowe WHERE kanal = ? AND zniknal_at IS NULL AND stan_prowadzony = \'tak\' AND karta_id IS NOT NULL').all(konto.klucz);
    const grupy = new Map();
    for (const w of wiersze) {
      const rodzic = w.wariant_id ? w.produkt_id : null;
      if (!grupy.has(rodzic)) grupy.set(rodzic, []);
      grupy.get(rodzic).push(w.wariant_id || w.produkt_id);
    }
    let backorders = 0;
    for (const [rodzic, ids] of grupy) {
      const produkty = rodzic === null ? await klient.pobierzStany(ids) : await klient.pobierzStanyWariantow(rodzic, ids);
      if (!Array.isArray(produkty)) throw new Error('Niepoprawna lista Woo.');
      backorders += produkty.filter(p => p.backorders != null && p.backorders !== 'no').length;
    }
    return { fulfillment: null, fulfillmentIds: new Set(), backorders };
  }
  return { fulfillment: null, fulfillmentIds: new Set(), backorders: null };
}

export function podgladPrzejecia(db, kanal, typ, produkty = [], odczytaneAt = null) {
  const lustro = db.prepare('SELECT p.*, k.nazwa AS karta_nazwa FROM produkty_sklepowe p LEFT JOIN karty_produktow k ON k.id = p.karta_id WHERE p.kanal = ? AND p.zniknal_at IS NULL ORDER BY p.id').all(kanal);
  let bezStanow = 0;
  const wiersze = typ === 'erli' ? propozycjePrzejecia(db, kanal, produkty).map(({ produkt: p, karta }) => ({
    idZewnetrzne: p.externalId, kartaId: karta?.id ?? null, nazwa: p.name ?? p.externalId,
    stan: p.status, ilosc: p.stock ?? null, zamrozone: p.frozen ?? null, odczytaneAt,
  })) : lustro.filter(p => {
    if (typ === 'woo' && p.stan_prowadzony !== 'tak') { bezStanow++; return false; }
    return true;
  }).map(p => ({ idZewnetrzne: p.wariant_id ? `${p.produkt_id}/${p.wariant_id}` : p.produkt_id,
    kartaId: p.karta_nazwa ? p.karta_id : null, nazwa: p.nazwa, stan: p.status_publikacji,
    ilosc: p.ilosc_kanalu, odczytaneAt: p.ilosc_odczytana_at ?? p.odczytane_at, zamrozone: null }));
  return { wiersze, bezStanow, bezKarty: wiersze.filter(w => !w.kartaId).length,
    stare: typ !== 'erli' && (!lustro.length || lustro.some(p => !p.odczytane_at || Date.now() - Date.parse(p.odczytane_at) > 30 * 60_000)),
    zakonczone: wiersze.filter(w => w.stan === 'ENDED').length };
}

export function przejmijStany(db, kanal, typ, produkty = [], odczytaneAt = null) {
  return transakcjaOfert(db, () => {
    const plan = podgladPrzejecia(db, kanal, typ, produkty, odczytaneAt);
    let przejeto = 0;
    for (const w of plan.wiersze) {
      if (!w.kartaId) continue;
      if (typ === 'erli' && !['active', 'inactive'].includes(w.stan)) continue;
      if (ofertaPoIdZewnetrznym(db, kanal, w.idZewnetrzne)) continue;
      const o = wstawOferte(db, { kartaId: Number(w.kartaId), kanal, idZewnetrzne: w.idZewnetrzne,
        pochodzenie: 'przejeta', tryb: 'obserwowana', stan: ['ENDED', 'inactive'].includes(w.stan) ? 'nieaktywna' : 'aktywna' });
      zmienOferte(db, o.id, { odczytIloscKanalu: Number.isInteger(w.ilosc) ? w.ilosc : null,
        odczytIlosc: Number.isInteger(w.ilosc) && w.ilosc >= 0 ? w.ilosc : null,
        odczytStatus: w.stan ?? null, odczytZamrozone: zamrozonePola(w.zamrozone).length ? zamrozonePola(w.zamrozone) : null, odczytanoAt: w.odczytaneAt ?? new Date().toISOString() });
      przejeto++;
    }
    return { przejeto };
  });
}

export function obejmijStany(db, kanal, ids, typ = null) {
  return transakcjaOfert(db, () => {
    const oferty = [...new Set(ids)].map(id => ofertaPoId(db, Number(id)));
    for (const o of oferty) {
      if (!o || o.kanal !== kanal || o.pochodzenie !== 'przejeta') throw new Error('Oferta nie należy do tego konta lub nie jest przejęta.');
      if (zamrozonyStock(o.odczytZamrozone)) throw new Error('ERLI: zamrożony stock — odmowa objęcia.');
      const [produkt, wariant = ''] = o.idZewnetrzne.split('/');
      const p = db.prepare('SELECT karta_id, stan_prowadzony FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ? AND wariant_id = ? AND zniknal_at IS NULL').get(kanal, produkt, wariant);
      if (typ === 'woo' && p?.stan_prowadzony !== 'tak') throw new Error('Sklep nie prowadzi własnego stanu tej oferty.');
      if (typ === 'allegro' && !p) throw new Error('Oferta zniknęła z lustra. Odczytaj katalogi.');
      if (p && p.karta_id !== o.kartaId) throw new Error('Powiązanie oferty zmieniło się. Odczytaj podgląd ponownie.');
    }
    for (const o of oferty) zmienOferte(db, o.id, { iloscZOms: true });
    return oferty.length;
  });
}
