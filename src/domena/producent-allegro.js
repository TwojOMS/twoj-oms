// Producent Allegro (GPSR) dla oferty z karty: kto trafia do `responsibleProducer`/`responsiblePerson`
// i jaki błąd widzi człowiek. Czysta funkcja — oferta i karta muszą liczyć to tak samo.
const napis = (w) => (typeof w === 'string' ? w.trim() : w == null ? '' : String(w).trim());

/**
 * @param {{marka: string, droga: string, przypisanie?: {zrodlo?: string, producentId?: unknown,
 *   osobaOdpowiedzialnaId?: unknown} | null, ustawienia: {producentId?: unknown, osobaOdpowiedzialnaId?: unknown},
 *   nazwaKonta: string}} wejscie
 * @returns {{zrodlo: 'konto'|'marka'|'katalog'|'brak', responsibleProducer?: {type: 'ID', id: string},
 *   responsiblePerson?: {id: string}, blad?: string}}
 */
export function producentAllegro({ marka, droga, przypisanie, ustawienia, nazwaKonta }) {
  const producentKonta = () => {
    if (!napis(ustawienia.producentId))
      return /** @type {const} */ ({
        zrodlo: 'brak',
        blad: `Ustaw producenta konta ${nazwaKonta} (krok Oferty w konfiguratorze konta).`,
      });
    /** @type {ReturnType<typeof producentAllegro>} */
    const wynik = { zrodlo: 'konto', responsibleProducer: { type: 'ID', id: napis(ustawienia.producentId) } };
    if (napis(ustawienia.osobaOdpowiedzialnaId))
      wynik.responsiblePerson = { id: napis(ustawienia.osobaOdpowiedzialnaId) };
    return wynik;
  };
  if (przypisanie?.zrodlo === 'konto') return producentKonta();
  if (przypisanie?.zrodlo === 'wybrany' && napis(przypisanie.producentId)) {
    /** @type {ReturnType<typeof producentAllegro>} */
    const wynik = { zrodlo: 'marka', responsibleProducer: { type: 'ID', id: napis(przypisanie.producentId) } };
    if (napis(przypisanie.osobaOdpowiedzialnaId))
      wynik.responsiblePerson = { id: napis(przypisanie.osobaOdpowiedzialnaId) };
    return wynik;
  }
  // Bez przypisania pole pomijamy — Allegro bierze dane GPSR z produktu.
  if (droga === 'katalog-id') return { zrodlo: 'katalog' };
  if (!marka) return producentKonta();
  return {
    zrodlo: 'brak',
    blad: `Przypisz producenta marki ${marka} na koncie ${nazwaKonta} (Ustawienia → Integracje → Moje połączenia, przy koncie Allegro → krok Oferty).`,
  };
}
