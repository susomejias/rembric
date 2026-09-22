import { createServer as createNetServer } from 'node:net';

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createNetServer();
    sock.unref();
    sock.on('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      if (!addr || typeof addr === 'string') {
        sock.close();
        reject(new Error('expected an AddressInfo'));
        return;
      }
      const { port } = addr;
      sock.close(() => resolve(port));
    });
  });
}
