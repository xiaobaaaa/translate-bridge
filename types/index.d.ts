export type Mode = 'off' | 'only' | 'bilingual'

// A reply's translation: one string per translatable block, or the whole text when the
// provider could not keep the blocks apart (and for a step label).
export type Translation = { blocks?: string[]; whole?: string }

declare module 'claude-code' {
  interface PluginState {
    'translate-bridge': {
      mode: Mode
      // Translations of replies and step labels, by a hash of target language and source text.
      translated: StateFamily<Translation>
      // The text as typed for each English prompt sent, by a hash of the English.
      original: StateFamily<string>
      // The English sent for each prompt as typed, by a hash of the text typed.
      english: StateFamily<string>
    }
  }
}
