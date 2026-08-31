import {
  DEFAULT_SETTINGS,
  PRESET_SETTINGS,
  SETTINGS_STORAGE_KEY,
} from './settings-defaults';
import {
  QUALITY_PRESETS,
  type QualityPreset,
  type SettingsListener,
  type SettingsPatch,
  type SettingsState,
  type SettingsStorage,
} from './settings-types';

const DEFAULT_STORAGE: SettingsStorage = {
  getItem: (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Private browsing and blocked storage are valid browser contexts.
    }
  },
};

export class SettingsStore {
  readonly #storage: SettingsStorage;
  readonly #listeners = new Set<SettingsListener>();
  #settings: SettingsState;

  constructor(storage: SettingsStorage = DEFAULT_STORAGE) {
    this.#storage = storage;
    this.#settings = readSettings(storage.getItem(SETTINGS_STORAGE_KEY));
  }

  get(): SettingsState {
    return this.#settings;
  }

  update(patch: SettingsPatch): SettingsState {
    this.#settings = sanitizeSettings({ ...this.#settings, ...patch });
    this.#persist();
    this.#notify();
    return this.#settings;
  }

  applyPreset(preset: QualityPreset): SettingsState {
    if (preset === 'auto') {
      return this.update({
        ...DEFAULT_SETTINGS,
        preset,
        qualityMode: 'auto',
      });
    }
    return this.update({
      ...PRESET_SETTINGS[preset],
      preset,
    });
  }

  reset(): SettingsState {
    return this.update(DEFAULT_SETTINGS);
  }

  subscribe(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    listener(this.#settings);
    return () => this.#listeners.delete(listener);
  }

  syncSerialized(value: string | null): SettingsState {
    this.#settings = readSettings(value);
    this.#notify();
    return this.#settings;
  }

  #persist(): void {
    try {
      this.#storage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(this.#settings),
      );
    } catch {
      // Private browsing and quota errors should not stop the observatory.
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#settings);
  }
}

export function readSettings(serialized: string | null): SettingsState {
  if (serialized === null) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1) return DEFAULT_SETTINGS;
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function sanitizeSettings(
  candidate: SettingsPatch & { readonly version?: unknown },
): SettingsState {
  const preset = QUALITY_PRESETS.includes(candidate.preset as QualityPreset)
    ? (candidate.preset as QualityPreset)
    : DEFAULT_SETTINGS.preset;
  const qualityMode = candidate.qualityMode === 'manual' ? 'manual' : 'auto';
  const skyboxMode =
    candidate.skyboxMode === 'off' ||
    candidate.skyboxMode === 'space-8k' ||
    candidate.skyboxMode === 'space-2k'
      ? candidate.skyboxMode
      : DEFAULT_SETTINGS.skyboxMode;
  const pointerMode =
    candidate.pointerMode === 'camera'
      ? 'camera'
      : DEFAULT_SETTINGS.pointerMode;
  return {
    version: 1,
    qualityMode,
    preset,
    pixelRatio: clampNumber(candidate.pixelRatio, 0.55, 1.5, 1),
    antialiasing: booleanOr(candidate.antialiasing, true),
    nebulaDensity: clampNumber(candidate.nebulaDensity, 0, 1, 1),
    dustDensity: clampNumber(candidate.dustDensity, 0, 1, 1),
    nodeLod: clampNumber(candidate.nodeLod, 0, 1, 1),
    edgeBrightness: clampNumber(candidate.edgeBrightness, 0.25, 1.5, 1),
    skyboxMode,
    exposure: clampNumber(candidate.exposure, 0.5, 1.8, 1.05),
    fogDensity: clampNumber(candidate.fogDensity, 0, 0.02, 0.0035),
    autoOrbit: booleanOr(candidate.autoOrbit, true),
    pulse: booleanOr(candidate.pulse, true),
    motionScale: clampNumber(candidate.motionScale, 0, 1.5, 1),
    cameraSensitivity: clampNumber(candidate.cameraSensitivity, 0.25, 2, 1),
    pointerMode,
    showKubo: booleanOr(candidate.showKubo, true),
    showDiscovered: booleanOr(candidate.showDiscovered, true),
    showLatencyRings: booleanOr(candidate.showLatencyRings, true),
  };
}

function clampNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
