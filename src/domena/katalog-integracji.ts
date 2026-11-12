import type { OpisKuriera } from '../core/kontrakty.ts';
import { MODULY_KANALOW } from './moduly-kanalow.ts';
import { MODULY_KURIEROW } from './moduly-kurierow.ts';

export type KategoriaIntegracji = 'sklepy' | 'wysylka' | 'faktury' | 'poczta' | 'reklamy';
export type DostepnoscIntegracji = 'dostepna' | 'przez_konfiguracje' | 'planowana';

export interface IntegracjaKatalogu {
  id: string;
  nazwa: string;
  kategoria: KategoriaIntegracji;
  opis: string;
  logo: string;
  dostepnosc: DostepnoscIntegracji;
  href: string | null;
  /** Przycisk „Dodaj …” z opisu modułu kanału (PRZ-133); null dla usług bez konfiguratora. */
  konfigurator: { dodaj: string; href: string } | null;
}

type Wpis = Omit<IntegracjaKatalogu, 'konfigurator'>;

function zModulu(wpis: Wpis): IntegracjaKatalogu {
  const modul = Object.values(MODULY_KANALOW).find((m) => m.idKatalogu === wpis.id);
  if (!modul || wpis.dostepnosc === 'planowana') return { ...wpis, konfigurator: null };
  const href = `${modul.konfigurator.sciezka}/${modul.konfigurator.nowy}`;
  return { ...wpis, href, konfigurator: { dodaj: modul.konfigurator.dodaj, href } };
}

/** PRZ-135 D7: wpis wysyłki z opisu kuriera (id = idKatalogu, więc WzA zostaje „wza”). */
function zKuriera(opis: OpisKuriera): Wpis {
  return { id: opis.idKatalogu, nazwa: opis.nazwa, kategoria: 'wysylka', opis: opis.opisKatalogu, logo: opis.logo,
    // PRZ-136.14 (#5): WzA nie ma własnego ekranu — to cecha konta Allegro, więc „Konfiguruj” prowadzi do grupy
    // kont Allegro na liście, a nie na górę tej samej listy.
    dostepnosc: 'dostepna', href: opis.konfigurator.sciezka === '/ustawienia/integracje' ? '/ustawienia/integracje#grupa-sprzedaz' : opis.konfigurator.sciezka };
}

/** Kurier tylko do śledzenia (bez metod nadania) i kurier kanału (`wKatalogu: false`) nie mają wpisu w katalogu. */
const KURIERZY: Wpis[] = Object.values(MODULY_KURIEROW as Readonly<Record<string, OpisKuriera>>)
  .filter((opis) => opis.metody.length > 0 && opis.wKatalogu !== false).map(zKuriera);

const WPISY: Wpis[] = [
  { id: 'allegro', nazwa: 'Allegro', kategoria: 'sklepy', opis: 'Pobieraj zamówienia z konta Allegro.', logo: '/integracje/allegro.svg', dostepnosc: 'dostepna', href: null },
  { id: 'woocommerce', nazwa: 'WooCommerce', kategoria: 'sklepy', opis: 'Pobieraj zamówienia ze sklepu WooCommerce.', logo: '/integracje/woocommerce.png', dostepnosc: 'dostepna', href: null },
  { id: 'erli', nazwa: 'ERLI', kategoria: 'sklepy', opis: 'Połączenie z marketplace ERLI.', logo: '/integracje/erli.png', dostepnosc: 'dostepna', href: null },
  { id: 'shoper', nazwa: 'Shoper', kategoria: 'sklepy', opis: 'Połączenie ze sklepem Shoper.', logo: '/integracje/shoper.svg', dostepnosc: 'planowana', href: null },
  { id: 'empik', nazwa: 'Empik', kategoria: 'sklepy', opis: 'Połączenie z Empik Marketplace.', logo: '/integracje/empik.png', dostepnosc: 'planowana', href: null },
  { id: 'etsy', nazwa: 'Etsy', kategoria: 'sklepy', opis: 'Połączenie z marketplace Etsy.', logo: '/integracje/etsy.svg', dostepnosc: 'planowana', href: null },
  ...KURIERZY,
  // Zapowiedzi bez modułu (T3, decyzja właściciela 03.11: GLS, DHL, Apaczka).
  { id: 'gls', nazwa: 'GLS', kategoria: 'wysylka', opis: 'Połączenie z kurierem GLS.', logo: '/integracje/gls.png', dostepnosc: 'planowana', href: null },
  { id: 'dhl', nazwa: 'DHL', kategoria: 'wysylka', opis: 'Połączenie z kurierem DHL.', logo: '/integracje/dhl.svg', dostepnosc: 'planowana', href: null },
  { id: 'apaczka', nazwa: 'Apaczka', kategoria: 'wysylka', opis: 'Broker — wiele firm kurierskich w jednej umowie.', logo: '/integracje/paczka.svg', dostepnosc: 'planowana', href: null },
  { id: 'infakt', nazwa: 'inFakt', kategoria: 'faktury', opis: 'Połącz konto inFakt do wystawiania faktur.', logo: '/integracje/infakt.png', dostepnosc: 'dostepna', href: '/ustawienia/integracje/infakt' },
  { id: 'fakturownia', nazwa: 'Fakturownia', kategoria: 'faktury', opis: 'Połączenie z programem Fakturownia.', logo: '/integracje/fakturownia.svg', dostepnosc: 'planowana', href: null },
  { id: 'ksef', nazwa: 'KSeF', kategoria: 'faktury', opis: 'Skonfiguruj połączenie do pobierania faktur kosztowych.', logo: '/integracje/ksef.jpg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/ksef' },
  { id: 'gus', nazwa: 'GUS', kategoria: 'faktury', opis: 'Pobieraj dane firmy po numerze NIP.', logo: '/integracje/gus.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/gus' },
  { id: 'smtp', nazwa: 'Poczta wychodząca', kategoria: 'poczta', opis: 'Skonfiguruj wysyłanie wiadomości e-mail przez serwer SMTP.', logo: '/integracje/smtp.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje/poczta' },
  { id: 'meta', nazwa: 'Meta Ads', kategoria: 'reklamy', opis: 'Odczytuj statystyki kampanii Meta.', logo: '/integracje/meta.png', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje/reklamy' },
  { id: 'ga4', nazwa: 'Google Analytics 4', kategoria: 'reklamy', opis: 'Odczytuj statystyki Google Analytics 4.', logo: '/integracje/ga4.svg', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje/reklamy' },
  { id: 'google_ads', nazwa: 'Google Ads', kategoria: 'reklamy', opis: 'Odczytuj statystyki kampanii Google Ads.', logo: '/integracje/google-ads.svg', dostepnosc: 'przez_konfiguracje', href: '/ustawienia/integracje/reklamy' },
];

export const KATALOG_INTEGRACJI: IntegracjaKatalogu[] = WPISY.map(zModulu);

function normalizuj(tekst: string): string {
  return tekst.toLocaleLowerCase('pl').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').trim();
}

export function filtrujIntegracje({ szukaj = '', kategoria = '', planowane = true }: { szukaj?: string; kategoria?: string; planowane?: boolean } = {}): IntegracjaKatalogu[] {
  const fraza = normalizuj(szukaj);
  return KATALOG_INTEGRACJI.filter((usluga) =>
    (planowane || usluga.dostepnosc !== 'planowana') &&
    (!kategoria || usluga.kategoria === kategoria) &&
    (!fraza || normalizuj(`${usluga.nazwa} ${usluga.opis}`).includes(fraza)),
  );
}
