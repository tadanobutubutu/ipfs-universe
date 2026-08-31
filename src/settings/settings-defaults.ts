import type { QualityPreset, SettingsState } from './settings-types';

export const SETTINGS_STORAGE_KEY = 'peerstellation.settings.v1';

export const DEFAULT_SETTINGS: SettingsState = {
  version: 1,
  qualityMode: 'auto',
  preset: 'auto',
  pixelRatio: 1,
  antialiasing: true,
  nebulaDensity: 1,
  dustDensity: 1,
  nodeLod: 1,
  edgeBrightness: 1,
  skyboxMode: 'space-2k',
  exposure: 1.05,
  fogDensity: 0.0035,
  autoOrbit: true,
  pulse: true,
  motionScale: 1,
  cameraSensitivity: 1,
  pointerMode: 'hover',
  showKubo: true,
  showDiscovered: true,
  showLatencyRings: true,
};

export const PRESET_SETTINGS: Record<
  Exclude<QualityPreset, 'auto'>,
  Partial<SettingsState>
> = {
  lowest: {
    qualityMode: 'manual',
    pixelRatio: 0.65,
    antialiasing: false,
    nebulaDensity: 0.2,
    dustDensity: 0.2,
    nodeLod: 0,
    edgeBrightness: 0.75,
    skyboxMode: 'off',
  },
  low: {
    qualityMode: 'manual',
    pixelRatio: 0.8,
    antialiasing: false,
    nebulaDensity: 0.45,
    dustDensity: 0.45,
    nodeLod: 0.35,
    edgeBrightness: 0.85,
    skyboxMode: 'space-2k',
  },
  medium: {
    qualityMode: 'manual',
    pixelRatio: 1,
    antialiasing: true,
    nebulaDensity: 0.7,
    dustDensity: 0.7,
    nodeLod: 0.65,
    edgeBrightness: 1,
    skyboxMode: 'space-2k',
  },
  high: {
    qualityMode: 'manual',
    pixelRatio: 1.25,
    antialiasing: true,
    nebulaDensity: 0.9,
    dustDensity: 0.9,
    nodeLod: 0.85,
    edgeBrightness: 1.05,
    skyboxMode: 'space-2k',
  },
  highest: {
    qualityMode: 'manual',
    pixelRatio: 1.5,
    antialiasing: true,
    nebulaDensity: 1,
    dustDensity: 1,
    nodeLod: 1,
    edgeBrightness: 1.15,
    skyboxMode: 'space-8k',
  },
};
