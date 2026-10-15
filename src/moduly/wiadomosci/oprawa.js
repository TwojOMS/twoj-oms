import { PODPIS } from '../../domena/potwierdzenie-zamowienia.js';

/** Marka korespondencji jest osobna od tożsamości prawnej sprzedawcy. */
export function oprawaMaila(oprawa = {}) {
  return {
    podpis: String(oprawa?.podpis ?? '').trim() || PODPIS,
    naglowek: String(oprawa?.naglowek ?? '').trim(),
    footer: String(oprawa?.footer ?? '').split('\n').map(l => l.trim()).filter(Boolean).join('\n'),
  };
}

export function tekstZeStopka(tekst, footer) {
  return footer ? `${tekst}\n\n${footer}` : tekst;
}
