import { adresKanalu, rodzajKanalu } from '../../domena/kanaly.js';
import { cenaDlaKanalu, kwotaDziesietna } from '../../domena/cena-kanalu.js';
import { cenaPolska, liczbaPolska, zl } from '../../domena/kwoty.js';
import { cenyReczneKarty } from '../../oms/db/ceny-kanalow.js';
import { ustawieniaOfertKonta } from '../../oms/db/oferty-kanalow.ts';
import { sprzedazKartyWedlugKanalu } from '../../oms/db/sprzedaz-kanalow-karty.js';
import { czyKanalObslugujeCeny } from './ceny-kanalow.js';
import { historiaZmianKanalow } from './historia-zmian-kanalow.js';
import { STANY_PO_POLSKU } from './oferty.js';

const liczbaOfert = new Intl.PluralRules('pl');

const stanZLustra = {
  woo(produkt) {
    if (!produkt) return;
    if (produkt.zniknal_at) return 'usunięty ze sklepu';
    return produkt.status_publikacji === 'draft' ? 'szkic w sklepie' : 'w sklepie';
  },
  allegro(produkt, oferta) {
    const publikacja = produkt?.status_publikacji ?? oferta?.odczytStatus;
    if (publikacja === 'ENDED') return 'zakończona';
    if (oferta && !['aktywna', 'nieaktywna'].includes(oferta.stan)) return STANY_PO_POLSKU[oferta.stan];
    if (publikacja === 'ACTIVE') return STANY_PO_POLSKU.aktywna;
    if (publikacja === 'INACTIVE') return STANY_PO_POLSKU.nieaktywna;
    if (publikacja === 'ACTIVATING') return STANY_PO_POLSKU.sprawdzana;
  },
};

// Kilka wierszy Woo w jednej karcie to warianty jednego produktu, nie osobne oferty.
const JEDNOSTKI_ZBIORCZE = { woo: { few: 'warianty', inne: 'wariantów' } };

function stanOferty(typ, produkt, oferta) {
  return stanZLustra[typ]?.(produkt, oferta) ?? STANY_PO_POLSKU[oferta?.stan] ?? 'stan nieznany';
}

function stanKanalu(typ, produkty, oferty) {
  const pozostale = new Map(oferty.map((o) => [o.idZewnetrzne, o]));
  const stany = produkty.map((p) => {
    const oferta = pozostale.get(p.produkt_id);
    pozostale.delete(p.produkt_id);
    return stanOferty(typ, p, oferta);
  });
  for (const oferta of pozostale.values()) stany.push(stanOferty(typ, null, oferta));
  if (stany.length === 1) return stany[0];
  const opis = [...Map.groupBy(stany, (stan) => stan)].map(([stan, wystapienia]) => `${wystapienia.length} ${stan}`);
  const few = liczbaOfert.select(stany.length) === 'few';
  if (JEDNOSTKI_ZBIORCZE[typ]) {
    const warianty = `${stany.length} ${few ? JEDNOSTKI_ZBIORCZE[typ].few : JEDNOSTKI_ZBIORCZE[typ].inne}`;
    return opis.length === 1 ? `${warianty} ${stany[0]}` : `${warianty}: ${opis.join(', ')}`;
  }
  return `${stany.length} ${few ? 'oferty' : 'ofert'}: ${opis.join(', ')}`;
}

const aktywneWLustrze = {
  woo: (p) => !p.zniknal_at && p.status_publikacji !== 'draft',
  allegro: (p) => p.status_publikacji === 'ACTIVE',
};

function cenaKanalu(produkty) {
  const ceny = produkty.map((p) => p.cena_gr).filter((cena) => cena !== null);
  if (!ceny.length) return 'bez ceny';
  const min = Math.min(...ceny);
  const max = Math.max(...ceny);
  const formatMax = cenaPolska(zl(max));
  return min === max ? formatMax : `${cenaPolska(zl(min)).replace(/ zł$/, '')}–${formatMax}`;
}

function cenyDoOkienka(kartaGr, narzutBp, recznaGr) {
  const { grosze, zrodlo } = cenaDlaKanalu({ kartaGr, narzutBp, recznaGr });
  return {
    reczna: zrodlo === 'reczna',
    kwota: grosze === null ? null : cenaPolska(kwotaDziesietna(grosze)),
    narzut: liczbaPolska(narzutBp / 100),
    poleReczne: zrodlo === 'reczna' && grosze !== null ? kwotaDziesietna(grosze).replace('.', ',') : '',
  };
}

export function daneSprzedazyKarty(db, kartaId, produkty, oferty, definicje, adresSklepu) {
  const lustro = Map.groupBy(produkty, (p) => p.kanal);
  const rejestr = Map.groupBy(oferty, (o) => o.kanal);
  const sprzedaz = sprzedazKartyWedlugKanalu(db, kartaId, produkty, oferty);
  const reczneCeny = cenyReczneKarty(db, kartaId);
  const kartaGr = db.prepare('SELECT cena_gr FROM karty_produktow WHERE id = ?').get(kartaId)?.cena_gr;
  const okienka = [];
  for (const kanal of new Set([...lustro.keys(), ...rejestr.keys()])) {
    if (kanal === 'reczne') continue;
    const zLustra = lustro.get(kanal) ?? [];
    const zRejestru = rejestr.get(kanal) ?? [];
    const rodzaj = rodzajKanalu(kanal, definicje);
    const cenaDocelowa = czyKanalObslugujeCeny(rodzaj, zRejestru)
      ? cenyDoOkienka(kartaGr, ustawieniaOfertKonta(db, kanal).narzutBp, reczneCeny.get(kanal))
      : null;
    // Kanał bez lustra (ERLI) nie ma odczytanej ceny — „bez ceny” sugerowałoby, że w kanale jej nie ma.
    const odczytanaCena = zLustra.length ? cenaKanalu(zLustra) : null;
    okienka.push({
      kanal,
      nazwa: adresKanalu(kanal, definicje),
      rodzaj,
      adres:
        [...zLustra.filter((p) => aktywneWLustrze[rodzaj?.klucz]?.(p)), ...zLustra]
          .map((p) => adresSklepu(p.adres))
          .find(Boolean) ?? null,
      stan: stanKanalu(rodzaj?.klucz, zLustra, zRejestru),
      cena: odczytanaCena === cenaDocelowa?.kwota ? null : odczytanaCena,
      cenaDocelowa,
      ...(sprzedaz.get(kanal) ?? { lacznie: 0, ostatnie30Dni: 0 }),
    });
  }
  const reczne = sprzedaz.get('reczne');
  if (reczne?.lacznie > 0) okienka.push({ nazwa: 'Zamówienia ręczne', ...reczne });
  // Historia jedzie z okienkami, bo widok sekcji dostaje tylko tę tablicę.
  okienka.historia = historiaZmianKanalow(db, kartaId, definicje);
  return okienka;
}
