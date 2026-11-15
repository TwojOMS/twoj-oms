import { createServer } from 'node:http';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Kopia czystej mapy z magazynu; zgodności pilnuje test, bez importu modułu OMS.
export const TYPY = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const SCIEZKA = /^\/z\/([0-9a-f]{64}\.(jpg|png|webp))$/;

export function utworzSerwerZdjec({ katalog }) {
  return createServer((req, res) => {
    const odmowa = (status = 404) => { res.writeHead(status); res.end(); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return odmowa(405);
    // Nie dekodujemy ani nie normalizujemy URL: walidacja poprzedza każde I/O.
    const sciezka = (req.url || '').split('?')[0];
    const dopasowanie = SCIEZKA.exec(sciezka);
    if (!dopasowanie) return odmowa();
    const plik = join(katalog, dopasowanie[1]);
    fs.lstat(plik, (blad, dane) => {
      if (blad || !dane.isFile()) return odmowa();
      const naglowki = {
        'Content-Type': TYPY[dopasowanie[2]],
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      };
      if (req.method === 'HEAD') { res.writeHead(200, naglowki); res.end(); return; }
      const strumien = fs.createReadStream(plik);
      strumien.on('error', () => {
        if (res.headersSent) res.destroy();
        else odmowa();
      });
      res.on('close', () => strumien.destroy());
      strumien.once('open', fd => {
        // Otwarty deskryptor musi wskazywać ten sam zwykły plik co lstat.
        // Podmiana na symlink w czasie otwierania nie ujawni jego zawartości.
        fs.fstat(fd, (bladOtwarcia, otwarty) => {
          if (res.destroyed) { strumien.destroy(); return; }
          if (bladOtwarcia || !otwarty.isFile() || otwarty.ino !== dane.ino || otwarty.dev !== dane.dev) {
            strumien.destroy();
            return odmowa();
          }
          res.writeHead(200, naglowki);
          strumien.pipe(res);
        });
      });
    });
  });
}

// Bez import.meta.main: działa dopiero od Node 24.2, a engines dopuszcza 24.0.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.OMS_ZDJECIA_PORT || 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Niepoprawny OMS_ZDJECIA_PORT.');
  const katalog = process.env.OMS_KATALOG_ZDJEC || 'zdjecia';
  utworzSerwerZdjec({ katalog }).listen(port, '0.0.0.0');
}
