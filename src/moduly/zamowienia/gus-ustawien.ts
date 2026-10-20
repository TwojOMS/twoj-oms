// PRZ-102.11 — usługa GUS (REGON BIR1.1) z bieżącej konfiguracji: plik → panel → brak. Wzór: infaktZUstawien
// (moduly/faktury/infakt-ustawien.ts) i kurierzy z Ustawień (moduly/wysylka/kurierzy.ts).
//
// Ta sama usługa trafia do karty zamówienia, zamówienia ręcznego, Stałych klientów i do warunku „czy pokazać
// przycisk Pobierz z GUS”. Każde wywołanie pyta o BIEŻĄCEGO klienta: klucz z pliku (zbudowany raz przy starcie — plik
// nie zmienia się bez restartu), atrapa piaskownicy, a dopiero potem zapis z Ustawień czytany z bazy. Klient z panelu
// powstaje na nowo tylko przy zmianie klucza, więc sesja BIR (sid, 45 min) przeżywa kolejne zapytania, a zapis albo
// usunięcie klucza działa od następnego żądania — bez restartu.
// ⚠️ Klucz jest sekretem: nie idzie do logu ani do komunikatu (komunikaty buduje klient GUS bez klucza).
import { METODY_GUS } from '../../oms/gus/client.js';
import { bladOperatora } from '../../domena/bledy.js';
import { KOMUNIKAT_BRAK_GUS, kluczZZapisu } from '../../domena/konfiguracja-gus.js';

type KlientGus = Record<string, (...a: any[]) => Promise<any>>;
type ZapisGus = { sekrety: Record<string, unknown> } | null;
export type UslugaGus = KlientGus & {
  zEnv: boolean;
  dostepny: () => boolean;
  zapisany: () => boolean;
  sprawdzZapisany: () => Promise<unknown>;
};

export function uslugaGus({ zPliku = null, atrapa = null, wczytaj, fabryka, adres }: {
  zPliku?: KlientGus | null; atrapa?: KlientGus | null;
  wczytaj: () => ZapisGus; fabryka: (o: { klucz: string; url: string }) => KlientGus; adres: string;
}): UslugaGus {
  let odcisk: string | null = null;
  let klient: KlientGus | null = null;
  const zPanelu = (): KlientGus | null => {
    const klucz = kluczZZapisu(wczytaj());
    if (!klucz) { odcisk = null; klient = null; return null; }
    const nowy = JSON.stringify([klucz, adres]);
    if (nowy !== odcisk || !klient) { klient = fabryka({ klucz, url: adres }); odcisk = nowy; }
    return klient;
  };
  // Kolejność rozstrzyga regułę „plik wygrywa”: stary zapis z ekranu nie przesłoni klucza z pliku.
  const biezacy = (): KlientGus | null => zPliku ?? atrapa ?? zPanelu();
  const wywolaj = (m: string) => async (...a: unknown[]) => {
    const k = biezacy();
    // `status: 503` jak dawna odmowa tras bez klucza; trasy i tak pytają dostepny() przed wywołaniem.
    if (!k) throw bladOperatora(KOMUNIKAT_BRAK_GUS, { status: 503 });
    return k[m](...a);
  };
  return {
    ...Object.fromEntries(METODY_GUS.map((m: string) => [m, wywolaj(m)])),
    zEnv: Boolean(zPliku),
    dostepny: () => Boolean(biezacy()),
    zapisany: () => Boolean(kluczZZapisu(wczytaj())),
    // „Sprawdź połączenie” na ekranie sprawdza ZAPIS Z EKRANU (w piaskownicy: atrapą z tym kluczem), nie plik.
    sprawdzZapisany: async () => {
      const k = zPanelu();
      if (!k) throw bladOperatora('Najpierw zapisz klucz, potem sprawdź połączenie.', { status: 400 });
      return k.sprawdzPolaczenie();
    },
  } as UslugaGus;
}

/** Piaskownica bez atrapy: klucz wpisany na :3005 / demo nie wychodzi do GUS — każda metoda odmawia (4xx: nic nie poszło). */
export function odmowaGusWProbie(): KlientGus {
  const odmowa = async () => {
    throw bladOperatora('Piaskownica: prawdziwy GUS jest tu wyłączony — nic nie poszło do GUS.', { status: 400 });
  };
  return Object.fromEntries(METODY_GUS.map((m: string) => [m, odmowa]));
}
