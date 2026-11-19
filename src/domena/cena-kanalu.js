import { zlotowki } from './kwoty.js';

// Cena w kanale = cena brutto karty powiększona o narzut konta (D45, wspólne dla ERLI i Allegro).
// Komunikaty zostają w kanałach — tu tylko kody: 'cena', 'narzut', 'zakres'.

// Cena sprzedaży ma sens tylko dodatnia: od zera albo minusa nie da się policzyć oferty w kanale.
// Ta sama reguła pilnuje zapisu ceny z listy magazynu, żeby lista nie przyjęła ceny, której kanał nie przyjmie.
export const cenaDodatnia = (cenaGr) => Number.isSafeInteger(cenaGr) && cenaGr > 0;

/**
 * @param {number} cenaGr cena brutto karty w groszach (całkowita, > 0)
 * @param {number} narzutBp narzut w punktach bazowych (całkowity, ≥ 0; 1250 = 12,5%)
 * @returns {{ bledy: string[], grosze: number | null }}
 */
export function cenaZNarzutem(cenaGr, narzutBp) {
  const bledy = [];
  if (!cenaDodatnia(cenaGr)) bledy.push('cena');
  if (!Number.isSafeInteger(narzutBp) || narzutBp < 0) bledy.push('narzut');
  if (bledy.length) return { bledy, grosze: null };
  // BigInt zachowuje dokładność mnożenia także powyżej zakresu Number.
  // Dodanie połowy dzielnika daje zaokrąglenie połówką w górę.
  const grosze = (BigInt(cenaGr) * (10000n + BigInt(narzutBp)) + 5000n) / 10000n;
  if (grosze > BigInt(Number.MAX_SAFE_INTEGER)) return { bledy: ['zakres'], grosze: null };
  return { bledy: [], grosze: Number(grosze) };
}

/** Grosze → „<zł>.<gr>” (6638 → "66.38"), zapis kwoty Allegro `sellingMode.price.amount`. */
export function kwotaDziesietna(grosze) {
  const g = BigInt(grosze);
  return `${g / 100n}.${String(g % 100n).padStart(2, '0')}`;
}

/**
 * Jedyne źródło ceny docelowej oferty w kanale: ręczna cena kanału albo cena karty z narzutem konta.
 * Błędna ręczna cena jest błędem `reczna` — ciche przejście na narzut wysłałoby inną cenę, niż ustawił sprzedawca.
 * @param {{ kartaGr: number, narzutBp: number, recznaGr?: number | null }} dane
 * @returns {{ bledy: string[], grosze: number | null, zrodlo: 'reczna' | 'narzut' }}
 */
export function cenaDlaKanalu({ kartaGr, narzutBp, recznaGr = null }) {
  if (recznaGr !== null && recznaGr !== undefined) {
    if (!Number.isSafeInteger(recznaGr) || recznaGr <= 0) return { bledy: ['reczna'], grosze: null, zrodlo: 'reczna' };
    return { bledy: [], grosze: recznaGr, zrodlo: 'reczna' };
  }
  return { ...cenaZNarzutem(kartaGr, narzutBp), zrodlo: 'narzut' };
}

/**
 * Różnica nowej ceny względem starej w punktach bazowych (1000 = +10%), zaokrąglona połówką od zera.
 * Liczona na BigInt, żeby kolumna „różnica %” nie zależała od błędów float. Bez dodatnich cen całkowitych → null.
 */
export function roznicaBp(staraGr, nowaGr) {
  if (!Number.isSafeInteger(staraGr) || staraGr <= 0 || !Number.isSafeInteger(nowaGr) || nowaGr <= 0) return null;
  const licznik = (BigInt(nowaGr) - BigInt(staraGr)) * 10000n;
  const mianownik = BigInt(staraGr);
  const modul = ((licznik < 0n ? -licznik : licznik) * 2n + mianownik) / (2n * mianownik);
  // Bez -0: Object.is(-0, 0) jest fałszem, a „-0 bp” na ekranie myli.
  return licznik < 0n && modul > 0n ? -Number(modul) : Number(modul);
}

/**
 * Czy ceny w sklepie Woo są brutto (porównywalne z ceną karty). Sklep bez podatków albo z cenami
 * „z podatkiem” — tak; sklep liczący VAT od cen netto albo bez potwierdzenia ustawienia — nie.
 * Ta sama reguła dla odczytu lustra i podglądu cen, żeby ocena „sklep netto” się nie rozjechała.
 */
export function cenyBruttoSklepu(liczyPodatki, cenyBrutto) {
  return liczyPodatki === 'no' || cenyBrutto === 'yes' || cenyBrutto === true;
}

const kwotaDoRachunku = (gr) => `${gr < 0n ? '−' : ''}${zlotowki(kwotaDziesietna(gr < 0n ? -gr : gr))}`;

/**
 * @param {{ gr: number | null, tryb: 'o_procent' | 'na_kwote' | 'o_kwote', wartosc: number,
 *   zaokraglenie?: 'grosz' | '99' | 'zloty' }} zmiana Cena i kwoty w groszach, procent w punktach bazowych.
 */
export function cenaPoZmianie({ gr, tryb, wartosc, zaokraglenie = 'grosz' }) {
  if (tryb !== 'na_kwote' && (gr === null || gr === 0)) return { pominieta: true };
  if (tryb === 'o_procent' && (!Number.isInteger(wartosc) || wartosc < -9900 || wartosc > 100000)) {
    return { blad: 'PROCENT_POZA_ZAKRESEM' };
  }

  const zmiana = BigInt(wartosc);
  let wynik = zmiana;
  if (tryb === 'o_kwote') wynik = BigInt(gr) + zmiana;
  if (tryb === 'o_procent') wynik = (BigInt(gr) * (10000n + zmiana) + 5000n) / 10000n;

  // Końcówka 99 nie może zmienić niedodatniego wyniku w poprawną cenę.
  if (wynik <= 0n) {
    const koniec = kwotaDoRachunku(wynik);
    if (tryb === 'na_kwote') return { blad: 'CENA_NIEDODATNIA', rachunek: koniec };

    const cena = kwotaDoRachunku(BigInt(gr));
    const znak = zmiana < 0n ? '−' : '+';
    const wartoscBezwzgledna = zmiana < 0n ? -zmiana : zmiana;
    const dzialanie =
      tryb === 'o_procent'
        ? `${cena} × (100% ${znak} ${kwotaDziesietna(wartoscBezwzgledna).replace('.', ',')}%)`
        : `${cena} ${znak} ${kwotaDoRachunku(wartoscBezwzgledna)}`;
    return { blad: 'CENA_NIEDODATNIA', rachunek: `${dzialanie} = ${koniec}` };
  }

  let zaokraglony = wynik;
  if (tryb !== 'na_kwote') {
    if (zaokraglenie === '99') zaokraglony = (wynik / 100n) * 100n + 99n;
    if (zaokraglenie === 'zloty') zaokraglony = ((wynik + 50n) / 100n) * 100n;
  }
  if (zaokraglony === 0n) {
    return { blad: 'CENA_NIEDODATNIA', rachunek: `${kwotaDoRachunku(wynik)} → ${kwotaDoRachunku(zaokraglony)}` };
  }
  if (zaokraglony > BigInt(Number.MAX_SAFE_INTEGER)) return { blad: 'CENA_POZA_ZAKRESEM' };
  return { gr: Number(zaokraglony) };
}
