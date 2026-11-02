import { polaczenia, stanPolaczenia } from '../../../oms/db/reklamy.js';

type Stan = 'dziala' | 'uwaga' | 'niesprawdzone' | 'wylaczone';
type Zrodlo = 'panel' | 'serwer' | 'konto_allegro';
type Polaczenie = { id: string; usluga: string; nazwa: string; opis: string; stan: Stan; ostatniSukcesAt: string | null; zrodlo: Zrodlo; atrapa: boolean; kanal?: string };
type Opcje = { db: any; kanaly?: any; stanyKanalow?: any[]; integracje?: { id: string; skonfigurowana: boolean; zrodlo: Zrodlo }[]; proba?: boolean };
const data = (d: unknown): string | null => typeof d === 'string' && Number.isFinite(Date.parse(d)) ? d : null;

/** Żadnej sieci, zapisów ani serializacji obiektu konfiguracji/sekretów. */
export function polaczeniaIntegracji({ db, kanaly = {}, stanyKanalow = [], integracje = [], proba = false }: Opcje): Polaczenie[] {
  const wynik: Polaczenie[] = [];
  const dodaj = (p: Omit<Polaczenie, 'atrapa'>) => wynik.push({ ...p, stan: proba && p.stan === 'dziala' ? 'niesprawdzone' : p.stan, atrapa: proba });
  for (const [typ, mapa] of [['allegro', kanaly.kanaly ?? {}], ['woocommerce', kanaly.sklepy ?? {}]] as const) {
    for (const klucz of Object.keys(mapa)) {
      const stan = db.prepare('SELECT ostatni_przebieg_at, ostatni_blad FROM stan_pollera WHERE sklep = ?').get(klucz);
      const konto = stanyKanalow.find(k => k.kanal === klucz);
      const ostatniSukcesAt = stan && !stan.ostatni_blad ? data(stan.ostatni_przebieg_at) : null;
      const nazwa = kanaly.definicje?.find((d: any) => d.klucz === klucz)?.etykieta ?? klucz;
      dodaj({ id: `${typ}:${klucz}`, usluga: typ, nazwa, opis: typ === 'allegro' ? `Konto Allegro: ${konto?.kontoAllegro ?? 'nie ustalono'}` : `Sklep WooCommerce: ${nazwa}`,
        stan: stan?.ostatni_blad || konto?.pilne || konto?.uprzedzenie ? 'uwaga' : ostatniSukcesAt ? 'dziala' : 'niesprawdzone', ostatniSukcesAt, zrodlo: 'serwer', kanal: klucz });
      if (typ === 'allegro') dodaj({ id: `wza:${klucz}`, usluga: 'wza', nazwa: `Wysyłam z Allegro — ${nazwa}`, opis: `Dostęp przez konto Allegro: ${konto?.kontoAllegro ?? klucz}. Odczyt zamówień nie potwierdza uprawnień nadawania.`,
        stan: konto?.pilne ? 'uwaga' : 'niesprawdzone', ostatniSukcesAt: null, zrodlo: 'konto_allegro', kanal: klucz });
    }
  }
  for (const p of integracje.filter(p => p.skonfigurowana)) dodaj({ id: `${p.id}:glowne`, usluga: p.id, nazwa: p.id, opis: 'Konfiguracja jest dostępna. Nie zapisano czasu udanego odczytu wymagającego uwierzytelnienia.',
    stan: 'niesprawdzone', ostatniSukcesAt: null, zrodlo: p.zrodlo });
  for (const p of polaczenia(db)) {
    const stan = stanPolaczenia(db, p.id);
    const ostatniSukcesAt = data(stan?.ostatniSukcesAt);
    dodaj({ id: `reklamy:${p.id}`, usluga: p.typ, nazwa: `Konto ${p.kontoId}`, opis: p.kanal ? `Kanał: ${p.kanal}` : 'Bez przypisanego kanału',
      stan: stan?.kodBledu ? 'uwaga' : ostatniSukcesAt ? 'dziala' : 'niesprawdzone', ostatniSukcesAt, zrodlo: 'panel' });
  }
  return wynik;
}
