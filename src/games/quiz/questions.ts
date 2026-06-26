/**
 * Question model. The full record (incl. `answerIndex`) lives only on the
 * server — clients receive the prompt/choices without the answer, and the
 * answer only in a `reveal`. Keep packs safe for 7+ : no religion, politics,
 * violence or adult themes.
 */
export interface Question {
  id: string;
  type: "mcq" | "true_false";
  prompt: string;
  choices: string[];
  answerIndex: number;
  explanation?: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  ageMin: number;
  tags: string[];
}

export interface ThemePack {
  id: string;
  name: string;
  description: string;
  minAge: number;
  visualStyle: "classic" | "school" | "space" | "jungle" | "madagascar" | "custom";
  questions: Question[];
}
