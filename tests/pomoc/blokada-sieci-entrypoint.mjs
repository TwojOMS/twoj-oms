import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const odmow = () => {
  console.error('PRZ030: ZABRONIONE WYJŚCIE DO SIECI');
  process.exit(90);
};
globalThis.fetch = odmow;
net.Socket.prototype.connect = odmow;
tls.connect = odmow;
syncBuiltinESMExports();
