// Single source of truth for the Exercises database select options.
// Used by the API validation (logic.js), the app's dropdowns (delivered through /api/bootstrap) and scripts/setup-notion.mjs.
export const MUSCLE_GROUPS = [
  "Chest", "Upper Chest", "Lats", "Upper Back", "Traps", "Lower Back",
  "Front Delts", "Side Delts", "Rear Delts", "Biceps", "Triceps", "Forearms",
  "Quads", "Hamstrings", "Glutes", "Adductors", "Abductors", "Calves",
  "Abs", "Obliques", "Hip Flexors", "Neck", "Full Body", "Cardio",
];
export const EQUIPMENT = ["Barbell", "Dumbbell", "Cable", "Machine", "Bodyweight"];
export const EXERCISE_NAME_MAX = 100;
