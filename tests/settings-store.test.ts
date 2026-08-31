import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/settings/settings-defaults';
import { readSettings, SettingsStore } from '../src/settings/settings-store';
import type { SettingsStorage } from '../src/settings/settings-types';

function memoryStorage(initial: string | null = null): SettingsStorage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

describe('settings store', () => {
  it('defaults to adaptive quality and persists validated settings', () => {
    const store = new SettingsStore(memoryStorage());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const next = store.update({ pixelRatio: 99, fogDensity: -1 });
    expect(next.qualityMode).toBe('auto');
    expect(next.pixelRatio).toBe(1.5);
    expect(next.fogDensity).toBe(0);
  });

  it('expands beginner presets and resets to auto', () => {
    const store = new SettingsStore(memoryStorage());
    expect(store.applyPreset('lowest').skyboxMode).toBe('off');
    expect(store.get().qualityMode).toBe('manual');
    expect(store.applyPreset('highest').pixelRatio).toBe(1.5);
    expect(store.reset().preset).toBe('auto');
    expect(store.get().qualityMode).toBe('auto');
  });

  it('recovers from malformed or unknown storage', () => {
    expect(readSettings('{broken')).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(JSON.stringify({ version: 2 }))).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(
      readSettings(JSON.stringify({ version: 1, pixelRatio: 'x' })),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it('notifies subscribers and validates pointer/skybox values', () => {
    const store = new SettingsStore(memoryStorage());
    const seen: string[] = [];
    const unsubscribe = store.subscribe((settings) => {
      seen.push(`${settings.pointerMode}:${settings.skyboxMode}`);
    });
    store.update({ pointerMode: 'camera', skyboxMode: 'space-8k' });
    unsubscribe();
    store.update({ pointerMode: 'invalid' as never });
    expect(seen).toEqual(['hover:space-2k', 'camera:space-8k']);
    expect(store.get().pointerMode).toBe('hover');
  });
});
