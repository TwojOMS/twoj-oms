import { odswiezStatusKuriera, probaPrzesylkiWymagana } from './status-kuriera.js';

// Krótki przebieg co 10 min. Paczki po 14 dniach pozostają w selekcji, ale ich
// wspólny dławik pozwala na odczyt najwyżej raz na dobę. Sufit chroni API przy
// większym historycznym ogonie; najdawniej sprawdzane idą pierwsze.
export function createCzuwaczPodjazdow({ db, podjazdy, kurierzy = {}, teraz = () => new Date() }) {
  let trwa = false;
  async function przebieg() {
    if (trwa) return { pominiety: true };
    trwa = true;
    try {
      const chwila = teraz();
      const zlecenia = db.prepare(`SELECT id FROM podjazdy
        WHERE stan IN ('zarezerwowany','oczekuje','nieznany')
          AND (nastepne_sprawdzenie_at IS NULL OR nastepne_sprawdzenie_at <= ?)
        ORDER BY COALESCE(ostatnia_proba_at, utworzony_at), id LIMIT 50`).all(chwila.toISOString());
      let bledy = 0;
      for (const z of zlecenia) {
        try { await podjazdy.sprawdz({ id: z.id }); }
        catch { bledy += 1; }
      }
      const paczki = db.prepare(`SELECT p.*, z.sklep FROM przesylki p
        JOIN zamowienia z ON z.id=p.zamowienie_id
        WHERE p.kurier='allegro_wza' AND p.status='nadana'
          AND p.przejeta_at IS NULL AND p.numer_listu IS NOT NULL
        ORDER BY COALESCE(p.status_kuriera_pobrany_at, p.utworzona_at), p.id LIMIT 100`).all();
      let sprawdzone = 0;
      for (const p of paczki) {
        if (!probaPrzesylkiWymagana(p, chwila.getTime())) continue;
        const wynik = await odswiezStatusKuriera(db, kurierzy,
          { id: p.zamowienie_id, sklep: p.sklep }, p, { terazMs: chwila.getTime() });
        if (wynik?.ok) sprawdzone += 1;
        if (wynik?.blad) bledy += 1;
      }
      return { zlecenia: zlecenia.length, paczki: paczki.length, sprawdzone, bledy };
    } finally { trwa = false; }
  }
  return { przebieg };
}
