import { createApplication } from './bootstrap.js';
import { environment } from './config/runtime.js';

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  await app.listen(environment.PORT, environment.HOST);
}

void bootstrap().catch(() => {
  console.error('operation-service startup failed. Check .env, public key and database using npm run doctor / db:check.');
  process.exitCode = 1;
});
