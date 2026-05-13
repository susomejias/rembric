import { loadConfig, redactConfig } from '../config.js';
import { LlmClient, LlmError } from '../llm/index.js';

export async function runLlmPing(): Promise<void> {
  const config = loadConfig();
  const client = new LlmClient({
    baseUrl: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
  });

  process.stderr.write(`rembric: pinging ${config.llm.baseUrl} …\n`);

  try {
    const { latencyMs } = await client.ping(config.llm.model);
    process.stdout.write(JSON.stringify({ ok: true, latencyMs }, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    if (err instanceof LlmError) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            code: err.code,
            message: err.message,
            config: redactConfig(config).llm,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ ok: false, code: 'unknown', message }, null, 2) + '\n');
    }
    process.exit(1);
  }
}
