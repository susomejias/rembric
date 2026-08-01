import { describe, expect, it } from 'vitest';

import { STOPWORD_LANGUAGES, suggestTopicKey, topicKeyPrefix } from './topic-key.js';

/** Throws when the suggestion is a refusal, so the fixtures below read as strings. */
function key(input: { type: string; title?: string; content?: string }): string {
  const s = suggestTopicKey(input);
  if (s.topicKey === null) throw new Error(`expected a key, got refusal: ${s.reason}`);
  return s.topicKey;
}

describe('suggestTopicKey — deterministic family + slug', () => {
  it('produces a stable slug for the same input', () => {
    expect(key({ type: 'project', title: 'JWT auth middleware' })).toBe(
      key({ type: 'project', title: 'JWT auth middleware' }),
    );
  });

  it('maps type families', () => {
    expect(key({ type: 'project', title: 'alpha' })).toMatch(/^decision\//);
    expect(key({ type: 'user', title: 'alpha' })).toMatch(/^preference\//);
    expect(key({ type: 'feedback', title: 'alpha' })).toMatch(/^feedback\//);
    expect(key({ type: 'reference', title: 'alpha' })).toMatch(/^reference\//);
    expect(key({ type: 'procedural', title: 'alpha' })).toMatch(/^runbook\//);
  });

  it('drops stopwords and joins surviving tokens', () => {
    expect(key({ type: 'project', title: 'A note about the auth model' })).toBe(
      'decision/note-auth-model',
    );
  });

  it('caps at 6 tokens', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india';
    expect(
      key({ type: 'project', title: long }).split('/')[1]!.split('-').length,
    ).toBeLessThanOrEqual(6);
  });

  it('caps slug length at 48 chars and trims trailing hyphens', () => {
    const slug = key({ type: 'project', title: 'verylongword '.repeat(10) }).split('/')[1] ?? '';
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to content when title is missing', () => {
    expect(key({ type: 'feedback', content: 'use two-space indentation' })).toBe(
      'feedback/use-two-space-indentation',
    );
  });
});

describe('suggestTopicKey — English output must not move', () => {
  // Pinned against the pre-change implementation. If the stopword set is ever
  // over-extended these are the assertions that catch it.
  it.each([
    [
      'feedback',
      'Check the port before launching a server on the miniPC',
      'feedback/check-port-launching-server-minipc',
    ],
    [
      'project',
      'Rack ventilation: two 92 mm intake fans at the bottom and the 140 exhausting on top',
      'decision/rack-ventilation-two-92-mm-intake',
    ],
  ] as const)('%s / %s', (type, title, expected) => {
    expect(key({ type, title })).toBe(expected);
  });
});

/**
 * One row per language the transliteration must handle. Enabling a language in
 * `STOPWORD_LANGUAGES` moves rows here, so the coverage trade is visible in the
 * diff instead of being discovered later.
 */
const LANGUAGE_MATRIX: ReadonlyArray<{
  lang: string;
  type: string;
  title: string;
  expected: string | null;
}> = [
  {
    lang: 'en',
    type: 'project',
    title: 'Rack ventilation: two 92 mm intake fans at the bottom and the 140 exhausting on top',
    expected: 'decision/rack-ventilation-two-92-mm-intake',
  },
  {
    lang: 'en',
    type: 'feedback',
    title: 'Check the port before launching a server on the miniPC',
    expected: 'feedback/check-port-launching-server-minipc',
  },
  {
    lang: 'es',
    type: 'project',
    title: 'El disco duro del vault se calienta 12 grados en reposo por estar tumbado',
    expected: 'decision/disco-duro-vault-calienta-12-grados',
  },
  {
    lang: 'es',
    type: 'feedback',
    title: 'Antes de levantar un servidor en el miniPC hay que comprobar el puerto',
    expected: 'feedback/antes-levantar-servidor-minipc-hay-comprobar',
  },
  {
    lang: 'es',
    type: 'project',
    title: 'Ventilación del rack: 2x 92 mm de admisión abajo y el 140 arriba extrayendo',
    expected: 'decision/ventilacion-rack-2x-92-mm-admision',
  },
  // Particles survive in languages not enabled — the deliberate coverage limit.
  {
    lang: 'de',
    type: 'user',
    title: 'Präferenz für Größe der Fenster',
    expected: 'preference/praferenz-fur-grosse-der-fenster',
  },
  {
    lang: 'fr',
    type: 'project',
    title: 'Configuration du réseau derrière le pare-feu',
    expected: 'decision/configuration-du-reseau-derriere-pare-feu',
  },
  {
    lang: 'pt',
    type: 'project',
    title: 'Aumentámos o pool de conexões da base de dados',
    expected: 'decision/aumentamos-pool-conexoes-da-base-dados',
  },
  {
    lang: 'it',
    type: 'project',
    title: 'Ventilazione del rack con due ventole da 92 mm',
    expected: 'decision/ventilazione-rack-due-ventole-da-92',
  },
  { lang: 'da', type: 'project', title: 'Køb af større ø', expected: 'decision/kob-af-storre' },
  {
    lang: 'ru',
    type: 'project',
    title: 'Пул соединений базы данных увеличен до 20',
    expected: 'decision/pul-soedinenij-bazy-dannyh-uvelichen-20',
  },
  {
    lang: 'el',
    type: 'project',
    title: 'Ρύθμιση αερισμού για το rack',
    expected: 'decision/ry8mish-aerismoy-gia-rack',
  },
  {
    lang: 'tr',
    type: 'project',
    title: 'Veritabanı bağlantı havuzu 20ye çıkarıldı',
    expected: 'decision/veritabani-baglanti-havuzu-20ye-cikarildi',
  },
  {
    lang: 'pl',
    type: 'project',
    title: 'Zwiększono pulę połączeń bazy danych',
    expected: 'decision/zwiekszono-pule-polaczen-bazy-danych',
  },
  // No transliteration reaches these scripts, so no key is offered.
  { lang: 'ja', type: 'project', title: 'データベースの接続プールを20に増やした', expected: null },
  { lang: 'zh', type: 'project', title: '資料庫連線池調整為 20', expected: null },
  { lang: 'ko', type: 'user', title: '한국어 선호 설정', expected: null },
];

describe('suggestTopicKey — language matrix', () => {
  it.each(LANGUAGE_MATRIX)('$lang: $title', ({ type, title, expected }) => {
    expect(suggestTopicKey({ type, title }).topicKey).toBe(expected);
  });

  it('pins the enabled languages: widening this set is a measured decision', () => {
    expect(STOPWORD_LANGUAGES).toEqual(['eng', 'spa']);
  });

  it('covers every script class the transliteration claims to handle', () => {
    const langs = new Set(LANGUAGE_MATRIX.map((r) => r.lang));
    for (const required of ['en', 'es', 'de', 'ru', 'el', 'ja', 'ko']) {
      expect(langs).toContain(required);
    }
  });
});

describe('suggestTopicKey — properties that must hold in every language', () => {
  const withKeys = LANGUAGE_MATRIX.filter((r) => r.expected !== null);

  it('is deterministic', () => {
    for (const { type, title } of LANGUAGE_MATRIX) {
      expect(suggestTopicKey({ type, title }).topicKey).toBe(
        suggestTopicKey({ type, title }).topicKey,
      );
    }
  });

  it('never exceeds the token or character budget', () => {
    for (const { expected } of withKeys) {
      const slug = expected!.split('/')[1]!;
      expect(slug.split('-').length).toBeLessThanOrEqual(6);
      expect(slug.length).toBeLessThanOrEqual(48);
      expect(slug.endsWith('-')).toBe(false);
    }
  });

  it('emits only URL-safe ASCII', () => {
    for (const { expected } of withKeys) {
      expect(expected!).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
    }
  });

  it('yields at least two tokens, so no key is a bare word or number', () => {
    for (const { expected } of withKeys) {
      expect(expected!.split('/')[1]!.split('-').length).toBeGreaterThanOrEqual(2);
    }
  });
});

/**
 * The guard that would have caught the measured regressions: `romance+germanic`
 * eats `dos` and `mit`, and all 60 languages eat `global`, `save` and `stop`.
 */
describe("suggestTopicKey — this repo's vocabulary must survive the filter", () => {
  const PROTECTED = [
    'global',
    'scope',
    'project',
    'memory',
    'save',
    'judge',
    'compare',
    'search',
    'index',
    'query',
    'plan',
    'scan',
    'token',
    'session',
    'prompt',
    'entity',
    'relation',
    'pending',
    'active',
    'archived',
    'superseded',
    'topic',
    'slug',
    'trigger',
    'table',
    'row',
    'null',
    'stop',
    'start',
    'port',
    'path',
    'file',
    'test',
    'dos',
    'mit',
    'die',
    'der',
    'sudo',
    'cron',
    'diff',
    'head',
  ] as const;

  it.each(PROTECTED)('keeps %s', (word) => {
    const key = suggestTopicKey({
      type: 'project',
      title: `${word} handling in the server`,
    }).topicKey;
    expect(key).toContain(word);
  });
});

describe('suggestTopicKey — refuses rather than inventing a colliding key', () => {
  it.each([
    ['user', '한국어 선호 설정'],
    ['project', 'データベースの接続プールを20に増やした'],
    ['project', '資料庫連線池調整為 20'],
  ] as const)('%s / %s yields no key', (type, title) => {
    const s = suggestTopicKey({ type, title });
    expect(s.topicKey).toBeNull();
    expect(s.reason).toBeTruthy();
  });

  it('refuses on empty input rather than returning a shared placeholder', () => {
    for (const input of [{ type: 'project', title: '' }, { type: 'project' }]) {
      const s = suggestTopicKey(input);
      expect(s.topicKey).toBeNull();
      expect(s.reason).toBeTruthy();
    }
  });

  it('three unrelated non-transliterable titles no longer share a key', () => {
    const keys = [
      'データベースの接続プールを20に増やした',
      '資料庫連線池調整為 20',
      '한국어 선호 설정',
    ].map((title) => suggestTopicKey({ type: 'project', title }).topicKey);
    expect(keys).toEqual([null, null, null]);
  });

  it('refuses when the kept tokens are all numeric, even if a later word exists', () => {
    const s = suggestTopicKey({ type: 'project', title: '20 20 20 20 20 20 rack' });
    expect(s.topicKey).toBeNull();
  });

  it('still suggests when the title carries usable ASCII alongside another script', () => {
    expect(key({ type: 'project', title: '한국어 rack ventilation' })).toBe(
      'decision/rack-ventilation',
    );
  });
});

describe('topicKeyPrefix', () => {
  it('keeps the family and the first two slug tokens', () => {
    expect(topicKeyPrefix('decision/dev-stack-chown')).toBe('decision/dev-stack');
  });

  it('bridges two phrasings of one Spanish topic', () => {
    const a = key({ type: 'project', title: 'El disco duro del vault se calienta mucho' });
    const b = key({ type: 'project', title: 'Disco duro del vault: temperatura en reposo' });
    expect(topicKeyPrefix(a)).toBe(topicKeyPrefix(b));
  });
});
