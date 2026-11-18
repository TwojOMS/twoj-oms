import { adresKanalu } from '../../domena/kanaly.js';
import { liczbaPolska, cenaPolska } from '../../domena/kwoty.js';

const ETYKIETY_ZRODEL_KANALOW = Object.freeze({ allegro: 'Allegro', woo: 'sklep' });

export function etykietaZrodla(wiersz, definicje) {
  if (!wiersz) return null;
  if (wiersz.zrodlo === 'zastane') return 'zastane';
  if (wiersz.zrodlo === 'api') return 'API';
  if (Number(wiersz.reczne) === 1 || wiersz.zrodlo === 'reczne') return 'ręcznie';
  const [, typ, klucz] = /^(allegro|woo):(.+)$/.exec(wiersz.zrodlo) ?? [];
  return klucz ? `${ETYKIETY_ZRODEL_KANALOW[typ]}: ${adresKanalu(klucz, definicje)}` : null;
}

export function bladTresciOferty(p) {
  if (!p.tresc_blad?.trim()) return { bladTresci: null, bladTresciData: null };
  // Adres może zawierać dane zapytania; w komunikacie wystarczy host.
  const bladTresci = p.tresc_blad
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (adres) => {
      try {
        return new URL(adres).hostname;
      } catch {
        return '(adres)';
      }
    })
    .slice(0, 300);
  const data = p.tresc_blad_at ? new Date(p.tresc_blad_at) : null;
  return {
    bladTresci,
    bladTresciData:
      data && Number.isFinite(data.getTime())
        ? new Intl.DateTimeFormat('pl-PL', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: 'Europe/Warsaw',
          }).format(data)
        : null,
  };
}

export function danePrezentacjiKarty(db, kartaId, definicje, komunikat) {
  const zrodlaPol = Object.fromEntries(
    db
      .prepare('SELECT pole, zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ?')
      .all(kartaId)
      .map((w) => [w.pole, etykietaZrodla(w, definicje)]),
  );
  return {
    zrodlaPol,
    liczbaPolska,
    cenaPolska,
    polskieWymiary: (tekst) => tekst?.replace(/\d+(?:\.\d+)?/g, (n) => liczbaPolska(n)) ?? null,
    komunikatTresci: ['rozpoczeta', 'w-toku'].includes(komunikat)
      ? `Pobieram treść i zdjęcia ofert Allegro${komunikat === 'w-toku' ? ' — przebieg już trwa' : ''}. Odśwież tę stronę, żeby zobaczyć wynik.`
      : null,
  };
}
