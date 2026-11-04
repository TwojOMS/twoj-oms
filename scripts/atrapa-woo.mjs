import { createAtrapaWooHttp } from '../deploy/proba/atrapy/woo-http.mjs';

const port = Number(process.argv[2]);
const tryb = process.argv[3];
const przekierowanie = process.argv[4];
if (!Number.isInteger(port) || port < 1 || port > 65535 || (tryb && !['401', '404', '301'].includes(tryb))) {
  throw new Error('Użycie: node scripts/atrapa-woo.mjs PORT [401|404|301] [ADRES_PRZEKIEROWANIA]');
}
createAtrapaWooHttp({ tryb, przekierowanie }).listen(port, '127.0.0.1', () => console.log(`Atrapa Woo nasłuchuje na 127.0.0.1:${port}`));
