import type { Srodowisko } from '../../core/kontrakty.ts';
import { type DefinicjaKanalu } from './konfiguracja.ts';

export const KANALY_ALGORYTMICZNE = ['DROPSHIPPING', 'GDD', 'B2B', 'RECZNE', 'INDYWIDUALNE'] as const;
const zastrzezone = new Set<string>([...KANALY_ALGORYTMICZNE, 'SKLEP', 'SKLEP_INDYWIDUALNE', 'ALLEGRO']);
const identyfikator = (x: unknown): x is string => typeof x === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x);
const obiekt = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
function id(x: unknown, nazwa: string): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new Error(`${nazwa}: wymagany bezpieczny całkowity identyfikator >= 0`);
  return x;
}
function listaId(x: unknown, nazwa: string): number[] {
  if (!Array.isArray(x)) throw new Error(`${nazwa}: oczekiwana lista`);
  const lista = x.map(v=>id(v,nazwa));
  if (new Set(lista).size !== lista.length) throw new Error(`${nazwa}: powtórzony identyfikator`);
  return lista;
}
export function wczytajKlasyfikacje(env: Srodowisko, definicje: readonly DefinicjaKanalu[]) {
  const sklepy = new Map<string,string>();
  const raporty = new Set<string>(KANALY_ALGORYTMICZNE);
  const aktywne = new Set<string>();
  for (const d of definicje) {
    if (d.raport === undefined) continue;
    if (!identyfikator(d.raport) || zastrzezone.has(d.raport) || aktywne.has(d.raport))
      throw new Error('OMS_KANALY: zastrzeżony, błędny lub współdzielony raport');
    aktywne.add(d.raport); raporty.add(d.raport); sklepy.set(d.klucz,d.raport);
  }
  let h: unknown;
  try { h=JSON.parse(env.OMS_HISTORIA_KLASYFIKACJA ?? '{"konta":[]}'); }
  catch { throw new Error('OMS_HISTORIA_KLASYFIKACJA: niepoprawny JSON'); }
  if (!obiekt(h) || !Array.isArray(h.konta)) throw new Error('OMS_HISTORIA_KLASYFIKACJA: oczekiwany obiekt z listą konta');
  const konta=new Map<number,string>();
  for (const w of h.konta) {
    if (!obiekt(w) || !identyfikator(w.raport) || ['SKLEP','SKLEP_INDYWIDUALNE','ALLEGRO'].includes(w.raport)) throw new Error('OMS_HISTORIA_KLASYFIKACJA: błędny raport konta');
    const konto=id(w.konto,'OMS_HISTORIA_KLASYFIKACJA.konta');
    if(konta.has(konto)) throw new Error('OMS_HISTORIA_KLASYFIKACJA: powtórzone konto');
    konta.set(konto,w.raport);raporty.add(w.raport);
  }
  const tag = (n:string)=>h[n] === undefined ? null : id(h[n],`OMS_HISTORIA_KLASYFIKACJA.${n}`);
  const tagDrop=tag('tagDrop'),tagGdd=tag('tagGdd'),tagB2b=tag('tagB2b');
  const tagi=[tagDrop,tagGdd,tagB2b].filter(v=>v!==null);
  if(new Set(tagi).size!==tagi.length) throw new Error('OMS_HISTORIA_KLASYFIKACJA: tagi muszą być różne');
  const kontaB2b = new Set(listaId(h.kontaB2b ?? [],'OMS_HISTORIA_KLASYFIKACJA.kontaB2b'));
  for(const konto of kontaB2b) if(!konta.has(konto) || konta.get(konto)!=='B2B') throw new Error('OMS_HISTORIA_KLASYFIKACJA: konto B2B wymaga mapowania B2B');
  const prefiksy=h.prefiksyIndywidualne ?? [];
  if (!Array.isArray(prefiksy) || prefiksy.some(p=>typeof p!=='string' || !p.trim() || p.trim()!==p || !p.endsWith('|') || p.length<2)
    || new Set(prefiksy).size!==prefiksy.length) throw new Error('OMS_HISTORIA_KLASYFIKACJA: wymagane niepuste unikalne prefiksy zakończone |');
  for(const d of definicje) {
    const raw=env[`${d.prefiks}_HISTORIA_KONTO_APILO`]?.trim();
    if(raw === undefined || raw === '') continue;
    if(!/^\d+$/.test(raw)) throw new Error(`${d.prefiks}_HISTORIA_KONTO_APILO: błędne konto historii`);
    const konto=id(Number(raw),`${d.prefiks}_HISTORIA_KONTO_APILO`);
    if(!d.raport || konta.get(konto)!==d.raport) throw new Error(`${d.prefiks}_HISTORIA_KONTO_APILO: raport historii niezgodny z OMS_KANALY`);
  }
  return {sklepy,konta,tagDrop,tagGdd,tagB2b,kontaB2b,prefiksyIndywidualne:prefiksy as string[],raporty};
}
export type KlasyfikacjaRaportowa = ReturnType<typeof wczytajKlasyfikacje>;
