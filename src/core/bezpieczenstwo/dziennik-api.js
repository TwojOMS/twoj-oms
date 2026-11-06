import { rozbierzNaglowek } from '../../domena/klucze-api.js';
import { dopiszDoDziennikaApi } from './klucze-api.js';

const METODY_ODCZYTU = new Set(['GET', 'HEAD']);
const NAJDLUZSZA_SCIEZKA = 300;
const OKNO_DLAWIENIA_MS = 60_000;

/**
 * Dziennik wywołań kluczem API: /api/v1 i kolejki druku. Zapis (metoda inna niż GET/HEAD) i każdy status ≥ 400,
 * także 401 i 429 strażnika — haki onResponse widzą odpowiedzi wysłane z onRequest rdzenia.
 * Udane GET nie idą do dziennika: ślad użycia to `ostatnio_uzyty_at` klucza.
 * Ścieżka bez zapytania (w zapytaniu bywają dane), prefiks przy 401 tylko z poprawnie zbudowanego klucza.
 * Powtarzane błędy tej samej tożsamości, IP, metody, statusu i ścieżki są dławione przez minutę — dwa komputery
 * z tym samym złym kluczem dają osobne wiersze.
 */
export function wpisDoDziennika(ctx, { najwiecejWpisow = 5000 } = {}) {
  const ostatnieBledy = new Map();
  return async (req, reply) => {
    const status = reply.statusCode;
    if (METODY_ODCZYTU.has(req.method) && status < 400) return;
    if (req.bezWpisuDoDziennikaApi) return;
    try {
      const klucz = req.kluczApi;
      const prefiks = klucz?.prefiks ?? rozbierzNaglowek(req.headers.authorization)?.slice(5, 13) ?? null;
      const sciezka = String(req.url).split('?')[0].slice(0, NAJDLUZSZA_SCIEZKA);
      const teraz = ctx.teraz();
      const czas = teraz.getTime();
      const tozsamosc = klucz?.id != null ? ['klucz', klucz.id] : prefiks ? ['prefiks', prefiks] : ['ip', req.ip];
      const kluczDlawienia = JSON.stringify([tozsamosc, req.ip, req.method, status, sciezka]);
      if (status >= 400 && czas - ostatnieBledy.get(kluczDlawienia) < OKNO_DLAWIENIA_MS) return;
      dopiszDoDziennikaApi(ctx.db, {
        kluczId: klucz?.id ?? null,
        prefiks,
        at: teraz.toISOString(),
        metoda: req.method,
        sciezka,
        status,
        ip: req.ip,
      });
      if (status >= 400) {
        // Usuń i wstaw: mapa zostaje w kolejności czasu, więc przycinanie idzie od początku i staje na pierwszym
        // świeżym wpisie; ponad limit odpada najstarszy także świeży.
        ostatnieBledy.delete(kluczDlawienia);
        ostatnieBledy.set(kluczDlawienia, czas);
        for (const [kluczMapy, poprzedniCzas] of ostatnieBledy) {
          if (ostatnieBledy.size <= najwiecejWpisow && czas - poprzedniCzas < OKNO_DLAWIENIA_MS) break;
          ostatnieBledy.delete(kluczMapy);
        }
      }
    } catch (err) {
      req.log.warn({ err }, 'Dziennik API: nie zapisano wpisu');
    }
  };
}

