export const QUALITY_PRESETS = [
  'auto',
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const;

export type QualityPreset = (typeof QUALITY_PRESETS)[number];
export type QualityMode = 'auto' | 'manual';
export type SkyboxMode = 'off' | 'space-2k' | 'space-8k';

export interface SettingsState {
  readonly version: 1;
  readonly qualityMode: QualityMode;
  readonly preset: QualityPreset;
  readonly pixelRatio: number;
  readonly antialiasing: boolean;
  readonly nebulaDensity: number;
  readonly dustDensity: number;
  readonly nodeLod: number;
  readonly edgeBrightness: number;
  readonly skyboxMode: SkyboxMode;
  readonly exposure: number;
  readonly fogDensity: number;
  readonly autoOrbit: boolean;
  readonly pulse: boolean;
  readonly motionScale: number;
  readonly cameraSensitivity: number;
  readonly pointerMode: 'hover' | 'camera';
  readonly showKubo: boolean;
  readonly showDiscovered: boolean;
  readonly showLatencyRings: boolean;
}

export type SettingsPatch = Partial<Omit<SettingsState, 'version'>>;

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SettingsListener = (settings: SettingsState) => void;
