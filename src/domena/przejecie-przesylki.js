// `PENDING` oznacza rejestrację, nie przekazanie paczki. Nieznany kod też nie
// może zamykać oczekiwania; API może dodać nowe stany bez uprzedzenia.
export const PRZEJETE_ALLEGRO = new Set([
  'IN_TRANSIT', 'RELEASED_FOR_DELIVERY', 'AVAILABLE_FOR_PICKUP', 'DELIVERED',
]);
export const PRZEJETE_DPD = new Map([
  ['przyjęcie przesyłki w oddziale dpd', 'PRZYJECIE_W_ODDZIALE'],
  ['przesyłka odebrana przez kuriera', 'ODEBRANA_PRZEZ_KURIERA'],
  ['przesyłka doręczona', 'DORECZONA'],
]);

export function dowodPrzejecia({ zrodlo, zdarzenia }) {
  if (!Array.isArray(zdarzenia)) return null;
  if (zrodlo === 'allegro') {
    const znalezione = zdarzenia.filter((z) => PRZEJETE_ALLEGRO.has(z?.code))
      .sort((a, b) => String(a?.occurredAt ?? '').localeCompare(String(b?.occurredAt ?? '')));
    if (!znalezione.length) return null;
    const z = znalezione[0];
    return { zrodlo, kod: z.code, zdarzenieAt: z.occurredAt ?? null };
  }
  if (zrodlo === 'dpd') {
    const znalezione = zdarzenia.filter((z) => PRZEJETE_DPD.has(String(z?.opis ?? '').trim().toLowerCase()))
      .sort((a, b) => String(a?.at ?? '').localeCompare(String(b?.at ?? '')));
    if (!znalezione.length) return null;
    const z = znalezione[0];
    return { zrodlo, kod: PRZEJETE_DPD.get(z.opis.trim().toLowerCase()), zdarzenieAt: z.at ?? null };
  }
  return null;
}
