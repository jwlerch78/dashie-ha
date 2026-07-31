/**
 * Dashie Lite Configuration
 *
 * This config drives backend routing for LLM, STT, TTS, and data sources.
 * Users can configure cloud vs local backends via the HA addon settings.
 *
 * Part of the Unified NLP Architecture for Dashie Lite 3.0.
 * See: .reference/build-plans/20260122_UNIFIED_NLP_ARCHITECTURE.md
 */

// Default configuration - can be overridden by addon server injection
const defaultConfig = {
  // ═══════════════════════════════════════════════════════════════════
  // LLM CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════
  llm: {
    enabled: true,                   // LLM available via Ollama
    provider: 'local',              // 'local' | 'cloud' | 'hybrid'

    // Local: Addon server proxies to Ollama/HA
    localEndpoint: '/api/llm/chat',
    localModel: 'qwen2.5:1.5b',    // Ollama model

    // Cloud: Supabase Edge Function (same as Dashie Standard)
    cloudEndpoint: 'https://cwglbtosingboqepsmjk.supabase.co/functions/v1/ai-gateway',
    cloudModel: 'claude-sonnet-4-20250514',

    // Provider-specific options
    max_tokens: 300,                // Keep low for faster local model responses
    temperature: 0.7,

    // Hybrid: Try local first, fall back to cloud on failure
    hybridFallbackOnError: true,
    hybridFallbackOnTimeout: 5000,  // ms
  },

  // ═══════════════════════════════════════════════════════════════════
  // STT CONFIGURATION (Speech-to-Text)
  // ═══════════════════════════════════════════════════════════════════
  stt: {
    provider: 'local',              // 'local' | 'cloud'

    // Local: Wyoming Whisper via addon server
    localEndpoint: '/api/voice/transcribe',

    // Cloud: Deepgram via Supabase Edge Function
    cloudEndpoint: 'https://cwglbtosingboqepsmjk.supabase.co/functions/v1/deepgram-stt',
  },

  // ═══════════════════════════════════════════════════════════════════
  // TTS CONFIGURATION (Text-to-Speech)
  // ═══════════════════════════════════════════════════════════════════
  tts: {
    provider: 'local',              // 'local' | 'cloud'

    // Local: Wyoming Piper via addon server
    localEndpoint: '/api/voice/synthesize',
    localVoice: 'en_US-lessac-medium',

    // Cloud: ElevenLabs via Supabase Edge Function
    cloudEndpoint: 'https://cwglbtosingboqepsmjk.supabase.co/functions/v1/elevenlabs-tts',
    cloudVoice: 'pMsXgVXv3BLzUgSXRplE',  // Dashie voice
  },

  // ═══════════════════════════════════════════════════════════════════
  // DATA SOURCE CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════
  data: {
    // Calendar events
    calendar: 'ha',                 // 'ha' | 'cloud'

    // Weather
    weather: 'ha',                  // 'ha' | 'cloud'

    // Family members
    family: 'ha',                   // 'ha' | 'cloud'

    // Chores/Tasks
    chores: 'ha',                   // 'ha' | 'cloud'
  },

  // ═══════════════════════════════════════════════════════════════════
  // FEATURE FLAGS
  // ═══════════════════════════════════════════════════════════════════
  features: {
    streaming: false,               // Streaming not yet implemented for local
    localIntentClassification: true, // Bypass AI for simple commands
    sessionMemory: false,           // Conversation context (requires more tokens)
    analytics: false,               // Log interactions to Supabase
  },

  // ═══════════════════════════════════════════════════════════════════
  // VERSION INFO
  // ═══════════════════════════════════════════════════════════════════
  version: '3.0.0',
  platform: 'dashie-lite'
};

// Merge with server-injected config (if any)
const serverConfig = window.DASHIE_SERVER_CONFIG || {};

// Deep merge helper
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Export merged config
export const DASHIE_CONFIG = deepMerge(defaultConfig, serverConfig);

// Also expose globally for debugging and non-module scripts
window.DASHIE_CONFIG = DASHIE_CONFIG;

// Helper functions for common config access patterns
export function getLLMEndpoint() {
  const { llm } = DASHIE_CONFIG;
  return llm.provider === 'cloud' ? llm.cloudEndpoint : llm.localEndpoint;
}

export function getLLMModel() {
  const { llm } = DASHIE_CONFIG;
  return llm.provider === 'cloud' ? llm.cloudModel : llm.localModel;
}

export function getSTTEndpoint() {
  const { stt } = DASHIE_CONFIG;
  return stt.provider === 'cloud' ? stt.cloudEndpoint : stt.localEndpoint;
}

export function getTTSEndpoint() {
  const { tts } = DASHIE_CONFIG;
  return tts.provider === 'cloud' ? tts.cloudEndpoint : tts.localEndpoint;
}

export function isLocalLLM() {
  return DASHIE_CONFIG.llm.provider === 'local';
}

export function isCloudLLM() {
  return DASHIE_CONFIG.llm.provider === 'cloud';
}

export function isHybridLLM() {
  return DASHIE_CONFIG.llm.provider === 'hybrid';
}

export function isLLMEnabled() {
  return DASHIE_CONFIG.llm.enabled === true;
}

export default DASHIE_CONFIG;
