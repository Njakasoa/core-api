import type { Question, ThemePack } from "../questions.ts";

const TF = ["Vrai", "Faux"];

/**
 * Starter pack for the "Classique — famille / amis / école" theme. ~30 light,
 * non-violent questions for 7+. Target is 100 at the next milestone.
 */
const questions: Question[] = [
  { id: "cl_animals_001", type: "mcq", prompt: "Quel animal miaule ?", choices: ["Le chien", "Le chat", "La vache", "Le cheval"], answerIndex: 1, explanation: "Le chat fait « miaou ».", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_002", type: "mcq", prompt: "Quel animal vit dans l'eau et a des nageoires ?", choices: ["Le poisson", "Le lapin", "L'oiseau", "Le chat"], answerIndex: 0, explanation: "Le poisson nage avec ses nageoires.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_003", type: "true_false", prompt: "Une vache donne du lait.", choices: TF, answerIndex: 0, explanation: "La vache produit du lait.", category: "Animaux", difficulty: "easy", ageMin: 7, tags: ["animaux"] },
  { id: "cl_animals_004", type: "mcq", prompt: "Combien de pattes a une araignée ?", choices: ["4", "6", "8", "10"], answerIndex: 2, explanation: "Une araignée a 8 pattes.", category: "Animaux", difficulty: "medium", ageMin: 7, tags: ["animaux"] },
  { id: "cl_colors_001", type: "mcq", prompt: "De quelle couleur est le ciel par beau temps ?", choices: ["Vert", "Bleu", "Rouge", "Marron"], answerIndex: 1, explanation: "Le ciel est bleu quand il fait beau.", category: "Couleurs", difficulty: "easy", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_colors_002", type: "mcq", prompt: "Quelle couleur obtient-on en mélangeant le bleu et le jaune ?", choices: ["Vert", "Orange", "Violet", "Rose"], answerIndex: 0, explanation: "Bleu + jaune = vert.", category: "Couleurs", difficulty: "medium", ageMin: 7, tags: ["couleurs"] },
  { id: "cl_shapes_001", type: "mcq", prompt: "Combien de côtés a un triangle ?", choices: ["2", "3", "4", "5"], answerIndex: 1, explanation: "Un triangle a 3 côtés.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },
  { id: "cl_shapes_002", type: "mcq", prompt: "Une forme ronde comme une roue s'appelle…", choices: ["Un carré", "Un cercle", "Un triangle", "Un rectangle"], answerIndex: 1, explanation: "Une roue a la forme d'un cercle.", category: "Formes", difficulty: "easy", ageMin: 7, tags: ["formes"] },
  { id: "cl_math_001", type: "mcq", prompt: "Combien font 2 + 3 ?", choices: ["4", "5", "6", "7"], answerIndex: 1, explanation: "2 + 3 = 5.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_002", type: "mcq", prompt: "Combien font 10 - 4 ?", choices: ["5", "6", "7", "8"], answerIndex: 1, explanation: "10 - 4 = 6.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_003", type: "mcq", prompt: "Combien font 3 × 2 ?", choices: ["5", "6", "8", "9"], answerIndex: 1, explanation: "3 × 2 = 6.", category: "Calcul", difficulty: "medium", ageMin: 7, tags: ["maths"] },
  { id: "cl_math_004", type: "mcq", prompt: "Quel est le nombre qui vient juste après 9 ?", choices: ["8", "10", "11", "19"], answerIndex: 1, explanation: "Après 9 vient 10.", category: "Calcul", difficulty: "easy", ageMin: 7, tags: ["maths"] },
  { id: "cl_geo_001", type: "mcq", prompt: "Dans quelle ville se trouve la tour Eiffel ?", choices: ["Londres", "Paris", "Rome", "Madrid"], answerIndex: 1, explanation: "La tour Eiffel est à Paris.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_002", type: "mcq", prompt: "Quelle est la grande île à l'est de l'Afrique ?", choices: ["Madagascar", "L'Australie", "Le Japon", "Cuba"], answerIndex: 0, explanation: "Madagascar est une grande île près de l'Afrique.", category: "Géographie", difficulty: "medium", ageMin: 7, tags: ["geo"] },
  { id: "cl_geo_003", type: "true_false", prompt: "La mer est faite d'eau salée.", choices: TF, answerIndex: 0, explanation: "L'eau de mer est salée.", category: "Géographie", difficulty: "easy", ageMin: 7, tags: ["geo"] },
  { id: "cl_sci_001", type: "mcq", prompt: "Quel astre nous éclaire le jour ?", choices: ["La Lune", "Le Soleil", "Une étoile filante", "Une lampe"], answerIndex: 1, explanation: "Le Soleil éclaire la journée.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_sci_002", type: "mcq", prompt: "Combien de jours y a-t-il dans une semaine ?", choices: ["5", "6", "7", "8"], answerIndex: 2, explanation: "Une semaine compte 7 jours.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["temps"] },
  { id: "cl_sci_003", type: "mcq", prompt: "Quelle saison vient après l'hiver ?", choices: ["L'été", "L'automne", "Le printemps", "La pluie"], answerIndex: 2, explanation: "Après l'hiver vient le printemps.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["temps"] },
  { id: "cl_sci_004", type: "true_false", prompt: "Les plantes ont besoin d'eau pour pousser.", choices: TF, answerIndex: 0, explanation: "Les plantes boivent de l'eau pour grandir.", category: "Sciences", difficulty: "easy", ageMin: 7, tags: ["sciences"] },
  { id: "cl_logic_001", type: "mcq", prompt: "Quel objet sert à écrire ?", choices: ["Une cuillère", "Un crayon", "Une chaussure", "Une assiette"], answerIndex: 1, explanation: "On écrit avec un crayon.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_002", type: "mcq", prompt: "Lequel n'est PAS un fruit ?", choices: ["La pomme", "La banane", "La carotte", "La fraise"], answerIndex: 2, explanation: "La carotte est un légume.", category: "Logique", difficulty: "medium", ageMin: 7, tags: ["logique"] },
  { id: "cl_logic_003", type: "mcq", prompt: "Que met-on aux pieds pour marcher dehors ?", choices: ["Des gants", "Des chaussures", "Un chapeau", "Une écharpe"], answerIndex: 1, explanation: "On met des chaussures aux pieds.", category: "Logique", difficulty: "easy", ageMin: 7, tags: ["logique"] },
  { id: "cl_fr_001", type: "mcq", prompt: "Quel mot est le contraire de « grand » ?", choices: ["Petit", "Gros", "Haut", "Long"], answerIndex: 0, explanation: "Le contraire de grand est petit.", category: "Français", difficulty: "easy", ageMin: 7, tags: ["francais"] },
  { id: "cl_fr_002", type: "mcq", prompt: "Combien y a-t-il de voyelles dans le mot « école » ?", choices: ["1", "2", "3", "4"], answerIndex: 2, explanation: "é, o, e → 3 voyelles.", category: "Français", difficulty: "medium", ageMin: 7, tags: ["francais"] },
  { id: "cl_en_001", type: "mcq", prompt: "Comment dit-on « chat » en anglais ?", choices: ["Dog", "Cat", "Bird", "Fish"], answerIndex: 1, explanation: "« Chat » se dit « cat ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_002", type: "mcq", prompt: "Que veut dire « hello » en français ?", choices: ["Au revoir", "Merci", "Bonjour", "Pardon"], answerIndex: 2, explanation: "« Hello » veut dire « bonjour ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_en_003", type: "mcq", prompt: "Quelle est la couleur « red » en français ?", choices: ["Bleu", "Vert", "Rouge", "Jaune"], answerIndex: 2, explanation: "« Red » veut dire « rouge ».", category: "Anglais", difficulty: "easy", ageMin: 7, tags: ["anglais"] },
  { id: "cl_gen_001", type: "mcq", prompt: "Où range-t-on les livres à l'école ?", choices: ["Au réfectoire", "À la bibliothèque", "Dans la cour", "Au gymnase"], answerIndex: 1, explanation: "Les livres sont à la bibliothèque.", category: "École", difficulty: "easy", ageMin: 7, tags: ["ecole"] },
  { id: "cl_gen_002", type: "mcq", prompt: "Qui aide les élèves à apprendre en classe ?", choices: ["Le facteur", "Le maître ou la maîtresse", "Le boulanger", "Le pompier"], answerIndex: 1, explanation: "C'est l'enseignant(e) qui aide à apprendre.", category: "École", difficulty: "easy", ageMin: 7, tags: ["ecole"] },
  { id: "cl_gen_003", type: "true_false", prompt: "Un arc-en-ciel apparaît parfois après la pluie.", choices: TF, answerIndex: 0, explanation: "L'arc-en-ciel se forme avec le soleil et la pluie.", category: "Nature", difficulty: "easy", ageMin: 7, tags: ["nature"] },
  { id: "cl_gen_004", type: "mcq", prompt: "Combien de doigts a-t-on sur une main ?", choices: ["3", "4", "5", "6"], answerIndex: 2, explanation: "Une main a 5 doigts.", category: "Corps", difficulty: "easy", ageMin: 7, tags: ["corps"] },
];

export const classicFamilySchool: ThemePack = {
  id: "classic-family-school",
  name: "Classique",
  description: "Questions simples pour jouer en famille, entre amis ou à l'école.",
  minAge: 7,
  visualStyle: "classic",
  questions,
};
