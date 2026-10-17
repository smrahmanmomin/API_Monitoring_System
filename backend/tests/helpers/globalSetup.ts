import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './testEnv.js';

/** Apply migrations to the isolated test database once before the suite runs. */
export default function setup(): void {
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
