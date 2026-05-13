/* eslint-env node */
module.exports = {
  apps: [
    {
      name: 'rembric',
      // Install once with `pnpm add -g rembric` or `npm i -g rembric` so
      // the binary is on $PATH for pm2 to launch.
      script: 'rembric',
      env: {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: '8787',
        // REMBRIC_ADMIN_TOKEN: 'set-me-on-first-run',
        // LLM_PROVIDER: 'openai',
        // OPENAI_BASE_URL: 'http://localhost:11434/v1',
        // OPENAI_API_KEY: 'ollama',
        // OPENAI_MODEL: 'qwen2.5:7b-instruct-q4_K_M',
        // OPENAI_EMBEDDING_MODEL: 'nomic-embed-text:latest',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      out_file: '~/.pm2/logs/rembric.out.log',
      error_file: '~/.pm2/logs/rembric.err.log',
      time: true,
    },
  ],
};
