// Jedno źródło warunków, przy których pętla ofert Allegro pomija konto — pętla i karta produktu biorą je stąd,
// żeby zdanie „na co czeka oferta” nie rozjechało się z tym, co pętla naprawdę robi.
import { fmtDataCzasKrotko } from './format-daty.js';

/**
 * Powód, dla którego pętla ofert Allegro nie zapisze nic na tym koncie; `null` = konto gotowe.
 * Kolejność ma znaczenie: brak zgody blokuje wszystko, więc wygrywa z wstrzymaniem, a wstrzymanie z blokadą zapisu.
 * @param {{ zgoda?: boolean, tylkoOdczyt?: () => boolean } | null | undefined} konto
 * @param {{ czynne?: boolean } | null | undefined} ustawienia — ustawienia ofert konta
 * @returns {'brak_zgody' | 'wstrzymane' | 'zablokowane' | null}
 */
export function powodCzekaniaOferty(konto, ustawienia) {
  if (!konto?.zgoda) return 'brak_zgody';
  if (!ustawienia?.czynne) return 'wstrzymane';
  if (konto.tylkoOdczyt?.()) return 'zablokowane';
  return null;
}

const nazwaKonta = (konto) => konto?.nazwa || konto?.klucz || '';

/** Oferta, której pętla jeszcze nie wysłała: nowa albo szkic ze zleconą aktywacją. */
const czeka = (oferta) =>
  oferta?.stan === 'do_wyslania' || (oferta?.stan === 'nieaktywna' && oferta?.wyslanePola?.aktywuj === true);

/**
 * Jedno zdanie pod „Stan:” oferty, która jeszcze nie wyszła — pierwszy pasujący powód; `null`, gdy oferta już
 * wyszła (wtedy jest w kanale i nie czeka na nic po stronie OMS-u).
 * Pętla ERLI nie ma warunków konta, więc dla ERLI zostaje tylko termin próby albo zdanie domyślne.
 * @param {{
 *   rodzaj: 'allegro' | 'erli',
 *   konto: { klucz: string, nazwa?: string | null, zgoda?: boolean, tylkoOdczyt?: () => boolean } | null,
 *   ustawienia: { czynne?: boolean } | null,
 *   oferta: { stan: string, nastepnaProbaAt?: string | null, wyslanePola?: { aktywuj?: boolean } | null },
 *   teraz: number,
 * }} dane
 * @returns {{ kod: string, tekst: string, krok: string | null } | null} `krok` — adres kroku Oferty konta
 */
export function zdanieCzekaniaOferty({ rodzaj, konto, ustawienia, oferta, teraz }) {
  if (!czeka(oferta)) return null;
  const nazwa = nazwaKonta(konto);
  const powod = rodzaj === 'allegro' ? powodCzekaniaOferty(konto, ustawienia) : null;
  if (powod === 'brak_zgody')
    return {
      kod: powod,
      tekst: `Czeka: konto ${nazwa} nie ma zgody na zapis ofert — połącz je ponownie w Ustawieniach → Integracje.`,
      krok: null,
    };
  if (powod === 'wstrzymane')
    return {
      kod: powod,
      tekst: `Czeka: konto ${nazwa} ma oferty wstrzymane — nic nie wyjdzie do Allegro, dopóki nie włączysz „Oferty: czynne” w kroku Oferty konta.`,
      krok: `/ustawienia/integracje/allegro/${encodeURIComponent(konto?.klucz ?? '')}/oferty#allegro-oferty-ustawienia`,
    };
  if (powod === 'zablokowane')
    return {
      kod: powod,
      tekst: `Czeka: zapisy do konta ${nazwa} są zablokowane (Ustawienia → Integracje).`,
      krok: null,
    };
  const proba = oferta.nastepnaProbaAt ? Date.parse(oferta.nastepnaProbaAt) : NaN;
  if (proba > teraz) {
    const kiedy = fmtDataCzasKrotko(oferta.nastepnaProbaAt).replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3.$2.$1');
    return { kod: 'nastepna_proba', tekst: `Następna próba: ${kiedy}.`, krok: null };
  }
  return { kod: 'domyslne', tekst: 'Czeka na wysłanie — OMS wysyła oferty co 5 minut.', krok: null };
}

/**
 * Nagłówek oferty na karcie: kanał i nazwa konta, a numer oferty dopiero, gdy kanał go nadał. Wewnętrzny
 * `ext:…` OMS-u nie jest numerem oferty, a klucz konta nic człowiekowi nie mówi.
 * @param {{
 *   rodzaj: 'allegro' | 'erli' | null,
 *   konto: { klucz: string, nazwa?: string | null } | null,
 *   oferta: { kanal?: string, idZewnetrzne?: string | null, stan?: string },
 * }} dane
 */
export function naglowekOferty({ rodzaj, konto, oferta }) {
  const numer = String(oferta?.idZewnetrzne ?? '');
  // Allegro nadaje numer dopiero po wysłaniu (do tego czasu `ext:`); numer ERLI zna OMS, ale przed wysłaniem
  // oferty jeszcze nie ma w sklepie.
  const wyslana = rodzaj === 'erli' ? oferta?.stan !== 'do_wyslania' : numer !== '' && !numer.startsWith('ext:');
  const kanal = rodzaj === 'allegro' ? 'Allegro' : rodzaj === 'erli' ? 'ERLI' : null;
  const czesci = kanal ? [kanal, nazwaKonta(konto)] : [oferta?.kanal ?? ''];
  if (wyslana && numer) czesci.push(`oferta ${numer}`);
  return czesci.join(' · ');
}
