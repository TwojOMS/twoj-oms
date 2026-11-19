import { importMozeZapisac, polePuste } from '../../../domena/zrodla-pol.js';
import { przejeciaZeSklepu } from '../../../domena/przejecie-sku.js';
import { kartyPoIdach, produktyKart, zajeteSku, nadajSku } from '../../../oms/db/magazyn.js';
import { kolejnoscZrodel } from './kolejnosc-zrodel.js';

// UZUPELNIENIE PUSTEGO SKU KARTY NUMEREM, KTORY JEJ PRODUKT MA JUZ W SKLEPIE.
//
// ⚠️⚠️ TO JEST BARIERA PRZED PIERWSZYM ZAPISEM DO SKLEPU: karta bez naszego numeru dostalaby
// z generatora numer NOWY, a zapis do sklepu nadpisalby nim tozsamosc produktu — cicho. Numer
// w sklepie laduje w adresach, eksportach i feedach; podmieniony nie da sie cofnac przyciskiem.
// Dlatego import przepisuje do karty numer, ktory JUZ ZYJE w sklepie, i niczego nie wymysla.
//
// ⚠️⚠️ KARTA Z SKU NIE DOSTAJE INNEGO NUMERU NIGDY — takze gdy zrodlem pola jest ten sam kanal.
// Regula zrodel pol (`importMozeZapisac`) pozwala nadpisac pole temu samemu zrodlu; dla SKU to
// byloby ciche przenumerowanie produktu. Stad twarde `polePuste` PRZED regula zrodel.
//
// Kolizja (numer ma juz inna karta albo inny produkt) i rozbieznosc (produkty karty maja rozne
// numery) pomijaja JEDNA karte z powodem — reszta kanalu idzie dalej. Wybor za czlowieka bylby
// zgadywaniem tozsamosci produktu.

const opisWlasciciela = (skad) => (String(skad ?? '').startsWith('karta ') ? skad : `produkt ${skad}`);
const kluczNumeru = (sku) =>
  String(sku ?? '')
    .trim()
    .toUpperCase();

/**
 * @param {import('node:sqlite').DatabaseSync} db — wolane WEWNATRZ transakcji importu
 * @param {number[]} idyKart karty dotkniete importem (powtorki i karty z SKU sa odsiewane tutaj)
 * @param {{zrodlo: string, at: string}} opcje `zrodlo` = znacznik zrodla pola (`woo:<kanal>`)
 * @returns {{uzupelniono: number, pominiete: Array<{id: number, nazwa: string, sku: string, powod: string}>}}
 */
export function uzupelnijSkuZImportu(db, idyKart, { zrodlo, at }) {
  const pominiete = [];
  const idy = [...new Set(idyKart ?? [])];
  if (!idy.length) return { uzupelniono: 0, pominiete };

  const kolejnosc = kolejnoscZrodel(db);
  const zrodla = new Map(
    db
      .prepare(`SELECT * FROM karty_zrodla_pol WHERE pole = 'sku' AND karta_id IN (${idy.map(() => '?').join(', ')})`)
      .all(...idy)
      .map((w) => [w.karta_id, w]),
  );
  const karty = kartyPoIdach(db, idy).filter(
    (k) => polePuste('sku', k.sku) && importMozeZapisac('sku', k.sku, zrodla.get(k.id), zrodlo, kolejnosc),
  );
  if (!karty.length) return { uzupelniono: 0, pominiete };

  const idyKandydatow = karty.map((k) => k.id);
  const produkty = produktyKart(db, idyKandydatow);
  const zajete = zajeteSku(db, { pomijajProduktyKart: idyKandydatow });
  const pozycje = przejeciaZeSklepu(karty, produkty, zajete);

  // Numery ze sklepu per karta — do powodu pominiecia (regula oddaje `sku: null` przy kolizji).
  const numery = new Map();
  for (const p of produkty) {
    const sku = String(p.sku_sklepu ?? '').trim();
    if (!sku) continue;
    if (!numery.has(p.karta_id)) numery.set(p.karta_id, []);
    if (!numery.get(p.karta_id).includes(sku)) numery.get(p.karta_id).push(sku);
  }
  const powod = (poz) => {
    const moje = numery.get(poz.id) ?? [];
    if (poz.rodzaj === 'rozbieznosc') {
      return `${poz.nazwa}: produkty mają różne SKU (${moje.join(', ')}) — wpisz właściwe na karcie`;
    }
    const [sku] = moje;
    const skad = zajete.get(kluczNumeru(sku));
    if (skad !== undefined) return `${poz.nazwa}: SKU ${sku} ma już ${opisWlasciciela(skad)}`;
    const inna = pozycje.find(
      (x) => x.id !== poz.id && (numery.get(x.id) ?? []).some((s) => kluczNumeru(s) === kluczNumeru(sku)),
    );
    return `${poz.nazwa}: SKU ${sku} chce też karta „${inna?.nazwa ?? '?'}"`;
  };

  const plan = [];
  for (const poz of pozycje) {
    if (poz.sku) plan.push({ id: poz.id, sku: poz.sku });
    else
      pominiete.push({ id: poz.id, nazwa: poz.nazwa, sku: (numery.get(poz.id) ?? []).join(', '), powod: powod(poz) });
  }
  const { nadane, nieaktualne } = nadajSku(db, plan, { at });
  const oznacz = db.prepare(
    `INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'sku', ?, 0, ?)
    ON CONFLICT (karta_id, pole) DO UPDATE SET zrodlo = excluded.zrodlo, reczne = 0, zmieniono_at = excluded.zmieniono_at`,
  );
  for (const id of nadane) oznacz.run(id, zrodlo, at);
  for (const id of nieaktualne) {
    const poz = pozycje.find((x) => x.id === id);
    pominiete.push({ id, nazwa: poz.nazwa, sku: poz.sku, powod: `${poz.nazwa}: karta dostała SKU w trakcie importu` });
  }
  return { uzupelniono: nadane.length, pominiete };
}
