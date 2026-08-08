/** Public API consumer fixture under NodeNext module resolution. */
import { createHotplugApp, HotplugError, type Account, type Hotplug, type Provider } from 'hotplug';

async function main(): Promise<void> {
  const app: Hotplug = await createHotplugApp({ root: '/tmp/hotplug-consumer-nodenext' });
  const listed = await app.accounts.list('codex');
  const first = listed[0];
  if (first) {
    const name: string = first.name;
    void name;
  }

  const account: Account | null = await app.accounts.get('codex', 'work');
  if (account) {
    const dir: string = account.snapshotDir;
    void dir;
  }

  // @ts-expect-error stores and the database are not on the stable facade.
  void app.db;
  const providers: Provider[] = app.accountRegistry.list();
  void providers;
  await app.doctor.run();
  app.close();

  const err = new HotplugError('IMPORT_FORMAT', 'bad payload');
  void err;
}

void main();
