/** Test database (created by docker/postgres/init-test-db.sql). Never the development database. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://apimonitor:apimonitor_dev_password@localhost:5433/apimonitor_test?schema=public';

if (!TEST_DATABASE_URL.includes('test')) {
  throw new Error('Refusing to run integration tests against a database whose name does not contain "test"');
}
