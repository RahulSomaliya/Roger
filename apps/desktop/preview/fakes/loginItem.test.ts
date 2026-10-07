import { describe, expect, it } from 'vitest';
import { loginItemChannels } from '../../src/shared/ipc/loginItem';
import { createLoginItemFake } from './loginItem';
import { FakeHub } from './hub';

describe('the preview login item', () => {
  it('starts unavailable, like a build that is not packaged', async () => {
    const fake = createLoginItemFake(new FakeHub());
    await expect(fake.getLoginItemState()).resolves.toEqual({ status: 'unavailable' });
  });

  it('answers with, and announces, a state a scenario sends', async () => {
    const hub = new FakeHub();
    const fake = createLoginItemFake(hub);
    const heard: string[] = [];
    fake.onLoginItemStateChanged((state) => heard.push(state.status));

    hub.emit(loginItemChannels.LoginItemStateChanged, { status: 'requires-approval' });

    expect(heard).toEqual(['requires-approval']);
    await expect(fake.getLoginItemState()).resolves.toEqual({ status: 'requires-approval' });
  });

  it('rejects the next request a scenario fails, as main would', async () => {
    const hub = new FakeHub();
    const fake = createLoginItemFake(hub);
    hub.failNextRequest('macOS did not answer');
    await expect(fake.getLoginItemState()).rejects.toThrow('macOS did not answer');
  });
});
