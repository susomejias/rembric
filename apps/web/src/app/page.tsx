import { REMBRIC_VERSION } from '../lib/version';

export default function HomePage() {
  return (
    <main>
      <h1>Rembric</h1>
      <p>Server version: {REMBRIC_VERSION}</p>
    </main>
  );
}
