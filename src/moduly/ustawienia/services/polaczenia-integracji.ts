import { polaczenia, stanPolaczenia } from '../../../oms/db/reklamy.js';
import type {PolaczenieAllegro} from '../../kanaly/kontrakty-allegro.ts';
import { KATALOG_INTEGRACJI, type KategoriaIntegracji } from '../../../domena/katalog-integracji.ts';

/** PRZ-136.07: „blad” — stan dla widoku (czerwony wiersz); źródła danych jeszcze go nie ustawiają. */
type Stan = 'blad' | 'dziala' | 'uwaga' | 'niesprawdzone' | 'wylaczone';
type Zrodlo = 'panel' | 'serwer' | 'konto_allegro';
/** PRZ-136.06: cztery grupy z kategorii katalogu (decyzja planu: poczta + reklamy razem) i wstrzymane na końcu. */
export type GrupaPolaczen = 'sprzedaz' | 'wysylka' | 'faktury' | 'poczta' | 'wstrzymane';
type Akcja = { etykieta: string; href: string; glowna: boolean };
type Odnosnik = { etykieta: string; href: string };
type Polaczenie = { id: string; usluga: string; nazwa: string; opis: string; stan: Stan; ostatniSukcesAt: string | null; zrodlo: Zrodlo; atrapa: boolean; podlaczone?: boolean; kanal?: string;
  grupa: GrupaPolaczen; nazwaLudzka: string; konto: string | null; komunikat: string | null; akcja: Akcja | null; wiecej: Odnosnik[];
  czasOdczytu: string | null; etykietaStanu: string; wysylkaAllegro?: 'wlaczona' | 'wylaczona' };
type Integracja = { id: string; skonfigurowana: boolean; atrapa?: boolean; zrodlo: Zrodlo };
type Opcje = { db: any; kanaly?: any; stanyKanalow?: any[]; integracje?: Integracja[]; proba?: boolean; polaczeniaAllegro?:PolaczenieAllegro[]; sklepyErli?:any[]; sklepyWoo?:{klucz:string;nazwa:string;zrodlo:string;autoryzacja?:string}[] };
const data = (d: unknown): string | null => typeof d === 'string' && Number.isFinite(Date.parse(d)) ? d : null;

export const GRUPY_POLACZEN: Record<GrupaPolaczen, string> = {
  sprzedaz: 'Sprzedaż', wysylka: 'Wysyłka', faktury: 'Faktury i KSeF', poczta: 'Poczta i analityka', wstrzymane: 'Wstrzymane',
};
const GRUPA_KATEGORII: Record<KategoriaIntegracji, GrupaPolaczen> = { sklepy: 'sprzedaz', wysylka: 'wysylka', faktury: 'faktury', poczta: 'poczta', reklamy: 'poczta' };
const KOLEJNOSC_GRUP = Object.keys(GRUPY_POLACZEN) as GrupaPolaczen[];
/** Kolejność w grupie: błąd, uwaga, działa, niesprawdzone. */
const KOLEJNOSC_STANOW: Record<Stan, number> = { blad: 0, uwaga: 1, dziala: 2, niesprawdzone: 3, wylaczone: 4 };
const ETYKIETY_STANOW: Record<Stan, string> = { blad: 'Błąd', dziala: 'Działa', uwaga: 'Wymaga uwagi', niesprawdzone: 'Niesprawdzone', wylaczone: 'Wyłączone' };
const katalog = (id: string) => KATALOG_INTEGRACJI.find((u) => u.id === id);

/**
 * B1: jeden warunek „podłączone” dla listy i ekranu usługi — zapis z Ustawień albo plik konfiguracji. Atrapa
 * piaskownicy sama nie podłącza: ekran inFaktu bez zapisu mówi „Niepodłączony”, więc lista nie może mówić inaczej.
 */
export function stanIntegracji({ usluga, zapisany }: { usluga: { zEnv?: boolean; atrapa?: boolean } | null | undefined; zapisany: boolean }) {
  const skonfigurowana = zapisany || usluga?.zEnv === true;
  return { skonfigurowana, atrapa: !skonfigurowana && usluga?.atrapa === true, zrodlo: (usluga?.zEnv ? 'serwer' : 'panel') as Zrodlo };
}

/** Liczniki nad listą (wstrzymane osobno — OMS ich nie odpytuje). */
export function liczPolaczenia(wiersze: { podlaczone?: boolean }[]) {
  return wiersze.filter(w => w.podlaczone !== false).length;
}

export function podsumowanie(wiersze: { stan: Stan; podlaczone?: boolean }[]) {
  wiersze = wiersze.filter(w => w.podlaczone !== false);
  const ile = (s: Stan) => wiersze.filter((w) => w.stan === s).length;
  return { razem: liczPolaczenia(wiersze), blad: ile('blad'), dziala: ile('dziala'), uwaga: ile('uwaga'), niesprawdzone: ile('niesprawdzone'), wstrzymane: ile('wylaczone') };
}

/** Żadnej sieci, zapisów ani serializacji obiektu konfiguracji/sekretów. */
export function polaczeniaIntegracji({ db, kanaly = {}, stanyKanalow = [], integracje = [], proba = false, polaczeniaAllegro=[], sklepyWoo=[],sklepyErli=[] }: Opcje): Polaczenie[] {
  const wynik: Polaczenie[] = [];
  type Wejscie = Omit<Polaczenie, 'atrapa' | 'grupa' | 'czasOdczytu' | 'etykietaStanu' | 'wiecej' | 'komunikat' | 'akcja'> & { grupa: GrupaPolaczen; komunikat?: string | null; akcja: Akcja | null; wiecej?: Odnosnik[] };
  const dodaj = (p: Wejscie,atrapa=proba) => {
    const stan: Stan = atrapa && p.stan === 'dziala' ? 'niesprawdzone' : p.stan;
    wynik.push({ ...p, stan, atrapa, grupa: stan === 'wylaczone' ? 'wstrzymane' : p.grupa, czasOdczytu: p.ostatniSukcesAt,
      etykietaStanu: p.podlaczone === false ? (p.usluga === 'smtp' ? 'Nieustawiona' : 'Niepodłączony') : atrapa && stan === 'niesprawdzone' ? 'Dane przykładowe' : ETYKIETY_STANOW[stan],
      komunikat: stan === 'uwaga' || stan === 'blad' ? p.komunikat ?? 'Ostatni odczyt się nie udał. Sprawdź połączenie.' : null,
      akcja: p.akcja && { ...p.akcja, glowna: stan === 'uwaga' || stan === 'blad' }, wiecej: p.wiecej ?? [] });
  };
  const maDiagnostyke=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kanaly_diagnostyka'").get());
  const sklepyPanelu=sklepyWoo; // lista z repozytorium kanałów przychodzi parametrem (modul.ts), DTO bez kluczy WooCommerce
  // PRZ-134.PT7: sklep z panelu jest na liście także przed udanym połączeniem — inaczej szkic z odrzuconymi kluczami
  // znikał, a jego adres blokował ponowne dodanie.
  for (const [typ, mapa] of [['allegro', kanaly.kanaly ?? {}], ['woocommerce', kanaly.sklepy ?? {}]] as const) {
    for (const klucz of new Set([...Object.keys(mapa),...(typ==='allegro'?polaczeniaAllegro.map(p=>p.klucz):sklepyPanelu.filter(p=>p.zrodlo==='panel').map(p=>p.klucz))])) {
      const stan = db.prepare('SELECT ostatni_przebieg_at, ostatni_blad FROM stan_pollera WHERE sklep = ?').get(klucz);
      const konto = stanyKanalow.find(k => k.kanal === klucz);
      const p=typ==='allegro'?polaczeniaAllegro.find(p=>p.klucz===klucz):undefined;
      const sklep=typ==='woocommerce'?sklepyPanelu.find(p=>p.klucz===klucz&&p.zrodlo==='panel'):undefined;
      const szkic=sklep&&!(klucz in mapa)?sklep:undefined; // PRZ-134.PT7: z panelu, jeszcze nie pobiera
      const test=p&&maDiagnostyke?db.prepare('SELECT ostatni_sukces_at,blad FROM kanaly_diagnostyka WHERE kanal=?').get(klucz):null;
      const ostatniSukcesAt = data(test?.ostatni_sukces_at)??(stan && !stan.ostatni_blad ? data(stan.ostatni_przebieg_at) : null);
      const nazwa = p?.nazwa??sklep?.nazwa??kanaly.definicje?.find((d: any) => d.klucz === klucz)?.etykieta ?? klucz;
      const atrapa=proba&&!p&&!sklep;
      const opis=p?`Konto Allegro: ${p.login??p.kontoId??'jeszcze niepotwierdzone'}. ${p.srodowisko==='sandbox'?'Allegro Sandbox. ':''}${p.autoryzacja==='odlaczone'?'Odłączone.':p.pobieranie==='wlaczone'?'Pobieranie włączone.':'Pobieranie wyłączone.'}`:typ === 'allegro' ? `Konto Allegro: ${konto?.kontoAllegro ?? 'nie ustalono'}` : szkic?`Sklep WooCommerce: ${nazwa}. ${szkic.autoryzacja==='odlaczone'?'Odłączony.':'Konfiguracja niedokończona — sprawdź klucze i dokończ ją w „Zarządzaj”.'}`:`Sklep WooCommerce: ${nazwa}`;
      // Każde konto ma odnośnik do własnego ekranu, także przy danych przykładowych.
      const href=`/ustawienia/integracje/${typ}/${encodeURIComponent(klucz)}`;
      const akcja:Akcja={etykieta:szkic?'Dokończ konfigurację':'Zarządzaj',href,glowna:false};
      // Wysyłam z Allegro to cecha konta, nie osobne połączenie (U6) — wyłączona razem z odłączonym kontem.
      const wza=typ==='allegro'?{wysylkaAllegro:(p?.autoryzacja==='odlaczone'?'wylaczona':'wlaczona') as 'wlaczona'|'wylaczona'}:{};
      dodaj({ id: `${typ}:${klucz}`, usluga: typ, nazwa, opis,
        stan: (p??szkic)?.autoryzacja==='odlaczone'?'wylaczone':p&&p.autoryzacja!=='polaczone'||szkic?'niesprawdzone':test?.blad||stan?.ostatni_blad || konto?.pilne || konto?.uprzedzenie ? 'uwaga' : ostatniSukcesAt ? 'dziala' : 'niesprawdzone', ostatniSukcesAt, zrodlo:p?.zrodlo==='panel'||sklep?'panel':'serwer', kanal: klucz,
        grupa: 'sprzedaz', nazwaLudzka: nazwa, konto: typ==='allegro' ? p?.login ?? p?.kontoId ?? konto?.kontoAllegro ?? null : null,
        komunikat: typeof konto?.powod === 'string' && konto.powod ? konto.powod : typ==='allegro' ? 'Ostatni odczyt zamówień z Allegro się nie udał. Sprawdź połączenie.' : 'Ostatni odczyt zamówień ze sklepu się nie udał. Sprawdź klucze i adres sklepu.',
        akcja, ...wza },atrapa);
    }
  }
  for(const k of sklepyErli){
    const stan=db.prepare('SELECT ostatni_przebieg_at,ostatni_blad FROM stan_pollera WHERE sklep=?').get(k.klucz);
    const u=k.ustawienia??{};
    dodaj({id:'erli:'+k.klucz,usluga:'erli',kanal:k.klucz,nazwa:k.nazwa,nazwaLudzka:k.nazwa,
      opis:u.sklepId?`Sklep ERLI: ${u.sklepNazwa} (id ${u.sklepId})`:'Sklep ERLI: połączenie jeszcze niesprawdzone.',
      stan:k.autoryzacja==='odlaczone'||k.pobieranie!=='wlaczone'?'wylaczone':u.kolizja||stan?.ostatni_blad?'uwaga':u.sprawdzono?'dziala':'niesprawdzone',
      ostatniSukcesAt:data(stan?.ostatni_przebieg_at),zrodlo:k.zrodlo==='env'?'serwer':'panel',grupa:'sprzedaz',konto:u.sklepId??null,
      komunikat:u.kolizja?'Ten sklep ERLI jest zapisany w dwóch kanałach. Rozwiąż kolizję.':null,
      akcja:{etykieta:'Zarządzaj',href:'/ustawienia/integracje/erli/'+encodeURIComponent(k.klucz),glowna:false}},proba);
  }
  for (const p of integracje.filter(p => p.skonfigurowana || p.atrapa)) {
    const u = katalog(p.id);
    const tylkoAtrapa = !p.skonfigurowana;
    dodaj({ id: `${p.id}:glowne`, usluga: p.id, nazwa: p.id, podlaczone: p.skonfigurowana,
      opis: tylkoAtrapa ? 'Niepodłączone. W piaskownicy działa na danych przykładowych.' : 'Konfiguracja jest dostępna. Nie zapisano czasu udanego odczytu wymagającego uwierzytelnienia.',
      stan: 'niesprawdzone', ostatniSukcesAt: null, zrodlo: p.zrodlo,
      grupa: u ? GRUPA_KATEGORII[u.kategoria] : 'poczta', nazwaLudzka: u?.nazwa ?? p.id, konto: null,
      akcja: u?.href ? { etykieta: tylkoAtrapa ? 'Podłącz' : 'Zarządzaj', href: u.href, glowna: false } : null }, tylkoAtrapa || proba);
  }
  for (const p of polaczenia(db)) {
    const stan = stanPolaczenia(db, p.id);
    const ostatniSukcesAt = data(stan?.ostatniSukcesAt);
    const u = katalog(p.typ);
    dodaj({ id: `reklamy:${p.id}`, usluga: p.typ, nazwa: `Konto ${p.kontoId}`, opis: p.kanal ? `Kanał: ${p.kanal}` : 'Bez przypisanego kanału',
      stan: stan?.kodBledu ? 'uwaga' : ostatniSukcesAt ? 'dziala' : 'niesprawdzone', ostatniSukcesAt, zrodlo: 'panel',
      grupa: u ? GRUPA_KATEGORII[u.kategoria] : 'poczta', nazwaLudzka: u?.nazwa ?? p.typ, konto: String(p.kontoId),
      komunikat: 'Ostatni odczyt statystyk się nie udał. Sprawdź dostęp do konta reklamowego.',
      akcja: { etykieta: 'Zarządzaj', href: u?.href ?? '/ustawienia/integracje/reklamy', glowna: false } });
  }
  // Stabilne sortowanie: grupy w stałej kolejności, w grupie problem na górze; kolejność wstawiania w remisie.
  const pozycja = (p: Polaczenie) => KOLEJNOSC_GRUP.indexOf(p.grupa) * 10 + KOLEJNOSC_STANOW[p.stan];
  return wynik.map((p, i) => [p, i] as const).sort(([a, i], [b, j]) => pozycja(a) - pozycja(b) || i - j).map(([p]) => p);
}
