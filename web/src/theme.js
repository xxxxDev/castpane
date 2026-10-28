import { computed, readonly, ref } from 'vue';

const STORAGE_KEY = 'castpane-theme';
const ACCENT_STORAGE_KEY = 'castpane-accent';
const DEFAULT_THEME = 'dark';
const MODE_DEFAULT_ACCENTS = Object.freeze({
  light: '#000000',
  dark: '#ffffff',
});
const DEFAULT_THEME_CONFIG = Object.freeze({
  defaultMode: DEFAULT_THEME,
  allowUserModeToggle: true,
  allowUserAccent: true,
  accentMode: 'mode-default',
  accent: '#0a84ff',
  darkPage: '#121212',
  lightPage: '#f2f2f7',
});

const theme = ref(DEFAULT_THEME);
const themeConfig = ref({ ...DEFAULT_THEME_CONFIG });
const userAccent = ref(null);

function normalizeTheme(value, fallback = DEFAULT_THEME) {
  return value === 'light' || value === 'dark' ? value : fallback;
}

export function normalizeAccent(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.slice(1).split('').map((part) => part + part).join('')}`;
  }
  return null;
}

export function normalizeThemeConfig(value = {}) {
  const configuredAccent = normalizeAccent(value?.accent);
  const explicitAccentMode = value?.accentMode === 'mode-default' || value?.accentMode === 'custom'
    ? value.accentMode
    : null;
  return {
    defaultMode: normalizeTheme(value?.defaultMode, DEFAULT_THEME),
    allowUserModeToggle: value?.allowUserModeToggle ?? value?.allowUserToggle ?? true,
    allowUserAccent: value?.allowUserAccent ?? true,
    // Schema 1.0 stored only an accent string, which represented a custom project accent.
    accentMode: explicitAccentMode || (configuredAccent ? 'custom' : 'mode-default'),
    accent: configuredAccent || DEFAULT_THEME_CONFIG.accent,
    darkPage: normalizeAccent(value?.darkPage) || DEFAULT_THEME_CONFIG.darkPage,
    lightPage: normalizeAccent(value?.lightPage) || DEFAULT_THEME_CONFIG.lightPage,
  };
}

export function configureTheme(value = {}) {
  themeConfig.value = normalizeThemeConfig(value);
  return themeConfig.value;
}

function readStoredTheme() {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch (error) {
    return null;
  }
}

function readStoredAccent() {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeAccent(window.localStorage.getItem(ACCENT_STORAGE_KEY));
  } catch (error) {
    return null;
  }
}

function configuredAccent(mode = theme.value) {
  if (themeConfig.value.accentMode === 'custom') return themeConfig.value.accent;
  return MODE_DEFAULT_ACCENTS[normalizeTheme(mode, DEFAULT_THEME)];
}

const accent = computed(() => userAccent.value || configuredAccent());
const accentMode = computed(() => (
  userAccent.value || themeConfig.value.accentMode === 'custom' ? 'custom' : 'mode-default'
));
const userSettings = computed(() => ({
  allowUserModeToggle: themeConfig.value.allowUserModeToggle,
  allowUserAccent: themeConfig.value.allowUserAccent,
}));

export function accentRecipe(value) {
  const normalized = normalizeAccent(value);
  if (!normalized) return null;
  const hex = normalized.slice(1);
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const shade = rgb.map((channel) => Math.max(0, Math.round(channel * 0.86)));
  const tint = rgb.map((channel) => Math.min(255, Math.round(channel + ((255 - channel) * 0.16))));
  const linear = rgb.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const toHex = (parts) => `#${parts.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  return {
    '--cc-color-accent': normalized,
    '--cc-color-accent-rgb': rgb.join(', '),
    '--cc-color-accent-shade': toHex(shade),
    '--cc-color-accent-tint': toHex(tint),
    // 0.179 is the point where black provides more WCAG contrast than white.
    '--cc-color-on-accent': luminance > 0.179 ? '#000000' : '#ffffff',
  };
}

function themeTargets() {
  if (typeof document === 'undefined') return [];
  return [
    document.documentElement,
    document.body,
    document.querySelector('#app'),
    document.querySelector('.framework7-root'),
  ].filter(Boolean);
}

function syncFramework7Variables() {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('.framework7-root');
  if (!root) return;
  root.style.setProperty('--f7-theme-color', 'var(--cc-color-accent)');
  root.style.setProperty('--f7-theme-color-rgb', 'var(--cc-color-accent-rgb)');
  root.style.setProperty('--f7-theme-color-shade', 'var(--cc-color-accent-shade)');
  root.style.setProperty('--f7-theme-color-tint', 'var(--cc-color-accent-tint)');
  root.style.setProperty('--f7-button-fill-text-color', 'var(--cc-color-on-accent)');
  root.style.setProperty('--f7-page-bg-color', 'var(--cc-color-page)');
  root.style.setProperty('--f7-bars-bg-color', 'var(--cc-color-bars)');
}

function renderAccent() {
  const variables = accentRecipe(accent.value);
  if (!variables) return null;
  const custom = accentMode.value === 'custom';
  themeTargets().forEach((target) => {
    Object.entries(variables).forEach(([name, value]) => target.style.setProperty(name, value));
    target.classList.toggle('accent-custom', custom);
    target.classList.toggle('accent-default', !custom);
    target.dataset.accentMode = custom ? 'custom' : 'mode-default';
  });
  syncFramework7Variables();
  return accent.value;
}

export function applyAccent(value, { persist = false } = {}) {
  const next = normalizeAccent(value);
  if (!next) return null;
  userAccent.value = next;
  renderAccent();

  if (persist && typeof window !== 'undefined') {
    try { window.localStorage.setItem(ACCENT_STORAGE_KEY, next); } catch (error) { /* ignore */ }
  }
  return next;
}

// Backward-compatible helper used by older integrations. New code should call configureTheme().
export function setDefaultAccent(value) {
  const next = normalizeAccent(value);
  configureTheme({
    ...themeConfig.value,
    accentMode: next ? 'custom' : 'mode-default',
    accent: next || themeConfig.value.accent,
  });
  return initAccent();
}

export function initAccent({ ignoreStored = false } = {}) {
  userAccent.value = ignoreStored ? null : readStoredAccent();
  return renderAccent();
}

export function setAccent(value) {
  return applyAccent(value, { persist: true });
}

export function resetAccent() {
  if (typeof window !== 'undefined') {
    try { window.localStorage.removeItem(ACCENT_STORAGE_KEY); } catch (error) { /* ignore */ }
  }
  userAccent.value = null;
  return renderAccent();
}

export function applyTheme(value = theme.value, { persist = false } = {}) {
  const next = normalizeTheme(value, themeConfig.value.defaultMode);
  theme.value = next;
  const isDark = next === 'dark';
  const pageColor = isDark ? themeConfig.value.darkPage : themeConfig.value.lightPage;

  themeTargets().forEach((target) => {
    target.classList.add('ios');
    target.classList.toggle('dark', isDark);
    target.classList.toggle('light', !isDark);
    target.dataset.theme = next;
    target.style.setProperty('--cc-color-page', pageColor);
  });
  renderAccent();

  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', pageColor);
  }

  if (persist && typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch (error) { /* ignore */ }
  }
  return next;
}

export function initTheme({ ignoreStored = false } = {}) {
  const initial = ignoreStored ? themeConfig.value.defaultMode : readStoredTheme() || themeConfig.value.defaultMode;
  return applyTheme(initial, { persist: false });
}

export function setTheme(value) {
  return applyTheme(value, { persist: true });
}

export function toggleTheme() {
  return setTheme(theme.value === 'dark' ? 'light' : 'dark');
}

export function useTheme() {
  return {
    theme: readonly(theme),
    themeConfig: readonly(themeConfig),
    userSettings,
    accent,
    accentMode,
    setTheme,
    toggleTheme,
    applyTheme,
    setAccent,
    resetAccent,
    applyAccent,
  };
}

export {
  ACCENT_STORAGE_KEY,
  DEFAULT_THEME,
  DEFAULT_THEME_CONFIG,
  MODE_DEFAULT_ACCENTS,
  STORAGE_KEY,
};
