import multipart from '@fastify/multipart';
import { MAKS_LOGO, czyPng } from '../../../core/web/logo-instalacji.js';
import { zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji } from '../../../oms/db/konfiguracja-integracji.js';

const ADRES = '/ustawienia/firma/logo';
const odmowa = (reply, kod, tresc) => reply.code(kod).type('text/plain; charset=utf-8').send(tresc);
function sprawdzDostep(req, reply, znak) {
  if (req.konto?.admin !== true) return odmowa(reply, 403, 'Logo zmienia tylko administrator. Formularz niczego nie zapisał.');
  if (znak.wPliku) return odmowa(reply, 409, 'Logo ustawione w pliku konfiguracji (OMS_LOGO_PLIK w oms.env) — tam je zmień. Formularz niczego nie zapisał.');
  return null;
}

export function registerLogoRoutes(app, { db }) {
  app.register(async scoped => {
    // Osobny zakres parsera jak przy załącznikach wiadomości; formularz działa bez JS.
    // Bajt zapasu rozróżnia dozwolone 256 KB od przekroczenia limitu strumienia.
    await scoped.register(multipart, { limits: { files: 1, fileSize: MAKS_LOGO + 1, fields: 1, fieldSize: 800, parts: 2 } });
    scoped.post(ADRES, async (req, reply) => {
      const brakDostepu = sprawdzDostep(req, reply, app.logoInstalacji);
      if (brakDostepu) return brakDostepu;
      let bajty = null;
      let alt = '';
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            const bufor = await part.toBuffer();
            if (part.file.truncated || bufor.length > MAKS_LOGO) return odmowa(reply, 400, 'Plik większy niż 256 KB');
            if (part.fieldname !== 'logo') return odmowa(reply, 400, 'Wybierz plik logo.');
            bajty = bufor;
          } else {
            if (part.fieldname !== 'alt' || part.valueTruncated || String(part.value).length > 200) return odmowa(reply, 400, 'Tekst alternatywny może mieć do 200 znaków.');
            alt = String(part.value).trim();
          }
        }
      } catch (e) {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE') return odmowa(reply, 400, 'Plik większy niż 256 KB');
        return odmowa(reply, 400, 'Nie udało się odczytać formularza logo. Wybierz jeden plik PNG i spróbuj ponownie.');
      }
      if (!bajty || !czyPng(bajty)) return odmowa(reply, 400, 'Plik nie jest obrazem PNG');
      zapiszKonfiguracjeIntegracji(db, 'logo', { ustawienia: { png: bajty.toString('base64'), alt }, sekrety: {} },
        { konto: { id: req.konto.id ?? null, login: req.konto.login ?? null } });
      return reply.code(303).redirect('/ustawienia/firma?logo=zapisano#logo');
    });
    scoped.post(`${ADRES}/usun`, async (req, reply) => {
      const brakDostepu = sprawdzDostep(req, reply, app.logoInstalacji);
      if (brakDostepu) return brakDostepu;
      usunKonfiguracjeIntegracji(db, 'logo');
      return reply.code(303).redirect('/ustawienia/firma?logo=usunieto#logo');
    });
  });
}
