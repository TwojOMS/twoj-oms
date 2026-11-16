// Prowizja Allegro w podglądzie „Wystaw na…”. Informacja, nie bramka: odmowa albo brak
// odpowiedzi nie blokuje podglądu ani zatwierdzenia. Najwyżej 20 pierwszych kart bez błędów, po 2 zapytania naraz,
// razem do 20 s; pamięć (konto, kategoria, cena) na 10 min. Reszta kart: „prowizji nie policzono — zawęź wybór”.

export const PROWIZJA_NIE_POLICZONO = 'prowizji nie policzono — zawęź wybór';
export const PROWIZJA_NIEDOSTEPNA = 'prowizja niedostępna';
export const LIMIT_KART_PROWIZJI = 20;
const ROWNOLEGLE = 2;
const PAMIEC_MS = 10 * 60_000;
const LIMIT_MS = 20_000;

/** Suma `commissions[].fee.amount` w groszach → „19,00 zł”; brak prowizji w odpowiedzi = niedostępna. */
function kwotaProwizji(odpowiedz) {
  const prowizje = Array.isArray(odpowiedz?.commissions) ? odpowiedz.commissions : [];
  const kwoty = prowizje.map(p => Number(p?.fee?.amount)).filter(Number.isFinite);
  if (!kwoty.length) return null;
  const grosze = kwoty.reduce((s, k) => s + Math.round(k * 100), 0);
  return `${(grosze / 100).toFixed(2).replace('.', ',')} zł`;
}

/**
 * @param {{teraz?: () => number, limitMs?: number}} [opcje]
 */
export function createOplatyAllegro({ teraz = () => Date.now(), limitMs = LIMIT_MS } = {}) {
  /** @type {Map<string, {tekst: string, do: number}>} — tylko udane odpowiedzi */
  const pamiec = new Map();

  /**
   * Dopisuje `allegro.prowizja` wierszom podglądu. Wiersz z błędami (bez zadania) nie dostaje prowizji.
   * @param {{klucz: string, klient?: {podgladOplat?: (oferta: object) => Promise<any>}}} konto
   * @param {Array<{bledy: string[], zadanie?: any, allegro?: {prowizja?: string|null}}>} wiersze
   */
  async function prowizje(konto, wiersze) {
    // Wpisy po terminie wypadają przy każdym podglądzie — pamięć nie rośnie z każdą nową ceną.
    for (const [klucz, zapis] of pamiec) if (zapis.do <= teraz()) pamiec.delete(klucz);
    const doLiczenia = wiersze.filter(w => !w.bledy.length && w.zadanie && w.allegro);
    const wybrane = doLiczenia.slice(0, LIMIT_KART_PROWIZJI);
    for (const w of doLiczenia.slice(LIMIT_KART_PROWIZJI)) w.allegro.prowizja = PROWIZJA_NIE_POLICZONO;
    for (const w of wybrane) w.allegro.prowizja = PROWIZJA_NIE_POLICZONO;
    const zapytaj = typeof konto.klient?.podgladOplat === 'function' ? konto.klient.podgladOplat.bind(konto.klient) : null;
    if (!zapytaj) { for (const w of wybrane) w.allegro.prowizja = PROWIZJA_NIEDOSTEPNA; return; }

    // Jedno zapytanie na (konto, kategoria, cena) — także w jednym podglądzie.
    const grupy = new Map();
    for (const w of wybrane) {
      const oferta = { category: w.zadanie.category, sellingMode: w.zadanie.sellingMode };
      const klucz = `${konto.klucz}\u0000${oferta.category?.id ?? ''}\u0000${oferta.sellingMode?.price?.amount ?? ''}`;
      if (!grupy.has(klucz)) grupy.set(klucz, { oferta, wiersze: [] });
      grupy.get(klucz).wiersze.push(w);
    }
    const kolejka = [];
    for (const [klucz, g] of grupy) {
      const zapis = pamiec.get(klucz);
      if (zapis && zapis.do > teraz()) { for (const w of g.wiersze) w.allegro.prowizja = zapis.tekst; continue; }
      kolejka.push([klucz, g]);
    }
    let przerwano = false;
    const pracownik = async () => {
      while (kolejka.length && !przerwano) {
        const [klucz, g] = kolejka.shift();
        let tekst = PROWIZJA_NIEDOSTEPNA;
        try {
          const kwota = kwotaProwizji(await zapytaj(g.oferta));
          if (kwota) { tekst = kwota; pamiec.set(klucz, { tekst, do: teraz() + PAMIEC_MS }); }
        } catch { tekst = PROWIZJA_NIEDOSTEPNA; }
        if (!przerwano) for (const w of g.wiersze) w.allegro.prowizja = tekst;
      }
    };
    let zegar;
    const limit = new Promise(r => { zegar = setTimeout(() => { przerwano = true; r(); }, limitMs); zegar.unref?.(); });
    try {
      await Promise.race([Promise.all(Array.from({ length: ROWNOLEGLE }, pracownik)), limit]);
    } finally { clearTimeout(zegar); }
  }

  return { prowizje, rozmiarPamieci: () => pamiec.size };
}
