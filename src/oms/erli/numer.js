import { createSlownikiErli } from '../../moduly/kanaly/services/kanal-erli.ts';
import { numerWErli, konfliktNumeruErli } from '../../domena/erli-numer.js';

const slowniki = new WeakMap();
const przewoznicy = { dpd: 'dpd', inpost: 'inpost', inpost_paczkomat: 'inpost', inpost_kurier: 'inpost' };

export function numerErli(klient) {
  return {
    async przekazNumer(z, p) {
      const obecny = numerWErli(z);
      if (obecny === p.numer_listu || konfliktNumeruErli(z)) return { pominiety: true };
      if (!slowniki.has(klient)) slowniki.set(klient, createSlownikiErli(klient));
      const cache = slowniki.get(klient);
      let delivery;
      try { delivery = JSON.parse(z.surowe_json ?? '{}').delivery ?? {}; }
      catch { return { pominiety: true }; }
      await cache.przygotuj([{ delivery }]);
      if (!cache.dostepne()) throw new Error('Słowniki dostawy są niedostępne.');
      const droga = cache.rozpoznaj(delivery);
      if (droga?.droga !== 'umowa') return { pominiety: true };
      const vendor = przewoznicy[p.kurier];
      if (!vendor || !p.numer_listu) return { pominiety: true };
      const odpowiedz = await klient.utworzPaczkiZewnetrzne([{ orderId: z.zrodlo_id, vendor,
        trackingNumber: p.numer_listu, ...(vendor === 'dpd' ? { typeId: 'dpd' } : {}) }]);
      const id = odpowiedz?.[0]?.id;
      if (id == null || String(id) === '') throw new Error('ERLI nie potwierdziło identyfikatora przesyłki. Sprawdź panel ERLI.');
      return { id: String(id) };
    },
    usunNumer: id => klient.usunPaczkeZewnetrzna(id),
  };
}
