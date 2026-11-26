// Home (T31) constants, kept apart from HomeScreen.tsx so that file exports only components.

/** Shown in Try asking until the owner has asked anything (R14). */
export const TRY_ASKING_EXAMPLES = [
  'What did I decide about the project roadmap?',
  'Which repo handles sign-in?',
  'Where are my notes on setting up Docker?',
] as const

/** How far back the Recent changes card looks. */
export const RECENT_CHANGES_DAYS = 30
